// Where a host scan runs commands and reads files: the machine swamp runs
// on, or another one over SSH. Every file operation the host scan needs is
// here, shaped so that over SSH each is one round trip however many paths
// it covers.

/** Result of one command. `code` is 127 when the command can't be run. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with the given arguments. Injectable for tests. */
export type Run = (cmd: string, args: string[]) => Promise<RunResult>;

/** A regular file directly in a directory. */
export interface FileEntry {
  path: string;
  size: number;
  executable: boolean;
}

/** File access on the machine being scanned. */
export interface Fs {
  /** The path separator. */
  sep: string;
  /** A file's bytes, or null when nothing is there. Throws when it can't be read. */
  read(path: string): Promise<Uint8Array | null>;
  /** Where a path leads once links are followed, or null when nothing is there. */
  realPath(path: string): Promise<string | null>;
  /**
   * The directories under a root, down to `depth` levels and not through
   * links, sorted; none when the root can't be read.
   */
  dirs(root: string, depth: number): Promise<string[]>;
  /** Which of the paths are files, or directories. */
  existing(paths: string[], kind: "file" | "dir"): Promise<Set<string>>;
  /** The regular files directly in a directory; none when it can't be read. */
  files(dir: string): Promise<FileEntry[]>;
  /** The first text in a file matching an extended regular expression. */
  firstMatch(path: string, ere: string): Promise<string | null>;
  /**
   * Files with one of these names under the roots, down to `depth` levels,
   * not descending into directories named in `prune`.
   */
  find(
    roots: string[],
    names: string[],
    depth: number,
    prune: string[],
  ): Promise<string[]>;
  /** A new temporary directory, and writing to and removing it. */
  tempDir(): Promise<string>;
  writeText(path: string, text: string): Promise<void>;
  remove(path: string): Promise<void>;
}

const LOCAL_SEP = Deno.build.os === "windows" ? "\\" : "/";

async function localEntries(dir: string): Promise<Deno.DirEntry[]> {
  const out: Deno.DirEntry[] = [];
  try {
    for await (const e of Deno.readDir(dir)) out.push(e);
  } catch { /* missing or unreadable */ }
  return out.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** The machine swamp runs on. */
export const LOCAL_FS: Fs = {
  sep: LOCAL_SEP,
  async read(path) {
    try {
      return await Deno.readFile(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  },
  async realPath(path) {
    try {
      return await Deno.realPath(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return null;
      throw err;
    }
  },
  async dirs(root, depth) {
    const out: string[] = [];
    const walk = async (dir: string, level: number) => {
      for (const e of await localEntries(dir)) {
        if (!e.isDirectory) continue;
        const path = `${dir}${LOCAL_SEP}${e.name}`;
        out.push(path);
        if (level < depth) await walk(path, level + 1);
      }
    };
    await walk(root, 1);
    return out.sort();
  },
  async existing(paths, kind) {
    const out = new Set<string>();
    for (const path of paths) {
      try {
        const st = await Deno.stat(path);
        if (kind === "dir" ? st.isDirectory : st.isFile) out.add(path);
      } catch { /* not there */ }
    }
    return out;
  },
  async files(dir) {
    const out: FileEntry[] = [];
    for (const e of await localEntries(dir)) {
      if (!e.isFile) continue;
      const path = `${dir}${LOCAL_SEP}${e.name}`;
      try {
        const st = await Deno.stat(path);
        out.push({
          path,
          size: st.size,
          executable: st.mode === null || !!(st.mode & 0o111),
        });
      } catch { /* gone or unreadable */ }
    }
    return out;
  },
  async firstMatch(path, ere) {
    // The string can sit deep in a 200 MB executable, so it is streamed
    // rather than read whole.
    const pattern = new RegExp(ere);
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
        if (m) return m[0];
        // Keep enough to catch a match split across reads.
        tail = text.slice(-64);
      }
    } finally {
      file.close();
    }
  },
  async find(roots, names, depth, prune) {
    const out: string[] = [];
    const walk = async (dir: string, level: number) => {
      for (const e of await localEntries(dir)) {
        const path = `${dir}${LOCAL_SEP}${e.name}`;
        if (e.isFile && names.includes(e.name)) out.push(path);
        else if (
          e.isDirectory && level < depth && !prune.includes(e.name)
        ) {
          await walk(path, level + 1);
        }
      }
    };
    for (const root of roots) {
      // A root can be a lockfile itself, as find allows.
      const name = root.split(/[\\/]/).at(-1)!;
      if (
        names.includes(name) && (await LOCAL_FS.existing([root], "file")).size
      ) {
        out.push(root);
      } else {
        await walk(root, 1);
      }
    }
    return out;
  },
  tempDir: () => Deno.makeTempDir({ prefix: "emudhra-" }),
  writeText: (path, text) => Deno.writeTextFile(path, text),
  async remove(path) {
    await Deno.remove(path, { recursive: true }).catch(() => {});
  },
};

/** Quotes a word for a POSIX shell. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

/**
 * Runs commands on another machine with `ssh`, which hands the remote login
 * shell one command line, so each word is quoted. ssh exits 255 when it
 * can't connect.
 */
export function sshRunner(run: Run, dest: string, opts: string[]): Run {
  return (cmd, args) =>
    run("ssh", [
      ...opts,
      "--",
      dest,
      [cmd, ...args].map(shQuote).join(" "),
    ]);
}

/** Exit code the remote scripts use for "nothing there". */
const MISSING = 44;

/** Paths per remote call, well inside any command line limit. */
const BATCH = 400;

function decodeBase64(text: string): Uint8Array {
  const bin = atob(text.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.length);
}

/**
 * File access on a Linux or macOS machine through `run`, which runs each
 * command there (see sshRunner). Every operation is one `sh -c` script,
 * using only POSIX tools plus `base64`, and `find -maxdepth`, which GNU,
 * BSD and BusyBox all have.
 */
export function remoteFs(run: Run): Fs {
  const sh = (script: string, ...args: string[]) =>
    run("sh", ["-c", script, "sh", ...args]);
  const fail = (what: string, path: string, r: RunResult) =>
    new Error(
      `${what} ${path}: ${r.stderr || r.stdout || `exit ${r.code}`}`,
    );
  return {
    sep: "/",
    async read(path) {
      const r = await sh(
        `[ -e "$1" ] || exit ${MISSING}; base64 < "$1"`,
        path,
      );
      if (r.code === MISSING) return null;
      if (r.code !== 0) throw fail("Could not read", path, r);
      return decodeBase64(r.stdout);
    },
    async realPath(path) {
      const r = await sh(
        // BusyBox realpath takes -- for a file name, so a leading - is
        // guarded by hand; and a failed attempt prints nothing to stdout.
        `[ -e "$1" ] || exit ${MISSING}
case "$1" in -*) set -- "./$1" ;; esac
p=$(realpath "$1" 2>/dev/null) || p=$(readlink -f "$1" 2>/dev/null) || p=$1
printf '%s\\n' "$p"`,
        path,
      );
      if (r.code === MISSING) return null;
      if (r.code !== 0) throw fail("Could not resolve", path, r);
      return r.stdout.trim();
    },
    async dirs(root, depth) {
      const r = await sh(
        `find "$1" -mindepth 1 -maxdepth "$2" -type d 2>/dev/null; exit 0`,
        root,
        String(depth),
      );
      return lines(r.stdout).sort();
    },
    async existing(paths, kind) {
      const out = new Set<string>();
      for (let i = 0; i < paths.length; i += BATCH) {
        const r = await sh(
          `t=$1; shift; for f; do [ "$t" "$f" ] && printf '%s\\n' "$f"; done; exit 0`,
          kind === "dir" ? "-d" : "-f",
          ...paths.slice(i, i + BATCH),
        );
        for (const l of lines(r.stdout)) out.add(l);
      }
      return out;
    },
    async files(dir) {
      const r = await sh(
        `cd -- "$1" 2>/dev/null || exit 0
for f in * .[!.]*; do
  [ -f "$f" ] && [ ! -L "$f" ] || continue
  x=-; [ -x "$f" ] && x=x
  printf '%s\\t%s\\t%s\\n' "$(wc -c < "$f" | tr -d ' ')" "$x" "$f"
done`,
        dir,
      );
      return lines(r.stdout).map((l) => {
        const [size, x, ...name] = l.split("\t");
        return {
          path: `${dir}/${name.join("\t")}`,
          size: parseInt(size, 10) || 0,
          executable: x === "x",
        };
      });
    },
    async firstMatch(path, ere) {
      const r = await sh(
        `grep -a -o -m 1 -E -e "$2" -- "$1" 2>/dev/null | head -n 1`,
        path,
        ere,
      );
      return r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
    },
    async find(roots, names, depth, prune) {
      if (!roots.length || !names.length) return [];
      // roots -maxdepth D ( -name p1 -o ... ) -prune -o -type f ( -name n1 -o ... ) -print
      const alt = (xs: string[]) =>
        xs.flatMap((x, i) => i ? ["-o", "-name", x] : ["-name", x]);
      const expr = [
        "-maxdepth",
        String(depth),
        ...(prune.length ? ["(", ...alt(prune), ")", "-prune", "-o"] : []),
        "-type",
        "f",
        "(",
        ...alt(names),
        ")",
        "-print",
      ];
      // find reads leading words as paths until one looks like an expression.
      const r = await sh(
        `find "$@" 2>/dev/null; exit 0`,
        ...roots.map((p) => /^[-(!]/.test(p) ? `./${p}` : p),
        ...expr,
      );
      return lines(r.stdout);
    },
    async tempDir() {
      const r = await run("mktemp", ["-d"]);
      if (r.code !== 0) {
        throw new Error(`Could not make a temporary directory: ${r.stderr}`);
      }
      return r.stdout.trim();
    },
    async writeText(path, text) {
      const r = await sh(`printf '%s' "$2" > "$1"`, path, text);
      if (r.code !== 0) throw fail("Could not write", path, r);
    },
    async remove(path) {
      await sh(`rm -rf -- "$1"`, path);
    },
  };
}
