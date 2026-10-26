export const PROTOCOL_VERSION = "ui-1";

export type TaskState =
  | "READY"
  | "RUNNING"
  | "WAITING"
  | "NEEDS_INPUT"
  | "BLOCKED"
  | "COMPLETED"
  | "CANCELLED"
  // The process that owned this task's execution ended unexpectedly. A fact
  // about the local executor, never about remote or filesystem effects.
  | "INTERRUPTED";

export type ToolActivityStatus =
  | "running"
  | "completed"
  | "failed"
  | "denied"
  | "cancelled"
  | "timeout"
  | "unknown";

export interface MessageView {
  id: string;
  seq: number;
  author: "user" | "agent" | "system";
  source?: "model" | "verified";
  text: string;
  recordedAt: string;
}

export interface ToolActivityView {
  id: string;
  seq: number;
  tool: string;
  target: string | null;
  status: ToolActivityStatus;
  summary: string;
  detail: string | null;
  version: string | null;
  complete: boolean | null;
  truncated: boolean;
  durationMs: number | null;
  recordedAt: string;
}

export interface VerificationView {
  id: string;
  seq: number;
  command: string;
  cwd: string;
  exitCode: number | null;
  passed: number | null;
  failed: number | null;
  skipped: number | null;
  countsKnown: boolean;
  recordedAt: string;
}

export interface SteeringView {
  id: string;
  seq: number;
  text: string;
  mode: "guide" | "forbid";
  state: "received" | "accepted" | "applied";
  expectedRevision: number;
  appliedRevision: number | null;
  recordedAt: string;
}

export interface BudgetView {
  grantedCalls: number | null;
  grantedTokens: number | null;
  reservedCalls: number;
  reservedTokens: number;
  settledCalls: number;
  settledTokens: number;
  uncertainUsageAttempts?: number;
  // Subset of reserved held by UNKNOWN effects: possibly consumed, never zero.
  possibleCalls?: number;
  possibleTokens?: number;
}

export interface UnknownView {
  attemptId: string;
  operation: string;
  target: string | null;
  reason: string;
  recordedAt: string;
  acknowledged?: boolean;
  // What the server can do with it: observe the disk (edit), close it as
  // inert (read/search), record a human decision (exec/process/edit), or
  // only acknowledge it (model.invoke: possible remote consumption).
  reconcile?: "observe" | "decide" | "acknowledge-only";
}

// How a task ended, kept apart from its state: an automatic verification,
// a human acceptance and an unverifiable result are different facts and are
// never collapsed into "completed". Uncertain effects are reported alongside.
export type OutcomeKind = "verified" | "accepted" | "unverified" | "blocked";

export interface TaskOutcome {
  kind: OutcomeKind | null;
  detail: string;
  uncertainEffects: number;
  acceptedAt?: string;
  note?: string | null;
}

// An action waiting for the human's confirmation: exactly this tool with
// exactly these arguments. Approving it authorizes one execution only.
export interface ApprovalView {
  key: string;
  tool: string;
  description: string;
  argsJson: string;
  // Full length of the recorded arguments; larger than argsJson.length when
  // the view was cut.
  argsChars?: number;
  requestedAt: string;
}

// A recorded human answer to an approval request (or its withdrawal). It
// authorizes or blocks one attempt; it is never evidence that anything ran.
export interface ApprovalDecisionView {
  id: string;
  key: string;
  seq: number;
  tool: string;
  description: string;
  decision: "approved" | "denied" | "withdrawn";
  note: string | null;
  recordedAt: string;
}

// Server-computed affordances. The UI renders these instead of recomputing
// authority rules; every command is still revalidated when it arrives.
export interface Capability {
  allowed: boolean;
  reason?: string;
}

export type SendMode = "steer" | "continue" | "follow-up" | "none";

export interface TaskCapabilities {
  send: Capability & { mode: SendMode };
  stop: Capability;
  resume: Capability & { requiresAcknowledgement?: boolean };
  accept: Capability;
  reconcile: Capability;
  followUp: Capability;
  archive: Capability;
}

export interface WaitView {
  waitId: string;
  kind: string;
  condition: string;
  obligation: string;
  state: string;
}

export interface TaskSnapshot {
  protocol: typeof PROTOCOL_VERSION;
  taskId: string;
  rootId: string;
  workspace: string;
  objective: string;
  acceptanceCriteria: string[];
  state: TaskState;
  stateReason: string;
  contractRevision: number;
  provider: string;
  model: string;
  baseUrl: string | null;
  keyConfigured: boolean;
  pendingModel?: { provider: string; model: string; baseUrl: string | null } | null;
  unknowns: number;
  unknownHistory: UnknownView[];
  waits: WaitView[];
  resumable: boolean;
  resumeBlockers: string[];
  capabilities?: TaskCapabilities;
  budget: BudgetView;
  contextUsage: ContextUsage;
  messages: MessageView[];
  tools: ToolActivityView[];
  verifications: VerificationView[];
  steering: SteeringView[];
  cut: number;
  outcome?: TaskOutcome;
  // 1-based position when the task waits for the single executor.
  queuePosition?: number | null;
  archived?: boolean;
  approvalPolicy?: "none" | "confirm-mutations";
  approvals?: ApprovalView[];
  approvalHistory?: ApprovalDecisionView[];
  // Work session: the task this one continues (a follow-up has its own
  // contract; this is conversation context, never inherited authority).
  previous?: { taskId: string; objective: string; state: TaskState; messages: MessageView[] } | null;
}

export type UiEvent =
  | { seq: number; kind: "context"; contextUsage: ContextUsage }
  | { seq: number; kind: "message"; message: MessageView }
  | { seq: number; kind: "tool"; tool: ToolActivityView }
  | { seq: number; kind: "verification"; verification: VerificationView }
  | { seq: number; kind: "steering"; steering: SteeringView; contractRevision: number }
  | { seq: number; kind: "state"; state: TaskState; reason: string; contractRevision: number }
  | { seq: number; kind: "budget"; budget: BudgetView }
  | { seq: number; kind: "resync"; cut: number };

export type ContextUsage = ({ known: false; usedTokens?: number; contextWindow?: number }
  | { known: true; usedTokens: number; contextWindow: number }) & {
  provider?: string; endpoint?: string; model?: string; attemptId?: string;
  capacitySource?: "models-endpoint.context_length"; capacityKind?: "nominal";
};

// Single source of truth for accepted command kinds: the HTTP parser and the
// type both derive from this list, so a new command cannot be typed but
// silently refused on the wire.
export const COMMAND_KINDS = ["create-task", "follow-up-task", "start-task", "steer", "stop", "select-model", "set-key", "resume-task", "wake",
  "send-message", "reconcile", "accept-result", "archive-task", "decide-approval"] as const;

export type CommandKind = typeof COMMAND_KINDS[number];

export interface UiCommand {
  commandId: string;
  kind: CommandKind;
  taskId?: string;
  expectedRevision?: number;
  payload?: Record<string, unknown>;
}

export type CommandResult =
  | { accepted: true; commandId: string; taskId: string; revision: number; state: TaskState; detail?: string }
  | { accepted: false; commandId: string; reason: "duplicate" | "stale" | "invalid" | "denied"; revision: number; state: TaskState; detail?: string };

export interface SessionSummary {
  sessionId: string;
  taskId: string;
  rootId: string;
  workspace: string;
  objective: string;
  state: TaskState;
  updatedAt: string;
  parentTaskId?: string | null;
  outcome?: OutcomeKind | null;
  queuePosition?: number | null;
  archived?: boolean;
}
