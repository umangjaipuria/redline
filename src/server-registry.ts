import fs from "node:fs";
import path from "node:path";

// One file per running server, named by pid, written under a fixed per-user
// directory so any process can discover running servers regardless of its
// working directory. Each server owns and rewrites its own `<pid>.json`, deletes
// it on a clean exit, and prunes entries whose pid is no longer alive.

export interface ServerStateRecord {
  url: string;
  documentPath: string;
  pid: number;
  startedAt: string;
}

export function serverStatePath(dir: string, pid: number): string {
  return path.join(dir, `${pid}.json`);
}

export function writeServerState(dir: string, record: ServerStateRecord): void {
  fs.mkdirSync(dir, { recursive: true });
  pruneDeadServers(dir, record.pid);
  fs.writeFileSync(serverStatePath(dir, record.pid), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}

// Remove a server's own file. Registered on exit so a clean shutdown leaves no
// stale entry behind; a hard kill (SIGKILL) can't run this, which is why readers
// also prune by pid liveness.
export function removeServerState(dir: string, pid: number): void {
  try {
    fs.rmSync(serverStatePath(dir, pid), { force: true });
  } catch {
    // Best-effort cleanup; a leftover file is pruned by the next live server.
  }
}

// Drop registry files whose owning process is gone (e.g. crashed or SIGKILLed
// before it could clean up). Skips `selfPid`, non-pid filenames, and a missing dir.
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
    // Reject names like "12ab.json" or "-1.json" that parseInt would accept a prefix of.
    if (!Number.isInteger(pid) || `${pid}.json` !== entry || pid === selfPid) continue;
    if (isProcessAlive(pid)) continue;
    try {
      fs.rmSync(path.join(dir, entry), { force: true });
    } catch {
      // Another process may have removed it first; ignore.
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
