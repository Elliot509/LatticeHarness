import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EDIT_DEFINITION, EditTool, validateEditArgs, type EditOperation } from "../../src/tools/edit.js";
import { ReadTool, contentVersion } from "../../src/tools/read.js";
import type { ToolContext } from "../../src/tools/types.js";

let dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

function workspace(files: Record<string, string | Buffer>): ToolContext {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-f5-"));
  dirs.push(root);
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(root, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return { workspaceRoot: root, realm: "local-trusted", timeoutMs: 5000 };
}

function versionIn(summary: string): string | undefined {
  return /version (sha256:[0-9a-f]{16})/.exec(summary)?.[1];
}

const edit = (args: unknown, context: ToolContext) => new EditTool().execute(args as EditOperation, context);

describe("edit schema discriminates by kind", () => {
  const variants = EDIT_DEFINITION.parameters.oneOf ?? [];
  const variant = (kind: string) => variants.find((entry) => (entry["properties"] as { kind: { const: string } }).kind.const === kind);
  const forbidden = (kind: string) => ((variant(kind)?.["not"] as { anyOf: Array<{ required: string[] }> }).anyOf).map((entry) => entry.required[0]);

  it("declares one variant per kind with its required and refused fields", () => {
    expect(variants).toHaveLength(4);
    expect(variant("create")?.["required"]).toEqual(["kind", "path", "content"]);
    expect(variant("replace")?.["required"]).toEqual(["kind", "path", "expectedVersion", "oldText", "newText"]);
    expect(variant("delete")?.["required"]).toEqual(["kind", "path", "expectedVersion"]);
    expect(variant("rename")?.["required"]).toEqual(["kind", "path", "expectedVersion", "newPath"]);
    expect(forbidden("create")).toEqual(["expectedVersion", "oldText", "newText", "newPath"]);
    expect(forbidden("delete")).toEqual(["content", "oldText", "newText", "newPath"]);
    const kinds = (EDIT_DEFINITION.parameters.properties["kind"] as { enum: string[] }).enum;
    expect(variants.map((entry) => (entry["properties"] as { kind: { const: string } }).kind.const)).toEqual(kinds);
  });

  it("describes every field, including where expectedVersion comes from", () => {
    for (const [name, schema] of Object.entries(EDIT_DEFINITION.parameters.properties)) {
      expect((schema as { description?: string }).description, name).toMatch(/\S/);
    }
    const expected = (EDIT_DEFINITION.parameters.properties["expectedVersion"] as { description: string }).description;
    expect(expected).toContain("sha256:<16 hex>");
    expect(expected).toContain("read");
    expect(expected).toMatch(/Never guess/);
    expect(EDIT_DEFINITION.description).toContain("expectedVersion");
  });

  it("stays a plain JSON object the adapter can serialize unchanged", () => {
    const roundTrip = JSON.parse(JSON.stringify(EDIT_DEFINITION.parameters)) as unknown;
    expect(roundTrip).toEqual(EDIT_DEFINITION.parameters);
    expect(EDIT_DEFINITION.parameters).toMatchObject({ type: "object", required: ["kind", "path"], additionalProperties: false });
  });
});

describe("edit argument validation", () => {
  it("rejects missing, foreign and malformed fields as invalid-args, before touching the file", async () => {
    const context = workspace({ "a.txt": "one\n" });
    const version = contentVersion(Buffer.from("one\n"));
    const cases: Array<[unknown, RegExp]> = [
      [{ kind: "replace", path: "a.txt", oldText: "one", newText: "two" }, /requires string expectedVersion/],
      [{ kind: "replace", path: "a.txt", expectedVersion: "v1", oldText: "one", newText: "two" }, /not a content version/],
      [{ kind: "replace", path: "a.txt", expectedVersion: "sha256:deadbeef", oldText: "one", newText: "two" }, /not a content version/],
      [{ kind: "delete", path: "a.txt", expectedVersion: "metadata:4:1700000000000" }, /not a content version/],
      [{ kind: "replace", path: "a.txt", expectedVersion: version, oldText: "one" }, /requires string newText/],
      [{ kind: "replace", path: "a.txt", expectedVersion: version, oldText: "one", newText: "two", content: "x" }, /does not accept content/],
      [{ kind: "create", path: "b.txt", content: "x", expectedVersion: version }, /does not accept expectedVersion/],
      [{ kind: "rename", path: "a.txt", expectedVersion: version }, /requires string newPath/],
      [{ kind: "move", path: "a.txt" }, /kind must be one of/],
      [{ kind: "delete", path: "", expectedVersion: version }, /path must be non-empty/],
    ];
    for (const [args, message] of cases) {
      const result = await edit(args, context);
      expect(result.errorKind, JSON.stringify(args)).toBe("invalid-args");
      expect(result.summary).toMatch(message);
      expect(result.fileVersions).toBeUndefined();
    }
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("one\n");
    expect(fs.existsSync(path.join(context.workspaceRoot, "b.txt"))).toBe(false);
    expect(validateEditArgs({ kind: "delete", path: "a.txt", expectedVersion: version })).toBeNull();
  });

  it("keeps not-found, missing oldText and escaping paths distinct from stale-version", async () => {
    const context = workspace({ "a.txt": "one\n" });
    const version = contentVersion(Buffer.from("one\n"));
    expect((await edit({ kind: "replace", path: "gone.txt", expectedVersion: version, oldText: "one", newText: "two" }, context)).errorKind).toBe("not-found");
    expect((await edit({ kind: "replace", path: "a.txt", expectedVersion: version, oldText: "absent", newText: "two" }, context)).errorKind).toBe("precondition");
    expect((await edit({ kind: "replace", path: "../a.txt", expectedVersion: version, oldText: "one", newText: "two" }, context)).errorKind).toBe("invalid-args");
    expect(fs.readFileSync(path.join(context.workspaceRoot, "a.txt"), "utf8")).toBe("one\n");
  });
});

describe("read hands edit the version it validates", () => {
  it("names the whole-file version in the summary for full, partial, empty and binary reads", async () => {
    const context = workspace({ "a.txt": "l1\nl2\nl3\n", "empty.txt": "", "bin.dat": Buffer.from([0, 1, 2]) });
    const read = new ReadTool();
    const whole = contentVersion(fs.readFileSync(path.join(context.workspaceRoot, "a.txt")));
    const full = await read.execute({ path: "a.txt" }, context);
    const partial = await read.execute({ path: "./a.txt", start: 2, count: 1 }, context);
    expect(versionIn(full.summary)).toBe(whole);
    expect(versionIn(partial.summary)).toBe(whole);
    expect(partial.summary).toContain("whole file");
    expect(partial.fileVersions).toEqual([{ path: "a.txt", version: whole }]);
    const empty = await read.execute({ path: "empty.txt" }, context);
    expect(versionIn(empty.summary)).toBe(contentVersion(Buffer.alloc(0)));
    const binary = await read.execute({ path: "bin.dat" }, context);
    expect(versionIn(binary.summary)).toBe(contentVersion(Buffer.from([0, 1, 2])));
  });

  it("does not offer a byte-range metadata version as an edit version", async () => {
    const context = workspace({ "a.txt": "abc\n" });
    const ranged = await new ReadTool().execute({ path: "a.txt", offset: 0, maxBytes: 2 }, context);
    expect(ranged.version).toMatch(/^metadata:/);
    expect(ranged.summary).toContain("not an edit expectedVersion");
    expect(ranged.fileVersions).toBeUndefined();
    expect(versionIn(ranged.summary)).toBeUndefined();
  });

  it("accepts the read version, refuses it once stale, and accepts the re-read version", async () => {
    const context = workspace({ "a.txt": "alpha\nbeta\n" });
    const file = path.join(context.workspaceRoot, "a.txt");
    const read = new ReadTool();
    const first = versionIn((await read.execute({ path: "a.txt" }, context)).summary) ?? "";
    const replaced = await edit({ kind: "replace", path: "a.txt", expectedVersion: first, oldText: "alpha", newText: "gamma" }, context);
    expect(replaced.errorKind).toBeUndefined();
    expect(versionIn(replaced.summary)).toBe(contentVersion(fs.readFileSync(file)));
    expect(replaced.fileVersions).toEqual([{ path: "a.txt", version: replaced.version }]);

    fs.writeFileSync(file, "gamma\nbeta\nexternal\n");
    const stale = await edit({ kind: "replace", path: "a.txt", expectedVersion: replaced.version, oldText: "beta", newText: "delta" }, context);
    expect(stale.errorKind).toBe("stale-version");
    expect(stale.summary).toContain("read it again before editing");
    expect(stale.fileVersions).toEqual([{ path: "a.txt", version: null }]);
    expect(fs.readFileSync(file, "utf8")).toBe("gamma\nbeta\nexternal\n");

    const fresh = versionIn((await read.execute({ path: "a.txt" }, context)).summary) ?? "";
    const retried = await edit({ kind: "replace", path: "a.txt", expectedVersion: fresh, oldText: "beta", newText: "delta" }, context);
    expect(retried.errorKind).toBeUndefined();
    expect(fs.readFileSync(file, "utf8")).toBe("gamma\ndelta\nexternal\n");
  });

  it("reports versions for create, retires them on delete and moves them on rename", async () => {
    const context = workspace({});
    const created = await edit({ kind: "create", path: "n.txt", content: "x\n" }, context);
    expect(versionIn(created.summary)).toBe(contentVersion(Buffer.from("x\n")));
    const renamed = await edit({ kind: "rename", path: "n.txt", expectedVersion: created.version, newPath: "m.txt" }, context);
    expect(renamed.fileVersions).toEqual([{ path: "n.txt", version: null }, { path: "m.txt", version: created.version }]);
    const deleted = await edit({ kind: "delete", path: "m.txt", expectedVersion: renamed.version }, context);
    expect(deleted.fileVersions).toEqual([{ path: "m.txt", version: null }]);
    expect(fs.existsSync(path.join(context.workspaceRoot, "m.txt"))).toBe(false);
  });
});
