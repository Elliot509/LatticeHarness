import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  markDispatching,
  claimDurable,
  findUnreconciledAttempts,
  reconcileEditAttempt,
  recordReceiptDurable,
  recordUsageRevision,
} from "../../src/runtime/effects.js";
import { evaluateResumeGate, resumeTask } from "../../src/runtime/continuity.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import { enterWait, recordWake } from "../../src/runtime/wait.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { EditTool } from "../../src/tools/edit.js";
import { ProcessSupervisor } from "../../src/tools/process.js";
import type { TaskContract } from "../../src/runtime/contract.js";

// Fault campaign over the ARCHITECTURE §7 crash boundaries. Every scenario
// interrupts an exact protocol step, closes and reopens the database (a real
// restart with a new owner generation), then asserts the persisted
// classification and the observed sink state. Killing the test process here
// models a runtime crash, not power loss: filesystem and SQLite survive.

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
let supervisors: ProcessSupervisor[] = [];
afterEach(async () => {
  clearFaults();
  for (const supervisor of supervisors) {
    try {
      await supervisor.close();
    } catch {
      // Cleanup is best effort; the assertions already ran.
    }
  }
  supervisors = [];
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

function freshDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-crash-"));
  dirs.push(dir);
  return dir;
}

function versionOf(content: string): string {
  return `sha256:${createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16)}`;
}

const BEFORE = "price: 10\n";
const AFTER = "price: 12\n";

function makeContract(taskId: string, workspace: string, expiresMs = 30 * 60 * 1000): TaskContract {
  return createContract({
    taskId,
    rootId: `root-${taskId}`,
    objective: "Edit with crash",
    scope: [workspace],
    acceptanceCriteria: ["file updated"],
    obligations: ["preserve baseline"],
    grants: [
      { subject: "agent", operations: ["edit", "exec", "model.invoke"], targets: [workspace], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
    ],
    prohibitions: ["publish"],
    realm: "local-trusted",
    allowedProvider: "fake",
    allowedModel: "fake-model-1",
    expiresAt: new Date(Date.now() + expiresMs).toISOString(),
    retentionPolicy: "retain until explicit deletion",
    origin: "test",
  });
}

function persistTask(db: LatticeDb["raw"], taskId: string, workspace: string): void {
  const contract = makeContract(taskId, workspace);
  db.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
    taskId,
    contract.rootId,
    contract.revision,
    JSON.stringify(contract),
    new Date().toISOString(),
  );
  db.prepare("INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
    `run-${taskId}`,
    `session-${taskId}`,
    contract.rootId,
    taskId,
    JSON.stringify({ packageVersion: "0.0.0", workspace }),
    new Date().toISOString(),
  );
}

function editIntent(taskId: string, key: string, expectedVersion: string) {
  return {
    taskId,
    operation: "edit",
    target: "price.txt",
    actionKey: key,
    authorityRevision: 1,
    maxCalls: 0,
    maxTokens: 0,
    argsJson: JSON.stringify({ kind: "replace", path: "price.txt", expectedVersion, oldText: BEFORE, newText: AFTER }),
  };
}

function intentsRow(db: LatticeDb["raw"], intentId: string): string {
  const row = db.prepare("SELECT state FROM intents WHERE intent_id = ?").get(intentId) as { state: string };
  return row.state;
}

async function applyEdit(workspace: string, expectedVersion: string) {
  const edit = new EditTool();
  return edit.execute(
    { kind: "replace", path: "price.txt", expectedVersion, oldText: BEFORE, newText: AFTER },
    { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: 5000 },
  );
}

describe("crash boundaries A-C: before any possible effect", () => {
  it("A: commit failure before ADMITTED authorizes nothing", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const opened = track(openLatticeDb(path.join(root, "data")));
    persistTask(opened.raw, "task-a", workspace);
    armFault("before-admitted-commit");
    expect(() =>
      admitDurable(opened.raw, makeContract("task-a", workspace), editIntent("task-a", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1),
    ).toThrow();
    clearFaults();
    const rows = opened.raw.prepare("SELECT COUNT(*) AS n FROM intents").get() as { n: number };
    expect(rows.n).toBe(0);
    const admitted = admitDurable(opened.raw, makeContract("task-a", workspace), editIntent("task-a", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    expect(admitted.admitted).toBe(true);
  });

  it("B: ADMITTED without claim is invalidated after restart and readmitted once", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "price.txt"), BEFORE);
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-b", workspace);
    armFault("after-admitted");
    expect(() =>
      admitDurable(first.raw, makeContract("task-b", workspace), editIntent("task-b", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1),
    ).toThrow();
    clearFaults();
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = resumeTask(second.raw, { taskId: "task-b", generation: 2, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(true);
    expect(report.invalidatedAdmissions).toHaveLength(1);
    expect(report.unknowns).toHaveLength(0);
    // Readmission is explicit and allowed: the intent never dispatched.
    const readmitted = admitDurable(second.raw, makeContract("task-b", workspace), editIntent("task-b", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 2);
    expect(readmitted.admitted).toBe(true);
  });

  it("C: claim commit failure leaves ADMITTED, invalidated after restart", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-c", workspace);
    const admitted = admitDurable(first.raw, makeContract("task-c", workspace), editIntent("task-c", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    armFault("before-claim-commit");
    expect(() => claimDurable(first.raw, admitted.attemptId, 1, 1)).toThrow();
    clearFaults();
    expect(intentsRow(first.raw, admitted.intentId)).toBe("ADMITTED");
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = resumeTask(second.raw, { taskId: "task-c", generation: 2, packageVersion: "0.0.0" });
    expect(report.invalidatedAdmissions).toEqual([admitted.intentId]);
    expect(findUnreconciledAttempts(second.raw)).toEqual([]);
  });
});

describe("crash boundaries D-E: uncertain effect reconciled against the sink", () => {
  it("D: claimed without receipt reconciles an applied edit without replay", async () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "price.txt"), BEFORE);
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-d", workspace);
    const admitted = admitDurable(first.raw, makeContract("task-d", workspace), editIntent("task-d", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    armFault("after-claim");
    expect(() => claimDurable(first.raw, admitted.attemptId, 1, 1)).toThrow();
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    clearFaults();
    // The invocation may have happened: apply the real effect through the tool.
    const out = await applyEdit(workspace, versionOf(BEFORE));
    expect(out.status).toBe("completed");
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId: "task-d", generation: 2, packageVersion: "0.0.0" });
    expect(report.unknowns.map((entry) => entry.attemptId)).toEqual([admitted.attemptId]);
    // Reconciliation observes the sink instead of retrying: one application total.
    const observed = versionOf(fs.readFileSync(path.join(workspace, "price.txt"), "utf8"));
    expect(observed).toBe(versionOf(AFTER));
    const receipt = second.raw.prepare("SELECT detail FROM receipts WHERE attempt_id = ?").get(admitted.attemptId) as
      | { detail: string }
      | undefined;
    expect(receipt).toBeUndefined();
    // Record the crash-time UNKNOWN receipt, then reconcile from the sink.
    recordReceiptDurable(second.raw, {
      attemptId: admitted.attemptId,
      outcome: "unknown",
      summary: "claim without receipt after restart",
      detailJson: JSON.stringify({ tool: "edit", afterVersion: versionOf(AFTER) }),
      settledCalls: 0,
      settledTokens: 0,
    });
    expect(reconcileEditAttempt(second.raw, admitted.attemptId, observed)).toMatchObject({ result: "applied" });
    expect(fs.readFileSync(path.join(workspace, "price.txt"), "utf8")).toBe(AFTER);
  });

  it("E: effect applied but receipt commit lost reconciles without a second write", async () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "price.txt"), BEFORE);
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-e", workspace);
    const admitted = admitDurable(first.raw, makeContract("task-e", workspace), editIntent("task-e", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    const out = await applyEdit(workspace, versionOf(BEFORE));
    expect(out.status).toBe("completed");
    armFault("before-receipt-commit");
    expect(() =>
      recordReceiptDurable(first.raw, {
        attemptId: admitted.attemptId,
        outcome: "confirmed",
        summary: "replaced",
        detailJson: JSON.stringify({ tool: "edit", afterVersion: versionOf(AFTER) }),
        settledCalls: 0,
        settledTokens: 0,
      }),
    ).toThrow();
    clearFaults();
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId: "task-e", generation: 2, packageVersion: "0.0.0" });
    expect(report.unknowns).toHaveLength(1);
    recordReceiptDurable(second.raw, {
      attemptId: admitted.attemptId,
      outcome: "unknown",
      summary: "effect confirmed at sink, receipt commit had been lost",
      detailJson: JSON.stringify({ tool: "edit", afterVersion: versionOf(AFTER) }),
      settledCalls: 0,
      settledTokens: 0,
    });
    const observed = versionOf(fs.readFileSync(path.join(workspace, "price.txt"), "utf8"));
    expect(reconcileEditAttempt(second.raw, admitted.attemptId, observed)).toMatchObject({ result: "applied" });
    // Exactly one application happened: the file holds the single edit.
    expect(fs.readFileSync(path.join(workspace, "price.txt"), "utf8")).toBe(AFTER);
  });

  it("D-variant: no effect applied reconciles as safe to readmit", async () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    fs.writeFileSync(path.join(workspace, "price.txt"), BEFORE);
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-d2", workspace);
    const admitted = admitDurable(first.raw, makeContract("task-d2", workspace), editIntent("task-d2", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    evaluateResumeGate(second.raw, { taskId: "task-d2", generation: 2, packageVersion: "0.0.0" });
    recordReceiptDurable(second.raw, {
      attemptId: admitted.attemptId,
      outcome: "unknown",
      summary: "crash before invocation",
      detailJson: "{}",
      settledCalls: 0,
      settledTokens: 0,
    });
    expect(reconcileEditAttempt(second.raw, admitted.attemptId, versionOf(BEFORE))).toMatchObject({ result: "not-applied" });
    const readmitted = admitDurable(second.raw, makeContract("task-d2", workspace), editIntent("task-d2", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 2);
    if (!readmitted.admitted) throw new Error("readmission failed");
    expect(claimDurable(second.raw, readmitted.attemptId, 2, 1)).toEqual({ claimed: true });
    const out = await applyEdit(workspace, versionOf(BEFORE));
    expect(out.status).toBe("completed");
    expect(fs.readFileSync(path.join(workspace, "price.txt"), "utf8")).toBe(AFTER);
  });
});

describe("crash boundaries F-G: receipt present", () => {  it("F: committed receipt is redelivered from the ledger without new dispatch", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-f", workspace);
    const admitted = admitDurable(first.raw, makeContract("task-f", workspace), editIntent("task-f", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    // The executor committed its dispatch marker before the effect started.
    markDispatching(first.raw, admitted.attemptId);
    recordReceiptDurable(first.raw, {
      attemptId: admitted.attemptId,
      outcome: "confirmed",
      summary: "replaced",
      detailJson: JSON.stringify({ tool: "edit", afterVersion: versionOf(AFTER) }),
      settledCalls: 0,
      settledTokens: 0,
    });
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId: "task-f", generation: 2, packageVersion: "0.0.0" });
    expect(report.unknowns).toHaveLength(0);
    const receipt = second.raw.prepare("SELECT outcome FROM receipts WHERE attempt_id = ?").get(admitted.attemptId) as { outcome: string };
    expect(receipt.outcome).toBe("confirmed");
    const attempts = second.raw.prepare("SELECT COUNT(*) AS n FROM attempts").get() as { n: number };
    expect(attempts.n).toBe(1);
  });

  it("G: late usage revises the same attempt without duplicating settlement", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-g", workspace);
    const admitted = admitDurable(
      first.raw,
      makeContract("task-g", workspace),
      {
        taskId: "task-g",
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
    expect(claimDurable(first.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: true });
    recordReceiptDurable(first.raw, {
      attemptId: admitted.attemptId,
      outcome: "confirmed",
      summary: "responded",
      detailJson: JSON.stringify({ usageFinal: true }),
      settledCalls: 1,
      settledTokens: 120,
    });
    expect(recordUsageRevision(first.raw, admitted.attemptId, JSON.stringify({ inputTotal: 100, outputTotal: 20 }))).toBe(1);
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    expect(recordUsageRevision(second.raw, admitted.attemptId, JSON.stringify({ inputTotal: 100, outputTotal: 20 }))).toBe(2);
    const doc = second.raw.prepare("SELECT revision, document FROM attempt_usage WHERE attempt_id = ?").get(admitted.attemptId) as {
      revision: number;
      document: string;
    };
    expect(doc.revision).toBe(2);
    expect(JSON.parse(doc.document)).toMatchObject({ inputTotal: 100, usageRevision: 2 });
  });
});

describe("persistence failure refuses dispatch", () => {
  it("disk-full simulation fails every durable commit with no authorized effect", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const opened = track(openLatticeDb(path.join(root, "data")));
    persistTask(opened.raw, "task-disk", workspace);
    const contract = makeContract("task-disk", workspace);
    armFault("storage-write-fail");
    try {
      expect(() =>
        admitDurable(opened.raw, contract, editIntent("task-disk", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1),
      ).toThrow(/persistence refused/);
      expect(() => enterWait(opened.raw, "task-disk", {
        kind: "manual",
        condition: "test",
        source: "test",
        observedCursor: "0",
        obligation: "test",
      })).toThrow(/persistence refused/);
      expect(() =>
        recordWake(opened.raw, "task-disk", {
          wakeId: "wake-1",
          edge: true,
          source: "input",
          cursor: "m",
          observation: "hi",
        }),
      ).toThrow(/persistence refused/);
    } finally {
      clearFaults();
    }
    const counts = opened.raw.prepare(
      "SELECT (SELECT COUNT(*) FROM intents) AS i, (SELECT COUNT(*) FROM waits) AS w, (SELECT COUNT(*) FROM wake_events) AS e",
    ).get() as { i: number; w: number; e: number };
    expect(counts).toEqual({ i: 0, w: 0, e: 0 });
  });
});

describe("orphan processes are quarantined, never adopted", () => {
  it("a live child outliving the runtime becomes UNKNOWN; stale handles are rejected", async () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const first = track(openLatticeDb(path.join(root, "data")));
    persistTask(first.raw, "task-orphan", workspace);
    const contract = makeContract("task-orphan", workspace);
    const admitted = admitDurable(
      first.raw,
      contract,
      {
        taskId: "task-orphan",
        operation: "exec",
        target: process.execPath,
        actionKey: "exec-sleeper",
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
    // A supervised child starts under generation 1 and outlives the runtime.
    const supervisor = new ProcessSupervisor(workspace);
    supervisors.push(supervisor);
    const spawned = await supervisor.execute({
      op: "spawn",
      executable: process.execPath,
      argv: ["-e", "setInterval(()=>{},10000);"],
      generation: 1,
      realm: "local-trusted",
      attemptId: admitted.attemptId,
    });
    expect(spawned.status).toBe("running");
    const handle = spawned.handleId;
    if (handle === undefined) throw new Error("spawn returned no handle");
    // Runtime death: the database closes while the OS process keeps running.
    first.close();
    openHandles.splice(openHandles.indexOf(first), 1);

    const second = track(openLatticeDb(path.join(root, "data")));
    const report = evaluateResumeGate(second.raw, { taskId: "task-orphan", generation: 2, packageVersion: "0.0.0" });
    expect(report.canResume).toBe(false);
    expect(report.blockers.some((entry) => entry.code === "unknown-effects")).toBe(true);
    expect(report.unknowns.map((entry) => entry.attemptId)).toEqual([admitted.attemptId]);
    // A fresh generation never adopts the old handle, and never claims the
    // tree dead: the stale handle is refused via errorKind, the process untouched.
    const fresh = new ProcessSupervisor(workspace);
    supervisors.push(fresh);
    const polled = await fresh.execute({ op: "poll", handle, generation: 2 });
    expect(polled.errorKind).toBe("invalid-args");
    expect(polled.summary).toContain("never transfer");
  });
});

describe("claim fencing", () => {
  it("refuses claims on invalidated and resolved attempts", () => {
    const root = freshDir();
    const workspace = path.join(root, "ws");
    fs.mkdirSync(workspace, { recursive: true });
    const opened = track(openLatticeDb(path.join(root, "data")));
    persistTask(opened.raw, "task-fence", workspace);
    const contract = makeContract("task-fence", workspace);
    const admitted = admitDurable(opened.raw, contract, editIntent("task-fence", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!admitted.admitted) throw new Error("admission failed");
    // A concurrent classification invalidates the admission first...
    expect(evaluateResumeGate(opened.raw, { taskId: "task-fence", generation: 1, packageVersion: "0.0.0" }).invalidatedAdmissions).toEqual([
      admitted.intentId,
    ]);
    // ...so the late claim gains no authority, even with a valid ticket.
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1)).toEqual({ claimed: false, reason: "invalidated" });
    const readmitted = admitDurable(opened.raw, contract, editIntent("task-fence", "k", versionOf(BEFORE)), { calls: 50, tokens: 200000 }, 1);
    if (!readmitted.admitted) throw new Error("readmission failed");
    expect(claimDurable(opened.raw, readmitted.attemptId, 1, 1)).toEqual({ claimed: true });
    recordReceiptDurable(opened.raw, {
      attemptId: readmitted.attemptId,
      outcome: "confirmed",
      summary: "done",
      detailJson: "{}",
      settledCalls: 0,
      settledTokens: 0,
    });
    // And a resolved attempt is never claimable again.
    expect(claimDurable(opened.raw, readmitted.attemptId, 1, 1)).toEqual({ claimed: false, reason: "already-claimed" });
  });
});
