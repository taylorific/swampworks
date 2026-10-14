/**
 * Keeps the swamp-training Slidev deck honest about swamp: watches the swamp
 * repository's releases and retests the deck against a new one.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { checkCommand, type HelpNode } from "./_lib/cli.ts";
import { extractCommands } from "./_lib/deck.ts";
import { unifiedDiff } from "./_lib/diff.ts";
import { type Exec, extractLab, type LabStep, runLab } from "./_lib/lab.ts";

// `watch` asks GitHub for swamp's latest release and lists the commits since
// the release the deck was last tested against. `retest` downloads a release
// binary (checksum verified) and runs it in a throwaway sandbox (its own HOME,
// your swamp sign-in through SWAMP_CONFIG_DIR), so the swamp you have
// installed is never touched. It then checks three things:
//   commands  every `swamp ...` command in the deck against `swamp help`
//   lab       the @training/file-check lab, rebuilt from the slides and run
//   skills    what changed in the skills, CLAUDE.md and allowlist that
//             `swamp repo init` installs, since the last retest

const REPO = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;
const TAG = /^v?[0-9A-Za-z._-]+$/;

const GlobalArgsSchema = z.object({
  deckDir: z.string().describe(
    "Deck directory; relative paths resolve from the swamp repo",
  ),
  slidesFile: z.string().default("slides.md").describe(
    "Deck markdown file, relative to deckDir",
  ),
  upstream: z.string().regex(REPO).default("swamp-club/swamp").describe(
    "GitHub repository whose releases are watched",
  ),
  ghPath: z.string().default("gh").describe("GitHub CLI binary"),
  swampConfigDir: z.string().default("").describe(
    "Swamp config directory holding your sign-in, shared with the sandbox (default ~/.config/swamp)",
  ),
  ignore: z.array(z.string()).default([]).describe(
    "Regular expressions for deck commands that aren't real commands, such as a joke",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RetestArgsSchema = z.object({
  version: z.string().regex(TAG).optional().describe(
    "Release to test, e.g. v20261014.205128.0-sha.17edd435 (default: the latest)",
  ),
  force: z.boolean().default(false).describe(
    "Retest even when this release was already tested",
  ),
  keepSandbox: z.boolean().default(false).describe(
    "Keep the sandbox directory for debugging; its path is in the report",
  ),
});
type RetestArgs = z.infer<typeof RetestArgsSchema>;

const CommitSchema = z.object({
  sha: z.string(),
  date: z.string(),
  message: z.string(),
});
type Commit = z.infer<typeof CommitSchema>;

const UpstreamSchema = z.object({
  repo: z.string(),
  latest: z.string(),
  publishedAt: z.string(),
  url: z.string(),
  lastTested: z.string().nullable(),
  changed: z.boolean(),
  commits: z.array(CommitSchema),
  checkedAt: z.string(),
});

const CommandProblemSchema = z.object({
  text: z.string(),
  lines: z.array(z.number()),
  problems: z.array(z.string()),
});

const ReportSchema = z.object({
  version: z.string(),
  previousVersion: z.string().nullable(),
  platform: z.string(),
  testedAt: z.string(),
  ok: z.boolean(),
  commits: z.array(CommitSchema),
  commands: z.object({
    total: z.number(),
    ignored: z.number(),
    errors: z.array(CommandProblemSchema),
    legacy: z.array(CommandProblemSchema),
  }),
  lab: z.object({
    ok: z.boolean(),
    error: z.string().nullable(),
    steps: z.array(z.object({
      step: z.string(),
      slide: z.string(),
      line: z.number(),
      ok: z.boolean(),
      detail: z.string(),
    })),
  }),
  skills: z.object({
    baseline: z.boolean(),
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.object({ path: z.string(), diff: z.string() })),
  }),
  sandbox: z.string().nullable(),
});
type Report = z.infer<typeof ReportSchema>;

/** Files `swamp repo init` installs, by path: the snapshot `retest` saves. */
export interface Snapshot {
  version: string;
  files: Record<string, string>;
}

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface FileWriter {
  writeText(text: string): Promise<{ name: string }>;
}

interface Context {
  globalArgs: GlobalArgs;
  repoDir: string;
  modelType: string;
  modelId: string;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
  createFileWriter: (specName: string, name: string) => FileWriter;
  dataRepository: {
    getContent: (
      type: string,
      id: string,
      name: string,
    ) => Promise<Uint8Array | null>;
  };
}

/** Result of one `gh` call. */
export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `gh` with the given arguments. Injectable for tests. */
export type Gh = (args: string[]) => Promise<GhResult>;

/** Runs the GitHub CLI and captures its output. */
export function ghRunner(bin: string): Gh {
  return async (args) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs gh api and gh release download; argument lists are built in this file, see README What it runs
      out = await new Deno.Command(bin, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(600000),
      }).output();
    } catch (err) {
      throw new Error(
        `Cannot run ${bin}: ${
          (err as Error).message
        }. Install the GitHub CLI and run \`gh auth login\`.`,
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

function parseOrThrow(r: GhResult, what: string): Record<string, unknown> {
  if (r.code !== 0) {
    throw new Error(`${what} failed: ${r.stderr.replace(/^gh: /, "")}`);
  }
  return JSON.parse(r.stdout);
}

/** A release's tag, publish time and page. */
export interface Release {
  tag: string;
  publishedAt: string;
  url: string;
}

/** The latest release of `repo`, or the release tagged `tag`. */
export async function getRelease(
  gh: Gh,
  repo: string,
  tag?: string,
): Promise<Release> {
  const path = tag
    ? `repos/${repo}/releases/tags/${tag.startsWith("v") ? tag : `v${tag}`}`
    : `repos/${repo}/releases/latest`;
  const raw = parseOrThrow(
    await gh(["api", path]),
    `Reading ${tag ?? "the latest release"} of ${repo}`,
  );
  return {
    tag: String(raw.tag_name ?? ""),
    publishedAt: String(raw.published_at ?? ""),
    url: String(raw.html_url ?? ""),
  };
}

/** Commits after `base` up to `head`, newest first (GitHub returns at most 250). */
export async function commitsBetween(
  gh: Gh,
  repo: string,
  base: string,
  head: string,
): Promise<Commit[]> {
  if (base === head) return [];
  const raw = parseOrThrow(
    await gh(["api", `repos/${repo}/compare/${base}...${head}`]),
    `Comparing ${base}...${head}`,
  );
  const commits = (raw.commits ?? []) as {
    sha: string;
    commit: { message: string; committer?: { date?: string } };
  }[];
  return commits.map((c) => ({
    sha: c.sha.slice(0, 8),
    date: c.commit.committer?.date ?? "",
    message: c.commit.message.split("\n")[0],
  })).reverse();
}

/** The release asset for this machine. */
export function assetName(os: string, arch: string): string {
  const cpu = arch === "aarch64" || arch === "arm64" ? "aarch64" : arch;
  if (
    !["darwin", "linux"].includes(os) || !["aarch64", "x86_64"].includes(cpu)
  ) {
    throw new Error(
      `retest runs on macOS or Linux (x86_64 or aarch64), not ${os}-${arch}`,
    );
  }
  return `swamp-${os}-${cpu}`;
}

async function sha256(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Downloads a release binary into `dir`, checks it against checksums.txt and makes it executable. */
export async function downloadSwamp(
  gh: Gh,
  repo: string,
  tag: string,
  asset: string,
  dir: string,
): Promise<string> {
  const r = await gh([
    "release",
    "download",
    tag,
    "--repo",
    repo,
    "--pattern",
    asset,
    "--pattern",
    "checksums.txt",
    "--dir",
    dir,
  ]);
  if (r.code !== 0) {
    throw new Error(`Downloading ${asset} ${tag} failed: ${r.stderr}`);
  }
  const sums = await Deno.readTextFile(`${dir}/checksums.txt`);
  const expected = sums.split("\n").map((l) => l.trim().split(/\s+/)).find((
    p,
  ) => p[1] === asset)?.[0];
  const bin = `${dir}/${asset}`;
  const actual = await sha256(bin);
  if (!expected || expected.toLowerCase() !== actual) {
    throw new Error(
      `Checksum mismatch for ${asset} ${tag}: expected ${expected}, got ${actual}`,
    );
  }
  await Deno.chmod(bin, 0o755);
  return bin;
}

/** Runs commands in the sandbox: its own HOME, sharing only the swamp sign-in. */
export function sandboxExec(home: string, configDir: string): Exec {
  const env: Record<string, string> = {
    HOME: home,
    SWAMP_CONFIG_DIR: configDir,
    PATH: Deno.env.get("PATH") ?? "/usr/bin:/bin",
    TMPDIR: Deno.env.get("TMPDIR") ?? "/tmp",
    NO_COLOR: "1",
  };
  const lang = Deno.env.get("LANG");
  if (lang) env.LANG = lang;
  return async (argv, cwd) => {
    // swamp-quality-ignore deno-command: runs the downloaded swamp release and its bundled deno in a sandbox; commands come from the deck, see README What it runs
    const out = await new Deno.Command(argv[0], {
      args: argv.slice(1),
      cwd,
      env,
      clearEnv: true,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: AbortSignal.timeout(600000),
    }).output();
    const dec = new TextDecoder();
    const stdout = dec.decode(out.stdout);
    return { code: out.code, stdout, output: stdout + dec.decode(out.stderr) };
  };
}

/** Checks every deck command against the release's CLI schema, grouped by text. */
export async function checkDeckCommands(
  md: string,
  exec: Exec,
  swamp: string,
  cwd: string,
  ignore: string[],
): Promise<Report["commands"]> {
  const help = await exec([swamp, "help", "--no-telemetry"], cwd);
  if (help.code !== 0) throw new Error(`swamp help failed:\n${help.output}`);
  const root = JSON.parse(help.stdout).root as HelpNode;
  const hidden = new Map<string, HelpNode | null>();
  const lookup = async (path: string[]) => {
    const key = path.join(" ");
    if (!hidden.has(key)) {
      const r = await exec([swamp, "help", ...path, "--no-telemetry"], cwd);
      hidden.set(key, r.code === 0 ? JSON.parse(r.stdout).root : null);
    }
    return hidden.get(key) ?? null;
  };

  const patterns = ignore.map((p) => new RegExp(p));
  const all = extractCommands(md);
  const kept = all.filter((c) => !patterns.some((p) => p.test(c.text)));
  const byText = new Map<string, number[]>();
  for (const c of kept) {
    byText.set(c.text, [...byText.get(c.text) ?? [], c.line]);
  }

  const errors: Report["commands"]["errors"] = [];
  const legacy: Report["commands"]["legacy"] = [];
  for (const [text, lines] of byText) {
    const r = await checkCommand(text, root, lookup);
    if (r.status === "error") {
      errors.push({ text, lines, problems: r.problems });
    }
    if (r.status === "legacy") {
      legacy.push({ text, lines, problems: r.problems });
    }
  }
  return {
    total: kept.length,
    ignored: all.length - kept.length,
    errors,
    legacy,
  };
}

async function collect(
  dir: string,
  prefix: string,
  files: Record<string, string>,
): Promise<void> {
  let entries: Deno.DirEntry[];
  try {
    entries = [...Deno.readDirSync(dir)];
  } catch {
    return;
  }
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const path = `${dir}/${e.name}`;
    if (e.isDirectory) await collect(path, `${prefix}${e.name}/`, files);
    else if (e.isFile) {
      files[`${prefix}${e.name}`] = await Deno.readTextFile(path);
    }
  }
}

/** The files `swamp repo init` installed in the sandbox: CLAUDE.md, the allowlist and the skills. */
export async function takeSnapshot(
  version: string,
  repo: string,
  home: string,
): Promise<Snapshot> {
  const files: Record<string, string> = {};
  for (const f of ["CLAUDE.md", ".claude/settings.local.json"]) {
    try {
      files[f] = await Deno.readTextFile(`${repo}/${f}`);
    } catch { /* not installed by this release */ }
  }
  await collect(`${home}/.claude/skills`, "skills/", files);
  return { version, files };
}

/** What changed between two snapshots. With no earlier snapshot, this one is the baseline. */
export function compareSnapshots(
  prev: Snapshot | null,
  cur: Snapshot,
): Report["skills"] {
  if (!prev) return { baseline: true, added: [], removed: [], changed: [] };
  const before = prev.files;
  const after = cur.files;
  return {
    baseline: false,
    added: Object.keys(after).filter((p) => !(p in before)),
    removed: Object.keys(before).filter((p) => !(p in after)),
    changed: Object.keys(after).filter((p) =>
      p in before && before[p] !== after[p]
    ).map((path) => ({ path, diff: unifiedDiff(before[path], after[path]) })),
  };
}

function resolveDir(repoDir: string, dir: string): string {
  return dir.startsWith("/") ? dir : `${repoDir}/${dir}`;
}

function defaultConfigDir(): string {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  return `${xdg ?? `${Deno.env.get("HOME")}/.config`}/swamp`;
}

/** The `@taylor/swamp-training/deck` swamp behavior type. */
export const behavior = {
  type: "@taylor/swamp-training/deck",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    upstream: {
      description:
        "The latest swamp release and the commits since the last tested one (instance upstream)",
      schema: UpstreamSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
    report: {
      description:
        "One retest: commands, lab steps and skill changes (instance report)",
      schema: ReportSchema,
      lifetime: "infinite",
      garbageCollection: 50,
    },
  },
  files: {
    snapshot: {
      description:
        "Skills, CLAUDE.md and allowlist the tested release installs, to diff the next retest against (instance snapshot)",
      contentType: "application/json",
      lifetime: "infinite",
      garbageCollection: 5,
    },
  },
  methods: {
    watch: {
      description:
        "Check for a swamp release newer than the one the deck was last tested against",
      arguments: z.object({}),
      execute: async (
        args: { _gh?: Gh },
        context: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const latest = await getRelease(gh, g.upstream);
        const last = await context.readResource("report");
        const lastTested = last ? String(last.version) : null;
        const changed = latest.tag !== lastTested;
        const commits = lastTested && changed
          ? await commitsBetween(gh, g.upstream, lastTested, latest.tag)
          : [];
        if (changed) {
          context.logger.info(
            "{latest} is out; the deck was last tested against {last}",
            { latest: latest.tag, last: lastTested ?? "nothing yet" },
          );
        } else {
          context.logger.info("No new release; {latest} is already tested", {
            latest: latest.tag,
          });
        }
        const handle = await context.writeResource("upstream", "upstream", {
          repo: g.upstream,
          latest: latest.tag,
          publishedAt: latest.publishedAt,
          url: latest.url,
          lastTested,
          changed,
          commits,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },

    retest: {
      description:
        "Retest the deck against the latest swamp release (or `version`), unless that release was already tested",
      arguments: RetestArgsSchema,
      execute: async (
        args: RetestArgs & { _gh?: Gh },
        context: Context,
      ): Promise<{ dataHandles: { name: string }[] }> => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const release = await getRelease(gh, g.upstream, args.version);
        const last = await context.readResource("report");
        const previousVersion = last ? String(last.version) : null;
        if (previousVersion === release.tag && !args.force) {
          context.logger.info(
            "{version} was already tested; pass force=true to test it again",
            { version: release.tag },
          );
          return { dataHandles: [] };
        }

        const deckDir = resolveDir(context.repoDir, g.deckDir);
        const md = await Deno.readTextFile(`${deckDir}/${g.slidesFile}`);
        const asset = assetName(Deno.build.os, Deno.build.arch);
        const sandbox = await Deno.makeTempDir({ prefix: "swamp-training-" });
        const home = `${sandbox}/home`;
        const repo = `${sandbox}/repo`;
        try {
          await Deno.mkdir(home);
          await Deno.mkdir(repo);
          await Deno.mkdir(`${sandbox}/bin`);
          context.logger.info("Downloading {asset} {version}", {
            asset,
            version: release.tag,
          });
          const swamp = await downloadSwamp(
            gh,
            g.upstream,
            release.tag,
            asset,
            `${sandbox}/bin`,
          );
          const exec = sandboxExec(
            home,
            g.swampConfigDir || defaultConfigDir(),
          );
          const init = await exec(
            [swamp, "repo", "init", "--no-telemetry"],
            repo,
          );
          if (init.code !== 0) {
            throw new Error(`swamp repo init failed:\n${init.output}`);
          }

          context.logger.info("Checking the deck's commands");
          const commands = await checkDeckCommands(
            md,
            exec,
            swamp,
            repo,
            g.ignore,
          );

          context.logger.info("Running the @training/file-check lab");
          let steps: LabStep[] = [];
          let labError: string | null = null;
          try {
            steps = await runLab(extractLab(md), { repo, home, swamp, exec });
          } catch (err) {
            labError = (err as Error).message;
          }

          const snap = await takeSnapshot(release.tag, repo, home);
          const prevBytes = await context.dataRepository.getContent(
            context.modelType,
            context.modelId,
            "snapshot",
          );
          const prevSnap = prevBytes
            ? JSON.parse(new TextDecoder().decode(prevBytes)) as Snapshot
            : null;
          const skills = compareSnapshots(prevSnap, snap);

          const commits = previousVersion
            ? await commitsBetween(gh, g.upstream, previousVersion, release.tag)
            : [];
          const labOk = !labError && steps.every((s) => s.ok);
          const report: Report = {
            version: release.tag,
            previousVersion,
            platform: asset.replace(/^swamp-/, ""),
            testedAt: new Date().toISOString(),
            ok: commands.errors.length === 0 && labOk,
            commits,
            commands,
            lab: { ok: labOk, error: labError, steps },
            skills,
            sandbox: args.keepSandbox ? sandbox : null,
          };

          const failed = steps.filter((s) => !s.ok).length;
          const summary = {
            version: release.tag,
            errors: commands.errors.length,
            legacy: commands.legacy.length,
            failed: labError ? "all" : failed,
            changed: skills.changed.length + skills.added.length +
              skills.removed.length,
          };
          if (report.ok) {
            context.logger.info(
              "{version}: deck commands and lab pass ({legacy} legacy commands, {changed} skill files changed)",
              summary,
            );
          } else {
            context.logger.warn(
              "{version}: {errors} deck commands fail, {failed} lab steps fail, {changed} skill files changed",
              summary,
            );
          }

          const reportHandle = await context.writeResource(
            "report",
            "report",
            report,
          );
          const snapHandle = await context.createFileWriter(
            "snapshot",
            "snapshot",
          ).writeText(JSON.stringify(snap));
          return { dataHandles: [reportHandle, snapHandle] };
        } finally {
          if (!args.keepSandbox) {
            await Deno.remove(sandbox, { recursive: true }).catch(() => {});
          }
        }
      },
    },
  },
};
