import type { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveInScope } from "../platform/paths.js";
import {
  admitIntent,
  claimTicket,
  type ActionIntent,
  type AdmissionTicket,
} from "./admission.js";
import { BudgetLedger, exceedsLimit, type BudgetGrant } from "./budget.js";
import { guardWrites, throwIfFault } from "./faults.js";
import type { TaskContract } from "./contract.js";

export interface DurableIntentInput {
  taskId: string;
  operation: string;
  target: string | null;
  actionKey: string;
  authorityRevision: number;
  maxCalls: number;
  maxTokens: number;
  argsJson: string;
  // Logical model request this intent belongs to, when the intent is a
  // cognitive dispatch. Persisted so the usage ledger can group retries.
  requestId?: string | undefined;
  provider?: string;
  model?: string;
  realm?: string;
  additionalTargets?: readonly string[];
}

export type DurableDenialReason =
  | "no-grant"
  | "operation-not-granted"
  | "contract-expired"
  | "grant-expired"
  | "target-not-granted"
  | "provider-not-granted"
  | "model-not-granted"
  | "realm-not-granted"
  | "restriction-denied"
  | "stale-revision"
  | "stale-generation"
  | "budget-exceeded"
  | "duplicate-pending";

export interface DurableAdmitted {
  admitted: true;
  intentId: string;
  attemptId: string;
  ticket: AdmissionTicket;
}

export interface DurableDenied {
  admitted: false;
  reason: DurableDenialReason;
  detail: string;
}

export type DurableAdmission = DurableAdmitted | DurableDenied;

export type DurableClaimResult =
  | { claimed: true }
  | {
      claimed: false;
      reason:
        | "already-claimed"
        | "stale-generation"
        | "stale-revision"
        | "not-found"
        | "invalidated"
        | "contract-expired"
        | "grant-expired"
        | "grant-changed"
        | "target-not-granted"
        | "provider-not-granted"
        | "model-not-granted"
        | "realm-not-granted"
        | "restriction-denied"
        | "operation-not-granted";
    };

export class DuplicateReceiptError extends Error {
  readonly attemptId: string;
  constructor(attemptId: string) {
    super(`Receipt for attempt ${attemptId} already recorded; settlement happens once`);
    this.name = "DuplicateReceiptError";
    this.attemptId = attemptId;
  }
}

export type ReceiptOutcome = "confirmed" | "failed" | "unknown";

export interface ReceiptInput {
  attemptId: string;
  outcome: ReceiptOutcome;
  summary: string;
  detailJson: string;
  settledCalls: number;
  settledTokens: number;
  // When usage is unknown, the token ceiling stays reserved instead of being
  // released: absence of usage is not zero. A later correction releases it.
  releaseUnused?: boolean;
  // Usage and receipt share one SQLite commit, including observed overage.
  usageDocument?: string;
}

interface ReservationTotals {
  calls: number;
  tokens: number;
}

function openReservationTotals(db: DatabaseSync, taskId: string): ReservationTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(calls - settled_calls), 0) AS calls,
              COALESCE(SUM(tokens - settled_tokens), 0) AS tokens
       FROM reservations WHERE state = 'open' AND intent_id IN
         (SELECT intent_id FROM intents WHERE task_id = ?)`,
    )
    .get(taskId) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

function settledTotals(db: DatabaseSync, taskId: string): ReservationTotals {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(settled_calls), 0) AS calls,
              COALESCE(SUM(settled_tokens), 0) AS tokens
       FROM reservations WHERE intent_id IN
         (SELECT intent_id FROM intents WHERE task_id = ?)`,
    )
    .get(taskId) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

export function taskBudgetSnapshot(
  db: DatabaseSync,
  taskId: string,
  granted: BudgetGrant,
): { granted: BudgetGrant; reserved: ReservationTotals; settled: ReservationTotals } {
  return {
    granted: { ...granted },
    reserved: openReservationTotals(db, taskId),
    settled: settledTotals(db, taskId),
  };
}

function findDuplicateUnknown(db: DatabaseSync, taskId: string, actionKey: string): string | null {
  const row = db
    .prepare(
      `SELECT intent_id FROM intents
       WHERE task_id = ? AND action_key = ? AND state IN ('ADMITTED', 'CLAIMED', 'UNKNOWN')`,
    )
    .get(taskId, actionKey) as { intent_id: string } | undefined;
  return row?.intent_id ?? null;
}

// Durable admission: revalidates contract authority, checks the persisted
// budget (settled + reserved <= granted across restarts), guards against
// silently duplicating a pending/UNKNOWN equivalent intent, then commits the
// intent, attempt and reservation in one transaction. A commit failure means
// no dispatch is authorized.
export function admitDurable(
  db: DatabaseSync,
  contract: TaskContract,
  input: DurableIntentInput,
  granted: BudgetGrant,
  ownerGeneration: number,
  now: Date = new Date(),
  workspaceRootHint?: string,
): DurableAdmission {
  const actionIntent: ActionIntent = {
    intentId: `intent-${randomUUID()}`,
    operation: input.operation,
    target: input.target,
    actionKey: input.actionKey,
    authorityRevision: input.authorityRevision,
    maxCalls: input.maxCalls,
    maxTokens: input.maxTokens,
    ...(input.provider === undefined ? {} : { provider: input.provider }),
    ...(input.model === undefined ? {} : { model: input.model }),
    ...(input.realm === undefined ? {} : { realm: input.realm }),
    ...(input.additionalTargets === undefined ? {} : { additionalTargets: input.additionalTargets }),
  };
  const reserved = openReservationTotals(db, input.taskId);
  const settled = settledTotals(db, input.taskId);
  if (
    exceedsLimit(settled.calls + reserved.calls + input.maxCalls, granted.calls) ||
    exceedsLimit(settled.tokens + reserved.tokens + input.maxTokens, granted.tokens)
  ) {
    return {
      admitted: false,
      reason: "budget-exceeded",
      detail: "Reservation would exceed granted budget (settled + reserved <= granted)",
    };
  }
  const duplicate = findDuplicateUnknown(db, input.taskId, input.actionKey);
  if (duplicate !== null) {
    return {
      admitted: false,
      reason: "duplicate-pending",
      detail: `Equivalent intent ${duplicate} is already pending or UNKNOWN; reconcile before duplicating`,
    };
  }
  const attemptId = `attempt-${randomUUID()}`;
  const check = admitIntent({
    intent: actionIntent,
    contract,
    ledger: ledgerWithPersistedTotals(granted, settled, reserved),
    ownerGeneration,
    // Target matching resolves against the task workspace. Durable intents
    // carry workspace-relative targets (server/CLI scope) so the authority
    // gate and the tool containment share one root; exec/process targets are
    // free-form and stay out of the target gate by design (see authority.ts).
    // Prefer the run manifest workspace, but only when it CONTAINS the
    // contract scope: otherwise the manifest is stale/foreign and the scope
    // (the authority the user actually granted) decides. Callers may pass an
    // explicit workspaceRoot (the loop passes its toolContext root, which is
    // the ground truth at dispatch time).
    workspaceRoot: workspaceRootFor(db, contract, input.taskId, workspaceRootHint),
    now,
  });
  if (!check.admitted) {
    return { admitted: false, reason: check.reason, detail: check.detail };
  }
  const createdAt = now.toISOString();
  guardWrites("admitDurable");
  throwIfFault("before-admitted-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO intents (intent_id, task_id, operation, target, action_key, authority_revision, state, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ADMITTED', ?)`,
    ).run(
      actionIntent.intentId,
      input.taskId,
      input.operation,
      input.target,
      input.actionKey,
      input.authorityRevision,
      createdAt,
    );
    db.prepare(
      `INSERT INTO attempts (attempt_id, intent_id, request_id, generation, ticket, state, created_at)
       VALUES (?, ?, ?, ?, ?, 'ADMITTED', ?)`,
    ).run(
      attemptId,
      actionIntent.intentId,
      input.requestId ?? null,
      ownerGeneration,
      JSON.stringify({ ...check.ticket, args: input.argsJson }),
      createdAt,
    );
    db.prepare(
      `INSERT INTO reservations (intent_id, calls, tokens, settled_calls, settled_tokens, state)
       VALUES (?, ?, ?, 0, 0, 'open')`,
    ).run(actionIntent.intentId, input.maxCalls, input.maxTokens);
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Original error below remains the actionable signal.
    }
    throw error;
  }
  throwIfFault("after-admitted");
  return { admitted: true, intentId: actionIntent.intentId, attemptId, ticket: check.ticket };
}

// Reuses the S0 validation (grant, expiry, revision, generation) against
// totals already persisted, so restarts never renew the budget.
function workspaceRootFor(db: DatabaseSync, contract: TaskContract, taskId: string, hint?: string): string {
  // Explicit caller hint wins when it contains the granted scope (the loop
  // passes its toolContext root: ground truth at dispatch time). The
  // containment check runs lexically on purpose: at this point the hint may
  // be a fresh temp dir whose scope child does not exist on disk yet, and
  // resolveInScope would refuse it for absence rather than escape.
  if (hint !== undefined && hint !== "") {
    const scope = contract.scope[0];
    if (typeof scope !== "string" || scope === "") return hint;
    if (path.isAbsolute(scope)) {
      const relative = path.relative(path.resolve(hint), path.resolve(scope));
      if (relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative))) return hint;
      return scope;
    }
    return hint;
  }
  // Prefer the task workspace recorded in the run manifest (absolute,
  // server-resolved); fall back to the first contract scope entry when it is
  // itself absolute, then to the process cwd. Target matching then degrades
  // gracefully, never to silent allow (absolute targets always deny). A
  // RELATIVE scope entry is NOT resolved against the cwd: it would make the
  // gate depend on where the process happened to start.
  try {
    const row = db
      .prepare("SELECT manifest FROM runs WHERE task_id = ? ORDER BY created_at DESC LIMIT 1")
      .get(taskId) as { manifest: string } | undefined;
    if (row !== undefined) {
      const manifest = JSON.parse(row.manifest) as { workspace?: unknown };
      if (typeof manifest.workspace === "string" && manifest.workspace !== "") return manifest.workspace;
    }
  } catch {
    // Fall through to scope/cwd fallbacks below.
  }
  const scope = contract.scope[0];
  if (typeof scope === "string" && scope !== "" && path.isAbsolute(scope)) return scope;
  return process.cwd();
}

function ledgerWithPersistedTotals(
  granted: BudgetGrant,
  settled: ReservationTotals,
  reserved: ReservationTotals,
): BudgetLedger {
  const ledger = new BudgetLedger(granted);
  if (settled.calls > 0 || settled.tokens > 0) {
    ledger.reserve({ calls: settled.calls, tokens: settled.tokens });
    ledger.settle(`persisted-${settled.calls}-${settled.tokens}`, {
      calls: settled.calls,
      tokens: settled.tokens,
    });
  }
  ledger.reserve(reserved);
  return ledger;
}

// Durable claim: revalidates generation and contract revision against the
// persisted ticket immediately before invocation, single-use, PLUS the full
// CURRENT authority (expiry, grant, target, provider/model/realm, typed
// restrictions) inside the same transactional boundary. A grant that expired
// between ADMITTED and CLAIMED (crash, WAIT, slow queue) denies here: admit
// and claim are never assumed to be fast. Commit durável; the executor may
// invoke at most once after this commit.
export function claimDurable(
  db: DatabaseSync,
  attemptId: string,
  ownerGeneration: number,
  contractRevision: number,
  revalidation?: {
    contract: TaskContract;
    now?: Date | undefined;
  },
): DurableClaimResult {
  const row = db
    .prepare("SELECT ticket, state, intent_id FROM attempts WHERE attempt_id = ?")
    .get(attemptId) as { ticket: string; state: string; intent_id: string } | undefined;
  if (row === undefined) return { claimed: false, reason: "not-found" };
  // Only a live admission ticket is claimable: resolved, unknown,
  // reconciled and invalidated attempts never gain authority again, even if
  // a concurrent reader classified them between admission and claim.
  if (row.state === "INVALIDATED") return { claimed: false, reason: "invalidated" };
  if (row.state !== "ADMITTED") return { claimed: false, reason: "already-claimed" };
  const ticket = JSON.parse(row.ticket) as AdmissionTicket;
  const intent = db
    .prepare("SELECT task_id, operation, target FROM intents WHERE intent_id = ?")
    .get(row.intent_id) as { task_id: string; operation: string; target: string | null } | undefined;
  if (intent === undefined) return { claimed: false, reason: "not-found" };
  // WITHOUT an explicit contract the claim still revalidates generation and
  // revision against the persisted ticket (legacy path); WITH a contract it
  // re-runs the full authority evaluator on CURRENT state before consuming.
  if (revalidation === undefined) {
    const result = claimTicket(ticket, ownerGeneration, contractRevision);
    if (!result.claimed) {
      return { claimed: false, reason: result.reason ?? "already-claimed" };
    }
  } else {
    const result = claimTicket(ticket, ownerGeneration, contractRevision, {
      contract: revalidation.contract,
      operation: intent.operation,
      target: intent.target,
      workspaceRoot: ticket.workspaceRoot ?? workspaceRootFor(db, revalidation.contract, intent.task_id),
      ...(ticket.provider === undefined ? {} : { provider: ticket.provider }),
      ...(ticket.model === undefined ? {} : { model: ticket.model }),
      ...(ticket.realm === undefined ? {} : { realm: ticket.realm }),
      now: revalidation.now,
    });
    if (!result.claimed) {
      return { claimed: false, reason: result.reason ?? "already-claimed" };
    }
  }
  guardWrites("claimDurable");
  throwIfFault("before-claim-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare("UPDATE attempts SET state = 'CLAIMED' WHERE attempt_id = ?").run(attemptId);
    db.prepare("UPDATE intents SET state = 'CLAIMED' WHERE intent_id = (SELECT intent_id FROM attempts WHERE attempt_id = ?)").run(
      attemptId,
    );
    // dispatchMarker: this claim follows the dispatch-marker protocol, so a
    // missing dispatchStartedAt after a crash proves the executor never
    // started the effect (see markDispatching / classifyUnfinishedIntents).
    db.prepare("UPDATE attempts SET ticket = ? WHERE attempt_id = ?").run(
      JSON.stringify({ ...ticket, claimed: true, dispatchMarker: true }),
      attemptId,
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
  throwIfFault("after-claim");
  return { claimed: true };
}

// Durable "about to dispatch" marker, committed after the claim and
// immediately before the provider request or tool execution starts. Crash
// boundary: a claimed attempt WITHOUT this marker provably never reached the
// network or the tool; WITH it, the effect may have happened (UNKNOWN).
export function markDispatching(db: DatabaseSync, attemptId: string, now: Date = new Date()): void {
  guardWrites("markDispatching");
  db.prepare("UPDATE attempts SET ticket = json_set(ticket, '$.dispatchStartedAt', ?) WHERE attempt_id = ? AND state = 'CLAIMED'").run(now.toISOString(), attemptId);
}

export function dispatchEvidence(db: DatabaseSync, attemptId: string): "dispatched" | "not-dispatched" | "unknown" {
  const row = db.prepare("SELECT ticket FROM attempts WHERE attempt_id = ?").get(attemptId) as { ticket: string } | undefined;
  if (row === undefined) return "unknown";
  try {
    const ticket = JSON.parse(row.ticket) as { dispatchMarker?: unknown; dispatchStartedAt?: unknown };
    if (ticket.dispatchMarker !== true) return "unknown";
    return typeof ticket.dispatchStartedAt === "string" ? "dispatched" : "not-dispatched";
  } catch {
    return "unknown";
  }
}

// Invalidates an ADMITTED intent that was never claimed (crash boundary B):
// by protocol it never dispatched, so the ticket dies and the unused
// reservation is released. Readmission stays possible when still needed.
export function invalidateAdmittedIntent(db: DatabaseSync, intentId: string): boolean {
  guardWrites("invalidateAdmittedIntent");
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db
      .prepare("SELECT state FROM intents WHERE intent_id = ?")
      .get(intentId) as { state: string } | undefined;
    if (row === undefined || row.state !== "ADMITTED") {
      db.exec("ROLLBACK");
      return false;
    }
    db.prepare("UPDATE intents SET state = 'INVALIDATED' WHERE intent_id = ?").run(intentId);
    db.prepare("UPDATE attempts SET state = 'INVALIDATED' WHERE intent_id = ? AND state = 'ADMITTED'").run(intentId);
    db.prepare("UPDATE reservations SET calls = settled_calls, tokens = settled_tokens, state = 'closed' WHERE intent_id = ?").run(
      intentId,
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
  return true;
}

// Durable receipt: persists the observed outcome, settles the reservation
// idempotently per attempt and closes the attempt in one transaction.
// UNKNOWN keeps the attempt pending reconciliation; it never replays blind.
export function recordReceiptDurable(db: DatabaseSync, input: ReceiptInput, now: Date = new Date()): void {
  if (!Number.isSafeInteger(input.settledCalls) || input.settledCalls < 0 ||
      !Number.isSafeInteger(input.settledTokens) || input.settledTokens < 0) {
    throw new Error("Observed settlement must contain non-negative safe integers");
  }
  const row = db
    .prepare("SELECT intent_id, state FROM attempts WHERE attempt_id = ?")
    .get(input.attemptId) as { intent_id: string; state: string } | undefined;
  if (row === undefined) {
    throw new Error(`Attempt ${input.attemptId} not found; cannot record receipt`);
  }
  if (row.state === "RESOLVED") {
    throw new DuplicateReceiptError(input.attemptId);
  }
  const createdAt = now.toISOString();
  guardWrites("recordReceiptDurable");
  throwIfFault("before-receipt-commit");
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT COUNT(*) AS n FROM receipts WHERE attempt_id = ?")
      .get(input.attemptId) as { n: number };
    if (existing.n > 0) {
      throw new DuplicateReceiptError(input.attemptId);
    }
    db.prepare(
      `INSERT INTO receipts (receipt_id, attempt_id, outcome, detail, recorded_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      `receipt-${randomUUID()}`,
      input.attemptId,
      input.outcome,
      JSON.stringify({ summary: input.summary, detail: input.detailJson }),
      createdAt,
    );
    const reservation = db
      .prepare("SELECT calls, tokens, settled_calls, settled_tokens FROM reservations WHERE intent_id = ?")
      .get(row.intent_id) as
      | { calls: number; tokens: number; settled_calls: number; settled_tokens: number }
      | undefined;
    if (reservation === undefined) {
      throw new Error(`Reservation for intent ${row.intent_id} not found`);
    }
    const openCalls = reservation.calls - reservation.settled_calls;
    const openTokens = reservation.tokens - reservation.settled_tokens;
    // An estimate cannot veto already observed consumption. Increasing the
    // reservation to actual usage records overage, never grants new authority.
    // Admission will refuse further work if the persisted hard cap is exceeded.
    const releaseUnused = input.releaseUnused ?? input.outcome !== "unknown";
    const releasedCalls = releaseUnused ? openCalls - input.settledCalls : Math.min(0, openCalls - input.settledCalls);
    const releasedTokens = releaseUnused ? openTokens - input.settledTokens : -input.settledTokens;
    db.prepare(
      `UPDATE reservations SET calls = calls - ?, tokens = tokens - ?,
        settled_calls = settled_calls + ?, settled_tokens = settled_tokens + ?
       WHERE intent_id = ?`,
    ).run(releasedCalls, releasedTokens, input.settledCalls, input.settledTokens, row.intent_id);
    db.prepare(
      `UPDATE reservations SET state = CASE
         WHEN (calls - settled_calls) + (tokens - settled_tokens) > 0 THEN 'open'
         ELSE 'closed' END
       WHERE intent_id = ?`,
    ).run(row.intent_id);
    const attemptState = input.outcome === "unknown" ? "UNKNOWN" : "RESOLVED";
    db.prepare("UPDATE attempts SET state = ? WHERE attempt_id = ?").run(attemptState, input.attemptId);
    db.prepare("UPDATE intents SET state = ? WHERE intent_id = ?").run(
      input.outcome === "unknown" ? "UNKNOWN" : "RESOLVED",
      row.intent_id,
    );
    if (input.usageDocument !== undefined) recordUsageRevision(db, input.attemptId, input.usageDocument, now);
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

// Recovery scan: CLAIMED attempts without a receipt are indistinguishable
// from post-invocation crashes, so they surface as UNKNOWN candidates.
export function findUnreconciledAttempts(db: DatabaseSync): string[] {
  const rows = db
    .prepare(
      `SELECT attempt_id FROM attempts WHERE state = 'CLAIMED'
       AND attempt_id NOT IN (SELECT attempt_id FROM receipts)`,
    )
    .all() as Array<{ attempt_id: string }>;
  return rows.map((row) => row.attempt_id);
}

// Late usage evidence: a new revision for the same physical attempt. Never
// a second settlement by itself; settlement corrections are explicit. Object
// documents are stamped with their revision so every stored revision stays
// self-describing for the export projection.
export function recordUsageRevision(db: DatabaseSync, attemptId: string, documentJson: string, now: Date = new Date()): number {
  const row = db
    .prepare("SELECT revision FROM attempt_usage WHERE attempt_id = ?")
    .get(attemptId) as { revision: number } | undefined;
  const revision = (row?.revision ?? 0) + 1;
  db.prepare(
    `INSERT INTO attempt_usage (attempt_id, revision, document, updated_at)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET revision = excluded.revision, document = excluded.document, updated_at = excluded.updated_at`,
  ).run(attemptId, revision, stampRevision(documentJson, revision), now.toISOString());
  return revision;
}

function stampRevision(documentJson: string, revision: number): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(documentJson);
  } catch {
    return documentJson;
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return documentJson;
  return JSON.stringify({ ...(parsed as Record<string, unknown>), usageRevision: revision });
}

// Releases whatever a reservation still holds open (for example after late
// usage arrived and was accounted). Closed reservations stay closed.
export function releaseReservation(db: DatabaseSync, intentId: string): void {
  db.prepare(
    `UPDATE reservations SET calls = settled_calls, tokens = settled_tokens, state = 'closed'
     WHERE intent_id = ? AND state = 'open'`,
  ).run(intentId);
}

export type EditReconciliation =
  | { result: "applied"; detail: string }
  | { result: "not-applied"; detail: string }
  | { result: "conflict"; detail: string };

// Extracts the post-effect content version from a receipt detail envelope.
// Accepts the normalized top-level afterVersion/version as well as older
// shapes where versions only appear nested inside the raw output blob.
export function receiptEffectVersions(receiptDetail: string): { afterVersion: string | null } {
  try {
    const outer = JSON.parse(receiptDetail) as { detail?: unknown };
    const candidates: unknown[] = [];
    if (typeof outer.detail === "string") {
      try {
        const inner = JSON.parse(outer.detail) as Record<string, unknown>;
        candidates.push(inner);
        if (typeof inner.output === "string") {
          try {
            candidates.push(JSON.parse(inner.output) as Record<string, unknown>);
          } catch {
            // Raw output is not JSON; versions must be top-level.
          }
        }
      } catch {
        return { afterVersion: null };
      }
    }
    for (const candidate of candidates) {
      if (candidate !== null && typeof candidate === "object") {
        const record = candidate as Record<string, unknown>;
        if (typeof record["afterVersion"] === "string") return { afterVersion: record["afterVersion"] };
        if (typeof record["version"] === "string") return { afterVersion: record["version"] };
      }
    }
    return { afterVersion: null };
  } catch {
    return { afterVersion: null };
  }
}

// Reconciles an UNKNOWN edit without replaying it: compares the observed
// content version against the versions retained before the write. Same final
// hash proves the desired state, not authorship; anything else is conflict.
//
// Reconciliation evidence is a new event, never a second receipt: the
// UNKNOWN receipt stays as history. Applied and not-applied outcomes move
// the intent to RECONCILED, which lifts the duplicate guard for an explicit
// readmission; conflict keeps UNKNOWN blocking until a human decides.
export function reconcileEditAttempt(
  db: DatabaseSync,
  attemptId: string,
  observedVersion: string,
): EditReconciliation {
  const row = db
    .prepare("SELECT intent_id, ticket FROM attempts WHERE attempt_id = ?")
    .get(attemptId) as { intent_id: string; ticket: string } | undefined;
  if (row === undefined) {
    return { result: "conflict", detail: `attempt ${attemptId} not found; cannot reconcile` };
  }
  const ticket = JSON.parse(row.ticket) as { args?: string };
  let args: { expectedVersion?: string };
  try {
    args = ticket.args !== undefined ? (JSON.parse(ticket.args) as { expectedVersion?: string }) : {};
  } catch {
    return { result: "conflict", detail: `attempt ${attemptId} carries no parseable edit plan` };
  }
  const receipt = db
    .prepare("SELECT detail FROM receipts WHERE attempt_id = ?")
    .get(attemptId) as { detail: string } | undefined;
  const afterVersion = receipt !== undefined ? receiptEffectVersions(receipt.detail).afterVersion : null;
  const taskId = intentTask(db, row.intent_id);
  if (afterVersion !== null && observedVersion === afterVersion) {
    closeReconciliation(db, row.intent_id, attemptId, "applied", `effect present at ${observedVersion}`, taskId);
    return { result: "applied", detail: `effect present at ${observedVersion}` };
  }
  if (args.expectedVersion !== undefined && observedVersion === args.expectedVersion) {
    closeReconciliation(db, row.intent_id, attemptId, "not-applied", `no effect at ${observedVersion}; safe to readmit`, taskId);
    return { result: "not-applied", detail: `no effect at ${observedVersion}; safe to readmit` };
  }
  db.prepare(`INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)`).run(
    "reconciliation.conflict",
    taskId,
    JSON.stringify({ attemptId, observedVersion }),
    new Date().toISOString(),
  );
  return {
    result: "conflict",
    detail: `current content ${observedVersion} matches neither before nor after version; human decision required`,
  };
}

function intentTask(db: DatabaseSync, intentId: string): string | null {
  const row = db.prepare("SELECT task_id FROM intents WHERE intent_id = ?").get(intentId) as { task_id: string } | undefined;
  return row?.task_id ?? null;
}

// Possibly-consumed accounting: what is still reserved by UNKNOWN intents.
// A remote call that may have been processed keeps counting against the
// budget; presenting it separately keeps "possible" from reading as zero or
// as an ordinary in-flight reservation.
export function uncertainReservationTotals(db: DatabaseSync, taskId: string): { calls: number; tokens: number } {
  const row = db
    .prepare(
      `SELECT COALESCE(SUM(r.calls - r.settled_calls), 0) AS calls,
              COALESCE(SUM(r.tokens - r.settled_tokens), 0) AS tokens
       FROM reservations r JOIN intents i ON i.intent_id = r.intent_id
       WHERE r.state = 'open' AND i.task_id = ? AND i.state = 'UNKNOWN'`,
    )
    .get(taskId) as { calls: number; tokens: number };
  return { calls: row.calls, tokens: row.tokens };
}

export type ReconcileDecision = "observe" | "treat-as-applied" | "treat-as-not-applied";

export interface ReconcileOutcome {
  attemptId: string;
  operation: string;
  result: "applied" | "not-applied" | "inert" | "conflict" | "human-applied" | "human-not-applied" | "not-reconcilable";
  reconciled: boolean;
  detail: string;
}

function fileState(workspaceRoot: string, relative: string | undefined): { kind: "absent" } | { kind: "file"; version: string } | { kind: "unobservable"; detail: string } {
  if (typeof relative !== "string" || relative === "") return { kind: "unobservable", detail: "edit plan names no path" };
  const absolute = resolveInScope(workspaceRoot, relative);
  if (absolute === null) return { kind: "unobservable", detail: `${relative} resolves outside the workspace` };
  try {
    const stat = fs.lstatSync(absolute);
    if (!stat.isFile()) return { kind: "unobservable", detail: `${relative} is not a regular file` };
    return { kind: "file", version: `sha256:${createHash("sha256").update(fs.readFileSync(absolute)).digest("hex").slice(0, 16)}` };
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    return code === "ENOENT" ? { kind: "absent" } : { kind: "unobservable", detail: `${relative} could not be read` };
  }
}

function describeState(state: ReturnType<typeof fileState>): string {
  return state.kind === "file" ? state.version : state.kind === "absent" ? "absent" : `unobservable (${state.detail})`;
}

// Observation-based classification of an UNKNOWN edit, for every kind. The
// final state matching the plan proves the desired state, not authorship;
// anything that matches neither the precondition nor the plan is a conflict
// that only a human may decide.
function observeEdit(argsJson: string | undefined, afterVersion: string | null, workspaceRoot: string): { result: "applied" | "not-applied" | "conflict"; detail: string } {
  let args: { kind?: unknown; path?: unknown; content?: unknown; expectedVersion?: unknown; newPath?: unknown; oldText?: unknown; newText?: unknown };
  try {
    args = argsJson !== undefined ? (JSON.parse(argsJson) as typeof args) : {};
  } catch {
    return { result: "conflict", detail: "attempt carries no parseable edit plan" };
  }
  const target = typeof args.path === "string" ? args.path : undefined;
  const expected = typeof args.expectedVersion === "string" ? args.expectedVersion : null;
  const current = fileState(workspaceRoot, target);
  if (current.kind === "unobservable") return { result: "conflict", detail: current.detail };
  switch (args.kind) {
    case "create": {
      if (current.kind === "absent") return { result: "not-applied", detail: `${target} absent; create not applied` };
      const planned = typeof args.content === "string" ? `sha256:${createHash("sha256").update(args.content, "utf8").digest("hex").slice(0, 16)}` : null;
      return current.version === planned
        ? { result: "applied", detail: `${target} present with the planned content ${current.version}` }
        : { result: "conflict", detail: `${target} exists with ${current.version}, not the planned content` };
    }
    case "delete":
      if (current.kind === "absent") return { result: "applied", detail: `${target} absent; delete effect present` };
      return current.version === expected
        ? { result: "not-applied", detail: `${target} unchanged at ${current.version}; delete not applied` }
        : { result: "conflict", detail: `${target} at ${current.version} matches neither the precondition nor deletion` };
    case "rename": {
      const destination = fileState(workspaceRoot, typeof args.newPath === "string" ? args.newPath : undefined);
      if (destination.kind === "unobservable") return { result: "conflict", detail: destination.detail };
      if (current.kind === "absent" && destination.kind === "file" && destination.version === expected) return { result: "applied", detail: `content ${expected} now at ${String(args.newPath)}` };
      if (current.kind === "file" && current.version === expected && destination.kind === "absent") return { result: "not-applied", detail: `${target} unchanged at ${current.version}; rename not applied` };
      return { result: "conflict", detail: `source ${describeState(current)}, destination ${describeState(destination)}` };
    }
    default:
      if (current.kind === "file" && current.version === expected) return { result: "not-applied", detail: `${target} unchanged at ${current.version}; safe to readmit` };
      if (current.kind === "file" && afterVersion !== null && current.version === afterVersion) return { result: "applied", detail: `effect present at ${current.version}` };
      if (current.kind === "file" && expected !== null && typeof args.oldText === "string" && typeof args.newText === "string"
        && replacementReverts(workspaceRoot, target, args.oldText, args.newText, expected)) {
        return { result: "applied", detail: `${target} at ${current.version} is exactly the precondition ${expected} with the planned replacement applied` };
      }
      return { result: "conflict", detail: `${target} is ${describeState(current)}; matches neither the precondition nor a recorded result` };
  }
}

// Proof for a replace without a receipt: undoing the planned replacement at
// some occurrence of newText yields bytes whose version is exactly the
// precondition. Only then is the current file "precondition + this edit".
function replacementReverts(workspaceRoot: string, relative: string | undefined, oldText: string, newText: string, expected: string): boolean {
  if (newText === "" || typeof relative !== "string") return false;
  const absolute = resolveInScope(workspaceRoot, relative);
  if (absolute === null) return false;
  let content: string;
  try {
    content = fs.readFileSync(absolute, "utf8");
  } catch {
    return false;
  }
  for (let index = content.indexOf(newText); index !== -1; index = content.indexOf(newText, index + 1)) {
    const reverted = content.slice(0, index) + oldText + content.slice(index + newText.length);
    if (`sha256:${createHash("sha256").update(reverted, "utf8").digest("hex").slice(0, 16)}` === expected) return true;
  }
  return false;
}

// Reconciles one UNKNOWN attempt of a task, by operation:
// - read/search have no mutating effect: reconciled as inert;
// - edit is reconciled by observing the disk against its plan;
// - exec/process cannot be proven by local observation: only an explicit,
//   recorded human decision closes them;
// - model.invoke is never reconciled here: a remote call may have been
//   processed and billed; it stays UNKNOWN and its reservation stays counted.
// Every outcome is an event with provenance; the UNKNOWN receipt stays.
export function reconcileUnknownAttempt(
  db: DatabaseSync,
  taskId: string,
  attemptId: string,
  workspaceRoot: string,
  decision: ReconcileDecision = "observe",
  actor = "human",
  note: string | null = null,
): ReconcileOutcome {
  const row = db
    .prepare(
      `SELECT a.intent_id, a.ticket, a.state AS attempt_state, i.state AS intent_state, i.operation
       FROM attempts a JOIN intents i ON i.intent_id = a.intent_id WHERE a.attempt_id = ? AND i.task_id = ?`,
    )
    .get(attemptId, taskId) as { intent_id: string; ticket: string; attempt_state: string; intent_state: string; operation: string } | undefined;
  if (row === undefined) return { attemptId, operation: "unknown", result: "not-reconcilable", reconciled: false, detail: `attempt ${attemptId} does not belong to task ${taskId}` };
  const base = { attemptId, operation: row.operation };
  if (row.intent_state !== "UNKNOWN" && row.attempt_state !== "UNKNOWN") {
    return { ...base, result: "not-reconcilable", reconciled: false, detail: `attempt is ${row.attempt_state}, not UNKNOWN` };
  }
  if (row.operation === "model.invoke") {
    return { ...base, result: "not-reconcilable", reconciled: false, detail: "a remote model call cannot be observed locally; it may have been processed and billed. Acknowledge it to continue; its reservation stays counted as possible consumption" };
  }
  if (decision !== "observe") {
    if (row.operation === "read" || row.operation === "search") {
      closeReconciliation(db, row.intent_id, attemptId, "inert", "non-mutating operation", taskId);
      return { ...base, result: "inert", reconciled: true, detail: "non-mutating operation; nothing to reconcile" };
    }
    const result = decision === "treat-as-applied" ? "human-applied" : "human-not-applied";
    closeReconciliation(db, row.intent_id, attemptId, "human", `${actor} decided: ${decision}${note === null ? "" : ` (${note})`}`, taskId, { decision, actor, note });
    return { ...base, result, reconciled: true, detail: `recorded human decision: ${decision}` };
  }
  if (row.operation === "read" || row.operation === "search") {
    closeReconciliation(db, row.intent_id, attemptId, "inert", "non-mutating operation", taskId);
    return { ...base, result: "inert", reconciled: true, detail: "non-mutating operation; nothing to reconcile" };
  }
  if (row.operation === "edit") {
    let argsJson: string | undefined;
    try {
      const ticket = JSON.parse(row.ticket) as { args?: unknown };
      argsJson = typeof ticket.args === "string" ? ticket.args : undefined;
    } catch {
      argsJson = undefined;
    }
    const receipt = db.prepare("SELECT detail FROM receipts WHERE attempt_id = ?").get(attemptId) as { detail: string } | undefined;
    const observed = observeEdit(argsJson, receipt !== undefined ? receiptEffectVersions(receipt.detail).afterVersion : null, workspaceRoot);
    if (observed.result === "conflict") {
      db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(
        "reconciliation.conflict", taskId, JSON.stringify({ attemptId, detail: observed.detail }), new Date().toISOString());
      return { ...base, result: "conflict", reconciled: false, detail: `${observed.detail}; human decision required` };
    }
    closeReconciliation(db, row.intent_id, attemptId, observed.result, observed.detail, taskId);
    return { ...base, result: observed.result, reconciled: true, detail: observed.detail };
  }
  return { ...base, result: "not-reconcilable", reconciled: false, detail: "process effects cannot be proven by local observation; inspect the workspace and record a decision" };
}

function closeReconciliation(
  db: DatabaseSync,
  intentId: string,
  attemptId: string,
  result: "applied" | "not-applied" | "inert" | "human",
  detail: string,
  taskId: string | null = null,
  extra: Record<string, unknown> = {},
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(`INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)`).run(
      `reconciliation.${result}`,
      taskId,
      JSON.stringify({ attemptId, detail, ...extra }),
      new Date().toISOString(),
    );
    db.prepare(`UPDATE intents SET state = 'RECONCILED' WHERE intent_id = ?`).run(intentId);
    db.prepare(`UPDATE attempts SET state = 'RECONCILED' WHERE attempt_id = ?`).run(attemptId);
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
