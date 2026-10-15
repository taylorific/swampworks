// Keeping local copies of a hosted account's git repositories: working
// checkouts (`source`) or bare mirrors (`mirror`). After the first sync only
// the repositories active since the last one are touched. History that a
// force push or a deleted branch or tag would lose is kept under
// refs/backups/<time>/ in the local copy before it is overwritten.
//
// The same file is in @taylor/github and @taylor/bitbucket; keep them equal.

import { z } from "npm:zod@4";
import { commandRunner, type Run } from "./run.ts";

// How far before a sync's start the next sync looks back, so repositories
// pushed while one sync was listing aren't missed by the next.
const OVERLAP_MS = 10 * 60 * 1000;

export const SyncArgsSchema = z.object({
  directory: z.string().min(1).describe(
    "Directory holding the copies. Relative paths are from the swamp repository; ~ is your home directory.",
  ),
  mode: z.enum(["source", "mirror"]).default("source").describe(
    "source: a working checkout per repository (<name>), fast-forwarded on update. mirror: a bare `git clone --mirror` per repository (<name>.git).",
  ),
  days: z.number().int().positive().optional().describe(
    "Only repositories active in the last N days. Without it, only those active since the last sync of this mode into this directory, or all of them the first time.",
  ),
  all: z.boolean().default(false).describe(
    "Sync every repository, whatever the last sync or days say",
  ),
  concurrency: z.number().int().min(1).max(16).default(4).describe(
    "Repositories cloned or fetched at once",
  ),
});
export type SyncArgs = z.infer<typeof SyncArgsSchema>;

const RefChangeSchema = z.object({
  ref: z.string(),
  old: z.string(),
  new: z.string(),
  backup: z.string(),
});
type RefChange = z.infer<typeof RefChangeSchema>;

const SyncResultSchema = z.object({
  name: z.string(),
  path: z.string(),
  action: z.enum(["cloned", "updated", "unchanged", "failed"]),
  rewritten: z.array(RefChangeSchema),
  deleted: z.array(RefChangeSchema),
  note: z.string(),
  error: z.string(),
});
type SyncResult = z.infer<typeof SyncResultSchema>;

export const SyncStateSchema = z.object({
  owner: z.string(),
  mode: z.enum(["source", "mirror"]),
  directory: z.string(),
  since: z.string().nullable(),
  nextSince: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string(),
  listed: z.number(),
  synced: z.number(),
  cloned: z.number(),
  updated: z.number(),
  unchanged: z.number(),
  failed: z.number(),
  backups: z.number(),
  results: z.array(SyncResultSchema),
});
type SyncState = z.infer<typeof SyncStateSchema>;

/** The `sync` resource spec. */
export const syncResource = {
  description:
    "What the last sync did, per mode (instances sync-source, sync-mirror)",
  schema: SyncStateSchema,
  lifetime: "infinite",
  garbageCollection: 20,
};

/** What a sync needs to know about a repository. */
export interface SyncTarget {
  name: string;
  sshUrl: string;
  lastActivity: string;
  defaultBranch: string;
}

export interface SyncContext {
  repoDir: string;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warn(msg: string, props?: Record<string, unknown>): void;
    error(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
}

/** The ssh command git runs, or undefined for git's default. */
export function sshCommand(
  opts: { sshKeyPath?: string; knownHostsPath?: string },
): string | undefined {
  const q = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`;
  const parts = ["ssh"];
  if (opts.sshKeyPath) {
    parts.push("-i", q(opts.sshKeyPath), "-o", "IdentitiesOnly=yes");
  }
  if (opts.knownHostsPath) {
    // ssh splits this option's value on spaces unless it's double-quoted.
    if (opts.knownHostsPath.includes('"')) {
      throw new Error("knownHostsPath can't contain a double quote");
    }
    parts.push("-o", q(`UserKnownHostsFile="${opts.knownHostsPath}"`));
  }
  return parts.length > 1 ? parts.join(" ") : undefined;
}

/**
 * Runs git without ever prompting, optionally with an SSH key and a
 * known_hosts file of its own.
 */
export function gitRunner(
  bin: string,
  ssh: { sshKeyPath?: string; knownHostsPath?: string } = {},
): Run {
  const env: Record<string, string> = { GIT_TERMINAL_PROMPT: "0" };
  const cmd = sshCommand(ssh);
  if (cmd) env.GIT_SSH_COMMAND = cmd;
  return commandRunner(bin, {
    timeoutMs: 60 * 60 * 1000,
    hint: "Install git.",
    env,
  });
}

export function daysAgo(now: Date, days: number): string {
  return new Date(now.getTime() - days * 86400000).toISOString();
}

/** The latest of the given timestamps, ignoring empty ones. */
export function latest(...times: string[]): string {
  return times.filter(Boolean).sort().pop() ?? "";
}

/** Repositories active at or after `since` (all of them for null). */
export function activeSince<T extends { lastActivity: string }>(
  repos: T[],
  since: string | null,
): T[] {
  if (!since) return repos;
  const t = Date.parse(since);
  return repos.filter((r) => Date.parse(r.lastActivity) >= t);
}

/** Most recently active first. */
export function newestFirst<T extends { lastActivity: string; name: string }>(
  repos: T[],
): T[] {
  return repos.sort((a, b) =>
    b.lastActivity.localeCompare(a.lastActivity) || a.name.localeCompare(b.name)
  );
}

/** Resolves ~ and paths relative to the swamp repository. */
export function resolveDirectory(dir: string, repoDir: string): string {
  if (dir === "~" || dir.startsWith("~/")) {
    const home = Deno.env.get("HOME");
    if (!home) throw new Error("HOME is not set, so ~ can't be resolved");
    dir = home + dir.slice(1);
  }
  if (!dir.startsWith("/")) dir = `${repoDir}/${dir}`;
  return dir.replace(/\/+$/, "") || "/";
}

/** True when `from` (null: the beginning of time) reaches back to `to`. */
function covers(from: string | null, to: string | null): boolean {
  if (from === null) return true;
  if (to === null) return false;
  return Date.parse(from) <= Date.parse(to);
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** One line of `git fetch --porcelain`. */
interface FetchLine {
  flag: string;
  old: string;
  new: string;
  ref: string;
}

/** Parses `git fetch --porcelain` output. */
export function parseFetch(stdout: string): FetchLine[] {
  const lines: FetchLine[] = [];
  for (const line of stdout.split("\n")) {
    const m = /^(.) ([0-9a-f]+) ([0-9a-f]+) (\S+)$/.exec(line);
    if (m) lines.push({ flag: m[1], old: m[2], new: m[3], ref: m[4] });
  }
  return lines;
}

const ZERO = /^0+$/;

/**
 * The informative part of git's stderr: its first line (e.g. ssh's "Host key
 * verification failed.") and the `fatal:` line, without the advice git
 * prints after them.
 */
export function gitError(stderr: string): string {
  const lines = stderr.split("\n").map((l) => l.trim()).filter(Boolean);
  const fatal = lines.find((l) => /^(fatal|error):/.test(l));
  const parts = [lines[0], fatal].filter((l, i, a) => l && a.indexOf(l) === i);
  return parts.join(" ") || "failed";
}

/** Builds the per-repository sync for one mode. */
function syncer(
  git: Run,
  mode: "source" | "mirror",
  stamp: string,
  followDefaultBranch: boolean,
) {
  const fail = (what: string, r: { stderr: string; stdout: string }) =>
    new Error(`${what}: ${gitError(r.stderr || r.stdout)}`);

  // Refs whose history matters: branches and tags, not GitHub's pull refs.
  const watched = mode === "mirror"
    ? /^refs\/(heads|tags)\//
    : /^refs\/(remotes\/origin|tags)\//;
  // Tags come with --tags --force rather than a refspec, so --prune leaves
  // tags deleted upstream alone while moved tags are still updated.
  const fetchArgs = [
    "fetch",
    "--porcelain",
    "--prune",
    "--tags",
    "--force",
    "--no-auto-maintenance",
    "origin",
    ...(mode === "mirror"
      ? ["+refs/heads/*:refs/heads/*", "+refs/pull/*:refs/pull/*"]
      : ["+refs/heads/*:refs/remotes/origin/*"]),
  ];

  const backupName = (ref: string) =>
    `refs/backups/${stamp}/${ref.replace(/^refs\//, "")}`;

  // Creates the backup refs in one transaction: all of them or none.
  async function backupAll(
    path: string,
    refs: { ref: string; sha: string }[],
  ) {
    if (!refs.length) return;
    const input = refs.map((r) => `update ${backupName(r.ref)} ${r.sha}\n`)
      .join("");
    const r = await git(["-C", path, "update-ref", "--stdin"], input);
    if (r.code !== 0) {
      throw fail(`Backing up ${refs.length} refs (nothing was fetched)`, r);
    }
  }

  async function backup(path: string, ref: string, sha: string) {
    await backupAll(path, [{ ref, sha }]);
    return backupName(ref);
  }

  async function assertClean(path: string, why: string) {
    const r = await git([
      "-C",
      path,
      "status",
      "--porcelain",
      "--untracked-files=no",
    ]);
    if (r.code !== 0) throw fail("Checking for local changes", r);
    if (r.stdout) {
      throw new Error(
        `${why} and the checkout has uncommitted changes; left as is`,
      );
    }
  }

  // Switches to the default branch when the checkout is on another one.
  async function switchToDefault(path: string, branch: string) {
    if (!branch) return false;
    const cur = await git([
      "-C",
      path,
      "symbolic-ref",
      "-q",
      "--short",
      "HEAD",
    ]);
    if (cur.code === 0 && cur.stdout === branch) return false;
    const upstream = await git([
      "-C",
      path,
      "rev-parse",
      "-q",
      "--verify",
      `refs/remotes/origin/${branch}`,
    ]);
    if (upstream.code !== 0) return false;
    await assertClean(path, `checkout isn't on the default branch ${branch}`);
    const r = await git(["-C", path, "checkout", "-q", branch]);
    if (r.code !== 0) throw fail(`Checking out ${branch}`, r);
    return true;
  }

  // Fast-forwards the checked-out branch, or, when its upstream was
  // rewritten, backs it up and resets it to the upstream.
  async function updateCheckout(
    path: string,
    rewritten: RefChange[],
  ): Promise<{ moved: boolean; note: string }> {
    const any = await git([
      "-C",
      path,
      "for-each-ref",
      "--count=1",
      "refs/remotes/origin/",
    ]);
    if (any.code === 0 && !any.stdout) return { moved: false, note: "" }; // empty repository
    const branch = await git(["-C", path, "symbolic-ref", "-q", "HEAD"]);
    if (branch.code !== 0) {
      return { moved: false, note: "detached HEAD; checkout left as is" };
    }
    const upstream = await git([
      "-C",
      path,
      "rev-parse",
      "-q",
      "--verify",
      "@{upstream}",
    ]);
    if (upstream.code !== 0) {
      return {
        moved: false,
        note: "branch has no upstream (or it was deleted); checkout left as is",
      };
    }
    const head = await git(["-C", path, "rev-parse", "-q", "--verify", "HEAD"]);
    if (head.stdout === upstream.stdout) return { moved: false, note: "" };
    if (head.code !== 0) {
      // Unborn branch, e.g. cloned while the repository was empty.
      const r = await git(["-C", path, "reset", "-q", "--hard", "@{upstream}"]);
      if (r.code !== 0) throw fail("Checking out the upstream", r);
      return { moved: true, note: "" };
    }
    const ff = await git([
      "-C",
      path,
      "merge-base",
      "--is-ancestor",
      "HEAD",
      "@{upstream}",
    ]);
    if (ff.code === 0) {
      const r = await git([
        "-C",
        path,
        "merge",
        "-q",
        "--ff-only",
        "@{upstream}",
      ]);
      if (r.code !== 0) throw fail("Fast-forwarding", r);
      return { moved: true, note: "" };
    }
    if (ff.code !== 1) throw fail("Comparing with the upstream", ff);
    // Not a fast-forward: the upstream was force-pushed, or there are local
    // commits. Either way the old commits are kept in a backup ref.
    await assertClean(path, "upstream can't be fast-forwarded");
    const ref = branch.stdout;
    rewritten.push({
      ref,
      old: head.stdout,
      new: upstream.stdout,
      backup: await backup(path, ref, head.stdout),
    });
    const r = await git(["-C", path, "reset", "-q", "--hard", "@{upstream}"]);
    if (r.code !== 0) throw fail("Resetting to the upstream", r);
    return { moved: true, note: "" };
  }

  return async (dir: string, repo: SyncTarget): Promise<SyncResult> => {
    const path = `${dir}/${repo.name}${mode === "mirror" ? ".git" : ""}`;
    const result: SyncResult = {
      name: repo.name,
      path,
      action: "unchanged",
      rewritten: [],
      deleted: [],
      note: "",
      error: "",
    };
    try {
      if (!(await exists(path))) {
        const r = await git([
          "clone",
          "-q",
          ...(mode === "mirror" ? ["--mirror"] : []),
          repo.sshUrl,
          path,
        ]);
        if (r.code !== 0) throw fail("Cloning", r);
        result.action = "cloned";
        return result;
      }
      // A dry run says which refs the fetch would overwrite or delete; they
      // are backed up before anything changes.
      const dry = await git(["-C", path, ...fetchArgs, "--dry-run"]);
      if (dry.code !== 0) throw fail("Fetching", dry);
      const destructive = (lines: FetchLine[]) =>
        lines.filter((l) =>
          watched.test(l.ref) && !ZERO.test(l.old) &&
          (l.flag === "-" || l.flag === "+" || l.flag === "t")
        );
      const saved = new Map<string, string>();
      const planned = destructive(parseFetch(dry.stdout));
      await backupAll(path, planned.map((l) => ({ ref: l.ref, sha: l.old })));
      for (const l of planned) saved.set(l.ref, l.old);

      // Maintenance stays off so nothing is pruned before a late backup.
      const r = await git(["-C", path, ...fetchArgs]);
      const lines = parseFetch(r.stdout);
      const done = destructive(lines);
      // Anything pushed between the dry run and the fetch.
      const late = done.filter((l) => saved.get(l.ref) !== l.old);
      await backupAll(path, late.map((l) => ({ ref: l.ref, sha: l.old })));
      for (const l of done) {
        (l.flag === "-" ? result.deleted : result.rewritten).push({
          ref: l.ref,
          old: l.old,
          new: l.new,
          backup: backupName(l.ref),
        });
      }
      if (r.code !== 0) throw fail("Fetching", r);
      let moved = lines.some((l) => l.flag !== "=");
      if (mode === "source") {
        if (followDefaultBranch) {
          moved = (await switchToDefault(path, repo.defaultBranch)) || moved;
        }
        const c = await updateCheckout(path, result.rewritten);
        moved ||= c.moved;
        result.note = c.note;
      }
      result.action = moved ? "updated" : "unchanged";
    } catch (err) {
      result.action = "failed";
      result.error = (err as Error).message;
    }
    return result;
  };
}

async function pool<T, R>(
  items: T[],
  size: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, worker),
  );
  return out;
}

/**
 * Syncs the repositories `list` returns for the cutoff into the directory
 * and records the result in the `sync` resource.
 */
export async function runSync(opts: {
  args: SyncArgs;
  context: SyncContext;
  owner: string;
  git: Run;
  /** Repositories active since the cutoff (all of them for null). */
  list: (since: string | null) => Promise<SyncTarget[]>;
  /** In source mode, switch checkouts to the repository's default branch. */
  followDefaultBranch: boolean;
}) {
  const { args, context, owner, git } = opts;
  const startedAt = new Date();
  const dir = resolveDirectory(args.directory, context.repoDir);
  const stateName = `sync-${args.mode}`;

  // The oldest activity not yet synced into this directory; null means
  // nothing has been synced completely yet.
  const prev = await context.readResource(stateName) as SyncState | null;
  const pending = prev && prev.directory === dir ? prev.nextSince : null;
  const since = args.all
    ? null
    : args.days
    ? daysAgo(startedAt, args.days)
    : pending;

  const listed = await opts.list(since);
  const repos = activeSince(listed, since);
  context.logger.info(
    "Syncing {count} repositories of {owner} ({mode}) into {dir}" +
      (since ? ", active since {since}" : ""),
    { count: repos.length, owner, mode: args.mode, dir, since },
  );
  await Deno.mkdir(dir, { recursive: true });

  const stamp = startedAt.toISOString().replace(/[-:]|\.\d+/g, "");
  const one = syncer(git, args.mode, stamp, opts.followDefaultBranch);
  const results = await pool(repos, args.concurrency, async (repo) => {
    const r = await one(dir, repo);
    if (r.action === "failed") {
      context.logger.error("{name}: {error}", { name: r.name, error: r.error });
    } else {
      context.logger.info("{name}: {action}", {
        name: r.name,
        action: r.action,
      });
    }
    if (r.note) {
      context.logger.warn("{name}: {note}", { name: r.name, note: r.note });
    }
    for (const c of [...r.rewritten, ...r.deleted]) {
      context.logger.warn(
        "{name}: {ref} was {how}; old history kept as {backup}",
        {
          name: r.name,
          ref: c.ref,
          how: ZERO.test(c.new) ? "deleted" : "rewritten",
          backup: c.backup,
        },
      );
    }
    return r;
  });

  const count = (a: SyncResult["action"]) =>
    results.filter((r) => r.action === a).length;
  const failed = count("failed");
  // Move the cutoff forward only when this sync reached back to it and
  // everything succeeded; otherwise the next sync retries the same span.
  const nextSince = failed === 0 && covers(since, pending)
    ? new Date(startedAt.getTime() - OVERLAP_MS).toISOString()
    : pending;
  if (failed) {
    context.logger.warn(
      "{failed} repositories failed; the next sync retries them",
      { failed },
    );
  }
  return await context.writeResource("sync", stateName, {
    owner,
    mode: args.mode,
    directory: dir,
    since,
    nextSince,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    listed: listed.length,
    synced: repos.length,
    cloned: count("cloned"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    failed,
    backups: results.reduce(
      (n, r) => n + r.rewritten.length + r.deleted.length,
      0,
    ),
    results,
  });
}
