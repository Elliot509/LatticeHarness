import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb } from "../../src/storage/db.js";
import { createContract } from "../../src/runtime/contract.js";
import { admitDurable, claimDurable, DuplicateReceiptError, recordReceiptDurable, taskBudgetSnapshot } from "../../src/runtime/effects.js";
import { runTaskLoop, type LoopOptions } from "../../src/runtime/loop.js";
import { FakeProvider, type FakeScriptStep } from "../../src/providers/fake.js";
import { armFault, clearFaults } from "../../src/runtime/faults.js";
import { buildToolset } from "../../src/tools/registry.js";

const dirs: string[] = [];
afterEach(() => { clearFaults(); for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

function fixture(steps: FakeScriptStep[] = [], tokens: number | null = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-sprint-accounting-")); dirs.push(dir);
  const opened = openLatticeDb(dir);
  const workspace = path.join(dir, "workspace"); fs.mkdirSync(workspace);
  const contract = createContract({ taskId: "t", rootId: "r", objective: "Inspect", scope: [workspace],
    acceptanceCriteria: ["observed"], obligations: ["preserve work"],
    grants: [{ subject: "agent", operations: ["model.invoke", "read", "edit"], targets: [workspace], expiresAt: null, limits: { maxCalls: null, maxTokens: tokens } }],
    prohibitions: [], realm: "local-trusted", allowedProvider: "fake", allowedModel: "m", expiresAt: null, retentionPolicy: "retain", origin: "sprint fixture" });
  const provider = new FakeProvider(steps);
  const options: LoopOptions = { db: opened.raw, contract, provider, model: "m", sessionId: "s", runId: "run", ownerGeneration: 1,
    grantedCalls: null, grantedTokens: tokens, tools: [], toolContext: { workspaceRoot: workspace, realm: "local-trusted" },
    taskSurface: { objective: contract.objective, acceptanceCriteria: contract.acceptanceCriteria, grants: ["read"], prohibitions: [], obligations: [], unknowns: [], humanDecisions: [], versions: [], lastError: null },
    acceptanceVerifiers: [() => ({ complete: true, reason: "fixture acceptance" })] };
  return { dir, workspace, opened, contract, provider, options };
}

describe("sprint accounting protocol", () => {
  it.each(["missing", "denied"])("stops repeated %s proposals before dispatch without imposing a total call cap", async (kind) => {
    const call = { name: kind === "missing" ? "no-such-tool" : "read", argumentsJson: '{"path":"../outside"}' };
    const f = fixture(Array.from({ length: 10 }, () => ({ toolCalls: [call] })));
    try {
      f.options.tools = buildToolset().filter(tool => tool.name === "read");
      expect(await runTaskLoop(f.options)).toMatchObject({ decision: "ASK", modelCalls: 5, toolDispatches: 0 });
      expect(taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: null }).settled.calls).toBe(5);
    } finally { f.opened.close(); }
  });

  it("allows failed arguments to be corrected on the next request", async () => {
    const f = fixture([{ toolCalls: [{ name: "read", argumentsJson: '{"path":"missing"}' }] }, { toolCalls: [{ name: "read", argumentsJson: '{"path":"exists"}' }] }, { text: "Inspected." }]);
    try {
      fs.writeFileSync(path.join(f.workspace, "exists"), "real content");
      f.options.tools = buildToolset().filter(tool => tool.name === "read");
      expect(await runTaskLoop(f.options)).toMatchObject({ decision: "STOP", modelCalls: 3, toolDispatches: 2 });
      // Surface-2: the corrected read's result arrives as a tool message.
      expect(f.provider.requests[2]?.messages.map((message) => message.content).join("\n")).toContain("real content");
    } finally { f.opened.close(); }
  });
  it("finishes productive work beyond 50 calls and 200k tokens with bounded recent context", async () => {
    const steps: FakeScriptStep[] = Array.from({ length: 60 }, (_, n) => ({ toolCalls: [{ name: "edit", argumentsJson: JSON.stringify({ kind: "create", path: `result-${n}`, content: `observed ${n}` }) }], usage: { inputTokens: 4500, outputTokens: 500 } }));
    steps.push({ text: "Verified", usage: { inputTokens: 4500, outputTokens: 500 } });
    const f = fixture(steps);
    try {
      f.options.tools = buildToolset().filter(tool => tool.name === "edit");
      f.options.contextChars = 3000;
      expect(await runTaskLoop(f.options)).toMatchObject({ decision: "STOP", modelCalls: 61, toolDispatches: 60 });
      expect(fs.readFileSync(path.join(f.workspace, "result-59"), "utf8")).toBe("observed 59");
      expect(taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: null }).settled.tokens).toBe(305_000);
      for (const request of f.provider.requests) {
        const chars = request.system.length + request.messages.reduce((sum, message) => sum + message.content.length + (message.toolCalls ?? []).reduce((calls, call) => calls + call.id.length + call.name.length + call.argumentsJson.length, 0), 0);
        expect(chars).toBeLessThanOrEqual(3000);
        // Bounded recent context never splits a call from its result.
        const ids = new Set(request.messages.flatMap((message) => (message.toolCalls ?? []).map((call) => call.id)));
        for (const message of request.messages) if (message.role === "tool") expect(ids.has(message.toolCallId ?? "")).toBe(true);
      }
      expect(f.provider.requests.at(-1)?.system).toContain("omitidos por limite");
    } finally { f.opened.close(); }
  });

  it("stops repeated equivalent probes but permits the same probe after a state change beyond the rendered prefix", async () => {
    const step = { toolCalls: [{ name: "read", argumentsJson: '{"path":"probe"}' }], usage: { inputTokens: 10, outputTokens: 5 } };
    const f = fixture(Array.from({ length: 12 }, () => step));
    try {
      const prefix = "same prefix\n".repeat(500);
      fs.writeFileSync(path.join(f.workspace, "probe"), prefix + "before");
      f.options.tools = buildToolset().filter(tool => tool.name === "read");
      f.options.beforeRequest = () => { if (f.provider.requests.length === 2) fs.writeFileSync(path.join(f.workspace, "probe"), prefix + "changed"); };
      const stop = await runTaskLoop(f.options);
      expect(stop).toMatchObject({ decision: "ASK", toolDispatches: 7 });
      expect(stop.reason).toContain("no progress");
      expect(fs.readFileSync(path.join(f.workspace, "probe"), "utf8")).toContain("changed");
    } finally { f.opened.close(); }
  });
  it.each([null, 200_000, 4000])("persists 4387 against a 4000 estimate and enforces the actual cap %s", (cap) => {
    const f = fixture([], cap);
    try {
      const granted = { calls: null, tokens: cap };
      const attempt = admitDurable(f.opened.raw, f.contract, { taskId: "t", operation: "model.invoke", target: "fake/m", actionKey: "a", authorityRevision: 1, maxCalls: 1, maxTokens: 4000, argsJson: "{}" }, granted, 1);
      expect(attempt.admitted).toBe(true); if (!attempt.admitted) throw new Error("not admitted");
      expect(claimDurable(f.opened.raw, attempt.attemptId, 1, 1, { contract: f.contract })).toEqual({ claimed: true });
      const receipt = { attemptId: attempt.attemptId, outcome: "confirmed" as const, summary: "responded", detailJson: "{}", settledCalls: 1, settledTokens: 4387 };
      recordReceiptDurable(f.opened.raw, receipt);
      expect(taskBudgetSnapshot(f.opened.raw, "t", granted)).toMatchObject({ settled: { calls: 1, tokens: 4387 }, reserved: { calls: 0, tokens: 0 } });
      expect(() => recordReceiptDurable(f.opened.raw, receipt)).toThrow(DuplicateReceiptError);
      expect(taskBudgetSnapshot(f.opened.raw, "t", granted).settled.tokens).toBe(4387);
      const next = admitDurable(f.opened.raw, f.contract, { taskId: "t", operation: "model.invoke", target: "fake/m", actionKey: "b", authorityRevision: 1, maxCalls: 1, maxTokens: 1, argsJson: "{}" }, granted, 1);
      expect(next.admitted).toBe(cap !== 4000);
    } finally { f.opened.close(); }
  });

  it("a fresh loop settles the Muse usage without a false budget block", async () => {
    const f = fixture([{ text: "Observed", usage: { inputTokens: 3604, outputTokens: 783, inclusiveInput: true } }], 200_000);
    try {
      expect(await runTaskLoop(f.options)).toMatchObject({ decision: "STOP", modelCalls: 1 });
      expect(taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: 200_000 }).settled.tokens).toBe(4387);
      expect(f.opened.raw.prepare("SELECT state FROM attempts").get()).toMatchObject({ state: "RESOLVED" });
    } finally { f.opened.close(); }
  });

  it("records real cap overage before blocking further effects", async () => {
    const f = fixture([{ text: "response retained", usage: { inputTokens: 3604, outputTokens: 783, inclusiveInput: true } }], 4000);
    try {
      expect(await runTaskLoop(f.options)).toMatchObject({ decision: "ESCALATE", modelCalls: 1 });
      expect(taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: 4000 }).settled.tokens).toBe(4387);
      expect(f.opened.raw.prepare("SELECT COUNT(*) AS n FROM receipts").get()).toMatchObject({ n: 1 });
    } finally { f.opened.close(); }
  });

  it.each([null, { inputTokens: 9000, inclusiveInput: true }])("holds unknown consumption instead of inventing zero: %j", async (usage) => {
    const f = fixture([{ text: "observed", usage }]);
    try {
      await runTaskLoop(f.options);
      const snapshot = taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: null });
      expect(snapshot.reserved.tokens).toBeGreaterThan(0);
      expect(snapshot.settled.tokens).toBe(usage === null ? 0 : 9000);
      const doc = f.opened.raw.prepare("SELECT document FROM attempt_usage").get() as { document: string };
      expect(JSON.parse(doc.document).usageFinal).toBe(false);
    } finally { f.opened.close(); }
  });

  it("timeout leaves UNKNOWN and its reserve across reopen, without retry", async () => {
    const f = fixture([{ failWith: "timeout" }, { text: "must not run" }]);
    expect(await runTaskLoop(f.options)).toMatchObject({ decision: "ESCALATE", modelCalls: 1 });
    expect(f.provider.requests).toHaveLength(1);
    f.opened.close();
    const reopened = openLatticeDb(f.dir);
    try {
      expect(reopened.raw.prepare("SELECT state FROM attempts").get()).toMatchObject({ state: "UNKNOWN" });
      expect(taskBudgetSnapshot(reopened.raw, "t", { calls: null, tokens: null }).reserved.tokens).toBeGreaterThan(0);
    } finally { reopened.close(); }
  });

  it("receipt failure cannot leave usage committed separately", async () => {
    const f = fixture([{ text: "observed", usage: { inputTokens: 3604, outputTokens: 783 } }]);
    armFault("before-receipt-commit");
    try {
      await expect(runTaskLoop(f.options)).rejects.toThrow("injected fault");
      expect(f.opened.raw.prepare("SELECT COUNT(*) AS n FROM attempt_usage").get()).toMatchObject({ n: 0 });
      expect(f.opened.raw.prepare("SELECT state FROM attempts").get()).toMatchObject({ state: "CLAIMED" });
      expect(taskBudgetSnapshot(f.opened.raw, "t", { calls: null, tokens: null }).reserved.tokens).toBeGreaterThan(0);
    } finally { f.opened.close(); }
  });
});
