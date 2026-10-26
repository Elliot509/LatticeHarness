import { useMemo, useRef, useState } from "react";
import type { JSX, ReactNode } from "react";
import { highlight, inlineText, parseMarkdown, type Block, type Inline } from "./markdown.js";

// Renders model Markdown as React elements only: no innerHTML anywhere, so
// the text can never become markup. Links open externally after an
// allowlist check; images are never fetched (CSP and policy: no remote
// loads), they render as a labeled link instead.

// Clipboard API only (the UI is served from loopback, a secure context).
// When it is refused the button says so; the text stays selectable.
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

// When the clipboard is refused, the content is selected instead so a
// keyboard copy (Ctrl/Cmd+C) still works, and the button says so.
export function CopyButton({ text, label = "Copiar", className = "btn copy-btn", selectOnFailure }: { text: string; label?: string; className?: string; selectOnFailure?: () => Element | null }): JSX.Element {
  const [state, setState] = useState<"idle" | "done" | "selected" | "failed">("idle");
  return (
    <button
      type="button"
      className={className}
      aria-label={state === "done" ? "Copiado" : state === "selected" ? "Texto selecionado; use Ctrl+C" : label}
      onClick={() => {
        void copyText(text).then((ok) => {
          let next: "done" | "selected" | "failed" = ok ? "done" : "failed";
          const target = ok ? null : selectOnFailure?.() ?? null;
          if (target !== null) {
            window.getSelection()?.selectAllChildren(target);
            next = "selected";
          }
          setState(next);
          window.setTimeout(() => { setState("idle"); }, next === "selected" ? 4000 : 1600);
        });
      }}
    >
      {state === "done" ? "Copiado" : state === "selected" ? "Selecionado · Ctrl+C" : state === "failed" ? "Não copiado" : label}
    </button>
  );
}

function hostOf(href: string): string {
  try {
    const url = new URL(href);
    return url.protocol === "mailto:" ? url.pathname : url.host;
  } catch {
    return "";
  }
}

function renderInline(nodes: readonly Inline[], keyPrefix: string): ReactNode[] {
  return nodes.map((node, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (node.type) {
      case "text":
        return node.text;
      case "break":
        return <br key={key} />;
      case "code":
        return <code key={key} className="md-inline-code">{node.text}</code>;
      case "strong":
        return <strong key={key}>{renderInline(node.children, key)}</strong>;
      case "em":
        return <em key={key}>{renderInline(node.children, key)}</em>;
      case "del":
        return <del key={key}>{renderInline(node.children, key)}</del>;
      case "link": {
        if (node.href === null) {
          return <span key={key} className="md-link-blocked" title="Link não aberto: só endereços http, https e mailto são permitidos">{renderInline(node.children, key)}</span>;
        }
        const host = hostOf(node.href);
        const label = inlineText(node.children);
        return (
          <a key={key} href={node.href} target="_blank" rel="noopener noreferrer nofollow" title={node.title === null ? node.href : `${node.title} — ${node.href}`}>
            {renderInline(node.children, key)}
            {host !== "" && !label.includes(host) && <span className="md-link-host"> ({host})</span>}
          </a>
        );
      }
      case "image":
        return node.src === null
          ? <span key={key} className="md-image">[imagem: {node.alt || "sem descrição"}]</span>
          : <a key={key} className="md-image" href={node.src} target="_blank" rel="noopener noreferrer nofollow" title={node.src}>[imagem: {node.alt || "sem descrição"} — abrir externamente]</a>;
    }
  });
}

function CodeBlock({ block }: { block: Extract<Block, { type: "code" }> }): JSX.Element {
  const tokens = useMemo(() => highlight(block.text, block.lang), [block.text, block.lang]);
  const codeRef = useRef<HTMLElement>(null);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <span className="md-code-lang">{block.lang ?? "texto"}</span>
        {block.unterminated && <span className="md-code-note">bloco sem fechamento</span>}
        <CopyButton text={block.text} label="Copiar código" selectOnFailure={() => codeRef.current} />
      </div>
      <pre tabIndex={0}><code ref={codeRef}>{tokens.map((token, index) => token.cls === null ? token.text : <span key={index} className={`tok-${token.cls}`}>{token.text}</span>)}</code></pre>
    </div>
  );
}

function renderBlocks(blocks: readonly Block[], keyPrefix: string): ReactNode[] {
  return blocks.map((block, index) => {
    const key = `${keyPrefix}-${index}`;
    switch (block.type) {
      case "heading": {
        // Message headings sit below the page and section headings.
        const level = Math.min(6, block.level + 2);
        const Tag = `h${level}` as "h3" | "h4" | "h5" | "h6";
        return <Tag key={key} className={`md-h md-h${block.level}`}>{renderInline(block.children, key)}</Tag>;
      }
      case "paragraph":
        return <p key={key}>{renderInline(block.children, key)}</p>;
      case "code":
        return <CodeBlock key={key} block={block} />;
      case "quote":
        return <blockquote key={key}>{renderBlocks(block.children, key)}</blockquote>;
      case "hr":
        return <hr key={key} />;
      case "list": {
        const items = block.items.map((item, itemIndex) => {
          const itemKey = `${key}-${itemIndex}`;
          // A single paragraph renders inline so tight lists stay compact.
          const only = item.children.length === 1 && item.children[0]?.type === "paragraph" ? item.children[0] : null;
          const content = only !== null ? renderInline(only.children, itemKey) : renderBlocks(item.children, itemKey);
          return (
            <li key={itemKey} className={item.checked === null ? undefined : "md-task"}>
              {item.checked !== null && <input type="checkbox" checked={item.checked} disabled aria-label={item.checked ? "Concluído" : "Pendente"} />}
              {content}
            </li>
          );
        });
        return block.ordered
          ? <ol key={key} start={block.start ?? undefined}>{items}</ol>
          : <ul key={key}>{items}</ul>;
      }
      case "table":
        return (
          <div key={key} className="md-table-wrap" tabIndex={0} role="region" aria-label="Tabela">
            <table>
              <thead>
                <tr>{block.header.map((cell, cellIndex) => <th key={cellIndex} style={block.align[cellIndex] === null ? undefined : { textAlign: block.align[cellIndex] ?? "left" }}>{renderInline(cell, `${key}-h${cellIndex}`)}</th>)}</tr>
              </thead>
              <tbody>
                {block.rows.map((row, rowIndex) => (
                  <tr key={rowIndex}>{row.map((cell, cellIndex) => <td key={cellIndex} style={block.align[cellIndex] === null ? undefined : { textAlign: block.align[cellIndex] ?? "left" }}>{renderInline(cell, `${key}-${rowIndex}-${cellIndex}`)}</td>)}</tr>
                ))}
              </tbody>
            </table>
          </div>
        );
    }
  });
}

export function Markdown({ text }: { text: string }): JSX.Element {
  const blocks = useMemo(() => parseMarkdown(text), [text]);
  return <div className="md">{renderBlocks(blocks, "md")}</div>;
}
