import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { openLatticeDb, claimOwnership } from "../../src/storage/db.js";
import { saveProductConfig } from "../../src/productConfig.js";
import { serveLattice } from "../../src/server/server.js";
import { contextProvider } from "../helpers/context-provider.js";
import { launchChromium } from "./cdp.js";
import { driveConversation } from "../helpers/conversation-ui-driver.js";
import { evaluate, waitFor } from "../helpers/sprint-ui-driver.js";

describe("verified result and conversational follow-up in a real browser", () => {
  it("creates, displays the result, collapses/audits tools, retries a lost acknowledgement and reopens both tasks", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lattice-conversation-browser-")); const workspace = path.join(dir, "project"); fs.mkdirSync(workspace); fs.writeFileSync(path.join(workspace, "README.md"), "Fictitious");
    const finalText = "Resposta completa do modelo. ".repeat(180) + "MODEL-FINAL-TAIL";
    const provider = await contextProvider([{ id: "conversation-fixture", context_length: 128000 }], [
      { toolCalls: [{ name: "read", argumentsJson: '{"kind":"directory","path":"."}' }] },
      { toolCalls: [{ name: "exec", argumentsJson: JSON.stringify({ executable: process.execPath, argv: ["-e", "require('fs').mkdirSync('Python')"] }) }] },
      { toolCalls: [{ name: "read", argumentsJson: '{"kind":"directory","path":"."}' }] },
      { text: finalText },
    ]);
    const data = path.join(dir, "data"); const db = openLatticeDb(data); claimOwnership(db.raw); saveProductConfig(data, { schemaVersion: 1, defaultProviderId: "local", defaultModel: "conversation-fixture", defaultBaseUrl: provider.url, customProviders: [] });
    const server = await serveLattice({ db: db.raw, workspace, dataDir: data, assetRoot: path.resolve(__dirname, "../../dist/ui") }); const browser = await launchChromium(19009);
    try {
      await browser.session.send("Page.enable"); await browser.session.send("Page.navigate", { url: server.url });
      const { first, second } = await driveConversation(browser.session); expect(first.state).toBe("COMPLETED"); expect(second.state).toBe("COMPLETED"); expect(provider.requests).toHaveLength(3); expect(fs.statSync(path.join(workspace, "Python")).isDirectory()).toBe(true);
      await evaluate(browser.session, "(() => {const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'Leia README.md e explique o conteúdo.');e.dispatchEvent(new Event('input',{bubbles:true}));})()");
      await evaluate(browser.session, "document.querySelector('.composer .primary').click()");
      await waitFor(browser.session, "document.querySelector('.chat > .message-row.agent .text')?.textContent.includes('MODEL-FINAL-TAIL') === true && document.querySelector('.topbar')?.textContent.includes('Concluído') === true");
      expect(await evaluate(browser.session, "document.querySelector('.chat > .message-row.agent .text').textContent")).toBe(finalText);
      expect(await evaluate(browser.session, "document.querySelector('.chat > .message-row.agent .author').textContent")).toContain("resposta do modelo"); expect(provider.requests).toHaveLength(4);
    } finally { await browser.close(); await server.close(); db.close(); await provider.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  }, 30000);
});
