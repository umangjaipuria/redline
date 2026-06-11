// Local development runner: keep the browser bundle fresh while the server
// watches its own TypeScript entrypoint. The production/start path still builds
// the client only when dist/ is missing; dev is intentionally more eager.

import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { buildClient } from "./client/build";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const clientDir = path.resolve(__dirname, "client");
const serverEntry = path.resolve(__dirname, "server/server.ts");

const WATCH_EXTENSIONS = new Set([".css", ".html", ".ts", ".tsx"]);
const REBUILD_DEBOUNCE_MS = 80;

let server: ChildProcess | null = null;
let watcher: fs.FSWatcher | null = null;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;
let rebuilding = false;
let rebuildAgain = false;

await rebuildClient("initial");
watchClient();
startServer(Bun.argv.slice(2));

function startServer(args: string[]): void {
  server = spawn("bun", ["--watch", serverEntry, ...args], {
    cwd: repoRoot,
    env: { ...process.env, REDLINE_NO_BROWSER: "1" },
    stdio: "inherit",
  });
  server.on("exit", (code, signal) => {
    cleanup();
    if (signal) process.kill(process.pid, signal);
    process.exit(code ?? 0);
  });
}

function watchClient(): void {
  watcher = fs.watch(clientDir, { recursive: true }, (_event, filename) => {
    if (!filename || !WATCH_EXTENSIONS.has(path.extname(String(filename)))) return;
    scheduleRebuild();
  });
}

function scheduleRebuild(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void rebuildClient("change");
  }, REBUILD_DEBOUNCE_MS);
}

async function rebuildClient(reason: "initial" | "change"): Promise<void> {
  if (rebuilding) {
    rebuildAgain = true;
    return;
  }
  rebuilding = true;
  try {
    if (reason === "change") console.log("Client change detected; rebuilding...");
    await buildClient({ minify: false });
  } catch (error) {
    console.error(error);
  } finally {
    rebuilding = false;
    if (rebuildAgain) {
      rebuildAgain = false;
      scheduleRebuild();
    }
  }
}

function cleanup(): void {
  if (rebuildTimer) clearTimeout(rebuildTimer);
  watcher?.close();
  server?.kill();
}

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
  process.once(signal, () => {
    cleanup();
    process.exit(0);
  });
}
