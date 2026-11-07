// The drawing-independent form of a diagram: boxes, the arrows between them,
// and the groups (workflow jobs) they sit in. State machines and workflows
// are turned into this, and the SVG renderer lays it out.

import type { EdgeRole } from "./mermaid.ts";

/** An arrow from nowhere into the first box (a hidden entry phase). */
export const GRAPH_START = "\u0000start";
/** An arrow out of a box to nowhere (a hidden exit phase). */
export const GRAPH_END = "\u0000end";

/** How a box is drawn. */
export type NodeKind = "normal" | "highlight" | "failure" | "dashed";

/** A box: a phase or a workflow step. */
export interface GraphNode {
  id: string;
  label: string;
  /** Shown beside the box: a phase's note, or what a step runs. */
  note?: string;
  /** Methods that keep the phase where it is, drawn as a loop beside it. */
  loop?: string[];
  kind: NodeKind;
  /** A step that runs another workflow. */
  nested?: boolean;
}

/** An arrow. */
export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  role: EdgeRole;
  /** A step back to an earlier box (a retry), routed around the others. */
  back?: boolean;
}

/** A set of boxes drawn together, framed when it has a label (a job). */
export interface GraphGroup {
  id?: string;
  label?: string;
  nodes: GraphNode[];
}

/** A whole diagram. */
export interface Graph {
  title: string;
  subtitle?: string;
  groups: GraphGroup[];
  edges: GraphEdge[];
  /** Arrows between groups (job dependencies), by group id. */
  groupEdges?: GraphEdge[];
}
