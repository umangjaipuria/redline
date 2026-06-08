// Read/write the single embedded review-state block for HTML, plus the one-line
// agent discovery marker. These (and only these) are the bytes Redline writes
// into an HTML file. Ported from the previous state.ts injection logic with the
// new schema and marker text (no data-redline-anchor mention — spans are gone).

import { normalizeState, type EmbeddedState } from "../../core/model";
import { MalformedStateError } from "../types";

const STATE_SCRIPT_ID = "redline-state";
const GUIDE_META_NAME = "redline-agent-guide";
const GUIDE_META_CONTENT =
  "Redline review document. Agents: use the redline-review skill; review state is in the #redline-state block.";
const GUIDE_META_TAG = `<meta name="${GUIDE_META_NAME}" content="${GUIDE_META_CONTENT}">`;
const GUIDE_COMMENT = `<!-- redline-agent-guide: use the redline-review skill; review state is in the #redline-state block. -->`;

const STATE_SCRIPT_PATTERN =
  /<script\b(?=[^>]*\bid\s*=\s*(["'])redline-state\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>\s*/i;
const STATE_SCRIPT_REMOVAL_PATTERN =
  /[ \t]*<script\b(?=[^>]*\bid\s*=\s*(["'])redline-state\1)(?=[^>]*\btype\s*=\s*(["'])application\/json\2)[^>]*>[\s\S]*?<\/script>[ \t]*(?:\r?\n)?/gi;
const GUIDE_META_PATTERN = /<meta\b(?=[^>]*\bname\s*=\s*(["'])redline-agent-guide\1)[^>]*>/i;
const GUIDE_COMMENT_PATTERN = /<!--\s*redline-agent-guide:/i;

// Parse the embedded block. null when absent; throws MalformedStateError when a
// block is present but unparseable or an unknown schema version.
export function readStateBlock(html: string): EmbeddedState | null {
  const match = html.match(STATE_SCRIPT_PATTERN);
  if (!match?.[0]) return null;

  const jsonText = match[0]
    .replace(/^<script\b[^>]*>/i, "")
    .replace(/<\/script>\s*$/i, "");

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    throw new MalformedStateError("The embedded Redline state block is not valid JSON.");
  }
  try {
    return normalizeState(parsed);
  } catch (error) {
    throw new MalformedStateError(
      error instanceof Error ? error.message : "The embedded Redline state block is invalid.",
    );
  }
}

// Write the state block (and discovery marker), touching nothing else. Empty
// state removes the block entirely; the marker is stamped only when there is
// state to discover.
export function writeStateBlock(html: string, state: EmbeddedState): string {
  const withoutExisting = html.replace(STATE_SCRIPT_REMOVAL_PATTERN, "");
  if (state.threads.length === 0) {
    return withoutExisting;
  }

  const withMarker = ensureDiscoveryMarker(withoutExisting);
  const script = `<script type="application/json" id="${STATE_SCRIPT_ID}">${jsonForHtmlScript(state)}</script>`;

  if (/<\/head>/i.test(withMarker)) {
    return withMarker.replace(/<\/head>/i, `${script}\n  </head>`);
  }
  if (/<html\b[^>]*>/i.test(withMarker)) {
    return withMarker.replace(/<html\b[^>]*>/i, (m) => `${m}\n  <head>\n    ${script}\n  </head>`);
  }
  return `${script}\n${withMarker}`;
}

function ensureDiscoveryMarker(html: string): string {
  if (GUIDE_META_PATTERN.test(html) || GUIDE_COMMENT_PATTERN.test(html)) {
    return html;
  }
  if (/<\/head>/i.test(html)) {
    return html.replace(/<\/head>/i, `    ${GUIDE_META_TAG}\n  </head>`);
  }
  if (/<html\b[^>]*>/i.test(html)) {
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}\n  <head>\n    ${GUIDE_META_TAG}\n  </head>`);
  }
  return `${GUIDE_COMMENT}\n${html}`;
}

// JSON-escape "<" to its unicode escape so the payload can never break out of
// the host <script> element.
function jsonForHtmlScript(state: EmbeddedState): string {
  return JSON.stringify(state).replace(/</g, "\\u003c");
}
