// Validates the distributable artifact: packs the package, inspects the
// tarball for unexpected entries, installs it under an isolated prefix, and
// executes the shipped CLI outside the checkout. Node-only APIs so the same
// script runs on Linux and Windows CI.
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { joinCommand, npmCommand, useShell } from "./npm-spawn.mjs";

const execFileAsync = promisify(execFile);
const root = process.cwd();
const NPM = npmCommand();

function run(cmd, args, options = {}) {
  // Windows batch shims fail with spawn EINVAL unless run through a shell,
  // and the shell receives one pre-quoted command line: Node does not escape
  // argument arrays for shells (DEP0190), so spaced paths would split.
  if (useShell()) {
    return execFileAsync(joinCommand(cmd, args), { ...options, shell: true });
  }
  return execFileAsync(cmd, args, { ...options, shell: false });
}

function fail(message) {
  process.stderr.write(`pack-test: ${message}\n`);
  process.exit(1);
}

// Reads the packed file list from npm's structured output instead of parsing
// the tarball by hand or relying on a system tar binary.
function packedEntries(packJson) {
  let parsed;
  try {
    parsed = JSON.parse(packJson);
  } catch {
    fail("npm pack did not return parseable JSON");
  }
  const summaries = Array.isArray(parsed) ? parsed : Object.values(parsed);
  if (summaries.length !== 1) fail("npm pack returned metadata for an unexpected package set");
  const [summary] = summaries;
  if (!summary || typeof summary.filename !== "string" || !Array.isArray(summary.files)) {
    fail("npm pack metadata misses filename or files");
  }
  return {
    filename: summary.filename,
    entries: summary.files.map((file) => `package/${file.path}`),
  };
}

const forbidden = [/\.env$/i, /^node_modules\//, /\.git\//, /\.sqlite$/i, /\.db$/i, /\.pdf$/i, /^dist\/p0-bundle\//];

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-pack-"));
try {
  const { stdout: packOut } = await run(NPM, ["pack", "--json", "--pack-destination", scratch], {
    cwd: root,
  });
  const { filename: tarballName, entries } = packedEntries(packOut);
  const tarball = path.join(scratch, tarballName);
  if (!fs.existsSync(tarball)) fail(`tarball not created: ${tarballName}`);

  if (!entries.some((e) => e === "package/dist/cli/main.js")) {
    fail("tarball misses package/dist/cli/main.js");
  }
  if (!entries.some((e) => e === "package/package.json")) {
    fail("tarball misses package/package.json");
  }
  if (!entries.includes("package/desktop/PORTABLE.md")) fail("tarball misses portable documentation referenced by README");
  for (const asset of ["package/dist/ui/index.html", "package/dist/ui/app.js", "package/dist/ui/app.css"]) {
    if (!entries.some((e) => e === asset)) {
      fail(`tarball misses ${asset}`);
    }
  }
  const sourced = entries.filter((e) => e.startsWith("package/src/ui/") || e.startsWith("package/fixtures/") || e.startsWith("package/tests/"));
  if (sourced.length > 0) fail(`tarball contains sources/fixtures that must stay out: ${sourced.join(", ")}`);
  const bad = entries.filter((e) => forbidden.some((re) => re.test(e.replace(/^package\//, ""))));
  if (bad.length > 0) fail(`tarball contains forbidden entries: ${bad.join(", ")}`);
  process.stdout.write(`pack-test: tarball ${tarballName} ok (${entries.length} entries)\n`);

  const prefix = path.join(scratch, "prefix");
  const probeDir = path.join(scratch, "probe");
  fs.mkdirSync(prefix, { recursive: true });
  fs.mkdirSync(probeDir, { recursive: true });

  await run(NPM, ["install", "--global", "--prefix", prefix, tarball], { cwd: probeDir });
  const binName = process.platform === "win32" ? "lattice.cmd" : "lattice";
  const bin = path.join(prefix, "bin", binName);
  const windowsShim = path.join(prefix, binName);
  const latticeBin = fs.existsSync(bin) ? bin : windowsShim;
  if (!fs.existsSync(latticeBin)) fail(`global bin missing under prefix: ${prefix}`);

  const dataDir = path.join(scratch, "data dir", "café");
  const env = { ...process.env, LATTICE_DATA_DIR: dataDir };
  const { stdout: statusOut } = await run(latticeBin, ["status", "--json"], {
    cwd: probeDir,
    env,
  });
  const report = JSON.parse(statusOut);
  // Fresh installs land directly on the current schema version.
  const { SCHEMA_VERSION } = await import(pathToFileURL(path.join(root, "dist", "storage", "schema.js")).href);
  if (report.schemaVersion !== SCHEMA_VERSION) fail(`unexpected schemaVersion: ${report.schemaVersion}`);
  if (report.readiness !== "provider-pending") fail(`unexpected readiness: ${report.readiness}`);
  if (!fs.existsSync(path.join(dataDir, "lattice.db"))) {
    fail("installed CLI did not create its database");
  }
  process.stdout.write("pack-test: global isolated install executes outside checkout\n");

  const { stdout: execOut } = await run(
    NPM,
    ["exec", "--yes", "--package", tarball, "lattice", "--", "status"],
    { cwd: probeDir, env: { ...process.env, LATTICE_DATA_DIR: path.join(scratch, "exec-data") } },
  );
  if (!execOut.includes("provider-pending")) fail("npm exec run did not report readiness");
  process.stdout.write("pack-test: npm exec against tarball ok\n");

  // Agent smoke from the installed artifact: copy a bug fixture outside the
  // checkout and drive the full loop with the fake test-double provider.
  // This validates the shipped runtime modules, never model skill.
  const fixtureSrc = path.join(root, "fixtures", "bug-prices");
  const agentWs = path.join(scratch, "agent project");
  copyDir(fixtureSrc, agentWs);
  const sumSource = fs.readFileSync(path.join(agentWs, "src", "sum.js"), "utf8");
  const { createHash } = await import("node:crypto");
  const sumVersion = `sha256:${createHash("sha256").update(sumSource, "utf8").digest("hex").slice(0, 16)}`;
  const nodeExe = process.execPath;
  const oldText = "  return items.reduce((sum, item) => {\n    const line = item.price * item.qty;\n    const discount = item.price > 50 ? item.price * 0.1 : 0;\n    return sum + line - discount;\n  }, 0);";
  const newText = "  const subtotal = items.reduce((sum, item) => sum + item.price * item.qty, 0);\n  const discount = subtotal > 100 ? subtotal * 0.1 : 0;\n  return subtotal - discount;";
  const script = [
    { toolCalls: [{ name: "search", argumentsJson: "{\"kind\":\"text\",\"query\":\"discount\"}" }] },
    { toolCalls: [{ name: "read", argumentsJson: "{\"path\":\"src/sum.js\"}" }] },
    { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
    { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify({ kind: "replace", path: "src/sum.js", expectedVersion: sumVersion, oldText, newText }) }] },
    { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: nodeExe, argv: ["--test", "test/test.js"] }) }] },
    { text: "Fixed and verified." },
  ];
  const scriptPath = path.join(scratch, "fake-script.json");
  fs.writeFileSync(scriptPath, JSON.stringify(script));
  const noteBefore = fs.readFileSync(path.join(agentWs, "notes", "todo.txt"), "utf8");
  const { stdout: runOut } = await run(
    latticeBin,
    [
      "run",
      "--workspace", agentWs,
      "--data-dir", path.join(scratch, "agent-data"),
      "--task", "Fix the bulk discount bug",
      "--accept", "project test suite passes",
      "--provider", "fake",
      "--model", "fake-model-1",
      "--fake-script", scriptPath,
      "--verify", nodeExe,
      "--verify-arg", "--test",
      "--verify-arg", "test/test.js",
    ],
    { cwd: probeDir, env: { ...process.env, LATTICE_DATA_DIR: path.join(scratch, "agent-data") } },
  );
  if (!runOut.includes("lattice: STOP: verified:")) {
    fail(`installed agent did not conclude verified: ${runOut.slice(-500)}`);
  }
  if (fs.readFileSync(path.join(agentWs, "notes", "todo.txt"), "utf8") !== noteBefore) {
    fail("installed agent modified human-owned files");
  }
  process.stdout.write("pack-test: installed agent solved the fixture with verification\n");

  // UI smoke from the installed artifact: serve the packaged assets outside
  // the checkout, drive one authenticated command and read a snapshot back.
  // The long-lived server is launched via node plus the installed entrypoint
  // instead of the global bin shim: Windows .cmd shims cannot be spawned
  // directly (EINVAL without a shell), and a shell would complicate shutdown.
  // The shim itself stays covered by the status, agent and exec steps above.
  // Global layout differs per OS (lib/node_modules on Unix, node_modules on
  // Windows), so probe both instead of assuming one.
  const installedMain = ["lib", ""]
    .map((middle) => path.join(prefix, middle, "node_modules", "lattice-harness", "dist", "cli", "main.js"))
    .find((candidate) => fs.existsSync(candidate));
  if (installedMain === undefined) fail(`installed entrypoint missing under prefix: ${prefix}`);
  const installedPortable = path.join(path.dirname(installedMain), "..", "..", "desktop", "PORTABLE.md");
  if (fs.readFileSync(installedPortable, "utf8") !== fs.readFileSync(path.join(root, "desktop", "PORTABLE.md"), "utf8")) fail("installed portable documentation differs from source");
  process.stdout.write("pack-test: installed portable documentation matches source\n");
  const uiWs = path.join(scratch, "ui workspace");
  fs.mkdirSync(uiWs, { recursive: true });
  const uiData = path.join(scratch, "ui-data");
  const uiProc = spawn(
    process.execPath,
    [installedMain, "ui", "--workspace", uiWs, "--data-dir", uiData, "--no-open"],
    { cwd: probeDir, env: { ...process.env, LATTICE_DATA_DIR: uiData } },
  );
  let uiOut = "";
  let uiUrl;
  try {
    uiUrl = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("lattice ui did not print an address")), 30000);
      uiProc.stdout?.on("data", (chunk) => {
        uiOut += chunk.toString("utf8");
        const match = /lattice ui: (http:\/\/127\.0\.0\.1:\d+)/.exec(uiOut);
        if (match?.[1] !== undefined) {
          clearTimeout(timer);
          resolve(match[1]);
        }
      });
      uiProc.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      uiProc.once("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`lattice ui exited early with ${code}: ${uiOut.slice(-500)}`));
      });
    });
  } catch (error) {
    uiProc.kill();
    fail(`lattice ui did not start: ${error.message}`);
  }
  try {
    if (uiUrl === undefined) fail("lattice ui did not report an address");
    // Model direct top-level browser navigation. Node fetch overwrites
    // Sec-Fetch-Mode, so this fixture uses the native HTTP client.
    const home = await new Promise((resolve, reject) => {
      const request = http.get(`${uiUrl}/`, { headers: { "Sec-Fetch-Site": "none", "Sec-Fetch-Mode": "navigate", "Sec-Fetch-Dest": "document" } }, response => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode, cookie: response.headers["set-cookie"]?.[0] ?? "" }));
      });
      request.on("error", reject);
    });
    if (home.status !== 200) fail(`ui index returned ${home.status}`);
    const cookie = home.cookie.split(";")[0];
    if (cookie === "") fail("ui did not issue a session cookie");
    const created = await (
      await fetch(`${uiUrl}/api/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Cookie: cookie },
        body: JSON.stringify({
          commandId: "pack-create",
          kind: "create-task",
          payload: { workspace: "", objective: "Pack smoke task", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
        }),
      })
    ).json();
    if (created.accepted !== true) fail(`ui create-task denied: ${JSON.stringify(created).slice(0, 200)}`);
    const snapshot = await (
      await fetch(`${uiUrl}/api/tasks/${created.taskId}/snapshot`, { headers: { Cookie: cookie } })
    ).json();
    if (snapshot.objective !== "Pack smoke task" || snapshot.state !== "READY") {
      fail("ui snapshot does not reflect the created task");
    }
    const noAuth = await fetch(`${uiUrl}/api/sessions`);
    if (noAuth.status !== 401) fail("ui api served sessions without a session");
  } finally {
    uiProc.kill();
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  process.stdout.write("pack-test: installed ui serves assets and answers authenticated api\n");

  // Upgrade check: a genuine v1 database opens under the installed CLI,
  // migrates automatically, and keeps its rows. Built from the installed
  // package's own v1 DDL, outside the checkout.
  const schemaCandidates = ["lib", ""].map((middle) =>
    path.join(prefix, middle, "node_modules", "lattice-harness", "dist", "storage", "schema.js"),
  );
  const installedSchema = schemaCandidates.find((candidate) => fs.existsSync(candidate));
  if (installedSchema === undefined) fail(`installed schema module missing under prefix: ${prefix}`);
  const { V1_SCHEMA_SQL } = await import(pathToFileURL(installedSchema).href);
  if (typeof V1_SCHEMA_SQL !== "string") fail("installed package does not export V1_SCHEMA_SQL");
  const { DatabaseSync } = await import("node:sqlite");
  const upgradeData = path.join(scratch, "upgrade-data");
  fs.mkdirSync(upgradeData, { recursive: true });
  const upgradeDbPath = path.join(upgradeData, "lattice.db");
  {
    const v1 = new DatabaseSync(upgradeDbPath);
    try {
      v1.exec(V1_SCHEMA_SQL);
      v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
      v1.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "task-upgrade",
        "root-upgrade",
        1,
        JSON.stringify({ taskId: "task-upgrade", objective: "pre-upgrade work" }),
        new Date().toISOString(),
      );
    } finally {
      v1.close();
    }
  }
  const { stdout: upgradeOut } = await run(latticeBin, ["status", "--json"], {
    cwd: probeDir,
    env: { ...process.env, LATTICE_DATA_DIR: upgradeData },
  });
  const upgradeReport = JSON.parse(upgradeOut);
  if (upgradeReport.schemaVersion !== SCHEMA_VERSION) fail(`upgrade did not migrate to schema ${SCHEMA_VERSION}: ${upgradeOut.slice(0, 200)}`);
  {
    const reopened = new DatabaseSync(upgradeDbPath);
    try {
      const kept = reopened.prepare("SELECT document FROM contracts WHERE task_id = 'task-upgrade'").get();
      if (!kept || !kept.document.includes("pre-upgrade work")) fail("upgrade lost the previous contract row");
      const waits = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'waits'").get();
      if (!waits) fail("upgrade did not create the v2 waits table");
      const epochs = reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'composition_epochs'").get();
      if (!epochs) fail("upgrade did not create the v3 composition_epochs table");
    } finally {
      reopened.close();
    }
  }
  process.stdout.write("pack-test: installed package migrates a v1 database with data preserved\n");
} finally {
  fs.rmSync(scratch, { recursive: true, force: true });
}
process.stdout.write("pack-test: PASS\n");

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(from, to);
    else fs.copyFileSync(from, to);
  }
}
