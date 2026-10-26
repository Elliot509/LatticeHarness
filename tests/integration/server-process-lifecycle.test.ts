import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { startDesktopBackend, type DesktopBackend } from "../../src/desktop/backend.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { openLatticeDb } from "../../src/storage/db.js";
import { listActiveWaits } from "../../src/runtime/wait.js";

const backends: DesktopBackend[] = [];
const dirs: string[] = [];
const pids = new Set<number>();
afterEach(async () => {
  for (const backend of backends.splice(0)) await backend.close();
  for (const pid of pids) {
    try {
      if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true });
      else process.kill(-pid, "SIGKILL");
    } catch { /* Only children identified by this fixture. */ }
  }
  pids.clear();
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-lifecycle-"));
  dirs.push(dir);
  const workspace = path.join(dir, "workspace café");
  const dataDir = path.join(dir, "data café");
  fs.mkdirSync(workspace);
  const backend = await startDesktopBackend({ workspace, dataDir });
  backends.push(backend);
  // Explicit tests-pass: these runs complete on observed TAP output (acceptance-4
  // would otherwise leave "Observe ..." awaiting human review).
  const { taskId } = backend.tasks.createTask({ workspace: "", objective: "Observe the owned process", acceptance: ["tests-pass"], provider: "openai", model: "fixture", baseUrl: "http://127.0.0.1:9" });
  return { backend, taskId, workspace, dataDir };
}

async function until(check: () => boolean, timeout = 4000) {
  const deadline = Date.now() + timeout;
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
  expect(check()).toBe(true);
}

function spawnStep(program: string) {
  return { toolCalls: [{ name: "process", argumentsJson: JSON.stringify({ op: "spawn", executable: process.execPath, argv: ["-e", program], generation: 1, realm: "local-trusted", attemptId: "fixture-owned" }) }] };
}

function childPid(backend: DesktopBackend, taskId: string) {
  const text = backend.tasks.snapshot(taskId).tools[0]?.summary ?? "";
  const pid = Number(/pid (\d+)/.exec(text)?.[1]);
  expect(pid).toBeGreaterThan(0);
  pids.add(pid);
  return pid;
}

function isAlive(pid: number) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

describe("alive task process lifecycle", () => {
  it("binds process identity to the actual owner, rather than model-supplied metadata", async () => {
    const { backend, taskId } = await setup();
    backend.db.raw.prepare("UPDATE ownership SET generation = 7 WHERE id = 1").run();
    const provider = new FakeProvider([
      spawnStep("setTimeout(() => console.log('owner-seven'), 150)"),
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log('ok 1 - owner bound')"] }) }] },
      { text: "Verified." },
    ]);
    backend.tasks.startTask(taskId, "start", provider);
    await until(() => backend.tasks.snapshot(taskId).state === "COMPLETED");
    expect(backend.tasks.snapshot(taskId).unknowns).toBe(0);
    expect(provider.consumedSteps).toBe(3);
  });

  it("polls the retained running handle after an explicit wake, re-arms WAIT and deduplicates redelivery", async () => {
    const { backend, taskId } = await setup();
    const poll = { name: "process", argumentsJson: "{}" };
    const provider = new FakeProvider([
      spawnStep("console.log('running-output'); setTimeout(() => console.error('final-stderr'), 850)"),
      { toolCalls: [poll] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log('ok 1 - continued')"] }) }] },
      { text: "Done." },
    ]);
    backend.tasks.startTask(taskId, "start", provider);
    await until(() => backend.tasks.snapshot(taskId).state === "WAITING");
    childPid(backend, taskId);
    const handle = /handle (proc_[a-z0-9]+)/.exec(backend.tasks.snapshot(taskId).tools[0]?.summary ?? "")?.[1];
    expect(handle).toBeTruthy();
    poll.argumentsJson = JSON.stringify({ op: "poll", handle, generation: 999, timeoutMs: 0 });
    const waitId = listActiveWaits(backend.db.raw, taskId)[0]?.waitId;
    const wake = { source: "explicit-observation", cursor: "1", observation: "Check the running process", waitId: waitId ?? "", edge: false };
    expect(backend.tasks.wakeTask(taskId, "wake", wake).accepted).toBe(true);
    expect(backend.tasks.wakeTask(taskId, "duplicate-wake", wake)).toMatchObject({ accepted: false, reason: "duplicate" });
    await until(() => provider.consumedSteps === 2 && backend.tasks.snapshot(taskId).state === "WAITING");
    expect(backend.tasks.snapshot(taskId).tools[1]?.summary).toContain("running");
    expect(listActiveWaits(backend.db.raw, taskId)).toHaveLength(1);
    await until(() => backend.tasks.snapshot(taskId).state === "COMPLETED");
    expect(provider.consumedSteps).toBe(4);
    expect(backend.db.raw.prepare("SELECT COUNT(*) AS n FROM wake_events WHERE task_id = ?").get(taskId)).toMatchObject({ n: 2 });
  });

  it("keeps WAIT at zero model calls, durably observes all output and continues once", async () => {
    const { backend, taskId } = await setup();
    const provider = new FakeProvider([
      spawnStep("console.log('early-out'); console.error('early-err'); setTimeout(() => console.log('final-out'), 650)"),
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "console.log('ok 1 - process observed')"] }) }] },
      { text: "Observed and verified." },
    ]);
    expect(backend.tasks.startTask(taskId, "start", provider).accepted).toBe(true);
    await until(() => backend.tasks.snapshot(taskId).state === "WAITING");
    childPid(backend, taskId);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(provider.consumedSteps).toBe(1);
    expect(backend.tasks.snapshot(taskId).budget.settledCalls).toBe(1);
    await until(() => backend.tasks.snapshot(taskId).state === "COMPLETED");
    expect(provider.consumedSteps).toBe(3);
    const wakes = backend.db.raw.prepare("SELECT observation FROM wake_events WHERE task_id = ?").all(taskId) as Array<{ observation: string }>;
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.observation).toContain("early-out");
    expect(wakes[0]?.observation).toContain("early-err");
    expect(wakes[0]?.observation).toContain("final-out");
    expect(backend.db.raw.prepare("SELECT state FROM waits WHERE task_id = ?").get(taskId)).toMatchObject({ state: "consumed" });
    expect(backend.tasks.snapshot(taskId).unknowns).toBe(0);
  });

  it("accepts Stop during WAIT and observes child termination without another model call", async () => {
    const { backend, taskId } = await setup();
    const provider = new FakeProvider([spawnStep("require('node:child_process').spawn(process.execPath, ['-e', \"require('node:fs').writeFileSync('nested-pid.txt', String(process.pid)); setInterval(() => {}, 1000)\"], {stdio: ['ignore', 'inherit', 'inherit']}); setInterval(() => {}, 1000)")]);
    backend.tasks.startTask(taskId, "start", provider);
    await until(() => backend.tasks.snapshot(taskId).state === "WAITING");
    const pid = childPid(backend, taskId);
    const nestedFile = path.join(backend.tasks.serverWorkspace, "nested-pid.txt");
    await until(() => fs.existsSync(nestedFile));
    const nestedPid = Number(fs.readFileSync(nestedFile, "utf8"));
    pids.add(nestedPid);
    expect(backend.tasks.stop(taskId, "stop").accepted).toBe(true);
    await until(() => !["WAITING", "RUNNING"].includes(backend.tasks.snapshot(taskId).state));
    expect(isAlive(pid)).toBe(false);
    expect(isAlive(nestedPid)).toBe(false);
    expect(provider.consumedSteps).toBe(1);
    expect(backend.tasks.stop(taskId, "stop-again").accepted).toBe(false);
    const cleanup = backend.db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'process-cleanup'").all(taskId);
    expect(cleanup).toHaveLength(1);
  });

  it("drains an active child before HTTP/DB close and reopens coherent history", async () => {
    const { backend, taskId, dataDir } = await setup();
    const provider = new FakeProvider([spawnStep("setInterval(() => {}, 1000)")]);
    backend.tasks.startTask(taskId, "start", provider);
    await until(() => backend.tasks.snapshot(taskId).state === "WAITING");
    const pid = childPid(backend, taskId);
    const next = backend.tasks.createTask({ workspace: "", objective: "Must not dispatch during drain", acceptance: [], provider: "openai", model: "fixture", baseUrl: "http://127.0.0.1:9" });
    expect(backend.tasks.startTask(next.taskId, "competing-start", provider).accepted).toBe(false);
    const closing = backend.close();
    expect(backend.tasks.startTask(next.taskId, "start-during-close", provider).accepted).toBe(false);
    await closing;
    backends.splice(backends.indexOf(backend), 1);
    expect(isAlive(pid)).toBe(false);
    await expect(fetch(backend.server.url)).rejects.toThrow();
    const db = openLatticeDb(dataDir);
    try {
      const row = db.raw.prepare("SELECT payload FROM events WHERE task_id = ? AND kind = 'task-state' ORDER BY seq DESC LIMIT 1").get(taskId) as { payload: string };
      expect(["CANCELLED", "BLOCKED"]).toContain(JSON.parse(row.payload).state);
      expect(db.raw.prepare("SELECT state FROM waits WHERE task_id = ?").get(taskId)).toMatchObject({ state: "cancelled" });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state = 'CLAIMED'").get()).toMatchObject({ n: 0 });
      expect(db.raw.prepare("PRAGMA integrity_check").get()).toMatchObject({ integrity_check: "ok" });
    } finally { db.close(); }
  });

  it("cancels finite exec during shutdown, preserves UNKNOWN and prevents the next tool in the batch", async () => {
    const { backend, taskId, workspace, dataDir } = await setup();
    const provider = new FakeProvider([{ toolCalls: [
      { name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('node:fs').writeFileSync('exec-pid.txt', String(process.pid)); setInterval(() => {}, 1000)"] }) },
      { name: "edit", argumentsJson: JSON.stringify({ op: "create", path: "must-not-exist.txt", content: "unauthorized after stop" }) },
    ] }]);
    backend.tasks.startTask(taskId, "start", provider);
    await until(() => fs.existsSync(path.join(workspace, "exec-pid.txt")));
    const pid = Number(fs.readFileSync(path.join(workspace, "exec-pid.txt"), "utf8"));
    pids.add(pid);
    await backend.close();
    backends.splice(backends.indexOf(backend), 1);
    expect(isAlive(pid)).toBe(false);
    expect(fs.existsSync(path.join(workspace, "must-not-exist.txt"))).toBe(false);
    const db = openLatticeDb(dataDir);
    try {
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts a JOIN intents i ON i.intent_id = a.intent_id WHERE i.task_id = ? AND i.operation = 'edit'").get(taskId)).toMatchObject({ n: 0 });
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM attempts WHERE state = 'CLAIMED'").get()).toMatchObject({ n: 0 });
      expect(db.raw.prepare("SELECT outcome FROM receipts WHERE outcome = 'unknown'").get()).toMatchObject({ outcome: "unknown" });
    } finally { db.close(); }
  });
});
