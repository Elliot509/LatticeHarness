import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb, OwnershipHeldError } from "../../src/storage/db.js";
import { FutureSchemaError, MigrationError, readSchemaVersion, SCHEMA_VERSION } from "../../src/storage/schema.js";
import { latticeDbPath } from "../../src/platform/paths.js";
import { TaskManager } from "../../src/server/tasks.js";

// Version compatibility between runtimes sharing one data folder. v4 is the
// generation that records confirmation policy, approvals and INTERRUPTED;
// every shipped v3 runtime refuses a newer schema before touching the
// database, which is what keeps it out of an upgraded folder. The real v3
// binaries are exercised separately (private evidence); here the current
// runtime's half of the contract is pinned.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

function dataDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-compat-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  return path.join(dir, "data");
}

// A physically faithful v3 database: v4 only adds an index and a meta note,
// so removing both and stamping version 3 is exactly what a v3 runtime wrote.
function asV3(dir: string): void {
  const raw = new DatabaseSync(latticeDbPath(dir));
  try {
    raw.exec("DROP INDEX IF EXISTS events_task_kind; DELETE FROM meta WHERE key = 'compatibility'; UPDATE meta SET value = '3' WHERE key = 'schema_version'");
  } finally { raw.close(); }
}

// Content of every row of every table except meta, for preservation checks.
function contentDigest(dir: string): Record<string, string> {
  const raw = new DatabaseSync(latticeDbPath(dir), { readOnly: true });
  try {
    const tables = (raw.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name != 'meta' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
    return Object.fromEntries(tables.map((table) => [table, createHash("sha256").update(JSON.stringify(raw.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all())).digest("hex")]));
  } finally { raw.close(); }
}

function meta(dir: string, key: string): string | undefined {
  const raw = new DatabaseSync(latticeDbPath(dir), { readOnly: true });
  try { return (raw.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined)?.value; } finally { raw.close(); }
}

async function populated(dir: string): Promise<string> {
  const db = openLatticeDb(dir);
  claimOwnership(db.raw);
  const tasks = new TaskManager(db.raw, path.dirname(dir));
  const created = tasks.handleCommand({ commandId: "c1", kind: "create-task", payload: { workspace: "", objective: "Explique", provider: "local", model: "m", baseUrl: "http://127.0.0.1:9/v1", approval: "confirm-mutations" } });
  if (!created.accepted) throw new Error("create refused");
  db.raw.prepare("INSERT INTO events (kind, task_id, payload, recorded_at) VALUES ('approval.requested', ?, ?, ?)").run(created.taskId, JSON.stringify({ key: "k", tool: "exec", argsJson: "{}", toolCallId: "x1", runId: "r", revision: 1 }), new Date().toISOString());
  await tasks.close();
  db.close();
  return created.taskId;
}

describe("schema v4 compatibility generation", () => {
  it("creates a fresh folder at v4 with the generation note and the per-task event index", () => {
    const dir = dataDir();
    openLatticeDb(dir).close();
    expect(SCHEMA_VERSION).toBe(4);
    expect(meta(dir, "schema_version")).toBe("4");
    expect(meta(dir, "compatibility")).toContain("v3 runtimes must not open this folder");
    const raw = new DatabaseSync(latticeDbPath(dir), { readOnly: true });
    try {
      expect(raw.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'events_task_kind'").get()).toBeDefined();
    } finally { raw.close(); }
  });

  it("upgrades a v3 folder in place without changing a single stored row", async () => {
    const dir = dataDir();
    const taskId = await populated(dir);
    asV3(dir);
    const before = contentDigest(dir);
    const db = openLatticeDb(dir);
    expect(readSchemaVersion(db.raw)).toBe(4);
    db.close();
    expect(contentDigest(dir)).toEqual(before);
    // The upgraded folder still reads as the same task, approval still pending.
    const again = openLatticeDb(dir);
    claimOwnership(again.raw);
    const tasks = new TaskManager(again.raw, path.dirname(dir));
    cleanups.push(async () => { await tasks.close(); again.close(); });
    expect(tasks.snapshot(taskId)).toMatchObject({ approvalPolicy: "confirm-mutations" });
    expect(tasks.snapshot(taskId).approvals).toHaveLength(1);
  });

  it("a failed upgrade leaves the v3 folder exactly as it was, and a later open completes it", async () => {
    const dir = dataDir();
    await populated(dir);
    asV3(dir);
    // A conflicting object makes the v4 statements fail midway.
    const raw = new DatabaseSync(latticeDbPath(dir));
    raw.exec("CREATE TABLE events_task_kind (x)");
    raw.close();
    const before = contentDigest(dir);
    expect(() => openLatticeDb(dir)).toThrow(MigrationError);
    expect(meta(dir, "schema_version")).toBe("3");
    expect(meta(dir, "compatibility")).toBeUndefined();
    expect(contentDigest(dir)).toEqual(before);
    const fix = new DatabaseSync(latticeDbPath(dir));
    fix.exec("DROP TABLE events_task_kind");
    fix.close();
    openLatticeDb(dir).close();
    expect(meta(dir, "schema_version")).toBe("4");
  });

  it("never upgrades a folder another live process owns; upgrades once it is gone", async () => {
    const dir = dataDir();
    await populated(dir);
    asV3(dir);
    // A real live process stands in for an older runtime holding the folder.
    const holder = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    cleanups.push(() => { holder.kill("SIGKILL"); });
    const raw = new DatabaseSync(latticeDbPath(dir));
    raw.prepare("UPDATE ownership SET pid = ? WHERE id = 1").run(holder.pid ?? 0);
    raw.close();
    const before = contentDigest(dir);
    expect(() => openLatticeDb(dir)).toThrow(OwnershipHeldError);
    expect(meta(dir, "schema_version")).toBe("3");
    expect(contentDigest(dir)).toEqual(before);
    holder.kill("SIGKILL");
    await new Promise<void>((resolve) => { holder.once("exit", () => { resolve(); }); });
    const db = openLatticeDb(dir);
    expect(readSchemaVersion(db.raw)).toBe(4);
    expect(claimOwnership(db.raw).generation).toBeGreaterThan(1);
    db.close();
  });

  it("refuses a newer folder with an explanation and leaves the file byte-identical", () => {
    const dir = dataDir();
    openLatticeDb(dir).close();
    const raw = new DatabaseSync(latticeDbPath(dir));
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.prepare("UPDATE meta SET value = '5' WHERE key = 'schema_version'").run();
    raw.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    raw.close();
    const file = (): string => createHash("sha256").update(fs.readFileSync(latticeDbPath(dir))).digest("hex");
    const before = file();
    let error: unknown;
    try { openLatticeDb(dir); } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(FutureSchemaError);
    expect((error as Error).message).toContain("schema version 5 is newer than supported 4; refusing downgrade");
    expect((error as Error).message).toContain("open it with that version or a newer one");
    expect(file()).toBe(before);
  });
});
