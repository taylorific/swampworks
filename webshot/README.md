# webshot

A [swamp](https://swamp.club/) model that takes a full-page screenshot of a web
page (PNG, JPEG, or WebP), scrolling all the way to the bottom first so
lazy-loaded content is rendered. Pages of any height are captured correctly,
including ones far taller than Chrome can capture in one shot.

## How it works

The `@taylor/webshot` model type (`extensions/models/webshot.ts`) drives
headless Chrome over the Chrome DevTools Protocol, using Deno's built-in
WebSocket — no Node, Puppeteer, or Playwright required. By default Chrome runs
in a fresh
[`chromedp/headless-shell`](https://hub.docker.com/r/chromedp/headless-shell)
Docker container for each capture, pinned to a specific Chrome version and
extended with Noto fonts, so screenshots are reproducible across machines. A
locally installed browser can be used instead.

For each capture it:

1. Starts a fresh browser — a new container (or a throwaway local profile) —
   and opens the URL, recording the HTTP status of the page. By default a 4xx
   or 5xx response fails the run without saving anything.
2. Scrolls down one viewport at a time, pausing between steps, until it reaches
   the bottom and the page stops growing (so lazy images and infinite-scroll
   sections load).
3. Scrolls back to the top and, by default, hides `position: fixed` overlays
   (cookie banners, chat widgets, slide-out menus) and unsticks sticky
   elements so they don't float mid-image.
4. Captures the page (see [Tall pages](#tall-pages)) and stores the image as
   swamp data, along with metadata about the capture.
5. Removes the container (or closes the local browser), including on errors
   and timeouts.

### Tall pages

Chrome cannot capture more than its maximum texture size in one screenshot —
8192 device pixels with the software renderer in the Docker image, 16384 on
many GPUs. Past that point it silently repeats the top of the page. webshot
plans around the smaller limit on every backend:

| Page height (device px) | `hideFixed` | Method                                                                  | Speed  |
| ----------------------- | ----------- | ----------------------------------------------------------------------- | ------ |
| up to 8000              | any         | One capture                                                             | fast   |
| taller                  | `true`      | Scroll one viewport at a time, capture each, stitch into one PNG        | fast   |
| taller                  | `false`     | Capture 4096 px bands beyond the viewport, stitch (fixed bars show once) | slow   |

Viewport-sized tiles keep the layout exactly as a visitor sees it (elements
sized with `100vh` stay one viewport tall). Stitching is lossless and only
supported for PNG; JPEG and WebP are limited to a single capture.

## Requirements

- [swamp](https://github.com/swamp-club/swamp)
- **Docker backend (default):** Docker (or a docker-compatible CLI set via
  `dockerPath`). On first use the base image (~150 MB, amd64 and arm64) is
  pulled and, with `fonts: noto`, a local font image is built from it once
  (about 2 minutes; ~800 MB on disk). Neither counts against `timeoutMs`.
- **Local backend:** Google Chrome, Chromium, Microsoft Edge, or Brave. Common
  install locations on macOS and Linux are detected automatically; otherwise
  set `chromePath` or `$CHROME_PATH`.

## Install

```bash
swamp extension pull @taylor/webshot
swamp model create @taylor/webshot webshot
```

## Usage

Capture a page:

```bash
swamp model method run webshot capture --input url=https://example.com
```

Give the screenshot an explicit name (defaults to a slug of the host, e.g.
`example-com`):

```bash
swamp model method run webshot capture \
  --input 'url=https://example.com/docs/page?tab=overview' \
  --input name=docs-page
```

Smaller files — WebP or JPEG at a chosen quality:

```bash
swamp model method run webshot capture --input url=https://example.com \
  --input format=webp --input quality=80
```

Save the image to a file:

```bash
swamp data query 'model("webshot") && name == "docs-page"' --select content --json \
  | jq -r '.results[0]' | base64 -D > docs-page.png   # use `base64 -d` on Linux
```

Use `--json` as shown: without it, swamp renders the result in the terminal,
which fails for large images.

To create another instance with different settings:

```bash
swamp model create @taylor/webshot webshot-retina
# then edit models/@taylor/webshot/webshot-retina.yaml, e.g.
#   globalArguments:
#     deviceScaleFactor: 2
```

### Using a local browser install

To use a locally installed Chrome instead of Docker:

```yaml
globalArguments:
  backend: local
  chromePath: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome # optional
```

Everything else — tall pages, formats, HTTP status checks — works the same.
The page renders with your machine's fonts and Chrome version, so results can
differ between machines.

## Configuration

### Global arguments (set on the model definition)

| Argument            | Default                                 | Description                                                                     |
| ------------------- | --------------------------------------- | ------------------------------------------------------------------------------- |
| `backend`           | `docker`                                | `docker` (fresh container per capture) or `local`                               |
| `image`             | `chromedp/headless-shell:156.0.8078.12` | Base image exposing DevTools on port 9222 (docker backend)                      |
| `fonts`             | `noto`                                  | `noto`: add Noto fonts (incl. emoji and CJK) to `image`; `basic`: use as-is     |
| `dockerPath`        | `docker`                                | Docker-compatible CLI (docker backend)                                          |
| `chromePath`        | auto-detect                             | Path to a Chrome/Chromium binary (local backend)                                |
| `viewportWidth`     | `1280`                                  | Viewport width in CSS pixels                                                    |
| `viewportHeight`    | `800`                                   | Viewport height in CSS pixels; also the scroll step and tall-page tile height   |
| `deviceScaleFactor` | `1`                                     | Device pixel ratio, a whole number 1–4; `2` gives retina-resolution images      |

### `capture` method arguments

| Argument          | Default    | Description                                                                 |
| ----------------- | ---------- | --------------------------------------------------------------------------- |
| `url`             | (required) | Page to screenshot (http/https only)                                        |
| `name`            | host slug  | Data name for the image (`[a-z0-9-]`, must not end in `-capture`)           |
| `format`          | `png`      | `png`, `jpeg`, or `webp`                                                    |
| `quality`         | `80`       | 1–100, for `jpeg` and `webp`                                                |
| `failOnHttpError` | `true`     | Fail without saving when the page returns HTTP 4xx/5xx                      |
| `scrollDelayMs`   | `300`      | Pause after each scroll step                                                |
| `settleMs`        | `1000`     | Wait after hiding overlays, before capturing                                |
| `maxHeight`       | `50000`    | Cap on captured height in CSS pixels (guards infinite scroll)               |
| `timeoutMs`       | `60000`    | Overall timeout for loading and capturing                                   |
| `hideFixed`       | `true`     | Hide fixed overlays and unstick sticky elements before capturing            |

## Output data

Each run produces two pieces of data:

| Name             | Kind     | Contents                                                                                                                                  |
| ---------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `<name>`         | file     | The image (`image/png`, `image/jpeg`, or `image/webp`)                                                                                    |
| `<name>-capture` | resource | `url`, `finalUrl`, `title`, `width`, `height`, `truncated`, `format`, `httpStatus`, `tiles`, `bytes`, `capturedAt`, `browserVersion`       |

`truncated` is `true` when the page was cut off — taller than `maxHeight`, or
taller than one JPEG/WebP capture can hold. `httpStatus` is `null` when Chrome
reported no status (for example, a page served by a service worker). `tiles`
is the number of captures stitched together. Up to 10 versions of each are
kept.

Reference them from other models or workflows with CEL:

```
data.latest("webshot", "example-com").path
data.latest("webshot", "example-com-capture").attributes.httpStatus
```

## What it runs

**Docker backend.** `capture` runs the docker CLI with fixed argument lists:

```
docker image inspect <image>          # pulls with `docker pull <image>` if missing
docker image inspect <font image>     # fonts: noto only; builds it if missing:
docker build --tag webshot-noto:<image> --label webshot.base=<image> -
docker run --detach --rm --label webshot=1 --publish 127.0.0.1::9222
  --shm-size 1g --add-host host.docker.internal:host-gateway <image>
  --hide-scrollbars --mute-audio --window-size=<width>,<height>
docker port <container> 9222/tcp
docker rm --force <container>         # always, on success, error, or timeout
```

The font image's Dockerfile is passed on stdin. It is `FROM <image>` plus one
`apt-get install` of version-pinned Debian packages (`fonts-noto-core`,
`fonts-noto-color-emoji`, `fonts-noto-cjk`). Remove it with
`docker image rm webshot-noto:<image>`; it is rebuilt on next use.

The DevTools port is published on a random port bound to `127.0.0.1` only, so
the browser is never reachable from the network. `image` is validated against
an image-reference pattern (it cannot start with `-`), and the viewport size
is validated as positive integers.

**Local backend.** `capture` runs the browser binary resolved from
`chromePath`, `$CHROME_PATH`, or the built-in list of install locations:

```
--headless=new --remote-debugging-port=0 --user-data-dir=<new temp dir>
--no-first-run --no-default-browser-check --hide-scrollbars --mute-audio
--window-size=<viewportWidth>,<viewportHeight> about:blank
```

The temp profile directory is deleted and the browser killed when the method
finishes.

In both cases the URL is never put on a command line; it is sent over the
DevTools connection.

## Limitations

- Each capture uses a fresh browser profile, so pages behind a login show the
  login screen.
- Infinite-scroll pages stop at `maxHeight`.
- JPEG and WebP are limited to one capture (8000 device pixels, i.e. 8000 CSS
  px at scale 1, 4000 at scale 2); taller pages are cut and marked
  `truncated`. Use PNG for the full page.
- Tall pages with `hideFixed: false` use the slow beyond-viewport method:
  Chrome re-renders the whole page for every 4096 px band, which can take tens
  of seconds per band on very long pages. Raise `timeoutMs` if needed.
- With the docker backend, `localhost` means the container. To capture a
  server running on your machine, use `http://host.docker.internal:<port>`.
- With `hideFixed` on, fixed-position headers are hidden too; pass
  `--input hideFixed=false` to keep them.

## Development

```bash
~/.swamp/deno/deno test -A extensions/models/   # unit tests, fake browser
~/.swamp/deno/deno run -A ci/smoke.ts            # real Chrome in Docker
```

CI (`.github/workflows/ci.yml` at the repository root) runs both on every pull
request that touches this extension.

## License

Licensed under the GNU Affero General Public License version 3 with the Swamp
Extension and Definition Exception — the same terms as the official swamp
extensions. See [LICENSE](LICENSE), [COPYING](COPYING), and
[COPYING-EXCEPTION](COPYING-EXCEPTION).
