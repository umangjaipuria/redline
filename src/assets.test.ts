import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readDocumentState } from "./state";

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("app shell loads local bundled fonts only", () => {
  const indexHtml = readProjectFile("public/index.html");
  const fontsCss = readProjectFile("public/fonts.css");
  const styleCss = readProjectFile("public/style.css");
  const publicBundle = `${indexHtml}\n${fontsCss}\n${styleCss}`;

  expect(publicBundle).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/);
  expect(indexHtml).toContain('href="/fonts.css"');
  expect(indexHtml.indexOf('href="/fonts.css"')).toBeLessThan(indexHtml.indexOf('href="/style.css"'));

  for (const family of ["Fraunces", "Hanken Grotesk", "JetBrains Mono"]) {
    expect(fontsCss).toContain(`font-family: "${family}"`);
  }
});

test("font stylesheet references existing local assets", () => {
  const fontsCss = readProjectFile("public/fonts.css");
  const urls = [...fontsCss.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1] ?? "");

  expect(urls).toHaveLength(16);
  expect(new Set(urls).size).toBe(urls.length);

  for (const url of urls) {
    expect(url.startsWith("/fonts/")).toBe(true);
    expect(url.endsWith(".woff2")).toBe(true);

    const assetPath = path.join(projectRoot, "public", url.slice(1));
    expect(fs.existsSync(assetPath)).toBe(true);
    expect(fs.statSync(assetPath).size).toBeGreaterThan(1_000);
    expect(fs.readFileSync(assetPath).subarray(0, 4).toString("ascii")).toBe("wOF2");
  }
});

test("HOWTO keeps embedded Redline anchors aligned", () => {
  const howtoPath = path.join(projectRoot, "documents", "howto.html");
  const html = readProjectFile("documents/howto.html");
  const state = readDocumentState(howtoPath);

  expect(html).toContain("<h1>Redline HOWTO</h1>");
  expect(state.threads).toHaveLength(3);

  for (const thread of state.threads) {
    const anchorId = thread.anchor.anchorId;
    expect(anchorId).toBeTruthy();

    const anchorHtml = anchoredHtml(html, anchorId ?? "");
    expect(anchorHtml).not.toBeNull();
    expect(normalizeText(stripTags(anchorHtml ?? ""))).toBe(thread.quote);
  }
});

function readProjectFile(relativePath: string): string {
  return fs.readFileSync(path.join(projectRoot, relativePath), "utf8");
}

function anchoredHtml(html: string, anchorId: string): string | null {
  const escaped = escapeRegExp(anchorId);
  const match = html.match(
    new RegExp(
      `<span\\b(?=[^>]*\\bdata-redline-anchor\\s*=\\s*(["'])${escaped}\\1)[^>]*>([\\s\\S]*?)<\\/span>`,
      "i",
    ),
  );
  return match?.[2] ?? null;
}

function stripTags(html: string): string {
  return html.replace(/<[^>]*>/g, "");
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
