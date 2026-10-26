import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { contentVersion } from "./read.js";
import { throwIfFault } from "../runtime/faults.js";
import { toolFailure, versionKey, type Tool, type ToolContext, type ToolResult } from "./types.js";

export type EditOperation =
  | { kind: "create"; path: string; content: string }
  | { kind: "replace"; path: string; expectedVersion: string; oldText: string; newText: string }
  | { kind: "delete"; path: string; expectedVersion: string }
  | { kind: "rename"; path: string; expectedVersion: string; newPath: string };

// Fields each kind requires; every other edit field is refused for it. The
// schema below and validateEditArgs are both derived from this table so the
// model-facing contract and the executor cannot drift apart.
const EDIT_FIELDS = {
  create: ["path", "content"],
  replace: ["path", "expectedVersion", "oldText", "newText"],
  delete: ["path", "expectedVersion"],
  rename: ["path", "expectedVersion", "newPath"],
} as const satisfies Record<EditOperation["kind"], readonly string[]>;
const ALL_EDIT_FIELDS = ["kind", "path", "content", "expectedVersion", "oldText", "newText", "newPath"];
// Same representation read returns and contentVersion computes.
const CONTENT_VERSION = /^sha256:[0-9a-f]{16}$/;

export const EDIT_DEFINITION: ToolDefinition = {
  name: "edit",
  description:
    "Versioned literal file edit: create (target must be absent), replace (single literal match under the expected content version), delete, or rename. replace, delete and rename require expectedVersion: copy the version a line read of that file returned (shown as 'version sha256:...'); never invent it. A stale-version refusal means the file changed since that read: read it again before retrying. No fuzzy matching, no silent formatting.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: ["create", "replace", "delete", "rename"], description: "create: path+content. replace: path+expectedVersion+oldText+newText. delete: path+expectedVersion. rename: path+expectedVersion+newPath. Other fields are refused." },
      path: { type: "string", description: "Workspace-relative file path to act on" },
      content: { type: "string", description: "create only: full content of the new file" },
      expectedVersion: { type: "string", description: "replace/delete/rename: whole-file content version 'sha256:<16 hex>' exactly as returned by the latest read of this path (or by the previous edit of it). The edit is refused unless the file still has this version. Never guess it; byte-range 'metadata:' versions are not accepted." },
      oldText: { type: "string", description: "replace only: non-empty text that must occur exactly once, literally (including line endings)" },
      newText: { type: "string", description: "replace only: text that replaces oldText (may be empty)" },
      newPath: { type: "string", description: "rename only: workspace-relative destination; must not exist" },
    },
    required: ["kind", "path"],
    additionalProperties: false,
    oneOf: (Object.keys(EDIT_FIELDS) as Array<keyof typeof EDIT_FIELDS>).map((kind) => ({
      properties: { kind: { const: kind } },
      required: ["kind", ...EDIT_FIELDS[kind]],
      not: { anyOf: ALL_EDIT_FIELDS.filter((field) => field !== "kind" && !(EDIT_FIELDS[kind] as readonly string[]).includes(field)).map((field) => ({ required: [field] })) },
    })),
  },
};

// The registry decodes JSON without schema validation, so the executor
// enforces the per-kind contract itself: a missing or foreign field, or a
// version not in content-version form, is invalid-args, never stale-version.
export function validateEditArgs(raw: unknown): string | null {
  if (typeof raw !== "object" || raw === null) return "edit arguments must be an object";
  const fields = raw as Record<string, unknown>;
  const kind = fields["kind"];
  if (typeof kind !== "string" || !Object.hasOwn(EDIT_FIELDS, kind)) return "edit kind must be one of create, replace, delete, rename";
  const allowed: readonly string[] = EDIT_FIELDS[kind as keyof typeof EDIT_FIELDS];
  const foreign = Object.keys(fields).filter((key) => key !== "kind" && !allowed.includes(key));
  if (foreign.length > 0) return `edit ${kind} does not accept ${foreign.join(", ")}; it takes ${allowed.join(", ")}`;
  const missing = allowed.filter((key) => typeof fields[key] !== "string");
  if (missing.length > 0) return `edit ${kind} requires string ${missing.join(", ")}`;
  if (fields["path"] === "") return "edit path must be non-empty";
  // Present only for kinds that require it, and already checked to be a string.
  const expected = fields["expectedVersion"] as string | undefined;
  if (expected !== undefined && !CONTENT_VERSION.test(expected)) {
    return `expectedVersion ${JSON.stringify(expected.slice(0, 80))} is not a content version; read the file and copy its 'version sha256:<16 hex>'`;
  }
  return null;
}

const MAX_STORED_BYTES = 64 * 1024;

export interface EditPlan {
  operation: EditOperation;
  beforeVersion: string | null;
}

// A refused version precondition retires whatever version the model holds
// for the path; the observed version is reported, but the content behind it
// was never shown, so the guidance is to read again rather than retry blind.
function staleVersion(requested: string, message: string): ToolResult {
  return {
    ...toolFailure("stale-version", `${message}; ${requested} changed since it was read: read it again before editing`, false),
    fileVersions: [{ path: versionKey(requested), version: null }],
  };
}

function resolveInWorkspace(workspaceRoot: string, target: string): string | null {
  return resolveInScope(workspaceRoot, target);
}

function storedPreview(content: Buffer): { hash: string; preview: string; truncated: boolean } {
  const hash = `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
  if (content.length <= MAX_STORED_BYTES) {
    return { hash, preview: content.toString("utf8"), truncated: false };
  }
  return { hash, preview: content.subarray(0, MAX_STORED_BYTES).toString("utf8"), truncated: true };
}

function detectEol(text: string): "\r\n" | "\n" {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

// Atomic file replacement in the same directory/filesystem: temp O_EXCL,
// optional fsync where the platform honors it, mode copied from the
// original when given, then rename. Best-effort fsync: failure to flush
// does not fail the write (the OS/page-cache contract varies), but the
// rename itself is atomic on POSIX and on Windows for same-volume moves,
// which is the old-or-new guarantee that matters here. Not a power-loss
// proof: that claim is never made (see ARCH §9 reconciliation note).
function writeAtomic(absolute: string, content: Buffer, mode?: number): void {
  const dir = path.dirname(absolute);
  const stamp = `${process.pid}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  const temporary = path.join(dir, `.${path.basename(absolute)}.${stamp}.tmp`);
  let fd: number | null = null;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode ?? 0o666);
    fs.writeFileSync(fd, content);
    try {
      fs.fsyncSync(fd);
    } catch {
      // Flush is best effort across platforms/filesystems; the atomic
      // rename below is the durability boundary this tool guarantees.
    }
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, absolute);
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Best effort.
      }
    }
    try {
      fs.rmSync(temporary, { force: true });
    } catch {
      // Cleanup is best effort; a leftover .tmp never masks the target.
    }
  }
}

export class EditTool implements Tool<EditOperation> {
  readonly definition = EDIT_DEFINITION;
  // Serialized Lattice writers: the runtime is single-process/local-first,
  // but two replaces on one path must never interleave read→prepare→write.
  // A module-local promise chain per canonical path is the minimal keyed
  // mutex. External writers are NOT covered (documented limit, ARCH §9).
  private static readonly locks = new Map<string, Promise<void>>();

  execute(rawArgs: EditOperation, context: ToolContext): Promise<ToolResult> {
    const invalid = validateEditArgs(rawArgs);
    if (invalid !== null) return Promise.resolve(toolFailure("invalid-args", invalid, false));
    const absolute = resolveInWorkspace(context.workspaceRoot, rawArgs.path);
    if (absolute === null) {
      return Promise.resolve(toolFailure("invalid-args", "edit path escapes the workspace", false));
    }
    const targets = [absolute];
    if (rawArgs.kind === "rename") {
      const destination = resolveInWorkspace(context.workspaceRoot, rawArgs.newPath);
      if (destination === null) return Promise.resolve(toolFailure("invalid-args", "rename destination escapes the workspace", false));
      targets.push(destination);
    }
    const keys = [...new Set(targets)].sort();
    const run = Promise.all(keys.map((key) => EditTool.locks.get(key) ?? Promise.resolve()))
      .then(() => this.executeSync(rawArgs, context, absolute));
    const tail = run.then(() => undefined, () => undefined);
    for (const key of keys) EditTool.locks.set(key, tail);
    void tail.then(() => { for (const key of keys) if (EditTool.locks.get(key) === tail) EditTool.locks.delete(key); });
    return run;
  }

  private executeSync(rawArgs: EditOperation, context: ToolContext, absolute: string): ToolResult {
    const effect = { applied: false };
    const effected = (): void => { effect.applied = true; throwIfFault("after-edit-effect"); };
    try {
      switch (rawArgs.kind) {
        case "create":
          return this.create(absolute, rawArgs, effected);
        case "replace":
          return this.replace(absolute, rawArgs, effected);
        case "delete":
          return this.delete(absolute, rawArgs, effected);
        case "rename":
          return this.rename(absolute, rawArgs, context, effected);
        default:
          return toolFailure("invalid-args", "unknown edit kind", false);
      }
    } catch (error) {
      if (effect.applied) return { status: "unknown", effectUncertain: true, errorKind: "post-effect-observation", errorRetryable: false, summary: "edit effect may have applied; read the affected paths before any recovery", detail: error instanceof Error ? error.message : "observation failed" };
      return toolFailure(
        "io-error",
        `edit failed: ${error instanceof Error ? error.message : "unknown error"}`,
        true,
      );
    }
  }

  private create(absolute: string, args: Extract<EditOperation, { kind: "create" }>, effected: () => void): ToolResult {
    if (typeof args.content !== "string") {
      return toolFailure("invalid-args", "create requires content", false);
    }
    if (fs.existsSync(absolute)) {
      return toolFailure("precondition", `create refused: ${args.path} already exists`, false);
    }
    fs.mkdirSync(path.dirname(absolute), { recursive: true });
    // Atomic create: temp in the SAME directory + rename, so a crash leaves
    // either absence or the complete file, never a truncated partial.
    writeAtomic(absolute, Buffer.from(args.content, "utf8"));
    effected();
    const after = contentVersion(Buffer.from(args.content, "utf8"));
    return {
      status: "completed",
      summary: `created ${args.path}; version ${after}`,
      detail: JSON.stringify({ beforeVersion: null, afterVersion: after }),
      version: after,
      fileVersions: [{ path: versionKey(args.path), version: after }],
      complete: true,
    };
  }

  private replace(absolute: string, args: Extract<EditOperation, { kind: "replace" }>, effected: () => void): ToolResult {
    if (typeof args.oldText !== "string" || args.oldText === "" || typeof args.newText !== "string") {
      return toolFailure("invalid-args", "replace requires non-empty oldText and newText", false);
    }
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      return toolFailure("not-found", `replace refused: ${args.path} does not exist`, false);
    }
    const before = fs.readFileSync(absolute);
    if (before.includes(0)) {
      return toolFailure("precondition", "replace refused: binary file", false);
    }
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return staleVersion(args.path, `replace refused: expected ${args.expectedVersion} but observed ${currentVersion}`);
    }
    const text = before.toString("utf8");
    const first = text.indexOf(args.oldText);
    if (first === -1) {
      return toolFailure("precondition", "replace refused: oldText not found literally", false);
    }
    if (text.indexOf(args.oldText, first + 1) !== -1) {
      return toolFailure("precondition", "replace refused: oldText matches more than once", false);
    }
    const eol = detectEol(text);
    let newText = text.slice(0, first) + args.newText + text.slice(first + args.oldText.length);
    if (eol === "\r\n") {
      newText = newText.replace(/\r(?!\n)|(?<!\r)\n/g, "\r\n");
    }
    // Atomic replace: validate → prepare → temp in the same filesystem →
    // revalidate precondition immediately before the swap → rename → observe
    // the final bytes. Mode preserved from the original. A crash leaves the
    // old file or the complete new file; reconciliation classifies UNKNOWN.
    const beforeStat = fs.statSync(absolute);
    const prepared = Buffer.from(newText, "utf8");
    const current = fs.readFileSync(absolute);
    if (contentVersion(current).valueOf() !== currentVersion.valueOf()) {
      return staleVersion(args.path, `replace refused: file changed during prepare (observed ${contentVersion(current)}, expected ${args.expectedVersion})`);
    }
    writeAtomic(absolute, prepared, beforeStat.mode & 0o777);
    effected();
    const observed = fs.readFileSync(absolute);
    const after = contentVersion(observed);
    const beforeStored = storedPreview(before);
    const afterStored = storedPreview(Buffer.from(newText, "utf8"));
    return {
      status: "completed",
      summary: `replaced one literal occurrence in ${args.path}; new version ${after}`,
      detail: JSON.stringify({
        beforeVersion: currentVersion,
        afterVersion: after,
        beforeHash: beforeStored.hash,
        beforeTruncated: beforeStored.truncated,
        beforePreview: beforeStored.preview.slice(0, 8000),
        beforePreviewTruncated: beforeStored.truncated || beforeStored.preview.length > 8000,
        afterPreview: afterStored.preview.slice(0, 8000),
        afterPreviewTruncated: afterStored.truncated || afterStored.preview.length > 8000,
      }),
      version: after,
      fileVersions: [{ path: versionKey(args.path), version: after }],
      complete: true,
    };
  }

  private delete(absolute: string, args: Extract<EditOperation, { kind: "delete" }>, effected: () => void): ToolResult {
    if (!fs.existsSync(absolute)) {
      return toolFailure("not-found", `delete refused: ${args.path} does not exist`, false);
    }
    if (!fs.statSync(absolute).isFile()) {
      return toolFailure("precondition", `delete refused: ${args.path} is not a file`, false);
    }
    const before = fs.readFileSync(absolute);
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return staleVersion(args.path, `delete refused: expected ${args.expectedVersion} but observed ${currentVersion}`);
    }
    const stored = storedPreview(before);
    fs.unlinkSync(absolute);
    effected();
    return {
      status: "completed",
      summary: `deleted ${args.path}`,
      detail: JSON.stringify({ beforeVersion: currentVersion, beforeHash: stored.hash, beforeTruncated: stored.truncated }),
      fileVersions: [{ path: versionKey(args.path), version: null }],
      complete: true,
    };
  }

  private rename(absolute: string, args: Extract<EditOperation, { kind: "rename" }>, context: ToolContext, effected: () => void): ToolResult {
    if (typeof args.newPath !== "string" || args.newPath === "") {
      return toolFailure("invalid-args", "rename requires newPath", false);
    }
    const destination = resolveInWorkspace(context.workspaceRoot, args.newPath);
    if (destination === null) {
      return toolFailure("invalid-args", "rename destination escapes the workspace", false);
    }
    if (!fs.existsSync(absolute)) {
      return toolFailure("not-found", `rename refused: ${args.path} does not exist`, false);
    }
    const before = fs.readFileSync(absolute);
    const currentVersion = contentVersion(before);
    if (currentVersion !== args.expectedVersion) {
      return staleVersion(args.path, `rename refused: expected ${args.expectedVersion} but observed ${currentVersion}`);
    }
    if (fs.existsSync(destination)) {
      return toolFailure("precondition", `rename refused: destination ${args.newPath} already exists`, false);
    }
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    try {
      fs.renameSync(absolute, destination);
    } catch (error) {
      const stillThere = fs.existsSync(absolute);
      const arrived = fs.existsSync(destination);
      return { status: "unknown", effectUncertain: true, errorKind: "io-error", errorRetryable: false, summary: `rename partially applied or failed (source present: ${stillThere}, destination present: ${arrived}): ${error instanceof Error ? error.message : "unknown error"}` };
    }
    effected();
    return {
      status: "completed",
      summary: `renamed ${args.path} to ${args.newPath}; version ${currentVersion} now belongs to ${args.newPath}`,
      detail: JSON.stringify({ beforeVersion: currentVersion, afterVersion: currentVersion }),
      version: currentVersion,
      fileVersions: [{ path: versionKey(args.path), version: null }, { path: versionKey(args.newPath), version: currentVersion }],
      complete: true,
    };
  }
}
