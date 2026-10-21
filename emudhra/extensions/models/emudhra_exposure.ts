import { z } from "npm:zod@4";
import {
  ANCHORS,
  CROSS_SIGNED_TLS_ROOT,
  type Indicator,
  INTERMEDIATES,
  type Usage,
} from "./_lib/indicators.ts";
import { hashBundle, toPem } from "./_lib/x509.ts";

// Exposure to the eMudhra intermediates whose private keys anyone can
// recover (https://emudhra.we-have-a-problem.com/, disclosed 2026-10-20).
// `scan` looks at the machine swamp runs on and at any container images or
// running containers named in the arguments, and records for each whether it
// still trusts those intermediates for TLS or code signing:
//
// - PEM CA bundles (the system bundle, Homebrew, Python certifi, pip, Git for
//   Windows, and any others named) are exposed when they hold a compromised
//   intermediate or a root it chains to, matched by public key.
// - On macOS and Windows the OS verifier is asked about each intermediate:
//   `security verify-cert` and CryptoAPI through .NET's X509Chain. Both see
//   the vendors' block lists, which a PEM bundle never does.
// - Node.js and Go carry their own roots, so their versions are compared
//   with the patched releases the page lists.
//
// Nothing is changed. Containers are read with `docker cp` or `container cp`;
// an image gets a container created for the copy and removed after.

const RUNTIMES = ["docker", "container"] as const;
type Runtime = typeof RUNTIMES[number];

const GlobalArgsSchema = z.object({
  host: z.boolean().default(true).describe(
    "Scan the machine swamp runs on",
  ),
  images: z.array(z.string().min(1)).default([]).describe(
    'Container images to scan, e.g. ["debian:bookworm", "python:3.12-slim"]',
  ),
  containers: z.array(z.string().min(1)).default([]).describe(
    "Running containers to scan, by name or ID",
  ),
  runtime: z.enum(RUNTIMES).default("docker").describe(
    "Container runtime: docker (or podman via runtimePath), or container (Apple's container CLI)",
  ),
  runtimePath: z.string().optional().describe(
    "Path to the runtime CLI if it is not `docker`/`container` on PATH",
  ),
  bundles: z.array(z.string().min(1)).default([]).describe(
    "More PEM CA bundles to check, on the host and in every container",
  ),
  toolchains: z.boolean().default(true).describe(
    "On the host, also check Python certifi, pip, Node.js and Go",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ScanArgsSchema = z.object({
  failOnExposed: z.boolean().default(false).describe(
    "Fail the run, after recording the results, when any target is exposed",
  ),
});
type ScanArgs = z.infer<typeof ScanArgsSchema>;

const STATUS = ["exposed", "protected", "unknown"] as const;
/** Whether a target trusts the compromised intermediates for a usage. */
export type Status = typeof STATUS[number];

const BundleSchema = z.object({
  path: z.string(),
  source: z.string(),
  certificates: z.number(),
  anchors: z.array(z.string()),
  intermediates: z.array(z.string()),
  exposes: z.array(z.enum(["tls", "codeSigning"])),
});
/** What one PEM bundle trusts. */
export type Bundle = z.infer<typeof BundleSchema>;

const VERDICTS = ["trusted", "blocked", "untrusted", "error"] as const;
const NativeSchema = z.object({
  verifier: z.string(),
  name: z.string(),
  issuedBy: z.string(),
  usage: z.enum(["tls", "codeSigning"]),
  verdict: z.enum(VERDICTS),
  detail: z.string(),
});
/** The OS verifier's answer for one intermediate. */
export type NativeResult = z.infer<typeof NativeSchema>;

const ToolchainSchema = z.object({
  tool: z.string(),
  version: z.string(),
  fixedIn: z.array(z.string()),
  status: z.enum(["patched", "outdated"]),
});
/** A toolchain that carries its own roots. */
export type Toolchain = z.infer<typeof ToolchainSchema>;

const TargetSchema = z.object({
  target: z.string(),
  kind: z.enum(["host", "image", "container"]),
  os: z.string(),
  distro: z.string().nullable(),
  status: z.enum(STATUS),
  tls: z.enum(STATUS),
  codeSigning: z.enum(STATUS),
  bundles: z.array(BundleSchema),
  native: z.array(NativeSchema),
  toolchains: z.array(ToolchainSchema),
  findings: z.array(z.string()),
  remediation: z.array(z.string()),
  checkedAt: z.string(),
});
/** The scan of one machine, image or container. */
export type Target = z.infer<typeof TargetSchema>;

const SummarySchema = z.object({
  exposed: z.array(z.string()),
  protected: z.array(z.string()),
  unknown: z.array(z.string()),
  errors: z.array(z.object({ target: z.string(), error: z.string() })),
  checkedAt: z.string(),
});

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

interface Context {
  globalArgs: GlobalArgs;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

interface CheckContext {
  globalArgs: GlobalArgs;
}

/** Result of one command. `code` is 127 when the command can't be run. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with the given arguments. Injectable for tests. */
export type Run = (cmd: string, args: string[]) => Promise<RunResult>;

/** The operating system and the environment. */
export interface Platform {
  os: string;
  env: (name: string) => string | undefined;
}

/** Test seams accepted by `scan`. */
export interface Seams {
  _run?: Run;
  _platform?: Platform;
}

/** Runs real commands, reporting one that can't be started as code 127. */
export function commandRunner(timeoutMs = 120000): Run {
  return async (cmd, args) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs the container runtime, security, powershell, python and version queries; argument lists are built in this file, see README What it runs
      out = await new Deno.Command(cmd, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(timeoutMs),
      }).output();
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}

/** The platform swamp is running on. */
export function hostPlatform(): Platform {
  return { os: Deno.build.os, env: (name) => Deno.env.get(name) };
}

/** Where distributions keep their PEM CA bundles. */
export const LINUX_BUNDLES = [
  "/etc/ssl/certs/ca-certificates.crt", // Debian, Ubuntu, Alpine, Arch, Gentoo
  "/etc/pki/tls/certs/ca-bundle.crt", // Fedora, RHEL and rebuilds
  "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",
  "/etc/pki/ca-trust/extracted/pem/objsign-ca-bundle.pem",
  "/etc/ssl/ca-bundle.pem", // openSUSE, SLES
  "/var/lib/ca-certificates/ca-bundle.pem",
  "/etc/ssl/cert.pem", // Alpine, BSD
];

/** The PEM bundles OpenSSL-based tools use on macOS, system and Homebrew. */
export const MACOS_BUNDLES = [
  "/etc/ssl/cert.pem",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
  "/usr/local/etc/ca-certificates/cert.pem",
  "/opt/homebrew/etc/openssl@3/cert.pem",
  "/usr/local/etc/openssl@3/cert.pem",
];

/** The bundles to look for on a host, labelled by where they come from. */
export function hostBundles(
  p: Platform,
  extra: string[],
): { path: string; source: string }[] {
  const list: { path: string; source: string }[] = [];
  if (p.os === "darwin") {
    for (const path of MACOS_BUNDLES) {
      list.push({
        path,
        source: path.startsWith("/etc/") ? "system" : "homebrew",
      });
    }
  } else if (p.os === "windows") {
    // Git for Windows, installed for everyone or for one user.
    const gits = [
      p.env("ProgramFiles") && `${p.env("ProgramFiles")}\\Git`,
      p.env("LOCALAPPDATA") && `${p.env("LOCALAPPDATA")}\\Programs\\Git`,
    ];
    for (const git of gits) {
      if (!git) continue;
      list.push({
        path: `${git}\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt`,
        source: "git for windows",
      });
    }
  } else {
    for (const path of LINUX_BUNDLES) list.push({ path, source: "system" });
  }
  for (const path of extra) list.push({ path, source: "extra" });
  return list;
}

/** Usages for which a bundle holding these indicators can be abused. */
function usagesOf(found: Indicator[]): Usage[] {
  const u = new Set(found.flatMap((i) => i.usage));
  return (["tls", "codeSigning"] as const).filter((x) => u.has(x));
}

/**
 * What a bundle is used to verify. Distribution and toolchain bundles hold
 * the roots trusted for TLS; Fedora's objsign bundle those for code signing.
 * A bundle named in the arguments could be for either.
 */
export function bundlePurpose(path: string, source: string): Usage[] {
  if (source === "extra") return ["tls", "codeSigning"];
  return /objsign/.test(path) ? ["codeSigning"] : ["tls"];
}

/** Matches a bundle's certificates against the indicators by public key. */
export async function checkBundle(
  path: string,
  source: string,
  text: string,
): Promise<Bundle> {
  const certs = await hashBundle(text);
  const keys = new Set(certs.map((c) => c.spkiSha256));
  const anchors = ANCHORS.filter((a) => keys.has(a.spkiSha256));
  const inters = INTERMEDIATES.filter((i) => keys.has(i.spkiSha256));
  return {
    path,
    source,
    certificates: certs.length,
    anchors: anchors.map((a) => a.name),
    intermediates: [...new Set(inters.map((i) => i.name))],
    exposes: usagesOf([...anchors, ...inters]).filter((u) =>
      bundlePurpose(path, source).includes(u)
    ),
  };
}

/** The verdict `security verify-cert -v` gives for one certificate. */
export function macVerdict(
  r: RunResult,
): { verdict: NativeResult["verdict"]; detail: string } {
  const out = `${r.stdout}\n${r.stderr}`;
  if (r.code === 127) return { verdict: "error", detail: r.stderr };
  if (r.code === 0) {
    return { verdict: "trusted", detail: "verification successful" };
  }
  if (/isRevoked = 1|certificate is revoked/i.test(out)) {
    return { verdict: "blocked", detail: "revoked" };
  }
  const reason = out.match(/NSLocalizedDescription=([^,}]+)/)?.[1]?.trim();
  return { verdict: "untrusted", detail: reason ?? "verification failed" };
}

/** Asks the macOS Security framework about each intermediate. */
async function macNative(run: Run, dir: string): Promise<NativeResult[]> {
  const cross = `${dir}/cross.pem`;
  await Deno.writeTextFile(cross, toPem(CROSS_SIGNED_TLS_ROOT));
  const out: NativeResult[] = [];
  for (const [n, i] of INTERMEDIATES.entries()) {
    const file = `${dir}/intermediate-${n}.pem`;
    await Deno.writeTextFile(file, toPem(i.der));
    // -l: the certificate is a CA; -L: no fetching. Apple's block list is
    // local, so it still applies.
    const r = await run("security", [
      "verify-cert",
      "-c",
      file,
      "-c",
      cross,
      "-l",
      "-L",
      "-p",
      "basic",
      "-v",
    ]);
    out.push({
      verifier: "macos-security",
      name: i.name,
      issuedBy: i.issuedBy,
      usage: i.usage[0],
      ...macVerdict(r),
    });
  }
  return out;
}

/**
 * Builds a chain for each certificate with .NET's X509Chain, which on
 * Windows is CryptoAPI: the Root, AuthRoot and Disallowed stores and the
 * automatic root and disallowed-list updates.
 */
export const WINDOWS_SCRIPT = `param([string]$Data)
$ErrorActionPreference = 'Stop'
$in = Get-Content -Raw -LiteralPath $Data | ConvertFrom-Json
$T = 'System.Security.Cryptography.X509Certificates.X509Certificate2'
$extra = @($in.extra | ForEach-Object { New-Object $T -ArgumentList (,[Convert]::FromBase64String($_)) })
$results = foreach ($c in $in.certs) {
  $cert = New-Object $T -ArgumentList (,[Convert]::FromBase64String($c.der))
  $chain = New-Object System.Security.Cryptography.X509Certificates.X509Chain
  $chain.ChainPolicy.RevocationMode = 'NoCheck'
  foreach ($e in $extra) { [void]$chain.ChainPolicy.ExtraStore.Add($e) }
  $ok = $chain.Build($cert)
  $subjects = @($chain.ChainElements | ForEach-Object { $_.Certificate.Subject })
  [pscustomobject]@{
    sha256 = $c.sha256
    ok = $ok
    status = @($chain.ChainStatus | ForEach-Object { $_.Status.ToString() })
    root = $(if ($subjects.Count) { $subjects[-1] } else { $null })
  }
  $chain.Reset()
}
ConvertTo-Json -InputObject @($results) -Depth 4 -Compress
`;

interface WindowsChain {
  sha256: string;
  ok: boolean;
  status: string[];
  root: string | null;
}

/** The verdict for one chain X509Chain built. */
export function windowsVerdict(
  c: WindowsChain,
): { verdict: NativeResult["verdict"]; detail: string } {
  if (c.status.includes("ExplicitDistrust")) {
    return { verdict: "blocked", detail: "in the Disallowed store" };
  }
  if (c.ok) return { verdict: "trusted", detail: `chains to ${c.root}` };
  return {
    verdict: "untrusted",
    detail: c.status.join(", ") || "chain did not build",
  };
}

/** Asks CryptoAPI about each intermediate. */
async function windowsNative(run: Run, dir: string): Promise<NativeResult[]> {
  const script = `${dir}\\scan.ps1`;
  const data = `${dir}\\data.json`;
  await Deno.writeTextFile(script, WINDOWS_SCRIPT);
  await Deno.writeTextFile(
    data,
    JSON.stringify({
      extra: [CROSS_SIGNED_TLS_ROOT.replace(/\s+/g, "")],
      certs: INTERMEDIATES.map((i) => ({
        sha256: i.sha256,
        der: i.der.replace(/\s+/g, ""),
      })),
    }),
  );
  const r = await run("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    script,
    "-Data",
    data,
  ]);
  const fail = (detail: string) =>
    INTERMEDIATES.map((i): NativeResult => ({
      verifier: "windows-cryptoapi",
      name: i.name,
      issuedBy: i.issuedBy,
      usage: i.usage[0],
      verdict: "error",
      detail,
    }));
  if (r.code !== 0) return fail(r.stderr || `powershell exited ${r.code}`);
  let chains: WindowsChain[];
  try {
    chains = JSON.parse(r.stdout);
  } catch {
    return fail(`unreadable output: ${r.stdout.slice(0, 200)}`);
  }
  const bySha = new Map(chains.map((c) => [c.sha256, c]));
  return INTERMEDIATES.map((i) => {
    const c = bySha.get(i.sha256);
    return {
      verifier: "windows-cryptoapi",
      name: i.name,
      issuedBy: i.issuedBy,
      usage: i.usage[0],
      ...(c
        ? windowsVerdict(c)
        : { verdict: "error" as const, detail: "no result" }),
    };
  });
}

/** Patched releases per line, from the page. Lines not listed have no fix. */
export const PATCHED: Record<string, string[]> = {
  node: ["22.23.4", "24.22.1", "26.12.1"],
  go: ["1.26.10", "1.27.3"],
};

function parts(v: string): number[] {
  return v.split(".").map((x) => parseInt(x, 10) || 0);
}

function compare(a: string, b: string): number {
  const x = parts(a), y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Whether a version has the fix: at or past the patched release on its
 * line, or on a line newer than every patched one. `lineParts` is how many
 * leading numbers name a line (1 for Node majors, 2 for Go).
 */
export function isPatched(
  version: string,
  fixed: string[],
  lineParts: number,
): boolean {
  const line = (v: string) => parts(v).slice(0, lineParts).join(".");
  const own = fixed.find((f) => line(f) === line(version));
  if (own) return compare(version, own) >= 0;
  const newest = fixed.reduce((a, b) => compare(a, b) >= 0 ? a : b);
  return compare(line(version), line(newest)) > 0;
}

/** Node.js and Go versions on PATH, against the patched releases. */
async function toolchainVersions(run: Run): Promise<Toolchain[]> {
  const out: Toolchain[] = [];
  const node = await run("node", ["--version"]);
  const nv = node.code === 0
    ? node.stdout.match(/v?(\d+\.\d+\.\d+)/)?.[1]
    : undefined;
  if (nv) {
    out.push({
      tool: "node",
      version: nv,
      fixedIn: PATCHED.node,
      status: isPatched(nv, PATCHED.node, 1) ? "patched" : "outdated",
    });
  }
  const go = await run("go", ["version"]);
  const gv = go.code === 0
    ? go.stdout.match(/go(\d+\.\d+(?:\.\d+)?)/)?.[1]
    : undefined;
  if (gv) {
    out.push({
      tool: "go",
      version: gv,
      fixedIn: PATCHED.go,
      status: isPatched(gv, PATCHED.go, 2) ? "patched" : "outdated",
    });
  }
  return out;
}

/** Python's certifi bundle and the one pip vendors, where Python has them. */
async function pythonBundles(
  run: Run,
  p: Platform,
): Promise<{ path: string; source: string }[]> {
  const pythons = p.os === "windows" ? ["python", "py"] : ["python3", "python"];
  for (const py of pythons) {
    const r = await run(py, [
      "-c",
      [
        "import importlib",
        "for name, mod in (('certifi', 'certifi'), ('pip', 'pip._vendor.certifi')):",
        "    try: print(name + '\\t' + importlib.import_module(mod).where())",
        "    except Exception: pass",
      ].join("\n"),
    ]);
    if (r.code === 127) continue;
    return r.stdout.split("\n").filter((l) => l.includes("\t")).map((l) => {
      const [name, path] = l.split("\t");
      return {
        path: path.trim(),
        source: name === "pip" ? "pip" : "python certifi",
      };
    });
  }
  return [];
}

/** The fields of an os-release file. */
export function parseOsRelease(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
  return out;
}

/** What the page says to do for a distribution's system bundle. */
export function distroFix(release: Record<string, string>): string {
  const ids = [release.ID, ...(release.ID_LIKE ?? "").split(/\s+/)];
  const has = (...names: string[]) => names.some((n) => ids.includes(n));
  if (has("ubuntu")) {
    return "Upgrade ca-certificates to 20260816ubuntu0.<release>.1 (22.04, 24.04, 26.04, 26.10)";
  }
  if (has("debian")) {
    return "Upgrade ca-certificates to 20250419~deb12u2 (bookworm), 20250419+deb13u1 (trixie) or 20260816+nmu1";
  }
  if (has("alpine")) return "Upgrade ca-certificates to 20261020-r0";
  if (has("wolfi", "chainguard")) {
    return "Upgrade ca-certificates to 20260909-r3";
  }
  if (has("fedora", "rhel", "centos", "rocky", "almalinux", "amzn")) {
    return "Upgrade ca-certificates (Fedora 2026.2.92_v9.0.319), or put Comodo_AAA_Services_root.pem and emSign_ECC_Root_CA_-_G3.pem in /etc/pki/ca-trust/source/blocklist and run update-ca-trust";
  }
  if (has("opensuse", "suse", "sles")) {
    return "Put Comodo_AAA_Services_root.pem and emSign_ECC_Root_CA_-_G3.pem in /etc/pki/trust/blocklist and run update-ca-certificates";
  }
  if (has("arch")) return "Upgrade ca-certificates-mozilla to 3.131.1-1";
  if (has("gentoo")) return "Upgrade ca-certificates to 20260816.3.125";
  if (has("nixos")) {
    return 'Add "Comodo AAA Services root" and "emSign ECC Root CA - G3" to security.pki.caCertificateBlacklist';
  }
  return "Remove AAA Certificate Services and emSign ECC Root CA - G3 from the system CA bundle, or upgrade ca-certificates";
}

/** What to do about one exposed bundle. */
function bundleFix(
  b: Bundle,
  kind: Target["kind"],
  release: Record<string, string>,
): string {
  const where = `${b.path}: `;
  switch (b.source) {
    case "homebrew":
      return `${where}brew upgrade ca-certificates`;
    case "python certifi":
      return `${where}upgrade certifi to 2026.10.19 or later`;
    case "pip":
      return `${where}upgrade pip to 26.2.2 or later`;
    case "git for windows":
      return `${where}upgrade Git for Windows, or switch http.sslBackend to schannel`;
    case "extra":
      return `${where}remove the certificates listed for it`;
  }
  if (kind !== "host") {
    return `${where}rebuild the image on a base with patched ca-certificates (${
      distroFix(release)
    })`;
  }
  if (b.path === "/etc/ssl/cert.pem" && !release.ID) {
    return `${where}remove AAA Certificate Services and emSign ECC Root CA - G3 (see the macOS workaround on the page)`;
  }
  return `${where}${distroFix(release)}`;
}

/** Rolls bundles, native verdicts and toolchains into a target's result. */
export function assess(
  base: Pick<Target, "target" | "kind" | "os" | "distro">,
  bundles: Bundle[],
  native: NativeResult[],
  toolchains: Toolchain[],
  release: Record<string, string> = {},
  notes: string[] = [],
): Target {
  const findings: string[] = [...notes];
  const remediation: string[] = [];
  const exposed = { tls: false, codeSigning: false };
  for (const b of bundles) {
    if (!b.exposes.length) continue;
    for (const u of b.exposes) exposed[u] = true;
    findings.push(
      `${b.path} trusts ${[...b.anchors, ...b.intermediates].join(", ")}`,
    );
    remediation.push(bundleFix(b, base.kind, release));
  }
  const trusted = native.filter((n) => n.verdict === "trusted");
  for (const n of trusted) {
    exposed[n.usage] = true;
    findings.push(
      `${n.verifier} trusts ${n.name} (issued by ${n.issuedBy}): ${n.detail}`,
    );
  }
  if (trusted.some((n) => n.verifier === "windows-cryptoapi")) {
    remediation.push(
      "Windows: let Windows Update refresh the disallowed certificate list (Microsoft blocked these 2026-10-20), or import the trusted intermediates into the Local Machine Disallowed store",
    );
  }
  if (trusted.some((n) => n.verifier === "macos-security")) {
    remediation.push(
      "macOS: install the latest security updates; the page lists no manual fix for the system trust store",
    );
  }
  for (const n of native.filter((n) => n.verdict === "error")) {
    findings.push(`${n.verifier} could not check ${n.name}: ${n.detail}`);
  }
  for (const t of toolchains.filter((t) => t.status === "outdated")) {
    exposed.tls = true;
    findings.push(
      `${t.tool} ${t.version} predates the fix (${t.fixedIn.join(", ")})`,
    );
    remediation.push(`Upgrade ${t.tool} to ${t.fixedIn.join(", ")} or later`);
  }
  const checked = bundles.length > 0 ||
    native.some((n) => n.verdict !== "error");
  const status = (u: Usage): Status =>
    exposed[u] ? "exposed" : checked ? "protected" : "unknown";
  const tls = status("tls");
  const codeSigning = status("codeSigning");
  if (!checked) {
    findings.push(
      "No CA bundle was found, so only clients that bring their own roots can make TLS connections; check those separately",
    );
  }
  return {
    ...base,
    status: tls === "exposed" || codeSigning === "exposed" ? "exposed" : tls,
    tls,
    codeSigning,
    bundles,
    native,
    toolchains,
    findings,
    remediation: [...new Set(remediation)],
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Reads each bundle that exists once, however many paths lead to it, and
 * lists the ones that exist but can't be read.
 */
async function readHostBundles(
  list: { path: string; source: string }[],
): Promise<{ bundles: Bundle[]; unreadable: string[] }> {
  const seen = new Set<string>();
  const out: Bundle[] = [];
  const unreadable: string[] = [];
  for (const { path, source } of list) {
    let real: string;
    let text: string;
    try {
      real = await Deno.realPath(path);
      if (seen.has(real)) continue;
      text = await Deno.readTextFile(real);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound && source !== "extra") continue;
      // A bundle we can't read may still be one that tools use.
      unreadable.push(`Could not read ${path}: ${(err as Error).message}`);
      continue;
    }
    seen.add(real);
    out.push(await checkBundle(path, source, text));
  }
  return { bundles: out, unreadable };
}

/** macOS version, or the os-release fields on Linux. */
async function hostRelease(
  run: Run,
  p: Platform,
): Promise<{ distro: string | null; release: Record<string, string> }> {
  if (p.os === "darwin") {
    const r = await run("sw_vers", ["-productVersion"]);
    return {
      distro: r.code === 0 ? `macOS ${r.stdout}` : "macOS",
      release: {},
    };
  }
  if (p.os === "windows") return { distro: "Windows", release: {} };
  for (const f of ["/etc/os-release", "/usr/lib/os-release"]) {
    try {
      const release = parseOsRelease(await Deno.readTextFile(f));
      return { distro: release.PRETTY_NAME ?? release.ID ?? null, release };
    } catch { /* try the next */ }
  }
  return { distro: null, release: {} };
}

async function scanHost(
  g: GlobalArgs,
  run: Run,
  p: Platform,
): Promise<Target> {
  const dir = await Deno.makeTempDir({ prefix: "emudhra-" });
  try {
    const { distro, release } = await hostRelease(run, p);
    const list = hostBundles(p, g.bundles);
    let toolchains: Toolchain[] = [];
    if (g.toolchains) {
      list.push(...await pythonBundles(run, p));
      toolchains = await toolchainVersions(run);
    }
    const { bundles, unreadable } = await readHostBundles(list);
    const native = p.os === "darwin"
      ? await macNative(run, dir)
      : p.os === "windows"
      ? await windowsNative(run, dir)
      : [];
    return assess(
      { target: "host", kind: "host", os: p.os, distro },
      bundles,
      native,
      toolchains,
      release,
      unreadable,
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Copies one file out of a container; null when it isn't there. */
async function copyOut(
  run: Run,
  bin: string,
  runtime: Runtime,
  id: string,
  path: string,
  dest: string,
): Promise<string | null> {
  // docker cp copies a symlink as a link unless told to follow it; Apple's
  // container cp follows it.
  const args = runtime === "docker"
    ? ["cp", "-L", `${id}:${path}`, dest]
    : ["cp", `${id}:${path}`, dest];
  const r = await run(bin, args);
  if (r.code !== 0) return null;
  try {
    return await Deno.readTextFile(dest);
  } catch {
    return null;
  }
}

/** The CLI calls that differ between Docker and Apple's container CLI. */
export const RUNTIME_ARGS: Record<
  Runtime,
  {
    start: (image: string, name: string) => string[];
    remove: (name: string) => string[];
  }
> = {
  // A created container is enough for docker cp, so images without a shell
  // (distroless, scratch) work.
  docker: {
    start: (image, name) => [
      "create",
      "--name",
      name,
      "--label",
      "emudhra-scan=1",
      image,
      "true",
    ],
    remove: (name) => ["rm", "--force", name],
  },
  // Apple's container cp needs a running container, so the image needs sleep.
  container: {
    start: (image, name) => [
      "run",
      "--detach",
      "--rm",
      "--name",
      name,
      "--entrypoint",
      "sleep",
      image,
      "600",
    ],
    remove: (name) => ["delete", "--force", name],
  },
};

/** A resource name for a target. */
export function slug(kind: string, ref: string): string {
  return `${kind}-${
    ref.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/^-+|-+$/g, "")
  }`;
}

async function scanContainer(
  g: GlobalArgs,
  run: Run,
  kind: "image" | "container",
  ref: string,
): Promise<Target> {
  const bin = g.runtimePath ?? g.runtime;
  const rt = RUNTIME_ARGS[g.runtime];
  const dir = await Deno.makeTempDir({ prefix: "emudhra-" });
  let id = ref;
  let created = false;
  try {
    if (kind === "image") {
      id = `emudhra-scan-${crypto.randomUUID().slice(0, 8)}`;
      const r = await run(bin, rt.start(ref, id));
      if (r.code !== 0) {
        throw new Error(
          `Could not ${
            g.runtime === "docker" ? "create" : "start"
          } a container from ${ref}: ${r.stderr || r.stdout}${
            g.runtime === "container"
              ? " (Apple's container CLI can only copy from a running container, so the image needs sleep; use runtime docker for images without it)"
              : ""
          }`,
        );
      }
      created = true;
    } else {
      // Every copy from a container that isn't there fails the same way a
      // missing file does, so make sure it's there first.
      const r = await run(bin, ["inspect", ref]);
      if (r.code !== 0) {
        throw new Error(`No container ${ref}: ${r.stderr || r.stdout}`);
      }
    }
    let release: Record<string, string> = {};
    for (const f of ["/etc/os-release", "/usr/lib/os-release"]) {
      const text = await copyOut(
        run,
        bin,
        g.runtime,
        id,
        f,
        `${dir}/os-release`,
      );
      if (text !== null) {
        release = parseOsRelease(text);
        break;
      }
    }
    const seen = new Set<string>();
    const bundles: Bundle[] = [];
    const list = [
      ...LINUX_BUNDLES.map((path) => ({ path, source: "system" })),
      ...g.bundles.map((path) => ({ path, source: "extra" })),
    ];
    for (const [n, { path, source }] of list.entries()) {
      const text = await copyOut(
        run,
        bin,
        g.runtime,
        id,
        path,
        `${dir}/bundle-${n}`,
      );
      if (text === null || seen.has(text)) continue;
      seen.add(text);
      bundles.push(await checkBundle(path, source, text));
    }
    return assess(
      {
        target: ref,
        kind,
        os: "linux",
        distro: release.PRETTY_NAME ?? release.ID ?? null,
      },
      bundles,
      [],
      [],
      release,
    );
  } finally {
    if (created) await run(bin, rt.remove(id));
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Fails when containers are to be scanned but the runtime doesn't answer. */
export async function checkRuntime(g: GlobalArgs, run: Run) {
  if (!g.images.length && !g.containers.length) return { pass: true };
  const bin = g.runtimePath ?? g.runtime;
  const r = await run(bin, ["--version"]);
  if (r.code === 0) return { pass: true };
  return {
    pass: false,
    errors: [
      `${bin} is not available (${r.stderr || `exit ${r.code}`}); install it${
        g.runtime === "container" ? " and run `container system start`" : ""
      }, or set runtimePath`,
    ],
  };
}

export const model = {
  type: "@taylor/emudhra/exposure",
  version: "2026.10.21.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    target: {
      description:
        "Whether one machine, image or container trusts the compromised eMudhra intermediates, and why",
      schema: TargetSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    summary: {
      description:
        "Which targets the last scan found exposed, protected or unknown",
      schema: SummarySchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "runtime-available": {
      description:
        "The container runtime answers when images or containers are to be scanned",
      labels: ["live"],
      appliesTo: ["scan"],
      execute: (ctx: CheckContext) =>
        checkRuntime(ctx.globalArgs, commandRunner(30000)),
    },
  },
  methods: {
    scan: {
      description:
        "Check the host and the named images and containers for trust in the compromised eMudhra intermediates; changes nothing",
      arguments: ScanArgsSchema,
      execute: async (args: ScanArgs & Seams, context: Context) => {
        const g = context.globalArgs;
        const run = args._run ?? commandRunner();
        const p = args._platform ?? hostPlatform();
        const jobs: {
          name: string;
          label: string;
          go: () => Promise<Target>;
        }[] = [];
        if (g.host) {
          jobs.push({
            name: "host",
            label: "host",
            go: () => scanHost(g, run, p),
          });
        }
        for (const image of g.images) {
          jobs.push({
            name: slug("image", image),
            label: image,
            go: () => scanContainer(g, run, "image", image),
          });
        }
        for (const c of g.containers) {
          jobs.push({
            name: slug("container", c),
            label: c,
            go: () => scanContainer(g, run, "container", c),
          });
        }
        if (!jobs.length) {
          throw new Error("Nothing to scan: set host, images or containers");
        }
        // Different references can make the same name ("a:b" and "a-b").
        const used = new Set<string>();
        for (const job of jobs) {
          let name = job.name;
          for (let n = 2; used.has(name); n++) name = `${job.name}-${n}`;
          used.add(name);
          job.name = name;
        }
        const handles = [];
        const summary = {
          exposed: [] as string[],
          protected: [] as string[],
          unknown: [] as string[],
          errors: [] as { target: string; error: string }[],
          checkedAt: "",
        };
        for (const job of jobs) {
          context.logger.info("Scanning {target}", { target: job.label });
          let t: Target;
          try {
            t = await job.go();
          } catch (err) {
            const error = (err as Error).message;
            context.logger.warn("Could not scan {target}: {error}", {
              target: job.label,
              error,
            });
            summary.errors.push({ target: job.label, error });
            continue;
          }
          const log = t.status === "exposed"
            ? context.logger.warn
            : context.logger.info;
          log.call(
            context.logger,
            "{target}: {status} (TLS {tls}, code signing {codeSigning})",
            {
              target: job.label,
              status: t.status,
              tls: t.tls,
              codeSigning: t.codeSigning,
            },
          );
          for (const f of t.findings) {
            context.logger.warn("{target}: {finding}", {
              target: job.label,
              finding: f,
            });
          }
          summary[t.status].push(job.label);
          handles.push(await context.writeResource("target", job.name, t));
        }
        summary.checkedAt = new Date().toISOString();
        context.logger.info(
          "Scanned {count} targets: {exposed} exposed, {protected} protected, {unknown} unknown, {errors} failed",
          {
            count: jobs.length,
            exposed: summary.exposed.length,
            protected: summary.protected.length,
            unknown: summary.unknown.length,
            errors: summary.errors.length,
          },
        );
        handles.push(
          await context.writeResource("summary", "summary", summary),
        );
        if (summary.errors.length === jobs.length) {
          throw new Error(
            `Every scan failed: ${
              summary.errors.map((e) => `${e.target}: ${e.error}`).join("; ")
            }`,
          );
        }
        if (args.failOnExposed && summary.exposed.length) {
          throw new Error(`Exposed: ${summary.exposed.join(", ")}`);
        }
        return { dataHandles: handles };
      },
    },
  },
};
