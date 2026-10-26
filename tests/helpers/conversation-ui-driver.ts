import assert from "node:assert/strict";
import type { CdpSession } from "../browser/cdp.js";
import type { TaskSnapshot } from "../../src/server/protocol.js";
import { evaluate, waitFor } from "./sprint-ui-driver.js";

export async function driveConversation(session: CdpSession) {
  const creation = 'Crie uma pasta chamada "Python" dentro desse lugar.';
  const listing = "Me liste tudo que está nessa pasta.";
  await waitFor(session, "document.querySelector('.newtask-modelbtn')?.textContent.includes('conversation-fixture') === true");
  await evaluate(session, `(() => {const e=document.querySelector('#new-task-objective');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(creation)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(session, "document.querySelector('button[aria-label=\"Iniciar tarefa\"]').click()");
  await waitFor(session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true && document.querySelector('.chat > .message-row.verified') !== null");
  assert.match(await evaluate<string>(session, "document.querySelector('.chat > .message-row.verified .author').textContent"), /resultado verificado/i);
  assert.match(await evaluate<string>(session, "document.querySelector('.chat > .message-row.verified .text').textContent"), /A pasta "Python" existe/);
  assert.equal(await evaluate(session, "document.querySelector('.execution-block').open"), false);
  assert.match(await evaluate<string>(session, "document.querySelector('.execution-block summary').textContent"), /2 ferramentas executadas · Concluído/);
  assert.equal(await evaluate(session, "document.querySelector('.composer textarea').placeholder"), "Pergunte algo ou peça o próximo passo");
  const first = await evaluate<TaskSnapshot>(session, "(async()=>{const l=await(await fetch('/api/sessions')).json();return await(await fetch('/api/tasks/'+l.sessions[0].taskId+'/snapshot')).json()})()");
  await evaluate(session, "document.querySelector('.execution-block summary').click()");
  await waitFor(session, "document.querySelector('.execution-block').open === true");
  await evaluate(session, "[...document.querySelectorAll('.toolrow-head')].find(e=>e.textContent.includes('exec')).click()");
  await waitFor(session, "document.querySelector('.arguments-section')?.textContent.includes('Python') === true");
  assert.match(await evaluate<string>(session, "document.querySelector('.detail').textContent"), /Argumentos|Estado|Evidência/);
  await evaluate(session, "document.querySelector('[aria-label=\"Fechar detalhe\"]').click()");
  assert.equal(await evaluate(session, "document.querySelector('.execution-block').open"), true);
  await evaluate(session, "document.querySelector('.execution-block summary').click()");
  await session.send("Emulation.setDeviceMetricsOverride", { width: 480, height: 850, deviceScaleFactor: 1, mobile: true });
  assert.equal(await evaluate(session, "document.documentElement.scrollWidth <= innerWidth"), true);
  await session.send("Emulation.clearDeviceMetricsOverride");
  // Narrow viewports collapse the navigation rail; reopen it for the list checks below.
  await evaluate(session, "(() => { if (document.querySelector('.sidebar.collapsed')) document.querySelector('.rail-toggle').click(); return true; })()");
  // The server accepts and completes the request, but the browser loses its
  // acknowledgement. Retrying must retain the same durable command identity.
  await evaluate(session, `(() => { const original=window.fetch;window.__followUpIds=[];let lose=true;window.fetch=async(...args)=>{const raw=args[1]?.body;const body=typeof raw==='string'?JSON.parse(raw):null;if(body?.kind==='follow-up-task'||body?.kind==='send-message'){window.__followUpIds.push(body.commandId);const result=await original(...args);if(lose){lose=false;throw new Error('simulated lost acknowledgement');}return result;}return original(...args);}; })()`);
  await evaluate(session, `(() => {const e=document.querySelector('.composer textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(listing)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await evaluate(session, "document.querySelector('.composer .primary').click()");
  await waitFor(session, "document.querySelector('.composer').textContent.includes('simulated lost acknowledgement') === true");
  assert.equal(await evaluate(session, "document.querySelector('.composer textarea').value"), listing);
  await evaluate(session, "document.querySelector('.composer .primary').click();document.querySelector('.composer .primary').click()");
  await waitFor(session, "document.querySelector('.objective-panel')?.textContent.includes('Me liste tudo') === true && document.querySelector('.topbar')?.textContent.includes('Concluído') === true && document.querySelector('.chat > .message-row.verified .text')?.textContent.includes('Python') === true");
  const ids = await evaluate<string[]>(session, "window.__followUpIds"); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
  assert.equal(await evaluate(session, "document.querySelectorAll('.chat > .message-row.verified').length"), 1);
  assert.equal(await evaluate(session, "document.querySelectorAll('.chat > .message-row.user').length"), 1);
  assert.equal(await evaluate(session, "document.querySelector('.execution-block').open"), false);
  const second = await evaluate<TaskSnapshot>(session, "(async()=>{const l=await(await fetch('/api/sessions')).json();return await(await fetch('/api/tasks/'+l.sessions[0].taskId+'/snapshot')).json()})()");
  assert.notEqual(first.taskId, second.taskId); assert.notEqual(first.rootId, second.rootId); assert.equal(first.workspace, second.workspace);
  const unchanged = await evaluate<TaskSnapshot>(session, `(async()=>await(await fetch('/api/tasks/'+${JSON.stringify(first.taskId)}+'/snapshot')).json())()`); assert.deepEqual(unchanged, first);
  await waitFor(session, "document.querySelectorAll('.session').length === 2");
  await evaluate(session, "[...document.querySelectorAll('.session')].find(e=>e.textContent.includes('Crie')).click()");
  await waitFor(session, "document.querySelector('.chat > .message-row.verified .text')?.textContent.includes('A pasta') === true");
  await session.send("Page.reload"); await waitFor(session, "document.querySelectorAll('.session').length === 2");
  await evaluate(session, "[...document.querySelectorAll('.session')].find(e=>e.textContent.includes('Me liste')).click()");
  await waitFor(session, "document.querySelector('.topbar')?.textContent.includes('Concluído') === true && document.querySelector('.chat > .message-row.verified .text')?.textContent.includes('Python') === true");
  assert.equal(await evaluate(session, "document.querySelectorAll('.chat > .message-row.verified').length"), 1);
  return { first, second };
}
