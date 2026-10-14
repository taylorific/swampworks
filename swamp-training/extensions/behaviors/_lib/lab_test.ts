import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import {
  type ExecResult,
  extractLab,
  missingLines,
  replaceKeyLine,
  runLab,
  subsetDiff,
} from "./lab.ts";

const F = "```";
const slide = (heading: string, ...body: string[]) =>
  [`# ${heading}`, "", ...body, "", "---", ""].join("\n");
const code = (lang: string, text: string) => `${F}${lang}\n${text}\n${F}`;

const deck = [
  slide(
    "What we're building: `@training/file-check`",
    "Create one file: `extensions/behaviors/file_check.ts`.",
  ),
  slide("Part 1: the schemas", code("ts {1|all}", "const S = 1;")),
  slide(
    "Part 2: describe the behavior type",
    code(
      "ts",
      "export const behavior = {\n  sizeBytes: z.number(),\n  methods: {\n    check: { /* coming up */ },\n  },\n};",
    ),
  ),
  slide(
    "Part 3: the `check` method",
    code("ts", "check: {\n  execute: () => ({\n    sizeBytes,\n  }),\n},"),
  ),
  slide("A unit test for `check`", code("ts", "Deno.test('t', () => {});")),
  slide(
    "Did swamp load the behavior type?",
    code("bash", "swamp behavior type describe @training/file-check"),
    code("text", "Type: @training/file-check\nMethods:"),
  ),
  slide(
    "Create a behavior definition, run the method",
    code(
      "bash",
      "swamp behavior create @training/file-check img --global-arg path=a.png",
    ),
    code(
      "yaml",
      "name: img\nglobalArguments:\n  minBytes: 1          # default",
    ),
    code(
      "bash",
      "swamp behavior run img check\nswamp data query 'modelName == \"img\"' --json",
    ),
  ),
  slide(
    "The data the method saved",
    code(
      "json",
      '{ "name": "report", "content": { "path": "a.png", "sizeBytes": 4, "checkedAt": "x" } }',
    ),
  ),
  slide(
    "Break the behavior: bad settings",
    code(
      "bash",
      "swamp behavior create @training/file-check bad --global-arg minBytes=-5",
    ),
    code("text", "minBytes: Too small"),
  ),
  slide(
    "One setup file: `deno.json`",
    code("text", "TS7006 [ERROR]: Parameter 'args'"),
    code("json", '{ "compilerOptions": { "noImplicitAny": false } }'),
  ),
  slide(
    "Run the tests",
    code("bash", "~/.swamp/deno/deno test extensions/behaviors/"),
    code("text", "ok | 1 passed | 0 failed (6ms)"),
  ),
  slide(
    "Break the behavior: a test catches the bug",
    code("ts", "bigEnough: sizeBytes > minBytes,      // was >="),
    code("text", "at file:///.../file_check_test.ts:1:1\nFAILED"),
  ),
  slide(
    "Break the behavior: bad output",
    code("ts", "sizeBytes: String(sizeBytes),"),
    code("text", "Warning Resource 'report' data does not match schema:"),
  ),
].join("");

Deno.test("extractLab assembles the source from parts 1-3", () => {
  const spec = extractLab(deck);
  assertEquals(spec.filePath, "extensions/behaviors/file_check.ts");
  assertEquals(
    spec.source,
    "const S = 1;\n\nexport const behavior = {\n  sizeBytes: z.number(),\n  methods: {\n    check: {\n      execute: () => ({\n        sizeBytes,\n      }),\n    },\n  },\n};\n",
  );
  assertEquals(spec.bug.line, "bigEnough: sizeBytes > minBytes,");
  assertEquals(spec.badSettings.length, 1);
  assertEquals(
    spec.query.command,
    `swamp data query 'modelName == "img"' --json`,
  );
});

Deno.test("extractLab names a missing slide", () => {
  assertThrows(
    () => extractLab(deck.replace("# Run the tests", "# Running tests")),
    Error,
    '"# Run the tests"',
  );
});

Deno.test("missingLines ignores colors, timings and spacing; ... matches anything", () => {
  const out =
    "\x1b[32mok\x1b[0m |  1 passed | 0 failed (8ms)\n  at file:///tmp/x/file_check_test.ts:1:1";
  assertEquals(
    missingLines(
      "ok | 1 passed | 0 failed (6ms)\nat file:///.../file_check_test.ts:1:1\nnope",
      out,
    ),
    ["nope"],
  );
});

Deno.test("subsetDiff compares only what the slide shows", () => {
  assertEquals(
    subsetDiff(
      { a: 1, c: { d: true, t: "x" } },
      { a: 1, b: 2, c: { d: false, t: "y" } },
      ["t"],
    ),
    ["c.d: slide shows true, got false"],
  );
});

Deno.test("replaceKeyLine changes the method's line, not the schema's", () => {
  const src = "  sizeBytes: z.number(),\n    sizeBytes,\n";
  assertEquals(
    replaceKeyLine(src, "sizeBytes: String(sizeBytes),"),
    "  sizeBytes: z.number(),\n    sizeBytes: String(sizeBytes),\n",
  );
});

Deno.test("runLab runs each step and reports what differs", async () => {
  const repo = await Deno.makeTempDir();
  const calls: string[] = [];
  const respond = (argv: string[]): ExecResult => {
    const cmd = argv.join(" ");
    const ok = (output: string, stdout = output) => ({
      code: 0,
      stdout,
      output,
    });
    const fail = (output: string) => ({ code: 1, stdout: "", output });
    if (cmd.includes("type describe")) {
      return ok("Type: @training/file-check\n\nMethods:\n");
    }
    if (cmd.includes("create @training/file-check img")) {
      Deno.mkdirSync(`${repo}/models/@training/file-check`, {
        recursive: true,
      });
      Deno.writeTextFileSync(
        `${repo}/models/@training/file-check/img.yaml`,
        "name: img\nglobalArguments:\n  minBytes: 1\n",
      );
      return ok("created");
    }
    if (cmd.includes("minBytes=-5")) {
      return fail("minBytes: Too small: expected");
    }
    if (cmd.includes("behavior run img check")) {
      const src = Deno.readTextFileSync(
        `${repo}/extensions/behaviors/file_check.ts`,
      );
      return ok(
        src.includes("String(")
          ? "Warning Resource 'report' data does not match schema: x"
          : "done",
      );
    }
    if (cmd.includes("data query")) {
      return ok(
        "",
        JSON.stringify({
          results: [{
            name: "report",
            content: { path: "a.png", sizeBytes: 5, checkedAt: "now" },
          }],
        }),
      );
    }
    if (cmd.includes("deno test")) {
      const hasConfig = (() => {
        try {
          Deno.statSync(`${repo}/deno.json`);
          return true;
        } catch {
          return false;
        }
      })();
      if (!hasConfig) {
        return fail("TS7006 [ERROR]: Parameter 'args' implicitly");
      }
      const src = Deno.readTextFileSync(
        `${repo}/extensions/behaviors/file_check.ts`,
      );
      return src.includes("> minBytes")
        ? fail("at file:///x/file_check_test.ts:1:1\nFAILED | 0 passed")
        : ok("ok | 1 passed | 0 failed (3ms)");
    }
    throw new Error(`unexpected ${cmd}`);
  };
  const exec = (argv: string[]) => {
    calls.push(argv.join(" "));
    return Promise.resolve(respond(argv));
  };
  const spec = extractLab(
    deck.replace(
      "Part 3: the `check` method\n\n```ts\ncheck: {\n  execute: () => ({\n    sizeBytes,\n  }),\n},",
      "Part 3: the `check` method\n\n```ts\ncheck: {\n  execute: () => ({\n    sizeBytes,\n    bigEnough: sizeBytes >= minBytes,\n  }),\n},",
    ),
  );
  const steps = await runLab(spec, {
    repo,
    home: "/h",
    swamp: "/bin/swamp",
    exec,
  });

  assertEquals(
    steps.map((s) => [s.step, s.ok]),
    [
      ["swamp loads the behavior type", true],
      ["create the behavior definition", true],
      ["run the method", true],
      ["query the saved data", false],
      ["bad settings 1 are refused", true],
      ["deno test fails without deno.json", true],
      ["deno test passes", true],
      ["a test catches the bug", true],
      ["bad output is saved with a warning", true],
    ],
  );
  assertStringIncludes(
    steps[3].detail,
    "content.sizeBytes: slide shows 4, got 5",
  );
  assertEquals(
    calls[0],
    "/bin/swamp behavior type describe @training/file-check --no-telemetry --no-color",
  );
  assertStringIncludes(
    calls.find((c) => c.includes("deno test"))!,
    "/h/.swamp/deno/deno test",
  );
  assertEquals((await Deno.stat(`${repo}/a.png`)).size, 4);
  assertStringIncludes(
    await Deno.readTextFile(`${repo}/extensions/behaviors/file_check.ts`),
    "bigEnough: sizeBytes >= minBytes,",
  );
  await Deno.remove(repo, { recursive: true });
});
