import path from "node:path";
import { loadConfig, validateConfig } from "../config.js";
import {
  acceptTaskResult,
  acknowledgeUnknownEffects,
  listSessions,
  readContract,
  recordTaskEvent,
  recoverOrphanedTasks,
  resumeTask,
  type ResumeReport,
} from "../runtime/continuity.js";
import { reconcileUnknownAttempt } from "../runtime/effects.js";
import { claimOwnership, openLatticeDb } from "../storage/db.js";
import { buildSessionExport, serializeExport, writeExportFile } from "../telemetry/export.js";
import { edgeWakeId, levelWakeId, recordWake } from "../runtime/wait.js";

export const EXPORT_PACKAGE_VERSION = "0.0.0";

function emit(line: string): void {
  process.stdout.write(`${line}\n`);
}

function openDataDb(dataDir: string, workspace: string) {
  const config = loadConfig({ workspace: path.resolve(workspace), dataDir: path.resolve(dataDir) }, process.cwd());
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`Invalid configuration: ${configErrors.join("; ")}`);
  }
  return openLatticeDb(config.dataDir);
}

export interface SessionsCommandOptions {
  dataDir: string;
  workspace: string;
  json: boolean;
}

export function sessionsCommand(options: SessionsCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open sessions: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    const sessions = listSessions(db.raw);
    if (options.json) {
      emit(JSON.stringify(sessions, null, 2));
      return Promise.resolve(0);
    }
    if (sessions.length === 0) {
      emit("lattice: no sessions yet");
      return Promise.resolve(0);
    }
    for (const session of sessions) {
      emit(`${session.sessionId} task=${session.taskId} state=${session.state} objective=${session.objective.slice(0, 80)}`);
    }
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}

export interface ResumeCommandOptions {
  dataDir: string;
  workspace: string;
  taskId: string;
  json: boolean;
  acknowledgeUnknown?: boolean | undefined;
}

function renderReport(report: ResumeReport): string {
  const lines = [
    `task: ${report.taskId}`,
    `session: ${report.sessionId}`,
    `state: ${report.state} (${report.stateReason.slice(0, 160)})`,
    `contract revision: ${report.contractRevision}`,
    `budget: settled ${report.budget.settled.calls} calls/${report.budget.settled.tokens} tokens, reserved ${report.budget.reserved.calls}/${report.budget.reserved.tokens}, granted ${report.budget.granted.calls}/${report.budget.granted.tokens}`,
    `unknowns: ${report.unknowns.length}${report.unknowns.length === 0 ? "" : ` (${report.unknowns.filter((entry) => entry.acknowledged).length} acknowledged)`}`,
    ...report.unknowns.map((entry) => `- ${entry.attemptId} ${entry.operation}${entry.target === null ? "" : ` ${entry.target}`}${entry.acknowledged ? " [acknowledged]" : ""}: ${entry.reason.slice(0, 160)}`),
    `drifted files: ${report.drift.length === 0 ? "none" : report.drift.map((entry) => `${entry.path} (${entry.change})`).join(", ")}`,
    `pending obligations: ${report.obligationsPending.length === 0 ? "none" : report.obligationsPending.join(" | ").slice(0, 300)}`,
    `active waits: ${report.waits.length === 0 ? "none" : report.waits.map((wait) => `${wait.kind}: ${wait.condition}`).join(" | ").slice(0, 300)}`,
  ];
  if (report.newRunId !== null) lines.push(`resumed under run ${report.newRunId}; same session, same budget`);
  if (!report.canResume) {
    lines.push("resume refused:");
    for (const blocker of report.blockers) lines.push(`- ${blocker.code}: ${blocker.detail.slice(0, 200)}`);
    if (report.blockers.some((blocker) => blocker.code === "unknown-effects")) {
      lines.push("next: inspect each UNKNOWN with `lattice reconcile <taskId> <attemptId>`, or continue with them recorded via `lattice resume <taskId> --acknowledge-unknown`");
    }
  }
  return lines.join("\n");
}

// Manual resume gate: evaluates continuity and, only when safe, opens a new
// run under the same session. Viewing a report never starts the model; use
// `lattice run --resume` to continue execution after a clean report.
export function resumeCommand(options: ResumeCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open database: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    let generation: number;
    try {
      generation = claimOwnership(db.raw).generation;
    } catch (error) {
      emit(`lattice: cannot resume: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    const contract = readContract(db.raw, options.taskId);
    if (contract === null) {
      emit(`lattice: unknown task ${options.taskId}`);
      return Promise.resolve(1);
    }
    // This process now owns the database: any RUNNING left by a dead owner
    // becomes INTERRUPTED with its effects classified before the gate runs.
    recoverOrphanedTasks(db.raw, generation);
    if (options.acknowledgeUnknown === true) {
      const acknowledged = acknowledgeUnknownEffects(db.raw, options.taskId, { actor: "human (cli)", note: "lattice resume --acknowledge-unknown" });
      if (acknowledged.length > 0 && !options.json) emit(`lattice: acknowledged ${acknowledged.length} UNKNOWN effect(s); they stay UNKNOWN and keep counting against the budget`);
    }
    const report = resumeTask(db.raw, { taskId: options.taskId, generation, packageVersion: EXPORT_PACKAGE_VERSION });
    emit(options.json ? JSON.stringify(report, null, 2) : renderReport(report));
    return Promise.resolve(report.canResume ? 0 : 1);
  } finally {
    db.close();
  }
}

export interface ReconcileCommandOptions {
  dataDir: string;
  workspace: string;
  taskId: string;
  attemptId: string;
  action: "observe" | "acknowledge" | "treat-as-applied" | "treat-as-not-applied";
  note: string | null;
  json: boolean;
}

// Reconciles one UNKNOWN effect from the terminal: observation for edits
// (and inert reads/searches), an explicit recorded decision for processes,
// or acknowledgement. Never replays the effect and never starts the model.
export function reconcileCommand(options: ReconcileCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open database: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    let generation: number;
    try {
      generation = claimOwnership(db.raw).generation;
    } catch (error) {
      emit(`lattice: cannot reconcile: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    const contract = readContract(db.raw, options.taskId);
    if (contract === null) {
      emit(`lattice: unknown task ${options.taskId}`);
      return Promise.resolve(1);
    }
    recoverOrphanedTasks(db.raw, generation);
    if (options.action === "acknowledge") {
      const acknowledged = acknowledgeUnknownEffects(db.raw, options.taskId, { actor: "human (cli)", note: options.note ?? "lattice reconcile --action acknowledge", attemptIds: [options.attemptId] });
      const ok = acknowledged.length > 0;
      emit(options.json ? JSON.stringify({ attemptId: options.attemptId, acknowledged: ok }) : ok ? `lattice: ${options.attemptId} acknowledged; it stays UNKNOWN` : `lattice: ${options.attemptId} is not an unacknowledged UNKNOWN effect of this task`);
      return Promise.resolve(ok ? 0 : 1);
    }
    const outcome = reconcileUnknownAttempt(db.raw, options.taskId, options.attemptId, contract.scope[0] ?? options.workspace, options.action, "human (cli)", options.note);
    emit(options.json ? JSON.stringify(outcome, null, 2) : `lattice: ${outcome.attemptId} ${outcome.operation}: ${outcome.result} — ${outcome.detail}`);
    return Promise.resolve(outcome.reconciled ? 0 : 1);
  } finally {
    db.close();
  }
}

export interface AcceptCommandOptions {
  dataDir: string;
  workspace: string;
  taskId: string;
  note: string | null;
}

// Human acceptance from the terminal: closes the task with basis
// accepted-by-human. Never runs a verification, never clears UNKNOWN.
export function acceptCommand(options: AcceptCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open database: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    let generation: number;
    try {
      generation = claimOwnership(db.raw).generation;
    } catch (error) {
      emit(`lattice: cannot accept: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    recoverOrphanedTasks(db.raw, generation);
    const result = acceptTaskResult(db.raw, options.taskId, { actor: "human (cli)", note: options.note });
    emit(result.accepted ? `lattice: ${options.taskId} accepted by human (not an automatic verification)` : `lattice: accept refused: ${result.reason}`);
    return Promise.resolve(result.accepted ? 0 : 1);
  } finally {
    db.close();
  }
}

export interface ExportCommandOptions {
  dataDir: string;
  workspace: string;
  sessionId: string;
  out: string;
}

// Local export v1: writes a JSONL snapshot of one session to an explicitly
// chosen destination. Never sends anything anywhere; that is S4.
export function exportCommand(options: ExportCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open database: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    let exported;
    try {
      exported = buildSessionExport(db.raw, options.sessionId, EXPORT_PACKAGE_VERSION);
    } catch (error) {
      emit(`lattice: export refused: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    try {
      writeExportFile(path.resolve(options.out), serializeExport(exported));
    } catch (error) {
      emit(`lattice: export write failed: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    const taskRow = db.raw.prepare("SELECT task_id FROM contracts WHERE root_id = ? LIMIT 1").get(exported.header.rootId) as
      | { task_id: string }
      | undefined;
    if (taskRow !== undefined) {
      recordTaskEvent(db.raw, taskRow.task_id, "export", {
        sessionId: options.sessionId,
        recordCount: exported.complete.recordCount,
        ledgerCut: exported.complete.ledgerCut,
        exportRevision: exported.header.exportRevision,
      });
    }
    emit(`lattice: exported session ${options.sessionId} (${exported.complete.recordCount} attempts, revision ${exported.header.exportRevision})`);
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}

export interface WakeCommandOptions {
  dataDir: string;
  workspace: string;
  taskId: string;
  source: string;
  cursor: string;
  observation: string;
  waitId?: string | undefined;
  level: boolean;
}

// Delivers one wake through the deterministic WakeGate: durable dedup first,
// then observation plus cursor in a single commit. Level wakes derive a
// stable id from source and cursor; edge wakes (human input, approvals) each
// carry a fresh id and never coalesce.
export function wakeCommand(options: WakeCommandOptions): Promise<number> {
  let db;
  try {
    db = openDataDb(options.dataDir, options.workspace);
  } catch (error) {
    emit(`lattice: cannot open database: ${error instanceof Error ? error.message : "unknown error"}`);
    return Promise.resolve(1);
  }
  try {
    try {
      claimOwnership(db.raw);
    } catch (error) {
      emit(`lattice: cannot wake: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    if (readContract(db.raw, options.taskId) === null) {
      emit(`lattice: unknown task ${options.taskId}`);
      return Promise.resolve(1);
    }
    const wakeId = options.level ? levelWakeId(options.taskId, options.source, options.cursor) : edgeWakeId();
    let result;
    try {
      result = recordWake(db.raw, options.taskId, {
        wakeId,
        ...(options.waitId !== undefined ? { waitId: options.waitId } : {}),
        edge: !options.level,
        source: options.source,
        cursor: options.cursor,
        observation: options.observation,
      });
    } catch (error) {
      emit(`lattice: wake refused: ${error instanceof Error ? error.message : "unknown error"}`);
      return Promise.resolve(1);
    }
    if (result.duplicate) {
      emit(`lattice: duplicate wake ignored (${wakeId})`);
      return Promise.resolve(0);
    }
    emit(`lattice: wake recorded (${wakeId})${result.fired ? " and wait fired" : ""}`);
    return Promise.resolve(0);
  } finally {
    db.close();
  }
}
