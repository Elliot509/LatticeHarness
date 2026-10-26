import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb } from "../../src/storage/db.js";
import { serveLattice, type LatticeServer } from "../../src/server/server.js";

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });

async function serve(): Promise<{ server: LatticeServer; post: (body: Record<string, unknown>) => Promise<Record<string, unknown>>; get: (route: string) => Promise<Record<string, unknown>> }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-first-use-"));
  cleanups.push(() => { fs.rmSync(dir, { recursive: true, force: true }); });
  const workspace = path.join(dir, "ws");
  fs.mkdirSync(workspace);
  const db = openLatticeDb(path.join(dir, "data"));
  claimOwnership(db.raw);
  const server = await serveLattice({ db: db.raw, workspace });
  cleanups.push(async () => { await server.close(); db.close(); });
  const headers = { "Content-Type": "application/json", Cookie: server.bootstrapCookie, Origin: server.url };
  return {
    server,
    post: async (body) => await (await fetch(`${server.url}/api/commands`, { method: "POST", headers, body: JSON.stringify(body) })).json() as Record<string, unknown>,
    get: async (route) => await (await fetch(`${server.url}${route}`, { headers })).json() as Record<string, unknown>,
  };
}

describe("first use: problems known in advance are reported before anything runs", () => {
  it("refuses a task whose provider needs a key that is not configured, then accepts it once the key exists (PG-018)", async () => {
    const { post } = await serve();
    const refused = await post({ commandId: "c1", kind: "create-task", payload: { objective: "Explique o projeto", provider: "openai", model: "gpt-x" } });
    expect(refused).toMatchObject({ accepted: false, reason: "denied" });
    expect(String(refused["detail"])).toContain("Configure a chave de API de OpenAI");
    expect(await post({ commandId: "k", kind: "set-key", payload: { provider: "openai", key: "sk-test-not-real" } })).toMatchObject({ accepted: true });
    expect(await post({ commandId: "c2", kind: "create-task", payload: { objective: "Explique o projeto", provider: "openai", model: "gpt-x" } })).toMatchObject({ accepted: true });
    // An explicit endpoint may be a local or proxied server: no key is assumed.
    expect(await post({ commandId: "c3", kind: "create-task", payload: { objective: "Explique o projeto", provider: "openrouter", model: "m", baseUrl: "http://127.0.0.1:59997/v1" } })).toMatchObject({ accepted: true });
  });

  it("previews the completion criterion of a request in advance (PG-025)", async () => {
    const { get } = await serve();
    expect(await get(`/api/acceptance-preview?objective=${encodeURIComponent("Por que o teste falha?")}`)).toMatchObject({ criteria: ["response"] });
    expect(await get(`/api/acceptance-preview?objective=${encodeURIComponent("Corrija o bug em a.js")}`)).toMatchObject({ criteria: ["unverified"] });
    expect(await get(`/api/acceptance-preview?objective=${encodeURIComponent("Crie uma pasta chamada Docs")}`)).toMatchObject({ criteria: ["directory-exists:Docs"] });
  });
});
