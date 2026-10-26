import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { openLatticeDb, type LatticeDb } from "../../src/storage/db.js";
import { FutureSchemaError, V1_SCHEMA_SQL, readSchemaVersion } from "../../src/storage/schema.js";
import { latticeDbPath } from "../../src/platform/paths.js";

let dirs: string[] = [];
let openHandles: LatticeDb[] = [];
afterEach(() => {
  for (const handle of openHandles) {
    try {
      handle.close();
    } catch {
      // Cleanup is best effort; the assertions already ran.
    }
  }
  openHandles = [];
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

// Builds a genuine previous-version database: the v1 DDL straight from the
// schema module, stamped as version 1, with a contract and run inside.
function buildV1Database(dataDir: string): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const raw = new DatabaseSync(latticeDbPath(dataDir));
  try {
    raw.exec(V1_SCHEMA_SQL);
    raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '1')").run();
    raw.prepare("INSERT INTO contracts (task_id, root_id, revision, document, updated_at) VALUES (?, ?, ?, ?, ?)").run(
      "task-old",
      "root-old",
      1,
      JSON.stringify({ taskId: "task-old", objective: "old work", revision: 1 }),
      new Date().toISOString(),
    );
    raw.prepare("INSERT INTO runs (run_id, session_id, root_id, task_id, manifest, created_at) VALUES (?, ?, ?, ?, ?, ?)").run(
      "run-old",
      "session-old",
      "root-old",
      "task-old",
      JSON.stringify({ packageVersion: "0.0.0" }),
      new Date().toISOString(),
    );
  } finally {
    raw.close();
  }
}

describe("storage upgrade", () => {
  it("migrates a v1 database automatically with sessions preserved", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-migrate-"));
    dirs.push(dir);
    const dataDir = path.join(dir, "data");
    buildV1Database(dataDir);
    const opened = openLatticeDb(dataDir);
    openHandles.push(opened);
    expect(readSchemaVersion(opened.raw)).toBe(4);
    const contract = opened.raw.prepare("SELECT document FROM contracts WHERE task_id = 'task-old'").get() as { document: string };
    expect(JSON.parse(contract.document)).toMatchObject({ objective: "old work" });
    const run = opened.raw.prepare("SELECT session_id FROM runs WHERE task_id = 'task-old'").get() as { session_id: string };
    expect(run.session_id).toBe("session-old");
    for (const table of ["waits", "wake_events", "pending_revisions", "composition_epochs"]) {
      const found = opened.raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) as { name: string } | undefined;
      expect(found?.name).toBe(table);
    }
  });

  it("refuses a future schema without touching it", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-migrate-"));
    dirs.push(dir);
    const dataDir = path.join(dir, "data");
    fs.mkdirSync(dataDir, { recursive: true });
    const raw = new DatabaseSync(latticeDbPath(dataDir));
    try {
      raw.exec(V1_SCHEMA_SQL);
      raw.prepare("INSERT INTO meta (key, value) VALUES ('schema_version', '99')").run();
    } finally {
      raw.close();
    }
    expect(() => openLatticeDb(dataDir)).toThrow(FutureSchemaError);
  });
});
