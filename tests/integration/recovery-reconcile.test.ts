import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { readContract, readTaskState, recordTaskEvent, recoverOrphanedTasks, unknownHistory } from "../../src/runtime/continuity.js";
import { admitDurable, claimDurable, markDispatching, taskBudgetSnapshot } from "../../src/runtime/effects.js";
import { reconcileCommand, resumeCommand } from "../../src/cli/continuity.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

function versionOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
}

function setup(baseUrl = "http://127.0.0.1:59998/v1"): { db: LatticeDb; tasks: TaskManager; taskId: string; ws: string; data: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-reconcile-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const ws = path.join(dir, "ws");
  fs.mkdirSync(ws);
  const data = path.join(dir, "data");
  const db = openLatticeDb(data);
  cleanups.push(() => {
    try { db.close(); } catch { /* already closed by the test */ }
  });
  claimOwnership(db.raw);
  const tasks = new TaskManager(db.raw, ws);
  cleanups.push(async () => { await tasks.close(); });
  const created = tasks.handleCommand({ commandId: "create", kind: "create-task", payload: { workspace: "", objective: "Explique o projeto", provider: "local", model: "m", baseUrl } });
  if (!created.accepted) throw new Error("create refused");
  return { db, tasks, taskId: created.taskId, ws, data };
}

function claimTool(db: LatticeDb, taskId: string, operation: string, target: string | null, args: unknown, dispatched = true): string {
  const contract = readContract(db.raw, taskId);
  if (contract === null) throw new Error("no contract");
  const admitted = admitDurable(db.raw, contract, { taskId, operation, target, actionKey: `tool:${operation}:${JSON.stringify(args)}`, authorityRevision: contract.revision, maxCalls: 0, maxTokens: 0, argsJson: JSON.stringify(args) }, { calls: null, tokens: null }, 1);
  if (!admitted.admitted) throw new Error(`admission refused: ${admitted.detail}`);
  expect(claimDurable(db.raw, admitted.attemptId, 1, contract.revision)).toEqual({ claimed: true });
  if (dispatched) markDispatching(db.raw, admitted.attemptId);
  return admitted.attemptId;
}

function crash(db: LatticeDb, taskId: string): void {
  recordTaskEvent(db.raw, taskId, "task-state", { state: "RUNNING", reason: "loop started", generation: 1 });
  recoverOrphanedTasks(db.raw, 2);
}

async function provider(handler: (count: number, response: http.ServerResponse) => void): Promise<{ url: string; count: () => number; close: () => Promise<void> }> {
  let count = 0;
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => { count += 1; handler(count, response); });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { resolve((server.address() as { port: number }).port); }));
  const close = async (): Promise<void> => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); };
  cleanups.push(close);
  return { url: `http://127.0.0.1:${port}/v1`, count: () => count, close };
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

describe("orphan recovery classification", () => {
  it("a claim whose dispatch marker never committed is settled as not executed, with zero cost", () => {
    const { db, tasks, taskId } = setup();
    const contract = readContract(db.raw, taskId);
    if (contract === null) throw new Error("no contract");
    const admitted = admitDurable(db.raw, contract, { taskId, operation: "model.invoke", target: "local/m", actionKey: "model-x", authorityRevision: contract.revision, maxCalls: 1, maxTokens: 4000, argsJson: "{}", provider: "local", model: "m" }, { calls: null, tokens: null }, 1);
    if (!admitted.admitted) throw new Error(admitted.detail);
    expect(claimDurable(db.raw, admitted.attemptId, 1, contract.revision)).toEqual({ claimed: true });
    crash(db, taskId);
    expect(readTaskState(db.raw, taskId).state).toBe("INTERRUPTED");
    expect(unknownHistory(db.raw, taskId)).toEqual([]);
    expect(taskBudgetSnapshot(db.raw, taskId, { calls: null, tokens: null })).toMatchObject({ reserved: { calls: 0, tokens: 0 }, settled: { calls: 0, tokens: 0 } });
    const evidence = db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ? AND kind = 'unknown.not-dispatched'").get(taskId) as { n: number };
    expect(evidence.n).toBe(1);
    expect(tasks.snapshot(taskId).capabilities?.resume.allowed).toBe(true);
  });

  it("a legacy claim without the marker protocol stays UNKNOWN (no proof either way)", () => {
    const { db, taskId } = setup();
    const attemptId = claimTool(db, taskId, "edit", "a.txt", { kind: "create", path: "a.txt", content: "x" }, false);
    db.raw.prepare("UPDATE attempts SET ticket = json_remove(ticket, '$.dispatchMarker') WHERE attempt_id = ?").run(attemptId);
    crash(db, taskId);
    expect(unknownHistory(db.raw, taskId).map((entry) => entry.attemptId)).toEqual([attemptId]);
  });

  it("only a live executor generation is spared; other RUNNING tasks become INTERRUPTED once", () => {
    const { db, taskId } = setup();
    recordTaskEvent(db.raw, taskId, "task-state", { state: "RUNNING", reason: "loop started", generation: 2 });
    expect(recoverOrphanedTasks(db.raw, 2)).toEqual([]);
    expect(recoverOrphanedTasks(db.raw, 3).map((entry) => entry.taskId)).toEqual([taskId]);
    expect(recoverOrphanedTasks(db.raw, 3)).toEqual([]);
  });
});

describe("reconciliation by operation", () => {
  it("read/search are closed as inert; exec needs an explicit recorded human decision", () => {
    const { db, tasks, taskId } = setup();
    const read = claimTool(db, taskId, "read", "a.txt", { path: "a.txt" });
    const exec = claimTool(db, taskId, "exec", "/bin/true", { executable: "/bin/true", argv: [] });
    crash(db, taskId);
    expect(tasks.snapshot(taskId).unknownHistory.map((entry) => entry.reconcile)).toEqual(["observe", "decide"]);
    expect(tasks.handleCommand({ commandId: "r1", kind: "reconcile", taskId, payload: { attemptId: read, action: "observe" } })).toMatchObject({ accepted: true });
    const observed = tasks.handleCommand({ commandId: "r2", kind: "reconcile", taskId, payload: { attemptId: exec, action: "observe" } });
    expect(observed).toMatchObject({ accepted: false, reason: "denied" });
    const decided = tasks.handleCommand({ commandId: "r3", kind: "reconcile", taskId, payload: { attemptId: exec, action: "treat-as-not-applied", note: "nada mudou no projeto" } });
    expect(decided).toMatchObject({ accepted: true });
    expect(unknownHistory(db.raw, taskId)).toEqual([]);
    const human = db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'reconciliation.human'").get(taskId) as { payload: string };
    expect(JSON.parse(human.payload)).toMatchObject({ attemptId: exec, decision: "treat-as-not-applied", actor: "human", note: "nada mudou no projeto" });
    expect(tasks.snapshot(taskId).capabilities?.resume.allowed).toBe(true);
  });

  it("edit kinds are reconciled by observing the disk against the plan", () => {
    const { db, tasks, taskId, ws } = setup();
    fs.writeFileSync(path.join(ws, "created.txt"), "planned");
    const create = claimTool(db, taskId, "edit", "created.txt", { kind: "create", path: "created.txt", content: "planned" });
    fs.writeFileSync(path.join(ws, "kept.txt"), "still here");
    const del = claimTool(db, taskId, "edit", "kept.txt", { kind: "delete", path: "kept.txt", expectedVersion: versionOf("still here") });
    fs.writeFileSync(path.join(ws, "moved.txt"), "content");
    const rename = claimTool(db, taskId, "edit", "old.txt", { kind: "rename", path: "old.txt", expectedVersion: versionOf("content"), newPath: "moved.txt" });
    fs.writeFileSync(path.join(ws, "other.txt"), "someone else wrote this");
    const conflict = claimTool(db, taskId, "edit", "other.txt", { kind: "replace", path: "other.txt", expectedVersion: versionOf("original"), oldText: "original", newText: "changed" });
    crash(db, taskId);
    const outcome = (attemptId: string): string => {
      const result = tasks.handleCommand({ commandId: `o-${attemptId}`, kind: "reconcile", taskId, payload: { attemptId, action: "observe" } });
      return result.detail ?? "";
    };
    expect(outcome(create)).toContain("planned content");
    expect(outcome(del)).toContain("delete not applied");
    expect(outcome(rename)).toContain("now at moved.txt");
    expect(outcome(conflict)).toContain("human decision required");
    expect(unknownHistory(db.raw, taskId).map((entry) => entry.attemptId)).toEqual([conflict]);
  });
});

describe("capabilities and the single send action", () => {
  it("a human stop leaves work that can continue; COMPLETED only continues as follow-up", () => {
    const { db, tasks, taskId } = setup();
    recordTaskEvent(db.raw, taskId, "task-state", { state: "CANCELLED", reason: "stop requested" });
    expect(tasks.snapshot(taskId).capabilities).toMatchObject({ send: { allowed: true, mode: "continue" }, resume: { allowed: true }, stop: { allowed: false } });
    recordTaskEvent(db.raw, taskId, "task-state", { state: "COMPLETED", reason: "done" });
    const caps = tasks.snapshot(taskId).capabilities;
    expect(caps).toMatchObject({ send: { allowed: true, mode: "follow-up" }, resume: { allowed: false } });
    expect(caps?.resume.reason).toContain("seguimento");
  });

  it("every refused capability carries a reason", () => {
    const { db, tasks, taskId } = setup();
    recordTaskEvent(db.raw, taskId, "task-state", { state: "BLOCKED", reason: "x" });
    const caps = tasks.snapshot(taskId).capabilities;
    if (caps === undefined) throw new Error("no capabilities");
    for (const [name, capability] of Object.entries(caps)) {
      if (!capability.allowed) expect(capability.reason, name).toMatch(/\S/);
    }
  });
});

describe("provider delivery classification", () => {
  it("an unreachable endpoint is not sent: zero cost, bounded automatic retries, no UNKNOWN", async () => {
    const closed = await provider(() => undefined);
    await closed.close();
    const { tasks, taskId, db } = setup(closed.url);
    expect(tasks.handleCommand({ commandId: "s", kind: "start-task", taskId })).toMatchObject({ accepted: true });
    expect(await settle(tasks, taskId, ["BLOCKED", "NEEDS_INPUT", "COMPLETED"])).toBe("BLOCKED");
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.unknownHistory).toEqual([]);
    expect(snapshot.budget).toMatchObject({ settledCalls: 0, reservedCalls: 0, possibleCalls: 0 });
    const attempts = db.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = 'model.invoke'").get(taskId) as { n: number };
    expect(attempts.n).toBe(3);
    expect(snapshot.capabilities?.send).toMatchObject({ allowed: true, mode: "continue" });
  }, 20_000);

  it("a 500 after delivery stays UNKNOWN with its reservation counted", async () => {
    const failing = await provider((_count, response) => { response.writeHead(500); response.end("{}"); });
    const { tasks, taskId } = setup(failing.url);
    tasks.handleCommand({ commandId: "s", kind: "start-task", taskId });
    expect(await settle(tasks, taskId, ["BLOCKED", "NEEDS_INPUT", "COMPLETED"])).toBe("BLOCKED");
    const snapshot = tasks.snapshot(taskId);
    expect(failing.count()).toBe(1);
    expect(snapshot.unknownHistory.map((entry) => entry.operation)).toEqual(["model.invoke"]);
    // The call itself is counted as settled; its token reservation stays as
    // possible consumption instead of being released as zero.
    expect(snapshot.budget.settledCalls).toBe(1);
    expect(snapshot.budget.possibleTokens ?? 0).toBeGreaterThan(0);
  });

  it("stopping during an in-flight call keeps that call UNKNOWN instead of free", async () => {
    const hanging: http.ServerResponse[] = [];
    const slow = await provider((_count, response) => { hanging.push(response); });
    const { tasks, taskId } = setup(slow.url);
    tasks.handleCommand({ commandId: "s", kind: "start-task", taskId });
    const deadline = Date.now() + 5000;
    while (slow.count() < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20));
    expect(tasks.handleCommand({ commandId: "stop", kind: "stop", taskId })).toMatchObject({ accepted: true });
    expect(await settle(tasks, taskId, ["CANCELLED"])).toBe("CANCELLED");
    for (const response of hanging) response.destroy();
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.unknownHistory.map((entry) => entry.operation)).toEqual(["model.invoke"]);
    expect(snapshot.capabilities?.resume).toMatchObject({ allowed: false, requiresAcknowledgement: true });
  });
});

async function captureStdout(run: () => Promise<number>): Promise<{ code: number; out: string }> {
  const original = process.stdout.write;
  let out = "";
  process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
  try {
    return { code: await run(), out };
  } finally {
    process.stdout.write = original;
  }
}

describe("cli recovery", () => {
  it("resume refuses unacknowledged UNKNOWN with guidance, reconcile observes, acknowledgement resumes", async () => {
    const { db, tasks, taskId, ws, data } = setup();
    fs.writeFileSync(path.join(ws, "made.txt"), "planned");
    const create = claimTool(db, taskId, "edit", "made.txt", { kind: "create", path: "made.txt", content: "planned" });
    const exec = claimTool(db, taskId, "exec", "/bin/true", { executable: "/bin/true", argv: [] });
    recordTaskEvent(db.raw, taskId, "task-state", { state: "RUNNING", reason: "loop started", generation: 1 });
    db.raw.prepare("UPDATE ownership SET pid = 999999999, process_identity = 'dead'").run();
    await tasks.close();
    db.close();
    const refused = await captureStdout(() => resumeCommand({ workspace: ws, dataDir: data, taskId, json: false }));
    expect(refused.code).toBe(1);
    expect(refused.out).toContain("unknown-effects");
    expect(refused.out).toContain("--acknowledge-unknown");
    const observed = await captureStdout(() => reconcileCommand({ workspace: ws, dataDir: data, taskId, attemptId: create, action: "observe", note: null, json: false }));
    expect(observed.code).toBe(0);
    expect(observed.out).toContain("applied");
    const resumed = await captureStdout(() => resumeCommand({ workspace: ws, dataDir: data, taskId, json: false, acknowledgeUnknown: true }));
    expect(resumed.code).toBe(0);
    expect(resumed.out).toContain(`${exec} exec`);
    expect(resumed.out).toContain("[acknowledged]");
  });
});
