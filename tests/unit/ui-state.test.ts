import { describe, expect, it } from "vitest";
import { initialState, uiReducer } from "../../src/ui/state.js";
import type { TaskSnapshot, UiEvent } from "../../src/server/protocol.js";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    protocol: "ui-1",
    taskId: "task-1",
    rootId: "root-1",
    workspace: "/ws",
    objective: "Fix it",
    acceptanceCriteria: ["tests pass"],
    state: "RUNNING",
    stateReason: "",
    contractRevision: 1,
    provider: "openai",
    model: "m1",
    baseUrl: null,
    keyConfigured: false,
    unknowns: 0,
    unknownHistory: [],
    waits: [],
    resumable: false,
    resumeBlockers: [],
    budget: { grantedCalls: 50, grantedTokens: 200000, reservedCalls: 0, reservedTokens: 0, settledCalls: 0, settledTokens: 0 },
    contextUsage: { known: false },
    messages: [],
    tools: [],
    verifications: [],
    steering: [],
    cut: 3,
    ...overrides,
  };
}

describe("ui reducer", () => {
  it("settles a pending message by its durable identity, from an event or a snapshot (PG-011)", () => {
    let state = uiReducer(initialState, { type: "open-task", taskId: "task-1" });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "cmd-a", kind: "steer", text: "olá", sentAt: 1 } });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "cmd-b", kind: "steer", text: "olá", sentAt: 2 } });
    const message = { id: "msg-cmd-a", seq: 4, author: "user" as const, text: "olá", recordedAt: "2026-10-26T00:00:00Z" };
    state = uiReducer(state, { type: "event", event: { seq: 4, kind: "message", message } });
    // Same text, different command: only the acknowledged one settles.
    expect(state.pending.map((command) => command.commandId)).toEqual(["cmd-b"]);
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ cut: 5, messages: [message, { ...message, id: "msg-cmd-b", seq: 5 }] }) });
    expect(state.pending).toEqual([]);
  });

  it("refreshes the resume gate after BLOCKED without dropping UNKNOWN or permitting retry", () => {
    let state = uiReducer(initialState, { type: "open-task", taskId: "task-1" });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ resumeBlockers: ["active-runtime"] }) });
    state = uiReducer(state, { type: "event", event: { seq: 4, kind: "state", state: "BLOCKED", reason: "model invocation UNKNOWN", contractRevision: 1 } });
    expect(state.needsResync).toBe(true);
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ cut: 4, state: "BLOCKED", unknowns: 1, resumeBlockers: ["unresolved-unknown"], resumable: false }) });
    expect(state.needsResync).toBe(false); expect(state.task?.resumeBlockers).not.toContain("active-runtime");
    expect(state.task?.unknowns).toBe(1); expect(state.task?.resumable).toBe(false);
  });
  it("removes rejected pending commands and restores a delayed draft to its original task", () => {
    let state = uiReducer(initialState, { type: "open-task", taskId: "task-1" });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "c", kind: "steer", text: "draft", sentAt: 1 } });
    state = uiReducer(state, { type: "command-failed", taskId: "task-1", commandId: "c", error: "denied" });
    expect(state.pending).toEqual([]); expect(state.actionError).toBe("denied");
    state = uiReducer(state, { type: "open-task", taskId: "task-2" });
    state = uiReducer(state, { type: "task-draft", taskId: "task-1", draft: "restored" });
    expect(state.draft).toBe(""); expect(state.drafts?.["task-1"]).toBe("restored");
    expect(state.actionError).toBeNull();
  });
  it("does not clear a newer gap when a snapshot from an older in-flight resync arrives", () => {
    let state = uiReducer(initialState, { type: "open-task", taskId: "task-1" });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ cut: 3 }) });
    state = uiReducer(state, { type: "event", event: { seq: 5, kind: "state", state: "RUNNING", reason: "", contractRevision: 1 } });
    state = uiReducer(state, { type: "event", event: { seq: 9, kind: "state", state: "COMPLETED", reason: "observed", contractRevision: 1 } });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ state: "RUNNING", cut: 5 }) });
    expect(state.needsResync).toBe(true); expect(state.resyncTarget).toBe(9);
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ state: "COMPLETED", cut: 9 }) });
    expect(state.needsResync).toBe(false); expect(state.task?.state).toBe("COMPLETED");
  });
  it("keeps a completed projection when an older snapshot arrives and reopening the same task preserves its draft", () => {
    let state = uiReducer(initialState, { type: "open-task", taskId: "task-1" });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ state: "COMPLETED", cut: 12 }) });
    state = uiReducer(state, { type: "draft", draft: "preserved" });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ state: "READY", cut: 10 }) });
    state = uiReducer(state, { type: "open-task", taskId: "task-1" });
    expect(state.task?.state).toBe("COMPLETED"); expect(state.draft).toBe("preserved");
    state = uiReducer(state, { type: "open-task", taskId: "task-2" });
    expect(state.draft).toBe("");
    state = uiReducer(state, { type: "open-task", taskId: "task-1" });
    expect(state.draft).toBe("preserved");
  });
  it("applies ordered events and ignores duplicates", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    const message: UiEvent = {
      seq: 4,
      kind: "message",
      message: { id: "m1", seq: 4, author: "agent", text: "hi", recordedAt: "t" },
    };
    state = uiReducer(state, { type: "event", event: message });
    expect(state.task?.messages).toHaveLength(1);
    expect(state.lastSeq).toBe(4);
    state = uiReducer(state, { type: "event", event: message });
    expect(state.task?.messages).toHaveLength(1);
    state = uiReducer(state, { type: "event", event: { ...message, seq: 3 } });
    expect(state.task?.messages).toHaveLength(1);
  });

  it("flags resync on gaps and on resync events", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, {
      type: "event",
      event: { seq: 9, kind: "state", state: "RUNNING", reason: "", contractRevision: 1 },
    });
    expect(state.needsResync).toBe(true);
    expect(state.task?.state).toBe("RUNNING");
  });

  it("updates tools in place by identity, not position", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    const started: UiEvent = {
      seq: 4,
      kind: "tool",
      tool: { id: "a1", seq: 4, tool: "exec", target: null, status: "running", summary: "started", detail: null, version: null, complete: false, truncated: false, durationMs: null, recordedAt: "t" },
    };
    const ended: UiEvent = {
      seq: 5,
      kind: "tool",
      tool: { id: "a1", seq: 5, tool: "exec", target: null, status: "completed", summary: "done", detail: null, version: null, complete: true, truncated: false, durationMs: 3, recordedAt: "t" },
    };
    state = uiReducer(state, { type: "event", event: started });
    state = uiReducer(state, { type: "event", event: ended });
    expect(state.task?.tools).toHaveLength(1);
    expect(state.task?.tools[0]?.status).toBe("completed");
  });

  it("preserves draft, detail and pending commands across snapshots", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, { type: "draft", draft: "half written" });
    state = uiReducer(state, { type: "select-detail", detailId: "a1" });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "c1", kind: "stop", text: "stop", sentAt: 1 } });
    state = uiReducer(state, { type: "snapshot", snapshot: snapshot({ cut: 10 }) });
    expect(state.draft).toBe("half written");
    expect(state.detailId).toBe("a1");
    expect(state.pending).toHaveLength(1);
    expect(state.lastSeq).toBe(10);
  });

  it("clears stop echoes once a terminal state arrives", () => {
    let state = uiReducer(initialState, { type: "snapshot", snapshot: snapshot() });
    state = uiReducer(state, { type: "command-sent", command: { commandId: "c1", kind: "stop", text: "stop", sentAt: 1 } });
    state = uiReducer(state, { type: "event", event: { seq: 4, kind: "state", state: "CANCELLED", reason: "x", contractRevision: 1 } });
    expect(state.task?.state).toBe("CANCELLED");
    expect(state.pending).toEqual([]);
  });

  it("toggles the sidebar and tracks connection", () => {
    let state = uiReducer(initialState, { type: "toggle-sidebar" });
    expect(state.sidebarOpen).toBe(false);
    state = uiReducer(state, { type: "connection", connection: "reconnecting" });
    expect(state.connection).toBe("reconnecting");
    state = uiReducer(state, { type: "connection", connection: "live" });
    expect(state.connection).toBe("live");
    expect(state.error).toBeNull();
  });
});
