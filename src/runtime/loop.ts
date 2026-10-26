import type { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import {
  compileSurface,
  type EvidenceItem,
  type ModelSurface,
  type TaskSurface,
} from "../context/compiler.js";
import {
  admitDurable,
  claimDurable,
  recordReceiptDurable,
  taskBudgetSnapshot,
} from "./effects.js";
import {
  cancelActiveWaits,
  enterWait,
  takePendingRevisions,
  acknowledgePendingRevisions,
  type WaitKind,
  type WaitRequest,
} from "./wait.js";
import { recordTaskEvent } from "./continuity.js";
import type { AttemptStatus, AttemptUsage } from "../telemetry/usage.js";
import type { TaskContract } from "./contract.js";
import { isContractExpired } from "./contract.js";
import { exceedsLimit } from "./budget.js";
import { advanceCompositionEpoch, bindRequest, compositionForRoute, payloadDigest, type RequestBinding } from "./composition.js";
import type {
  ModelRequest,
  ModelResponse,
  ProviderAdapter,
  ToolDefinition,
} from "../providers/types.js";
import { normalizeUsageQuantities } from "../telemetry/usage.js";
import { parseToolArgs, versionKey, type ToolContext, type ToolResult } from "../tools/types.js";

export type LoopDecision = "CONTINUE" | "ASK" | "STOP" | "ESCALATE";

export interface LoopStop {
  decision: LoopDecision;
  reason: string;
  iterations: number;
  modelCalls: number;
  toolDispatches: number;
  // Present when the loop paused in a stable WAIT instead of deciding: the
  // task state is WAITING/NEEDS_INPUT, zero model calls were made for the
  // wait itself, and the app must stay alive for a wake to arrive.
  wait?: { waitId: string; kind: WaitKind; condition: string } | undefined;
}

export interface RegisteredTool {
  name: string;
  definition: ToolDefinition;
  run(argsJson: string, context: ToolContext): Promise<{ result: ToolResult; argsSummary: string }>;
}

export interface LoopOptions {
  db: DatabaseSync;
  provider: ProviderAdapter;
  model: string;
  modelRef?: { provider: ProviderAdapter; model: string; providerId?: string; endpoint?: string | null };
  contract: TaskContract;
  sessionId: string;
  runId: string;
  taskSurface: TaskSurface;
  tools: RegisteredTool[];
  toolContext: ToolContext;
  ownerGeneration: number;
  grantedCalls: number | null;
  grantedTokens: number | null;
  maxIterations?: number;
  // Optional durable execution-activity limit (R1 D-R1-02): caps the number
  // of tool dispatches for this activation. Unset means unbounded by this
  // mechanism (maxIterations and the LoopGovernor still bound the loop).
  // This is deliberately NOT a product default: no evidence-backed value
  // exists yet, and inventing one would be policy without data.
  maxToolDispatches?: number | undefined;
  contextChars?: number;
  signal?: AbortSignal;
  acceptanceVerifiers?: Array<(response?: ModelResponse) => AcceptanceCheck | Promise<AcceptanceCheck>>;
  verifyAfterTools?: boolean;
  beforeRequest?: () => void;
  onRequestBound?: (binding: RequestBinding) => void;
  afterRequestBound?: () => void;
  waiter?: LoopWaiter | undefined;
  // An alive owner may retain this activation while waiting for a process.
  // CLI callers without this hook retain the existing stable-WAIT exit.
  // The hook observes readiness only; check() still commits/consumes wakes.
  awaitWake?: (wait: NonNullable<LoopStop["wait"]>) => Promise<void>;
  onEvent?: (event: LoopEvent) => void;
  onModelText?: (text: string, source?: "model" | "verified") => void;
}

// Caller-provided wait policy. check() runs at the top of every iteration,
// before any model admission: returning a wait pauses the loop with zero new
// model calls, returning a wake injects observation evidence and continues.
// The waiter itself never invokes the model.
export interface LoopWaiter {
  check(): { wait: WaitRequest } | { woke: { text: string } } | null | Promise<{ wait: WaitRequest } | { woke: { text: string } } | null>;
}

export type LoopEvent =
  | { kind: "model-request"; requestId: string; attemptId: string }
  | { kind: "model-response"; requestId: string; attemptId: string; toolCalls: number }
  | { kind: "tool-start"; attemptId: string; tool: string }
  | { kind: "tool-end"; attemptId: string; tool: string; status: string; handle?: string | undefined }
  | { kind: "wake"; text: string }
  | { kind: "stop"; decision: LoopDecision; reason: string };

function actionFingerprint(tool: string, argsJson: string): string {
  const parsed = parseToolArgs(argsJson);
  return `${tool}:${parsed.ok ? JSON.stringify(canonicalObservation(parsed.value)) : argsJson}`;
}

function canonicalObservation(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalObservation);
  if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]: [string, unknown]) => [key, canonicalObservation(item)]));
  return value;
}

function isPromise(value: unknown): value is Promise<{ wait: WaitRequest } | { woke: { text: string } } | null> {
  return value instanceof Promise;
}

function isAborted(signal: AbortSignal | undefined): boolean { return signal?.aborted === true; }

// Bounds the `Versões:` anchor, which is never omitted (an oversized anchor
// would refuse the model call): the least recently established path goes
// first and the model reads it again if it needs to edit it.
const MAX_ANCHORED_VERSIONS = 16;
const MAX_ANCHORED_VERSION_CHARS = 2_000;

export async function runTaskLoop(options: LoopOptions): Promise<LoopStop> {
  const maxIterations = options.maxIterations;
  const contextChars = options.contextChars ?? 24_000;
  const evidence: EvidenceItem[] = [];
  const observations: string[] = [];
  const coverage = new Map<string, { version: string; items: Set<string> }>();
  let stagnant = 0;
  let iterations = 0;
  let modelCalls = 0;
  let toolDispatches = 0;
  let editRevision = 0;
  // Latest edit-usable version per path, as tool results established it. It
  // is rendered into the always-included `Versões:` anchor, so the version a
  // read returned survives evidence omission until superseded or retired.
  // Entries the caller seeded (resume drift `path@version`, verifications)
  // are dropped once a tool result speaks for the same path.
  let baseVersions = [...options.taskSurface.versions];
  const fileVersions = new Map<string, string>();
  const noteFileVersions = (updates: ReadonlyArray<{ path: string; version: string | null }>): void => {
    for (const update of updates) {
      fileVersions.delete(update.path);
      if (update.version !== null) fileVersions.set(update.path, update.version);
      baseVersions = baseVersions.filter((entry) => !entry.includes("@") || versionKey(entry.slice(0, entry.lastIndexOf("@"))) !== update.path);
    }
    const rendered = (): string[] => [...fileVersions].map(([file, version]) => `${file}@${version}`);
    while (fileVersions.size > MAX_ANCHORED_VERSIONS || (fileVersions.size > 0 && rendered().join(" | ").length > MAX_ANCHORED_VERSION_CHARS)) {
      fileVersions.delete(fileVersions.keys().next().value as string);
    }
    options.taskSurface.versions = [...baseVersions, ...rendered()];
  };
  const noteObservation = (action: string, text: string): boolean => {
    // Progress is scoped to actual observations and confirmed edits. No whole
    // workspace scan per tool; unrelated external changes cannot prove progress.
    const observation = createHash("sha256").update(JSON.stringify([action, text, editRevision])).digest("hex");
    stagnant = observations.includes(observation) ? stagnant + 1 : 0;
    observations.push(observation);
    if (observations.length > 8) observations.shift();
    return stagnant >= 4;
  };
  const noProgress = (): LoopStop => stop("ASK", "no progress: repeated equivalent observations without observed progress; human guidance required", iterations, modelCalls, toolDispatches, options);

  for (;;) {
    if (isAborted(options.signal)) {
      return stop("STOP", "interrupted by user", iterations, modelCalls, toolDispatches, options);
    }
    if (isContractExpired(options.contract)) {
      return stop("ESCALATE", "contract expired", iterations, modelCalls, toolDispatches, options);
    }
    if (maxIterations !== undefined && iterations >= maxIterations) {
      return stop(
        "ESCALATE",
        `iteration budget exhausted after ${iterations} iterations without verified completion`,
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }
    iterations += 1;

    // WAIT gate: consulted before context compilation and model admission,
    // so a stable wait costs exactly zero model calls. Revisions that
    // arrived mid-activation surface here as evidence, never as silent drops.
    // A synchronous waiter result never yields: without handles or due work
    // the iteration stays fully synchronous up to the provider call.
    let waitCheck: { wait: WaitRequest } | { woke: { text: string } } | null = null;
    if (options.waiter !== undefined) {
      const probed = options.waiter.check();
      waitCheck = isPromise(probed) ? await probed : probed;
    }
    if (waitCheck !== null) {
      if ("woke" in waitCheck) {
        const text = waitCheck.woke.text;
        evidence.push({ id: `ev-${evidence.length + 1}`, text: `Wake observed: ${text.slice(0, 4000)}${text.length > 4000 ? "\n[observation truncated in model context; full durable wake retained]" : ""}` });
        options.onEvent?.({ kind: "wake", text });
      } else {
        const waiting = enterWaiting(options, waitCheck.wait, iterations, modelCalls, toolDispatches);
        if (options.awaitWake === undefined || waiting.wait?.kind !== "process") return waiting;
        await options.awaitWake(waiting.wait);
        iterations -= 1;
        continue;
      }
    }
    options.beforeRequest?.();
    const pendingRevisions = takePendingRevisions(options.db, options.contract.taskId);
    for (const pending of pendingRevisions) {
      evidence.push({
        id: `ev-${evidence.length + 1}`,
        text: `Revision ${pending.revision} arrived during activation and was revalidated at a safe point: ${describePending(pending.payload)}`,
      });
    }

    let surface: ModelSurface;
    try {
      surface = compileSurface(options.taskSurface, evidence, { maxChars: contextChars });
    } catch (error) {
      return stop(
        "ESCALATE",
        error instanceof Error ? error.message : "context compilation failed",
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }

    const admittedAt = new Date();
    const requestId = `req-${randomUUID()}`;
    const provider = activeProvider(options);
    const providerId = options.modelRef?.providerId ?? provider.name;
    const model = activeModel(options);
    const request: ModelRequest = {
      model, system: surface.system, messages: [{ role: "user", content: surface.task }],
      tools: structuredClone(options.tools.map((tool) => tool.definition)),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    };
    const digest = payloadDigest(request);
    const epoch = advanceCompositionEpoch(options.db, options.contract.taskId,
      compositionForRoute(providerId, model, request.tools, provider.adapterRevision, surface.surfaceVersion, options.modelRef?.endpoint));
    const before = snapshotBudget(options);
    if ((before.granted.tokens !== null && before.settled.tokens + before.reserved.tokens >= before.granted.tokens) ||
        (before.granted.calls !== null && before.settled.calls + before.reserved.calls >= before.granted.calls)) {
      return stop("ESCALATE", "configured cumulative budget exhausted; outstanding reservations remain accounted", iterations, modelCalls, toolDispatches, options);
    }
    const modelAttempt = admitDurable(
      options.db,
      options.contract,
      {
        taskId: options.contract.taskId,
        operation: "model.invoke",
        target: `${providerId}/${model}`,
        actionKey: `model:${activeProvider(options).name}:${activeModel(options)}:${surface.surfaceVersion}:${iterations}`,
        authorityRevision: options.contract.revision,
        maxCalls: 1,
        maxTokens: estimateReservation(options, surface),
        argsJson: JSON.stringify({ surfaceVersion: surface.surfaceVersion, payloadDigest: digest, endpoint: options.modelRef?.endpoint ?? null }),
        requestId,
        provider: providerId,
        model,
        realm: options.toolContext.realm,
      },
      { calls: options.grantedCalls, tokens: options.grantedTokens },
      options.ownerGeneration,
      admittedAt,
      options.toolContext.workspaceRoot,
    );
    if (!modelAttempt.admitted) {
      return stop(
        "ESCALATE",
        modelAttempt.reason === "budget-exceeded"
          ? `budget exhausted: ${modelAttempt.detail}`
          : `model call not admitted: ${modelAttempt.detail}`,
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }
    const binding = bindRequest({ db: options.db, taskId: options.contract.taskId, requestId, attemptId: modelAttempt.attemptId,
      contractRevision: options.contract.revision, epoch, provider: providerId, model, request });
    options.db.exec("BEGIN IMMEDIATE");
    try {
      recordTaskEvent(options.db, options.contract.taskId, "request-binding", { ...binding });
      acknowledgePendingRevisions(options.db, options.contract.taskId, pendingRevisions.map((pending) => pending.revision));
      options.onRequestBound?.(binding);
      options.db.exec("COMMIT");
    } catch (error) { options.db.exec("ROLLBACK"); throw error; }
    options.afterRequestBound?.();
    const claim = claimDurable(options.db, modelAttempt.attemptId, options.ownerGeneration, options.contract.revision, {
      contract: options.contract,
      now: new Date(),
    });
    if (!claim.claimed) {
      recordReceiptDurable(options.db, {
        attemptId: modelAttempt.attemptId,
        outcome: "failed",
        summary: `claim refused (${claim.reason}); model not invoked`,
        detailJson: "{}",
        settledCalls: 0,
        settledTokens: 0,
      });
      return stop(
        "ESCALATE",
        `claim refused (${claim.reason})`,
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }
    options.onEvent?.({ kind: "model-request", requestId, attemptId: modelAttempt.attemptId });

    let response: ModelResponse;
    const dispatchedAt = new Date();
    modelCalls += 1;
    try {
      if (payloadDigest(request) !== binding.payloadDigest) throw new Error("request changed after binding; dispatch refused");
      response = await provider.complete(request);
    } catch (error) {
      const finishedAt = new Date();
      const uncertain = isUncertainProviderError(error);
      const usageDocument = modelUsageDocument(options, {
        attemptId: modelAttempt.attemptId,
        intentId: modelAttempt.intentId,
        requestId,
        status: uncertain ? "unknown" : "failed",
        usage: null,
        modelResolved: null,
        providerRequestId: null,
        error: errorMessage(error),
        admittedAt,
        dispatchedAt,
        finishedAt,
      });
      recordReceiptDurable(options.db, {
        attemptId: modelAttempt.attemptId,
        outcome: uncertain ? "unknown" : "failed",
        summary: `model invocation ${uncertain ? "uncertain" : "failed"}: ${errorMessage(error)}`,
        detailJson: JSON.stringify({ kind: errorName(error), usageFinal: false }),
        settledCalls: 1,
        settledTokens: 0,
        releaseUnused: false,
        usageDocument,
      });
      return stop(
        "ESCALATE",
        `model invocation ${uncertain ? "UNKNOWN; reconcile before retry" : "failed"}: ${errorMessage(error)}`,
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }
    const finishedAt = new Date();
    options.onEvent?.({ kind: "model-response", requestId, attemptId: modelAttempt.attemptId, toolCalls: response.toolCalls.length });
    const inventoryFinal = response.toolCalls.length === 0 && options.taskSurface.acceptanceCriteria.some(criterion => criterion.startsWith("directory-listing:"));
    if (response.text.trim() !== "" && !inventoryFinal) {
      options.onModelText?.(response.toolCalls.length === 0 ? response.text : response.text.slice(0, 2000), "model");
    }
    settleModelUsage(options, modelAttempt.attemptId, modelAttempt.intentId, requestId, response, admittedAt, dispatchedAt, finishedAt);
    const budget = snapshotBudget(options);
    if (exceedsLimit(budget.settled.calls, budget.granted.calls) || exceedsLimit(budget.settled.tokens, budget.granted.tokens)) {
      return stop("ESCALATE", "configured cumulative budget exceeded by observed provider usage; response accounted, no further effects authorized", iterations, modelCalls, toolDispatches, options);
    }

    if (response.toolCalls.length === 0) {
      const verification = await checkCompletion(options, response);
      if (verification.complete) {
        if (inventoryFinal && response.text.trim() !== "") options.onModelText?.(response.text, "model");
        if (verification.finalText !== undefined && (inventoryFinal || response.text.trim() === "")) options.onModelText?.(verification.finalText, "verified");
        return stop("STOP", verification.reason, iterations, modelCalls, toolDispatches, options);
      }
      if (inventoryFinal) options.onModelText?.(`Resultado não verificado: ${verification.reason}. Preciso de orientação para obter as entradas restantes.`);
      return stop(
        "ASK",
        `acceptance criteria unverified: ${verification.reason}; ${response.text.slice(0, 300)}`,
        iterations,
        modelCalls,
        toolDispatches,
        options,
      );
    }

    for (const call of response.toolCalls) {
      if (isAborted(options.signal)) {
        return stop("STOP", "interrupted by user", iterations, modelCalls, toolDispatches, options);
      }
      const registered = options.tools.find((tool) => tool.name === call.name);
      if (registered === undefined) {
        evidence.push({
          id: `ev-${evidence.length + 1}`,
          text: `Unknown tool requested: ${call.name}. Available: ${options.tools.map((tool) => tool.name).join(", ")}.`,
        });
        if (noteObservation(`unavailable:${call.name}`, "unknown tool")) return noProgress();
        continue;
      }
      // Optional execution-activity cap (R1 D-R1-02): counts dispatches, not
      // model calls. Unset = unbounded by this mechanism. The check runs
      // BEFORE admission so a capped tool never reserves, claims, or
      // dispatches; the denial is evidence, not a silent drop.
      if (options.maxToolDispatches !== undefined && toolDispatches >= options.maxToolDispatches) {
        evidence.push({
          id: `ev-${evidence.length + 1}`,
          text: `Tool ${call.name} denied: tool dispatch limit reached (${toolDispatches}/${options.maxToolDispatches}); no dispatch, no claim.`,
        });
        if (noteObservation(actionFingerprint(call.name, stableArgs(call.argumentsJson)), "dispatch limit reached")) return noProgress();
        continue;
      }
      const admission = admitDurable(
        options.db,
        options.contract,
        {
          taskId: options.contract.taskId,
          operation: call.name,
          target: callTarget(call.argumentsJson),
          actionKey: `tool:${call.name}:${stableArgs(call.argumentsJson)}`,
          authorityRevision: options.contract.revision,
          maxCalls: 0,
          maxTokens: 0,
          argsJson: call.argumentsJson,
          realm: options.toolContext.realm,
          ...(call.name === "edit" ? { additionalTargets: renameTargets(call.argumentsJson) } : {}),
        },
        { calls: options.grantedCalls, tokens: options.grantedTokens },
        options.ownerGeneration,
        new Date(),
        options.toolContext.workspaceRoot,
      );
      if (!admission.admitted) {
        if (admission.reason === "budget-exceeded") {
          return stop("ESCALATE", admission.detail, iterations, modelCalls, toolDispatches, options);
        }
        evidence.push({ id: `ev-${evidence.length + 1}`, text: `Tool ${call.name} denied: ${admission.detail}` });
        if (noteObservation(actionFingerprint(call.name, stableArgs(call.argumentsJson)), admission.detail)) return noProgress();
        continue;
      }
      const toolClaim = claimDurable(options.db, admission.attemptId, options.ownerGeneration, options.contract.revision, {
        contract: options.contract,
        now: new Date(),
      });
      if (!toolClaim.claimed) {
        recordReceiptDurable(options.db, {
          attemptId: admission.attemptId,
          outcome: "failed",
          summary: `claim refused (${toolClaim.reason}); tool not invoked`,
          detailJson: "{}",
          settledCalls: 0,
          settledTokens: 0,
        });
        evidence.push({ id: `ev-${evidence.length + 1}`, text: `Tool ${call.name} claim refused (${toolClaim.reason}).` });
        if (noteObservation(actionFingerprint(call.name, stableArgs(call.argumentsJson)), toolClaim.reason)) return noProgress();
        continue;
      }
      options.onEvent?.({ kind: "tool-start", attemptId: admission.attemptId, tool: call.name });
      toolDispatches += 1;
      const summary = await invokeTool(registered, call.argumentsJson, { ...options.toolContext, ownerGeneration: options.ownerGeneration, attemptId: admission.attemptId, ...(options.signal !== undefined ? { signal: options.signal } : {}) });
      recordReceiptDurable(options.db, {
        attemptId: admission.attemptId,
        outcome: summary.outcome,
        summary: summary.text,
        detailJson: summary.detailJson,
        settledCalls: 0,
        settledTokens: 0,
      });
      options.onEvent?.({
        kind: "tool-end",
        attemptId: admission.attemptId,
        tool: call.name,
        status: summary.outcome,
        ...(summary.handleId !== undefined ? { handle: summary.handleId } : {}),
      });
      evidence.push({ id: `ev-${evidence.length + 1}`, text: summary.text });
      if (summary.outcome === "unknown") return stop("ESCALATE", "tool effect UNKNOWN; reconcile before further work", iterations, modelCalls, toolDispatches, options);
      if (call.name === "edit" && summary.outcome === "confirmed") editRevision += 1;
      if (summary.fileVersions !== undefined) noteFileVersions(summary.fileVersions);
      const observation = JSON.parse(summary.detailJson) as { version?: unknown; observationKey?: unknown; progress?: { scope: string; version: string; items: string[] }; errorKind?: string };
      let repeated: boolean;
      if (observation.progress !== undefined) {
        const progress = observation.progress;
        const prior = coverage.get(progress.scope);
        const current = prior?.version === progress.version ? prior : { version: progress.version, items: new Set<string>() };
        const newItems = progress.items.some(item => !current.items.has(item));
        if (prior?.version !== progress.version || newItems) stagnant = 0;
        else stagnant += 1;
        progress.items.forEach(item => current.items.add(item));
        coverage.set(progress.scope, current);
        repeated = stagnant >= 4;
      } else repeated = noteObservation(observation.errorKind !== undefined ? `failed:${call.name}:${observation.errorKind}` : actionFingerprint(call.name, stableArgs(call.argumentsJson)), JSON.stringify([observation.observationKey ?? summary.text, observation.version ?? null]));
      if (repeated) {
        // A verified outcome wins over a repeat counter, but UNKNOWN above
        // still exits before this check and unresolved effects still gate it.
        if (options.verifyAfterTools === true) {
          const verification = await checkCompletion(options);
          if (verification.complete) { if (verification.finalText !== undefined) options.onModelText?.(verification.finalText, "verified"); return stop("STOP", verification.reason, iterations, modelCalls, toolDispatches, options); }
        }
        return noProgress();
      }
    }
    if (options.verifyAfterTools === true) {
      const verification = await checkCompletion(options);
      if (verification.complete) { if (verification.finalText !== undefined) options.onModelText?.(verification.finalText, "verified"); return stop("STOP", verification.reason, iterations, modelCalls, toolDispatches, options); }
      options.taskSurface.lastError = verification.reason;
    }
  }
}

function stop(
  decision: LoopStop["decision"],
  reason: string,
  iterations: number,
  modelCalls: number,
  toolDispatches: number,
  options: LoopOptions,
): LoopStop {
  // Terminal exits leave no orphan waits behind; the waiting exit below is
  // the only path that keeps them.
  try {
    cancelActiveWaits(options.db, options.contract.taskId, `loop ${decision}: ${reason.slice(0, 200)}`);
  } catch {
    // Wait cleanup must not mask the loop outcome; waits stay queryable.
  }
  options.onEvent?.({ kind: "stop", decision, reason });
  return { decision, reason, iterations, modelCalls, toolDispatches };
}

// Stable WAIT exit: persists the wait record and the WAITING/NEEDS_INPUT
// task state, then returns without admitting any model call. The caller
// keeps the app alive; a later wake (or manual resume) continues the loop.
function enterWaiting(
  options: LoopOptions,
  request: WaitRequest,
  iterations: number,
  modelCalls: number,
  toolDispatches: number,
): LoopStop {
  const { waitId } = enterWait(options.db, options.contract.taskId, request);
  const waitingState = request.kind === "input" ? "NEEDS_INPUT" : "WAITING";
  recordTaskEvent(options.db, options.contract.taskId, "task-state", {
    state: waitingState,
    reason: `waiting: ${request.condition} (wait ${waitId}); the app must stay alive for a wake to arrive`,
  });
  const reason = `waiting: ${request.condition}; zero model calls while stable`;
  options.onEvent?.({ kind: "stop", decision: "STOP", reason });
  return {
    decision: "STOP",
    reason,
    iterations,
    modelCalls,
    toolDispatches,
    wait: { waitId, kind: request.kind, condition: request.condition },
  };
}

function describePending(payload: Record<string, unknown>): string {
  const text = typeof payload["text"] === "string" ? payload["text"] : null;
  if (text !== null) return text.slice(0, 300);
  try {
    return JSON.stringify(payload).slice(0, 300);
  } catch {
    return "unreadable revision payload";
  }
}

async function invokeTool(
  registered: RegisteredTool,
  argsJson: string,
  context: ToolContext,
): Promise<{ outcome: "confirmed" | "failed" | "unknown"; text: string; detailJson: string; handleId?: string | undefined; fileVersions?: ToolResult["fileVersions"] }> {
  try {
    const { result } = await registered.run(argsJson, context);
    const previewTruncated = (result.detail?.length ?? 0) > 4000;
    const text = `[${registered.name}] ${result.status}: ${result.summary}${result.detail !== undefined ? `\n${result.detail.slice(0, 4000)}` : ""}${previewTruncated ? `\n[model preview truncated; recover captured output with read path="." handleId=${result.handleId ?? "unavailable"} offset=0 maxBytes=3000; executor truncation=${result.truncated === true}]` : ""}${result.truncationNote !== undefined ? `\n${result.truncationNote}` : ""}`;
    // Receipts carry before/after versions at the top level so resume-time
    // reconciliation and drift detection never depend on tool-specific
    // nesting inside the raw output blob.
    const detailJson = JSON.stringify({
      tool: registered.name,
      output: result.detail?.slice(0, 64 * 1024) ?? null,
      outputTruncated: (result.detail?.length ?? 0) > 64 * 1024 || result.truncated === true,
      version: result.version ?? null,
      afterVersion: result.version ?? null,
      observationKey: result.observationKey ?? null,
      progress: result.progress,
      directoryPage: result.directoryPage,
      handleId: result.handleId,
      previewTruncated,
      errorKind: result.errorKind,
    });
    if (result.status === "unknown" || result.effectUncertain === true) {
      return { outcome: "unknown", text, detailJson, handleId: result.handleId };
    }
    if (result.status === "denied" || result.status === "cancelled" || result.status === "timeout") {
      return { outcome: "unknown", text, detailJson, handleId: result.handleId };
    }
    if (result.errorKind !== undefined) return { outcome: "failed", text, detailJson, handleId: result.handleId, fileVersions: result.fileVersions };
    return { outcome: "confirmed", text, detailJson, handleId: result.handleId, fileVersions: result.fileVersions };
  } catch (error) {
    return {
      outcome: "unknown",
      text: `[${registered.name}] uncertain: executor threw (${errorMessage(error)}); effect reconciled as UNKNOWN`,
      detailJson: JSON.stringify({ tool: registered.name, output: null }),
    };
  }
}

function activeProvider(options: LoopOptions): ProviderAdapter {
  return options.modelRef?.provider ?? options.provider;
}

function activeModel(options: LoopOptions): string {
  return options.modelRef?.model ?? options.model;
}

interface ModelUsageSample {
  attemptId: string;
  intentId: string;
  requestId: string;
  status: AttemptStatus;
  usage: ModelResponse["usage"];
  modelResolved: string | null;
  providerRequestId: string | null;
  error: string | null;
  admittedAt: Date;
  dispatchedAt: Date;
  finishedAt: Date;
}

// Every physical model dispatch leaves an AttemptUsage revision in the
// ledger, including failures and UNKNOWN outcomes: unknown is never zero,
// and late corrections revise the same attempt instead of duplicating it.
function modelUsageDocument(options: LoopOptions, sample: ModelUsageSample): string {
  const normalized =
    sample.usage === null
      ? null
      : normalizeUsageQuantities({
          inputTotal: asIntOrNull(sample.usage.inputTokens),
          outputTotal: asIntOrNull(sample.usage.outputTokens),
          cacheRead: asIntOrNull(sample.usage.cacheReadTokens),
          cacheWrite: asIntOrNull(sample.usage.cacheWriteTokens),
          reasoningSubset: asIntOrNull(sample.usage.reasoningTokens),
          // Provider-declared input partition convention (TELEMETRY §3).
          // Only a boolean declared at the wire boundary is honored; any
          // other shape stays unknown so telemetry keeps partitions UNKNOWN.
          ...(sample.usage.inclusiveInput === true || sample.usage.inclusiveInput === false
            ? { inclusiveInput: sample.usage.inclusiveInput }
            : {}),
          source: `${activeProvider(options).name}/${activeProvider(options).adapterRevision}`,
        });
  const unknownQuantity = { value: null, quality: "unknown" as const, source: "lattice" };
  const doc: AttemptUsage = {
    schemaVersion: 1,
    sessionId: options.sessionId,
    runId: options.runId,
    taskId: options.contract.taskId,
    rootId: options.contract.rootId,
    requestId: sample.requestId,
    attemptId: sample.attemptId,
    parentAttemptId: null,
    intentId: sample.intentId,
    executorGeneration: options.ownerGeneration,
    provider: options.modelRef?.providerId ?? activeProvider(options).name,
    modelRequested: activeModel(options),
    modelResolved: sample.modelResolved,
    adapterRevision: activeProvider(options).adapterRevision,
    usageRevision: 0,
    usageFinal: normalized?.inputTotal.value !== null && normalized?.inputTotal.value !== undefined && normalized.outputTotal.value !== null,
    purpose: "primary",
    status: sample.status,
    admittedAt: sample.admittedAt.toISOString(),
    dispatchedAt: sample.dispatchedAt.toISOString(),
    firstTokenAt: null,
    finishedAt: sample.finishedAt.toISOString(),
    recordedAt: new Date().toISOString(),
    clockQuality: "wall",
    durationMs: Math.max(0, sample.finishedAt.getTime() - sample.dispatchedAt.getTime()),
    providerRequestId: sample.providerRequestId,
    error: sample.error,
    inputTotal: normalized?.inputTotal ?? unknownQuantity,
    inputNew: normalized?.inputNew ?? unknownQuantity,
    cacheRead: normalized?.cacheRead ?? unknownQuantity,
    cacheWrite: normalized?.cacheWrite ?? unknownQuantity,
    outputTotal: normalized?.outputTotal ?? unknownQuantity,
    reasoningSubset: normalized?.reasoningSubset ?? null,
  };
  return JSON.stringify(doc);
}

function settleModelUsage(
  options: LoopOptions,
  attemptId: string,
  intentId: string,
  requestId: string,
  response: ModelResponse,
  admittedAt: Date,
  dispatchedAt: Date,
  finishedAt: Date,
): void {
  const usage = response.usage;
  const usageDocument = modelUsageDocument(options, {
    attemptId,
    intentId,
    requestId,
    status: "completed",
    usage,
    modelResolved: response.modelResolved,
    providerRequestId: response.providerRequestId,
    error: null,
    admittedAt,
    dispatchedAt,
    finishedAt,
  });
  if (usage === null) {
    recordReceiptDurable(options.db, {
      attemptId,
      outcome: "confirmed",
      summary: `model responded with ${response.toolCalls.length} tool call(s); usage unknown, token ceiling held`,
      detailJson: JSON.stringify({ usageFinal: false, coverage: "unknown" }),
      settledCalls: 1,
      settledTokens: 0,
      releaseUnused: false,
      usageDocument,
    });
    return;
  }
  const normalized = normalizeUsageQuantities({
    inputTotal: asIntOrNull(usage.inputTokens),
    outputTotal: asIntOrNull(usage.outputTokens),
    cacheRead: asIntOrNull(usage.cacheReadTokens),
    cacheWrite: asIntOrNull(usage.cacheWriteTokens),
    reasoningSubset: asIntOrNull(usage.reasoningTokens),
    ...(usage.inclusiveInput === true || usage.inclusiveInput === false
      ? { inclusiveInput: usage.inclusiveInput }
      : {}),
    source: `${activeProvider(options).name}/${activeProvider(options).adapterRevision}`,
  });
  const input = normalized.inputTotal.value ?? 0;
  const output = normalized.outputTotal.value ?? 0;
  recordReceiptDurable(options.db, {
    attemptId,
    outcome: "confirmed",
    summary: `model responded with ${response.toolCalls.length} tool call(s)`,
    detailJson: JSON.stringify({
      usageRevision: 1,
      usageFinal: normalized.inputTotal.value !== null && normalized.outputTotal.value !== null,
      inputTotal: normalized.inputTotal,
      outputTotal: normalized.outputTotal,
      modelResolved: response.modelResolved,
    }),
    settledCalls: 1,
    settledTokens: input + output,
    releaseUnused: normalized.inputTotal.value !== null && normalized.outputTotal.value !== null,
    usageDocument,
  });
}

function estimateReservation(options: LoopOptions, surface: ModelSurface): number {
  // This is a scheduling estimate, not a provider context or billing bound.
  // Reserve at most remaining configured authority; actual usage is always
  // recorded even when the provider exceeds this estimate.
  const estimate = Buffer.byteLength(surface.system + surface.task + JSON.stringify(options.tools.map((tool) => tool.definition)), "utf8");
  const budget = snapshotBudget(options);
  return budget.granted.tokens === null ? estimate : Math.max(0, Math.min(estimate, budget.granted.tokens - budget.settled.tokens - budget.reserved.tokens));
}

function callTarget(argsJson: string): string | null {
  const parsed = parseToolArgs(argsJson);
  if (!parsed.ok) return null;
  // Authority target: the workspace-relative PATH the operation acts on.
  // Search queries are content, not paths: they must never enter the target
  // gate (a query like "/etc/passwd" would otherwise deny/fail spuriously),
  // so search intents carry a null target and rely on operation authority
  // plus root containment at the tool boundary.
  const value = parsed.value["path"] ?? parsed.value["target"] ?? parsed.value["executable"];
  return typeof value === "string" ? value : null;
}

function stableArgs(argsJson: string): string {
  const parsed = parseToolArgs(argsJson);
  if (!parsed.ok) return argsJson;
  return JSON.stringify(parsed.value);
}

function renameTargets(argsJson: string): string[] {
  const parsed = parseToolArgs(argsJson);
  return parsed.ok && parsed.value["kind"] === "rename" && typeof parsed.value["newPath"] === "string" ? [parsed.value["newPath"]] : [];
}

function asIntOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : "unknown";
}

function isUncertainProviderError(error: unknown): boolean {
  if (error === null || typeof error !== "object" || !("kind" in error)) return true;
  return error.kind === "timeout" || error.kind === "network" || error.kind === "unknown";
}

export interface AcceptanceCheck {
  complete: boolean;
  reason: string;
  finalText?: string;
}

async function checkCompletion(options: LoopOptions, response?: ModelResponse): Promise<AcceptanceCheck> {
  const pending = options.db.prepare("SELECT COUNT(*) AS n FROM intents WHERE task_id = ? AND state IN ('ADMITTED','CLAIMED','UNKNOWN')").get(options.contract.taskId) as { n: number };
  if (pending.n > 0) return { complete: false, reason: `${pending.n} unresolved effects require reconciliation` };
  return checkAcceptanceEvident(options.acceptanceVerifiers ?? [], response);
}

async function checkAcceptanceEvident(verifiers: NonNullable<LoopOptions["acceptanceVerifiers"]>, response?: ModelResponse): Promise<AcceptanceCheck> {
  // STOP requires evidence tied to acceptance criteria, never bare model
  // text; without a satisfied verifier the loop stalls to ASK.
  const checks = await Promise.all(verifiers.map(async (verifier) => verifier(response)));
  return checks.length === 0 ? { complete: false, reason: "no acceptance evidence recorded" } :
    checks.find((check) => !check.complete) ?? { complete: true, reason: checks.map((check) => check.reason).join("; "), ...(checks.some(check => check.finalText !== undefined) ? { finalText: checks.flatMap(check => check.finalText === undefined ? [] : [check.finalText]).join("\n\n") } : {}) };
}

export function snapshotBudget(options: LoopOptions): ReturnType<typeof taskBudgetSnapshot> {
  return taskBudgetSnapshot(options.db, options.contract.taskId, {
    calls: options.grantedCalls,
    tokens: options.grantedTokens,
  });
}
