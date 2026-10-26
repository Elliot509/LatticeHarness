import { describe, expect, it } from "vitest";
import {
  compileConversation,
  ContextOverflowError,
  KERNEL,
  SURFACE_VERSION,
  type TaskSurface,
} from "../../src/context/compiler.js";
import type { ConversationTurn } from "../../src/runtime/conversation.js";

function task(): TaskSurface {
  return {
    objective: "Fix the off-by-one",
    acceptanceCriteria: ["relevant test passes"],
    grants: ["read, edit under workspace"],
    prohibitions: ["publish"],
    obligations: ["preserve baseline"],
    unknowns: [],
    humanDecisions: [],
    versions: ["src/a.ts@abc"],
    lastError: null,
  };
}

const user = (seq: number, text: string): ConversationTurn => ({ kind: "user", seq, text, taskId: "t" });
const assistant = (seq: number, text: string, calls: Array<{ id: string; name?: string; args?: string }> = []): ConversationTurn => ({
  kind: "assistant", seq, text, taskId: "t",
  toolCalls: calls.map((call) => ({ id: call.id, name: call.name ?? "read", argumentsJson: call.args ?? "{}" })),
});
const tool = (seq: number, id: string, content: string): ConversationTurn => ({ kind: "tool", seq, toolCallId: id, name: "read", content, taskId: "t" });

describe("conversation compiler", () => {
  it("puts every anchor in the system message after the kernel", () => {
    const surface = compileConversation(task(), [user(1, "Fix it")], { maxChars: 100_000 });
    expect(surface.system.startsWith(KERNEL)).toBe(true);
    for (const anchor of ["Fix the off-by-one", "relevant test passes", "read, edit under workspace", "publish", "preserve baseline", "src/a.ts@abc"]) {
      expect(surface.system).toContain(anchor);
    }
    expect(surface.anchorCount).toBe(8);
    expect(surface.surfaceVersion).toBe(SURFACE_VERSION);
    expect(surface.messages).toEqual([{ role: "user", content: "Fix it" }]);
  });

  it("includes the discriminating error and unknowns when present", () => {
    const surface = compileConversation({ ...task(), unknowns: ["edit receipt pending"], lastError: "test failed: expected 2 got 3" }, [user(1, "go")], { maxChars: 100_000 });
    expect(surface.system).toContain("edit receipt pending");
    expect(surface.system).toContain("expected 2 got 3");
    expect(surface.anchorCount).toBe(9);
  });

  it("emits assistant tool calls followed by their correlated results", () => {
    const surface = compileConversation(task(), [
      user(1, "Read a.ts"),
      assistant(2, "", [{ id: "c1" }, { id: "c2", name: "search" }]),
      tool(3, "c2", "search result"),
      tool(4, "c1", "read result"),
      assistant(5, "Done."),
    ], { maxChars: 100_000 });
    expect(surface.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool", "tool", "assistant"]);
    expect(surface.messages[1]?.toolCalls?.map((call) => call.id)).toEqual(["c1", "c2"]);
    expect(surface.messages.slice(2, 4).map((message) => [message.toolCallId, message.content])).toEqual([["c1", "read result"], ["c2", "search result"]]);
  });

  it("answers a call left without result explicitly and drops orphan results", () => {
    const surface = compileConversation(task(), [user(1, "go"), assistant(2, "", [{ id: "c1" }]), tool(3, "ghost", "orphan")], { maxChars: 100_000 });
    expect(surface.messages.map((message) => message.role)).toEqual(["user", "assistant", "tool"]);
    expect(surface.messages[2]).toMatchObject({ toolCallId: "c1" });
    expect(surface.messages[2]?.content).toContain("Sem resultado registrado");
    expect(JSON.stringify(surface.messages)).not.toContain("orphan");
  });

  it("omits the oldest middle groups whole, keeps the opening request and says so", () => {
    const turns: ConversationTurn[] = [user(1, "Opening request")];
    for (let index = 0; index < 20; index += 1) {
      turns.push(assistant(10 + index * 2, "", [{ id: `c${index}` }]), tool(11 + index * 2, `c${index}`, `${index}:${"x".repeat(800)}`));
    }
    const surface = compileConversation(task(), turns, { maxChars: 6_000 });
    expect(surface.messages[0]).toEqual({ role: "user", content: "Opening request" });
    expect(surface.turnsOmitted).toBeGreaterThan(0);
    expect(surface.system).toContain("omitidos por limite de contexto");
    expect(surface.chars).toBeLessThanOrEqual(6_000);
    // Pairs never split: every tool message follows its assistant call.
    const ids = new Set<string>();
    for (const message of surface.messages) {
      if (message.role === "assistant") for (const call of message.toolCalls ?? []) ids.add(call.id);
      if (message.role === "tool") expect(ids.has(message.toolCallId ?? "")).toBe(true);
    }
    // The newest exchange survives.
    expect(JSON.stringify(surface.messages)).toContain("19:");
  });

  it("shrinks the newest results instead of dropping the answer to the latest calls", () => {
    const surface = compileConversation(task(), [user(1, "go"), assistant(2, "", [{ id: "big" }]), tool(3, "big", "y".repeat(20_000))], { maxChars: 4_000 });
    expect(surface.messages.at(-1)?.content).toContain("resultado reduzido");
    expect(surface.chars).toBeLessThanOrEqual(4_000);
  });

  it("merges adjacent user-role messages for strict-alternation templates", () => {
    const surface = compileConversation(task(), [user(1, "first"), { kind: "runtime", seq: 2, text: "resumed", taskId: "t" }, user(3, "second")], { maxChars: 100_000 });
    expect(surface.messages).toHaveLength(1);
    expect(surface.messages[0]?.content).toContain("first");
    expect(surface.messages[0]?.content).toContain("[Observação do Lattice] resumed");
    expect(surface.messages[0]?.content).toContain("second");
  });

  it("refuses to call the model when anchors alone overflow", () => {
    expect(() => compileConversation(task(), [], { maxChars: 10 })).toThrow(ContextOverflowError);
    try {
      compileConversation(task(), [], { maxChars: 10 });
      expect.unreachable();
    } catch (error) {
      expect((error as ContextOverflowError).message).toContain("obligations omitted");
    }
  });
});
