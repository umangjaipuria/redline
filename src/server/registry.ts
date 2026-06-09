// The server registry: one file per running server under a fixed per-user
// directory, so any process (notably the agent CLI) can discover running servers
// and the documents each one holds open — regardless of working directory. Each
// server owns and rewrites its own `<pid>.json`, deletes it on a clean exit, and
// prunes entries whose pid is no longer alive.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Deliberately NOT honoring $XDG_STATE_HOME: the point is a predictable path the
// agent skill can name literally, and that env var is virtually never set.
export const STATE_DIR = path.join(os.homedir(), ".local", "state", "redline");
export const SERVERS_DIR = path.join(STATE_DIR, "servers");

export interface RegistryDoc {
  docId: string;
  path: string;
}

export interface ServerRecord {
  url: string;
  pid: number;
  startedAt: string;
  docs: RegistryDoc[];
}

export function serverRecordPath(dir: string, pid: number): string {
  return path.join(dir, `${pid}.json`);
}

export function writeServerRecord(dir: string, record: ServerRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  pruneDeadServers(dir, record.pid);
  fs.writeFileSync(serverRecordPath(dir, record.pid), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

export function removeServerRecord(dir: string, pid: number): void {
  try {
    fs.rmSync(serverRecordPath(dir, pid), { force: true });
  } catch {
    // Best-effort; a leftover file is pruned by the next live server.
  }
}

// All live server records, freshest first (by startedAt). Prunes dead entries as
// a side effect so readers self-heal a registry full of crashed servers.
export function readServerRecords(dir = SERVERS_DIR): ServerRecord[] {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return [];
  }
  const records: ServerRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || `${pid}.json` !== entry) continue;
    if (!isProcessAlive(pid)) {
      try {
        fs.rmSync(path.join(dir, entry), { force: true });
      } catch {
        // Another process may have removed it; ignore.
      }
      continue;
    }
    try {
      const record = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as ServerRecord;
      if (record && typeof record.url === "string") {
        records.push({ ...record, docs: Array.isArray(record.docs) ? record.docs : [] });
      }
    } catch {
      // Skip a partially-written file; the owner rewrites it.
    }
  }
  return records.sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)));
}

// The server hosting `canonicalPath`, if any. When several claim it, the
// freshest (most-recently-started) wins, deterministically.
export function findServerForPath(canonicalPath: string, dir = SERVERS_DIR): ServerRecord | undefined {
  return readServerRecords(dir).find((record) =>
    record.docs.some((doc) => doc.path === canonicalPath),
  );
}

export function pruneDeadServers(dir: string, selfPid: number): void {
  let entries: string[];
  try {
    entries = fs.readdirSync(dir);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const pid = Number.parseInt(entry, 10);
    if (!Number.isInteger(pid) || `${pid}.json` !== entry || pid === selfPid) continue;
    if (isProcessAlive(pid)) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      // Already removed; ignore.
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    // Signal 0 performs error checking without delivering a signal.
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but is owned by another user.
    return (error as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
