// Save an on-screen <svg> (ER diagram, chart) as a standalone SVG or PNG file.
import { save } from "@tauri-apps/plugin-dialog";
import { api, errText } from "../lib/api";

const NS = "http://www.w3.org/2000/svg";
const STYLE_PROPS = ["fill", "stroke", "stroke-width", "stroke-dasharray", "opacity", "font-family", "font-size", "font-weight", "font-style", "text-anchor"];

/** Theme colors are CSS variables, so they're resolved onto each element. A title (and legend) can go on top. */
function standaloneSvg(svg: SVGSVGElement, w: number, h: number, head?: { title: string; legend?: { label: string; color: string }[] }): { text: string; w: number; h: number } {
  const copy = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll("*")], dst = [copy, ...copy.querySelectorAll("*")];
  src.forEach((el, i) => {
    const cs = getComputedStyle(el);
    (dst[i] as SVGElement).setAttribute("style", STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(";"));
  });
  const body = getComputedStyle(document.body);
  const fg = body.getPropertyValue("--fg") || "#000", font = body.getPropertyValue("--ui") || "sans-serif";
  const top = head ? (head.legend?.length ? 52 : 34) : 0;
  const out = document.createElementNS(NS, "svg");
  out.setAttribute("xmlns", NS);
  out.setAttribute("width", String(w)); out.setAttribute("height", String(h + top));
  const bg = document.createElementNS(NS, "rect");
  bg.setAttribute("width", "100%"); bg.setAttribute("height", "100%"); bg.setAttribute("fill", body.getPropertyValue("--bg") || "#fff");
  out.append(bg);
  if (head) {
    const t = document.createElementNS(NS, "text");
    t.setAttribute("x", "12"); t.setAttribute("y", "22");
    t.setAttribute("style", `fill:${fg};font-family:${font};font-size:14px;font-weight:600`);
    t.textContent = head.title;
    out.append(t);
    let x = 12;
    for (const l of head.legend ?? []) {
      const sw = document.createElementNS(NS, "rect");
      sw.setAttribute("x", String(x)); sw.setAttribute("y", "34"); sw.setAttribute("width", "10"); sw.setAttribute("height", "10");
      sw.setAttribute("style", `fill:${l.color}`);
      const lt = document.createElementNS(NS, "text");
      lt.setAttribute("x", String(x + 15)); lt.setAttribute("y", "43");
      lt.setAttribute("style", `fill:${fg};font-family:${font};font-size:12px`);
      lt.textContent = l.label;
      out.append(sw, lt);
      x += 30 + l.label.length * 7;
    }
  }
  const g = document.createElementNS(NS, "g");
  g.setAttribute("transform", `translate(0,${top})`);
  copy.removeAttribute("width"); copy.removeAttribute("height");
  copy.setAttribute("width", String(w)); copy.setAttribute("height", String(h));
  g.append(copy);
  out.append(g);
  return { text: new XMLSerializer().serializeToString(out), w, h: h + top };
}

/** Ask for a file name and write the image. Resolves with a message for a toast, or null if cancelled. */
export async function saveSvgImage(svg: SVGSVGElement, w: number, h: number, fmt: "svg" | "png", name: string, head?: { title: string; legend?: { label: string; color: string }[] }): Promise<string | null> {
  const path = await save({ title: fmt === "png" ? "Save as PNG" : "Save as SVG", defaultPath: `${name.replace(/[^\w.-]+/g, "_") || "image"}.${fmt}`, filters: [{ name: fmt.toUpperCase(), extensions: [fmt] }] });
  if (!path) return null;
  try {
    const img = standaloneSvg(svg, w, h, head);
    if (fmt === "svg") { await api.writeText(path, img.text); return `Saved ${path}`; }
    const el = new Image();
    el.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(img.text)}`;
    await el.decode();
    const scale = 2; // sharp on high-DPI screens and in documents
    const canvas = document.createElement("canvas");
    canvas.width = img.w * scale; canvas.height = img.h * scale;
    const ctx = canvas.getContext("2d")!;
    ctx.scale(scale, scale);
    ctx.drawImage(el, 0, 0);
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
    if (!blob) throw new Error("Could not render the PNG.");
    await api.writeBytes(path, new Uint8Array(await blob.arrayBuffer()));
    return `Saved ${path}`;
  } catch (e) { return errText(e); }
}
