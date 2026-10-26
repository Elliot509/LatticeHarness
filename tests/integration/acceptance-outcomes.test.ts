import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider, type FakeScriptStep } from "../../src/providers/fake.js";
import { readContract, recordTaskEvent } from "../../src/runtime/continuity.js";
import { acceptCommand } from "../../src/cli/continuity.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const usage = { inputTokens: 10, outputTokens: 5 };

function fixture(files: Record<string, string> = {}): { db: LatticeDb; tasks: TaskManager; root: string; data: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-accept-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, "project");
  fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const data = path.join(dir, "data");
  const db = openLatticeDb(data);
  claimOwnership(db.raw);
  const tasks = new TaskManager(db.raw, root);
  let closed = false;
  cleanups.push(async () => { if (!closed) { closed = true; await tasks.close(); db.close(); } });
  return { db, tasks, root, data };
}

async function run(tasks: TaskManager, objective: string, steps: FakeScriptStep[]): Promise<string> {
  const { taskId } = tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
  tasks.startTask(taskId, "start", new FakeProvider(steps));
  const deadline = Date.now() + 10_000;
  while (["RUNNING", "READY"].includes(tasks.snapshot(taskId).state)) {
    if (Date.now() > deadline) throw new Error("task did not settle");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return taskId;
}

const version = (text: string): string => `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16)}`;

describe("outcomes: verified, awaiting review, accepted by a human", () => {
  it("a fix without a verifier ends awaiting review, and acceptance closes it on a recorded human basis (PG-006)", async () => {
    const before = "export const discount = (total) => total > 100 ? total * 0.9 : total * 0.9;\n";
    const f = fixture({ "sum.js": before });
    const taskId = await run(f.tasks, "Corrija o bug do desconto em sum.js", [
      { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify({ kind: "replace", path: "sum.js", expectedVersion: version(before), oldText: ": total * 0.9;", newText: ": total;" }) }], usage },
      { text: "Corrigi: o desconto só vale acima de 100.", usage },
    ]);
    let snapshot = f.tasks.snapshot(taskId);
    expect(snapshot.acceptanceCriteria).toEqual(["unverified"]);
    expect(snapshot.state).toBe("NEEDS_INPUT");
    expect(snapshot.outcome).toMatchObject({ kind: "unverified", uncertainEffects: 0 });
    expect(snapshot.capabilities?.accept.allowed).toBe(true);
    const contractBefore = readContract(f.db.raw, taskId);

    const accepted = f.tasks.handleCommand({ commandId: "accept", kind: "accept-result", taskId, payload: { note: "revisei o diff" } });
    expect(accepted).toMatchObject({ accepted: true, state: "COMPLETED" });
    snapshot = f.tasks.snapshot(taskId);
    expect(snapshot.outcome).toMatchObject({ kind: "accepted", note: "revisei o diff" });
    expect(snapshot.stateReason).toContain("not an automatic verification");
    // The contract (criteria included) is untouched: acceptance is a decision record.
    expect(readContract(f.db.raw, taskId)).toEqual(contractBefore);
    const record = JSON.parse((f.db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task.accepted'").get(taskId) as { payload: string }).payload) as Record<string, unknown>;
    expect(record).toMatchObject({ actor: "human", note: "revisei o diff", criteria: ["unverified"], priorState: "NEEDS_INPUT", confirmedEdits: 1, unknowns: [] });
    const basis = JSON.parse((f.db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1").get(taskId) as { payload: string }).payload) as { basis?: string };
    expect(basis.basis).toBe("accepted-by-human");
    // A closed task cannot be accepted twice and continues only as follow-up.
    expect(f.tasks.handleCommand({ commandId: "accept-2", kind: "accept-result", taskId })).toMatchObject({ accepted: false });
    expect(f.tasks.snapshot(taskId).capabilities?.send.mode).toBe("follow-up");
    expect(f.tasks.listSessions().find((session) => session.taskId === taskId)?.outcome).toBe("accepted");
  });

  it("an automatic verification is a different outcome from acceptance", async () => {
    const f = fixture({ "README.md": "# Projeto\n" });
    const taskId = await run(f.tasks, "Explique o README.md", [{ toolCalls: [{ name: "read", argumentsJson: '{"path":"README.md"}' }], usage }, { text: "Um projeto sem descrição.", usage }]);
    const snapshot = f.tasks.snapshot(taskId);
    expect(snapshot).toMatchObject({ state: "COMPLETED", outcome: { kind: "verified" } });
    const basis = JSON.parse((f.db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1").get(taskId) as { payload: string }).payload) as { basis?: string };
    expect(basis.basis).toBe("verified");
  });

  it("acceptance never erases UNKNOWN effects", async () => {
    const f = fixture();
    const taskId = await run(f.tasks, "Organize o projeto", [{ text: "Nada a fazer.", usage }]);
    const contract = readContract(f.db.raw, taskId);
    if (contract === null) throw new Error("no contract");
    f.db.raw.prepare("INSERT INTO intents (intent_id, task_id, operation, target, action_key, authority_revision, state, created_at) VALUES ('i-u', ?, 'exec', 'x', 'k', 1, 'UNKNOWN', ?)").run(taskId, new Date().toISOString());
    f.db.raw.prepare("INSERT INTO attempts (attempt_id, intent_id, request_id, generation, ticket, state, created_at) VALUES ('a-u', 'i-u', NULL, 1, '{}', 'UNKNOWN', ?)").run(new Date().toISOString());
    expect(f.tasks.handleCommand({ commandId: "accept", kind: "accept-result", taskId })).toMatchObject({ accepted: true });
    const snapshot = f.tasks.snapshot(taskId);
    expect(snapshot.outcome).toMatchObject({ kind: "accepted", uncertainEffects: 1 });
    expect(snapshot.unknownHistory.map((entry) => entry.attemptId)).toEqual(["a-u"]);
    expect(snapshot.stateReason).toContain("1 UNKNOWN effect(s) still recorded");
  });

  it("refuses acceptance when there is nothing to accept or the task is running", async () => {
    const f = fixture();
    const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Organize o projeto", acceptance: [], provider: "local", model: "fixture", baseUrl: null });
    const refused = f.tasks.handleCommand({ commandId: "accept", kind: "accept-result", taskId });
    expect(refused).toMatchObject({ accepted: false });
    expect(refused.accepted ? "" : refused.detail).toContain("Ainda não há resultado");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    f.tasks.startTask(taskId, "start", { name: "gated", adapterRevision: "g", complete: async () => { await gate; return { text: "ok", toolCalls: [], usage: null, modelResolved: null, providerRequestId: null }; } });
    expect(f.tasks.snapshot(taskId).capabilities?.accept).toMatchObject({ allowed: false });
    expect(f.tasks.handleCommand({ commandId: "accept-live", kind: "accept-result", taskId })).toMatchObject({ accepted: false });
    release();
  });

  it("the CLI records acceptance with the same basis", async () => {
    const f = fixture();
    const taskId = await run(f.tasks, "Organize o projeto", [{ text: "Feito.", usage }]);
    recordTaskEvent(f.db.raw, taskId, "noop", {});
    await f.tasks.close();
    f.db.close();
    cleanups.pop();
    const original = process.stdout.write;
    let out = "";
    process.stdout.write = ((chunk: unknown) => { out += String(chunk); return true; }) as typeof process.stdout.write;
    let code: number;
    try { code = await acceptCommand({ workspace: f.root, dataDir: f.data, taskId, note: "ok pelo terminal" }); }
    finally { process.stdout.write = original; }
    expect(code).toBe(0);
    expect(out).toContain("accepted by human");
  });
});
