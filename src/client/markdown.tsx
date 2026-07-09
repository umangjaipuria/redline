import type { ComponentChildren } from "preact";

// Inline-only markdown for comment bodies. A comment is a margin note, so every
// construct here renders inside the line it began on: there is no heading, list,
// blockquote, table, or fenced code, because a comment that needs those has
// outgrown the rail. Bodies are stored as raw markdown and parsed at render.
//
// The output is a vnode tree, never an HTML string. Comment bodies come from
// users and agents alike, so there is deliberately no innerHTML path to escape
// wrong. Link destinations are still scheme-checked: an href is executable.

export type Inline =
  | { kind: "text"; value: string }
  | { kind: "code"; value: string }
  | { kind: "strong"; children: Inline[] }
  | { kind: "em"; children: Inline[] }
  | { kind: "del"; children: Inline[] }
  | { kind: "link"; href: string; children: Inline[] };

const ESCAPABLE = "\\`*_~[]()";
const MAX_DEPTH = 6;
// Emphasis scanning is quadratic against pathological delimiter runs. Comments
// are never this long; an agent writing a novel gets plain text instead of a
// hung tab.
const MAX_SOURCE = 20_000;

export function parseInline(src: string): Inline[] {
  if (!src) return [];
  if (src.length > MAX_SOURCE) return [{ kind: "text", value: src }];
  return parse(src, 0, false);
}

// Browsers ignore C0 controls and spaces while reading a scheme, so strip them
// before testing: `java\tscript:` is javascript: by the time it reaches an href.
const SAFE_SCHEME = /^(?:https?:|mailto:)/;

export function safeHref(raw: string): string | null {
  const href = raw.trim();
  const scheme = [...href].filter((c) => c.charCodeAt(0) > 0x20).join("").toLowerCase();
  return SAFE_SCHEME.test(scheme) ? href : null;
}

function parse(src: string, depth: number, inLink: boolean): Inline[] {
  const out: Inline[] = [];
  let buf = "";
  const flush = () => {
    if (buf) out.push({ kind: "text", value: buf });
    buf = "";
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "\\" && ESCAPABLE.includes(src[i + 1] ?? "")) {
      buf += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const code = matchCode(src, i);
      if (code) {
        flush();
        out.push({ kind: "code", value: code.value });
        i = code.end;
        continue;
      }
    }

    if (!inLink && ch === "[") {
      const link = matchLink(src, i);
      if (link) {
        flush();
        const children = depth < MAX_DEPTH
          ? parse(link.label, depth + 1, true)
          : [{ kind: "text", value: link.label } as Inline];
        out.push({ kind: "link", href: link.href, children });
        i = link.end;
        continue;
      }
    }

    if (!inLink && (ch === "h" || ch === "H")) {
      const url = matchAutolink(src, i);
      if (url) {
        flush();
        out.push({ kind: "link", href: url.href, children: [{ kind: "text", value: url.text }] });
        i = url.end;
        continue;
      }
    }

    if (ch === "*" || ch === "_" || ch === "~") {
      const emphasis = matchEmphasis(src, i, depth, inLink);
      if (emphasis) {
        flush();
        out.push(emphasis.node);
        i = emphasis.end;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return out;
}

// `code`, or ``code with a ` in it``.
function matchCode(src: string, start: number): { value: string; end: number } | null {
  let open = start;
  while (src[open] === "`") open++;
  const fence = open - start;

  let i = open;
  while (i < src.length) {
    if (src.startsWith("\n\n", i)) return null;
    if (src[i] !== "`") {
      i++;
      continue;
    }
    let j = i;
    while (src[j] === "`") j++;
    if (j - i !== fence) {
      i = j;
      continue;
    }
    let value = src.slice(open, i);
    // One space either side is padding, so that `` ` `` can hold a backtick.
    if (value.length >= 2 && value.startsWith(" ") && value.endsWith(" ") && value.trim() !== "") {
      value = value.slice(1, -1);
    }
    return value ? { value, end: j } : null;
  }
  return null;
}

// [label](destination), where the label may nest brackets and the destination
// may nest balanced parens or be wrapped in <>.
function matchLink(src: string, start: number): { label: string; href: string; end: number } | null {
  let brackets = 0;
  let i = start;
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "\\") {
      i++;
    } else if (ch === "`") {
      const code = matchCode(src, i);
      if (code) i = code.end - 1;
    } else if (ch === "[") {
      brackets++;
    } else if (ch === "]") {
      brackets--;
      if (brackets === 0) break;
    } else if (src.startsWith("\n\n", i)) {
      return null;
    }
  }
  if (brackets !== 0 || src[i + 1] !== "(") return null;
  const label = src.slice(start + 1, i);

  let parens = 1;
  let dest = "";
  let j = i + 2;
  for (; j < src.length; j++) {
    const ch = src[j]!;
    if (ch === "\\" && j + 1 < src.length) {
      dest += src[++j];
      continue;
    }
    if (ch === "\n") return null;
    if (ch === "(") parens++;
    else if (ch === ")" && --parens === 0) break;
    dest += ch;
  }
  if (parens !== 0 || j >= src.length) return null;

  let raw = dest.trim();
  if (raw.startsWith("<") && raw.endsWith(">")) raw = raw.slice(1, -1);
  else raw = raw.split(/\s+/)[0] ?? ""; // a trailing "title" is dropped, not rendered

  const href = safeHref(raw);
  if (!href || !label.trim()) return null;
  return { label, href, end: j + 1 };
}

const URL_TAIL = ".,;:!?'\"*";

// A bare https:// URL, since reviewers paste links far more often than they
// write link syntax around them.
function matchAutolink(src: string, start: number): { href: string; text: string; end: number } | null {
  if (isWord(src[start - 1])) return null;
  const match = /^https?:\/\/[^\s<>]+/i.exec(src.slice(start));
  if (!match) return null;

  const text = trimUrlTail(match[0]);
  if (!/^https?:\/\/[^\s/?#]+/i.test(text)) return null; // a scheme with no host is not a link
  const href = safeHref(text);
  return href ? { href, text, end: start + text.length } : null;
}

// Sentence punctuation that trails a pasted URL belongs to the sentence, and a
// closing bracket belongs to the URL only if the URL opened it.
function trimUrlTail(url: string): string {
  let end = url.length;
  while (end > 0) {
    const ch = url[end - 1]!;
    if (URL_TAIL.includes(ch)) end--;
    else if ((ch === ")" || ch === "]" || ch === "}") && !opensWithin(url.slice(0, end), ch)) end--;
    else break;
  }
  return url.slice(0, end);
}

function opensWithin(text: string, closer: string): boolean {
  const opener = closer === ")" ? "(" : closer === "]" ? "[" : "{";
  let open = 0;
  for (const ch of text) {
    if (ch === opener) open++;
    else if (ch === closer) open--;
  }
  return open >= 0;
}

function matchEmphasis(
  src: string,
  start: number,
  depth: number,
  inLink: boolean,
): { node: Inline; end: number } | null {
  if (depth >= MAX_DEPTH) return null;
  const ch = src[start]!;
  let run = 0;
  while (src[start + run] === ch) run++;

  // ~ marks strikethrough only when doubled; a lone ~ is a tilde.
  const widths = ch === "~" ? (run >= 2 ? [2] : []) : run >= 2 ? [2, 1] : [1];

  for (const width of widths) {
    // `snake_case` is an identifier, not emphasis; `2 * 3` is arithmetic.
    if (ch === "_" && isWord(src[start - 1])) continue;
    const from = start + width;
    const next = src[from];
    if (!next || /\s/.test(next)) continue;

    const close = findCloser(src, from, ch, width);
    if (close === -1) continue;

    // `***x***` opens at the run's head and closes at its tail, so the closer may
    // legitimately sit inside a run. What it may not do is leave nothing but more
    // delimiters between them: `****` is four asterisks, not an emphasised `**`.
    const inner = src.slice(from, close);
    if (![...inner].some((c) => c !== ch)) continue;

    const children = parse(inner, depth + 1, inLink);
    const node: Inline = ch === "~"
      ? { kind: "del", children }
      : width === 2
      ? { kind: "strong", children }
      : { kind: "em", children };
    return { node, end: close + width };
  }
  return null;
}

function findCloser(src: string, from: number, ch: string, width: number): number {
  let i = from;
  while (i < src.length) {
    if (src.startsWith("\n\n", i)) return -1; // emphasis does not span a paragraph break
    const c = src[i]!;
    if (c === "\\") {
      i += 2;
      continue;
    }
    if (c === "`") {
      const code = matchCode(src, i);
      if (code) {
        i = code.end;
        continue;
      }
    }
    if (c !== ch) {
      i++;
      continue;
    }

    let j = i;
    while (src[j] === ch) j++;
    // Right-align inside the run so ***both*** closes the inner emphasis first.
    const closer = i + (j - i) - width;
    const before = src[i - 1];
    if (
      j - i >= width &&
      closer > from &&
      before !== undefined &&
      !/\s/.test(before) &&
      (ch !== "_" || !isWord(src[j]))
    ) {
      return closer;
    }
    i = j;
  }
  return -1;
}

function isWord(ch: string | undefined): boolean {
  return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}

export function MarkdownText(props: { text: string }) {
  return <>{toVNodes(parseInline(props.text))}</>;
}

function toVNodes(nodes: Inline[]): ComponentChildren {
  return nodes.map((node, i) => {
    switch (node.kind) {
      case "text":
        return node.value;
      case "code":
        return <code key={i}>{node.value}</code>;
      case "strong":
        return <strong key={i}>{toVNodes(node.children)}</strong>;
      case "em":
        return <em key={i}>{toVNodes(node.children)}</em>;
      case "del":
        return <del key={i}>{toVNodes(node.children)}</del>;
      case "link":
        return (
          <a
            key={i}
            href={node.href}
            target="_blank"
            rel="noopener noreferrer nofollow"
            onClick={(e) => e.stopPropagation()}
          >
            {toVNodes(node.children)}
          </a>
        );
    }
  });
}
