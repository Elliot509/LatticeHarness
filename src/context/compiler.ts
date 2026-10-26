import type { ModelMessage } from "../providers/types.js";
import type { ConversationTurn } from "../runtime/conversation.js";

export const KERNEL = `Trabalhe pelo resultado solicitado dentro do escopo e da autoridade atuais. Use evidências observadas e diferencie fatos, hipóteses e resultados pendentes. Preserve trabalho existente e cumpra as precondições das ferramentas. Continue com ações úteis autorizadas; descubra o que pode antes de perguntar. Pergunte quando uma decisão material ou informação indispensável bloquear o avanço. Use falhas para orientar a próxima ação, considerando mudanças desde a tentativa anterior. Verifique o comportamento pertinente e relate limites com precisão. Termine quando o escopo estiver verificado, quando o usuário interromper ou quando não houver avanço autorizado possível.`;

// surface-2: anchors travel in the system message and the exchange travels
// as structured turns (assistant tool calls + correlated tool results).
export const SURFACE_VERSION = "surface-2";

export interface TaskSurface {
  objective: string;
  acceptanceCriteria: readonly string[];
  grants: readonly string[];
  prohibitions: readonly string[];
  obligations: readonly string[];
  unknowns: readonly string[];
  humanDecisions: readonly string[];
  versions: readonly string[];
  lastError: string | null;
}

export interface ConversationSurface {
  surfaceVersion: string;
  system: string;
  messages: ModelMessage[];
  anchorCount: number;
  turnsIncluded: number;
  turnsOmitted: number;
  // Characters the request carries (system + messages), the basis for the
  // scheduling estimate of the model reservation.
  chars: number;
}

export interface CompilerLimits {
  maxChars: number;
}

// Conservative, demonstrable size estimate: callers treat the value as an
// upper bound for admission, never as a token count.
export function estimateChars(text: string): number {
  return text.length;
}

function renderAnchors(surface: TaskSurface): string {
  const lines = [
    `Objetivo: ${surface.objective}`,
    `Pronto quando: ${surface.acceptanceCriteria.join(" | ")}`,
    `Autorizado: ${surface.grants.join(" | ")}`,
    `Proibido: ${surface.prohibitions.join(" | ")}`,
    `Obrigações pendentes: ${surface.obligations.length > 0 ? surface.obligations.join(" | ") : "nenhuma"}`,
    `Efeitos incertos: ${surface.unknowns.length > 0 ? surface.unknowns.join(" | ") : "nenhum"}`,
    `Decisões humanas: ${surface.humanDecisions.length > 0 ? surface.humanDecisions.join(" | ") : "nenhuma"}`,
    `Versões: ${surface.versions.length > 0 ? surface.versions.join(" | ") : "nenhuma registrada"}`,
  ];
  if (surface.lastError !== null) lines.push(`Último erro discriminante: ${surface.lastError}`);
  return lines.join("\n");
}

export class ContextOverflowError extends Error {
  readonly anchors: number;
  readonly limit: number;
  constructor(anchors: number, limit: number) {
    super(
      `Task anchors (${anchors} chars) exceed the context limit (${limit} chars); refusing to call the model with obligations omitted`,
    );
    this.name = "ContextOverflowError";
    this.anchors = anchors;
    this.limit = limit;
  }
}

const UNANSWERED = "[Sem resultado registrado: a execução parou antes desta chamada produzir resultado. O efeito pode ou não ter ocorrido; confira o estado (Efeitos incertos) antes de repetir.]";

type Group = { messages: ModelMessage[]; turns: number };

function messageChars(message: ModelMessage): number {
  return message.content.length + (message.toolCalls?.reduce((sum, call) => sum + call.name.length + call.argumentsJson.length + call.id.length + 16, 0) ?? 0) + 16;
}

function groupChars(group: Group): number {
  return group.messages.reduce((sum, message) => sum + messageChars(message), 0);
}

// Turns → protocol messages, grouped so selection never separates a tool call
// from its result. Each assistant tool call gets exactly one tool message:
// its recorded result, or an explicit "no result recorded" when the run
// stopped first. Results without a matching call are dropped.
function toGroups(turns: readonly ConversationTurn[]): Group[] {
  const groups: Group[] = [];
  const results = new Map<string, ConversationTurn & { kind: "tool" }>();
  for (const turn of turns) if (turn.kind === "tool" && !results.has(turn.toolCallId)) results.set(turn.toolCallId, turn);
  for (const turn of turns) {
    if (turn.kind === "user") groups.push({ messages: [{ role: "user", content: turn.text }], turns: 1 });
    else if (turn.kind === "runtime") groups.push({ messages: [{ role: "user", content: `[Observação do Lattice] ${turn.text}` }], turns: 1 });
    else if (turn.kind === "assistant") {
      if (turn.text.trim() === "" && turn.toolCalls.length === 0) continue;
      const messages: ModelMessage[] = [{ role: "assistant", content: turn.text, ...(turn.toolCalls.length > 0 ? { toolCalls: turn.toolCalls.map((call) => ({ ...call })) } : {}) }];
      for (const call of turn.toolCalls) {
        const result = results.get(call.id);
        messages.push({ role: "tool", toolCallId: call.id, toolName: call.name, content: result?.content ?? UNANSWERED });
      }
      groups.push({ messages, turns: 1 + turn.toolCalls.length });
    }
  }
  return groups;
}

// Adjacent user-role messages merge: some chat templates require strict
// user/assistant alternation, and merging loses nothing.
function mergeUsers(messages: ModelMessage[]): ModelMessage[] {
  const merged: ModelMessage[] = [];
  for (const message of messages) {
    const last = merged.at(-1);
    if (last?.role === "user" && message.role === "user") merged[merged.length - 1] = { role: "user", content: `${last.content}\n\n${message.content}` };
    else merged.push(message);
  }
  return merged;
}

// Shrinks tool contents of the newest group when it alone exceeds the room
// left: that group is mandatory (it answers the latest calls).
function shrinkGroup(group: Group, room: number): Group {
  const tools = group.messages.filter((message) => message.role === "tool").length;
  if (tools === 0) return group;
  const fixed = group.messages.filter((message) => message.role !== "tool").reduce((sum, message) => sum + messageChars(message), 0);
  const each = Math.max(200, Math.floor((room - fixed) / tools) - 120);
  return {
    turns: group.turns,
    messages: group.messages.map((message) => message.role === "tool" && message.content.length > each
      ? { ...message, content: `${message.content.slice(0, each)}\n[resultado reduzido para caber no contexto; o registro completo está preservado]` }
      : message),
  };
}

// Builds the request surface: kernel + always-present anchors in the system
// message, then the newest turns that fit. The first user turn (the request
// that opened the exchange) is always kept; older middle turns are omitted
// as whole groups, and the system message says how many.
export function compileConversation(task: TaskSurface, turns: readonly ConversationTurn[], limits: CompilerLimits): ConversationSurface {
  const anchors = renderAnchors(task);
  const base = `${KERNEL}\n\n${anchors}`;
  if (estimateChars(base) > limits.maxChars) throw new ContextOverflowError(estimateChars(base), limits.maxChars);
  const groups = toGroups(turns);
  const firstUser = groups.findIndex((group) => group.messages[0]?.role === "user");
  const head = firstUser === -1 ? null : groups[firstUser] ?? null;
  const rest = groups.filter((_, index) => index !== firstUser);
  const omissionNote = (count: number): string => `\n\nHistórico: ${count} turno(s) anteriores omitidos por limite de contexto; o registro durável da tarefa está preservado.`;
  const reserve = omissionNote(9999).length;
  let room = limits.maxChars - base.length - reserve - (head === null ? 0 : groupChars(head));
  const selected: Group[] = [];
  for (let index = rest.length - 1; index >= 0; index -= 1) {
    const group = rest[index];
    if (group === undefined) continue;
    const cost = groupChars(group);
    if (cost <= room) { selected.unshift(group); room -= cost; continue; }
    if (selected.length === 0 && index === rest.length - 1) {
      const shrunk = shrinkGroup(group, room);
      if (groupChars(shrunk) <= room) { selected.unshift(shrunk); room -= groupChars(shrunk); continue; }
    }
    break;
  }
  const omittedGroups = rest.length - selected.length;
  const omittedTurns = rest.slice(0, omittedGroups).reduce((sum, group) => sum + group.turns, 0);
  const system = omittedGroups > 0 ? `${base}${omissionNote(omittedTurns)}` : base;
  const messages = mergeUsers([...(head?.messages ?? []), ...selected.flatMap((group) => group.messages)]);
  const included = (head?.turns ?? 0) + selected.reduce((sum, group) => sum + group.turns, 0);
  const chars = system.length + messages.reduce((sum, message) => sum + messageChars(message), 0);
  if (chars > limits.maxChars) throw new ContextOverflowError(chars, limits.maxChars);
  return {
    surfaceVersion: SURFACE_VERSION,
    system,
    messages,
    anchorCount: 8 + (task.lastError !== null ? 1 : 0),
    turnsIncluded: included,
    turnsOmitted: omittedTurns,
    chars,
  };
}
