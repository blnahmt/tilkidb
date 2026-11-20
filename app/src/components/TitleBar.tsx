import { useEffect, useState, type ReactNode } from "react";
import { isTauri } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Icon, Logo } from "./Icons";

const win = isTauri() ? getCurrentWindow() : null;

// The OS frame is off ("decorations": false, "shadow": false keeps corners square on Windows 11),
// so we draw the window controls. data-tauri-drag-region only drags on the element itself.
export function TitleBar({ picker, onSearch }: { picker: ReactNode; onSearch: () => void }) {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    if (!win) return;
    const sync = () => win.isMaximized().then(setMaximized);
    sync();
    const off = win.onResized(sync);
    return () => { off.then((f) => f()); };
  }, []);

  return (
    <header className="title" data-tauri-drag-region>
      <div className="brand" data-tauri-drag-region>
        <Logo />
        <b>Tilki <span>DB</span></b>
      </div>
      {picker}
      <button className="cmd" onClick={onSearch} aria-label="Open command menu">
        <Icon name="search" />
        <span>Search tables, queries, commands…</span>
        <kbd>Ctrl K</kbd>
      </button>
      <div className="drag" data-tauri-drag-region />
      {win && (
        <div className="winctl">
          <button onClick={() => win.minimize()} aria-label="Minimize" title="Minimize">
            <svg viewBox="0 0 16 16"><path d="M3 8h10" /></svg>
          </button>
          <button onClick={() => win.toggleMaximize()} aria-label={maximized ? "Restore" : "Maximize"} title={maximized ? "Restore" : "Maximize"}>
            {maximized
              ? <svg viewBox="0 0 16 16"><path d="M3 5.5h7.5V13H3zM5.5 5.5V3H13v7.5h-2.5" /></svg>
              : <svg viewBox="0 0 16 16"><path d="M3 3h10v10H3z" /></svg>}
          </button>
          <button className="close" onClick={() => win.close()} aria-label="Close" title="Close">
            <svg viewBox="0 0 16 16"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" /></svg>
          </button>
        </div>
      )}
    </header>
  );
}
