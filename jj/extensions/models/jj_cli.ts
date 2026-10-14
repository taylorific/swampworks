import { z } from "npm:zod@4";

// Jujutsu (jj), the Git-compatible version control system, installed and
// configured for the current user on Linux, macOS or Windows. `install` puts
// jj on the machine if it is missing: with Homebrew on macOS and winget on
// Windows when they are there, otherwise from the jj-vcs/jj GitHub release,
// whose archive is checked against the SHA-256 digest GitHub publishes for it.
// `uninstall` removes only what `install` put there, which the installation
// resource remembers as `managed`. `configure` sets user-level config (user.name, user.email and any other
// keys) with `jj config set --user`, touching only keys whose value differs,
// and restores the config file if jj rejects the result. `sync` reads the
// installed version and config without changing anything and records where
// they have drifted from the arguments.

const METHODS = ["auto", "release", "brew", "winget"] as const;
/** How jj gets installed; `auto` picks one for the platform. */
export type InstallMethod = Exclude<typeof METHODS[number], "auto">;

/** The winget package that installs jj. */
export const WINGET_ID = "jj-vcs.jj";
/** GitHub releases API for jj. */
export const RELEASES_API = "https://api.github.com/repos/jj-vcs/jj/releases";

const SEMVER = /^\d+\.\d+\.\d+$/;
/** A jj config key as `jj config set` takes it, e.g. `revset-aliases."trunk()"`. */
const KEY = /^[^\s-][^\r\n]*$/;

const SettingValueSchema = z.union([
  z.string(),
  z.number().finite(),
  z.boolean(),
  z.array(z.string()),
]);
/** A value for a jj config key: a string, number, boolean or list of strings. */
export type SettingValue = z.infer<typeof SettingValueSchema>;

const GlobalArgsSchema = z.object({
  installMethod: z.enum(METHODS).default("auto").describe(
    "auto (Homebrew on macOS and winget on Windows when available, otherwise the GitHub release), release, brew or winget",
  ),
  version: z.string().refine((v) => v === "latest" || SEMVER.test(v), {
    message: 'Must be "latest" or a version like 0.46.0',
  }).default("latest").describe(
    'jj version to install: "latest" or a version like 0.46.0. Homebrew cannot pin one.',
  ),
  installDir: z.string().optional().describe(
    "Where the release method puts jj. Defaults to ~/.local/bin, or %LOCALAPPDATA%\\Programs\\jj on Windows.",
  ),
  jjPath: z.string().optional().describe(
    "Path to a jj binary to use instead of looking for one",
  ),
  userName: z.string().min(1).optional().describe("user.name for commits"),
  userEmail: z.string().regex(/^[^\s@]+@[^\s@]+$/).optional().describe(
    "user.email for commits",
  ),
  settings: z.record(z.string().regex(KEY), SettingValueSchema).default({})
    .describe(
      'Other user-level config, keyed as jj names them, e.g. {"ui.default-command": "log", "ui.diff-formatter": ":git"}',
    ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstallArgsSchema = z.object({
  upgrade: z.boolean().default(false).describe(
    'With version "latest", also upgrade a jj that is already installed',
  ),
});
type InstallArgs = z.infer<typeof InstallArgsSchema>;

const ManagedSchema = z.object({
  method: z.enum(["release", "brew", "winget"]),
  path: z.string(),
});
/** The jj this model installed, which uninstall may remove. */
export type Managed = z.infer<typeof ManagedSchema>;

const InstallationSchema = z.object({
  installed: z.boolean(),
  path: z.string().nullable(),
  version: z.string().nullable(),
  method: z.enum(["release", "brew", "winget"]).nullable(),
  action: z.enum(["installed", "updated", "exists", "missing", "removed"]),
  managed: ManagedSchema.nullable(),
  os: z.string(),
  arch: z.string(),
  drift: z.array(z.string()),
  checkedAt: z.string(),
});
type Installation = z.infer<typeof InstallationSchema>;

const ConfigSchema = z.object({
  path: z.string().nullable(),
  settings: z.record(z.string(), z.unknown()),
  changed: z.array(z.string()),
  drift: z.array(z.string()),
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
  readResource: (name: string) => Promise<Record<string, unknown> | null>;
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

/** Fetches a URL. Injectable for tests. */
export type Fetch = (
  url: string,
  init?: RequestInit,
) => Promise<Response>;

/** The operating system and architecture, and the environment. */
export interface Platform {
  os: string;
  arch: string;
  env: (name: string) => string | undefined;
}

/** Test seams accepted by every method. */
export interface Seams {
  _run?: Run;
  _fetch?: Fetch;
  _platform?: Platform;
}

/** Runs real commands, reporting one that can't be started as code 127. */
export function commandRunner(timeoutMs = 600000): Run {
  return async (cmd, args) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs jj, brew, winget and tar; argument lists are built in this file, see README What it runs
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
  return {
    os: Deno.build.os,
    arch: Deno.build.arch,
    env: (name) => Deno.env.get(name),
  };
}

/** Joins path parts with the platform's separator. */
export function joinPath(os: string, ...parts: string[]): string {
  const sep = os === "windows" ? "\\" : "/";
  return parts.map((p, i) =>
    i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")
  ).join(sep);
}

/** The jj binary's file name. */
export function binName(os: string): string {
  return os === "windows" ? "jj.exe" : "jj";
}

/** Where the release method puts jj unless installDir says otherwise. */
export function defaultInstallDir(p: Platform): string {
  if (p.os === "windows") {
    const local = p.env("LOCALAPPDATA");
    if (!local) throw new Error("LOCALAPPDATA is not set; set installDir");
    return joinPath(p.os, local, "Programs", "jj");
  }
  const home = p.env("HOME");
  if (!home) throw new Error("HOME is not set; set installDir");
  return joinPath(p.os, home, ".local", "bin");
}

function installDir(g: GlobalArgs, p: Platform): string {
  return g.installDir ?? defaultInstallDir(p);
}

/** Where the winget-installed jj is linked, if LOCALAPPDATA is set. */
function wingetLink(p: Platform): string | undefined {
  const local = p.env("LOCALAPPDATA");
  return local
    ? joinPath(p.os, local, "Microsoft", "WinGet", "Links", "jj.exe")
    : undefined;
}

/**
 * Places to look for jj, in order: jjPath alone if it is set, otherwise
 * installDir, jj on PATH, then where Homebrew and winget put it. installDir
 * comes first so that a pinned release build wins over an older jj on PATH;
 * otherwise install would replace it on every run.
 */
export function jjCandidates(g: GlobalArgs, p: Platform): string[] {
  if (g.jjPath) return [g.jjPath];
  const list: string[] = [];
  try {
    list.push(joinPath(p.os, installDir(g, p), binName(p.os)));
  } catch { /* no home directory to look in */ }
  list.push("jj");
  if (p.os === "darwin") list.push("/opt/homebrew/bin/jj", "/usr/local/bin/jj");
  if (p.os === "linux") list.push("/home/linuxbrew/.linuxbrew/bin/jj");
  const link = p.os === "windows" ? wingetLink(p) : undefined;
  if (link) list.push(link);
  return [...new Set(list)];
}

/** The version in `jj --version` output, e.g. "jj 0.46.0-7d38231" → 0.46.0. */
export function parseVersion(out: string): string | null {
  return /\bjj (\d+\.\d+\.\d+)/.exec(out)?.[1] ?? null;
}

/** A jj binary that runs, and its version. */
export interface Found {
  path: string;
  version: string;
}

/** The first candidate that answers `--version`, or null. */
export async function findJj(
  run: Run,
  candidates: string[],
): Promise<Found | null> {
  for (const path of candidates) {
    const r = await run(path, ["--version"]);
    const version = r.code === 0 ? parseVersion(r.stdout) : null;
    if (version) return { path, version };
  }
  return null;
}

async function available(run: Run, cmd: string): Promise<boolean> {
  return (await run(cmd, ["--version"])).code === 0;
}

/** Picks the install method: the one asked for, or one suited to the platform. */
export async function resolveMethod(
  g: GlobalArgs,
  p: Platform,
  run: Run,
): Promise<InstallMethod> {
  if (g.installMethod !== "auto") return g.installMethod;
  if (
    p.os === "darwin" && g.version === "latest" && await available(run, "brew")
  ) {
    return "brew";
  }
  if (p.os === "windows" && await available(run, "winget")) return "winget";
  return "release";
}

/** The Rust target triple of jj's release build for this platform. */
export function releaseTarget(p: Platform): string {
  if (p.arch !== "x86_64" && p.arch !== "aarch64") {
    throw new Error(`jj publishes no release build for ${p.arch}`);
  }
  switch (p.os) {
    case "linux":
      return `${p.arch}-unknown-linux-musl`;
    case "darwin":
      return `${p.arch}-apple-darwin`;
    case "windows":
      return `${p.arch}-pc-windows-msvc`;
    default:
      throw new Error(`jj publishes no release build for ${p.os}`);
  }
}

/** The release asset for a version on this platform. */
export function assetName(version: string, p: Platform): string {
  const ext = p.os === "windows" ? "zip" : "tar.gz";
  return `jj-v${version}-${releaseTarget(p)}.${ext}`;
}

/** A jj release as the GitHub API reports it. */
export interface Release {
  version: string;
  assets: { name: string; url: string; digest: string }[];
}

const GITHUB_HEADERS = {
  accept: "application/vnd.github+json",
  "user-agent": "swamp-taylor-jj",
};

/** Reads the latest release, or the one for a version. */
export async function getRelease(
  fetchFn: Fetch,
  version: string,
): Promise<Release> {
  const url = version === "latest"
    ? `${RELEASES_API}/latest`
    : `${RELEASES_API}/tags/v${version}`;
  const res = await fetchFn(url, {
    headers: GITHUB_HEADERS,
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    let message = (await res.text()).slice(0, 300);
    try {
      message = String(JSON.parse(message).message ?? message);
    } catch { /* not JSON */ }
    const hint = res.status === 403 || res.status === 429
      ? " (GitHub rate-limits unauthenticated requests to 60 an hour; try again later)"
      : "";
    throw new Error(
      `GitHub returned ${res.status} for ${url}: ${message}${hint}`,
    );
  }
  const body = await res.json() as {
    tag_name?: string;
    assets?: {
      name?: string;
      browser_download_url?: string;
      digest?: string | null;
    }[];
  };
  return {
    version: String(body.tag_name ?? "").replace(/^v/, ""),
    assets: (body.assets ?? []).map((a) => ({
      name: String(a.name ?? ""),
      url: String(a.browser_download_url ?? ""),
      digest: String(a.digest ?? ""),
    })),
  };
}

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Downloads a release archive, checks its SHA-256 against GitHub's digest,
 * extracts jj and puts it in dir. Returns the installed path.
 */
export async function installRelease(
  release: Release,
  dir: string,
  p: Platform,
  run: Run,
  fetchFn: Fetch,
): Promise<string> {
  const name = assetName(release.version, p);
  const asset = release.assets.find((a) => a.name === name);
  if (!asset) {
    throw new Error(`jj ${release.version} has no release asset ${name}`);
  }
  const want = /^sha256:([0-9a-f]{64})$/.exec(asset.digest)?.[1];
  if (!want) {
    throw new Error(`GitHub lists no SHA-256 digest for ${name}`);
  }
  const res = await fetchFn(asset.url, {
    headers: { "user-agent": GITHUB_HEADERS["user-agent"] },
    signal: AbortSignal.timeout(300000),
  });
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`Downloading ${name} failed: HTTP ${res.status}`);
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  const got = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (got !== want) {
    throw new Error(`${name} has SHA-256 ${got}, but GitHub lists ${want}`);
  }

  const tmp = await Deno.makeTempDir({ prefix: "swamp-jj-" });
  try {
    const archive = joinPath(p.os, tmp, name);
    await Deno.writeFile(archive, bytes);
    // Windows' own bsdtar reads zip files; a GNU tar from Git for Windows
    // earlier on PATH would not.
    const tar = p.os === "windows"
      ? joinPath(
        p.os,
        p.env("SystemRoot") ?? "C:\\Windows",
        "System32",
        "tar.exe",
      )
      : "tar";
    const x = await run(tar, ["-xf", archive, "-C", tmp]);
    if (x.code !== 0) throw new Error(`Extracting ${name} failed: ${x.stderr}`);

    await Deno.mkdir(dir, { recursive: true });
    const dest = joinPath(p.os, dir, binName(p.os));
    // Copy next to the destination and rename over it, so a jj that is
    // running keeps its old file.
    const staged = `${dest}.new`;
    try {
      await Deno.copyFile(joinPath(p.os, tmp, binName(p.os)), staged);
      if (p.os !== "windows") await Deno.chmod(staged, 0o755);
      await Deno.rename(staged, dest);
    } catch (err) {
      await Deno.remove(staged).catch(() => {});
      throw new Error(
        `Installing jj to ${dest} failed: ${(err as Error).message}`,
      );
    }
    return dest;
  } finally {
    await Deno.remove(tmp, { recursive: true }).catch(() => {});
  }
}

function check(r: RunResult, what: string): RunResult {
  if (r.code !== 0) {
    throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  }
  return r;
}

/** True when `winget upgrade` failed only because jj is already current. */
export function wingetUpToDate(r: RunResult): boolean {
  return r.code !== 0 &&
    /no (available|applicable) upgrade|no newer package/i.test(r.stdout);
}

const WINGET_FLAGS = [
  "--id",
  WINGET_ID,
  "--exact",
  "--silent",
  "--accept-package-agreements",
  "--accept-source-agreements",
  "--disable-interactivity",
];

/** True when PATH includes dir. */
export function onPath(dir: string, p: Platform): boolean {
  const norm = (s: string) => {
    const t = s.replace(/[\\/]+$/, "");
    return p.os === "windows" ? t.toLowerCase() : t;
  };
  const path = p.env("PATH") ?? p.env("Path") ?? "";
  return path.split(p.os === "windows" ? ";" : ":").some((d) =>
    norm(d) === norm(dir)
  );
}

/** The config keys and values the arguments ask for. */
export function desiredSettings(g: GlobalArgs): Record<string, SettingValue> {
  return {
    ...(g.userName ? { "user.name": g.userName } : {}),
    ...(g.userEmail ? { "user.email": g.userEmail } : {}),
    ...g.settings,
  };
}

/** A value as a TOML literal, the form `jj config set` parses. */
export function tomlValue(v: SettingValue): string {
  if (Array.isArray(v)) {
    return `[${v.map((s) => JSON.stringify(s)).join(", ")}]`;
  }
  return typeof v === "string" ? JSON.stringify(v) : String(v);
}

/** True when a value read from jj equals the wanted one. */
export function sameValue(current: unknown, wanted: SettingValue): boolean {
  return JSON.stringify(current) === JSON.stringify(wanted);
}

/**
 * Reads user-level config values with `jj config list --user`. A key that is
 * not set reads as undefined.
 */
export async function readSettings(
  run: Run,
  jj: string,
  keys: string[],
): Promise<Record<string, unknown>> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const r = check(
      await run(jj, [
        "config",
        "list",
        "--user",
        "-T",
        'json(value) ++ "\\n"',
        key,
      ]),
      `Reading ${key}`,
    );
    const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
    if (lines.length > 1) {
      throw new Error(`${key} is a table; set the keys inside it instead`);
    }
    out[key] = lines.length ? JSON.parse(lines[0]) : undefined;
  }
  return out;
}

/** Differences between the wanted and current config. */
export function configDrift(
  wanted: Record<string, SettingValue>,
  current: Record<string, unknown>,
): string[] {
  return Object.entries(wanted)
    .filter(([k, v]) => !sameValue(current[k], v))
    .map(([k, v]) =>
      `${k}: wanted ${JSON.stringify(v)}, found ${
        current[k] === undefined ? "unset" : JSON.stringify(current[k])
      }`
    );
}

async function userConfigPath(run: Run, jj: string): Promise<string | null> {
  const r = await run(jj, ["config", "path", "--user"]);
  const lines = r.stdout.split("\n").filter((l) => l.trim() !== "");
  // JJ_CONFIG can name several files; then there is no single one to back up.
  return r.code === 0 && lines.length === 1 ? lines[0].trim() : null;
}

function seams(args: Seams) {
  return {
    run: args._run ?? commandRunner(),
    fetchFn: args._fetch ?? fetch,
    p: args._platform ?? hostPlatform(),
  };
}

function versionDrift(g: GlobalArgs, found: Found | null): string[] {
  if (!found) return ["jj is not installed"];
  return g.version !== "latest" && found.version !== g.version
    ? [`version: wanted ${g.version}, found ${found.version}`]
    : [];
}

function installation(
  p: Platform,
  found: Found | null,
  method: InstallMethod | null,
  action: Installation["action"],
  drift: string[],
  managed: Managed | null,
): Installation {
  return {
    installed: found !== null,
    path: found?.path ?? null,
    version: found?.version ?? null,
    method,
    action,
    managed,
    os: p.os,
    arch: p.arch,
    drift,
    checkedAt: new Date().toISOString(),
  };
}

/** What an earlier install recorded as installed by this model. */
async function previousManaged(context: Context): Promise<Managed | null> {
  const prev = await context.readResource("installation");
  const parsed = ManagedSchema.safeParse(prev?.managed);
  return parsed.success ? parsed.data : null;
}

/**
 * Removes a jj this model installed. Something already gone counts as
 * removed; a file at a release path that isn't jj is left alone.
 */
export async function removeManaged(m: Managed, run: Run): Promise<void> {
  if (m.method === "release") {
    try {
      await Deno.lstat(m.path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return;
      throw err;
    }
    const r = await run(m.path, ["--version"]);
    if (r.code !== 0 || !parseVersion(r.stdout)) {
      throw new Error(`${m.path} is not a jj binary; left it alone`);
    }
    await Deno.remove(m.path);
  } else if (m.method === "brew") {
    if ((await run("brew", ["list", "--versions", "jj"])).code !== 0) return;
    check(await run("brew", ["uninstall", "jj"]), "brew uninstall jj");
  } else {
    const flags = [
      "--id",
      WINGET_ID,
      "--exact",
      "--accept-source-agreements",
      "--disable-interactivity",
    ];
    if ((await run("winget", ["list", ...flags])).code !== 0) return;
    check(
      await run("winget", ["uninstall", ...flags, "--silent"]),
      "winget uninstall",
    );
  }
}

/** Pre-flight: the platform can use the chosen install method. */
export function checkPlatform(
  g: GlobalArgs,
  p: Platform,
): { pass: boolean; errors?: string[] } {
  const errors: string[] = [];
  if (!["linux", "darwin", "windows"].includes(p.os)) {
    errors.push(`${p.os} is not supported; use Linux, macOS or Windows`);
  }
  if (g.installMethod === "brew" && p.os === "windows") {
    errors.push("Homebrew does not run on Windows; use winget or release");
  }
  if (g.installMethod === "winget" && p.os !== "windows") {
    errors.push("winget only runs on Windows; use brew or release");
  }
  if (g.installMethod === "brew" && g.version !== "latest") {
    errors.push(
      `Homebrew installs the current jj and can't pin ${g.version}; use release`,
    );
  }
  if (g.installMethod !== "brew" && g.installMethod !== "winget") {
    try {
      releaseTarget(p);
    } catch (err) {
      errors.push((err as Error).message);
    }
  }
  return errors.length ? { pass: false, errors } : { pass: true };
}

/** Pre-flight: an explicitly chosen package manager is installed. */
export async function checkPackageManager(
  g: GlobalArgs,
  run: Run,
): Promise<{ pass: boolean; errors?: string[] }> {
  if (g.installMethod !== "brew" && g.installMethod !== "winget") {
    return { pass: true };
  }
  return await available(run, g.installMethod)
    ? { pass: true }
    : { pass: false, errors: [`${g.installMethod} is not installed`] };
}

/** Pre-flight: jj can be found, so there is something to configure. */
export async function checkJjInstalled(
  g: GlobalArgs,
  p: Platform,
  run: Run,
): Promise<{ pass: boolean; errors?: string[] }> {
  return await findJj(run, jjCandidates(g, p)) ? { pass: true } : {
    pass: false,
    errors: ["jj is not installed; run install first, or set jjPath"],
  };
}

/** The `@taylor/jj/cli` swamp model type. */
export const model = {
  type: "@taylor/jj/cli",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "install no longer records a Homebrew or winget jj it only upgraded as managed; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    installation: {
      description: "Where jj is installed, its version and how it got there",
      schema: InstallationSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    config: {
      description: "The managed user-level jj config values",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "platform-supported": {
      description:
        "The OS and architecture can use the chosen install method and version",
      labels: ["policy"],
      appliesTo: ["install"],
      execute: (ctx: CheckContext) =>
        Promise.resolve(checkPlatform(ctx.globalArgs, hostPlatform())),
    },
    "package-manager-available": {
      description: "brew or winget is installed when installMethod names it",
      labels: ["live"],
      appliesTo: ["install"],
      execute: (ctx: CheckContext) =>
        checkPackageManager(ctx.globalArgs, commandRunner(30000)),
    },
    "jj-installed": {
      description: "jj is installed, so there is something to configure",
      labels: ["live"],
      appliesTo: ["configure"],
      execute: (ctx: CheckContext) =>
        checkJjInstalled(ctx.globalArgs, hostPlatform(), commandRunner(30000)),
    },
  },
  methods: {
    install: {
      description:
        "Install jj if it is missing or not the pinned version; with upgrade, also bring it to the latest release",
      arguments: InstallArgsSchema,
      execute: async (args: InstallArgs & Seams, context: Context) => {
        const g = context.globalArgs;
        const { run, fetchFn, p } = seams(args);
        const candidates = jjCandidates(g, p);
        const before = await findJj(run, candidates);
        const pinned = g.version !== "latest";
        const method = await resolveMethod(g, p, run);

        let needed = !before || (pinned && before.version !== g.version) ||
          (!pinned && args.upgrade);
        let release: Release | undefined;
        if (needed && method === "release") {
          release = await getRelease(fetchFn, g.version);
          if (before?.version === release.version) needed = false;
        }

        if (!needed) {
          context.logger.info("jj {version} is already installed at {path}", {
            version: before!.version,
            path: before!.path,
          });
          const handle = await context.writeResource(
            "installation",
            "installation",
            installation(
              p,
              before,
              null,
              "exists",
              versionDrift(g, before),
              await previousManaged(context),
            ),
          );
          return { dataHandles: [handle] };
        }

        context.logger.info("Installing jj {version} with {method}", {
          version: release?.version ?? g.version,
          method,
        });
        let first: string[] = [];
        // Whether this run put jj there. A Homebrew or winget package that
        // was already installed stays the user's, so uninstall leaves it.
        let ours = true;
        if (method === "release") {
          const dir = installDir(g, p);
          first = [
            await installRelease(release!, dir, p, run, fetchFn),
          ];
          if (!g.jjPath && !onPath(dir, p)) {
            context.logger.warn(
              "{dir} is not on PATH; add it so your shell finds jj",
              { dir },
            );
          }
        } else if (method === "brew") {
          if (pinned) {
            throw new Error(
              `Homebrew installs the current jj and can't pin ${g.version}; use release`,
            );
          }
          // A jj found elsewhere (a release build, a distro package) is not
          // Homebrew's to upgrade.
          const verb =
            (await run("brew", ["list", "--versions", "jj"])).code === 0
              ? "upgrade"
              : "install";
          ours = verb === "install";
          check(await run("brew", [verb, "jj"]), `brew ${verb} jj`);
          const prefix = await run("brew", ["--prefix"]);
          if (prefix.code === 0) first = [`${prefix.stdout}/bin/jj`];
        } else {
          const listed = (await run("winget", [
            "list",
            "--id",
            WINGET_ID,
            "--exact",
            "--accept-source-agreements",
            "--disable-interactivity",
          ])).code === 0;
          ours = !listed;
          const r = listed && !pinned
            ? await run("winget", ["upgrade", ...WINGET_FLAGS])
            : await run("winget", [
              "install",
              ...WINGET_FLAGS,
              ...(pinned ? ["--version", g.version, "--force"] : []),
            ]);
          if (!wingetUpToDate(r)) check(r, "winget");
          const link = wingetLink(p);
          if (link) first = [link];
        }

        const after = await findJj(run, [
          ...(g.jjPath ? [] : first),
          ...candidates,
        ]);
        if (!after) {
          throw new Error(`jj was installed with ${method} but can't be run`);
        }
        const action = !before
          ? "installed"
          : before.version === after.version && before.path === after.path
          ? "exists"
          : "updated";
        context.logger.info("jj {version} is at {path} ({action})", {
          version: after.version,
          path: after.path,
          action,
        });
        const drift = versionDrift(g, after);
        for (const item of drift) {
          context.logger.warn("Drift: {item}", { item });
        }
        const handle = await context.writeResource(
          "installation",
          "installation",
          installation(
            p,
            after,
            method,
            action,
            drift,
            ours
              ? { method, path: after.path }
              : await previousManaged(context),
          ),
        );
        return { dataHandles: [handle] };
      },
    },
    uninstall: {
      description:
        "Remove the jj this model installed (the release build, or the Homebrew or winget package); a jj installed any other way is left alone",
      arguments: z.object({}),
      execute: async (args: Seams, context: Context) => {
        const g = context.globalArgs;
        const { run, p } = seams(args);
        const managed = await previousManaged(context);
        if (managed) {
          context.logger.info("Removing jj installed with {method} at {path}", {
            method: managed.method,
            path: managed.path,
          });
          await removeManaged(managed, run);
        } else {
          context.logger.warn(
            "This model hasn't installed jj, so there is nothing to remove",
          );
        }
        const found = await findJj(run, jjCandidates(g, p));
        if (found) {
          context.logger.warn("jj {version} is still at {path}", {
            version: found.version,
            path: found.path,
          });
        } else {
          context.logger.info("jj is no longer installed");
        }
        const action = managed ? "removed" : found ? "exists" : "missing";
        const handle = await context.writeResource(
          "installation",
          "installation",
          installation(p, found, null, action, [], null),
        );
        return { dataHandles: [handle] };
      },
    },
    configure: {
      description:
        "Set user.name, user.email and the other settings in jj's user config, changing only keys that differ",
      arguments: z.object({}),
      execute: async (args: Seams, context: Context) => {
        const g = context.globalArgs;
        const { run, p } = seams(args);
        const found = await findJj(run, jjCandidates(g, p));
        if (!found) {
          throw new Error(
            "jj is not installed; run install first, or set jjPath",
          );
        }
        const wanted = desiredSettings(g);
        const keys = Object.keys(wanted);
        if (!keys.length) {
          context.logger.warn(
            "Nothing to configure: set userName, userEmail or settings",
          );
        }
        const path = await userConfigPath(run, found.path);
        const current = await readSettings(run, found.path, keys);
        const changed = keys.filter((k) => !sameValue(current[k], wanted[k]));

        let settings = current;
        if (changed.length) {
          let original: string | null = null;
          if (path) {
            original = await Deno.readTextFile(path).catch(() => null);
          }
          try {
            for (const key of changed) {
              context.logger.info("Setting {key} = {value}", {
                key,
                value: tomlValue(wanted[key]),
              });
              check(
                await run(found.path, [
                  "config",
                  "set",
                  "--user",
                  key,
                  tomlValue(wanted[key]),
                ]),
                `Setting ${key}`,
              );
            }
            settings = await readSettings(run, found.path, keys);
            const left = configDrift(wanted, settings);
            if (left.length) {
              throw new Error(`jj did not keep ${left.join("; ")}`);
            }
          } catch (err) {
            // jj writes a value before checking it, and a value it rejects
            // breaks every later jj command, so put the file back.
            if (path) {
              if (original === null) {
                await Deno.remove(path).catch(() => {});
              } else {
                await Deno.writeTextFile(path, original);
              }
            }
            throw new Error(
              `jj rejected the new config (${changed.join(", ")}): ${
                (err as Error).message
              }${path ? `; restored ${path}` : ""}`,
            );
          }
        } else {
          context.logger.info("jj config already matches ({count} keys)", {
            count: keys.length,
          });
        }
        const handle = await context.writeResource("config", "config", {
          path,
          settings,
          changed,
          drift: [],
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Read the installed jj and its config without changing anything, recording drift from the arguments",
      arguments: z.object({}),
      execute: async (args: Seams, context: Context) => {
        const g = context.globalArgs;
        const { run, p } = seams(args);
        context.logger.info("Reading jj and its config");
        const found = await findJj(run, jjCandidates(g, p));
        const drift = versionDrift(g, found);
        // Read everything before writing anything, so a config jj can't
        // parse fails the run without leaving half its data behind.
        let config: Record<string, unknown> | undefined;
        if (found) {
          const wanted = desiredSettings(g);
          const settings = await readSettings(
            run,
            found.path,
            Object.keys(wanted),
          );
          config = {
            path: await userConfigPath(run, found.path),
            settings,
            changed: [],
            drift: configDrift(wanted, settings),
            checkedAt: new Date().toISOString(),
          };
        }
        context.logger.info("jj {version} at {path}", {
          version: found?.version ?? "not installed",
          path: found?.path ?? "-",
        });
        for (const item of [...drift, ...(config?.drift as string[] ?? [])]) {
          context.logger.warn("Drift: {item}", { item });
        }
        const handles = [
          await context.writeResource(
            "installation",
            "installation",
            installation(
              p,
              found,
              null,
              found ? "exists" : "missing",
              drift,
              await previousManaged(context),
            ),
          ),
        ];
        if (config) {
          handles.push(await context.writeResource("config", "config", config));
        }
        return { dataHandles: handles };
      },
    },
  },
};
