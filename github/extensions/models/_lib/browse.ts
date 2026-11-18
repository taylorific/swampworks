// Browsing a repository's files through the GitHub API, without cloning it:
// the file tree at a ref, and one file's contents.

import { z } from "npm:zod@4";
import { type Gh, isNotFound, parseOrThrow } from "./gh.ts";

export const TreeEntrySchema = z.object({
  path: z.string(),
  type: z.enum(["blob", "tree", "commit"]),
  size: z.number().nullable(),
});
export type TreeEntry = z.infer<typeof TreeEntrySchema>;

export const TreeSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  ref: z.string(),
  pattern: z.string().nullable(),
  truncated: z.boolean(),
  count: z.number(),
  entries: z.array(TreeEntrySchema),
  listedAt: z.string(),
});
export type Tree = z.infer<typeof TreeSchema>;

/**
 * A glob as a case-insensitive regex over a whole path. `**` matches across
 * directories, `*` and `?` within one. A glob without a `/` matches the
 * file name in any directory.
 */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*" && glob[i + 1] === "*") {
      // `**/` matches zero or more directories.
      if (glob[i + 2] === "/") {
        re += "(?:.*/)?";
        i += 2;
      } else {
        re += ".*";
        i += 1;
      }
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  const anchored = glob.includes("/") ? `^${re}$` : `(?:^|/)${re}$`;
  return new RegExp(anchored, "i");
}

/** Encodes a repository path for a URL, keeping its slashes. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

/** The repository's default branch, or "" for an empty repository. */
export async function defaultBranch(
  gh: Gh,
  owner: string,
  repo: string,
): Promise<string> {
  const body = parseOrThrow(
    await gh(["api", `repos/${owner}/${repo}`]),
    `Reading ${owner}/${repo}`,
  );
  return String(body.default_branch ?? "");
}

/** The files and directories at `ref`, optionally only those matching `pattern`. */
export async function readTree(
  gh: Gh,
  owner: string,
  repo: string,
  ref: string,
  pattern?: string,
): Promise<Tree> {
  const r = await gh([
    "api",
    `repos/${owner}/${repo}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
  ]);
  let entries: TreeEntry[] = [];
  let truncated = false;
  // An empty repository answers 409 Conflict; it simply has no files.
  if (!(r.code !== 0 && /\(HTTP 409\)/.test(r.stderr))) {
    const body = parseOrThrow(r, `Reading the tree of ${owner}/${repo}`);
    truncated = Boolean(body.truncated);
    // deno-lint-ignore no-explicit-any
    entries = ((body.tree ?? []) as any[]).map((e) => ({
      path: String(e.path),
      type: e.type === "tree" || e.type === "commit" ? e.type : "blob",
      size: typeof e.size === "number" ? e.size : null,
    }));
  }
  if (pattern) {
    const re = globToRegExp(pattern);
    entries = entries.filter((e) => re.test(e.path));
  }
  return {
    owner,
    repo,
    ref,
    pattern: pattern ?? null,
    truncated,
    count: entries.length,
    entries,
    listedAt: new Date().toISOString(),
  };
}

/** One file's contents at `ref`, as text. */
export async function readFile(
  gh: Gh,
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string> {
  const r = await gh([
    "api",
    "-H",
    "Accept: application/vnd.github.raw",
    `repos/${owner}/${repo}/contents/${encodePath(path)}?ref=${
      encodeURIComponent(ref)
    }`,
  ]);
  if (isNotFound(r)) {
    throw new Error(`No file ${path} in ${owner}/${repo} at ${ref}`);
  }
  if (r.code !== 0) {
    throw new Error(
      `Reading ${path} in ${owner}/${repo} failed: ${
        r.stderr.replace(/^gh: /, "")
      }`,
    );
  }
  if (r.stdout.startsWith("[")) {
    // A directory comes back as a JSON listing even with the raw media type.
    try {
      if (Array.isArray(JSON.parse(r.stdout))) {
        throw new Error(`${path} in ${owner}/${repo} is a directory`);
      }
    } catch (err) {
      if (!(err instanceof SyntaxError)) throw err;
    }
  }
  if (r.stdout.includes("\u0000")) {
    throw new Error(`${path} in ${owner}/${repo} is a binary file`);
  }
  return r.stdout;
}

/** A data instance name made from free text. */
export function instanceName(...parts: string[]): string {
  return parts.join("--").replace(/[^A-Za-z0-9._-]+/g, "-").replace(
    /^-+|-+$/g,
    "",
  );
}
