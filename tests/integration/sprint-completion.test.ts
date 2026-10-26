import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { TaskAcceptance, defaultAcceptance } from "../../src/runtime/acceptance.js";
import { ExecTool, type ExecArgs } from "../../src/tools/exec.js";
import { SearchTool } from "../../src/tools/search.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-sprint-completion-")); dirs.push(dir);
  const opened = openLatticeDb(path.join(dir, "data"));
  const workspace = path.join(dir, "café"); fs.mkdirSync(workspace);
  const tasks = new TaskManager(opened.raw, workspace);
  return { dir, opened, workspace, tasks };
}
async function finish(tasks: TaskManager, taskId: string, timeoutMs = 3000) {
  for (let i = 0; i < timeoutMs / 10; i++) {
    const snapshot = tasks.snapshot(taskId);
    if (snapshot.state !== "RUNNING") return snapshot;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("task did not settle");
}
const usage = { inputTokens: 3604, outputTokens: 783, inclusiveInput: true };

describe("completion and exact tool arguments", () => {
  it("completes a real test command in a project exceeding both old scan ceilings", async () => {
    const f = fixture();
    try {
      fs.writeFileSync(path.join(f.workspace, "large.bin"), Buffer.alloc(33 * 1024 * 1024));
      for (let i = 0; i < 10_001; i++) fs.writeFileSync(path.join(f.workspace, `entry-${i}`), "x");
      fs.writeFileSync(path.join(f.workspace, "fixture.test.mjs"), "import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';test('large project input',()=>assert.equal(fs.statSync('large.bin').size,33*1024*1024));");
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Run the project tests", acceptance: ["tests-pass"], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["--test", "--test-reporter=tap", "fixture.test.mjs"] }) }], usage }, { text: "Verified the project test.", usage }]);
      f.tasks.startTask(taskId, "start", provider);
      const result = await finish(f.tasks, taskId, 30_000);
      expect(result.state).toBe("COMPLETED");
      expect(result.verifications.at(-1)).toMatchObject({ countsKnown: true, passed: 1, failed: 0 });
    } finally { await f.tasks.close(); f.opened.close(); }
  }, 45_000);

  it("creates a file and completes from its actual bounded target", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Create file result.txt", acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [{ name: "edit", argumentsJson: '{"kind":"create","path":"result.txt","content":"real result"}' }], usage }]);
      f.tasks.startTask(taskId, "start", provider);
      expect((await finish(f.tasks, taskId)).state).toBe("COMPLETED");
      expect(fs.readFileSync(path.join(f.workspace, "result.txt"), "utf8")).toBe("real result");
      expect(provider.requests).toHaveLength(1);
    } finally { await f.tasks.close(); f.opened.close(); }
  });
  it.each([false, true])("directory request completes from a fresh bounded observation (preexisting=%s) and survives reopen", async (preexisting) => {
    const f = fixture();
    if (preexisting) fs.mkdirSync(path.join(f.workspace, "Muse"));
    const { taskId } = f.tasks.createTask({ workspace: ".", objective: 'Crie uma pasta dentro essa pasta que tenha o nome de "Muse"', acceptance: [], provider: "local", model: "fixture", baseUrl: null });
    const provider = new FakeProvider([{ toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('fs').mkdirSync('Muse',{recursive:true})"] }) }], usage }]);
    f.tasks.startTask(taskId, "start", provider);
    const completed = await finish(f.tasks, taskId);
    expect(completed.state).toBe("COMPLETED");
    expect(fs.statSync(path.join(f.workspace, "Muse")).isDirectory()).toBe(true);
    expect(completed.stateReason).toContain("observed on filesystem");
    expect(provider.requests).toHaveLength(1);
    expect(completed.verifications[0]?.countsKnown).toBe(false);
    expect(completed.messages[0]?.text).toContain("Muse");
    await f.tasks.close(); f.opened.close();
    const reopened = openLatticeDb(path.join(f.dir, "data"));
    try {
      const retained = new TaskManager(reopened.raw, f.workspace).snapshot(taskId);
      expect(retained.state).toBe("COMPLETED");
      expect(retained.messages).toEqual(completed.messages);
      expect(retained.budget.settledTokens).toBe(4387);
    } finally { reopened.close(); }
  });

  it("exit zero cannot complete a missing directory", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Create directory Muse", acceptance: ["directory-exists:Muse"], provider: "local", model: "fixture", baseUrl: null });
      f.tasks.startTask(taskId, "start", new FakeProvider([{ toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "process.exit(0)"] }) }], usage }, { text: "Done", usage }]));
      const snapshot = await finish(f.tasks, taskId);
      expect(snapshot.state).toBe("NEEDS_INPUT");
      expect(snapshot.stateReason).toContain("not observed");
    } finally { await f.tasks.close(); f.opened.close(); }
  });

  it("HTTP command preserves explicit criteria and explicit cumulative limits", () => {
    const f = fixture();
    try {
      const result = f.tasks.handleCommand({ kind: "create-task", commandId: "create", payload: { objective: "Observe", provider: "local", model: "fixture", acceptance: ["file-exists:result.txt"], budget: { calls: 3, tokens: 10_000 } } });
      expect(result.accepted).toBe(true); if (!result.accepted) throw new Error("not accepted");
      expect(f.tasks.snapshot(result.taskId)).toMatchObject({ acceptanceCriteria: ["file-exists:result.txt"], budget: { grantedCalls: 3, grantedTokens: 10_000 } });
    } finally { f.opened.close(); }
  });

  it("analysis can legitimately finish without a tool", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Explique a diferença entre uma chamada e uma ferramenta", acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      f.tasks.startTask(taskId, "start", new FakeProvider([{ text: "A chamada consulta o modelo; a ferramenta executa uma operação.", usage }]));
      expect((await finish(f.tasks, taskId)).state).toBe("COMPLETED");
    } finally { await f.tasks.close(); f.opened.close(); }
  });

  it("test failure, edit, pass, and subsequent edits invalidate the observed workspace", async () => {
    const f = fixture();
    try {
      const verifier = new TaskAcceptance(f.workspace, ["tests-pass"]);
      fs.writeFileSync(path.join(f.workspace, "code.js"), "broken");
      await verifier.prepare("exec");
      await verifier.observe("exec", "test", { status: "completed", summary: "exit 1", detail: "not ok 1 - broken" });
      expect((await verifier.check()).complete).toBe(false);
      fs.writeFileSync(path.join(f.workspace, "code.js"), "fixed");
      await verifier.observe("edit", "{}", { status: "completed", summary: "edited" });
      await verifier.prepare("exec");
      await verifier.observe("exec", "test", { status: "completed", summary: "exit 0", detail: "ok 1 - fixed" });
      expect((await verifier.check()).complete).toBe(true);
      fs.writeFileSync(path.join(f.workspace, "code.js"), "changed after tests");
      expect(await verifier.check()).toMatchObject({ complete: false });
      expect((await verifier.check()).reason).toContain("observed content changed (code.js)");
    } finally { f.opened.close(); }
  });

  it("an empty directory is observable by search", async () => {
    const f = fixture();
    try {
      fs.mkdirSync(path.join(f.workspace, "Muse"));
      const result = await new SearchTool().execute({ kind: "path", query: "Muse" }, { workspaceRoot: f.workspace, realm: "local-trusted" });
      expect(result.detail).toContain("Muse");
      expect(result.detail).toContain("directory");
    } finally { f.opened.close(); }
  });

  it.each([{ executable: "sh", command: "touch forbidden" }, { mode: "shell", shell: "sh", command: "touch forbidden", executable: "sh" }, { executable: "sh" }, { mode: "bogus", executable: "sh", argv: [] }])("malformed exec is rejected before spawn: %j", async (args) => {
    const f = fixture();
    try {
      const result = await new ExecTool().execute(args as ExecArgs, { workspaceRoot: f.workspace, realm: "local-trusted" });
      expect(result.errorKind).toBe("invalid-args");
      expect(fs.existsSync(path.join(f.workspace, "forbidden"))).toBe(false);
    } finally { f.opened.close(); }
  });

  it("conservative defaults do not turn an arbitrary coding request into response-only acceptance", () => {
    expect(defaultAcceptance("Fix a bug and run tests")).toEqual(["tests-pass"]);
    expect(defaultAcceptance("Create directory ../escape")).toEqual(["clarification-required"]);
    expect(defaultAcceptance("Fix a bug and create directory Muse")).toEqual(["unverified"]);
    expect(defaultAcceptance("Create directory Muse and delete the project")).toEqual(["clarification-required"]);
  });
});
