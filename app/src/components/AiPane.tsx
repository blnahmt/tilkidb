import { useEffect, useRef, useState } from "react";
import { api, errText, type AiSummary } from "../lib/api";
import { extractSql } from "../lib/ai";
import { Markdown } from "./Markdown";

type AiState = { label: string; text: string; job: string | null; error?: string; summary?: AiSummary };

/** One question at a time per query tab; the answer streams in as Claude writes it. */
export function useAi() {
  const [ai, setAi] = useState<AiState | null>(null);
  const ask = async (label: string, system: string, prompt: string) => {
    const job = crypto.randomUUID();
    let text = "";
    setAi({ label, text, job });
    try {
      const summary = await api.aiAsk(job, system, prompt, (t) => { text += t; setAi((a) => (a?.job === job ? { ...a, text } : a)); });
      setAi((a) => (a?.job === job ? { ...a, text, job: null, summary } : a));
    } catch (e) {
      setAi((a) => (a?.job === job ? { ...a, job: null, error: errText(e) } : a));
    }
  };
  return { ai, ask, cancel: () => { if (ai?.job) api.cancelQuery(ai.job); } };
}

export function AiPane({ ready, ai, busy, onSetup, onWrite, onExplain, onCancel, onInsert, onToast }: {
  ready: boolean;
  ai: AiState | null;
  busy: boolean; // a question is being answered
  onSetup: () => void;
  onWrite: (request: string) => void;
  onExplain: () => void;
  onCancel: () => void;
  onInsert: (sql: string) => void;
  onToast: (m: string) => void;
}) {
  const [request, setRequest] = useState("");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = body.current; if (el && busy) el.scrollTop = el.scrollHeight; }, [ai?.text, busy]);

  if (!ready) {
    return (
      <div className="rempty">
        <div className="aioff">
          <b>AI assistant is off</b>
          <p>Ask Claude to explain a query, write one from a description, or fix an error. It uses your own Anthropic API key. Only the SQL you ask about and the table and column names are sent, never row data.</p>
          <button className="btn pri" onClick={onSetup}>Set up AI…</button>
        </div>
      </div>
    );
  }

  const declined = ai?.summary?.stopReason === "refusal";
  const sql = ai && !ai.job && !declined && !ai.error ? extractSql(ai.text) : null;
  const write = () => { if (request.trim() && !busy) { onWrite(request.trim()); setRequest(""); } };
  return (
    <div className="aipane">
      <div className="aiask">
        <input value={request} onChange={(e) => setRequest(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") write(); }}
          placeholder="Describe the query you need, e.g. revenue per country last month" aria-label="Describe the query you need" disabled={busy} />
        <button className="btn pri" onClick={write} disabled={busy || !request.trim()}>Write SQL</button>
        <button className="btn" onClick={onExplain} disabled={busy} title="Explain the statement under the cursor">Explain statement</button>
        {busy && <button className="btn danger" onClick={onCancel}>Cancel</button>}
      </div>
      <div className="aibody" ref={body}>
        {!ai && <p className="ty aihint">Answers appear here. Claude sees the SQL you ask about and the schema's table and column names. Review any SQL before running it.</p>}
        {ai && (
          <>
            <div className="aiq">{ai.label}</div>
            {declined ? <p className="err">Claude declined this request, so there is no answer. Try rephrasing it.</p>
              : <div className="aimd">{ai.text ? <Markdown src={ai.text} onToast={onToast} /> : ai.job ? <p className="ty">Thinking…</p> : null}</div>}
            {ai.error && <p className="err">{ai.error}</p>}
            {sql && (
              <div className="frow aiacts">
                <button className="btn pri" onClick={() => onInsert(sql)}>Insert into editor</button>
                <button className="btn" onClick={() => navigator.clipboard.writeText(sql).then(() => onToast("Copied the SQL"), () => onToast("Clipboard is not available"))}>Copy SQL</button>
              </div>
            )}
            {ai.summary && <small className="ty aifoot">{ai.summary.cancelled ? "Cancelled · " : ""}{ai.summary.model || "Claude"} · {ai.summary.inputTokens.toLocaleString()} in / {ai.summary.outputTokens.toLocaleString()} out tokens</small>}
          </>
        )}
      </div>
    </div>
  );
}

/** Save or remove the Anthropic API key (kept in the OS keychain, never in the web view after saving). */
export function AiSettings({ ready, onClose, onChanged, onToast }: { ready: boolean; onClose: () => void; onChanged: (ready: boolean) => void; onToast: (m: string) => void }) {
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const esc = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    addEventListener("keydown", esc);
    return () => removeEventListener("keydown", esc);
  }, [onClose]);
  const set = (k: string | null) => api.setAiKey(k).then(() => { onChanged(k !== null); onToast(k ? "AI assistant is on" : "AI assistant is off; the key was removed"); onClose(); }, (e) => setError(errText(e)));
  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal small" role="dialog" aria-modal="true" aria-labelledby="ai-title">
        <h3 id="ai-title">AI assistant</h3>
        <p className="note">Optional and off until you add a key. Requests go from this app straight to Anthropic's API using Claude Opus 5.5, billed to your Anthropic account.</p>
        <ul className="gwhy">
          <li><b>Sent:</b> the SQL you ask about or describe, an error message when you ask for a fix, and table / column names and types of the connected database.</li>
          <li><b>Never sent:</b> row data, passwords, connection details.</li>
          <li>The key is stored in the OS keychain (Windows Credential Manager).</li>
        </ul>
        <div className="f">
          <label htmlFor="ai-key">{ready ? "Replace the API key" : "Anthropic API key"}</label>
          <input id="ai-key" type="password" autoFocus value={key} onChange={(e) => setKey(e.target.value)} placeholder="sk-ant-…" autoComplete="off" spellCheck={false}
            onKeyDown={(e) => { if (e.key === "Enter" && key.trim()) set(key.trim()); }} />
        </div>
        {error && <p className="testres err">{error}</p>}
        <div className="acts">
          {ready && <button className="btn danger" style={{ marginRight: "auto" }} onClick={() => set(null)}>Turn off and remove key</button>}
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn pri" disabled={!key.trim()} onClick={() => set(key.trim())}>Save key</button>
        </div>
      </div>
    </div>
  );
}
