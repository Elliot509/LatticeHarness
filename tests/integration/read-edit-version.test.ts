import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { TaskManager } from "../../src/server/tasks.js";
import { OpenAiAdapter } from "../../src/providers/openai.js";
import { contentVersion } from "../../src/tools/read.js";
import { createContract } from "../../src/runtime/contract.js";
import { runTaskLoop } from "../../src/runtime/loop.js";
import { FakeProvider } from "../../src/providers/fake.js";
import { buildToolset } from "../../src/tools/registry.js";
import type { TaskSurface } from "../../src/context/compiler.js";

// A reactive OpenAI-compatible loopback model: each reply is decided from
// the request body the runtime actually serialized, so a version can only
// reach the next tool call by crossing read → loop → surface → adapter.
interface ChatBody {
  messages: Array<{ role: string; content: string }>;
  tools: Array<{ type: string; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
}
type Reply = { text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> };

async function reactiveModel(decide: (body: ChatBody, turn: number) => Reply) {
  const bodies: ChatBody[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk: Buffer) => { raw += chunk.toString("utf8"); });
    req.on("end", () => {
      const body = JSON.parse(raw) as ChatBody;
      bodies.push(body);
      const reply = decide(body, bodies.length);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        id: `f5-${bodies.length}`, model: "f5-fixture",
        choices: [{ message: { content: reply.text ?? "", tool_calls: (reply.toolCalls ?? []).map((call, index) => ({ id: `c${bodies.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } })) }, finish_reason: reply.toolCalls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }));
    });
  });
  await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("bind failed");
  return {
    url: `http://127.0.0.1:${address.port}/v1`,
    bodies,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }),
  };
}

const userText = (body: ChatBody): string => body.messages.find((message) => message.role === "user")?.content ?? "";
const anchor = (body: ChatBody): string => /^Versões: .*$/m.exec(userText(body))?.[0] ?? "";
// What a model would do: take the version the observation names, never derive it.
const observedVersion = (body: ChatBody, file: string): string | undefined => new RegExp(`Versões: .*${file.replace(".", "\\.")}@(sha256:[0-9a-f]{16})`).exec(userText(body))?.[1];

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(files: Record<string, string>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-f5-e2e-")); dirs.push(dir);
  const root = path.join(dir, "project"); fs.mkdirSync(root);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(root, name), content);
  const db = openLatticeDb(path.join(dir, "data"));
  return { root, db, tasks: new TaskManager(db.raw, root) };
}

async function until(check: () => boolean) {
  const end = Date.now() + 10_000;
  while (!check()) { if (Date.now() >= end) throw new Error("deadline"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}

function dumpEvidence(name: string, bodies: ChatBody[]): void {
  const target = process.env["LATTICE_F5_EVIDENCE_DIR"];
  if (target === undefined || target === "") return;
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, `${name}.requests.json`), JSON.stringify(bodies.map((body) => ({ user: userText(body), tools: body.tools.map((tool) => tool.function.name), editSchema: body.tools.find((tool) => tool.function.name === "edit")?.function.parameters })), null, 2));
}

async function runTask(f: ReturnType<typeof fixture>, model: Awaited<ReturnType<typeof reactiveModel>>) {
  const { taskId } = f.tasks.createTask({ workspace: ".", objective: "Corrija a saudação em note.txt", acceptance: [], provider: "openai", model: "f5-fixture", baseUrl: model.url });
  f.tasks.startTask(taskId, "start", new OpenAiAdapter({ apiKey: "f5-loopback-placeholder", baseUrl: model.url }));
  await until(() => f.tasks.snapshot(taskId).state !== "RUNNING");
  return f.tasks.snapshot(taskId);
}

describe("read → version → model request → edit, through the task manager and OpenAI adapter", () => {
  it("delivers the read version to the next request and the model's copy of it edits on the first try", async () => {
    const f = fixture({ "note.txt": "ola mundo\n" });
    const original = contentVersion(Buffer.from("ola mundo\n"));
    const model = await reactiveModel((body, turn) => {
      if (turn === 1) return { toolCalls: [{ name: "read", args: { path: "note.txt" } }] };
      const version = observedVersion(body, "note.txt");
      if (turn === 2 && version !== undefined) return { toolCalls: [{ name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: version, oldText: "ola", newText: "olá" } }] };
      return { text: "done" };
    });
    try {
      await runTask(f, model);
      dumpEvidence("first-try", model.bodies);
      const [first, second, third] = model.bodies;
      if (first === undefined || second === undefined || third === undefined) throw new Error(`expected 3 requests, got ${model.bodies.length}`);
      expect(anchor(first)).toBe("Versões: nenhuma registrada");
      // The request assembled after the read carries the version twice: in
      // the read observation (evidence) and in the always-kept anchor.
      expect(userText(second)).toContain(`note.txt lines 1-2 of 2; version ${original} (whole file; edit expectedVersion)`);
      expect(anchor(second)).toBe(`Versões: note.txt@${original}`);
      expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe("olá mundo\n");
      const after = contentVersion(fs.readFileSync(path.join(f.root, "note.txt")));
      expect(userText(third)).toContain(`[edit] completed: replaced one literal occurrence in note.txt; new version ${after}`);
      expect(anchor(third)).toBe(`Versões: note.txt@${after}`);
      expect(userText(third)).not.toContain("stale-version");
      const editSchema = second.tools.find((tool) => tool.function.name === "edit")?.function.parameters;
      expect(editSchema?.["oneOf"]).toHaveLength(4);
    } finally { await model.close(); await f.tasks.close(); f.db.close(); }
  });

  it("refuses a stale version without writing, retires it from the anchor, and recovers after a re-read", async () => {
    const f = fixture({ "note.txt": "ola mundo\n" });
    const file = path.join(f.root, "note.txt");
    let staleVersion = "";
    const model = await reactiveModel((body, turn) => {
      if (turn === 1 || turn === 3) return { toolCalls: [{ name: "read", args: { path: "note.txt" } }] };
      if (turn === 2) {
        staleVersion = observedVersion(body, "note.txt") ?? "";
        // Another writer changes the file after the model observed it.
        fs.writeFileSync(file, "ola mundo\nlinha externa\n");
        return { toolCalls: [{ name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: staleVersion, oldText: "ola", newText: "olá" } }] };
      }
      const version = observedVersion(body, "note.txt");
      if (turn === 4 && version !== undefined) return { toolCalls: [{ name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: version, oldText: "ola", newText: "olá" } }] };
      return { text: "done" };
    });
    try {
      await runTask(f, model);
      dumpEvidence("stale-recovery", model.bodies);
      expect(model.bodies).toHaveLength(5);
      const [, , afterStale, afterReread, final] = model.bodies;
      if (afterStale === undefined || afterReread === undefined || final === undefined) throw new Error("missing requests");
      const external = contentVersion(Buffer.from("ola mundo\nlinha externa\n"));
      expect(userText(afterStale)).toContain(`[edit] completed: replace refused: expected ${staleVersion} but observed ${external}; note.txt changed since it was read: read it again before editing`);
      expect(anchor(afterStale)).toBe("Versões: nenhuma registrada");
      expect(anchor(afterReread)).toBe(`Versões: note.txt@${external}`);
      expect(fs.readFileSync(file, "utf8")).toBe("olá mundo\nlinha externa\n");
      expect(userText(final)).toContain("replaced one literal occurrence in note.txt");
    } finally { await model.close(); await f.tasks.close(); f.db.close(); }
  });

  it("returns an invented version as invalid-args and leaves the file untouched", async () => {
    const f = fixture({ "note.txt": "ola mundo\n" });
    const model = await reactiveModel((_body, turn) => turn === 1
      ? { toolCalls: [{ name: "edit", args: { kind: "replace", path: "note.txt", expectedVersion: "v1", oldText: "ola", newText: "olá" } }] }
      : { text: "done" });
    try {
      await runTask(f, model);
      expect(userText(model.bodies[1] ?? { messages: [], tools: [] })).toContain(`expectedVersion "v1" is not a content version; read the file and copy its 'version sha256:<16 hex>'`);
      expect(fs.readFileSync(path.join(f.root, "note.txt"), "utf8")).toBe("ola mundo\n");
    } finally { await model.close(); await f.tasks.close(); f.db.close(); }
  });
});

describe("Versões anchor in the shared loop (CLI resume seeds it)", () => {
  it("replaces a seeded drift entry for the same path, keeps other seeds, and stays bounded", async () => {
    const files = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`f${index}.txt`, `${index}\n`]));
    const f = fixture({ "note.txt": "ola\n", ...files });
    const reads = ["./note.txt", ...Object.keys(files)].map((file) => ({ toolCalls: [{ name: "read", argumentsJson: JSON.stringify({ path: file }) }] }));
    const provider = new FakeProvider([...reads, { text: "done" }]);
    const contract = createContract({
      taskId: "task-f5", rootId: "root-f5", objective: "read files", scope: ["workspace"], acceptanceCriteria: ["response"], obligations: ["preserve human work"],
      grants: [{ subject: "agent", operations: ["read", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } }],
      prohibitions: ["publish"], realm: "local-trusted", allowedProvider: "fake", allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), retentionPolicy: "retain until explicit deletion", origin: "test",
    });
    const taskSurface: TaskSurface = { objective: "read files", acceptanceCriteria: ["response"], grants: ["read"], prohibitions: [], obligations: [], unknowns: [], humanDecisions: [], versions: ["note.txt@sha256:0000000000000000", "verify node --test: exit 0"], lastError: null };
    try {
      await runTaskLoop({ db: f.db.raw, provider, model: "fake-model-1", contract, sessionId: "s-f5", runId: "r-f5", taskSurface, tools: buildToolset(), toolContext: { workspaceRoot: f.root, realm: "local-trusted", timeoutMs: 5000 }, ownerGeneration: 1, grantedCalls: 50, grantedTokens: 200_000, maxIterations: 25 });
      const anchors = provider.requests.map((request) => /^Versões: .*$/m.exec(request.messages[0]?.content ?? "")?.[0]);
      expect(anchors[0]).toBe("Versões: note.txt@sha256:0000000000000000 | verify node --test: exit 0");
      expect(anchors[1]).toBe(`Versões: verify node --test: exit 0 | note.txt@${contentVersion(Buffer.from("ola\n"))}`);
      const last = anchors[anchors.length - 1] ?? "";
      expect(last.split(" | ").filter((entry) => entry.includes("@sha256:"))).toHaveLength(16);
      expect(last).not.toContain("note.txt@");
      expect(last).toContain(`f16.txt@${contentVersion(Buffer.from("16\n"))}`);
    } finally { await f.tasks.close(); f.db.close(); }
  });

  it("evicts by size so a long path can never push the anchor past the context limit", async () => {
    const long = `${"d".repeat(120)}/${"e".repeat(120)}`;
    const names = Array.from({ length: 10 }, (_, index) => `${long}/${index}.txt`);
    const f = fixture({});
    for (const name of names) { fs.mkdirSync(path.join(f.root, path.dirname(name)), { recursive: true }); fs.writeFileSync(path.join(f.root, name), "x\n"); }
    const provider = new FakeProvider([...names.map((name) => ({ toolCalls: [{ name: "read", argumentsJson: JSON.stringify({ path: name }) }] })), { text: "done" }]);
    const contract = createContract({
      taskId: "task-f5b", rootId: "root-f5b", objective: "read files", scope: ["workspace"], acceptanceCriteria: ["response"], obligations: ["preserve human work"],
      grants: [{ subject: "agent", operations: ["read", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } }],
      prohibitions: ["publish"], realm: "local-trusted", allowedProvider: "fake", allowedModel: "fake-model-1",
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(), retentionPolicy: "retain until explicit deletion", origin: "test",
    });
    const taskSurface: TaskSurface = { objective: "read files", acceptanceCriteria: ["response"], grants: ["read"], prohibitions: [], obligations: [], unknowns: [], humanDecisions: [], versions: [], lastError: null };
    try {
      await runTaskLoop({ db: f.db.raw, provider, model: "fake-model-1", contract, sessionId: "s-f5b", runId: "r-f5b", taskSurface, tools: buildToolset(), toolContext: { workspaceRoot: f.root, realm: "local-trusted", timeoutMs: 5000 }, ownerGeneration: 1, grantedCalls: 50, grantedTokens: 200_000, maxIterations: 15 });
      expect(provider.requests).toHaveLength(names.length + 1);
      const last = /^Versões: (.*)$/m.exec(provider.requests[names.length]?.messages[0]?.content ?? "")?.[1] ?? "";
      expect(last.length).toBeLessThanOrEqual(2_000);
      expect(last).toContain(`${names[9] ?? ""}@`);
      expect(last).not.toContain(`${names[0] ?? ""}@`);
    } finally { await f.tasks.close(); f.db.close(); }
  });
});
