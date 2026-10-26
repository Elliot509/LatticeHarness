import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb } from "../../src/storage/db.js";
import { serveLattice } from "../../src/server/server.js";

// PG-033: search results open a read-only preview through the UI API. It is
// a file-read path outside the tool protocol, so its boundary is pinned over
// real HTTP: session required, task scope only (no traversal, absolute paths
// or symlink escape), regular text files only, bounded, nothing recorded.

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function setup(): Promise<{ url: string; cookie: string; taskId: string; root: string; outside: string; events: () => number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-preview-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const root = path.join(dir, "project");
  fs.mkdirSync(path.join(root, "src"), { recursive: true });
  fs.writeFileSync(path.join(root, "src", "app.js"), "export const ok = true;\n");
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(300 * 1024));
  fs.writeFileSync(path.join(root, "image.bin"), Buffer.from([0x89, 0x50, 0x00, 0x01]));
  const outside = path.join(dir, "secret.txt");
  fs.writeFileSync(outside, "do not read\n");
  fs.symlinkSync(outside, path.join(root, "link.txt"));
  const assets = path.join(dir, "ui");
  fs.mkdirSync(assets);
  fs.writeFileSync(path.join(assets, "index.html"), "<html></html>");
  const db = openLatticeDb(path.join(dir, "data"));
  claimOwnership(db.raw);
  const server = await serveLattice({ db: db.raw, workspace: root, assetRoot: assets });
  cleanups.push(async () => { await server.close(); db.close(); });
  const created = await fetch(`${server.url}/api/commands`, { method: "POST", headers: { Cookie: server.bootstrapCookie, "Content-Type": "application/json" }, body: JSON.stringify({ commandId: "c", kind: "create-task", payload: { workspace: "", objective: "Explique", provider: "local", model: "m", baseUrl: "http://127.0.0.1:9/v1" } }) });
  const { taskId } = (await created.json()) as { taskId: string };
  return { url: server.url, cookie: server.bootstrapCookie, taskId, root, outside, events: () => (db.raw.prepare("SELECT COUNT(*) AS n FROM events").get() as { n: number }).n };
}

describe("file preview over HTTP (PG-033)", () => {
  it("serves a project text file to the session and records nothing", async () => {
    const { url, cookie, taskId, events } = await setup();
    const before = events();
    const response = await fetch(`${url}/api/tasks/${taskId}/file?path=${encodeURIComponent("src/app.js")}`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ path: "src/app.js", content: "export const ok = true;\n", truncated: false, size: 24 });
    expect(events()).toBe(before);
    const big = await (await fetch(`${url}/api/tasks/${taskId}/file?path=big.txt`, { headers: { Cookie: cookie } })).json() as { content: string; truncated: boolean; size: number };
    expect(big).toMatchObject({ truncated: true, size: 300 * 1024 });
    expect(big.content).toHaveLength(256 * 1024);
  });

  it("refuses anything outside the project, binaries and directories", async () => {
    const { url, cookie, taskId, outside } = await setup();
    const status = async (requested: string): Promise<[number, string]> => {
      const response = await fetch(`${url}/api/tasks/${taskId}/file?path=${encodeURIComponent(requested)}`, { headers: { Cookie: cookie } });
      const body = (await response.json()) as { error?: string; content?: string };
      return [response.status, body.error ?? body.content ?? ""];
    };
    expect(await status("../secret.txt")).toEqual([404, "path is outside the project"]);
    expect(await status("src/../../secret.txt")).toEqual([404, "path is outside the project"]);
    expect(await status(outside)).toEqual([404, "relative project path required"]);
    expect(await status("link.txt")).toEqual([404, "path is outside the project"]);
    expect(await status("image.bin")).toEqual([404, "binary file; preview unavailable"]);
    expect(await status("src")).toEqual([404, "not a regular file"]);
    expect(await status("")).toEqual([404, "relative project path required"]);
  });

  it("requires the session cookie and the same origin", async () => {
    const { url, cookie, taskId } = await setup();
    expect((await fetch(`${url}/api/tasks/${taskId}/file?path=src/app.js`)).status).toBe(401);
    expect((await fetch(`${url}/api/tasks/${taskId}/file?path=src/app.js`, { headers: { Cookie: cookie, Origin: "https://evil.example" } })).status).toBe(403);
  });
});
