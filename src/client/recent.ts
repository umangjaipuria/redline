// Recently-opened folders, kept in localStorage. Powers the file browser's
// "Recent" chips and its cold-start default directory (when no document is open
// to anchor the browser to its own folder). Best-effort: any storage failure
// degrades to "no recents", never an error.

const KEY = "redline.recentFolders";
const MAX = 5;

export function getRecentFolders(): string[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Normalize on read too (not only on write): a stale or hand-edited value
    // shouldn't surface duplicate or unbounded chips.
    const strings = parsed.filter((x): x is string => typeof x === "string" && x.length > 0);
    return [...new Set(strings)].slice(0, MAX);
  } catch {
    return [];
  }
}

// Record a folder as most-recent, de-duplicated and capped. Called when a file
// is successfully opened, with that file's containing directory.
export function pushRecentFolder(folder: string): void {
  if (!folder) return;
  try {
    const next = [folder, ...getRecentFolders().filter((f) => f !== folder)].slice(0, MAX);
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable (private mode, quota) — recents are a convenience only.
  }
}
