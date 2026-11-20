// A small Markdown subset for notebook text cells: # headings, paragraphs, - / 1. lists,
// > quotes, ``` code blocks, and inline `code`, **bold**, *italic*, [links](url).
// It returns plain data; the component renders it with React, so nothing is injected as HTML.

export type Inline = { t: "text" | "code" | "b" | "i"; text: string } | { t: "a"; text: string; href: string };
export type Block =
  | { t: "h"; level: 1 | 2 | 3; inl: Inline[] }
  | { t: "p" | "quote"; inl: Inline[] }
  | { t: "ul" | "ol"; items: Inline[][] }
  | { t: "code"; text: string };

const INLINE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[[^\]]+\]\([^)\s]+\))/g;

export function inline(s: string): Inline[] {
  const out: Inline[] = [];
  let last = 0;
  for (const m of s.matchAll(INLINE)) {
    if (m.index > last) out.push({ t: "text", text: s.slice(last, m.index) });
    const x = m[0];
    if (m[1]) out.push({ t: "code", text: x.slice(1, -1) });
    else if (m[2]) out.push({ t: "b", text: x.slice(2, -2) });
    else if (m[3]) out.push({ t: "i", text: x.slice(1, -1) });
    else { const [, text, href] = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(x)!; out.push({ t: "a", text, href }); }
    last = m.index + x.length;
  }
  if (last < s.length) out.push({ t: "text", text: s.slice(last) });
  return out;
}

export function parse(src: string): Block[] {
  const lines = src.replace(/\r\n/g, "\n").split("\n");
  const out: Block[] = [];
  let para: string[] = [];
  const flush = () => { if (para.length) { out.push({ t: "p", inl: inline(para.join(" ")) }); para = []; } };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^```/.test(l)) {
      flush();
      const body: string[] = [];
      while (++i < lines.length && !/^```/.test(lines[i])) body.push(lines[i]);
      out.push({ t: "code", text: body.join("\n") });
    } else if (/^#{1,3}\s/.test(l)) {
      flush();
      const level = l.match(/^#+/)![0].length as 1 | 2 | 3;
      out.push({ t: "h", level, inl: inline(l.slice(level).trim()) });
    } else if (/^\s*([-*]|\d+\.)\s/.test(l)) {
      flush();
      const t = /^\s*\d+\./.test(l) ? "ol" : "ul";
      const item = t === "ol" ? /^\s*\d+\.\s/ : /^\s*[-*]\s/;
      const items: Inline[][] = [];
      for (; i < lines.length && item.test(lines[i]); i++) items.push(inline(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, "")));
      i--;
      out.push({ t, items });
    } else if (/^>\s?/.test(l)) {
      flush();
      const q: string[] = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ""));
      i--;
      out.push({ t: "quote", inl: inline(q.join(" ")) });
    } else if (!l.trim()) {
      flush();
    } else {
      para.push(l.trim());
    }
  }
  flush();
  return out;
}
