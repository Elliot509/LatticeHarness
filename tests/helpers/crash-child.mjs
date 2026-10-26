// Crash-test child: runs one task through the built TaskManager against a
// test-owned database and provider, then dies the way the parent asks. TEST
// INFRASTRUCTURE ONLY. Requires `npm run build` (imports dist/).
//
// Env: CRASH_DIST, CRASH_DATA, CRASH_WS, CRASH_PROVIDER_URL, CRASH_OBJECTIVE,
//      CRASH_MODE = "external" (parent kills us) | "before-send" (die right
//      after the dispatch marker, before fetch) | "after-rename:<file>" (die
//      right after the edit's atomic rename, before the receipt commits).
import fs from "node:fs";
import path from "node:path";

const dist = process.env.CRASH_DIST;
const mode = process.env.CRASH_MODE ?? "external";
const { openLatticeDb, claimOwnership } = await import(path.join(dist, "storage/db.js"));
const { TaskManager } = await import(path.join(dist, "server/tasks.js"));

if (mode === "before-send") {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (...args) => {
    if (String(args[0]).includes("/chat/completions")) process.kill(process.pid, "SIGKILL");
    return originalFetch(...args);
  };
}
if (mode.startsWith("after-rename:")) {
  const target = mode.slice("after-rename:".length);
  const originalRename = fs.renameSync;
  fs.renameSync = (from, to) => {
    originalRename(from, to);
    if (String(to).endsWith(target)) process.kill(process.pid, "SIGKILL");
  };
}

const db = openLatticeDb(process.env.CRASH_DATA);
claimOwnership(db.raw);
const tasks = new TaskManager(db.raw, process.env.CRASH_WS);
const created = tasks.handleCommand({
  commandId: "crash-create",
  kind: "create-task",
  payload: { workspace: "", objective: process.env.CRASH_OBJECTIVE, provider: "local", model: "crash-fixture", baseUrl: process.env.CRASH_PROVIDER_URL },
});
if (!created.accepted) {
  process.stdout.write(`${JSON.stringify({ error: "create refused", created })}\n`);
  process.exit(2);
}
// Report before starting: some modes die synchronously inside the start.
fs.writeSync(1, `${JSON.stringify({ taskId: created.taskId, pid: process.pid })}\n`);
const started = tasks.handleCommand({ commandId: "crash-start", kind: "start-task", taskId: created.taskId });
fs.writeSync(1, `${JSON.stringify({ started: started.accepted })}\n`);
setInterval(() => undefined, 60_000);
