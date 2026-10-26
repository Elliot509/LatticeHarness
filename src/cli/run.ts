import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { loadConfig, validateConfig } from "../config.js";
import { createContract, type TaskContract } from "../runtime/contract.js";
import {
  acknowledgeUnknownEffects,
  evaluateResumeGate,
  grantedFromContract,
  openRun,
  openSession,
  persistContract,
  readContract,
  readRunManifest,
  recordTaskEvent,
  recordVerificationEvent,
  recoverOrphanedTasks,
  resumeTask,
} from "../runtime/continuity.js";
import { HandleWaiter } from "../runtime/wait.js";
import { runTaskLoop, type LoopOptions } from "../runtime/loop.js";
import { conversationWithLineage } from "../runtime/conversation.js";
import { claimOwnership, openLatticeDb } from "../storage/db.js";
import { VerifyLedger } from "../runtime/verify.js";
import { TaskAcceptance, resolveAcceptance } from "../runtime/acceptance.js";
import { FakeProvider, type FakeScriptStep } from "../providers/fake.js";
import { OpenAiAdapter } from "../providers/openai.js";
import { isKnownProviderId } from "../providers/presets.js";
import type { ProviderAdapter } from "../providers/types.js";
import { buildToolset } from "../tools/registry.js";
import { ProcessSupervisor } from "../tools/process.js";
import type { TaskSurface } from "../context/compiler.js";

export interface RunCommandOptions {
  workspace: string;
  dataDir: string;
  task: string;
  acceptance: string[];
  providerName: string;
  model: string;
  baseUrl?: string;
  fakeScriptPath?: string;
  verifyExecutable?: string;
  verifyArgs?: string[];
  maxIterations?: number;
  maxModelAttempts?: number;
  maxTotalTokens?: number;
  taskExpiryMs?: number;
  onOutput?: (line: string) => void;
  // Continues a persisted task instead of creating one: the contract,
  // session, budget and composition all come from the ledger.
  resumeTaskId?: string | undefined;
  acknowledgeUnknown?: boolean | undefined;
}

const TOOL_OPERATIONS = ["search", "read", "edit", "exec", "process", "model.invoke"];

function loadFakeScript(scriptPath: string): FakeScriptStep[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(scriptPath, "utf8"));
  } catch (error) {
    throw new Error(`Cannot read fake script ${scriptPath}: ${error instanceof Error ? error.message : "unknown error"}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Fake script ${scriptPath} must be a JSON array of steps`);
  }
  return parsed as FakeScriptStep[];
}

function selectProvider(options: Pick<RunCommandOptions, "providerName" | "fakeScriptPath"> & { baseUrl?: string | undefined }): ProviderAdapter {
  if (options.providerName === "fake") {
    if (options.fakeScriptPath === undefined) {
      throw new Error("fake provider requires --fake-script with a JSON step file; it is a test double, not a model");
    }
    return new FakeProvider(loadFakeScript(options.fakeScriptPath));
  }
  if (isKnownProviderId(options.providerName)) {
    // S5: every known preset speaks OpenAI Chat Completions; one adapter.
    // CLI keeps the openai env-key fallback; other presets need an explicit
    // --base-url (local) or fail with a clear adapter error, never silently.
    const apiKey = options.providerName === "openai" ? process.env["LATTICE_API_KEY"] ?? "" : "";
    if (options.baseUrl === undefined && apiKey.trim() === "") {
      throw new Error(
        `${options.providerName} provider requires the LATTICE_API_KEY environment variable to be set; for a local OpenAI-compatible endpoint pass --base-url instead`,
      );
    }
    return new OpenAiAdapter({
      apiKey,
      ...(options.baseUrl !== undefined ? { baseUrl: options.baseUrl } : {}),
    });
  }
  throw new Error(`Unknown provider ${options.providerName}; expected fake or a known preset`);
}

// Runs one task loop to completion. Exit codes: 0 verified STOP, 2 ASK,
// 3 ESCALATE, 4 stable WAIT (app must stay alive for a wake), 1 operational
// error. Never prints secret values.
export async function runTaskCommand(options: RunCommandOptions): Promise<number> {
  const emit = options.onOutput ?? ((line: string) => {
    process.stdout.write(`${line}\n`);
  });
  const workspace = path.resolve(options.workspace);
  if (!fs.existsSync(workspace) || !fs.statSync(workspace).isDirectory()) {
    emit(`lattice: workspace does not exist: ${workspace}`);
    return 1;
  }
  const config = loadConfig({ workspace, dataDir: path.resolve(options.dataDir),
    maxModelAttempts: options.maxModelAttempts, maxTotalTokens: options.maxTotalTokens, taskExpiryMs: options.taskExpiryMs }, process.cwd());
  const configErrors = validateConfig(config);
  if (configErrors.length > 0) {
    emit(`lattice: invalid configuration: ${configErrors.join("; ")}`);
    return 1;
  }
  const db = openLatticeDb(config.dataDir);
  const supervisor = new ProcessSupervisor(workspace);
  const ledger = new VerifyLedger();
  try {
    const claim = claimOwnership(db.raw);
    const resolved = resolveTaskTarget(db.raw, options, config, workspace, claim.generation, emit);
    if (resolved === null) return 1;
    return await runResolvedLoop(db.raw, supervisor, ledger, claim.generation, resolved, options, config, workspace, emit);
  } catch (error) {
    emit(`lattice: run failed: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  } finally {
    await supervisor.close();
    db.close();
  }
}

interface ResolvedTarget {
  contract: TaskContract;
  taskSurface: TaskSurface;
  sessionId: string;
  runId: string;
  providerName: string;
  model: string;
  baseUrl: string | undefined;
}

// Fresh tasks create contract, session and run; resumed tasks reload them
// from the ledger through the ResumeGate. Either way the budget below comes
// from the persisted contract, never from a renewed default.
function resolveTaskTarget(
  db: ReturnType<typeof openLatticeDb>["raw"],
  options: RunCommandOptions,
  config: { maxModelAttempts: number | null; maxTotalTokens: number | null; taskExpiryMs: number | null; commandTimeoutMs: number },
  workspace: string,
  ownerGeneration: number,
  emit: (line: string) => void,
): ResolvedTarget | null {
  if (options.resumeTaskId === undefined) {
    const resolution = resolveAcceptance(options.task, options.acceptance);
    const acceptance = resolution.criteria;
    const contract = createContract({
      taskId: `task-${randomUUID()}`,
      rootId: `root-${randomUUID()}`,
      objective: options.task,
      scope: [workspace],
      acceptanceCriteria: acceptance,
      obligations: ["preserve human work"],
      grants: [
        {
          subject: "agent",
          operations: TOOL_OPERATIONS,
          targets: [workspace],
          expiresAt: null,
          limits: { maxCalls: config.maxModelAttempts, maxTokens: config.maxTotalTokens },
        },
      ],
      prohibitions: ["publish"],
      realm: "local-trusted",
      allowedProvider: options.providerName,
      allowedModel: options.model,
      expiresAt: config.taskExpiryMs === null ? null : new Date(Date.now() + config.taskExpiryMs).toISOString(),
      retentionPolicy: "retain until explicit deletion",
      origin: "cli run",
    });
    persistContract(db, contract);
    recordTaskEvent(db, contract.taskId, "chat", { author: "user", text: options.task, id: `objective-${contract.taskId}` });
    recordTaskEvent(db, contract.taskId, "acceptance-policy", { source: resolution.source, policyVersion: resolution.policyVersion, reason: resolution.reason, revision: contract.revision });
    const { sessionId } = openSession(db, contract.rootId);
    const runId = openRun(db, {
      sessionId,
      rootId: contract.rootId,
      taskId: contract.taskId,
      manifest: { provider: options.providerName, model: options.model, workspace, origin: "cli run" },
    });
    emit(`lattice: task=${contract.taskId} session=${sessionId}`);
    return {
      contract,
      taskSurface: {
        objective: options.task,
        acceptanceCriteria: acceptance,
        grants: [`${TOOL_OPERATIONS.join(", ")} under workspace`],
        prohibitions: ["publish"],
        obligations: ["preserve human work"],
        unknowns: [],
        humanDecisions: [],
        versions: [],
        lastError: null,
      },
      sessionId,
      runId,
      providerName: options.providerName,
      model: options.model,
      baseUrl: options.baseUrl,
    };
  }
  const contract = readContract(db, options.resumeTaskId);
  if (contract === null) {
    emit(`lattice: unknown task ${options.resumeTaskId}`);
    return null;
  }
  recoverOrphanedTasks(db, ownerGeneration);
  if (options.acknowledgeUnknown === true) acknowledgeUnknownEffects(db, contract.taskId, { actor: "human (cli)", note: "lattice run --resume --acknowledge-unknown" });
  const gate = evaluateResumeGate(db, { taskId: contract.taskId, generation: ownerGeneration, packageVersion: "0.0.0" });
  if (!gate.canResume) {
    emit(`lattice: resume refused for ${contract.taskId}:`);
    for (const blocker of gate.blockers) emit(`lattice: - ${blocker.code}: ${blocker.detail}`);
    return null;
  }
  const report = resumeTask(db, { taskId: contract.taskId, generation: ownerGeneration, packageVersion: "0.0.0" });
  if (report.newRunId === null) {
    emit(`lattice: resume failed for ${contract.taskId}: no run opened`);
    return null;
  }
  const manifest = readRunManifest(db, contract.taskId);
  emit(`lattice: resumed task=${contract.taskId} session=${report.sessionId} run=${report.newRunId}`);
  emit(`lattice: pending obligations: ${report.obligationsPending.length === 0 ? "none" : report.obligationsPending.join(" | ").slice(0, 300)}`);
  emit(`lattice: unknowns: ${report.unknowns.length}, drifted files: ${report.drift.length}, active waits: ${report.waits.length}`);
  return {
    contract,
    taskSurface: {
      objective: contract.objective,
      acceptanceCriteria: [...contract.acceptanceCriteria],
      grants: contract.grants.map((grant) => `${grant.operations.join(", ")} under workspace`),
      prohibitions: [...contract.prohibitions],
      obligations: report.obligationsPending,
      unknowns: report.unknowns.map((entry) => `${entry.operation} ${entry.target ?? ""} (${entry.attemptId}): ${entry.reason}`.trim()),
      humanDecisions: report.humanDecisions,
      versions: [
        ...report.drift.map((entry) => `${entry.path}@${entry.current ?? "deleted"}`),
        ...report.verifications.map((verification) => `verify ${verification.command}: exit ${verification.exitCode}`),
      ],
      lastError: report.state === "BLOCKED" || report.state === "NEEDS_INPUT" ? report.stateReason : null,
    },
    sessionId: report.sessionId,
    runId: report.newRunId,
    providerName: manifest.provider,
    model: manifest.model,
    baseUrl: manifest.baseUrl ?? undefined,
  };
}

async function runResolvedLoop(
  dbRaw: ReturnType<typeof openLatticeDb>["raw"],
  supervisor: ProcessSupervisor,
  ledger: VerifyLedger,
  ownerGeneration: number,
  resolved: ResolvedTarget,
  options: RunCommandOptions,
  config: { commandTimeoutMs: number },
  workspace: string,
  emit: (line: string) => void,
): Promise<number> {
  const { contract, taskSurface, sessionId, runId } = resolved;
  const acceptance = new TaskAcceptance(workspace, contract.acceptanceCriteria);
  if (acceptance.clarificationReason !== null) {
    recordTaskEvent(dbRaw, contract.taskId, "task-state", { state: "NEEDS_INPUT", reason: acceptance.clarificationReason });
    emit(`lattice: ASK: ${acceptance.clarificationReason}`);
    return 2;
  }
  let provider: ProviderAdapter;
  try {
    provider = selectProvider({
      providerName: resolved.providerName,
      ...(options.fakeScriptPath !== undefined ? { fakeScriptPath: options.fakeScriptPath } : {}),
      ...(resolved.baseUrl !== undefined ? { baseUrl: resolved.baseUrl } : {}),
    });
  } catch (error) {
    emit(`lattice: ${error instanceof Error ? error.message : "unknown error"}`);
    return 1;
  }
  emit(`lattice: provider=${resolved.providerName} model=${resolved.model} workspace=${workspace}${resolved.baseUrl !== undefined ? ` baseUrl=${resolved.baseUrl}` : ""}`);
  const granted = grantedFromContract(contract);
  // Deterministic process waiting: supervised handles are probed with a
  // zero-timeout poll each iteration; a still-running process pauses the
  // loop with zero model calls until a later (re)start observes its end.
  const waiter = new HandleWaiter(
      dbRaw,
      contract.taskId,
      {
        pollProcess: async (handle) => {
          const out = await supervisor.execute({ op: "poll", handle, timeoutMs: 0, generation: ownerGeneration });
          if (out.errorKind !== undefined) return { lost: true, reason: out.summary };
          if (out.status === "completed" && out.complete === true) {
            return { running: false as const, observation: `[process ${handle}] ${out.summary}${out.detail !== undefined ? `\n${out.detail.slice(0, 2000)}` : ""}` };
          }
          return { running: true as const };
        },
      },
      contract.obligations[0] ?? "complete the task",
    );
    const loopOptions: LoopOptions = {
      db: dbRaw,
      provider,
      model: resolved.model,
      contract,
      sessionId,
      runId,
      taskSurface,
      tools: buildToolset({
        directoryOnly: acceptance.directoryOnly,
        supervisor,
        verifyTriggers:
          options.verifyExecutable !== undefined
            ? [
                {
                  executable: options.verifyExecutable,
                  argv: options.verifyArgs ?? [],
                  onResult: (result) => {
                    ledger.record(result);
                    recordVerificationEvent(dbRaw, contract.taskId, {
                      command: result.command,
                      cwd: result.cwd,
                      exitCode: result.exitCode,
                      passed: result.passed,
                      failed: result.failed,
                      skipped: result.skipped,
                      countsKnown: result.countsKnown,
                    });
                  },
                },
              ]
            : [],
      }).map(tool => ({ ...tool, run: async (argsJson, context) => {
        await acceptance.prepare(tool.name, context.signal);
        const out = await tool.run(argsJson, context);
        await acceptance.observe(tool.name, argsJson, out.result);
        return out;
      } })),
      toolContext: { workspaceRoot: workspace, realm: "local-trusted", timeoutMs: config.commandTimeoutMs },
      ownerGeneration,
      grantedCalls: granted.calls,
      grantedTokens: granted.tokens,
      ...(options.maxIterations === undefined ? {} : { maxIterations: options.maxIterations }),
      acceptanceVerifiers: [(response) => acceptance.check(response?.text), ...(options.verifyExecutable === undefined ? [] : [() => ledger.check()])],
      verifyAfterTools: acceptance.hasFilesystemPredicate,
      conversation: () => conversationWithLineage(dbRaw, contract.taskId),
      modelRef: { provider, providerId: resolved.providerName, model: resolved.model, endpoint: resolved.baseUrl ?? null },
      waiter,
      beforeRequest: () => { if (acceptance.inventoryInstruction !== null && !taskSurface.obligations.includes(acceptance.inventoryInstruction)) taskSurface.obligations = [...taskSurface.obligations, acceptance.inventoryInstruction]; },
      onModelText: (text, source = "model") => { recordTaskEvent(dbRaw, contract.taskId, "chat", { author: "agent", text, source }); emit(text); },
      onEvent: (event) => {
        if (event.kind === "tool-start") emit(`[tool] ${event.tool} started`);
        else if (event.kind === "tool-end") {
          emit(`[tool] ${event.tool} ${event.status}`);
          waiter.noteToolEnd(event.tool, event.status, event.handle);
        } else if (event.kind === "model-response") emit(`[model] responded with ${event.toolCalls} tool call(s)`);
      },
    };
    const stop = await runTaskLoop(loopOptions);
    emit(`lattice: ${stop.decision}: ${stop.reason}`);
    emit(`lattice: iterations=${stop.iterations} modelCalls=${stop.modelCalls} toolDispatches=${stop.toolDispatches}`);
    // The terminal task state persists so sessions/resume/export observe the
    // same outcome after restart. A stable WAIT keeps its own state event.
    if (stop.wait !== undefined) {
      emit(`lattice: wait ${stop.wait.waitId}: ${stop.wait.condition}; the app must stay alive for a wake to arrive`);
      return 4;
    }
    recordTaskEvent(
      dbRaw,
      contract.taskId,
      "task-state",
      stop.decision === "STOP"
        ? { state: "COMPLETED", reason: stop.reason }
        : stop.decision === "ASK"
          ? { state: "NEEDS_INPUT", reason: stop.reason }
          : { state: "BLOCKED", reason: stop.reason },
    );
  if (stop.decision === "STOP") return 0;
  if (stop.decision === "ASK") return 2;
  return 3;
}
