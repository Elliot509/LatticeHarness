import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { resolveInScope } from "../platform/paths.js";
import type { ToolResult } from "../tools/types.js";
import { VerifyLedger, summarizeExecResult } from "./verify.js";
import type { DirectoryPage, DirectoryEntry } from "../tools/directory.js";

export type AcceptancePredicate =
  | { kind: "directory-exists" | "file-exists"; path: string }
  | { kind: "directory-listing"; path: string; recursive: boolean; filter: "all" | "files" | "directories" }
  | { kind: "tests-pass" | "response" | "clarification-required" | "unverified" };

const LOCAL_LOCATION = String.raw`(?:(?:dentro\s+(?:desta|dessa|deste|desse|esta|essa|este|esse))|(?:nesta|nessa|neste|nesse|no))\s+(?:pasta|diret[oó]rio|lugar|projeto|ambiente)|aqui`;
const CLARIFY = "Defina um alvo, escopo e critério explícitos; operações adicionais ou localização ambígua precisam de confirmação.";

export interface AcceptanceResolution {
  criteria: string[];
  source: "explicit" | "default";
  policyVersion: "acceptance-4";
  reason: string;
}

// A bounded grammar for ONE creation, not a shell parser or general intent
// classifier. Location clauses may only refer to the selected workspace.
// Unconsumed text is a material obligation: never discard it to infer success.
function creationCriterion(objective: string): string | null {
  const creation = /^(?:por favor[, ]+)?(?:cri[ea]|criar|create)\s+(?:(?:um|uma|o|a|an?|the)\s+)?(pastas?|diret[oó]rios?|directories|directory|folders?|arquivos?|files?)(?:\s+([\s\S]*))?$/iu.exec(objective.trim().replace(/[.!?]+$/u, ""));
  if (!creation) return null;
  const noun = creation[1] ?? "";
  if (/s$/iu.test(noun) || /[;\r\n]/u.test(objective)) return "clarification-required";
  let rest = (creation[2] ?? "").trim().replace(/[.!?]+$/u, "").trim();
  // Confirming the same existence adds no separate effect. No other action
  // following a conjunction is silently reduced to a single creation.
  rest = rest.replace(/,?\s+e\s+confirme\s+(?:que\s+(?:ela|ele|a\s+pasta|o\s+diret[oó]rio|o\s+arquivo)\s+existe|(?:a|sua)\s+exist[eê]ncia)$/iu, "");
  const leading = new RegExp(`^(?:${LOCAL_LOCATION})\\s+`, "iu");
  const trailing = new RegExp(`\\s+(?:${LOCAL_LOCATION})$`, "iu");
  if (leading.test(rest) && trailing.test(rest)) return "clarification-required";
  rest = rest.replace(leading, "").replace(trailing, "");
  if (/^(?:chamad[ao]|named|called|nome|com\s+o\s+nome|que\s+tenha\s+o\s+nome)$/iu.test(rest)) return "clarification-required";
  rest = rest.replace(/^(?:(?:que\s+tenha\s+o\s+)?nome\s+(?:de\s+)?|chamad[ao]\s+|named\s+|called\s+|(?:com\s+o\s+nome|with\s+the\s+name)\s+(?:de\s+)?)/iu, "");
  const named = /^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|`([^`\r\n]+)`|([^\s"'`<>]+))$/u.exec(rest);
  const target = named?.slice(1).find(Boolean);
  // No environment expansion, absolute paths, traversal or inferred shell
  // syntax. Explicit criteria still use the canonical runtime scope check.
  if (!target || target.trim() !== target || /[<>|;&$():\r\n\0]/u.test(target)
    || path.posix.isAbsolute(target) || path.win32.isAbsolute(target)
    || target.split(/[/\\]/u).some(part => part === ".." || part === "")
    || target.split(/[/\\]/u).every(part => part === ".")) return "clarification-required";
  return `${/^(?:arquivo|file)$/iu.test(noun) ? "file" : "directory"}-exists:${target}`;
}

// Only a complete, local inventory request is eligible. A conjunction, named
// external location or additional obligation is not silently discarded.
function listingCriterion(objective: string): string | null {
  const text = objective.trim().replace(/[.!?]+$/u, "").replace(/^por favor[, ]+/iu, "");
  const match = /^(?:(?:me\s+)?(?:liste|listar|mostre|mostrar|list|show)\s+(?:(?:os|as|todos\s+os|todas\s+as)\s+)?(tudo|arquivos|diret[oó]rios|pastas|files|directories|entries)(?:\s+que\s+(?:est[aá]|est[aã]o|existem|existe))?\s+(aqui|(?:nessa|nesta|dessa|desta|nesse|neste|desse|deste|na|no)\s+(?:pasta|diret[oó]rio|projeto|lugar))|quais\s+(arquivos|diret[oó]rios|pastas)\s+(?:existem|est[aã]o)\s+(aqui|(?:nessa|nesta|nesse|neste)\s+(?:pasta|diret[oó]rio|projeto)))(?:\s+(recursivamente|recursive(?:ly)?))?$/iu.exec(text);
  if (match === null) return null;
  const noun = match[1] ?? match[3] ?? "";
  const filter = /^(?:arquivos|files)$/iu.test(noun) ? "files" : /^(?:diret[oó]rios|pastas|directories)$/iu.test(noun) ? "directories" : "all";
  return `directory-listing:${filter}:${match[5] === undefined ? "immediate" : "recursive"}:.`;
}

const MUTATION = /\b(?:corri(?:ja|jam|gir|ge|gindo)|consert(?:e|ar|em|ando)|arrum(?:e|ar|em)|modifi(?:que|car|quem)|alter(?:e|ar|em|ando)|implement(?:e|ar|em|ando)|adicion(?:e|ar|em)|cri(?:e|ar|em|ando)|remov(?:a|e|er|am)|apag(?:ue|ar|uem)|delet(?:e|ar)|renomei(?:e|ar)|renomear|mov(?:a|er|am)|refator(?:e|ar)|atualiz(?:e|ar|em)|escrev(?:a|er|am)|edit(?:e|ar|em)|instal(?:e|ar)|organiz(?:e|ar|em)|fix|fixes|change|modify|implement|add|create|remove|delete|rename|move|refactor|update|write|edit|install|organi[sz]e)\b/iu;
const TESTS = /\b(?:testes?|tests?|pytest|vitest|jest|mocha|npm\s+test|cargo\s+test|go\s+test|su[ií]te\s+de\s+testes)\b/iu;
const ANALYSIS = /^(?:(?:por favor|please)[, ]+)?(?:(?:voc[eê]|vc|you)\s+)?(?:(?:pode|poderia|consegue|can|could)\s+(?:me\s+)?)?(?:expli(?:que|car|ca)|explain|anal[yi]s[ea]\w*|resum\w*|summari[sz]e|inspect\w*|inspecion\w*|read|leia|ler|descrev\w*|describe|revis\w*|review|avali\w*|diagn[oó]stic\w*|compare|compar\w*|o\s+que\s+(?:faz|é|significa))\b/iu;
const QUESTION_WORD = /^(?:(?:e|and|ent[aã]o|mas|but|so|ok)[, ]+)?(?:como|por\s*qu[eê]|porque|o\s+que|qual|quais|onde|quando|quem|quanto|quantos|quantas|what|why|how|which|where|when|who)\b/iu;

export function resolveAcceptance(objective: string, explicit: readonly string[] = []): AcceptanceResolution {
  const version = "acceptance-4" as const;
  // Do not run heuristics at all when the human supplied criteria.
  if (explicit.length > 0) return { criteria: [...explicit], source: "explicit", policyVersion: version, reason: "user-defined criteria" };
  const text = objective.trim();
  const creation = creationCriterion(objective);
  if (creation !== null) return { criteria: [creation], source: "default", policyVersion: version, reason: creation === "clarification-required" ? "filesystem creation needs an explicit target or criterion" : "single bounded filesystem creation" };
  const listing = listingCriterion(objective);
  if (listing !== null) return { criteria: [listing], source: "default", policyVersion: version, reason: "bounded directory inventory; immediate children unless recursion explicitly requested" };
  if (/^(?:por favor[, ]+)?(?:(?:me\s+)?(?:liste|listar|mostre|mostrar|list|show)\b|quais\s+(?:arquivos|diret[oó]rios|pastas)\b)/iu.test(text) && !/\b(?:corrija|modifique|implemente|apague|remova|crie|execute)\b/iu.test(objective)) return { criteria: ["clarification-required"], source: "default", policyVersion: version, reason: "inventory scope or additional obligations need clarification" };
  // The deliverable of an explanation or a question is the answer itself.
  // Any mutation verb anywhere disqualifies it: an answer never certifies a change.
  const asksAnswer = (ANALYSIS.test(text) || (QUESTION_WORD.test(text) && /\?\s*$/u.test(text))) && !MUTATION.test(text.replace(QUESTION_WORD, "").replace(/^\s*(?:corrijo|conserto|arrumo|fa[cç]o)\b/iu, ""));
  if (asksAnswer) return { criteria: ["response"], source: "default", policyVersion: version, reason: "analysis or question: the answer is the deliverable" };
  // Tests named explicitly: completion requires observed passing tests.
  if (TESTS.test(text)) return { criteria: ["tests-pass"], source: "default", policyVersion: version, reason: "tests named in the request" };
  // Everything else changes things in ways no generic predicate can certify:
  // the run ends awaiting human review, never concluded by model text.
  return { criteria: ["unverified"], source: "default", policyVersion: version, reason: "no automatic verifier for this request; human review decides" };
}

export function defaultAcceptance(objective: string): string[] {
  return resolveAcceptance(objective).criteria;
}

function predicate(text: string): AcceptancePredicate | null {
  const listing = /^directory-listing:(all|files|directories):(immediate|recursive):(.+)$/u.exec(text);
  if (listing?.[1] && listing[3]) return { kind: "directory-listing", filter: listing[1] as "all" | "files" | "directories", recursive: listing[2] === "recursive", path: listing[3] };
  const match = /^(directory-exists|file-exists):(.+)$/u.exec(text);
  if (match?.[1] && match[2]) return { kind: match[1] as "directory-exists" | "file-exists", path: match[2] };
  if (text === "response") return { kind: "response" };
  if (text === "unverified") return { kind: "unverified" };
  if (text === "clarification-required") return { kind: "clarification-required" };
  if (text === "tests-pass" || /^(?:project test suite passes|tests pass|task completed as verified)$/iu.test(text)) return { kind: "tests-pass" };
  return null;
}

export interface WorkspaceSnapshot {
  version: string | null;
  reason: string;
  entries: Map<string, string>;
  bytesRead: number;
  durationMs: number;
}

export function sameObservedFile(before: Pick<fs.BigIntStats, "ino" | "dev">, opened: Pick<fs.BigIntStats, "ino" | "dev">, platform: NodeJS.Platform = process.platform): boolean {
  // Node 22 on Windows can report path-stat dev=0 but handle-stat the
  // volume serial. Keep the nonzero file ID check; do not ignore a known
  // device mismatch or apply this exception to POSIX.
  return before.ino === opened.ino && before.ino !== 0n
    && (before.dev === opened.dev || (platform === "win32" && before.dev === 0n));
}

// Content evidence only at verification boundaries, never per read/search.
// Coverage deliberately excludes generated/dependency directories. Symlink
// destinations outside this tree and the test runner's environment are not
// certified. This is an observation, not an atomic filesystem snapshot.
export async function workspaceVersion(root: string, options: { signal?: AbortSignal; maxDurationMs?: number } = {}): Promise<WorkspaceSnapshot> {
  const hash = createHash("sha256");
  const entries = new Map<string, string>();
  const started = performance.now();
  const buffer = Buffer.allocUnsafe(64 * 1024);
  let bytesRead = 0;
  const guard = (): void => {
    if (options.signal?.aborted === true) throw new Error("verification cancelled");
    if (performance.now() - started >= (options.maxDurationMs ?? 30_000)) throw new Error("content observation deadline exceeded; retry in a quiet, bounded project");
  };
  const walk = async (dir: string): Promise<void> => {
    guard();
    const items = await fs.promises.readdir(dir, { withFileTypes: true });
    items.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const item of items) {
      guard();
      if ([".git", "node_modules", "dist", ".cache"].includes(item.name)) continue;
      const full = path.join(dir, item.name);
      const relative = path.relative(root, full);
      const before = await fs.promises.lstat(full, { bigint: true });
      let record: unknown[];
      if (before.isSymbolicLink()) record = [relative, "symlink", await fs.promises.readlink(full)];
      else if (before.isDirectory()) record = [relative, "directory", String(before.mode)];
      else if (before.isFile()) {
        const content = createHash("sha256");
        // Open without following a swapped symlink; use the same descriptor
        // for identity and streaming, then check the path still names it.
        const file = await fs.promises.open(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
        try {
          const opened = await file.stat({ bigint: true });
          if (!sameObservedFile(before, opened) || !opened.isFile()) throw new Error("file changed during content observation");
          for (;;) {
            guard();
            const { bytesRead: count } = await file.read(buffer, 0, buffer.length, null);
            if (count === 0) break;
            content.update(buffer.subarray(0, count));
            bytesRead += count;
          }
        } finally { await file.close(); }
        record = [relative, "file", String(before.mode), String(before.size), content.digest("hex")];
      } else throw new Error("unsupported filesystem entry; content evidence unknown");
      const after = await fs.promises.lstat(full, { bigint: true });
      if (["dev", "ino", "size", "mtimeNs", "ctimeNs", "mode"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after])) throw new Error("entry changed during content observation");
      const encoded = JSON.stringify(record);
      hash.update(encoded).update("\n"); // JSON escaping frames paths/types/content unambiguously.
      entries.set(relative, encoded);
      if (before.isDirectory()) await walk(full);
    }
  };
  try {
    await walk(root);
    return { version: hash.digest("hex"), reason: "content observed", entries, bytesRead, durationMs: performance.now() - started };
  } catch (error) {
    const known = error instanceof Error && /^(verification cancelled|content observation deadline|file changed|entry changed|unsupported filesystem)/u.test(error.message);
    return { version: null, reason: known ? error.message : "workspace content observation incomplete (unreadable or changing entry)", entries, bytesRead, durationMs: performance.now() - started };
  }
}

export class TaskAcceptance {
  private readonly ledger = new VerifyLedger();
  private prepared: WorkspaceSnapshot | null = null;
  private tested: WorkspaceSnapshot | null = null;
  private unknownReason = "test evidence requires a content observation before execution";
  private signal: AbortSignal | undefined;
  private mutated = false;
  private readonly checks: Array<AcceptancePredicate | null>;
  private readonly root: string;
  private readonly criteria: readonly string[];
  private readonly inventories = new Map<string, { page: DirectoryPage; entries: Map<number, DirectoryEntry> }>();

  constructor(root: string, criteria: readonly string[]) {
    this.root = root;
    this.criteria = criteria;
    this.checks = criteria.map(predicate);
  }

  async prepare(tool: string, signal?: AbortSignal): Promise<void> {
    this.signal = signal;
    if (tool === "exec" && this.checks.some(check => check?.kind === "tests-pass")) {
      this.prepared = await workspaceVersion(this.root, signal === undefined ? {} : { signal });
    }
  }

  async observe(tool: string, argsJson: string, result: ToolResult): Promise<void> {
    if (result.directoryPage !== undefined && result.status === "completed" && result.errorKind === undefined && result.effectUncertain !== true) {
      const page = result.directoryPage;
      const current = this.inventories.get(page.snapshot) ?? { page, entries: new Map<number, DirectoryEntry>() };
      current.page = page;
      page.entries.forEach((entry, index) => current.entries.set(page.offset + index, entry));
      this.inventories.set(page.snapshot, current);
      if (this.inventories.size > 8) this.inventories.delete(this.inventories.keys().next().value ?? "");
    }
    if (tool === "edit" && result.errorKind === undefined) { this.mutated = true; this.tested = null; }
    if (tool !== "exec") return;
    if (result.errorKind !== "invalid-args") { this.mutated = true; this.tested = null; }
    const summary = summarizeExecResult(argsJson, this.root, result, 0);
    if (summary.countsKnown) {
      this.ledger.record(summary);
      if (this.ledger.check().complete && result.effectUncertain !== true && result.status === "completed") {
        const after = await workspaceVersion(this.root, this.signal === undefined ? {} : { signal: this.signal });
        this.unknownReason = this.prepared?.version === null ? this.prepared.reason : after.version === null ? after.reason : "workspace changed while tests ran; rerun tests after changes settle";
        if (this.prepared?.version !== null && this.prepared?.version !== undefined && after.version === this.prepared.version) this.tested = after;
      }
    }
    this.prepared = null;
  }

  get hasFilesystemPredicate(): boolean { return this.checks.some((check) => check?.kind === "directory-exists" || check?.kind === "file-exists" || check?.kind === "directory-listing"); }

  // An explicit composite contract may also require writes or tests. Restrict
  // tools only for a single inventory obligation, never discard other criteria.
  get directoryOnly(): boolean { return this.checks.length === 1 && this.checks[0]?.kind === "directory-listing"; }

  get inventoryInstruction(): string | null {
    const check = this.checks.find(check => check?.kind === "directory-listing");
    if (check?.kind !== "directory-listing") return null;
    return `Inventário verificado: use read com kind="directory", path=${JSON.stringify(check.path)}, recursive=${check.recursive}; siga nextCursor até observar todas as páginas. Não repita ls/find para obter uma cauda omitida. O runtime entregará a lista das entradas observadas; resultados parciais não comprovam completude.`;
  }

  get clarificationReason(): string | null { return this.checks.some(check => check?.kind === "clarification-required") ? CLARIFY : null; }

  async check(finalText?: string): Promise<{ complete: boolean; reason: string; finalText?: string; review?: boolean }> {
    const observed: string[] = [];
    const responses: string[] = [];
    let current: WorkspaceSnapshot | null = null;
    let review = false;
    for (const [index, check] of this.checks.entries()) {
      if (check === null) return { complete: false, reason: `criterion needs an explicit verifier: ${this.criteria[index]}` };
      if (check.kind === "clarification-required") return { complete: false, reason: CLARIFY };
      if (check.kind === "unverified") { review = true; continue; }
      if (check.kind === "directory-listing") {
        const target = resolveInScope(this.root, check.path);
        const root = resolveInScope(this.root, ".");
        if (target === null || root === null) return { complete: false, reason: "directory listing scope escapes workspace" };
        const scope = path.relative(root, target) || ".";
        const inventory = [...this.inventories.values()].reverse().find(item => item.page.scope === scope && item.page.recursive === check.recursive);
        if (inventory === undefined || !inventory.page.scanComplete || inventory.entries.size !== inventory.page.total || Array.from({ length: inventory.page.total }, (_, i) => i).some(i => !inventory.entries.has(i))) return { complete: false, reason: "directory inventory incomplete: use read kind=directory and retrieve every nextCursor; no complete list certified" };
        const entries = [...inventory.entries.entries()].sort(([a], [b]) => a - b).map(([, entry]) => entry).filter(entry => check.filter === "all" || entry.type === (check.filter === "files" ? "file" : "directory"));
        responses.push(`Listei ${entries.length} entrada(s) em ${JSON.stringify(scope)} — ${check.recursive ? "escopo recursivo" : "somente filhos imediatos, sem recursão"}${check.filter === "all" ? "" : `; filtro: ${check.filter === "files" ? "arquivos" : "diretórios"}`}. Ocultos incluídos; links simbólicos listados sem seguir seus destinos.\n\n${entries.map(entry => `- ${JSON.stringify(entry.path)} [${entry.type}]`).join("\n") || "A pasta não contém entradas desse tipo."}\n\nTodas as ${inventory.page.total} entradas do escopo foram recuperadas. Esta é uma observação do diretório, não um snapshot atômico de alterações futuras.`);
        observed.push(`directory inventory delivered: ${inventory.page.total} entries observed in ${scope}`);
      } else if (check.kind === "directory-exists" || check.kind === "file-exists") {
        const target = resolveInScope(this.root, check.path);
        if (target === null) return { complete: false, reason: `acceptance target escapes the workspace: ${check.path}` };
        try {
          const stat = fs.statSync(target);
          if (!(check.kind === "directory-exists" ? stat.isDirectory() : stat.isFile())) throw new Error("wrong kind");
          observed.push(`${check.kind}:${check.path} observed on filesystem`);
          responses.push(`${check.kind === "directory-exists" ? "A pasta" : "O arquivo"} ${JSON.stringify(check.path)} existe no projeto. Existência confirmada pelo Lattice.`);
        } catch { return { complete: false, reason: `${check.kind}:${check.path} not observed` }; }
      } else if (check.kind === "tests-pass") {
        const tests = this.ledger.check();
        if (!tests.complete) return tests;
        if (this.tested === null) return { complete: false, reason: `test evidence unknown or stale: ${this.unknownReason}` };
        current ??= await workspaceVersion(this.root, this.signal === undefined ? {} : { signal: this.signal });
        if (current.version === null) return { complete: false, reason: `test evidence unknown: ${current.reason}` };
        if (current.version !== this.tested.version) {
          const changed = [...new Set([...current.entries.keys(), ...this.tested.entries.keys()])].find(key => current?.entries.get(key) !== this.tested?.entries.get(key));
          return { complete: false, reason: `test evidence is stale: observed content changed (${changed ?? "workspace"}); rerun tests` };
        }
        observed.push(tests.reason);
      } else {
        if (finalText === undefined || finalText.trim() === "") return { complete: false, reason: "final analysis response required" };
        observed.push(`analysis response provided; filesystem correctness not certified${this.mutated ? "; exec/edit effects are not certified by response" : ""}`);
      }
    }
    // "unverified" never concludes by itself: the run ends awaiting a human
    // decision, with the other criteria's observations already checked.
    if (review) return { complete: false, review: true, reason: `result awaits human review: no automatic verifier for this request${observed.length > 0 ? `; observed: ${observed.join("; ")}` : ""}` };
    return { complete: observed.length > 0, reason: observed.join("; ") || "no acceptance criteria", ...(responses.length > 0 ? { finalText: responses.join("\n\n") } : {}) };
  }
}
