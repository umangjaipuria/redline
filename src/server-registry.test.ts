import { afterEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  isProcessAlive,
  pruneDeadServers,
  removeServerState,
  serverStatePath,
  writeServerState,
} from "./server-registry";

const tempDirs: string[] = [];

function makeDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "redline-registry-"));
  tempDirs.push(dir);
  return dir;
}

// A pid that no process can plausibly own: spawn a process, wait for it to exit,
// then reuse its now-dead pid. Far more reliable than guessing a fixed number.
async function deadPid(): Promise<number> {
  const child = Bun.spawn(["true"]);
  await child.exited;
  return child.pid;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("isProcessAlive reports the current process as alive", () => {
  expect(isProcessAlive(process.pid)).toBe(true);
});

test("isProcessAlive reports an exited process as dead", async () => {
  expect(isProcessAlive(await deadPid())).toBe(false);
});

test("writeServerState then removeServerState round-trips the pid file", () => {
  const dir = makeDir();
  const record = {
    url: "http://127.0.0.1:7331/",
    documentPath: "/tmp/doc.html",
    pid: process.pid,
    startedAt: "2026-06-04T00:00:00.000Z",
  };

  writeServerState(dir, record);
  const file = serverStatePath(dir, process.pid);
  expect(fs.existsSync(file)).toBe(true);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual(record);

  removeServerState(dir, process.pid);
  expect(fs.existsSync(file)).toBe(false);
});

test("removeServerState is a no-op when the file is already gone", () => {
  const dir = makeDir();
  expect(() => removeServerState(dir, process.pid)).not.toThrow();
});

test("pruneDeadServers deletes dead entries but keeps live and own entries", async () => {
  const dir = makeDir();
  fs.mkdirSync(dir, { recursive: true });
  const dead = await deadPid();

  const write = (pid: number) => fs.writeFileSync(serverStatePath(dir, pid), "{}\n", "utf8");
  write(dead); // dead process -> should be pruned
  write(process.pid); // a live process that is not self -> should be kept
  const selfPid = 999_999_999; // stand-in "self" so process.pid is treated as another live server

  pruneDeadServers(dir, selfPid);

  expect(fs.existsSync(serverStatePath(dir, dead))).toBe(false);
  expect(fs.existsSync(serverStatePath(dir, process.pid))).toBe(true);
});

test("pruneDeadServers skips the self pid even when it cannot be probed", () => {
  const dir = makeDir();
  fs.mkdirSync(dir, { recursive: true });
  const selfPid = 999_999_999; // not a live process, but it is "us"
  fs.writeFileSync(serverStatePath(dir, selfPid), "{}\n", "utf8");

  pruneDeadServers(dir, selfPid);

  expect(fs.existsSync(serverStatePath(dir, selfPid))).toBe(true);
});

test("pruneDeadServers ignores non-pid and non-json files", async () => {
  const dir = makeDir();
  fs.mkdirSync(dir, { recursive: true });
  const keep = [
    path.join(dir, "notes.txt"),
    path.join(dir, "server.json"), // non-numeric stem
    path.join(dir, "12ab.json"), // numeric prefix but not a pure pid
  ];
  for (const file of keep) fs.writeFileSync(file, "{}\n", "utf8");

  pruneDeadServers(dir, process.pid);

  for (const file of keep) expect(fs.existsSync(file)).toBe(true);
});

test("pruneDeadServers tolerates a missing directory", () => {
  const dir = path.join(makeDir(), "does-not-exist");
  expect(() => pruneDeadServers(dir, process.pid)).not.toThrow();
});

test("writeServerState prunes a dead sibling while writing its own file", async () => {
  const dir = makeDir();
  fs.mkdirSync(dir, { recursive: true });
  const dead = await deadPid();
  fs.writeFileSync(serverStatePath(dir, dead), "{}\n", "utf8");

  writeServerState(dir, {
    url: "http://127.0.0.1:7332/",
    documentPath: "/tmp/doc.html",
    pid: process.pid,
    startedAt: "2026-06-04T00:00:00.000Z",
  });

  expect(fs.existsSync(serverStatePath(dir, dead))).toBe(false);
  expect(fs.existsSync(serverStatePath(dir, process.pid))).toBe(true);
});
