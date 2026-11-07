// Draw a swamp workflow (the YAML in workflows/) as a Mermaid flowchart:
// each job is a box of its steps, and each dependsOn is an arrow labelled
// with its condition when that isn't plain "succeeded".

import { parse } from "jsr:@std/yaml@1.2.0";
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
import type { Graph, GraphEdge, GraphGroup } from "./graph.ts";

/** The parts of a workflow file the diagram uses. */
export interface WorkflowDoc {
  id?: string;
  name: string;
  description?: string;
  trigger?: { schedule?: string };
  jobs: JobDoc[];
}

interface Dependency {
  job?: string;
  step?: string;
  condition?: Record<string, unknown>;
}

interface JobDoc {
  name: string;
  description?: string;
  dependsOn?: Dependency[];
  labels?: Record<string, string>;
  steps?: StepDoc[];
}

interface StepDoc {
  name: string;
  description?: string;
  task?: Record<string, unknown>;
  dependsOn?: Dependency[];
  allowFailure?: boolean;
  guard?: string;
  forEach?: Record<string, unknown>;
}

/** Parse a workflow YAML file, checking it has a name and jobs. */
export function parseWorkflow(text: string, source: string): WorkflowDoc {
  const doc = parse(text) as Partial<WorkflowDoc> | null;
  if (!doc || typeof doc !== "object" || typeof doc.name !== "string") {
    throw new Error(`${source} is not a swamp workflow (no name)`);
  }
  if (!Array.isArray(doc.jobs)) {
    throw new Error(`${source} is not a swamp workflow (no jobs)`);
  }
  return doc as WorkflowDoc;
}

/** One line saying what a step's task runs. */
export function describeTask(task: Record<string, unknown> | undefined): {
  text: string;
  human: boolean;
} {
  const str = (k: string) =>
    typeof task?.[k] === "string" ? task[k] as string : undefined;
  switch (task?.type) {
    case "behavior":
    case "model_method": {
      const who = str("behavior") ?? str("modelIdOrName") ??
        str("behaviorName") ??
        str("modelName") ?? str("behaviorType") ?? str("modelType") ?? "?";
      return { text: `${who} · ${str("methodName") ?? "?"}`, human: false };
    }
    case "workflow":
      return {
        text: `workflow ${str("workflowIdOrName") ?? "?"}`,
        human: false,
      };
    case "manual_approval":
      return { text: "manual approval", human: true };
    case "wait_for_signal":
      return { text: "waits for a signal", human: true };
    case "assert":
      return { text: "assert", human: false };
    default:
      return { text: String(task?.type ?? "no task"), human: false };
  }
}

/** A dependency condition as an edge label and role. */
export function describeCondition(
  condition: Record<string, unknown> | undefined,
): { label?: string; role: EdgeRole } {
  const type = condition?.type;
  if (type === undefined || type === "succeeded") return { role: "normal" };
  if (type === "failed") return { label: "failed", role: "fail" };
  if (type === "completed") return { label: "completed", role: "skip" };
  if (type === "skipped") return { label: "skipped", role: "skip" };
  // and / or / not / anything newer: show it compactly.
  const compact = JSON.stringify(condition).replace(/"/g, "");
  return { label: compact.length > 60 ? `${type}` : compact, role: "skip" };
}

/** What was drawn, for the resource record. */
export interface WorkflowDiagram {
  mermaid: string;
  jobs: number;
  steps: number;
}

/** Draw the workflow as a Mermaid flowchart. */
export function renderWorkflow(
  wf: WorkflowDoc,
  opts: { title?: string; theme: Theme; direction: Direction },
): WorkflowDiagram {
  const lines = [...frontmatter(opts.title || wf.name, opts.theme)];
  lines.push(`flowchart ${opts.direction}`);
  const edges: { line: string; role: EdgeRole }[] = [];
  const jobId = (j: string) => nodeId("job", j);
  const stepId = (j: string, s: string) =>
    nodeId(`s_${j.replace(/\W/g, "_")}`, s);
  let steps = 0;

  for (const job of wf.jobs) {
    // Only the name fits above the box; long titles overlap the first step.
    // Worker labels say where the job runs, e.g. on a worker role=kvm-host.
    const where = Object.entries(job.labels ?? {}).map(([k, v]) => `${k}=${v}`)
      .join(", ");
    const jobTitle = where ? `${job.name} · on worker ${where}` : job.name;
    lines.push(`  subgraph ${jobId(job.name)}["${escapeLabel(jobTitle)}"]`);
    lines.push(
      `    direction ${opts.direction === "TD" ? "TB" : opts.direction}`,
    );
    for (const step of job.steps ?? []) {
      steps++;
      const task = describeTask(step.task);
      const extras = [task.text];
      if (step.forEach) {
        const each = Object.entries(step.forEach).map(([k, v]) => `${k} ${v}`)
          .join(", ");
        extras.push(`for each: ${each}`);
      }
      if (step.guard) extras.push("guarded");
      if (step.allowFailure) extras.push("may fail");
      const cls = task.human
        ? "highlight"
        : step.allowFailure
        ? "dashed"
        : "state";
      const label = nodeLabel(step.name, extras.join(" · "));
      // Humans gate the run: a hexagon; nested workflows: a subroutine box.
      const shape = task.human
        ? `{{${label}}}`
        : step.task?.type === "workflow"
        ? `[[${label}]]`
        : `(${label})`;
      lines.push(`    ${stepId(job.name, step.name)}${shape}:::${cls}`);
      for (const dep of step.dependsOn ?? []) {
        if (!dep.step) continue;
        const c = describeCondition(dep.condition);
        const lbl = c.label ? `|"${escapeLabel(c.label)}"|` : "";
        edges.push({
          line: `  ${stepId(job.name, dep.step)} ${arrow(c.role)}${lbl} ${
            stepId(job.name, step.name)
          }`,
          role: c.role,
        });
      }
    }
    lines.push("  end");
    if (opts.theme !== "none") {
      // A light outline instead of the theme's filled cluster box.
      lines.push(
        `  style ${
          jobId(job.name)
        } fill:transparent,stroke:#9ca3af,stroke-width:1px,stroke-dasharray:4 3`,
      );
    }
    for (const dep of job.dependsOn ?? []) {
      if (!dep.job) continue;
      const c = describeCondition(dep.condition);
      const lbl = c.label ? `|"${escapeLabel(c.label)}"|` : "";
      edges.push({
        line: `  ${jobId(dep.job)} ${arrow(c.role)}${lbl} ${jobId(job.name)}`,
        role: c.role,
      });
    }
  }

  lines.push(...edges.map((e) => e.line));
  lines.push(...classDefs(opts.theme));
  edges.forEach((e, i) => {
    const s = linkStyle(i, e.role, opts.theme);
    if (s) lines.push(s);
  });
  return { mermaid: lines.join("\n") + "\n", jobs: wf.jobs.length, steps };
}

/** The workflow as a graph, for the SVG renderer: one group per job. */
export function workflowGraph(wf: WorkflowDoc, title?: string): Graph {
  const groups: GraphGroup[] = [];
  const edges: GraphEdge[] = [];
  const groupEdges: GraphEdge[] = [];
  const id = (job: string, step: string) => `${job}/${step}`;
  for (const job of wf.jobs) {
    const where = Object.entries(job.labels ?? {}).map(([k, v]) => `${k}=${v}`)
      .join(", ");
    groups.push({
      id: job.name,
      label: where ? `${job.name} · on worker ${where}` : job.name,
      nodes: (job.steps ?? []).map((step) => {
        const task = describeTask(step.task);
        const extras = [task.text];
        if (step.forEach) {
          extras.push(
            `for each ${
              Object.entries(step.forEach).map(([k, v]) => `${k} ${v}`).join(
                ", ",
              )
            }`,
          );
        }
        if (step.guard) extras.push("guarded");
        if (step.allowFailure) extras.push("may fail");
        return {
          id: id(job.name, step.name),
          label: step.name,
          note: extras.join(" · "),
          kind: task.human
            ? "highlight"
            : step.allowFailure
            ? "dashed"
            : "normal",
          nested: step.task?.type === "workflow",
        };
      }),
    });
    for (const step of job.steps ?? []) {
      for (const dep of step.dependsOn ?? []) {
        if (!dep.step) continue;
        const c = describeCondition(dep.condition);
        edges.push({
          from: id(job.name, dep.step),
          to: id(job.name, step.name),
          label: c.label,
          role: c.role,
        });
      }
    }
    for (const dep of job.dependsOn ?? []) {
      if (!dep.job) continue;
      const c = describeCondition(dep.condition);
      groupEdges.push({
        from: dep.job,
        to: job.name,
        label: c.label,
        role: c.role,
      });
    }
  }
  return {
    title: title || wf.name,
    subtitle: wf.description?.trim(),
    groups,
    edges,
    groupEdges,
  };
}
