import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  cpuCount,
  DOCKERFILE,
  type Exec,
  type ExecResult,
  imageRef,
  instanceName,
  model,
  resolveRuntime,
} from "./whisper_transcriber.ts";

type TranscribeCtx = Parameters<typeof model.methods.transcribe.execute>[1];

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: [] });
const fail = (code = 1, line = "boom"): ExecResult => ({
  code,
  stdout: "",
  stderr: [line],
});

const SUMMARY = {
  model: "large-v3",
  computeType: "float32",
  beamSize: 5,
  language: "en",
  languageProbability: 0.99,
  durationSeconds: 61.5,
  segmentCount: 2,
  wordCount: 9,
  elapsedSeconds: 12.3,
};

/** A fake container CLI. `run` writes the transcript files the real container would. */
function fakeExec(
  handlers: Partial<Record<string, (args: string[]) => ExecResult>>,
) {
  const calls: string[][] = [];
  const exec: Exec = async (cmd, args) => {
    calls.push([cmd, ...args]);
    const h = handlers[`${cmd} ${args[0]}`] ?? handlers[args[0]];
    if (!h) throw new Error(`unexpected ${cmd} ${args.join(" ")}`);
    return await Promise.resolve(h(args));
  };
  return { exec, calls };
}

function writeOutputs(args: string[]): ExecResult {
  const out =
    args[args.indexOf("-v", args.indexOf("-v") + 1) + 1].split(":")[0];
  const stem = args[args.indexOf("--stem") + 1];
  for (const ext of ["srt", "vtt", "json"]) {
    Deno.writeTextFileSync(`${out}/${stem}.${ext}`, "");
  }
  Deno.writeTextFileSync(
    `${out}/${stem}.txt`,
    "[00:00:00] Hello everyone.\n[00:00:03] Let's triage lint.\n",
  );
  return ok(`SUMMARY ${JSON.stringify(SUMMARY)}\n`);
}

async function transcribe(
  handlers: Parameters<typeof fakeExec>[0],
  extra: Record<string, unknown> = {},
  signal?: AbortSignal,
) {
  const dir = await Deno.makeTempDir();
  await Deno.writeFile(`${dir}/standup.m4a`, new Uint8Array([0]));
  const { exec, calls } = fakeExec(handlers);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      runtime: "container",
      cacheDir: `${dir}/cache`,
      cpus: 4,
    }),
    methodName: "transcribe",
    repoDir: dir,
    ...(signal ? { signal } : {}),
  });
  const run = () =>
    model.methods.transcribe.execute(
      {
        ...model.methods.transcribe.arguments.parse({
          audioPath: "standup.m4a",
          ...extra,
        }),
        _exec: exec,
      },
      test.context as unknown as TranscribeCtx,
    );
  return { dir, calls, test, run };
}

Deno.test("imageRef tags with a stable recipe hash", async () => {
  const a = await imageRef("swamp-whisper");
  assertMatch(a, /^swamp-whisper:[0-9a-f]{12}$/);
  assertEquals(a, await imageRef("swamp-whisper"));
});

Deno.test("resolveRuntime prefers Apple container, falls back to docker", async () => {
  const both = fakeExec({
    "container system": () => ok(),
    "docker info": () => ok(),
  });
  assertEquals(await resolveRuntime("auto", both.exec), "container");
  const dockerOnly = fakeExec({
    "container system": () => fail(127),
    "docker info": () => ok(),
  });
  assertEquals(await resolveRuntime("auto", dockerOnly.exec), "docker");
  const none = fakeExec({
    "container system": () => fail(127),
    "docker info": () => fail(),
  });
  await assertRejects(
    () => resolveRuntime("auto", none.exec),
    Error,
    "No container runtime",
  );
  assertEquals(await resolveRuntime("docker", none.exec), "docker");
});

Deno.test("cpuCount never exceeds 8 unless configured", () => {
  assert(cpuCount() <= 8 && cpuCount() >= 1);
  assertEquals(cpuCount(12), 12);
});

Deno.test("global args default to the highest-quality settings", () => {
  const g = model.globalArguments.parse({});
  assertEquals([g.model, g.computeType, g.runtime], [
    "large-v3",
    "float32",
    "auto",
  ]);
});

Deno.test("image pins its python dependencies to prebuilt wheels", () => {
  assertMatch(DOCKERFILE, /--only-binary=:all:/);
  for (const pkg of ["faster-whisper", "av", "huggingface_hub", "requests"]) {
    assertMatch(DOCKERFILE, new RegExp(`${pkg}==\\d`));
  }
});

Deno.test("transcribe runs the container and records the transcript", async () => {
  const { dir, calls, test, run } = await transcribe(
    { "image": () => ok(), "run": writeOutputs },
    { language: "en", initialPrompt: "ESLint, CI" },
  );
  await run();
  const runCall = calls.find((c) => c[1] === "run")!;
  assertEquals(runCall[0], "container");
  assertEquals(runCall[runCall.indexOf("--cpus") + 1], "4");
  assertEquals(runCall[runCall.indexOf("--memory") + 1], "12G");
  assertEquals(runCall[runCall.indexOf("--language") + 1], "en");
  assertEquals(runCall[runCall.indexOf("--initial-prompt") + 1], "ESLint, CI");
  assert(runCall.includes(`${dir}/cache:/cache`));
  assert(!calls.some((c) => c[1] === "build"), "image existed, no build");

  const [res] = test.getWrittenResources();
  const data = res.data as Record<string, unknown>;
  assertEquals(data.wordCount, 9);
  assertEquals(data.runtime, "container");
  assertEquals(
    (data.outputs as Record<string, string>).txt,
    `${dir}/standup.txt`,
  );
  assertEquals(test.getWrittenFiles().length, 1);
});

Deno.test("transcribe builds the image when it is missing", async () => {
  const { calls, run } = await transcribe({
    "image": () => fail(),
    "build": () => ok(),
    "run": writeOutputs,
  });
  await run();
  const build = calls.find((c) => c[1] === "build")!;
  assertEquals(build[build.indexOf("-t") + 1], await imageRef("swamp-whisper"));
});

Deno.test("transcribe fails without writing data when the container fails", async () => {
  const { test, run } = await transcribe({
    "image": () => ok(),
    "run": () => fail(1, "ModuleNotFoundError: No module named 'requests'"),
  });
  await assertRejects(run, Error, "No module named 'requests'");
  assertEquals(test.getWrittenResources().length, 0);
});

Deno.test("transcribe rejects a missing audio file before touching the runtime", async () => {
  const { calls, run } = await transcribe({}, { audioPath: "nope.m4a" });
  await assertRejects(run, Error, "Audio file not found");
  assertEquals(calls.length, 0);
});

Deno.test("instance names are prefixed per spec and storage-safe", async () => {
  assertEquals(
    instanceName("2026-10-13 lint triage"),
    "2026-10-13-lint-triage",
  );
  assertEquals(instanceName("../x"), "x");
  assertEquals(instanceName("..."), "audio");
  const { test, run } = await transcribe({
    "image": () => ok(),
    "run": writeOutputs,
  });
  await run();
  assertEquals(test.getWrittenResources()[0].name, "transcript-standup");
  assertEquals(test.getWrittenFiles()[0].name, "text-standup");
});

Deno.test("cancelling transcribe force-removes the named container", async () => {
  const controller = new AbortController();
  let finish!: (r: ExecResult) => void;
  const { calls, run } = await transcribe(
    {
      "image": () => ok(),
      "run": (() => {
        queueMicrotask(() => controller.abort());
        return new Promise<ExecResult>((r) => (finish = r));
      }) as unknown as (args: string[]) => ExecResult,
      "delete": () => {
        finish(fail(137, "killed"));
        return ok();
      },
    },
    {},
    controller.signal,
  );
  await assertRejects(run, Error, "killed");
  const runCall = calls.find((c) => c[1] === "run")!;
  const name = runCall[runCall.indexOf("--name") + 1];
  assertMatch(name, /^swamp-whisper-[0-9a-f]{8}$/);
  assertEquals(calls.at(-1), ["container", "delete", "--force", name]);
});
