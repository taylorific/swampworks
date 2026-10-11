// End-to-end tests of the `capture` method against a fake browser: a local
// WebSocket server that speaks the subset of the Chrome DevTools Protocol the
// model uses. Screenshots are generated PNGs whose rows encode their absolute
// page position, so stitched output can be checked row by row.

import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import { type LaunchedBrowser, model } from "./webshot.ts";
import { parsePng } from "./_lib/png.ts";

type CaptureContext = Parameters<typeof model.methods.capture.execute>[1];

interface FakePage {
  status?: number;
  navigateError?: string;
  height?: number;
  width?: number;
  title?: string;
  finalUrl?: string;
  /** Throw from this in-page script ("scroll", "hide", "info"). */
  scriptError?: "scroll" | "hide" | "info";
  /** The window never scrolls (content lives in a custom scroll container). */
  stuckScroll?: boolean;
}

interface CdpCall {
  method: string;
  params: Record<string, unknown>;
}

const TARGET = "TARGET-1";
const SESSION = "SESSION-1";

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/**
 * An RGB PNG for the page band [y, y + height): every pixel of page row r is
 * (r & 0xff, r >> 8 & 0xff, r >> 16 & 0xff).
 */
async function bandPng(width: number, y: number, height: number) {
  const stride = 1 + width * 3;
  const raw = new Uint8Array(stride * height);
  for (let r = 0; r < height; r++) {
    const abs = y + r;
    for (let x = 0; x < width; x++) {
      const o = r * stride + 1 + x * 3;
      raw[o] = abs & 0xff;
      raw[o + 1] = (abs >> 8) & 0xff;
      raw[o + 2] = (abs >> 16) & 0xff;
    }
  }
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, height);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(raw)),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** Returns the absolute page row encoded in each row of a captured PNG. */
async function decodeRows(png: Uint8Array): Promise<number[]> {
  const { header, idat } = parsePng(png);
  const stream = new Blob(idat as BlobPart[]).stream()
    .pipeThrough(new DecompressionStream("deflate"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = 1 + header.width * 3;
  const rows: number[] = [];
  for (let r = 0; r < header.height; r++) {
    // Fake tiles and stitched output only use filter type 0.
    assertEquals(raw[r * stride], 0, `row ${r} filter`);
    const o = r * stride + 1;
    rows.push(raw[o] | (raw[o + 1] << 8) | (raw[o + 2] << 16));
  }
  return rows;
}

/** Starts a fake DevTools endpoint serving one page. */
function fakeBrowser(page: FakePage = {}) {
  const calls: CdpCall[] = [];
  let closed = false;
  const height = page.height ?? 3000;
  const width = page.width ?? 16;
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", onListen: () => {} },
    (req) => {
      const { socket, response } = Deno.upgradeWebSocket(req);
      const send = (msg: unknown) => socket.send(JSON.stringify(msg));
      socket.onmessage = async (ev) => {
        const { id, method, params = {} } = JSON.parse(ev.data);
        calls.push({ method, params });
        const reply = (result: unknown) => send({ id, result });
        const event = (m: string, p: unknown) =>
          send({ method: m, params: p, sessionId: SESSION });
        switch (method) {
          case "Browser.getVersion":
            return reply({ product: "FakeChrome/1.0" });
          case "Target.createTarget":
            return reply({ targetId: TARGET });
          case "Target.attachToTarget":
            return reply({ sessionId: SESSION });
          case "Page.navigate":
            if (page.navigateError) {
              return reply({ frameId: TARGET, errorText: page.navigateError });
            }
            // A redirect-like response for another frame must be ignored.
            event("Network.responseReceived", {
              type: "Document",
              frameId: "IFRAME",
              response: { status: 500 },
            });
            event("Network.responseReceived", {
              type: "Document",
              frameId: TARGET,
              response: { status: page.status ?? 200 },
            });
            reply({ frameId: TARGET });
            return event("Page.loadEventFired", {});
          case "Runtime.evaluate": {
            const expr = String(params.expression);
            const kind = expr.includes("scrollBy")
              ? "scroll"
              : expr.includes("getComputedStyle")
              ? "hide"
              : expr.includes("document.title")
              ? "info"
              : "tile";
            if (page.scriptError === kind) {
              return reply({
                result: {},
                exceptionDetails: {
                  text: "Uncaught",
                  exception: { description: `TypeError: boom in ${kind}` },
                },
              });
            }
            const max = height - 800;
            const top = Number(/top: (\d+)/.exec(expr)?.[1] ?? 0);
            const value = kind === "scroll"
              ? height
              : kind === "hide"
              ? { hidden: 2, unstuck: 1 }
              : kind === "info"
              ? {
                title: page.title ?? "Fake Page",
                url: page.finalUrl ?? "https://example.com/final",
              }
              : { y: page.stuckScroll ? 0 : Math.min(top, max), max };
            return reply({ result: { value } });
          }
          case "Page.getLayoutMetrics":
            return reply({ cssContentSize: { width, height } });
          case "Page.captureScreenshot": {
            const clip = params.clip as {
              x: number;
              y: number;
              width: number;
              height: number;
            };
            if (params.format !== "png") {
              return reply({ data: btoa(`fake-${params.format}`) });
            }
            const png = await bandPng(clip.width, clip.y, clip.height);
            return reply({ data: toBase64(png) });
          }
          default:
            return reply({});
        }
      };
      return response;
    },
  );
  const launch = (): Promise<LaunchedBrowser> =>
    Promise.resolve({
      wsUrl: `ws://127.0.0.1:${server.addr.port}/devtools/browser/fake`,
      description: "fake browser",
      close: () => {
        closed = true;
        return Promise.resolve();
      },
    });
  return {
    calls,
    launch,
    isClosed: () => closed,
    stop: () => server.shutdown(),
  };
}

function runCapture(
  page: FakePage,
  argOverrides: Record<string, unknown> = {},
  globalOverrides: Record<string, unknown> = {},
) {
  const fake = fakeBrowser(page);
  const fileOverrides: Array<{ contentType?: string } | undefined> = [];
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      viewportWidth: 16,
      viewportHeight: 800,
      ...globalOverrides,
    }),
    methodName: "capture",
  });
  const context = test.context as unknown as CaptureContext;
  const createFileWriter = context.createFileWriter;
  context.createFileWriter = (spec, name, overrides) => {
    fileOverrides.push(overrides);
    return createFileWriter(spec, name, overrides);
  };
  const args = {
    ...model.methods.capture.arguments.parse({
      url: "https://example.com/page",
      scrollDelayMs: 0,
      settleMs: 0,
      ...argOverrides,
    }),
    _launchBrowser: fake.launch,
  };
  const run = () => model.methods.capture.execute(args, context);
  return { fake, test, run, fileOverrides };
}

/** The y positions of the per-tile scrolls, in order. */
function tileScrolls(calls: CdpCall[]): number[] {
  return calls
    .map((c) => String(c.params.expression ?? ""))
    .filter((e) => e.includes("requestAnimationFrame") && e.includes("max:"))
    .map((e) => Number(/top: (\d+)/.exec(e)![1]));
}

function screenshotCalls(calls: CdpCall[]) {
  return calls.filter((c) => c.method === "Page.captureScreenshot")
    .map((c) => c.params);
}

function written(test: ReturnType<typeof createModelTestContext>) {
  const files = test.getWrittenFiles();
  const resources = test.getWrittenResources();
  return {
    files,
    resources,
    meta: resources[0]?.data as Record<string, unknown> | undefined,
  };
}

Deno.test("capture: short page is one beyond-viewport capture with full metadata", async () => {
  const { fake, test, run, fileOverrides } = runCapture({
    height: 3000,
    title: "Hello",
  });
  try {
    const result = await run();
    const { files, resources, meta } = written(test);

    assertEquals(files.length, 1);
    assertEquals(files[0].specName, "screenshot");
    assertEquals(files[0].name, "example-com");
    assertEquals(fileOverrides[0]?.contentType, "image/png");
    assertEquals(resources.length, 1);
    assertEquals(resources[0].specName, "capture");
    assertEquals(resources[0].name, "example-com-capture");
    assertEquals(result.dataHandles.length, 2);

    const png = files[0].content as Uint8Array;
    assertEquals(parsePng(png).header.height, 3000);
    const rows = await decodeRows(png);
    assertEquals(rows, Array.from({ length: 3000 }, (_, i) => i));

    assertEquals(meta, {
      url: "https://example.com/page",
      finalUrl: "https://example.com/final",
      title: "Hello",
      width: 16,
      height: 3000,
      truncated: false,
      format: "png",
      httpStatus: 200,
      tiles: 1,
      bytes: png.length,
      capturedAt: meta!.capturedAt,
      browserVersion: "FakeChrome/1.0",
    });

    const shots = screenshotCalls(fake.calls);
    assertEquals(shots.length, 1);
    assertEquals(shots[0].captureBeyondViewport, true);
    assertEquals(shots[0].clip, {
      x: 0,
      y: 0,
      width: 16,
      height: 3000,
      scale: 1,
    });
    assert(fake.calls.some((c) => c.method === "Browser.close"));
    assert(fake.isClosed(), "browser torn down");
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: tall page scrolls in viewport tiles and stitches every row in order", async () => {
  const { fake, test, run } = runCapture({ height: 20500 }, {
    maxHeight: 100000,
  });
  try {
    await run();
    const { files, meta } = written(test);
    const rows = await decodeRows(files[0].content as Uint8Array);
    assertEquals(rows.length, 20500);
    assertEquals(rows, Array.from({ length: 20500 }, (_, i) => i));
    assertEquals(meta?.tiles, 26);
    assertEquals(meta?.truncated, false);

    const shots = screenshotCalls(fake.calls);
    assertEquals(shots.length, 26);
    assert(shots.every((s) => s.captureBeyondViewport === false));
    const scrolls = tileScrolls(fake.calls);
    assertEquals(scrolls, Array.from({ length: 26 }, (_, i) => i * 800));
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: tall page without hideFixed uses beyond-viewport bands", async () => {
  const { fake, test, run } = runCapture(
    { height: 20000 },
    { hideFixed: false },
  );
  try {
    await run();
    const rows = await decodeRows(written(test).files[0].content as Uint8Array);
    assertEquals(rows, Array.from({ length: 20000 }, (_, i) => i));
    const shots = screenshotCalls(fake.calls);
    assertEquals(
      shots.map((s) => (s.clip as { height: number }).height),
      [4096, 4096, 4096, 4096, 3616],
    );
    assert(shots.every((s) => s.captureBeyondViewport === true));
    assert(
      !fake.calls.some((c) =>
        String(c.params.expression ?? "").includes("getComputedStyle")
      ),
      "fixed elements were not touched",
    );
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: maxHeight cuts the page and marks it truncated", async () => {
  const { fake, test, run } = runCapture({ height: 5000 }, {
    maxHeight: 1200,
  });
  try {
    await run();
    const { files, meta } = written(test);
    assertEquals(parsePng(files[0].content as Uint8Array).header.height, 1200);
    assertEquals(meta?.truncated, true);
    assertEquals(meta?.height, 1200);
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: jpeg passes quality, sets the content type, and is cut to one capture", async () => {
  const { fake, test, run, fileOverrides } = runCapture(
    { height: 40000 },
    { format: "jpeg", quality: 55 },
  );
  try {
    await run();
    const { files, meta } = written(test);
    assertEquals(fileOverrides[0]?.contentType, "image/jpeg");
    assertEquals(
      new TextDecoder().decode(files[0].content as Uint8Array),
      "fake-jpeg",
    );
    const shots = screenshotCalls(fake.calls);
    assertEquals(shots.length, 1);
    assertEquals(shots[0].format, "jpeg");
    assertEquals(shots[0].quality, 55);
    assertEquals(meta?.height, 8000);
    assertEquals(meta?.truncated, true);
    assertEquals(meta?.format, "jpeg");
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: HTTP errors fail before writing, unless allowed", async () => {
  const failing = runCapture({ status: 404 });
  try {
    await assertRejects(failing.run, Error, "responded with HTTP 404");
    assertEquals(written(failing.test).files.length, 0);
    assertEquals(written(failing.test).resources.length, 0);
    assert(failing.fake.isClosed(), "browser torn down after failure");
  } finally {
    await failing.fake.stop();
  }

  const allowed = runCapture({ status: 503 }, { failOnHttpError: false });
  try {
    await allowed.run();
    assertEquals(written(allowed.test).meta?.httpStatus, 503);
  } finally {
    await allowed.fake.stop();
  }
});

Deno.test("capture: navigation errors fail before writing", async () => {
  const { fake, test, run } = runCapture({
    navigateError: "net::ERR_NAME_NOT_RESOLVED",
  });
  try {
    await assertRejects(run, Error, "net::ERR_NAME_NOT_RESOLVED");
    assertEquals(written(test).files.length, 0);
    assert(fake.isClosed());
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: page script exceptions fail before writing", async () => {
  for (const scriptError of ["scroll", "hide", "info"] as const) {
    const { fake, test, run } = runCapture({ scriptError });
    try {
      await assertRejects(run, Error, `TypeError: boom in ${scriptError}`);
      assertEquals(written(test).files.length, 0, scriptError);
      assert(fake.isClosed(), scriptError);
    } finally {
      await fake.stop();
    }
  }
});

Deno.test("capture: deviceScaleFactor is applied to the viewport", async () => {
  const { fake, run } = runCapture({ height: 1000 }, {}, {
    deviceScaleFactor: 2,
  });
  try {
    await run();
    const metrics = fake.calls.find((c) =>
      c.method === "Emulation.setDeviceMetricsOverride"
    );
    assertEquals(metrics?.params.deviceScaleFactor, 2);
    assertEquals(metrics?.params.width, 16);
    assertEquals(metrics?.params.height, 800);
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: smooth scrolling is switched off before scrolling", async () => {
  const { fake, run } = runCapture({ height: 3000 });
  try {
    await run();
    const scrollScript = fake.calls.map((c) =>
      String(c.params.expression ?? "")
    )
      .find((e) => e.includes("scrollBy"));
    assert(scrollScript?.includes("scroll-behavior: auto !important"));
    assert(scrollScript?.includes('behavior: "instant"'));
  } finally {
    await fake.stop();
  }
});

Deno.test("capture: falls back to beyond-viewport bands when the window does not scroll", async () => {
  const { fake, test, run } = runCapture({ height: 20000, stuckScroll: true });
  try {
    await run();
    const { files, meta } = written(test);
    const rows = await decodeRows(files[0].content as Uint8Array);
    assertEquals(rows, Array.from({ length: 20000 }, (_, i) => i));
    assertEquals(meta?.tiles, 5);

    // The first tile (y=0) lands, the second does not: then it switches.
    assertEquals(tileScrolls(fake.calls), [0, 800]);
    const shots = screenshotCalls(fake.calls);
    assertEquals(shots[0].captureBeyondViewport, false);
    const fallback = shots.slice(1);
    assertEquals(
      fallback.map((s) => (s.clip as { height: number }).height),
      [4096, 4096, 4096, 4096, 3616],
    );
    assert(fallback.every((s) => s.captureBeyondViewport === true));
  } finally {
    await fake.stop();
  }
});
