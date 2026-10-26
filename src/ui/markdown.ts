// Markdown → typed tree, for model output shown in the chat. The raw text
// stays the canonical, persisted form; this tree is derived on render and
// never stored. No HTML is ever produced or interpreted: raw HTML in the
// source stays literal text, and links/images carry a vetted URL or none.
// Coverage is the subset models actually emit (CommonMark blocks, GFM
// tables, task lists, strikethrough and autolinks); anything malformed
// degrades to literal text, never to a parse failure.

export type Inline =
  | { type: "text"; text: string }
  | { type: "code"; text: string }
  | { type: "strong"; children: Inline[] }
  | { type: "em"; children: Inline[] }
  | { type: "del"; children: Inline[] }
  | { type: "link"; href: string | null; title: string | null; children: Inline[] }
  | { type: "image"; alt: string; src: string | null }
  | { type: "break" };

export type Align = "left" | "center" | "right" | null;

export interface ListItem {
  checked: boolean | null;
  children: Block[];
}

export type Block =
  | { type: "heading"; level: number; children: Inline[] }
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; lang: string | null; text: string; unterminated: boolean }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number | null; items: ListItem[] }
  | { type: "table"; align: Align[]; header: Inline[][]; rows: Inline[][][] }
  | { type: "hr" };

const MAX_DEPTH = 12;
const SAFE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

// Navigation allowlist: absolute http(s) and mailto only. Relative paths,
// fragments, javascript:, data:, file: and anything unparsable are refused.
export function safeHref(raw: string): string | null {
  const trimmed = raw.trim().replace(/^<(.*)>$/u, "$1");
  if (trimmed === "") return null;
  try {
    const url = new URL(trimmed);
    return SAFE_PROTOCOLS.has(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const FENCE = /^( {0,3})(`{3,}|~{3,})[ \t]*([^`\s]*)[^`]*$/u;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?(?:[ \t]+#+)?[ \t]*$/u;
const HR = /^ {0,3}(?:(?:-[ \t]*){3,}|(?:\*[ \t]*){3,}|(?:_[ \t]*){3,})$/u;
const QUOTE = /^ {0,3}>[ ]?/u;
const LIST_ITEM = /^( *)([-*+]|\d{1,9}[.)])([ \t]+|$)(.*)$/u;
const TABLE_DELIMITER = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function splitRow(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|") && !text.endsWith("\\|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let code = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text.charAt(index);
    if (char === "\\" && text[index + 1] === "|") { current += "|"; index += 1; continue; }
    if (char === "`") code = !code;
    if (char === "|" && !code) { cells.push(current.trim()); current = ""; continue; }
    current += char;
  }
  cells.push(current.trim());
  return cells;
}

function startsBlock(line: string, next: string | undefined): boolean {
  return FENCE.test(line) || HEADING.test(line) || HR.test(line) || QUOTE.test(line)
    // Only bullets and lists starting at 1 interrupt a paragraph ("2024. foi" stays text).
    || /^ {0,3}(?:[-*+]|1[.)])[ \t]+\S/u.test(line)
    || (line.includes("|") && next !== undefined && TABLE_DELIMITER.test(next) && next.includes("-"));
}

export function parseMarkdown(source: string): Block[] {
  return parseBlocks(source.replace(/\r\n?/gu, "\n").split("\n"), 0);
}

function parseBlocks(lines: string[], depth: number): Block[] {
  const blocks: Block[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (isBlank(line)) { index += 1; continue; }
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const indent = fence[1]?.length ?? 0;
      const marker = fence[2] ?? "```";
      const body: string[] = [];
      let closed = false;
      index += 1;
      while (index < lines.length) {
        const current = lines[index] ?? "";
        const closing = /^( {0,3})(`{3,}|~{3,})[ \t]*$/u.exec(current);
        if (closing !== null && (closing[2] ?? "")[0] === marker[0] && (closing[2] ?? "").length >= marker.length) { closed = true; index += 1; break; }
        body.push(current.replace(new RegExp(`^ {0,${indent}}`, "u"), ""));
        index += 1;
      }
      blocks.push({ type: "code", lang: fence[3] === undefined || fence[3] === "" ? null : fence[3].toLowerCase(), text: body.join("\n"), unterminated: !closed });
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading !== null) {
      blocks.push({ type: "heading", level: heading[1]?.length ?? 1, children: parseInline(heading[2] ?? "", depth) });
      index += 1;
      continue;
    }
    if (HR.test(line)) { blocks.push({ type: "hr" }); index += 1; continue; }
    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length && !isBlank(lines[index] ?? "")) {
        const current = lines[index] ?? "";
        // Lazy continuation: plain lines without ">" stay in the quote.
        if (!QUOTE.test(current) && startsBlock(current, lines[index + 1])) break;
        body.push(current.replace(QUOTE, ""));
        index += 1;
      }
      blocks.push({ type: "quote", children: depth >= MAX_DEPTH ? [{ type: "paragraph", children: [{ type: "text", text: body.join("\n") }] }] : parseBlocks(body, depth + 1) });
      continue;
    }
    const next = lines[index + 1];
    if (line.includes("|") && next !== undefined && next.includes("-") && TABLE_DELIMITER.test(next)) {
      const header = splitRow(line);
      const align: Align[] = splitRow(next).map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : cell.startsWith(":") ? "left" : null);
      if (align.length === header.length) {
        index += 2;
        const rows: Inline[][][] = [];
        while (index < lines.length && !isBlank(lines[index] ?? "") && (lines[index] ?? "").includes("|")) {
          const cells = splitRow(lines[index] ?? "");
          rows.push(header.map((_, column) => parseInline(cells[column] ?? "", depth)));
          index += 1;
        }
        blocks.push({ type: "table", align, header: header.map((cell) => parseInline(cell, depth)), rows });
        continue;
      }
    }
    const item = LIST_ITEM.exec(line);
    if (item !== null && (item[4] ?? "").trim() !== "" ) {
      const parsed = parseList(lines, index, depth);
      blocks.push(parsed.block);
      index = parsed.next;
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && !isBlank(lines[index] ?? "")) {
      const current = lines[index] ?? "";
      if (paragraph.length > 0 && startsBlock(current, lines[index + 1])) break;
      paragraph.push(current.trim());
      index += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(paragraph.join("\n"), depth) });
  }
  return blocks;
}

function parseList(lines: string[], start: number, depth: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[start] ?? "");
  const baseIndent = first?.[1]?.length ?? 0;
  const ordered = /\d/u.test(first?.[2] ?? "");
  const startNumber = ordered ? Number.parseInt(first?.[2] ?? "1", 10) : null;
  const items: ListItem[] = [];
  let index = start;
  while (index < lines.length) {
    const match = LIST_ITEM.exec(lines[index] ?? "");
    if (match === null) break;
    const indent = match[1]?.length ?? 0;
    if (indent < baseIndent || indent > baseIndent + 3) break;
    if (/\d/u.test(match[2] ?? "") !== ordered) break;
    const contentOffset = indent + (match[2]?.length ?? 1) + Math.min(4, Math.max(1, match[3]?.length ?? 1));
    const body: string[] = [match[4] ?? ""];
    index += 1;
    let sawBlank = false;
    while (index < lines.length) {
      const current = lines[index] ?? "";
      if (isBlank(current)) { sawBlank = true; body.push(""); index += 1; continue; }
      const currentIndent = current.length - current.trimStart().length;
      if (currentIndent >= contentOffset || (currentIndent > baseIndent && LIST_ITEM.test(current))) {
        body.push(current.slice(Math.min(currentIndent, contentOffset)));
        sawBlank = false;
        index += 1;
        continue;
      }
      // Lazy continuation of the item's paragraph (no blank line before).
      if (!sawBlank && !startsBlock(current, lines[index + 1]) && currentIndent > baseIndent - 1 && !LIST_ITEM.test(current)) {
        body.push(current.trim());
        index += 1;
        continue;
      }
      break;
    }
    while (body.length > 0 && isBlank(body.at(-1) ?? "")) body.pop();
    let checked: boolean | null = null;
    const task = /^\[([ xX])\][ \t]+/u.exec(body[0] ?? "");
    if (task !== null) {
      checked = task[1] !== " ";
      body[0] = (body[0] ?? "").slice(task[0].length);
    }
    items.push({ checked, children: depth >= MAX_DEPTH ? [{ type: "paragraph", children: [{ type: "text", text: body.join("\n") }] }] : parseBlocks(body, depth + 1) });
    // A blank line followed by something that is not the next item ends the list.
    if (index < lines.length && !LIST_ITEM.test(lines[index] ?? "")) break;
  }
  return { block: { type: "list", ordered, start: startNumber, items }, next: index };
}

const PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/u;

function isWhitespace(char: string | undefined): boolean {
  return char === undefined || /\s/u.test(char);
}

function isWordChar(char: string | undefined): boolean {
  return char !== undefined && /[\p{L}\p{N}]/u.test(char);
}

export function parseInline(text: string, depth = 0): Inline[] {
  const out: Inline[] = [];
  let buffer = "";
  const flush = (): void => {
    if (buffer !== "") { out.push({ type: "text", text: buffer }); buffer = ""; }
  };
  const push = (node: Inline): void => { flush(); out.push(node); };
  let index = 0;
  while (index < text.length) {
    const char = text[index] ?? "";
    if (char === "\\" && index + 1 < text.length) {
      const next = text[index + 1] ?? "";
      if (next === "\n") { push({ type: "break" }); index += 2; continue; }
      if (PUNCTUATION.test(next)) { buffer += next; index += 2; continue; }
    }
    if (char === "\n") {
      buffer = buffer.replace(/ +$/u, "");
      push({ type: "break" });
      index += 1;
      continue;
    }
    if (char === "`") {
      let run = 1;
      while (text[index + run] === "`") run += 1;
      const fence = "`".repeat(run);
      let search = index + run;
      let close = -1;
      while (search < text.length) {
        const found = text.indexOf(fence, search);
        if (found === -1) break;
        if (text[found + run] !== "`" && text[found - 1] !== "`") { close = found; break; }
        search = found + 1;
      }
      if (close !== -1) {
        let content = text.slice(index + run, close).replace(/\n/gu, " ");
        if (content.length > 1 && content.startsWith(" ") && content.endsWith(" ")) content = content.slice(1, -1);
        push({ type: "code", text: content });
        index = close + run;
        continue;
      }
      buffer += fence;
      index += run;
      continue;
    }
    if (depth < MAX_DEPTH && (char === "!" && text[index + 1] === "[" || char === "[")) {
      const image = char === "!";
      const parsed = parseLink(text, image ? index + 1 : index);
      if (parsed !== null) {
        if (image) push({ type: "image", alt: parsed.label, src: safeHref(parsed.destination) });
        else push({ type: "link", href: safeHref(parsed.destination), title: parsed.title, children: parseInline(parsed.label, depth + 1) });
        index = parsed.end;
        continue;
      }
    }
    if (char === "<") {
      const auto = /^<((?:https?:\/\/|mailto:)[^\s<>]+)>/iu.exec(text.slice(index));
      if (auto !== null) {
        const href = safeHref(auto[1] ?? "");
        push({ type: "link", href, title: null, children: [{ type: "text", text: auto[1] ?? "" }] });
        index += auto[0].length;
        continue;
      }
    }
    if ((char === "h" || char === "H") && !isWordChar(text[index - 1])) {
      const bare = /^https?:\/\/[^\s<]+/iu.exec(text.slice(index));
      if (bare !== null) {
        let url = bare[0];
        // GFM autolink literal: trailing punctuation and unbalanced ")" stay outside.
        while (/[.,:;!?'"*_~]$/u.test(url)) url = url.slice(0, -1);
        while (url.endsWith(")") && (url.match(/\)/gu)?.length ?? 0) > (url.match(/\(/gu)?.length ?? 0)) url = url.slice(0, -1);
        push({ type: "link", href: safeHref(url), title: null, children: [{ type: "text", text: url }] });
        index += url.length;
        continue;
      }
    }
    if (depth < MAX_DEPTH && (char === "*" || char === "_" || char === "~")) {
      const emphasis = parseEmphasis(text, index, depth);
      if (emphasis !== null) {
        push(emphasis.node);
        index = emphasis.end;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return out;
}

function parseEmphasis(text: string, index: number, depth: number): { node: Inline; end: number } | null {
  const char = text[index] ?? "";
  let run = 1;
  while (text[index + run] === char) run += 1;
  if (char === "~" && run !== 2) return null;
  const width = char === "~" ? 2 : Math.min(run, 2);
  const delimiter = char.repeat(width);
  const after = text[index + width];
  if (isWhitespace(after)) return null;
  // Intraword underscores never emphasize (snake_case stays literal).
  if (char === "_" && isWordChar(text[index - 1])) return null;
  let search = index + width + 1;
  while (search <= text.length - width) {
    const close = text.indexOf(delimiter, search);
    if (close === -1) return null;
    const before = text[close - 1];
    const following = text[close + width];
    // A single delimiter that belongs to a longer run ("**") cannot close "*".
    const sameRunContinues = width === 1 && (following === char || before === char);
    if (!isWhitespace(before) && !(char === "_" && isWordChar(following)) && !sameRunContinues) {
      const inner = text.slice(index + width, close);
      if (inner.trim() !== "") {
        const children = parseInline(inner, depth + 1);
        const node: Inline = char === "~" ? { type: "del", children } : width === 2 ? { type: "strong", children } : { type: "em", children };
        return { node, end: close + width };
      }
    }
    search = close + 1;
  }
  return null;
}

function parseLink(text: string, open: number): { label: string; destination: string; title: string | null; end: number } | null {
  let depthCount = 0;
  let close = -1;
  for (let index = open; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "`") {
      const end = text.indexOf("`", index + 1);
      if (end !== -1) { index = end; continue; }
    }
    if (char === "[") depthCount += 1;
    if (char === "]") { depthCount -= 1; if (depthCount === 0) { close = index; break; } }
  }
  if (close === -1 || text[close + 1] !== "(") return null;
  let parens = 0;
  let end = -1;
  for (let index = close + 2; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") { index += 1; continue; }
    if (char === "\n") return null;
    if (char === "(") parens += 1;
    if (char === ")") { if (parens === 0) { end = index; break; } parens -= 1; }
  }
  if (end === -1) return null;
  const inside = text.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+(?:"([^"]*)"|'([^']*)')$/u.exec(inside);
  return {
    label: text.slice(open + 1, close),
    destination: titled?.[1] ?? inside,
    title: titled === null ? null : titled[2] ?? titled[3] ?? null,
    end: end + 1,
  };
}

// Plain text of inline nodes (aria labels, link host comparison, copy).
export function inlineText(nodes: readonly Inline[]): string {
  return nodes.map((node) => node.type === "text" || node.type === "code" ? node.text : node.type === "break" ? "\n" : node.type === "image" ? node.alt : inlineText(node.children)).join("");
}

export type TokenClass = "comment" | "string" | "number" | "keyword" | "literal" | "tag" | "attr" | null;

const KEYWORDS: Record<string, readonly string[]> = {
  js: ["const", "let", "var", "function", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "new", "class", "extends", "import", "from", "export", "default", "async", "await", "try", "catch", "finally", "throw", "typeof", "instanceof", "in", "of", "this", "super", "yield", "delete", "void", "interface", "type", "enum", "implements", "readonly", "public", "private", "protected", "static", "as", "satisfies", "keyof", "declare", "namespace"],
  python: ["def", "return", "if", "elif", "else", "for", "while", "in", "not", "and", "or", "is", "import", "from", "as", "class", "try", "except", "finally", "raise", "with", "lambda", "yield", "pass", "break", "continue", "global", "nonlocal", "async", "await", "assert", "del"],
  shell: ["if", "then", "else", "elif", "fi", "for", "while", "do", "done", "case", "esac", "function", "in", "export", "local", "return", "echo", "cd", "set", "unset", "source"],
  sql: ["select", "from", "where", "insert", "into", "values", "update", "set", "delete", "create", "table", "index", "drop", "alter", "join", "left", "right", "inner", "outer", "on", "group", "by", "order", "having", "limit", "offset", "and", "or", "not", "null", "as", "distinct", "union", "primary", "key", "foreign", "references", "default", "begin", "commit", "rollback"],
  c: ["int", "long", "short", "char", "float", "double", "void", "struct", "union", "enum", "typedef", "const", "static", "return", "if", "else", "for", "while", "do", "switch", "case", "break", "continue", "sizeof", "include", "define", "fn", "let", "mut", "pub", "use", "mod", "impl", "trait", "match", "func", "package", "import", "go", "defer", "chan", "select", "class", "public", "private", "protected", "new", "throw", "throws", "try", "catch", "finally", "extends", "implements", "interface", "namespace", "using", "var", "val", "fun", "when", "override", "self", "Self", "where", "async", "await", "move", "ref", "type"],
};

const LANGUAGE_FAMILY: Record<string, string> = {
  js: "js", javascript: "js", jsx: "js", ts: "js", typescript: "js", tsx: "js", mjs: "js", cjs: "js",
  py: "python", python: "python",
  sh: "shell", bash: "shell", zsh: "shell", shell: "shell", console: "shell",
  sql: "sql",
  c: "c", h: "c", cpp: "c", "c++": "c", cs: "c", csharp: "c", java: "c", go: "c", rust: "c", rs: "c", kotlin: "c", kt: "c", swift: "c", php: "c", scala: "c",
  json: "json", jsonc: "json",
  html: "markup", xml: "markup", svg: "markup", vue: "markup",
  css: "css", scss: "css",
  yaml: "hash", yml: "hash", toml: "hash", ini: "hash", dockerfile: "hash", ruby: "hash", rb: "hash", r: "hash",
};

// Lightweight lexical highlighting: comments, strings, numbers, keywords
// and literals for common languages. Unknown languages render unhighlighted.
export function highlight(code: string, lang: string | null): Array<{ text: string; cls: TokenClass }> {
  const family = lang === null ? undefined : LANGUAGE_FAMILY[lang.toLowerCase()];
  if (family === undefined || code.length > 200_000) return [{ text: code, cls: null }];
  const lineComment = family === "js" || family === "c" ? "//" : family === "python" || family === "shell" || family === "hash" ? "#" : family === "sql" ? "--" : null;
  const blockComment = family === "js" || family === "c" || family === "css" ? ["/*", "*/"] : family === "markup" ? ["<!--", "-->"] : null;
  const keywords = new Set(KEYWORDS[family] ?? []);
  const tokens: Array<{ text: string; cls: TokenClass }> = [];
  const pushToken = (text: string, cls: TokenClass): void => {
    const last = tokens.at(-1);
    if (last !== undefined && last.cls === cls) last.text += text;
    else tokens.push({ text, cls });
  };
  let index = 0;
  while (index < code.length) {
    const rest = code.slice(index);
    if (blockComment !== null && rest.startsWith(blockComment[0] ?? "")) {
      const end = code.indexOf(blockComment[1] ?? "", index + (blockComment[0]?.length ?? 0));
      const stop = end === -1 ? code.length : end + (blockComment[1]?.length ?? 0);
      pushToken(code.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (lineComment !== null && rest.startsWith(lineComment) && !(lineComment === "#" && family === "shell" && /[\w$]/u.test(code[index - 1] ?? ""))) {
      const end = code.indexOf("\n", index);
      const stop = end === -1 ? code.length : end;
      pushToken(code.slice(index, stop), "comment");
      index = stop;
      continue;
    }
    if (family === "markup" && rest.startsWith("<")) {
      const tag = /^<\/?[A-Za-z][\w:-]*/u.exec(rest);
      if (tag !== null) { pushToken(tag[0], "tag"); index += tag[0].length; continue; }
    }
    const char = code[index] ?? "";
    if (char === "\"" || char === "'" || (char === "`" && family === "js")) {
      let end = index + 1;
      while (end < code.length && code[end] !== char) {
        if (code[end] === "\\") end += 1;
        if (code[end] === "\n" && char !== "`") break;
        end += 1;
      }
      const stop = Math.min(code.length, end + 1);
      pushToken(code.slice(index, stop), family === "json" && /^\s*:/u.test(code.slice(stop)) ? "attr" : "string");
      index = stop;
      continue;
    }
    const number = /^-?(?:0x[\da-f]+|\d+(?:\.\d+)?(?:e[+-]?\d+)?)/iu.exec(rest);
    if (number !== null && !/[\w$]/u.test(code[index - 1] ?? "")) {
      pushToken(number[0], "number");
      index += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_$][\w$]*/u.exec(rest);
    if (word !== null) {
      const value = word[0];
      const cls: TokenClass = keywords.has(family === "sql" ? value.toLowerCase() : value) ? "keyword"
        : /^(?:true|false|null|undefined|None|True|False|nil|NaN|Infinity)$/u.test(value) ? "literal" : null;
      pushToken(value, cls);
      index += value.length;
      continue;
    }
    pushToken(char, null);
    index += 1;
  }
  return tokens;
}
