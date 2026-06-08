import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { FileEntry } from "../shared";
import { api } from "./api";
import { getRecentFolders } from "./recent";
import { ChevronRightIcon, DocIcon, FolderRowIcon, SearchIcon } from "./icons";

// The built-in, cross-platform file browser: the server lists directories and
// the client navigates them, opening an .html/.htm file. Works on every OS and
// even headless, with no native dependency. Type-to-filter narrows the listing,
// the breadcrumb jumps up the tree in one click, and recent folders are one tap
// away — so a docs folder full of non-openable files isn't a wall of dead rows.
export function FileBrowser(props: {
  onOpen: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
  // Folder to open into. Defaults to the most-recent folder, then the server's
  // home dir. Passed as the current document's directory so "Open" starts where
  // you already are.
  initialDir?: string;
}) {
  const [dir, setDir] = useState<string>("");
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState("");
  const filterRef = useRef<HTMLInputElement | null>(null);
  const recents = useMemo(() => getRecentFolders(), []);

  const load = async (target: string) => {
    setLoading(true);
    setFilter("");
    try {
      const listing = await api.listFiles(target);
      setDir(listing.dir);
      setEntries(listing.entries);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : "Could not list that directory.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load(props.initialDir ?? recents[0] ?? "");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Focus the filter once a listing lands so you can narrow it by typing at once.
  useEffect(() => {
    if (!loading) filterRef.current?.focus();
  }, [loading]);

  const crumbs = useMemo(() => buildCrumbs(dir), [dir]);
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    const list = q ? entries.filter((e) => e.name.toLowerCase().includes(q)) : entries.slice();
    // Order folders → openable files → other files, alphabetical within each.
    // Done client-side so the order is right regardless of server version.
    const rank = (e: FileEntry): number => (e.isDirectory ? 0 : e.isHtml ? 1 : 2);
    return list.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [entries, filter]);

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal file-browser" onClick={(e) => e.stopPropagation()}>
        <header class="modal-head">
          <h2>Open a document</h2>
          <button type="button" class="link-button" onClick={props.onClose}>Close</button>
        </header>

        {recents.length > 0 && (
          <div class="recent-row" aria-label="Recent folders">
            <span class="recent-label">Recent</span>
            <div class="recent-chips">
              {recents.map((folder) => (
                <button
                  key={folder}
                  type="button"
                  class={`recent-chip ${folder === dir ? "active" : ""}`}
                  title={folder}
                  onClick={() => load(folder)}
                >
                  {leaf(folder)}
                </button>
              ))}
            </div>
          </div>
        )}

        <div class="browser-toolbar">
          <nav class="crumbs" aria-label="Folder path">
            {crumbs.collapsed && (
              <>
                <button
                  type="button"
                  class="crumb"
                  title={crumbs.collapsed.path}
                  onClick={() => load(crumbs.collapsed!.path)}
                >
                  …
                </button>
                <span class="crumb-sep" aria-hidden="true">/</span>
              </>
            )}
            {crumbs.shown.map((crumb, i) => (
              <span class="crumb-wrap" key={crumb.path}>
                {i > 0 && <span class="crumb-sep" aria-hidden="true">/</span>}
                {i === crumbs.shown.length - 1 ? (
                  <span class="crumb current" title={crumb.path}>{crumb.label}</span>
                ) : (
                  <button type="button" class="crumb" title={crumb.path} onClick={() => load(crumb.path)}>
                    {crumb.label}
                  </button>
                )}
              </span>
            ))}
          </nav>
          <label class="file-filter">
            <span class="file-filter-icon" aria-hidden="true"><SearchIcon /></span>
            <input
              ref={filterRef}
              type="text"
              value={filter}
              spellcheck={false}
              placeholder="Filter…"
              onInput={(e) => setFilter((e.target as HTMLInputElement).value)}
            />
          </label>
        </div>

        <ul class="file-list">
          {loading && <li class="file-loading">Loading…</li>}
          {!loading &&
            shown.map((entry) =>
              entry.isDirectory ? (
                <li class="file-entry dir" key={entry.path} onClick={() => load(entry.path)}>
                  <span class="row-icon-wrap"><FolderRowIcon /></span>
                  <span class="file-name">{entry.name}</span>
                  <span class="row-chevron" aria-hidden="true"><ChevronRightIcon /></span>
                </li>
              ) : (
                <li
                  class={`file-entry file ${entry.isHtml ? "html" : "other"}`}
                  key={entry.path}
                  onClick={() => entry.isHtml && props.onOpen(entry.path)}
                  title={entry.isHtml ? "Open in Redline" : "Only .html/.htm files can be opened yet"}
                >
                  <span class="row-icon-wrap"><DocIcon /></span>
                  <span class="file-name">{entry.name}</span>
                </li>
              ),
            )}
          {!loading && shown.length === 0 && (
            <li class="file-loading">{filter ? "No matches." : "Empty folder."}</li>
          )}
        </ul>
      </div>
    </div>
  );
}

function leaf(path: string): string {
  return path.split("/").filter(Boolean).pop() || "/";
}

interface Crumb {
  label: string;
  path: string;
}

// Split an absolute dir into clickable segments. Deep paths collapse to a leading
// "…" (which navigates one level up from the visible tail) plus the last few
// segments, so the breadcrumb never overflows the modal.
function buildCrumbs(dir: string): { shown: Crumb[]; collapsed: Crumb | null } {
  const all: Crumb[] = [{ label: "/", path: "/" }];
  let acc = "";
  for (const part of dir.split("/").filter(Boolean)) {
    acc += `/${part}`;
    all.push({ label: part, path: acc });
  }
  const MAX = 4;
  if (all.length <= MAX) return { shown: all, collapsed: null };
  return { shown: all.slice(-MAX), collapsed: all[all.length - MAX - 1] ?? null };
}
