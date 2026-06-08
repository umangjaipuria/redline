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
  html = html.replace(
    /[ \t]*<script\b(?=[^>]*\bid\s*=\s*(["'])redline-state\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>[ \t]*(?:\r?\n)?/gi,
    "",
  );
  html = html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
  // The agent discovery marker is Redline-owned metadata, not author content.
  // Keeping it out of the iframe prevents state-only writes from forcing a
  // document reload just because the marker was added or removed.
  html = html.replace(/[ \t]*<meta\b(?=[^>]*\bname\s*=\s*(["'])redline-agent-guide\1)[^>]*>[ \t]*(?:\r?\n)?/gi, "");
  html = html.replace(/[ \t]*<!--\s*redline-agent-guide:[\s\S]*?-->\s*/gi, "");
  // Drop inline event handlers (on*="..."/on*='...'/on*=value).
  html = html.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
  // Neutralize javascript:/vbscript: URLs in href/src.
  html = html.replace(
    /\b(href|src)\s*=\s*("(?:\s*(?:javascript|vbscript):)[^"]*"|'(?:\s*(?:javascript|vbscript):)[^']*')/gi,
    '$1="#"',
  );
  // Strip <meta http-equiv="refresh"> to block timed navigation.
  html = html.replace(/<meta\b[^>]*http-equiv\s*=\s*("refresh"|'refresh'|refresh)[^>]*>/gi, "");
  // Remove active/embedding elements outright (defense in depth beside the
  // iframe sandbox + CSP): nested frames, plugins, and any author <base> that
  // would fight the asset base we inject at view time.
  html = html.replace(/<(iframe|object|embed|frame|frameset)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  html = html.replace(/<(iframe|object|embed|frame|frameset|base)\b[^>]*\/?>/gi, "");

  return { html, title: extractTitle(raw) };
}

function extractTitle(raw: string): string | undefined {
  const match = raw.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) return undefined;
  const title = match[1]?.replace(/\s+/g, " ").trim();
  return title || undefined;
}
