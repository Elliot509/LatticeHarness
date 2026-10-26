import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 4;
const META_SCHEMA_KEY = "schema_version";

export class FutureSchemaError extends Error {
  readonly found: number;
  readonly supported: number;
  constructor(found: number, supported: number) {
    super(
      `Database schema version ${found} is newer than supported ${supported}; refusing downgrade. ` +
        "This data folder was updated by a newer Lattice; open it with that version or a newer one.",
    );
    this.name = "FutureSchemaError";
    this.found = found;
    this.supported = supported;
  }
}

export class MigrationError extends Error {
  readonly fromVersion: number;
  readonly toVersion: number;
  constructor(fromVersion: number, toVersion: number, cause: unknown) {
    super(`Migration ${fromVersion} -> ${toVersion} failed; previous state preserved`, {
      cause,
    });
    this.name = "MigrationError";
    this.fromVersion = fromVersion;
    this.toVersion = toVersion;
  }
}

interface Migration {
  readonly toVersion: number;
  readonly destructive: boolean;
  readonly sql: string;
}

const V1_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ownership (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  process_identity TEXT NOT NULL,
  claimed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL,
  task_id TEXT,
  payload TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contracts (
  task_id TEXT PRIMARY KEY,
  root_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  run_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  root_id TEXT NOT NULL,
  task_id TEXT NOT NULL,
  manifest TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  intent_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  operation TEXT NOT NULL,
  target TEXT,
  action_key TEXT NOT NULL,
  authority_revision INTEGER NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempts (
  attempt_id TEXT PRIMARY KEY,
  intent_id TEXT NOT NULL REFERENCES intents(intent_id),
  request_id TEXT,
  generation INTEGER NOT NULL,
  ticket TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS reservations (
  intent_id TEXT PRIMARY KEY REFERENCES intents(intent_id),
  calls INTEGER NOT NULL,
  tokens INTEGER NOT NULL,
  settled_calls INTEGER NOT NULL DEFAULT 0,
  settled_tokens INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS receipts (
  receipt_id TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL REFERENCES attempts(attempt_id),
  outcome TEXT NOT NULL,
  detail TEXT NOT NULL,
  recorded_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS attempt_usage (
  attempt_id TEXT PRIMARY KEY REFERENCES attempts(attempt_id),
  revision INTEGER NOT NULL,
  document TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// S3 continuity: durable WAIT records with cursor/ack semantics, durable wake
// dedup, and pending revisions that arrive while a task is active. Events stay
// the canonical history; these tables hold only wait coordination state.
const V2_SCHEMA = `
CREATE TABLE IF NOT EXISTS waits (
  wait_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  condition TEXT NOT NULL,
  source TEXT NOT NULL,
  observed_cursor TEXT NOT NULL,
  obligation TEXT NOT NULL,
  deadline TEXT,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS wake_events (
  wake_id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  wait_id TEXT,
  edge INTEGER NOT NULL,
  observation TEXT NOT NULL,
  received_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pending_revisions (
  task_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (task_id, revision)
);
`;

// The v1 DDL stays exported so tests and the package upgrade check can build
// a genuine previous-version database without duplicating the schema.
export { V1_SCHEMA as V1_SCHEMA_SQL };

// R1 v3 (composition identity, F-0010): per-task composition epochs. The
// table is ALSO created lazily by composition.ts (ensureTable) so databases
// that skip migrate (tests opening raw handles) still work; the migration
// keeps versioned databases honest and future-schema checks meaningful.
const V3_SCHEMA = `
CREATE TABLE IF NOT EXISTS composition_epochs (
  task_id TEXT PRIMARY KEY,
  epoch INTEGER NOT NULL,
  digest TEXT NOT NULL,
  composition TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

// v4 (compatibility generation): this runtime records data that earlier
// runtimes would misread as permission to act: per-task confirmation policy
// and pending approvals, INTERRUPTED tasks and unanswered tool calls. Every
// shipped v3 runtime refuses a newer schema before touching the database
// (FutureSchemaError), so the version bump itself keeps them out of an
// upgraded data folder. Additive only: one index for the per-task event
// lookups (approvals, conversation) and a note naming the generation.
const V4_SCHEMA = `
CREATE INDEX IF NOT EXISTS events_task_kind ON events (task_id, kind, seq);
INSERT INTO meta (key, value) VALUES ('compatibility', 'v4: confirmation policy, approvals, INTERRUPTED, structured conversation; v3 runtimes must not open this folder')
  ON CONFLICT(key) DO UPDATE SET value = excluded.value;
`;

const MIGRATIONS: readonly Migration[] = [
  { toVersion: 1, destructive: false, sql: V1_SCHEMA },
  { toVersion: 2, destructive: false, sql: V2_SCHEMA },
  { toVersion: 3, destructive: false, sql: V3_SCHEMA },
  { toVersion: 4, destructive: false, sql: V4_SCHEMA },
];

export function readSchemaVersion(db: DatabaseSync): number {
  const tables = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta'",
    )
    .all() as Array<{ name: string }>;
  if (tables.length === 0) return 0;
  const row = db
    .prepare("SELECT value FROM meta WHERE key = ?")
    .get(META_SCHEMA_KEY) as { value: string } | undefined;
  if (row === undefined) return 0;
  const parsed = Number.parseInt(row.value, 10);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new MigrationError(0, SCHEMA_VERSION, new Error("Corrupt schema_version in meta"));
  }
  return parsed;
}

function writeSchemaVersion(db: DatabaseSync, version: number): void {
  db.prepare(
    "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(META_SCHEMA_KEY, String(version));
}

export function migrate(db: DatabaseSync): { from: number; to: number } {
  const current = readSchemaVersion(db);
  if (current > SCHEMA_VERSION) {
    throw new FutureSchemaError(current, SCHEMA_VERSION);
  }
  let version = current;
  for (const migration of MIGRATIONS) {
    if (migration.toVersion <= version) continue;
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        db.exec(migration.sql);
        writeSchemaVersion(db, migration.toVersion);
        db.exec("COMMIT");
      } catch (error) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Rollback failure leaves the transaction state to SQLite; the
          // original error below remains the actionable signal.
        }
        throw error;
      }
      version = migration.toVersion;
    } catch (error) {
      if (error instanceof FutureSchemaError) throw error;
      throw new MigrationError(version, migration.toVersion, error);
    }
  }
  return { from: current, to: version };
}

export function getMigrationPlan(from: number): readonly number[] {
  return MIGRATIONS.filter((m) => m.toVersion > from).map((m) => m.toVersion);
}
