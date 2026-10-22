import { z } from "npm:zod@4";
import {
  ANCHORS,
  CROSS_SIGNED_TLS_ROOT,
  type Indicator,
  INTERMEDIATES,
  type Usage,
} from "./_lib/indicators.ts";
import { parseBlockedCerts, readKeystore } from "./_lib/keystore.ts";
import { recoverableScalar } from "./_lib/weakkey.ts";
import {
  type CertHashes,
  hashBundle,
  hashCertificates,
  sha256Hex,
  toPem,
} from "./_lib/x509.ts";

// Exposure to the eMudhra intermediates whose private keys anyone can
// recover (https://emudhra.we-have-a-problem.com/, disclosed 2026-10-20).
// `scan` looks at the machine swamp runs on and at any container images or
// running containers named in the arguments, and records for each whether it
// still trusts those intermediates for TLS or code signing:
//
// - PEM CA bundles (the system bundle, Homebrew, MacPorts, Python certifi,
//   pip, Perl's Mozilla::CA, Git for Windows, and any others named) are
//   exposed when they hold a compromised intermediate or a root it chains
//   to, matched by public key. A trusted certificate whose OpenSSL trust
//   settings reject it for any use doesn't count.
// - Any EC certificate in a bundle or keystore whose private key is one of
//   the 255 smallest, as the eMudhra keys were, is also exposed: its key can
//   be recovered, listed or not.
// - On macOS and Windows the OS verifier is asked about each intermediate:
//   `security verify-cert` and CryptoAPI through .NET's X509Chain. Both see
//   the vendors' block lists, which a PEM bundle never does.
// - Java keystores (each Java runtime's cacerts, the distribution's Java
//   store, and any others named) are exposed in the same way, unless the
//   runtime's blocked.certs (blacklisted.certs in older JDKs such as 8) lists the
//   intermediate, which is how the JDK fix ships. They are read without
//   keytool, so this works in containers too.
// - Node.js, Go, Bun, uv, pixi, rustup, mise, Claude Code, Docker Desktop,
//   Electron apps, and the Deno that swamp itself runs on carry their own
//   roots or verifier, so their versions are compared with the patched
//   releases.
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
  keystores: z.array(z.string().min(1)).default([]).describe(
    "More Java keystores (JKS or PKCS#12) to check, on the host and in every container",
  ),
  toolchains: z.boolean().default(true).describe(
    "On the host, also check Python certifi, pip, Perl Mozilla::CA, Java runtimes, Node.js, Go, Deno, Bun, uv, pixi, rustup, mise, Claude Code, Docker Desktop and Electron apps",
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
  /** Java keystores: the intermediates the runtime's blocked.certs refuses. */
  blocked: z.array(z.string()).optional(),
  /**
   * SHA-256 fingerprints of other EC certificates whose private keys can be
   * recovered from their public keys; present when there are any.
   */
  recoverable: z.array(z.string()).optional(),
  /**
   * OpenSSL trust bundles: roots and intermediates whose trust settings
   * reject them for everything the bundle verifies, but not for any use, so
   * OpenSSL still accepts them when a caller names no purpose. Not exposure;
   * present when there are any.
   */
  rejectedForNamedUses: z.array(z.string()).optional(),
  /**
   * Git for Windows' bundle: the http.sslBackend Git uses. With schannel Git
   * verifies with the Windows store and never reads the bundle, unless
   * http.schannelUseSSLCAInfo points schannel at it (schannel-cainfo).
   */
  gitBackend: z.enum(["openssl", "schannel", "schannel-cainfo"]).optional(),
  exposes: z.array(z.enum(["tls", "codeSigning"])),
});
/** What one PEM bundle or Java keystore trusts. */
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
  /** Where it is installed, for an Electron app or swamp itself. */
  path: z.string().optional(),
  fixedIn: z.array(z.string()),
  /** Where the fix stands when no release has it. */
  note: z.string().optional(),
  status: z.enum(["patched", "outdated"]),
});
/** A toolchain or app that carries its own roots. */
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

/** The Deno runtime the scan runs on: swamp's own when run by swamp. */
export interface DenoRuntime {
  version: string;
  execPath: string;
}

/** Test seams accepted by `scan`. */
export interface Seams {
  _run?: Run;
  _platform?: Platform;
  _deno?: DenoRuntime;
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
  // With trust settings, which blocklisted roots keep (galadran/we-have-a-problem.com#78).
  "/etc/pki/ca-trust/extracted/openssl/ca-bundle.trust.crt",
  "/etc/ssl/ca-bundle.pem", // openSUSE, SLES
  "/var/lib/ca-certificates/ca-bundle.pem",
  "/etc/ssl/cert.pem", // Alpine, BSD
];

/**
 * The PEM bundles OpenSSL-based tools use on macOS: the system's, Homebrew's
 * and MacPorts' (curl-ca-bundle, which its curl, git and OpenSSL use).
 */
export const MACOS_BUNDLES = [
  "/etc/ssl/cert.pem",
  "/opt/homebrew/etc/ca-certificates/cert.pem",
  "/usr/local/etc/ca-certificates/cert.pem",
  "/opt/homebrew/etc/openssl@3/cert.pem",
  "/usr/local/etc/openssl@3/cert.pem",
  "/opt/local/share/curl/curl-ca-bundle.crt",
  "/opt/local/etc/openssl/cert.pem",
];

function macSource(path: string): string {
  if (path.startsWith("/etc/")) return "system";
  return path.startsWith("/opt/local/") ? "macports" : "homebrew";
}

/** Where Git for Windows keeps the bundle it reads with the openssl backend. */
const GIT_BUNDLE = "\\mingw64\\etc\\ssl\\certs\\ca-bundle.crt";

/** Git for Windows, installed for everyone or for one user. */
function gitDirs(p: Platform): string[] {
  return [
    p.env("ProgramFiles") && `${p.env("ProgramFiles")}\\Git`,
    p.env("LOCALAPPDATA") && `${p.env("LOCALAPPDATA")}\\Programs\\Git`,
  ].filter((x): x is string => !!x);
}

/** How a Git for Windows install verifies TLS, as far as its bundle goes. */
export type GitBackend = "openssl" | "schannel" | "schannel-cainfo";

/**
 * The http.sslBackend a Git for Windows install uses, openssl when it isn't
 * set. Git is run from its install directory, which isn't a repository, so
 * it merges every level but a repository's own (ProgramData, system, XDG
 * and global) in its own order. With schannel, http.schannelUseSSLCAInfo
 * makes Git verify against http.sslCAInfo, the bundle, after all. Null when
 * its git can't be run.
 */
export async function gitBackend(
  run: Run,
  git: string,
): Promise<GitBackend | null> {
  const bin = `${git}\\cmd\\git.exe`;
  const get = async (key: string, type: string[] = []) => {
    const r = await run(bin, ["-C", git, "config", ...type, "--get", key]);
    // git config exits 1 when the key isn't set.
    if (r.code === 1) return "";
    return r.code === 0 ? r.stdout.trim().toLowerCase() : null;
  };
  const backend = await get("http.sslBackend");
  if (backend === null) return null;
  if (backend !== "schannel") return "openssl";
  const cainfo = await get("http.schannelUseSSLCAInfo", ["--type=bool"]);
  if (cainfo === null) return null;
  return cainfo === "true" ? "schannel-cainfo" : "schannel";
}

/**
 * Records which backend each Git for Windows bundle's Git uses. With
 * schannel, Git verifies with the Windows store and never reads the bundle,
 * so it exposes nothing.
 */
export async function applyGitBackends(
  run: Run,
  bundles: Bundle[],
): Promise<Bundle[]> {
  const out: Bundle[] = [];
  for (const b of bundles) {
    if (b.source !== "git for windows" || !b.path.endsWith(GIT_BUNDLE)) {
      out.push(b);
      continue;
    }
    const backend = await gitBackend(
      run,
      b.path.slice(0, -GIT_BUNDLE.length),
    );
    if (!backend) {
      out.push(b);
      continue;
    }
    out.push({
      ...b,
      gitBackend: backend,
      ...(backend === "schannel" ? { exposes: [] } : {}),
    });
  }
  return out;
}

/** The bundles to look for on a host, labelled by where they come from. */
export function hostBundles(
  p: Platform,
  extra: string[],
): { path: string; source: string }[] {
  const list: { path: string; source: string }[] = [];
  if (p.os === "darwin") {
    for (const path of MACOS_BUNDLES) {
      list.push({ path, source: macSource(path) });
    }
  } else if (p.os === "windows") {
    // Git for Windows, installed for everyone or for one user: the bundle
    // Git reads with the openssl backend, and the default CA file of the
    // OpenSSL it ships (OPENSSLDIR is /mingw64/etc/ssl).
    for (const git of gitDirs(p)) {
      list.push({
        path: `${git}${GIT_BUNDLE}`,
        source: "git for windows",
      }, {
        path: `${git}\\mingw64\\etc\\ssl\\cert.pem`,
        source: "git for windows openssl",
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
  // Java checks TLS servers and signed JARs against the same cacerts.
  if (source === "extra" || source === "java") return ["tls", "codeSigning"];
  return /objsign/.test(path) ? ["codeSigning"] : ["tls"];
}

const LISTED_KEYS = new Set(INTERMEDIATES.map((i) => i.spkiSha256));

/**
 * Certificates other than the listed intermediates whose keys have a
 * recoverable private scalar, by fingerprint.
 */
function recoverable(certs: CertHashes[]): string[] {
  return certs.filter((c) =>
    !LISTED_KEYS.has(c.spkiSha256) && recoverableScalar(c.spki) !== null
  ).map((c) => c.sha256);
}

/** Whether trust settings stop a certificate being used for a usage. */
function rejectedFor(c: CertHashes, u: Usage): boolean {
  return c.rejects.any ||
    (u === "tls" ? c.rejects.serverAuth : c.rejects.codeSigning);
}

/** The indicators whose keys are among these certificates. */
function indicatorsIn(certs: CertHashes[]): Indicator[] {
  const keys = new Set(certs.map((c) => c.spkiSha256));
  return [...ANCHORS, ...INTERMEDIATES].filter((i) => keys.has(i.spkiSha256));
}

const names = (found: Indicator[]) => [...new Set(found.map((i) => i.name))];

/**
 * Matches a bundle's certificates against the indicators by public key, and
 * looks for any other key that can be recovered. A bundle that holds such a
 * key can be abused for everything it verifies. Trust settings count per
 * usage: a certificate rejected for TLS server authentication isn't trusted
 * for TLS, one rejected for code signing isn't for code signing.
 */
export async function checkBundle(
  path: string,
  source: string,
  text: string,
): Promise<Bundle> {
  const all = await hashBundle(text);
  const purpose = bundlePurpose(path, source);
  const exposes: Usage[] = [];
  const trusted = new Set<CertHashes>();
  for (const u of purpose) {
    const usable = all.filter((c) => !rejectedFor(c, u));
    for (const c of usable) trusted.add(c);
    if (
      indicatorsIn(usable).some((i) => i.usage.includes(u)) ||
      recoverable(usable).length
    ) {
      exposes.push(u);
    }
  }
  const found = indicatorsIn([...trusted]);
  const weak = recoverable([...trusted]);
  // Rejected for everything this bundle verifies, but not for any use.
  const named = indicatorsIn(all.filter((c) => !c.rejects.any)).filter((i) =>
    !found.includes(i)
  );
  return {
    path,
    source,
    certificates: all.length,
    anchors: names(found.filter((i) => ANCHORS.includes(i))),
    intermediates: names(found.filter((i) => !ANCHORS.includes(i))),
    ...(named.length ? { rejectedForNamedUses: names(named) } : {}),
    ...(weak.length ? { recoverable: weak } : {}),
    exposes,
  };
}

/**
 * The issuers of the intermediates each anchor reaches. emSign ECC Root CA -
 * G3 reaches the ones emSign Root TLS CA - G3 issued, through its cross-sign.
 */
const REACHES: Record<string, string[]> = {
  "AAA Certificate Services": ["AAA Certificate Services"],
  "emSign Root TLS CA - G3": ["emSign Root TLS CA - G3"],
  "emSign ECC Root CA - G3": ["emSign Root TLS CA - G3"],
  "emSign Root CS CA - G3": ["emSign Root CS CA - G3"],
};

/** An intermediate copy, named with its issuer since both copies share a name. */
const copyName = (i: Indicator) => `${i.name} (issued by ${i.issuedBy})`;

/**
 * Matches a Java keystore's certificates against the indicators by public
 * key. Java refuses any path through a certificate in the runtime's
 * blocked.certs, so a usage is exposed only while some copy of an
 * intermediate for it is both reachable from the store and not blocked.
 */
export async function checkKeystore(
  path: string,
  source: string,
  bytes: Uint8Array,
  blockedCerts: string | null,
): Promise<{ bundle: Bundle; notes: string[] }> {
  const ks = readKeystore(bytes);
  const notes: string[] = [];
  if (ks.encrypted) {
    notes.push(
      `${path} has password-protected certificates that could not be read; check it with keytool -list -rfc`,
    );
  }
  const certs = await hashCertificates(ks.certificates);
  const keys = new Set(certs.map((c) => c.spkiSha256));
  const anchors = ANCHORS.filter((a) => keys.has(a.spkiSha256));
  const inters = INTERMEDIATES.filter((i) => keys.has(i.spkiSha256));
  let blocked = new Set<string>();
  if (blockedCerts !== null) {
    const parsed = parseBlockedCerts(blockedCerts);
    if (parsed) blocked = parsed;
    else notes.push(`${path}: blocked.certs is not SHA-256, so it was ignored`);
  }
  const reachable = INTERMEDIATES.filter((i) =>
    keys.has(i.spkiSha256) ||
    anchors.some((a) => REACHES[a.name]?.includes(i.issuedBy))
  );
  const open = reachable.filter((i) => !blocked.has(i.sha256));
  const weak = recoverable(certs).filter((sha) => !blocked.has(sha));
  const purpose = bundlePurpose(path, source);
  return {
    bundle: {
      path,
      source,
      certificates: certs.length,
      anchors: anchors.map((a) => a.name),
      intermediates: [...new Set(inters.map((i) => i.name))],
      blocked: INTERMEDIATES.filter((i) => blocked.has(i.sha256)).map(
        copyName,
      ),
      ...(weak.length ? { recoverable: weak } : {}),
      exposes: weak.length
        ? purpose
        : usagesOf(open).filter((u) => purpose.includes(u)),
    },
    notes,
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

/**
 * Patched releases per line, from the page's table (fetched 2026-10-22).
 * Lines not listed have no fix. Each of these carries its own roots, mostly
 * webpki-roots, or its own verifier, so the OS trust store doesn't cover it.
 */
export const PATCHED: Record<string, string[]> = {
  node: ["22.23.4", "24.22.1", "26.12.1"],
  go: ["1.26.10", "1.27.3"],
  electron: ["42.11.16", "43.8.1", "44.9.1"],
  // rustls-webpki 0.103.16 and webpki-roots 1.0.10.
  deno: ["2.9.8"],
  bun: [],
  uv: ["0.13.4"],
  pixi: ["0.82.1"],
  rustup: ["1.29.2"],
  mise: ["2026.10.17"],
  "claude-code": ["2.1.303"],
  "docker-desktop": ["4.96.2"],
};

/** Where the fix stands for a tool with no patched release. */
export const PENDING: Record<string, string> = {
  bun: "pending on the page; no Bun release has the fix yet",
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
 * leading numbers name a line (1 for Node majors, 2 for Go, 0 for a tool
 * with a single fixed release).
 */
export function isPatched(
  version: string,
  fixed: string[],
  lineParts: number,
): boolean {
  if (!fixed.length) return false;
  const line = (v: string) => parts(v).slice(0, lineParts).join(".");
  const own = fixed.find((f) => line(f) === line(version));
  if (own) return compare(version, own) >= 0;
  const newest = fixed.reduce((a, b) => compare(a, b) >= 0 ? a : b);
  return compare(line(version), line(newest)) > 0;
}

/** How many leading numbers name a release line, per tool. */
export const LINE_PARTS: Record<string, number> = {
  node: 1,
  go: 2,
  electron: 1,
  deno: 0,
  bun: 0,
  uv: 0,
  pixi: 0,
  rustup: 0,
  mise: 0,
  "claude-code": 0,
  "docker-desktop": 0,
};

/** One tool's version against its patched releases. */
export function toolchain(
  tool: keyof typeof PATCHED,
  version: string,
  path?: string,
): Toolchain {
  return {
    tool,
    version,
    ...(path ? { path } : {}),
    fixedIn: PATCHED[tool],
    ...(PENDING[tool] ? { note: PENDING[tool] } : {}),
    status: isPatched(version, PATCHED[tool], LINE_PARTS[tool])
      ? "patched"
      : "outdated",
  };
}

/** How to ask each tool on PATH for its version. */
export const PROBES: [keyof typeof PATCHED, string, string[], RegExp][] = [
  // Deno answers for a `node` that isn't installed, with its own version.
  ["node", "node", ["--version"], /^v(\d+\.\d+\.\d+)/],
  ["go", "go", ["version"], /go(\d+\.\d+(?:\.\d+)?)/],
  ["deno", "deno", ["--version"], /deno (\d+\.\d+\.\d+)/],
  ["bun", "bun", ["--version"], /^(\d+\.\d+\.\d+)/],
  ["uv", "uv", ["--version"], /uv (\d+\.\d+\.\d+)/],
  ["pixi", "pixi", ["--version"], /pixi (\d+\.\d+\.\d+)/],
  ["rustup", "rustup", ["--version"], /rustup (\d+\.\d+\.\d+)/],
  ["mise", "mise", ["--version"], /(\d{4}\.\d+\.\d+)/],
  ["claude-code", "claude", ["--version"], /(\d+\.\d+\.\d+) \(Claude Code\)/],
  // Answers only while Docker Desktop is running.
  [
    "docker-desktop",
    "docker",
    ["version", "--format", "{{.Server.Platform.Name}}"],
    /Docker Desktop (\d+\.\d+\.\d+)/,
  ],
];

/** The versions of the tools on PATH, against the patched releases. */
async function toolchainVersions(run: Run): Promise<Toolchain[]> {
  const out: Toolchain[] = [];
  for (const [tool, cmd, args, pattern] of PROBES) {
    const r = await run(cmd, args);
    const v = r.code === 0 ? r.stdout.match(pattern)?.[1] : undefined;
    if (v) out.push(toolchain(tool, v));
  }
  return out;
}

/**
 * Docker Desktop on Windows when it isn't running, so `docker version` can't
 * name it: the installer records the version in componentsVersion.json.
 */
export async function dockerDesktopInstalled(
  p: Platform,
): Promise<Toolchain | null> {
  const pf = p.env("ProgramFiles");
  if (p.os !== "windows" || !pf) return null;
  const dir = `${pf}${SEP}Docker${SEP}Docker`;
  try {
    const v = JSON.parse(
      await Deno.readTextFile(
        `${dir}${SEP}resources${SEP}componentsVersion.json`,
      ),
    ).appVersion;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v)
      ? toolchain("docker-desktop", v, dir)
      : null;
  } catch {
    return null;
  }
}

/** The Deno this code is running on, which is swamp's own under swamp. */
export function denoRuntime(): DenoRuntime {
  return { version: Deno.version.deno, execPath: Deno.execPath() };
}

/**
 * Swamp is a compiled Deno program, and its fetches verify with Deno's
 * rustls against webpki-roots. DENO_TLS_CA_STORE=system swaps in the OS
 * roots but not the OS block lists, so it doesn't help: only a Deno with
 * the fix (2.9.8) does.
 */
export function swampDeno(d: DenoRuntime): Toolchain {
  return toolchain("deno", d.version, d.execPath);
}

/**
 * Reads a binary in chunks for the version Electron builds into its user
 * agent, `Electron/<version>`. The string sits deep in a 200 MB executable,
 * so it is streamed rather than read whole.
 */
export async function electronVersion(path: string): Promise<string | null> {
  const pattern = /Electron\/(\d+\.\d+\.\d+)/;
  const dec = new TextDecoder("latin1");
  const file = await Deno.open(path);
  try {
    const buf = new Uint8Array(4 << 20);
    let tail = "";
    for (;;) {
      const n = await file.read(buf);
      if (n === null) return null;
      const text = tail + dec.decode(buf.subarray(0, n));
      const m = text.match(pattern);
      if (m) return m[1];
      // Keep enough to catch a match split across reads.
      tail = text.slice(-32);
    }
  } finally {
    file.close();
  }
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isDirectory;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Joins paths on the machine swamp runs on. */
const SEP = Deno.build.os === "windows" ? "\\" : "/";

/** The subdirectories of a directory; none when it can't be read. */
async function subdirs(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    for await (const e of Deno.readDir(dir)) {
      if (e.isDirectory) out.push(`${dir}${SEP}${e.name}`);
    }
  } catch { /* missing or unreadable */ }
  return out.sort();
}

/** Where to look for installed applications, per OS. */
export function appRoots(p: Platform): string[] {
  const env = (n: string) => p.env(n);
  if (p.os === "windows") {
    const local = env("LOCALAPPDATA");
    return [
      local && `${local}\\Programs`,
      local,
      env("ProgramFiles"),
      env("ProgramFiles(x86)"),
    ].filter((x): x is string => !!x);
  }
  if (p.os === "darwin") {
    return ["/Applications", env("HOME") && `${env("HOME")}/Applications`]
      .filter((x): x is string => !!x);
  }
  return ["/opt", "/usr/lib", "/usr/share"];
}

/**
 * Electron apps under the given roots, with the Electron version each runs.
 * On macOS that is the Electron Framework's bundle version; elsewhere an app
 * is a directory with resources/app.asar or resources/app, in an install
 * directory or one level below it (VS Code keeps it in a versioned folder,
 * Squirrel apps in app-<version>), and the version comes from its largest
 * executable. The Electron binary is well over `minSize`; smaller ones are
 * helpers and uninstallers.
 */
export async function electronApps(
  roots: string[],
  os: string,
  minSize = 50 << 20,
): Promise<Toolchain[]> {
  const out: Toolchain[] = [];
  // A root can sit inside another (LOCALAPPDATA\Programs); it isn't an app.
  const seen = new Set<string>(roots);
  for (const root of roots) {
    for (const dir of await subdirs(root)) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      let version: string | null = null;
      if (os === "darwin") {
        if (!dir.endsWith(".app")) continue;
        try {
          const plist = await Deno.readTextFile(
            `${dir}/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist`,
          );
          version = plist.match(
            /<key>CFBundleVersion<\/key>\s*<string>([^<]+)<\/string>/,
          )?.[1] ?? null;
        } catch { /* not Electron */ }
      } else {
        version = await electronDirVersion(dir, os, minSize);
      }
      if (version) out.push(toolchain("electron", version, dir));
    }
  }
  return out;
}

async function electronDirVersion(
  dir: string,
  os: string,
  minSize: number,
): Promise<string | null> {
  let appDir: string | null = null;
  for (const d of [dir, ...await subdirs(dir)]) {
    const res = `${d}${SEP}resources${SEP}`;
    if (await exists(`${res}app.asar`) || await isDir(`${res}app`)) {
      appDir = d;
      break;
    }
  }
  if (!appDir) return null;
  const exes: { path: string; size: number }[] = [];
  for (const d of new Set([dir, appDir])) {
    try {
      for await (const e of Deno.readDir(d)) {
        if (!e.isFile) continue;
        if (os === "windows" && !e.name.toLowerCase().endsWith(".exe")) {
          continue;
        }
        const path = `${d}${SEP}${e.name}`;
        const st = await Deno.stat(path);
        if (st.size < minSize) continue;
        if (os !== "windows" && st.mode !== null && !(st.mode & 0o111)) {
          continue;
        }
        exes.push({ path, size: st.size });
      }
    } catch { /* unreadable */ }
  }
  for (const { path } of exes.sort((a, b) => b.size - a.size)) {
    try {
      const v = await electronVersion(path);
      if (v) return v;
    } catch { /* unreadable */ }
  }
  return null;
}

/** Distribution-managed Java trust stores, generated from the system bundle. */
export const LINUX_KEYSTORES = [
  "/etc/ssl/certs/java/cacerts", // Debian, Ubuntu (ca-certificates-java)
  "/etc/pki/ca-trust/extracted/java/cacerts", // Fedora, RHEL
  "/etc/pki/java/cacerts",
  "/var/lib/ca-certificates/java-cacerts", // openSUSE
];

/** A keystore to read, and the blocked.certs of the runtime that uses it. */
export interface KeystoreRef {
  path: string;
  source: string;
  blocked?: string;
}

/**
 * Where a runtime's block list may be: blocked.certs, or blacklisted.certs
 * beside it in older JDKs such as 8, where the OpenJDK advisory's
 * workaround puts the new list.
 */
export function blockListPaths(blocked: string): string[] {
  return [blocked, blocked.replace(/blocked\.certs$/, "blacklisted.certs")];
}

/** The trust store and block list of a Java home, if it has them. */
async function javaHomeKeystore(
  home: string,
): Promise<KeystoreRef | null> {
  // JDK 9 and later keep them in lib/security; JDK 8 in jre/lib/security.
  for (const sec of ["lib", "jre/lib"]) {
    const dir = `${home}${SEP}${sec.replaceAll("/", SEP)}${SEP}security${SEP}`;
    if (await exists(`${dir}cacerts`)) {
      return {
        path: `${dir}cacerts`,
        source: "java",
        blocked: `${dir}blocked.certs`,
      };
    }
  }
  return null;
}

/** Where Java runtimes are installed, per OS. */
export function javaRoots(p: Platform): string[] {
  const home = p.env("HOME");
  if (p.os === "windows") {
    const local = p.env("LOCALAPPDATA");
    return [
      p.env("ProgramFiles"),
      p.env("ProgramFiles(x86)"),
      local && `${local}\\Programs`,
    ].filter((x): x is string => !!x);
  }
  if (p.os === "darwin") {
    return [
      "/Library/Java/JavaVirtualMachines",
      home && `${home}/Library/Java/JavaVirtualMachines`,
      "/Applications",
    ].filter((x): x is string => !!x);
  }
  return ["/usr/lib/jvm", "/opt", "/usr/local"];
}

/**
 * The Java trust stores on a host: the runtime `java` on PATH reports,
 * JAVA_HOME, and every Java home up to two levels under the roots (vendors
 * install to <vendor>/<version>), including the runtimes apps such as
 * JetBrains IDEs bundle in jbr or jre.
 */
export async function hostKeystores(
  run: Run,
  p: Platform,
  roots: string[],
): Promise<KeystoreRef[]> {
  const homes: string[] = [];
  const java = await run("java", ["-XshowSettings:properties", "-version"]);
  const reported = `${java.stdout}\n${java.stderr}`.match(
    /java\.home = (.+)/,
  )?.[1]?.trim();
  if (java.code === 0 && reported) homes.push(reported);
  const javaHome = p.env("JAVA_HOME");
  if (javaHome) homes.push(javaHome);
  const nested = (d: string) =>
    p.os === "darwin"
      ? [`${d}/Contents/Home`, `${d}/Contents/jbr/Contents/Home`]
      : [`${d}${SEP}jbr`, `${d}${SEP}jre`];
  for (const root of roots) {
    for (const d of await subdirs(root)) {
      homes.push(d, ...nested(d));
      for (const dd of await subdirs(d)) homes.push(dd, ...nested(dd));
    }
  }
  const out: KeystoreRef[] = [];
  for (const home of new Set(homes)) {
    const ks = await javaHomeKeystore(home);
    if (ks) out.push(ks);
  }
  if (p.os === "linux") {
    for (const path of LINUX_KEYSTORES) {
      if (await exists(path)) out.push({ path, source: "java" });
    }
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

/** The bundle Perl's Mozilla::CA ships, which LWP and IO::Socket::SSL use. */
async function perlBundles(
  run: Run,
): Promise<{ path: string; source: string }[]> {
  const r = await run("perl", [
    "-MMozilla::CA",
    "-e",
    "print Mozilla::CA::SSL_ca_file()",
  ]);
  return r.code === 0 && r.stdout
    ? [{ path: r.stdout, source: "perl mozilla::ca" }]
    : [];
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
  // Devuan has ID_LIKE=debian and the same packages.
  if (has("ubuntu")) {
    return "Upgrade ca-certificates to 20260816ubuntu0.<release>.1 (22.04, 24.04, 26.04, 26.10), or until then prefix mozilla/emSign_ECC_Root_CA_-_G3.crt and mozilla/Comodo_AAA_Services_root.crt with ! in /etc/ca-certificates.conf and run update-ca-certificates";
  }
  if (has("debian")) {
    return "Upgrade ca-certificates to 20250419~deb12u2 (bookworm), 20250419+deb13u1 (trixie) or 20260816+nmu1, or until then prefix mozilla/emSign_ECC_Root_CA_-_G3.crt and mozilla/Comodo_AAA_Services_root.crt with ! in /etc/ca-certificates.conf and run update-ca-certificates";
  }
  if (has("alpine")) {
    return "Upgrade ca-certificates to 20261020-r0, or until then prefix mozilla/emSign_ECC_Root_CA_-_G3.crt with ! in /etc/ca-certificates.conf and run update-ca-certificates";
  }
  if (has("wolfi", "chainguard")) {
    return "Upgrade ca-certificates to 20260909-r3";
  }
  if (has("fedora", "rhel", "centos", "rocky", "almalinux", "amzn")) {
    return "Upgrade ca-certificates (Fedora 2026.2.92_v9.0.319), or extract Comodo AAA Services root and emSign ECC Root CA - G3 into /etc/pki/ca-trust/source/blocklist with trust extract, mark each with openssl x509 -trustout -addreject anyExtendedKeyUsage so ca-bundle.trust.crt rejects it for every use, and run update-ca-trust";
  }
  if (has("opensuse", "suse", "sles")) {
    return "Extract Comodo AAA Services root and emSign ECC Root CA - G3 into /etc/pki/trust/blocklist with trust extract and run update-ca-certificates";
  }
  if (has("arch")) {
    return "Upgrade ca-certificates-mozilla to 3.131.1-1, or extract emSign ECC Root CA - G3 into /etc/ca-certificates/trust-source/blocklist with trust extract and run update-ca-trust";
  }
  if (has("gentoo")) return "Upgrade ca-certificates to 20260816.3.125";
  if (has("bottlerocket")) {
    return "Bottlerocket has no fixed release yet (bottlerocket-os/bottlerocket#4976); distrust emSign ECC Root CA - G3 with a settings.pki entry with trusted = false";
  }
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
  const listed = [...b.anchors, ...b.intermediates].join(", ");
  if (b.recoverable?.length && !listed) {
    return `${where}remove the certificates whose keys can be recovered (SHA-256 ${
      b.recoverable.join(", ")
    })`;
  }
  switch (b.source) {
    case "homebrew":
      return `${where}brew upgrade ca-certificates (2026-09-25_1 or later)`;
    case "macports":
      return `${where}MacPorts' curl-ca-bundle has no fixed release yet; remove ${listed} from it as the page shows for /etc/ssl/cert.pem, and sudo port upgrade curl-ca-bundle once it ships the 2026-10-20 curl bundle`;
    case "python certifi":
      return `${where}upgrade certifi to 2026.10.19 or later`;
    case "pip":
      // The pip of macOS's own python3 lives with the Command Line Tools or
      // Xcode and can't be upgraded in place.
      if (
        /\/Library\/Developer\/CommandLineTools\/|\/Xcode[^/]*\.app\//.test(
          b.path,
        )
      ) {
        return `${where}this is the pip of macOS's own python3; fix /etc/ssl/cert.pem, then set PIP_CERT=/etc/ssl/cert.pem in its sitecustomize.py (the page's macOS workaround)`;
      }
      return `${where}upgrade pip to 26.2.2 or later`;
    case "perl mozilla::ca":
      return `${where}upgrade Mozilla::CA to 20261020 or later`;
    case "git for windows":
      if (b.gitBackend === "schannel-cainfo") {
        return `${where}Git uses schannel, but http.schannelUseSSLCAInfo makes it verify against this bundle; unset it with git config --global --unset http.schannelUseSSLCAInfo (or at the level that sets it, git config --show-origin --get http.schannelUseSSLCAInfo), or upgrade Git for Windows once it ships a bundle without ${listed}`;
      }
      return `${where}switch Git to the Windows store with git config --global http.sslBackend schannel, or upgrade Git for Windows once it ships a bundle without ${listed}`;
    case "git for windows openssl":
      return `${where}the OpenSSL that ships with Git (openssl.exe in Git Bash, and anything else built on it) trusts this by default; upgrade Git for Windows once it ships a bundle without ${listed}, or remove them from this file`;
    case "extra":
      return `${where}remove the certificates listed for it`;
    case "java":
      if (LINUX_KEYSTORES.includes(b.path)) break;
      return `${where}update this Java runtime to one with the fix (27.0.1.0.2, 25.0.5.0.2, 21.0.13.0.2, 17.0.21.0.2, 11.0.33.0.2 or 8u511 on the page), or replace its lib/security/blocked.certs (blacklisted.certs on JDK 8) with https://ops.java/unix/blocked.certs (windows/blocked.certs on Windows), keeping any entries of your own`;
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

function toolLabel(t: Toolchain): string {
  return t.path
    ? `${t.path} (${t.tool} ${t.version})`
    : `${t.tool} ${t.version}`;
}

/** What to do about one outdated toolchain or app. */
function toolchainFix(t: Toolchain): string {
  const to = t.fixedIn.length
    ? `${t.fixedIn.join(", ")} or later`
    : `a release with the fix (${t.note ?? "none yet"})`;
  if (t.tool === "electron") {
    return `${t.path}: update the app to one built on Electron ${to}`;
  }
  if (t.tool === "deno" && t.path) {
    const deno = t.fixedIn.length
      ? `Deno ${to}`
      : `a Deno release with the fix (${t.note ?? "none yet"})`;
    return `${t.path}: update to a build on ${deno}; DENO_TLS_CA_STORE=system doesn't help, as rustls reads the OS roots but not its block list`;
  }
  return `Upgrade ${t.tool} to ${to}`;
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
    if (b.rejectedForNamedUses?.length) {
      findings.push(
        `${b.path} rejects ${
          b.rejectedForNamedUses.join(", ")
        } for what it verifies, so TLS clients refuse them, but not for any use: OpenSSL still accepts them when a caller names no purpose, as openssl verify does`,
      );
      remediation.push(
        `${b.path}: to close that too, mark each blocklisted root with openssl x509 -in F -out F -trustout -addreject anyExtendedKeyUsage and run update-ca-trust (galadran/we-have-a-problem.com#78), or upgrade ca-certificates`,
      );
    }
    if (
      b.gitBackend === "schannel" && b.anchors.length + b.intermediates.length
    ) {
      findings.push(
        `${b.path} trusts ${
          [...b.anchors, ...b.intermediates].join(", ")
        }, but Git uses http.sslBackend schannel, so it verifies with the Windows store and doesn't read this bundle`,
      );
    }
    if (!b.exposes.length) continue;
    for (const u of b.exposes) exposed[u] = true;
    const listed = [...b.anchors, ...b.intermediates];
    if (listed.length) findings.push(`${b.path} trusts ${listed.join(", ")}`);
    if (b.recoverable?.length) {
      findings.push(
        `${b.path} trusts ${b.recoverable.length} other certificate${
          b.recoverable.length === 1 ? "" : "s"
        } whose private key anyone can recover, as with the eMudhra keys (SHA-256 ${
          b.recoverable.join(", ")
        })`,
      );
    }
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
      "Windows: let the automatic certificate trust list updates bring Microsoft's block (shipped from 2026-10-20); on a machine that doesn't get them, run the page's Block-EmudhraCompromisedCA.ps1 from an elevated PowerShell, which adds the 16 certificates to LocalMachine\\Disallowed",
    );
  }
  if (trusted.some((n) => n.verifier === "macos-security")) {
    remediation.push(
      "macOS: install the latest security updates; Apple has blocked these since 2026-10-19",
    );
  }
  for (const n of native.filter((n) => n.verdict === "error")) {
    findings.push(`${n.verifier} could not check ${n.name}: ${n.detail}`);
  }
  for (const t of toolchains.filter((t) => t.status === "outdated")) {
    exposed.tls = true;
    findings.push(
      `${toolLabel(t)} predates the fix (${
        t.fixedIn.join(", ") || t.note || "no release yet"
      })`,
    );
    remediation.push(toolchainFix(t));
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

/**
 * Reads each keystore that exists once, however many paths lead to it (a
 * Debian JDK's cacerts links to the distribution's store), with the block
 * list of the runtime it was found in.
 */
export async function readHostKeystores(
  list: KeystoreRef[],
): Promise<{ bundles: Bundle[]; notes: string[] }> {
  const seen = new Set<string>();
  const bundles: Bundle[] = [];
  const notes: string[] = [];
  for (const { path, source, blocked } of list) {
    try {
      const real = await Deno.realPath(path);
      if (seen.has(real)) continue;
      seen.add(real);
      const bytes = await Deno.readFile(real);
      let blockedText: string | null = null;
      for (const f of blocked ? blockListPaths(blocked) : []) {
        try {
          blockedText = await Deno.readTextFile(f);
          break;
        } catch { /* try the older name, or a runtime without a block list */ }
      }
      const r = await checkKeystore(path, source, bytes, blockedText);
      bundles.push(r.bundle);
      notes.push(...r.notes);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound && source !== "extra") continue;
      notes.push(`Could not read ${path}: ${(err as Error).message}`);
    }
  }
  return { bundles, notes };
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
  deno: DenoRuntime,
): Promise<Target> {
  const dir = await Deno.makeTempDir({ prefix: "emudhra-" });
  try {
    const { distro, release } = await hostRelease(run, p);
    const list = hostBundles(p, g.bundles);
    const keystores: KeystoreRef[] = [];
    let toolchains: Toolchain[] = [];
    if (g.toolchains) {
      list.push(...await pythonBundles(run, p), ...await perlBundles(run));
      keystores.push(...await hostKeystores(run, p, javaRoots(p)));
      toolchains = [
        ...await toolchainVersions(run),
        swampDeno(deno),
        ...await electronApps(appRoots(p), p.os),
      ];
      if (!toolchains.some((t) => t.tool === "docker-desktop")) {
        const dd = await dockerDesktopInstalled(p);
        if (dd) toolchains.push(dd);
      }
    }
    for (const path of g.keystores) keystores.push({ path, source: "extra" });
    const pem = await readHostBundles(list);
    const java = await readHostKeystores(keystores);
    const bundles = [
      ...await applyGitBackends(run, pem.bundles),
      ...java.bundles,
    ];
    const unreadable = [...pem.unreadable, ...java.notes];
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
async function copyOutBytes(
  run: Run,
  bin: string,
  runtime: Runtime,
  id: string,
  path: string,
  dest: string,
): Promise<Uint8Array | null> {
  // docker cp copies a symlink as a link unless told to follow it; Apple's
  // container cp follows it.
  const args = runtime === "docker"
    ? ["cp", "-L", `${id}:${path}`, dest]
    : ["cp", `${id}:${path}`, dest];
  const r = await run(bin, args);
  if (r.code !== 0) return null;
  try {
    return await Deno.readFile(dest);
  } catch {
    return null;
  }
}

async function copyOut(
  ...args: Parameters<typeof copyOutBytes>
): Promise<string | null> {
  const bytes = await copyOutBytes(...args);
  return bytes && new TextDecoder().decode(bytes);
}

/**
 * The JAVA_HOME a container is configured with, from `inspect`, which both
 * runtimes print as JSON with the environment as NAME=value strings.
 */
export function inspectJavaHome(inspect: string): string | null {
  return inspect.match(/"JAVA_HOME=([^"]+)"/)?.[1] ?? null;
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
  let inspect = "";
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
      const info = await run(bin, ["inspect", id]);
      if (info.code === 0) inspect = info.stdout;
    } else {
      // Every copy from a container that isn't there fails the same way a
      // missing file does, so make sure it's there first.
      const r = await run(bin, ["inspect", ref]);
      if (r.code !== 0) {
        throw new Error(`No container ${ref}: ${r.stderr || r.stdout}`);
      }
      inspect = r.stdout;
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
    // Java: the image's JAVA_HOME (the official images set it), the
    // distribution's store, and any named.
    const keystores: KeystoreRef[] = [];
    const javaHome = inspectJavaHome(inspect);
    if (javaHome) {
      for (const sec of ["lib/security", "jre/lib/security"]) {
        keystores.push({
          path: `${javaHome}/${sec}/cacerts`,
          source: "java",
          blocked: `${javaHome}/${sec}/blocked.certs`,
        });
      }
    }
    keystores.push(
      ...LINUX_KEYSTORES.map((path) => ({ path, source: "java" })),
      ...g.keystores.map((path) => ({ path, source: "extra" })),
    );
    const notes: string[] = [];
    for (const [n, ks] of keystores.entries()) {
      const bytes = await copyOutBytes(
        run,
        bin,
        g.runtime,
        id,
        ks.path,
        `${dir}/keystore-${n}`,
      );
      if (bytes === null) continue;
      // JAVA_HOME's cacerts is often a link to the distribution's store.
      const key = await sha256Hex(bytes);
      if (seen.has(key)) continue;
      seen.add(key);
      let blocked: string | null = null;
      for (const f of ks.blocked ? blockListPaths(ks.blocked) : []) {
        blocked = await copyOut(
          run,
          bin,
          g.runtime,
          id,
          f,
          `${dir}/blocked-${n}`,
        );
        if (blocked !== null) break;
      }
      try {
        const r = await checkKeystore(ks.path, ks.source, bytes, blocked);
        bundles.push(r.bundle);
        notes.push(...r.notes);
      } catch (err) {
        notes.push(`Could not read ${ks.path}: ${(err as Error).message}`);
      }
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
      notes,
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
  version: "2026.10.22.4",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.21.3",
      description:
        "2026.10.21.2 added the keystores argument; instances from 2026.10.21.1 get it empty, nothing else changes",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => ({
        keystores: [],
        ...old,
      }),
    },
    {
      toVersion: "2026.10.22.1",
      description:
        "New checks and patched releases; the arguments are unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.10.22.2",
      description:
        "Finds Docker Desktop on Windows when it isn't running; the arguments are unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.10.22.3",
      description:
        "Honours Git for Windows' http.sslBackend and checks its OpenSSL's cert.pem; the arguments are unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.10.22.4",
      description:
        "Counts OpenSSL trust settings per usage, so a root rejected for TLS isn't TLS exposure; the arguments are unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
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
        const deno = args._deno ?? denoRuntime();
        const jobs: {
          name: string;
          label: string;
          go: () => Promise<Target>;
        }[] = [];
        if (g.host) {
          jobs.push({
            name: "host",
            label: "host",
            go: () => scanHost(g, run, p, deno),
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
