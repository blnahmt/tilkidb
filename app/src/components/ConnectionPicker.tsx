import { useCallback, useState, type CSSProperties } from "react";
import { ENGINES, type ConnConfig, type Store } from "../lib/api";
import { rank } from "../lib/fuzzy";
import { Highlight } from "./CommandPalette";
import { Icon } from "./Icons";
import { Popover } from "./Popover";

export const where = (c: ConnConfig) => (c.engine === "sqlite" ? c.file.split(/[\\/]/).pop() || c.file : `${c.host}:${c.port}${c.ssh?.enabled ? ` via ${c.ssh.host}` : ""}`);

// Title-bar picker: current connection, and a menu of saved ones grouped by tag.
export function ConnectionPicker({ store, active, status, onPick, onNew, onEdit, onImport, onDisconnect }: {
  store: Store | null;
  active: ConnConfig | null;
  status: string; // shown under the name, e.g. "PostgreSQL 16.4 · localhost:5432"
  onPick: (id: string) => void;
  onNew: () => void;
  onEdit: (c: ConnConfig) => void;
  onImport?: () => void;
  onDisconnect?: () => void; // set while a connection is open
}) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [q, setQ] = useState("");
  const close = useCallback(() => { setAnchor(null); setQ(""); }, []);
  const conns = store?.connections ?? [];
  const tags = store?.tags ?? [];
  // a connection's folder groups it; without one it falls back to its tag (the older grouping)
  const groupOf = (c: ConnConfig) => c.folder?.trim() || (tags.includes(c.tag) ? c.tag : "");
  const names = [...new Set(conns.map((c) => c.folder?.trim()).filter(Boolean) as string[])].sort((a, b) => a.localeCompare(b));
  const groups = [...names, ...tags.filter((t) => !names.includes(t)), ""]
    .map((tag) => ({ tag, items: rank(conns.filter((c) => groupOf(c) === tag), q, (c) => c.name) }))
    .filter((g) => g.items.length);
  const pick = (id: string) => { close(); onPick(id); };

  return (
    <div className="connrow">
      <button className="connsel" aria-haspopup="dialog" aria-expanded={!!anchor} title="Switch connection"
        style={{ "--envc": active?.color ?? "var(--faint)" } as CSSProperties}
        onClick={(e) => { const el = e.currentTarget; setAnchor((a) => (a ? null : el)); }}>
        <span className="dot" />
        <span className="tx"><span className="nm">{active?.name ?? "No connection"}</span><span className="sub">{status}</span></span>
        <Icon name="chevron" />
      </button>
      <button className="ibtn" title="New connection" aria-label="New connection" onClick={onNew}><Icon name="plus" /></button>
      {anchor && (
        <Popover anchor={anchor} width={340} label="Switch connection" onClose={close}>
          <input className="msearch" data-autofocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find connection…" aria-label="Find connection"
            onKeyDown={(e) => { if (e.key === "Enter" && groups[0]) pick(groups[0].items[0].item.id); }} />
          <div className="list">
            {groups.length === 0 && <p className="pad note">{conns.length ? "No matches." : "No saved connections yet."}</p>}
            {groups.map((g) => (
              <div key={g.tag}>
                <div className="grp">{g.tag || "Other"}</div>
                {g.items.map(({ item: c, match }) => (
                  <div key={c.id} className={`mi${c.id === active?.id ? " on" : ""}`} role="button" tabIndex={0} style={{ "--envc": c.color } as CSSProperties}
                    onClick={() => pick(c.id)} onKeyDown={(e) => { if (e.key === "Enter" && e.target === e.currentTarget) pick(c.id); }}>
                    <span className="dot" />
                    <span className="tx">
                      <span className="nm"><Highlight text={c.name} indices={match.indices} />{c.prod && <span className="prodtag">PROD</span>}</span>
                      <span className="sub">{ENGINES[c.engine].label} · {where(c)}</span>
                    </span>
                    {c.id === active?.id && <span className="chk" aria-label="connected">✓</span>}
                    <button className="ibtn ed" title="Edit connection" aria-label={`Edit ${c.name}`} onClick={(e) => { e.stopPropagation(); close(); onEdit(c); }}><Icon name="edit" /></button>
                  </div>
                ))}
              </div>
            ))}
          </div>
          <div className="foot">
            {onDisconnect && active && <button className="mi" onClick={() => { close(); onDisconnect(); }}>
              <span className="tx"><span className="nm">Disconnect from {active.name}</span><span className="sub">Closes the connection; its tabs come back when you reconnect</span></span>
            </button>}
            <button className="mi" onClick={() => { close(); onNew(); }}>
              <span className="tx"><span className="nm">+ New connection…</span><span className="sub">PostgreSQL · MySQL · SQLite</span></span>
            </button>
            {onImport && <button className="mi" onClick={() => { close(); onImport(); }}>
              <span className="tx"><span className="nm">Import connections…</span><span className="sub">From DBeaver, Beekeeper Studio or pgpass</span></span>
            </button>}
          </div>
        </Popover>
      )}
    </div>
  );
}
