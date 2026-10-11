import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import { type GhResult, model } from "./github_pages_site.ts";

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
const site = (buildType: string) =>
  ok({
    html_url: "https://taylorific.github.io/new-deck/",
    build_type: buildType,
    status: "built",
  });

/** A fake gh that returns queued responses per "METHOD path". */
function fakeGh(routes: Record<string, GhResult[]>) {
  const calls: string[][] = [];
  const gh = (args: string[]) => {
    calls.push(args);
    const i = args.indexOf("--method");
    const key = `${i >= 0 ? args[i + 1] : "GET"} ${args[i >= 0 ? i + 2 : 1]}`;
    const r = routes[key]?.shift();
    if (!r) throw new Error(`unexpected gh ${args.join(" ")}`);
    return Promise.resolve(r);
  };
  return { gh, calls };
}

async function ensure(routes: Record<string, GhResult[]>) {
  const { gh, calls } = fakeGh(routes);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      owner: "taylorific",
      repo: "new-deck",
    }),
    methodName: "ensure",
  });
  await model.methods.ensure.execute(
    { _gh: gh },
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  return { calls, site: r[r.length - 1]?.data as Record<string, unknown> };
}

const PATH = "repos/taylorific/new-deck/pages";

Deno.test("ensure enables Pages from Actions when Pages is off", async () => {
  const { calls, site: s } = await ensure({
    [`GET ${PATH}`]: [notFound, site("workflow")],
    [`POST ${PATH}`]: [ok({})],
  });
  assertEquals(calls[1], [
    "api",
    "--method",
    "POST",
    PATH,
    "-f",
    "build_type=workflow",
  ]);
  assertEquals([s.action, s.buildType, s.url], [
    "created",
    "workflow",
    "https://taylorific.github.io/new-deck/",
  ]);
});

Deno.test("ensure switches a branch-built site to Actions", async () => {
  const { calls, site: s } = await ensure({
    [`GET ${PATH}`]: [site("legacy"), site("workflow")],
    [`PUT ${PATH}`]: [{ code: 0, stdout: "", stderr: "" }],
  });
  assertEquals(calls[1].slice(1, 3), ["--method", "PUT"]);
  assertEquals(s.action, "switched");
});

Deno.test("ensure leaves an Actions site alone", async () => {
  const { calls, site: s } = await ensure({
    [`GET ${PATH}`]: [site("workflow"), site("workflow")],
  });
  assertEquals(calls.length, 2);
  assertEquals(s.action, "unchanged");
});

Deno.test("ensure surfaces API errors", async () => {
  await assertRejects(
    () =>
      ensure({
        [`GET ${PATH}`]: [notFound],
        [`POST ${PATH}`]: [{
          code: 1,
          stdout:
            '{"message":"Your current plan does not support GitHub Pages for this repository."}',
          stderr: "gh: (HTTP 422)",
        }],
      }),
    Error,
    "does not support GitHub Pages",
  );
});
