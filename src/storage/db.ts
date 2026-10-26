import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import { latticeDbPath } from "../platform/paths.js";
import { migrate, readSchemaVersion, SCHEMA_VERSION } from "./schema.js";

export { SCHEMA_VERSION };

export class OwnershipHeldError extends Error {
  readonly pid: number;
  readonly generation: number;
  constructor(pid: number, generation: number) {
    super(`Database is owned by live process ${pid} at generation ${generation}`);
    this.name = "OwnershipHeldError";
    this.pid = pid;
    this.generation = generation;
  }
}

export class OwnershipUncertainError extends Error {
  readonly pid: number;
  constructor(pid: number, cause: unknown) {
    super(
      `Cannot prove owner process ${pid} terminated; entering recovery without effects`,
      { cause },
    );
    this.name = "OwnershipUncertainError";
    this.pid = pid;
  }
}

export class PersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "PersistenceError";
  }
}

export interface LatticeDb {
  readonly dataDir: string;
  readonly dbPath: string;
  readonly raw: DatabaseSync;
  close(): void;
}

export interface OwnerClaim {
  readonly generation: number;
  readonly pid: number;
  readonly processIdentity: string;
  readonly fresh: boolean;
}

function defaultProcessIdentity(): string {
  return `pid:${process.pid}:ppid:${process.ppid}:${process.execPath}`;
}

function ownerAlive(pid: number): boolean {
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code =
      typeof error === "object" && error !== null && "code" in error
        ? error.code
        : undefined;
    if (code === "ESRCH") return false;
    if (code === "EPERM") return true;
    throw new OwnershipUncertainError(pid, error);
  }
}

export function openLatticeDb(dataDir: string): LatticeDb {
  try {
    fs.mkdirSync(dataDir, { recursive: true });
  } catch (error) {
    throw new PersistenceError(`Cannot create data directory ${dataDir}`, error);
  }
  const dbPath = latticeDbPath(dataDir);
  let raw: DatabaseSync;
  try {
    raw = new DatabaseSync(dbPath);
  } catch (error) {
    throw new PersistenceError(`Cannot open database at ${dbPath}`, error);
  }
  try {
    raw.exec("PRAGMA journal_mode = WAL");
    raw.exec("PRAGMA synchronous = FULL");
    raw.exec("PRAGMA foreign_keys = ON");
    // POST_R1_VERIFY PR1-001: bounded busy timeout so lock contention under
    // multi-process ownership races blocks briefly instead of surfacing raw
    // SQLITE_BUSY ("database is locked"). The ownership boundary promises a
    // TYPED loser (OwnershipHeldError/Uncertain); without this, a loser's
    // BEGIN IMMEDIATE can throw the untyped busy error. 5s matches the
    // short-transaction discipline (ownership + migrations are ms-scale).
    raw.exec("PRAGMA busy_timeout = 5000");
    refuseUpgradeUnderLiveOwner(raw);
    migrate(raw);
  } catch (error) {
    try {
      raw.close();
    } catch {
      // Close failure after a setup failure must not mask the root cause.
    }
    throw error;
  }
  return {
    dataDir,
    dbPath,
    raw,
    close() {
      raw.close();
    },
  };
}

// An upgrade never runs under another live process: an older runtime that
// already opened this folder keeps its own view until it exits, and must not
// find the schema changed beneath it. Same-process reopens and dead owners
// proceed (a dead owner is recovered by claimOwnership as before).
function refuseUpgradeUnderLiveOwner(raw: DatabaseSync): void {
  const version = readSchemaVersion(raw);
  if (version === 0 || version >= SCHEMA_VERSION) return;
  const owner = raw.prepare("SELECT generation, pid FROM ownership WHERE id = 1").get() as { generation: number; pid: number } | undefined;
  if (owner !== undefined && owner.pid !== process.pid && ownerAlive(owner.pid)) throw new OwnershipHeldError(owner.pid, owner.generation);
}

export function currentSchemaVersion(db: DatabaseSync): number {
  return readSchemaVersion(db);
}

export function claimOwnership(
  db: DatabaseSync,
  processIdentity: string = defaultProcessIdentity(),
): OwnerClaim {
  // Serialized: two processes racing here must not both believe they own.
  // BEGIN IMMEDIATE takes the write lock up front; the loser blocks, then
  // reads the winner's row and fails closed with OwnershipHeldError (or
  // takes over a provably-dead owner). Same-process re-claim stays cheap.
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db
      .prepare("SELECT generation, pid, process_identity FROM ownership WHERE id = 1")
      .get() as
      | { generation: number; pid: number; process_identity: string }
      | undefined;
    if (existing === undefined) {
      db.prepare(
        "INSERT INTO ownership (id, generation, pid, process_identity, claimed_at) VALUES (1, 1, ?, ?, ?)",
      ).run(process.pid, processIdentity, new Date().toISOString());
      db.exec("COMMIT");
      return { generation: 1, pid: process.pid, processIdentity, fresh: true };
    }
    if (existing.pid === process.pid && existing.process_identity === processIdentity) {
      db.exec("COMMIT");
      return {
        generation: existing.generation,
        pid: process.pid,
        processIdentity,
        fresh: false,
      };
    }
    if (ownerAlive(existing.pid)) {
      db.exec("ROLLBACK");
      throw new OwnershipHeldError(existing.pid, existing.generation);
    }
    const generation = existing.generation + 1;
    db.prepare(
      "UPDATE ownership SET generation = ?, pid = ?, process_identity = ?, claimed_at = ? WHERE id = 1",
    ).run(generation, process.pid, processIdentity, new Date().toISOString());
    db.exec("COMMIT");
    return { generation, pid: process.pid, processIdentity, fresh: false };
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // ROLLBACK after COMMIT throws (no transaction): the success paths
      // above already committed, so only a failed COMMIT lands here with
      // something to roll back. Best effort; original error wins.
    }
    throw error;
  }
}

export function readOwnerGeneration(db: DatabaseSync): number | null {
  const row = db.prepare("SELECT generation FROM ownership WHERE id = 1").get() as
    | { generation: number }
    | undefined;
  return row?.generation ?? null;
}
