import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import { type GhResult, isNotFound, model } from "./github_repo.ts";

type Ctx = Parameters<typeof model.methods.ensure.execute>[1];

const ok = (body: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
});
const notFound: GhResult = {
  code: 1,
  stdout: '{"message":"Not Found","status":"404"}',
  stderr: "gh: Not Found (HTTP 404)",
};
const repoBody = (name: string, priv = false) => ({
  name,
  private: priv,
  description: "Deck",
  html_url: `https://github.com/taylorific/${name}`,
  ssh_url: `git@github.com:taylorific/${name}.git`,
  clone_url: `https://github.com/taylorific/${name}.git`,
  default_branch: "main",
  owner: { login: "taylorific" },
});

/** A fake gh: routes by "METHOD path" and records every call. */
function fakeGh(routes: Record<string, GhResult>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const i = args.indexOf("--method");
    const method = i >= 0 ? args[i + 1] : "GET";
    const path =
      args.filter((a, j) =>
        j > 0 && args[j - 1] !== "--method" && args[j - 1] !== "-f" &&
        args[j - 1] !== "-F" && !a.startsWith("-")
      )[0];
    const r = routes[`${method} ${path}`];
    if (!r) throw new Error(`unexpected gh ${args.join(" ")}`);
    return Promise.resolve(r);
  };
  return { gh, calls };
}

async function ensure(
  routes: Record<string, GhResult>,
  args: Record<string, unknown> = {},
  globals: Record<string, unknown> = {},
) {
  const { gh, calls } = fakeGh(routes);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      owner: "taylorific",
      name: "new-deck",
      ...globals,
    }),
    methodName: "ensure",
  });
  await model.methods.ensure.execute(
    { ...model.methods.ensure.arguments.parse(args), _gh: gh },
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  return { calls, repo: r[r.length - 1]?.data as Record<string, unknown> };
}

Deno.test("isNotFound only matches 404s", () => {
  assertEquals(isNotFound(notFound), true);
  assertEquals(
    isNotFound({
      code: 1,
      stdout: "",
      stderr: "gh: Bad credentials (HTTP 401)",
    }),
    false,
  );
});

Deno.test("ensure reports an existing repository without changing it", async () => {
  const { calls, repo } = await ensure({
    "GET repos/taylorific/new-deck": ok(repoBody("new-deck")),
  });
  assertEquals(calls.length, 1);
  assertEquals([repo.action, repo.visibility, repo.sshUrl], [
    "exists",
    "public",
    "git@github.com:taylorific/new-deck.git",
  ]);
});

Deno.test("ensure creates a missing repository for the logged-in user", async () => {
  const { calls, repo } = await ensure({
    "GET repos/taylorific/new-deck": notFound,
    "GET user": ok({ login: "taylorific" }),
    "POST user/repos": ok(repoBody("new-deck")),
  }, { description: "New Deck" });
  assertEquals(calls[2], [
    "api",
    "--method",
    "POST",
    "user/repos",
    "-f",
    "name=new-deck",
    "-F",
    "private=false",
    "-f",
    "description=New Deck",
  ]);
  assertEquals(repo.action, "created");
});

Deno.test("ensure creates in an organization", async () => {
  const { calls } = await ensure(
    {
      "GET repos/boxcutter/new-deck": notFound,
      "GET user": ok({ login: "taylorific" }),
      "GET users/boxcutter": ok({ type: "Organization" }),
      "POST orgs/boxcutter/repos": ok(repoBody("new-deck", true)),
    },
    { visibility: "private" },
    { owner: "boxcutter" },
  );
  assertEquals(calls[3].slice(3, 4), ["orgs/boxcutter/repos"]);
  assertEquals(calls[3].includes("private=true"), true);
});

Deno.test("ensure refuses another user's account", async () => {
  await assertRejects(
    () =>
      ensure(
        {
          "GET repos/someone/new-deck": notFound,
          "GET user": ok({ login: "taylorific" }),
          "GET users/someone": ok({ type: "User" }),
        },
        {},
        { owner: "someone" },
      ),
    Error,
    "can't create repositories for the user someone",
  );
});

Deno.test("ensure surfaces API errors with GitHub's message", async () => {
  await assertRejects(
    () =>
      ensure({
        "GET repos/taylorific/new-deck": {
          code: 1,
          stdout: '{"message":"Bad credentials"}',
          stderr: "gh: Bad credentials (HTTP 401)",
        },
      }),
    Error,
    "Reading taylorific/new-deck failed: Bad credentials",
  );
});
