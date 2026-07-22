import { describe, expect, test } from "bun:test";
import { injectBase, localFragmentFromHref } from "./viewer";

// injectBase reconstructs untrusted HTML into a shell whose first parsed token is
// Redline's CSP. These lock that the CSP comes first and that no author content
// is dropped regardless of where it sat in malformed input. (location is absent
// under bun, so absoluteAssetSource falls back to the relative base — fine here.)
const BASE = "/api/docs/doc_x/assets/";

function order(html: string): { cspFirst: boolean; out: string } {
  const out = injectBase(html, BASE);
  const cspIndex = out.indexOf("Content-Security-Policy");
  // The CSP meta must precede any author resource tag.
  const firstImg = out.indexOf("<img");
  const firstLink = out.indexOf("<link");
  const firstAuthor = Math.min(...[firstImg, firstLink].filter((i) => i >= 0).concat([Infinity]));
  return { cspFirst: cspIndex >= 0 && cspIndex < firstAuthor, out };
}

describe("injectBase reconstruction", () => {
  test("CSP precedes author resource tags in a normal doc", () => {
    const { cspFirst } = order(
      `<!doctype html><html><head><title>T</title></head><body><img src="a.png"><p>hi</p></body></html>`,
    );
    expect(cspFirst).toBe(true);
  });

  test("a resource tag placed before <head> still ends up after the CSP", () => {
    const { cspFirst, out } = order(`<img src="evil.png"><html><head></head><body><p>x</p></body></html>`);
    expect(cspFirst).toBe(true);
    expect(out).toContain("evil.png"); // not dropped, just relocated after CSP
  });

  test("content between </head> and <body> is preserved", () => {
    const out = injectBase(
      `<html><head><style>.a{}</style></head>STRAY-CONTENT<body><p>main</p></body></html>`,
      BASE,
    );
    expect(out).toContain("STRAY-CONTENT");
    expect(out).toContain("main");
    expect(out).toContain(".a{}"); // author head style retained (after CSP)
  });

  test("a fragment with no head/body is treated as body content", () => {
    const out = injectBase(`<p>just a fragment</p><img src="x.png">`, BASE);
    expect(out).toContain("just a fragment");
    expect(out).toContain("x.png");
    expect(out).toContain("Content-Security-Policy");
  });

  test("author whitespace (e.g. <pre>) is preserved, not trimmed", () => {
    const out = injectBase(
      `<html><head></head><body><pre>  line1\n  line2\n</pre></body></html>`,
      BASE,
    );
    expect(out).toContain("<pre>  line1\n  line2\n</pre>");
  });

  test("CSP restricts resources to the doc-scoped asset path, not broad 'self'", () => {
    const out = injectBase(`<html><head></head><body></body></html>`, BASE);
    expect(out).toContain(`img-src ${BASE}`);
    expect(out).not.toContain("img-src 'self'");
    expect(out).toContain("script-src 'none'");
  });

  test("CSP allows external images and Google Fonts but never scripts", () => {
    const out = injectBase(`<html><head></head><body></body></html>`, BASE);
    // External images are permitted (any https host).
    expect(out).toMatch(/img-src [^;]*\bhttps:/);
    // Google Fonts: stylesheet host under style-src, file host under font-src.
    expect(out).toMatch(/style-src [^;]*https:\/\/fonts\.googleapis\.com/);
    expect(out).toMatch(/font-src [^;]*https:\/\/fonts\.gstatic\.com/);
    // Active code stays blocked.
    expect(out).toContain("script-src 'none'");
    expect(out).toContain("object-src 'none'");
  });
});

describe("localFragmentFromHref", () => {
  test("keeps raw same-document hash links local despite the injected base tag", () => {
    expect(localFragmentFromHref("#m0")).toBe("m0");
    expect(localFragmentFromHref("#")).toBe("");
    expect(localFragmentFromHref("#a%20b")).toBe("a b");
  });

  test("ignores links that are not raw same-document fragments", () => {
    expect(localFragmentFromHref(null)).toBeNull();
    expect(localFragmentFromHref("m0")).toBeNull();
    expect(localFragmentFromHref("/api/docs/doc_x/assets/#m0")).toBeNull();
    expect(localFragmentFromHref("https://example.com/#m0")).toBeNull();
  });
});
