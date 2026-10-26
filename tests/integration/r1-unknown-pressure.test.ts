import { describe, expect, it } from "vitest";
import { compileConversation, type TaskSurface } from "../../src/context/compiler.js";
import { unknownHistory } from "../../src/runtime/continuity.js";
import { createContract } from "../../src/runtime/contract.js";
import {
  admitDurable,
  claimDurable,
  recordReceiptDurable,
} from "../../src/runtime/effects.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach } from "vitest";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Best effort.
    }
  }
  openHandles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// R1 §31A: UNKNOWN under context pressure. An operational UNKNOWN plus a
// flood of evidence up to the limit must resolve ONE of two ways:
// (A) the UNKNOWN becomes a mandatory anchor and survives, or (B) the
// compiler/loop refuses to call the model when the required UNKNOWN does
// not fit. FORBIDDEN: calling the model without the relevant UNKNOWN.
describe("r1 unknown under context pressure", () => {
  it("keeps operational UNKNOWN in the mandatory anchors under evidence flood", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-r1ctx-"));
    dirs.push(dir);
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const contract = createContract({
      taskId: "task-1",
      rootId: "root-1",
      objective: "Edit with recovery",
      scope: ["workspace"],
      acceptanceCriteria: ["file updated"],
      obligations: ["preserve baseline"],
      grants: [
        { subject: "agent", operations: ["edit", "model.invoke"], targets: ["workspace"], expiresAt: null, limits: { maxCalls: 50, maxTokens: 200000 } },
      ],
      prohibitions: [],
      realm: "local-trusted",
      allowedProvider: null,
      allowedModel: null,
      expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "r1",
    });
    const admitted = admitDurable(
      opened.raw, contract,
      { taskId: "task-1", operation: "edit", target: "workspace/a.txt", actionKey: "r1-ctx", authorityRevision: 1, maxCalls: 0, maxTokens: 0, argsJson: "{}" },
      { calls: 50, tokens: 200000 }, 1,
    );
    expect(admitted.admitted).toBe(true);
    if (!admitted.admitted) return;
    expect(claimDurable(opened.raw, admitted.attemptId, 1, 1, { contract })).toEqual({ claimed: true });
    recordReceiptDurable(opened.raw, {
      attemptId: admitted.attemptId, outcome: "unknown", summary: "edit effect uncertain",
      detailJson: "{}", settledCalls: 0, settledTokens: 0,
    });
    const unknowns = unknownHistory(opened.raw, "task-1");
    expect(unknowns).toHaveLength(1);

    // Build the task surface exactly as the loop would: unknowns anchor.
    const surface: TaskSurface = {
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      grants: ["edit, model.invoke under workspace"],
      prohibitions: [],
      obligations: [...contract.obligations],
      unknowns: unknowns.map((entry) => `${entry.operation} ${entry.target ?? ""} (${entry.attemptId}): ${entry.reason}`.trim()),
      humanDecisions: [],
      versions: [],
      lastError: null,
    };
    // Flood the exchange to the limit: anchors must survive, turns drop.
    const flood = Array.from({ length: 200 }, (_, i) => ({ kind: "runtime" as const, seq: i, text: "x".repeat(500), taskId: "task-1" }));
    const compiled = compileConversation(surface, [{ kind: "user", seq: -1, text: "go", taskId: "task-1" }, ...flood], { maxChars: 4000 });
    expect(compiled.system).toContain("edit effect uncertain");
    expect(compiled.system).toContain(admitted.attemptId);
    expect(compiled.turnsOmitted).toBeGreaterThan(0);
    // And when even the anchors do not fit, the compiler refuses (path B).
    expect(() => compileConversation(surface, [], { maxChars: 10 })).toThrow();
  });
});
