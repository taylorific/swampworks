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
  checkRuntime,
  distroFix,
  hostBundles,
  isPatched,
  macVerdict,
  model,
  parseOsRelease,
  type Platform,
  type RunResult,
  slug,
  windowsVerdict,
} from "./emudhra_exposure.ts";
import {
  ANCHORS,
  CROSS_SIGNED_TLS_ROOT,
  INTERMEDIATES,
} from "./_lib/indicators.ts";
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

/** A fake docker: `cp` writes the files in `fs`, other calls are recorded. */
function fakeDocker(fs: Record<string, string>) {
  const calls: string[] = [];
  const run = async (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    if (cmd !== "docker") return missing;
    if (args[0] === "create") return ok("abc123");
    if (args[0] === "rm") return ok();
    if (args[0] === "inspect") {
      return args[1] === "web" ? ok("[{}]") : {
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
      await Deno.writeTextFile(args[3], fs[path]);
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
