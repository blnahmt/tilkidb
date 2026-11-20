import { parse, type Block, type Inline } from "../lib/markdown";

// Renders the Markdown subset from lib/markdown with React elements (no HTML injection).
export function Markdown({ src, onToast }: { src: string; onToast: (m: string) => void }) {
  return <>{parse(src).map((b, i) => <MdBlock key={i} b={b} onToast={onToast} />)}</>;
}

function Inl({ inl, onToast }: { inl: Inline[]; onToast: (m: string) => void }) {
  return <>{inl.map((x, i) => x.t === "code" ? <code key={i}>{x.text}</code> : x.t === "b" ? <b key={i}>{x.text}</b> : x.t === "i" ? <i key={i}>{x.text}</i>
    // links would navigate the app window away, so a click copies the address instead
    : x.t === "a" ? <a key={i} href={x.href} title={`${x.href} (click to copy)`} onClick={(e) => { e.preventDefault(); navigator.clipboard.writeText(x.href).then(() => onToast("Copied the link"), () => {}); }}>{x.text}</a>
    : <span key={i}>{x.text}</span>)}</>;
}

function MdBlock({ b, onToast }: { b: Block; onToast: (m: string) => void }) {
  switch (b.t) {
    case "h": { const H = (`h${b.level + 1}`) as "h2" | "h3" | "h4"; return <H><Inl inl={b.inl} onToast={onToast} /></H>; }
    case "p": return <p><Inl inl={b.inl} onToast={onToast} /></p>;
    case "quote": return <blockquote><Inl inl={b.inl} onToast={onToast} /></blockquote>;
    case "code": return <pre>{b.text}</pre>;
    default: { const L = b.t; return <L>{b.items.map((it, i) => <li key={i}><Inl inl={it} onToast={onToast} /></li>)}</L>; }
  }
}
