import { useEffect, useRef, type ReactNode } from "react";

// Floating menu tied to a button: closes on outside click or Esc (focus returns to the button).
// The element marked data-autofocus gets focus when it opens.
export function Popover({ anchor, place = "below", width = 320, label, className = "", onClose, children }: {
  anchor: HTMLElement;
  place?: "below" | "right";
  width?: number;
  label: string;
  className?: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const r = anchor.getBoundingClientRect();

  useEffect(() => {
    ref.current?.querySelector<HTMLElement>("[data-autofocus]")?.focus();
    const down = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!ref.current?.contains(t) && !anchor.contains(t)) onClose();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); anchor.focus(); }
    };
    addEventListener("mousedown", down);
    addEventListener("keydown", key);
    return () => { removeEventListener("mousedown", down); removeEventListener("keydown", key); };
  }, [anchor, onClose]);

  const style = place === "right"
    ? { left: r.right + 6, bottom: Math.max(8, innerHeight - r.bottom), width }
    : { top: r.bottom + 4, left: Math.max(8, Math.min(r.left, innerWidth - width - 8)), width };
  return <div ref={ref} className={`menu ${className}`} role="dialog" aria-label={label} style={style}>{children}</div>;
}
