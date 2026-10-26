import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { createContract } from "../../src/runtime/contract.js";
import {
  detectWorkspaceDrift,
  evaluateResumeGate,
  grantedFromContract,
  listSessions,
  openRun,
  openSession,
  pendingObligations,
  readRunManifest,
  readTaskState,
  recordTaskEvent,
  resumeTask,
  satisfyObligation,
  unknownHistory,
  type ResumeReport,
} from "../../src/runtime/continuity.js";
import { admitDurable, claimDurable, markDispatching } from "../../src/runtime/effects.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Cleanup is best effort; the assertions already ran.
    }
  }
  openHandles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function track(handle: LatticeDb): LatticeDb {
  openHandles.push(handle);
  return handle;
}

function dir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-continuity-"));
  dirs.push(dir);
  return dir;
}

function workspaceFile(workspace: string, name: string, content: string): void {
  const full = path.join(workspace, name);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function versionOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
}

function persistTask(
  db: LatticeDb["raw"],
  workspace: string,
  opts?: { expiresAt?: string; taskState?: string; obligations?: string[] },
): { taskId: string; rootId: string; sessionId: string } {
  const taskId = `task-${Math.floor(Math.random() * 1e9)}`;
  const rootId = `root-${taskId}`;
  const contract = createContract({
    taskId,
    rootId,
    objective: "Resume the fixture",
    scope: [workspace],
    acceptanceCriteria: ["tests pass"],
    obligations: opts?.obligations ?? ["preserve human work", "fix the bug"],
    grants: [
      { subject: "agent", operations: ["search", "read", "edit", "exec", "model.invoke"], targets: [workspace], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "fake",
    allowedModel: "fake-model-1",
    expiresAt: opts?.expiresAt ?? new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    retentionPolicy: "retain until explicit deletion",
    origin: "test",
  });
  db.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    rootId,
    contract.revision,
    JSON.stringify(contract),
    new Date().toISOString(),
  );
  const { sessionId } = openSession(db, rootId);
  openRun(db, { sessionId, rootId, taskId, manifest: { provider: "openai", model: "m1", packageVersion: "0.0.0", workspace } });
  recordTaskEvent(db, taskId, "task-state", { state: opts?.taskState ?? "RUNNING", reason: "test" });
  return { taskId, rootId, sessionId };
}

describe("sessions and runs", () => {
  it("reuses the session for the same root and lists it", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const first = persistTask(opened.raw, workspace);
    const again = openSession(opened.raw, first.rootId);
    expect(again.sessionId).toBe(first.sessionId);
    const sessions = listSessions(opened.raw);
    expect(sessions.some((row) => row.taskId === first.taskId && row.sessionId === first.sessionId)).toBe(true);
  });

  it("derives granted budget from the persisted contract, never renewing it", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    expect(grantedFromContract(JSON.parse(row.document))).toEqual({ calls: 50, tokens: 200000 });
  });
});

describe("obligations", () => {
  it("retires satisfied obligations with evidence and keeps the rest pending", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    expect(pendingObligations(opened.raw, contract)).toEqual(["preserve human work", "fix the bug"]);
    satisfyObligation(opened.raw, taskId, "fix the bug", "verify-12");
    expect(pendingObligations(opened.raw, contract)).toEqual(["preserve human work"]);
  });
});

describe("workspace drift and stale evidence", () => {
  function editReceiptTask(workspace: string): { db: LatticeDb; taskId: string; before: string; after: string } {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const before = "line one\n";
    const after = "line one\nline two\n";
    workspaceFile(workspace, "a.txt", before);
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const admitted = admitDurable(
      opened.raw,
      contract,
      {
        taskId,
        operation: "edit",
        target: "a.txt",
        actionKey: "edit-a",
        authorityRevision: 1,
        maxCalls: 0,
        maxTokens: 0,
        argsJson: JSON.stringify({ kind: "replace", path: "a.txt", expectedVersion: versionOf(before) }),
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(opened.raw, admitted.attemptId);
    opened.raw.prepare("INSERT INTO receipts (receipt_id, attempt_id, outcome, detail, recorded_at) VALUES (?, ?, ?, ?, ?)").run(
      "receipt-1",
      admitted.attemptId,
      "confirmed",
      JSON.stringify({ summary: "replaced", detail: JSON.stringify({ tool: "edit", version: versionOf(after), afterVersion: versionOf(after) }) }),
      new Date().toISOString(),
    );
    workspaceFile(workspace, "a.txt", after);
    return { db: opened, taskId, before, after };
  }

  it("reports a human-modified file as drift and stale evidence", () => {
    const root = dir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { db, taskId } = editReceiptTask(workspace);
    workspaceFile(workspace, "a.txt", "line one\nline two\nhuman line\n");
    const drift = detectWorkspaceDrift(db.raw, taskId, workspace);
    expect(drift).toHaveLength(1);
    expect(drift[0]).toMatchObject({ path: "a.txt", change: "modified" });
    const report = evaluateResumeGate(db.raw, { taskId, generation: 1, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers.some((entry) => entry.code === "unknown-effects")).toBe(true);
    expect(report.staleEvidence).toHaveLength(1);
    expect(report.staleEvidence[0]?.path).toBe("a.txt");
  });

  it("reports a deleted file and ignores files the task never touched", () => {
    const root = dir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { db, taskId } = editReceiptTask(workspace);
    fs.rmSync(path.join(workspace, "a.txt"));
    workspaceFile(workspace, "unrelated.txt", "human scratch");
    const drift = detectWorkspaceDrift(db.raw, taskId, workspace);
    expect(drift).toEqual([{ path: "a.txt", change: "deleted", lastObserved: drift[0]?.lastObserved ?? null, current: null }]);
  });

  it("finds no drift when the workspace still matches observations", () => {
    const root = dir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { db, taskId } = editReceiptTask(workspace);
    expect(detectWorkspaceDrift(db.raw, taskId, workspace)).toEqual([]);
  });
});

describe("resume gate", () => {
  it("refuses resume without a usable contract", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(opened.raw, { taskId: "task-missing", generation: 1, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers[0]?.code).toBe("no-contract");
  });

  it("blocks resume on an expired contract without renewing anything", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace, { expiresAt: new Date(Date.now() - 1000).toISOString() });
    const report: ResumeReport = evaluateResumeGate(opened.raw, { taskId, generation: 1, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.expired).toBe(true);
    expect(report.blockers.some((blocker) => blocker.code === "contract-expired")).toBe(true);
  });

  it("blocks resume of terminal tasks", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace, { taskState: "COMPLETED" });
    const report = evaluateResumeGate(opened.raw, { taskId, generation: 1, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers.some((blocker) => blocker.code === "terminal-state")).toBe(true);
  });

  it("blocks resume when the workspace is gone", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    fs.rmSync(workspace, { recursive: true, force: true });
    const report = evaluateResumeGate(opened.raw, { taskId, generation: 1, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers.some((blocker) => blocker.code === "workspace-missing")).toBe(true);
  });

  it("invalidates never-claimed admissions and quarantines claims without receipts", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const intent = (key: string) => ({
      taskId,
      operation: "edit",
      target: "a.txt",
      actionKey: key,
      authorityRevision: 1,
      maxCalls: 0,
      maxTokens: 0,
      argsJson: JSON.stringify({ kind: "replace", path: "a.txt", expectedVersion: "sha256:x" }),
    });
    const orphan = admitDurable(opened.raw, contract, intent("orphan"), { calls: 50, tokens: 200000 }, 1);
    if (!orphan.admitted) throw new Error("admission failed");
    const claimed = admitDurable(opened.raw, contract, intent("crashed"), { calls: 50, tokens: 200000 }, 1);
    if (!claimed.admitted) throw new Error("admission failed");
    expect(claimDurable(opened.raw, claimed.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(opened.raw, claimed.attemptId);
    const report = evaluateResumeGate(opened.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers.some((entry) => entry.code === "unknown-effects")).toBe(true);
    expect(report.invalidatedAdmissions).toEqual([orphan.intentId]);
    expect(report.unknowns.map((entry) => entry.attemptId)).toEqual([claimed.attemptId]);
    // A second evaluation finds nothing left to classify: classification is durable.
    const again = evaluateResumeGate(opened.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(again.invalidatedAdmissions).toEqual([]);
    expect(again.unknowns.map((entry) => entry.attemptId)).toEqual([claimed.attemptId]);
  });

  it("quarantines supervised-process claims without touching the process", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const admitted = admitDurable(
      opened.raw,
      contract,
      {
        taskId,
        operation: "exec",
        target: "sleep",
        actionKey: "exec-sleep",
        authorityRevision: 1,
        maxCalls: 0,
        maxTokens: 0,
        argsJson: "{}",
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(opened.raw, admitted.attemptId);
    const report = evaluateResumeGate(opened.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(report.unknowns).toHaveLength(1);
    expect(unknownHistory(opened.raw, taskId)).toHaveLength(1);
  });

  it("manual resume opens a new run under the same session without replaying effects", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId, sessionId } = persistTask(opened.raw, workspace);
    const report = resumeTask(opened.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(true);
    expect(report.sessionId).toBe(sessionId);
    expect(report.newRunId).not.toBeNull();
    expect(readTaskState(opened.raw, taskId).state).toBe("READY");
    const runs = opened.raw.prepare("SELECT COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId) as { n: number };
    expect(runs.n).toBe(2);
  });

  it("manual resume makes WAITING startable while retaining the durable wait gate", () => {    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace, { taskState: "WAITING" });
    const report = resumeTask(opened.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(true);
    expect(readTaskState(opened.raw, taskId).state).toBe("READY");
  });

  it("preserves settled budget across close and reopen with no renewal", () => {
    const root = dir();
    const first = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(first.raw, workspace);
    const row = first.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const admitted = admitDurable(
      first.raw,
      contract,
      {
        taskId,
        operation: "model.invoke",
        target: "fake/m",
        actionKey: "model-1",
        authorityRevision: 1,
        maxCalls: 1,
        maxTokens: 4000,
        argsJson: "{}",
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    // Claimed but never resolved: the reservation stays open across restart.
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    // One call and 4000 tokens still reserved from before the restart.
    expect(report.budget.reserved).toEqual({ calls: 1, tokens: 4000 });
    expect(report.budget.settled).toEqual({ calls: 0, tokens: 0 });
    // The remaining budget admits exactly what is left, nothing more.
    const row2 = second.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract2 = JSON.parse(row2.document) as Parameters<typeof pendingObligations>[1];
    const over = admitDurable(
      second.raw,
      contract2,
      {
        taskId,
        operation: "model.invoke",
        target: "fake/m",
        actionKey: "model-2",
        authorityRevision: 1,
        maxCalls: 50,
        maxTokens: 200000,
        argsJson: "{}",
      },
      grantedFromContract(contract2),
      2,
    );
    expect(over.admitted).toBe(false);
  });

  it("keeps UNKNOWN history across restart with identity and reason", () => {
    const root = dir();
    const first = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(first.raw, workspace);
    const row = first.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const admitted = admitDurable(
      first.raw,
      contract,
      {
        taskId,
        operation: "exec",
        target: "cmd",
        actionKey: "exec-1",
        authorityRevision: 1,
        maxCalls: 0,
        maxTokens: 0,
        argsJson: "{}",
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId, generation: 2, packageVersion: "0.0.0" });
    expect(report.unknowns).toHaveLength(1);
    expect(report.unknowns[0]).toMatchObject({ attemptId: admitted.attemptId, operation: "exec", target: "cmd" });
  });
});

describe("clocks across boots", () => {
  it("evaluates expiry on wall-clock UTC, never on monotonic time", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const future = persistTask(opened.raw, workspace, { expiresAt: new Date(Date.now() + 60_000).toISOString() });
    const past = persistTask(opened.raw, workspace, { expiresAt: new Date(Date.now() - 60_000).toISOString() });
    expect(evaluateResumeGate(opened.raw, { taskId: future.taskId, generation: 1, packageVersion: "0.0.0" }).expired).toBe(false);
    const pastReport = evaluateResumeGate(opened.raw, { taskId: past.taskId, generation: 1, packageVersion: "0.0.0" });
    expect(pastReport.expired).toBe(true);
    expect(pastReport.canResume).toBe(false);
  });
});

describe("run manifests", () => {
  it("leaves in-flight admissions alone when classification is disabled", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId } = persistTask(opened.raw, workspace);
    const row = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const contract = JSON.parse(row.document) as Parameters<typeof pendingObligations>[1];
    const admitted = admitDurable(
      opened.raw,
      contract,
      {
        taskId,
        operation: "edit",
        target: "a.txt",
        actionKey: "hot",
        authorityRevision: 1,
        maxCalls: 0,
        maxTokens: 0,
        argsJson: "{}",
      },
      { calls: 50, tokens: 200000 },
      1,
    );
    if (!admitted.admitted) throw new Error("admission failed");
    // Hot read path (e.g. snapshot during a live run): reports, never
    // invalidates in-flight work.
    const preview = evaluateResumeGate(opened.raw, { taskId, generation: 1, packageVersion: "0.0.0" }, { classifyPending: false });
    expect(preview.invalidatedAdmissions).toEqual([]);
    const state = opened.raw.prepare("SELECT state FROM intents WHERE intent_id = ?").get(admitted.intentId) as { state: string };
    expect(state.state).toBe("ADMITTED");
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
  });

  it("inherits composition past resume-marker runs and fails closed without any", () => {
    const root = dir();
    const opened = track(openLatticeDb(path.join(root, "data")));
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const { taskId, rootId, sessionId } = persistTask(opened.raw, workspace);
    openRun(opened.raw, { sessionId, rootId, taskId, manifest: { resumedFromState: "READY" } });
    expect(readRunManifest(opened.raw, taskId)).toMatchObject({ provider: "openai", model: "m1" });
    expect(() => readRunManifest(opened.raw, "task-missing")).toThrow(/no run composition/);
  });
});
