import { z } from "npm:zod@4";

// The GitHub Pages site of one repository, managed through the GitHub CLI
// (`gh api`), so it uses whatever account `gh auth login` set up and needs no
// token in a vault. `ensure` makes Pages build from GitHub Actions: it turns
// Pages on if it is off, switches a branch-built site over, and otherwise
// leaves the site alone. The repository needs a workflow that deploys Pages
// (actions/deploy-pages) for the site to have content.

const NAME = /^[A-Za-z0-9._-]+$/;

const GlobalArgsSchema = z.object({
  owner: z.string().regex(NAME).describe(
    "User or organization that owns the repository",
  ),
  repo: z.string().regex(NAME).describe("Repository name"),
  ghPath: z.string().default("gh").describe("GitHub CLI binary"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const SiteSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  url: z.string(),
  buildType: z.string(),
  status: z.string(),
  action: z.enum(["created", "switched", "unchanged"]),
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
      // swamp-quality-ignore deno-command: runs gh api from the GitHub CLI; argument lists are built in this file, see README What it runs
      out = await new Deno.Command(bin, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(60000),
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

/** True when a failed `gh api` call was a 404. */
export function isNotFound(r: GhResult): boolean {
  return r.code !== 0 && /\(HTTP 404\)/.test(r.stderr);
}

/** Parses `gh api` output, or throws with the API's message. */
export function parseOrThrow(
  r: GhResult,
  what: string,
): Record<string, unknown> {
  if (r.code !== 0) {
    let message = r.stderr.replace(/^gh: /, "");
    try {
      message = String(JSON.parse(r.stdout).message ?? message);
    } catch { /* not JSON */ }
    throw new Error(`${what} failed: ${message}`);
  }
  return r.stdout ? JSON.parse(r.stdout) : {};
}

/** The `@taylor/github-pages/site` swamp model type. */
export const model = {
  type: "@taylor/github-pages/site",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    site: {
      description: "The Pages site as GitHub reports it (instance site)",
      schema: SiteSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Make GitHub Pages build from GitHub Actions: enable Pages if it is off, switch a branch-built site, otherwise leave the site alone",
      arguments: z.object({}),
      execute: async (args: { _gh?: Gh }, context: Context) => {
        const g = context.globalArgs;
        const gh = args._gh ?? ghRunner(g.ghPath);
        const full = `${g.owner}/${g.repo}`;
        const path = `repos/${full}/pages`;
        context.logger.info("Ensuring Pages for {repo} builds from Actions", {
          repo: full,
        });

        let action: "created" | "switched" | "unchanged";
        const current = await gh(["api", path]);
        if (isNotFound(current)) {
          parseOrThrow(
            await gh([
              "api",
              "--method",
              "POST",
              path,
              "-f",
              "build_type=workflow",
            ]),
            `Enabling Pages for ${full}`,
          );
          action = "created";
        } else {
          const site = parseOrThrow(current, `Reading Pages for ${full}`);
          if (site.build_type === "workflow") {
            action = "unchanged";
          } else {
            parseOrThrow(
              await gh([
                "api",
                "--method",
                "PUT",
                path,
                "-f",
                "build_type=workflow",
              ]),
              `Switching Pages for ${full} to Actions`,
            );
            action = "switched";
          }
        }

        const site = parseOrThrow(
          await gh(["api", path]),
          `Reading Pages for ${full}`,
        );
        const data = {
          owner: g.owner,
          repo: g.repo,
          url: String(site.html_url ?? ""),
          buildType: String(site.build_type ?? ""),
          status: String(site.status ?? ""),
          action,
          checkedAt: new Date().toISOString(),
        };
        context.logger.info("Pages for {repo}: {action}, {url}", {
          repo: full,
          action,
          url: data.url,
        });
        const handle = await context.writeResource("site", "site", data);
        return { dataHandles: [handle] };
      },
    },
  },
};
