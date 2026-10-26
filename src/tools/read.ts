import { createHash } from "node:crypto";
import fs from "node:fs";
import type { ToolDefinition } from "../providers/types.js";
import { resolveInScope } from "../platform/paths.js";
import { HandleRegistry } from "./handles.js";
import { DirectoryReader } from "./directory.js";
import { toolFailure, versionKey, type Tool, type ToolContext, type ToolResult } from "./types.js";

export interface ReadArgs {
  path: string;
  kind?: "directory";
  recursive?: boolean;
  cursor?: string;
  pageSize?: number;
  start?: number;
  count?: number;
  handleId?: string;
  offset?: number;
  maxBytes?: number;
}

export const READ_DEFINITION: ToolDefinition = {
  name: "read",
  description:
    "Read a workspace file by line/byte range, expand a result handle, or list directory metadata with kind:'directory', path:'.'. Directory pages include hidden entries, scope, completeness and nextCursor; continue the same cursor instead of repeating ls/find. recursive defaults false (immediate children). No file contents are read for directory listing.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      kind: { type: "string", enum: ["directory"] },
      recursive: { type: "boolean" },
      cursor: { type: "string" },
      pageSize: { type: "number", description: "Directory entries per page, 1..200; text size also bounded" },
      start: { type: "number", description: "First line, 1-based, inclusive" },
      count: { type: "number", description: "Number of lines" },
      handleId: { type: "string", description: "Expand a previous truncated result" },
      offset: { type: "number", description: "Byte offset for a bounded byte-range read, including long lines" },
      maxBytes: { type: "number", description: "Byte range size, at most 65536" },
    },
    required: ["path"],
    additionalProperties: false,
  },
};

const DEFAULT_COUNT = 200;
const MAX_BYTES = 64 * 1024;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_FILE_BYTES = 8 * 1024 * 1024;

function boundedSnapshot(absolute: string): Buffer {
  const fd = fs.openSync(absolute, "r");
  try {
    const before = fs.fstatSync(fd);
    if (before.size > MAX_FILE_BYTES) throw new Error("file exceeds bounded snapshot; use offset/maxBytes");
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_FILE_BYTES + 1));
    let read = 0;
    while (read < bytes.length) { const n = fs.readSync(fd, bytes, read, bytes.length - read, read); if (n === 0) break; read += n; }
    const after = fs.fstatSync(fd);
    if (read > before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error("file changed during bounded read; read again");
    return bytes.subarray(0, read);
  } finally { fs.closeSync(fd); }
}

function expansion(absolute: string, version: string, start: number): () => string {
  return () => {
    const stat = fs.statSync(absolute);
    if (stat.size > MAX_FILE_BYTES) throw new Error("file exceeds bounded snapshot read; request a byte range");
    const current = boundedSnapshot(absolute);
    if (contentVersion(current) !== version) throw new Error("file changed since this handle; read the new version");
    const rest = Buffer.from(current.toString("utf8").split("\n").slice(start - 1).join("\n"));
    return rest.subarray(0, MAX_BYTES).toString("utf8") + (rest.length > MAX_BYTES ? "\n[expansion truncated; use offset/maxBytes for further ranges]" : "");
  };
}

export function contentVersion(content: Buffer): string {
  return `sha256:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`;
}

// The whole-file content version is what edit compares against, so a line
// read names it in the summary the model sees, whatever range was rendered.
function versionNote(version: string): string {
  return `version ${version} (whole file; edit expectedVersion)`;
}

export class ReadTool implements Tool<ReadArgs> {
  readonly definition = READ_DEFINITION;
  private readonly handles: HandleRegistry;
  private readonly directory = new DirectoryReader();
  constructor(handles: HandleRegistry = new HandleRegistry()) {
    this.handles = handles;
  }

  execute(rawArgs: ReadArgs, context: ToolContext): Promise<ToolResult> {
    if (rawArgs.kind === "directory") return this.directory.execute(rawArgs, context);
    return Promise.resolve(this.executeSync(rawArgs, context));
  }

  private executeSync(rawArgs: ReadArgs, context: ToolContext): ToolResult {
    if (typeof rawArgs.path !== "string" || rawArgs.path === "") {
      return toolFailure("invalid-args", "read path must be a non-empty string", false);
    }
    if (rawArgs.handleId !== undefined) {
      const handle = this.handles.get(rawArgs.handleId);
      if (handle === undefined) {
        return toolFailure("invalid-args", `unknown handle ${rawArgs.handleId}`, false);
      }
      try {
        if (handle.kind === "output" || rawArgs.offset !== undefined) {
          const bytes = Buffer.from(handle.expand());
          const offset = rawArgs.offset ?? 0;
          const maxBytes = rawArgs.maxBytes ?? 3000;
          if (!Number.isSafeInteger(offset) || offset < 0 || offset > bytes.length || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 3000) return toolFailure("invalid-args", "output offset must be within captured output; maxBytes must be 1..3000", false);
          const end = Math.min(bytes.length, offset + maxBytes);
          const selected = bytes.subarray(offset, end);
          let detail: string;
          try { detail = new TextDecoder("utf-8", { fatal: true }).decode(selected); }
          catch { detail = `[base64 byte range] ${selected.toString("base64")}`; }
          return { status: "completed", summary: `captured output ${handle.id}: bytes ${offset}-${end}/${bytes.length}; ${end < bytes.length ? `next read handleId=${handle.id} offset=${end} maxBytes=3000` : "end of captured output (not proof of filesystem coverage)"}`, detail, handleId: handle.id, complete: end === bytes.length, truncated: end < bytes.length, observationKey: contentVersion(selected) };
        }
        return {
        status: "completed",
        summary: `expanded ${handle.kind} result ${handle.id}`,
        detail: handle.expand(),
        complete: false,
        truncated: true,
        truncationNote: "Expanded snapshot range; further content may require offset/maxBytes. This does not certify full search coverage.",
      }; } catch (error) { return toolFailure("stale-version", error instanceof Error ? error.message : "handle unavailable; read again", false); }
    }
    const start = rawArgs.start ?? 1;
    const count = rawArgs.count ?? DEFAULT_COUNT;
    if (!Number.isInteger(start) || start < 1 || !Number.isInteger(count) || count < 1) {
      return toolFailure("invalid-args", "start and count must be positive integers (start is 1-based)", false);
    }
    const absolute = resolveInScope(context.workspaceRoot, rawArgs.path);
    if (absolute === null) {
      return toolFailure("invalid-args", "read path escapes the workspace", false);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(absolute);
    } catch {
      return toolFailure("not-found", `file not found: ${rawArgs.path}`, false);
    }
    if (!stat.isFile()) {
      return toolFailure("invalid-args", `not a file: ${rawArgs.path}`, false);
    }
    if (rawArgs.offset !== undefined) {
      const offset = rawArgs.offset;
      const maxBytes = rawArgs.maxBytes ?? MAX_BYTES;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > stat.size || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > MAX_BYTES) return toolFailure("invalid-args", "offset must be within the file; maxBytes must be 1..65536", false);
      let fd: number | undefined;
      try {
        fd = fs.openSync(absolute, "r");
        const bytes = Buffer.alloc(Math.min(maxBytes, stat.size - offset));
        const read = fs.readSync(fd, bytes, 0, bytes.length, offset);
        const complete = offset === 0 && read === stat.size;
        let detail: string;
        let encoding = "UTF-8";
        try { detail = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, read)); }
        catch { detail = bytes.subarray(0, read).toString("base64"); encoding = "base64 (binary or split UTF-8 range)"; }
        return { status: "completed", summary: `${rawArgs.path} bytes ${offset}-${offset + read} of ${stat.size} (${encoding}; metadata version, not an edit expectedVersion: read by lines for that)`, detail, version: `metadata:${stat.size}:${stat.mtimeMs}`, complete, truncated: !complete };
      } catch { return toolFailure("unreadable", "cannot read byte range", false); }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
    if (stat.size > MAX_FILE_BYTES) return toolFailure("invalid-args", "file exceeds 8 MiB bounded line read; use offset/maxBytes for byte ranges", false);
    let buffer: Buffer;
    try {
      buffer = boundedSnapshot(absolute);
    } catch (error) {
      return toolFailure("unreadable", `cannot read ${rawArgs.path}: ${error instanceof Error ? error.message : "unknown error"}`, true);
    }
    const version = contentVersion(buffer);
    const fileVersions = [{ path: versionKey(rawArgs.path), version }];
    if (buffer.length === 0) {
      return {
        status: "completed",
        summary: `empty file ${rawArgs.path}; ${versionNote(version)}`,
        detail: "",
        version,
        fileVersions,
        complete: true,
      };
    }
    if (buffer.includes(0)) {
      return {
        status: "completed",
        summary: `binary file ${rawArgs.path} (${stat.size} bytes); content not rendered; ${versionNote(version)}`,
        version,
        fileVersions,
        complete: false,
      };
    }
    let text: string;
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(buffer);
      text = buffer.toString("utf8");
    } catch {
      return {
        status: "completed",
        summary: `non-UTF8 file ${rawArgs.path}; content not rendered; ${versionNote(version)}`,
        version,
        fileVersions,
        complete: false,
      };
    }
    const lines = text.split("\n");
    const totalLines = lines.length;
    if (start > totalLines) {
      return toolFailure("invalid-args", `start line ${start} beyond ${totalLines} total lines`, false);
    }
    const selected = lines.slice(start - 1, start - 1 + count);
    const omittedLines = totalLines - (start - 1 + selected.length);
    let omittedBytes = 0;
    let rendered = selected
      .map((line, index) => {
        if (Buffer.byteLength(line, "utf8") > MAX_LINE_BYTES) {
          omittedBytes += Buffer.byteLength(line, "utf8") - MAX_LINE_BYTES;
          const bytes = Buffer.from(line, "utf8").subarray(0, MAX_LINE_BYTES).toString("utf8");
          return `${start + index}:[line truncated at ${MAX_LINE_BYTES} bytes]${bytes}`;
        }
        return `${start + index}:${line}`;
      })
      .join("\n");
    if (Buffer.byteLength(rendered, "utf8") > MAX_BYTES) {
      const full = rendered;
      rendered = Buffer.from(full, "utf8").subarray(0, MAX_BYTES).toString("utf8");
      omittedBytes += Buffer.byteLength(full, "utf8") - MAX_BYTES;
    }
    if (omittedLines <= 0 && omittedBytes <= 0) {
      return {
        status: "completed",
        summary: `${rawArgs.path} lines ${start}-${start + selected.length - 1} of ${totalLines}; ${versionNote(version)}`,
        detail: rendered,
        version,
        fileVersions,
        complete: true,
      };
    }
    const note = `omitted ${omittedLines} trailing line(s)${omittedBytes > 0 ? ` and ~${omittedBytes} bytes` : ""}; expand via handle`;
    const handleId = this.handles.store("read", `${rawArgs.path}@${version} (${note})`, expansion(absolute, version, start));
    return {
      status: "completed",
      summary: `${rawArgs.path} lines ${start}-${start + selected.length - 1} of ${totalLines}; ${versionNote(version)}; ${note}`,
      detail: rendered,
      version,
      fileVersions,
      complete: false,
      truncated: true,
      truncationNote: note,
      handleId,
    };
  }
}
