import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  dailyTitle,
  dailyUid,
  fridayOnOrAfter,
  model,
  mondayAfter,
  normalizeHeading,
  parseOutline,
  parseSummaryHeading,
  periodContaining,
  periodFromKey,
  resolvePeriod,
  trimCode,
} from "./roam_graph.ts";

type Ctx = Parameters<typeof model.methods.collect.execute>[1];

// ---- An in-memory graph that speaks the Roam backend API. ----

interface Node {
  uid: string;
  string?: string;
  title?: string;
  children: Node[];
}

/** Outline shorthand: [text, [children]] or text. */
type Spec = string | [string, Spec[]];

let uidCounter = 0;
function build(spec: Spec): Node {
  const [string, kids] = typeof spec === "string" ? [spec, []] : spec;
  return { uid: `b${++uidCounter}`, string, children: kids.map(build) };
}

class FakeRoam {
  pages = new Map<string, Node>();
  writes: Record<string, unknown>[] = [];
  requests: Request[] = [];
  /** Respond 429 this many times before succeeding. */
  throttle = 0;
  /** Seconds sent in Retry-After with each 429. */
  retryAfter?: number;
  /** Reject write requests this returns true for, with HTTP 403. */
  rejectWrite?: (body: Record<string, unknown>) => boolean;
  /** Reject every request with this status. */
  status?: number;

  page(date: string, ...blocks: Spec[]): this {
    this.pages.set(dailyUid(date), {
      uid: dailyUid(date),
      title: dailyTitle(date),
      children: blocks.map(build),
    });
    return this;
  }

  *walk(): Generator<{ node: Node; page: Node; parent: Node }> {
    for (const page of this.pages.values()) {
      const stack = [page];
      while (stack.length) {
        const parent = stack.pop()!;
        for (const node of parent.children) {
          yield { node, page, parent };
          stack.push(node);
        }
      }
    }
  }

  find(uid: string): { node: Node; parent?: Node } | null {
    if (this.pages.has(uid)) return { node: this.pages.get(uid)! };
    for (const w of this.walk()) if (w.node.uid === uid) return w;
    return null;
  }

  pull(n: Node): Record<string, unknown> {
    return {
      ":block/uid": n.uid,
      ...(n.title !== undefined
        ? { ":node/title": n.title }
        : { ":block/string": n.string }),
      ":block/children": n.children.map((c, i) => ({
        ...this.pull(c),
        ":block/order": i,
      })),
    };
  }

  apply(a: Record<string, unknown>) {
    this.writes.push(a);
    const block = a.block as { uid: string; string?: string };
    switch (a.action) {
      case "batch-actions":
        for (const x of a.actions as Record<string, unknown>[]) this.apply(x);
        return;
      case "create-page": {
        const p = a.page as { uid: string; title: string };
        this.pages.set(p.uid, { uid: p.uid, title: p.title, children: [] });
        return;
      }
      case "create-block": {
        const loc = a.location as { "parent-uid": string };
        const parent = this.find(loc["parent-uid"]);
        if (!parent) throw new Error(`no parent ${loc["parent-uid"]}`);
        parent.node.children.push({
          uid: block.uid,
          string: block.string,
          children: [],
        });
        return;
      }
      case "delete-block": {
        const hit = this.find(block.uid);
        if (!hit) return;
        hit.parent!.children = hit.parent!.children.filter((c) =>
          c.uid !== block.uid
        );
        return;
      }
    }
    throw new Error(`unexpected action ${a.action}`);
  }

  fetch = async (req: Request): Promise<Response> => {
    this.requests.push(req);
    if (this.status) return new Response("nope", { status: this.status });
    if (this.throttle > 0) {
      this.throttle--;
      return new Response("slow down", {
        status: 429,
        headers: this.retryAfter ? { "Retry-After": `${this.retryAfter}` } : {},
      });
    }
    const body = await req.json();
    const path = new URL(req.url).pathname.split("/").pop();
    if (path === "write" && this.rejectWrite?.(body)) {
      return new Response("write rejected", { status: 403 });
    }
    if (path === "pull-many") {
      const uids = [...String(body.eids).matchAll(/"([^"]+)"/g)].map((m) =>
        m[1]
      );
      // Like Roam, missing entities are dropped rather than returned as null.
      const result = uids.map((u) => this.find(u)?.node).filter(Boolean).map(
        (n) => this.pull(n!),
      );
      return Response.json({ result });
    }
    if (path === "q") {
      const [needle] = body.args;
      const result = [...this.walk()]
        .filter((w) => w.node.string?.includes(needle))
        .map((w) => [w.node.uid, w.node.string, w.page.uid, w.page.title]);
      return Response.json({ result });
    }
    if (path === "write") {
      this.apply(body);
      return new Response("", { status: 200 });
    }
    return new Response("not found", { status: 404 });
  };
}

function ctx(methodName: string, section?: string) {
  const t = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      token: "roam-graph-token-test",
      graph: "test-graph",
      ...(section ? { section } : {}),
    }),
    methodName,
  });
  return t;
}

async function run(
  method: "collect" | "publish" | "dailies",
  roam: FakeRoam,
  args: Record<string, unknown>,
  today = "2026-10-11",
) {
  const t = ctx(method);
  const m = model.methods[method];
  // deno-lint-ignore no-explicit-any
  const parsed = (m.arguments as any).parse(args);
  await m.execute(
    { ...parsed, _fetch: roam.fetch, _today: today, _sleep: async () => {} },
    t.context as unknown as Ctx,
  );
  return t;
}

function written(t: ReturnType<typeof ctx>, name: string) {
  const r = t.getWrittenResources().find((x) => x.name === name);
  assert(r, `no resource ${name}`);
  return r.data as Record<string, unknown>;
}

// ---- Pure functions ----

Deno.test("normalizeHeading accepts the usual ways of writing a heading", () => {
  for (
    const s of [
      "Activities",
      "activities",
      "[[Activities]]",
      "#Activities",
      "**Activities:**",
      "Activities::",
    ]
  ) {
    assertEquals(normalizeHeading(s), "activities", s);
  }
});

Deno.test("trimCode drops long code blocks and keeps short ones", () => {
  assertEquals(trimCode("a ```x``` b"), "a ```x``` b");
  assertEquals(
    trimCode(`run \`\`\`${"x".repeat(300)}\`\`\` done`),
    "run [code block omitted] done",
  );
});

Deno.test("daily note uid and title", () => {
  assertEquals(dailyUid("2026-10-02"), "10-02-2026");
  assertEquals(dailyTitle("2026-10-02"), "October 2nd, 2026");
  assertEquals(dailyTitle("2026-09-11"), "September 11th, 2026");
  assertEquals(dailyTitle("2026-09-21"), "September 21st, 2026");
  assertEquals(dailyTitle("2026-09-23"), "September 23rd, 2026");
});

Deno.test("weeks run Saturday to Friday", () => {
  assertEquals(fridayOnOrAfter("2026-10-02"), "2026-10-02");
  assertEquals(fridayOnOrAfter("2026-10-03"), "2026-10-09");
  const w = periodContaining("week", "2026-09-21");
  assertEquals([w.start, w.end, w.key], [
    "2026-09-19",
    "2026-09-25",
    "2026-09-25",
  ]);
  assertEquals(w.title, "Week Ending September 25, 2026");
  assertEquals(w.targetDate, "2026-09-28");
});

Deno.test("mondayAfter is always strictly after the day", () => {
  assertEquals(mondayAfter("2026-10-09"), "2026-10-12"); // Friday
  assertEquals(mondayAfter("2026-08-31"), "2026-09-07"); // a Monday
  assertEquals(mondayAfter("2026-09-30"), "2026-10-05"); // Wednesday
});

Deno.test("rollups land on the first Monday after the period ends", () => {
  const m = periodContaining("month", "2026-09-14");
  assertEquals(m.title, "Monthly Rollup September 2026");
  assertEquals([m.start, m.end, m.targetDate], [
    "2026-09-01",
    "2026-09-30",
    "2026-10-05",
  ]);
  const q = periodContaining("quarter", "2026-08-01");
  assertEquals([q.key, q.title, q.start, q.end], [
    "2026-Q3",
    "Quarterly Rollup Q3 2026",
    "2026-07-01",
    "2026-09-30",
  ]);
  const y = periodContaining("year", "2026-08-01");
  assertEquals([y.title, y.end, y.targetDate], [
    "Yearly Rollup 2026",
    "2026-12-31",
    "2027-01-04",
  ]);
});

Deno.test("'last' is the most recent period that has ended", () => {
  // Sunday 2026-10-11: last week ended Friday 10-09, last month is September.
  assertEquals(resolvePeriod("week", "last", "2026-10-11").key, "2026-10-09");
  // On a Friday, this week has ended.
  assertEquals(resolvePeriod("week", "last", "2026-10-09").key, "2026-10-09");
  assertEquals(
    resolvePeriod("week", "current", "2026-10-11").key,
    "2026-10-16",
  );
  assertEquals(resolvePeriod("month", "last", "2026-10-11").key, "2026-09");
  assertEquals(resolvePeriod("month", "last", "2026-10-31").key, "2026-10");
  assertEquals(resolvePeriod("quarter", "last", "2026-10-11").key, "2026-Q3");
  assertEquals(resolvePeriod("year", "last", "2026-10-11").key, "2025");
  assertEquals(resolvePeriod("month", "2026-02-14", "x").end, "2026-02-28");
});

Deno.test("periodFromKey round-trips and rejects bad keys", () => {
  for (
    const [kind, day] of [["week", "2026-10-07"], ["month", "2026-09-14"], [
      "quarter",
      "2026-11-01",
    ], ["year", "2026-03-03"]] as const
  ) {
    const p = periodContaining(kind, day);
    assertEquals(periodFromKey(kind, p.key), p);
  }
  assertThrows(
    () => periodFromKey("week", "2026-10-08"),
    Error,
    "not a Friday",
  );
  assertThrows(() => periodFromKey("month", "2026-Q3"), Error, "not a month");
});

Deno.test("parseSummaryHeading recognises hand-written headings", () => {
  assertEquals(
    parseSummaryHeading("Week Ending 2026-09-18")?.key,
    "2026-09-18",
  );
  assertEquals(
    parseSummaryHeading("Week Ending October 2, 2026")?.key,
    "2026-10-02",
  );
  assertEquals(
    parseSummaryHeading("**Week ending [[October 2nd, 2026]]**")?.key,
    "2026-10-02",
  );
  assertEquals(
    parseSummaryHeading("Monthly Rollup September 2026")?.key,
    "2026-09",
  );
  assertEquals(parseSummaryHeading("Quarterly Rollup Q3 2026")?.key, "2026-Q3");
  assertEquals(parseSummaryHeading("Yearly Rollup 2026")?.key, "2026");
  // Mentions in running text are not headings.
  assertEquals(
    parseSummaryHeading("see the Week Ending 2026-09-18 notes"),
    null,
  );
  assertEquals(parseSummaryHeading("Week Ending soon"), null);
});

Deno.test("parseOutline nests bullets by indentation", () => {
  const md = [
    "- **Theme A**",
    "  - one",
    "    - one.a",
    "      - one.a.i",
    "  - two",
    "",
    "- **Theme B**",
    "  * three",
    "- **Overall theme:** done",
  ].join("\n");
  assertEquals(parseOutline(md), [
    {
      string: "**Theme A**",
      children: [
        {
          string: "one",
          children: [{
            string: "one.a",
            children: [{ string: "one.a.i", children: [] }],
          }],
        },
        { string: "two", children: [] },
      ],
    },
    { string: "**Theme B**", children: [{ string: "three", children: [] }] },
    { string: "**Overall theme:** done", children: [] },
  ]);
});

Deno.test("parseOutline turns Markdown headings into bold parents", () => {
  const md = "## Theme A\n- one\n  - one.a\n## Theme B\n- two\n";
  assertEquals(parseOutline(md), [
    {
      string: "**Theme A**",
      children: [{
        string: "one",
        children: [{ string: "one.a", children: [] }],
      }],
    },
    { string: "**Theme B**", children: [{ string: "two", children: [] }] },
  ]);
});

// ---- Methods against the fake graph ----

function septemberGraph() {
  return new FakeRoam()
    .page("2026-09-28", ["Activities", ["Prepped for the planning meeting"]])
    .page(
      "2026-09-29",
      ["Notes", ["not activities"]],
      ["Activities", [["Worked on PROJ-101", ["generated tests"]]]],
    )
    .page("2026-10-02", ["**Activities:**", [
      `pasted \`\`\`${"log ".repeat(100)}\`\`\``,
    ]]);
}

Deno.test("collect week reads the section from each daily note", async () => {
  const roam = septemberGraph();
  const t = await run("collect", roam, { kind: "week", date: "2026-09-30" });
  const s = written(t, "source");
  assertEquals(s.key, "2026-10-02");
  assertEquals(s.title, "Week Ending October 2, 2026");
  assertEquals(s.sources, ["2026-09-28", "2026-09-29", "2026-10-02"]);
  assertEquals(
    s.text,
    "## September 28th, 2026\n- Prepped for the planning meeting\n\n" +
      "## September 29th, 2026\n- Worked on PROJ-101\n  - generated tests\n\n" +
      "## October 2nd, 2026\n- pasted [code block omitted]\n",
  );
  assertMatch(String(s.prompt), /Overall theme/);
  assertMatch(String(s.prompt), /# Daily notes\n\n## September 28th/);
  // One pull-many for the whole week, authenticated both ways.
  assertEquals(roam.requests.length, 1);
  assertEquals(
    roam.requests[0].headers.get("X-Authorization"),
    "Bearer roam-graph-token-test",
  );
  assertEquals(
    new URL(roam.requests[0].url).pathname,
    "/api/graph/test-graph/pull-many",
  );
});

Deno.test("collect fails when the week has no entries", async () => {
  await assertRejects(
    () => run("collect", new FakeRoam(), { kind: "week", date: "2026-09-30" }),
    Error,
    'No "Activities" entries',
  );
});

Deno.test("collect month uses weeklies that overlap the month", async () => {
  const roam = new FakeRoam()
    .page("2026-08-28", ["Week Ending 2026-08-28", ["August only"]])
    .page("2026-09-04", ["Week Ending 2026-09-04", ["spans Aug/Sep"]])
    .page("2026-09-18", ["Week Ending 2026-09-18", ["third week"]])
    .page("2026-09-25", ["Week Ending 2026-09-25", ["fourth week"]])
    .page("2026-10-02", ["Week Ending October 2, 2026", ["spans Sep/Oct"]])
    .page("2026-10-09", ["Week Ending October 9, 2026", ["October only"]]);
  const t = await run("collect", roam, { kind: "month", date: "last" });
  const s = written(t, "source");
  assertEquals(s.title, "Monthly Rollup September 2026");
  assertEquals(s.sources, [
    "2026-09-04",
    "2026-09-18",
    "2026-09-25",
    "2026-10-02",
  ]);
  assertEquals(s.missing, ["2026-09-11"]);
  assertMatch(
    String(s.text),
    /^## Week Ending September 4, 2026 \(2026-08-29 to 2026-09-04\)\n- spans Aug\/Sep\n/,
  );
  assertMatch(String(s.prompt), /# Weekly summaries/);
  assertMatch(String(s.prompt), /"September outcome"/);
});

Deno.test("collect prefers the longer of two summaries for one period", async () => {
  const roam = new FakeRoam()
    .page("2026-09-30", ["Monthly Rollup September 2026", ["short"]])
    .page("2026-10-02", ["Monthly Rollup September 2026", [
      ["longer", ["with detail"]],
    ]]);
  const t = await run("collect", roam, { kind: "quarter", date: "2026-08-01" });
  const s = written(t, "source");
  assertEquals(s.sources, ["2026-09"]);
  assertEquals(s.missing, ["2026-07", "2026-08"]);
  assert(String(s.text).includes("- longer\n  - with detail"));
});

Deno.test("collect rollup fails when there are no child summaries", async () => {
  await assertRejects(
    () => run("collect", new FakeRoam(), { kind: "year", date: "2026-01-01" }),
    Error,
    "No quarter summaries found for Yearly Rollup 2026",
  );
});

const SUMMARY = "- **Theme**\n  - did a thing\n- **Overall theme:** good";

Deno.test("publish creates the heading on the next Monday's daily note", async () => {
  const roam = new FakeRoam().page("2026-10-12", ["Activities", ["x"]]);
  const t = await run("publish", roam, {
    kind: "week",
    key: "2026-10-09",
    markdown: SUMMARY,
  });
  assertEquals(roam.pages.size, 1);
  const page = roam.pages.get("10-12-2026")!;
  assertEquals(page.children.map((c) => c.string), [
    "Activities",
    "Week Ending October 9, 2026",
  ]);
  const heading = page.children[1];
  assertEquals(heading.children.map((c) => c.string), [
    "**Theme**",
    "**Overall theme:** good",
  ]);
  assertEquals(heading.children[0].children[0].string, "did a thing");
  const s = written(t, "summary-week-2026-10-09");
  assertEquals([s.action, s.blockUid], ["created", heading.uid]);
});

Deno.test("publish creates the daily note when it does not exist", async () => {
  const roam = new FakeRoam();
  await run("publish", roam, { kind: "year", key: "2026", markdown: SUMMARY });
  const page = roam.pages.get("01-04-2027")!;
  assertEquals(page.title, "January 4th, 2027");
  assertEquals(page.children[0].string, "Yearly Rollup 2026");
});

Deno.test("publish skips a period that already has a summary", async () => {
  const roam = new FakeRoam().page("2026-10-02", [
    "Monthly Rollup September 2026",
    ["hand-written"],
  ]);
  const t = await run("publish", roam, {
    kind: "month",
    key: "2026-09",
    markdown: SUMMARY,
  });
  assertEquals(roam.writes, []);
  const s = written(t, "summary-month-2026-09");
  assertEquals([s.action, s.pageUid], ["skipped", "10-02-2026"]);
});

Deno.test("publish replace swaps the contents in place", async () => {
  const roam = new FakeRoam().page(
    "2026-09-18",
    ["Week Ending 2026-09-18", ["old", "older"]],
    "after",
  );
  const uid = roam.pages.get("09-18-2026")!.children[0].uid;
  const t = await run("publish", roam, {
    kind: "week",
    key: "2026-09-18",
    markdown: SUMMARY,
    ifExists: "replace",
  });
  const page = roam.pages.get("09-18-2026")!;
  assertEquals(page.children.map((c) => c.string), [
    "Week Ending 2026-09-18",
    "after",
  ]);
  assertEquals(page.children[0].uid, uid);
  assertEquals(page.children[0].children.map((c) => c.string), [
    "**Theme**",
    "**Overall theme:** good",
  ]);
  assertEquals(written(t, "summary-week-2026-09-18").action, "replaced");
});

Deno.test("publish fail refuses to touch an existing summary", async () => {
  const roam = new FakeRoam().page("2026-09-18", "Week Ending 2026-09-18");
  await assertRejects(
    () =>
      run("publish", roam, {
        kind: "week",
        key: "2026-09-18",
        markdown: SUMMARY,
        ifExists: "fail",
      }),
    Error,
    "already exists on September 18th, 2026",
  );
});

Deno.test("requests are retried when Roam rate-limits", async () => {
  const roam = septemberGraph();
  roam.throttle = 2;
  const t = await run("dailies", roam, {
    start: "2026-09-28",
    end: "2026-09-29",
  });
  assertEquals(roam.requests.length, 3);
  assertEquals(written(t, "dailies-2026-09-28-2026-09-29").daysWithEntries, 2);
});

Deno.test("publish removes a partial summary when a write fails", async () => {
  const roam = new FakeRoam().page("2026-10-09", "Activities");
  roam.rejectWrite = (b) => b.action === "batch-actions";
  await assertRejects(
    () =>
      run("publish", roam, {
        kind: "week",
        key: "2026-10-09",
        markdown: SUMMARY,
      }),
    Error,
    "failed part-way; removed the partial summary. Roam API write failed: HTTP 403",
  );
  assertEquals(roam.writes.at(-1)?.action, "delete-block");
});

Deno.test("API errors name the endpoint and status", async () => {
  const roam = septemberGraph();
  roam.status = 401;
  await assertRejects(
    () => run("collect", roam, { kind: "week", date: "2026-09-30" }),
    Error,
    "Roam API pull-many failed: HTTP 401 nope",
  );
});

Deno.test("Retry-After sets the wait between retries", async () => {
  const roam = septemberGraph();
  roam.throttle = 1;
  roam.retryAfter = 7;
  const waits: number[] = [];
  const t = ctx("dailies");
  await model.methods.dailies.execute(
    {
      ...model.methods.dailies.arguments.parse({
        start: "2026-09-28",
        end: "2026-09-28",
      }),
      _fetch: roam.fetch,
      _sleep: (ms: number) => {
        waits.push(ms);
        return Promise.resolve();
      },
    },
    t.context as unknown as Ctx,
  );
  assertEquals(waits, [7000]);
});
