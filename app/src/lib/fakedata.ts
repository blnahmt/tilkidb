// Sample rows for an empty or test table, picked from each column's name and type.
// Deterministic for a given seed, so tests and "generate again" are predictable.
import type { Cell, Column } from "./api.ts";

const FIRST = ["Ada", "Ali", "Ayşe", "Can", "Deniz", "Elif", "Emre", "Lena", "Mehmet", "Mia", "Noah", "Selin", "Zeynep", "Omar", "Sofia", "Kerem"];
const LAST = ["Yılmaz", "Kaya", "Demir", "Şahin", "Smith", "Garcia", "Müller", "Rossi", "Novak", "Tanaka", "Silva", "Öztürk"];
const CITIES = ["İstanbul", "Ankara", "İzmir", "Berlin", "Lisbon", "Madrid", "Paris", "Tokyo", "Toronto", "Oslo"];
const COUNTRIES = ["TR", "DE", "PT", "ES", "FR", "JP", "CA", "NO", "US", "GB"];
const WORDS = ["fox", "river", "stone", "amber", "north", "quiet", "copper", "maple", "harbor", "cedar", "lumen", "swift", "orbit", "delta", "ember"];

export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

const pad = (n: number, w = 2) => String(n).padStart(w, "0");

/** One value for a column; undefined = leave it out of the INSERT (database default / auto id). */
/** `person`: one name per row, so full_name, first_name and email agree */
export function fakeValue(col: Column, k: number, r: () => number, fkValues: Cell[] = [], person?: [string, string]): Cell | undefined {
  const pick = <T,>(xs: T[]) => xs[Math.floor(r() * xs.length)];
  const int = (lo: number, hi: number) => lo + Math.floor(r() * (hi - lo + 1));
  const t = col.dataType.toLowerCase(), n = col.name.toLowerCase();
  const isInt = /int|serial/.test(t) && !/interval|point/.test(t);
  if (col.pk && (isInt || /default|identity/.test(t))) return undefined; // generated key
  if (col.fk) return fkValues.length ? pick(fkValues) : col.nullable ? null : undefined;
  if (t.endsWith("[]") || /^array|^set\(/.test(t)) return col.nullable ? null : undefined; // arrays: no safe literal for every element type
  const len = Number(/\((\d+)\)/.exec(t)?.[1] ?? 0);
  const fit = (s: string) => (len > 0 && /char/.test(t) ? s.slice(0, len) : s);
  const date = () => { const d = new Date(Date.UTC(2024, 0, 1) + int(0, 700) * 86400000); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`; };
  const enumVals = /^enum\((.*)\)$/.exec(t)?.[1].match(/'((?:[^']|'')*)'/g)?.map((x) => x.slice(1, -1).replace(/''/g, "'"));
  if (enumVals?.length) return pick(enumVals);
  if (/bool|bit\(1\)|tinyint\(1\)/.test(t)) return r() < 0.5;
  if (/uuid/.test(t) || (col.pk && /char|text/.test(t))) {
    const h = () => Math.floor(r() * 16).toString(16);
    const s = "xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx".replace(/x/g, h);
    return /uuid/.test(t) ? s : fit(s);
  }
  if (/json/.test(t)) return { sample: true, n: k + 1 };
  if (/timestamp|datetime/.test(t)) return `${date()} ${pad(int(0, 23))}:${pad(int(0, 59))}:${pad(int(0, 59))}`;
  if (/^date/.test(t)) return date();
  if (/^time/.test(t)) return `${pad(int(0, 23))}:${pad(int(0, 59))}:00`;
  const money = /price|amount|total|cost|salary|balance|fee/.test(n);
  if (/numeric|decimal|real|double|float|money/.test(t) || (money && !isInt)) return Math.round((money ? int(1, 500) + r() : r() * 1000) * 100) / 100;
  if (isInt) return /qty|quantity|count|stock|age/.test(n) ? int(1, /age/.test(n) ? 90 : 50) : /year/.test(n) ? int(1990, 2026) : int(1, 1000);
  if (!/char|text|string|clob|name/.test(t) && t !== "") return undefined; // blobs, geometry, arrays: leave to the default
  const [first, last] = person ?? [pick(FIRST), pick(LAST)];
  const ascii = (s: string) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/ı/g, "i").replace(/[^a-zA-Z]/g, "").toLowerCase();
  if (/mail/.test(n)) return fit(`${ascii(first)}.${ascii(last)}${k + 1}@example.com`); // index keeps it unique
  if (/first/.test(n)) return fit(first);
  if (/last|surname/.test(n)) return fit(last);
  if (/(^|_)name$|full_?name|^name/.test(n)) return fit(/product|item|title/.test(n) ? `${pick(WORDS)} ${pick(WORDS)}` : `${first} ${last}`);
  if (/phone|mobile|tel/.test(n)) return fit(`+90 5${int(30, 59)} ${int(100, 999)} ${pad(int(0, 99))} ${pad(int(0, 99))}`);
  if (/city/.test(n)) return fit(pick(CITIES));
  if (/country/.test(n)) return fit(pick(COUNTRIES));
  if (/url|website|link/.test(n)) return fit(`https://example.com/${pick(WORDS)}/${k + 1}`);
  if (/sku|code|ref/.test(n)) return fit(`${pick(WORDS).slice(0, 3).toUpperCase()}-${pad(k + 1, 5)}`);
  if (/status|state/.test(n)) return fit(pick(["active", "pending", "done", "cancelled"]));
  if (/desc|note|comment|body|text|bio/.test(n)) return fit(Array.from({ length: int(6, 14) }, () => pick(WORDS)).join(" ") + ".");
  return fit(`${pick(WORDS)} ${pick(WORDS)}`);
}

/** `n` rows; each row has a value (or undefined) per column. */
export function fakeRows(cols: Column[], n: number, seed: number, fkValues: Record<string, Cell[]> = {}): (Cell | undefined)[][] {
  const r = rng(seed);
  return Array.from({ length: n }, (_, k) => {
    const person: [string, string] = [FIRST[Math.floor(r() * FIRST.length)], LAST[Math.floor(r() * LAST.length)]];
    return cols.map((c) => fakeValue(c, k, r, fkValues[c.name], person));
  });
}
