// P0 Electron main: owns window lifecycle and supervises the packaged
// backend utility process over a typed handshake. Task execution, storage
// and HTTP/SSE stay in the backend; the renderer loads the compiled UI.
import { app, BrowserWindow, dialog, ipcMain, shell, utilityProcess } from "electron";
import path from "node:path";
import fs from "node:fs";
import { DESKTOP_BACKEND_PROTOCOL, SELECT_PROJECT_CHANNEL } from "./protocol.js";

import { desktopOptions } from "./options.js";

const options = desktopOptions();
fs.mkdirSync(options.browserDir, { recursive: true, mode: 0o700 });
app.setPath("userData", options.browserDir);

const LATTICE_APP_ID = "dev.lattice.harness.p0";

interface BackendHandle {
  child: ReturnType<typeof utilityProcess.fork>;
  url: string;
  port: number;
  bootstrapCookie: string;
}

interface BackendMessage {
  type?: unknown;
  id?: unknown;
  protocol?: unknown;
  url?: unknown;
  port?: unknown;
  bootstrapCookie?: unknown;
  error?: unknown;
  activeTasks?: unknown;
  workspace?: unknown;
}

let mainWindow: BrowserWindow | null = null;
let backend: BackendHandle | null = null;
let quitting = false;
let closePending = false;

function backendEntry(): string {
  return path.join(__dirname, "backend-entry.js");
}

let requestCounter = 0;

function waitForMessage(
  child: ReturnType<typeof utilityProcess.fork>,
  predicate: (message: BackendMessage) => boolean,
  timeoutMs: number,
): Promise<BackendMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", onMessage);
      reject(new Error("timed out waiting for backend handshake"));
    }, timeoutMs);
    const onMessage = (message: BackendMessage): void => {
      if (predicate(message)) {
        clearTimeout(timer);
        child.off("message", onMessage);
        resolve(message);
      }
    };
    child.on("message", onMessage);
  });
}

async function startBackend(workspace: string, dataDir: string, timeoutMs = 30_000): Promise<BackendHandle> {
  const child = utilityProcess.fork(backendEntry(), [], { stdio: "pipe" });
  if (child.stdout !== null) {
    child.stdout.on("data", (chunk: Buffer) => {
      process.stdout.write(`[backend] ${chunk.toString("utf8")}`);
    });
  }
  if (child.stderr !== null) {
    child.stderr.on("data", (chunk: Buffer) => {
      process.stderr.write(`[backend] ${chunk.toString("utf8")}`);
    });
  }
  requestCounter += 1;
  const id = requestCounter;
  child.postMessage({ id, op: "start", config: { workspace, dataDir, nativeProjectSelection: true } });
  const ready = await waitForMessage(
    child,
    (message) => (message.type === "lattice-backend-ready" || message.type === "lattice-backend-error") && message.id === id,
    timeoutMs,
  );
  if (ready.type !== "lattice-backend-ready" || ready.protocol !== DESKTOP_BACKEND_PROTOCOL) {
    try {
      child.kill();
    } catch {
      // Kill failure leaves the exit handler to report; handshake already failed.
    }
    throw new Error(`backend handshake failed: ${typeof ready.error === "string" ? ready.error : "unexpected reply"}`);
  }
  const url = ready.url;
  const port = ready.port;
  if (typeof url !== "string" || typeof port !== "number" || typeof ready.bootstrapCookie !== "string") {
    try {
      child.kill();
    } catch {
      // Same as above: the handshake error below is the actionable signal.
    }
    throw new Error("backend handshake returned a malformed address");
  }
  return { child, url, port, bootstrapCookie: ready.bootstrapCookie };
}

async function stopBackend(): Promise<void> {
  const current = backend;
  backend = null;
  if (current === null) return;
  requestCounter += 1;
  const id = requestCounter;
  try {
    current.child.postMessage({ id, op: "stop" });
    await waitForMessage(
      current.child,
      (message) => message.type === "lattice-backend-stopped" && message.id === id,
      10_000,
    );
  } catch {
    // A hung backend must not wedge desktop shutdown; kill is the backstop.
  }
  // Deterministic teardown: the utility process owns the DB lock and the
  // loopback listener. Kill unconditionally after the graceful stop above
  // so no orphan backend survives main, then report the kill outcome.
  try {
    const killed = current.child.kill();
    if (!killed) {
      throw new Error("backend kill signal refused");
    }
  } catch {
    // Already gone: the graceful stop above closed it.
  }
}

async function requestQuit(): Promise<void> {
  if (quitting || closePending) return;
  closePending = true;
  try {
    if (backend !== null) {
      const current = backend;
      const id = ++requestCounter;
      const response = waitForMessage(current.child, (message) => message.type === "lattice-backend-status" && message.id === id, 5000);
      current.child.postMessage({ id, op: "status" });
      const status = await response;
      if (typeof status.activeTasks !== "number" || !Number.isInteger(status.activeTasks) || status.activeTasks < 0) throw new Error("malformed backend lifecycle status");
      if (status.activeTasks > 0 && mainWindow !== null) {
        const choice = await dialog.showMessageBox(mainWindow, {
          type: "question", title: "Lattice", message: "Há uma tarefa ativa.",
          detail: "Parar e fechar solicita a interrupção e aguarda o encerramento dos processos supervisionados. Efeitos já executados permanecem no histórico.",
          buttons: ["Continuar trabalhando", "Parar e fechar"], defaultId: 0, cancelId: 0,
        });
        if (choice.response !== 1) return;
      }
    }
    quitting = true;
    await stopBackend();
    app.quit();
  } catch (error) {
    process.stderr.write(`lattice shutdown failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
  } finally { closePending = false; }
}

async function createWindow(): Promise<void> {
  backend = await startBackend(options.workspace, options.dataDir);
  // P0 smoke mode: report readiness for the headless harness and keep the
  // backend alive without opening a window. Not a production code path.
  if (process.argv.includes("--p0-smoke") || process.env["LATTICE_P0_SMOKE"] === "1") {
    // Only the explicitly invoked test owner receives auth over an inherited
    // anonymous pipe. Never send a bootstrap secret over HTTP or stdout.
    if (process.env["LATTICE_P0_OWNER_PIPE"] === "1") {
      fs.writeSync(3, JSON.stringify({ url: backend.url, cookie: backend.bootstrapCookie.split(";")[0] }) + "\n");
      fs.closeSync(3);
    }
    process.stdout.write(`P0_SMOKE_READY ${backend.url}\n`);
    return;
  }
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    backgroundColor: "#1b1c1f",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.js"),
    },
  });
  mainWindow.on("closed", () => {
    mainWindow = null;
  });
  mainWindow.on("close", (event) => {
    if (quitting) return;
    event.preventDefault();
    void requestQuit();
  });
  // No new Electron windows ever. Links from responses (target=_blank) open
  // in the system browser, and only for http(s) and mailto.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (externalLinkAllowed(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (backend === null || new URL(url).origin !== new URL(backend.url).origin) event.preventDefault();
  });
  const pair = backend.bootstrapCookie.split(";")[0] ?? "";
  const separator = pair.indexOf("=");
  await mainWindow.webContents.session.cookies.set({ url: backend.url, name: pair.slice(0, separator), value: pair.slice(separator + 1), httpOnly: true, sameSite: "strict", path: "/" });
  await mainWindow.loadURL(backend.url);
}

export function externalLinkAllowed(url: string): boolean {
  try {
    return ["http:", "https:", "mailto:"].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

function projectSelectionAvailable(current: BackendHandle): boolean { return backend === current && !quitting && !closePending; }

ipcMain.handle(SELECT_PROJECT_CHANNEL, async (event) => {
  if (mainWindow === null || backend === null || quitting || closePending || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame || new URL(event.senderFrame.url).origin !== new URL(backend.url).origin) throw new Error("project selection denied");
  const current = backend;
  const selected = await dialog.showOpenDialog(mainWindow, { title: "Escolha o projeto", properties: ["openDirectory"] });
  if (selected.canceled || selected.filePaths.length !== 1) return null;
  if (!projectSelectionAvailable(current)) throw new Error("project selection unavailable");
  const id = ++requestCounter;
  const reply = waitForMessage(current.child, message => message.id === id && (message.type === "lattice-workspace-selected" || message.type === "lattice-backend-error"), 5000);
  current.child.postMessage({ id, op: "select-workspace", workspace: selected.filePaths[0] });
  const result = await reply;
  if (result.type !== "lattice-workspace-selected" || typeof result.workspace !== "string") throw new Error(typeof result.error === "string" ? result.error : "project selection failed");
  return { workspace: result.workspace };
});

app.setAppUserModelId(LATTICE_APP_ID);

// One instance per profile (PG-045): a second launch focuses the existing
// window instead of racing it for the same database ownership.
const primaryInstance = app.requestSingleInstanceLock();
if (!primaryInstance) {
  process.stdout.write("lattice desktop: another instance owns this profile; focusing it\n");
  app.exit(0);
}
app.on("second-instance", () => {
  if (mainWindow === null) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

if (primaryInstance) app.whenReady().then(
  () => {
    createWindow().catch((error: unknown) => {
      process.stderr.write(`lattice desktop failed to start: ${error instanceof Error ? error.message : "unknown error"}\n`);
      dialog.showErrorBox("Lattice não abriu", "Não foi possível iniciar o aplicativo. Confira a pasta de dados e se outra janela Lattice já está aberta.\n\n" + (error instanceof Error ? error.message : "Falha de inicialização"));
      app.exit(1);
    });
  },
  () => {
    app.exit(1);
  },
);

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    void requestQuit();
  }
});

// P0 smoke mode keeps no window: SIGTERM/SIGKILL from the harness ends the
// backend with main. Normal window mode drains through before-quit above.
process.on("SIGTERM", () => {
  process.stdout.write("P0_SMOKE_SIGTERM\n");
  stopBackend()
    .catch(() => undefined)
    .finally(() => {
      app.exit(0);
    });
});

app.on("before-quit", (event: { preventDefault(): void }) => {
  if (quitting || backend === null) return;
  event.preventDefault();
  void requestQuit();
});
