import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

// PG-013 (errata E-10): a second start never runs concurrently; it waits in a
// visible queue and starts by itself when the executor is free.
describe("single executor with a visible queue", () => {
  it("queues later starts, starts them in order, and lets the human take one out", async () => {
    const held: http.ServerResponse[] = [];
    let release = false;
    const answered: string[] = [];
    const server = http.createServer((request, response) => {
      let raw = "";
      request.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
      request.on("end", () => {
        const objective = /Objetivo: ([^\n]+)/u.exec((JSON.parse(raw) as { messages: Array<{ content: string }> }).messages[0]?.content ?? "")?.[1] ?? "?";
        const reply = (): void => {
          answered.push(objective);
          response.writeHead(200, { "Content-Type": "application/json" });
          response.end(JSON.stringify({ id: "q", model: "m", choices: [{ message: { content: `Resposta para ${objective}` } }], usage: { prompt_tokens: 5, completion_tokens: 5 } }));
        };
        if (!release) held.push(Object.assign(response, { reply }));
        else reply();
      });
    });
    const port = await new Promise<number>((resolve) => server.listen(0, "127.0.0.1", () => { resolve((server.address() as { port: number }).port); }));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => { server.close(() => { resolve(); }); }); });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-queue-"));
    cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const db = openLatticeDb(path.join(dir, "data"));
    claimOwnership(db.raw);
    const tasks = new TaskManager(db.raw, dir);
    cleanups.push(async () => { await tasks.close(); db.close(); });
    const url = `http://127.0.0.1:${port}/v1`;
    const create = (objective: string): string => tasks.createTask({ workspace: "", objective, acceptance: [], provider: "local", model: "m", baseUrl: url }).taskId;
    const a = create("Explique A");
    const b = create("Explique B");
    const c = create("Explique C");
    expect(tasks.handleCommand({ commandId: "sa", kind: "start-task", taskId: a })).toMatchObject({ accepted: true, state: "RUNNING" });
    const queued = tasks.handleCommand({ commandId: "sb", kind: "start-task", taskId: b });
    expect(queued).toMatchObject({ accepted: true, state: "READY" });
    expect(queued.detail).toContain("posição 1");
    tasks.handleCommand({ commandId: "sc", kind: "start-task", taskId: c });
    expect(tasks.snapshot(b)).toMatchObject({ queuePosition: 1, state: "READY" });
    expect(tasks.snapshot(c)).toMatchObject({ queuePosition: 2 });
    expect(tasks.snapshot(c).stateReason).toContain("queued");
    expect(tasks.listSessions().find((session) => session.taskId === b)?.queuePosition).toBe(1);
    // Only one run is live: B and C never reached the provider.
    const deadline = Date.now() + 5000;
    while (held.length < 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
    expect(held).toHaveLength(1);
    // The human takes C out of the queue.
    expect(tasks.snapshot(c).capabilities?.stop.allowed).toBe(true);
    expect(tasks.handleCommand({ commandId: "stop-c", kind: "stop", taskId: c })).toMatchObject({ accepted: true, detail: "Tarefa removida da fila." });
    expect(tasks.snapshot(c).queuePosition).toBeNull();
    // A finishes → B starts by itself → B finishes; C stays READY.
    release = true;
    for (const response of held.splice(0)) (response as unknown as { reply: () => void }).reply();
    const until = async (check: () => boolean): Promise<void> => { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) throw new Error("deadline"); await new Promise((resolve) => setTimeout(resolve, 20)); } };
    await until(() => tasks.snapshot(b).state === "COMPLETED");
    expect(tasks.snapshot(a).state).toBe("COMPLETED");
    expect(answered).toEqual(["Explique A", "Explique B"]);
    expect(tasks.snapshot(c)).toMatchObject({ state: "READY", queuePosition: null });
  });
});

// Resume and start can open two runs of one task within the same
// millisecond (approval decisions, "reply and continue"): the list still
// shows the task once, under its newest run.
describe("session list", () => {
  it("lists a task once even when two of its runs share a timestamp", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-sessions-"));
    cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const db = openLatticeDb(path.join(dir, "data"));
    claimOwnership(db.raw);
    const tasks = new TaskManager(db.raw, dir);
    cleanups.push(async () => { await tasks.close(); db.close(); });
    const { taskId } = tasks.createTask({ workspace: "", objective: "Explique A", acceptance: [], provider: "local", model: "m", baseUrl: "http://127.0.0.1:9/v1" });
    db.raw.prepare("INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) SELECT 'run-twin', session_id, root_id, task_id, manifest, created_at FROM runs WHERE task_id = ?").run(taskId);
    expect((db.raw.prepare("SELECT COUNT(DISTINCT created_at) AS t, COUNT(*) AS n FROM runs WHERE task_id = ?").get(taskId) as { t: number; n: number })).toEqual({ t: 1, n: 2 });
    const listed = tasks.listSessions().filter((session) => session.taskId === taskId);
    expect(listed).toHaveLength(1);
  });
});

describe("archiving (PG-044)", () => {
  it("hides a task from the default list without deleting anything, and restores it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-archive-"));
    cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
    const db = openLatticeDb(path.join(dir, "data"));
    claimOwnership(db.raw);
    const tasks = new TaskManager(db.raw, dir);
    cleanups.push(async () => { await tasks.close(); db.close(); });
    const { taskId } = tasks.createTask({ workspace: "", objective: "Arquivar-me", acceptance: [], provider: "local", model: "m", baseUrl: "http://127.0.0.1:59996/v1" });
    const events = (): number => (db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE task_id = ?").get(taskId) as { n: number }).n;
    const before = events();
    expect(tasks.handleCommand({ commandId: "a1", kind: "archive-task", taskId, payload: { archived: true } })).toMatchObject({ accepted: true });
    expect(tasks.listSessions().some((session) => session.taskId === taskId)).toBe(false);
    expect(tasks.listSessions(true).find((session) => session.taskId === taskId)).toMatchObject({ archived: true });
    expect(tasks.snapshot(taskId)).toMatchObject({ archived: true, objective: "Arquivar-me" });
    expect(events()).toBe(before + 1);
    expect(tasks.handleCommand({ commandId: "a2", kind: "archive-task", taskId, payload: { archived: false } })).toMatchObject({ accepted: true });
    expect(tasks.listSessions().some((session) => session.taskId === taskId)).toBe(true);
  });
});
