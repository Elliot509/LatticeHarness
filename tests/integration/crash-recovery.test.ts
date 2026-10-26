import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { readTaskState } from "../../src/runtime/continuity.js";

// J8 at the backend level: a real child process owns the database, runs a
// task through the built TaskManager and is killed with SIGKILL at a chosen
// boundary. The parent then reopens the same database as the next owner.
const DIST = path.resolve(__dirname, "../../dist");
const CHILD = path.resolve(__dirname, "../helpers/crash-child.mjs");
const built = fs.existsSync(path.join(DIST, "server/tasks.js"));

type Step = { hang: true } | { text?: string; toolCalls?: Array<{ name: string; argumentsJson: string }> };

interface ScriptedProvider {
  url: string;
  bodies: string[];
  steps: Step[];
  waitForRequests(count: number): Promise<void>;
  close(): Promise<void>;
}

async function scriptedProvider(steps: Step[]): Promise<ScriptedProvider> {
  const bodies: string[] = [];
  const hanging: http.ServerResponse[] = [];
  const waiters: Array<() => void> = [];
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.url?.endsWith("/models")) {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "crash-fixture" }] }));
        return;
      }
      bodies.push(body);
      for (const wake of waiters.splice(0)) wake();
      const step = steps.shift();
      if (step === undefined) {
        response.writeHead(500, { "Content-Type": "application/json" });
        response.end(JSON.stringify({ error: { message: "script exhausted" } }));
        return;
      }
      if ("hang" in step) { hanging.push(response); return; }
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: `crash-${bodies.length}`,
        model: "crash-fixture",
        choices: [{ message: { content: step.text ?? "", tool_calls: (step.toolCalls ?? []).map((call, index) => ({ id: `call-${bodies.length}-${index}`, type: "function", function: { name: call.name, arguments: call.argumentsJson } })) } }],
        usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 },
      }));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { resolve((server.address() as { port: number }).port); }));
  return {
    url: `http://127.0.0.1:${port}/v1`,
    bodies,
    steps,
    waitForRequests: async (count) => {
      const deadline = Date.now() + 15_000;
      while (bodies.length < count) {
        if (Date.now() > deadline) throw new Error(`provider saw ${bodies.length} request(s), expected ${count}`);
        await new Promise<void>((resolve) => { waiters.push(resolve); setTimeout(resolve, 100); });
      }
    },
    close: async () => {
      for (const response of hanging) response.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
    },
  };
}

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function versionOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
}

async function runChild(env: Record<string, string>): Promise<{ child: ChildProcess; taskId: string; exited: Promise<NodeJS.Signals | null> }> {
  const child = spawn(process.execPath, [CHILD], { env: { PATH: process.env["PATH"] ?? "", HOME: os.tmpdir(), CRASH_DIST: DIST, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  cleanups.push(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); });
  const exited = new Promise<NodeJS.Signals | null>((resolve) => { child.once("exit", (_code, signal) => { resolve(signal); }); });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
  const line = await new Promise<string>((resolve, reject) => {
    let out = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      out += chunk.toString("utf8");
      const newline = out.indexOf("\n");
      if (newline !== -1) resolve(out.slice(0, newline));
    });
    child.once("exit", () => { reject(new Error(`child exited before reporting: ${stderr}`)); });
  });
  const parsed = JSON.parse(line) as { taskId?: string };
  if (parsed.taskId === undefined) throw new Error(`child did not create the task: ${line}`);
  return { child, taskId: parsed.taskId, exited };
}

function setup(): { dir: string; data: string; ws: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-crash-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  fs.writeFileSync(path.join(ws, "README.md"), "# Projeto\nUm projeto de teste.\n");
  return { dir, data: path.join(dir, "data"), ws };
}

function reopen(data: string, ws: string): { db: LatticeDb; tasks: TaskManager; generation: number } {
  const db = openLatticeDb(data);
  cleanups.push(() => { db.close(); });
  const generation = claimOwnership(db.raw).generation;
  const tasks = new TaskManager(db.raw, ws);
  cleanups.push(async () => { await tasks.close(); });
  return { db, tasks, generation };
}

async function settle(tasks: TaskManager, taskId: string, states: string[]): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = tasks.snapshot(taskId).state;
    if (states.includes(state)) return state;
    if (Date.now() > deadline) throw new Error(`task stayed ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe.skipIf(!built)("crash recovery with a real SIGKILL of the owning process", () => {
  it("crash during a provider call: INTERRUPTED, UNKNOWN kept, cost stays counted, explicit acknowledgement resumes", async () => {
    const { data, ws } = setup();
    const provider = await scriptedProvider([{ hang: true }, { text: "O README descreve um projeto de teste." }]);
    cleanups.push(() => provider.close());
    const { child, taskId, exited } = await runChild({ CRASH_DATA: data, CRASH_WS: ws, CRASH_PROVIDER_URL: provider.url, CRASH_OBJECTIVE: "Explique o README.md" });
    await provider.waitForRequests(1);
    child.kill("SIGKILL");
    expect(await exited).toBe("SIGKILL");

    const { db, tasks, generation } = reopen(data, ws);
    expect(generation).toBeGreaterThan(1);
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.state).toBe("INTERRUPTED");
    expect(snapshot.stateReason).toContain("executor lost");
    expect(snapshot.unknownHistory).toHaveLength(1);
    expect(snapshot.unknownHistory[0]).toMatchObject({ operation: "model.invoke", acknowledged: false, reconcile: "acknowledge-only" });
    // The request reached the provider: possible consumption, never zero.
    expect(snapshot.budget.possibleCalls).toBe(1);
    expect(snapshot.budget.possibleTokens ?? 0).toBeGreaterThan(0);
    expect(snapshot.capabilities?.stop.allowed).toBe(false);
    expect(snapshot.capabilities?.resume).toMatchObject({ allowed: false, requiresAcknowledgement: true });
    expect(snapshot.capabilities?.send.allowed).toBe(false);
    // Observation cannot reconcile a remote call.
    const observe = tasks.handleCommand({ commandId: "c-observe", kind: "reconcile", taskId, payload: { attemptId: snapshot.unknownHistory[0]?.attemptId, action: "observe" } });
    expect(observe).toMatchObject({ accepted: false, reason: "denied" });
    // Resume without acknowledgement stays refused, with a reason.
    const refused = tasks.handleCommand({ commandId: "c-resume-1", kind: "resume-task", taskId });
    expect(refused).toMatchObject({ accepted: false });
    expect(refused.accepted ? "" : refused.detail).toContain("incertos");

    const resumed = tasks.handleCommand({ commandId: "c-resume-2", kind: "resume-task", taskId, payload: { acknowledgeUnknown: true } });
    expect(resumed).toMatchObject({ accepted: true, state: "READY" });
    const started = tasks.handleCommand({ commandId: "c-start", kind: "start-task", taskId });
    expect(started).toMatchObject({ accepted: true });
    expect(await settle(tasks, taskId, ["COMPLETED", "NEEDS_INPUT", "BLOCKED"])).toBe("COMPLETED");
    const after = tasks.snapshot(taskId);
    // The UNKNOWN stays in the ledger and keeps counting after completion.
    expect(after.unknownHistory).toHaveLength(1);
    expect(after.unknownHistory[0]?.acknowledged).toBe(true);
    expect(after.budget.possibleCalls).toBe(1);
    expect(after.budget.settledCalls).toBe(1);
    expect(provider.bodies).toHaveLength(2);
    const acknowledgements = db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'unknown.acknowledged'").get(taskId) as { n: number };
    expect(acknowledgements.n).toBe(1);
  }, 30_000);

  it("crash after the dispatch marker but before the request left: stays UNKNOWN (no local proof), nothing reached the provider", async () => {
    const { data, ws } = setup();
    const provider = await scriptedProvider([{ text: "never used" }]);
    cleanups.push(() => provider.close());
    const { exited, taskId } = await runChild({ CRASH_DATA: data, CRASH_WS: ws, CRASH_PROVIDER_URL: provider.url, CRASH_OBJECTIVE: "Explique o README.md", CRASH_MODE: "before-send" });
    expect(await exited).toBe("SIGKILL");
    expect(provider.bodies).toHaveLength(0);
    const { tasks } = reopen(data, ws);
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.state).toBe("INTERRUPTED");
    // The marker committed, so the runtime cannot prove the request was not
    // sent: it stays UNKNOWN rather than claiming zero cost.
    expect(snapshot.unknownHistory.map((entry) => entry.operation)).toEqual(["model.invoke"]);
  }, 30_000);

  it("crash right after an edit hit the disk and before its receipt: observation proves the effect and blocks a duplicate", async () => {
    const { data, ws } = setup();
    const before = "export const total = (a, b) => a - b;\n";
    fs.writeFileSync(path.join(ws, "sum.js"), before);
    const edit = { kind: "replace", path: "sum.js", expectedVersion: versionOf(before), oldText: "a - b", newText: "a + b" };
    const provider = await scriptedProvider([
      { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify(edit) }] },
      // After resume the model repeats the same edit; admission must refuse it.
      { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify(edit) }] },
      { text: "Corrigido." },
    ]);
    cleanups.push(() => provider.close());
    const { exited, taskId } = await runChild({ CRASH_DATA: data, CRASH_WS: ws, CRASH_PROVIDER_URL: provider.url, CRASH_OBJECTIVE: "Corrija a soma em sum.js", CRASH_MODE: "after-rename:sum.js" });
    expect(await exited).toBe("SIGKILL");
    const after = "export const total = (a, b) => a + b;\n";
    expect(fs.readFileSync(path.join(ws, "sum.js"), "utf8")).toBe(after);

    const { db, tasks } = reopen(data, ws);
    let snapshot = tasks.snapshot(taskId);
    expect(snapshot.state).toBe("INTERRUPTED");
    const unknown = snapshot.unknownHistory.find((entry) => entry.operation === "edit");
    expect(unknown).toMatchObject({ reconcile: "observe", target: "sum.js" });

    // Acknowledge (do not reconcile) and resume: the identical edit is refused.
    expect(tasks.handleCommand({ commandId: "e-resume", kind: "resume-task", taskId, payload: { acknowledgeUnknown: true } })).toMatchObject({ accepted: true });
    expect(tasks.handleCommand({ commandId: "e-start", kind: "start-task", taskId })).toMatchObject({ accepted: true });
    await settle(tasks, taskId, ["COMPLETED", "NEEDS_INPUT", "BLOCKED"]);
    expect(fs.readFileSync(path.join(ws, "sum.js"), "utf8")).toBe(after);
    const denied = db.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = 'edit'").get(taskId) as { n: number };
    expect(denied.n).toBe(1);
    expect(provider.bodies[2]).toContain("already pending or UNKNOWN");

    // Observation now proves the effect from disk alone.
    snapshot = tasks.snapshot(taskId);
    const reconciled = tasks.handleCommand({ commandId: "e-observe", kind: "reconcile", taskId, payload: { attemptId: unknown?.attemptId, action: "observe" } });
    expect(reconciled).toMatchObject({ accepted: true });
    expect(reconciled.accepted ? reconciled.detail : "").toContain("planned replacement applied");
    expect(tasks.snapshot(taskId).unknownHistory).toHaveLength(0);
    expect(readTaskState(db.raw, taskId).state).not.toBe("RUNNING");
  }, 30_000);
});
