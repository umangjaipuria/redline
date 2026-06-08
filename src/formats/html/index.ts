import type { EmbeddedState } from "../../core/model";
import type { ReviewFormatAdapter, RenderedView } from "../types";
import { renderHtml } from "./render";
import { readStateBlock, writeStateBlock } from "./state-block";
import { extractCanonicalText } from "./text";

// The HTML review adapter — the first and (in this rewrite) only adapter. Knows
// how to extract anchoring text, render for viewing, and read/write only the
// embedded state block.
export const htmlAdapter: ReviewFormatAdapter = {
  id: "html",
  label: "HTML",
  extensions: [".html", ".htm"],

  canOpen(path: string): boolean {
    return /\.html?$/i.test(path);
  },

  extractText(raw: string): string {
    return extractCanonicalText(raw);
  },

  render(raw: string): RenderedView {
    return renderHtml(raw);
  },

  readState(raw: string): EmbeddedState | null {
    return readStateBlock(raw);
  },

  writeState(raw: string, state: EmbeddedState): string {
    return writeStateBlock(raw, state);
  },
};
