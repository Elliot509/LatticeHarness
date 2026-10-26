import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { approvalKey, describeAction, requiresApproval } from "../../src/runtime/approval.js";
import { reviseContract, type TaskContract } from "../../src/runtime/contract.js";
import { humanizeReason, toolActionText } from "../../src/ui/presentation.js";

// D3 / PG-040: confirmation for mutating actions is enforced by the runtime.
// Every test drives the real TaskManager over the protocol (no UI) against an
// OpenAI-compatible wire model, and reads the effects from the workspace and
// the ledger (intents, receipts, approval events), never from the UI.

interface WireMessage { role: string; content: string | null; tool_call_id?: string }
interface WireBody { messages: WireMessage[] }
type Reply = { text?: string; calls?: Array<{ id: string; name: string; args: unknown }> };

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
        model: "wire-model",
        choices: [{ message: { content: next.text ?? "", tool_calls: (next.calls ?? []).map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) } }],
        usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 },
      }));
    });
  });
  const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { resolve((server.address() as { port: number }).port); }));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
  return { url: `http://127.0.0.1:${port}/v1`, bodies };
}

function workspace(files: Record<string, string> = {}): { root: string; data: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-approval-"));
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

// With no automatic verifier (acceptance "unverified", C3) a finished run
// waits for the human to accept the result; that is the end of the run here.
async function finished(tasks: TaskManager, taskId: string): Promise<void> {
  const state = await settle(tasks, taskId);
  const reason = tasks.snapshot(taskId).stateReason ?? "";
  expect(`${state}: ${reason}`).toMatch(/^NEEDS_INPUT: .*awaits human review/u);
}
async function paused(tasks: TaskManager, taskId: string): Promise<void> {
  const state = await settle(tasks, taskId);
  const reason = tasks.snapshot(taskId).stateReason ?? "";
  expect(`${state}: ${reason}`).toMatch(/^NEEDS_INPUT: approval required/u);
}

let commands = 0;
const cid = (label: string): string => `${label}-${(commands += 1)}`;

function create(tasks: TaskManager, url: string, approval: "confirm-mutations" | "none" | "omit" = "confirm-mutations"): string {
  const created = tasks.handleCommand({ commandId: cid("create"), kind: "create-task", payload: { workspace: "", objective: "Ajuste o projeto", provider: "local", model: "wire-model", baseUrl: url, ...(approval === "omit" ? {} : { approval }) } });
  if (!created.accepted) throw new Error(`create refused: ${created.detail ?? ""}`);
  return created.taskId;
}

async function start(tasks: TaskManager, taskId: string): Promise<string> {
  expect(tasks.handleCommand({ commandId: cid("start"), kind: "start-task", taskId }).accepted).toBe(true);
  return settle(tasks, taskId);
}

function decide(tasks: TaskManager, taskId: string, key: string, decision: "approved" | "denied", note?: string): ReturnType<TaskManager["handleCommand"]> {
  return tasks.handleCommand({ commandId: cid("decide"), kind: "decide-approval", taskId, payload: { key, decision, ...(note === undefined ? {} : { note }) } });
}

// Tool intents the runtime admitted for this task (an intent precedes any
// dispatch), and the receipts recorded for them.
function intents(db: LatticeDb, taskId: string, operation: string): number {
  return (db.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND operation = ?").get(taskId, operation) as { n: number }).n;
}
function receipts(db: LatticeDb, taskId: string, operation: string): Array<{ outcome: string; detail: string }> {
  return db.raw.prepare("SELECT r.outcome, r.detail FROM receipts r JOIN attempts a ON a.attempt_id = r.attempt_id JOIN intents i ON i.intent_id = a.intent_id WHERE i.task_id = ? AND i.operation = ? ORDER BY r.recorded_at").all(taskId, operation) as Array<{ outcome: string; detail: string }>;
}
function approvalEvents(db: LatticeDb, taskId: string): Array<{ kind: string; payload: Record<string, unknown> }> {
  return (db.raw.prepare("SELECT kind, payload FROM events WHERE task_id = ? AND kind LIKE 'approval.%' ORDER BY seq").all(taskId) as Array<{ kind: string; payload: string }>)
    .map((row) => ({ kind: row.kind, payload: JSON.parse(row.payload) as Record<string, unknown> }));
}
const toolText = (body: WireBody | undefined, id: string): string => body?.messages.find((message) => message.role === "tool" && message.tool_call_id === id)?.content ?? "";
const versionIn = (body: WireBody): string => /version (sha256:[0-9a-f]{16})/u.exec(body.messages.filter((message) => message.role === "tool").map((message) => message.content).join("\n"))?.[1] ?? "missing";

const shell = (command: string): { mode: "shell"; shell: "sh"; command: string } => ({ mode: "shell", shell: "sh", command });

describe("confirm-mutations: edit", () => {
  it("pauses before an edit with no effect, then an approval runs it exactly once with an auditable chain", async () => {
    const { root, data } = workspace({ "note.txt": "ola mundo\n" });
    const model = await wireModel((body, turn) => {
      if (turn === 1) return { calls: [{ id: "r1", name: "read", args: { path: "note.txt" } }] };
      if (turn === 2) return { calls: [{ id: "e1", name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: versionIn(body), oldText: "ola", newText: "olá" } }] };
      return { text: "Pronto." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    expect(tasks.snapshot(taskId).approvalPolicy).toBe("confirm-mutations");

    // Reads are not gated; the edit is. Nothing was admitted for it.
    await start(tasks, taskId); await paused(tasks, taskId);
    const pending = tasks.snapshot(taskId).approvals ?? [];
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ tool: "edit", description: "alterar o arquivo note.txt" });
    expect(JSON.parse(pending[0]?.argsJson ?? "{}")).toMatchObject({ oldText: "ola", newText: "olá" });
    expect(intents(db, taskId, "read")).toBe(1);
    expect(intents(db, taskId, "edit")).toBe(0);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("ola mundo\n");
    expect(tasks.snapshot(taskId).stateReason).toContain("approval required");
    // PG-015/PG-022 on real runtime text: product language, raw kept aside.
    const asked = humanizeReason("NEEDS_INPUT", tasks.snapshot(taskId).stateReason);
    expect(asked.text).toBe("O agente pede sua confirmação para alterar o arquivo note.txt. Aprove, negue, ou responda com uma mensagem.");
    expect(asked.technical).toContain("approval required");
    expect(toolActionText(tasks.snapshot(taskId).tools.find((tool) => tool.tool === "read") ?? ({} as never))).toBe("Leu note.txt · linhas 1–2 de 2");

    const approved = decide(tasks, taskId, pending[0]?.key ?? "", "approved");
    expect(approved).toMatchObject({ accepted: true });
    await finished(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("olá mundo\n");
    expect(intents(db, taskId, "edit")).toBe(1);
    expect(receipts(db, taskId, "edit").map((receipt) => receipt.outcome)).toEqual(["confirmed"]);
    expect(toolActionText(tasks.snapshot(taskId).tools.find((tool) => tool.tool === "edit") ?? ({} as never))).toBe("Editou note.txt · 1 trecho substituído");
    expect(humanizeReason("NEEDS_INPUT", tasks.snapshot(taskId).stateReason).text).toMatch(/^O agente terminou, mas /u);
    // The paused call itself ran (no extra model call to re-ask for it) and
    // its result answers the same tool_call_id.
    expect(model.bodies).toHaveLength(3);
    expect(toolText(model.bodies[2], "e1")).not.toContain("negada");

    // Audit: request (with the tool call and revision) → human decision →
    // consumption. The decision is not the receipt: the receipt above is.
    const events = approvalEvents(db, taskId);
    expect(events.map((event) => event.kind)).toEqual(["approval.requested", "approval.decided", "approval.used"]);
    expect(events[0]?.payload).toMatchObject({ tool: "edit", toolCallId: "e1", key: pending[0]?.key, revision: (db.raw.prepare("SELECT revision FROM contracts WHERE task_id = ?").get(taskId) as { revision: number }).revision });
    expect(events[1]?.payload).toMatchObject({ decision: "approved", actor: "human" });
    expect(tasks.snapshot(taskId).approvals).toEqual([]);
  });

  it("a denial blocks the edit, reaches the model as that call's result, and an identical retry needs a new decision", async () => {
    const { root, data } = workspace({ "note.txt": "ola\n" });
    const create_ = { kind: "create", path: "novo.txt", content: "x\n" };
    const model = await wireModel((_body, turn) => {
      if (turn === 1) return { calls: [{ id: "c1", name: "edit", args: create_ }] };
      if (turn === 2) return { calls: [{ id: "c2", name: "edit", args: create_ }] };
      return { text: "Entendido, não criei o arquivo." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    const key = tasks.snapshot(taskId).approvals?.[0]?.key ?? "";
    expect(decide(tasks, taskId, key, "denied", "não crie arquivos novos")).toMatchObject({ accepted: true });
    // The model retried the same action under another call id: paused again.
    await paused(tasks, taskId);
    expect(toolText(model.bodies[1], "c1")).toContain("negada pelo usuário");
    expect(toolText(model.bodies[1], "c1")).toContain("não crie arquivos novos");
    // The denial is visible as the human's decision, not as an executed action.
    expect(tasks.snapshot(taskId).approvalHistory).toMatchObject([{ decision: "denied", tool: "edit", description: "criar o arquivo novo.txt", note: "não crie arquivos novos" }]);
    expect(tasks.snapshot(taskId).tools.filter((tool) => tool.tool === "edit")).toEqual([]);
    const again = tasks.snapshot(taskId).approvals ?? [];
    expect(again).toHaveLength(1);
    expect(again[0]?.key).toBe(key);
    expect(fs.existsSync(path.join(root, "novo.txt"))).toBe(false);
    expect(intents(db, taskId, "edit")).toBe(0);
    // The old decision cannot be replayed; the new request is a new decision.
    expect(decide(tasks, taskId, key, "denied")).toMatchObject({ accepted: true });
    await finished(tasks, taskId);
    expect(fs.existsSync(path.join(root, "novo.txt"))).toBe(false);
    expect(intents(db, taskId, "edit")).toBe(0);
    expect(approvalEvents(db, taskId).filter((event) => event.kind === "approval.decided")).toHaveLength(2);
  });

  it("an approved edit whose version went stale is refused by the tool, not forced through", async () => {
    const { root, data } = workspace({ "note.txt": "ola\n" });
    const model = await wireModel((body, turn) => {
      if (turn === 1) return { calls: [{ id: "r1", name: "read", args: { path: "note.txt" } }] };
      if (turn === 2) return { calls: [{ id: "e1", name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: versionIn(body), oldText: "ola", newText: "olá" } }] };
      return { text: "O arquivo mudou; vou parar." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    // The file changes while the human is deciding.
    fs.writeFileSync(path.join(root, "note.txt"), "ola alterado por fora\n");
    decide(tasks, taskId, tasks.snapshot(taskId).approvals?.[0]?.key ?? "", "approved");
    await finished(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "note.txt"), "utf8")).toBe("ola alterado por fora\n");
    expect(receipts(db, taskId, "edit").map((receipt) => receipt.outcome)).toEqual(["failed"]);
    expect(toolActionText(tasks.snapshot(taskId).tools.find((tool) => tool.tool === "edit") ?? ({} as never))).toBe("Edição recusada: o arquivo mudou desde a leitura; o agente precisa ler de novo");
    expect(toolText(model.bodies[2], "e1")).toMatch(/refused: expected sha256:[0-9a-f]{16} but observed .*changed since it was read/u);
    // The approval was consumed by that one attempt.
    expect(approvalEvents(db, taskId).at(-1)?.kind).toBe("approval.used");
  });
});

describe("confirm-mutations: exec", () => {
  it("runs an approved command once; repeating it needs a new approval, and a denial blocks it", async () => {
    const { root, data } = workspace();
    const command = shell("echo ok >> marker.txt");
    const model = await wireModel((_body, turn) => {
      if (turn === 1) return { calls: [{ id: "x1", name: "exec", args: command }] };
      if (turn === 2) return { calls: [{ id: "x2", name: "exec", args: command }] };
      return { text: "Feito." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    expect(fs.existsSync(path.join(root, "marker.txt"))).toBe(false);
    const first = tasks.snapshot(taskId).approvals?.[0];
    expect(first).toMatchObject({ tool: "exec", description: "executar no shell sh: echo ok >> marker.txt" });
    decide(tasks, taskId, first?.key ?? "", "approved");
    // Same command, new call id: the consumed approval does not cover it.
    await paused(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("ok\n");
    expect(intents(db, taskId, "exec")).toBe(1);
    expect(tasks.snapshot(taskId).approvals?.[0]?.key).toBe(first?.key);
    expect(decide(tasks, taskId, first?.key ?? "", "denied")).toMatchObject({ accepted: true });
    await finished(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "marker.txt"), "utf8")).toBe("ok\n");
    expect(intents(db, taskId, "exec")).toBe(1);
    expect(toolText(model.bodies[2], "x2")).toContain("negada pelo usuário");
  });

  it("a command that fails after approval keeps its receipt, and a retry is a new decision", async () => {
    const { root, data } = workspace();
    const failing = shell("exit 3");
    const model = await wireModel((_body, turn) => {
      if (turn === 1) return { calls: [{ id: "x1", name: "exec", args: failing }] };
      if (turn === 2) return { calls: [{ id: "x2", name: "exec", args: failing }] };
      return { text: "Falhou." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    decide(tasks, taskId, tasks.snapshot(taskId).approvals?.[0]?.key ?? "", "approved");
    await paused(tasks, taskId);
    expect(receipts(db, taskId, "exec")).toHaveLength(1);
    expect(toolText(model.bodies[1], "x1")).toMatch(/3/u);
    expect(intents(db, taskId, "exec")).toBe(1);
  });

  it("a different command after an approval is a different action and pauses again", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => {
      if (turn === 1) return { calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] };
      if (turn === 2) return { calls: [{ id: "x2", name: "exec", args: shell("echo b > a.txt") }] };
      return { text: "Feito." };
    });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    const firstKey = tasks.snapshot(taskId).approvals?.[0]?.key ?? "";
    // A client cannot pre-approve an action that was never requested.
    const forged = approvalKey("exec", JSON.stringify(shell("echo b > a.txt")));
    expect(decide(tasks, taskId, forged, "approved")).toMatchObject({ accepted: false, reason: "invalid" });
    decide(tasks, taskId, firstKey, "approved");
    await paused(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    const second = tasks.snapshot(taskId).approvals?.[0];
    expect(second?.key).toBe(forged);
    expect(second?.key).not.toBe(firstKey);
    // The consumed approval cannot be replayed either.
    expect(decide(tasks, taskId, firstKey, "approved")).toMatchObject({ accepted: false, reason: "invalid" });
    expect(intents(db, taskId, "exec")).toBe(1);
  });
});

describe("confirm-mutations: no implicit authorization", () => {
  it("a decision for one task cannot release another task's action", async () => {
    const { root, data } = workspace();
    const model = await wireModel(() => ({ calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] }));
    const { db, tasks } = open(data, root);
    const a = create(tasks, model.url);
    const b = create(tasks, model.url);
    await start(tasks, a); await paused(tasks, a);
    const key = tasks.snapshot(a).approvals?.[0]?.key ?? "";
    expect(decide(tasks, b, key, "approved")).toMatchObject({ accepted: false, reason: "invalid" });
    expect(tasks.snapshot(a).approvals).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(intents(db, a, "exec") + intents(db, b, "exec")).toBe(0);
  });

  it("waiting, resuming or restarting without a decision never runs the action", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => turn === 1 ? { calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] } : { text: "Feito." });
    const first = open(data, root);
    const taskId = create(first.tasks, model.url);
    await start(first.tasks, taskId); await paused(first.tasks, taskId);
    // There is no live run to stop: the pause is the stop.
    expect(first.tasks.handleCommand({ commandId: cid("stop"), kind: "stop", taskId })).toMatchObject({ accepted: false });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Resume + start without a decision: re-paused on the same request with
    // no model call and no admission.
    expect(first.tasks.handleCommand({ commandId: cid("resume"), kind: "resume-task", taskId }).accepted).toBe(true);
    await start(first.tasks, taskId); await paused(first.tasks, taskId);
    expect(model.bodies).toHaveLength(1);
    expect(approvalEvents(first.db, taskId).map((event) => event.kind)).toEqual(["approval.requested"]);
    await first.close();

    // Backend restart: the request survives as pending, still unanswered.
    const second = open(data, root);
    expect(second.tasks.snapshot(taskId).state).toBe("NEEDS_INPUT");
    const pending = second.tasks.snapshot(taskId).approvals ?? [];
    expect(pending).toHaveLength(1);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(intents(second.db, taskId, "exec")).toBe(0);
    decide(second.tasks, taskId, pending[0]?.key ?? "", "approved");
    await finished(second.tasks, taskId);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(intents(second.db, taskId, "exec")).toBe(1);
  });

  it("a message instead of a decision withdraws the request and the action is never run", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => turn === 1 ? { calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] } : { text: "Certo, não vou executar." });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    const key = tasks.snapshot(taskId).approvals?.[0]?.key ?? "";
    expect(tasks.handleCommand({ commandId: cid("msg"), kind: "send-message", taskId, payload: { text: "Não rode comandos, só explique." } }).accepted).toBe(true);
    await finished(tasks, taskId);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(intents(db, taskId, "exec")).toBe(0);
    expect(toolText(model.bodies[1], "x1")).toContain("não executada");
    expect(approvalEvents(db, taskId).map((event) => event.kind)).toEqual(["approval.requested", "approval.withdrawn"]);
    expect(tasks.snapshot(taskId).approvalHistory).toMatchObject([{ decision: "withdrawn", note: "superseded by a user message" }]);
    // A late click on the withdrawn request is refused.
    expect(decide(tasks, taskId, key, "approved")).toMatchObject({ accepted: false, reason: "invalid" });
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });

  it("an approval given under one contract revision is withdrawn and asked again after a revision", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => turn === 1 ? { calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] } : { text: "Feito." });
    const first = open(data, root);
    const taskId = create(first.tasks, model.url);
    await start(first.tasks, taskId); await paused(first.tasks, taskId);
    const key = first.tasks.snapshot(taskId).approvals?.[0]?.key ?? "";
    await first.close();
    // Simulated revision while the request is pending (no current command
    // revises without a user message, which withdraws on its own): written
    // to the ledger with the backend down, then the backend comes back.
    const offline = openLatticeDb(data);
    const row = offline.raw.prepare("SELECT document FROM contracts WHERE task_id = ?").get(taskId) as { document: string };
    const revised = reviseContract(JSON.parse(row.document) as TaskContract, { origin: "test revision" });
    offline.raw.prepare("UPDATE contracts SET document = ?, revision = ? WHERE task_id = ?").run(JSON.stringify(revised), revised.revision, taskId);
    offline.close();
    const { db, tasks } = open(data, root);
    expect(decide(tasks, taskId, key, "approved")).toMatchObject({ accepted: true });
    await paused(tasks, taskId);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(intents(db, taskId, "exec")).toBe(0);
    const kinds = approvalEvents(db, taskId).map((event) => event.kind);
    expect(kinds).toEqual(["approval.requested", "approval.decided", "approval.withdrawn", "approval.requested"]);
    expect(approvalEvents(db, taskId).at(-1)?.payload["revision"]).toBe(revised.revision);
    // A decision under the current revision runs it.
    decide(tasks, taskId, key, "approved");
    await finished(tasks, taskId);
    expect(intents(db, taskId, "exec")).toBe(1);
  });
});

describe("confirm-mutations: closing the task", () => {
  it("accepting the result as it is withdraws the pending request; a late decision is refused and the follow-up conversation stays well-formed", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => turn === 1 ? { text: "Vou gravar.", calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] } : { text: "Resposta do seguimento." });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url);
    await start(tasks, taskId); await paused(tasks, taskId);
    const key = tasks.snapshot(taskId).approvals?.[0]?.key ?? "";
    expect(tasks.handleCommand({ commandId: cid("accept"), kind: "accept-result", taskId, payload: {} })).toMatchObject({ accepted: true });
    expect(tasks.snapshot(taskId).state).toBe("COMPLETED");
    expect(tasks.snapshot(taskId).approvals).toEqual([]);
    expect(tasks.snapshot(taskId).approvalHistory).toMatchObject([{ decision: "withdrawn" }]);
    expect(decide(tasks, taskId, key, "approved")).toMatchObject({ accepted: false });
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
    expect(intents(db, taskId, "exec")).toBe(0);
    // The ledger says the paused call was not run (not merely unanswered).
    const answer = db.raw.prepare("SELECT json_extract(payload, '$.content') AS content FROM events WHERE task_id = ? AND kind = 'conversation.tool' AND json_extract(payload, '$.toolCallId') = 'x1'").get(taskId) as { content: string } | undefined;
    expect(answer?.content).toContain("não executada: o usuário aceitou o resultado");
    // The follow-up carries the previous conversation: every assistant tool
    // call there must be answered, or the provider rejects the request.
    const follow = tasks.handleCommand({ commandId: cid("follow"), kind: "follow-up-task", taskId, payload: { objective: "E agora, o que falta?" } });
    if (!follow.accepted) throw new Error(`follow-up refused: ${JSON.stringify(follow)}`);
    if (!follow.accepted) return;
    // The follow-up keeps the confirmation policy (never broader).
    expect(tasks.snapshot(follow.taskId).approvalPolicy).toBe("confirm-mutations");
    await finished(tasks, follow.taskId);
    const last = model.bodies.at(-1);
    const calls = new Set<string>();
    for (const message of last?.messages ?? []) {
      for (const call of (message as { tool_calls?: Array<{ id: string }> }).tool_calls ?? []) calls.add(call.id);
      if (message.role === "tool") calls.delete(message.tool_call_id ?? "");
    }
    expect([...calls]).toEqual([]);
    expect(fs.existsSync(path.join(root, "a.txt"))).toBe(false);
  });
});

describe("local-trusted default is unchanged", () => {
  it("without the policy, mutations run without pausing and no approval is recorded", async () => {
    const { root, data } = workspace();
    const model = await wireModel((_body, turn) => turn === 1 ? { calls: [{ id: "x1", name: "exec", args: shell("echo a > a.txt") }] } : { text: "Feito." });
    const { db, tasks } = open(data, root);
    const taskId = create(tasks, model.url, "omit");
    expect(tasks.snapshot(taskId).approvalPolicy).toBe("none");
    await start(tasks, taskId); await finished(tasks, taskId);
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(approvalEvents(db, taskId)).toEqual([]);
    expect(tasks.snapshot(taskId).approvals).toEqual([]);
  });

  it("rejects an unknown policy value instead of silently disabling confirmation", async () => {
    const { root, data } = workspace();
    const { tasks } = open(data, root);
    const refused = tasks.handleCommand({ commandId: cid("create"), kind: "create-task", payload: { workspace: "", objective: "x", provider: "local", model: "m", baseUrl: "http://127.0.0.1:9/v1", approval: "confirm" } });
    expect(refused).toMatchObject({ accepted: false });
    expect(tasks.listSessions()).toHaveLength(0);
  });
});

describe("approval policy rules", () => {
  const contract = { approvalPolicy: "confirm-mutations" } as unknown as TaskContract;
  it("gates edit, exec and process control; observation stays free", () => {
    expect(requiresApproval(contract, "edit", "{}")).toBe(true);
    expect(requiresApproval(contract, "exec", "{}")).toBe(true);
    expect(requiresApproval(contract, "process", JSON.stringify({ op: "start", executable: "x", argv: [] }))).toBe(true);
    expect(requiresApproval(contract, "process", JSON.stringify({ op: "stop", handle: "h" }))).toBe(true);
    expect(requiresApproval(contract, "process", JSON.stringify({ op: "poll", handle: "h" }))).toBe(false);
    expect(requiresApproval(contract, "process", "not json")).toBe(true);
    expect(requiresApproval(contract, "read", "{}")).toBe(false);
    expect(requiresApproval(contract, "search", "{}")).toBe(false);
    expect(requiresApproval({} as TaskContract, "exec", "{}")).toBe(false);
  });
  it("keys the exact action: argument order does not matter, any value does", () => {
    expect(approvalKey("exec", '{"executable":"ls","argv":["-a"]}')).toBe(approvalKey("exec", '{"argv":["-a"],"executable":"ls"}'));
    expect(approvalKey("exec", '{"executable":"ls","argv":["-a"]}')).not.toBe(approvalKey("exec", '{"executable":"ls","argv":["-a"],"cwd":"sub"}'));
    expect(approvalKey("exec", '{"executable":"ls","argv":[]}')).not.toBe(approvalKey("edit", '{"executable":"ls","argv":[]}'));
  });
  it("names everything that changes what a command does", () => {
    expect(describeAction("exec", JSON.stringify({ executable: "npm", argv: ["test"], cwd: "pkg", env: { CI: "1" }, input: "y" }))).toBe("executar: npm test (em pkg) com as variáveis CI com entrada padrão");
    expect(describeAction("edit", JSON.stringify({ kind: "rename", path: "a", newPath: "b", expectedVersion: "sha256:0000000000000000" }))).toBe("renomear a para b");
  });
});
