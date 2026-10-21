import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  assess,
  checkBundle,
  checkKeystore,
  checkRuntime,
  distroFix,
  electronApps,
  electronVersion,
  hostBundles,
  hostKeystores,
  inspectJavaHome,
  isPatched,
  macVerdict,
  model,
  parseOsRelease,
  type Platform,
  readHostKeystores,
  type RunResult,
  slug,
  swampDeno,
  toolchain,
  windowsVerdict,
} from "./emudhra_exposure.ts";
import {
  ANCHORS,
  CROSS_SIGNED_TLS_ROOT,
  INTERMEDIATES,
} from "./_lib/indicators.ts";
import { parseBlockedCerts, readKeystore } from "./_lib/keystore.ts";
import {
  certificateBytes,
  fromBase64,
  sha256Hex,
  spkiBytes,
  toPem,
} from "./_lib/x509.ts";

type Ctx = Parameters<typeof model.methods.scan.execute>[1];

/** A self-signed certificate that has nothing to do with eMudhra. */
const UNRELATED = `-----BEGIN CERTIFICATE-----
MIIBfjCCASOgAwIBAgIUMDY4OK9Vl1VcxG6IT6qPHX+CQY4wCgYIKoZIzj0EAwIw
FDESMBAGA1UEAwwJdW5yZWxhdGVkMB4XDTI2MTAyMTEyMzEwNloXDTM2MTAxODEy
MzEwNlowFDESMBAGA1UEAwwJdW5yZWxhdGVkMFkwEwYHKoZIzj0CAQYIKoZIzj0D
AQcDQgAEuKN0zGxtDPxVovHJDh43+x8hW/nQQZ8fUHkrM6+fasfkmtFf2kGI5MFG
PRQT1mbZMJLQ+EAZO1xppMkpsielpKNTMFEwHQYDVR0OBBYEFARIBk4Wy5LLTY/m
nnmQs8A/CddNMB8GA1UdIwQYMBaAFARIBk4Wy5LLTY/mnnmQs8A/CddNMA8GA1Ud
EwEB/wQFMAMBAf8wCgYIKoZIzj0EAwIDSQAwRgIhAJDaXI0hr+5N9nz0BWxjr3JA
y97TTAXlOI/PqwMHw2nfAiEArWj9PPlcJNMh4EclxdM6No/r6ewLslSpKP71UaVC
rW0=
-----END CERTIFICATE-----
`;

const anchor = (name: string) => ANCHORS.find((a) => a.name === name)!;
const AAA = anchor("AAA Certificate Services");
const ECC = anchor("emSign ECC Root CA - G3");

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 127, stdout: "", stderr: "not found" };

Deno.test("every embedded certificate hashes to the page's fingerprints", async () => {
  for (const c of [...INTERMEDIATES, ...ANCHORS]) {
    const der = fromBase64(c.der);
    assertEquals(await sha256Hex(certificateBytes(der)), c.sha256, c.name);
    assertEquals(await sha256Hex(spkiBytes(der)), c.spkiSha256, c.name);
  }
});

Deno.test("the cross-signed TLS root has the TLS root's key", async () => {
  const der = fromBase64(CROSS_SIGNED_TLS_ROOT);
  assertEquals(
    await sha256Hex(certificateBytes(der)),
    "3094025792039A68AF6E553686410BDAB7C0D4A36B9084CBA64202E35D6EBBDD",
  );
  assertEquals(
    await sha256Hex(spkiBytes(der)),
    anchor("emSign Root TLS CA - G3").spkiSha256,
  );
});

Deno.test("the page lists 16 certificates for 8 keys", () => {
  assertEquals(INTERMEDIATES.length, 16);
  assertEquals(new Set(INTERMEDIATES.map((i) => i.spkiSha256)).size, 8);
});

Deno.test("checkBundle finds AAA Certificate Services for what the bundle verifies", async () => {
  const b = await checkBundle(
    "/etc/ssl/cert.pem",
    "system",
    UNRELATED + toPem(AAA.der),
  );
  assertEquals(b.certificates, 2);
  assertEquals(b.anchors, ["AAA Certificate Services"]);
  assertEquals(b.exposes, ["tls"], "a system bundle is for TLS");
  const objsign = await checkBundle(
    "/etc/pki/ca-trust/extracted/pem/objsign-ca-bundle.pem",
    "system",
    toPem(AAA.der),
  );
  assertEquals(objsign.exposes, ["codeSigning"]);
  const extra = await checkBundle("/x.pem", "extra", toPem(AAA.der));
  assertEquals(extra.exposes, ["tls", "codeSigning"]);
});

Deno.test("checkBundle finds emSign ECC Root CA - G3 for TLS only", async () => {
  const b = await checkBundle("/b.pem", "system", toPem(ECC.der));
  assertEquals(b.exposes, ["tls"]);
});

Deno.test("checkBundle matches an intermediate by key, in either copy", async () => {
  const cs = INTERMEDIATES.find((i) =>
    i.name === "EM OV CS CA - G3C" && i.issuedBy === "AAA Certificate Services"
  )!;
  const b = await checkBundle("/b.pem", "extra", toPem(cs.der));
  assertEquals(b.intermediates, ["EM OV CS CA - G3C"]);
  assertEquals(b.exposes, ["codeSigning"]);
});

Deno.test("checkBundle reads OpenSSL TRUSTED CERTIFICATE blocks", async () => {
  // Trust settings follow the certificate in the same block.
  const der = fromBase64(AAA.der);
  const withAux = new Uint8Array([...der, 0x30, 0x03, 0x02, 0x01, 0x00]);
  const b64 = btoa(String.fromCharCode(...withAux));
  const text =
    `-----BEGIN TRUSTED CERTIFICATE-----\n${b64}\n-----END TRUSTED CERTIFICATE-----\n`;
  const b = await checkBundle("/b.pem", "system", text);
  assertEquals(b.anchors, ["AAA Certificate Services"]);
});

Deno.test("checkBundle leaves a clean bundle clean and skips garbage", async () => {
  const b = await checkBundle(
    "/b.pem",
    "system",
    `${UNRELATED}-----BEGIN CERTIFICATE-----\n!!!\n-----END CERTIFICATE-----\n`,
  );
  assertEquals(b.certificates, 1);
  assertEquals(b.exposes, []);
});

Deno.test("isPatched compares within a release line", () => {
  const node = ["22.23.4", "24.22.1", "26.12.1"];
  assert(isPatched("22.23.4", node, 1));
  assert(!isPatched("22.23.3", node, 1));
  assert(isPatched("24.30.0", node, 1));
  assert(!isPatched("20.19.0", node, 1), "no fix on an older line");
  assert(!isPatched("25.1.0", node, 1), "no fix on an unlisted line");
  assert(isPatched("27.0.0", node, 1), "newer than every fixed line");
  const go = ["1.26.10", "1.27.3"];
  assert(isPatched("1.27.3", go, 2));
  assert(!isPatched("1.27", go, 2));
  assert(!isPatched("1.26.9", go, 2));
  assert(isPatched("1.28.0", go, 2));
  assert(!isPatched("1.25.12", go, 2));
});

Deno.test("macVerdict tells revoked from untrusted", () => {
  assertEquals(macVerdict(ok()).verdict, "trusted");
  assertEquals(
    macVerdict({
      code: 1,
      stdout: "",
      stderr:
        'Error Domain=NSOSStatusErrorDomain Code=-67820 "x" UserInfo={NSLocalizedDescription=\u201cEM DV TLS CA - G3B\u201d certificate is revoked, ...}',
    }).verdict,
    "blocked",
  );
  const u = macVerdict({
    code: 1,
    stdout: "",
    stderr:
      "UserInfo={NSLocalizedDescription=Root certificate is not trusted., NSUnderlyingError=0x1}",
  });
  assertEquals(u, {
    verdict: "untrusted",
    detail: "Root certificate is not trusted.",
  });
  assertEquals(macVerdict(missing).verdict, "error");
});

Deno.test("windowsVerdict treats ExplicitDistrust as blocked", () => {
  assertEquals(
    windowsVerdict({
      sha256: "",
      ok: false,
      status: ["ExplicitDistrust"],
      root: null,
    }).verdict,
    "blocked",
  );
  assertEquals(
    windowsVerdict({
      sha256: "",
      ok: true,
      status: [],
      root: "CN=AAA Certificate Services",
    }),
    { verdict: "trusted", detail: "chains to CN=AAA Certificate Services" },
  );
  assertEquals(
    windowsVerdict({
      sha256: "",
      ok: false,
      status: ["PartialChain"],
      root: null,
    }).verdict,
    "untrusted",
  );
});

Deno.test("distroFix follows ID_LIKE", () => {
  assertStringIncludes(
    distroFix(parseOsRelease('ID=pop\nID_LIKE="ubuntu debian"\n')),
    "ubuntu0",
  );
  assertStringIncludes(
    distroFix(parseOsRelease("ID=rocky\nID_LIKE='rhel centos fedora'")),
    "blocklist",
  );
  assertStringIncludes(distroFix({ ID: "alpine" }), "20261020-r0");
  assertStringIncludes(distroFix({}), "Remove");
});

Deno.test("hostBundles looks in the right places per OS", () => {
  const env = (vars: Record<string, string>) => (k: string) => vars[k];
  const win: Platform = {
    os: "windows",
    env: env({ ProgramFiles: "C:\\Program Files" }),
  };
  assertEquals(hostBundles(win, []), [{
    path: "C:\\Program Files\\Git\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt",
    source: "git for windows",
  }]);
  const mac = hostBundles({ os: "darwin", env: env({}) }, ["/x.pem"]);
  assertEquals(mac[0], { path: "/etc/ssl/cert.pem", source: "system" });
  assertEquals(mac[1].source, "homebrew");
  assertEquals(mac.at(-1), { path: "/x.pem", source: "extra" });
});

Deno.test("assess rolls findings into TLS and code-signing status", async () => {
  const base = {
    target: "x",
    kind: "image" as const,
    os: "linux",
    distro: null,
  };
  const clean = await checkBundle("/b", "system", UNRELATED);
  const dirty = await checkBundle("/b", "system", toPem(ECC.der));
  assertEquals(assess(base, [clean], [], []).status, "protected");
  const t = assess(base, [dirty], [], [], { ID: "debian" });
  assertEquals([t.status, t.tls, t.codeSigning], [
    "exposed",
    "exposed",
    "protected",
  ]);
  assertStringIncludes(t.remediation[0], "rebuild the image");
  assertStringIncludes(t.remediation[0], "deb12u2");
  const none = assess(base, [], [], []);
  assertEquals(none.status, "unknown");
  const native = assess({ ...base, kind: "host" }, [], [{
    verifier: "windows-cryptoapi",
    name: "EM OV CS CA - G3B",
    issuedBy: "AAA Certificate Services",
    usage: "codeSigning",
    verdict: "trusted",
    detail: "chains to CN=AAA",
  }], [{
    tool: "node",
    version: "22.1.0",
    fixedIn: ["22.23.4"],
    status: "outdated",
  }]);
  assertEquals([native.tls, native.codeSigning], ["exposed", "exposed"]);
  assertEquals(native.remediation.length, 2);
});

Deno.test("slug makes resource names", () => {
  assertEquals(
    slug("image", "ghcr.io/Org/app:1.2"),
    "image-ghcr.io-org-app-1.2",
  );
});

Deno.test("checkRuntime only matters when there are containers", async () => {
  const g = model.globalArguments.parse({});
  assertEquals(
    await checkRuntime(g, () => Promise.resolve(missing)),
    { pass: true },
  );
  const r = await checkRuntime(
    model.globalArguments.parse({ images: ["x"], runtime: "container" }),
    () => Promise.resolve(missing),
  );
  assertEquals(r.pass, false);
  assertStringIncludes(r.errors![0], "container system start");
});

/**
 * A fake docker: `cp` writes the files in `fs`, `inspect` reports `env` for
 * "web" and for the containers it creates, other calls are recorded.
 */
function fakeDocker(
  fs: Record<string, string | Uint8Array>,
  env: string[] = [],
) {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "docker") return missing;
    if (args[0] === "create") return ok("abc123");
    if (args[0] === "rm") return ok();
    if (args[0] === "inspect") {
      return args[1] === "web" || args[1].startsWith("emudhra-scan-")
        ? ok(JSON.stringify([{ Config: { Env: env } }]))
        : {
          code: 1,
          stdout: "",
          stderr: `Error: No such object: ${args[1]}`,
        };
    }
    if (args[0] === "cp") {
      const path = args[2].split(":")[1];
      if (!(path in fs)) {
        return { code: 1, stdout: "", stderr: "Could not find the file" };
      }
      const data = fs[path];
      if (typeof data === "string") await Deno.writeTextFile(args[3], data);
      else await Deno.writeFile(args[3], data);
      return ok();
    }
    return missing;
  };
  return { run, calls };
}

async function scan(
  globals: Record<string, unknown>,
  run: (cmd: string, args: string[]) => Promise<RunResult>,
  args: Record<string, unknown> = {},
) {
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse(globals),
    methodName: "scan",
  });
  const m = model.methods.scan;
  let error: Error | undefined;
  try {
    await m.execute(
      // deno-lint-ignore no-explicit-any
      { ...m.arguments.parse(args), _run: run } as any,
      test.context as unknown as Ctx,
    );
  } catch (err) {
    error = err as Error;
  }
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of test.getWrittenResources()) {
    out[r.name] = r.data as Record<string, unknown>;
  }
  return { out, error };
}

Deno.test("scan reads an image's bundle and removes its container", async () => {
  const docker = fakeDocker({
    "/etc/os-release":
      'PRETTY_NAME="Debian GNU/Linux 12 (bookworm)"\nID=debian\n',
    "/etc/ssl/certs/ca-certificates.crt": UNRELATED + toPem(ECC.der),
  });
  const { out, error } = await scan(
    { host: false, images: ["debian:bookworm"] },
    docker.run,
  );
  assertEquals(error, undefined);
  const t = out["image-debian-bookworm"];
  assertEquals(t.status, "exposed");
  assertEquals(t.distro, "Debian GNU/Linux 12 (bookworm)");
  assertEquals((t.bundles as unknown[]).length, 1);
  assertEquals(out.summary.exposed, ["debian:bookworm"]);
  assert(docker.calls[0].startsWith("docker create --name emudhra-scan-"));
  assert(docker.calls.at(-1)!.startsWith("docker rm --force emudhra-scan-"));
});

Deno.test("scan reads a running container in place and fails on exposure when asked", async () => {
  const docker = fakeDocker({
    "/app/roots.pem": toPem(AAA.der),
  });
  const { out, error } = await scan(
    { host: false, containers: ["web"], bundles: ["/app/roots.pem"] },
    docker.run,
    { failOnExposed: true },
  );
  assertEquals(out["container-web"].codeSigning, "exposed");
  assertStringIncludes(error!.message, "Exposed: web");
  assert(
    !docker.calls.some((c) => c.includes(" create ") || c.includes(" rm ")),
  );
  assert(
    docker.calls.some((c) =>
      c === `docker cp -L web:/app/roots.pem ${c.split(" ").at(-1)}`
    ),
  );
});

Deno.test("scan records a target it can't read and carries on", async () => {
  const run = (cmd: string, args: string[]) =>
    Promise.resolve(
      args[0] === "create" && args.includes("nope:1")
        ? { code: 1, stdout: "", stderr: "pull access denied" }
        : cmd === "docker" && args[0] === "cp" &&
            args[2].endsWith("ca-certificates.crt")
        ? missing
        : args[0] === "rm" || args[0] === "create"
        ? ok()
        : { code: 1, stdout: "", stderr: "no such file" },
    );
  const { out, error } = await scan(
    { host: false, images: ["nope:1", "scratch-app:1"] },
    run,
  );
  assertEquals(error, undefined);
  assertEquals(out["image-scratch-app-1"].status, "unknown");
  const s = out.summary as { errors: { target: string; error: string }[] };
  assertEquals(s.errors[0].target, "nope:1");
  assertStringIncludes(s.errors[0].error, "pull access denied");
});

Deno.test("scan fails when there is nothing to scan, or every target fails", async () => {
  const { error } = await scan({ host: false }, () => Promise.resolve(missing));
  assertStringIncludes(error!.message, "Nothing to scan");
  await assertRejects(
    async () => {
      const r = await scan(
        { host: false, images: ["a"] },
        () => Promise.resolve({ code: 1, stdout: "", stderr: "boom" }),
      );
      if (r.error) throw r.error;
    },
    Error,
    "Every scan failed",
  );
});

Deno.test("scan reports a running container that isn't there as an error", async () => {
  const docker = fakeDocker({});
  const { out } = await scan(
    { host: false, containers: ["web", "gone"] },
    docker.run,
  );
  const s = out.summary as { errors: { target: string; error: string }[] };
  assertEquals(s.errors.map((e) => e.target), ["gone"]);
  assertStringIncludes(s.errors[0].error, "No container gone");
  assert(!docker.calls.some((c) => c.startsWith("docker cp -L gone:")));
});

Deno.test("scan keeps targets whose names would collide apart", async () => {
  const docker = fakeDocker({ "/etc/ssl/cert.pem": UNRELATED });
  const { out } = await scan(
    { host: false, images: ["app:1", "app-1"] },
    docker.run,
  );
  assertEquals(out["image-app-1"].target, "app:1");
  assertEquals(out["image-app-1-2"].target, "app-1");
});

Deno.test("assess keeps notes about bundles it couldn't read", () => {
  const t = assess(
    { target: "host", kind: "host", os: "linux", distro: null },
    [],
    [],
    [],
    {},
    ["Could not read /x.pem: Permission denied"],
  );
  assertEquals(t.findings[0], "Could not read /x.pem: Permission denied");
});

const bytes = (...parts: (Uint8Array | number[])[]) =>
  Uint8Array.from(parts.flatMap((p) => Array.from(p)));
const u16 = (n: number) => [n >> 8, n & 0xff];
const u32 = (
  n: number,
) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const utf = (s: string) => bytes(u16(s.length), new TextEncoder().encode(s));
const hexBytes = (h: string) => h.match(/../g)!.map((x) => parseInt(x, 16));

/** A DER element with a definite length. */
function der(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const body = bytes(...parts);
  const n = body.length;
  const len = n < 0x80
    ? [n]
    : n < 0x100
    ? [0x81, n]
    : n < 0x10000
    ? [0x82, n >> 8, n & 0xff]
    : [0x83, n >> 16, (n >> 8) & 0xff, n & 0xff];
  return bytes([tag], len, body);
}
const seq = (...p: Uint8Array[]) => der(0x30, ...p);
const oid = (h: string) => der(0x06, Uint8Array.from(hexBytes(h)));
const explicit0 = (...p: Uint8Array[]) => der(0xa0, ...p);
const octet = (...p: Uint8Array[]) => der(0x04, ...p);
const DATA = "2a864886f70d010701";

/** A password-less PKCS#12 trust store, as keytool writes cacerts. */
function pkcs12(certs: Uint8Array[], encryptedBag = false): Uint8Array {
  const bags = seq(
    ...certs.map((c) =>
      seq(
        oid("2a864886f70d010c0a0103"),
        explicit0(seq(oid("2a864886f70d01091601"), explicit0(octet(c)))),
      )
    ),
  );
  const infos = [seq(oid(DATA), explicit0(octet(bags)))];
  if (encryptedBag) {
    infos.push(seq(oid("2a864886f70d010706"), explicit0(seq())));
  }
  return seq(
    der(0x02, Uint8Array.from([3])),
    seq(oid(DATA), explicit0(octet(seq(...infos)))),
  );
}

/** A JKS keystore with trusted certificates and one key entry's chain. */
function jks(trusted: Uint8Array[], chain: Uint8Array[] = [], version = 2) {
  const cert = (c: Uint8Array) =>
    bytes(version === 2 ? utf("X.509") : [], u32(c.length), c);
  const entries = trusted.map((c, n) =>
    bytes(u32(2), utf(`ca${n}`), new Array(8).fill(0), cert(c))
  );
  if (chain.length) {
    entries.push(bytes(
      u32(1),
      utf("server"),
      new Array(8).fill(0),
      u32(3),
      [1, 2, 3],
      u32(chain.length),
      ...chain.map(cert),
    ));
  }
  return bytes(
    u32(0xfeedfeed),
    u32(version),
    u32(entries.length),
    ...entries,
    new Array(20).fill(0),
  );
}

const derOf = (pem: string) =>
  fromBase64(pem.replace(/-----[A-Z ]+-----/g, ""));
const AAA_DER = fromBase64(AAA.der);
const ECC_DER = fromBase64(ECC.der);
const blockedCerts = (...shas: string[]) =>
  ["Algorithm=SHA-256", ...shas].join("\n") + "\n";

Deno.test("readKeystore reads JKS trusted entries and key chains", () => {
  for (const version of [1, 2]) {
    const ks = readKeystore(
      jks([derOf(UNRELATED), AAA_DER], [ECC_DER], version),
    );
    assertEquals(ks.format, "jks");
    assertEquals(ks.certificates.length, 3);
    assertEquals(ks.certificates[1], AAA_DER);
  }
});

Deno.test("readKeystore reads password-less PKCS#12 and notes encrypted bags", () => {
  const ks = readKeystore(pkcs12([AAA_DER, derOf(UNRELATED)]));
  assertEquals(ks.format, "pkcs12");
  assertEquals(ks.certificates.length, 2);
  assertEquals(ks.encrypted, false);
  assert(readKeystore(pkcs12([AAA_DER], true)).encrypted);
});

Deno.test("readKeystore rejects what isn't a keystore", () => {
  let error: Error | undefined;
  try {
    readKeystore(new TextEncoder().encode("hello"));
  } catch (err) {
    error = err as Error;
  }
  assertStringIncludes(error!.message, "Not a JKS or PKCS#12 keystore");
});

Deno.test("parseBlockedCerts reads SHA-256 block lists only", () => {
  const sha = INTERMEDIATES[0].sha256;
  assertEquals(
    parseBlockedCerts(blockedCerts(sha.toLowerCase(), "nonsense")),
    new Set([sha]),
  );
  assertEquals(parseBlockedCerts("Algorithm=SHA-1\nABCD\n"), null);
});

Deno.test("checkKeystore exposes both usages through AAA until blocked.certs refuses the intermediates", async () => {
  const store = pkcs12([derOf(UNRELATED), AAA_DER]);
  const open = await checkKeystore("/jdk/cacerts", "java", store, null);
  assertEquals(open.bundle.anchors, ["AAA Certificate Services"]);
  assertEquals(open.bundle.exposes, ["tls", "codeSigning"]);
  assertEquals(open.bundle.blocked, []);

  const aaa = INTERMEDIATES.filter((i) =>
    i.issuedBy === "AAA Certificate Services"
  );
  const tlsOnly = aaa.filter((i) => i.usage.includes("tls"));
  const some = await checkKeystore(
    "/jdk/cacerts",
    "java",
    store,
    blockedCerts(...tlsOnly.map((i) => i.sha256)),
  );
  assertEquals(some.bundle.exposes, ["codeSigning"]);
  assertEquals(some.bundle.blocked!.length, 6);
  assertStringIncludes(
    some.bundle.blocked![0],
    "(issued by AAA Certificate Services)",
  );

  const all = await checkKeystore(
    "/jdk/cacerts",
    "java",
    store,
    blockedCerts(...aaa.map((i) => i.sha256)),
  );
  assertEquals(all.bundle.exposes, []);
});

Deno.test("checkKeystore follows emSign ECC Root CA - G3 to the TLS intermediates", async () => {
  const store = jks([ECC_DER]);
  const open = await checkKeystore("/k.jks", "java", store, null);
  assertEquals(open.bundle.exposes, ["tls"]);
  const viaTls = INTERMEDIATES.filter((i) =>
    i.issuedBy === "emSign Root TLS CA - G3"
  );
  const blocked = await checkKeystore(
    "/k.jks",
    "java",
    store,
    blockedCerts(...viaTls.map((i) => i.sha256)),
  );
  assertEquals(blocked.bundle.exposes, []);
});

Deno.test("checkKeystore notes what it couldn't read", async () => {
  const r = await checkKeystore(
    "/k.p12",
    "extra",
    pkcs12([derOf(UNRELATED)], true),
    "Algorithm=MD5\n",
  );
  assertEquals(r.bundle.exposes, []);
  assertStringIncludes(r.notes[0], "password-protected");
  assertStringIncludes(r.notes[1], "not SHA-256");
});

Deno.test("toolchain knows the patched Electron lines and that Deno has no release yet", () => {
  assertEquals(toolchain("electron", "43.6.0").status, "outdated");
  assertEquals(toolchain("electron", "43.8.1").status, "patched");
  assertEquals(toolchain("electron", "38.2.0").status, "outdated");
  assertEquals(toolchain("electron", "45.0.0").status, "patched");
  const deno = swampDeno({
    version: "2.9.7",
    execPath: "/usr/local/bin/swamp",
  });
  assertEquals(deno.status, "outdated");
  assertEquals(deno.path, "/usr/local/bin/swamp");
  assertStringIncludes(deno.note!, "denoland/deno#37046");
  assert(!isPatched("9.9.9", [], 2), "no release has the fix");
});

Deno.test("assess explains outdated apps and swamp's Deno", () => {
  const t = assess(
    { target: "host", kind: "host", os: "darwin", distro: null },
    [],
    [],
    [
      toolchain("electron", "38.2.0", "/Applications/Roam.app"),
      swampDeno({ version: "2.9.7", execPath: "/usr/local/bin/swamp" }),
    ],
  );
  assertEquals(t.tls, "exposed");
  assertEquals(
    t.findings[0],
    "/Applications/Roam.app (electron 38.2.0) predates the fix (42.11.16, 43.8.1, 44.9.1)",
  );
  assertStringIncludes(
    t.remediation[0],
    "/Applications/Roam.app: update the app",
  );
  assertStringIncludes(
    t.remediation[1],
    "DENO_TLS_CA_STORE=system doesn't help",
  );
});

Deno.test("electronVersion finds the version across a chunk boundary", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = `${dir}/app`;
    const marker = new TextEncoder().encode("Electron/43.6.0 ");
    const data = new Uint8Array((4 << 20) + 64);
    data.set(marker, (4 << 20) - 5);
    await Deno.writeFile(path, data);
    assertEquals(await electronVersion(path), "43.6.0");
    await Deno.writeFile(path, new Uint8Array(100));
    assertEquals(await electronVersion(path), null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("electronApps finds apps with resources/app in the install directory or one below", async () => {
  const root = await Deno.makeTempDir();
  const exe = (v: string) =>
    new TextEncoder().encode(`${"x".repeat(2000)}Electron/${v}`);
  const put = async (path: string, data: Uint8Array) => {
    await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), { recursive: true });
    await Deno.writeFile(path, data);
  };
  try {
    // An installer that keeps resources in a versioned folder, like VS Code.
    await put(`${root}/Code/Code.exe`, exe("43.6.0"));
    await Deno.mkdir(`${root}/Code/2242ebbb54/resources/app`, {
      recursive: true,
    });
    // A Squirrel app, next to a small uninstaller.
    await put(`${root}/slack/app-4.4/slack.exe`, exe("44.9.1"));
    await put(`${root}/slack/app-4.4/resources/app.asar`, new Uint8Array(1));
    await put(`${root}/slack/Update.exe`, exe("1.0.0").subarray(0, 100));
    // Chromium without an app is not Electron.
    await put(`${root}/Chrome/chrome.exe`, exe("1.2.3"));
    const apps = await electronApps([root], "windows", 1000);
    assertEquals(
      apps.map((a) => [a.path!.slice(root.length + 1), a.version, a.status]),
      [["Code", "43.6.0", "outdated"], ["slack", "44.9.1", "patched"]],
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("hostKeystores finds Java homes, bundled runtimes and the java on PATH", async () => {
  const root = await Deno.makeTempDir();
  const home = await Deno.makeTempDir();
  const sep = Deno.build.os === "windows" ? "\\" : "/";
  const security = (h: string) => `${h}/lib/security`;
  try {
    for (
      const h of [
        `${root}/Eclipse Adoptium/jdk-21`,
        `${root}/JetBrains/IDEA/jbr`,
        home,
      ]
    ) {
      await Deno.mkdir(security(h), { recursive: true });
      await Deno.writeFile(`${security(h)}/cacerts`, pkcs12([AAA_DER]));
    }
    await Deno.writeTextFile(
      `${security(`${root}/JetBrains/IDEA/jbr`)}/blocked.certs`,
      blockedCerts(...INTERMEDIATES.map((i) => i.sha256)),
    );
    const run = (cmd: string) =>
      Promise.resolve(
        cmd === "java"
          ? {
            code: 0,
            stdout: "",
            stderr: `Property settings:\n    java.home = ${home}\n`,
          }
          : missing,
      );
    const p: Platform = { os: "windows", env: () => undefined };
    const refs = await hostKeystores(run, p, [root]);
    assertEquals(refs.length, 3);
    assertEquals(refs[0].path, `${home}${sep}lib${sep}security${sep}cacerts`);
    const { bundles, notes } = await readHostKeystores([
      ...refs,
      { path: `${root}/missing.jks`, source: "extra" },
    ]);
    assertEquals(bundles.map((b) => b.exposes.length), [2, 2, 0]);
    assertStringIncludes(notes[0], "missing.jks");
  } finally {
    await Deno.remove(root, { recursive: true });
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("inspectJavaHome reads the environment from inspect", () => {
  assertEquals(
    inspectJavaHome(
      '[{"Config":{"Env":["PATH=/bin","JAVA_HOME=/opt/java/openjdk"]}}]',
    ),
    "/opt/java/openjdk",
  );
  assertEquals(inspectJavaHome("[{}]"), null);
});

Deno.test("scan reads an image's JAVA_HOME keystore and its block list", async () => {
  const store = pkcs12([AAA_DER]);
  const docker = fakeDocker(
    {
      "/opt/java/openjdk/lib/security/cacerts": store,
      "/opt/java/openjdk/lib/security/blocked.certs": blockedCerts(
        ...INTERMEDIATES.filter((i) => i.usage.includes("codeSigning")).map(
          (i) => i.sha256,
        ),
      ),
      // The distribution's store holds the same bytes; it is read once.
      "/etc/ssl/certs/java/cacerts": store,
    },
    ["JAVA_HOME=/opt/java/openjdk"],
  );
  const { out, error } = await scan(
    { host: false, images: ["eclipse-temurin:21"] },
    docker.run,
  );
  assertEquals(error, undefined);
  const t = out["image-eclipse-temurin-21"];
  assertEquals([t.tls, t.codeSigning], ["exposed", "protected"]);
  const bundles = t.bundles as { path: string; source: string }[];
  assertEquals(bundles.map((b) => b.path), [
    "/opt/java/openjdk/lib/security/cacerts",
  ]);
  assertStringIncludes(
    (t.remediation as string[])[0],
    "update this Java runtime",
  );
});

Deno.test("scan checks swamp's own Deno, Java and Electron apps on the host", async () => {
  const home = await Deno.makeTempDir();
  try {
    const jdk =
      `${home}/Library/Java/JavaVirtualMachines/jdk-21.jdk/Contents/Home`;
    await Deno.mkdir(`${jdk}/lib/security`, { recursive: true });
    await Deno.writeFile(`${jdk}/lib/security/cacerts`, jks([ECC_DER]));
    const fw =
      `${home}/Applications/Roam.app/Contents/Frameworks/Electron Framework.framework/Resources`;
    await Deno.mkdir(fw, { recursive: true });
    await Deno.writeTextFile(
      `${fw}/Info.plist`,
      "<dict>\n<key>CFBundleVersion</key>\n<string>38.2.0</string>\n</dict>",
    );
    const test = createModelTestContext({
      globalArgs: model.globalArguments.parse({}),
      methodName: "scan",
    });
    const m = model.methods.scan;
    await m.execute(
      {
        ...m.arguments.parse({}),
        _run: () => Promise.resolve(missing),
        _platform: {
          os: "darwin",
          env: (n: string) => n === "HOME" ? home : undefined,
        },
        _deno: { version: "2.9.7", execPath: "/usr/local/bin/swamp" },
      },
      test.context as unknown as Ctx,
    );
    const host = test.getWrittenResources().find((r) => r.name === "host")!
      .data as {
        toolchains: { tool: string; path?: string; status: string }[];
        bundles: { path: string; exposes: string[] }[];
        tls: string;
      };
    assertEquals(host.tls, "exposed");
    assert(
      host.toolchains.some((t) =>
        t.tool === "deno" && t.path === "/usr/local/bin/swamp" &&
        t.status === "outdated"
      ),
    );
    assert(
      host.toolchains.some((t) =>
        t.tool === "electron" && t.path!.endsWith("Roam.app")
      ),
    );
    assert(
      host.bundles.some((b) =>
        b.path.includes("jdk-21.jdk") && b.exposes.join() === "tls"
      ),
    );
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("the upgrade gives 2026.10.21.1 instances an empty keystores list", () => {
  const [up] = model.upgrades;
  assertEquals(up.toVersion, model.version);
  const old = { host: false, images: ["debian:bookworm"] };
  const upgraded = up.upgradeAttributes(old);
  assertEquals(upgraded, {
    keystores: [],
    host: false,
    images: ["debian:bookworm"],
  });
  assertEquals(model.globalArguments.parse(upgraded).keystores, []);
  // An instance that already has keystores keeps them.
  assertEquals(
    up.upgradeAttributes({ keystores: ["/k.jks"] }).keystores,
    ["/k.jks"],
  );
});
