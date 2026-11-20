import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, COLORS, desktop, ENGINES, errText, newConnection, newSsh, type ConnConfig, type Engine, type SshAuth, type SshConfig, type SslMode } from "../lib/api";
import { parseConnUrl, unknownHostKey } from "../lib/connUrl";

export interface TagOps {
  tags: string[];
  uses: (tag: string) => number;
  add: (tag: string) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  remove: (tag: string) => Promise<void>;
}

// New / edit connection. Saving writes metadata to connections.json and the password to the OS keychain.
export function ConnectionDialog({ initial, tagOps, folders = [], onClose, onSave, onDelete }: {
  initial: ConnConfig | null;
  tagOps: TagOps;
  folders?: string[]; // existing folder names, offered as suggestions
  onClose: () => void;
  onSave: (cfg: ConnConfig, password: string | null, sshSecret: string | null, connect: boolean) => Promise<void>;
  onDelete: (c: ConnConfig) => Promise<void>;
}) {
  const isNew = !initial;
  const [d, setD] = useState<ConnConfig>(() => initial ? { ...initial, ssh: { ...newSsh(), ...initial.ssh } } : { ...newConnection(), tag: tagOps.tags[0] ?? "" });
  const [pw, setPw] = useState("");
  const [pwTouched, setPwTouched] = useState(false);
  const [sshSecret, setSshSecret] = useState("");
  const [sshTouched, setSshTouched] = useState(false);
  const [hostPrompt, setHostPrompt] = useState<{ host: string; fingerprint: string } | null>(null);
  const [tab, setTab] = useState<"general" | "ssh" | "advanced">("general");
  const [tagMode, setTagMode] = useState<"pick" | "new" | "edit">("pick");
  const [newTag, setNewTag] = useState("");
  const [url, setUrl] = useState("");
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const set = <K extends keyof ConnConfig>(k: K, v: ConnConfig[K]) => setD((x) => ({ ...x, [k]: v }));
  const setSsh = <K extends keyof SshConfig>(k: K, v: SshConfig[K]) => setD((x) => ({ ...x, ssh: { ...x.ssh, [k]: v } }));
  const useSsh = d.ssh.enabled && d.engine !== "sqlite";
  const fail = (text: string) => setResult({ ok: false, text });

  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === "Escape" && !busy) onClose(); };
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [busy, onClose]);

  const problem = (): string | null => {
    if (!d.name.trim()) return "Give the connection a name.";
    if (d.engine === "sqlite") return d.file.trim() ? null : "Choose a database file.";
    if (!d.host.trim()) return "Host is required.";
    if (!(d.port > 0 && d.port < 65536)) return "Port must be between 1 and 65535.";
    if (useSsh && (!d.ssh.host.trim() || !d.ssh.user.trim())) return "SSH host and SSH user are required for the tunnel.";
    if (useSsh && !(d.ssh.port > 0 && d.ssh.port < 65536)) return "SSH port must be between 1 and 65535.";
    if (useSsh && d.ssh.auth === "key" && !d.ssh.keyFile.trim()) return "Choose the private key file for SSH.";
    return null;
  };
  // null = use the secret already in the keychain (editing without retyping it)
  const password = pwTouched ? pw : isNew ? "" : null;
  const sshArg = sshTouched ? sshSecret : isNew ? "" : null;

  const setEngine = (engine: Engine) => setD((x) => ({
    ...x, engine, port: ENGINES[engine].port || x.port,
    user: engine === "mysql" && x.user === "postgres" ? "root" : engine === "postgres" && x.user === "root" ? "postgres" : x.user,
  }));

  const applyUrl = (text: string) => {
    if (!text.trim()) return;
    const f = parseConnUrl(text);
    if (!f) { fail("Not a connection URL. Use postgres://, mysql:// or sqlite://"); return; }
    const { password: p, ...fields } = f;
    setD((x) => ({ ...x, ...fields, name: x.name || fields.database || fields.host || (fields.file ?? "").split(/[\\/]/).pop() || "" }));
    if (p !== undefined) { setPw(p); setPwTouched(true); }
    setResult({ ok: true, text: `Filled from the URL${p !== undefined ? ". The password goes to the OS keychain when you save." : "."}` });
  };

  const browse = async () => {
    const f = await open({ multiple: false, directory: false, filters: [{ name: "SQLite database", extensions: ["sqlite", "sqlite3", "db", "db3"] }, { name: "All files", extensions: ["*"] }] });
    if (typeof f === "string") {
      setD((x) => ({ ...x, file: f, name: x.name || f.split(/[\\/]/).pop() || "" }));
    }
  };

  const browseKey = async () => {
    const f = await open({ multiple: false, directory: false, title: "Choose your SSH private key" });
    if (typeof f === "string") setSsh("keyFile", f);
  };

  const test = async (trustHost = false) => {
    const p = problem();
    if (p) return fail(p);
    setBusy(true);
    setHostPrompt(null);
    setResult({ ok: true, text: useSsh ? "Opening the SSH tunnel…" : "Connecting…" });
    try {
      setResult({ ok: true, text: `Connected: ${await api.testConnection(d, password, sshArg, trustHost)}` });
    } catch (e) {
      const msg = errText(e);
      const hk = unknownHostKey(msg);
      if (hk) { setHostPrompt(hk); setResult(null); } else fail(msg);
    } finally {
      setBusy(false);
    }
  };

  const save = async (connect: boolean) => {
    const p = problem();
    if (p) { setTab(/SSH/.test(p) ? "ssh" : "general"); return fail(p); }
    setBusy(true);
    try {
      await onSave({ ...d, name: d.name.trim() }, pwTouched ? pw : null, sshTouched ? sshSecret : null, connect);
    } catch (e) {
      fail(errText(e));
      setBusy(false);
    }
  };

  const addTag = async () => {
    const t = newTag.trim();
    if (!t) return fail("Type a tag name first.");
    const existing = tagOps.tags.find((x) => x.toLowerCase() === t.toLowerCase());
    try {
      if (!existing) await tagOps.add(t);
      set("tag", existing ?? t);
      setNewTag("");
      setTagMode("pick");
    } catch (e) { fail(errText(e)); }
  };

  const renameTag = async (from: string, to: string, input: HTMLInputElement) => {
    to = to.trim();
    if (to === from) return;
    if (!to || tagOps.tags.some((x) => x !== from && x.toLowerCase() === to.toLowerCase())) {
      input.value = from;
      return fail(to ? `A tag named "${to}" already exists.` : "A tag needs a name.");
    }
    try {
      await tagOps.rename(from, to);
      if (d.tag === from) set("tag", to);
    } catch (e) { fail(errText(e)); input.value = from; }
  };

  const removeTag = async (t: string) => {
    try {
      await tagOps.remove(t);
      if (d.tag === t) set("tag", "");
    } catch (e) { fail(errText(e)); }
  };

  const text = (k: "name" | "host" | "database" | "user" | "file", label: string, cls: string, placeholder = "") => (
    <div className={`f ${cls}`}>
      <label htmlFor={`cf-${k}`}>{label}</label>
      <input id={`cf-${k}`} value={d[k]} placeholder={placeholder} autoComplete="off" spellCheck={false} onChange={(e) => set(k, e.target.value)} />
    </div>
  );

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}>
      <div className="modal wide" role="dialog" aria-modal="true" aria-labelledby="cd-title" style={{ borderTop: `3px ${d.prod ? "dashed" : "solid"} ${d.color}` }}>
        <h3 id="cd-title">{isNew ? "New connection" : `Edit ${initial.name}`}</h3>
        <div className="mtabs" role="tablist">
          {([["general", "General"], ["ssh", `SSH tunnel${useSsh ? " ●" : ""}`], ["advanced", "Advanced"]] as const).map(([t, label]) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? "on" : ""} onClick={() => setTab(t)}>{label}</button>
          ))}
        </div>

        {tab === "ssh" ? (
          d.engine === "sqlite" ? <p className="note">SQLite opens a local file, so there is no SSH tunnel.</p> : (
            <div className="fg">
              <div className="f">
                <label className="check"><input type="checkbox" checked={d.ssh.enabled} onChange={(e) => setSsh("enabled", e.target.checked)} /> Connect through an SSH tunnel</label>
              </div>
              {d.ssh.enabled && (
                <>
                  <div className="f s4"><label htmlFor="cf-sshhost">SSH host</label><input id="cf-sshhost" value={d.ssh.host} placeholder="bastion.example.com" spellCheck={false} onChange={(e) => setSsh("host", e.target.value)} /></div>
                  <div className="f s2"><label htmlFor="cf-sshport">SSH port</label><input id="cf-sshport" type="number" min={1} max={65535} value={d.ssh.port || ""} onChange={(e) => setSsh("port", Number(e.target.value))} /></div>
                  <div className="f s3"><label htmlFor="cf-sshuser">SSH user</label><input id="cf-sshuser" value={d.ssh.user} placeholder="deploy" spellCheck={false} onChange={(e) => setSsh("user", e.target.value)} /></div>
                  <div className="f s3">
                    <label>Authentication</label>
                    <div className="seg">
                      {([["key", "Private key"], ["password", "Password"], ["agent", "SSH agent"]] as [SshAuth, string][]).map(([a, label]) => (
                        <button key={a} className={d.ssh.auth === a ? "on" : ""} aria-pressed={d.ssh.auth === a} onClick={() => setSsh("auth", a)}>{label}</button>
                      ))}
                    </div>
                  </div>
                  {d.ssh.auth === "key" && (
                    <>
                      <div className="f s4"><label htmlFor="cf-sshkey">Private key file</label><input id="cf-sshkey" value={d.ssh.keyFile} placeholder="~/.ssh/id_ed25519" spellCheck={false} onChange={(e) => setSsh("keyFile", e.target.value)} /></div>
                      <div className="f s2"><label>&nbsp;</label><button className="btn" onClick={browseKey} disabled={!desktop}>Browse…</button></div>
                    </>
                  )}
                  {d.ssh.auth !== "agent" ? (
                    <div className="f">
                      <label htmlFor="cf-sshsecret">{d.ssh.auth === "key" ? "Key passphrase (leave empty if the key has none)" : "SSH password"}</label>
                      <input id="cf-sshsecret" type="password" value={sshSecret} autoComplete="new-password"
                        placeholder={isNew ? "Kept in the OS keychain" : "Saved in the keychain — type to change"}
                        onChange={(e) => { setSshSecret(e.target.value); setSshTouched(true); }} />
                    </div>
                  ) : (
                    <p className="note f">Uses the Windows OpenSSH Authentication Agent or Pageant (ssh-agent on Linux). Keys stay in the agent.</p>
                  )}
                  <p className="note f">
                    Tilki DB opens a local port and forwards it through <b>{d.ssh.host || "the SSH host"}</b> to <b>{d.host || "host"}:{d.port}</b>.
                    The database host is resolved on the SSH server, so <code>localhost</code> there means the SSH server itself. Host keys are checked against ~/.ssh/known_hosts.
                  </p>
                </>
              )}
              {!d.ssh.enabled && <p className="note f">Use this when the database is only reachable through a bastion (jump) server.</p>}
            </div>
          )
        ) : tab === "general" ? (
          <div className="fg">
            <div className="f">
              <label htmlFor="cf-url">Paste a connection URL to fill the form</label>
              <input id="cf-url" value={url} placeholder="postgres://user@host:5432/dbname" autoComplete="off" spellCheck={false}
                onChange={(e) => setUrl(e.target.value)} onBlur={() => applyUrl(url)}
                onPaste={(e) => { const t = e.clipboardData.getData("text"); setTimeout(() => applyUrl(t)); }}
                onKeyDown={(e) => { if (e.key === "Enter") applyUrl(url); }} />
            </div>
            <div className="f">
              <label>Database type</label>
              <div className="seg">
                {(Object.keys(ENGINES) as Engine[]).map((k) => (
                  <button key={k} className={d.engine === k ? "on" : ""} aria-pressed={d.engine === k} onClick={() => setEngine(k)}>{ENGINES[k].label}</button>
                ))}
              </div>
            </div>
            {text("name", "Name", "s4", "e.g. shop_local")}
            <div className="f s2">
              <div className="lblrow"><label htmlFor="cf-tag">Tag</label><button className="linkbtn" onClick={() => setTagMode(tagMode === "edit" ? "pick" : "edit")}>{tagMode === "edit" ? "Done" : "Edit tags"}</button></div>
              <select id="cf-tag" value={d.tag} onChange={(e) => { if (e.target.value === "\u0000new") setTagMode("new"); else { set("tag", e.target.value); setTagMode("pick"); } }}>
                <option value="">No tag</option>
                {tagOps.tags.map((t) => <option key={t} value={t}>{t}</option>)}
                <option value={"\u0000new"}>+ New tag…</option>
              </select>
            </div>
            {tagMode === "new" && (
              <div className="f">
                <div className="frow">
                  <input autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") addTag(); }}
                    placeholder="e.g. Customer A, Analytics, Read replica" aria-label="New tag name" style={{ flex: 1 }} />
                  <button className="btn" onClick={addTag}>Add tag</button>
                  <button className="btn" onClick={() => setTagMode("pick")}>Cancel</button>
                </div>
              </div>
            )}
            {tagMode === "edit" && (
              <div className="f">
                <div className="tagman">
                  {tagOps.tags.length === 0 && <p className="note">No tags yet.</p>}
                  {tagOps.tags.map((t) => (
                    <div className="frow" key={t}>
                      <input defaultValue={t} aria-label={`Rename tag ${t}`} style={{ flex: 1 }}
                        onBlur={(e) => renameTag(t, e.target.value, e.target)} onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }} />
                      <span className="ty">{tagOps.uses(t)} conn.</span>
                      <button className="ibtn" title="Delete tag" aria-label={`Delete tag ${t}`} onClick={() => removeTag(t)}>×</button>
                    </div>
                  ))}
                  <p className="note">Renaming or deleting a tag updates every connection that uses it.</p>
                </div>
              </div>
            )}
            <div className="f">
              <label>Color</label>
              <div className="swatches">
                {COLORS.map((c) => (
                  <button key={c} className={`swc${d.color === c ? " on" : ""}`} style={{ background: c }} aria-label={`Color ${c}`} aria-pressed={d.color === c} onClick={() => set("color", c)} />
                ))}
                <label className={`swc custom${COLORS.includes(d.color) ? "" : " on"}`} title="Custom color" style={COLORS.includes(d.color) ? undefined : { background: d.color }}>
                  <input type="color" value={d.color} onChange={(e) => set("color", e.target.value)} aria-label="Custom color" />
                </label>
                <span className="ty">Shown as the band under the title bar and the dot next to the name.</span>
              </div>
            </div>
            <div className="f">
              <label className="check"><input type="checkbox" checked={d.prod} onChange={(e) => setD((x) => ({ ...x, prod: e.target.checked, readOnly: e.target.checked || x.readOnly }))} />
                Production: read-only by default, striped warning band, confirm risky statements</label>
            </div>
            {d.engine === "sqlite" ? (
              <>
                {text("file", "Database file", "s4", "C:\\data\\app.sqlite")}
                <div className="f s2"><label>&nbsp;</label><button className="btn" onClick={browse} disabled={!desktop} title={desktop ? "" : "Needs the desktop app"}>Browse…</button></div>
              </>
            ) : (
              <>
                {text("host", "Host", "s4", "localhost")}
                <div className="f s2"><label htmlFor="cf-port">Port</label><input id="cf-port" type="number" min={1} max={65535} value={d.port || ""} onChange={(e) => set("port", Number(e.target.value))} /></div>
                {text("database", "Database", "s3", d.engine === "postgres" ? "postgres" : "optional")}
                <div className="f s3">
                  <label htmlFor="cf-ssl">SSL</label>
                  <select id="cf-ssl" value={d.ssl} onChange={(e) => set("ssl", e.target.value as SslMode)}>
                    <option value="disable">Off</option><option value="prefer">Prefer</option><option value="require">Require</option><option value="verify-full">Verify certificate</option>
                  </select>
                </div>
                {text("user", "User", "s3")}
                <div className="f s3">
                  <label htmlFor="cf-pw">Password</label>
                  <input id="cf-pw" type="password" value={pw} autoComplete="new-password" placeholder={isNew ? "Kept in the OS keychain" : "Saved in the keychain — type to change"}
                    onChange={(e) => { setPw(e.target.value); setPwTouched(true); }} />
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="fg">
            <div className="f">
              <label className="check"><input type="checkbox" checked={d.readOnly} onChange={(e) => set("readOnly", e.target.checked)} /> Read-only: block INSERT, UPDATE, DELETE and schema changes</label>
            </div>
            <div className="f">
              <label htmlFor="cf-folder">Folder</label>
              <input id="cf-folder" list="cf-folders" value={d.folder} placeholder="Groups connections in the picker, e.g. Customer A" onChange={(e) => set("folder", e.target.value)} />
              <datalist id="cf-folders">{folders.map((f) => <option key={f} value={f} />)}</datalist>
            </div>
            {d.engine !== "sqlite" && ([["sslCa", "CA certificate", "Verifies the server (needed for most cloud databases with Verify-full)"], ["sslCert", "Client certificate", "Only if the server asks for one"], ["sslKey", "Client key", "Goes with the client certificate"]] as const).map(([k, label, hint]) => (
              <div className="f" key={k}>
                <label htmlFor={`cf-${k}`}>{label}</label>
                <div className="frow">
                  <input id={`cf-${k}`} value={d[k]} placeholder={hint} onChange={(e) => set(k, e.target.value)} style={{ flex: 1, width: "auto" }} spellCheck={false} />
                  <button className="btn" type="button" onClick={async () => { const p = await open({ title: label, multiple: false, filters: [{ name: "Certificates and keys", extensions: ["pem", "crt", "cer", "key"] }, { name: "All files", extensions: ["*"] }] }); if (typeof p === "string") set(k, p); }}>Choose…</button>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="note">Passwords are stored in Windows Credential Manager (or the Linux keyring), never in Tilki DB's own files.</p>
        {hostPrompt && (
          <div className="hostkey" role="alert">
            <b>First connection to {hostPrompt.host}</b>
            <p>This SSH server isn't in your known_hosts yet. Check that its fingerprint matches what your server admin gave you:</p>
            <code>{hostPrompt.fingerprint}</code>
            <div className="frow"><button className="btn pri" onClick={() => test(true)} disabled={busy}>Trust this host and test</button><button className="btn" onClick={() => setHostPrompt(null)}>Don't trust</button></div>
          </div>
        )}
        <div className={`testres${result ? (result.ok ? " ok" : " err") : ""}`} role="status">{result?.text}</div>
        <div className="acts">
          {!isNew && (
            <button className={`btn${confirmDelete ? " danger" : ""}`} disabled={busy}
              onClick={() => (confirmDelete ? onDelete(initial) : setConfirmDelete(true))} onBlur={() => setConfirmDelete(false)}>
              {confirmDelete ? "Click again to delete" : "Delete"}
            </button>
          )}
          <button className="btn" onClick={() => test()} disabled={busy} style={{ marginRight: "auto" }}>Test connection</button>
          <button className="btn" onClick={onClose} disabled={busy}>Cancel</button>
          <button className="btn" onClick={() => save(false)} disabled={busy}>Save</button>
          <button className="btn pri" onClick={() => save(true)} disabled={busy}>Save &amp; connect</button>
        </div>
      </div>
    </div>
  );
}
