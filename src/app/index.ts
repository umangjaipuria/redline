// src/app — per-document use-case commands composed from core + the format
// adapter. Each command is path-addressed; the server's session map supplies the
// path. Pure logic + file I/O, no transport.

export * from "./errors";
export * from "./document";
export * from "./comments";
export * from "./anchors";
export * from "./agent-update";
export * from "./agent-reads";
