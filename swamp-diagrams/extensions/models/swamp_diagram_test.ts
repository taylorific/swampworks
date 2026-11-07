import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { join } from "jsr:@std/path@1.0.8";
import {
  dockerAvailable,
  findWorkflows,
  model,
  slug,
} from "./swamp_diagram.ts";
import { renderSvg } from "./_lib/svg.ts";
import {
  collapse,
  parseTransitions,
  renderStateMachine,
  stateMachineGraph,
  type StateMachineOptions,
} from "./_lib/state_machine.ts";
import {
  describeCondition,
  describeTask,
  parseWorkflow,
  renderWorkflow,
  workflowGraph,
} from "./_lib/workflow.ts";
import {
  classDefs,
  embed,
  escapeLabel,
  frontmatter,
  mermaidBlock,
} from "./_lib/mermaid.ts";

const LIFECYCLE = `
## State Machine

\`\`\`
created ──[start]──> triaging
triaging ──[triage]──> classified
classified ──[plan]──> plan_generated
plan_generated ──[iterate]──> plan_generated  (feedback loop)
plan_generated ──[approve]──> approved
approved ──[implement]──> implementing
implementing ──[verify]──> verifying
verifying ──[verification_failed]──> implementing  (fix and retry)
verifying ──[link_pr]──> pr_open
pr_open ──[pr_failed]──> pr_failed
pr_failed ──[link_pr]──> pr_open  (retry with new PR)
pr_failed ──[implement]──> implementing  (restart implementation)
pr_open ──[pr_merged]──> releasing
releasing ──[ship]──> notify
implementing ──[complete]──> notify  (no PR linked)
releasing ──[complete]──> notify
notify ──[notify]──> done
notify ──[skip_notify]──> done
\`\`\`
`;

const opts = (
  o: Partial<StateMachineOptions & { subtitle: string }> = {},
): StateMachineOptions & { subtitle?: string } => ({
  title: "t",
  theme: "dark",
  direction: "TD",
  hideStates: [],
  collapseStates: [],
  omitMethods: [],
  humanGates: [],
  highlightStates: [],
  failureStates: [],
  notes: {},
  showComments: false,
  ...o,
});

Deno.test("parseTransitions reads box-drawing and ASCII arrows, skips prose", () => {
  const t = parseTransitions(
    LIFECYCLE + "\nsome prose\na --[go]--> b (why)\n",
  );
  assertEquals(t.length, 19);
  assertEquals(t[0], { from: "created", method: "start", to: "triaging" });
  assertEquals(t[3].comment, "feedback loop");
  assertEquals(t[18], { from: "a", method: "go", to: "b", comment: "why" });
});

Deno.test("renderStateMachine colours loops, gates, failures and retries", () => {
  const d = renderStateMachine(
    parseTransitions(LIFECYCLE),
    opts({ humanGates: ["approve"] }),
  );
  const m = d.mermaid;
  // Self-loops are a line in the box, not an arc.
  assertStringIncludes(
    m,
    `st_plan_generated("plan_generated<br/><small>↺ iterate</small>")`,
  );
  assert(!m.includes("st_plan_generated -->|"));
  assertStringIncludes(m, `st_plan_generated ==>|"approve"| st_approved`);
  assertStringIncludes(m, `st_pr_failed("pr_failed"):::failure`);
  assertStringIncludes(m, `st_done("done"):::highlight`);
  assertStringIncludes(m, `st_notify -->|"notify / skip_notify"| st_done`);
  // Steps back are retries; forward shortcuts are not.
  assertStringIncludes(m, `"verification_failed (retry)"`);
  assertStringIncludes(m, `"implement (retry)"`);
  assertStringIncludes(m, `st_releasing -->|"ship / complete"| st_notify`);
  assert(!m.includes(`"complete (retry)"`));
});

Deno.test("hidden phases become entry dots; collapse joins through a phase", () => {
  const t = parseTransitions(LIFECYCLE);
  const joined = collapse(t, ["verifying"]);
  assert(!joined.some((x) => x.from === "verifying" || x.to === "verifying"));
  assert(
    joined.some((x) =>
      x.from === "implementing" && x.to === "pr_open" && x.method === "link_pr"
    ),
  );
  // implementing → verifying → implementing is a round trip: dropped.
  assert(
    !joined.some((x) => x.from === "implementing" && x.to === "implementing"),
  );

  const m = renderStateMachine(
    t,
    opts({
      hideStates: ["created"],
      collapseStates: ["verifying"],
      notes: { triaging: "reads <CLAUDE.md>" },
    }),
  ).mermaid;
  assertStringIncludes(m, `__start -->|"start"| st_triaging`);
  assertStringIncludes(m, "reads #lt;CLAUDE.md#gt;");
  assert(!m.includes("st_created"));
});

Deno.test("renderStateMachine refuses an empty machine", () => {
  let threw = false;
  try {
    renderStateMachine([], opts());
  } catch {
    threw = true;
  }
  assert(threw);
});

const WORKFLOW = `
name: build-and-ship
jobs:
  - name: build
    steps:
      - name: compile
        task: { type: behavior, behavior: builder, methodName: build }
      - name: approve
        task: { type: manual_approval, prompt: ok? }
        dependsOn: [{ step: compile, condition: { type: succeeded } }]
      - name: cleanup
        allowFailure: true
        task: { type: model_method, modelIdOrName: builder, methodName: clean }
        dependsOn: [{ step: compile, condition: { type: failed } }]
  - name: ship
    labels: { role: deployer }
    dependsOn: [{ job: build, condition: { type: completed } }]
    steps:
      - name: child
        task: { type: workflow, workflowIdOrName: deploy }
`;

Deno.test("renderWorkflow draws jobs, steps, task kinds and conditions", () => {
  const d = renderWorkflow(parseWorkflow(WORKFLOW, "w.yaml"), {
    theme: "light",
    direction: "TD",
  });
  assertEquals([d.jobs, d.steps], [2, 4]);
  const m = d.mermaid;
  assertStringIncludes(m, `subgraph job_build["build"]`);
  assertStringIncludes(m, "direction TB");
  assertStringIncludes(m, "builder · build");
  assertStringIncludes(
    m,
    `s_build_approve{{"approve<br/><small>manual approval</small>"}}:::highlight`,
  );
  assertStringIncludes(m, ":::dashed");
  assertStringIncludes(m, `s_build_compile -->|"failed"| s_build_cleanup`);
  assertStringIncludes(m, `job_build -.->|"completed"| job_ship`);
  assertStringIncludes(m, `s_ship_child[[`);
  assertStringIncludes(
    m,
    `subgraph job_ship["ship · on worker role=deployer"]`,
  );
});

Deno.test("task and condition descriptions", () => {
  assertEquals(describeTask({ type: "wait_for_signal" }).human, true);
  assertEquals(
    describeTask({ type: "behavior", behaviorType: "@a/b", methodName: "m" })
      .text,
    "@a/b · m",
  );
  assertEquals(describeCondition(undefined), { role: "normal" });
  assertEquals(describeCondition({ type: "failed" }).role, "fail");
  assertEquals(escapeLabel(`a "b" | <c>`), "a #quot;b#quot; #124; #lt;c#gt;");
  assertEquals(slug("@swamp/issue-lifecycle"), "swamp-issue-lifecycle");
});

Deno.test("parseWorkflow rejects files that aren't workflows", () => {
  let threw = 0;
  for (const text of ["a: 1", "name: x"]) {
    try {
      parseWorkflow(text, "f");
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 2);
});

function fakeContext(repoDir: string, g: Record<string, unknown> = {}) {
  const files: Record<string, string | Uint8Array> = {};
  const resources: Record<string, Record<string, unknown>> = {};
  return {
    files,
    resources,
    ctx: {
      repoDir,
      globalArgs: {
        format: "mermaid",
        theme: "dark",
        direction: "TD",
        render: "none",
        outputDir: "",
        embedIn: "",
        copyFiles: ["mmd", "md", "image"],
        registryUrl: "https://example.test",
        dockerPath: "docker",
        mermaidImage: "img",
        ...g,
      },
      logger: { info() {}, warning() {} },
      writeResource: (
        _s: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        resources[name] = data;
        return Promise.resolve({ name });
      },
      createFileWriter: (_s: string, name: string) => ({
        writeText: (t: string) => {
          files[name] = t;
          return Promise.resolve({ name });
        },
        writeAll: (b: Uint8Array) => {
          files[name] = b;
          return Promise.resolve({ name });
        },
      }),
    },
  };
}

Deno.test("workflow method draws every workflow and copies to outputDir", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "workflows"));
    await Deno.writeTextFile(
      join(dir, "workflows", "workflow-build-and-ship.yaml"),
      WORKFLOW,
    );
    await Deno.writeTextFile(join(dir, "workflows", "notes.yaml"), "a: 1\n");
    const { ctx, files, resources } = fakeContext(dir, {
      render: "svg",
      outputDir: "docs/diagrams",
    });
    const res = await model.methods.workflow.execute(
      {
        name: "",
        path: "",
        dir: "",
        title: "",
        _render: () => Promise.resolve(new TextEncoder().encode("<svg/>")),
      },
      // deno-lint-ignore no-explicit-any
      ctx as any,
    );
    assertEquals(res.dataHandles.length, 4);
    assert(files["workflow-build-and-ship-svg"] instanceof Uint8Array);
    const r = resources["workflow-build-and-ship"];
    assertEquals(r.copiedTo, [
      "docs/diagrams/workflow-build-and-ship.mmd",
      "docs/diagrams/workflow-build-and-ship.md",
      "docs/diagrams/workflow-build-and-ship.svg",
    ]);
    const md = await Deno.readTextFile(
      join(dir, "docs/diagrams/workflow-build-and-ship.md"),
    );
    assertStringIncludes(md, "```mermaid\n---\ntitle:");
    await assertRejects(() => findWorkflows(dir, { name: "nope", path: "" }));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("stateMachine method reads the registry description", async () => {
  const { ctx, resources } = fakeContext("/tmp");
  await model.methods.stateMachine.execute(
    {
      extension: "@swamp/issue-lifecycle",
      transitions: "",
      title: "",
      subtitle: "",
      hideStates: [],
      collapseStates: [],
      omitMethods: [],
      humanGates: ["approve"],
      highlightStates: [],
      failureStates: [],
      notes: {},
      showComments: false,
      path: "",
      backEdges: "retry",
      _fetch: (url, ext) =>
        Promise.resolve({ url: `${url}/${ext}`, description: LIFECYCLE }),
    },
    // deno-lint-ignore no-explicit-any
    ctx as any,
  );
  const r = resources["state-machine-swamp-issue-lifecycle"];
  assertEquals(r.source, "https://example.test/@swamp/issue-lifecycle");
  assertEquals(r.nodes, 12);
  await assertRejects(() =>
    model.methods.stateMachine.execute(
      {
        extension: "",
        transitions: "no arrows here",
        title: "",
        subtitle: "",
        hideStates: [],
        collapseStates: [],
        omitMethods: [],
        humanGates: [],
        highlightStates: [],
        failureStates: [],
        notes: {},
        showComments: false,
        path: "",
        backEdges: "retry",
      },
      // deno-lint-ignore no-explicit-any
      ctx as any,
    )
  );
});

Deno.test("theme both renders a dark and light pair; dir finds nested workflows/", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "ext/workflows"), { recursive: true });
    await Deno.mkdir(join(dir, "ext/models"), { recursive: true });
    await Deno.mkdir(join(dir, ".github/workflows"), { recursive: true });
    await Deno.writeTextFile(join(dir, "ext/workflows/w.yaml"), WORKFLOW);
    await Deno.writeTextFile(join(dir, "ext/models/m.yaml"), WORKFLOW);
    await Deno.writeTextFile(join(dir, ".github/workflows/ci.yml"), WORKFLOW);
    const found = await findWorkflows(join(dir, "ext"), {
      name: "",
      path: "",
      dir: "..",
    });
    assertEquals(found.map((f) => f.path), [join(dir, "ext/workflows/w.yaml")]);

    const rendered: string[] = [];
    const { ctx } = fakeContext(join(dir, "ext"), {
      theme: "both",
      render: "svg",
      outputDir: "../docs/diagrams",
      copyFiles: ["mmd", "image"],
    });
    await model.methods.workflow.execute(
      {
        name: "build-and-ship",
        path: "",
        dir: "..",
        title: "",
        _render: (m, _f, g) => {
          rendered.push(`${g.theme}:${m.includes("#0b0f0e")}`);
          return Promise.resolve(new Uint8Array([1]));
        },
      },
      // deno-lint-ignore no-explicit-any
      ctx as any,
    );
    assertEquals(rendered, ["dark:true", "light:false"]);
    const mmd = await Deno.readTextFile(
      join(dir, "docs/diagrams/workflow-build-and-ship.mmd"),
    );
    assert(!mmd.includes("#0b0f0e"), "both keeps an auto-theme source");
    const names = [];
    for await (const e of Deno.readDir(join(dir, "docs/diagrams"))) {
      names.push(e.name);
    }
    assertEquals(names.sort(), [
      "workflow-build-and-ship-dark.svg",
      "workflow-build-and-ship-light.svg",
      "workflow-build-and-ship.mmd",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("auto theme leaves text colour and base theme to the viewer", () => {
  const fm = frontmatter("t", "auto").join("\n");
  assert(!fm.includes("theme: base"));
  assert(!fm.includes("primaryColor"));
  assertStringIncludes(fm, "curve: linear");
  const defs = classDefs("auto").join("\n");
  assertStringIncludes(
    defs,
    "classDef state fill:transparent,stroke:#14b8a6,stroke-width",
  );
  assert(!/classDef (state|highlight|failure) [^\n]*color:/.test(defs));
});

Deno.test("embed replaces only the named block and is idempotent", () => {
  const doc = [
    "# Doc",
    "<!-- swamp-diagram: a -->",
    "old",
    "<!-- /swamp-diagram -->",
    "between",
    "<!-- swamp-diagram: b -->",
    "keep",
    "<!-- /swamp-diagram -->",
    "",
  ].join("\n");
  const once = embed(doc, "a", mermaidBlock("flowchart TD\n  x --> y\n"));
  assertStringIncludes(once, "```mermaid\nflowchart TD\n  x --> y\n```");
  assert(!once.includes("old"));
  assertStringIncludes(once, "keep");
  assertEquals(
    embed(once, "a", mermaidBlock("flowchart TD\n  x --> y\n")),
    once,
  );
  assertEquals(embed(doc, "c", "x"), doc);
});

Deno.test("embedIn writes the diagram into marked Markdown blocks", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "workflows"));
    await Deno.mkdir(join(dir, "docs"));
    await Deno.writeTextFile(join(dir, "workflows/w.yaml"), WORKFLOW);
    await Deno.writeTextFile(
      join(dir, "docs/page.md"),
      "# Page\n\n<!-- swamp-diagram: workflow-build-and-ship -->\n<!-- /swamp-diagram -->\n",
    );
    const { ctx, resources } = fakeContext(dir, {
      theme: "auto",
      embedIn: "docs",
    });
    await model.methods.workflow.execute(
      { name: "", path: "", dir: "", title: "" },
      // deno-lint-ignore no-explicit-any
      ctx as any,
    );
    const page = await Deno.readTextFile(join(dir, "docs/page.md"));
    assertStringIncludes(page, '```mermaid\n---\ntitle: "build-and-ship"');
    assertEquals(resources["workflow-build-and-ship"].embeddedIn, [
      "docs/page.md",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("docker check passes without render and explains a missing CLI", async () => {
  assertEquals(
    await dockerAvailable({ render: "none", dockerPath: "nope" }),
    { pass: true },
  );
  const r = await dockerAvailable({
    render: "svg",
    dockerPath: "/nonexistent/docker-for-swamp-diagrams-test",
  });
  assertEquals(r.pass, false);
  assertStringIncludes(r.errors![0], "was not found");
  assertStringIncludes(r.errors![0], "render=none");
});

Deno.test("dockerPath and mermaidImage are validated", () => {
  const g = model.globalArguments;
  assert(g.safeParse({}).success);
  assert(!g.safeParse({ dockerPath: "--rm" }).success);
  assert(!g.safeParse({ dockerPath: "docker run" }).success);
  assert(!g.safeParse({ mermaidImage: "img; rm -rf /" }).success);
  assert(
    g.safeParse({ mermaidImage: "ghcr.io/mermaid-js/mermaid-cli:11.12.0" })
      .success,
  );
});

Deno.test("unparseable workflow files are logged, not silently skipped", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "workflows"));
    await Deno.writeTextFile(join(dir, "workflows/good.yaml"), WORKFLOW);
    await Deno.writeTextFile(join(dir, "workflows/broken.yaml"), "name: x\n");
    const warned: string[] = [];
    const found = await findWorkflows(dir, { name: "", path: "" }, {
      info() {},
      warning(_m: string, p?: Record<string, unknown>) {
        warned.push(String(p?.file));
      },
    });
    assertEquals(found.length, 1);
    assertEquals(warned, ["workflows/broken.yaml"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("workflows whose names share a diagram name are refused", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "workflows"));
    await Deno.writeTextFile(join(dir, "workflows/a.yaml"), WORKFLOW);
    await Deno.writeTextFile(
      join(dir, "workflows/b.yaml"),
      WORKFLOW.replace("name: build-and-ship", "name: build_and_ship"),
    );
    const { ctx } = fakeContext(dir);
    await assertRejects(
      () =>
        model.methods.workflow.execute(
          { name: "", path: "", dir: "", title: "" },
          // deno-lint-ignore no-explicit-any
          ctx as any,
        ),
      Error,
      "would both be drawn as workflow-build-and-ship",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("embed leaves markers inside code blocks alone", () => {
  const doc = [
    "Put a marker pair where a diagram belongs:",
    "",
    "```markdown",
    "<!-- swamp-diagram: a -->",
    "<!-- /swamp-diagram -->",
    "```",
    "",
    "<!-- swamp-diagram: a -->",
    "<!-- /swamp-diagram -->",
    "",
  ].join("\n");
  const out = embed(doc, "a", mermaidBlock("flowchart TD"));
  assertStringIncludes(
    out,
    "```markdown\n<!-- swamp-diagram: a -->\n<!-- /swamp-diagram -->\n```",
  );
  assertEquals(out.split("```mermaid").length, 2);
  const example = doc.split("\n").slice(0, 7).join("\n");
  assertEquals(embed(example, "a", "x"), example);
});

Deno.test("SVG layout: main path down the middle, failures beside, retries back", () => {
  const g = stateMachineGraph(
    parseTransitions(LIFECYCLE),
    opts({
      humanGates: ["approve"],
      hideStates: ["created"],
      collapseStates: ["verifying"],
      notes: { triaging: "reads <CLAUDE.md>" },
      subtitle: "a typed state machine",
    }),
  );
  for (const mode of ["dark", "light"] as const) {
    const svg = renderSvg(g, mode);
    assert(!/NaN|Infinity/.test(svg), "every coordinate is a number");
    assertStringIncludes(svg, "<svg xmlns=");
    assertStringIncludes(svg, "a typed state machine");
    assertStringIncludes(svg, "reads &lt;CLAUDE.md&gt;");
    assertStringIncludes(svg, ">implement (retry)<");
    assertStringIncludes(svg, `marker-end="url(#arrow-human)"`);
    for (const s of ["triaging", "approved", "pr_failed", "done"]) {
      assertStringIncludes(svg, `>${s}</text>`);
    }
  }
  // pr_failed sits level with pr_open, to its right.
  const svg = renderSvg(g, "dark");
  const at = (label: string) => {
    const m = new RegExp(
      `<text x="([-\\d.]+)" y="([-\\d.]+)"[^>]*>${label}</text>`,
    )
      .exec(svg)!;
    return { x: Number(m[1]), y: Number(m[2]) };
  };
  assertEquals(at("pr_failed").y, at("pr_open").y);
  assert(at("pr_failed").x > at("pr_open").x);
  assertEquals(at("triaging").x, at("done").x);
  assert(at("triaging").y < at("done").y);
});

Deno.test("SVG layout: workflow jobs are framed and fan-outs share a row", () => {
  const wf = parseWorkflow(
    `
name: fan
jobs:
  - name: host
    labels: { role: kvm-host }
    steps:
      - name: a
        task: { type: behavior, behavior: x, methodName: m }
      - name: b
        task: { type: behavior, behavior: x, methodName: m }
        dependsOn: [{ step: a }]
      - name: c
        task: { type: behavior, behavior: x, methodName: m }
        dependsOn: [{ step: a }]
`,
    "fan.yaml",
  );
  const svg = renderSvg(workflowGraph(wf), "light");
  assert(!/NaN|Infinity/.test(svg));
  assertStringIncludes(svg, "host · on worker role=kvm-host");
  assertStringIncludes(svg, `stroke-dasharray="4 4"`);
  const y = (label: string) =>
    Number(new RegExp(`y="([-\\d.]+)"[^>]*>${label}</text>`).exec(svg)![1]);
  assertEquals(y("b"), y("c"));
  assert(y("a") < y("b"));
});

Deno.test("format svg embeds a <picture> and writes the pair beside the page", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "workflows"));
    await Deno.mkdir(join(dir, "docs"));
    await Deno.writeTextFile(join(dir, "workflows/w.yaml"), WORKFLOW);
    await Deno.writeTextFile(
      join(dir, "docs/page.md"),
      "# Page\n\n<!-- swamp-diagram: workflow-build-and-ship -->\n<!-- /swamp-diagram -->\n",
    );
    const { ctx, resources } = fakeContext(dir, {
      format: "svg",
      embedIn: "docs",
    });
    const run = () =>
      model.methods.workflow.execute(
        { name: "", path: "", dir: "", title: "" },
        // deno-lint-ignore no-explicit-any
        ctx as any,
      );
    await run();
    const page = await Deno.readTextFile(join(dir, "docs/page.md"));
    assertStringIncludes(
      page,
      `<source media="(prefers-color-scheme: dark)" srcset="diagrams/workflow-build-and-ship-dark.svg">`,
    );
    assertStringIncludes(
      page,
      `src="diagrams/workflow-build-and-ship-light.svg"`,
    );
    const dark = await Deno.readTextFile(
      join(dir, "docs/diagrams/workflow-build-and-ship-dark.svg"),
    );
    assertStringIncludes(dark, "<svg");
    assertEquals(resources["workflow-build-and-ship"].copiedTo, [
      "docs/diagrams/workflow-build-and-ship-dark.svg",
      "docs/diagrams/workflow-build-and-ship-light.svg",
    ]);
    const before = (await Deno.stat(
      join(dir, "docs/diagrams/workflow-build-and-ship-dark.svg"),
    )).mtime;
    await run();
    assertEquals(await Deno.readTextFile(join(dir, "docs/page.md")), page);
    assertEquals(
      (await Deno.stat(
        join(dir, "docs/diagrams/workflow-build-and-ship-dark.svg"),
      ))
        .mtime,
      before,
      "an unchanged diagram isn't rewritten",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("format svg needs no Docker", async () => {
  assertEquals(
    await dockerAvailable({
      format: "svg",
      render: "png",
      dockerPath: "/nonexistent",
    }),
    { pass: true },
  );
});

Deno.test("SVG survives quotes in titles and a job with no steps", () => {
  const wf = parseWorkflow(
    `
name: 'say "hi"'
jobs:
  - name: empty
  - name: one
    steps:
      - name: a <b>
        task: { type: behavior, behavior: x, methodName: m }
`,
    "q.yaml",
  );
  const svg = renderSvg(workflowGraph(wf), "dark");
  assert(!/NaN|Infinity/.test(svg));
  assertStringIncludes(svg, `aria-label="say &quot;hi&quot;"`);
  assertStringIncludes(svg, ">a &lt;b&gt;</text>");
});

Deno.test("stateMachine reads transitions from a page; backEdges=normal isn't a retry", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(join(dir, "docs"));
    const page = [
      "# Lifecycle",
      "",
      "<!-- swamp-diagram: state-machine-taylor-thing -->",
      "<!-- /swamp-diagram -->",
      "",
      "```text",
      "absent ──[start]──> running",
      "running ──[stop]──> stopped",
      "stopped ──[start]──> running",
      "stopped ──[remove]──> removed",
      "```",
      "",
    ].join("\n");
    await Deno.writeTextFile(join(dir, "docs/thing.md"), page);
    const { ctx, resources } = fakeContext(dir, {
      format: "svg",
      embedIn: "docs",
    });
    await model.methods.stateMachine.execute(
      {
        extension: "",
        transitions: "",
        path: "docs/thing.md",
        title: "@taylor/thing",
        subtitle: "",
        hideStates: ["absent"],
        collapseStates: [],
        omitMethods: [],
        humanGates: [],
        highlightStates: [],
        failureStates: [],
        notes: {},
        showComments: false,
        backEdges: "normal",
      },
      // deno-lint-ignore no-explicit-any
      ctx as any,
    );
    const r = resources["state-machine-taylor-thing"];
    assertEquals(r.source, "docs/thing.md");
    assertEquals(r.embeddedIn, ["docs/thing.md"]);
    const svg = await Deno.readTextFile(
      join(dir, "docs/diagrams/state-machine-taylor-thing-dark.svg"),
    );
    assert(!svg.includes("(retry)"));
    assert(
      !svg.includes(`marker-end="url(#arrow-fail)"`),
      "a routine step back is not red",
    );
    // The transition lines in the page are left as they were.
    assertStringIncludes(
      await Deno.readTextFile(join(dir, "docs/thing.md")),
      "stopped ──[start]──> running",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
