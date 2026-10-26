import type { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import type { ModelToolCall } from "../providers/types.js";

// Durable conversation protocol. The ledger keeps the exchange the model
// takes part in: user turns (chat events), assistant turns with their tool
// calls, one tool result per call (correlated by toolCallId) and runtime
// observations. Requests are rebuilt from these events on every iteration,
// so a resume or a restart continues the same exchange instead of starting
// from the objective alone. Private model reasoning is never stored.

export type ConversationTurn =
  | { kind: "user"; seq: number; text: string; taskId: string }
  | { kind: "assistant"; seq: number; text: string; toolCalls: ModelToolCall[]; taskId: string }
  | { kind: "tool"; seq: number; toolCallId: string; name: string; content: string; taskId: string }
  | { kind: "runtime"; seq: number; text: string; taskId: string };

// Bounds what one turn may contribute to any request; the full content stays
// in receipts and events.
export const MAX_TOOL_CONTENT = 6_000;
export const MAX_TURN_TEXT = 8_000;

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/u;

function stableId(seed: string): string {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const digest = createHash("sha256").update(seed).digest();
  let id = "";
  for (let index = 0; index < 9; index += 1) id += alphabet.charAt((digest[index] ?? 0) % alphabet.length);
  return id;
}

// Tool-call ids must be unique across the whole replayed history and safe
// for every provider dialect. Provider ids are kept when they already are;
// absent, duplicated or unusual ids are replaced by a deterministic
// 9-character alphanumeric id derived from the attempt.
export function normalizeToolCalls(db: DatabaseSync, taskId: string, attemptId: string, calls: readonly ModelToolCall[]): ModelToolCall[] {
  const used = new Set<string>();
  const rows = db.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'conversation.assistant'").all(taskId) as Array<{ payload: string }>;
  for (const row of rows) {
    try {
      const parsed = JSON.parse(row.payload) as { toolCalls?: Array<{ id?: unknown }> };
      for (const call of parsed.toolCalls ?? []) if (typeof call.id === "string") used.add(call.id);
    } catch {
      // An unreadable turn cannot reserve ids; uniqueness below still holds within this turn.
    }
  }
  return calls.map((call, index) => {
    let id = SAFE_ID.test(call.id) && !used.has(call.id) ? call.id : stableId(`${attemptId}:${index}`);
    for (let salt = 1; used.has(id); salt += 1) id = stableId(`${attemptId}:${index}:${salt}`);
    used.add(id);
    return { id, name: call.name, argumentsJson: call.argumentsJson };
  });
}

export function recordAssistantTurn(db: DatabaseSync, taskId: string, turn: { runId: string; attemptId: string; text: string; toolCalls: readonly ModelToolCall[] }): void {
  recordTaskEvent(db, taskId, "conversation.assistant", { runId: turn.runId, attemptId: turn.attemptId, text: turn.text, toolCalls: turn.toolCalls });
}

export function recordToolResult(db: DatabaseSync, taskId: string, result: { runId: string; toolCallId: string; name: string; attemptId: string | null; content: string }): void {
  recordTaskEvent(db, taskId, "conversation.tool", { ...result, content: clip(result.content, MAX_TOOL_CONTENT) });
}

export function recordRuntimeNote(db: DatabaseSync, taskId: string, text: string): void {
  recordTaskEvent(db, taskId, "conversation.runtime", { text: clip(text, MAX_TURN_TEXT) });
}

function recordTaskEvent(db: DatabaseSync, taskId: string, kind: string, payload: Record<string, unknown>): void {
  db.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES (?, ?, ?, ?)").run(kind, taskId, JSON.stringify(payload), new Date().toISOString());
}

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n[conteúdo reduzido para o contexto do modelo; registro completo preservado]`;
}

interface Row { seq: number; kind: string; payload: string; task_id: string }

function rowsFor(db: DatabaseSync, taskId: string): Row[] {
  return db
    .prepare(
      `SELECT seq, kind, payload, task_id FROM events
       WHERE task_id = ? AND kind IN ('chat', 'conversation.assistant', 'conversation.tool', 'conversation.runtime')
       ORDER BY seq ASC`,
    )
    .all(taskId) as unknown as Row[];
}

// Turns of one task, in ledger order. Tasks recorded before this protocol
// have no conversation events: their real model texts become assistant
// turns and their receipts become one derived, labeled runtime note. Nothing
// is invented to fill the gap.
export function taskTurns(db: DatabaseSync, taskId: string): ConversationTurn[] {
  const rows = rowsFor(db, taskId);
  const structured = rows.some((row) => row.kind.startsWith("conversation."));
  const turns: ConversationTurn[] = [];
  for (const row of rows) {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (row.kind === "chat") {
      const text = typeof payload["text"] === "string" ? payload["text"] : "";
      if (text.trim() === "") continue;
      if (payload["author"] === "user") turns.push({ kind: "user", seq: row.seq, text: clip(text, MAX_TURN_TEXT), taskId });
      else if (payload["author"] === "agent" && payload["source"] === "verified") turns.push({ kind: "runtime", seq: row.seq, text: `[Resultado verificado pelo Lattice e mostrado ao usuário]\n${clip(text, MAX_TURN_TEXT)}`, taskId });
      else if (!structured && payload["author"] === "agent") turns.push({ kind: "assistant", seq: row.seq, text: clip(text, MAX_TURN_TEXT), toolCalls: [], taskId });
      continue;
    }
    if (row.kind === "conversation.assistant") {
      const calls = Array.isArray(payload["toolCalls"]) ? (payload["toolCalls"] as Array<Record<string, unknown>>) : [];
      turns.push({
        kind: "assistant",
        seq: row.seq,
        text: clip(typeof payload["text"] === "string" ? payload["text"] : "", MAX_TURN_TEXT),
        toolCalls: calls.flatMap((call) => typeof call["id"] === "string" && typeof call["name"] === "string"
          ? [{ id: call["id"], name: call["name"], argumentsJson: typeof call["argumentsJson"] === "string" ? call["argumentsJson"] : "{}" }]
          : []),
        taskId,
      });
    } else if (row.kind === "conversation.tool") {
      if (typeof payload["toolCallId"] !== "string") continue;
      turns.push({ kind: "tool", seq: row.seq, toolCallId: payload["toolCallId"], name: typeof payload["name"] === "string" ? payload["name"] : "tool", content: typeof payload["content"] === "string" ? payload["content"] : "", taskId });
    } else if (typeof payload["text"] === "string") {
      turns.push({ kind: "runtime", seq: row.seq, text: payload["text"], taskId });
    }
  }
  if (!structured) {
    const note = legacyEvidenceNote(db, taskId);
    if (note !== null) {
      // Placed after the first user turn: it summarizes work that followed the objective.
      const index = turns.findIndex((turn) => turn.kind === "user");
      turns.splice(index + 1, 0, { kind: "runtime", seq: (turns[index]?.seq ?? 0) + 0.5, text: note, taskId });
    }
  }
  return turns;
}

function legacyEvidenceNote(db: DatabaseSync, taskId: string): string | null {
  const rows = db
    .prepare(
      `SELECT i.operation, i.target, r.outcome, r.detail FROM receipts r
       JOIN attempts a ON a.attempt_id = r.attempt_id JOIN intents i ON i.intent_id = a.intent_id
       WHERE i.task_id = ? AND i.operation != 'model.invoke' ORDER BY r.recorded_at DESC LIMIT 20`,
    )
    .all(taskId) as Array<{ operation: string; target: string | null; outcome: string; detail: string }>;
  if (rows.length === 0) return null;
  const lines = rows.reverse().map((row) => {
    let summary = "";
    try {
      const parsed = JSON.parse(row.detail) as { summary?: unknown };
      if (typeof parsed.summary === "string") summary = parsed.summary.replace(/\s+/gu, " ").slice(0, 300);
    } catch {
      summary = "";
    }
    return `- ${row.operation}${row.target === null ? "" : ` ${row.target}`} (${row.outcome}): ${summary}`;
  });
  return `[Resumo derivado dos recibos de ações anteriores desta tarefa (registro anterior ao histórico estruturado); não é a conversa original]\n${lines.join("\n")}`;
}

// Follow-up chain, oldest first, excluding the task itself. A follow-up is a
// new contract; this only names whose exchange it continues.
export function taskLineage(db: DatabaseSync, taskId: string, maxDepth = 5): string[] {
  const chain: string[] = [];
  let current = taskId;
  for (let depth = 0; depth < maxDepth; depth += 1) {
    const row = db
      .prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'follow-up-request' ORDER BY seq ASC LIMIT 1")
      .get(current) as { payload: string } | undefined;
    if (row === undefined) break;
    let from: unknown;
    try {
      from = (JSON.parse(row.payload) as { from?: unknown }).from;
    } catch {
      break;
    }
    if (typeof from !== "string" || chain.includes(from) || from === taskId) break;
    chain.unshift(from);
    current = from;
  }
  return chain;
}

function objectiveOf(db: DatabaseSync, taskId: string): string {
  const row = db.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string } | undefined;
  try {
    const objective = row === undefined ? undefined : (JSON.parse(row.document) as { objective?: unknown }).objective;
    return typeof objective === "string" ? objective : "(tarefa anterior)";
  } catch {
    return "(tarefa anterior)";
  }
}

// The exchange a task continues: each ancestor's turns behind a labeled
// boundary, then the task's own turns. Inherited call ids are remapped per
// ancestor so ids stay unique within one request. Context only: authority,
// grants and acceptance come from the task's own contract.
export function conversationWithLineage(db: DatabaseSync, taskId: string): ConversationTurn[] {
  const turns: ConversationTurn[] = [];
  for (const ancestor of taskLineage(db, taskId)) {
    const inherited = taskTurns(db, ancestor);
    if (inherited.length === 0) continue;
    const firstSeq = inherited[0]?.seq ?? 0;
    turns.push({ kind: "runtime", seq: firstSeq - 0.5, text: `[Início do contexto herdado da tarefa anterior "${objectiveOf(db, ancestor).slice(0, 200)}". É uma conversa anterior desta sessão de trabalho: as permissões e o critério de conclusão atuais vêm somente do contrato desta nova tarefa.]`, taskId: ancestor });
    for (const turn of inherited) {
      if (turn.kind === "assistant") turns.push({ ...turn, toolCalls: turn.toolCalls.map((call) => ({ ...call, id: stableId(`${ancestor}:${call.id}`) })) });
      else if (turn.kind === "tool") turns.push({ ...turn, toolCallId: stableId(`${ancestor}:${turn.toolCallId}`) });
      else turns.push(turn);
    }
  }
  const own = taskTurns(db, taskId);
  if (turns.length > 0) turns.push({ kind: "runtime", seq: (own[0]?.seq ?? 0) - 0.5, text: "[Fim do contexto herdado. A partir daqui começa a nova tarefa.]", taskId });
  return [...turns, ...own];
}

// Calls of this task's latest assistant turn that have no recorded result,
// and whether the human wrote after that turn.
export function unansweredCalls(db: DatabaseSync, taskId: string): { calls: ModelToolCall[]; afterUserMessage: boolean } {
  const turns = taskTurns(db, taskId);
  let lastAssistant = -1;
  for (let index = turns.length - 1; index >= 0; index -= 1) {
    if (turns[index]?.kind === "assistant") { lastAssistant = index; break; }
  }
  const turn = turns[lastAssistant];
  if (turn?.kind !== "assistant") return { calls: [], afterUserMessage: false };
  const answered = new Set(turns.slice(lastAssistant + 1).flatMap((item) => item.kind === "tool" ? [item.toolCallId] : []));
  return {
    calls: turn.toolCalls.filter((call) => !answered.has(call.id)),
    afterUserMessage: turns.slice(lastAssistant + 1).some((item) => item.kind === "user"),
  };
}
