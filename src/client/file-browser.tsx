import { useEffect, useState } from "preact/hooks";
import type { FileEntry } from "../shared";
import { api } from "./api";

// The built-in, cross-platform file browser: the server lists directories and
// the client navigates them, opening an .html/.htm file. Works on every OS and
// even headless, with no native dependency.
export function FileBrowser(props: {
  onOpen: (path: string) => void;
  onClose: () => void;
  onError: (message: string) => void;
}) {
  const [dir, setDir] = useState<string>("");
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [loading, setLoading] = useState(true);

  const load = async (target: string) => {
    setLoading(true);
    try {
      const listing = await api.listFiles(target);
      setDir(listing.dir);
      setParent(listing.parent);
      setEntries(listing.entries);
    } catch (err) {
      props.onError(err instanceof Error ? err.message : "Could not list that directory.");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div class="modal-backdrop" onClick={props.onClose}>
      <div class="modal file-browser" onClick={(e) => e.stopPropagation()}>
        <header class="modal-head">
          <h2>Open a document</h2>
          <button type="button" class="link-button" onClick={props.onClose}>Close</button>
        </header>
        <div class="file-path" title={dir}>{dir}</div>
        <ul class="file-list">
          {parent && (
            <li class="file-entry dir" onClick={() => load(parent)}>
              <span class="file-icon">↑</span> ..
            </li>
          )}
          {loading && <li class="file-loading">Loading…</li>}
          {!loading &&
            entries.map((entry) =>
              entry.isDirectory ? (
                <li class="file-entry dir" onClick={() => load(entry.path)}>
                  <span class="file-icon">📁</span> {entry.name}
                </li>
              ) : (
                <li
                  class={`file-entry file ${entry.isHtml ? "html" : "other"}`}
                  onClick={() => entry.isHtml && props.onOpen(entry.path)}
                  title={entry.isHtml ? "Open in Redline" : "Only .html/.htm files can be opened"}
                >
                  <span class="file-icon">{entry.isHtml ? "📄" : "·"}</span> {entry.name}
                </li>
              ),
            )}
          {!loading && entries.length === 0 && <li class="file-loading">Empty folder.</li>}
        </ul>
      </div>
    </div>
  );
}
