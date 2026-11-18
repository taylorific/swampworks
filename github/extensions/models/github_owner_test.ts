import {
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import { type GhResult } from "./_lib/gh.ts";
import { parseFetch, resolveDirectory } from "./_lib/git_sync.ts";
import { model } from "./github_owner.ts";
import { globToRegExp } from "./_lib/browse.ts";

type Ctx = Parameters<typeof model.methods.sync.execute>[1];

const ok = (body: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
});

interface Node {
  name: string;
  sshUrl?: string;
  owner?: string;
  createdAt: string;
  updatedAt?: string;
  pushedAt?: string | null;
}

const node = (n: Node) => ({
  name: n.name,
  owner: { login: n.owner ?? "systeminit" },
  sshUrl: n.sshUrl ?? `git@github.com:systeminit/${n.name}.git`,
  url: `https://github.com/systeminit/${n.name}`,
  isPrivate: false,
  isFork: false,
  isArchived: false,
  isEmpty: false,
  createdAt: n.createdAt,
  updatedAt: n.updatedAt ?? n.createdAt,
  pushedAt: n.pushedAt === undefined ? n.createdAt : n.pushedAt,
  defaultBranchRef: { name: "main" },
});

/** A fake gh serving the given pages of repositories in order. */
function fakeGh(pages: Node[][]) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const i = calls.length - 1;
    return Promise.resolve(ok({
      data: {
        repositoryOwner: {
          login: "systeminit",
          repositories: {
            pageInfo: {
              hasNextPage: i < pages.length - 1,
              endCursor: `c${i}`,
            },
            nodes: pages[i].map(node),
          },
        },
      },
    }));
  };
  return { gh, calls };
}

const daysAgo = (d: number) =>
  new Date(Date.now() - d * 86400000).toISOString();

async function list(pages: Node[][], args: Record<string, unknown> = {}) {
  const { gh, calls } = fakeGh(pages);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({ owner: "systeminit" }),
    methodName: "list",
  });
  await model.methods.list.execute(
    { ...model.methods.list.arguments.parse(args), _gh: gh },
    test.context as unknown as Parameters<typeof model.methods.list.execute>[1],
  );
  const repos = test.getWrittenResources()[0].data as Record<string, unknown>;
  const file = test.getWrittenFiles()[0];
  return { calls, repos, file };
}

Deno.test("list pages through every repository, newest first", async () => {
  const { calls, repos, file } = await list([
    [
      { name: "old", createdAt: daysAgo(400) },
      { name: "pushed", createdAt: daysAgo(300), pushedAt: daysAgo(1) },
    ],
    [
      { name: "new", createdAt: daysAgo(3), pushedAt: null },
      { name: "theirs", owner: "someone", createdAt: daysAgo(0) },
    ],
  ]);
  assertEquals(calls.length, 2);
  assertEquals(calls[0].some((a) => a.startsWith("cursor=")), false);
  assertEquals(calls[1].includes("cursor=c0"), true);
  assertEquals(repos.sshUrls, [
    "git@github.com:systeminit/pushed.git",
    "git@github.com:systeminit/new.git",
    "git@github.com:systeminit/old.git",
  ]);
  assertEquals(
    new TextDecoder().decode(file.content as Uint8Array).split("\n")[0],
    "git@github.com:systeminit/pushed.git",
  );
});

Deno.test("list with days keeps repositories created or updated since", async () => {
  const { repos } = await list([[
    { name: "old", createdAt: daysAgo(400) },
    { name: "renamed", createdAt: daysAgo(400), updatedAt: daysAgo(2) },
    { name: "new", createdAt: daysAgo(5) },
  ]], { days: 7 });
  assertEquals(
    (repos.repos as { name: string }[]).map((r) => r.name),
    ["renamed", "new"],
  );
});

Deno.test("parseFetch reads porcelain lines", () => {
  const a = "a".repeat(40), b = "b".repeat(40), z = "0".repeat(40);
  assertEquals(
    parseFetch(`+ ${a} ${b} refs/heads/main\n- ${a} ${z} refs/heads/gone\n`),
    [
      { flag: "+", old: a, new: b, ref: "refs/heads/main" },
      { flag: "-", old: a, new: z, ref: "refs/heads/gone" },
    ],
  );
});

Deno.test("resolveDirectory handles ~ and relative paths", () => {
  assertEquals(resolveDirectory("backup/", "/repo"), "/repo/backup");
  assertEquals(resolveDirectory("/abs", "/repo"), "/abs");
  assertEquals(
    resolveDirectory("~/x", "/repo"),
    `${Deno.env.get("HOME")}/x`,
  );
});

// --- sync against real git, with local bare repositories as "GitHub" ---

async function sh(cwd: string, ...args: string[]): Promise<string> {
  const out = await new Deno.Command("git", {
    args,
    cwd,
    env: {
      GIT_AUTHOR_NAME: "t",
      GIT_AUTHOR_EMAIL: "t@t",
      GIT_COMMITTER_NAME: "t",
      GIT_COMMITTER_EMAIL: "t@t",
    },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout).trim();
  if (out.code !== 0) {
    throw new Error(
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return text;
}

/** An upstream bare repository plus a work tree that pushes to it. */
async function upstream(root: string, name: string) {
  const bare = `${root}/gh/${name}.git`;
  const work = `${root}/work/${name}`;
  await Deno.mkdir(bare, { recursive: true });
  await sh(bare, "init", "-q", "--bare", "-b", "main");
  await Deno.mkdir(work, { recursive: true });
  await sh(work, "init", "-q", "-b", "main");
  await sh(work, "remote", "add", "origin", bare);
  const commit = async (msg: string) => {
    await Deno.writeTextFile(`${work}/f`, msg);
    await sh(work, "add", "f");
    await sh(work, "commit", "-q", "-m", msg);
    return await sh(work, "rev-parse", "HEAD");
  };
  return { bare, work, commit };
}

async function sync(
  root: string,
  nodes: Node[],
  args: Record<string, unknown>,
  stored: Record<string, Record<string, unknown>> = {},
) {
  const { gh } = fakeGh([nodes]);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({ owner: "systeminit" }),
    methodName: "sync",
    repoDir: root,
    storedResources: stored,
  });
  await model.methods.sync.execute(
    { ...model.methods.sync.arguments.parse(args), _gh: gh },
    test.context as unknown as Ctx,
  );
  const w = test.getWrittenResources();
  // deno-lint-ignore no-explicit-any
  const state = w[w.length - 1].data as any;
  return { state, stored: { [w[w.length - 1].name]: state } };
}

for (const mode of ["source", "mirror"] as const) {
  Deno.test(`sync ${mode}: clones, updates, and backs up force pushes`, async () => {
    const root = await Deno.makeTempDir();
    try {
      const a = await upstream(root, "alpha");
      const first = await a.commit("one");
      await sh(a.work, "push", "-q", "origin", "main");
      await sh(a.work, "push", "-q", "origin", "main:doomed");
      const nodes = [{
        name: "alpha",
        sshUrl: a.bare,
        createdAt: daysAgo(1),
      }];

      // First sync clones.
      let r = await sync(root, nodes, { directory: "copies", mode });
      assertEquals(r.state.results[0].action, "cloned");
      assertEquals(r.state.since, null);
      assertMatch(r.state.nextSince, /^\d{4}-/);
      const path = `${root}/copies/alpha${mode === "mirror" ? ".git" : ""}`;
      const head = mode === "mirror" ? "refs/heads/main" : "HEAD";

      // Force push main and delete a branch upstream.
      await sh(a.work, "commit", "-q", "--amend", "-m", "rewritten");
      const second = await sh(a.work, "rev-parse", "HEAD");
      await sh(a.work, "push", "-q", "-f", "origin", "main");
      await sh(a.work, "push", "-q", "origin", ":doomed");

      const pushed = [{ ...nodes[0], pushedAt: new Date().toISOString() }];
      r = await sync(root, pushed, { directory: "copies", mode }, r.stored);
      const res = r.state.results[0];
      assertEquals([res.action, res.error], ["updated", ""]);
      assertEquals(await sh(path, "rev-parse", head), second);
      // The overwritten and deleted history is kept.
      const backups = (await sh(
        path,
        "for-each-ref",
        "--format=%(objectname) %(refname)",
        "refs/backups/",
      )).split("\n");
      assertEquals(backups.length >= 2, true);
      for (const b of backups) assertEquals(b.split(" ")[0], first);
      assertEquals(res.deleted.length, 1);
      assertEquals(r.state.backups >= 2, true);

      // A repository inactive since the last sync is skipped.
      const quiet = [{ ...nodes[0], createdAt: daysAgo(30) }];
      r = await sync(root, quiet, { directory: "copies", mode }, r.stored);
      assertEquals(r.state.synced, 0);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  });
}

Deno.test("sync source leaves a dirty, diverged checkout alone and retries it", async () => {
  const root = await Deno.makeTempDir();
  try {
    const a = await upstream(root, "beta");
    await a.commit("one");
    await sh(a.work, "push", "-q", "origin", "main");
    const nodes = [{ name: "beta", sshUrl: a.bare, createdAt: daysAgo(1) }];
    let r = await sync(root, nodes, { directory: "copies" });
    const firstNext = r.state.nextSince;

    await sh(a.work, "commit", "-q", "--amend", "-m", "rewritten");
    await sh(a.work, "push", "-q", "-f", "origin", "main");
    await Deno.writeTextFile(`${root}/copies/beta/f`, "local edit");

    const pushed = [{ ...nodes[0], pushedAt: new Date().toISOString() }];
    r = await sync(root, pushed, { directory: "copies" }, r.stored);
    assertEquals(r.state.results[0].action, "failed");
    assertMatch(r.state.results[0].error, /uncommitted changes/);
    assertEquals(
      await Deno.readTextFile(`${root}/copies/beta/f`),
      "local edit",
    );
    // The cutoff didn't move, so the next sync tries again.
    assertEquals(r.state.nextSince, firstNext);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("sync with days on a fresh directory still syncs everything next time", async () => {
  const root = await Deno.makeTempDir();
  try {
    const a = await upstream(root, "gamma");
    await a.commit("one");
    await sh(a.work, "push", "-q", "origin", "main");
    const r = await sync(root, [{
      name: "gamma",
      sshUrl: a.bare,
      createdAt: daysAgo(1),
    }], { directory: "copies", mode: "mirror", days: 7 });
    assertEquals(r.state.results[0].action, "cloned");
    assertEquals(r.state.nextSince, null);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("globToRegExp matches names anywhere and paths whole", () => {
  const names = globToRegExp("slides.md");
  assertEquals(names.test("slides.md"), true);
  assertEquals(names.test("decks/caddy/SLIDES.md"), true);
  assertEquals(names.test("myslides.md"), false);
  const deep = globToRegExp("decks/**/*.md");
  assertEquals(deep.test("decks/a.md"), true);
  assertEquals(deep.test("decks/x/y/a.md"), true);
  assertEquals(deep.test("other/decks/a.md"), false);
  assertEquals(globToRegExp("*.md").test("a/b.md"), true);
  assertEquals(globToRegExp("a/*.md").test("a/b/c.md"), false);
});

/** A fake gh for browsing: the repository list, then routes by API path. */
function browseGh(routes: Record<string, GhResult>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    if (args[1] === "graphql") {
      return Promise.resolve(ok({
        data: {
          repositoryOwner: {
            login: "systeminit",
            repositories: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                node({ name: "deck", createdAt: daysAgo(1) }),
                node({ name: "tool", createdAt: daysAgo(2) }),
                {
                  ...node({ name: "blank", createdAt: daysAgo(3) }),
                  isEmpty: true,
                },
              ],
            },
          },
        },
      }));
    }
    const path = args[args.length - 1];
    const r = routes[path];
    if (!r) throw new Error(`unexpected gh ${args.join(" ")}`);
    return Promise.resolve(r);
  };
  return { gh, calls };
}

const treeBody = (...paths: string[]) =>
  ok({
    truncated: false,
    tree: paths.map((p) => ({ path: p, type: "blob", size: 10 })),
  });

async function run(
  method: "tree" | "read",
  routes: Record<string, GhResult>,
  args: Record<string, unknown>,
) {
  const { gh, calls } = browseGh(routes);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({ owner: "systeminit" }),
    methodName: method,
  });
  const m = model.methods[method];
  await m.execute(
    // deno-lint-ignore no-explicit-any
    { ...(m.arguments.parse(args) as any), _gh: gh },
    // deno-lint-ignore no-explicit-any
    test.context as any,
  );
  return { calls, test };
}

Deno.test("tree across repositories keeps only those with matches", async () => {
  const { calls, test } = await run("tree", {
    "repos/systeminit/deck/git/trees/main?recursive=1": treeBody(
      "slides.md",
      "README.md",
    ),
    "repos/systeminit/tool/git/trees/main?recursive=1": treeBody("main.go"),
  }, { pattern: "slides.md" });
  const w = test.getWrittenResources();
  assertEquals(w.length, 1);
  assertEquals(w[0].name, "tree--deck");
  const tree = w[0].data as Record<string, unknown>;
  assertEquals(tree.count, 1);
  assertEquals(
    (tree.entries as { path: string }[]).map((e) => e.path),
    ["slides.md"],
  );
  // The empty repository isn't asked for a tree.
  assertEquals(calls.some((c) => c.join(" ").includes("blank")), false);
});

Deno.test("tree of one repository uses its default branch", async () => {
  const { test } = await run("tree", {
    "repos/systeminit/tool": ok({ default_branch: "trunk" }),
    "repos/systeminit/tool/git/trees/trunk?recursive=1": treeBody("main.go"),
  }, { repo: "tool" });
  const tree = test.getWrittenResources()[0].data as Record<string, unknown>;
  assertEquals(tree.ref, "trunk");
  assertEquals(tree.count, 1);
});

Deno.test("read writes the file's text", async () => {
  const { calls, test } = await run("read", {
    "repos/systeminit/deck/contents/pages/caddy%20intro.md?ref=v1": {
      code: 0,
      stdout: "\n  indented: true\n# Caddy",
      stderr: "",
    },
  }, { repo: "deck", path: "pages/caddy intro.md", ref: "v1" });
  assertEquals(calls[0].includes("Accept: application/vnd.github.raw"), true);
  const f = test.getWrittenFiles()[0];
  assertEquals(f.name, "file--deck--pages-caddy-intro.md");
  assertEquals(
    new TextDecoder().decode(f.content as Uint8Array),
    "\n  indented: true\n# Caddy",
  );
});

Deno.test("read reports a missing file", async () => {
  await assertRejects(
    () =>
      run("read", {
        "repos/systeminit/deck/contents/nope.md?ref=main": {
          code: 1,
          stdout: "",
          stderr: "gh: Not Found (HTTP 404)",
        },
      }, { repo: "deck", path: "nope.md", ref: "main" }),
    Error,
    "No file nope.md",
  );
});
