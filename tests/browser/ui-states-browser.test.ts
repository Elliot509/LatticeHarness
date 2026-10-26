import fs from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { SessionSummary, TaskSnapshot, TaskState, ToolActivityStatus } from "../../src/server/protocol.js";
import { stateLabel } from "../../src/ui/state.js";
import { findChromium, launchChromium, screenshot, type CdpSession } from "./cdp.js";

const UI_ROOT = path.resolve(__dirname, "../../dist/ui");
const STATES: TaskState[] = ["READY", "RUNNING", "WAITING", "NEEDS_INPUT", "BLOCKED", "COMPLETED", "CANCELLED", "INTERRUPTED"];

function json(response: ServerResponse, body: unknown): void {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body));
}

function toolStatus(state: TaskState): ToolActivityStatus {
  switch (state) {
    case "RUNNING":
      return "running";
    case "BLOCKED":
      return "denied";
    case "CANCELLED":
    case "INTERRUPTED":
      return "unknown";
    case "READY":
    case "WAITING":
    case "NEEDS_INPUT":
    case "COMPLETED":
      return "completed";
  }
}

function snapshot(state: TaskState): TaskSnapshot {
  const reasons: Record<TaskState, string> = {
    READY: "Task is ready to continue.",
    RUNNING: "Reading the current workspace.",
    WAITING: "Waiting for the owned test process.",
    NEEDS_INPUT: "Choose which failing suite to prioritize.",
    BLOCKED: "The required credential is not configured.",
    COMPLETED: "All required checks passed.",
    CANCELLED: "Stop confirmed by the runtime.",
    INTERRUPTED: "The executor ended unexpectedly; effects classified.",
  };
  const hasUnknown = state === "CANCELLED" || state === "INTERRUPTED";
  return {
    protocol: "ui-1",
    taskId: "task-state",
    rootId: "root-state",
    workspace: "/workspace/lattice",
    objective: "Validate the execution state presentation",
    acceptanceCriteria: ["state remains explicit"],
    state,
    stateReason: reasons[state],
    contractRevision: 4,
    provider: "openai",
    model: "m1",
    baseUrl: null,
    keyConfigured: true,
    unknowns: hasUnknown ? 1 : 0,
    unknownHistory: hasUnknown
      ? [{ attemptId: "attempt-uncertain", operation: "exec", target: "npm test", reason: "process exit was not observed", recordedAt: "2026-09-13T13:00:03Z" }]
      : [],
    waits: state === "WAITING"
      ? [{ waitId: "wait-process", kind: "process", condition: "test process is still running", obligation: "observe the owned process", state: "active" }]
      : [],
    resumable: state === "WAITING" || state === "BLOCKED" || state === "CANCELLED" || state === "INTERRUPTED",
    resumeBlockers: state === "BLOCKED" ? ["configure the provider credential"] : [],
    budget: { grantedCalls: 50, grantedTokens: 200000, reservedCalls: state === "RUNNING" ? 1 : 0, reservedTokens: 0, settledCalls: 8, settledTokens: 12400 },
    contextUsage: { known: true, usedTokens: 18300, contextWindow: 128000 },
    messages: [{ id: "message-1", seq: 1, author: "user", text: "Validate every execution state.", recordedAt: "2026-09-13T13:00:01Z" }],
    tools: [{ id: "tool-2", seq: 2, tool: "exec", target: "npm test", status: toolStatus(state), summary: "[exec] observed project test execution", detail: null, version: null, complete: state !== "RUNNING" && state !== "CANCELLED", truncated: false, durationMs: state === "RUNNING" ? null : 842, recordedAt: "2026-09-13T13:00:02Z" }],
    verifications: [],
    steering: [],
    cut: 2,
  };
}

async function waitFor(session: CdpSession, expression: string, timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const result = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", { expression, returnByValue: true });
    if (result.result.value === true) return;
    if (Date.now() >= deadline) throw new Error(`condition not met: ${expression}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

describe("browser ui state presentation", () => {
  it("keeps every projected task state explicit and usable", async () => {
    if (findChromium() === null) {
      console.warn("chromium not available; browser state test skipped");
      return;
    }

    let currentState: TaskState = "READY";
    const streams = new Set<ServerResponse>();
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
      if (pathname === "/" || pathname === "/index.html") {
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(fs.readFileSync(path.join(UI_ROOT, "index.html")));
        return;
      }
      if (pathname === "/assets/app.js" || pathname === "/assets/app.css") {
        response.writeHead(200, { "Content-Type": pathname.endsWith(".js") ? "text/javascript" : "text/css" });
        response.end(fs.readFileSync(path.join(UI_ROOT, path.basename(pathname))));
        return;
      }
      if (pathname === "/api/info") {
        json(response, { workspace: "/workspace/lattice" });
        return;
      }
      if (pathname === "/api/sessions") {
        const session: SessionSummary = { sessionId: "session-state", taskId: "task-state", rootId: "root-state", workspace: "/workspace/lattice", objective: "Validate the execution state presentation", state: currentState, updatedAt: "2026-09-13T13:00:04Z" };
        json(response, { sessions: [session] });
        return;
      }
      if (pathname === "/api/tasks/task-state/snapshot") {
        json(response, snapshot(currentState));
        return;
      }
      if (pathname === "/api/tasks/task-state/events") {
        response.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
        response.write(": connected\n\n");
        streams.add(response);
        request.once("close", () => { streams.delete(response); });
        return;
      }
      response.writeHead(404);
      response.end();
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { resolve(); });
    });
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("mock ui server did not open a TCP port");
    const url = `http://127.0.0.1:${address.port}`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-ui-states-"));
    const browser = await launchChromium(19002);

    try {
      const session = browser.session;
      await session.send("Page.enable", {});
      await session.send("Emulation.setDeviceMetricsOverride", { width: 900, height: 700, deviceScaleFactor: 1, mobile: false });

      for (const state of STATES) {
        for (const stream of streams) stream.end();
        streams.clear();
        currentState = state;
        await session.send("Page.navigate", { url: `${url}/?state=${state}` });
        await waitFor(session, `document.querySelector(".session") !== null`);
        await session.send("Runtime.evaluate", { expression: `document.querySelector(".session")?.click()` });
        await waitFor(session, `document.querySelector(".topbar .state")?.textContent === ${JSON.stringify(stateLabel(state))}`);
        const stateView = await session.send<{ result: { value?: unknown } }>("Runtime.evaluate", {
          expression: `(() => ({
            // The reason may be shown humanized (with the original under
            // "Detalhes técnicos") or in the running row: anywhere in the task view.
            hasReason: document.querySelector(".chat")?.textContent?.includes(${JSON.stringify(snapshot(state).stateReason)}) === true,
            hasStop: document.querySelector(".composer .danger") !== null,
            hasResume: [...document.querySelectorAll(".composer button")].some((button) => button.textContent?.trim() === "Retomar"),
            noHorizontalScroll: document.documentElement.scrollWidth <= window.innerWidth,
          }))()`,
          returnByValue: true,
        });
        expect(stateView.result.value).toEqual({
          hasReason: true,
          hasStop: state === "RUNNING" || state === "WAITING",
          hasResume: state === "WAITING" || state === "BLOCKED" || state === "CANCELLED" || state === "INTERRUPTED",
          noHorizontalScroll: true,
        });
        await screenshot(session, path.join(dir, `state-${state.toLowerCase().replace("_", "-")}.png`));
      }

      const destination = "/tmp/lattice-shots";
      fs.mkdirSync(destination, { recursive: true });
      for (const state of STATES) {
        const name = `state-${state.toLowerCase().replace("_", "-")}.png`;
        fs.copyFileSync(path.join(dir, name), path.join(destination, name));
      }
    } finally {
      await browser.close();
      server.close();
      for (const stream of streams) stream.end();
      server.closeAllConnections();
      server.unref();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 120_000);
});
