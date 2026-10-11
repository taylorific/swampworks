import { z } from "npm:zod@4";
import { stitchPngs } from "./_lib/png.ts";

// Takes a full-page PNG screenshot of a web page. Drives headless Chrome —
// by default a fresh chromedp/headless-shell Docker container per capture, or
// a locally installed Chrome/Chromium — over the Chrome DevTools Protocol
// using Deno's native WebSocket, so there are no npm dependencies. The page is
// scrolled to the bottom in viewport-sized steps first so lazy-loaded content
// and infinite-scroll sections render before the capture. Pages taller than
// Chrome's single-capture limit are captured in tiles and stitched.

/** Pinned default image; bump deliberately so captures stay reproducible. */
export const DEFAULT_IMAGE = "chromedp/headless-shell:156.0.8078.12";

/**
 * Debian packages layered onto the image when `fonts` is `noto`, pinned to the
 * Debian 13 versions so the font image is as reproducible as the base image.
 */
export const NOTO_PACKAGES = [
  "fonts-noto-core=20201225-2",
  "fonts-noto-color-emoji=2.051-0+deb13u1",
  "fonts-noto-cjk=1:20240730+repack1-1",
];

/**
 * Chrome silently wraps a single capture taller than its maximum texture size,
 * repeating the top of the page below that point. That is 8192 device pixels
 * with the software renderer in the Docker image (16384 on many GPUs), so
 * captures stay under the smaller limit regardless of backend.
 */
export const MAX_SINGLE_DEVICE_PX = 8000;

/** Band height for the beyond-viewport fallback when tiling. */
export const MAX_TILE_DEVICE_PX = 4096;

const CHROME_CANDIDATES = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
];

const GlobalArgsSchema = z.object({
  backend: z.enum(["docker", "local"]).default("docker").describe(
    "Where Chrome runs: a fresh Docker container per capture, or a locally installed browser",
  ),
  image: z.string().regex(/^[a-z0-9][a-z0-9._\/:@-]*$/i).default(DEFAULT_IMAGE)
    .describe(
      "Docker image exposing the DevTools protocol on port 9222 (docker backend)",
    ),
  fonts: z.enum(["noto", "basic"]).default("noto").describe(
    "noto: layer Noto fonts (incl. emoji and CJK) onto the image, built locally once; basic: use the image as-is (docker backend)",
  ),
  dockerPath: z.string().default("docker").describe(
    "Docker CLI binary (docker backend); any docker-compatible CLI works",
  ),
  chromePath: z.string().optional().describe(
    "Path to a Chrome/Chromium binary (local backend). Defaults to $CHROME_PATH or the first common install location found.",
  ),
  viewportWidth: z.number().int().positive().default(1280).describe(
    "Browser viewport width in CSS pixels",
  ),
  viewportHeight: z.number().int().positive().default(800).describe(
    "Browser viewport height in CSS pixels (also the scroll step size)",
  ),
  deviceScaleFactor: z.number().int().min(1).max(4).default(1).describe(
    "Device pixel ratio (1-4); 2 produces a retina-resolution image",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const CaptureArgsSchema = z.object({
  url: z.string().url().refine((u) => /^https?:\/\//i.test(u), {
    message: "Only http and https URLs are supported",
  }).describe("URL of the page to screenshot (http or https)"),
  name: z.string().regex(/^[a-z0-9][a-z0-9-]*$/).refine(
    (n) => !n.endsWith("-capture"),
    { message: "Names ending in -capture are reserved for capture metadata" },
  ).optional().describe(
    "Data instance name for the PNG. Defaults to a slug of the URL host. Must not end in -capture.",
  ),
  scrollDelayMs: z.number().int().nonnegative().default(300).describe(
    "Pause after each scroll step to let lazy content load",
  ),
  settleMs: z.number().int().nonnegative().default(1000).describe(
    "Extra wait after scrolling back to the top (and hiding overlays), before capturing",
  ),
  maxHeight: z.number().int().positive().default(50000).describe(
    "Cap on captured page height in CSS pixels (guards against infinite scroll)",
  ),
  timeoutMs: z.number().int().positive().default(60000).describe(
    "Overall timeout for loading and capturing the page",
  ),
  hideFixed: z.boolean().default(true).describe(
    "Hide position:fixed overlays (cookie banners, chat widgets, pinned bars) and unstick sticky elements so they don't float mid-image",
  ),
  format: z.enum(["png", "jpeg", "webp"]).default("png").describe(
    "Image format. Only png supports pages taller than one capture; jpeg/webp are cut at the single-capture limit and marked truncated.",
  ),
  quality: z.number().int().min(1).max(100).default(80).describe(
    "Compression quality for jpeg and webp (ignored for png)",
  ),
  failOnHttpError: z.boolean().default(true).describe(
    "Fail without saving anything when the page responds with HTTP 4xx/5xx",
  ),
});
type CaptureArgs = z.infer<typeof CaptureArgsSchema>;

const CaptureSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  title: z.string(),
  width: z.number(),
  height: z.number(),
  truncated: z.boolean(),
  format: z.enum(["png", "jpeg", "webp"]),
  httpStatus: z.number().nullable(),
  tiles: z.number(),
  bytes: z.number(),
  capturedAt: z.string(),
  browserVersion: z.string(),
});

const CONTENT_TYPES = {
  png: "image/png",
  jpeg: "image/jpeg",
  webp: "image/webp",
} as const;

interface DataWriter {
  writeAll(content: Uint8Array): Promise<{ name: string }>;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: { message: string };
  sessionId?: string;
}

/** Minimal Chrome DevTools Protocol client over a browser-level WebSocket. */
class Cdp {
  #ws: WebSocket;
  #nextId = 1;
  #pending = new Map<
    number,
    {
      resolve: (r: Record<string, unknown>) => void;
      reject: (e: Error) => void;
    }
  >();
  #listeners: Array<(msg: CdpMessage) => void> = [];

  private constructor(ws: WebSocket) {
    this.#ws = ws;
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data as string) as CdpMessage;
      if (msg.id !== undefined) {
        const p = this.#pending.get(msg.id);
        if (!p) return;
        this.#pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message));
        else p.resolve(msg.result ?? {});
      } else {
        for (const l of this.#listeners) l(msg);
      }
    };
    ws.onclose = () => {
      for (const p of this.#pending.values()) {
        p.reject(new Error("DevTools connection closed"));
      }
      this.#pending.clear();
    };
  }

  static connect(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new Cdp(ws));
      ws.onerror = () =>
        reject(new Error(`Cannot connect to DevTools at ${url}`));
    });
  }

  send(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<Record<string, unknown>> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }

  /** Subscribes to every event; returns an unsubscribe function. */
  on(listener: (msg: CdpMessage) => void): () => void {
    this.#listeners.push(listener);
    return () => {
      this.#listeners = this.#listeners.filter((x) => x !== listener);
    };
  }

  waitFor(method: string, sessionId: string): Promise<CdpMessage> {
    return new Promise((resolve) => {
      const l = (msg: CdpMessage) => {
        if (msg.method === method && msg.sessionId === sessionId) {
          this.#listeners = this.#listeners.filter((x) => x !== l);
          resolve(msg);
        }
      };
      this.#listeners.push(l);
    });
  }

  close(): void {
    try {
      this.#ws.close();
    } catch {
      // already closed
    }
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch {
    return false;
  }
}

/**
 * Finds the browser binary. An explicit path (argument or $CHROME_PATH) must
 * exist; only when neither is set are the common install locations searched.
 */
export async function resolveChrome(
  configured?: string,
  envPath: string | undefined = Deno.env.get("CHROME_PATH"),
  candidates: string[] = CHROME_CANDIDATES,
): Promise<string> {
  const explicit = configured || envPath;
  if (explicit) {
    if (await isFile(explicit)) return explicit;
    throw new Error(
      `Chrome binary not found at ${explicit} (from ${
        configured ? "chromePath" : "$CHROME_PATH"
      })`,
    );
  }
  for (const p of candidates) {
    if (await isFile(p)) return p;
  }
  throw new Error(
    "No Chrome/Chromium binary found. Set the chromePath global argument or $CHROME_PATH.",
  );
}

/** A running browser: where to connect, and how to tear it down. */
export interface LaunchedBrowser {
  wsUrl: string;
  description: string;
  close(): Promise<void>;
}

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitForDevToolsFile(
  userDataDir: string,
  signal: AbortSignal,
): Promise<string> {
  const file = `${userDataDir}/DevToolsActivePort`;
  while (!signal.aborted) {
    try {
      const [port, path] = (await Deno.readTextFile(file)).trim().split("\n");
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    } catch {
      // not written yet
    }
    await sleep(100);
  }
  throw new Error("Timed out waiting for Chrome to start");
}

async function launchLocal(
  g: GlobalArgs,
  signal: AbortSignal,
): Promise<LaunchedBrowser> {
  const chrome = await resolveChrome(g.chromePath);
  const userDataDir = await Deno.makeTempDir({ prefix: "webshot-" });
  // swamp-quality-ignore deno-command: launches the headless browser (local backend); fixed argument list, see README What it runs
  const proc = new Deno.Command(chrome, {
    args: [
      "--headless=new",
      "--remote-debugging-port=0",
      `--user-data-dir=${userDataDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--hide-scrollbars",
      "--mute-audio",
      `--window-size=${g.viewportWidth},${g.viewportHeight}`,
      "about:blank",
    ],
    stdout: "null",
    stderr: "null",
  }).spawn();
  const close = async () => {
    try {
      proc.kill("SIGKILL");
    } catch {
      // already exited
    }
    await proc.status;
    await Deno.remove(userDataDir, { recursive: true }).catch(() => {});
  };
  try {
    return {
      wsUrl: await waitForDevToolsFile(userDataDir, signal),
      description: chrome,
      close,
    };
  } catch (err) {
    await close();
    throw err;
  }
}

async function docker(
  g: GlobalArgs,
  args: string[],
  input?: string,
): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  let out: Deno.CommandOutput;
  try {
    // swamp-quality-ignore deno-command: runs the docker CLI (docker backend); fixed argument lists, see README What it runs
    const proc = new Deno.Command(g.dockerPath, {
      args,
      stdin: input === undefined ? "null" : "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    if (input !== undefined) {
      const w = proc.stdin.getWriter();
      await w.write(new TextEncoder().encode(input));
      await w.close();
    }
    out = await proc.output();
  } catch (err) {
    throw new Error(
      `Cannot run ${g.dockerPath}: ${
        (err as Error).message
      }. Is Docker installed?`,
    );
  }
  const dec = new TextDecoder();
  return {
    ok: out.success,
    stdout: dec.decode(out.stdout).trim(),
    stderr: dec.decode(out.stderr).trim(),
  };
}

/** Local tag for the base image with Noto fonts layered on. */
export function notoImageTag(base: string): string {
  return `webshot-noto:${base.replace(/[^A-Za-z0-9_.-]/g, "-").slice(0, 128)}`;
}

/** Dockerfile (fed to `docker build -` on stdin) that adds Noto fonts. */
export function notoDockerfile(base: string): string {
  return [
    `FROM ${base}`,
    "RUN apt-get update \\",
    `  && apt-get install -y --no-install-recommends ${
      NOTO_PACKAGES.join(" ")
    } \\`,
    "  && rm -rf /var/lib/apt/lists/*",
    "",
  ].join("\n");
}

async function ensureImage(g: GlobalArgs, logger: Logger): Promise<string> {
  if (!(await docker(g, ["image", "inspect", g.image])).ok) {
    logger.info("Pulling {image}", { image: g.image });
    const pull = await docker(g, ["pull", g.image]);
    if (!pull.ok) {
      throw new Error(`docker pull ${g.image} failed: ${pull.stderr}`);
    }
  }
  if (g.fonts === "basic") return g.image;

  const tag = notoImageTag(g.image);
  if (!(await docker(g, ["image", "inspect", tag])).ok) {
    logger.info("Building {tag} with Noto fonts (one-time, ~150 MB)", { tag });
    const build = await docker(g, [
      "build",
      "--tag",
      tag,
      "--label",
      `webshot.base=${g.image}`,
      "-",
    ], notoDockerfile(g.image));
    if (!build.ok) {
      throw new Error(`Building font image ${tag} failed: ${build.stderr}`);
    }
  }
  return tag;
}

/** Parses `docker port` output, preferring the IPv4 loopback mapping. */
export function parseDockerPort(output: string): number {
  const lines = output.split("\n").map((l) => l.trim()).filter(Boolean);
  const line = lines.find((l) => l.startsWith("127.0.0.1:")) ?? lines[0];
  const port = Number(line?.slice(line.lastIndexOf(":") + 1));
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`Unexpected docker port output: ${output}`);
  }
  return port;
}

async function launchDocker(
  g: GlobalArgs,
  image: string,
  signal: AbortSignal,
): Promise<LaunchedBrowser> {
  const run = await docker(g, [
    "run",
    "--detach",
    "--rm",
    "--label",
    "webshot=1",
    "--publish",
    "127.0.0.1::9222",
    "--shm-size",
    "1g",
    "--add-host",
    "host.docker.internal:host-gateway",
    image,
    "--hide-scrollbars",
    "--mute-audio",
    `--window-size=${g.viewportWidth},${g.viewportHeight}`,
  ]);
  if (!run.ok) {
    throw new Error(`docker run ${image} failed: ${run.stderr}`);
  }
  const id = run.stdout.split("\n").pop()!;
  const close = async () => {
    await docker(g, ["rm", "--force", id]).catch(() => {});
  };

  try {
    const mapping = await docker(g, ["port", id, "9222/tcp"]);
    if (!mapping.ok) {
      throw new Error(`docker port failed: ${mapping.stderr}`);
    }
    const port = parseDockerPort(mapping.stdout);
    while (!signal.aborted) {
      try {
        const res = await fetch(`http://127.0.0.1:${port}/json/version`, {
          signal,
        });
        if (res.ok) {
          const info = await res.json() as { webSocketDebuggerUrl?: string };
          if (info.webSocketDebuggerUrl) {
            // Address the published port, whatever host Chrome reports.
            const path = new URL(info.webSocketDebuggerUrl).pathname;
            return {
              wsUrl: `ws://127.0.0.1:${port}${path}`,
              description: `container ${id.slice(0, 12)} (${image})`,
              close,
            };
          }
        } else {
          await res.body?.cancel();
        }
      } catch {
        // not listening yet
      }
      await sleep(100);
    }
    throw new Error(`Timed out waiting for Chrome in container ${id}`);
  } catch (err) {
    await close();
    throw err;
  }
}

function withTimeout<T>(
  p: Promise<T>,
  signal: AbortSignal,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error(`Timed out: ${what}`));
    const onAbort = () => reject(new Error(`Timed out: ${what}`));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() =>
      signal.removeEventListener("abort", onAbort)
    );
  });
}

// Runs in the page: scroll down one viewport at a time until the bottom is
// reached and the document stops growing, then return to the top. Smooth
// scrolling is switched off first so every scroll lands immediately.
const SCROLL_SCRIPT = `(async (delay, maxHeight) => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const style = document.createElement("style");
  style.textContent = "html, body { scroll-behavior: auto !important; }";
  (document.head || document.documentElement).appendChild(style);
  const docHeight = () => Math.max(
    document.body ? document.body.scrollHeight : 0,
    document.documentElement.scrollHeight,
  );
  let stable = 0;
  for (let i = 0; i < 1000; i++) {
    const before = docHeight();
    window.scrollBy({ top: window.innerHeight, behavior: "instant" });
    await sleep(delay);
    const after = docHeight();
    const atBottom = window.scrollY + window.innerHeight >= after - 2;
    if (window.scrollY >= maxHeight) break;
    if (atBottom && after === before) {
      if (++stable >= 2) break;
    } else {
      stable = 0;
    }
  }
  window.scrollTo({ top: 0, behavior: "instant" });
  await sleep(delay);
  return docHeight();
})`;

/**
 * Runs in the page: jump to `y`, wait two frames for paint, and report where
 * the window actually is and how far it can scroll.
 */
export function scrollToTileScript(y: number): string {
  return `new Promise((r) => {
    window.scrollTo({ top: ${y}, behavior: "instant" });
    requestAnimationFrame(() => requestAnimationFrame(() => r({
      y: window.scrollY,
      max: document.documentElement.scrollHeight - window.innerHeight,
    })));
  })`;
}

// Runs in the page: a single full-page capture renders position:fixed elements
// wherever they sat in the viewport, so hide them. Sticky elements are put back
// in normal flow so they appear once at their natural position.
const HIDE_FIXED_SCRIPT = `(() => {
  let hidden = 0, unstuck = 0;
  for (const el of document.querySelectorAll("body *")) {
    const pos = getComputedStyle(el).position;
    if (pos === "fixed") {
      el.style.setProperty("display", "none", "important");
      hidden++;
    } else if (pos === "sticky" || pos === "-webkit-sticky") {
      el.style.setProperty("position", "static", "important");
      unstuck++;
    }
  }
  return { hidden, unstuck };
})()`;

/** Decodes a base64 string (as returned by CDP) into raw bytes. */
export function decodeBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Derives a default data name from a URL host, e.g. `www.example.com` becomes `www-example-com`. */
export function slugFromUrl(url: string): string {
  const slug = new URL(url).hostname.toLowerCase().replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (!slug) return "page";
  // "-capture" names are reserved for the metadata resource.
  return slug.endsWith("-capture") ? `${slug}-page` : slug;
}

/** One clipped capture: a vertical band of the page in CSS pixels. */
export interface Tile {
  y: number;
  height: number;
}

/**
 * How a page is captured:
 * - `single`: one beyond-viewport capture (fits under Chrome's limit).
 * - `scroll`: scroll one viewport at a time and capture what is visible. Fast,
 *   and layout (e.g. `100vh`) matches what a visitor sees, but fixed elements
 *   would repeat in every tile, so it requires `hideFixed`.
 * - `beyond`: beyond-viewport captures in large bands. Faithful with fixed
 *   elements, but Chrome re-renders the whole page per band, so it is slow.
 */
export type CaptureMode = "single" | "scroll" | "beyond";

/**
 * Plans the captures for a page of `height` CSS pixels. Only PNG can be
 * stitched; JPEG and WebP (which is limited to 16383 pixels) are cut to a
 * single capture.
 */
export function planCapture(opts: {
  height: number;
  deviceScaleFactor: number;
  viewportHeight: number;
  format: "png" | "jpeg" | "webp";
  hideFixed: boolean;
}): { mode: CaptureMode; height: number; cutByFormat: boolean; tiles: Tile[] } {
  const { deviceScaleFactor: dsf, format } = opts;
  const singleLimit = Math.floor(MAX_SINGLE_DEVICE_PX / dsf);
  if (opts.height <= singleLimit || format !== "png") {
    const h = format === "png"
      ? opts.height
      : Math.min(opts.height, Math.floor(16383 / dsf), singleLimit);
    return {
      mode: "single",
      height: h,
      cutByFormat: h < opts.height,
      tiles: [{ y: 0, height: h }],
    };
  }
  const mode: CaptureMode = opts.hideFixed ? "scroll" : "beyond";
  const step = mode === "scroll"
    ? Math.min(opts.viewportHeight, Math.floor(MAX_TILE_DEVICE_PX / dsf))
    : Math.floor(MAX_TILE_DEVICE_PX / dsf);
  const tiles: Tile[] = [];
  for (let y = 0; y < opts.height; y += step) {
    tiles.push({ y, height: Math.min(step, opts.height - y) });
  }
  return { mode, height: opts.height, cutByFormat: false, tiles };
}

/**
 * The `@taylor/webshot` model type. Its `capture` method loads a URL in headless
 * Chrome, scrolls to the bottom, and stores a full-page screenshot
 * (`screenshot` file, PNG/JPEG/WebP) plus capture metadata (`capture`
 * resource).
 */
export const model = {
  type: "@taylor/webshot",
  version: "2026.10.11.1",
  globalArguments: GlobalArgsSchema,
  files: {
    screenshot: {
      description: "Full-page screenshot (PNG by default; JPEG or WebP)",
      contentType: "image/png",
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  resources: {
    capture: {
      description: "Metadata about the captured screenshot",
      schema: CaptureSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    capture: {
      description:
        "Load a URL in headless Chrome, scroll to the bottom to trigger lazy content, and save a full-page screenshot",
      arguments: CaptureArgsSchema,
      execute: async (
        // `_launchBrowser` lets tests supply a fake browser. swamp rejects
        // method inputs that are not in the schema, so it cannot be set from
        // the CLI or a workflow.
        args: CaptureArgs & {
          _launchBrowser?: () => Promise<LaunchedBrowser>;
        },
        context: {
          globalArgs: GlobalArgs;
          signal?: AbortSignal;
          logger: Logger;
          createFileWriter: (
            specName: string,
            name: string,
            overrides?: { contentType?: string },
          ) => DataWriter;
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const g = context.globalArgs;
        const name = args.name ?? slugFromUrl(args.url);
        const withAbort = (ms: number) =>
          context.signal
            ? AbortSignal.any([context.signal, AbortSignal.timeout(ms)])
            : AbortSignal.timeout(ms);

        // Image pulls and the one-time font build are not bounded by any
        // timeout; only browser startup (30s) and the capture (timeoutMs) are.
        const browser = args._launchBrowser
          ? await args._launchBrowser()
          : g.backend === "docker"
          ? await launchDocker(
            g,
            await ensureImage(g, context.logger),
            withAbort(30000),
          )
          : await launchLocal(g, withAbort(30000));
        const signal = withAbort(args.timeoutMs);

        let cdp: Cdp | undefined;
        try {
          context.logger.info("Started Chrome: {browser}", {
            browser: browser.description,
          });
          cdp = await Cdp.connect(browser.wsUrl);
          const { product } = await cdp.send("Browser.getVersion") as {
            product: string;
          };

          const { targetId } = await cdp.send("Target.createTarget", {
            url: "about:blank",
          });
          const { sessionId } = await cdp.send("Target.attachToTarget", {
            targetId,
            flatten: true,
          }) as { sessionId: string };
          const s = (method: string, params: Record<string, unknown> = {}) =>
            cdp!.send(method, params, sessionId);
          const evaluate = async <T>(
            expression: string,
            what: string,
          ): Promise<T> => {
            const res = await withTimeout(
              s("Runtime.evaluate", {
                expression,
                awaitPromise: true,
                returnByValue: true,
              }),
              signal,
              what,
            ) as {
              result?: { value?: T };
              exceptionDetails?: {
                text: string;
                exception?: { description?: string };
              };
            };
            if (res.exceptionDetails) {
              const d = res.exceptionDetails;
              throw new Error(
                `Page script failed while ${what}: ${
                  d.exception?.description ?? d.text
                }`,
              );
            }
            return res.result?.value as T;
          };

          await s("Page.enable");
          // Track the main frame's document response for its HTTP status.
          // Redirects arrive as requestWillBeSent, so the last
          // responseReceived is the final document.
          await s("Network.enable");
          let httpStatus: number | null = null;
          const stopListening = cdp.on((msg) => {
            const p = msg.params as
              | {
                type?: string;
                frameId?: string;
                response?: { status?: number };
              }
              | undefined;
            if (
              msg.method === "Network.responseReceived" &&
              msg.sessionId === sessionId && p?.type === "Document" &&
              p.frameId === targetId && typeof p.response?.status === "number"
            ) {
              httpStatus = p.response.status;
            }
          });
          await s("Emulation.setDeviceMetricsOverride", {
            width: g.viewportWidth,
            height: g.viewportHeight,
            deviceScaleFactor: g.deviceScaleFactor,
            mobile: false,
          });

          context.logger.info("Loading {url}", { url: args.url });
          const loaded = cdp.waitFor("Page.loadEventFired", sessionId);
          const nav = await s("Page.navigate", { url: args.url });
          if (nav.errorText) {
            throw new Error(
              `Navigation to ${args.url} failed: ${nav.errorText}`,
            );
          }
          await withTimeout(loaded, signal, `loading ${args.url}`);
          stopListening();
          const status = httpStatus as number | null;
          context.logger.info("Page loaded with HTTP {status}", {
            status: status ?? "unknown",
          });
          if (args.failOnHttpError && status !== null && status >= 400) {
            throw new Error(
              `${args.url} responded with HTTP ${status}; nothing was saved (set failOnHttpError=false to capture error pages)`,
            );
          }

          context.logger.info("Scrolling to the bottom of the page");
          await evaluate<number>(
            `${SCROLL_SCRIPT}(${args.scrollDelayMs}, ${args.maxHeight})`,
            "scrolling page",
          );
          if (args.hideFixed) {
            const counts = await evaluate<{ hidden: number; unstuck: number }>(
              HIDE_FIXED_SCRIPT,
              "hiding fixed elements",
            );
            context.logger.info(
              "Hid {hidden} fixed and unstuck {unstuck} sticky elements",
              counts,
            );
          }
          await new Promise((r) => setTimeout(r, args.settleMs));

          const metrics = await s("Page.getLayoutMetrics") as {
            cssContentSize: { width: number; height: number };
          };
          const fullHeight = Math.ceil(metrics.cssContentSize.height);
          const width = Math.max(
            g.viewportWidth,
            Math.ceil(metrics.cssContentSize.width),
          );
          const plan = planCapture({
            height: Math.min(fullHeight, args.maxHeight),
            deviceScaleFactor: g.deviceScaleFactor,
            viewportHeight: g.viewportHeight,
            format: args.format,
            hideFixed: args.hideFixed,
          });
          const height = plan.height;
          if (plan.cutByFormat) {
            context.logger.info(
              "{format} output is limited to {height} CSS px at this scale; use png for the full page",
              { format: args.format, height },
            );
          }

          const page = await evaluate<{ title: string; url: string }>(
            "({ title: document.title, url: location.href })",
            "reading page info",
          );

          // Returns null when a scroll did not land where expected (a custom
          // scroll container or scroll-hijacking script), since capturing the
          // viewport would then record the wrong part of the page.
          const captureTiles = async (
            current: ReturnType<typeof planCapture>,
          ): Promise<Uint8Array[] | null> => {
            context.logger.info(
              "Capturing {width}x{height} as {format} in {tiles} tile(s) ({mode})",
              {
                width,
                height,
                format: args.format,
                tiles: current.tiles.length,
                mode: current.mode,
              },
            );
            const out: Uint8Array[] = [];
            for (const tile of current.tiles) {
              if (current.mode === "scroll") {
                const pos = await evaluate<{ y: number; max: number }>(
                  scrollToTileScript(tile.y),
                  "scrolling to tile",
                );
                const expected = Math.min(tile.y, Math.max(pos.max, 0));
                if (Math.abs(pos.y - expected) > 1) {
                  context.logger.info(
                    "Scrolling to {expected} landed at {actual}; falling back to beyond-viewport capture",
                    { expected, actual: pos.y },
                  );
                  return null;
                }
              }
              const shot = await withTimeout(
                s("Page.captureScreenshot", {
                  format: args.format,
                  ...(args.format === "png" ? {} : { quality: args.quality }),
                  captureBeyondViewport: current.mode !== "scroll",
                  clip: {
                    x: 0,
                    y: tile.y,
                    width,
                    height: tile.height,
                    scale: 1,
                  },
                }),
                signal,
                "capturing screenshot",
              ) as { data: string };
              out.push(decodeBase64(shot.data));
            }
            return out;
          };

          let usedPlan = plan;
          let parts = await captureTiles(plan);
          if (!parts) {
            usedPlan = planCapture({
              height,
              deviceScaleFactor: g.deviceScaleFactor,
              viewportHeight: g.viewportHeight,
              format: args.format,
              hideFixed: false,
            });
            parts = (await captureTiles(usedPlan))!;
          }
          const image = parts.length === 1 ? parts[0] : await stitchPngs(parts);

          const fileHandle = await context.createFileWriter(
            "screenshot",
            name,
            {
              contentType: CONTENT_TYPES[args.format],
            },
          ).writeAll(image);
          const metaHandle = await context.writeResource(
            "capture",
            `${name}-capture`,
            {
              url: args.url,
              finalUrl: page.url,
              title: page.title,
              width,
              height,
              truncated: fullHeight > height,
              format: args.format,
              httpStatus: status,
              tiles: usedPlan.tiles.length,
              bytes: image.length,
              capturedAt: new Date().toISOString(),
              browserVersion: product,
            },
          );
          context.logger.info("Saved {bytes} byte {format} as {name}", {
            bytes: image.length,
            format: args.format,
            name,
          });
          return { dataHandles: [fileHandle, metaHandle] };
        } finally {
          try {
            await cdp?.send("Browser.close");
          } catch {
            // browser already gone
          }
          cdp?.close();
          await browser.close();
        }
      },
    },
  },
};
