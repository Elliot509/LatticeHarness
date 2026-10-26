import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { claimOwnership } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";
import type { UiEvent } from "../../src/server/protocol.js";

let dirs: string[] = [];
let handles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of handles) {
    try {
      handle.close();
    } catch {
      // Best effort cleanup.
    }
  }
  handles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function manager() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-server-"));
  dirs.push(dir);
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace, { recursive: true });
  const opened = openLatticeDb(path.join(dir, "data"));
  handles.push(opened);
  claimOwnership(opened.raw);
  return new TaskManager(opened.raw, workspace);
}

function createReady(tasks: TaskManager) {
  const result = tasks.handleCommand({
    commandId: "cmd-create-1",
    kind: "create-task",
    payload: { workspace: "", objective: "Fix the bug and run the tests", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
  });
  if (!result.accepted) throw new Error("create-task denied");
  return result.taskId;
}

describe("task commands", () => {
  it("streams committed tool output, verification, chat and settled budget without a reload", async () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const events: UiEvent[] = [];
    tasks.subscribe(taskId, (event) => events.push(event));
    const provider = new FakeProvider([
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log('ok 1 - project verified')"] }) }] },
      { text: "Project verified." },
    ]);
    expect(tasks.startTask(taskId, "stream-run", provider).accepted).toBe(true);
    const deadline = Date.now() + 5000;
    while (tasks.snapshot(taskId).state === "RUNNING" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.state).toBe("COMPLETED");
    const completed = events.find((event) => event.kind === "tool" && event.tool.complete === true);
    expect(completed?.kind === "tool" ? completed.tool : null).toEqual(snapshot.tools[0]);
    expect(snapshot.tools[0]?.summary).toContain("exit 0");
    expect(events.some((event) => event.kind === "verification" && event.verification.passed === 1)).toBe(true);
    expect(events.some((event) => event.kind === "message" && event.message.text === "Project verified.")).toBe(true);
    const budgets = events.filter((event) => event.kind === "budget");
    expect(budgets.at(-1)?.kind === "budget" ? budgets.at(-1)?.budget : null).toEqual(snapshot.budget);
    expect(snapshot.budget.settledCalls).toBe(2);
  });

  it("creates tasks inside the server workspace only", () => {
    const tasks = manager();
    const ok = tasks.handleCommand({
      commandId: "c1",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    expect(ok.accepted).toBe(true);
    const escaped = tasks.handleCommand({
      commandId: "c2",
      kind: "create-task",
      payload: { workspace: "../..", objective: "Fix it", provider: "openai", model: "m1" },
    });
    expect(escaped).toMatchObject({ accepted: false, reason: "invalid" });
    const badProvider = tasks.handleCommand({
      commandId: "c3",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "fake", model: "m1" },
    });
    expect(badProvider).toMatchObject({ accepted: false, reason: "invalid" });
  });

  it("deduplicates repeated commandIds without a second effect", () => {
    const tasks = manager();
    const first = tasks.handleCommand({
      commandId: "dup",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    const second = tasks.handleCommand({
      commandId: "dup",
      kind: "create-task",
      payload: { workspace: "", objective: "Fix it", provider: "openai", model: "m1", baseUrl: "http://127.0.0.1:9" },
    });
    expect(first).toEqual(second);
    expect(tasks.listSessions()).toHaveLength(1);
  });

  it("rejects stale steering and accepts current revisions", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const stale = tasks.handleCommand({
      commandId: "s1",
      kind: "steer",
      taskId,
      expectedRevision: 999,
      payload: { text: "be careful", mode: "guide" },
    });
    expect(stale).toMatchObject({ accepted: false, reason: "stale", revision: 1 });
    const accepted = tasks.handleCommand({
      commandId: "s2",
      kind: "steer",
      taskId,
      expectedRevision: 1,
      payload: { text: "be careful", mode: "guide" },
    });
    expect(accepted).toMatchObject({ accepted: true, revision: 2 });
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.contractRevision).toBe(2);
    expect(snapshot.steering).toHaveLength(1);
    expect(snapshot.steering[0]).toMatchObject({ state: "accepted", appliedRevision: null });
    expect(snapshot.objective).toContain("Fix the bug");
  });

  it("forbid steering adds prohibitions durably", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const result = tasks.handleCommand({
      commandId: "f1",
      kind: "steer",
      taskId,
      expectedRevision: 1,
      payload: { text: "network access", mode: "forbid" },
    });
    expect(result).toMatchObject({ accepted: true, revision: 2 });
    expect(tasks.snapshot(taskId).steering[0]).toMatchObject({ mode: "forbid" });
  });

  it("denies stop when nothing runs and select-model without a key", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    expect(tasks.handleCommand({ commandId: "x1", kind: "stop", taskId })).toMatchObject({
      accepted: false,
      reason: "denied",
    });
    expect(
      tasks.handleCommand({ commandId: "x2", kind: "select-model", taskId, payload: { provider: "openai", model: "m2" } }),
    ).toMatchObject({ accepted: false, reason: "denied" });
  });

  it("stops a running task and distinguishes request from observed end", async () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const hanging = {
      name: "hanging",
      adapterRevision: "hanging-1",
      complete: (request: { signal?: AbortSignal }) =>
        new Promise<never>((_resolve, reject) => {
          if (request.signal?.aborted === true) {
            reject(new Error("aborted before dispatch"));
            return;
          }
          request.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        }),
    };
    const started = tasks.startTask(taskId, "run-1", hanging as never);
    expect(started).toMatchObject({ accepted: true, state: "RUNNING" });
    const stopped = tasks.handleCommand({ commandId: "stop-1", kind: "stop", taskId });
    expect(stopped).toMatchObject({ accepted: true, state: "RUNNING" });
    expect(tasks.snapshot(taskId).state).toBe("RUNNING");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await new Promise((resolve) => setTimeout(resolve, 500));
    const observed = tasks.snapshot(taskId);
    expect(observed.state).toBe("CANCELLED");
    expect(observed.stateReason).toContain("stop requested");
    const again = tasks.handleCommand({ commandId: "stop-2", kind: "stop", taskId });
    expect(again).toMatchObject({ accepted: false });
  });

  it("select-model stays pending until the next bound request", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    tasks.handleCommand({
      commandId: "set-key-1",
      kind: "set-key",
      payload: { provider: "openai", key: "k" },
    });
    const switched = tasks.handleCommand({
      commandId: "model-1",
      kind: "select-model",
      taskId,
      payload: { provider: "openai", model: "m2", baseUrl: "http://127.0.0.1:9" },
    });
    expect(switched).toMatchObject({ accepted: true });
    expect(tasks.snapshot(taskId).model).toBe("m1");
  });

  it("stores keys in memory without echoing them", () => {
    const tasks = manager();
    expect(tasks.keyConfigured("openai")).toBe(false);
    const result = tasks.handleCommand({
      commandId: "k1",
      kind: "set-key",
      payload: { provider: "openai", key: "sekret" },
    });
    expect(result.accepted).toBe(true);
    expect(JSON.stringify(result)).not.toContain("sekret");
    expect(tasks.keyConfigured("openai")).toBe(true);
  });

  it("replays missed events and flags resync past the buffer", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const first = tasks.missedEvents(taskId, 0);
    expect(first.resync).toBe(false);
    expect(first.events.length).toBeGreaterThan(0);
    const cut = first.events[first.events.length - 1]?.seq ?? 0;
    expect(tasks.missedEvents(taskId, cut).events).toEqual([]);
    let revision = tasks.snapshot(taskId).contractRevision;
    for (let i = 0; i < 510; i += 1) {
      const result = tasks.handleCommand({
        commandId: `overflow-${i}`,
        kind: "steer",
        taskId,
        expectedRevision: revision,
        payload: { text: `note ${i}`, mode: "guide" },
      });
      if (!result.accepted) throw new Error(`steer ${i} denied`);
      revision = result.revision;
    }
    expect(tasks.missedEvents(taskId, cut).resync).toBe(true);
    const fresh = tasks.snapshot(taskId);
    expect(tasks.missedEvents(taskId, fresh.cut).events).toEqual([]);
  });

  it("snapshot exposes budget, unknowns and unknown context usage", () => {
    const tasks = manager();
    const taskId = createReady(tasks);
    const snapshot = tasks.snapshot(taskId);
    expect(snapshot.protocol).toBe("ui-1");
    expect(snapshot.budget).toMatchObject({ grantedCalls: null, grantedTokens: null });
    expect(snapshot.unknowns).toBe(0);
    expect(snapshot.contextUsage).toEqual({ known: false });
    expect(snapshot.messages[0]).toMatchObject({ author: "user", text: "Fix the bug and run the tests" });
  });
});
