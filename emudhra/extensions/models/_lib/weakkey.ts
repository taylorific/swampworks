// The eMudhra keys fell because each private scalar d was a single byte:
// 47 zero bytes and then 4, 56, 66, 115, 155, 156, 230 or 237
// (https://scotthelme.co.uk/eight-bits-of-trust-emudhras-ca-keys-cracked-in-milliseconds/).
// The public key is d×G, so computing 1×G, 2×G, ... up to 255×G finds d in
// milliseconds. Doing the same for every EC key in a trust store finds any
// CA made the same way, whether or not the disclosure lists it.

import { createECDH } from "node:crypto";
import { readTlv } from "./x509.ts";

/** The largest scalar tried: one byte, as in the eMudhra keys. */
export const MAX_SCALAR = 255;

/** Named-curve OIDs, as hex DER with tag, and their OpenSSL names. */
const CURVES: Record<string, { name: string; bytes: number }> = {
  "06082a8648ce3d030107": { name: "prime256v1", bytes: 32 },
  "06052b81040022": { name: "secp384r1", bytes: 48 },
  "06052b81040023": { name: "secp521r1", bytes: 66 },
};

/** id-ecPublicKey (1.2.840.10045.2.1). */
const EC_PUBLIC_KEY = "06072a8648ce3d0201";

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** Per curve, the x coordinate of d×G for each small d. Built when needed. */
const tables = new Map<string, Map<string, number>>();

function table(curve: { name: string; bytes: number }): Map<string, number> {
  let t = tables.get(curve.name);
  if (t) return t;
  t = new Map();
  for (let d = 1; d <= MAX_SCALAR; d++) {
    const ecdh = createECDH(curve.name);
    const key = new Uint8Array(curve.bytes);
    key[curve.bytes - 1] = d;
    ecdh.setPrivateKey(key);
    // Uncompressed: 04, x, y. Matching on x covers compressed keys too; the
    // other point with that x is (n-d)×G, far outside the table.
    const point = ecdh.getPublicKey();
    t.set(hex(point.subarray(1, 1 + curve.bytes)), d);
  }
  tables.set(curve.name, t);
  return t;
}

/**
 * The private scalar of an EC SubjectPublicKeyInfo when it is at most
 * MAX_SCALAR, which anyone can recover; null for any other key.
 */
export function recoverableScalar(spki: Uint8Array): number | null {
  try {
    const outer = readTlv(spki, 0);
    const alg = readTlv(spki, outer.body);
    const oid = readTlv(spki, alg.body);
    if (hex(spki.subarray(oid.start, oid.end)) !== EC_PUBLIC_KEY) return null;
    const params = readTlv(spki, oid.end);
    const curve = CURVES[hex(spki.subarray(params.start, params.end))];
    if (!curve) return null;
    const bits = readTlv(spki, alg.end);
    // A BIT STRING: the unused-bits byte, then the point.
    const point = spki.subarray(bits.body + 1, bits.end);
    if (![0x02, 0x03, 0x04].includes(point[0])) return null;
    const x = hex(point.subarray(1, 1 + curve.bytes));
    return table(curve).get(x) ?? null;
  } catch {
    return null;
  }
}
