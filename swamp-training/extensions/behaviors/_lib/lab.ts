// The deck's hands-on lab, `@training/file-check`, rebuilt from the slides and
// run against a swamp release. Every file, command and expected output comes
// from the deck, so the lab tests what the slides tell people to do.

import {
  block,
  codeBlocks,
  findSlide,
  shellWords,
  type Slide,
} from "./deck.ts";

/** Output of one command. */
export interface ExecResult {
  code: number;
  stdout: string;
  /** stdout followed by stderr. */
  output: string;
}

/** Runs one command in a directory. Injectable for tests. */
export type Exec = (argv: string[], cwd: string) => Promise<ExecResult>;

/** One lab step's result. */
export interface LabStep {
  step: string;
  /** Slide heading and source line the step comes from. */
  slide: string;
  line: number;
  ok: boolean;
  /** Why the step failed: missing lines, a wrong exit code, the output. */
  detail: string;
}

interface Expect {
  slide: Slide;
  command: string;
  /** The text block that shows the output, if the slide has one. */
  output?: string;
}

/** Everything the lab needs, read from the deck. */
export interface LabSpec {
  filePath: string;
  source: string;
  test: string;
  describe: Expect;
  create: Expect & { yaml: string };
  run: Expect;
  query: Expect & { saved: Record<string, unknown> };
  badSettings: Expect[];
  denoJson: string;
  noConfig: Expect;
  tests: Expect;
  bug: Expect & { line: string };
  badOutput: Expect & { line: string };
}

const commandLines = (code: string): string[] =>
  code.split("\n").map((l) => l.replace(/\s+#.*$/, "").trim()).filter((l) =>
    l.length > 0 && !l.startsWith("#")
  );

const textBlocks = (s: Slide): string[] =>
  codeBlocks(s).filter((b) => b.lang === "text" || b.lang === "").map((b) =>
    b.code
  );

/** Reads the lab from the deck. Throws naming the slide that's missing a part. */
export function extractLab(md: string): LabSpec {
  const what = findSlide(md, "What we're building");
  const fileMatch = what.lines.join("\n").match(
    /Create one file: `([^`]+\.ts)`/,
  );
  if (!fileMatch) {
    throw new Error(
      `Slide "${what.heading}" (line ${what.line}) doesn't say "Create one file: \`<path>.ts\`"`,
    );
  }

  const part1 = block(findSlide(md, "Part 1:"), ["ts"]).code;
  const part2Slide = findSlide(md, "Part 2:");
  const part2 = block(part2Slide, ["ts"]).code;
  const part3 = block(findSlide(md, "Part 3:"), ["ts"]).code;
  const slot = part2.match(/^([ \t]*)check: \{ \/\* coming up \*\/ \},?$/m);
  if (!slot) {
    throw new Error(
      `Slide "${part2Slide.heading}" (line ${part2Slide.line}) has no \`check: { /* coming up */ },\` for Part 3`,
    );
  }
  const indented = part3.split("\n").map((l) => l ? slot[1] + l : l).join(
    "\n",
  );
  const source = `${part1}\n\n${part2.replace(slot[0], indented)}\n`;

  const loaded = findSlide(md, "Did swamp load the");
  const created = findSlide(md, "Create a behavior definition");
  const createRun = commandLines(block(created, ["bash"], 1).code);
  const saved = findSlide(md, "The data the method saved");
  const bad = findSlide(md, "Break the behavior: bad settings");
  const setup = findSlide(md, "One setup file");
  const runTests = findSlide(md, "Run the tests");
  const bug = findSlide(md, "Break the behavior: a test catches the bug");
  const badOut = findSlide(md, "Break the behavior: bad output");
  const tsLine = (s: Slide) => block(s, ["ts"]).code.split("//")[0].trim();
  const testCmd = commandLines(block(runTests, ["bash"]).code)[0];

  return {
    filePath: fileMatch[1],
    source,
    test: block(findSlide(md, "A unit test for"), ["ts"]).code + "\n",
    describe: {
      slide: loaded,
      command: commandLines(block(loaded, ["bash"]).code)[0],
      output: textBlocks(loaded)[0],
    },
    create: {
      slide: created,
      command: commandLines(block(created, ["bash"]).code)[0],
      yaml: block(created, ["yaml"]).code,
    },
    run: { slide: created, command: createRun[0] },
    query: {
      slide: saved,
      command: createRun[1],
      saved: JSON.parse(block(saved, ["json"]).code),
    },
    badSettings: codeBlocks(bad).filter((b) => b.lang === "bash").map((
      b,
      k,
    ) => ({
      slide: bad,
      command: commandLines(b.code)[0],
      output: textBlocks(bad)[k],
    })),
    denoJson: block(setup, ["json"]).code,
    noConfig: { slide: setup, command: testCmd, output: textBlocks(setup)[0] },
    tests: {
      slide: runTests,
      command: testCmd,
      output: textBlocks(runTests)[0],
    },
    bug: {
      slide: bug,
      command: testCmd,
      output: textBlocks(bug)[0],
      line: tsLine(bug),
    },
    badOutput: {
      slide: badOut,
      command: createRun[0],
      output: textBlocks(badOut)[0],
      line: tsLine(badOut),
    },
  };
}

/** Strips colors and timings, and collapses whitespace, for comparing output. */
export function normalize(s: string): string {
  return s
    // deno-lint-ignore no-control-regex
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\(\d+(\.\d+)?m?s\)/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The lines of `expected` that don't appear in `actual`. A `...` in an
 * expected line matches anything, as in the deck's trimmed paths.
 */
export function missingLines(expected: string, actual: string): string[] {
  const hay = normalize(actual);
  return expected.split("\n").filter((l) => normalize(l).length > 0).filter(
    (l) => {
      const pattern = normalize(l)
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        .replace(/\\\.\\\.\\\./g, ".*?")
        .replace(/ /g, "\\s*");
      return !new RegExp(pattern).test(hay);
    },
  );
}

/** Where `expected` (a trimmed copy) differs from `actual`, skipping `ignore` keys. */
export function subsetDiff(
  expected: unknown,
  actual: unknown,
  ignore: string[],
  path = "",
): string[] {
  if (expected && typeof expected === "object" && !Array.isArray(expected)) {
    if (!actual || typeof actual !== "object") {
      return [
        `${path || "result"}: expected an object, got ${
          JSON.stringify(actual)
        }`,
      ];
    }
    return Object.entries(expected).flatMap(([k, v]) =>
      ignore.includes(k) ? [] : subsetDiff(
        v,
        (actual as Record<string, unknown>)[k],
        ignore,
        path ? `${path}.${k}` : k,
      )
    );
  }
  return JSON.stringify(expected) === JSON.stringify(actual) ? [] : [
    `${path}: slide shows ${JSON.stringify(expected)}, got ${
      JSON.stringify(actual)
    }`,
  ];
}

/**
 * Replaces the last line that sets `key` (`key: ...` or shorthand `key,`)
 * with `line`, keeping its indentation. The last one is the method's write,
 * after the schema's line for the same key.
 */
export function replaceKeyLine(source: string, line: string): string {
  const key = line.split(":")[0].trim();
  const re = new RegExp(`^([ \\t]*)${key}([ \\t]*:.*|[ \\t]*,)[ \\t]*$`, "gm");
  const hits = [...source.matchAll(re)];
  const last = hits[hits.length - 1];
  if (!last) throw new Error(`No \`${key}\` line in the lab source to change`);
  return source.slice(0, last.index) + last[1] + line +
    source.slice(last.index! + last[0].length);
}

/** Where the lab runs. */
export interface Sandbox {
  repo: string;
  home: string;
  swamp: string;
  exec: Exec;
}

/** The deck's command as an argument list for the sandbox. */
export function sandboxArgv(command: string, sb: Sandbox): string[] {
  const argv = shellWords(command);
  if (argv[0] === "swamp") {
    return [sb.swamp, ...argv.slice(1), "--no-telemetry", "--no-color"];
  }
  return argv.map((a) => a.replace(/^~(?=\/)/, sb.home));
}

const tail = (s: string, n = 1500): string =>
  s.length > n ? "…" + s.slice(-n) : s;

async function findFile(dir: string, name: string): Promise<string | null> {
  for await (const e of Deno.readDir(dir)) {
    const p = `${dir}/${e.name}`;
    if (e.isFile && e.name === name) return p;
    if (e.isDirectory) {
      const found = await findFile(p, name);
      if (found) return found;
    }
  }
  return null;
}

/** Runs the lab in `sb.repo`, an initialized swamp repo. */
export async function runLab(spec: LabSpec, sb: Sandbox): Promise<LabStep[]> {
  const steps: LabStep[] = [];
  const file = `${sb.repo}/${spec.filePath}`;
  const testFile = file.replace(/\.ts$/, "_test.ts");

  const step = async (
    name: string,
    e: Expect,
    wantSuccess: boolean,
    extra?: (r: ExecResult) => Promise<string[]> | string[],
  ) => {
    let problems: string[] = [];
    let output = "";
    try {
      const r = await sb.exec(sandboxArgv(e.command, sb), sb.repo);
      output = r.output;
      if ((r.code === 0) !== wantSuccess) {
        problems.push(
          `\`${e.command}\` exited ${r.code}; the slide expects ${
            wantSuccess ? "success" : "a failure"
          }`,
        );
      }
      if (e.output) {
        problems.push(
          ...missingLines(e.output, output).map((l) =>
            `missing from the output: ${l.trim()}`
          ),
        );
      }
      if (extra) problems.push(...await extra(r));
    } catch (err) {
      problems = [(err as Error).message];
    }
    steps.push({
      step: name,
      slide: e.slide.heading,
      line: e.slide.line,
      ok: problems.length === 0,
      detail: problems.length
        ? problems.join("\n") +
          (output ? `\n--- output ---\n${tail(output)}` : "")
        : "",
    });
  };

  await Deno.mkdir(file.slice(0, file.lastIndexOf("/")), { recursive: true });
  await Deno.writeTextFile(file, spec.source);
  await Deno.writeTextFile(testFile, spec.test);
  const content = (spec.query.saved.content ?? {}) as Record<string, unknown>;
  if (typeof content.path === "string") {
    const size = typeof content.sizeBytes === "number" ? content.sizeBytes : 1;
    await Deno.writeFile(`${sb.repo}/${content.path}`, new Uint8Array(size));
  }

  await step("swamp loads the behavior type", spec.describe, true);
  await step("create the behavior definition", spec.create, true, async () => {
    const name = spec.create.yaml.match(/^name:\s*(\S+)/m)?.[1] ?? "";
    const path = await findFile(`${sb.repo}/models`, `${name}.yaml`);
    if (!path) return [`no models/**/${name}.yaml was written`];
    const have = (await Deno.readTextFile(path)).split("\n").map((l) =>
      l.trim()
    );
    return commandLines(spec.create.yaml).filter((l) => !have.includes(l))
      .map((l) => `definition YAML has no line \`${l}\``);
  });
  await step("run the method", spec.run, true);
  await step("query the saved data", spec.query, true, (r) => {
    const results = JSON.parse(r.stdout).results;
    if (!Array.isArray(results) || results.length !== 1) {
      return [`expected one result, got ${results?.length ?? 0}`];
    }
    return subsetDiff(spec.query.saved, results[0], ["checkedAt"]);
  });
  for (const [k, bad] of spec.badSettings.entries()) {
    await step(`bad settings ${k + 1} are refused`, bad, false);
  }
  await step("deno test fails without deno.json", spec.noConfig, false);
  await Deno.writeTextFile(`${sb.repo}/deno.json`, spec.denoJson + "\n");
  await step("deno test passes", spec.tests, true);

  await Deno.writeTextFile(file, replaceKeyLine(spec.source, spec.bug.line));
  await step("a test catches the bug", spec.bug, false);
  await Deno.writeTextFile(
    file,
    replaceKeyLine(spec.source, spec.badOutput.line),
  );
  await step("bad output is saved with a warning", spec.badOutput, true);
  await Deno.writeTextFile(file, spec.source);
  return steps;
}
