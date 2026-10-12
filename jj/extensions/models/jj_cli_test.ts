import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  assetName,
  checkPlatform,
  configDrift,
  type Fetch,
  jjCandidates,
  joinPath,
  model,
  parseVersion,
  type Platform,
  type RunResult,
  tomlValue,
  wingetUpToDate,
} from "./jj_cli.ts";

type Ctx = Parameters<typeof model.methods.install.execute>[1];

const linux = (env: Record<string, string> = {}): Platform => ({
  os: "linux",
  arch: "x86_64",
  env: (k) => ({ HOME: "/home/me", PATH: "/usr/bin", ...env })[k],
});
const mac: Platform = {
  os: "darwin",
  arch: "aarch64",
  env: (k) => ({ HOME: "/Users/me", PATH: "/usr/bin" })[k as "HOME"],
};
const windows: Platform = {
  os: "windows",
  arch: "x86_64",
  env: (k) =>
    ({ LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", PATH: "" })[
      k as "LOCALAPPDATA"
    ],
};

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const missing: RunResult = { code: 127, stdout: "", stderr: "not found" };

type Handler = (cmd: string, args: string[]) => RunResult | undefined;

/** A fake runner: the first handler that answers wins; records every call. */
function fakeRun(...handlers: Handler[]) {
  const calls: string[] = [];
  const run = (cmd: string, args: string[]) => {
    calls.push([cmd, ...args].join(" "));
    for (const h of handlers) {
      const r = h(cmd, args);
      if (r) return Promise.resolve(r);
    }
    return Promise.resolve(missing);
  };
  return { run, calls };
}

/** jj at the given paths, answering --version with its version. */
const jjAt = (versions: Record<string, string>): Handler => (cmd, args) =>
  versions[cmd] && args[0] === "--version"
    ? ok(`jj ${versions[cmd]}-7d382314f9420b4b`)
    : undefined;

/**
 * A fake jj config backed by a map, answering `config list --user` and
 * `config set --user` the way jj does.
 */
function fakeConfig(jj: string, store: Record<string, string> = {}): Handler {
  return (cmd, args) => {
    if (cmd !== jj || args[0] !== "config") return undefined;
    if (args[1] === "path") return ok("/home/me/.config/jj/config.toml");
    if (args[1] === "list") {
      const key = args[args.length - 1];
      return ok(store[key] === undefined ? "" : JSON.stringify(store[key]));
    }
    if (args[1] === "set") {
      store[args[3]] = JSON.parse(args[4]);
      return ok();
    }
    return undefined;
  };
}

async function runMethod(
  method: "install" | "uninstall" | "configure" | "sync",
  seams: Record<string, unknown>,
  globals: Record<string, unknown> = {},
  args: Record<string, unknown> = {},
  stored: Record<string, Record<string, unknown>> = {},
) {
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse(globals),
    methodName: method,
    storedResources: stored,
  });
  const m = model.methods[method];
  await m.execute(
    // deno-lint-ignore no-explicit-any
    { ...m.arguments.parse(args), ...seams } as any,
    test.context as unknown as Ctx,
  );
  const out: Record<string, Record<string, unknown>> = {};
  for (const r of test.getWrittenResources()) {
    out[r.specName] = r.data as Record<string, unknown>;
  }
  return out;
}

Deno.test("parseVersion reads jj --version output", () => {
  assertEquals(parseVersion("jj 0.46.0-7d382314f9420b4b"), "0.46.0");
  assertEquals(parseVersion("jj 0.25.0"), "0.25.0");
  assertEquals(parseVersion("git version 2.45"), null);
});

Deno.test("assetName matches jj's release assets", () => {
  assertEquals(
    assetName("0.46.0", linux()),
    "jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz",
  );
  assertEquals(
    assetName("0.46.0", mac),
    "jj-v0.46.0-aarch64-apple-darwin.tar.gz",
  );
  assertEquals(
    assetName("0.46.0", windows),
    "jj-v0.46.0-x86_64-pc-windows-msvc.zip",
  );
});

Deno.test("tomlValue quotes strings so jj stores them as strings", () => {
  assertEquals(tomlValue("never"), '"never"');
  assertEquals(tomlValue('Mischa "T"'), '"Mischa \\"T\\""');
  assertEquals(tomlValue("true"), '"true"');
  assertEquals(tomlValue(true), "true");
  assertEquals(tomlValue(1000), "1000");
  assertEquals(tomlValue(["log", "-r", "all()"]), '["log", "-r", "all()"]');
});

Deno.test("configDrift lists only keys that differ", () => {
  assertEquals(
    configDrift(
      { "user.name": "Me", "ui.paginate": "never", "aliases.l": ["log"] },
      { "user.name": "Me", "aliases.l": ["log"] },
    ),
    ['ui.paginate: wanted "never", found unset'],
  );
});

Deno.test("jjCandidates covers PATH, installDir, Homebrew and winget", () => {
  const g = model.globalArguments.parse({});
  assertEquals(jjCandidates(g, mac), [
    "/Users/me/.local/bin/jj",
    "jj",
    "/opt/homebrew/bin/jj",
    "/usr/local/bin/jj",
  ]);
  assertEquals(jjCandidates(g, windows), [
    "C:\\Users\\me\\AppData\\Local\\Programs\\jj\\jj.exe",
    "jj",
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\jj.exe",
  ]);
  assertEquals(
    jjCandidates(model.globalArguments.parse({ jjPath: "/opt/jj" }), mac),
    ["/opt/jj"],
  );
});

Deno.test("checkPlatform rejects methods the platform can't use", () => {
  const parse = (a: Record<string, unknown>) => model.globalArguments.parse(a);
  assertEquals(checkPlatform(parse({}), linux()).pass, true);
  assertEquals(
    checkPlatform(parse({ installMethod: "brew" }), windows).pass,
    false,
  );
  assertEquals(
    checkPlatform(parse({ installMethod: "winget" }), mac).pass,
    false,
  );
  assertEquals(
    checkPlatform(parse({ installMethod: "brew", version: "0.40.0" }), mac)
      .pass,
    false,
  );
  assertEquals(
    checkPlatform(parse({}), { ...linux(), arch: "riscv64" }).pass,
    false,
  );
});

Deno.test("winget reporting no upgrade is not a failure", () => {
  assert(
    wingetUpToDate({
      code: -1978335189,
      stdout: "No available upgrade found.",
      stderr: "",
    }),
  );
  assert(!wingetUpToDate({ code: 1, stdout: "Installer failed", stderr: "" }));
});

Deno.test("version must be latest or x.y.z", () => {
  assertEquals(
    model.globalArguments.safeParse({ version: "v0.46" }).success,
    false,
  );
});

Deno.test("install leaves an installed jj alone", async () => {
  const { run, calls } = fakeRun(jjAt({ jj: "0.45.0" }));
  const out = await runMethod("install", { _run: run, _platform: linux() });
  assertEquals(out.installation.action, "exists");
  assertEquals(out.installation.version, "0.45.0");
  assertEquals(calls, ["/home/me/.local/bin/jj --version", "jj --version"]);
});

Deno.test("install downloads, verifies and installs the release", async () => {
  const home = await Deno.makeTempDir();
  try {
    const archive = new TextEncoder().encode("pretend tarball");
    const digest = [
      ...new Uint8Array(await crypto.subtle.digest("SHA-256", archive)),
    ].map((b) => b.toString(16).padStart(2, "0")).join("");
    const name = "jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz";
    const fetched: string[] = [];
    const fakeFetch: Fetch = (url) => {
      fetched.push(url);
      if (url.endsWith("/releases/latest")) {
        return Promise.resolve(Response.json({
          tag_name: "v0.46.0",
          assets: [{
            name,
            browser_download_url: `https://example.test/${name}`,
            digest: `sha256:${digest}`,
          }],
        }));
      }
      return Promise.resolve(new Response(archive));
    };
    const dest = joinPath("linux", home, ".local", "bin", "jj");
    const { run, calls } = fakeRun(
      (cmd, args) => {
        try {
          Deno.statSync(dest);
        } catch {
          return undefined;
        }
        return jjAt({ [dest]: "0.46.0" })(cmd, args);
      },
      (cmd, args) => {
        if (cmd !== "tar") return undefined;
        // Stand in for extraction: put a jj where tar would.
        Deno.writeTextFileSync(joinPath("linux", args[3], "jj"), "#!/bin/sh");
        return ok();
      },
    );
    const out = await runMethod("install", {
      _run: run,
      _fetch: fakeFetch,
      _platform: linux({ HOME: home }),
    });
    assertEquals(out.installation.action, "installed");
    assertEquals(out.installation.method, "release");
    assertEquals(out.installation.path, dest);
    assertEquals(out.installation.managed, { method: "release", path: dest });
    assertEquals((await Deno.stat(dest)).mode! & 0o777, 0o755);
    assertEquals(fetched.length, 2);
    assert(calls.some((c) => c.startsWith("tar -xf ")));
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("install refuses an archive whose digest doesn't match", async () => {
  const name = "jj-v0.46.0-x86_64-unknown-linux-musl.tar.gz";
  const fakeFetch: Fetch = (url) =>
    Promise.resolve(
      url.endsWith("/latest")
        ? Response.json({
          tag_name: "v0.46.0",
          assets: [{
            name,
            browser_download_url: "https://example.test/a",
            digest: `sha256:${"0".repeat(64)}`,
          }],
        })
        : new Response("tampered"),
    );
  const { run } = fakeRun();
  await assertRejects(
    () =>
      runMethod("install", {
        _run: run,
        _fetch: fakeFetch,
        _platform: linux(),
      }),
    Error,
    "but GitHub lists",
  );
});

Deno.test("install uses Homebrew on macOS when it is there", async () => {
  let installed = false;
  const { run, calls } = fakeRun(
    (cmd, args) => {
      if (cmd !== "brew") return undefined;
      if (args[0] === "--version") return ok("Homebrew 4.6.0");
      if (args[0] === "list") return missing;
      if (args[0] === "install") {
        installed = true;
        return ok();
      }
      if (args[0] === "--prefix") return ok("/opt/homebrew");
    },
    (cmd, args) =>
      installed && cmd === "/opt/homebrew/bin/jj" && args[0] === "--version"
        ? ok("jj 0.46.0")
        : undefined,
  );
  const out = await runMethod("install", { _run: run, _platform: mac });
  assert(calls.includes("brew install jj"));
  assertEquals(out.installation.method, "brew");
  assertEquals(out.installation.path, "/opt/homebrew/bin/jj");
  assertEquals(out.installation.action, "installed");
});

Deno.test("install upgrades with winget on Windows", async () => {
  let version = "0.45.0";
  const link =
    "C:\\Users\\me\\AppData\\Local\\Microsoft\\WinGet\\Links\\jj.exe";
  const { run, calls } = fakeRun(
    (cmd, args) => {
      if (cmd !== "winget") return undefined;
      if (args[0] === "upgrade") version = "0.46.0";
      return ok();
    },
    (cmd, args) =>
      (cmd === "jj" || cmd === link) && args[0] === "--version"
        ? ok(`jj ${version}`)
        : undefined,
  );
  const out = await runMethod(
    "install",
    { _run: run, _platform: windows },
    {},
    { upgrade: true },
  );
  assert(calls.some((c) => c.startsWith("winget upgrade --id jj-vcs.jj")));
  assertEquals(out.installation.action, "updated");
  assertEquals(out.installation.version, "0.46.0");
});

Deno.test("configure sets only keys that differ", async () => {
  const store: Record<string, string> = { "user.name": "Me" };
  const { run, calls } = fakeRun(
    jjAt({ jj: "0.46.0" }),
    fakeConfig("jj", store),
  );
  const out = await runMethod("configure", { _run: run, _platform: linux() }, {
    userName: "Me",
    userEmail: "me@example.com",
    settings: { "ui.paginate": "never" },
  });
  assertEquals(out.config.changed, ["user.email", "ui.paginate"]);
  assertEquals(store["user.email"], "me@example.com");
  assertEquals(
    calls.filter((c) => c.startsWith("jj config set")),
    [
      'jj config set --user user.email "me@example.com"',
      'jj config set --user ui.paginate "never"',
    ],
  );
});

Deno.test("configure restores the config file when jj rejects a value", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = joinPath("linux", dir, "config.toml");
    await Deno.writeTextFile(path, 'user.name = "Me"\n');
    const { run } = fakeRun(jjAt({ jj: "0.46.0" }), (_cmd, args) => {
      if (args[0] !== "config") return undefined;
      if (args[1] === "path") return ok(path);
      if (args[1] === "list") return ok("");
      if (args[1] === "set") {
        Deno.writeTextFileSync(path, 'ui.color = "true"\n');
        return { code: 1, stdout: "", stderr: "Invalid type or value" };
      }
    });
    const err = await assertRejects(
      () =>
        runMethod("configure", { _run: run, _platform: linux() }, {
          settings: { "ui.color": "true" },
        }),
      Error,
    );
    assertStringIncludes(err.message, `restored ${path}`);
    assertEquals(await Deno.readTextFile(path), 'user.name = "Me"\n');
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("configure fails when jj is not installed", async () => {
  const { run } = fakeRun();
  await assertRejects(
    () => runMethod("configure", { _run: run, _platform: linux() }),
    Error,
    "jj is not installed",
  );
});

Deno.test("sync records version and config drift", async () => {
  const { run } = fakeRun(
    jjAt({ jj: "0.45.0" }),
    fakeConfig("jj", { "user.name": "Someone" }),
  );
  const out = await runMethod("sync", { _run: run, _platform: linux() }, {
    version: "0.46.0",
    userName: "Me",
  });
  assertEquals(out.installation.drift, [
    "version: wanted 0.46.0, found 0.45.0",
  ]);
  assertEquals(out.config.drift, [
    'user.name: wanted "Me", found "Someone"',
  ]);
});

Deno.test("sync reports a missing jj", async () => {
  const { run } = fakeRun();
  const out = await runMethod("sync", { _run: run, _platform: linux() });
  assertEquals(out.installation.action, "missing");
  assertEquals(out.config, undefined);
});

Deno.test("install keeps a pinned release build over an older jj on PATH", async () => {
  const { run, calls } = fakeRun(
    jjAt({ jj: "0.40.0", "/home/me/.local/bin/jj": "0.46.0" }),
  );
  const out = await runMethod(
    "install",
    { _run: run, _platform: linux() },
    { installMethod: "release", version: "0.46.0" },
  );
  assertEquals(out.installation.action, "exists");
  assertEquals(out.installation.path, "/home/me/.local/bin/jj");
  assertEquals(calls, ["/home/me/.local/bin/jj --version"]);
});

Deno.test("install reports GitHub's message when it refuses", async () => {
  const { run } = fakeRun();
  const fakeFetch: Fetch = () =>
    Promise.resolve(
      Response.json({ message: "API rate limit exceeded" }, { status: 403 }),
    );
  const err = await assertRejects(
    () =>
      runMethod("install", {
        _run: run,
        _fetch: fakeFetch,
        _platform: linux(),
      }),
    Error,
  );
  assertStringIncludes(err.message, "API rate limit exceeded");
  assertStringIncludes(err.message, "60 an hour");
});

Deno.test("sync writes nothing when jj can't read its config", async () => {
  const { run } = fakeRun(
    jjAt({ jj: "0.46.0" }),
    (_cmd, args) =>
      args[0] === "config"
        ? { code: 1, stdout: "", stderr: "Config error: Invalid type" }
        : undefined,
  );
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({ userName: "Me" }),
    methodName: "sync",
  });
  await assertRejects(
    () =>
      model.methods.sync.execute(
        { _run: run, _platform: linux() },
        test.context as unknown as Ctx,
      ),
    Error,
    "Config error",
  );
  assertEquals(test.getWrittenResources(), []);
});

/** A stored installation record saying this model installed jj. */
const stored = (method: string, path: string) => ({
  installation: { managed: { method, path } },
});

Deno.test("install and sync keep what an earlier install managed", async () => {
  const { run } = fakeRun(jjAt({ jj: "0.46.0" }), fakeConfig("jj"));
  const prev = stored("brew", "/opt/homebrew/bin/jj");
  for (const m of ["install", "sync"] as const) {
    const out = await runMethod(
      m,
      { _run: run, _platform: linux() },
      {},
      {},
      prev,
    );
    assertEquals(out.installation.managed, prev.installation.managed);
  }
});

Deno.test("uninstall removes the release build this model installed", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = joinPath("linux", dir, "jj");
    await Deno.writeTextFile(path, "#!/bin/sh");
    const { run } = fakeRun((cmd, args) => {
      try {
        Deno.statSync(cmd);
      } catch {
        return undefined;
      }
      return jjAt({ [path]: "0.46.0" })(cmd, args);
    });
    const out = await runMethod(
      "uninstall",
      { _run: run, _platform: linux() },
      { installDir: dir },
      {},
      stored("release", path),
    );
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    assertEquals(out.installation.action, "removed");
    assertEquals(out.installation.installed, false);
    assertEquals(out.installation.managed, null);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall leaves a file that isn't jj alone", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const path = joinPath("linux", dir, "jj");
    await Deno.writeTextFile(path, "something else");
    const { run } = fakeRun();
    await assertRejects(
      () =>
        runMethod(
          "uninstall",
          { _run: run, _platform: linux() },
          {},
          {},
          stored("release", path),
        ),
      Error,
      "is not a jj binary",
    );
    assertEquals(await Deno.readTextFile(path), "something else");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("uninstall removes the Homebrew package it installed", async () => {
  let installed = true;
  const { run, calls } = fakeRun((cmd, args) => {
    if (cmd === "brew" && args[0] === "list") return installed ? ok() : missing;
    if (cmd === "brew" && args[0] === "uninstall") {
      installed = false;
      return ok();
    }
  });
  const out = await runMethod(
    "uninstall",
    { _run: run, _platform: mac },
    {},
    {},
    stored("brew", "/opt/homebrew/bin/jj"),
  );
  assert(calls.includes("brew uninstall jj"));
  assertEquals(out.installation.action, "removed");
});

Deno.test("uninstall touches nothing this model didn't install", async () => {
  const { run, calls } = fakeRun(jjAt({ jj: "0.46.0" }));
  const out = await runMethod("uninstall", { _run: run, _platform: mac });
  assertEquals(out.installation.action, "exists");
  assert(!calls.some((c) => c.startsWith("brew") || c.startsWith("winget")));
});
