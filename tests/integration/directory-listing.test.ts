import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { ProviderError, type ProviderAdapter, type ModelRequest } from "../../src/providers/types.js";
import { TaskAcceptance, defaultAcceptance, resolveAcceptance } from "../../src/runtime/acceptance.js";
import { ReadTool } from "../../src/tools/read.js";
import { buildToolset } from "../../src/tools/registry.js";

// Surface-2: anchors are in the system message, observations in tool turns.
function modelText(request: { system: string; messages: Array<{ content: string }> } | undefined): string {
  return request === undefined ? "" : [request.system, ...request.messages.map((message) => message.content)].join("\n");
}

const objective = "Me liste tudo que está nessa pasta.";
const usage = { inputTokens: 1200, outputTokens: 50, inclusiveInput: true };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-inventory-")); dirs.push(dir);
  const root = path.join(dir, "project"); fs.mkdirSync(root);
  const data = path.join(dir, "data"); const db = openLatticeDb(data);
  return { dir, root, data, db, tasks: new TaskManager(db.raw, root) };
}
async function until(check: () => boolean) { const end = Date.now() + 10_000; while (!check()) { if (Date.now() > end) throw new Error("inventory fixture deadline"); await new Promise(resolve => setTimeout(resolve, 5)); } }
function read(args: Record<string, unknown>) { return { name: "read", argumentsJson: JSON.stringify({ path: ".", kind: "directory", ...args }) }; }
function exec(command: string) { return { name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", command], cwd: "." }) }; }

describe("bounded informational acceptance", () => {
  it.each([
    [objective, "directory-listing:all:immediate:."],
    ["Quais arquivos existem aqui?", "directory-listing:files:immediate:."],
    ["Mostre os diretórios desse projeto.", "directory-listing:directories:immediate:."],
    ["Liste tudo nessa pasta recursivamente.", "directory-listing:all:recursive:."],
    ["Leia README.md e explique o conteúdo.", "response"],
    ["Resuma a estrutura desse projeto.", "response"],
    ["Corrija a API e explique o resultado", "unverified"],
    ["Liste os arquivos aqui e crie um programa", "unverified"],
    ["Explique o erro e corrija o programa", "unverified"],
    ["Liste tudo na pasta Downloads", "clarification-required"],
  ])("preserves the whole obligation: %s", (text, criterion) => { expect(defaultAcceptance(text)).toEqual([criterion]); });
  it("keeps explicit criteria independent", () => { expect(resolveAcceptance(objective, ["response", "tests-pass"])).toMatchObject({ criteria: ["response", "tests-pass"], source: "explicit" }); });

  it("keeps execution available for explicit composite inventory criteria", async () => {
    const f = fixture();
    try {
      const criteria = ["directory-listing:all:immediate:.", "file-exists:result.txt"];
      expect(new TaskAcceptance(f.root, criteria).directoryOnly).toBe(false);
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: criteria, provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [exec("require('fs').writeFileSync('result.txt','fixture')"), read({})], usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(provider.requests[0]?.tools.map(tool => tool.name)).toContain("exec");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "COMPLETED", acceptanceCriteria: criteria });
      expect(fs.readFileSync(path.join(f.root, "result.txt"), "utf8")).toBe("fixture");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("response after queries does not silently require tests; actual writes retain explicit filesystem predicates", async () => {
    const f = fixture();
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: ["response"], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [exec("console.log(require('fs').readdirSync('.'))")], usage }, { text: "A pasta está vazia, no escopo imediato consultado.", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "COMPLETED", acceptanceCriteria: ["response"] });
      const acceptance = new TaskAcceptance(f.root, ["response", "file-exists:result.txt"]);
      const tool = buildToolset().find(tool => tool.name === "exec"); if (!tool) throw new Error("missing exec");
      await acceptance.prepare("exec");
      const args = exec("require('fs').writeFileSync('result.txt','observed')").argumentsJson;
      await acceptance.observe("exec", args, (await tool.run(args, { workspaceRoot: f.root, realm: "local-trusted" })).result);
      expect(await acceptance.check("Arquivo criado.")).toMatchObject({ complete: true });
      expect(await new TaskAcceptance(f.root, ["response", "file-exists:missing.txt"]).check("Done")).toMatchObject({ complete: false });
      expect(await new TaskAcceptance(f.root, ["tests-pass"]).check("Done")).toMatchObject({ complete: false });
    } finally { await f.tasks.close(); f.db.close(); }
  });
});

describe("directory pages and verified delivery", () => {
  it("includes hidden/generated entries and links without reading contents or traversing links", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "node_modules")); fs.writeFileSync(path.join(f.root, ".hidden"), ""); fs.writeFileSync(path.join(f.root, "a\nb.txt"), "");
    const outside = path.join(f.dir, "outside"); fs.mkdirSync(outside); fs.writeFileSync(path.join(outside, "private.txt"), "do not read");
    fs.symlinkSync(outside, path.join(f.root, "link"), process.platform === "win32" ? "junction" : "dir");
    try {
      const result = await new ReadTool().execute({ path: ".", kind: "directory", recursive: true }, { workspaceRoot: f.root, realm: "local-trusted" });
      expect(result.directoryPage).toMatchObject({ scanComplete: true, total: 4, nextCursor: null });
      expect(result.directoryPage?.entries).toContainEqual({ path: "a\nb.txt", type: "file" });
      expect(result.directoryPage?.entries).toContainEqual({ path: "link", type: "symlink" });
      expect(result.detail).not.toContain("private.txt");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("large inventory requires every page, recovers the tail without a rescan, and cannot falsely complete", async () => {
    const f = fixture();
    for (let i = 0; i < 291; i++) fs.writeFileSync(path.join(f.root, `${String(i).padStart(3, "0")}-${"x".repeat(100)}.txt`), "");
    const reader = new ReadTool(); const acceptance = new TaskAcceptance(f.root, defaultAcceptance(objective)); const context = { workspaceRoot: f.root, realm: "local-trusted" };
    try {
      let page = await reader.execute({ path: ".", kind: "directory" }, context);
      expect(page.detail?.length).toBeLessThan(4000); expect(page.directoryPage?.nextCursor).not.toBeNull();
      await acceptance.observe("read", "{}", page);
      expect(await acceptance.check("Here is everything.")).toMatchObject({ complete: false });
      // A cursor continues the original observation despite a later new file.
      fs.writeFileSync(path.join(f.root, "later.txt"), "");
      let pages = 1;
      while (page.directoryPage?.nextCursor) {
        page = await reader.execute({ path: ".", kind: "directory", cursor: page.directoryPage.nextCursor }, context);
        expect(page.detail?.length).toBeLessThan(4000); await acceptance.observe("read", "{}", page); pages++;
      }
      const check = await acceptance.check();
      expect(check).toMatchObject({ complete: true }); expect(check.finalText).toContain('"290-'); expect(check.finalText).not.toContain("later.txt");
      expect(check.finalText?.split("\n").filter(line => line.startsWith("- "))).toHaveLength(291); expect(pages).toBeGreaterThan(1);
      const newPage = await reader.execute({ path: ".", kind: "directory" }, context); expect(newPage.directoryPage?.total).toBe(292);
      const escaped = await reader.execute({ path: "../outside", kind: "directory" }, context); expect(escaped.errorKind).toBe("invalid-args");
      const wrongScope = await reader.execute({ path: "later.txt", kind: "directory", cursor: page.directoryPage?.snapshot + ":1" }, context); expect(wrongScope.errorKind).toBe("stale-cursor");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("unreadable, missing or cancelled inventories do not certify a complete list", async () => {
    const f = fixture();
    try {
      const result = await new ReadTool().execute({ path: "missing", kind: "directory" }, { workspaceRoot: f.root, realm: "local-trusted" });
      expect(result.directoryPage?.scanComplete).toBe(false);
      const acceptance = new TaskAcceptance(f.root, ["directory-listing:all:immediate:missing"]); await acceptance.observe("read", "{}", result);
      expect(await acceptance.check("Everything")).toMatchObject({ complete: false });
      const abort = new AbortController(); abort.abort();
      expect(await new ReadTool().execute({ path: ".", kind: "directory" }, { workspaceRoot: f.root, realm: "local-trusted", signal: abort.signal })).toMatchObject({ status: "cancelled", complete: false });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("the incident objective completes with delivered entries before redundant calls, and reopens unchanged", async () => {
    const f = fixture(); fs.mkdirSync(path.join(f.root, "Python")); fs.writeFileSync(path.join(f.root, "README.md"), "fixture");
    const provider = new FakeProvider([{ toolCalls: [read({})], usage }, ...Array.from({ length: 13 }, () => ({ toolCalls: [exec("console.log('repeat')")], usage }))]);
    let taskId = "";
    try {
      ({ taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null }));
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "COMPLETED", acceptanceCriteria: ["directory-listing:all:immediate:."] });
      expect(provider.requests).toHaveLength(1); expect(provider.remainingSteps).toBe(13);
      expect(provider.requests[0]?.tools.map(tool => tool.name)).toEqual(["read"]);
      expect(modelText(provider.requests[0])).toContain("nextCursor");
      const chats = f.db.raw.prepare("SELECT payload FROM events WHERE kind='chat'").all().map(row => JSON.parse(String(row["payload"])) as { text: string });
      expect(chats.at(-1)?.text).toContain('"Python" [directory]'); expect(chats.at(-1)?.text).toContain('"README.md" [file]');
    } finally { await f.tasks.close(); f.db.close(); }
    const reopened = openLatticeDb(f.data); const tasks = new TaskManager(reopened.raw, f.root);
    try { expect(tasks.snapshot(taskId).state).toBe("COMPLETED"); const messages = reopened.raw.prepare("SELECT payload FROM events WHERE kind='chat'").all().map(row => JSON.parse(String(row["payload"])) as { author: string; text: string }); expect(messages.filter(message => message.author === "agent")).toHaveLength(1); expect(messages.at(-1)?.text).toContain('"Python" [directory]'); }
    finally { await tasks.close(); reopened.close(); }
  });

  it("productive pagination stays finite and does not count as stagnation even when older pages leave context", async () => {
    const f = fixture(); for (let i = 0; i < 120; i++) fs.writeFileSync(path.join(f.root, `item-${String(i).padStart(3, "0")}`), "");
    const requests: ModelRequest[] = [];
    const provider: ProviderAdapter = { name: "fake", adapterRevision: "directory-fixture-1", complete: async request => {
      requests.push(request); const text = modelText(request);
      const cursor = [...text.matchAll(/cursor=([a-f0-9-]{36}:\d+)/gu)].at(-1)?.[1];
      return { text: "", toolCalls: [{ id: `page-${requests.length}`, ...read({ pageSize: 5, ...(cursor === undefined ? {} : { cursor }) }) }], usage, modelResolved: "fixture", providerRequestId: null };
    } };
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("COMPLETED"); expect(requests).toHaveLength(24);
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toMatchObject({ n: 48 });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("repeating observed pages under different cursors/sizes does not fabricate progress", async () => {
    const f = fixture(); for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(f.root, name), "");
    const requests: ModelRequest[] = [];
    const provider: ProviderAdapter = { name: "fake", adapterRevision: "directory-repeat-1", complete: async request => {
      requests.push(request);
      return { text: "", toolCalls: [{ id: String(requests.length), ...read({ pageSize: 1 }) }], usage, modelResolved: "fixture", providerRequestId: null };
    } };
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("NEEDS_INPUT"); expect(requests).toHaveLength(5); expect(f.tasks.snapshot(taskId).stateReason).toContain("no progress");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("Stop during a pending continuation retains UNKNOWN, receipts and the task", async () => {
    const f = fixture(); for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(f.root, name), "");
    let calls = 0;
    const first = new FakeProvider([{ toolCalls: [read({ pageSize: 1 })], usage }]);
    const provider: ProviderAdapter = { name: "fake", adapterRevision: "directory-stop-1", complete: request => {
      calls++; if (calls === 1) return first.complete(request);
      return new Promise((_resolve, reject) => request.signal?.addEventListener("abort", () => reject(new ProviderError("aborted", "human stop", false)), { once: true }));
    } };
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      f.tasks.startTask(taskId, "start", provider); await until(() => calls === 2); f.tasks.stop(taskId, "human-stop"); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "CANCELLED", budget: { uncertainUsageAttempts: 1 } });
      expect(f.tasks.snapshot(taskId).tools).toHaveLength(1);
      expect(f.db.raw.prepare("SELECT COUNT(*) AS n FROM receipts WHERE json_extract(detail,'$.detail') LIKE '%directoryPage%'").get()).toMatchObject({ n: 1 });
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("expands a long exec receipt without dispatching the command again", async () => {
    const f = fixture(); const tools = buildToolset(); const command = tools.find(tool => tool.name === "exec"); const reader = tools.find(tool => tool.name === "read");
    if (!command || !reader) throw new Error("tools missing"); const context = { workspaceRoot: f.root, realm: "local-trusted" };
    try {
      const result = (await command.run(exec("console.log('x'.repeat(7000)+'TAIL')").argumentsJson, context)).result;
      expect(result.truncated).toBe(false); expect(result.handleId).toBeDefined();
      const tail = (await reader.run(JSON.stringify({ path: ".", handleId: result.handleId, offset: 6500, maxBytes: 1000 }), context)).result;
      expect(tail.detail).toContain("TAIL"); expect(tail.summary).toContain("end of captured output");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("a premature model claim of a complete inventory is not delivered as a verified answer", async () => {
    const f = fixture(); fs.writeFileSync(path.join(f.root, "a.txt"), ""); fs.writeFileSync(path.join(f.root, "b.txt"), "");
    try {
      const { taskId } = f.tasks.createTask({ workspace: ".", objective, acceptance: [], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [read({ pageSize: 1 })], usage }, { text: "Inventário completo: a.txt; não existe mais nada.", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(f.tasks.snapshot(taskId).state).toBe("NEEDS_INPUT");
      const messages = f.db.raw.prepare("SELECT payload FROM events WHERE kind='chat'").all().map(row => JSON.parse(String(row["payload"])) as { text: string });
      expect(messages.at(-1)?.text).toContain("Resultado não verificado"); expect(messages.at(-1)?.text).not.toContain("não existe mais nada");
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("real shell writes do not satisfy tests-pass through exit zero", async () => {
    const f = fixture();
    try {
      // Explicit tests-pass keeps this test about exit-zero evidence; the
      // default for this objective is now "unverified" (acceptance-4).
      const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Implemente um programa", acceptance: ["tests-pass"], provider: "local", model: "fixture", baseUrl: null });
      const provider = new FakeProvider([{ toolCalls: [exec("require('fs').writeFileSync('program.js','console.log(1)')")], usage }, { text: "Done", usage }]);
      f.tasks.startTask(taskId, "start", provider); await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
      expect(fs.readFileSync(path.join(f.root, "program.js"), "utf8")).toBe("console.log(1)"); expect(f.tasks.snapshot(taskId)).toMatchObject({ state: "NEEDS_INPUT", acceptanceCriteria: ["tests-pass"] });
    } finally { await f.tasks.close(); f.db.close(); }
  });
});
