import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  bindMount,
  containerName,
  expandSlides,
  findAddress,
  model,
  type RunResult,
} from "./slidev_deck.ts";

type Ctx = Parameters<typeof model.methods.fit.execute>[1];
type Method = keyof typeof model.methods;

// ---- A fake runtime CLI ----

interface Call {
  args: string[];
}

/** Source directory of the bind mount whose target is `target`. */
function mountSource(args: string[], target: string): string {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] !== "--mount") continue;
    const parts = Object.fromEntries(
      args[i + 1].split(",").map((kv) => kv.split("=")),
    );
    if (parts.target === target) return parts.source;
  }
  throw new Error(`no mount for ${target} in ${args.join(" ")}`);
}

/** Value after `flag` in the image arguments. */
function after(args: string[], flag: string): string {
  return args[args.indexOf(flag) + 1];
}

class FakeRuntime {
  calls: Call[] = [];
  running = new Set<string>();
  /** Handles `run` calls; return undefined for exit 0 with no output. */
  onRun: (
    args: string[],
  ) => Partial<RunResult> | void | Promise<Partial<RunResult> | void> =
    () => {};
  inspectJson = "[]";
  throwOnRun?: Error;

  run = async (args: string[]): Promise<RunResult> => {
    this.calls.push({ args });
    const ok = (r?: Partial<RunResult> | void): RunResult => ({
      code: 0,
      stdout: "",
      stderr: "",
      ...(r ?? {}),
    });
    const [cmd] = args;
    if (cmd === "inspect") {
      return this.running.has(args[1])
        ? ok({ stdout: this.inspectJson })
        : { code: 1, stdout: "", stderr: "no such container" };
    }
    if (cmd === "rm" || cmd === "delete") {
      this.running.delete(args[args.length - 1]);
      return ok();
    }
    if (cmd === "run") {
      if (this.throwOnRun) throw this.throwOnRun;
      if (args.includes("--detach")) {
        this.running.add(after(args, "--name"));
      }
      return ok(await this.onRun(args));
    }
    throw new Error(`unexpected ${args.join(" ")}`);
  };

  runs(): string[][] {
    return this.calls.map((c) => c.args).filter((a) => a[0] === "run");
  }
}

async function tempDeck(
  pkg: Record<string, unknown> = {},
  modules: Record<string, string> = {},
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "deck-test-" });
  await Deno.writeTextFile(
    `${dir}/package.json`,
    JSON.stringify({ name: "deck", ...pkg }),
  );
  for (const [name, version] of Object.entries(modules)) {
    await setVersion(dir, name, version);
  }
  return dir;
}

async function setVersion(dir: string, name: string, version: string) {
  await Deno.mkdir(`${dir}/node_modules/${name}`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/node_modules/${name}/package.json`,
    JSON.stringify({ name, version }),
  );
}

async function run(
  method: Method,
  dir: string,
  rt: FakeRuntime,
  args: Record<string, unknown> = {},
  globals: Record<string, unknown> = {},
  fetchImpl?: (url: string) => Promise<Response>,
) {
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({ dir, ...globals }),
    methodName: method,
  });
  // deno-lint-ignore no-explicit-any
  const m = model.methods[method] as any;
  await m.execute(
    {
      ...m.arguments.parse(args),
      _run: rt.run,
      _fetch: fetchImpl ?? (() => Promise.resolve(new Response("ok"))),
      _sleep: () => Promise.resolve(),
    },
    test.context as unknown as Ctx,
  );
  return test;
}

function resource(test: ReturnType<typeof createModelTestContext>) {
  const r = test.getWrittenResources();
  return r[r.length - 1].data as Record<string, unknown>;
}

// ---- Pure helpers ----

Deno.test("expandSlides expands ranges", () => {
  assertEquals(expandSlides("12"), "12");
  assertEquals(expandSlides("3,7,10-12"), "3,7,10,11,12");
  assertThrows(() => expandSlides("5-3"), Error, "Bad slide range");
});

Deno.test("containerName is deck-scoped", () => {
  assertEquals(
    containerName("/Users/x/swamp-training/", "serve", true),
    "slidev-swamp-training",
  );
  const n = containerName("/x/My Deck", "fit");
  assert(/^slidev-my-deck-fit-[0-9a-f]{8}$/.test(n), n);
});

Deno.test("bindMount refuses paths the mount syntax can't carry", () => {
  assertEquals(bindMount("/a/b", "/slidev"), [
    "--mount",
    "type=bind,source=/a/b,target=/slidev",
  ]);
  assertThrows(() => bindMount("/a,b", "/slidev"), Error, "commas");
});

Deno.test("findAddress reads the container's own IPv4 address", () => {
  const json = JSON.stringify([{
    configuration: {
      publishedPorts: [{ hostAddress: "0.0.0.0", hostPort: 3099 }],
    },
    networks: [{ ipv4Address: "192.168.64.4/24", ipv4Gateway: "192.168.64.1" }],
  }]);
  assertEquals(findAddress(json), "192.168.64.4");
  assertEquals(findAddress("not json"), null);
  assertEquals(findAddress("[{}]"), null);
});

// ---- fit ----

function fitResults(fitDir: string, results: unknown[], shots: number[]) {
  Deno.writeTextFileSync(
    `${fitDir}/out/results.json`,
    JSON.stringify({ total: 30, results }),
  );
  for (const n of shots) {
    Deno.writeFileSync(
      `${fitDir}/out/slide-${String(n).padStart(3, "0")}.png`,
      new Uint8Array([137, 80, 78, 71, n]),
    );
  }
}

const SLIDE = {
  title: "",
  file: "/slidev/slides.md",
  line: 1,
  routeAlias: "",
  layout: "",
  height: 552,
  bottom: 300,
  right: 924,
  bottomEl: "",
  rightEl: "",
  scrolled: [],
  problems: [],
  screenshot: false,
};

Deno.test("fit runs the script in the image and reports flagged slides", async () => {
  const dir = await tempDeck();
  const shots = await Deno.makeTempDir();
  const rt = new FakeRuntime();
  let script = "";
  rt.onRun = (args) => {
    const fitDir = mountSource(args, "/fit");
    script = Deno.readTextFileSync(`${fitDir}/fit.mjs`);
    assertEquals(mountSource(args, "/slidev"), dir);
    fitResults(fitDir, [
      { ...SLIDE, no: 3, title: "Fine" },
      {
        ...SLIDE,
        no: 4,
        title: "Too tall",
        file: "/slidev/pages/a.md",
        line: 12,
        bottom: 680,
        bottomEl: "pre: cgroup",
        problems: ["bottom"],
        screenshot: true,
      },
    ], [4]);
  };
  const test = await run("fit", dir, rt, {
    slides: "3-4",
    shotsDir: shots,
  });

  const [args] = rt.runs();
  assertEquals(args.slice(0, 2), ["run", "--rm"]);
  assertEquals(after(args, "--entrypoint"), "bash");
  const c = after(args, "-c");
  assertStringIncludes(c, "/entrypoint.sh --port 3030");
  assertStringIncludes(c, "node /fit/fit.mjs 3030 /fit/out 40 20 flagged 3,4");
  assertStringIncludes(script, "clicks=999");
  assertEquals(
    args[args.indexOf("-c") - 1],
    "docker.io/boxcutter/slidev:latest",
  );

  const r = resource(test);
  assertEquals([r.total, r.checked], [30, 2]);
  const flagged = r.flagged as Record<string, unknown>[];
  assertEquals(flagged.map((s) => [s.no, s.file, s.line]), [[
    4,
    "pages/a.md",
    12,
  ]]);
  const files = test.getWrittenFiles();
  assertEquals(files.length, 1);
  assertEquals(
    [...Deno.readFileSync(`${shots}/slide-004.png`)],
    [137, 80, 78, 71, 4],
  );
});

Deno.test("fit explains a deck without playwright-chromium", async () => {
  const dir = await tempDeck();
  const rt = new FakeRuntime();
  rt.onRun = () => ({ code: 3, stderr: "FIT_ERROR no-playwright" });
  await assertRejects(
    () => run("fit", dir, rt),
    Error,
    "The deck has no playwright-chromium",
  );
});

Deno.test("fit shows the slidev log when the server never answers", async () => {
  const dir = await tempDeck();
  const rt = new FakeRuntime();
  rt.onRun = (args) => {
    Deno.writeTextFileSync(
      `${mountSource(args, "/fit")}/out/slidev.log`,
      "Error: Cannot find module 'vue'",
    );
    return { code: 4, stderr: "FIT_ERROR server-timeout" };
  };
  const e = await assertRejects(() => run("fit", dir, rt), Error);
  assertStringIncludes(e.message, "never answered");
  assertStringIncludes(e.message, "Cannot find module 'vue'");
});

Deno.test("fit removes its container when the run times out", async () => {
  const dir = await tempDeck();
  for (const [runtime, remove] of [["docker", "rm"], ["container", "delete"]]) {
    const rt = new FakeRuntime();
    rt.throwOnRun = new Error("docker run timed out after 10ms");
    await assertRejects(
      () => run("fit", dir, rt, {}, { runtime }),
      Error,
      "timed out",
    );
    const name = after(rt.calls[0].args, "--name");
    assertEquals(rt.calls[1].args, [remove, "--force", name]);
  }
});

Deno.test("fit refuses a directory that is not a deck", async () => {
  const dir = await Deno.makeTempDir();
  await assertRejects(
    () => run("fit", dir, new FakeRuntime()),
    Error,
    "is not a Slidev deck",
  );
});

// ---- serve / stop ----

Deno.test("serve starts a detached --remote container and waits for it", async () => {
  const dir = await tempDeck();
  const rt = new FakeRuntime();
  let polls = 0;
  const test = await run("serve", dir, rt, { port: 3099 }, {}, () => {
    polls++;
    return polls < 3
      ? Promise.reject(new Error("refused"))
      : Promise.resolve(new Response("ok"));
  });
  const [args] = rt.runs();
  assertEquals(after(args, "--publish"), "3099:3030");
  assertEquals(args.slice(-2), [
    "docker.io/boxcutter/slidev:latest",
    "--remote",
  ]);
  assertEquals(polls, 3);
  const r = resource(test);
  assertEquals([r.action, r.running, r.url], [
    "started",
    true,
    "http://localhost:3099/",
  ]);
  assertEquals(r.container, `slidev-${dir.split("/").pop()!.toLowerCase()}`);
});

Deno.test("serve without remote binds all interfaces", async () => {
  const rt = new FakeRuntime();
  await run("serve", await tempDeck(), rt, { remote: false });
  assertEquals(rt.runs()[0].slice(-2), ["--bind", "0.0.0.0"]);
});

Deno.test("serve reuses a running server and adds the Apple container IP", async () => {
  const dir = await tempDeck();
  const rt = new FakeRuntime();
  rt.running.add(containerName(dir, "serve", true));
  rt.inspectJson = JSON.stringify([{
    networks: [{ ipv4Address: "192.168.64.7/24" }],
  }]);
  const test = await run("serve", dir, rt, {}, { runtime: "container" });
  assertEquals(rt.runs(), []);
  const r = resource(test);
  assertEquals(r.action, "already-running");
  assertEquals(r.urls, ["http://localhost:3030/", "http://192.168.64.7:3030/"]);
});

Deno.test("stop removes the server, and is fine when none is running", async () => {
  const dir = await tempDeck();
  const rt = new FakeRuntime();
  rt.running.add(containerName(dir, "serve", true));
  const t1 = await run("stop", dir, rt, {}, { runtime: "container" });
  assertEquals(resource(t1).action, "stopped");
  assert(rt.calls.some((c) => c.args[0] === "delete"));
  const t2 = await run("stop", dir, rt);
  assertEquals(resource(t2).action, "not-running");
});

// ---- outdated / upgrade ----

Deno.test("outdated parses npm outdated, which exits 1 when anything is old", async () => {
  const rt = new FakeRuntime();
  rt.onRun = (args) => {
    assertEquals(after(args, "--entrypoint"), "npm");
    assertEquals(args.slice(-2), ["outdated", "--json"]);
    return {
      code: 1,
      stdout: JSON.stringify({
        "@slidev/cli": {
          current: "52.19.1",
          wanted: "52.20.1",
          latest: "53.0.0",
        },
      }),
    };
  };
  const test = await run("outdated", await tempDeck(), rt);
  assertEquals(resource(test).packages, [{
    name: "@slidev/cli",
    current: "52.19.1",
    wanted: "52.20.1",
    latest: "53.0.0",
  }]);
});

Deno.test("outdated reports npm failures", async () => {
  const rt = new FakeRuntime();
  rt.onRun = () => ({ code: 1, stdout: "npm ERR! nope" });
  await assertRejects(
    () => run("outdated", tempDeckSync(), rt),
    Error,
    "npm outdated failed",
  );
});

function tempDeckSync(): string {
  const dir = Deno.makeTempDirSync();
  Deno.writeTextFileSync(`${dir}/package.json`, "{}");
  return dir;
}

Deno.test("upgrade moves Slidev packages to latest, leaves pins and adds playwright", async () => {
  const dir = await tempDeck({
    dependencies: {
      "@slidev/cli": "^52.19.1",
      "@slidev/theme-seriph": "latest",
      "vue": "^3.5.0",
      "lodash": "^4.0.0",
    },
    devDependencies: { "@slidev/types": "52.15.2" },
  }, {
    "@slidev/cli": "52.19.1",
    "@slidev/theme-seriph": "0.25.0",
    "vue": "3.5.42",
  });
  const rt = new FakeRuntime();
  const installs: string[][] = [];
  rt.onRun = async (args) => {
    const npmArgs = args.slice(
      args.indexOf("docker.io/boxcutter/slidev:latest") + 1,
    );
    installs.push(npmArgs);
    if (npmArgs.includes("@slidev/cli@latest")) {
      await setVersion(dir, "@slidev/cli", "53.0.0");
      await setVersion(dir, "vue", "3.5.43");
    }
    if (npmArgs.includes("playwright-chromium@latest")) {
      await setVersion(dir, "playwright-chromium", "1.64.0");
    }
  };
  const test = await run("upgrade", dir, rt);
  assertEquals(installs, [
    [
      "install",
      "--no-audit",
      "--no-fund",
      "@slidev/cli@latest",
      "@slidev/theme-seriph@latest",
      "vue@latest",
    ],
    [
      "install",
      "--no-audit",
      "--no-fund",
      "--save-dev",
      "playwright-chromium@latest",
    ],
  ]);
  const r = resource(test);
  assertEquals(r.skippedPinned, ["@slidev/types@52.15.2"]);
  assertEquals(r.changes, [
    { name: "@slidev/cli", from: "52.19.1", to: "53.0.0" },
    { name: "vue", from: "3.5.42", to: "3.5.43" },
    { name: "playwright-chromium", from: "", to: "1.64.0" },
  ]);
});

Deno.test("upgrade upgrades a pinned package when it is named", async () => {
  const dir = await tempDeck({ dependencies: { "@slidev/cli": "52.15.2" } });
  const rt = new FakeRuntime();
  await run("upgrade", dir, rt, {
    packages: ["@slidev/cli"],
    playwright: false,
  });
  assertEquals(rt.runs().length, 1);
  assertEquals(rt.runs()[0].slice(-1), ["@slidev/cli@latest"]);
});

Deno.test("upgrade reports a failed npm install", async () => {
  const dir = await tempDeck({ dependencies: { "@slidev/cli": "^52.0.0" } });
  const rt = new FakeRuntime();
  rt.onRun = () => ({ code: 1, stderr: "ERESOLVE could not resolve" });
  await assertRejects(() => run("upgrade", dir, rt), Error, "ERESOLVE");
});

// ---- export / init ----

Deno.test("export stores the PDF", async () => {
  const rt = new FakeRuntime();
  rt.onRun = (args) => {
    assertEquals(after(args, "--output"), "/out/slides.pdf");
    assert(args.includes("--with-clicks"));
    Deno.writeFileSync(
      `${mountSource(args, "/out")}/slides.pdf`,
      new TextEncoder().encode("%PDF-1.7"),
    );
  };
  const test = await run("export", await tempDeck(), rt, { withClicks: true });
  assertEquals(test.getWrittenFiles().length, 1);
});

Deno.test("export explains a missing PDF", async () => {
  const rt = new FakeRuntime();
  rt.onRun = () => ({
    code: 1,
    stderr: "browserType.launch: Executable doesn't exist",
  });
  const dir = await tempDeck();
  await assertRejects(
    () => run("export", dir, rt),
    Error,
    "produced no PDF",
  );
});

Deno.test("init creates the deck in the parent directory and adds playwright", async () => {
  const parent = await Deno.makeTempDir();
  const dir = `${parent}/new-talk`;
  const rt = new FakeRuntime();
  rt.onRun = async (args) => {
    if (args.includes("bash")) {
      assertEquals(mountSource(args, "/slidev"), parent);
      assertStringIncludes(
        after(args, "-c"),
        "npm init slidev@latest --yes new-talk",
      );
      Deno.mkdirSync(dir);
      Deno.writeTextFileSync(`${dir}/package.json`, "{}");
      await setVersion(dir, "@slidev/cli", "53.0.0");
    } else {
      assertEquals(mountSource(args, "/slidev"), dir);
      assertEquals(args.slice(-2), ["--save-dev", "playwright-chromium"]);
    }
  };
  const test = await run("init", dir, rt);
  assertEquals(rt.runs().length, 2);
  assertEquals(resource(test).slidevVersion, "53.0.0");
});

Deno.test("init refuses an existing directory", async () => {
  const dir = await tempDeck();
  await assertRejects(
    () => run("init", dir, new FakeRuntime()),
    Error,
    "already exists",
  );
});
