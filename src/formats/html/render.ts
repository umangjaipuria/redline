// Render untrusted HTML for the sandboxed iframe. The iframe sandbox is the
// primary control (scripts/forms/navigation/same-origin all disabled by the
// client); this is defense in depth: strip the embedded state script, drop all
// <script>/<style on*>/event-handler vectors, and neutralize javascript: URLs so
// even a misconfigured sandbox can't execute author script.

import type { RenderedView } from "../types";

export function renderHtml(raw: string): RenderedView {
  let html = raw;

  // Remove the inert Redline state script (it should never be visible/parsed in
  // the view) and any other scripts.
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // Drop inline event handlers (on*="..."/on*='...'/on*=value).
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize javascript:/vbscript: URLs in href/src.
  html = html.replace(
    /\b(href|src)\s*=\s*("(?:\s*(?:javascript|vbscript):)[^"]*"|'(?:\s*(?:javascript|vbscript):)[^']*')/gi,
    '$1="#"',
  );
  // Strip <meta http-equiv="refresh"> to block timed navigation.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*("refresh"|'refresh'|refresh)[^>]*>/gi, "");

  return { html, title: extractTitle(raw) };
}

function extractTitle(raw: string): string | undefined {
  const match = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const title = match[1]?.replace(/\s+/g, " ").trim();
  return title || undefined;
}
