import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { highlight, inlineText, parseInline, parseMarkdown, safeHref } from "../../src/ui/markdown.js";
import { Markdown } from "../../src/ui/markdown-view.js";

const html = (text: string): string => renderToStaticMarkup(createElement(Markdown, { text }));

// The corpus the product audit found rendered literally (PG-001).
const AUDIT_CORPUS = [
  "**Análise concluída**",
  "",
  "# Relatório",
  "",
  "```javascript",
  "const total = items.reduce((sum, item) => sum + item.price, 0);",
  "```",
  "",
  "| Arquivo | Linhas |",
  "|---|---:|",
  "| src/sum.js | 9 |",
  "",
  "- [x] corrigir o desconto",
  "- [ ] rodar os testes",
  "",
  "> Atenção: o teste ainda falha.",
  "",
  "[documentação](https://example.com/docs)",
].join("\n");

describe("markdown parser", () => {
  it("parses every construct of the audit corpus into structure", () => {
    const blocks = parseMarkdown(AUDIT_CORPUS);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "heading", "code", "table", "list", "quote", "paragraph"]);
    const rendered = html(AUDIT_CORPUS);
    expect(rendered).toContain("<strong>Análise concluída</strong>");
    expect(rendered).toMatch(/<h3 class="md-h md-h1">Relatório<\/h3>/u);
    expect(rendered).toContain('<span class="md-code-lang">javascript</span>');
    expect(rendered).toContain('<span class="tok-keyword">const</span>');
    expect(rendered).toContain("<th>Arquivo</th>");
    expect(rendered).toContain('<td style="text-align:right">9</td>');
    expect(rendered).toMatch(/<li class="md-task"><input type="checkbox"[^>]*aria-label="Concluído"[^>]*\/>corrigir o desconto<\/li>/u);
    expect(rendered).toMatch(/<input type="checkbox"[^>]*checked=""[^>]*\/>corrigir/u);
    expect(rendered).toContain("<blockquote><p>Atenção: o teste ainda falha.</p></blockquote>");
    expect(rendered).toContain('href="https://example.com/docs"');
    expect(rendered).toContain('rel="noopener noreferrer nofollow"');
    // None of the raw markers survive as text.
    for (const marker of ["**", "# Relatório", "```", "|---|", "- [x]", "> Atenção", "](https"]) expect(rendered).not.toContain(marker);
  });

  it("handles emphasis, strikethrough, code spans and intraword underscores", () => {
    expect(html("*itálico* e __forte__ e ~~riscado~~")).toBe('<div class="md"><p><em>itálico</em> e <strong>forte</strong> e <del>riscado</del></p></div>');
    expect(html("*a **b** c*")).toBe('<div class="md"><p><em>a <strong>b</strong> c</em></p></div>');
    expect(html("use snake_case_name e 2 * 3 * 4")).toBe('<div class="md"><p>use snake_case_name e 2 * 3 * 4</p></div>');
    expect(html("chame `fn(**args)` agora")).toContain('<code class="md-inline-code">fn(**args)</code>');
    expect(html("\\*literal\\*")).toBe('<div class="md"><p>*literal*</p></div>');
  });

  it("builds nested and ordered lists and keeps line breaks inside paragraphs", () => {
    const blocks = parseMarkdown("1. primeiro\n   - sub a\n   - sub b\n2. segundo\n\nlinha um\nlinha dois");
    expect(blocks[0]).toMatchObject({ type: "list", ordered: true, start: 1 });
    const list = blocks[0];
    if (list?.type !== "list") throw new Error("list expected");
    expect(list.items).toHaveLength(2);
    expect(list.items[0]?.children.map((block) => block.type)).toEqual(["paragraph", "list"]);
    expect(html("linha um\nlinha dois")).toBe('<div class="md"><p>linha um<br/>linha dois</p></div>');
    expect(html("3. começa no três\n4. quatro")).toContain('<ol start="3">');
  });

  it("degrades malformed input to text instead of failing", () => {
    expect(parseMarkdown("```python\nprint('sem fim')")).toEqual([{ type: "code", lang: "python", text: "print('sem fim')", unterminated: true }]);
    // Unclosed emphasis and link stay literal; the bare URL inside still autolinks (GFM).
    expect(html("**sem fechamento e [link sem fim](http://a")).toContain("**sem fechamento e [link sem fim](<a href=\"http://a/\"");
    expect(html("| a | b |\n| c | d |")).not.toContain("<table");
    const deep = `${"> ".repeat(200)}fundo`;
    expect(() => parseMarkdown(deep)).not.toThrow();
    expect(() => parseInline("*".repeat(5000))).not.toThrow();
    expect(() => parseInline("[".repeat(3000) + "x" + "](http://a)".repeat(10))).not.toThrow();
  });

  it("autolinks bare URLs without swallowing trailing punctuation", () => {
    const nodes = parseInline("veja https://example.com/a(b). Depois <mailto:dev@example.com>");
    const links = nodes.filter((node) => node.type === "link");
    expect(links.map((node) => node.type === "link" ? node.href : null)).toEqual(["https://example.com/a(b)", "mailto:dev@example.com"]);
    expect(inlineText(nodes)).toContain("a(b). Depois");
  });
});

describe("markdown rendering is inert for untrusted input (PG-037)", () => {
  const INJECTION = [
    "<script>window.__pwned=1</script>",
    "<img src=x onerror=window.__pwned=1>",
    '<a href="javascript:alert(1)">raw html link</a>',
    "[clique](javascript:alert(1))",
    "[clique2](JaVaScRiPt:alert(1))",
    "[clique3](java\tscript:alert(1))",
    "[dados](data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==)",
    "[arquivo](file:///etc/passwd)",
    "[relativo](../segredo)",
    "![rastreador](https://tracker.example/pixel.png)",
    "![local](javascript:alert(1))",
    "<iframe src=https://evil.example></iframe>",
    "<style>body{display:none}</style>",
  ].join("\n\n");

  it("never emits executable markup, unsafe URLs or remote image loads", () => {
    const rendered = html(INJECTION);
    // No executable tags and no event-handler attribute inside any tag; the
    // escaped source text may still mention them, as inert characters.
    expect(rendered).not.toMatch(/<(?:script|img|iframe|style)\b/iu);
    expect(rendered).not.toMatch(/<[^>]*\son\w+=/iu);
    expect(rendered).not.toMatch(/href="(?:javascript|data|file|vbscript):/iu);
    // Raw HTML is shown as text, escaped.
    expect(rendered).toContain("&lt;script&gt;window.__pwned=1&lt;/script&gt;");
    // Refused links keep their label as plain, marked text.
    expect(rendered).toContain('<span class="md-link-blocked"');
    // Images become an explicit, user-initiated external link.
    expect(rendered).toContain('href="https://tracker.example/pixel.png"');
    expect(rendered).toContain("[imagem: rastreador — abrir externamente]");
    expect(rendered).toContain("[imagem: local]");
  });

  it("allows only absolute http(s) and mailto destinations", () => {
    expect(safeHref("https://example.com/x?y=1")).toBe("https://example.com/x?y=1");
    expect(safeHref("mailto:a@b.c")).toBe("mailto:a@b.c");
    for (const bad of ["javascript:alert(1)", " javascript:alert(1)", "vbscript:x", "data:text/html,x", "file:///etc/passwd", "/relative", "#frag", "ftp://x", "", "http//broken"]) {
      expect(safeHref(bad), bad).toBeNull();
    }
  });
});

describe("syntax highlighting", () => {
  it("tokenizes common languages and leaves unknown ones untouched", () => {
    const js = highlight("// soma\nconst n = 42; return \"ok\";", "ts");
    expect(js.find((token) => token.cls === "comment")?.text).toBe("// soma");
    expect(js.filter((token) => token.cls === "keyword").map((token) => token.text)).toEqual(["const", "return"]);
    expect(js.find((token) => token.cls === "number")?.text).toBe("42");
    expect(js.find((token) => token.cls === "string")?.text).toBe("\"ok\"");
    expect(highlight("SELECT * FROM t -- fim", "sql").map((token) => token.cls)).toContain("comment");
    expect(highlight("{\"a\": true}", "json").map((token) => token.cls)).toEqual(expect.arrayContaining(["attr", "literal"]));
    expect(highlight("anything", "brainfuck")).toEqual([{ text: "anything", cls: null }]);
    expect(highlight("x", null)).toEqual([{ text: "x", cls: null }]);
    // Highlighting never changes the text.
    const source = "def f(x):\n    return x + 1  # comentário\n";
    expect(highlight(source, "python").map((token) => token.text).join("")).toBe(source);
  });
});
