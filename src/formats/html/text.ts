// HTML → canonical anchoring text. Ported from the previous state.ts tokenizer
// (the behavior the test suite locked), minus everything to do with inline
// anchor spans, which no longer exist. The output is the text a browser would
// expose as the body's textContent under the same normalization the client uses:
// block elements contribute a boundary space, script/style contribute nothing,
// and entities are decoded so server and browser see identical characters.

interface Range {
  start: number;
  end: number;
}

const blockBoundaryHtmlElements = new Set([
  "address", "article", "aside", "blockquote", "details", "dd", "div", "dl",
  "dt", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2",
  "h3", "h4", "h5", "h6", "header", "hgroup", "hr", "li", "main", "nav",
  "ol", "p", "pre", "section", "table", "tbody", "td", "tfoot", "th",
  "thead", "tr", "ul", "br",
]);

export function extractCanonicalText(html: string): string {
  const bounds = bodyContentBounds(html);
  let text = "";
  let index = bounds.start;
  while (index < bounds.end) {
    const token = readTextToken(html, index, bounds.end);
    text += token.text;
    index = token.end;
  }
  return text;
}

function bodyContentBounds(html: string): Range {
  const bodyMatch = /<body\b/i.exec(html);
  if (!bodyMatch) {
    return { start: 0, end: html.length };
  }
  const openEnd = tagEndIndex(html, bodyMatch.index, html.length);
  const closeMatch = /<\/body\s*>/i.exec(html.slice(openEnd));
  return {
    start: openEnd,
    end: closeMatch ? openEnd + closeMatch.index : html.length,
  };
}

interface TextToken {
  end: number;
  text: string;
}

function readTextToken(html: string, index: number, limit: number): TextToken {
  if (html.startsWith("<!--", index)) {
    const end = html.indexOf("-->", index + 4);
    return { end: end === -1 ? limit : Math.min(limit, end + 3), text: "" };
  }

  if (html[index] !== "<") return readCharOrEntity(html, index, limit);

  const tagEnd = tagEndIndex(html, index, limit);
  const tagText = html.slice(index, tagEnd);
  const tagName = tagText.match(/^<\/?\s*([A-Za-z][\w:-]*)/)?.[1]?.toLowerCase();
  const isClosing = /^<\s*\//.test(tagText);

  // Skip the entire contents of script/style elements.
  if (!isClosing && (tagName === "script" || tagName === "style")) {
    const closePattern = new RegExp(`<\\/${tagName}\\s*>`, "i");
    const closeMatch = closePattern.exec(html.slice(tagEnd, limit));
    return {
      end: closeMatch ? Math.min(limit, tagEnd + closeMatch.index + closeMatch[0].length) : limit,
      text: "",
    };
  }

  if (tagName && blockBoundaryHtmlElements.has(tagName)) {
    return { end: tagEnd, text: " " };
  }

  return { end: tagEnd, text: "" };
}

function tagEndIndex(html: string, start: number, limit: number): number {
  let quote: string | null = null;
  for (let index = start + 1; index < limit; index += 1) {
    const char = html[index];
    if (quote) {
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ">") return index + 1;
  }
  return limit;
}

function readCharOrEntity(html: string, index: number, limit: number): TextToken {
  if (html[index] === "&") {
    const entityEnd = html.indexOf(";", index + 1);
    if (entityEnd !== -1 && entityEnd < limit) {
      const raw = html.slice(index, entityEnd + 1);
      return { end: entityEnd + 1, text: decodeHtmlEntity(raw) };
    }
  }
  return { end: index + 1, text: html[index] ?? "" };
}

function decodeHtmlEntity(entity: string): string {
  const body = entity.slice(1, -1);
  if (body.startsWith("#x") || body.startsWith("#X")) {
    const codePoint = Number.parseInt(body.slice(2), 16);
    return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
  }
  if (body.startsWith("#")) {
    const codePoint = Number.parseInt(body.slice(1), 10);
    return isValidCodePoint(codePoint) ? String.fromCodePoint(codePoint) : entity;
  }
  const named: Record<string, string> = {
    amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"',
    copy: "©", reg: "®", trade: "™", hellip: "…",
    mdash: "—", ndash: "–", lsquo: "‘", rsquo: "’",
    ldquo: "“", rdquo: "”", laquo: "«", raquo: "»",
    bull: "•", middot: "·", deg: "°", times: "×",
    divide: "÷",
  };
  return named[body.toLowerCase()] ?? entity;
}

function isValidCodePoint(value: number): boolean {
  return Number.isInteger(value) && value >= 0 && value <= 0x10ffff;
}
