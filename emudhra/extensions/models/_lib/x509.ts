// Just enough X.509 to match certificates by key: split PEM bundles, find the
// SubjectPublicKeyInfo in a DER certificate, and hash it. Matching on the
// key rather than the whole certificate catches every copy of a CA, whoever
// signed it. Also the trust settings OpenSSL appends to a TRUSTED
// CERTIFICATE, enough to tell when one is rejected for every use.

/** The bounds of one DER element. */
export interface Tlv {
  tag: number;
  /** Offset of the tag byte. */
  start: number;
  /** Offset of the first content byte. */
  body: number;
  /** Offset just past the element. */
  end: number;
}

/** Reads the DER element that starts at `at`. */
export function readTlv(der: Uint8Array, at: number): Tlv {
  if (at + 2 > der.length) throw new Error("Truncated DER");
  const tag = der[at];
  let len = der[at + 1];
  let body = at + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || body + n > der.length) {
      throw new Error("Unsupported DER length");
    }
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + der[body + i];
    body += n;
  }
  const end = body + len;
  if (end > der.length) throw new Error("Truncated DER");
  return { tag, start: at, body, end };
}

/** The whole certificate (a trusted-certificate PEM carries trust after it). */
export function certificateBytes(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0);
  if (cert.tag !== 0x30) throw new Error("Not a certificate");
  return der.subarray(0, cert.end);
}

/** The SubjectPublicKeyInfo element of a DER certificate, tag and all. */
export function spkiBytes(der: Uint8Array): Uint8Array {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.body);
  if (cert.tag !== 0x30 || tbs.tag !== 0x30) {
    throw new Error("Not a certificate");
  }
  let at = tbs.body;
  // Optional [0] version, then serial, signature, issuer, validity, subject.
  if (der[at] === 0xa0) at = readTlv(der, at).end;
  for (let i = 0; i < 5; i++) at = readTlv(der, at).end;
  const spki = readTlv(der, at);
  if (spki.tag !== 0x30) throw new Error("No SubjectPublicKeyInfo");
  return der.subarray(spki.start, spki.end);
}

/** Uppercase hex SHA-256, as the disclosure page writes fingerprints. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(
    new Uint8Array(digest),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("").toUpperCase();
}

/** Base64, which may be wrapped, to bytes. */
export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
}

/** Base64 DER as a PEM certificate. */
export function toPem(der: string): string {
  const lines = der.replace(/\s+/g, "").match(/.{1,64}/g) ?? [];
  return `-----BEGIN CERTIFICATE-----\n${
    lines.join("\n")
  }\n-----END CERTIFICATE-----\n`;
}

const PEM_BLOCK =
  /-----BEGIN (?:TRUSTED )?CERTIFICATE-----([\s\S]*?)-----END (?:TRUSTED )?CERTIFICATE-----/g;

/** Every certificate in a PEM bundle, as DER. Blocks that don't decode are skipped. */
export function splitPem(text: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  for (const m of text.matchAll(PEM_BLOCK)) {
    try {
      out.push(fromBase64(m[1].replace(/\s+/g, "")));
    } catch {
      // Not base64; a bundle may carry a damaged block.
    }
  }
  return out;
}

/** anyExtendedKeyUsage (2.5.29.37.0), DER-encoded with its tag. */
const ANY_EKU = [0x06, 0x04, 0x55, 0x1d, 0x25, 0x00];

/**
 * Whether a trusted certificate's settings reject it for any use, as
 * `openssl x509 -trustout -addreject anyExtendedKeyUsage` writes them. They
 * follow the certificate as X509_CERT_AUX, whose [0] holds the rejected
 * purposes. One rejected only for named purposes, as update-ca-trust writes
 * blocklisted roots into ca-bundle.trust.crt, is still trusted by OpenSSL
 * when the caller asks for no purpose.
 */
export function rejectsAnyUse(der: Uint8Array): boolean {
  try {
    return auxRejectsAny(der);
  } catch {
    // Damaged trust settings reject nothing.
    return false;
  }
}

function auxRejectsAny(der: Uint8Array): boolean {
  const cert = readTlv(der, 0);
  if (cert.end >= der.length) return false;
  const aux = readTlv(der, cert.end);
  if (aux.tag !== 0x30) return false;
  for (let at = aux.body; at < aux.end;) {
    const e = readTlv(der, at);
    if (e.tag === 0xa0) {
      for (let o = e.body; o < e.end;) {
        const oid = readTlv(der, o);
        const bytes = der.subarray(oid.start, oid.end);
        if (
          bytes.length === ANY_EKU.length &&
          bytes.every((b, i) => b === ANY_EKU[i])
        ) {
          return true;
        }
        o = oid.end;
      }
    }
    at = e.end;
  }
  return false;
}

/** One certificate from a bundle, by its hashes. */
export interface CertHashes {
  sha256: string;
  spkiSha256: string;
  spki: Uint8Array;
  /** A trusted certificate rejected for any use: the bundle doesn't trust it. */
  rejected: boolean;
}

/** The certificate and key hashes of every certificate in a PEM bundle. */
export function hashBundle(text: string): Promise<CertHashes[]> {
  return hashCertificates(splitPem(text));
}

/** The certificate and key hashes of DER certificates. */
export async function hashCertificates(
  ders: Uint8Array[],
): Promise<CertHashes[]> {
  const out: CertHashes[] = [];
  for (const der of ders) {
    try {
      const spki = spkiBytes(der);
      out.push({
        sha256: await sha256Hex(certificateBytes(der)),
        spkiSha256: await sha256Hex(spki),
        spki,
        rejected: rejectsAnyUse(der),
      });
    } catch {
      // Not a certificate we can read; it can't be one of ours.
    }
  }
  return out;
}
