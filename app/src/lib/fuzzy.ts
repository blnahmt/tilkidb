// Fuzzy matching for the command palette: query letters must appear in order.
// Contiguous letters and letters at word starts score higher.
export interface Match {
  score: number;
  indices: number[];
}

const WORD_BREAK = /[\s\-_.:/]/;

function greedyFrom(q: string, t: string, start: number): Match | null {
  const indices: number[] = [];
  let score = 0;
  let prev = -2;
  for (let i = start, j = 0; i < t.length && j < q.length; i++) {
    if (t[i] !== q[j]) continue;
    score += (i === prev + 1 ? 5 : 1) + (i === 0 || WORD_BREAK.test(t[i - 1]) ? 3 : 0);
    indices.push(i);
    prev = i;
    j++;
  }
  return indices.length === q.length ? { score, indices } : null;
}

export function fuzzyMatch(query: string, text: string): Match | null {
  const q = query.toLowerCase().replace(/\s+/g, "");
  if (!q) return { score: 0, indices: [] };
  const t = text.toLowerCase();
  let best: Match | null = null;
  // try every place the first letter occurs, so "or" finds "orders" and not the "O" of "Open"
  for (let s = t.indexOf(q[0]); s !== -1; s = t.indexOf(q[0], s + 1)) {
    const m = greedyFrom(q, t, s);
    if (!m) break; // later starts can't match either
    if (!best || m.score > best.score) best = m;
  }
  return best && { score: best.score - text.length * 0.01, indices: best.indices }; // shorter text wins a tie
}

/** Items that match, best first. An empty query keeps the original order. */
export function rank<T>(items: T[], query: string, text: (item: T) => string): { item: T; match: Match }[] {
  const out: { item: T; match: Match }[] = [];
  for (const item of items) {
    const match = fuzzyMatch(query, text(item));
    if (match) out.push({ item, match });
  }
  if (query.trim()) out.sort((a, b) => b.match.score - a.match.score);
  return out;
}
