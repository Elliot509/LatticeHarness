import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { TaskContract } from "./contract.js";
import { parseToolArgs } from "../tools/types.js";

// Human confirmation for mutating actions (PG-040), opt-in per task through
// the contract's approval policy. An approval names ONE exact action (tool +
// canonical arguments) and is consumed by one execution; a denial is
// returned to the model as that call's result and cannot be bypassed by
// re-asking: an identical call needs a new human decision. This is
// enforcement at the admission boundary, not guidance in the prompt.

export type ApprovalPolicy = "none" | "confirm-mutations";

export function approvalPolicy(contract: TaskContract): ApprovalPolicy {
  return (contract as TaskContract & { approvalPolicy?: unknown }).approvalPolicy === "confirm-mutations" ? "confirm-mutations" : "none";
}

const OBSERVATIONAL_PROCESS_OPS = new Set(["poll", "read", "list"]);

export function requiresApproval(contract: TaskContract, tool: string, argsJson: string): boolean {
  if (approvalPolicy(contract) !== "confirm-mutations") return false;
  if (tool === "edit" || tool === "exec") return true;
  if (tool !== "process") return false;
  const parsed = parseToolArgs(argsJson);
  const op = parsed.ok ? parsed.value["op"] : undefined;
  return !(typeof op === "string" && OBSERVATIONAL_PROCESS_OPS.has(op));
}

function text(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : typeof value === "number" || typeof value === "boolean" ? String(value) : fallback;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([key, item]: [string, unknown]) => [key, canonical(item)]));
  }
  return value;
}

export function approvalKey(tool: string, argsJson: string): string {
  const parsed = parseToolArgs(argsJson);
  const args = parsed.ok ? canonical(parsed.value) : argsJson;
  return createHash("sha256").update(JSON.stringify([tool, args])).digest("hex").slice(0, 24);
}

// Human-readable description of exactly what would run or change.
export function describeAction(tool: string, argsJson: string): string {
  const parsed = parseToolArgs(argsJson);
  if (!parsed.ok) return `${tool} com argumentos inválidos`;
  const args = parsed.value;
  if (tool === "exec") {
    // Everything that changes what runs is named: cwd, env and stdin too.
    const env = args["env"] !== null && typeof args["env"] === "object" && !Array.isArray(args["env"]) ? Object.keys(args["env"]) : [];
    const where = `${typeof args["cwd"] === "string" ? ` (em ${args["cwd"]})` : ""}${env.length > 0 ? ` com as variáveis ${env.join(", ")}` : ""}${typeof args["input"] === "string" ? " com entrada padrão" : ""}`;
    if (typeof args["command"] === "string") return `executar no shell ${text(args["shell"], "?")}: ${args["command"]}${where}`;
    const argv = Array.isArray(args["argv"]) ? args["argv"].filter((item): item is string => typeof item === "string") : [];
    return `executar: ${`${text(args["executable"], "?")} ${argv.join(" ")}`.trim()}${where}`;
  }
  if (tool === "edit") {
    const kind = text(args["kind"], "?");
    const target = text(args["path"], "?");
    if (kind === "create") return `criar o arquivo ${target}`;
    if (kind === "delete") return `apagar o arquivo ${target}`;
    if (kind === "rename") return `renomear ${target} para ${text(args["newPath"], "?")}`;
    return `alterar o arquivo ${target}`;
  }
  return `${tool} ${text(args["op"], "")}`.trim();
}

interface Row { kind: string; payload: string }

function rows(db: DatabaseSync, taskId: string, key: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  const found = db
    .prepare("SELECT kind, payload FROM events WHERE task_id = ? AND kind IN ('approval.requested', 'approval.decided', 'approval.used', 'approval.withdrawn') AND json_extract(payload, '$.key') = ? ORDER BY seq ASC")
    .all(taskId, key) as unknown as Row[];
  return found.flatMap((row) => {
    try {
      return [{ kind: row.kind, payload: JSON.parse(row.payload) as Record<string, unknown> }];
    } catch {
      return [];
    }
  });
}

// The newest decision that no execution has consumed yet, if any, with the
// contract revision the human saw when the action was requested.
export function openDecision(db: DatabaseSync, taskId: string, key: string): { decision: "approved" | "denied"; note: string | null; revision: number | null } | null {
  let open: { decision: "approved" | "denied"; note: string | null; revision: number | null } | null = null;
  let requestedAt: number | null = null;
  for (const row of rows(db, taskId, key)) {
    if (row.kind === "approval.requested") requestedAt = typeof row.payload["revision"] === "number" ? row.payload["revision"] : null;
    else if (row.kind === "approval.decided") open = { decision: row.payload["decision"] === "approved" ? "approved" : "denied", note: typeof row.payload["note"] === "string" ? row.payload["note"] : null, revision: requestedAt };
    else if (row.kind === "approval.used" || row.kind === "approval.withdrawn") open = null;
  }
  return open;
}

function insert(db: DatabaseSync, taskId: string, kind: string, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(kind, taskId, JSON.stringify(payload), new Date().toISOString());
}

export function requestApproval(db: DatabaseSync, taskId: string, input: { key: string; tool: string; argsJson: string; toolCallId: string; runId: string; revision: number }): void {
  const history = rows(db, taskId, input.key);
  const last = history.at(-1);
  if (last?.kind === "approval.requested") {
    if (last.payload["revision"] === input.revision) return;
    insert(db, taskId, "approval.withdrawn", { key: input.key, reason: "contract revised since the request" });
  }
  insert(db, taskId, "approval.requested", { ...input, description: describeAction(input.tool, input.argsJson) });
}

export function useDecision(db: DatabaseSync, taskId: string, key: string, attemptId: string | null): void {
  insert(db, taskId, "approval.used", { key, attemptId });
}

export function decideApproval(db: DatabaseSync, taskId: string, input: { key: string; decision: "approved" | "denied"; actor: string; note: string | null }): boolean {
  const history = rows(db, taskId, input.key);
  if (history.at(-1)?.kind !== "approval.requested") return false;
  insert(db, taskId, "approval.decided", input);
  return true;
}

export interface PendingApproval {
  key: string;
  tool: string;
  argsJson: string;
  description: string;
  toolCallId: string;
  requestedAt: string;
}

// Requests still waiting for a human decision.
export function pendingApprovals(db: DatabaseSync, taskId: string): PendingApproval[] {
  const found = db
    .prepare("SELECT kind, payload, recorded_at FROM events WHERE task_id = ? AND kind IN ('approval.requested', 'approval.decided', 'approval.used', 'approval.withdrawn') ORDER BY seq ASC")
    .all(taskId) as Array<{ kind: string; payload: string; recorded_at: string }>;
  const open = new Map<string, PendingApproval>();
  for (const row of found) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = typeof payload["key"] === "string" ? payload["key"] : "";
    if (row.kind === "approval.requested") {
      open.set(key, {
        key,
        tool: text(payload["tool"], ""),
        argsJson: text(payload["argsJson"], "{}"),
        description: text(payload["description"], ""),
        toolCallId: text(payload["toolCallId"], ""),
        requestedAt: row.recorded_at,
      });
    } else {
      open.delete(key);
    }
  }
  return [...open.values()];
}

export interface ApprovalDecision {
  id: string;
  key: string;
  seq: number;
  tool: string;
  description: string;
  decision: "approved" | "denied" | "withdrawn";
  note: string | null;
  recordedAt: string;
}

// Every human decision (and every withdrawn request) in ledger order, named
// by the request it answered. A decision is not a result: the action's own
// receipt, if any, says what happened.
export function approvalHistory(db: DatabaseSync, taskId: string): ApprovalDecision[] {
  const found = db
    .prepare("SELECT seq, kind, payload, recorded_at FROM events WHERE task_id = ? AND kind IN ('approval.requested', 'approval.decided', 'approval.withdrawn') ORDER BY seq ASC")
    .all(taskId) as Array<{ seq: number; kind: string; payload: string; recorded_at: string }>;
  const requested = new Map<string, { tool: string; description: string }>();
  const history: ApprovalDecision[] = [];
  for (const row of found) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    const key = text(payload["key"], "");
    if (row.kind === "approval.requested") {
      requested.set(key, { tool: text(payload["tool"], ""), description: text(payload["description"], "") });
      continue;
    }
    const request = requested.get(key);
    if (request === undefined) continue;
    const decision = row.kind === "approval.withdrawn" ? "withdrawn" : payload["decision"] === "approved" ? "approved" : "denied";
    history.push({ id: `approval-${row.seq}`, key, seq: row.seq, ...request, decision, note: typeof payload["note"] === "string" ? payload["note"] : typeof payload["reason"] === "string" ? payload["reason"] : null, recordedAt: row.recorded_at });
    requested.delete(key);
  }
  return history;
}

// A request (or an unused decision) that no longer applies: the human
// answered with a message, or the contract changed since it was shown.
export function withdrawApproval(db: DatabaseSync, taskId: string, key: string, reason = "superseded by a user message"): void {
  insert(db, taskId, "approval.withdrawn", { key, reason });
}

export function approvalRequestedFor(db: DatabaseSync, taskId: string, toolCallId: string): boolean {
  const row = db.prepare("SELECT 1 AS hit FROM events WHERE task_id = ? AND kind = 'approval.requested' AND json_extract(payload, '$.toolCallId') = ? LIMIT 1").get(taskId, toolCallId);
  return row !== undefined;
}
