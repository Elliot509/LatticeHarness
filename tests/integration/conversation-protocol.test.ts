import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";

// B1: the request the provider receives is a real conversation. Every
// assertion below reads the HTTP body the OpenAI-compatible adapter sent.

interface WireMessage {
  role: string;
  content: string | null;
  tool_call_id?: string;
  tool_calls?: Array<{ id: string; type: string; function: { name: string; arguments: string } }>;
}
interface WireBody { model: string; messages: WireMessage[] }
type Reply = { text?: string; calls?: Array<{ id?: string; name: string; args: unknown }> };

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function wireModel(reply: (body: WireBody, turn: number) => Reply): Promise<{ url: string; bodies: WireBody[] }> {
  const bodies: WireBody[] = [];
  const server = http.createServer((request, response) => {
    let raw = "";
    request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    request.on("end", () => {
      const body = JSON.parse(raw) as WireBody;
      bodies.push(body);
      const next = reply(body, bodies.length);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify({
        id: `wire-${bodies.length}`,
        model: body.model,
        choices: [{ message: { content: next.text ?? "", tool_calls: (next.calls ?? []).map((call) => ({ ...(call.id === undefined ? {} : { id: call.id }), type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }],
        usage: { prompt_tokens: Math.ceil(raw.length / 4), completion_tokens: 10, total_tokens: Math.ceil(raw.length / 4) + 10 },
      }));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { resolve((server.address() as { port: number }).port); }));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  return { url: `http://127.0.0.1:${port}/v1`, bodies };
}

function workspace(files: Record<string, string>): { root: string; data: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-conversation-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  return { root, data: path.join(dir, "data") };
}

function open(data: string, root: string): { db: LatticeDb; tasks: TaskManager; close: () => Promise<void> } {
  const db = openLatticeDb(data);
  claimOwnership(db.raw);
  const tasks = new TaskManager(db.raw, root);
  let closed = false;
  const close = async (): Promise<void> => { if (!closed) { closed = true; await tasks.close(); db.close(); } };
  cleanups.push(close);
  return { db, tasks, close };
}

async function settle(tasks: TaskManager, taskId: string): Promise<string> {
  const deadline = Date.now() + 15_000;
  for (;;) {
    const state = tasks.snapshot(taskId).state;
    if (!["RUNNING", "READY"].includes(state)) return state;
    if (Date.now() > deadline) throw new Error(`task stayed ${state}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function create(tasks: TaskManager, url: string, objective: string): string {
  const created = tasks.handleCommand({ commandId: `create-${objective}`, kind: "create-task", payload: { workspace: "", objective, provider: "local", model: "wire-model", baseUrl: url } });
  if (!created.accepted) throw new Error("create refused");
  return created.taskId;
}

// Every tool message answers exactly one earlier assistant tool call.
function expectCorrelated(body: WireBody): void {
  const open = new Set<string>();
  const answered = new Set<string>();
  for (const message of body.messages) {
    if (message.role === "assistant") {
      expect(open.size, "previous calls answered before the next assistant turn").toBe(0);
      for (const call of message.tool_calls ?? []) open.add(call.id);
    } else if (message.role === "tool") {
      expect(open.has(message.tool_call_id ?? ""), `tool result ${message.tool_call_id} answers an open call`).toBe(true);
      open.delete(message.tool_call_id ?? "");
      answered.add(message.tool_call_id ?? "");
    } else {
      expect(open.size, `${message.role} turn after unanswered calls`).toBe(0);
    }
  }
  expect(open.size).toBe(0);
}

const versionIn = (body: WireBody): string | undefined => /version (sha256:[0-9a-f]{16})/u.exec(body.messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n"))?.[1];

describe("structured conversation over the real HTTP payload", () => {
  it("carries assistant tool calls and their correlated results across a read → edit sequence", async () => {
    const { root, data } = workspace({ "note.txt": "ola mundo\n", "other.txt": "x\n" });
    const model = await wireModel((body, turn) => {
      if (turn === 1) return { text: "Vou ler os arquivos.", calls: [{ id: "call_read", name: "read", args: { path: "note.txt" } }, { id: "call_search", name: "search", args: { kind: "text", query: "ola" } }] };
      if (turn === 2) return { calls: [{ id: "call_edit", name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: versionIn(body), oldText: "ola", newText: "olá" } }] };
      return { text: "Pronto: corrigi a saudação." };
    });
    const { tasks } = open(data, root);
    const taskId = create(tasks, model.url, "Corrija a saudação em note.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    await settle(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("olá mundo\n");
    expect(model.bodies).toHaveLength(3);
    const [first, second, third] = model.bodies as [WireBody, WireBody, WireBody];
    expect(first.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(first.messages[0]?.content).toContain("Objetivo: Corrija a saudação em note.txt");
    expect(second.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool"]);
    expect(second.messages[2]).toMatchObject({ content: "Vou ler os arquivos.", tool_calls: [{ id: "call_read", function: { name: "read" } }, { id: "call_search", function: { name: "search" } }] });
    expect(second.messages[3]).toMatchObject({ tool_call_id: "call_read" });
    expect(second.messages[3]?.content).toContain("note.txt lines 1-2 of 2");
    expect(second.messages[4]).toMatchObject({ tool_call_id: "call_search" });
    expect(third.messages.map((message) => message.role)).toEqual(["system", "user", "assistant", "tool", "tool", "assistant", "tool"]);
    // An assistant turn with only tool calls sends null content (spec form).
    expect(third.messages[5]).toMatchObject({ content: null, tool_calls: [{ id: "call_edit" }] });
    expect(third.messages[6]?.content).toContain("replaced one literal occurrence in note.txt");
    for (const body of model.bodies) expectCorrelated(body);
  });

  it("returns an argument error as the call's result and lets the model correct it", async () => {
    const { root, data } = workspace({ "a.txt": "conteúdo real\n" });
    const model = await wireModel((_body, turn) => turn === 1
      ? { calls: [{ id: "bad", name: "read", args: { path: 42 } }] }
      : turn === 2 ? { calls: [{ id: "good", name: "read", args: { path: "a.txt" } }] } : { text: "O arquivo contém um texto curto." });
    const { tasks } = open(data, root);
    const taskId = create(tasks, model.url, "Explique o arquivo a.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    expect(await settle(tasks, taskId)).toBe("COMPLETED");
    const [, second, third] = model.bodies as [WireBody, WireBody, WireBody];
    expect(second.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "bad" });
    expect(second.messages.at(-1)?.content).toMatch(/invalid|path/iu);
    expect(third.messages.at(-1)).toMatchObject({ role: "tool", tool_call_id: "good" });
    expect(third.messages.at(-1)?.content).toContain("conteúdo real");
  });

  it("continues after a question with the earlier exchange, without re-reading, even across a restart", async () => {
    const { root, data } = workspace({ "notes.md": "Lista de compras\n" });
    let phase = 1;
    const model = await wireModel((body, turn) => {
      if (phase === 1) return turn === 1 ? { calls: [{ id: "r1", name: "read", args: { path: "notes.md" } }] } : { text: "Li notes.md. Qual item devo destacar?" };
      return { text: `Destacado: ${body.messages.at(-1)?.content ?? ""}` };
    });
    const first = open(data, root);
    // Not an analysis request: a final text cannot certify it, so the
    // question leaves the task waiting for the human (NEEDS_INPUT).
    const taskId = create(first.tasks, model.url, "Destaque um item em notes.md conforme eu indicar");
    first.tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    await settle(first.tasks, taskId);
    expect(model.bodies).toHaveLength(2);
    // Simulate closing the app: a new owner reopens the same database.
    expect(first.tasks.snapshot(taskId).state).toBe("NEEDS_INPUT");
    await first.close();
    phase = 2;
    const second = open(data, root);
    const capability = second.tasks.snapshot(taskId).capabilities?.send;
    expect(capability).toMatchObject({ allowed: true });
    const sent = second.tasks.handleCommand({ commandId: "reply", kind: "send-message", taskId, payload: { text: "o leite" } });
    expect(sent).toMatchObject({ accepted: true });
    await settle(second.tasks, taskId);
    expect(model.bodies).toHaveLength(3);
    const third = model.bodies[2] as WireBody;
    const roles = third.messages.map((message) => message.role);
    expect(roles.slice(0, 5)).toEqual(["system", "user", "assistant", "tool", "assistant"]);
    expect(third.messages[3]?.content).toContain("Lista de compras");
    expect(third.messages[4]?.content).toContain("Qual item devo destacar?");
    expect(third.messages.at(-1)?.role).toBe("user");
    expect(third.messages.at(-1)?.content).toContain("o leite");
    // No new read was needed: the observation travelled from the ledger.
    const reads = second.db.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = 'read'").get(taskId) as { n: number };
    expect(reads.n).toBe(1);
    expectCorrelated(third);
  });

  it("makes absent or repeated provider call ids unique and keeps them correlated", async () => {
    const { root, data } = workspace({ "a.txt": "a\n", "b.txt": "b\n" });
    const model = await wireModel((_body, turn) => turn === 1
      ? { calls: [{ name: "read", args: { path: "a.txt" } }, { name: "read", args: { path: "b.txt" } }] }
      : turn === 2 ? { calls: [{ id: "dup", name: "read", args: { path: "a.txt", startLine: 1 } }] }
        : turn === 3 ? { calls: [{ id: "dup", name: "read", args: { path: "b.txt", startLine: 1 } }] } : { text: "Os dois arquivos têm uma letra." });
    const { tasks } = open(data, root);
    const taskId = create(tasks, model.url, "Explique a.txt e b.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    await settle(tasks, taskId);
    const last = model.bodies.at(-1) as WireBody;
    const ids = last.messages.flatMap((message) => (message.tool_calls ?? []).map((call) => call.id));
    expect(ids).toHaveLength(4);
    expect(new Set(ids).size).toBe(4);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]+$/u);
    expect(ids).toContain("dup");
    expectCorrelated(last);
  });

  it("keeps the exchange when the human switches model mid-task", async () => {
    const { root, data } = workspace({ "a.txt": "conteúdo\n" });
    const firstModel = await wireModel(() => ({ text: "Preciso saber: devo resumir ou traduzir?" }));
    const secondModel = await wireModel(() => ({ text: "Resumo: um arquivo curto." }));
    const { tasks } = open(data, root);
    const taskId = create(tasks, firstModel.url, "Transforme a.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    await settle(tasks, taskId);
    expect(tasks.handleCommand({ commandId: "switch", kind: "select-model", taskId, payload: { provider: "local", model: "second-model", baseUrl: secondModel.url } })).toMatchObject({ accepted: true });
    tasks.handleCommand({ commandId: "reply", kind: "send-message", taskId, payload: { text: "resumir" } });
    await settle(tasks, taskId);
    expect(secondModel.bodies).toHaveLength(1);
    const body = secondModel.bodies[0] as WireBody;
    expect(body.model).toBe("second-model");
    expect(body.messages.some((message) => message.role === "assistant" && (message.content ?? "").includes("devo resumir ou traduzir"))).toBe(true);
    expect(body.messages.at(-1)?.content).toContain("resumir");
  });

  it("binds and reserves for the request actually sent as history grows", async () => {
    const { root, data } = workspace({ "a.txt": "a\n".repeat(200) });
    const model = await wireModel((_body, turn) => turn <= 3 ? { calls: [{ id: `r${turn}`, name: "read", args: { path: "a.txt", startLine: turn } }] } : { text: "O arquivo repete a letra a." });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url, "Explique a.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId });
    await settle(tasks, taskId);
    const bindings = db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'request-binding' ORDER BY seq").all(taskId) as Array<{ payload: string }>;
    const digests = bindings.map((row) => (JSON.parse(row.payload) as { payloadDigest: string }).payloadDigest);
    expect(digests).toHaveLength(model.bodies.length);
    expect(new Set(digests).size).toBe(digests.length);
    // The admission estimate follows the growing request instead of the
    // first one: each ticket reserved at least the messages actually sent.
    const tickets = db.raw.prepare(`SELECT a.ticket FROM attempts a JOIN intents i ON i.intent_id = a.intent_id WHERE i.task_id = ? AND i.operation = 'model.invoke' ORDER BY a.created_at`).all(taskId) as Array<{ ticket: string }>;
    const reserved = tickets.map((row) => (JSON.parse(row.ticket) as { reservedTokens: number }).reservedTokens);
    expect(reserved).toHaveLength(model.bodies.length);
    for (const [index, body] of model.bodies.entries()) {
      const sentChars = body.messages.reduce((sum, message) => sum + (message.content ?? "").length + JSON.stringify(message.tool_calls ?? []).length, 0);
      expect(reserved[index] ?? 0).toBeGreaterThanOrEqual(Math.floor(sentChars * 0.9));
    }
    expect(reserved.at(-1) ?? 0).toBeGreaterThan(reserved[0] ?? 0);
  });
});

describe("work sessions: a follow-up continues the conversation, not the authority", () => {
  it("sends the completed task's exchange as labeled context and keeps both contracts separate", async () => {
    const { root, data } = workspace({ "a.txt": "valor = 1 + '1'\n" });
    const model = await wireModel((_body, turn) => turn === 1
      ? { calls: [{ id: "ra", name: "read", args: { path: "a.txt" } }] }
      : turn === 2 ? { text: "O arquivo soma um número com uma string." } : { text: "Use 1 + 1 ou converta a string com Number()." });
    const { db, tasks } = open(data, root);
    const first = create(tasks, model.url, "Explique o problema em a.txt");
    tasks.handleCommand({ commandId: "start", kind: "start-task", taskId: first });
    expect(await settle(tasks, first)).toBe("COMPLETED");
    const before = db.raw.prepare("SELECT revision, document FROM contracts WHERE task_id = ?").get(first) as { revision: number; document: string };
    expect(tasks.snapshot(first).capabilities?.send).toMatchObject({ allowed: true, mode: "follow-up" });

    const sent = tasks.handleCommand({ commandId: "follow", kind: "send-message", taskId: first, payload: { text: "E como corrijo isso?" } });
    expect(sent.accepted).toBe(true);
    const second = sent.accepted ? sent.taskId : "";
    expect(second).not.toBe(first);
    await settle(tasks, second);
    const body = model.bodies[2] as WireBody;
    const text = body.messages.map((message) => message.content ?? "").join("\n");
    expect(text).toContain("contexto herdado da tarefa anterior");
    expect(text).toContain("O arquivo soma um número com uma string.");
    expect(text).toContain("valor = 1 + '1'");
    expect(body.messages.at(-1)?.content).toContain("E como corrijo isso?");
    expect(body.messages[0]?.content).toContain("Objetivo: E como corrijo isso?");
    expectCorrelated(body);

    // The closed contract is untouched; the follow-up has its own.
    const after = db.raw.prepare("SELECT revision, document FROM contracts WHERE task_id = ?").get(first) as { revision: number; document: string };
    expect(after).toEqual(before);
    expect(tasks.snapshot(first).state).toBe("COMPLETED");
    const snapshot = tasks.snapshot(second);
    expect(snapshot.previous).toMatchObject({ taskId: first, objective: "Explique o problema em a.txt", state: "COMPLETED" });
    expect(snapshot.rootId).not.toBe(tasks.snapshot(first).rootId);
    expect(tasks.listSessions().find((session) => session.taskId === second)?.parentTaskId).toBe(first);
    // Authority is the follow-up's own default grant, not a copy of history.
    const contract = JSON.parse((db.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(second) as { document: string }).document) as { origin: string; grants: Array<{ targets: string[] }> };
    expect(contract.origin).toBe("ui create-task");
    expect(contract.grants[0]?.targets).toEqual([root]);
  });
});
