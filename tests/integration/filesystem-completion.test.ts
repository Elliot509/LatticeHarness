import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { ProviderError, type ProviderAdapter } from "../../src/providers/types.js";
import { TaskAcceptance } from "../../src/runtime/acceptance.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import { runTaskCommand } from "../../src/cli/run.js";

// Surface-2: anchors are in the system message, observations in tool turns.
function modelText(request: { system: string; messages: Array<{ content: string }> } | undefined): string {
  return request === undefined ? "" : [request.system, ...request.messages.map((message) => message.content)].join("\n");
}

const literal = 'Crie uma pasta chamada "Python" dentro desse lugar.';
const usage = { inputTokens: 10, outputTokens: 5, inclusiveInput: true };
const dirs: string[] = [];
afterEach(() => { clearFaults(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-filesystem-")); dirs.push(dir);
  const root = path.join(dir, "project"); fs.mkdirSync(root);
  const db = openLatticeDb(path.join(dir, "data"));
  return { dir, root, db, tasks: new TaskManager(db.raw, root) };
}
async function until(check: () => boolean) {
  const end = Date.now() + 5000;
  while (!check()) { if (Date.now() >= end) throw new Error("fixture deadline"); await new Promise(resolve => setTimeout(resolve, 5)); }
}
function exec(command: string, create = false) {
  // Original shell proposals on POSIX; equivalent filesystem observations
  // on Windows, where sh is not a supported installed prerequisite.
  return { name: "exec", argumentsJson: JSON.stringify(process.platform === "win32"
    ? { executable: process.execPath, argv: ["-e", `const fs=require('fs');console.log(fs.readdirSync('.'));${create ? "fs.mkdirSync('Python',{recursive:true});" : ""}console.log(fs.existsSync('Python')?'READY:Python-exists':'MISSING:Python');`], cwd: "." }
    : { mode: "shell", shell: "sh", cwd: ".", command }) };
}
function script() {
  return [
    'pwd; ls -la; echo "---"; find . -maxdepth 3 -type d -print 2>&1 | head -n 100',
    "pwd; ls -la; mkdir -p Python && ls -la; test -d Python && echo READY:Python-exists",
    "pwd; ls -la; test -d Python && echo READY:Python-exists || echo MISSING:Python",
    "pwd; ls -la; test -d Python && echo READY:Python-exists || echo MISSING:Python",
    'pwd; ls -la; test -d "./Python" && echo "READY:Python-exists" || echo "MISSING:Python"',
    'pwd; ls -la; test -d "./Python" && echo "READY:Python-exists" || echo "MISSING:Python"',
    "pwd; ls -la; test -d Python && echo READY:Python-exists || echo MISSING:Python",
    "pwd; ls -la; ls -ld Python 2>&1 && echo READY:Python-exists || echo MISSING:Python",
    "pwd; ls -la; test -d Python && echo READY:Python-exists || echo MISSING:Python; test -d ./Python && ls -ld ./Python",
    'pwd; ls -la; test -d "./Python" && echo "READY:Python-exists" || echo "MISSING:Python"',
  ].map((command, index) => ({ toolCalls: [exec(command, index === 1)], usage }));
}

describe("filesystem acceptance through the real task manager", () => {
  it("replays the original proposals and completes after creation, before nine further model requests", async () => {
    const f = fixture();
    try {
      const created = f.tasks.handleCommand({ kind: "create-task", commandId: "create", payload: { objective: literal, acceptance: [], provider: "local", model: "fixture" } });
      expect(created.accepted).toBe(true);
      if (!created.accepted) throw new Error("task creation denied");
      const provider = new FakeProvider([...script(), { text: "Should not be called", usage }]);
      f.tasks.startTask(created.taskId, "start", provider);
      await until(() => f.tasks.snapshot(created.taskId).state !== "RUNNING");
      const done = f.tasks.snapshot(created.taskId);
      expect(done).toMatchObject({ state: "COMPLETED", acceptanceCriteria: ["directory-exists:Python"], budget: { settledCalls: 2, settledTokens: 30 } });
      expect(fs.statSync(path.join(f.root, "Python")).isDirectory()).toBe(true);
      expect(provider.requests).toHaveLength(2); expect(provider.remainingSteps).toBe(9);
      expect(done.tools).toHaveLength(2);
      expect(done.verifications.every(v => v.countsKnown === false)).toBe(true);
      expect(modelText(provider.requests[1])).toContain("not observed");
      expect(JSON.parse(String(f.db.raw.prepare("SELECT payload FROM events WHERE kind='acceptance-policy'").get()?.["payload"]))).toMatchObject({ source: "default", policyVersion: "acceptance-4" });
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM intents WHERE state IN ('ADMITTED','CLAIMED','UNKNOWN')").get()).toMatchObject({ n: 0 });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("completes a preexisting directory from a fresh observation without an extra request", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "Python"));
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: literal, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider(script()); f.tasks.startTask(taskId, "start", provider);
      await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("COMPLETED"); expect(provider.requests).toHaveLength(1);
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it.each(["tests-pass", "directory-exists:Other"])("does not replace the explicit criterion %s with the inferred Python target", async criterion => {
    const f = fixture();
    const acceptance = [criterion];
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: literal, acceptance, provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([...script().slice(1, 2), { text: "Done", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "NEEDS_INPUT", acceptanceCriteria: acceptance });
      expect(fs.existsSync(path.join(f.root, "Python"))).toBe(true);
      expect(JSON.parse(String(f.db.raw.prepare("SELECT payload FROM events WHERE kind='acceptance-policy'").get()?.["payload"]))).toMatchObject({ source: "explicit" });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it.each(["Crie uma pasta.", "Crie uma pasta chamada Python e remova os arquivos.", "Crie um arquivo chamado x.txt contendo um programa."])("clarifies ambiguous creation before provider configuration or dispatch: %s", async objective => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "openrouter", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([]);
      expect(f.tasks.startTask(taskId, "start", provider)).toMatchObject({ accepted: true, state: "NEEDS_INPUT" });
      expect(provider.requests).toHaveLength(0);
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "NEEDS_INPUT", budget: { settledCalls: 0 } });
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM attempts").get()).toMatchObject({ n: 0 });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("explicit acceptance bypasses the ambiguity preflight", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Crie uma pasta com um nome a combinar.", acceptance: ["directory-exists:Python"], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider(script().slice(1, 2)); f.tasks.startTask(taskId, "start", provider);
      await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("COMPLETED"); expect(provider.requests).toHaveLength(1);
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("exit zero from a missing-directory conditional cannot prove completion", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: literal, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [exec("test -d Python && echo READY:Python-exists || echo MISSING:Python")], usage }, { text: "Done", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      const snap = f.tasks.snapshot(taskId);
      expect(snap.state).toBe("NEEDS_INPUT"); expect(snap.verifications[0]).toMatchObject({ exitCode: 0, countsKnown: false });
      expect(modelText(provider.requests[1])).toContain("not observed");
      expect(fs.existsSync(path.join(f.root, "Python"))).toBe(false);
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("does not conclude through an external symlink or wrong filesystem kind", async () => {
    const f = fixture(); const external = path.join(f.dir, "outside"); fs.mkdirSync(external);
    try {
      fs.writeFileSync(path.join(f.root, "Python"), "not a directory");
      expect((await new TaskAcceptance(f.root, ["directory-exists:Python"]).check()).complete).toBe(false);
      fs.unlinkSync(path.join(f.root, "Python"));
      fs.symlinkSync(external, path.join(f.root, "Python"), process.platform === "win32" ? "junction" : "dir");
      expect(await new TaskAcceptance(f.root, ["directory-exists:Python"]).check()).toMatchObject({ complete: false, reason: expect.stringContaining("escapes") });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("an applied but UNKNOWN effect blocks early completion even when the file now exists", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Create file result.txt", acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      armFault("after-edit-effect");
      f.tasks.startTask(taskId, "start", new FakeProvider([{ toolCalls: [{ name: "edit", argumentsJson: '{"kind":"create","path":"result.txt","content":"applied"}' }], usage }]));
      await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "BLOCKED", unknowns: 1 });
      expect(f.tasks.snapshot(taskId).messages.some(message => message.source === "verified")).toBe(false);
      expect(fs.existsSync(path.join(f.root, "result.txt"))).toBe(true);
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM events WHERE kind='acceptance'").get()).toMatchObject({ n: 0 });
    } finally { clearFaults(); await f.tasks.close(); f.db.close(); }
  });

  it("human Stop during repeated checks remains CANCELLED with unknown usage retained", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "Python"));
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: literal, acceptance: ["tests-pass"], provider: "local", model: "fixture", baseUrl: null });
      const scripted = new FakeProvider(script()); let calls = 0;
      const provider: ProviderAdapter = { name: "fixture", adapterRevision: "fixture-1", complete: request => {
        calls++;
        if (calls < 4) return scripted.complete(request);
        return new Promise((_resolve, reject) => { request.signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "fixture stop", false)), { once: true }); });
      } };
      f.tasks.startTask(taskId, "start", provider); await until(() => calls === 4);
      expect(f.tasks.stop(taskId, "human-stop").accepted).toBe(true);
      await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "CANCELLED", budget: { settledCalls: 4, uncertainUsageAttempts: 1 } });
      expect(f.tasks.snapshot(taskId).messages.some(message => message.source === "verified")).toBe(false);
      expect(f.tasks.snapshot(taskId).stateReason).toContain("stop requested");
      expect(f.tasks.snapshot(taskId).tools).toHaveLength(3);
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("CLI uses the same automatic clarification policy without invoking a provider", async () => {
    const f = fixture(); f.db.close();
    const output: string[] = [];
    const code = await runTaskCommand({ workspace: f.root, dataDir: path.join(f.dir, "cli-data"), task: "Crie uma pasta.", acceptance: [], providerName: "fake", model: "fixture", onOutput: line => output.push(line) });
    expect(code).toBe(2); expect(output.join("\n")).toContain("ASK");
    expect(output.join("\n")).not.toContain("fake provider requires");
  });
});
