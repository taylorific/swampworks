// Just enough X.509 to match certificates by key: split PEM bundles, find the
// SubjectPublicKeyInfo in a DER certificate, and hash it. Matching on the
// key rather than the whole certificate catches every copy of a CA, whoever
// signed it. Also the trust settings OpenSSL appends to a TRUSTED
// CERTIFICATE, enough to tell what each is rejected for.

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

/** What a trusted certificate's settings reject it for. */
export interface Rejections {
  /** anyExtendedKeyUsage: every use, including a caller that names none. */
  any: boolean;
  /** TLS server authentication, the purpose TLS clients ask for. */
  serverAuth: boolean;
  codeSigning: boolean;
}

export const NO_REJECTIONS: Rejections = {
  any: false,
  serverAuth: false,
  codeSigning: false,
};

/** The rejected purposes we look for, as hex DER OIDs with tag. */
const REJECT_OIDS: Record<string, keyof Rejections> = {
  "0604551d2500": "any", // 2.5.29.37.0
  "06082b06010505070301": "serverAuth", // 1.3.6.1.5.5.7.3.1
  "06082b06010505070303": "codeSigning", // 1.3.6.1.5.5.7.3.3
};

/**
 * The purposes a trusted certificate's settings reject, as OpenSSL writes
 * them after the certificate in X509_CERT_AUX, whose [0] lists them.
 * update-ca-trust writes blocklisted roots into ca-bundle.trust.crt rejected
 * for TLS, code signing and other named uses but not for any use: TLS
 * clients, which ask for the TLS server purpose, refuse them, but OpenSSL
 * accepts them when a caller names no purpose (`openssl verify`).
 * Damaged trust settings reject nothing.
 */
export function rejections(der: Uint8Array): Rejections {
  const out = { ...NO_REJECTIONS };
  try {
    const cert = readTlv(der, 0);
    if (cert.end >= der.length) return out;
    const aux = readTlv(der, cert.end);
    if (aux.tag !== 0x30) return out;
    for (let at = aux.body; at < aux.end;) {
      const e = readTlv(der, at);
      if (e.tag === 0xa0) {
        for (let o = e.body; o < e.end;) {
          const oid = readTlv(der, o);
          const hex = Array.from(
            der.subarray(oid.start, oid.end),
            (b) => b.toString(16).padStart(2, "0"),
          ).join("");
          const name = REJECT_OIDS[hex];
          if (name) out[name] = true;
          o = oid.end;
        }
      }
      at = e.end;
    }
  } catch {
    return { ...NO_REJECTIONS };
  }
  return out;
}

/** One certificate from a bundle, by its hashes. */
export interface CertHashes {
  sha256: string;
  spkiSha256: string;
  spki: Uint8Array;
  /** What its trust settings reject it for; nothing for a plain certificate. */
  rejects: Rejections;
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
        rejects: rejections(der),
      });
    } catch {
      // Not a certificate we can read; it can't be one of ours.
    }
  }
  return out;
}
