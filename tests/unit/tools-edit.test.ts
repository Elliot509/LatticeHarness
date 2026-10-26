import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EDIT_DEFINITION, EditTool } from "../../src/tools/edit.js";
import { contentVersion } from "../../src/tools/read.js";
import type { ToolContext } from "../../src/tools/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workspace(files: Record<string, string>): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-edit-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { workspaceRoot: root, realm: "local-trusted", timeoutMs: 5000 };
}

function versionOf(context: ToolContext, name: string): string {
  return contentVersion(fs.readFileSync(path.join(context.workspaceRoot, name)));
}

describe("edit tool", () => {
  it("exposes the versioned literal contract", () => {
    expect(EDIT_DEFINITION.name).toBe("edit");
    expect(EDIT_DEFINITION.parameters.required).toContain("kind");
  });

  it("creates only when absent and replaces a single literal match", async () => {
    const context = workspace({ "a.txt": "hello world\n" });
    const tool = new EditTool();
    const created = await tool.execute({ kind: "create", path: "new.txt", content: "hi\n" }, context);
    expect(created.status).toBe("completed");
    expect(created.version).toMatch(/^sha256:/);
    const refused = await tool.execute({ kind: "create", path: "new.txt", content: "x" }, context);
    expect(refused.errorKind).toBe("precondition");

    const before = versionOf(context, "a.txt");
    const replaced = await tool.execute(
      { kind: "replace", path: "a.txt", expectedVersion: before, oldText: "world", newText: "there" },
      context,
    );
    expect(replaced.status).toBe("completed");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("hello there\n");
    expect(replaced.version).not.toBe(before);
  });

  it("rejects stale versions explicitly", async () => {
    const context = workspace({ "a.txt": "one\n" });
    const tool = new EditTool();
    const stale = await tool.execute(
      { kind: "replace", path: "a.txt", expectedVersion: "sha256:deadbeefdeadbeef", oldText: "one", newText: "two" },
      context,
    );
    expect(stale.errorKind).toBe("stale-version");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("one\n");
    const deleted = await tool.execute(
      { kind: "delete", path: "a.txt", expectedVersion: "sha256:deadbeefdeadbeef" },
      context,
    );
    expect(deleted.errorKind).toBe("stale-version");
    expect(fs.existsSync(path.join(context.workspaceRoot, "a.txt"))).toBe(true);
  });

  it("rejects ambiguous matches without fuzzy fallback", async () => {
    const context = workspace({ "a.txt": "x = 1\nx = 1\n" });
    const tool = new EditTool();
    const result = await tool.execute(
      { kind: "replace", path: "a.txt", expectedVersion: versionOf(context, "a.txt"), oldText: "x = 1", newText: "x = 2" },
      context,
    );
    expect(result.errorKind).toBe("precondition");
    expect(result.summary).toContain("more than once");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("x = 1\nx = 1\n");
  });

  it("preserves CRLF and handles delete plus rename preconditions", async () => {
    const context = workspace({});
    fs.writeFileSync(path.join(context.workspaceRoot, "win.txt"), "a\r\nb\r\n");
    const tool = new EditTool();
    const before = versionOf(context, "win.txt");
    const replaced = await tool.execute(
      { kind: "replace", path: "win.txt", expectedVersion: before, oldText: "a", newText: "z" },
      context,
    );
    expect(replaced.status).toBe("completed");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "win.txt"), "utf8")).toBe("z\r\nb\r\n");

    const renamed = await tool.execute(
      { kind: "rename", path: "win.txt", expectedVersion: replaced.version ?? before, newPath: "moved.txt" },
      context,
    );
    expect(renamed.status).toBe("completed");
    expect(fs.existsSync(path.join(context.workspaceRoot, "win.txt"))).toBe(false);
    expect(fs.existsSync(path.join(context.workspaceRoot, "moved.txt"))).toBe(true);

    const clash = await tool.execute(
      { kind: "rename", path: "moved.txt", expectedVersion: renamed.version ?? before, newPath: "moved.txt" },
      context,
    );
    expect(clash.errorKind).toBe("precondition");
  });

  it("requires EOL-exact oldText and preserves CRLF on success", async () => {
    const context = workspace({});
    fs.writeFileSync(path.join(context.workspaceRoot, "win.txt"), "a\r\nb\r\n");
    const tool = new EditTool();
    const version = versionOf(context, "win.txt");
    const mismatched = await tool.execute(
      { kind: "replace", path: "win.txt", expectedVersion: version, oldText: "a\nb", newText: "z" },
      context,
    );
    expect(mismatched.errorKind).toBe("precondition");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "win.txt"), "utf8")).toBe("a\r\nb\r\n");
    const matched = await tool.execute(
      { kind: "replace", path: "win.txt", expectedVersion: version, oldText: "a", newText: "z" },
      context,
    );
    expect(matched.status).toBe("completed");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "win.txt"), "utf8")).toBe("z\r\nb\r\n");
  });

  it("confines every operation to the workspace", async () => {
    const context = workspace({ "a.txt": "x\n" });
    const tool = new EditTool();
    expect((await tool.execute({ kind: "create", path: "../out.txt", content: "x" }, context)).errorKind).toBe("invalid-args");
    expect(
      (await tool.execute({ kind: "rename", path: "a.txt", expectedVersion: versionOf(context, "a.txt"), newPath: "../out.txt" }, context)).errorKind,
    ).toBe("invalid-args");
  });
});
