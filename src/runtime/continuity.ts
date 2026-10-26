import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { dispatchEvidence, invalidateAdmittedIntent, receiptEffectVersions, recordReceiptDurable, taskBudgetSnapshot } from "./effects.js";
import { listActiveWaits, type WaitRecord } from "./wait.js";
import { recordRuntimeNote } from "./conversation.js";
import { isContractExpired, type TaskContract } from "./contract.js";

// S3 continuity: manual resume over durable state. This module never creates
// authority, never renews grants or budgets, never replays effects and never
// starts the model. It rebuilds what is known, classifies what is pending,
// and reports whether continuation is safe. Restart is reconstruction, not
// replay.

export interface SessionHandle {
  sessionId: string;
  rootId: string;
}

export function openSession(db: DatabaseSync, rootId: string): SessionHandle {
  const row = db
    .prepare("SELECT session_id FROM runs WHERE root_id = ? ORDER BY created_at ASC LIMIT 1")
    .get(rootId) as { session_id: string } | undefined;
  if (row !== undefined) return { sessionId: row.session_id, rootId };
  return { sessionId: `session-${randomUUID()}`, rootId };
}

export function openRun(
  db: DatabaseSync,
  input: { sessionId: string; rootId: string; taskId: string; manifest: Record<string, unknown> },
  now: Date = new Date(),
): string {
  const runId = `run-${randomUUID()}`;
  db.prepare(
    "INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(runId, input.sessionId, input.rootId, input.taskId, JSON.stringify(input.manifest), now.toISOString());
  return runId;
}

export interface SessionRow {
  sessionId: string;
  rootId: string;
  taskId: string;
  workspace: string;
  objective: string;
  state: string;
  updatedAt: string;
}
export function listSessions(db: DatabaseSync, limit = 100): SessionRow[] {
  // One row per task at its latest run: resumed tasks keep their session
  // across runs and must not appear twice.
  const rows = db
    .prepare(
      `SELECT r.session_id, r.root_id, r.task_id, r.created_at, c.document
       FROM runs r LEFT JOIN contracts c ON c.task_id = r.task_id
       WHERE r.created_at = (SELECT MAX(created_at) FROM runs WHERE task_id = r.task_id)
       ORDER BY r.created_at DESC LIMIT ?`,
    )
    .all(limit) as Array<{
    session_id: string;
    root_id: string;
    task_id: string;
    created_at: string;
    document: string | null;
  }>;
  return rows.map((row) => {
    let objective = "";
    let workspace = "";
    if (row.document !== null) {
      try {
        const contract = JSON.parse(row.document) as { objective?: unknown; scope?: unknown };
        if (typeof contract.objective === "string") objective = contract.objective;
        if (Array.isArray(contract.scope) && typeof contract.scope[0] === "string") {
          workspace = contract.scope[0];
        }
      } catch {
        // Corrupt document surfaces as blank, never crashes the list.
      }
    }
    return {
      sessionId: row.session_id,
      rootId: row.root_id,
      taskId: row.task_id,
      workspace,
      objective,
      state: readTaskState(db, row.task_id).state,
      updatedAt: row.created_at,
    };
  });
}

// Granted budget is always derived from the persisted contract grants, so a
// restart can never renew it. Prefers the grant covering model.invoke.
export function grantedFromContract(contract: TaskContract): { calls: number | null; tokens: number | null } {
  const modelGrant = contract.grants.find((grant) => grant.operations.includes("model.invoke"));
  const grant = modelGrant ?? contract.grants[0];
  if (grant === undefined) throw new Error(`contract ${contract.taskId} carries no grants`);
  return { calls: grant.limits.maxCalls, tokens: grant.limits.maxTokens };
}
export function recordTaskEvent(db: DatabaseSync, taskId: string, kind: string, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
    kind,
    taskId,
    JSON.stringify(payload),
    new Date().toISOString(),
  );
}

export interface VerificationEvidence {
  command: string;
  cwd: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  countsKnown: boolean;
}

// Verification outcomes persist as events so a resumed session can answer
// what was already verified without rerunning anything.
export function recordVerificationEvent(db: DatabaseSync, taskId: string, evidence: VerificationEvidence): void {
  recordTaskEvent(db, taskId, "verification", { ...evidence });
}

export function readTaskState(db: DatabaseSync, taskId: string): { state: string; reason: string } {
  const row = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1")
    .get(taskId) as { payload: string } | undefined;
  if (row === undefined) return { state: "READY", reason: "created" };
  try {
    const parsed = JSON.parse(row.payload) as { state?: unknown; reason?: unknown };
    if (typeof parsed.state === "string") {
      return { state: parsed.state, reason: typeof parsed.reason === "string" ? parsed.reason : "" };
    }
  } catch {
    // Fall through to READY rather than crashing on a bad row.
  }
  return { state: "READY", reason: "created" };
}

// Upserts the contract document: every revision stays queryable through
// the events history while this row always holds the current revision.
export function persistContract(db: DatabaseSync, contract: TaskContract, now: Date = new Date()): void {
  db.prepare(
    "INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at",
  ).run(contract.taskId, contract.rootId, contract.revision, JSON.stringify(contract), now.toISOString());
}

export function readContract(db: DatabaseSync, taskId: string): TaskContract | null {  const row = db.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as
    | { document: string }
    | undefined;
  if (row === undefined) return null;
  try {
    return JSON.parse(row.document) as TaskContract;
  } catch {
    return null;
  }
}

// Obligation satisfaction is an event, not a second source of truth: the
// contract lists obligations, satisfaction events retire them with evidence.
export function satisfyObligation(db: DatabaseSync, taskId: string, obligation: string, evidenceRef: string): void {
  recordTaskEvent(db, taskId, "obligation.satisfied", { obligation, evidenceRef });
}

export function pendingObligations(db: DatabaseSync, contract: TaskContract): string[] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'obligation.satisfied' ORDER BY seq ASC")
    .all(contract.taskId) as Array<{ payload: string }>;
  const satisfied = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { obligation?: unknown };
      if (typeof parsed.obligation === "string") satisfied.add(parsed.obligation);
    } catch {
      // Skip unreadable rows; the obligation stays pending.
    }
  }
  return contract.obligations.filter((obligation) => !satisfied.has(obligation));
}

export interface UnknownSummary {
  attemptId: string;
  intentId: string;
  operation: string;
  target: string | null;
  reason: string;
  recordedAt: string;
  // A human saw this uncertainty and chose to continue with it recorded.
  // Acknowledgement never reclassifies the effect: it stays UNKNOWN, its
  // reservation stays counted, and equivalent intents stay refused.
  acknowledged: boolean;
}

export function unknownHistory(db: DatabaseSync, taskId: string): UnknownSummary[] {
  const rows = db
    .prepare(
      `SELECT a.attempt_id, a.intent_id, a.created_at, i.operation, i.target, i.state,
              (SELECT r.detail FROM receipts r WHERE r.attempt_id = a.attempt_id) AS receipt
       FROM attempts a JOIN intents i ON i.intent_id = a.intent_id
       WHERE i.task_id = ? AND (i.state = 'UNKNOWN' OR a.state = 'UNKNOWN')
       ORDER BY a.created_at ASC`,
    )
    .all(taskId) as Array<{
    attempt_id: string;
    intent_id: string;
    created_at: string;
    operation: string;
    target: string | null;
    state: string;
    receipt: string | null;
  }>;
  const acknowledged = acknowledgedAttempts(db, taskId);
  return rows.map((row) => {
    let reason = "effect uncertain; reconcile before retry";
    if (row.receipt !== null) {
      try {
        const parsed = JSON.parse(row.receipt) as { summary?: unknown };
        if (typeof parsed.summary === "string" && parsed.summary !== "") reason = parsed.summary;
      } catch {
        // Keep the default reason.
      }
    }
    return {
      attemptId: row.attempt_id,
      intentId: row.intent_id,
      operation: row.operation,
      target: row.target,
      reason,
      recordedAt: row.created_at,
      acknowledged: acknowledged.has(row.attempt_id),
    };
  });
}

function acknowledgedAttempts(db: DatabaseSync, taskId: string): Set<string> {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'unknown.acknowledged' ORDER BY seq ASC")
    .all(taskId) as Array<{ payload: string }>;
  const ids = new Set<string>();
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { attemptId?: unknown };
      if (typeof parsed.attemptId === "string") ids.add(parsed.attemptId);
    } catch {
      // Unreadable acknowledgement proves nothing; the effect stays unacknowledged.
    }
  }
  return ids;
}

// Records that a human saw the listed UNKNOWN effects and decided to continue
// with them pending. This is a decision record, not a reconciliation: the
// ledger keeps the effect UNKNOWN, the reservation keeps counting, and the
// admission duplicate guard keeps refusing an equivalent intent.
export function acknowledgeUnknownEffects(
  db: DatabaseSync,
  taskId: string,
  input: { actor: string; note?: string | undefined; attemptIds?: readonly string[] | undefined },
  now: Date = new Date(),
): string[] {
  const pending = unknownHistory(db, taskId).filter((entry) => !entry.acknowledged
    && (input.attemptIds === undefined || input.attemptIds.includes(entry.attemptId)));
  if (pending.length === 0) return [];
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const entry of pending) {
      db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
        "unknown.acknowledged",
        taskId,
        JSON.stringify({ attemptId: entry.attemptId, intentId: entry.intentId, operation: entry.operation, actor: input.actor, note: input.note ?? null }),
        now.toISOString(),
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
  return pending.map((entry) => entry.attemptId);
}

// Effects that keep automatic verification from certifying completion:
// anything in flight, and every UNKNOWN effect except an acknowledged remote
// model call (which has no workspace effect; its cost stays counted). An
// acknowledged tool UNKNOWN still blocks: the workspace may hold its effect.
export function completionBlockingEffects(db: DatabaseSync, taskId: string): number {
  const inFlight = db
    .prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND state IN ('ADMITTED','CLAIMED')")
    .get(taskId) as { n: number };
  const unknown = unknownHistory(db, taskId).filter((entry) => !(entry.operation === "model.invoke" && entry.acknowledged));
  return inFlight.n + new Set(unknown.map((entry) => entry.intentId)).size;
}

// Human acceptance: records WHO decided and on WHAT basis, then closes the
// task as COMPLETED with basis "accepted-by-human". It is a decision record,
// never a verification: criteria stay as they were, UNKNOWN effects stay
// UNKNOWN (listed in the record), and the contract is not revised.
export function acceptTaskResult(db: DatabaseSync, taskId: string, input: { actor: string; note: string | null }, now: Date = new Date()): { accepted: boolean; reason: string } {
  const contract = readContract(db, taskId);
  if (contract === null) return { accepted: false, reason: "unknown task" };
  const state = readTaskState(db, taskId).state;
  if (state === "COMPLETED") return { accepted: false, reason: "task already completed" };
  if (state === "READY") {
    const responses = db.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = 'model.invoke'").get(taskId) as { n: number };
    if (responses.n === 0) return { accepted: false, reason: "nothing to accept yet" };
  }
  const unknowns = unknownHistory(db, taskId).map((entry) => entry.attemptId);
  const verifications = readVerifications(db, taskId);
  const edits = db.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = 'edit' AND state IN ('RESOLVED','RECONCILED')").get(taskId) as { n: number };
  db.exec("BEGIN IMMEDIATE");
  try {
    recordTaskEvent(db, taskId, "task.accepted", {
      actor: input.actor,
      note: input.note,
      criteria: [...contract.acceptanceCriteria],
      priorState: state,
      unknowns,
      verifications: verifications.length,
      passingVerifications: verifications.filter((entry) => entry.exitCode === 0).length,
      confirmedEdits: edits.n,
      acceptedAt: now.toISOString(),
    });
    recordTaskEvent(db, taskId, "task-state", {
      state: "COMPLETED",
      reason: `accepted by human${unknowns.length > 0 ? ` with ${unknowns.length} UNKNOWN effect(s) still recorded` : ""}; not an automatic verification`,
      basis: "accepted-by-human",
    });
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
  return { accepted: true, reason: "accepted" };
}

export interface RecoveredTask {
  taskId: string;
  priorState: string;
  priorGeneration: number | null;
  invalidatedAdmissions: string[];
  unknowns: string[];
}

// Orphan recovery at owner start. A task whose latest state says RUNNING (or
// WAITING on a supervised process) under a generation that is not the live
// one has no executor: that owner is gone, so the claim "it is running" is
// false and observably so. The TASK leaves RUNNING for INTERRUPTED; EFFECTS
// are only classified (CLAIMED without receipt → UNKNOWN, never-claimed
// admissions → INVALIDATED). Nothing is replayed, released or declared zero.
export function recoverOrphanedTasks(db: DatabaseSync, generation: number, now: Date = new Date()): RecoveredTask[] {
  const rows = db
    .prepare(
      `SELECT e.task_id, e.payload FROM events e
       WHERE e.kind = 'task-state' AND e.task_id IS NOT NULL
         AND e.seq = (SELECT MAX(seq) FROM events WHERE task_id = e.task_id AND kind = 'task-state')`,
    )
    .all() as Array<{ task_id: string; payload: string }>;
  const recovered: RecoveredTask[] = [];
  for (const row of rows) {
    let state = "";
    let owner: number | null = null;
    try {
      const parsed = JSON.parse(row.payload) as { state?: unknown; generation?: unknown };
      state = typeof parsed.state === "string" ? parsed.state : "";
      owner = typeof parsed.generation === "number" ? parsed.generation : null;
    } catch {
      continue;
    }
    if (owner === generation) continue;
    const processWaits = state === "WAITING" ? listActiveWaits(db, row.task_id).filter((wait) => wait.kind === "process") : [];
    if (state !== "RUNNING" && processWaits.length === 0) continue;
    const invalidated = classifyUnfinishedIntents(db, row.task_id);
    if (processWaits.length > 0) {
      db.prepare("UPDATE waits SET state = 'cancelled', updated_at = ? WHERE task_id = ? AND kind = 'process' AND state = 'active'").run(now.toISOString(), row.task_id);
    }
    const unknowns = unknownHistory(db, row.task_id).filter((entry) => !entry.acknowledged).map((entry) => entry.attemptId);
    const reason = `executor lost: the process running this task ended unexpectedly${owner === null ? "" : ` (owner generation ${owner})`}; effects classified, nothing replayed${unknowns.length > 0 ? `; ${unknowns.length} effect(s) UNKNOWN` : ""}`;
    db.exec("BEGIN IMMEDIATE");
    try {
      recordTaskEvent(db, row.task_id, "task.interrupted", { priorState: state, priorGeneration: owner, recoveredBy: generation, invalidatedAdmissions: invalidated, unknowns });
      recordTaskEvent(db, row.task_id, "task-state", { state: "INTERRUPTED", reason, generation });
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // Original error below remains the actionable signal.
      }
      throw error;
    }
    recovered.push({ taskId: row.task_id, priorState: state, priorGeneration: owner, invalidatedAdmissions: invalidated, unknowns });
  }
  return recovered;
}

export interface DriftEntry {
  path: string;
  change: "modified" | "deleted";
  lastObserved: string | null;
  current: string | null;
}

function contentVersion(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

interface ObservedFile {
  version: string;
}

// Recomputes content versions for every file the task observed through
// read/edit receipts and compares them with the workspace as found now.
// Files the task never touched are not drift: human work elsewhere is simply
// preserved, never reverted or blamed.
export function detectWorkspaceDrift(db: DatabaseSync, taskId: string, workspace: string): DriftEntry[] {
  const rows = db
    .prepare(
      `SELECT i.target, r.detail
       FROM attempts a JOIN intents i ON i.intent_id = a.intent_id
       LEFT JOIN receipts r ON r.attempt_id = a.attempt_id
       WHERE i.task_id = ? AND i.operation IN ('read', 'edit') AND i.target IS NOT NULL
       ORDER BY a.created_at ASC`,
    )
    .all(taskId) as Array<{ target: string | null; detail: string | null }>;
  const observed = new Map<string, ObservedFile>();
  for (const row of rows) {
    if (row.target === null) continue;
    const version = versionFromReceipt(row.detail);
    if (version !== null) observed.set(row.target, { version });
  }
  const drift: DriftEntry[] = [];
  for (const [target, { version }] of observed) {
    const absolute = path.resolve(workspace, target);
    const root = path.resolve(workspace);
    if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) continue;
    let current: Buffer | null = null;
    try {
      current = fs.readFileSync(absolute);
    } catch {
      drift.push({ path: target, change: "deleted", lastObserved: version, current: null });
      continue;
    }
    const now = contentVersion(current);
    if (now !== version) {
      drift.push({ path: target, change: "modified", lastObserved: version, current: now });
    }
  }
  return drift;
}

function versionFromReceipt(detail: string | null): string | null {
  if (detail === null) return null;
  return receiptEffectVersions(detail).afterVersion;
}

export interface RunManifestView {
  provider: string;
  model: string;
  baseUrl: string | null;
  workspace: string;
}

// Latest run manifest for a task: the composition (provider/model/binding)
// a manual resume continues with. Resume-marker runs carry no composition,
// so the latest run whose manifest parses with a provider and model wins.
// Throws fail-closed when no usable composition exists.
export function readRunManifest(db: DatabaseSync, taskId: string): RunManifestView {
  const rows = db.prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC").all(taskId) as
    | Array<{ manifest: string }>
    | undefined;
  if (rows !== undefined) {
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.manifest);
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const record = parsed as Record<string, unknown>;
      if (typeof record["provider"] !== "string" || typeof record["model"] !== "string") continue;
      return {
        provider: record["provider"],
        model: record["model"],
        baseUrl: typeof record["baseUrl"] === "string" ? record["baseUrl"] : null,
        workspace: typeof record["workspace"] === "string" ? record["workspace"] : "",
      };
    }
  }
  throw new Error(`no run composition for task ${taskId}`);
}

export interface ResumeBlocker {
  code: string;
  detail: string;
}

export interface ResumeReport {
  taskId: string;
  rootId: string;
  sessionId: string;
  newRunId: string | null;
  contractRevision: number;
  state: string;
  stateReason: string;
  generation: number;
  budget: {
    granted: { calls: number | null; tokens: number | null };
    reserved: { calls: number; tokens: number };
    settled: { calls: number; tokens: number };
  };
  expired: boolean;
  expiresAt: string | null;
  workspaceOk: boolean;
  workspaceDetail: string;
  unknowns: UnknownSummary[];
  invalidatedAdmissions: string[];
  waits: WaitRecord[];
  drift: DriftEntry[];
  staleEvidence: Array<{ path: string; reason: string }>;
  obligationsPending: string[];
  acceptanceCriteria: string[];
  verifications: Array<{ command: string; exitCode: number | null; passed: number | null; failed: number | null }>;
  humanDecisions: string[];
  compositionChanged: boolean;
  canResume: boolean;
  blockers: ResumeBlocker[];
}

export interface ResumeGateInput {
  taskId: string;
  generation: number;
  packageVersion: string;
  now?: Date | undefined;
}

export interface ResumeGateOptions {
  // False for hot read paths (snapshots during a live run): reports current
  // unknowns without invalidating in-flight admissions. True on real resume.
  classifyPending?: boolean | undefined;
}

// Validates continuity without executing anything: loads the persisted
// contract, manifest, budget, pending intents, UNKNOWN history and workspace
// drift, then classifies every unfinished intent. ADMITTED-without-claim is
// invalidated (it never dispatched); CLAIMED-without-receipt becomes UNKNOWN
// with an explicit quarantine reason when it supervised a process.
export function evaluateResumeGate(db: DatabaseSync, input: ResumeGateInput, options?: ResumeGateOptions): ResumeReport {
  const now = input.now ?? new Date();
  const contract = readContract(db, input.taskId);
  if (contract === null) {
    return blockedReport(input.taskId, [{ code: "no-contract", detail: `no usable contract for task ${input.taskId}; refusing resume` }]);
  }
  const manifestRow = db
    .prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
    .get(input.taskId) as { manifest: string } | undefined;
  if (manifestRow === undefined) {
    return blockedReport(input.taskId, [{ code: "no-run", detail: `no run manifest for task ${input.taskId}; refusing resume` }]);
  }
  const { sessionId } = openSession(db, contract.rootId);
  const state = readTaskState(db, input.taskId);
  const granted = grantedFromContract(contract);
  const snapshot = taskBudgetSnapshot(db, input.taskId, granted);
  const expired = isContractExpired(contract, now);
  const blockers: ResumeBlocker[] = [];
  if (expired) {
    blockers.push({ code: "contract-expired", detail: `contract expired at ${contract.expiresAt}; a new grant is required before resuming` });
  }
  // COMPLETED closes the contract: continuing is a follow-up under a new
  // contract, never a reopening. A human stop (CANCELLED) or a lost executor
  // (INTERRUPTED) leaves unfinished work that may continue under the same
  // grant, budget and session.
  if (state.state === "COMPLETED") {
    blockers.push({ code: "terminal-state", detail: `task is ${state.state}; resume applies to unfinished work, not to closed tasks` });
  }
  const workspace = contract.scope[0] ?? "";
  let workspaceOk = true;
  let workspaceDetail = workspace === "" ? "contract carries no workspace scope" : `workspace present: ${workspace}`;
  if (workspace !== "") {
    try {
      if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
        workspaceOk = false;
        workspaceDetail = `workspace missing or not a directory: ${workspace}`;
      }
    } catch {
      workspaceOk = false;
      workspaceDetail = `workspace not readable: ${workspace}`;
    }
  }
  if (!workspaceOk) {
    blockers.push({ code: "workspace-missing", detail: workspaceDetail });
  }

  const invalidatedAdmissions = options?.classifyPending === false ? [] : classifyUnfinishedIntents(db, input.taskId);
  const unknowns = unknownHistory(db, input.taskId);
  // Restricted resume: UNKNOWN effects block only until a human has seen
  // them. Acknowledged effects stay UNKNOWN in the ledger, keep their
  // reservation counted, stay in the model context, and equivalent intents
  // stay refused by admission until reconciled by observation.
  const unacknowledged = unknowns.filter((entry) => !entry.acknowledged);
  if (unacknowledged.length > 0) blockers.push({ code: "unknown-effects", detail: `${unacknowledged.length} unresolved effect(s) must be reconciled or acknowledged before a new activation` });
  const drift = workspaceOk && workspace !== "" ? detectWorkspaceDrift(db, input.taskId, workspace) : [];
  const staleEvidence = drift.map((entry) => ({
    path: entry.path,
    reason: `content ${entry.change} since last observed version; prior evidence for this file is stale until re-verified`,
  }));
  const manifest = safeParseManifest(manifestRow.manifest);
  return {
    taskId: input.taskId,
    rootId: contract.rootId,
    sessionId,
    newRunId: null,
    contractRevision: contract.revision,
    state: state.state,
    stateReason: state.reason,
    generation: input.generation,
    budget: {
      granted: { ...granted },
      reserved: { ...snapshot.reserved },
      settled: { ...snapshot.settled },
    },
    expired,
    expiresAt: contract.expiresAt,
    workspaceOk,
    workspaceDetail,
    unknowns,
    invalidatedAdmissions,
    waits: listActiveWaits(db, input.taskId),
    drift,
    staleEvidence,
    obligationsPending: pendingObligations(db, contract),
    acceptanceCriteria: [...contract.acceptanceCriteria],
    verifications: readVerifications(db, input.taskId),
    humanDecisions: readHumanDecisions(db, input.taskId),
    compositionChanged: manifest.packageVersion !== null && manifest.packageVersion !== input.packageVersion,
    canResume: blockers.length === 0,
    blockers,
  };
}

// Classifies unfinished intents durably. Returns invalidated ADMITTED intent
// ids. CLAIMED-without-receipt attempts are indistinguishable from
// post-invocation crashes, so they become UNKNOWN; supervised-process intents
// carry an explicit quarantine reason because fresh generations never adopt
// old handles or kill by bare PID.
function classifyUnfinishedIntents(db: DatabaseSync, taskId: string): string[] {
  const rows = db
    .prepare("SELECT intent_id, state, operation FROM intents WHERE task_id = ? AND state IN ('ADMITTED', 'CLAIMED')")
    .all(taskId) as Array<{ intent_id: string; state: string; operation: string }>;
  const invalidated: string[] = [];
  for (const row of rows) {
    if (row.state === "ADMITTED") {
      if (invalidateAdmittedIntent(db, row.intent_id)) invalidated.push(row.intent_id);
      continue;
    }
    // A claim whose dispatch marker never committed provably never started
    // its effect: settle it as not executed (zero cost, reservation
    // released) with the classification recorded as evidence.
    const attempts = db.prepare("SELECT attempt_id FROM attempts WHERE intent_id = ? AND state = 'CLAIMED'").all(row.intent_id) as Array<{ attempt_id: string }>;
    if (attempts.length > 0 && attempts.every((attempt) => dispatchEvidence(db, attempt.attempt_id) === "not-dispatched")) {
      for (const attempt of attempts) {
        recordReceiptDurable(db, {
          attemptId: attempt.attempt_id,
          outcome: "failed",
          summary: `${row.operation} not dispatched: the executor stopped after the claim and before the dispatch marker; nothing was sent or executed`,
          detailJson: JSON.stringify({ classification: "not-dispatched", usageFinal: true }),
          settledCalls: 0,
          settledTokens: 0,
          releaseUnused: true,
        });
        recordTaskEvent(db, taskId, "unknown.not-dispatched", { intentId: row.intent_id, attemptId: attempt.attempt_id, operation: row.operation });
      }
      continue;
    }
    quarantineClaimed(db, taskId, row.intent_id, row.operation);
  }
  return invalidated;
}

function quarantineClaimed(db: DatabaseSync, taskId: string, intentId: string, operation: string): void {
  const reason =
    operation === "exec" || operation === "process"
      ? "owner restarted; supervised handles never transfer generations: process left untouched, classified UNKNOWN until observed"
      : "claim without receipt after restart; effect uncertain until reconciled";
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE intents SET state = 'UNKNOWN' WHERE intent_id = ? AND state = 'CLAIMED'").run(intentId);
    db.prepare("UPDATE attempts SET state = 'UNKNOWN' WHERE intent_id = ? AND state = 'CLAIMED'").run(intentId);
    db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
      "unknown.classified",
      taskId,
      JSON.stringify({ intentId, reason }),
      new Date().toISOString(),
    );
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
}

function safeParseManifest(manifestJson: string): { packageVersion: string | null } {
  try {
    const parsed = JSON.parse(manifestJson) as { packageVersion?: unknown };
    return { packageVersion: typeof parsed.packageVersion === "string" ? parsed.packageVersion : null };
  } catch {
    return { packageVersion: null };
  }
}

function readVerifications(db: DatabaseSync, taskId: string): ResumeReport["verifications"] {
  const rows = db
    .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'verification' ORDER BY seq ASC LIMIT 100")
    .all(taskId) as Array<{ payload: string }>;
  const out: ResumeReport["verifications"] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      out.push({
        command: typeof parsed["command"] === "string" ? parsed["command"] : "unknown",
        exitCode: typeof parsed["exitCode"] === "number" ? parsed["exitCode"] : null,
        passed: typeof parsed["passed"] === "number" ? parsed["passed"] : null,
        failed: typeof parsed["failed"] === "number" ? parsed["failed"] : null,
      });
    } catch {
      // Skip unreadable rows.
    }
  }
  return out;
}

// Decisions a human took about this task that the model must not lose when
// older turns leave the window: restrictions, acknowledged uncertainty,
// recorded reconciliations and acceptance. Messages themselves travel as
// conversation turns. Bounded: the newest 10, each at most 300 characters.
export function readHumanDecisions(db: DatabaseSync, taskId: string): string[] {
  const rows = db
    .prepare(
      `SELECT kind, payload FROM events WHERE task_id = ?
       AND kind IN ('steering', 'unknown.acknowledged', 'reconciliation.human', 'task.accepted') ORDER BY seq ASC`,
    )
    .all(taskId) as Array<{ kind: string; payload: string }>;
  const decisions: string[] = [];
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as Record<string, unknown>;
      if (row.kind === "steering" && parsed["mode"] === "forbid" && typeof parsed["text"] === "string") decisions.push(`restrição do usuário: ${parsed["text"]}`);
      else if (row.kind === "unknown.acknowledged") decisions.push(`usuário reconheceu o efeito incerto ${String(parsed["operation"])} (${String(parsed["attemptId"])}) e decidiu continuar sem repeti-lo`);
      else if (row.kind === "reconciliation.human") decisions.push(`usuário decidiu ${parsed["decision"] === "treat-as-applied" ? "que foi executado" : "que não foi executado"} o efeito ${String(parsed["attemptId"])}${typeof parsed["note"] === "string" ? `: ${parsed["note"]}` : ""}`);
      else if (row.kind === "task.accepted") decisions.push(`usuário aceitou o resultado${typeof parsed["note"] === "string" ? `: ${parsed["note"]}` : ""}`);
    } catch {
      // Skip unreadable rows.
    }
  }
  return decisions.slice(-10).map((text) => text.length > 300 ? `${text.slice(0, 300)}…` : text);
}

function blockedReport(taskId: string, blockers: ResumeBlocker[]): ResumeReport {
  return {
    taskId,
    rootId: "",
    sessionId: "",
    newRunId: null,
    contractRevision: 0,
    state: "BLOCKED",
    stateReason: blockers[0]?.detail ?? "resume refused",
    generation: 0,
    budget: {
      granted: { calls: 0, tokens: 0 },
      reserved: { calls: 0, tokens: 0 },
      settled: { calls: 0, tokens: 0 },
    },
    expired: false,
    expiresAt: "",
    workspaceOk: false,
    workspaceDetail: "",
    unknowns: [],
    invalidatedAdmissions: [],
    waits: [],
    drift: [],
    staleEvidence: [],
    obligationsPending: [],
    acceptanceCriteria: [],
    verifications: [],
    humanDecisions: [],
    compositionChanged: false,
    canResume: false,
    blockers,
  };
}

// Manual resume: evaluates the gate and, only when it allows, opens a new
// run under the same session/root and moves a crash-interrupted RUNNING task
// back to READY. Viewing history never resumes; this function is the explicit
// action. It never invokes tools or the model.
export function resumeTask(db: DatabaseSync, input: ResumeGateInput & { manifestExtra?: Record<string, unknown> }): ResumeReport {
  const report = evaluateResumeGate(db, input);
  if (!report.canResume) return report;
  const newRunId = openRun(
    db,
    {
      sessionId: report.sessionId,
      rootId: report.rootId,
      taskId: report.taskId,
      manifest: { resumedFromState: report.state, resumedAt: new Date().toISOString(), ...(input.manifestExtra ?? {}) },
    },
  );
  // The model learns, as a runtime observation, that this is a continuation
  // and why the previous activation ended; uncertainty stays in the anchors.
  const unknownCount = report.unknowns.length;
  const why = report.state === "INTERRUPTED" ? "A execução anterior foi interrompida inesperadamente (o processo do Lattice terminou)."
    : report.state === "CANCELLED" ? "O usuário havia interrompido a execução."
      : report.state === "NEEDS_INPUT" ? "A execução anterior parou aguardando o usuário."
        : report.state === "BLOCKED" ? `A execução anterior parou bloqueada: ${report.stateReason.slice(0, 300)}.`
          : null;
  if (why !== null) {
    recordRuntimeNote(db, report.taskId, `${why} O usuário retomou a tarefa.${unknownCount > 0 ? ` ${unknownCount} efeito(s) seguem incertos e não serão repetidos automaticamente (ver Efeitos incertos).` : ""}`);
  }
  if (["RUNNING", "BLOCKED", "NEEDS_INPUT", "WAITING", "INTERRUPTED", "CANCELLED"].includes(report.state)) {
    recordTaskEvent(db, report.taskId, "task-state", {
      state: "READY",
      reason: "manual resume after restart; unfinished intents classified, no effect replayed",
    });
    report.state = "READY";
    report.stateReason = "manual resume after restart; unfinished intents classified, no effect replayed";
  }
  recordTaskEvent(db, report.taskId, "resume", { runId: newRunId, generation: input.generation });
  report.newRunId = newRunId;
  return report;
}
