import { z } from "npm:zod@4";
import { dirname, join, relative, resolve } from "jsr:@std/path@1.0.8";
import {
  background,
  embed,
  hasBlock,
  mermaidBlock,
  pictureBlock,
  type Theme,
  toMarkdown,
} from "./_lib/mermaid.ts";
import { renderSvg } from "./_lib/svg.ts";
import {
  parseTransitions,
  renderStateMachine,
  stateMachineGraph,
  type Transition,
} from "./_lib/state_machine.ts";
import {
  parseWorkflow,
  renderWorkflow,
  type WorkflowDoc,
  workflowGraph,
} from "./_lib/workflow.ts";

// Diagrams of swamp workflows and of behaviors' state machines, written as
// Mermaid.
//
// `workflow` draws the workflows in this repository's workflows/ folder (or
// any workflow file) as flowcharts: one box per job, one node per step, and
// dependsOn arrows labelled with their condition.
//
// `stateMachine` draws a behavior's phases and the methods that move between
// them, from transition lines like `created ──[start]──> triaging`. It reads
// them from a published extension's registry description (as
// @swamp/issue-lifecycle has) or from text you pass in.
//
// format svg (the default) draws each diagram itself as a light and a dark
// SVG with a fixed layout: the main path straight down the middle, failures
// beside it, retries curving back up, loops and notes beside their boxes.
// format mermaid writes Mermaid instead, which GitHub draws itself. Either is
// written into marked blocks in Markdown docs (embedIn), stored as data, and
// can be copied into a folder in the repository.

const MERMAID_CLI =
  "minlag/mermaid-cli:11.12.0@sha256:bad64c9d9ad917c8dfbe9d9e9c162b96f6615ff019b37058638d16eb27ce7783";

const GlobalArgsSchema = z.object({
  format: z.enum(["svg", "mermaid"]).default("svg").describe(
    "svg: a light and dark SVG pair drawn with a fixed, hand-drawn-style layout, shown with a <picture> element; mermaid: Mermaid source that GitHub draws itself",
  ),
  theme: z.enum(["auto", "dark", "light", "both", "none"]).default("auto")
    .describe(
      "Colours: auto (reads on light and dark pages; GitHub draws it in the reader's mode), dark (teal on black), light, both (auto source, images rendered as a -dark and -light pair), or none (Mermaid's default theme, no colours)",
    ),
  direction: z.enum(["TD", "LR"]).default("TD").describe(
    "Layout: TD (top-down) or LR (left-to-right)",
  ),
  render: z.enum(["none", "svg", "png"]).default("none").describe(
    "format mermaid only: also render an image with the mermaid-cli container (needs Docker)",
  ),
  outputDir: z.string().default("").describe(
    "Folder, relative to the repository, to also copy the diagram files into (empty = keep them in swamp data only)",
  ),
  embedIn: z.string().default("").describe(
    "Markdown file or folder, relative to the repository, whose <!-- swamp-diagram: <name> --> … <!-- /swamp-diagram --> blocks get the diagram: a <picture> of the SVG pair (saved in a diagrams/ folder beside the Markdown file) or a mermaid code block (empty = none)",
  ),
  copyFiles: z.array(z.enum(["mmd", "md", "image"])).default([
    "mmd",
    "md",
    "image",
  ]).describe("Which files to copy into outputDir"),
  registryUrl: z.string().url().default("https://swamp-club.com").describe(
    "swamp extension registry that stateMachine reads descriptions from",
  ),
  dockerPath: z.string().min(1).regex(
    /^[^-\s][^\s]*$/,
    "a binary name or path, without spaces or a leading dash",
  ).default("docker").describe("Docker CLI binary"),
  mermaidImage: z.string().regex(
    /^[a-z0-9][a-z0-9._/-]*(:[A-Za-z0-9._-]+)?(@sha256:[a-f0-9]{64})?$/,
    "an image reference such as name:tag or name@sha256:<digest>",
  ).default(MERMAID_CLI).describe(
    "mermaid-cli container image used to render SVG or PNG",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const WorkflowArgsSchema = z.object({
  name: z.string().default("").describe(
    "Workflow name, ID or file name (empty = every workflow found)",
  ),
  dir: z.string().default("workflows").describe(
    "Folder to look for workflows in, relative to the repository: it and every workflows/ folder beneath it (e.g. .. to draw every extension's workflows in a monorepo)",
  ),
  path: z.string().default("").describe(
    "A workflow YAML file to draw instead, relative to the repository or absolute",
  ),
  title: z.string().default("").describe(
    "Diagram title (defaults to the workflow name)",
  ),
});

const StateMachineArgsSchema = z.object({
  extension: z.string().default("").describe(
    "Published extension whose description holds the transitions, e.g. @swamp/issue-lifecycle",
  ),
  transitions: z.string().default("").describe(
    "Transition lines to draw instead, one per line: 'from ──[method]──> to'",
  ),
  path: z.string().default("").describe(
    "A file to read the transition lines from instead, relative to the repository (other lines are ignored, so it can be the docs page itself)",
  ),
  backEdges: z.enum(["retry", "normal"]).default("retry").describe(
    "A step back to an earlier phase: retry (red, labelled '(retry)') or normal (routine, like start after stop)",
  ),
  title: z.string().default("").describe(
    "Diagram title (defaults to the extension name)",
  ),
  subtitle: z.string().default("").describe(
    "A line shown under the title",
  ),
  hideStates: z.array(z.string()).default([]).describe(
    "Phases to leave out; their transitions become entry or exit arrows (e.g. created)",
  ),
  collapseStates: z.array(z.string()).default([]).describe(
    "Phases to skip over: each way in is joined to each way out (e.g. verifying)",
  ),
  omitMethods: z.array(z.string()).default([]).describe(
    "Methods whose transitions are left out, to keep the diagram to the main path",
  ),
  humanGates: z.array(z.string()).default([]).describe(
    "Methods only a person may run, drawn as thick green arrows (e.g. approve)",
  ),
  highlightStates: z.array(z.string()).default([]).describe(
    "Phases to emphasise, besides the final ones (which always are)",
  ),
  failureStates: z.array(z.string()).default([]).describe(
    "Phases to draw as failures, besides any whose name contains 'fail'",
  ),
  notes: z.record(z.string(), z.string()).default({}).describe(
    "A short note to show under a phase, keyed by phase",
  ),
  showComments: z.boolean().default(false).describe(
    "Add each transition's parenthetical comment to its arrow",
  ),
});

const DiagramSchema = z.object({
  kind: z.enum(["workflow", "stateMachine"]),
  name: z.string().describe("Workflow name or extension the diagram is of"),
  source: z.string().describe("File or URL the diagram was drawn from"),
  title: z.string(),
  mermaid: z.string().describe("The Mermaid source"),
  nodes: z.number().describe("Steps or phases drawn"),
  edges: z.number().describe("Transitions or dependencies drawn"),
  copiedTo: z.array(z.string()).describe(
    "Files written under outputDir, relative to the repository",
  ),
  embeddedIn: z.array(z.string()).default([]).describe(
    "Markdown files whose swamp-diagram block was updated, relative to the repository",
  ),
  generatedAt: z.string(),
});
type Diagram = z.infer<typeof DiagramSchema>;

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warning(msg: string, props?: Record<string, unknown>): void;
}

interface Writer {
  writeText(text: string): Promise<{ name: string }>;
  writeAll(content: Uint8Array): Promise<{ name: string }>;
}

interface Context {
  globalArgs: GlobalArgs;
  repoDir: string;
  logger: Logger;
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    spec: string,
    name: string,
    overrides?: { contentType?: string },
  ) => Writer;
}

/** Renders `.mmd` source to an image; swapped out in tests. */
export type Renderer = (
  mermaid: string,
  format: "svg" | "png",
  g: GlobalArgs,
) => Promise<Uint8Array>;

/** Slug for data instance and file names. */
export function slug(text: string): string {
  return text.toLowerCase().replace(/^@/, "").replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Render with mermaid-cli in Docker, as the invoking user so files stay theirs. */
const dockerRenderer: Renderer = async (mermaid, format, g) => {
  const dir = await Deno.makeTempDir({ prefix: "mermaid-" });
  try {
    await Deno.writeTextFile(join(dir, "in.mmd"), mermaid);
    const theme = g.theme as Theme;
    const args = ["run", "--rm"];
    const uid = Deno.uid();
    const gid = Deno.gid();
    if (uid !== null && gid !== null) args.push("-u", `${uid}:${gid}`);
    args.push(
      "-v",
      `${dir}:/data`,
      g.mermaidImage,
      "-i",
      "/data/in.mmd",
      "-o",
      `/data/out.${format}`,
      "-b",
      background(theme),
    );
    if (format === "png") args.push("-s", "2");
    // The only subprocess: the digest-pinned mermaid-cli image, run only when
    // render is set. dockerPath and mermaidImage are validated by the schema,
    // and every other argument is built here, not taken from input.
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command(g.dockerPath, {
      args,
      stdout: "piped",
      stderr: "piped",
    }).output();
    if (!out.success) {
      // mermaid-cli prints the parse error first, then a long stack trace.
      const lines = new TextDecoder().decode(out.stderr).trim().split("\n");
      const at = lines.findIndex((l) => /^\s*(Error|Parse error)/.test(l));
      const shown = at >= 0 ? lines.slice(at, at + 3) : lines.slice(-5);
      throw new Error(`mermaid-cli failed: ${shown.join("\n")}`);
    }
    return await Deno.readFile(join(dir, `out.${format}`));
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
};

/** Whether Docker can render, when rendering is asked for at all. */
export async function dockerAvailable(
  g: Pick<GlobalArgs, "render" | "dockerPath"> & { format?: string },
): Promise<{ pass: boolean; errors?: string[] }> {
  if (g.render === "none" || g.format === "svg") return { pass: true };
  const fail = (why: string) => ({
    pass: false,
    errors: [
      `render=${g.render} needs Docker to run mermaid-cli, but ${why}. Install or start Docker, or set render=none.`,
    ],
  });
  try {
    // swamp-quality-ignore deno-command
    const out = await new Deno.Command(g.dockerPath, {
      args: ["version", "--format", "{{.Server.Version}}"],
      stdout: "null",
      stderr: "piped",
      signal: AbortSignal.timeout(15_000),
    }).output();
    if (out.success) return { pass: true };
    const err = new TextDecoder().decode(out.stderr).trim().split("\n")[0];
    return fail(`the daemon did not answer (${err || "no output"})`);
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return fail(`${g.dockerPath} was not found`);
    }
    return fail(err instanceof Error ? err.message : String(err));
  }
}

/** Store a diagram as data files, optionally render it and copy it out. */
async function save(
  context: Context,
  instance: string,
  record: Omit<Diagram, "copiedTo" | "embeddedIn" | "generatedAt" | "mermaid">,
  draw: {
    mermaid: (theme: Theme) => string;
    svg: (mode: "dark" | "light") => string;
  },
  note: string | undefined,
  renderer: Renderer,
): Promise<{ name: string }[]> {
  const g = context.globalArgs;
  const sourceTheme: Theme = g.theme === "both" ? "auto" : g.theme;
  const mermaid = draw.mermaid(sourceTheme);
  const svgs = g.format === "svg"
    ? { dark: draw.svg("dark"), light: draw.svg("light") }
    : undefined;
  const markdown = toMarkdown(record.title, mermaid, note);
  const handles = [
    await context.createFileWriter("mermaid", `${instance}-mmd`).writeText(
      mermaid,
    ),
    await context.createFileWriter("markdown", `${instance}-md`).writeText(
      markdown,
    ),
  ];
  const outputs: [string, Uint8Array | string][] = [];
  if (g.copyFiles.includes("mmd")) outputs.push([`${instance}.mmd`, mermaid]);
  if (g.copyFiles.includes("md")) outputs.push([`${instance}.md`, markdown]);
  if (svgs) {
    for (const mode of ["dark", "light"] as const) {
      handles.push(
        await context.createFileWriter("image", `${instance}-${mode}-svg`, {
          contentType: "image/svg+xml",
        }).writeText(svgs[mode]),
      );
      if (g.copyFiles.includes("image")) {
        outputs.push([`${instance}-${mode}.svg`, svgs[mode]]);
      }
    }
  } else if (g.render !== "none") {
    // theme both: a -dark and -light pair; otherwise one image.
    const variants: [string, Theme][] = g.theme === "both"
      ? [["-dark", "dark"], ["-light", "light"]]
      : [["", g.theme]];
    for (const [suffix, theme] of variants) {
      const image = await renderer(
        theme === sourceTheme ? mermaid : draw.mermaid(theme),
        g.render,
        { ...g, theme },
      );
      handles.push(
        await context.createFileWriter(
          "image",
          `${instance}${suffix}-${g.render}`,
          {
            contentType: g.render === "svg" ? "image/svg+xml" : "image/png",
          },
        ).writeAll(image),
      );
      if (g.copyFiles.includes("image")) {
        outputs.push([`${instance}${suffix}.${g.render}`, image]);
      }
    }
  }
  const copiedTo: string[] = [];
  if (g.outputDir) {
    const dir = resolve(context.repoDir, g.outputDir);
    await Deno.mkdir(dir, { recursive: true });
    for (const [file, content] of outputs) {
      const path = join(dir, file);
      if (typeof content === "string") await Deno.writeTextFile(path, content);
      else await Deno.writeFile(path, content);
      copiedTo.push(relative(context.repoDir, path));
    }
  }
  const embeddedIn: string[] = [];
  if (g.embedIn) {
    for (
      const path of await markdownFiles(resolve(context.repoDir, g.embedIn))
    ) {
      const text = await Deno.readTextFile(path);
      if (!hasBlock(text, instance)) continue;
      let body = mermaidBlock(mermaid);
      if (svgs) {
        // The pair goes in a diagrams/ folder beside the page.
        const dir = join(dirname(path), "diagrams");
        await Deno.mkdir(dir, { recursive: true });
        for (const mode of ["dark", "light"] as const) {
          const file = join(dir, `${instance}-${mode}.svg`);
          const old = await Deno.readTextFile(file).catch(() => "");
          if (old !== svgs[mode]) await Deno.writeTextFile(file, svgs[mode]);
          copiedTo.push(relative(context.repoDir, file));
        }
        body = pictureBlock(`diagrams/${instance}`, record.title);
      }
      const next = embed(text, instance, body);
      if (next === text) {
        if (hasBlock(text, instance)) {
          embeddedIn.push(relative(context.repoDir, path));
        }
        continue;
      }
      await Deno.writeTextFile(path, next);
      embeddedIn.push(relative(context.repoDir, path));
    }
    if (embeddedIn.length === 0) {
      context.logger.warning(
        "No <!-- swamp-diagram: {name} --> block under {dir}",
        { name: instance, dir: g.embedIn },
      );
    }
  }
  handles.push(
    await context.writeResource("diagram", instance, {
      ...record,
      mermaid,
      copiedTo,
      embeddedIn,
      generatedAt: new Date().toISOString(),
    }),
  );
  context.logger.info("Drew {name}: {nodes} nodes, {edges} edges{where}", {
    name: record.name,
    nodes: record.nodes,
    edges: record.edges,
    where: [
      g.outputDir && copiedTo.length ? `, copied to ${g.outputDir}` : "",
      embeddedIn.length ? `, embedded in ${embeddedIn.join(", ")}` : "",
    ].join(""),
  });
  return handles;
}

/** A Markdown file, or every Markdown file under a folder. */
async function markdownFiles(path: string): Promise<string[]> {
  const info = await Deno.stat(path);
  if (info.isFile) return [path];
  const files: string[] = [];
  for await (const e of Deno.readDir(path)) {
    if (e.name.startsWith(".") || e.name === "node_modules") continue;
    const p = join(path, e.name);
    if (e.isDirectory) files.push(...await markdownFiles(p));
    else if (e.name.endsWith(".md")) files.push(p);
  }
  return files.sort();
}

/**
 * YAML files directly in `dir`, and in every `workflows/` folder beneath it.
 * Hidden folders and node_modules are skipped.
 */
async function workflowFiles(dir: string, top = true): Promise<string[]> {
  const files: string[] = [];
  const inWorkflows = top || dir.split("/").pop() === "workflows";
  try {
    for await (const e of Deno.readDir(dir)) {
      const path = join(dir, e.name);
      if (e.isDirectory) {
        if (e.name.startsWith(".") || e.name === "node_modules") continue;
        files.push(...await workflowFiles(path, false));
      } else if (inWorkflows && /\.ya?ml$/.test(e.name)) files.push(path);
    }
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  return files.sort();
}

/** The workflows to draw: one file, one by name, or all of them. */
export async function findWorkflows(
  repoDir: string,
  args: { name: string; path: string; dir?: string },
  logger?: Logger,
): Promise<{ path: string; doc: WorkflowDoc }[]> {
  if (args.path) {
    const path = resolve(repoDir, args.path);
    return [{ path, doc: parseWorkflow(await Deno.readTextFile(path), path) }];
  }
  const root = resolve(repoDir, args.dir || "workflows");
  const found: { path: string; doc: WorkflowDoc }[] = [];
  for (const path of await workflowFiles(root)) {
    let doc: WorkflowDoc;
    try {
      doc = parseWorkflow(await Deno.readTextFile(path), path);
    } catch (err) {
      // Everything in a workflows/ folder should be a workflow, so say so
      // rather than leave a broken one out of the docs silently.
      logger?.warning("Skipped {file}: {reason}", {
        file: relative(repoDir, path),
        reason: err instanceof Error ? err.message : String(err),
      });
      continue;
    }
    const file = path.split("/").pop()!.replace(/\.ya?ml$/, "");
    if (
      !args.name || doc.name === args.name || doc.id === args.name ||
      file === args.name || file === `workflow-${args.name}`
    ) found.push({ path, doc });
  }
  if (found.length === 0) {
    throw new Error(
      args.name
        ? `No workflow named ${args.name} in ${root}`
        : `No workflows in ${root}`,
    );
  }
  return found;
}

/** Fetch an extension's description from the registry. */
export async function fetchDescription(
  registryUrl: string,
  extension: string,
  signal?: AbortSignal,
): Promise<{ url: string; description: string }> {
  const url = `${registryUrl.replace(/\/$/, "")}/api/v1/extensions/${
    encodeURIComponent(extension)
  }`;
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal,
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`${extension}: registry returned ${res.status} for ${url}`);
  }
  const body = await res.json() as { description?: string };
  return { url, description: body.description ?? "" };
}

/** The @taylor/mermaid/diagram behavior. */
export const model = {
  type: "@taylor/swamp-diagrams/diagram",
  version: "2026.11.06.3",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.06.2",
      description:
        "Validates dockerPath and mermaidImage, checks Docker before rendering, and reports skipped and clashing workflows; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.06.3",
      description:
        "Adds format svg, now the default: a light and dark SVG pair with a fixed, hand-drawn-style layout (set format=mermaid to keep Mermaid). stateMachine can read transitions from a file (path) and draw routine steps back as normal arrows (backEdges=normal). Also ignores swamp-diagram markers inside code blocks and stops Mermaid labels clipping on GitHub; existing settings are kept",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "docker-available": {
      description:
        "When render is set, the Docker CLI can reach a daemon to run mermaid-cli",
      labels: ["live"],
      appliesTo: ["workflow", "stateMachine"],
      execute: (
        context: { globalArgs: GlobalArgs },
      ): Promise<{ pass: boolean; errors?: string[] }> =>
        dockerAvailable(context.globalArgs),
    },
  },
  resources: {
    diagram: {
      description:
        "A diagram's Mermaid source, what it was drawn from, and where it was copied",
      schema: DiagramSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  files: {
    mermaid: {
      description: "Mermaid source (.mmd)",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    markdown: {
      description: "Markdown file with the diagram in a mermaid code block",
      contentType: "text/markdown",
      lifetime: "infinite",
      garbageCollection: 10,
    },
    image: {
      description: "The diagram rendered to SVG or PNG (when render is set)",
      contentType: "image/svg+xml",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    workflow: {
      description:
        "Draw swamp workflows as flowcharts: each job a box of its steps, each dependsOn an arrow labelled with its condition. Draws every workflow in workflows/ unless name or path picks one",
      arguments: WorkflowArgsSchema,
      execute: async (
        args: z.infer<typeof WorkflowArgsSchema> & { _render?: Renderer },
        context: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const handles: { name: string }[] = [];
        const found = await findWorkflows(
          context.repoDir,
          args,
          context.logger,
        );
        // Diagram names come from workflow names; two that differ only in
        // punctuation would overwrite each other's diagram.
        const seen = new Map<string, string>();
        for (const { path, doc } of found) {
          const instance = `workflow-${slug(doc.name)}`;
          const other = seen.get(instance);
          if (other) {
            throw new Error(
              `${relative(context.repoDir, other)} and ${
                relative(context.repoDir, path)
              } would both be drawn as ${instance}; rename one of the workflows`,
            );
          }
          seen.set(instance, path);
        }
        for (const { path, doc } of found) {
          const draw = (theme: Theme) =>
            renderWorkflow(doc, {
              title: args.title,
              theme,
              direction: g.direction,
            });
          const d = draw("none");
          const edges = doc.jobs.reduce(
            (n, j) =>
              n + (j.dependsOn?.length ?? 0) +
              (j.steps ?? []).reduce(
                (m, s) => m + (s.dependsOn?.length ?? 0),
                0,
              ),
            0,
          );
          handles.push(
            ...await save(
              context,
              `workflow-${slug(doc.name)}`,
              {
                kind: "workflow",
                name: doc.name,
                source: relative(context.repoDir, path),
                title: args.title || doc.name,
                nodes: d.steps,
                edges,
              },
              {
                mermaid: (theme) => draw(theme).mermaid,
                svg: (mode) =>
                  renderSvg(workflowGraph(doc, args.title || undefined), mode),
              },
              doc.description?.trim(),
              args._render ?? dockerRenderer,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    stateMachine: {
      description:
        "Draw a behavior's phases and the methods that move between them, from transition lines ('from ──[method]──> to') in a published extension's description or passed in",
      arguments: StateMachineArgsSchema,
      execute: async (
        args: z.infer<typeof StateMachineArgsSchema> & {
          _render?: Renderer;
          _fetch?: typeof fetchDescription;
        },
        context: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        if (!args.extension && !args.transitions && !args.path) {
          throw new Error("Pass extension, transitions or path");
        }
        let text = args.transitions;
        let source = "transitions argument";
        if (!text && args.path) {
          const file = resolve(context.repoDir, args.path);
          text = await Deno.readTextFile(file);
          source = relative(context.repoDir, file);
        } else if (!text) {
          const got = await (args._fetch ?? fetchDescription)(
            g.registryUrl,
            args.extension,
            context.signal,
          );
          text = got.description;
          source = got.url;
        }
        const transitions: Transition[] = parseTransitions(text);
        if (transitions.length === 0) {
          throw new Error(
            `No transition lines like 'created ──[start]──> triaging' in ${source}`,
          );
        }
        const name = args.extension || args.title || "state-machine";
        const title = args.title || args.extension || "State machine";
        const options = (theme: Theme) => ({
          title,
          theme,
          direction: g.direction,
          hideStates: args.hideStates,
          collapseStates: args.collapseStates,
          omitMethods: args.omitMethods,
          humanGates: args.humanGates,
          highlightStates: args.highlightStates,
          failureStates: args.failureStates,
          notes: args.notes,
          showComments: args.showComments,
          backEdges: args.backEdges,
        });
        const draw = (theme: Theme) =>
          renderStateMachine(transitions, options(theme));
        const d = draw("none");
        const handles = await save(
          context,
          `state-machine-${slug(name)}`,
          {
            kind: "stateMachine",
            name,
            source,
            title,
            nodes: d.states.length,
            edges: d.transitions,
          },
          {
            mermaid: (theme) => draw(theme).mermaid,
            svg: (mode) =>
              renderSvg(
                stateMachineGraph(transitions, {
                  ...options("none"),
                  subtitle: args.subtitle || undefined,
                }),
                mode,
              ),
          },
          args.subtitle || undefined,
          args._render ?? dockerRenderer,
        );
        return { dataHandles: handles };
      },
    },
  },
};
