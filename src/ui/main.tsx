import { StrictMode, useEffect, useReducer, useRef } from "react";
import type { JSX } from "react";
import { createRoot } from "react-dom/client";
import { createApi } from "./api.js";
import { initialState, uiReducer } from "./state.js";
import { Chat, Composer, Detail, Header, HelpView, NewTask, SettingsView, Sidebar } from "./views.js";
import type { UiEvent } from "../server/protocol.js";

const api = createApi("");
const LAST_TASK_KEY = "lattice.lastTask";
const DRAFTS_KEY = "lattice.drafts";

// Per-viewer conveniences only (last open task, unsent drafts): storage may
// be unavailable or empty, and the UI works the same without it.
function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage unavailable: nothing to persist, nothing breaks.
  }
}

function restoredState(): typeof initialState {
  // Stored data is untrusted input: keep only string drafts.
  const drafts = readStored<unknown>(DRAFTS_KEY, {});
  const safe: Record<string, string> = {};
  if (typeof drafts === "object" && drafts !== null) {
    for (const [key, value] of Object.entries(drafts)) if (typeof value === "string") safe[key] = value;
  }
  return { ...initialState, drafts: safe, draft: safe["new"] ?? "" };
}

function TaskView(): JSX.Element {
  const [state, dispatch] = useReducer(uiReducer, undefined, restoredState);
  const restoredLastTask = useRef(false);

  useEffect(() => {
    document.getElementById("root")?.removeAttribute("aria-busy");
    // Phones and narrow windows keep the navigation rail collapsed: it would
    // otherwise overlay the task. Widening again leaves the choice to the user.
    const narrow = window.matchMedia("(max-width: 759px)");
    if (narrow.matches) dispatch({ type: "sidebar", open: false });
    const onChange = (event: MediaQueryListEvent): void => { if (event.matches) dispatch({ type: "sidebar", open: false }); };
    narrow.addEventListener("change", onChange);
    return () => { narrow.removeEventListener("change", onChange); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api
      .sessions(state.showArchived === true)
      .then((sessions) => {
        if (!cancelled) {
          dispatch({ type: "sessions", sessions });
          dispatch({ type: "connection", connection: "live" });
          // Reopen the task that was open before a reload or restart.
          if (!restoredLastTask.current) {
            restoredLastTask.current = true;
            const last = readStored<string | null>(LAST_TASK_KEY, null);
            if (typeof last === "string" && sessions.some((session) => session.taskId === last)) dispatch({ type: "open-task", taskId: last });
          }
        }
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "connection", connection: "error", error: "Não foi possível acessar o servidor local" });
      });
    // The list also reflects tasks other than the open one (follow-ups,
    // queued starts, another window): refresh slowly while visible.
    const timer = window.setInterval(() => {
      if (document.visibilityState !== "visible") return;
      api.sessions(state.showArchived === true).then((sessions) => { if (!cancelled) dispatch({ type: "sessions", sessions }); }).catch(() => undefined);
    }, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [state.activeTaskId, state.task?.state, state.sessionsVersion]);

  useEffect(() => {
    const taskId = state.activeTaskId;
    if (taskId === null) return;
    let cancelled = false;
    let unsubscribe: (() => void) | null = null;
    api
      .snapshot(taskId)
      .then((snapshot) => {
        if (cancelled) return;
        dispatch({ type: "snapshot", snapshot });
        dispatch({ type: "connection", connection: "live" });
        unsubscribe = api.subscribe(
          taskId,
          (event: UiEvent) => {
            if (!cancelled) dispatch({ type: "event", event });
          },
          (status) => {
            if (!cancelled) dispatch({ type: "connection", connection: status === "live" ? "live" : "reconnecting" });
          },
        );
      })
      .catch(() => {
        if (!cancelled) dispatch({ type: "connection", connection: "error", error: "não foi possível abrir a tarefa" });
      });
    return () => {
      cancelled = true;
      unsubscribe?.();
    };
  }, [state.activeTaskId]);

  useEffect(() => {
    if (restoredLastTask.current) writeStored(LAST_TASK_KEY, state.activeTaskId);
  }, [state.activeTaskId]);

  // Header actions outside the reducer's reach (archive) ask for a refresh.
  useEffect(() => {
    const stale = (): void => { dispatch({ type: "sessions-stale" }); dispatch({ type: "request-resync" }); };
    window.addEventListener("lattice:sessions-stale", stale);
    return () => { window.removeEventListener("lattice:sessions-stale", stale); };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      const drafts = { ...(state.drafts ?? {}), [state.activeTaskId ?? "new"]: state.draft };
      writeStored(DRAFTS_KEY, Object.fromEntries(Object.entries(drafts).filter(([, text]) => text.trim() !== "").slice(-50)));
    }, 300);
    return () => { window.clearTimeout(timer); };
  }, [state.draft, state.drafts, state.activeTaskId]);

  useEffect(() => {
    if (!state.needsResync || state.activeTaskId === null) return;
    const taskId = state.activeTaskId;
    const target = state.resyncTarget ?? state.lastSeq;
    let cancelled = false;
    const isCancelled = (): boolean => cancelled;
    const refresh = async (): Promise<void> => {
      while (!isCancelled()) {
        const snapshot = await api.snapshot(taskId);
        if (isCancelled()) return;
        dispatch({ type: "snapshot", snapshot });
        if (snapshot.cut >= target) return;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
    };
    void refresh().catch(() => { if (!cancelled) dispatch({ type: "connection", connection: "error", error: "Não foi possível atualizar a tarefa" }); });
    return () => {
      cancelled = true;
    };
  }, [state.needsResync, state.resyncTarget, state.activeTaskId]);

  return (
    <div className="app">
      <Sidebar state={state} dispatch={dispatch} />
      <div className={state.activeTaskId === null || state.view !== "task" ? "main landing-main" : "main"}>
        {state.activeTaskId !== null && state.view === "task" && <Header api={api} state={state} />}
        {state.view === "settings" ? (
          <div className="layout">
            <main className="center">
              <div className="reading page-reading">
                <SettingsView api={api} state={state} dispatch={dispatch} />
              </div>
            </main>
          </div>
        ) : state.view === "help" ? (
          <div className="layout">
            <main className="center">
              <div className="reading page-reading">
                <HelpView state={state} dispatch={dispatch} />
              </div>
            </main>
          </div>
        ) : (
        <div className="layout">
          <main className="center">
            {state.task === null ? (
              <div className="reading">
                {state.activeTaskId === null ? (
                  <NewTask api={api} state={state} dispatch={dispatch} />
                ) : (
                  <div className="opening-task" role="status" aria-label="Abrindo tarefa">
                    <span>Abrindo tarefa</span>
                    <span className="opening-line" />
                    <span className="opening-line short" />
                  </div>
                )}
              </div>
            ) : (
              <>
                <div className="reading">
                  <Chat api={api} state={state} dispatch={dispatch} />
                </div>
                <Composer api={api} state={state} dispatch={dispatch} />
                {state.actionError && <p className="conn error" role="alert">{state.actionError} <button type="button" className="btn" onClick={() => { dispatch({ type: "clear-action-error" }); }}>Fechar aviso da ação</button></p>}
              </>
            )}
            {state.connection === "reconnecting" && (
              <p className="conn" role="status">
                Reconectando ao runtime local; a tarefa continua executando.
              </p>
            )}
            {state.needsResync && (
              <p className="conn resync" role="status">
                Atualizando a projeção da tarefa após uma lacuna de eventos.
              </p>
            )}
            {state.connection === "error" && state.error !== null && (
              <p className="conn error" role="alert">
                {state.error}
              </p>
            )}
          </main>
          {state.detailId !== null && <Detail api={api} state={state} dispatch={dispatch} />}
        </div>
        )}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <TaskView />
  </StrictMode>,
);
