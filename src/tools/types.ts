import path from "node:path";
import type { ToolDefinition } from "../providers/types.js";
import type { DirectoryPage } from "./directory.js";

export type ToolStatus =
  | "completed"
  | "running"
  | "denied"
  | "cancelled"
  | "timeout"
  | "unknown";

export interface ToolResult {
  status: ToolStatus;
  summary: string;
  detail?: string;
  version?: string;
  complete?: boolean;
  truncated?: boolean;
  truncationNote?: string;
  handleId?: string;
  errorKind?: string;
  errorRetryable?: boolean;
  effectUncertain?: boolean;
  // Executor-produced identity of substantive observed output. Presentation
  // metadata (e.g. elapsed milliseconds) must not count as new progress.
  observationKey?: string;
  directoryPage?: DirectoryPage;
  progress?: { scope: string; version: string; items: string[] };
  // Edit-usable content versions this result established, keyed by the
  // workspace-relative path the model used. null: any earlier version of
  // that path is no longer current (deleted, moved, or found stale).
  fileVersions?: Array<{ path: string; version: string | null }>;
}

export function versionKey(requested: string): string {
  return path.posix.normalize(requested.replace(/\\/g, "/")).replace(/^(\.\/)+/, "");
}

export interface ToolContext {
  workspaceRoot: string;
  realm: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  ownerGeneration?: number;
  attemptId?: string;
  // Explicit environment overlay the caller authorizes for tool children.
  // Ambient process.env is NEVER inherited: children are built from the
  // shared allowlist base plus this overlay plus per-call args (see
  // platform/childEnv.ts). Absent means no overlay.
  envOverlay?: Record<string, string> | undefined;
}

export interface Tool<TArgs> {
  readonly definition: ToolDefinition;
  execute(args: TArgs, context: ToolContext): Promise<ToolResult>;
}

export function toolFailure(kind: string, summary: string, retryable: boolean): ToolResult {
  return { status: "completed", summary, errorKind: kind, errorRetryable: retryable };
}

export function parseToolArgs(json: string): { ok: true; value: Record<string, unknown> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { ok: false, error: "tool arguments are not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: "tool arguments must be a JSON object" };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}
