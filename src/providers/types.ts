export interface ToolParameterSchema {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  oneOf?: Array<Record<string, unknown>>;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameterSchema;
}

export interface ModelMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolName?: string;
  // Assistant turns that requested tools; each id is answered by exactly one
  // later `tool` message carrying the same toolCallId.
  toolCalls?: ModelToolCall[];
}

export interface ModelToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

export interface RawUsage {
  inputTokens?: unknown;
  outputTokens?: unknown;
  cacheReadTokens?: unknown;
  cacheWriteTokens?: unknown;
  reasoningTokens?: unknown;
  // Declared by the provider boundary when the wire response carries enough
  // evidence to fix the Lattice input partition convention (TELEMETRY §3):
  //   inputTotal = inputNew + cacheRead + cacheWrite   (disjoint)
  // `true`  = provider's input field already includes the cache partitions
  //           (OpenAI prompt_tokens and OpenRouter prompt_tokens semantics);
  // `false` = provider's input field is already exclusive of them;
  // absent  = convention unknown; telemetry keeps partitions UNKNOWN and
  //           downstream consumers must refuse the window (never zero-filled).
  inclusiveInput?: boolean | undefined;
  [key: string]: unknown;
}

export interface ModelResponse {
  text: string;
  toolCalls: ModelToolCall[];
  usage: RawUsage | null;
  modelResolved: string | null;
  providerRequestId: string | null;
}

export interface ModelRequest {
  model: string;
  system: string;
  messages: ModelMessage[];
  tools: ToolDefinition[];
  maxOutputTokens?: number;
  signal?: AbortSignal;
}

export type ProviderErrorKind =
  | "auth"
  | "rate-limited"
  | "server-error"
  | "network"
  // The request provably never left this machine: name resolution,
  // connection refusal or TLS setup failed before any byte was sent.
  | "unreachable"
  | "timeout"
  | "aborted"
  | "invalid-request"
  | "unknown";

// What the provider may have done with the request. Only "not-sent" is
// proof of no remote execution; an error status after delivery can still
// follow processing (and billing), so anything not provably rejected up
// front stays "uncertain".
export type ProviderDelivery = "not-sent" | "uncertain" | "rejected";

export function defaultDelivery(kind: ProviderErrorKind): ProviderDelivery {
  switch (kind) {
    case "unreachable":
      return "not-sent";
    case "auth":
    case "invalid-request":
      return "rejected";
    default:
      return "uncertain";
  }
}

export class ProviderError extends Error {
  readonly kind: ProviderErrorKind;
  readonly retryable: boolean;
  readonly statusCode: number | null;
  readonly delivery: ProviderDelivery;
  constructor(kind: ProviderErrorKind, message: string, retryable: boolean, statusCode: number | null = null, delivery: ProviderDelivery = defaultDelivery(kind)) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryable = retryable;
    this.statusCode = statusCode;
    this.delivery = delivery;
  }
}

export interface ProviderAdapter {
  readonly name: string;
  readonly adapterRevision: string;
  complete(request: ModelRequest): Promise<ModelResponse>;
}
