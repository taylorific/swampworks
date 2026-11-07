// Parse a behavior's phase machine written as transition lines and draw it as
// a Mermaid flowchart.
//
// The notation is the one swamp extensions use in their descriptions, e.g.
// @swamp/issue-lifecycle:
//
//   created ──[start]──> triaging
//   plan_generated ──[iterate]──> plan_generated  (feedback loop)
//
// ASCII dashes work too: `a --[method]--> b`. Lines that don't match are
// ignored, so a whole README or registry description can be passed in.

import {
  arrow,
  classDefs,
  type Direction,
  type EdgeRole,
  escapeLabel,
  frontmatter,
  linkStyle,
  nodeId,
  nodeLabel,
  type Theme,
} from "./mermaid.ts";

/** One transition: running `method` in phase `from` moves to phase `to`. */
export interface Transition {
  from: string;
  to: string;
  method: string;
  comment?: string;
}

const LINE =
  /^\s*([A-Za-z0-9_.-]+)\s*[─—–-]+\s*\[\s*([^\]]+?)\s*\]\s*[─—–-]+>\s*([A-Za-z0-9_.-]+)\s*(?:\((.*)\))?\s*$/;

/** Every transition line found in `text`, in order. */
export function parseTransitions(text: string): Transition[] {
  const out: Transition[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = LINE.exec(line);
    if (!m) continue;
    const t: Transition = { from: m[1], method: m[2], to: m[3] };
    if (m[4]?.trim()) t.comment = m[4].trim();
    out.push(t);
  }
  return out;
}

/** Options that shape the drawing; all are optional. */
export interface StateMachineOptions {
  title: string;
  theme: Theme;
  direction: Direction;
  /** Phases left out; transitions into or out of them become entry or exit arrows. */
  hideStates: string[];
  /** Phases skipped over: each way in is joined to each way out, under the outgoing method. */
  collapseStates: string[];
  /** Methods whose transitions are left out. */
  omitMethods: string[];
  /** Methods only a person may run: drawn as thick green arrows. */
  humanGates: string[];
  /** Phases drawn emphasised, in addition to the final ones. */
  highlightStates: string[];
  /** Phases drawn as failures, in addition to any whose name contains "fail". */
  failureStates: string[];
  /** A short note shown under a phase's name. */
  notes: Record<string, string>;
  /** Append each transition's parenthetical comment to its label. */
  showComments: boolean;
}

/** What was drawn, for the resource record. */
export interface StateMachineDiagram {
  mermaid: string;
  states: string[];
  transitions: number;
}

interface Edge {
  from: string;
  to: string;
  labels: string[];
  role: EdgeRole;
}

const START = "__start";
const END = "__end";

/**
 * Skip over each phase in `states`: every transition into it is joined to
 * every transition out of it (labelled with the outgoing method), and its
 * self-loops and any round trips back to where they started are dropped.
 */
export function collapse(
  transitions: Transition[],
  states: string[],
): Transition[] {
  let out = transitions;
  for (const s of states) {
    const into = out.filter((t) => t.to === s && t.from !== s);
    const from = out.filter((t) => t.from === s && t.to !== s);
    const joined: Transition[] = [];
    for (const a of into) {
      for (const b of from) {
        if (a.from === b.to) continue;
        if (
          !joined.some((j) =>
            j.from === a.from && j.to === b.to && j.method === b.method
          )
        ) joined.push({ from: a.from, to: b.to, method: b.method });
      }
    }
    const rest = out.filter((t) => t.from !== s && t.to !== s);
    // Keep the joined transitions where the first way in was written.
    const at = out.findIndex((t) => t.to === s || t.from === s);
    const before = out.slice(0, at).filter((t) => rest.includes(t));
    const after = rest.filter((t) => !before.includes(t));
    out = [...before, ...joined, ...after];
  }
  return out;
}

/** Draw the transitions as a Mermaid flowchart. */
export function renderStateMachine(
  transitions: Transition[],
  opts: StateMachineOptions,
): StateMachineDiagram {
  if (transitions.length === 0) {
    throw new Error(
      "No transitions found. Expected lines like 'created ──[start]──> triaging'",
    );
  }
  const hidden = new Set(opts.hideStates);
  const omitted = new Set(opts.omitMethods);
  const human = new Set(opts.humanGates);
  const kept = collapse(
    transitions.filter((t) => !omitted.has(t.method)),
    opts.collapseStates,
  );

  // Phases in the order they first appear, without the hidden ones.
  const states: string[] = [];
  for (const t of kept) {
    for (const s of [t.from, t.to]) {
      if (!hidden.has(s) && !states.includes(s)) states.push(s);
    }
  }

  // An edge is a step back (a retry) when it returns to a phase that is still
  // on the depth-first path from the entry phases, following transitions in
  // the order they are written.
  const visible = kept.filter((t) => !hidden.has(t.from) && !hidden.has(t.to));
  const incoming = new Set(
    visible.filter((t) => t.from !== t.to).map((t) => t.to),
  );
  const entries = kept.filter((t) => hidden.has(t.from) && !hidden.has(t.to))
    .map((t) => t.to);
  const roots = [
    ...new Set([
      ...entries,
      ...states.filter((s) => !incoming.has(s)),
      ...states,
    ]),
  ];
  const back = new Set<Transition>();
  const done = new Set<string>();
  const onPath = new Set<string>();
  const visit = (s: string) => {
    onPath.add(s);
    for (const t of visible) {
      if (t.from !== s || t.to === s) continue;
      if (onPath.has(t.to)) back.add(t);
      else if (!done.has(t.to)) visit(t.to);
    }
    onPath.delete(s);
    done.add(s);
  };
  for (const r of roots) if (!done.has(r)) visit(r);

  const isFailure = (s: string) =>
    opts.failureStates.includes(s) || /fail/i.test(s);
  const outgoing = new Set(
    visible.filter((t) => t.from !== t.to).map((t) => t.from),
  );
  for (const t of kept) {
    if (!hidden.has(t.from) && hidden.has(t.to)) outgoing.add(t.from);
  }
  const finals = new Set(states.filter((s) => !outgoing.has(s)));

  // Collapse transitions that share endpoints and role into one edge.
  const edges: Edge[] = [];
  for (const t of kept) {
    let from = t.from;
    let to = t.to;
    if (hidden.has(from) && hidden.has(to)) continue;
    if (hidden.has(from)) from = START;
    if (hidden.has(to)) to = END;
    let role: EdgeRole = "normal";
    if (from === to) role = "loop";
    else if (human.has(t.method)) role = "human";
    else if (isFailure(to)) role = "fail";
    else if (back.has(t)) role = "fail";
    let label = t.method;
    if (opts.showComments && t.comment) label += ` (${t.comment})`;
    if (back.has(t) && !isFailure(to)) {
      label += " (retry)";
    }
    const same = edges.find((e) =>
      e.from === from && e.to === to && e.role === role
    );
    if (same) {
      if (!same.labels.includes(label)) same.labels.push(label);
    } else edges.push({ from, to, labels: [label], role });
  }

  const id = (s: string) => s === START || s === END ? s : nodeId("st", s);
  const lines = [...frontmatter(opts.title, opts.theme)];
  lines.push(`flowchart ${opts.direction}`);
  if (edges.some((e) => e.from === START)) {
    lines.push(`  ${START}(( )):::dot`);
  }
  if (edges.some((e) => e.to === END)) lines.push(`  ${END}(( )):::dot`);
  for (const s of states) {
    const cls = isFailure(s)
      ? "failure"
      : finals.has(s) || opts.highlightStates.includes(s)
      ? "highlight"
      : "state";
    // Self-loops read better as a line in the box than as an arc around it.
    const loop = edges.filter((e) => e.role === "loop" && e.from === s)
      .flatMap((e) => e.labels);
    const loopText = loop.length ? `↺ ${loop.join(" · ")}` : undefined;
    lines.push(
      `  ${id(s)}(${nodeLabel(s, opts.notes[s], loopText)}):::${cls}`,
    );
  }

  const styles: string[] = [];
  edges.filter((e) => e.role !== "loop").forEach((e, i) => {
    const sep = e.role === "loop" ? " · " : " / ";
    let text = e.labels.join(sep);
    if (e.role === "loop") text = `↺ ${text}`;
    lines.push(
      `  ${id(e.from)} ${arrow(e.role)}|"${escapeLabel(text)}"| ${id(e.to)}`,
    );
    const style = linkStyle(i, e.role, opts.theme);
    if (style) styles.push(style);
  });

  lines.push(...classDefs(opts.theme), ...styles);
  return {
    mermaid: lines.join("\n") + "\n",
    states,
    transitions: kept.length,
  };
}
