import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  assetName,
  behavior,
  compareSnapshots,
  compareVersions,
  type GhResult,
  refOf,
} from "./swamp_training_deck.ts";

type WatchCtx = Parameters<typeof behavior.methods.watch.execute>[1];
type RetestCtx = Parameters<typeof behavior.methods.retest.execute>[1];

const ok = (body: unknown): GhResult => ({
  code: 0,
  stdout: JSON.stringify(body),
  stderr: "",
});

/** A fake gh: routes `gh api <path>` and records every call. */
function fakeGh(routes: Record<string, GhResult>) {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    calls.push(args.join(" "));
    const r = routes[args.join(" ")];
    if (!r) throw new Error(`unexpected gh ${args.join(" ")}`);
    return Promise.resolve(r);
  };
  return { gh, calls };
}

const latest = ok({
  tag_name: "v2",
  published_at: "2026-10-14T00:00:00Z",
  html_url: "https://github.com/swamp-club/swamp/releases/tag/v2",
});
const compare = ok({
  commits: [
    {
      sha: "aaaaaaaa1111",
      commit: { message: "first\n\nbody", committer: { date: "d1" } },
    },
    {
      sha: "bbbbbbbb2222",
      commit: { message: "second", committer: { date: "d2" } },
    },
  ],
});

function context(
  stored: Record<string, Record<string, unknown>> = {},
  installedSwamp = "",
) {
  return createModelTestContext({
    globalArgs: behavior.globalArguments.parse({
      deckDir: "/deck",
      installedSwamp,
    }),
    storedResources: stored,
  });
}

Deno.test("watch lists the commits since the last tested release", async () => {
  const { gh, calls } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
    "api repos/swamp-club/swamp/compare/v1...v2": compare,
  });
  const test = context({ report: { version: "v1" } });
  await behavior.methods.watch.execute(
    { _gh: gh },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals([up.latest, up.lastTested, up.changed], ["v2", "v1", true]);
  assertEquals(up.commits, [
    { sha: "bbbbbbbb", date: "d2", message: "second" },
    { sha: "aaaaaaaa", date: "d1", message: "first" },
  ]);
  assertEquals([up.commitsTotal, up.commitsTruncated], [2, false]);
  assertEquals(calls.length, 2);
});

Deno.test("watch says when GitHub cut the commit list short", async () => {
  const body = JSON.parse(compare.stdout);
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
    "api repos/swamp-club/swamp/compare/v1...v2": ok({
      ...body,
      total_commits: 300,
    }),
  });
  const test = context({ report: { version: "v1" } });
  await behavior.methods.watch.execute(
    { _gh: gh },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals([up.commitsTotal, up.commitsTruncated], [300, true]);
});

Deno.test("watch reports no change when the latest release is tested", async () => {
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
  });
  const test = context({ report: { version: "v2" } });
  await behavior.methods.watch.execute(
    { _gh: gh },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals([up.changed, up.commits], [false, []]);
});

Deno.test("watch before any retest has nothing to compare", async () => {
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
  });
  const test = context();
  await behavior.methods.watch.execute(
    { _gh: gh },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals([up.lastTested, up.changed], [null, true]);
});

Deno.test("retest skips a release it already tested", async () => {
  const { gh, calls } = fakeGh({
    "api repos/swamp-club/swamp/releases/tags/v2": latest,
  });
  const test = context({ report: { version: "v2" } });
  const r = await behavior.methods.retest.execute(
    { ...behavior.methods.retest.arguments.parse({ version: "2" }), _gh: gh },
    test.context as unknown as RetestCtx,
  );
  assertEquals(r.dataHandles, []);
  assertEquals(test.getWrittenResources(), []);
  assertEquals(calls, ["api repos/swamp-club/swamp/releases/tags/v2"]);
});

const installed = (v: string | null) => () => Promise.resolve(v);

Deno.test("watch follows the installed swamp when it is a newer build", async () => {
  const { gh, calls } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": ok({
      tag_name: "v20261021.015131.0-sha.bfde0792",
      published_at: "2026-10-21T01:53:30Z",
      html_url: "https://github.com/swamp-club/swamp/releases/tag/x",
    }),
    "api repos/swamp-club/swamp/compare/bfde0792...f979f7c1": compare,
  });
  const test = context(
    { report: { version: "v20261021.015131.0-sha.bfde0792" } },
    "swamp",
  );
  await behavior.methods.watch.execute(
    {
      _gh: gh,
      _swampVersion: installed("v20261021.155838.0-sha.f979f7c1"),
    },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals(
    [up.latest, up.source, up.changed, up.url],
    [
      "v20261021.155838.0-sha.f979f7c1",
      "installed",
      true,
      "https://github.com/swamp-club/swamp/commit/f979f7c1",
    ],
  );
  assertEquals(up.commitsTotal, 2);
  assertEquals(calls.length, 2);
});

Deno.test("watch still records an installed build whose commit GitHub can't compare", async () => {
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": ok({
      tag_name: "v20261021.015131.0-sha.bfde0792",
      published_at: "",
      html_url: "",
    }),
    "api repos/swamp-club/swamp/compare/bfde0792...0123abcd": {
      code: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    },
  });
  const test = context(
    { report: { version: "v20261021.015131.0-sha.bfde0792" } },
    "swamp",
  );
  await behavior.methods.watch.execute(
    {
      _gh: gh,
      _swampVersion: installed("v20261022.010000.0-sha.0123abcd"),
    },
    test.context as unknown as WatchCtx,
  );
  const up = test.getWrittenResources()[0].data;
  assertEquals(
    [up.source, up.changed, up.commitsTotal, up.commitsTruncated],
    ["installed", true, 0, true],
  );
});

Deno.test("watch still fails when GitHub can't compare two releases", async () => {
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
    "api repos/swamp-club/swamp/compare/v1...v2": {
      code: 1,
      stdout: "",
      stderr: "gh: Not Found (HTTP 404)",
    },
  });
  const test = context({ report: { version: "v1" } });
  await assertRejects(() =>
    behavior.methods.watch.execute(
      { _gh: gh },
      test.context as unknown as WatchCtx,
    )
  );
});

Deno.test("watch keeps the release when the installed swamp is older or unreadable", async () => {
  for (const v of ["v20261014.204224.0-sha.8d6dfb6c", null]) {
    const { gh } = fakeGh({
      "api repos/swamp-club/swamp/releases/latest": ok({
        tag_name: "v20261021.015131.0-sha.bfde0792",
        published_at: "",
        html_url: "",
      }),
    });
    const test = context(
      { report: { version: "v20261021.015131.0-sha.bfde0792" } },
      "swamp",
    );
    await behavior.methods.watch.execute(
      { _gh: gh, _swampVersion: installed(v) },
      test.context as unknown as WatchCtx,
    );
    const up = test.getWrittenResources()[0].data;
    assertEquals([up.source, up.changed], ["release", false]);
  }
});

Deno.test("retest skips an installed build it already tested", async () => {
  const { gh } = fakeGh({
    "api repos/swamp-club/swamp/releases/latest": latest,
  });
  const test = context({
    report: { version: "v20261021.155838.0-sha.f979f7c1" },
  }, "swamp");
  const r = await behavior.methods.retest.execute(
    {
      ...behavior.methods.retest.arguments.parse({}),
      _gh: gh,
      _swampVersion: installed("v20261021.155838.0-sha.f979f7c1"),
    },
    test.context as unknown as RetestCtx,
  );
  assertEquals(r.dataHandles, []);
});

Deno.test("compareVersions orders builds by time and refOf finds the commit", () => {
  const a = "v20261021.015131.0-sha.bfde0792";
  const b = "20261021.155838.0-sha.f979f7c1";
  assertEquals(compareVersions(a, b) < 0, true);
  assertEquals(compareVersions(b, a) > 0, true);
  assertEquals(compareVersions(a, a), 0);
  assertEquals(refOf(a), "bfde0792");
  assertEquals(refOf("v2"), "v2");
});

Deno.test("assetName maps the platform to a release asset", () => {
  assertEquals(assetName("darwin", "aarch64"), "swamp-darwin-aarch64");
  assertEquals(assetName("linux", "x86_64"), "swamp-linux-x86_64");
  assertThrows(() => assetName("windows", "x86_64"), Error, "macOS or Linux");
});

Deno.test("compareSnapshots lists added, removed and changed files", () => {
  const prev = { version: "v1", files: { a: "1", b: "2", c: "3" } };
  const cur = { version: "v2", files: { a: "1", b: "two", d: "4" } };
  assertEquals(compareSnapshots(null, cur), {
    baseline: true,
    added: [],
    removed: [],
    changed: [],
  });
  assertEquals(compareSnapshots(prev, cur), {
    baseline: false,
    added: ["d"],
    removed: ["c"],
    changed: [{ path: "b", diff: "@@ -1,1 +1,1 @@\n-2\n+two" }],
  });
});
