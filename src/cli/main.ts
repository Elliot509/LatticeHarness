#!/usr/bin/env node
import path from "node:path";
import { loadConfig, providerReadiness, validateConfig } from "../config.js";
import { resolveDataDir } from "../platform/paths.js";
import { checkRuntimeVersion } from "../platform/runtime.js";
import { claimOwnership, currentSchemaVersion, openLatticeDb } from "../storage/db.js";
import { SCHEMA_VERSION } from "../storage/schema.js";
import { runTaskCommand } from "./run.js";
import { acceptCommand, exportCommand, reconcileCommand, resumeCommand, sessionsCommand, wakeCommand } from "./continuity.js";
import { uiCommand } from "./ui.js";

const PACKAGE_VERSION = "0.0.0";

interface StatusReport {
  version: string;
  workspace: string;
  dataDir: string;
  dbPath: string;
  schemaVersion: number;
  supportedSchemaVersion: number;
  ownerGeneration: number | null;
  provider: string | null;
  model: string | null;
  readiness: "ready" | "provider-pending";
  configErrors: string[];
}

function printHelp(): void {
  const text = [
    "lattice - local-first agent harness runtime",
    "",
    "Usage:",
    "  lattice [workspace] [options]",
    "  lattice status [--json] [--workspace <path>]",
    "  lattice run --task <objective> [options]",
    "  lattice run --resume <taskId> [options]",
    "  lattice sessions [--json]",
    "  lattice resume <taskId> [--acknowledge-unknown] [--json]",
    "  lattice accept <taskId> [--note <text>]",
    "  lattice reconcile <taskId> <attemptId> [--action observe|acknowledge|treat-as-applied|treat-as-not-applied] [--note <text>] [--json]",
    "  lattice export --session <id> --out <path>",
    "  lattice wake <taskId> --source <s> --cursor <c> --observation <text> [--wait <id>] [--level]",
    "  lattice ui [--workspace <path>] [--port <n>] [--no-open]",
  "",
  "With no arguments, lattice opens the local UI for the current directory.",
  "",
    "Options:",
    "  --workspace <path>  workspace directory (default: current directory)",
    "  --data-dir <path>   override data directory (default: platform directory)",
    "  --json              machine-readable status output",
    "  --task <text>       task objective (run command)",
    "  --resume <taskId>   continue a persisted task through the resume gate (run command)",
    "  --session <id>      session identifier (export command)",
    "  --out <path>        explicit export destination file (export command)",
    "  --source <s>        wake source identity (wake command)",
    "  --cursor <c>        observed cursor carried by the wake (wake command)",
    "  --observation <t>   what was observed (wake command)",
    "  --wait <id>         wait record to fire, when known (wake command)",
    "  --level             level wake with stable id instead of edge wake (wake command)",
    "  --acknowledge-unknown  record that you saw the UNKNOWN effects and continue with them pending (resume, run --resume)",
    "  --action <a>        reconcile action: observe (default), acknowledge, treat-as-applied, treat-as-not-applied",
    "  --note <text>       note recorded with a reconcile decision",
    "  --provider <name>   fake or a known provider preset: openai, openrouter, gemini, abacus, local, custom (run command)",
    "  --model <name>      model identifier (run command)",
    "  --base-url <url>    OpenAI-compatible base URL, e.g. a local server (run command)",
    "  --fake-script <f>   JSON step file for the fake test-double provider",
    "  --verify <exe>      verification executable (run command)",
    "  --verify-arg <a>    verification argument, repeatable (run command)",
    "  --accept <text>     acceptance criterion, repeatable (run command)",
    "  --max-iterations N  explicit loop iteration limit (unset: none)",
    "  --max-calls N       explicit cumulative model-call limit (unset: none)",
    "  --max-tokens N      explicit cumulative token limit (unset: none)",
    "  --task-timeout-ms N explicit contract duration (unset: none)",
    "  --port <n>          loopback port for lattice ui (default: ephemeral)",
    "  --no-open           do not open a browser automatically (ui command)",
    "  --help              show this help",
    "  --version           show version",
    "",
    "run executes one task loop with durable admission, receipts and",
    "verification gating. The openai provider reads LATTICE_API_KEY from the",
    "environment; the key is never printed or logged.",
    "resume reopens a persisted task under its original session and budget;",
    "export writes a local JSONL usage snapshot and never sends anything.",
  ].join("\n");
  process.stdout.write(`${text}\n`);
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  if (typeof cause === "string") return cause;
  return "unknown error";
}

function fail(message: string, cause?: unknown): never {
  if (cause !== undefined) {
    process.stderr.write(`lattice: ${message}: ${describeCause(cause)}\n`);
  } else {
    process.stderr.write(`lattice: ${message}\n`);
  }
  process.exit(1);
}

interface StatusOptions {
  command: "status";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  json: boolean;
}

interface RunOptions {
  command: "run";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  task: string;
  providerName: string;
  model: string;
  baseUrl?: string | undefined;
  fakeScriptPath?: string | undefined;
  verifyExecutable?: string | undefined;
  verifyArgs: string[];
  acceptance: string[];
  maxIterations?: number | undefined;
  maxModelAttempts?: number | undefined;
  maxTotalTokens?: number | undefined;
  taskExpiryMs?: number | undefined;
  resumeTaskId?: string | undefined;
  acknowledgeUnknown?: boolean | undefined;
}

interface SessionsOptions {
  command: "sessions";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  json: boolean;
}

interface ResumeOptions {
  command: "resume";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  taskId: string;
  json: boolean;
  acknowledgeUnknown: boolean;
}

interface AcceptOptions {
  command: "accept";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  taskId: string;
  note?: string | undefined;
}

interface ReconcileOptions {
  command: "reconcile";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  taskId: string;
  attemptId: string;
  action: "observe" | "acknowledge" | "treat-as-applied" | "treat-as-not-applied";
  note?: string | undefined;
  json: boolean;
}

interface ExportOptions {
  command: "export";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  sessionId: string;
  out: string;
}

interface WakeOptions {
  command: "wake";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  taskId: string;
  source: string;
  cursor: string;
  observation: string;
  waitId?: string | undefined;
  level: boolean;
}

interface UiOptions {
  command: "ui";
  workspace?: string | undefined;
  dataDir?: string | undefined;
  port?: number | undefined;
  openBrowser: boolean;
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index];
  if (value === undefined || value.startsWith("--")) {
    fail(`${flag} requires a value`);
  }
  return value;
}

function parseArgs(argv: readonly string[]): StatusOptions | RunOptions | UiOptions | SessionsOptions | ResumeOptions | ReconcileOptions | AcceptOptions | ExportOptions | WakeOptions {
  let command: "status" | "run" | "ui" | "sessions" | "resume" | "reconcile" | "accept" | "export" | "wake" = argv.length === 0 ? "ui" : "status";
  let acknowledgeUnknown = false;
  let reconcileAction: ReconcileOptions["action"] = "observe";
  let note: string | undefined;
  let workspace: string | undefined;
  let dataDir: string | undefined;
  let json = false;
  let task: string | undefined;
  let providerName = "openai";
  let model = "";
  let baseUrl: string | undefined;
  let port: number | undefined;
  let openBrowser = true;
  let fakeScriptPath: string | undefined;
  let verifyExecutable: string | undefined;
  const verifyArgs: string[] = [];
  const acceptance: string[] = [];
  let maxIterations: number | undefined;
  let maxModelAttempts: number | undefined;
  let maxTotalTokens: number | undefined;
  let taskExpiryMs: number | undefined;
  let resumeTaskId: string | undefined;
  let sessionId: string | undefined;
  let out: string | undefined;
  let wakeTaskId: string | undefined;
  let wakeSource: string | undefined;
  let wakeCursor: string | undefined;
  let wakeObservation: string | undefined;
  let wakeWaitId: string | undefined;
  let wakeLevel = false;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
    } else if (arg === "--workspace" || arg === "--data-dir") {
      const value = takeValue(argv, i + 1, arg);
      i += 1;
      if (arg === "--workspace") workspace = value;
      else dataDir = value;
    } else if (arg === "--task") {
      task = takeValue(argv, i + 1, arg);
      i += 1;
      command = "run";
    } else if (arg === "--resume") {
      resumeTaskId = takeValue(argv, i + 1, arg);
      i += 1;
      command = "run";
    } else if (arg === "--session") {
      sessionId = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--out") {
      out = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--source") {
      wakeSource = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--cursor") {
      wakeCursor = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--observation") {
      wakeObservation = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--wait") {
      wakeWaitId = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--acknowledge-unknown") {
      acknowledgeUnknown = true;
    } else if (arg === "--action") {
      const value = takeValue(argv, i + 1, arg);
      if (value !== "observe" && value !== "acknowledge" && value !== "treat-as-applied" && value !== "treat-as-not-applied") fail("--action must be observe, acknowledge, treat-as-applied or treat-as-not-applied");
      reconcileAction = value;
      i += 1;
    } else if (arg === "--note") {
      note = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--level") {
      wakeLevel = true;
    } else if (arg === "--provider") {
      providerName = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--model") {
      model = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--base-url") {
      baseUrl = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--fake-script") {
      fakeScriptPath = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--verify") {
      verifyExecutable = takeValue(argv, i + 1, arg);
      i += 1;
    } else if (arg === "--verify-arg") {
      // Verification arguments may legitimately start with dashes
      // (for example node --test), so they bypass the flag guard.
      const value = argv[i + 1];
      if (value === undefined) fail(`${arg} requires a value`);
      verifyArgs.push(value);
      i += 1;
    } else if (arg === "--accept") {
      acceptance.push(takeValue(argv, i + 1, arg));
      i += 1;
    } else if (arg === "--max-calls" || arg === "--max-tokens" || arg === "--task-timeout-ms") {
      const parsed = Number(takeValue(argv, i + 1, arg));
      i += 1;
      if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${arg} must be a positive integer`);
      if (arg === "--max-calls") maxModelAttempts = parsed;
      else if (arg === "--max-tokens") maxTotalTokens = parsed;
      else taskExpiryMs = parsed;
    } else if (arg === "--max-iterations") {
      const raw = takeValue(argv, i + 1, arg);
      i += 1;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0) fail("--max-iterations must be a positive integer");
      maxIterations = parsed;
    } else if (arg === "--port") {
      const raw = takeValue(argv, i + 1, arg);
      i += 1;
      const parsed = Number.parseInt(raw, 10);
      if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65535) fail("--port must be a valid port");
      port = parsed;
      command = "ui";
    } else if (arg === "--no-open") {
      openBrowser = false;
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else if (arg === "--version" || arg === "-V") {
      process.stdout.write(`${PACKAGE_VERSION}\n`);
      process.exit(0);
    } else if (arg === "status" || arg === "run" || arg === "ui" || arg === "sessions" || arg === "resume" || arg === "reconcile" || arg === "accept" || arg === "export" || arg === "wake") {
      // The first command word wins: later positionals (task ids) must not
      // flip the command.
      if (command !== "status") {
        positional.push(arg);
        continue;
      }
      if (arg === "run") command = "run";
      if (arg === "ui") command = "ui";
      if (arg === "sessions") command = "sessions";
      if (arg === "resume") command = "resume";
      if (arg === "reconcile") command = "reconcile";
      if (arg === "accept") command = "accept";
      if (arg === "export") command = "export";
      if (arg === "wake") command = "wake";
      continue;
    } else if (arg?.startsWith("--")) {
      fail(`unknown option ${arg} (see --help)`);
    } else if (arg !== undefined) {
      positional.push(arg);
    }
  }
  if (positional.length > (command === "reconcile" ? 2 : 1)) fail("at most one workspace argument is accepted");
  // Resume, reconcile and wake take ids positionally; every other command
  // takes an optional workspace there.
  const idCommands = command === "resume" || command === "wake" || command === "reconcile" || command === "accept";
  if (!idCommands && positional.length === 1 && workspace !== undefined) {
    fail("pass the workspace either positionally or via --workspace, not both");
  }
  const resolvedWorkspace = idCommands ? workspace : (workspace ?? positional[0]);
  if (command === "ui") {
    return { command: "ui", workspace: resolvedWorkspace, dataDir, port, openBrowser };
  }
  if (command === "run") {
    if (resumeTaskId !== undefined) {
      return {
        command: "run",
        workspace: resolvedWorkspace,
        dataDir,
        task: task ?? "",
        providerName,
        model,
        ...(baseUrl !== undefined ? { baseUrl } : {}),
        fakeScriptPath,
        verifyExecutable,
        verifyArgs,
        acceptance,
        maxIterations,
        maxModelAttempts, maxTotalTokens, taskExpiryMs,
        resumeTaskId,
        acknowledgeUnknown,
      };
    }
    if (task === undefined || task.trim() === "") fail("run requires --task with a non-empty objective");
    if (model.trim() === "") fail("run requires --model");
    return {
      command: "run",
      workspace: resolvedWorkspace,
      dataDir,
      task: task,
      providerName,
      model,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      fakeScriptPath,
      verifyExecutable,
      verifyArgs,
      acceptance,
      maxIterations,
      maxModelAttempts, maxTotalTokens, taskExpiryMs,
    };
  }
  if (command === "sessions") {
    return { command: "sessions", workspace: resolvedWorkspace, dataDir, json };
  }
  if (command === "resume") {
    if (positional.length === 0) fail("resume requires a task id");
    return { command: "resume", workspace: resolvedWorkspace, dataDir, taskId: positional[0] as string, json, acknowledgeUnknown };
  }
  if (command === "accept") {
    if (positional.length === 0) fail("accept requires a task id");
    return { command: "accept", workspace: resolvedWorkspace, dataDir, taskId: positional[0] as string, ...(note === undefined ? {} : { note }) };
  }
  if (command === "reconcile") {
    if (positional.length < 2) fail("reconcile requires a task id and an attempt id");
    return { command: "reconcile", workspace: resolvedWorkspace, dataDir, taskId: positional[0] as string, attemptId: positional[1] as string, action: reconcileAction, ...(note === undefined ? {} : { note }), json };
  }
  if (command === "export") {
    if (sessionId === undefined) fail("export requires --session");
    if (out === undefined) fail("export requires --out");
    return { command: "export", workspace: resolvedWorkspace, dataDir, sessionId, out };
  }
  if (command === "wake") {
    if (wakeTaskId === undefined && positional.length > 0) wakeTaskId = positional[0];
    if (wakeTaskId === undefined) fail("wake requires --task");
    if (wakeSource === undefined) fail("wake requires --source");
    if (wakeCursor === undefined) fail("wake requires --cursor");
    if (wakeObservation === undefined) fail("wake requires --observation");
    return {
      command: "wake",
      workspace: resolvedWorkspace,
      dataDir,
      taskId: wakeTaskId,
      source: wakeSource,
      cursor: wakeCursor,
      observation: wakeObservation,
      ...(wakeWaitId !== undefined ? { waitId: wakeWaitId } : {}),
      level: wakeLevel,
    };
  }
  return { command: "status", workspace: resolvedWorkspace, dataDir, json };
}

function collectStatus(workspaceInput: string | undefined, dataDirInput: string | undefined): StatusReport {
  const workspace = path.resolve(workspaceInput ?? process.cwd());
  const config = loadConfig(
    {
      workspace,
      ...(dataDirInput !== undefined ? { dataDir: path.resolve(dataDirInput) } : {}),
    },
    process.cwd(),
  );
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    throw new Error(`Invalid configuration: ${configErrors.join("; ")}`);
  }
  const db = openLatticeDb(config.dataDir);
  try {
    const schemaVersion = currentSchemaVersion(db.raw);
    let ownerGeneration: number | null = null;
    try {
      ownerGeneration = claimOwnership(db.raw).generation;
    } catch (error) {
      const name = error instanceof Error ? error.name : "";
      if (name === "OwnershipHeldError") {
        ownerGeneration = null;
      } else {
        throw error;
      }
    }
    return {
      version: PACKAGE_VERSION,
      workspace: config.workspace,
      dataDir: config.dataDir,
      dbPath: db.dbPath,
      schemaVersion,
      supportedSchemaVersion: SCHEMA_VERSION,
      ownerGeneration,
      provider: config.provider,
      model: config.model,
      readiness: providerReadiness(config),
      configErrors,
    };
  } finally {
    db.close();
  }
}

function renderHuman(report: StatusReport): string {
  const lines = [
    `lattice ${report.version}`,
    `workspace: ${report.workspace}`,
    `data dir: ${report.dataDir}`,
    `database: ${report.dbPath} (schema ${report.schemaVersion})`,
    report.ownerGeneration === null
      ? "ownership: held by another live process"
      : `ownership: generation ${report.ownerGeneration}`,
    report.readiness === "ready"
      ? `provider: ${report.provider ?? "?"} model: ${report.model ?? "?"} (configured)`
      : "provider: pending configuration (set LATTICE_PROVIDER and LATTICE_MODEL)",
    report.readiness === "ready" ? "status: ready" : "status: provider-pending",
  ];
  return `${lines.join("\n")}\n`;
}

export function main(argv: readonly string[] = process.argv.slice(2)): void {
  let options: StatusOptions | RunOptions | UiOptions | SessionsOptions | ResumeOptions | ReconcileOptions | AcceptOptions | ExportOptions | WakeOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  try {
    checkRuntimeVersion();
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  let dataDir = options.dataDir;
  if (dataDir === undefined) {
    try {
      dataDir = resolveDataDir();
    } catch (error) {
      fail("cannot resolve data directory", error);
    }
  }
  if (options.command === "ui") {
    uiCommand({
      workspace: options.workspace ?? process.cwd(),
      dataDir: dataDir,
      ...(options.port !== undefined ? { port: options.port } : {}),
      openBrowser: options.openBrowser,
    })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("ui failed", error));
    return;
  }
  if (options.command === "run") {
    runTaskCommand({
      workspace: options.workspace ?? process.cwd(),
      dataDir: dataDir,
      task: options.task,
      acceptance: options.acceptance,
      providerName: options.providerName,
      model: options.model,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
      ...(options.fakeScriptPath !== undefined ? { fakeScriptPath: options.fakeScriptPath } : {}),
      ...(options.verifyExecutable !== undefined ? { verifyExecutable: options.verifyExecutable } : {}),
      verifyArgs: options.verifyArgs,
      ...(options.maxIterations !== undefined ? { maxIterations: options.maxIterations } : {}),
      ...(options.maxModelAttempts === undefined ? {} : { maxModelAttempts: options.maxModelAttempts }),
      ...(options.maxTotalTokens === undefined ? {} : { maxTotalTokens: options.maxTotalTokens }),
      ...(options.taskExpiryMs === undefined ? {} : { taskExpiryMs: options.taskExpiryMs }),
      ...(options.resumeTaskId !== undefined ? { resumeTaskId: options.resumeTaskId } : {}),
      ...(options.acknowledgeUnknown === true ? { acknowledgeUnknown: true } : {}),
    })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("run failed", error));
    return;
  }
  if (options.command === "sessions") {
    sessionsCommand({ workspace: options.workspace ?? process.cwd(), dataDir: dataDir, json: options.json })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("sessions failed", error));
    return;
  }
  if (options.command === "resume") {
    resumeCommand({ workspace: options.workspace ?? process.cwd(), dataDir: dataDir, taskId: options.taskId, json: options.json, acknowledgeUnknown: options.acknowledgeUnknown })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("resume failed", error));
    return;
  }
  if (options.command === "accept") {
    acceptCommand({ workspace: options.workspace ?? process.cwd(), dataDir: dataDir, taskId: options.taskId, note: options.note ?? null })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("accept failed", error));
    return;
  }
  if (options.command === "reconcile") {
    reconcileCommand({ workspace: options.workspace ?? process.cwd(), dataDir: dataDir, taskId: options.taskId, attemptId: options.attemptId, action: options.action, note: options.note ?? null, json: options.json })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("reconcile failed", error));
    return;
  }
  if (options.command === "export") {
    exportCommand({ workspace: options.workspace ?? process.cwd(), dataDir: dataDir, sessionId: options.sessionId, out: options.out })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("export failed", error));
    return;
  }
  if (options.command === "wake") {
    wakeCommand({
      workspace: options.workspace ?? process.cwd(),
      dataDir: dataDir,
      taskId: options.taskId,
      source: options.source,
      cursor: options.cursor,
      observation: options.observation,
      ...(options.waitId !== undefined ? { waitId: options.waitId } : {}),
      level: options.level,
    })
      .then((code) => process.exit(code))
      .catch((error: unknown) => fail("wake failed", error));
    return;
  }
  let report: StatusReport;
  try {
    report = collectStatus(options.workspace, dataDir);
  } catch (error) {
    fail("cannot open workspace status", error);
  }
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    process.stdout.write(renderHuman(report));
  }
}

main();
