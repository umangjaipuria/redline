// Server-side file open: the portable base is a built-in file browser (works on
// every OS/browser, even headless), with an optional native macOS dialog as
// polish. Path resolution lives server-side — the client only ever sends/receives
// a path string. Kept behind these helpers so an implementation can be swapped
// without touching callers (the plan's FilePicker seam).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { adapterForPath } from "../formats";
import type { FileEntry } from "../shared";

export interface DirectoryListing {
  dir: string;
  parent: string | null;
  entries: FileEntry[];
}

export function expandPath(input: string): string {
  let value = (input ?? "").trim();
  if (value === "" || value === "~") {
    value = os.homedir();
  } else if (value.startsWith("~/")) {
    value = path.join(os.homedir(), value.slice(2));
  }
  return path.resolve(value);
}

export function listDirectory(rawDir: string): DirectoryListing {
  const dir = expandPath(rawDir || os.homedir());
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    throw new FileBrowseError(`Not a directory: ${dir}`);
  }

  const names = fs.readdirSync(dir);
  const entries: FileEntry[] = [];
  for (const name of names) {
    if (name.startsWith(".")) continue; // hide dotfiles for a calmer browser
    const full = path.join(dir, name);
    let isDirectory = false;
    try {
      isDirectory = fs.statSync(full).isDirectory();
    } catch {
      continue; // unreadable / broken symlink
    }
    entries.push({
      name,
      path: full,
      isDirectory,
      isHtml: !isDirectory && adapterForPath(full) !== undefined,
    });
  }

  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  const parent = path.dirname(dir);
  return { dir, parent: parent === dir ? null : parent, entries };
}

export class FileBrowseError extends Error {
  status = 400 as const;
  constructor(message: string) {
    super(message);
    this.name = "FileBrowseError";
  }
}

// Only one native dialog at a time so repeated requests can't stack Finder
// windows and orphan osascript processes.
let dialogInFlight = false;

// macOS-only native picker. Returns null on cancel. Linux/Windows native dialogs
// are flaky/often-absent, so they're intentionally not implemented here — the
// built-in browser is the cross-platform base.
export async function pickFileNativeDialog(startDir: string, signal?: AbortSignal): Promise<string | null> {
  if (process.platform !== "darwin") {
    throw new FileBrowseError("The native file picker is only available on macOS. Use the file browser instead.");
  }
  if (dialogInFlight) {
    throw new FileBrowseError("A file dialog is already open.");
  }
  dialogInFlight = true;

  const start = startDir && fs.existsSync(startDir) ? startDir : "";
  const proc = Bun.spawn(
    [
      "osascript",
      "-e", "on run argv",
      "-e", "set startDir to item 1 of argv",
      "-e", 'if startDir is not "" then',
      "-e", 'set chosen to choose file of type {"public.html"} default location (POSIX file startDir) with prompt "Open a document in Redline"',
      "-e", "else",
      "-e", 'set chosen to choose file of type {"public.html"} with prompt "Open a document in Redline"',
      "-e", "end if",
      "-e", "POSIX path of chosen",
      "-e", "end run",
      start,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );

  const onAbort = () => proc.kill();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const stderr = (await new Response(proc.stderr).text()).trim();
      if (/-128/.test(stderr) || /User canceled/i.test(stderr) || signal?.aborted) {
        return null;
      }
      throw new FileBrowseError(stderr || "The file picker could not be opened.");
    }
    const stdout = (await new Response(proc.stdout).text()).trim();
    return stdout || null;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    dialogInFlight = false;
  }
}
