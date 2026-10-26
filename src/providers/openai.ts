import { normalizeEndpoint, requireCredentialTransport, containsCredential } from "./endpoint.js";
import {
  ProviderError,
  type ModelRequest,
  type ModelResponse,
  type ProviderAdapter,
} from "./types.js";

export const OPENAI_ADAPTER_REVISION = "openai-chat-completions-4";
const DEFAULT_BASE_URL = "https://api.openai.com/v1";

export interface OpenAiAdapterOptions {
  apiKey: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

interface ChatCompletionsResponse {
  id?: unknown;
  model?: unknown;
  choices?: Array<{
    message?: {
      content?: unknown;
      tool_calls?: Array<{
        id?: unknown;
        type?: unknown;
        function?: { name?: unknown; arguments?: unknown };
      }>;
    };
    finish_reason?: unknown;
  }>;
  usage?: {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    total_tokens?: unknown;
    // Present on OpenAI Chat Completions responses when prompt caching is in
    // play, and always present (normalized) on OpenRouter Chat Completions
    // responses. Both vendors define prompt_tokens as the INCLUSIVE input
    // total: cached + written + ordinary input (see OpenAI prompt-caching
    // guide "ordinary_input_tokens = input_tokens - cached - cache_write",
    // OpenRouter ResponseUsage docs, openai-python PromptTokensDetails).
    // Absent details object = convention unknown (never zero-filled).
    prompt_tokens_details?: {
      cached_tokens?: unknown;
      cache_write_tokens?: unknown;
    } | null;
    completion_tokens_details?: { reasoning_tokens?: unknown };
  } | null;
}

function errorKind(status: number): { kind: "auth" | "rate-limited" | "server-error" | "invalid-request"; retryable: boolean } {
  if (status === 401 || status === 403) return { kind: "auth", retryable: false };
  if (status === 429) return { kind: "rate-limited", retryable: true };
  if (status >= 500) return { kind: "server-error", retryable: true };
  return { kind: "invalid-request", retryable: false };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function asCountOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

// Adapter for the OpenAI Chat Completions API (POST /chat/completions),
// per the official API reference, and for OpenAI-compatible local servers
// speaking the same endpoint. Non-streaming; one HTTP send per attempt.
// The adapter never retries: each additional send needs its own AttemptId.
// An empty API key sends no Authorization header; only use that against a
// local endpoint that needs no auth, never against the hosted API.
export class OpenAiAdapter implements ProviderAdapter {
  readonly name = "openai";
  readonly adapterRevision = OPENAI_ADAPTER_REVISION;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly requestTimeoutMs: number;

  constructor(options: OpenAiAdapterOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = normalizeEndpoint(options.baseUrl ?? DEFAULT_BASE_URL);
    requireCredentialTransport(this.baseUrl, this.apiKey);
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.requestTimeoutMs = options.requestTimeoutMs ?? 120_000;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    if (request.signal?.aborted === true) {
      throw new ProviderError("aborted", "Provider request aborted before dispatch", false, null, "not-sent");
    }
    const controller = new AbortController();
    const state = { timedOut: false };
    const timeout = setTimeout(() => {
      state.timedOut = true;
      controller.abort();
    }, this.requestTimeoutMs);
    const onCallerAbort = (): void => {
      controller.abort();
    };
    request.signal?.addEventListener("abort", onCallerAbort, { once: true });
    try {
      let httpResponse: Response;
      try {
        httpResponse = await this.fetchImpl(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          redirect: "error",
          headers: {
            "Content-Type": "application/json",
            ...(this.apiKey.trim() !== "" ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({
            model: request.model,
            messages: [
              { role: "system", content: request.system },
              ...request.messages.map((message) => message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0
                ? {
                    role: "assistant",
                    // Spec: content may be null when tool_calls is present.
                    content: message.content === "" ? null : message.content,
                    tool_calls: message.toolCalls.map((call) => ({ id: call.id, type: "function", function: { name: call.name, arguments: call.argumentsJson } })),
                  }
                : {
                    role: message.role,
                    content: message.content,
                    ...(message.toolCallId !== undefined
                      ? { tool_call_id: message.toolCallId }
                      : {}),
                  }),
            ],
            tools: request.tools.map((tool) => ({
              type: "function",
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.parameters,
              },
            })),
            tool_choice: "auto",
            ...(request.maxOutputTokens !== undefined
              ? { max_completion_tokens: request.maxOutputTokens }
              : {}),
          }),
          signal: controller.signal,
        });
      } catch (error) {
        const connectFailure = connectPhaseFailure(error);
        if (controller.signal.aborted) {
          throw new ProviderError(
            state.timedOut ? "timeout" : "aborted",
            state.timedOut ? "Provider request timed out" : "Provider request aborted while in flight",
            state.timedOut,
          );
        }
        if (connectFailure !== null) throw new ProviderError("unreachable", `Provider endpoint unreachable (${connectFailure}); request not sent`, true, null, "not-sent");
        throw new ProviderError("network", "Provider network request failed", true);
      }
      if (!httpResponse.ok) {
        const { kind, retryable } = errorKind(httpResponse.status);
        throw new ProviderError(
          kind,
          `Provider request failed with status ${httpResponse.status}`,
          retryable,
          httpResponse.status,
        );
      }
      let body: ChatCompletionsResponse;
      try { body = (await httpResponse.json()) as ChatCompletionsResponse; }
      catch { throw new ProviderError("unknown", "Provider returned invalid JSON", false); }
      if (containsCredential(body, this.apiKey)) throw new ProviderError("unknown", "Provider response contained a credential; output withheld", false);
      return normalizeResponse(body);
    } finally {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onCallerAbort);
    }
  }
}

// Error codes that can only occur before the request body is transmitted:
// resolution, connection establishment and TLS handshake. Resets and socket
// closes are excluded on purpose: they can happen after the request was sent.
const CONNECT_PHASE_CODES = new Set([
  "ECONNREFUSED", "ENOTFOUND", "EAI_AGAIN", "EHOSTUNREACH", "ENETUNREACH", "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "ERR_TLS_CERT_ALTNAME_INVALID",
]);

export function connectPhaseFailure(error: unknown): string | null {
  const seen = new Set<unknown>();
  const visit = (value: unknown): string | null => {
    if (value === null || typeof value !== "object" || seen.has(value)) return null;
    seen.add(value);
    const record = value as { code?: unknown; cause?: unknown; errors?: unknown; message?: unknown };
    if (typeof record.code === "string" && CONNECT_PHASE_CODES.has(record.code)) return record.code;
    // Fetch refuses ports on its blocklist before opening any connection.
    if (record.code === undefined && record.message === "bad port") return "blocked port";
    if (Array.isArray(record.errors)) {
      // Happy-eyeballs: every address must have failed to connect.
      const codes = record.errors.map(visit);
      if (codes.length > 0 && codes.every((code) => code !== null)) return codes[0] ?? null;
    }
    return visit(record.cause);
  };
  return visit(error);
}

function normalizeResponse(body: ChatCompletionsResponse): ModelResponse {
  const choice = body.choices?.[0];
  if (choice === undefined) {
    throw new ProviderError("unknown", "Provider response contained no choices", false);
  }
  const message = choice.message;
  if (message === undefined) {
    throw new ProviderError("unknown", "Provider response choice contained no message", false);
  }
  const toolCalls = (message.tool_calls ?? []).map((call, index) => {
    if (call.type !== undefined && call.type !== "function") {
      throw new ProviderError(
        "unknown",
        `Unsupported tool call type at index ${index}`,
        false,
      );
    }
    const name = call.function?.name;
    if (typeof name !== "string" || name === "") {
      throw new ProviderError("unknown", `Tool call at index ${index} has no name`, false);
    }
    const id = typeof call.id === "string" && call.id !== "" ? call.id : `openai-call-${index}`;
    const args = call.function?.arguments;
    return { id, name, argumentsJson: typeof args === "string" ? args : "{}" };
  });
  const usage = body.usage;
  const reasoning =
    typeof usage?.completion_tokens_details?.reasoning_tokens === "number"
      ? usage.completion_tokens_details.reasoning_tokens
      : undefined;
  // Cache partitions are provider-declared here, at the wire boundary, and
  // nowhere else. prompt_tokens is the INCLUSIVE input total per both
  // vendors; the details object (when present and valid) partitions it.
  // Only VALID counts (non-negative integers; explicit zero counts) become
  // known quantities. Absent, mistyped, or negative fields prove nothing
  // about caching, so the partitions stay absent (UNKNOWN downstream)
  // rather than becoming zero. The inclusive-input convention is declared
  // only when BOTH partitions are valid: declaring it on partial evidence
  // would let telemetry derive the missing partition as zero
  // (usage.ts `?? 0`), fabricating precision. Partial evidence therefore
  // keeps the convention undeclared and the window fail-closed.
  const details = asRecord(usage?.prompt_tokens_details);
  const cachedTokens = details !== null ? asCountOrUndefined(details["cached_tokens"]) : undefined;
  const cacheWriteTokens = details !== null ? asCountOrUndefined(details["cache_write_tokens"]) : undefined;
  const hasFullCacheEvidence = cachedTokens !== undefined && cacheWriteTokens !== undefined;
  return {
    text: typeof message.content === "string" ? message.content : "",
    toolCalls,
    usage:
      usage == null
        ? null
        : {
            inputTokens: usage.prompt_tokens,
            outputTokens: usage.completion_tokens,
            totalTokens: usage.total_tokens,
            ...(cachedTokens !== undefined ? { cacheReadTokens: cachedTokens } : {}),
            ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
            // The inclusive-input convention is declared only on full valid
            // cache evidence; otherwise it stays unknown and telemetry keeps
            // the partitions UNKNOWN (fail-closed).
            ...(hasFullCacheEvidence ? { inclusiveInput: true as const } : {}),
            ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
          },
    modelResolved: typeof body.model === "string" ? body.model : null,
    providerRequestId: typeof body.id === "string" ? body.id : null,
  };
}
