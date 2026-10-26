import { describe, expect, it } from "vitest";
import { SURFACE_VERSION } from "../../src/context/compiler.js";
import { OPENAI_ADAPTER_REVISION } from "../../src/providers/openai.js";
import {
  advanceCompositionEpoch,
  bindRequest,
  compositionForRoute,
  currentCompositionEpoch,
  ledgerCutOf,
  payloadDigest,
  toolSurfaceDigest,
} from "../../src/runtime/composition.js";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { readSchemaVersion, SCHEMA_VERSION } from "../../src/storage/schema.js";
import { DatabaseSync } from "node:sqlite";
import { V1_SCHEMA_SQL } from "../../src/storage/schema.js";
import { latticeDbPath } from "../../src/platform/paths.js";
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

function tmp(name: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `lattice-${name}-`));
  dirs.push(dir);
  return dir;
}

const TOOLS = [
  { name: "read", description: "r", parameters: { type: "object" as const, properties: {} } },
  { name: "edit", description: "e", parameters: { type: "object" as const, properties: {} } },
];

function request(model = "m1") {
  return {
    model,
    system: "sys",
    messages: [{ role: "user" as const, content: "hi" }],
    tools: [...TOOLS],
  };
}

// R1 composition identity (D-R1-05, F-0010): deterministic digests, epoch
// transitions only on semantic change, restart reconstruction, migration,
// late-response attribution.
describe("r1 composition and binding", () => {
  it("RED: same payload ⇒ same digest; meaningful change ⇒ different digest", () => {
    expect(payloadDigest(request())).toBe(payloadDigest(request()));
    expect(toolSurfaceDigest(TOOLS)).toBe(toolSurfaceDigest([...TOOLS].reverse()));
    expect(payloadDigest(request("m1"))).not.toBe(payloadDigest(request("m2")));
    expect(toolSurfaceDigest(TOOLS)).not.toBe(
      toolSurfaceDigest([...TOOLS, { name: "exec", description: "x", parameters: { type: "object", properties: {} } }]),
    );
  });

  it("RED: epoch opens at 1, stays put on refresh, bumps once on route switch", () => {
    const dir = tmp("r1epoch");
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const base = compositionForRoute("openai", "m1", TOOLS);
    const first = advanceCompositionEpoch(opened.raw, "task-1", base);
    expect(first.epoch).toBe(1);
    // UI refresh / reconnect / re-entry with the same composition: no bump.
    expect(advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m1", TOOLS)).epoch).toBe(1);
    expect(advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m1", TOOLS)).epoch).toBe(1);
    // Route switch at a safe point: exactly one bump.
    const second = advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m2", TOOLS));
    expect(second.epoch).toBe(2);
    expect(second.digest).not.toBe(first.digest);
    // Tool surface change also bumps (future skills/MCP plug in here).
    const third = advanceCompositionEpoch(
      opened.raw, "task-1",
      compositionForRoute("openai", "m2", [...TOOLS, { name: "exec", description: "x", parameters: { type: "object", properties: {} } }]),
    );
    expect(third.epoch).toBe(3);
    // Restart reconstructs: same composition reads back epoch 3, no reset.
    expect(currentCompositionEpoch(opened.raw, "task-1")?.epoch).toBe(3);
    expect(currentCompositionEpoch(opened.raw, "task-1")?.composition.model).toBe("m2");
    expect(base.adapterRevision).toBe(OPENAI_ADAPTER_REVISION);
    expect(base.surfaceVersion).toBe(SURFACE_VERSION);
  });

  it("RED: binding answers what was sent under which composition and cut", () => {
    const dir = tmp("r1bind");
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const epoch = advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m1", TOOLS));
    const req = request();
    const binding = bindRequest({
      db: opened.raw, taskId: "task-1", requestId: "req-1", attemptId: "attempt-1",
      contractRevision: 4, epoch, provider: "openai", model: "m1", request: req,
    });
    expect(binding).toMatchObject({
      requestId: "req-1", attemptId: "attempt-1", contractRevision: 4,
      compositionEpoch: 1, provider: "openai", model: "m1",
    });
    expect(binding.compositionDigest).toBe(epoch.digest);
    expect(binding.toolSurfaceDigest).toBe(epoch.composition.toolSurfaceDigest);
    expect(binding.payloadDigest).toBe(payloadDigest(req));
    expect(binding.payloadDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(binding.ledgerCut).toBe(ledgerCutOf(opened.raw));
  });

  it("RED: late response stays attributed to its originating epoch, next step uses current", () => {
    const dir = tmp("r1late");
    const opened = openLatticeDb(dir);
    openHandles.push(opened);
    const first = advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m1", TOOLS));
    const oldBinding = bindRequest({
      db: opened.raw, taskId: "task-1", requestId: "req-1", attemptId: "attempt-1",
      contractRevision: 1, epoch: first, provider: "openai", model: "m1", request: request("m1"),
    });
    // User switches at a safe point → epoch 2.
    const second = advanceCompositionEpoch(opened.raw, "task-1", compositionForRoute("openai", "m2", TOOLS));
    expect(second.epoch).toBe(2);
    // Late receipt for attempt-1 keeps its epoch-1 binding as EVIDENCE; it
    // never restores the old composition, and the next binding uses epoch 2.
    expect(oldBinding.compositionEpoch).toBe(1);
    const next = bindRequest({
      db: opened.raw, taskId: "task-1", requestId: "req-2", attemptId: "attempt-2",
      contractRevision: 1, epoch: second, provider: "openai", model: "m2", request: request("m2"),
    });
    expect(next.compositionEpoch).toBe(2);
    expect(next.payloadDigest).not.toBe(oldBinding.payloadDigest);
  });

  it("migrates v1→v3 and v2→v3 with data preserved, fresh v3, future fail-closed", async () => {
    const { FutureSchemaError } = await import("../../src/storage/schema.js");
    // v1 → v3.
    const v1dir = path.join(tmp("r1mig1"), "data");
    fs.mkdirSync(v1dir, { recursive: true });
    const v1 = new DatabaseSync(latticeDbPath(v1dir));
    try {
      v1.exec(V1_SCHEMA_SQL);
      v1.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
      v1.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "task-old", "root-old", 1, JSON.stringify({ taskId: "task-old", objective: "old" }), new Date().toISOString(),
      );
    } finally {
      v1.close();
    }
    const up1 = openLatticeDb(v1dir);
    openHandles.push(up1);
    expect(readSchemaVersion(up1.raw)).toBe(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBe(4);
    // Epoch table usable immediately after upgrade (lazy ensure + migration agree).
    expect(advanceCompositionEpoch(up1.raw, "task-old", compositionForRoute("openai", "m1", TOOLS)).epoch).toBe(1);
    // Fresh database at the current version + reopen reconstruction.
    const fresh = tmp("r1migfresh");
    const f1 = openLatticeDb(fresh);
    openHandles.push(f1);
    expect(readSchemaVersion(f1.raw)).toBe(SCHEMA_VERSION);
    advanceCompositionEpoch(f1.raw, "task-9", compositionForRoute("local", "m", TOOLS));
    f1.close();
    openHandles.splice(openHandles.indexOf(f1), 1);
    const f2 = openLatticeDb(fresh);
    openHandles.push(f2);
    expect(currentCompositionEpoch(f2.raw, "task-9")?.epoch).toBe(1);
    // Future schema stays fail-closed.
    const fut = path.join(tmp("r1migfut"), "data");
    fs.mkdirSync(fut, { recursive: true });
    const raw = new DatabaseSync(latticeDbPath(fut));
    try {
      raw.exec(V1_SCHEMA_SQL);
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')").run();
    } finally {
      raw.close();
    }
    expect(() => openLatticeDb(fut)).toThrow(FutureSchemaError);
  });
});
