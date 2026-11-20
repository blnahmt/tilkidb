import { useState } from "react";
import { ACTIONS, canon, clash, FIXED, keyOf, pretty } from "../lib/keymap";

// Every shortcut in one place (F1). App and editor shortcuts can be changed: click one, press the
// new keys. Esc cancels; a key another action already uses is refused.
export function ShortcutsDialog({ keys, onChange, onClose }: { keys: Record<string, string>; onChange: (k: Record<string, string>) => void; onClose: () => void }) {
  const [recording, setRecording] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const record = (e: React.KeyboardEvent) => {
    if (!recording) { if (e.key === "Escape") onClose(); return; }
    e.preventDefault(); e.stopPropagation();
    if (e.key === "Escape") { setRecording(null); setNote(null); return; }
    const k = keyOf(e.nativeEvent);
    if (!k) return; // a modifier on its own: wait for the key
    if (!e.ctrlKey && !e.metaKey && !e.altKey && !/^F\d+$/.test(e.key)) { setNote("Use Ctrl or Alt (or an F key), so typing isn't caught."); return; }
    const other = clash(keys, recording, k);
    if (other) { setNote(`${pretty(k)} is already used by "${other.label}".`); return; }
    onChange({ ...keys, [recording]: canon(k) });
    setRecording(null); setNote(null);
  };
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal wide keysdlg" role="dialog" aria-modal="true" aria-labelledby="ks-title" tabIndex={-1} onKeyDown={record} ref={(el) => el?.focus()}>
        <h3 id="ks-title">Keyboard shortcuts</h3>
        <p className={`note${note ? " err" : ""}`}>{note ?? (recording ? "Press the new keys, or Esc to cancel." : "Click a shortcut to change it.")}</p>
        <div className="keygrid">
          {(["App", "Editor"] as const).map((g) => (
            <section key={g}>
              <h4>{g}</h4>
              {ACTIONS.filter((a) => a.group === g).map((a) => (
                <div className="krow" key={a.id}>
                  <span>{a.label}</span>
                  <button className={`kbtn${recording === a.id ? " rec" : ""}`} onClick={() => { setRecording(a.id); setNote(null); }} aria-label={`Change shortcut for ${a.label}`}>
                    {recording === a.id ? "Press keys…" : <kbd>{pretty(keys[a.id])}</kbd>}
                  </button>
                  {canon(keys[a.id]) !== canon(a.key) && <button className="linkbtn" onClick={() => onChange({ ...keys, [a.id]: a.key })} title={`Back to ${pretty(a.key)}`}>reset</button>}
                </div>
              ))}
            </section>
          ))}
          <section>
            <h4>Grid, editor and tabs</h4>
            {FIXED.map((f) => <div className="krow" key={f.label}><span>{f.label}<span className="ty"> · {f.where}</span></span><kbd>{f.keys}</kbd></div>)}
          </section>
        </div>
        <div className="acts">
          <button className="btn" onClick={() => onChange(Object.fromEntries(ACTIONS.map((a) => [a.id, a.key])))}>Reset all</button>
          <span className="sp" /><button className="btn pri" onClick={onClose}>Done</button>
        </div>
      </div>
    </div>
  );
}
