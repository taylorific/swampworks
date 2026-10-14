/**
 * Transcribes meeting audio with OpenAI Whisper (via faster-whisper) running in
 * a local container. Works with Apple `container` or Docker.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { basename, dirname, extname, join, resolve } from "jsr:@std/path@1.0.8";

/** Container image recipe. faster-whisper decodes audio with PyAV, so no system ffmpeg is needed. */
export const DOCKERFILE = `FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 HF_HOME=/cache HF_HUB_DISABLE_TELEMETRY=1
RUN pip install --no-cache-dir --only-binary=:all: faster-whisper==1.1.1 av==14.2.0 huggingface_hub==0.30.2 requests==2.32.3
COPY transcribe.py /app/transcribe.py
WORKDIR /work
ENTRYPOINT ["python", "/app/transcribe.py"]
`;

/** Python entrypoint executed inside the container. */
export const TRANSCRIBE_PY = `import argparse, json, os, sys, time
from faster_whisper import WhisperModel

p = argparse.ArgumentParser()
p.add_argument("input")
p.add_argument("--out-dir", required=True)
p.add_argument("--stem", required=True)
p.add_argument("--model", default="large-v3")
p.add_argument("--language", default=None)
p.add_argument("--compute-type", default="float32")
p.add_argument("--beam-size", type=int, default=5)
p.add_argument("--threads", type=int, default=0)
p.add_argument("--vad", default="true")
p.add_argument("--initial-prompt", default=None)
a = p.parse_args()

def ts(s, sep="."):
    h, r = divmod(s, 3600); m, r = divmod(r, 60)
    return f"{int(h):02d}:{int(m):02d}:{r:06.3f}".replace(".", sep)

t0 = time.time()
print(f"loading model {a.model} ({a.compute_type})", file=sys.stderr, flush=True)
model = WhisperModel(a.model, device="cpu", compute_type=a.compute_type,
                     cpu_threads=a.threads, download_root=os.path.join("/cache", "models"))
segments, info = model.transcribe(
    a.input,
    language=a.language or None,
    beam_size=a.beam_size,
    best_of=a.beam_size,
    vad_filter=a.vad.lower() == "true",
    vad_parameters={"min_silence_duration_ms": 500},
    condition_on_previous_text=True,
    initial_prompt=a.initial_prompt or None,
    word_timestamps=True,
)
print(f"language={info.language} p={info.language_probability:.2f} duration={info.duration:.1f}s",
      file=sys.stderr, flush=True)

segs = []
for s in segments:
    segs.append({"id": s.id, "start": s.start, "end": s.end, "text": s.text.strip(),
                 "avg_logprob": s.avg_logprob, "no_speech_prob": s.no_speech_prob,
                 "words": [{"start": w.start, "end": w.end, "word": w.word, "probability": w.probability}
                           for w in (s.words or [])]})
    pct = 100 * s.end / info.duration if info.duration else 0
    print(f"[{pct:5.1f}%] [{ts(s.start)} -> {ts(s.end)}] {s.text.strip()}", file=sys.stderr, flush=True)

base = os.path.join(a.out_dir, a.stem)
with open(base + ".txt", "w") as f:
    f.write("\\n".join(f"[{ts(s['start'])[:8]}] {s['text']}" for s in segs) + "\\n")
with open(base + ".srt", "w") as f:
    for i, s in enumerate(segs, 1):
        f.write(f"{i}\\n{ts(s['start'], ',')} --> {ts(s['end'], ',')}\\n{s['text']}\\n\\n")
with open(base + ".vtt", "w") as f:
    f.write("WEBVTT\\n\\n")
    for s in segs:
        f.write(f"{ts(s['start'])} --> {ts(s['end'])}\\n{s['text']}\\n\\n")
summary = {"model": a.model, "computeType": a.compute_type, "beamSize": a.beam_size,
           "language": info.language, "languageProbability": info.language_probability,
           "durationSeconds": info.duration, "segmentCount": len(segs),
           "wordCount": sum(len(s["text"].split()) for s in segs),
           "elapsedSeconds": time.time() - t0}
with open(base + ".json", "w") as f:
    json.dump({**summary, "segments": segs}, f, indent=1)
print("SUMMARY " + json.dumps(summary), flush=True)
`;

const GlobalArgsSchema = z.object({
  runtime: z.enum(["auto", "container", "docker"]).default("auto").describe(
    "Container runtime: Apple `container`, `docker`, or `auto` (prefers Apple container when running)",
  ),
  image: z.string().default("swamp-whisper").describe(
    "Image repository name; the tag is derived from a hash of the embedded recipe",
  ),
  model: z.string().default("large-v3").describe(
    "Whisper model name (large-v3 is the most accurate)",
  ),
  computeType: z.enum(["float32", "int8", "int8_float32"]).default("float32")
    .describe("CTranslate2 precision; float32 is the highest quality on CPU"),
  cpus: z.number().int().positive().optional().describe(
    "CPUs given to the container (default: up to 8, never more than the host has)",
  ),
  memory: z.string().default("12G").describe(
    "Memory given to the container (Apple container defaults to 1G, too small for large models)",
  ),
  cacheDir: z.string().optional().describe(
    "Host directory for cached model weights (default ~/.cache/swamp-whisper)",
  ),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const BuildArgsSchema = z.object({
  noCache: z.boolean().default(false).describe("Rebuild without layer cache"),
});

const TranscribeArgsSchema = z.object({
  audioPath: z.string().describe(
    "Path to the audio file (relative paths resolve from the repo root)",
  ),
  outputDir: z.string().optional().describe(
    "Where to write .txt/.srt/.vtt/.json (default: next to the audio)",
  ),
  language: z.string().optional().describe(
    "ISO language code, e.g. en (default: auto-detect)",
  ),
  beamSize: z.number().int().positive().default(5).describe(
    "Beam search width",
  ),
  vad: z.boolean().default(true).describe(
    "Skip silence with Silero VAD (reduces hallucinations)",
  ),
  initialPrompt: z.string().optional().describe(
    "Vocabulary hint: names, jargon, acronyms used in the meeting",
  ),
});

const ImageSchema = z.object({
  image: z.string(),
  runtime: z.string(),
  builtAt: z.iso.datetime(),
});

const SummarySchema = z.object({
  model: z.string(),
  computeType: z.string(),
  beamSize: z.number(),
  language: z.string(),
  languageProbability: z.number(),
  durationSeconds: z.number(),
  segmentCount: z.number(),
  wordCount: z.number(),
  elapsedSeconds: z.number(),
});

const TranscriptSchema = SummarySchema.extend({
  audioPath: z.string(),
  outputs: z.object({
    txt: z.string(),
    srt: z.string(),
    vtt: z.string(),
    json: z.string(),
  }),
  runtime: z.string(),
  transcribedAt: z.iso.datetime(),
});

type Logger = {
  info: (msg: string, props?: Record<string, unknown>) => void;
  debug: (msg: string, props?: Record<string, unknown>) => void;
};

/** Result of running an external command. */
export type ExecResult = { code: number; stdout: string; stderr: string[] };

/**
 * Runs an external command. `onLine` receives each stderr line as it arrives;
 * a missing executable is reported as code 127 rather than thrown.
 */
export type Exec = (
  cmd: string,
  args: string[],
  opts?: { onLine?: (line: string) => void; signal?: AbortSignal },
) => Promise<ExecResult>;

/** Default {@link Exec} backed by Deno.Command. */
export const denoExec: Exec = async (cmd, args, opts = {}) => {
  let child: Deno.ChildProcess;
  try {
    // swamp-quality-ignore deno-command: runs the container or docker CLI; argument lists are built in this file, see README What it runs
    child = new Deno.Command(cmd, {
      args,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
      signal: opts.signal,
    }).spawn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return { code: 127, stdout: "", stderr: [`${cmd}: command not found`] };
    }
    throw err;
  }
  const stderr: string[] = [];
  const pump = (async () => {
    let buf = "";
    for await (
      const chunk of child.stderr.pipeThrough(new TextDecoderStream())
    ) {
      buf += chunk;
      const parts = buf.split(/\r?\n/);
      buf = parts.pop() ?? "";
      for (const line of parts) {
        if (!line.trim()) continue;
        opts.onLine?.(line);
        stderr.push(line);
        if (stderr.length > 30) stderr.shift();
      }
    }
  })();
  const [status, stdout] = await Promise.all([
    child.status,
    new Response(child.stdout).text(),
    pump,
  ]);
  return { code: status.code, stdout, stderr };
};

/** Runs a command, streaming stderr to the logger, and throws on failure. */
async function run(
  exec: Exec,
  cmd: string,
  args: string[],
  logger: Logger,
  signal?: AbortSignal,
): Promise<string> {
  logger.debug("exec {cmd} {args}", { cmd, args: args.join(" ") });
  const r = await exec(cmd, args, {
    onLine: (line) => logger.info("{line}", { line }),
    signal,
  });
  if (r.code !== 0) {
    throw new Error(
      `${cmd} ${args[0]} exited with code ${r.code}:\n${r.stderr.join("\n")}`,
    );
  }
  return r.stdout;
}

/** Image reference whose tag changes whenever the embedded recipe changes. */
export async function imageRef(image: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(DOCKERFILE + TRANSCRIBE_PY),
  );
  const hex = Array.from(new Uint8Array(digest).slice(0, 6))
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${image}:${hex}`;
}

/** Picks the container CLI to use. */
export async function resolveRuntime(
  runtime: GlobalArgs["runtime"],
  exec: Exec = denoExec,
): Promise<"container" | "docker"> {
  if (runtime !== "auto") return runtime;
  if ((await exec("container", ["system", "status"])).code === 0) {
    return "container";
  }
  if ((await exec("docker", ["info"])).code === 0) return "docker";
  throw new Error(
    "No container runtime available: start Apple container (`container system start`) or Docker",
  );
}

/** Data instance name for an audio file stem, safe for swamp storage paths. */
export function instanceName(stem: string): string {
  return stem.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[-.]+/, "") ||
    "audio";
}

/** CPUs to give the container: the configured count, else up to 8. */
export function cpuCount(configured?: number): number {
  return configured ?? Math.min(8, navigator.hardwareConcurrency || 1);
}

/** Builds the whisper image from the embedded recipe. */
async function buildImage(
  exec: Exec,
  runtime: "container" | "docker",
  ref: string,
  noCache: boolean,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  const ctxDir = await Deno.makeTempDir({ prefix: "swamp-whisper-" });
  try {
    await Deno.writeTextFile(join(ctxDir, "Dockerfile"), DOCKERFILE);
    await Deno.writeTextFile(join(ctxDir, "transcribe.py"), TRANSCRIBE_PY);
    const args = ["build", "-t", ref, "-f", join(ctxDir, "Dockerfile")];
    if (noCache) args.push("--no-cache");
    args.push(ctxDir);
    await run(exec, runtime, args, logger, signal);
  } finally {
    await Deno.remove(ctxDir, { recursive: true });
  }
}

/** Builds the image unless it already exists locally. */
async function ensureImage(
  exec: Exec,
  runtime: "container" | "docker",
  ref: string,
  logger: Logger,
  signal?: AbortSignal,
): Promise<void> {
  if ((await exec(runtime, ["image", "inspect", ref])).code === 0) return;
  logger.info("Image {image} not found; building", { image: ref });
  await buildImage(exec, runtime, ref, false, logger, signal);
}

type WriteResource = (
  specName: string,
  name: string,
  data: Record<string, unknown>,
) => Promise<{ name: string }>;

type DataWriter = { writeText: (text: string) => Promise<{ name: string }> };

type BuildContext = {
  globalArgs: GlobalArgs;
  logger: Logger;
  signal?: AbortSignal;
  writeResource: WriteResource;
};

type TranscribeContext = BuildContext & {
  repoDir: string;
  createFileWriter: (specName: string, name: string) => DataWriter;
};

/** Model definition for containerized Whisper meeting transcription. */
export const model = {
  type: "@taylor/whisper-transcriber",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    image: {
      description: "The built whisper container image",
      schema: ImageSchema,
      lifetime: "infinite",
      garbageCollection: 5,
    },
    transcript: {
      description: "Metadata and output locations for a transcript",
      schema: TranscriptSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  files: {
    text: {
      description: "Timestamped plain-text transcript",
      contentType: "text/plain",
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    build: {
      description: "Build the whisper container image",
      arguments: BuildArgsSchema,
      execute: async (
        args: z.infer<typeof BuildArgsSchema> & { _exec?: Exec },
        context: BuildContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const exec = args._exec ?? denoExec;
        const g = context.globalArgs;
        const runtime = await resolveRuntime(g.runtime, exec);
        const ref = await imageRef(g.image);
        context.logger.info("Building {image} with {runtime}", {
          image: ref,
          runtime,
        });
        await buildImage(
          exec,
          runtime,
          ref,
          args.noCache,
          context.logger,
          context.signal,
        );
        const handle = await context.writeResource("image", "image", {
          image: ref,
          runtime,
          builtAt: new Date().toISOString(),
        });
        context.logger.info("Built {image}", { image: ref });
        return { dataHandles: [handle] };
      },
    },
    transcribe: {
      description:
        "Transcribe an audio file to .txt/.srt/.vtt/.json (builds the image if missing)",
      arguments: TranscribeArgsSchema,
      execute: async (
        args: z.infer<typeof TranscribeArgsSchema> & { _exec?: Exec },
        context: TranscribeContext,
      ): Promise<{ dataHandles: Array<{ name: string }> }> => {
        const exec = args._exec ?? denoExec;
        const g = context.globalArgs;
        const audio = resolve(context.repoDir, args.audioPath);
        try {
          await Deno.stat(audio);
        } catch (err) {
          if (err instanceof Deno.errors.NotFound) {
            throw new Error(`Audio file not found: ${audio}`);
          }
          throw err;
        }
        const outDir = resolve(
          context.repoDir,
          args.outputDir ?? dirname(audio),
        );
        await Deno.mkdir(outDir, { recursive: true });
        const cacheDir = g.cacheDir ??
          join(
            Deno.env.get("HOME") ?? context.repoDir,
            ".cache",
            "swamp-whisper",
          );
        await Deno.mkdir(cacheDir, { recursive: true });
        const stem = basename(audio, extname(audio));
        const cpus = cpuCount(g.cpus);

        const runtime = await resolveRuntime(g.runtime, exec);
        const ref = await imageRef(g.image);
        await ensureImage(exec, runtime, ref, context.logger, context.signal);

        // A named container can be removed if the run is cancelled; killing
        // the CLI alone can leave the container running.
        const name = `swamp-whisper-${crypto.randomUUID().slice(0, 8)}`;
        const runArgs = [
          "run",
          "--rm",
          "--name",
          name,
          "--cpus",
          String(cpus),
          "--memory",
          g.memory,
          "-v",
          `${dirname(audio)}:/in`,
          "-v",
          `${outDir}:/out`,
          "-v",
          `${cacheDir}:/cache`,
          ref,
          `/in/${basename(audio)}`,
          "--out-dir",
          "/out",
          "--stem",
          stem,
          "--model",
          g.model,
          "--compute-type",
          g.computeType,
          "--beam-size",
          String(args.beamSize),
          "--threads",
          String(cpus),
          "--vad",
          String(args.vad),
        ];
        if (args.language) runArgs.push("--language", args.language);
        if (args.initialPrompt) {
          runArgs.push("--initial-prompt", args.initialPrompt);
        }

        context.logger.info("Transcribing {audio} with {model} on {runtime}", {
          audio,
          model: g.model,
          runtime,
        });
        const cleanup = () => {
          const rm = runtime === "docker"
            ? ["rm", "-f", name]
            : ["delete", "--force", name];
          exec(runtime, rm).catch(() => {});
        };
        context.signal?.addEventListener("abort", cleanup, { once: true });
        let stdout: string;
        try {
          stdout = await run(exec, runtime, runArgs, context.logger);
        } finally {
          context.signal?.removeEventListener("abort", cleanup);
        }
        const line = stdout.split("\n").find((l) => l.startsWith("SUMMARY "));
        if (!line) {
          throw new Error("Transcriber exited without printing a summary");
        }
        const summary = SummarySchema.parse(
          JSON.parse(line.slice("SUMMARY ".length)),
        );

        const base = join(outDir, stem);
        const text = await Deno.readTextFile(`${base}.txt`);
        const handle = await context.writeResource(
          "transcript",
          `transcript-${instanceName(stem)}`,
          {
            ...summary,
            audioPath: audio,
            outputs: {
              txt: `${base}.txt`,
              srt: `${base}.srt`,
              vtt: `${base}.vtt`,
              json: `${base}.json`,
            },
            runtime,
            transcribedAt: new Date().toISOString(),
          },
        );
        const textHandle = await context.createFileWriter(
          "text",
          `text-${instanceName(stem)}`,
        )
          .writeText(text);
        context.logger.info(
          "Transcribed {segments} segments ({words} words) to {txt}",
          {
            segments: summary.segmentCount,
            words: summary.wordCount,
            txt: `${base}.txt`,
          },
        );
        return { dataHandles: [handle, textHandle] };
      },
    },
  },
};
