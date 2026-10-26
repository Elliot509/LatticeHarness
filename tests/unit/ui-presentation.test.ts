import { describe, expect, it } from "vitest";
import { taskActivity, taskStateDescription, toolSummaryPreview } from "../../src/ui/presentation.js";
import type { TaskSnapshot, TaskState } from "../../src/server/protocol.js";

function snapshot(overrides: Partial<TaskSnapshot> = {}): TaskSnapshot {
  return {
    protocol: "ui-1",
    taskId: "task-1",
    rootId: "root-1",
    workspace: "/workspace",
    objective: "Fix the task",
    acceptanceCriteria: [],
    state: "RUNNING",
    stateReason: "",
    contractRevision: 1,
    provider: "openai",
    model: "m1",
    baseUrl: null,
    keyConfigured: true,
    unknowns: 0,
    unknownHistory: [],
    waits: [],
    resumable: false,
    resumeBlockers: [],
    budget: { grantedCalls: 50, grantedTokens: 200000, reservedCalls: 0, reservedTokens: 0, settledCalls: 0, settledTokens: 0 },
    contextUsage: { known: false },
    messages: [],
    tools: [],
    verifications: [],
    steering: [],
    cut: 0,
    ...overrides,
  };
}

describe("ui presentation", () => {
  it("merges projected activity into sequence order without changing entries", () => {
    const task = snapshot({
      messages: [{ id: "message-4", seq: 4, author: "agent", text: "done", recordedAt: "2026-09-13T10:00:04Z" }],
      tools: [{ id: "tool-2", seq: 2, tool: "read", target: "src/a.ts", status: "completed", summary: "read", detail: null, version: null, complete: true, truncated: false, durationMs: 2, recordedAt: "2026-09-13T10:00:02Z" }],
      verifications: [{ id: "verify-3", seq: 3, command: "npm test", cwd: "/workspace", exitCode: 0, countsKnown: true, passed: 1, failed: 0, skipped: 0, recordedAt: "2026-09-13T10:00:03Z" }],
      steering: [{ id: "steer-1", seq: 1, text: "keep scope", mode: "guide", state: "applied", expectedRevision: 1, appliedRevision: 2, recordedAt: "2026-09-13T10:00:01Z" }],
    });

    expect(taskActivity(task).map((item) => [item.seq, item.kind])).toEqual([
      [1, "steering"],
      [2, "tool"],
      [3, "verification"],
      [4, "message"],
    ]);
  });

  it("uses the runtime reason when one is present", () => {
    expect(taskStateDescription(snapshot({ state: "BLOCKED", stateReason: "credential missing" }))).toBe("credential missing");
  });

  it("keeps edit evidence out of the default summary without discarding it", () => {
    const summary = toolSummaryPreview({
      id: "edit-1",
      seq: 1,
      tool: "edit",
      target: "src/a.ts",
      status: "completed",
      summary: "[edit] completed: replaced one occurrence {\"beforePreview\":\"large retained value\"}",
      detail: null,
      version: null,
      complete: true,
      truncated: false,
      durationMs: 1,
      recordedAt: "2026-09-13T10:00:00Z",
    });

    expect(summary).toEqual({ text: "[edit] completed: replaced one occurrence", shortened: true });
  });

  it("caps long unstructured summaries at a word boundary", () => {
    const summary = toolSummaryPreview({
      id: "search-1",
      seq: 1,
      tool: "search",
      target: "query",
      status: "completed",
      summary: "one two three four five six seven eight nine ten",
      detail: null,
      version: null,
      complete: true,
      truncated: false,
      durationMs: 1,
      recordedAt: "2026-09-13T10:00:00Z",
    }, 24);

    expect(summary).toEqual({ text: "one two three four...", shortened: true });
  });

  it.each([
    ["READY", ""],
    ["RUNNING", ""],
    ["WAITING", "Execução pausada até a condição registrada mudar."],
    ["NEEDS_INPUT", "A tarefa precisa de uma decisão antes de continuar."],
    ["BLOCKED", "A execução não pode continuar nas restrições atuais."],
    ["COMPLETED", "A tarefa chegou a um resultado final."],
    ["CANCELLED", "A execução foi interrompida. Efeitos concluídos e incertos continuam visíveis."],
  ] satisfies Array<[TaskState, string]>) ("describes %s without inventing runtime detail", (state, description) => {
    expect(taskStateDescription(snapshot({ state }))).toBe(description);
  });
});

describe("one event, one row", () => {
  it("renders a message that is also a steering record only once", async () => {
    const { taskActivity: activity } = await import("../../src/ui/presentation.js");
    const base = { protocol: "ui-1" as const, taskId: "t", rootId: "r", workspace: "/w", objective: "o", acceptanceCriteria: [], state: "RUNNING" as const, stateReason: "", contractRevision: 2, provider: "p", model: "m", baseUrl: null, keyConfigured: true, unknowns: 0, unknownHistory: [], waits: [], resumable: false, resumeBlockers: [], budget: { grantedCalls: null, grantedTokens: null, reservedCalls: 0, reservedTokens: 0, settledCalls: 0, settledTokens: 0 }, contextUsage: { known: false as const }, tools: [], verifications: [], cut: 3 };
    const items = activity({ ...base,
      messages: [{ id: "msg-cmd-1", seq: 2, author: "user", text: "também confira o limite", recordedAt: "x" }],
      steering: [
        { id: "msg-cmd-1", seq: 3, text: "também confira o limite", mode: "guide", state: "applied", expectedRevision: 1, appliedRevision: 2, recordedAt: "x" },
        { id: "steer-legacy", seq: 1, text: "orientação antiga sem mensagem", mode: "guide", state: "applied", expectedRevision: 1, appliedRevision: 2, recordedAt: "x" },
      ] });
    expect(items.map((item) => `${item.kind}:${item.value.id}`)).toEqual(["steering:steer-legacy", "message:msg-cmd-1"]);
  });

  it("places a human approval decision in ledger order, between the message and the action it released", async () => {
    const { taskActivity: activity } = await import("../../src/ui/presentation.js");
    const items = activity(snapshot({
      messages: [{ id: "m1", seq: 1, author: "agent", text: "Vou executar.", recordedAt: "x" }],
      tools: [{ id: "a1", seq: 5, tool: "exec", target: "", status: "completed", summary: "ok", startedAt: "x", endedAt: "x" } as unknown as TaskSnapshot["tools"][number]],
      approvalHistory: [{ id: "approval-3", key: "k", seq: 3, tool: "exec", description: "executar: ls", decision: "approved", note: null, recordedAt: "x" }],
    }));
    expect(items.map((item) => `${item.kind}:${item.value.id}`)).toEqual(["message:m1", "approval:approval-3", "tool:a1"]);
  });
});

describe("criterion labels (PG-025)", () => {
  it.each([
    ["directory-exists:TesteMuse", "a pasta “TesteMuse” existe no projeto"],
    ["file-exists:src/a.txt", "o arquivo “src/a.txt” existe no projeto"],
    ["directory-listing:files:recursive:.", "listagem completa dos arquivos de “projeto”, incluindo subpastas"],
    ["directory-listing:all:immediate:docs", "listagem completa das entradas de “docs”"],
    ["response", "uma resposta do agente"],
    ["tests-pass", "testes do projeto passando, observados pelo Lattice"],
    ["unverified", "sua revisão (sem verificação automática)"],
    ["clarification-required", "um critério mais claro (pedido ambíguo)"],
    ["custom:thing", "custom:thing"],
  ])("labels %s in product language", async (criterion, label) => {
    const { criterionLabel } = await import("../../src/ui/presentation.js");
    expect(criterionLabel(criterion)).toBe(label);
  });
});
