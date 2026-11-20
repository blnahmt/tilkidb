import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { rank } from "../lib/fuzzy";

export interface Command {
  id: string;
  group: string;
  title: string;
  shortcut?: string;
  active?: boolean;
  run: () => void;
}

export function Highlight({ text, indices }: { text: string; indices: number[] }) {
  const set = new Set(indices);
  return <>{[...text].map((ch, i) => (set.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>;
}

export function CommandPalette({ commands, initialQuery = "", onClose }: { commands: Command[]; initialQuery?: string; onClose: () => void }) {
  const [query, setQuery] = useState(initialQuery);
  const [sel, setSel] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);
  const results = useMemo(() => rank(commands, query, (c) => `${c.group} ${c.title}`).slice(0, 60), [commands, query]);

  useEffect(() => setSel(0), [query]);
  useEffect(() => {
    listRef.current?.querySelector(".on")?.scrollIntoView({ block: "nearest" });
  }, [sel]);

  const run = (i: number) => {
    const r = results[i];
    if (!r) return;
    onClose();
    r.item.run();
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => (s + 1) % Math.max(1, results.length)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => (s - 1 + results.length) % Math.max(1, results.length)); }
    else if (e.key === "Enter") { e.preventDefault(); run(sel); }
    else if (e.key === "Escape") { e.preventDefault(); onClose(); }
  };

  return (
    <div className="scrim" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="pal" role="dialog" aria-modal="true" aria-label="Command menu">
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKey}
          placeholder="Type a command or theme…"
          role="combobox"
          aria-expanded="true"
          aria-controls="pal-list"
          aria-activedescendant={results[sel] ? `pal-${results[sel].item.id}` : undefined}
        />
        <ul id="pal-list" role="listbox" ref={listRef}>
          {results.length === 0 && <li className="none">No matching commands</li>}
          {results.map(({ item, match }, i) => {
            const offset = item.group.length + 1; // highlight only the title part
            return (
              <li key={item.id} id={`pal-${item.id}`} role="option" aria-selected={i === sel} className={i === sel ? "on" : ""} onMouseMove={() => setSel(i)} onClick={() => run(i)}>
                <span className="g">{item.group}</span>
                <span className="tx"><Highlight text={item.title} indices={match.indices.filter((x) => x >= offset).map((x) => x - offset)} /></span>
                {item.active && <span className="chk" aria-label="current">✓</span>}
                {item.shortcut && <kbd>{item.shortcut}</kbd>}
              </li>
            );
          })}
        </ul>
        <div className="foot"><span><kbd>↑</kbd> <kbd>↓</kbd> move</span><span><kbd>↵</kbd> run</span><span><kbd>Esc</kbd> close</span></div>
      </div>
    </div>
  );
}
