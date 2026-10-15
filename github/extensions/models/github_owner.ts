import { z } from "npm:zod@4";
import { type Gh, ghRunner, parseOrThrow } from "./_lib/gh.ts";
import {
  activeSince,
  daysAgo,
  gitRunner,
  latest,
  newestFirst,
  runSync,
  type SyncArgs,
  SyncArgsSchema,
  type SyncContext,
  syncResource,
} from "./_lib/git_sync.ts";

// All the repositories of a GitHub user or organization. `list` reports their
// SSH URLs, newest first. `sync` keeps local copies of them; see
// _lib/git_sync.ts.

const NAME = /^[A-Za-z0-9._-]+$/;

const GlobalArgsSchema = z.object({
  owner: z.string().regex(NAME).describe(
    "User or organization whose repositories these are",
  ),
  ghPath: z.string().default("gh").describe("GitHub CLI binary"),
  gitPath: z.string().default("git").describe("git binary"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ListArgsSchema = z.object({
  days: z.number().int().positive().optional().describe(
    "Only repositories created, pushed to or updated in the last N days",
  ),
});
type ListArgs = z.infer<typeof ListArgsSchema>;

const RepoEntrySchema = z.object({
  name: z.string(),
  sshUrl: z.string(),
  url: z.string(),
  visibility: z.enum(["public", "private"]),
  fork: z.boolean(),
  archived: z.boolean(),
  empty: z.boolean(),
  defaultBranch: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  pushedAt: z.string(),
  lastActivity: z.string(),
});
type RepoEntry = z.infer<typeof RepoEntrySchema>;

const ReposSchema = z.object({
  owner: z.string(),
  since: z.string().nullable(),
  count: z.number(),
  sshUrls: z.array(z.string()),
  repos: z.array(RepoEntrySchema),
  listedAt: z.string(),
});

interface DataWriter {
  writeText(text: string): Promise<{ name: string }>;
}

interface Context extends SyncContext {
  globalArgs: GlobalArgs;
  createFileWriter: (specName: string, name: string) => DataWriter;
}

const QUERY = `query($owner: String!, $cursor: String) {
  repositoryOwner(login: $owner) {
    login
    repositories(first: 100, after: $cursor, orderBy: {field: CREATED_AT, direction: DESC}) {
      pageInfo { hasNextPage endCursor }
      nodes {
        name owner { login } sshUrl url isPrivate isFork isArchived isEmpty
        createdAt updatedAt pushedAt defaultBranchRef { name }
      }
    }
  }
}`;

/** Lists every repository the owner owns, most recently active first. */
export async function listRepos(gh: Gh, owner: string): Promise<RepoEntry[]> {
  const repos: RepoEntry[] = [];
  let cursor: string | null = null;
  do {
    const body = parseOrThrow(
      await gh([
        "api",
        "graphql",
        "-f",
        `query=${QUERY}`,
        "-f",
        `owner=${owner}`,
        ...(cursor ? ["-f", `cursor=${cursor}`] : []),
      ]),
      `Listing repositories of ${owner}`,
    );
    // deno-lint-ignore no-explicit-any
    const ro = (body.data as any)?.repositoryOwner;
    if (!ro) throw new Error(`No GitHub user or organization named ${owner}`);
    const page = ro.repositories;
    // deno-lint-ignore no-explicit-any
    for (const n of page.nodes as any[]) {
      // A user's list includes repositories they collaborate on.
      if (String(n.owner?.login).toLowerCase() !== owner.toLowerCase()) {
        continue;
      }
      const createdAt = String(n.createdAt ?? "");
      const updatedAt = String(n.updatedAt ?? "");
      const pushedAt = String(n.pushedAt ?? "");
      repos.push({
        name: String(n.name),
        sshUrl: String(n.sshUrl),
        url: String(n.url),
        visibility: n.isPrivate ? "private" : "public",
        fork: Boolean(n.isFork),
        archived: Boolean(n.isArchived),
        empty: Boolean(n.isEmpty),
        defaultBranch: String(n.defaultBranchRef?.name ?? ""),
        createdAt,
        updatedAt,
        pushedAt,
        lastActivity: latest(createdAt, updatedAt, pushedAt),
      });
    }
    cursor = page.pageInfo?.hasNextPage ? page.pageInfo.endCursor : null;
  } while (cursor);
  return newestFirst(repos);
}

/** The `@taylor/github/owner` swamp model type. */
export const model = {
  type: "@taylor/github/owner",
  version: "2026.10.15.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.15.2",
      description: "Version aligned with the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    repos: {
      description:
        "The owner's repositories, most recently active first (instance repos)",
      schema: ReposSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    sync: syncResource,
  },
  files: {
    sshUrls: {
      description:
        "The listed repositories' SSH URLs, one per line, newest first (instance ssh-urls)",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List the owner's repositories newest first, optionally only those active in the last N days",
      arguments: ListArgsSchema,
      execute: async (args: ListArgs & { _gh?: Gh }, context: Context) => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const now = new Date();
        const since = args.days ? daysAgo(now, args.days) : null;
        const repos = activeSince(await listRepos(gh, g.owner), since);
        for (const r of repos) context.logger.info(r.sshUrl);
        context.logger.info("{count} repositories of {owner}", {
          count: repos.length,
          owner: g.owner,
        });
        const sshUrls = repos.map((r) => r.sshUrl);
        const handle = await context.writeResource("repos", "repos", {
          owner: g.owner,
          since,
          count: repos.length,
          sshUrls,
          repos,
          listedAt: now.toISOString(),
        });
        const file = await context.createFileWriter("sshUrls", "ssh-urls")
          .writeText(sshUrls.map((u) => `${u}\n`).join(""));
        return { dataHandles: [handle, file] };
      },
    },
    sync: {
      description:
        "Clone or update local copies of the owner's repositories active since the last sync, keeping force-pushed history in backup refs",
      arguments: SyncArgsSchema,
      execute: async (
        args: SyncArgs & { _gh?: Gh; _git?: Gh },
        context: Context,
      ) => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const handle = await runSync({
          args,
          context,
          owner: g.owner,
          git: args._git ?? gitRunner(g.gitPath),
          list: () => listRepos(gh, g.owner),
          followDefaultBranch: false,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
