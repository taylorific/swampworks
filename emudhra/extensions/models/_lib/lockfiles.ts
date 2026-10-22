// Lockfiles that pin a package carrying its own CA roots, or its own
// verifier, so a program built from them trusts the compromised eMudhra
// intermediates until the package is updated, whatever the OS store says.

/** A package manager whose lockfiles are read. */
export type Ecosystem = "cargo" | "hex" | "pypi" | "composer";

/** The lockfiles read, by file name. */
export const LOCKFILES: Record<string, Ecosystem> = {
  "Cargo.lock": "cargo",
  "mix.lock": "hex",
  "rebar.lock": "hex",
  "uv.lock": "pypi",
  "poetry.lock": "pypi",
  "pdm.lock": "pypi",
  "Pipfile.lock": "pypi",
  "composer.lock": "composer",
};

/** Directories not searched for lockfiles: builds, caches and installs. */
export const PRUNE = [
  ".git",
  "node_modules",
  "target",
  "_build",
  ".venv",
  "venv",
  "__pycache__",
];

/** Where a package's fix stands. */
export interface DependencyFix {
  fixedIn: string[];
  /** Leading numbers that name a release line, as for toolchains. */
  lineParts: number;
  note?: string;
}

/**
 * Patched releases, keyed `ecosystem:package`. From the page's table
 * (fetched 2026-10-22), except tls_certificate_check, from its changelog
 * (1.36.0 removes emSign ECC Root CA - G3).
 */
export const DEPENDENCY_FIXES: Record<string, DependencyFix> = {
  "cargo:webpki-roots": { fixedIn: ["1.0.10"], lineParts: 0 },
  "cargo:webpki-root-certs": { fixedIn: ["1.0.10"], lineParts: 0 },
  // 0.x crates break compatibility at the minor version.
  "cargo:rustls-webpki": { fixedIn: ["0.103.16"], lineParts: 2 },
  "hex:castore": { fixedIn: ["1.0.22"], lineParts: 0 },
  "hex:certifi": {
    fixedIn: [],
    lineParts: 0,
    note: "pending on the page (certifi/erlang-certifi#56)",
  },
  "hex:tls_certificate_check": { fixedIn: ["1.36.0"], lineParts: 0 },
  "pypi:certifi": { fixedIn: ["2026.10.19"], lineParts: 0 },
  "composer:composer/ca-bundle": {
    fixedIn: ["1.4.16", "1.6.0"],
    lineParts: 2,
  },
};

/** A watched package pinned in a lockfile. */
export interface Pinned {
  ecosystem: Ecosystem;
  package: string;
  version: string;
}

/** The base name of a path with either separator. */
export function baseName(path: string): string {
  return path.split(/[\\/]/).at(-1)!;
}

const watched = (e: Ecosystem, pkg: string) =>
  `${e}:${pkg}` in DEPENDENCY_FIXES;

/** The [[package]] tables of a TOML lockfile: Cargo, uv, Poetry and PDM. */
function tomlPackages(
  text: string,
): { name: string; version: string; deps: string[] }[] {
  return text.split(/^\[\[package\]\]\s*$/m).slice(1).flatMap((block) => {
    const name = block.match(/^name = "([^"]+)"/m)?.[1];
    const version = block.match(/^version = "([^"]+)"/m)?.[1];
    if (!name || !version) return [];
    const list = block.match(/^dependencies = \[([\s\S]*?)\]/m)?.[1] ?? "";
    const deps = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    return [{ name, version, deps }];
  });
}

/**
 * The watched packages a lockfile pins. A webpki-roots 0.26 that depends on
 * webpki-roots 1.x only re-exports it, so the 1.x entry is the one that
 * counts.
 */
export function parseLockfile(path: string, text: string): Pinned[] {
  const name = baseName(path);
  const ecosystem = LOCKFILES[name];
  if (!ecosystem) return [];
  const out: Pinned[] = [];
  const add = (pkg: string, version: string) => {
    if (watched(ecosystem, pkg)) {
      out.push({ ecosystem, package: pkg, version });
    }
  };
  if (name === "mix.lock") {
    // "castore": {:hex, :castore, "1.0.22", ...}
    for (
      const m of text.matchAll(
        /"[^"]+":\s*\{:hex,\s*:([a-z0-9_]+),\s*"([^"]+)"/g,
      )
    ) add(m[1], m[2]);
  } else if (name === "rebar.lock") {
    // {<<"certifi">>,{pkg,<<"certifi">>,<<"2.15.0">>},0}
    for (
      const m of text.matchAll(
        /\{<<"[^"]+">>,\s*\{pkg,\s*<<"([^"]+)">>,\s*<<"([^"]+)">>/g,
      )
    ) add(m[1], m[2]);
  } else if (name === "composer.lock" || name === "Pipfile.lock") {
    let json: Record<string, unknown>;
    try {
      json = JSON.parse(text);
    } catch {
      return [];
    }
    if (name === "composer.lock") {
      for (const key of ["packages", "packages-dev"]) {
        const list = json[key];
        if (!Array.isArray(list)) continue;
        for (const p of list) {
          if (typeof p?.name === "string" && typeof p?.version === "string") {
            add(p.name, p.version.replace(/^v/, ""));
          }
        }
      }
    } else {
      for (const key of ["default", "develop"]) {
        const section = json[key];
        if (!section || typeof section !== "object") continue;
        for (const [pkg, p] of Object.entries(section)) {
          const v = (p as { version?: unknown })?.version;
          if (typeof v === "string") add(pkg, v.replace(/^==/, ""));
        }
      }
    }
  } else {
    for (const p of tomlPackages(text)) {
      if (
        p.name === "webpki-roots" &&
        p.deps.some((d) => d.startsWith("webpki-roots "))
      ) continue;
      add(p.name, p.version);
    }
  }
  return out;
}

/** The command that updates a package in a lockfile. */
export function updateCommand(lockfile: string, pkg: string): string {
  switch (baseName(lockfile)) {
    case "Cargo.lock":
      return `cargo update -p ${pkg}`;
    case "mix.lock":
      return `mix deps.update ${pkg}`;
    case "rebar.lock":
      return `rebar3 upgrade ${pkg}`;
    case "uv.lock":
      return `uv lock --upgrade-package ${pkg}`;
    case "poetry.lock":
      return `poetry update ${pkg}`;
    case "pdm.lock":
      return `pdm update ${pkg}`;
    case "Pipfile.lock":
      return `pipenv update ${pkg}`;
    default:
      return `composer update ${pkg}`;
  }
}
