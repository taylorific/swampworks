// Just enough of Java's keystore formats to list the certificates a trust
// store holds, without keytool or a password: JKS, which the JDK used for
// cacerts up to 17 and which distributions still generate, and PKCS#12,
// which cacerts has been since JDK 18. Java leaves the certificates in a
// trust store unencrypted in both, so no password is needed to read them.
// Also the JDK's blocked.certs, the fingerprints it refuses in any path.

import { readTlv } from "./x509.ts";

/** The certificates in a keystore, and whether some were out of reach. */
export interface KeystoreContents {
  format: "jks" | "pkcs12";
  certificates: Uint8Array[];
  /** PKCS#12 only: bags encrypted with a password, which can't be read. */
  encrypted: boolean;
}

const JKS_MAGIC = 0xfeedfeed;

/** A big-endian reader over a JKS file. */
class Cursor {
  private view: DataView;
  at = 0;
  constructor(private bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  private need(n: number) {
    if (this.at + n > this.bytes.length) throw new Error("Truncated keystore");
  }
  u16(): number {
    this.need(2);
    const v = this.view.getUint16(this.at);
    this.at += 2;
    return v;
  }
  u32(): number {
    this.need(4);
    const v = this.view.getUint32(this.at);
    this.at += 4;
    return v;
  }
  take(n: number): Uint8Array {
    this.need(n);
    const v = this.bytes.subarray(this.at, this.at + n);
    this.at += n;
    return v;
  }
  /** Java's writeUTF: a two-byte length, then the bytes. */
  skipUtf() {
    this.take(this.u16());
  }
}

function readJks(bytes: Uint8Array): KeystoreContents {
  const c = new Cursor(bytes);
  c.u32(); // magic
  const version = c.u32();
  if (version !== 1 && version !== 2) {
    throw new Error(`Unsupported JKS version ${version}`);
  }
  const certificates: Uint8Array[] = [];
  const cert = () => {
    if (version === 2) c.skipUtf(); // certificate type, "X.509"
    return c.take(c.u32());
  };
  const count = c.u32();
  for (let n = 0; n < count; n++) {
    const tag = c.u32();
    c.skipUtf(); // alias
    c.take(8); // creation date
    if (tag === 1) {
      // A private key entry: the protected key, then its chain.
      c.take(c.u32());
      const chain = c.u32();
      for (let i = 0; i < chain; i++) certificates.push(cert());
    } else if (tag === 2) {
      certificates.push(cert());
    } else {
      throw new Error(`Unsupported JKS entry type ${tag}`);
    }
  }
  return { format: "jks", certificates, encrypted: false };
}

const hex = (b: Uint8Array) =>
  Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

// Object identifiers, as the hex of their DER content.
const OID_DATA = "2a864886f70d010701"; // pkcs7-data
const OID_ENCRYPTED_DATA = "2a864886f70d010706"; // pkcs7-encryptedData
const OID_CERT_BAG = "2a864886f70d010c0a0103"; // pkcs-12 certBag
const OID_X509_CERT = "2a864886f70d01091601"; // x509Certificate

/** The children of a constructed DER element. */
function children(der: Uint8Array, at: number): number[] {
  const parent = readTlv(der, at);
  const out: number[] = [];
  for (let i = parent.body; i < parent.end; i = readTlv(der, i).end) {
    out.push(i);
  }
  return out;
}

function oidAt(der: Uint8Array, at: number): string {
  const t = readTlv(der, at);
  if (t.tag !== 0x06) throw new Error("Expected an object identifier");
  return hex(der.subarray(t.body, t.end));
}

/** The content of an OCTET STRING, or of [0] EXPLICIT around one. */
function octets(der: Uint8Array, at: number): Uint8Array {
  let t = readTlv(der, at);
  if (t.tag === 0xa0) t = readTlv(der, t.body);
  if (t.tag !== 0x04) throw new Error("Expected an OCTET STRING");
  return der.subarray(t.body, t.end);
}

function readPkcs12(der: Uint8Array): KeystoreContents {
  // PFX ::= SEQUENCE { version, authSafe ContentInfo, macData OPTIONAL }
  const [, authSafe] = children(der, 0);
  const [type, content] = children(der, authSafe);
  if (oidAt(der, type) !== OID_DATA) {
    throw new Error("PKCS#12 signed with a public key is not supported");
  }
  // AuthenticatedSafe ::= SEQUENCE OF ContentInfo
  const safe = octets(der, content);
  const certificates: Uint8Array[] = [];
  let encrypted = false;
  for (const info of children(safe, 0)) {
    const [t, c] = children(safe, info);
    const oid = oidAt(safe, t);
    if (oid === OID_ENCRYPTED_DATA) {
      encrypted = true;
      continue;
    }
    if (oid !== OID_DATA) continue;
    // SafeContents ::= SEQUENCE OF SafeBag
    const bags = octets(safe, c);
    for (const bag of children(bags, 0)) {
      const [bagId, value] = children(bags, bag);
      if (oidAt(bags, bagId) !== OID_CERT_BAG) continue;
      // [0] EXPLICIT CertBag ::= SEQUENCE { certId, [0] EXPLICIT OCTET STRING }
      const [certBag] = children(bags, value);
      const [certId, certValue] = children(bags, certBag);
      if (oidAt(bags, certId) !== OID_X509_CERT) continue;
      certificates.push(octets(bags, certValue));
    }
  }
  return { format: "pkcs12", certificates, encrypted };
}

/** The certificates in a JKS or PKCS#12 keystore. */
export function readKeystore(bytes: Uint8Array): KeystoreContents {
  if (bytes.length >= 4) {
    const magic = new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0);
    if (magic === JKS_MAGIC) return readJks(bytes);
  }
  if (bytes[0] === 0x30) return readPkcs12(bytes);
  throw new Error("Not a JKS or PKCS#12 keystore");
}

/**
 * The SHA-256 fingerprints in a JDK's blocked.certs, uppercase. The file
 * names its digest on the first line; one other than SHA-256 can't be
 * compared with the page's fingerprints and gives null.
 */
export function parseBlockedCerts(text: string): Set<string> | null {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const algorithm = lines[0]?.match(/^Algorithm=(.+)$/)?.[1];
  if (algorithm?.toUpperCase().replace("-", "") !== "SHA256") return null;
  return new Set(
    lines.slice(1).filter((l) => /^[0-9A-Fa-f]{64}$/.test(l)).map((l) =>
      l.toUpperCase()
    ),
  );
}
