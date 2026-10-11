// Docker smoke test: runs real `capture` calls against headless Chrome in
// Docker (the default backend) and checks the output pixel by pixel.
//
// The pages are served from this process. Each is a full-viewport red hero
// (height: 100vh) followed by 100px blocks of distinct solid colours, so the
// test can tell exactly which part of the page every row of the PNG came from:
// a wrong tile order, a gap, a repeated top (Chrome's single-capture wrap,
// 8192px with the container's software renderer), a hero
// stretched by a resized viewport, or blank tiles from smooth scrolling all
// show up as a colour mismatch.
//
// Usage: deno run -A ci/smoke.ts [output-dir]

import { model } from "../extensions/models/webshot.ts";
import { parsePng } from "../extensions/models/_lib/png.ts";

const OUT = Deno.args[0] ?? "smoke-output";
const PORT = 8765;
const VIEWPORT = { width: 640, height: 800 };
const BLOCK = 100;

function blockColor(i: number): [number, number, number] {
  return [(i * 37) % 256, (i * 91) % 256, 200];
}

function page(blocks: number, smooth: boolean): string {
  const divs = Array.from({ length: blocks }, (_, i) => {
    const [r, g, b] = blockColor(i);
    return `<div style="height:${BLOCK}px;background:rgb(${r},${g},${b})"></div>`;
  }).join("");
  return `<!doctype html><html style="${
    smooth ? "scroll-behavior:smooth" : ""
  }"><head><title>smoke ${blocks}</title></head>
<body style="margin:0"><div style="height:100vh;background:#f00"></div>${divs}</body></html>`;
}

const server = Deno.serve(
  { port: PORT, hostname: "0.0.0.0", onListen: () => {} },
  (req) => {
    const url = new URL(req.url);
    if (url.pathname !== "/blocks") {
      return new Response("not found", { status: 404 });
    }
    const blocks = Number(url.searchParams.get("blocks") ?? "20");
    const smooth = url.searchParams.has("smooth");
    return new Response(page(blocks, smooth), {
      headers: { "content-type": "text/html" },
    });
  },
);

/** Decodes an 8-bit RGB/RGBA PNG into rows of [r, g, b] at column `x`. */
async function columnColors(png: Uint8Array, x: number) {
  const { header, idat } = parsePng(png);
  const bpp = header.colorType === 6 ? 4 : 3;
  const stride = header.width * bpp;
  const raw = new Uint8Array(
    await new Response(
      new Blob(idat as BlobPart[]).stream()
        .pipeThrough(new DecompressionStream("deflate")),
    ).arrayBuffer(),
  );
  let prev = new Uint8Array(stride);
  const colors: Array<[number, number, number]> = [];
  for (let y = 0; y < header.height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      const p = a + b - c;
      const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const pred = f === 1
        ? a
        : f === 2
        ? b
        : f === 3
        ? (a + b) >> 1
        : f === 4
        ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)
        : 0;
      cur[i] = (line[i] + pred) & 0xff;
    }
    colors.push([cur[x * bpp], cur[x * bpp + 1], cur[x * bpp + 2]]);
    prev = cur;
  }
  return { width: header.width, height: header.height, colors };
}

const near = (a: number[], b: number[]) =>
  a.every((v, i) => Math.abs(v - b[i]) <= 3);

/** Checks the hero and every block of a captured /blocks page. */
async function verifyBlocks(png: Uint8Array, blocks: number) {
  const { width, height, colors } = await columnColors(png, 10);
  const expectedHeight = VIEWPORT.height + blocks * BLOCK;
  if (width !== VIEWPORT.width || height !== expectedHeight) {
    throw new Error(
      `size ${width}x${height}, expected ${VIEWPORT.width}x${expectedHeight}`,
    );
  }
  for (let y = 0; y < VIEWPORT.height; y++) {
    if (!near(colors[y], [255, 0, 0])) {
      throw new Error(`row ${y}: expected the red hero, got ${colors[y]}`);
    }
  }
  for (let i = 0; i < blocks; i++) {
    // Check rows well inside each block, away from anti-aliased edges.
    for (const dy of [2, BLOCK / 2, BLOCK - 3]) {
      const y = VIEWPORT.height + i * BLOCK + dy;
      if (!near(colors[y], blockColor(i))) {
        throw new Error(
          `row ${y}: expected block ${i} ${blockColor(i)}, got ${colors[y]}`,
        );
      }
    }
  }
}

interface Written {
  bytes?: Uint8Array;
  contentType?: string;
  meta?: Record<string, unknown>;
}

async function capture(
  name: string,
  url: string,
  args: Record<string, unknown> = {},
): Promise<Written> {
  const written: Written = {};
  const globalArgs = model.globalArguments.parse({
    viewportWidth: VIEWPORT.width,
    viewportHeight: VIEWPORT.height,
  });
  const parsed = model.methods.capture.arguments.parse({
    url,
    name,
    scrollDelayMs: 50,
    settleMs: 200,
    maxHeight: 100000,
    timeoutMs: 120000,
    ...args,
  });
  await model.methods.capture.execute(parsed, {
    globalArgs,
    logger: {
      info: (msg: string, props?: Record<string, unknown>) =>
        console.log(
          `    ${msg.replace(/\{(\w+)\}/g, (_, k) => String(props?.[k]))}`,
        ),
    },
    createFileWriter: (_spec, _name, overrides) => ({
      writeAll: async (content: Uint8Array) => {
        written.bytes = content;
        written.contentType = overrides?.contentType;
        const ext = overrides?.contentType?.split("/")[1] ?? "bin";
        await Deno.writeFile(`${OUT}/${name}.${ext}`, content);
        return { name };
      },
    }),
    writeResource: (_spec, _name, data) => {
      written.meta = data;
      return Promise.resolve({ name: `${name}-capture` });
    },
  });
  return written;
}

const base = `http://host.docker.internal:${PORT}`;
const checks: Array<[string, () => Promise<void>]> = [
  ["short page: single capture", async () => {
    const w = await capture("short", `${base}/blocks?blocks=20`);
    if (w.meta?.tiles !== 1) throw new Error(`tiles ${w.meta?.tiles}`);
    if (w.meta?.httpStatus !== 200) {
      throw new Error(`status ${w.meta?.httpStatus}`);
    }
    await verifyBlocks(w.bytes!, 20);
  }],
  ["mid-height page (8000-16000px): no single-capture wrap", async () => {
    const w = await capture("mid", `${base}/blocks?blocks=120`);
    if ((w.meta?.tiles as number) < 2) {
      throw new Error(`tiles ${w.meta?.tiles}`);
    }
    await verifyBlocks(w.bytes!, 120);
  }],
  [
    "tall page: scrolled tiles stitched in order",
    async () => {
      const w = await capture("tall", `${base}/blocks?blocks=250`);
      if ((w.meta?.tiles as number) < 2) {
        throw new Error(
          `tiles ${w.meta?.tiles}`,
        );
      }
      if (w.meta?.truncated !== false) throw new Error("marked truncated");
      await verifyBlocks(w.bytes!, 250);
    },
  ],
  ["tall page with smooth scrolling", async () => {
    const w = await capture("smooth", `${base}/blocks?blocks=250&smooth`);
    await verifyBlocks(w.bytes!, 250);
  }],
  ["tall page without hideFixed: beyond-viewport bands", async () => {
    const w = await capture("beyond", `${base}/blocks?blocks=250`, {
      hideFixed: false,
    });
    await verifyBlocks(w.bytes!, 250);
  }],
  ["webp output", async () => {
    const w = await capture("webp", `${base}/blocks?blocks=20`, {
      format: "webp",
    });
    const head = new TextDecoder().decode(w.bytes!.subarray(0, 12));
    if (
      w.contentType !== "image/webp" || !head.startsWith("RIFF") ||
      !head.endsWith("WEBP")
    ) {
      throw new Error(`not a webp (${w.contentType}, ${JSON.stringify(head)})`);
    }
  }],
  ["HTTP 404 fails without saving", async () => {
    try {
      const w = await capture("missing", `${base}/missing`);
      throw new Error(`expected a failure, saved ${w.bytes?.length} bytes`);
    } catch (err) {
      if (!String((err as Error).message).includes("HTTP 404")) throw err;
    }
  }],
];

await Deno.mkdir(OUT, { recursive: true });
let failed = 0;
for (const [label, check] of checks) {
  console.log(`- ${label}`);
  const started = performance.now();
  try {
    await check();
    console.log(`  ok (${((performance.now() - started) / 1000).toFixed(1)}s)`);
  } catch (err) {
    failed++;
    console.log(`  FAILED: ${(err as Error).message}`);
    console.log(
      `::error title=webshot smoke::${label}: ${(err as Error).message}`,
    );
  }
}
await server.shutdown();
console.log(
  failed ? `${failed} smoke check(s) failed` : "all smoke checks passed",
);
Deno.exit(failed ? 1 : 0);
