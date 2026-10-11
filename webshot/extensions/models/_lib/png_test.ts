import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { parsePng, stitchPngs, unfilterFirstRow } from "./png.ts";

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  let c = 0xffffffff;
  for (const b of out.subarray(4, 8 + data.length)) {
    c = CRC[(c ^ b) & 0xff] ^ (c >>> 8);
  }
  dv.setUint32(8 + data.length, (c ^ 0xffffffff) >>> 0);
  return out;
}

async function deflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream()
    .pipeThrough(new CompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([data as BlobPart]).stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

/** Filters one RGB scanline with the given PNG filter type. */
function filterRow(f: number, cur: number[], prev: number[]): number[] {
  return cur.map((v, i) => {
    const a = i >= 3 ? cur[i - 3] : 0,
      b = prev[i],
      c = i >= 3 ? prev[i - 3] : 0;
    const p = a + b - c;
    const pred = f === 1
      ? a
      : f === 2
      ? b
      : f === 3
      ? (a + b) >> 1
      : f === 4
      ? (Math.abs(p - a) <= Math.abs(p - b) &&
          Math.abs(p - a) <= Math.abs(p - c)
        ? a
        : Math.abs(p - b) <= Math.abs(p - c)
        ? b
        : c)
      : 0;
    return (v - pred) & 0xff;
  });
}

/** Builds an RGB PNG from pixel rows, filtering each row with `filters[y]`. */
async function makePng(
  rows: number[][],
  filters: number[],
): Promise<Uint8Array> {
  const width = rows[0].length / 3;
  const raw: number[] = [];
  let prev = new Array(rows[0].length).fill(0);
  rows.forEach((row, y) => {
    raw.push(filters[y], ...filterRow(filters[y], row, prev));
    prev = row;
  });
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, width);
  new DataView(ihdr.buffer).setUint32(4, rows.length);
  ihdr.set([8, 2, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", await deflate(new Uint8Array(raw))),
    chunk("IEND", new Uint8Array()),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) (out.set(p, off), off += p.length);
  return out;
}

/** Decodes an RGB PNG back into pixel rows. */
async function decode(png: Uint8Array): Promise<number[][]> {
  const { header, idat } = parsePng(png);
  const raw = await inflate(
    new Uint8Array(await new Blob(idat as BlobPart[]).arrayBuffer()),
  );
  const stride = header.width * 3;
  const rows: number[][] = [];
  let prev = new Array(stride).fill(0);
  for (let y = 0; y < header.height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur: number[] = [];
    for (let i = 0; i < stride; i++) {
      const a = i >= 3 ? cur[i - 3] : 0,
        b = prev[i],
        c = i >= 3 ? prev[i - 3] : 0;
      const p = a + b - c;
      const pred = f === 1
        ? a
        : f === 2
        ? b
        : f === 3
        ? (a + b) >> 1
        : f === 4
        ? (Math.abs(p - a) <= Math.abs(p - b) &&
            Math.abs(p - a) <= Math.abs(p - c)
          ? a
          : Math.abs(p - b) <= Math.abs(p - c)
          ? b
          : c)
        : 0;
      cur.push((line[i] + pred) & 0xff);
    }
    rows.push(cur);
    prev = cur;
  }
  return rows;
}

function pixels(seed: number, width: number, height: number): number[][] {
  return Array.from(
    { length: height },
    (_, y) =>
      Array.from(
        { length: width * 3 },
        (_, i) => (seed * 31 + y * 17 + i * 7) % 256,
      ),
  );
}

Deno.test("stitchPngs joins tiles row-for-row for every first-row filter", async () => {
  for (const firstFilter of [0, 1, 2, 3, 4]) {
    const a = pixels(1, 4, 3), b = pixels(2, 4, 2), c = pixels(3, 4, 4);
    const tiles = await Promise.all([
      makePng(a, [firstFilter, 4, 2]),
      makePng(b, [firstFilter, 3]),
      makePng(c, [firstFilter, 1, 2, 4]),
    ]);
    const out = await stitchPngs(tiles);
    assertEquals(parsePng(out).header.height, 9);
    assertEquals(
      await decode(out),
      [...a, ...b, ...c],
      `first-row filter ${firstFilter}`,
    );
  }
});

Deno.test("stitchPngs returns a single tile unchanged", async () => {
  const one = await makePng(pixels(5, 2, 2), [0, 2]);
  assertEquals(await stitchPngs([one]), one);
});

Deno.test("stitchPngs rejects tiles of different widths", async () => {
  const a = await makePng(pixels(1, 4, 2), [0, 0]);
  const b = await makePng(pixels(1, 5, 2), [0, 0]);
  await assertRejects(() => stitchPngs([a, b]), Error, "differ in width");
});

Deno.test("unfilterFirstRow rejects invalid filter types", () => {
  assertThrows(
    () => unfilterFirstRow(new Uint8Array([9, 1, 2, 3]), 3),
    Error,
    "Invalid PNG filter",
  );
});

Deno.test("parsePng rejects non-PNG input", () => {
  assertThrows(
    () => parsePng(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])),
    Error,
    "Not a PNG",
  );
});
