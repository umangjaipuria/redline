import { describe, expect, test } from "bun:test";
import { type Inline, parseInline, safeHref } from "./markdown";

// A compact rendering of the node tree, so expectations read like the markup a
// reader would see rather than a wall of object literals.
function show(nodes: Inline[]): string {
  return nodes.map((node) => {
    switch (node.kind) {
      case "text": return node.value;
      case "code": return `<code>${node.value}</code>`;
      case "strong": return `<strong>${show(node.children)}</strong>`;
      case "em": return `<em>${show(node.children)}</em>`;
      case "del": return `<del>${show(node.children)}</del>`;
      case "link": return `<a href="${node.href}">${show(node.children)}</a>`;
    }
  }).join("");
}

const md = (src: string) => show(parseInline(src));

describe("emphasis", () => {
  test("bold, italic, and strikethrough", () => {
    expect(md("**bold**")).toBe("<strong>bold</strong>");
    expect(md("__bold__")).toBe("<strong>bold</strong>");
    expect(md("*italic*")).toBe("<em>italic</em>");
    expect(md("_italic_")).toBe("<em>italic</em>");
    expect(md("~~gone~~")).toBe("<del>gone</del>");
  });

  test("emphasis nests", () => {
    expect(md("**bold with *italic* inside**")).toBe(
      "<strong>bold with <em>italic</em> inside</strong>",
    );
    expect(md("***both***")).toBe("<strong><em>both</em></strong>");
    expect(md("~~**gone**~~")).toBe("<del><strong>gone</strong></del>");
  });

  test("a lone tilde is a tilde, not strikethrough", () => {
    expect(md("~approx~")).toBe("~approx~");
    expect(md("~/src/app")).toBe("~/src/app");
  });

  test("underscores inside a word do not italicise it", () => {
    expect(md("call snake_case_name here")).toBe("call snake_case_name here");
    expect(md("MAX_SOURCE and MAX_DEPTH")).toBe("MAX_SOURCE and MAX_DEPTH");
  });

  test("a delimiter hugging whitespace is literal", () => {
    expect(md("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(md("a * b")).toBe("a * b");
    expect(md("unclosed *emphasis")).toBe("unclosed *emphasis");
    expect(md("**")).toBe("**");
    expect(md("****")).toBe("****");
  });

  test("emphasis does not leak across a paragraph break", () => {
    expect(md("*not\n\nemphasis*")).toBe("*not\n\nemphasis*");
    expect(md("*is\nemphasis*")).toBe("<em>is\nemphasis</em>");
  });

  test("backslash escapes a delimiter", () => {
    expect(md("\\*literal\\*")).toBe("*literal*");
    expect(md("a \\_ b")).toBe("a _ b");
    expect(md("\\\\")).toBe("\\");
  });
});

describe("code spans", () => {
  test("backticks make code", () => {
    expect(md("call `render()` now")).toBe("call <code>render()</code> now");
  });

  test("a doubled fence can hold a backtick", () => {
    expect(md("``a ` b``")).toBe("<code>a ` b</code>");
    expect(md("`` ` ``")).toBe("<code>`</code>");
  });

  test("code wins over emphasis inside it", () => {
    expect(md("`a *b* c`")).toBe("<code>a *b* c</code>");
    expect(md("**bold `code` here**")).toBe("<strong>bold <code>code</code> here</strong>");
  });

  test("an emphasis closer hiding in a code span does not close it", () => {
    expect(md("*a `*` b*")).toBe("<em>a <code>*</code> b</em>");
  });

  test("an unterminated fence is literal", () => {
    expect(md("a ` b")).toBe("a ` b");
  });
});

describe("links", () => {
  test("inline link syntax", () => {
    expect(md("[docs](https://example.com)")).toBe('<a href="https://example.com">docs</a>');
    expect(md("[**bold** label](https://example.com)")).toBe(
      '<a href="https://example.com"><strong>bold</strong> label</a>',
    );
  });

  test("a bare url is linked", () => {
    expect(md("see https://example.com/a_b now")).toBe(
      'see <a href="https://example.com/a_b">https://example.com/a_b</a> now',
    );
    expect(md("http://x.test")).toBe('<a href="http://x.test">http://x.test</a>');
  });

  test("sentence punctuation is not part of a bare url", () => {
    expect(md("see https://example.com.")).toBe(
      'see <a href="https://example.com">https://example.com</a>.',
    );
    expect(md("(see https://example.com)")).toBe(
      '(see <a href="https://example.com">https://example.com</a>)',
    );
  });

  test("a bracket the url itself opened is kept", () => {
    expect(md("https://en.wikipedia.org/wiki/Ruby_(gem)")).toBe(
      '<a href="https://en.wikipedia.org/wiki/Ruby_(gem)">https://en.wikipedia.org/wiki/Ruby_(gem)</a>',
    );
  });

  test("links do not nest inside a link label", () => {
    expect(md("[https://a.test](https://b.test)")).toBe(
      '<a href="https://b.test">https://a.test</a>',
    );
  });

  test("a bare url mid-word is not a link", () => {
    expect(md("xhttps://example.com")).toBe("xhttps://example.com");
  });

  test("a scheme with no host is not a link", () => {
    expect(md("https://")).toBe("https://");
  });

  test("an unsafe or unsupported destination falls back to literal text", () => {
    expect(md("[x](javascript:alert(1))")).toBe("[x](javascript:alert(1))");
    expect(md("[x](/local/path)")).toBe("[x](/local/path)");
    expect(md("[x](data:text/html,<script>)")).toBe("[x](data:text/html,<script>)");
  });

  test("an empty label makes no link, leaving the bare url to autolink", () => {
    // An unclickable <a></a> would be worse than the typo it came from.
    expect(md("[](https://example.com)")).toBe(
      '[](<a href="https://example.com">https://example.com</a>)',
    );
  });
});

describe("safeHref", () => {
  test("passes the schemes a comment may link to", () => {
    expect(safeHref("https://example.com")).toBe("https://example.com");
    expect(safeHref("HTTP://EXAMPLE.COM")).toBe("HTTP://EXAMPLE.COM");
    expect(safeHref("mailto:a@b.test")).toBe("mailto:a@b.test");
    expect(safeHref("  https://example.com  ")).toBe("https://example.com");
  });

  test("rejects executable and unsupported schemes", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("JaVaScRiPt:alert(1)")).toBeNull();
    expect(safeHref("data:text/html;base64,PHNjcmlwdD4=")).toBeNull();
    expect(safeHref("vbscript:msgbox")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref("/relative")).toBeNull();
    expect(safeHref("")).toBeNull();
  });

  test("rejects a scheme smuggled past the check with control characters", () => {
    // A browser strips these before resolving, so the sanitiser must too.
    const nul = String.fromCharCode(0);
    const vtab = String.fromCharCode(11);
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref(`java${nul}script:alert(1)`)).toBeNull();
    expect(safeHref(`jav${vtab}ascript:alert(1)`)).toBeNull();
    expect(safeHref(" javascript:alert(1)")).toBeNull();
  });

  test("percent-encoding does not resurrect a scheme", () => {
    expect(safeHref("%6aavascript:alert(1)")).toBeNull();
  });
});

describe("plain text", () => {
  test("text with no markup survives unchanged", () => {
    expect(md("Just a normal comment.")).toBe("Just a normal comment.");
    expect(md("")).toBe("");
    expect(md("line one\nline two")).toBe("line one\nline two");
  });

  test("html in a comment body is never markup", () => {
    // Rendering is a vnode tree, so this is text at every layer; assert the
    // parser keeps it as one text node rather than a link or element.
    expect(parseInline("<script>alert(1)</script>")).toEqual([
      { kind: "text", value: "<script>alert(1)</script>" },
    ]);
  });

  test("a body past the size cap renders as plain text", () => {
    const huge = "*".repeat(30_000);
    expect(parseInline(huge)).toEqual([{ kind: "text", value: huge }]);
  });

  test("pathological delimiter runs terminate", () => {
    const start = Date.now();
    parseInline("*".repeat(2_000) + "a");
    parseInline("[".repeat(2_000));
    parseInline("`".repeat(2_000));
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
