import { useState } from "react";
import type { SavedQuery } from "../lib/api";
import { fuzzyMatch } from "../lib/fuzzy";
import { Highlight } from "./CommandPalette";
import { Icon } from "./Icons";

// Sidebar list of saved queries: filter, open (click), rename, delete (second click confirms).
export function SavedList({ saved, connId, onOpen, onRename, onDelete }: {
  saved: SavedQuery[];
  connId: string | null;
  onOpen: (q: SavedQuery) => void;
  onRename: (q: SavedQuery, name: string) => void;
  onDelete: (q: SavedQuery) => void;
}) {
  const [q, setQ] = useState("");
  const [renaming, setRenaming] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const shown = saved
    .map((s) => ({ s, hit: fuzzyMatch(q, s.name) ?? (q && s.sql.toLowerCase().includes(q.toLowerCase()) ? { score: 0, indices: [] } : null) }))
    .filter((x) => x.hit)
    .sort((a, b) => b.s.updated - a.s.updated);

  return (
    <>
      <label className="filter">
        <Icon name="search" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${saved.length} saved queries`} aria-label="Filter saved queries" />
      </label>
      <div className="hlist">
        {saved.length === 0 && <p className="empty-side">Press <kbd>Ctrl S</kbd> in a query tab to save it here.</p>}
        {saved.length > 0 && shown.length === 0 && <p className="empty-side">No saved query matches.</p>}
        {shown.map(({ s, hit }) => (
          <div key={s.id} className="hist saved" role="button" tabIndex={0} onClick={() => renaming !== s.id && onOpen(s)} onKeyDown={(e) => { if (e.key === "Enter" && renaming !== s.id) onOpen(s); }} title="Open in a new tab">
            {renaming === s.id ? (
              <input autoFocus defaultValue={s.name} aria-label="New name" onClick={(e) => e.stopPropagation()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && e.currentTarget.value.trim()) { onRename(s, e.currentTarget.value.trim()); setRenaming(null); }
                  if (e.key === "Escape") setRenaming(null);
                }}
                onBlur={() => setRenaming(null)} />
            ) : (
              <b><Highlight text={s.name} indices={hit!.indices} /></b>
            )}
            <code>{s.sql.length > 200 ? `${s.sql.slice(0, 200)}…` : s.sql}</code>
            <small>
              <span>{new Date(s.updated).toLocaleDateString(undefined, { day: "numeric", month: "short" })}</span>
              {connId && s.connId && s.connId !== connId && <span>other connection</span>}
              <span className="sp" />
              <button className="linkbtn" onClick={(e) => { e.stopPropagation(); setRenaming(s.id); }}>Rename</button>
              <button className={`linkbtn${confirm === s.id ? " err" : ""}`} onBlur={() => setConfirm(null)}
                onClick={(e) => { e.stopPropagation(); if (confirm === s.id) { onDelete(s); setConfirm(null); } else setConfirm(s.id); }}>
                {confirm === s.id ? "Click again to delete" : "Delete"}
              </button>
            </small>
          </div>
        ))}
      </div>
    </>
  );
}
