# transcripts

A [swamp](https://swamp.club/) extension that transcribes meeting audio with
[Whisper](https://github.com/openai/whisper), using
[faster-whisper](https://github.com/SYSTRAN/faster-whisper) in a container
under Apple's [`container`](https://github.com/apple/container) CLI or Docker.
Everything runs locally, so the audio never leaves the machine.

## Model

`@taylor/whisper-transcriber` builds the image and transcribes audio files:

| Global argument | Default                  | Description                                                                                           |
| --------------- | ------------------------ | ----------------------------------------------------------------------------------------------------- |
| `runtime`       | `auto`                   | `container`, `docker`, or `auto` (Apple container if `container system status` succeeds, else Docker) |
| `image`         | `swamp-whisper`          | Image name; the tag is a hash of the embedded Dockerfile and script, so changes rebuild automatically |
| `model`         | `large-v3`               | Whisper model; `large-v3` is the most accurate                                                        |
| `computeType`   | `float32`                | `float32` is the highest quality on CPU; `int8` is about 2–3× faster and slightly less accurate       |
| `cpus`          | up to 8                  | CPUs for the container, which also sets the inference thread count                                    |
| `memory`        | `12G`                    | Container memory; Apple's container defaults to 1G, too little for large models                       |
| `cacheDir`      | `~/.cache/swamp-whisper` | Host directory where model weights (about 3 GB for `large-v3`) are cached                             |

| Method       | What it does                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------- |
| `build`      | Builds the image (`--input noCache=true` to rebuild from scratch)                             |
| `transcribe` | Transcribes one audio file, building the image first if it's missing; writes a `transcript` resource and a `text` file |

`transcribe` arguments:

| Argument        | Default         | Description                                                           |
| --------------- | --------------- | --------------------------------------------------------------------- |
| `audioPath`     |                 | Audio file (any format FFmpeg reads: m4a, mp3, wav, …), relative to the repo |
| `outputDir`     | next to audio   | Where to write the transcript files                                   |
| `language`      | auto-detect     | ISO code such as `en`                                                 |
| `beamSize`      | `5`             | Beam search width                                                     |
| `vad`           | `true`          | Skip silence with Silero VAD, which cuts hallucinated text in gaps    |
| `initialPrompt` |                 | Names, jargon and acronyms from the meeting, to help with spelling    |

## Usage

```sh
swamp extension pull @taylor/whisper-transcriber
swamp model create @taylor/whisper-transcriber whisper
swamp behavior run whisper transcribe \
  --input audioPath=2026-10-13-standup.m4a \
  --input initialPrompt="Weekly standup: ESLint, CI, pull requests."
```

It writes four files next to the audio:

- `<name>.txt`: one line per segment, prefixed with `[hh:mm:ss]`
- `<name>.srt` and `<name>.vtt`: subtitles
- `<name>.json`: segments with word-level timestamps and confidence

Progress is streamed to the swamp log as segments are decoded. On CPU, with
`large-v3` and `float32` on 8 cores of an Apple M4, a recording takes a little
over its own length to transcribe.

## What it runs

The image is `python:3.12-slim` with pinned `faster-whisper`, `av` (PyAV, which
bundles FFmpeg for decoding), `huggingface_hub` and `requests`, all installed
from prebuilt wheels. Both arm64 and amd64 hosts work. Inference runs on the
CPU, since containers on macOS can't reach the GPU. Weights are downloaded from
Hugging Face on first use into `cacheDir`, which is mounted at `/cache`.

These are the only commands the model runs, with `<rt>` being `container` or
`docker`:

```
container system status                 # runtime: auto, is Apple's container up?
docker info                             # runtime: auto, fallback
<rt> image inspect swamp-whisper:<hash> # does the image exist?
<rt> build -t swamp-whisper:<hash> -f <tmp>/Dockerfile <tmp>
<rt> run --rm --name swamp-whisper-<id> --cpus <n> --memory <mem> \
  -v <audio dir>:/in -v <output dir>:/out -v <cacheDir>:/cache \
  swamp-whisper:<hash> /in/<audio> --out-dir /out --stem <name> --model <model> ...
container delete --force swamp-whisper-<id>   # only if the run is cancelled
docker rm -f swamp-whisper-<id>               # likewise, on Docker
```

Each run uses a uniquely named container with `--rm`. If the swamp run is
cancelled, that container is force-removed.

Speaker diarization (labelling who said what) isn't included.

## Development

```sh
~/.swamp/deno/deno test --no-config --allow-all extensions/
```

## License

AGPL-3.0 with the Swamp Extension and Definition Exception; see
[LICENSE](LICENSE), [COPYING](COPYING) and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
