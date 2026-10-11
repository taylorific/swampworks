// Minimal PNG stitching: joins PNG tiles of equal width and pixel format
// vertically into one PNG without decoding every pixel. Each tile's filtered
// scanlines are copied through as-is; only the first row of each tile is
// re-filtered, because its PNG filter may reference the (implicit, all-zero)
// row above it, which in the stitched image is the previous tile's last row.

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

/** Header fields of a PNG image that stitching depends on. */
export interface PngHeader {
  width: number;
  height: number;
  bitDepth: number;
  colorType: number;
  interlace: number;
}

interface ParsedPng {
  header: PngHeader;
  idat: Uint8Array[];
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes: Uint8Array, crc = 0xffffffff): number {
  for (let i = 0; i < bytes.length; i++) {
    crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  }
  return crc;
}

/** Parses the IHDR and IDAT chunks of a PNG. Throws on malformed input. */
export function parsePng(bytes: Uint8Array): ParsedPng {
  if (!SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new Error("Not a PNG image");
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let header: PngHeader | undefined;
  const idat: Uint8Array[] = [];
  let off = 8;
  while (off + 8 <= bytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    if (off + 12 + len > bytes.length) throw new Error("Truncated PNG chunk");
    if (type === "IHDR") {
      header = {
        width: dv.getUint32(off + 8),
        height: dv.getUint32(off + 12),
        bitDepth: bytes[off + 16],
        colorType: bytes[off + 17],
        interlace: bytes[off + 20],
      };
    } else if (type === "IDAT") {
      idat.push(bytes.subarray(off + 8, off + 8 + len));
    } else if (type === "IEND") {
      break;
    }
    off += 12 + len;
  }
  if (!header) throw new Error("PNG has no IHDR chunk");
  return { header, idat };
}

function bytesPerPixel(h: PngHeader): number {
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[h.colorType];
  if (!channels || h.bitDepth !== 8 || h.interlace !== 0) {
    throw new Error(
      `Unsupported PNG format for stitching (color type ${h.colorType}, bit depth ${h.bitDepth}, interlace ${h.interlace})`,
    );
  }
  return channels;
}

async function inflate(chunks: Uint8Array[]): Promise<Uint8Array> {
  const stream = new Blob(chunks as BlobPart[]).stream()
    .pipeThrough(new DecompressionStream("deflate"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Rewrites a scanline whose filter assumed an all-zero row above it as an
 * unfiltered (type 0) scanline, so it no longer depends on the row above.
 */
export function unfilterFirstRow(row: Uint8Array, bpp: number): Uint8Array {
  const filter = row[0];
  const out = new Uint8Array(row.length);
  for (let i = 1; i < row.length; i++) {
    const left = i > bpp ? out[i - bpp] : 0;
    let v = row[i];
    // With the row above all zero: Up adds 0, Average adds left/2, Paeth
    // picks left.
    if (filter === 1 || filter === 4) v += left;
    else if (filter === 3) v += left >> 1;
    else if (filter !== 0 && filter !== 2) {
      throw new Error(`Invalid PNG filter type ${filter}`);
    }
    out[i] = v & 0xff;
  }
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(
    8 + data.length,
    crc32(out.subarray(4, 8 + data.length)) ^ 0xffffffff,
  );
  return out;
}

/**
 * Stitches PNG tiles top to bottom. All tiles must share width, bit depth and
 * color type (true for screenshots taken with the same capture settings).
 */
export async function stitchPngs(tiles: Uint8Array[]): Promise<Uint8Array> {
  if (tiles.length === 0) throw new Error("No tiles to stitch");
  if (tiles.length === 1) return tiles[0];

  const first = parsePng(tiles[0]).header;
  const bpp = bytesPerPixel(first);
  const stride = 1 + first.width * bpp;

  const compressor = new CompressionStream("deflate");
  const writer = (compressor.writable as WritableStream<Uint8Array>)
    .getWriter();
  const compressed = new Response(compressor.readable).arrayBuffer();

  let height = 0;
  for (const tile of tiles) {
    const { header, idat } = parsePng(tile);
    if (
      header.width !== first.width || header.bitDepth !== first.bitDepth ||
      header.colorType !== first.colorType
    ) {
      throw new Error("PNG tiles differ in width or pixel format");
    }
    const raw = await inflate(idat);
    if (raw.length !== stride * header.height) {
      throw new Error("PNG tile data does not match its header");
    }
    await writer.write(unfilterFirstRow(raw.subarray(0, stride), bpp));
    await writer.write(raw.subarray(stride));
    height += header.height;
  }
  await writer.close();

  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, first.width);
  dv.setUint32(4, height);
  ihdr.set([first.bitDepth, first.colorType, 0, 0, 0], 8);

  const data = new Uint8Array(await compressed);
  const parts = [SIGNATURE, chunk("IHDR", ihdr)];
  const MAX_IDAT = 1 << 20;
  for (let i = 0; i < data.length; i += MAX_IDAT) {
    parts.push(chunk("IDAT", data.subarray(i, i + MAX_IDAT)));
  }
  parts.push(chunk("IEND", new Uint8Array()));

  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}
