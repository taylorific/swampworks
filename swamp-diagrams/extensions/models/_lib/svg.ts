// Draw a Graph as an SVG with a fixed, hand-made-looking layout instead of an
// automatic one: the main path runs straight down the middle, failure boxes
// sit to the right of the box that leads to them, retries curve back up on
// the right, loops are arcs on the left, and notes sit beside their box.
//
// Text is monospace, so every label's width is known without a browser and
// boxes are always wide enough for their text.

import {
  type Graph,
  GRAPH_END,
  GRAPH_START,
  type GraphEdge,
  type GraphGroup,
  type GraphNode,
} from "./graph.ts";
import type { EdgeRole } from "./mermaid.ts";

/** Colours for one mode. */
interface SvgPalette {
  title: string;
  subtitle: string;
  text: string;
  note: string;
  frame: string;
  node: { fill: string; stroke: string; text: string };
  highlight: { fill: string; stroke: string; text: string };
  failure: { fill: string; stroke: string; text: string };
  edge: Record<EdgeRole, string>;
  glow: boolean;
}

const PALETTES: Record<"dark" | "light", SvgPalette> = {
  dark: {
    title: "#4ade80",
    subtitle: "#9ca3af",
    text: "#d1d5db",
    note: "#8b949e",
    frame: "#3f4b5b",
    node: { fill: "#0d1f1c", stroke: "#2dd4bf", text: "#5eead4" },
    highlight: { fill: "#0f2e1b", stroke: "#4ade80", text: "#86efac" },
    failure: { fill: "#2a1215", stroke: "#f87171", text: "#fca5a5" },
    edge: {
      normal: "#60a5fa",
      human: "#4ade80",
      fail: "#f87171",
      loop: "#f59e0b",
      skip: "#8b949e",
    },
    glow: true,
  },
  light: {
    title: "#15803d",
    subtitle: "#57606a",
    text: "#24292f",
    note: "#57606a",
    frame: "#d0d7de",
    node: { fill: "#f0fdfa", stroke: "#0d9488", text: "#115e59" },
    highlight: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
    failure: { fill: "#fef2f2", stroke: "#dc2626", text: "#991b1b" },
    edge: {
      normal: "#2563eb",
      human: "#16a34a",
      fail: "#dc2626",
      loop: "#d97706",
      skip: "#8c959f",
    },
    glow: false,
  },
};

const FONT =
  "ui-monospace, SFMono-Regular, Menlo, Consolas, 'Liberation Mono', monospace";
// Advance width of one character in these fonts, as a fraction of the size.
const CHAR = 0.6;
const SIZE = { title: 24, subtitle: 13, label: 15, note: 12, edge: 12 };
const BOX_H = 38;
const ROW_GAP = 54; // between boxes in consecutive rows
const NOTE_BELOW = 20; // extra row gap when notes sit under the boxes
const SIBLING_GAP = 36;
const SIDE_GAP = 150; // from a box to the failure box beside it
const NOTE_GAP = 16;
const ENTRY = 42; // length of an entry or exit arrow
const LOOP_ROOM = 100; // width a loop arc takes beside its box

/** Width of `text` at `size`, in the monospace font. */
export function textWidth(text: string, size: number): number {
  return [...text].length * size * CHAR;
}

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");

/** Split `text` into lines of at most `max` characters, at spaces. */
function wrap(text: string, max: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && (line + " " + word).length > max) {
      lines.push(line);
      line = word;
    } else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}

interface Box {
  node: GraphNode;
  x: number; // centre
  y: number; // centre
  w: number;
  noteSide: "left" | "right" | "below";
}

/** Tracks the drawing's extent so the viewBox fits everything. */
class Extent {
  minX = Infinity;
  maxX = -Infinity;
  minY = Infinity;
  maxY = -Infinity;
  add(x1: number, y1: number, x2 = x1, y2 = y1) {
    this.minX = Math.min(this.minX, x1, x2);
    this.maxX = Math.max(this.maxX, x1, x2);
    this.minY = Math.min(this.minY, y1, y2);
    this.maxY = Math.max(this.maxY, y1, y2);
  }
  text(x: number, y: number, s: string, size: number, anchor: string) {
    const w = textWidth(s, size);
    const left = anchor === "end" ? x - w : anchor === "middle" ? x - w / 2 : x;
    this.add(left, y - size, left + w, y + size * 0.3);
  }
}

/** SVG drawing state: elements by layer, and the extent. */
class Canvas {
  frames: string[] = [];
  edges: string[] = [];
  boxes: string[] = [];
  labels: string[] = [];
  ext = new Extent();
  constructor(readonly p: SvgPalette) {}

  text(
    x: number,
    y: number,
    s: string,
    o: {
      size: number;
      fill: string;
      anchor?: "start" | "middle" | "end";
      bold?: boolean;
      layer?: "labels" | "boxes";
    },
  ) {
    const anchor = o.anchor ?? "start";
    this.ext.text(x, y, s, o.size, anchor);
    (o.layer === "boxes" ? this.boxes : this.labels).push(
      `<text x="${r(x)}" y="${r(y)}" font-size="${o.size}" fill="${o.fill}"` +
        (anchor !== "start" ? ` text-anchor="${anchor}"` : "") +
        (o.bold ? ` font-weight="bold"` : "") + `>${esc(s)}</text>`,
    );
  }

  path(d: string, role: EdgeRole, points: [number, number][], arrow = true) {
    for (const [x, y] of points) this.ext.add(x, y);
    const colour = this.p.edge[role];
    const width = role === "human" ? 2.2 : 1.5;
    this.edges.push(
      `<path d="${d}" fill="none" stroke="${colour}" stroke-width="${width}"` +
        (role === "skip" ? ` stroke-dasharray="5 4"` : "") +
        (arrow ? ` marker-end="url(#arrow-${role})"` : "") + `/>`,
    );
  }

  edgeLabel(
    x: number,
    y: number,
    s: string,
    role: EdgeRole,
    anchor: "start" | "middle" | "end" = "start",
  ) {
    const fill = role === "normal" ? this.p.text : this.p.edge[role];
    this.text(x, y, s, {
      size: SIZE.edge,
      fill,
      anchor,
      bold: role === "human",
    });
  }
}

const r = (n: number) => Math.round(n * 10) / 10;

/** Lay out one group around x = 0 from y = top; returns its boxes. */
function layoutGroup(
  group: GraphGroup,
  edges: GraphEdge[],
  top: number,
): { boxes: Map<string, Box>; bottom: number } {
  // A job with no steps is just its frame.
  if (group.nodes.length === 0) return { boxes: new Map(), bottom: top };
  const ids = new Set(group.nodes.map((n) => n.id));
  const inner = edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const forward = inner.filter((e) => !e.back && e.from !== e.to);

  // A box reached only by failure arrows sits beside the box it fails from.
  const side = new Map<string, string>();
  for (const n of group.nodes) {
    const into = forward.filter((e) => e.to === n.id);
    if (into.length > 0 && into.every((e) => e.role === "fail")) {
      side.set(n.id, into[0].from);
    }
  }
  const main = group.nodes.filter((n) => !side.has(n.id));

  // Rows: the longest path of forward arrows to each main box.
  const rank = new Map(main.map((n) => [n.id, 0]));
  for (let i = 0; i < main.length; i++) {
    for (const e of forward) {
      if (rank.has(e.from) && rank.has(e.to)) {
        rank.set(e.to, Math.max(rank.get(e.to)!, rank.get(e.from)! + 1));
      }
    }
  }
  const rows: GraphNode[][] = [];
  for (const n of main) (rows[rank.get(n.id)!] ??= []).push(n);

  const w = Math.max(
    150,
    ...group.nodes.map((n) => textWidth(n.label, SIZE.label) + 44),
  );
  const boxes = new Map<string, Box>();
  const hasEntry = edges.some((e) => e.from === GRAPH_START && ids.has(e.to));
  let y = top + (hasEntry ? ENTRY : 0) + BOX_H / 2;
  for (const row of rows) {
    if (!row) continue;
    const total = row.length * w + (row.length - 1) * SIBLING_GAP;
    row.forEach((n, i) => {
      boxes.set(n.id, {
        node: n,
        x: -total / 2 + w / 2 + i * (w + SIBLING_GAP),
        y,
        w,
        noteSide: row.length > 1 ? "below" : "right",
      });
    });
    // Failure boxes beside the rightmost box of their row.
    let right = -total / 2 + total;
    for (const n of group.nodes) {
      const from = side.get(n.id);
      if (!from || !row.some((m) => m.id === from)) continue;
      boxes.set(n.id, {
        node: n,
        x: right + SIDE_GAP + w / 2,
        y,
        w,
        noteSide: "right",
      });
      right += SIDE_GAP + w;
    }
    const below = row.some((n) => n.note) && row.length > 1;
    y += BOX_H + ROW_GAP + (below ? NOTE_BELOW : 0);
  }
  // Failure boxes whose source is itself a failure box: below it.
  for (const n of group.nodes) {
    if (boxes.has(n.id)) continue;
    const from = boxes.get(side.get(n.id) ?? "");
    boxes.set(n.id, {
      node: n,
      x: from ? from.x : 0,
      y: from ? from.y + BOX_H + ROW_GAP : y,
      w,
      noteSide: "right",
    });
  }

  // Notes go left of boxes that have something on their right: a failure
  // box, or a retry arriving from the right.
  for (const b of boxes.values()) {
    if (b.noteSide === "below") continue;
    const crowded = [...side.values()].includes(b.node.id) ||
      inner.some((e) => e.back && e.to === b.node.id);
    if (crowded) b.noteSide = "left";
  }
  const last = Math.max(...[...boxes.values()].map((b) => b.y));
  const below = [...boxes.values()].some((b) =>
    b.y === last && b.noteSide === "below" && b.node.note
  );
  return { boxes, bottom: last + BOX_H / 2 + (below ? NOTE_BELOW : 0) };
}

function drawBox(c: Canvas, b: Box) {
  const p = c.p;
  const n = b.node;
  const colours = n.kind === "highlight"
    ? p.highlight
    : n.kind === "failure"
    ? p.failure
    : p.node;
  const x = b.x - b.w / 2;
  const y = b.y - BOX_H / 2;
  c.ext.add(x, y, x + b.w, y + BOX_H);
  const width = n.kind === "highlight" ? 2.5 : 1.5;
  c.boxes.push(
    `<rect x="${r(x)}" y="${r(y)}" width="${r(b.w)}" height="${BOX_H}" rx="4"` +
      ` fill="${colours.fill}" stroke="${colours.stroke}" stroke-width="${width}"` +
      (n.kind === "dashed" ? ` stroke-dasharray="6 4"` : "") + `/>`,
  );
  if (n.nested) {
    c.boxes.push(
      `<rect x="${r(x + 4)}" y="${r(y + 4)}" width="${r(b.w - 8)}" height="${
        BOX_H - 8
      }" rx="2" fill="none" stroke="${colours.stroke}" stroke-width="1"/>`,
    );
  }
  c.text(b.x, b.y + SIZE.label * 0.35, n.label, {
    size: SIZE.label,
    fill: colours.text,
    anchor: "middle",
    bold: n.kind === "highlight",
    layer: "boxes",
  });
  if (n.note) {
    const ny = b.y + SIZE.note * 0.35;
    if (b.noteSide === "right") {
      c.text(b.x + b.w / 2 + NOTE_GAP, ny, n.note, {
        size: SIZE.note,
        fill: p.note,
      });
    } else if (b.noteSide === "left") {
      // Past the loop, when there is one on this side.
      const loopRoom = n.loop?.length ? LOOP_ROOM : 0;
      c.text(b.x - b.w / 2 - NOTE_GAP - loopRoom, ny, n.note, {
        size: SIZE.note,
        fill: p.note,
        anchor: "end",
      });
    } else {
      c.text(b.x, b.y + BOX_H / 2 + 16, n.note, {
        size: SIZE.note,
        fill: p.note,
        anchor: "middle",
      });
    }
  }
  if (n.loop?.length) {
    // An arc out of the box's left side and back in, with its methods.
    const lx = b.x - b.w / 2;
    const d = `M${r(lx)},${r(b.y - 7)} C${r(lx - 90)},${r(b.y - 48)} ${
      r(lx - 90)
    },${r(b.y + 48)} ${r(lx + 1)},${r(b.y + 7)}`;
    c.path(d, "loop", [[lx - 70, b.y - 36], [lx - 70, b.y + 36]]);
    c.edgeLabel(lx - 78, b.y - 30, "loop ↺", "loop", "end");
    c.edgeLabel(lx - 78, b.y + 40, n.loop.join(" · "), "loop", "end");
  }
}

/** Draw a Graph as a standalone SVG in the given mode. */
export function renderSvg(graph: Graph, mode: "dark" | "light"): string {
  const p = PALETTES[mode];
  const c = new Canvas(p);
  const boxes = new Map<string, Box>();
  const frames = new Map<string, { top: number; bottom: number }>();

  let top = 0;
  for (const g of graph.groups) {
    const framed = !!g.label;
    const laid = layoutGroup(g, graph.edges, top + (framed ? 46 : 0));
    for (const [k, v] of laid.boxes) boxes.set(k, v);
    const bottom = laid.bottom + (framed ? 24 : 0);
    if (g.id) frames.set(g.id, { top, bottom });
    top = bottom + 70;
  }

  // Edges.
  const byPair = (a: string, b: string) =>
    graph.edges.filter((e) =>
      (e.from === a && e.to === b) || (e.from === b && e.to === a)
    );
  let rightLane = 0;
  let leftLane = 0;
  const boxList = [...boxes.values()];
  const extentBetween = (y1: number, y2: number, side: "left" | "right") => {
    const lo = Math.min(y1, y2), hi = Math.max(y1, y2);
    const inRange = boxList.filter((b) => b.y >= lo - 1 && b.y <= hi + 1);
    if (side === "right") {
      return Math.max(
        ...inRange.map((b) =>
          b.x + b.w / 2 +
          (b.noteSide === "right" && b.node.note
            ? NOTE_GAP + textWidth(b.node.note, SIZE.note)
            : 0)
        ),
      );
    }
    return Math.min(
      ...inRange.map((b) =>
        b.x - b.w / 2 -
        (b.noteSide === "left" && b.node.note
          ? NOTE_GAP + textWidth(b.node.note, SIZE.note)
          : 0) -
        (b.node.loop?.length ? LOOP_ROOM : 0)
      ),
    );
  };

  for (const e of graph.edges) {
    const label = e.label ?? "";
    if (e.from === GRAPH_START) {
      const t = boxes.get(e.to);
      if (!t) continue;
      const y1 = t.y - BOX_H / 2 - ENTRY;
      c.path(`M${r(t.x)},${r(y1)} V${r(t.y - BOX_H / 2)}`, e.role, [[
        t.x,
        y1,
      ]]);
      c.edgeLabel(t.x + 10, y1 + 16, label, e.role);
      continue;
    }
    if (e.to === GRAPH_END) {
      const s = boxes.get(e.from);
      if (!s) continue;
      const y1 = s.y + BOX_H / 2;
      c.path(`M${r(s.x)},${r(y1)} V${r(y1 + ENTRY)}`, e.role, [[
        s.x,
        y1 + ENTRY,
      ]]);
      c.edgeLabel(s.x + 10, y1 + ENTRY / 2 + 4, label, e.role);
      continue;
    }
    const s = boxes.get(e.from);
    const t = boxes.get(e.to);
    if (!s || !t) continue;
    const sameRow = Math.abs(s.y - t.y) < 1;

    if (sameRow) {
      // Side by side: straight across, one line each way when both exist.
      const pair = byPair(e.from, e.to).length > 1;
      const dir = t.x > s.x ? 1 : -1;
      const off = pair ? (dir > 0 ? -6 : 6) : 0;
      const x1 = s.x + dir * s.w / 2;
      const x2 = t.x - dir * t.w / 2;
      const yy = s.y + off;
      c.path(`M${r(x1)},${r(yy)} H${r(x2)}`, e.role, [[x1, yy], [x2, yy]]);
      c.edgeLabel(
        (x1 + x2) / 2,
        off > 0 ? yy + 17 : yy - 8,
        label,
        e.role,
        "middle",
      );
      continue;
    }

    if (e.back || t.y < s.y) {
      if (s.x - s.w / 2 > t.x + t.w / 2) {
        // From a box on the right up into the side of an earlier box.
        const x2 = t.x + t.w / 2;
        const y1 = s.y - BOX_H / 2;
        c.path(
          `M${r(s.x)},${r(y1)} C${r(s.x)},${r(t.y + (y1 - t.y) * 0.15)} ${
            r(s.x - (s.x - x2) * 0.25)
          },${r(t.y)} ${r(x2 + 1)},${r(t.y)}`,
          e.role,
          [[s.x, y1], [x2, t.y]],
        );
        c.edgeLabel((s.x + x2) / 2 + 20, t.y - 10, label, e.role, "middle");
      } else {
        // Up a lane on the right.
        const lane = extentBetween(s.y, t.y, "right") + 30 + rightLane++ * 18;
        const x1 = s.x + s.w / 2, x2 = t.x + t.w / 2;
        c.path(
          `M${r(x1)},${r(s.y)} H${r(lane)} V${r(t.y)} H${r(x2 + 1)}`,
          e.role,
          [[x1, s.y], [lane, s.y], [lane, t.y]],
        );
        c.edgeLabel(lane + 8, (s.y + t.y) / 2, label, e.role);
      }
      continue;
    }

    const spansRows = boxList.some((b) =>
      b.y > s.y + 1 && b.y < t.y - 1 && Math.abs(b.x - s.x) < b.w
    );
    if (spansRows) {
      // Skips boxes in between: down a lane on the left.
      const lane = extentBetween(s.y, t.y, "left") - 30 - leftLane++ * 18;
      const x1 = s.x - s.w / 2, x2 = t.x - t.w / 2;
      c.path(
        `M${r(x1)},${r(s.y)} H${r(lane)} V${r(t.y)} H${r(x2 - 1)}`,
        e.role,
        [[x1, s.y], [lane, s.y], [lane, t.y]],
      );
      c.edgeLabel(lane - 8, (s.y + t.y) / 2, label, e.role, "end");
      continue;
    }

    const y1 = s.y + BOX_H / 2;
    const y2 = t.y - BOX_H / 2;
    if (Math.abs(s.x - t.x) < 1) {
      c.path(`M${r(s.x)},${r(y1)} V${r(y2)}`, e.role, [[s.x, y1], [t.x, y2]]);
      c.edgeLabel(s.x + 10, (y1 + y2) / 2 + 4, label, e.role);
    } else {
      // Fan out or in: down, across, down.
      const notesBelow = s.noteSide === "below" && s.node.note ? NOTE_BELOW : 0;
      const mid = y1 + notesBelow + (y2 - y1 - notesBelow) / 2;
      c.path(
        `M${r(s.x)},${r(y1 + notesBelow)} V${r(mid)} H${r(t.x)} V${r(y2)}`,
        e.role,
        [[s.x, y1], [t.x, mid], [t.x, y2]],
      );
      c.edgeLabel(t.x + 8, (mid + y2) / 2 + 4, label, e.role);
    }
  }

  for (const b of boxes.values()) drawBox(c, b);

  // Job frames, around their boxes and notes, and arrows between jobs.
  const frameRects = new Map<
    string,
    { x: number; y: number; w: number; h: number }
  >();
  for (const g of graph.groups) {
    if (!g.label || !g.id) continue;
    const f = frames.get(g.id)!;
    const own = g.nodes.map((n) => boxes.get(n.id)!).filter(Boolean);
    const minX = Math.min(
      ...own.map((b) =>
        b.x - b.w / 2 -
        (b.noteSide === "left" && b.node.note
          ? NOTE_GAP + textWidth(b.node.note, SIZE.note)
          : 0)
      ),
      ...own.map((b) =>
        b.noteSide === "below" && b.node.note
          ? b.x - textWidth(b.node.note, SIZE.note) / 2
          : Infinity
      ),
      -textWidth(g.label, SIZE.note) / 2,
    ) - 24;
    const maxX = Math.max(
      ...own.map((b) =>
        b.x + b.w / 2 +
        (b.noteSide === "right" && b.node.note
          ? NOTE_GAP + textWidth(b.node.note, SIZE.note)
          : 0)
      ),
      ...own.map((b) =>
        b.noteSide === "below" && b.node.note
          ? b.x + textWidth(b.node.note, SIZE.note) / 2
          : -Infinity
      ),
      textWidth(g.label, SIZE.note) / 2,
    ) + 24;
    const rect = { x: minX, y: f.top, w: maxX - minX, h: f.bottom - f.top };
    frameRects.set(g.id, rect);
    c.ext.add(rect.x, rect.y, rect.x + rect.w, rect.y + rect.h);
    c.frames.push(
      `<rect x="${r(rect.x)}" y="${r(rect.y)}" width="${r(rect.w)}" height="${
        r(rect.h)
      }" rx="8" fill="none" stroke="${p.frame}" stroke-width="1" stroke-dasharray="4 4"/>`,
    );
    c.text(rect.x + 14, rect.y + 22, g.label, {
      size: SIZE.note,
      fill: p.note,
    });
  }
  for (const e of graph.groupEdges ?? []) {
    const a = frameRects.get(e.from), b = frameRects.get(e.to);
    if (!a || !b) continue;
    const y1 = a.y + a.h, y2 = b.y;
    c.path(`M0,${r(y1)} V${r(y2)}`, e.role, [[0, y1], [0, y2]]);
    if (e.label) c.edgeLabel(10, (y1 + y2) / 2 + 4, e.label, e.role);
  }

  // Title and subtitle, centred over the drawing.
  const cx = (c.ext.minX + c.ext.maxX) / 2;
  const sub = graph.subtitle ? wrap(graph.subtitle, 72) : [];
  let ty = c.ext.minY - 28 - sub.length * 19;
  const titleAt = ty;
  c.ext.text(cx, ty, graph.title, SIZE.title, "middle");
  for (const line of sub) {
    ty += 19;
    c.text(cx, ty + 6, line, {
      size: SIZE.subtitle,
      fill: p.subtitle,
      anchor: "middle",
    });
  }

  const pad = 24;
  const vx = c.ext.minX - pad, vy = c.ext.minY - pad;
  const vw = c.ext.maxX - c.ext.minX + pad * 2;
  const vh = c.ext.maxY - c.ext.minY + pad * 2;
  const markers = (Object.keys(p.edge) as EdgeRole[]).map((role) =>
    `<marker id="arrow-${role}" viewBox="0 0 10 10" refX="9" refY="5" markerUnits="userSpaceOnUse" markerWidth="10" markerHeight="10" orient="auto-start-reverse"><path d="M0,1 L10,5 L0,9 z" fill="${
      p.edge[role]
    }"/></marker>`
  ).join("");
  const glow = p.glow
    ? `<filter id="glow" x="-20%" y="-50%" width="140%" height="200%"><feGaussianBlur stdDeviation="4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`
    : "";
  const title =
    `<text x="${r(cx)}" y="${r(titleAt)}" font-size="${SIZE.title}"` +
    ` font-weight="bold" fill="${p.title}" text-anchor="middle"` +
    (p.glow ? ` filter="url(#glow)"` : "") + `>${esc(graph.title)}</text>`;
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${r(vx)} ${r(vy)} ${
      r(vw)
    } ${r(vh)}" width="${Math.ceil(vw)}" height="${Math.ceil(vh)}"` +
    ` font-family="${FONT}" role="img" aria-label="${esc(graph.title)}">`,
    `<defs>${markers}${glow}</defs>`,
    title,
    ...c.frames,
    ...c.edges,
    ...c.boxes,
    ...c.labels,
    `</svg>`,
    "",
  ].join("\n");
}
