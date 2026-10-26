import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { SURFACE_VERSION } from "../context/compiler.js";
import { OPENAI_ADAPTER_REVISION } from "../providers/openai.js";
import type { ModelRequest } from "../providers/types.js";
import type { ToolDefinition } from "../providers/types.js";

// R1 composition identity (D-R1-05, F-0010): minimal strong identity for the
// effective composition of an activation/request. Tools are fixed today, but
// skills/MCP/dynamic surfaces will need this boundary later; the identity is
// built now so the next surface plugs into a fenced slot instead of a hole.
//
// CompositionEpoch = monotonic per-task counter + deterministic digest of
// the effective composition (provider + model canonical ids, tool surface,
// adapter revision, surface version). It changes ONLY on semantically
// relevant change at a safe point (route switch); UI refresh, reconnect,
// cosmetic settings never bump it (no epoch inflation). Persisted in
// composition_epochs so restart reconstructs rather than resets.

export interface Composition {
  provider: string;
  model: string;
  toolSurfaceDigest: string;
  adapterRevision: string;
  surfaceVersion: string;
  endpoint?: string | null;
}

export interface CompositionEpoch {
  epoch: number;
  digest: string;
  composition: Composition;
}

export function toolSurfaceDigest(tools: readonly ToolDefinition[]): string {
  const canonical = [...tools]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function compositionDigest(composition: Composition): string {
  return createHash("sha256").update(JSON.stringify(composition), "utf8").digest("hex");
}

function ensureTable(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS composition_epochs (
      task_id TEXT PRIMARY KEY,
      epoch INTEGER NOT NULL,
      digest TEXT NOT NULL,
      composition TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`,
  );
}

export function currentCompositionEpoch(db: DatabaseSync, taskId: string): CompositionEpoch | null {
  ensureTable(db);
  const row = db.prepare("SELECT epoch, digest, composition FROM composition_epochs WHERE task_id = ?").get(taskId) as
    | { epoch: number; digest: string; composition: string }
    | undefined;
  if (row === undefined) return null;
  try {
    return { epoch: row.epoch, digest: row.digest, composition: JSON.parse(row.composition) as Composition };
  } catch {
    return null;
  }
}

// Opens epoch 1 for a new task, or advances exactly once when the effective
// composition changed since the stored epoch. Same composition → same epoch
// (idempotent: refresh/reconnect/start-task re-entry never inflates).
export function advanceCompositionEpoch(
  db: DatabaseSync,
  taskId: string,
  composition: Composition,
  now: Date = new Date(),
): CompositionEpoch {
  ensureTable(db);
  const digest = compositionDigest(composition);
  const current = currentCompositionEpoch(db, taskId);
  if (current !== null && current.digest === digest) return current;
  const epoch = current === null ? 1 : current.epoch + 1;
  db.prepare(
    "INSERT INTO composition_epochs (task_id, epoch, digest, composition, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(task_id) DO UPDATE SET epoch = excluded.epoch, digest = excluded.digest, composition = excluded.composition, updated_at = excluded.updated_at",
  ).run(taskId, epoch, digest, JSON.stringify(composition), now.toISOString());
  return { epoch, digest, composition };
}

export function compositionForRoute(
  provider: string,
  model: string,
  tools: readonly ToolDefinition[],
  adapterRevision: string = OPENAI_ADAPTER_REVISION,
  surfaceVersion: string = SURFACE_VERSION,
  endpoint?: string | null,
): Composition {
  return { provider, model, toolSurfaceDigest: toolSurfaceDigest(tools), adapterRevision, surfaceVersion, ...(endpoint === undefined ? {} : { endpoint }) };
}

// RequestBinding: what exactly was sent under which composition and which
// authoritative cut. The payload digest is SHA-256 over a canonical,
// secret-free representation of the effectively-sent ModelRequest. Digest is
// identity, not storage: the ledger already holds what reconstruction needs.
export interface RequestBinding {
  requestId: string;
  attemptId: string;
  contractRevision: number;
  compositionEpoch: number;
  compositionDigest: string;
  provider: string;
  model: string;
  toolSurfaceDigest: string;
  ledgerCut: number;
  payloadDigest: string;
  endpoint: string | null;
}

function canonicalPayload(request: ModelRequest): string {
  const messages = request.messages.map((message) => ({
    content: message.content,
    role: message.role,
    ...(message.toolCallId !== undefined ? { toolCallId: message.toolCallId } : {}),
    ...(message.toolName !== undefined ? { toolName: message.toolName } : {}),
    ...(message.toolCalls !== undefined ? { toolCalls: message.toolCalls.map((call) => ({ id: call.id, name: call.name, argumentsJson: call.argumentsJson })) } : {}),
  }));
  const tools = [...request.tools]
    .map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return JSON.stringify({
    model: request.model,
    system: request.system,
    messages,
    tools,
    ...(request.maxOutputTokens !== undefined ? { maxOutputTokens: request.maxOutputTokens } : {}),
  });
}

export function payloadDigest(request: ModelRequest): string {
  return createHash("sha256").update(canonicalPayload(request), "utf8").digest("hex");
}

export function ledgerCutOf(db: DatabaseSync): number {
  try {
    const row = db.prepare("SELECT COALESCE(MAX(seq), 0) AS cut FROM events").get() as { cut: number };
    return row.cut;
  } catch {
    return 0;
  }
}

export function bindRequest(input: {
  db: DatabaseSync;
  taskId: string;
  requestId: string;
  attemptId: string;
  contractRevision: number;
  epoch: CompositionEpoch;
  provider: string;
  model: string;
  request: ModelRequest;
}): RequestBinding {
  return {
    requestId: input.requestId,
    attemptId: input.attemptId,
    contractRevision: input.contractRevision,
    compositionEpoch: input.epoch.epoch,
    compositionDigest: input.epoch.digest,
    provider: input.provider,
    model: input.model,
    toolSurfaceDigest: input.epoch.composition.toolSurfaceDigest,
    ledgerCut: ledgerCutOf(input.db),
    payloadDigest: payloadDigest(input.request),
    endpoint: input.epoch.composition.endpoint ?? null,
  };
}
