import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership } from "../../src/storage/db.js";
import { serveLattice } from "../../src/server/server.js";
import { startFixtureProvider } from "../helpers/fixture-provider.js";
import { driveSprintDemo } from "../helpers/sprint-ui-driver.js";
import { waitFor, evaluate } from "../helpers/sprint-ui-driver.js";
import { saveProductConfig } from "../../src/productConfig.js";
import { launchChromium } from "./cdp.js";

describe("fresh Friday UI workflow", () => {
  it("opens the one created task and shows it queued while another task runs (PG-013)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-start-denial-"));
    const workspace = path.join(dir, "ws"); fs.mkdirSync(workspace);
    const db = openLatticeDb(path.join(dir, "data")); claimOwnership(db.raw);
    const held: http.ServerResponse[] = [];
    const provider = http.createServer((req, res) => { req.resume(); req.on("end", () => { held.push(res); }); });
    await new Promise<void>(resolve => { provider.listen(0, "127.0.0.1", resolve); });
    const address = provider.address(); if (address === null || typeof address === "string") throw new Error("no fixture address");
    const endpoint = `http://127.0.0.1:${address.port}/v1`;
    saveProductConfig(path.join(dir, "data"), { schemaVersion: 1, defaultProviderId: "local", defaultModel: "fixture", defaultBaseUrl: endpoint, customProviders: [] });
    const server = await serveLattice({ db: db.raw, workspace, dataDir: path.join(dir, "data"), assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19005);
    const command = async (body: Record<string, unknown>) => await (await fetch(`${server.url}/api/commands`, { method: "POST", headers: { "Content-Type": "application/json", Cookie: server.bootstrapCookie }, body: JSON.stringify(body) })).json() as { taskId: string; accepted: boolean };
    try {
      const active = await command({ kind: "create-task", commandId: "active", payload: { objective: "Inspect", acceptance: ["response"], provider: "local", model: "fixture", baseUrl: endpoint } });
      expect((await command({ kind: "start-task", commandId: "start-active", taskId: active.taskId })).accepted).toBe(true);
      await browser.session.send("Page.enable"); await browser.session.send("Page.navigate", { url: server.url });
      await waitFor(browser.session, `document.querySelector('.newtask-modelbtn')?.textContent.includes('fixture') === true`);
      await evaluate(browser.session, `(() => { const e=document.querySelector('#new-task-objective'); Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Create directory second'); e.dispatchEvent(new Event('input',{bubbles:true})); })()`);
      await evaluate(browser.session, `document.querySelector('button[aria-label="Iniciar tarefa"]').click()`);
      await waitFor(browser.session, `document.querySelector('.topbar')?.textContent.includes('Na fila') === true && document.querySelector('.task-notices')?.textContent.includes('começa sozinha') === true`);
      expect(await evaluate(browser.session, `[...document.querySelectorAll('.composer button')].some((b) => b.textContent === 'Tirar da fila')`)).toBe(true);
      expect(db.raw.prepare("SELECT COUNT(*) AS n FROM contracts").get()).toMatchObject({ n: 2 });
      expect(await evaluate(browser.session, `document.querySelector('.newtask') === null`)).toBe(true);
    } finally {
      for (const res of held) res.destroy(); provider.closeAllConnections();
      await browser.close(); await server.close(); db.close();
      await new Promise<void>(resolve => { provider.close(() => resolve()); }); fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 30000);
  it("configures a local model, reads a real file, creates and verifies a directory, then reloads retained history", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-sprint-ui-"));
    const workspace = path.join(dir, "café"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "notes.txt"), "Preserve this file.");
    const db = openLatticeDb(path.join(dir, "data")); claimOwnership(db.raw);
    const fixture = await startFixtureProvider([
      { toolCalls: [{ name: "read", argumentsJson: '{"path":"notes.txt"}' }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('fs').mkdirSync('Muse')"] }) }] },
    ]);
    const server = await serveLattice({ db: db.raw, workspace, dataDir: path.join(dir, "data"), assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19004);
    try {
      await browser.session.send("Page.enable");
      await browser.session.send("Page.navigate", { url: server.url });
      await driveSprintDemo(browser.session, fixture.url, "/tmp/lattice-sprint-ui-shots");
      expect(fs.statSync(path.join(workspace, "Muse")).isDirectory()).toBe(true);
      expect(fs.readFileSync(path.join(workspace, "notes.txt"), "utf8")).toBe("Preserve this file.");
      expect(fixture.requests).toHaveLength(2);
      const terminal = db.raw.prepare("SELECT payload FROM events WHERE kind = 'task-state' ORDER BY seq DESC LIMIT 1").get() as { payload: string };
      expect(JSON.parse(terminal.payload)).toMatchObject({ state: "COMPLETED" });
    } finally { await browser.close(); await server.close(); db.close(); await fixture.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
