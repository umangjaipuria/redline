// The format adapter contract — the extension seam. Redline never mutates
// content beyond the embedded state block, so the surface is intentionally
// minimal. `html` is the only adapter built in this rewrite; the seam is shaped
// so Markdown (next) and possibly DOCX (later) drop in without changing core.

import type { EmbeddedState } from "../core/model";

export interface RenderedView {
  html: string; // viewable, sanitized HTML for the sandboxed iframe
  title?: string;
}

export interface ReviewFormatAdapter {
  id: string;
  label: string;
  extensions: string[];
  canOpen(path: string): boolean;

  // Canonical text for anchoring: the rendered text content with markup
  // stripped, script/style/hidden content excluded, block boundaries inserted as
  // spaces, entities decoded. Both anchor resolution (server) and highlight
  // painting (client) must agree on this normalization.
  extractText(raw: string): string;

  // Viewable HTML for the iframe (HTML: sanitized passthrough).
  render(raw: string): RenderedView;

  // Parse the embedded block. Returns null when no block is present; throws when
  // a block is present but unparseable or an unknown schema version (the caller
  // surfaces a warning and refuses to overwrite it blindly).
  readState(raw: string): EmbeddedState | null;

  // Inject/replace/remove ONLY the embedded block (plus the one-line discovery
  // marker). Every other byte is preserved.
  writeState(raw: string, state: EmbeddedState): string;
}

// Thrown by readState when a block exists but cannot be trusted.
export class MalformedStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedStateError";
  }
}
