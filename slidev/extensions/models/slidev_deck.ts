import { z } from "npm:zod@4";
import { FIT_SCRIPT } from "./_lib/fit_script.ts";
import {
  type DeckInfo,
  deployYml,
  GITIGNORE,
  GLOBAL_TOP_VUE,
  license,
  PAGINATION_VUE,
  readme,
  slidesMd,
} from "./_lib/templates.ts";

// A Slidev deck worked on entirely inside a container image (by default
// docker.io/boxcutter/slidev), so the host needs no Node. The deck directory
// is bind-mounted at /slidev, and the image's entrypoint installs
// dependencies when package.json or the lockfile changes, then runs slidev.
// Docker and Apple's `container` CLI take the same run flags; the runtime
// only changes how a container is removed and how its address is found.
//
// The headline method is `fit`: it starts the dev server inside a throwaway
// container and opens every slide, all clicks revealed, in the deck's own
// playwright-chromium to find content that runs off the bottom or right edge
// or scrolls inside a code block or table.

/** Default container image: Slidev with Playwright's system libraries. */
export const DEFAULT_IMAGE = "docker.io/boxcutter/slidev:latest";

const RUNTIMES = ["docker", "container"] as const;
/** Container runtime CLI: Docker or Apple's `container`. */
export type Runtime = typeof RUNTIMES[number];

const GlobalArgsSchema = z.object({
  dir: z.string().min(1).describe(
    "Deck directory (the one with slides.md and package.json). Relative paths resolve from the swamp repository.",
  ),
  runtime: z.enum(RUNTIMES).default("docker").describe(
    "Container runtime: docker, or container (Apple's container CLI; start it with `container system start`)",
  ),
  runtimePath: z.string().optional().describe(
    "Path to the runtime CLI if it is not `docker`/`container` on PATH",
  ),
  image: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]*$/i).default(
    DEFAULT_IMAGE,
  ).describe(
    "Slidev image; its entrypoint must behave like boxcutter/slidev's",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FitArgsSchema = z.object({
  slides: z.string().regex(/^\d+(-\d+)?(,\d+(-\d+)?)*$/).optional().describe(
    "Only check these slide numbers, e.g. '12' or '3,7,10-14'",
  ),
  bottomMargin: z.number().int().min(0).default(40).describe(
    "Flag content that reaches within this many slide pixels of the bottom edge",
  ),
  rightMargin: z.number().int().min(0).default(20).describe(
    "Flag content that reaches within this many slide pixels of the right edge (the slide is 980 wide)",
  ),
  screenshots: z.enum(["flagged", "all", "none"]).default("flagged").describe(
    "Which slides to screenshot",
  ),
  shotsDir: z.string().optional().describe(
    "Also copy the screenshots into this host directory (created if needed)",
  ),
  timeoutMs: z.number().int().positive().default(600000).describe(
    "Overall timeout, including a first-run npm install",
  ),
});
type FitArgs = z.infer<typeof FitArgsSchema>;

const ServeArgsSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3030).describe(
    "Host port to publish the dev server on",
  ),
  remote: z.boolean().default(true).describe(
    "Pass --remote so other devices on the network can follow along and control the deck",
  ),
  timeoutMs: z.number().int().positive().default(300000).describe(
    "How long to wait for the server to answer, including a first-run npm install",
  ),
});
type ServeArgs = z.infer<typeof ServeArgsSchema>;

const UpgradeArgsSchema = z.object({
  packages: z.array(z.string().regex(/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i))
    .optional().describe(
      "Packages to move to @latest. Default: every @slidev/* package, vue and playwright-chromium in package.json, except ones pinned to an exact version",
    ),
  playwright: z.boolean().default(true).describe(
    "Add playwright-chromium as a dev dependency if it is missing (fit and export need it)",
  ),
  timeoutMs: z.number().int().positive().default(900000).describe(
    "Timeout for the npm installs",
  ),
});
type UpgradeArgs = z.infer<typeof UpgradeArgsSchema>;

const ExportArgsSchema = z.object({
  withClicks: z.boolean().default(false).describe(
    "One page per click step instead of one per slide",
  ),
  dark: z.boolean().default(false).describe("Export in dark mode"),
  timeoutMs: z.number().int().positive().default(900000).describe(
    "Timeout for the export",
  ),
});
type ExportArgs = z.infer<typeof ExportArgsSchema>;

const InitArgsSchema = z.object({
  playwright: z.boolean().default(true).describe(
    "Add playwright-chromium so fit and export work straight away",
  ),
  timeoutMs: z.number().int().positive().default(900000).describe(
    "Timeout for creating the deck and installing packages",
  ),
});
type InitArgs = z.infer<typeof InitArgsSchema>;

const ScaffoldArgsSchema = z.object({
  title: z.string().min(1).describe(
    "Deck title, used for the cover slide and the README",
  ),
  author: z.string().optional().describe(
    "Author on the cover slide. Default: git config user.name",
  ),
  email: z.string().optional().describe(
    "Email on the cover slide; omitted when not given",
  ),
  license: z.boolean().default(true).describe(
    "Write LICENSE: code under Apache-2.0, slides under CC BY 4.0",
  ),
  copyright: z.string().optional().describe(
    "Copyright holder for the first line of LICENSE",
  ),
  lockfileFrom: z.string().optional().describe(
    "Path of a deck that builds; its package-lock.json and dependency versions are copied in and installed with npm ci, to work around a broken upstream release",
  ),
  timeoutMs: z.number().int().positive().default(900000).describe(
    "Timeout for npm ci when lockfileFrom is given",
  ),
});
type ScaffoldArgs = z.infer<typeof ScaffoldArgsSchema>;

const PushArgsSchema = z.object({
  remoteUrl: z.string().min(1).describe(
    "Remote to push to as origin, e.g. git@github.com:<owner>/<name>.git",
  ),
  branch: z.string().regex(/^[A-Za-z0-9._\/-]+$/).default("main").describe(
    "Branch to push",
  ),
});
type PushArgs = z.infer<typeof PushArgsSchema>;

const TimeoutArgsSchema = z.object({
  timeoutMs: z.number().int().positive().default(300000).describe(
    "Timeout for the command",
  ),
});
type TimeoutArgs = z.infer<typeof TimeoutArgsSchema>;

const SlideSchema = z.object({
  no: z.number(),
  title: z.string(),
  file: z.string(),
  line: z.number(),
  routeAlias: z.string(),
  layout: z.string(),
  height: z.number(),
  bottom: z.number(),
  right: z.number(),
  bottomEl: z.string(),
  rightEl: z.string(),
  scrolled: z.array(z.string()),
  problems: z.array(z.enum(["bottom", "right", "scroll", "render"])),
  screenshot: z.boolean(),
});
/** One measured slide from the fit check. */
export type Slide = z.infer<typeof SlideSchema>;

const FitSchema = z.object({
  dir: z.string(),
  total: z.number(),
  checked: z.number(),
  flagged: z.array(SlideSchema),
  slides: z.array(SlideSchema),
  bottomMargin: z.number(),
  rightMargin: z.number(),
  shotsDir: z.string(),
  checkedAt: z.string(),
});

const ServerSchema = z.object({
  dir: z.string(),
  runtime: z.enum(RUNTIMES),
  container: z.string(),
  running: z.boolean(),
  url: z.string(),
  urls: z.array(z.string()),
  port: z.number(),
  remote: z.boolean(),
  action: z.enum(["started", "already-running", "stopped", "not-running"]),
  at: z.string(),
});

const PackageSchema = z.object({
  name: z.string(),
  current: z.string(),
  wanted: z.string(),
  latest: z.string(),
});

const OutdatedSchema = z.object({
  dir: z.string(),
  packages: z.array(PackageSchema),
  checkedAt: z.string(),
});

const UpgradeSchema = z.object({
  dir: z.string(),
  changes: z.array(
    z.object({ name: z.string(), from: z.string(), to: z.string() }),
  ),
  skippedPinned: z.array(z.string()),
  upgradedAt: z.string(),
});

const BuildSchema = z.object({
  dir: z.string(),
  ok: z.boolean(),
  durationMs: z.number(),
  log: z.string(),
  builtAt: z.string(),
});

const ScaffoldSchema = z.object({
  dir: z.string(),
  files: z.array(z.string()),
  branch: z.string(),
  commit: z.string(),
  scaffoldedAt: z.string(),
});

const PushSchema = z.object({
  dir: z.string(),
  remoteUrl: z.string(),
  branch: z.string(),
  commit: z.string(),
  pushedAt: z.string(),
});

const DeckSchema = z.object({
  dir: z.string(),
  slidevVersion: z.string(),
  playwright: z.boolean(),
  createdAt: z.string(),
});

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface DataWriter {
  writeAll(content: Uint8Array): Promise<{ name: string }>;
}

interface Context {
  globalArgs: GlobalArgs;
  repoDir?: string;
  logger: Logger;
  signal?: AbortSignal;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  createFileWriter: (
    specName: string,
    name: string,
    overrides?: { contentType?: string },
  ) => DataWriter;
}

/** Result of one runtime CLI call. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the runtime CLI with the given arguments. Injectable for tests. */
export type Runner = (
  args: string[],
  opts: { timeoutMs: number; signal?: AbortSignal },
) => Promise<RunResult>;

// Methods accept these for tests. swamp rejects method inputs that are not in
// the schema, so they cannot be set from the CLI or a workflow.
interface TestHooks {
  _run?: Runner;
  _git?: Runner;
  _fetch?: (url: string) => Promise<Response>;
  _sleep?: (ms: number) => Promise<void>;
}

/** Runs the runtime CLI; on timeout or abort it kills the CLI process. */
export function commandRunner(bin: string): Runner {
  return async (args, { timeoutMs, signal }) => {
    const abort = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])
      : AbortSignal.timeout(timeoutMs);
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs the docker or Apple container CLI, and git for scaffold and push; argument lists are built in this file, see README What it runs
      out = await new Deno.Command(bin, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: abort,
      }).output();
    } catch (err) {
      if (abort.aborted) {
        throw new Error(`${bin} ${args[0]} timed out after ${timeoutMs}ms`);
      }
      throw new Error(
        `Cannot run ${bin}: ${(err as Error).message}. Is it installed?`,
      );
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}

/** Runs git in the deck directory on the host. */
function gitIn(dir: string, run?: Runner) {
  const r = run ?? commandRunner("git");
  return (args: string[], timeoutMs = 60000) =>
    r(["-C", dir, ...args], { timeoutMs });
}

/** Commands that differ between Docker and Apple's container CLI. */
export const RUNTIME_ARGS: Record<
  Runtime,
  { remove: (name: string) => string[]; inspect: (name: string) => string[] }
> = {
  docker: {
    remove: (name) => ["rm", "--force", name],
    inspect: (name) => ["inspect", name],
  },
  container: {
    remove: (name) => ["delete", "--force", name],
    inspect: (name) => ["inspect", name],
  },
};

/** `--mount` for a bind mount; refuses paths the mount syntax can't carry. */
export function bindMount(source: string, target: string): string[] {
  if (/[,"]/.test(source)) {
    throw new Error(`Paths with commas or quotes can't be mounted: ${source}`);
  }
  return ["--mount", `type=bind,source=${source},target=${target}`];
}

/** "3,7,10-12" → "3,7,10,11,12". */
export function expandSlides(spec: string): string {
  return spec.split(",").flatMap((part) => {
    const [a, b] = part.split("-").map(Number);
    if (b === undefined) return [a];
    if (b < a) throw new Error(`Bad slide range ${part}`);
    return Array.from({ length: b - a + 1 }, (_, i) => a + i);
  }).join(",");
}

/** Container name: deck-scoped, unique per run unless `fixed`. */
export function containerName(dir: string, purpose: string, fixed = false) {
  const base = dir.split("/").filter(Boolean).pop()!.toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "") || "deck";
  return fixed
    ? `slidev-${base}`
    : `slidev-${base}-${purpose}-${crypto.randomUUID().slice(0, 8)}`;
}

/** The container's own IPv4 address from `container inspect` output. */
export function findAddress(inspectJson: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inspectJson);
  } catch {
    return null;
  }
  const first = (Array.isArray(parsed) ? parsed[0] : parsed) as {
    networks?: { ipv4Address?: string; address?: string }[];
    status?: { networks?: { ipv4Address?: string; address?: string }[] };
  } | undefined;
  const nets = first?.networks ?? first?.status?.networks ?? [];
  for (const n of nets) {
    const ip = (n.ipv4Address ?? n.address ?? "").split("/")[0];
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(ip) && ip !== "0.0.0.0") return ip;
  }
  return null;
}

interface Deck {
  dir: string;
  g: GlobalArgs;
  run: Runner;
  logger: Logger;
  signal?: AbortSignal;
}

function deck(ctx: Context, hooks: TestHooks, mustExist = true): Deck {
  const g = ctx.globalArgs;
  const dir = g.dir.startsWith("/")
    ? g.dir.replace(/\/+$/, "")
    : `${ctx.repoDir ?? Deno.cwd()}/${g.dir}`.replace(/\/+$/, "");
  if (mustExist) {
    let ok = false;
    try {
      ok = Deno.statSync(`${dir}/package.json`).isFile;
    } catch { /* missing */ }
    if (!ok) {
      throw new Error(
        `${dir} is not a Slidev deck (no package.json); create one with the init method`,
      );
    }
  }
  return {
    dir,
    g,
    run: hooks._run ?? commandRunner(g.runtimePath ?? g.runtime),
    logger: ctx.logger,
    signal: ctx.signal,
  };
}

/**
 * Runs a throwaway container for the deck and removes it afterwards, also on
 * timeout (killing the CLI does not stop a container on its own).
 */
async function runOnce(
  d: Deck,
  purpose: string,
  args: { pre?: string[]; image?: string[] },
  timeoutMs: number,
): Promise<RunResult> {
  const name = containerName(d.dir, purpose);
  try {
    return await d.run(
      [
        "run",
        "--rm",
        "--name",
        name,
        ...bindMount(d.dir, "/slidev"),
        ...(args.pre ?? []),
        d.g.image,
        ...(args.image ?? []),
      ],
      { timeoutMs, signal: d.signal },
    );
  } catch (e) {
    await d.run(RUNTIME_ARGS[d.g.runtime].remove(name), {
      timeoutMs: 30000,
    }).catch(() => {});
    throw e;
  }
}

function tail(s: string, n = 15): string {
  return s.split("\n").slice(-n).join("\n");
}

function readJson(path: string): Record<string, unknown> | null {
  try {
    return JSON.parse(Deno.readTextFileSync(path));
  } catch {
    return null;
  }
}

function installedVersion(dir: string, pkg: string): string {
  return String(
    readJson(`${dir}/node_modules/${pkg}/package.json`)?.version ?? "",
  );
}

function depsOf(dir: string): Record<string, string> {
  const pkg = readJson(`${dir}/package.json`) ?? {};
  return {
    ...(pkg.dependencies as Record<string, string> ?? {}),
    ...(pkg.devDependencies as Record<string, string> ?? {}),
  };
}

function isDevDep(dir: string, name: string): boolean {
  const pkg = readJson(`${dir}/package.json`) ?? {};
  return name in (pkg.devDependencies as Record<string, string> ?? {});
}

async function npm(
  d: Deck,
  args: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return await runOnce(d, "npm", {
    pre: ["--entrypoint", "npm"],
    image: args,
  }, timeoutMs);
}

const FIT_ERRORS: Record<number, string> = {
  3: "The deck has no playwright-chromium. Add it with the upgrade method (playwright: true) or `npm install --save-dev playwright-chromium` in the container.",
  4: "The Slidev dev server never answered. Its log is below.",
  5: "playwright-chromium is installed but its Chromium would not start. Reinstall it with the upgrade method so the browser is downloaded into node_modules.",
};

/** The `@taylor/slidev/deck` swamp model type. */
export const model = {
  type: "@taylor/slidev/deck",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.11.2",
      description: "fit reports boxes that scroll or clip; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.11.3",
      description: "Adds scaffold, build and push; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.22.1",
      description: "Relicenses under AGPL-3.0-or-later; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  files: {
    screenshot: {
      description:
        "Screenshot of a slide from the last fit check (instance slide-NNN)",
      contentType: "image/png",
      lifetime: "infinite",
      garbageCollection: 3,
    },
    pdf: {
      description: "The deck exported to PDF (instance slides)",
      contentType: "application/pdf",
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  resources: {
    fit: {
      description:
        "Slide fit report: every checked slide's extent and the flagged ones (instance fit)",
      schema: FitSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    server: {
      description:
        "The background dev server from serve/stop (instance server)",
      schema: ServerSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    outdated: {
      description: "Packages with newer versions (instance outdated)",
      schema: OutdatedSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    upgrade: {
      description: "Versions changed by an upgrade (instance upgrade)",
      schema: UpgradeSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    deck: {
      description: "The deck created by init (instance deck)",
      schema: DeckSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    build: {
      description: "The last production build check (instance build)",
      schema: BuildSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    scaffold: {
      description:
        "Files scaffold added and the first commit (instance scaffold)",
      schema: ScaffoldSchema,
      lifetime: "infinite",
      garbageCollection: 3,
    },
    push: {
      description: "The last push to the remote (instance push)",
      schema: PushSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    fit: {
      description:
        "Open every slide with all clicks revealed and flag content that runs off the bottom or right edge or scrolls, with screenshots",
      arguments: FitArgsSchema,
      execute: async (args: FitArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        const only = args.slides ? expandSlides(args.slides) : "";
        d.logger.info("Checking slide fit in {dir}{only}", {
          dir: d.dir,
          only: only ? ` (slides ${only})` : "",
        });
        const work = await Deno.makeTempDir({ prefix: "slidev-fit-" });
        try {
          await Deno.writeTextFile(`${work}/fit.mjs`, FIT_SCRIPT);
          await Deno.mkdir(`${work}/out`);
          const script = [
            "/entrypoint.sh --port 3030 > /fit/out/slidev.log 2>&1 &",
            `node /fit/fit.mjs 3030 /fit/out ${args.bottomMargin} ${args.rightMargin} ${args.screenshots} ${only}`,
          ].join("\n");
          const res = await runOnce(d, "fit", {
            pre: [...bindMount(work, "/fit"), "--entrypoint", "bash"],
            image: ["-c", script],
          }, args.timeoutMs);
          if (res.code !== 0) {
            const log = await Deno.readTextFile(`${work}/out/slidev.log`)
              .catch(() => "");
            throw new Error(
              `${
                FIT_ERRORS[res.code] ??
                  `The fit check failed (exit ${res.code}).`
              }\n${tail(res.stderr || res.stdout)}${
                res.code === 4 || !FIT_ERRORS[res.code]
                  ? `\n--- slidev log ---\n${tail(log)}`
                  : ""
              }`,
            );
          }
          const raw = JSON.parse(
            await Deno.readTextFile(`${work}/out/results.json`),
          ) as { total: number; results: Record<string, unknown>[] };
          const slides = raw.results.map((r) =>
            SlideSchema.parse({
              title: "",
              file: "",
              line: 0,
              routeAlias: "",
              layout: "",
              height: 0,
              bottom: 0,
              right: 0,
              bottomEl: "",
              rightEl: "",
              scrolled: [],
              ...r,
              // Report sources relative to the deck, not the container.
              ...(typeof r.file === "string"
                ? { file: r.file.replace(/^\/slidev\//, "") }
                : {}),
            })
          );
          const flagged = slides.filter((s) => s.problems.length);

          const handles = [];
          const shotsDir = args.shotsDir ?? "";
          if (shotsDir) await Deno.mkdir(shotsDir, { recursive: true });
          for (const s of slides.filter((s) => s.screenshot)) {
            const name = `slide-${String(s.no).padStart(3, "0")}`;
            const png = await Deno.readFile(`${work}/out/${name}.png`);
            handles.push(
              await context.createFileWriter("screenshot", name).writeAll(png),
            );
            if (shotsDir) await Deno.writeFile(`${shotsDir}/${name}.png`, png);
          }
          handles.push(
            await context.writeResource("fit", "fit", {
              dir: d.dir,
              total: raw.total,
              checked: slides.length,
              flagged,
              slides,
              bottomMargin: args.bottomMargin,
              rightMargin: args.rightMargin,
              shotsDir,
              checkedAt: new Date().toISOString(),
            }),
          );
          if (flagged.length) {
            d.logger.warn("{n} of {checked} slides don't fit: {list}", {
              n: flagged.length,
              checked: slides.length,
              list: flagged.map((s) => `${s.no} (${s.problems.join("+")})`)
                .join(", "),
            });
          } else {
            d.logger.info("All {checked} slides fit", {
              checked: slides.length,
            });
          }
          return { dataHandles: handles };
        } finally {
          await Deno.remove(work, { recursive: true }).catch(() => {});
        }
      },
    },

    serve: {
      description:
        "Start the dev server in a background container (slidev --remote by default) and wait until it answers",
      arguments: ServeArgsSchema,
      execute: async (args: ServeArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        const rt = RUNTIME_ARGS[d.g.runtime];
        const name = containerName(d.dir, "serve", true);
        const url = `http://localhost:${args.port}/`;
        d.logger.info("Starting {name} on port {port}", {
          name,
          port: args.port,
        });

        const existing = await d.run(rt.inspect(name), { timeoutMs: 30000 });
        let action: "started" | "already-running" = "already-running";
        if (existing.code !== 0) {
          const res = await d.run([
            "run",
            "--detach",
            "--rm",
            "--name",
            name,
            ...bindMount(d.dir, "/slidev"),
            "--publish",
            `${args.port}:3030`,
            d.g.image,
            // --remote listens on all interfaces; without it Slidev would
            // only listen inside the container, out of the published port's reach.
            ...(args.remote ? ["--remote"] : ["--bind", "0.0.0.0"]),
          ], { timeoutMs: 120000, signal: d.signal });
          if (res.code !== 0) {
            throw new Error(
              `Could not start ${name}: ${tail(res.stderr || res.stdout)}`,
            );
          }
          action = "started";
        }

        const fetchImpl = args._fetch ?? ((u: string) => fetch(u));
        const sleep = args._sleep ??
          ((ms: number) => new Promise((r) => setTimeout(r, ms)));
        const deadline = Date.now() + args.timeoutMs;
        for (;;) {
          try {
            const r = await fetchImpl(url);
            await r.body?.cancel();
            if (r.ok) break;
          } catch { /* not up yet */ }
          if (Date.now() > deadline) {
            throw new Error(
              `${name} did not answer on ${url} within ${args.timeoutMs}ms; it is still running, so check its logs or stop it`,
            );
          }
          await sleep(2000);
        }

        const urls = [url];
        if (d.g.runtime === "container") {
          const info = await d.run(rt.inspect(name), { timeoutMs: 30000 });
          const ip = findAddress(info.stdout);
          if (ip) urls.push(`http://${ip}:3030/`);
        }
        d.logger.info("{name} is serving at {urls}", {
          name,
          urls: urls.join(" and "),
        });
        const handle = await context.writeResource("server", "server", {
          dir: d.dir,
          runtime: d.g.runtime,
          container: name,
          running: true,
          url,
          urls,
          port: args.port,
          remote: args.remote,
          action,
          at: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description: "Stop the background dev server started by serve",
      arguments: TimeoutArgsSchema,
      execute: async (args: TimeoutArgs & TestHooks, context: Context) => {
        const d = deck(context, args, false);
        const rt = RUNTIME_ARGS[d.g.runtime];
        const name = containerName(d.dir, "serve", true);
        d.logger.info("Stopping {name}", { name });
        const exists =
          (await d.run(rt.inspect(name), { timeoutMs: 30000 })).code === 0;
        if (exists) {
          const res = await d.run(rt.remove(name), {
            timeoutMs: args.timeoutMs,
            signal: d.signal,
          });
          if (res.code !== 0) {
            throw new Error(`Could not stop ${name}: ${tail(res.stderr)}`);
          }
        }
        d.logger.info(exists ? "Stopped {name}" : "{name} was not running", {
          name,
        });
        const handle = await context.writeResource("server", "server", {
          dir: d.dir,
          runtime: d.g.runtime,
          container: name,
          running: false,
          url: "",
          urls: [],
          port: 0,
          remote: false,
          action: exists ? "stopped" : "not-running",
          at: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    outdated: {
      description: "List packages with newer versions (npm outdated)",
      arguments: TimeoutArgsSchema,
      execute: async (args: TimeoutArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        d.logger.info("Checking for outdated packages in {dir}", {
          dir: d.dir,
        });
        const res = await npm(d, ["outdated", "--json"], args.timeoutMs);
        // npm outdated exits 1 when something is outdated.
        let parsed: Record<string, Record<string, string>>;
        try {
          parsed = JSON.parse(res.stdout || "{}");
        } catch {
          throw new Error(
            `npm outdated failed (exit ${res.code}): ${
              tail(res.stderr || res.stdout)
            }`,
          );
        }
        if ("error" in parsed) {
          throw new Error(`npm outdated failed: ${JSON.stringify(parsed)}`);
        }
        const packages = Object.entries(parsed).map(([name, v]) => ({
          name,
          current: String(v.current ?? ""),
          wanted: String(v.wanted ?? ""),
          latest: String(v.latest ?? ""),
        }));
        d.logger.info("{n} outdated: {list}", {
          n: packages.length,
          list: packages.map((p) => `${p.name} ${p.current} → ${p.latest}`)
            .join(", ") || "none",
        });
        const handle = await context.writeResource("outdated", "outdated", {
          dir: d.dir,
          packages,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    upgrade: {
      description:
        "Move Slidev, its themes, vue and playwright-chromium to their latest versions (npm install <pkg>@latest), adding playwright-chromium if missing",
      arguments: UpgradeArgsSchema,
      execute: async (args: UpgradeArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        const deps = depsOf(d.dir);
        const skippedPinned: string[] = [];
        let names = args.packages;
        if (!names) {
          names = Object.keys(deps).filter((n) =>
            n.startsWith("@slidev/") || n === "vue" ||
            n === "playwright-chromium"
          ).filter((n) => {
            // An exact version is usually a deliberate pin (a known bug in a
            // newer release); leave it unless named explicitly.
            if (/^\d/.test(deps[n])) {
              skippedPinned.push(`${n}@${deps[n]}`);
              return false;
            }
            return true;
          });
        }
        if (skippedPinned.length) {
          d.logger.warn(
            "Left pinned packages alone: {pins}. Name them in packages to upgrade them anyway.",
            { pins: skippedPinned.join(", ") },
          );
        }
        const addPlaywright = args.playwright &&
          !("playwright-chromium" in deps) &&
          !names.includes("playwright-chromium");
        const dev = names.filter((n) => isDevDep(d.dir, n));
        const prod = names.filter((n) => !isDevDep(d.dir, n));
        if (addPlaywright) dev.push("playwright-chromium");
        const all = [...prod, ...dev];
        if (!all.length) throw new Error("Nothing to upgrade");
        d.logger.info("Upgrading {pkgs} in {dir}", {
          pkgs: all.join(", "),
          dir: d.dir,
        });

        const before = Object.fromEntries(
          all.map((n) => [n, installedVersion(d.dir, n)]),
        );
        for (const [group, flags] of [[prod, []], [dev, ["--save-dev"]]]) {
          if (!group.length) continue;
          const res = await npm(d, [
            "install",
            "--no-audit",
            "--no-fund",
            ...flags,
            ...group.map((n) => `${n}@latest`),
          ], args.timeoutMs);
          if (res.code !== 0) {
            throw new Error(
              `npm install failed (exit ${res.code}): ${
                tail(res.stderr || res.stdout)
              }`,
            );
          }
        }
        const changes = all.map((name) => ({
          name,
          from: before[name],
          to: installedVersion(d.dir, name),
        })).filter((c) => c.from !== c.to);
        d.logger.info("{n} packages changed: {list}", {
          n: changes.length,
          list: changes.map((c) => `${c.name} ${c.from || "(new)"} → ${c.to}`)
            .join(", ") || "none",
        });
        const handle = await context.writeResource("upgrade", "upgrade", {
          dir: d.dir,
          changes,
          skippedPinned,
          upgradedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    build: {
      description:
        "Check that the deck builds for production (slidev build), as a Pages deploy would; fails with the build log if it doesn't",
      arguments: TimeoutArgsSchema.extend({
        timeoutMs: z.number().int().positive().default(900000).describe(
          "Timeout for the build, including a first-run npm install",
        ),
      }),
      execute: async (
        args: TimeoutArgs & TestHooks,
        context: Context,
      ) => {
        const d = deck(context, args);
        d.logger.info("Building {dir} for production", { dir: d.dir });
        const started = Date.now();
        // The output goes to the throwaway container's /tmp, so the deck
        // directory is left as it was.
        const res = await runOnce(d, "build", {
          image: ["build", "--out", "/tmp/slidev-build"],
        }, args.timeoutMs);
        const log = tail(`${res.stdout}\n${res.stderr}`.trim(), 25);
        const ok = res.code === 0 && !/Build failed/.test(log);
        const durationMs = Date.now() - started;
        if (!ok) {
          throw new Error(
            `slidev build failed (exit ${res.code}), so a Pages deploy would fail too:\n${log}`,
          );
        }
        d.logger.info("Built in {s}s", {
          s: Math.round(durationMs / 1000),
        });
        const handle = await context.writeResource("build", "build", {
          dir: d.dir,
          ok,
          durationMs,
          log,
          builtAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    export: {
      description: "Export the deck to PDF (slidev export)",
      arguments: ExportArgsSchema,
      execute: async (args: ExportArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        d.logger.info("Exporting {dir} to PDF", { dir: d.dir });
        const work = await Deno.makeTempDir({ prefix: "slidev-export-" });
        try {
          const res = await runOnce(d, "export", {
            pre: bindMount(work, "/out"),
            image: [
              "export",
              "--output",
              "/out/slides.pdf",
              "--timeout",
              "60000",
              ...(args.withClicks ? ["--with-clicks"] : []),
              ...(args.dark ? ["--dark"] : []),
            ],
          }, args.timeoutMs);
          let pdf: Uint8Array;
          try {
            pdf = await Deno.readFile(`${work}/slides.pdf`);
          } catch {
            throw new Error(
              `slidev export produced no PDF (exit ${res.code}). It needs playwright-chromium (see the upgrade method).\n${
                tail(res.stderr || res.stdout)
              }`,
            );
          }
          const handle = await context.createFileWriter("pdf", "slides")
            .writeAll(pdf);
          d.logger.info("Exported {bytes} bytes of PDF", {
            bytes: pdf.length,
          });
          return { dataHandles: [handle] };
        } finally {
          await Deno.remove(work, { recursive: true }).catch(() => {});
        }
      },
    },

    init: {
      description:
        "Create a new Slidev deck at dir from the official template (npm init slidev), with playwright-chromium",
      arguments: InitArgsSchema,
      execute: async (args: InitArgs & TestHooks, context: Context) => {
        const d = deck(context, args, false);
        let exists = false;
        try {
          Deno.statSync(d.dir);
          exists = true;
        } catch { /* good */ }
        if (exists) throw new Error(`${d.dir} already exists`);
        const parent = d.dir.slice(0, d.dir.lastIndexOf("/")) || "/";
        const name = d.dir.slice(d.dir.lastIndexOf("/") + 1);
        if (!/^[a-z0-9][a-z0-9._-]*$/i.test(name)) {
          throw new Error(
            `Deck directory name "${name}" is not a valid npm name`,
          );
        }
        d.logger.info("Creating a Slidev deck at {dir}", { dir: d.dir });
        // The runtime can only mount a directory that exists.
        await Deno.mkdir(parent, { recursive: true });
        const res = await runOnce(
          { ...d, dir: parent },
          "init",
          {
            pre: ["--entrypoint", "bash"],
            image: ["-c", `echo n | npm init slidev@latest --yes ${name}`],
          },
          args.timeoutMs,
        );
        if (res.code !== 0 || !readJson(`${d.dir}/package.json`)) {
          throw new Error(
            `npm init slidev failed (exit ${res.code}): ${
              tail(res.stderr || res.stdout)
            }`,
          );
        }
        if (args.playwright) {
          const pw = await npm(d, [
            "install",
            "--no-audit",
            "--no-fund",
            "--save-dev",
            "playwright-chromium",
          ], args.timeoutMs);
          if (pw.code !== 0) {
            throw new Error(
              `The deck was created, but adding playwright-chromium failed: ${
                tail(pw.stderr || pw.stdout)
              }`,
            );
          }
        }
        const handle = await context.writeResource("deck", "deck", {
          dir: d.dir,
          slidevVersion: installedVersion(d.dir, "@slidev/cli"),
          playwright: args.playwright,
          createdAt: new Date().toISOString(),
        });
        d.logger.info("Created {dir}", { dir: d.dir });
        return { dataHandles: [handle] };
      },
    },

    scaffold: {
      description:
        "Add page numbers, a GitHub Pages deploy workflow, README, LICENSE and a starter slides.md to a deck from init, then git init and commit",
      arguments: ScaffoldArgsSchema,
      execute: async (args: ScaffoldArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        const git = gitIn(d.dir, args._git);
        let isRepo = false;
        try {
          Deno.statSync(`${d.dir}/.git`);
          isRepo = true;
        } catch { /* good */ }
        if (isRepo) {
          throw new Error(
            `${d.dir} is already a git repository; scaffold is for a new deck from init`,
          );
        }
        const name = d.dir.slice(d.dir.lastIndexOf("/") + 1);
        // Workflows pass unset inputs as "", so treat "" as not given.
        const author = args.author ||
          (await git(["config", "user.name"])).stdout;
        if (!author) {
          throw new Error(
            "No author given and git config user.name is not set",
          );
        }
        const info: DeckInfo = {
          name,
          title: args.title,
          author,
          email: args.email,
          copyright: args.copyright,
          year: new Date().getFullYear(),
        };
        d.logger.info("Scaffolding {name} ({title})", {
          name,
          title: args.title,
        });

        const files: Record<string, string> = {
          "components/Pagination.vue": PAGINATION_VUE,
          "global-top.vue": GLOBAL_TOP_VUE,
          ".github/workflows/deploy.yml": deployYml(name),
          "README.md": readme(info),
          "slides.md": slidesMd(info),
          ...(args.license ? { "LICENSE": license(info) } : {}),
        };
        let hasGitignore = false;
        try {
          hasGitignore = Deno.statSync(`${d.dir}/.gitignore`).isFile;
        } catch { /* write one */ }
        if (!hasGitignore) files[".gitignore"] = GITIGNORE;
        for (const [path, content] of Object.entries(files)) {
          const full = `${d.dir}/${path}`;
          await Deno.mkdir(full.slice(0, full.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(full, content);
        }

        // Workflows pass unset inputs as "", so treat "" as not given.
        if (args.lockfileFrom) {
          const src = args.lockfileFrom.replace(/\/+$/, "");
          let srcPkg: Record<string, unknown>;
          let srcLock: Record<string, unknown>;
          try {
            srcPkg = JSON.parse(await Deno.readTextFile(`${src}/package.json`));
            srcLock = JSON.parse(
              await Deno.readTextFile(`${src}/package-lock.json`),
            );
          } catch {
            throw new Error(
              `lockfileFrom ${src} needs a package.json and package-lock.json`,
            );
          }
          const pkgPath = `${d.dir}/package.json`;
          const pkg = JSON.parse(await Deno.readTextFile(pkgPath));
          for (const key of ["dependencies", "devDependencies", "overrides"]) {
            if (srcPkg[key]) pkg[key] = srcPkg[key];
            else delete pkg[key];
          }
          await Deno.writeTextFile(
            pkgPath,
            JSON.stringify(pkg, null, 2) + "\n",
          );
          // Keep this deck's name in the copied lockfile.
          srcLock.name = pkg.name;
          const root =
            (srcLock.packages as Record<string, Record<string, unknown>>)?.[""];
          if (root) root.name = pkg.name;
          await Deno.writeTextFile(
            `${d.dir}/package-lock.json`,
            JSON.stringify(srcLock, null, 2) + "\n",
          );
          d.logger.info("Installing the dependency versions locked in {src}", {
            src,
          });
          const res = await npm(
            d,
            ["ci", "--no-audit", "--no-fund"],
            args.timeoutMs,
          );
          if (res.code !== 0) {
            throw new Error(
              `npm ci with the lockfile from ${src} failed: ${
                tail(res.stderr || res.stdout)
              }`,
            );
          }
        }

        for (
          const cmd of [
            ["init", "--initial-branch=main"],
            ["add", "--all"],
            ["commit", "--quiet", "--message", "Initial slides"],
          ]
        ) {
          const r = await git(cmd);
          if (r.code !== 0) {
            throw new Error(
              `git ${cmd[0]} failed in ${d.dir}: ${tail(r.stderr || r.stdout)}`,
            );
          }
        }
        const commit = (await git(["rev-parse", "HEAD"])).stdout;
        d.logger.info("Committed {n} new files as {commit}", {
          n: Object.keys(files).length,
          commit: commit.slice(0, 7),
        });
        const handle = await context.writeResource("scaffold", "scaffold", {
          dir: d.dir,
          files: Object.keys(files).sort(),
          branch: "main",
          commit,
          scaffoldedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    push: {
      description:
        "Push the deck to a remote as origin (adding origin if it's missing) and set the branch to track it",
      arguments: PushArgsSchema,
      execute: async (args: PushArgs & TestHooks, context: Context) => {
        const d = deck(context, args);
        const git = gitIn(d.dir, args._git);
        d.logger.info("Pushing {branch} of {dir} to {remote}", {
          branch: args.branch,
          dir: d.dir,
          remote: args.remoteUrl,
        });
        const origin = await git(["remote", "get-url", "origin"]);
        if (origin.code !== 0) {
          const r = await git(["remote", "add", "origin", args.remoteUrl]);
          if (r.code !== 0) {
            throw new Error(`git remote add failed: ${tail(r.stderr)}`);
          }
        } else if (origin.stdout !== args.remoteUrl) {
          throw new Error(
            `origin is already ${origin.stdout}, not ${args.remoteUrl}; change it with git remote set-url if that's intended`,
          );
        }
        const r = await git(
          ["push", "--set-upstream", "origin", args.branch],
          300000,
        );
        if (r.code !== 0) {
          throw new Error(
            `git push failed: ${tail(r.stderr || r.stdout)}`,
          );
        }
        const commit = (await git(["rev-parse", args.branch])).stdout;
        d.logger.info("Pushed {commit} to {remote}", {
          commit: commit.slice(0, 7),
          remote: args.remoteUrl,
        });
        const handle = await context.writeResource("push", "push", {
          dir: d.dir,
          remoteUrl: args.remoteUrl,
          branch: args.branch,
          commit,
          pushedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
