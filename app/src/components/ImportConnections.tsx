import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, ENGINES, errText, type ConnConfig } from "../lib/api";
import { where } from "./ConnectionPicker";

type Found = { cfg: ConnConfig; password: string | null };
const SOURCES = [
  ["dbeaver", "DBeaver", "data-sources.json"],
  ["beekeeper", "Beekeeper Studio", "app.db"],
  ["pgpass", "pgpass", "pgpass.conf / .pgpass, with passwords"],
] as const;

// Bring connections over from another tool. Possible duplicates (same engine, host, port,
// database, user or file) start unticked.
export function ImportConnections({ existing, onClose, onImport }: { existing: ConnConfig[]; onClose: () => void; onImport: (items: Found[]) => Promise<void> }) {
  const [found, setFound] = useState<Found[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);

  const same = (a: ConnConfig, b: ConnConfig) => a.engine === b.engine && (a.engine === "sqlite" ? a.file === b.file : a.host === b.host && a.port === b.port && a.database === b.database && a.user === b.user);
  const load = async (kind: string, path: string | null) => {
    setError(null); setBusy(true);
    try {
      const got = await api.importConnections(kind, path);
      setFound(got);
      setPicked(new Set(got.map((g, i) => (existing.some((e) => same(e, g.cfg)) ? -1 : i)).filter((i) => i >= 0)));
      if (!got.length) setError("No PostgreSQL, MySQL / MariaDB or SQLite connections in that file.");
    } catch (e) { setError(errText(e)); setFound(null); } finally { setBusy(false); }
  };
  const choose = async () => {
    const p = await open({ title: "Connections file", multiple: false, filters: [{ name: "DBeaver, Beekeeper, pgpass", extensions: ["json", "db", "conf", "pgpass", "txt"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof p !== "string") return;
    const f = p.toLowerCase();
    load(f.endsWith(".json") ? "dbeaver" : f.endsWith(".db") ? "beekeeper" : "pgpass", p);
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="ic-title">
        <h3 id="ic-title">Import connections</h3>
        <p className="note">Reads the other tool's own file; nothing is changed there. DBeaver and Beekeeper keep passwords encrypted, so those connections ask for one on first connect.</p>
        <div className="frow">
          {SOURCES.map(([k, label, hint]) => <button key={k} className="btn" disabled={busy} onClick={() => load(k, null)} title={`Look in the usual place for ${hint}`}>{label}</button>)}
          <button className="btn" disabled={busy} onClick={choose}>Choose file…</button>
        </div>
        {error && <p className="testres err">{error}</p>}
        {found && found.length > 0 && (
          <table className="sttab icl">
            <thead><tr><th /><th>Name</th><th>Engine</th><th>Where</th><th>Folder</th><th /></tr></thead>
            <tbody>
              {found.map((f, i) => (
                <tr key={i}>
                  <td><input type="checkbox" checked={picked.has(i)} aria-label={`Import ${f.cfg.name}`} onChange={(e) => { const s = new Set(picked); if (e.target.checked) s.add(i); else s.delete(i); setPicked(s); }} /></td>
                  <td>{f.cfg.name}{f.cfg.prod && <span className="kb">PROD</span>}</td>
                  <td className="ty">{ENGINES[f.cfg.engine].label}</td>
                  <td className="mono">{where(f.cfg)}</td>
                  <td className="ty">{f.cfg.folder}</td>
                  <td className="ty">{existing.some((e) => same(e, f.cfg)) ? "already saved?" : f.password ? "with password" : ""}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div className="acts">
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={!found || !picked.size || busy}
            onClick={async () => { setBusy(true); try { await onImport(found!.filter((_, i) => picked.has(i))); onClose(); } catch (e) { setError(errText(e)); setBusy(false); } }}>
            Import {picked.size || ""}
          </button>
        </div>
      </div>
    </div>
  );
}
