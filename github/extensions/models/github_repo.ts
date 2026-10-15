import { z } from "npm:zod@4";
import { type Gh, ghRunner, isNotFound, parseOrThrow } from "./_lib/gh.ts";

export {
  type Gh,
  type GhResult,
  ghRunner,
  isNotFound,
  parseOrThrow,
} from "./_lib/gh.ts";

// A GitHub repository, managed through the GitHub CLI (`gh api`), so it uses
// whatever account `gh auth login` set up and needs no token in a vault.
// `ensure` creates the repository if it is missing and otherwise only reports
// it: an existing repository's settings are never changed.

const NAME = /^[A-Za-z0-9._-]+$/;

const GlobalArgsSchema = z.object({
  owner: z.string().regex(NAME).describe(
    "User or organization that owns the repository",
  ),
  name: z.string().regex(NAME).describe("Repository name"),
  ghPath: z.string().default("gh").describe("GitHub CLI binary"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const EnsureArgsSchema = z.object({
  description: z.string().max(350).optional().describe(
    "Description for a new repository",
  ),
  visibility: z.enum(["public", "private"]).default("public").describe(
    "Visibility for a new repository. An existing repository keeps its own; a difference is reported as a warning.",
  ),
});
type EnsureArgs = z.infer<typeof EnsureArgsSchema>;

const RepoSchema = z.object({
  owner: z.string(),
  name: z.string(),
  url: z.string(),
  sshUrl: z.string(),
  cloneUrl: z.string(),
  description: z.string(),
  visibility: z.enum(["public", "private"]),
  defaultBranch: z.string(),
  action: z.enum(["created", "exists"]),
  checkedAt: z.string(),
});

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface Context {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

function toRepo(
  raw: Record<string, unknown>,
  action: "created" | "exists",
): z.infer<typeof RepoSchema> {
  return {
    owner: String((raw.owner as { login?: string })?.login ?? ""),
    name: String(raw.name ?? ""),
    url: String(raw.html_url ?? ""),
    sshUrl: String(raw.ssh_url ?? ""),
    cloneUrl: String(raw.clone_url ?? ""),
    description: String(raw.description ?? ""),
    visibility: raw.private ? "private" : "public",
    defaultBranch: String(raw.default_branch ?? ""),
    action,
    checkedAt: new Date().toISOString(),
  };
}

/** The `@taylor/github/repo` swamp model type. */
export const model = {
  type: "@taylor/github/repo",
  version: "2026.10.15.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.15.2",
      description: "Moves the gh helpers to _lib/gh.ts; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    repo: {
      description: "The repository as GitHub reports it (instance repo)",
      schema: RepoSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Create the repository if it doesn't exist; otherwise report it unchanged",
      arguments: EnsureArgsSchema,
      execute: async (args: EnsureArgs & { _gh?: Gh }, context: Context) => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const full = `${g.owner}/${g.name}`;
        context.logger.info("Ensuring {repo} exists", { repo: full });

        const existing = await gh(["api", `repos/${full}`]);
        let repo: z.infer<typeof RepoSchema>;
        if (!isNotFound(existing)) {
          repo = toRepo(parseOrThrow(existing, `Reading ${full}`), "exists");
          if (repo.visibility !== args.visibility) {
            context.logger.warn(
              "{repo} already exists and is {actual}, not {wanted}; left as is",
              { repo: full, actual: repo.visibility, wanted: args.visibility },
            );
          }
          context.logger.info("{repo} already exists", { repo: full });
        } else {
          // A user can only create repositories for the account gh is
          // logged in as; organizations have their own endpoint.
          const me = parseOrThrow(
            await gh(["api", "user"]),
            "Reading the gh account",
          );
          const login = String(me.login ?? "");
          let endpoint = "user/repos";
          if (login.toLowerCase() !== g.owner.toLowerCase()) {
            const owner = parseOrThrow(
              await gh(["api", `users/${g.owner}`]),
              `Looking up ${g.owner}`,
            );
            if (owner.type !== "Organization") {
              throw new Error(
                `gh is logged in as ${login} and can't create repositories for the user ${g.owner}`,
              );
            }
            endpoint = `orgs/${g.owner}/repos`;
          }
          const created = await gh([
            "api",
            "--method",
            "POST",
            endpoint,
            "-f",
            `name=${g.name}`,
            "-F",
            `private=${args.visibility === "private"}`,
            ...(args.description
              ? ["-f", `description=${args.description}`]
              : []),
          ]);
          repo = toRepo(parseOrThrow(created, `Creating ${full}`), "created");
          context.logger.info("Created {visibility} repository {url}", {
            visibility: repo.visibility,
            url: repo.url,
          });
        }
        const handle = await context.writeResource("repo", "repo", repo);
        return { dataHandles: [handle] };
      },
    },
  },
};
