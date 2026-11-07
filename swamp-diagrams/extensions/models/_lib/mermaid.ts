// Shared pieces for writing Mermaid flowcharts: label escaping, node IDs,
// colour palettes and the frontmatter that carries the title and theme.

/**
 * Colour scheme for a diagram. `auto` uses mid-tone colours and transparent
 * fills that read on light and dark pages alike, and leaves the base theme to
 * the viewer (GitHub draws it to match the reader's mode). `none` leaves
 * Mermaid's own theme alone and colours nothing.
 */
export type Theme = "auto" | "dark" | "light" | "none";

/** Layout direction: top-down or left-to-right. */
export type Direction = "TD" | "LR";

/** The roles a node or edge can play, each with its own colours. */
export interface Palette {
  background: string;
  text: string;
  muted: string;
  node: { fill: string; stroke: string; text: string };
  highlight: { fill: string; stroke: string; text: string };
  failure: { fill: string; stroke: string; text: string };
  edge: string;
  loop: string;
  human: string;
  fail: string;
  skip: string;
}

const PALETTES: Record<"auto" | "dark" | "light", Palette> = {
  // Mid-tones with contrast on both white and GitHub's dark background.
  auto: {
    background: "transparent",
    text: "#6b7280",
    muted: "#9ca3af",
    node: { fill: "transparent", stroke: "#14b8a6", text: "" },
    highlight: { fill: "#22c55e33", stroke: "#22c55e", text: "" },
    failure: { fill: "#ef444426", stroke: "#ef4444", text: "" },
    edge: "#3b82f6",
    loop: "#f59e0b",
    human: "#22c55e",
    fail: "#ef4444",
    skip: "#9ca3af",
  },
  dark: {
    background: "#0b0f0e",
    text: "#d1d5db",
    muted: "#9ca3af",
    node: { fill: "#0f1f1c", stroke: "#2dd4bf", text: "#5eead4" },
    highlight: { fill: "#14532d", stroke: "#4ade80", text: "#bbf7d0" },
    failure: { fill: "#1f0f0f", stroke: "#f87171", text: "#fca5a5" },
    edge: "#60a5fa",
    loop: "#f59e0b",
    human: "#4ade80",
    fail: "#f87171",
    skip: "#9ca3af",
  },
  light: {
    background: "#ffffff",
    text: "#1f2937",
    muted: "#6b7280",
    node: { fill: "#ecfdf5", stroke: "#0d9488", text: "#134e4a" },
    highlight: { fill: "#dcfce7", stroke: "#16a34a", text: "#14532d" },
    failure: { fill: "#fef2f2", stroke: "#dc2626", text: "#7f1d1d" },
    edge: "#2563eb",
    loop: "#d97706",
    human: "#16a34a",
    fail: "#dc2626",
    skip: "#6b7280",
  },
};

/** The palette for a theme (`none` uses the light one). */
export function palette(theme: Theme): Palette {
  return PALETTES[theme === "none" ? "light" : theme];
}

/** Background colour to render an image on. */
export function background(theme: Theme): string {
  if (theme === "dark") return PALETTES.dark.background;
  return theme === "auto" ? "transparent" : "white";
}

/** Escape text for use inside a quoted Mermaid label. */
export function escapeLabel(text: string): string {
  return text
    .replace(/&/g, "#amp;")
    .replace(/"/g, "#quot;")
    .replace(/</g, "#lt;")
    .replace(/>/g, "#gt;")
    .replace(/\|/g, "#124;")
    .replace(/\r?\n/g, " ");
}

/** A node label with an optional smaller second line. */
export function nodeLabel(
  main: string,
  ...details: (string | undefined)[]
): string {
  const head = escapeLabel(main);
  const rest = details.filter((d): d is string => !!d)
    .map((d) => `<br/><small>${escapeLabel(d)}</small>`).join("");
  return `"${head}${rest}"`;
}

/** A Mermaid-safe node ID built from arbitrary text. */
export function nodeId(prefix: string, text: string): string {
  return `${prefix}_${text.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** Frontmatter with the title and, unless `none`, the theme variables. */
export function frontmatter(title: string, theme: Theme): string[] {
  const lines = ["---", `title: ${JSON.stringify(title)}`];
  if (theme === "auto") {
    // No base theme, so the viewer's light or dark one applies; only straight
    // edges and spacing are set. The font is left to the viewer too: a font
    // the renderer hasn't loaded when it measures labels clips them.
    lines.push(
      "config:",
      "  flowchart:",
      "    padding: 20",
      "    curve: linear",
      "    nodeSpacing: 40",
      "    rankSpacing: 45",
      "    wrappingWidth: 320",
      "    subGraphTitleMargin:",
      "      top: 4",
      "      bottom: 12",
    );
  } else if (theme !== "none") {
    const p = palette(theme);
    lines.push(
      "config:",
      "  theme: base",
      "  themeVariables:",
      `    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace"`,
      `    background: "${p.background}"`,
      `    primaryColor: "${p.node.fill}"`,
      `    primaryBorderColor: "${p.node.stroke}"`,
      `    primaryTextColor: "${p.node.text}"`,
      `    lineColor: "${p.edge}"`,
      `    textColor: "${p.text}"`,
      `    titleColor: "${p.highlight.stroke}"`,
      `    edgeLabelBackground: "${p.background}"`,
      `    clusterBkg: "${p.background}"`,
      `    clusterBorder: "${p.muted}"`,
      "  flowchart:",
      "    curve: linear",
      "    htmlLabels: true",
    );
  }
  lines.push("---");
  return lines;
}

/** classDef lines for the node roles, or nothing for theme `none`. */
export function classDefs(theme: Theme): string[] {
  if (theme === "none") {
    return [
      "  classDef highlight stroke-width:3px",
      "  classDef failure stroke-dasharray:0",
      "  classDef dot stroke-width:0",
      "  classDef dashed stroke-dasharray:5 3",
    ];
  }
  const p = palette(theme);
  // An empty text colour keeps the viewer's own (auto theme).
  const role = (name: string, c: Palette["node"], extra = "") =>
    `  classDef ${name} fill:${c.fill},stroke:${c.stroke}${
      c.text ? `,color:${c.text}` : ""
    },stroke-width:1.5px${extra}`;
  return [
    role("state", p.node),
    // No bold: Mermaid sizes boxes before class styles apply, so bold text
    // would overflow its box. A thicker border does the emphasis.
    role("highlight", p.highlight, ",stroke-width:3px"),
    role("failure", p.failure),
    `  classDef dot fill:${p.edge},stroke:${p.edge},color:${p.edge}`,
    role("dashed", p.node, ",stroke-dasharray:5 3"),
  ];
}

/** How an edge is drawn: plain, a self-loop, a human gate, a failure or retry path, or a skip. */
export type EdgeRole = "normal" | "loop" | "human" | "fail" | "skip";

/** The arrow for an edge role. */
export function arrow(role: EdgeRole): string {
  if (role === "human") return "==>";
  if (role === "skip") return "-.->";
  return "-->";
}

/** A linkStyle line colouring edge number `index`, or nothing for theme `none`. */
export function linkStyle(
  index: number,
  role: EdgeRole,
  theme: Theme,
): string | undefined {
  if (theme === "none") return undefined;
  const p = palette(theme);
  const colour = {
    normal: p.edge,
    loop: p.loop,
    human: p.human,
    fail: p.fail,
    skip: p.skip,
  }[role];
  const width = role === "human" ? "3px" : "1.5px";
  // auto: labels keep the viewer's text colour, which reads on GitHub's
  // light and dark label boxes; the line colour carries the meaning.
  const label = theme === "auto" ? "" : `,color:${colour}`;
  return `  linkStyle ${index} stroke:${colour},stroke-width:${width}${label}`;
}

/** Wrap a diagram in a Markdown file: heading, optional note, fenced block. */
export function toMarkdown(
  title: string,
  mermaid: string,
  note?: string,
): string {
  const parts = [`# ${title}`, ""];
  if (note) parts.push(note, "");
  parts.push("```mermaid", mermaid.trimEnd(), "```", "");
  return parts.join("\n");
}

const BEGIN = /<!--\s*swamp-diagram:\s*([A-Za-z0-9_.-]+)\s*-->/g;
const END = "<!-- /swamp-diagram -->";

/** Character ranges of fenced code blocks (``` or ~~~), so markers shown as examples are ignored. */
function fencedRanges(text: string): [number, number][] {
  const ranges: [number, number][] = [];
  let open: { at: number; fence: string } | undefined;
  let pos = 0;
  for (const line of text.split("\n")) {
    const m = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (m) {
      if (!open) open = { at: pos, fence: m[1] };
      else if (m[1][0] === open.fence[0] && m[1].length >= open.fence.length) {
        ranges.push([open.at, pos + line.length]);
        open = undefined;
      }
    }
    pos += line.length + 1;
  }
  if (open) ranges.push([open.at, text.length]);
  return ranges;
}

/** The `swamp-diagram` start markers for `name` outside code blocks. */
function markers(text: string, name: string): RegExpMatchArray[] {
  const fenced = fencedRanges(text);
  return [...text.matchAll(BEGIN)].filter((m) =>
    m[1] === name && !fenced.some(([a, b]) => m.index! >= a && m.index! < b)
  );
}

/** Whether `text` has a `swamp-diagram` block for `name` (outside code blocks). */
export function hasBlock(text: string, name: string): boolean {
  return markers(text, name).length > 0;
}

/** A fenced mermaid code block. */
export function mermaidBlock(mermaid: string): string {
  return "```mermaid\n" + mermaid.trimEnd() + "\n```";
}

/** A <picture> showing `<base>-dark.svg` in dark mode, `<base>-light.svg` otherwise. */
export function pictureBlock(base: string, alt: string): string {
  const a = alt.replace(/&/g, "&amp;").replace(/"/g, "&quot;")
    .replace(/</g, "&lt;");
  return [
    "<picture>",
    `  <source media="(prefers-color-scheme: dark)" srcset="${base}-dark.svg">`,
    `  <img alt="${a}" src="${base}-light.svg">`,
    "</picture>",
  ].join("\n");
}

/**
 * Replace the body of every `<!-- swamp-diagram: <name> -->` …
 * `<!-- /swamp-diagram -->` block for `name` in `text` with `body` (a
 * mermaidBlock or pictureBlock). Markers inside code blocks are examples and
 * are left alone. Returns the text unchanged when it has no such block.
 */
export function embed(text: string, name: string, body: string): string {
  let out = "";
  let last = 0;
  for (const m of markers(text, name)) {
    const start = m.index! + m[0].length;
    const end = text.indexOf(END, start);
    if (end < 0) throw new Error(`swamp-diagram: ${name} has no ${END}`);
    out += text.slice(last, start) + "\n\n" + body.trimEnd() + "\n\n";
    last = end;
  }
  return last === 0 ? text : out + text.slice(last);
}
