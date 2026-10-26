import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { claimOwnership, openLatticeDb } from "../../src/storage/db.js";
import { serveLattice } from "../../src/server/server.js";
import { saveProductConfig } from "../../src/productConfig.js";
import { startFixtureProvider } from "../helpers/fixture-provider.js";
import { evaluate, waitFor } from "../helpers/sprint-ui-driver.js";
import { launchChromium } from "./cdp.js";

// Release-candidate qualification of UI behaviors that had no dedicated
// test: PG-014 (session list refresh), PG-016 (first-use checklist), PG-020
// (last task and draft after reload), PG-021 (disabled look), PG-023 (inline
// diff), PG-026 (no start before /api/info), PG-028 (h1/favicon), PG-032
// (copy path), PG-033 (search results open a preview). Real backend, real
// Chromium, deterministic local provider.

const LONG = `// ${"uma linha bem longa ".repeat(30)}`;
const SOURCE = `export const total = 1;\n// TODO corrigir o limite\n${LONG}\n`;
const version = `sha256:${createHash("sha256").update(SOURCE).digest("hex").slice(0, 16)}`;

const type = (selector: string, text: string): string => `(() => { const e = document.querySelector(${JSON.stringify(selector)}); const proto = e instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype; Object.getOwnPropertyDescriptor(proto, 'value').set.call(e, ${JSON.stringify(text)}); e.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`;

describe("release-candidate UI qualification against the real backend", () => {
  it("covers first use, loading, diff, search preview, copy, persistence and list refresh", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-candidate-browser-"));
    const root = path.join(dir, "project");
    fs.mkdirSync(path.join(root, "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "src", "app.js"), SOURCE);
    const data = path.join(dir, "data");
    const db = openLatticeDb(data);
    claimOwnership(db.raw);
    const fixture = await startFixtureProvider([
      { toolCalls: [{ name: "search", argumentsJson: JSON.stringify({ kind: "text", query: "TODO" }) }] },
      { toolCalls: [{ name: "edit", argumentsJson: JSON.stringify({ kind: "replace", path: "src/app.js", expectedVersion: version, oldText: "// TODO corrigir o limite", newText: "// limite corrigido" }) }] },
      { text: "Pronto: troquei o comentário." },
    ]);
    const server = await serveLattice({ db: db.raw, workspace: root, dataDir: data, assetRoot: path.resolve(__dirname, "../../dist/ui") });
    const browser = await launchChromium(19010);
    const s = browser.session;
    try {
      await s.send("Page.enable");
      await s.send("Browser.grantPermissions", { permissions: ["clipboardReadWrite", "clipboardSanitizedWrite"] }).catch(() => undefined);
      // PG-026: hold /api/info; nothing can start before the server answered.
      await s.send("Page.addScriptToEvaluateOnNewDocument", { source: "(() => { const real = window.fetch.bind(window); let release; const gate = new Promise((r) => { release = r; }); window.__releaseInfo = () => release(); window.fetch = (input, init) => String(typeof input === 'string' ? input : input.url).includes('/api/info') && !window.__infoOnce ? (window.__infoOnce = true, gate.then(() => real(input, init))) : real(input, init); })()" });
      await s.send("Page.navigate", { url: server.url });
      await waitFor(s, "document.querySelector('#new-task-objective') !== null");
      await evaluate(s, type("#new-task-objective", "Corrija o TODO em src/app.js"));
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(await evaluate<boolean>(s, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').disabled")).toBe(true);
      expect(await evaluate<boolean>(s, "document.querySelector('.onboarding') === null")).toBe(true);
      await evaluate(s, "window.__releaseInfo()");
      // PG-016: with no model configured the checklist says what is missing,
      // and start stays disabled with that reason.
      await waitFor(s, "document.querySelector('.onboarding') !== null");
      const checklist = await evaluate<string[]>(s, "[...document.querySelectorAll('.onboarding li')].map((li) => li.className + ':' + li.querySelector('.label').textContent)");
      expect(checklist).toContain("todo:Escolha o provedor e o modelo");
      expect(checklist.some((item) => item.startsWith("done:Pasta do projeto"))).toBe(true);
      expect(await evaluate<string>(s, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').title")).toContain("escolha o provedor e o modelo");
      // PG-021: the disabled submit does not look like the enabled one.
      const disabledLook = await evaluate<string>(s, "getComputedStyle(document.querySelector('.newtask-submit')).backgroundColor");

      // Configure the route and reload: the first task runs.
      saveProductConfig(data, { schemaVersion: 1, defaultProviderId: "local", defaultModel: "fixture", defaultBaseUrl: fixture.url, customProviders: [] });
      await s.send("Page.reload");
      await waitFor(s, "typeof window.__releaseInfo === 'function'");
      await evaluate(s, "window.__releaseInfo()");
      await waitFor(s, "document.querySelector('.newtask-modelbtn')?.textContent.includes('fixture') === true");
      await evaluate(s, type("#new-task-objective", "Corrija o TODO em src/app.js"));
      await waitFor(s, "!document.querySelector('.newtask-submit').disabled");
      const enabledLook = await evaluate<string>(s, "getComputedStyle(document.querySelector('.newtask-submit')).backgroundColor");
      expect(enabledLook).not.toBe(disabledLook);
      await evaluate(s, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').click()");
      await waitFor(s, "document.querySelector('.topbar')?.textContent.includes('Aguardando sua revisão') === true", 20000);
      expect(fs.readFileSync(path.join(root, "src", "app.js"), "utf8")).toContain("// limite corrigido");

      // PG-028: the task view has a document heading; the icon is served.
      expect(await evaluate<string>(s, "document.querySelector('h1')?.textContent ?? ''")).toBe("Corrija o TODO em src/app.js");
      expect(await evaluate<string>(s, "fetch(document.querySelector('link[rel=icon]').href).then((r) => r.status + ' ' + r.headers.get('content-type'))")).toMatch(/^200 image\/svg\+xml/u);

      // PG-023: the edit's changes open inline, both sides, wrapped (no
      // horizontal clipping of the long line).
      await evaluate(s, "(() => { const d = document.querySelector('.inline-diff'); d.open = true; d.dispatchEvent(new Event('toggle')); return true; })()");
      await waitFor(s, "document.querySelector('.inline-diff pre .add') !== null");
      const diff = await evaluate<{ del: string[]; add: string[]; clipped: boolean }>(s, "(() => { const pre = document.querySelector('.inline-diff pre'); return { del: [...pre.querySelectorAll('.del')].map((e) => e.textContent), add: [...pre.querySelectorAll('.add')].map((e) => e.textContent), clipped: pre.scrollWidth > pre.clientWidth + 1 }; })()");
      expect(diff.del.join("")).toContain("// TODO corrigir o limite");
      expect(diff.add.join("")).toContain("// limite corrigido");
      expect(diff.clipped).toBe(false);

      // PG-033: the search result is a link to a read-only preview at the hit.
      await evaluate(s, "(() => { const row = [...document.querySelectorAll('.chat .toolrow')].find((e) => e.querySelector('.toolname')?.textContent === 'search'); row.querySelector('.toolrow-head').click(); return true; })()");
      await waitFor(s, "document.querySelector('.search-results button') !== null");
      expect(await evaluate<string>(s, "document.querySelector('.search-results button').textContent")).toBe("src/app.js:2");
      await evaluate(s, "document.querySelector('.search-results button').click()");
      await waitFor(s, "document.querySelector('.file-preview .line.hit') !== null");
      // The preview shows the file as it is now (after the edit), at line 2.
      expect(await evaluate<string>(s, "document.querySelector('.file-preview .line.hit').textContent")).toBe("2// limite corrigido\n");

      // PG-032: the project path is copyable.
      await s.send("Emulation.setFocusEmulationEnabled", { enabled: true });
      expect(await evaluate<string>(s, "document.querySelector('.railws').textContent")).toBe(root);
      // Headless Chromium keeps no readable system clipboard; what the app
      // hands to the Clipboard API is what is asserted.
      await evaluate(s, "(() => { const real = navigator.clipboard.writeText.bind(navigator.clipboard); navigator.clipboard.writeText = (text) => { window.__copied = text; return real(text); }; return true; })()");
      await evaluate(s, "document.querySelector('.railws-row button').click()");
      await waitFor(s, "document.querySelector('.railws-row button').textContent !== 'Copiar caminho'");
      expect(await evaluate<string>(s, "document.querySelector('.railws-row button').textContent")).toBe("Copiado");
      const copied = await evaluate<string>(s, "window.__copied");
      expect(copied).toBe(root);

      // PG-020: a draft and the open task survive a reload.
      await evaluate(s, type(".composer textarea", "rascunho que não foi enviado"));
      await new Promise((resolve) => setTimeout(resolve, 300));
      await s.send("Page.reload");
      await waitFor(s, "typeof window.__releaseInfo === 'function'");
      await evaluate(s, "window.__releaseInfo()");
      await waitFor(s, "document.querySelector('.topbar')?.textContent.includes('Corrija o TODO') === true");
      await waitFor(s, "document.querySelector('.composer textarea')?.value === 'rascunho que não foi enviado'");

      // PG-014: a task created elsewhere (another window, the CLI) appears
      // in the list without a reload.
      expect(await evaluate<number>(s, "document.querySelectorAll('.session').length")).toBe(1);
      const created = await evaluate<boolean>(s, "fetch('/api/commands', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ commandId: 'elsewhere', kind: 'create-task', payload: { workspace: '', objective: 'Tarefa criada em outra janela', provider: 'local', model: 'fixture', baseUrl: " + JSON.stringify(fixture.url) + " } }) }).then((r) => r.json()).then((j) => j.accepted)");
      expect(created).toBe(true);
      await waitFor(s, "[...document.querySelectorAll('.session')].some((e) => e.textContent.includes('Tarefa criada em outra janela'))", 15000);
    } finally {
      await browser.close(); await server.close(); await fixture.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60000);
});
