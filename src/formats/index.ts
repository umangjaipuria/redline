// Format adapter registry. HTML is the only adapter built in this rewrite;
// unsupported formats return a clear error rather than a wrong result.

import { htmlAdapter } from "./html";
import type { ReviewFormatAdapter } from "./types";

export * from "./types";

const adapters: ReviewFormatAdapter[] = [htmlAdapter];

export function adapterForPath(path: string): ReviewFormatAdapter | undefined {
  return adapters.find((adapter) => adapter.canOpen(path));
}

export class UnsupportedFormatError extends Error {
  constructor(path: string) {
    super(`Redline cannot open this file yet: ${path}. Supported: ${supportedExtensions().join(", ")}.`);
    this.name = "UnsupportedFormatError";
  }
}

export function requireAdapterForPath(path: string): ReviewFormatAdapter {
  const adapter = adapterForPath(path);
  if (!adapter) throw new UnsupportedFormatError(path);
  return adapter;
}

export function supportedExtensions(): string[] {
  return adapters.flatMap((adapter) => adapter.extensions);
}

export { htmlAdapter };
