// A small unified line diff, enough to show what changed in a skill file
// between two swamp releases.

const MAX_CELLS = 4_000_000;

type Op = { kind: " " | "-" | "+"; text: string; a: number; b: number };

function ops(a: string[], b: string[]): Op[] | null {
  const n = a.length;
  const m = b.length;
  if ((n + 1) * (m + 1) > MAX_CELLS) return null;
  // lcs[i][j]: length of the longest common subsequence of a[i..] and b[j..].
  const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = a[i] === b[j]
        ? lcs[i + 1][j + 1] + 1
        : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) {
      out.push({ kind: " ", text: a[i], a: i++, b: j++ });
    } else if (i < n && (j === m || lcs[i + 1][j] >= lcs[i][j + 1])) {
      out.push({ kind: "-", text: a[i], a: i++, b: j });
    } else {
      out.push({ kind: "+", text: b[j], a: i, b: j++ });
    }
  }
  return out;
}

/**
 * A unified diff of two texts with `context` lines around each change, or a
 * one-line note when the files are too big to diff. Returns "" when equal.
 */
export function unifiedDiff(
  before: string,
  after: string,
  context = 3,
): string {
  if (before === after) return "";
  const a = before.split("\n");
  const b = after.split("\n");
  const all = ops(a, b);
  if (!all) {
    return `(too large to diff: ${a.length} -> ${b.length} lines)`;
  }
  const changed = all.map((o, k) => o.kind !== " " ? k : -1).filter((k) =>
    k >= 0
  );
  const hunks: [number, number][] = [];
  for (const k of changed) {
    const lo = Math.max(0, k - context);
    const hi = Math.min(all.length - 1, k + context);
    const last = hunks[hunks.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else hunks.push([lo, hi]);
  }
  const lines: string[] = [];
  for (const [lo, hi] of hunks) {
    const slice = all.slice(lo, hi + 1);
    const aLen = slice.filter((o) => o.kind !== "+").length;
    const bLen = slice.filter((o) => o.kind !== "-").length;
    lines.push(
      `@@ -${slice[0].a + 1},${aLen} +${slice[0].b + 1},${bLen} @@`,
    );
    for (const o of slice) lines.push(o.kind + o.text);
  }
  return lines.join("\n");
}
