import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  type ApiRequest,
  type ApiResponse,
  basicAuth,
  checkExistingIsNexus,
  checkExistingMatches,
  checkMemory,
  checkPortAvailable,
  checkRuntimeReady,
  type CliResult,
  model,
  nexusUrl,
  portFree,
  waitUntilReady,
} from "./nexus_instance.ts";

type Ctx = Parameters<typeof model.methods.start.execute>[1];

const PW = "Sup3r-Secret";
const GENERATED = "generated-1234";

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "" });
const fail = (stderr: string): CliResult => ({ code: 1, stdout: "", stderr });
const missing = fail("Error: No such container: nexus");
const IMAGE = "docker.io/sonatype/nexus3:3.96.4";
/** `docker container inspect` output for one container. */
const dockerInfo = (
  id: string,
  running: boolean,
  image = IMAGE,
  port = 8081,
  { restarting = false, restarts = 0 } = {},
) =>
  ok(JSON.stringify([{
    Id: id,
    State: { Running: running, Restarting: restarting },
    RestartCount: restarts,
    Config: { Image: image },
    HostConfig: {
      PortBindings: {
        "8081/tcp": [{ HostIp: "127.0.0.1", HostPort: String(port) }],
      },
    },
  }]));
/** Apple `container inspect` output for one container. */
const appleInfo = (state: string, image = IMAGE, port = 8081) =>
  ok(JSON.stringify([{
    id: "nexus",
    status: { state },
    configuration: {
      image: { reference: image },
      publishedPorts: [{
        containerPort: 8081,
        hostAddress: "127.0.0.1",
        hostPort: port,
        proto: "tcp",
      }],
    },
  }]));
const appleMissing = fail("Error: container not found: nexus");

const res = (status: number, body: unknown = ""): ApiResponse => ({
  status,
  body: typeof body === "string" ? body : JSON.stringify(body),
});
const ANON = {
  enabled: false,
  userId: "anonymous",
  realmName: "NexusAuthorizingRealm",
};
const EULA_PENDING = res(200, { accepted: false, disclaimer: "Terms" });
const BUILTIN = {
  userId: "admin",
  firstName: "Administrator",
  lastName: "User",
  emailAddress: "admin@example.org",
  source: "default",
  status: "active",
  readOnly: false,
  roles: ["nx-admin"],
  externalRoles: [],
};

/** Calls into Nexus once it is configured: EULA, anonymous, onboarding. */
const afterSignIn = (
  eula = res(200, { accepted: true, disclaimer: "Terms" }),
) => ({
  "GET /v1/system/eula": [eula],
  "GET /v1/security/anonymous": [res(200, ANON)],
  "PUT /v1/security/anonymous": [res(204)],
  "GET /internal/ui/onboarding": [res(200, [])],
});

/** Queued fakes keyed by "first-arg" (docker) and "METHOD path" (API). */
function fakes(
  docker: Record<string, CliResult[]>,
  api: Record<string, ApiResponse[]>,
) {
  const dockerCalls: string[][] = [];
  const apiCalls: ApiRequest[] = [];
  return {
    dockerCalls,
    apiCalls,
    docker: (args: string[]) => {
      dockerCalls.push(args);
      const key = ["container", "volume", "system"].includes(args[0])
        ? `${args[0]} ${args[1]}`
        : args[0];
      // The last queued response keeps answering, like a container that
      // stays in one state.
      const q = docker[key];
      const r = q && (q.length > 1 ? q.shift() : q[0]);
      if (!r) throw new Error(`unexpected docker ${args.join(" ")}`);
      return Promise.resolve(r);
    },
    api: (req: ApiRequest) => {
      apiCalls.push(req);
      const key = `${req.method} ${req.path}`;
      const r = api[key]?.shift();
      if (!r) throw new Error(`unexpected ${key} as ${req.user}`);
      return Promise.resolve(r);
    },
  };
}

async function run(
  method: "start" | "stop" | "delete" | "sync",
  docker: Record<string, CliResult[]>,
  api: Record<string, ApiResponse[]> = {},
  { args = {}, globalArgs = {} }: {
    args?: Record<string, unknown>;
    globalArgs?: Record<string, unknown>;
  } = {},
) {
  const f = fakes(docker, api);
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      adminPassword: PW,
      ...globalArgs,
    }),
    methodName: method,
  });
  const m = model.methods[method];
  await (m.execute as (a: unknown, c: Ctx) => Promise<unknown>)(
    {
      ...m.arguments.parse(args),
      _cli: f.docker,
      _api: f.api,
      _probe: () => Promise.resolve(true),
    },
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  return { ...f, instance: r[r.length - 1]?.data as Record<string, unknown> };
}

const signIn = (...statuses: number[]) => ({
  "GET /v1/security/realms/active": statuses.map((s) => res(s)),
});

Deno.test("start creates the container and replaces the generated password", async () => {
  const { dockerCalls, apiCalls, instance } = await run("start", {
    "container inspect": [missing, dockerInfo("abc123", true)],
    run: [ok("abc123")],
    exec: [ok(GENERATED)],
  }, {
    ...signIn(401, 200),
    "PUT /v1/security/users/admin/change-password": [res(204)],
    ...afterSignIn(EULA_PENDING),
    "POST /v1/system/eula": [res(204)],
  });
  assertEquals(dockerCalls[1], [
    "run",
    "--detach",
    "--name",
    "nexus",
    "--restart",
    "unless-stopped",
    "--publish",
    "127.0.0.1:8081:8081",
    "--volume",
    "nexus-data:/nexus-data",
    IMAGE,
  ]);
  assertEquals(dockerCalls[4], [
    "exec",
    "nexus",
    "cat",
    "/nexus-data/admin.password",
  ]);
  const change = apiCalls.find((c) => c.path.endsWith("change-password"))!;
  assertEquals([change.user, change.password, change.text], [
    "admin",
    GENERATED,
    PW,
  ]);
  const eula = apiCalls.find((c) => c.method === "POST")!;
  assertEquals(eula.json, { accepted: true, disclaimer: "Terms" });
  const anon = apiCalls.find((c) =>
    c.path === "/v1/security/anonymous" && c.method === "PUT"
  )!;
  assertEquals(anon.json, { ...ANON, enabled: true });
  assertEquals(
    [instance.action, instance.state, instance.containerId, instance.url],
    ["created", "running", "abc123", "http://127.0.0.1:8081"],
  );
  assertEquals([instance.bootstrapped, instance.pendingOnboarding], [true, []]);
});

Deno.test("start leaves a configured, running instance alone", async () => {
  const { dockerCalls, apiCalls, instance } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, { ...signIn(200), ...afterSignIn() });
  assertEquals(dockerCalls.length, 2); // inspect, baseline inspect;
  assertEquals(apiCalls.some((c) => c.method === "POST"), false);
  assertEquals([instance.action, instance.bootstrapped], ["unchanged", false]);
});

Deno.test("start starts a stopped container", async () => {
  const { dockerCalls, instance } = await run("start", {
    "container inspect": [dockerInfo("abc123", false)],
    start: [ok()],
  }, { ...signIn(200), ...afterSignIn() });
  assertEquals(dockerCalls[1], ["start", "nexus"]);
  assertEquals(instance.action, "started");
});

Deno.test("start creates a custom admin and disables the built-in one", async () => {
  const { apiCalls, instance } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
    exec: [ok(GENERATED)],
  }, {
    // taylor fails, admin fails, then taylor works after setup
    ...signIn(401, 401, 200),
    "PUT /v1/security/users/admin/change-password": [res(204)],
    "POST /v1/security/users": [res(200)],
    ...afterSignIn(),
    "GET /v1/security/users?userId=admin&source=default": [res(200, [BUILTIN])],
    "PUT /v1/security/users/admin": [res(204)],
  }, { globalArgs: { adminUsername: "taylor", anonymousAccess: false } });
  const created = apiCalls.find((c) => c.path === "/v1/security/users")!;
  assertEquals(created.user, "admin");
  assertEquals((created.json as Record<string, unknown>).userId, "taylor");
  assertEquals((created.json as Record<string, unknown>).roles, ["nx-admin"]);
  const disabled = apiCalls.find((c) => c.path === "/v1/security/users/admin")!;
  assertEquals(disabled.user, "taylor");
  assertEquals(disabled.json, { ...BUILTIN, status: "disabled" });
  const anon = apiCalls.find((c) =>
    c.path === "/v1/security/anonymous" && c.method === "PUT"
  )!;
  assertEquals((anon.json as Record<string, unknown>).enabled, false);
  assertEquals(instance.adminUsername, "taylor");
});

Deno.test("start finishes a custom admin when admin's password is already set", async () => {
  const { dockerCalls, apiCalls } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, {
    ...signIn(401, 200, 200),
    "POST /v1/security/users": [res(200)],
    ...afterSignIn(),
    "GET /v1/security/users?userId=admin&source=default": [
      res(200, [{ ...BUILTIN, status: "disabled" }]),
    ],
  }, { globalArgs: { adminUsername: "taylor" } });
  assertEquals(dockerCalls.length, 2); // no exec: password already set;
  assertEquals(apiCalls.some((c) => c.path.endsWith("change-password")), false);
});

Deno.test("start explains a password that no longer matches", async () => {
  await assertRejects(
    () =>
      run("start", {
        "container inspect": [dockerInfo("abc123", true)],
        exec: [fail("cat: can't open '/nexus-data/admin.password'")],
      }, signIn(401)),
    Error,
    "set up with a different password",
  );
});

Deno.test("start skips the EULA on editions without one", async () => {
  const { apiCalls } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, { ...signIn(200), ...afterSignIn(res(404)) });
  assertEquals(apiCalls.some((c) => c.method === "POST"), false);
});

Deno.test("start reports onboarding steps Nexus still lists", async () => {
  const { instance } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, {
    ...signIn(200),
    ...afterSignIn(),
    "GET /internal/ui/onboarding": [
      res(200, [{ priority: 1, type: "CommunityDiscover" }]),
    ],
  });
  assertEquals(instance.pendingOnboarding, ["CommunityDiscover"]);
});

Deno.test("start records unknown onboarding when Nexus won't say", async () => {
  const { instance } = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, {
    ...signIn(200),
    ...afterSignIn(),
    "GET /internal/ui/onboarding": [res(404)],
  });
  assertEquals(instance.pendingOnboarding, null);
});

Deno.test("start fails on a sign-in error other than 401 without bootstrapping", async () => {
  await assertRejects(
    () =>
      run("start", { "container inspect": [dockerInfo("abc123", true)] }, {
        "GET /v1/security/realms/active": [res(503, "starting")],
      }),
    Error,
    "HTTP 503 starting",
  );
});

Deno.test("basicAuth encodes non-Latin-1 passwords as UTF-8", () => {
  const header = basicAuth("admin", "pässwörd🔑");
  const bytes = Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0));
  assertEquals(new TextDecoder().decode(bytes), "admin:pässwörd🔑");
});

Deno.test("start surfaces docker run errors", async () => {
  await assertRejects(
    () =>
      run("start", {
        "container inspect": [missing],
        run: [fail("port is already allocated")],
      }),
    Error,
    "port is already allocated",
  );
});

Deno.test("adminPassword is required and marked sensitive", () => {
  assertEquals(model.globalArguments.safeParse({}).success, false);
  const meta = model.globalArguments.shape.adminPassword.meta();
  assertEquals(meta?.sensitive, true);
});

Deno.test("stop stops a running container", async () => {
  const { dockerCalls, instance } = await run("stop", {
    "container inspect": [dockerInfo("abc123", true)],
    stop: [ok()],
  });
  assertEquals(dockerCalls[1], ["stop", "--time", "120", "nexus"]);
  assertEquals([instance.action, instance.state], ["stopped", "stopped"]);
  assertEquals(instance.pendingOnboarding, null);
});

Deno.test("stop fails when there is no container", async () => {
  await assertRejects(
    () => run("stop", { "container inspect": [missing] }),
    Error,
    "No container named nexus",
  );
});

Deno.test("delete keeps the volume by default", async () => {
  const { dockerCalls, instance } = await run("delete", {
    "container inspect": [dockerInfo("abc123", false)],
    rm: [ok()],
  });
  assertEquals(dockerCalls.map((c) => c[0]), ["container", "rm"]);
  assertEquals([instance.action, instance.state], ["removed", "removed"]);
});

Deno.test("delete removes the volume when asked", async () => {
  const { dockerCalls } = await run(
    "delete",
    {
      "container inspect": [missing],
      "volume inspect": [ok("[]")],
      "volume rm": [ok()],
    },
    {},
    { args: { removeVolume: true } },
  );
  assertEquals(dockerCalls[2], ["volume", "rm", "nexus-data"]);
});

Deno.test("delete skips a volume that is already gone", async () => {
  const { dockerCalls } = await run(
    "delete",
    {
      "container inspect": [missing],
      "volume inspect": [fail("no such volume")],
    },
    {},
    { args: { removeVolume: true } },
  );
  assertEquals(dockerCalls.length, 2);
});

Deno.test("nexusUrl uses loopback for 0.0.0.0 and brackets IPv6", () => {
  const base = { adminPassword: PW };
  const g = model.globalArguments.parse({ ...base, bindAddress: "0.0.0.0" });
  assertEquals(nexusUrl(g), "http://127.0.0.1:8081");
  const v6 = model.globalArguments.parse({
    ...base,
    bindAddress: "::1",
    port: 9000,
  });
  assertEquals(nexusUrl(v6), "http://[::1]:9000");
});

Deno.test("waitUntilReady times out", async () => {
  await assertRejects(
    () => waitUntilReady(() => Promise.resolve(false), "http://x", 30, 10),
    Error,
    "not ready",
  );
});

const apple = { runtime: "container" };

Deno.test("Apple container: start prepares the volume, sets memory and has no restart policy", async () => {
  const { dockerCalls, instance } = await run("start", {
    inspect: [appleMissing, appleInfo("running")],
    run: [ok(), ok("nexus")],
    exec: [ok(GENERATED)],
  }, {
    ...signIn(401, 200),
    "PUT /v1/security/users/admin/change-password": [res(204)],
    ...afterSignIn(),
  }, { globalArgs: apple });
  assertEquals(dockerCalls[1], [
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "chown",
    "--volume",
    "nexus-data:/nexus-data",
    IMAGE,
    "200:200",
    "/nexus-data",
  ]);
  assertEquals(dockerCalls[2], [
    "run",
    "--detach",
    "--name",
    "nexus",
    "--memory",
    "4g",
    "--publish",
    "127.0.0.1:8081:8081",
    "--volume",
    "nexus-data:/nexus-data",
    IMAGE,
  ]);
  assertEquals([instance.runtime, instance.containerId, instance.action], [
    "container",
    "nexus",
    "created",
  ]);
});

Deno.test("Apple container: start starts a stopped container", async () => {
  const { dockerCalls, instance } = await run(
    "start",
    {
      inspect: [appleInfo("stopped")],
      start: [ok()],
    },
    { ...signIn(200), ...afterSignIn() },
    { globalArgs: apple },
  );
  assertEquals(dockerCalls[1], ["start", "nexus"]);
  assertEquals(instance.action, "started");
});

Deno.test("Apple container: delete uses container delete and volume delete", async () => {
  const { dockerCalls } = await run(
    "delete",
    {
      inspect: [appleInfo("running")],
      delete: [ok()],
      "volume inspect": [ok("[]")],
      "volume delete": [ok()],
    },
    {},
    { args: { removeVolume: true }, globalArgs: apple },
  );
  assertEquals(dockerCalls[1], ["delete", "--force", "nexus"]);
  assertEquals(dockerCalls[3], ["volume", "delete", "nexus-data"]);
});

Deno.test("Apple container: stop stops a running container", async () => {
  const { dockerCalls } = await run(
    "stop",
    {
      inspect: [appleInfo("running")],
      stop: [ok()],
    },
    {},
    { globalArgs: apple },
  );
  assertEquals(dockerCalls[1], ["stop", "--time", "120", "nexus"]);
});

Deno.test("docker passes a memory limit only when one is set", async () => {
  const { dockerCalls } = await run(
    "start",
    {
      "container inspect": [missing, dockerInfo("abc123", true)],
      run: [ok()],
    },
    { ...signIn(200), ...afterSignIn() },
    { globalArgs: { memory: "6g" } },
  );
  const runCall = dockerCalls[1];
  assertEquals(
    runCall.slice(runCall.indexOf("--memory"), runCall.indexOf("--memory") + 2),
    [
      "--memory",
      "6g",
    ],
  );
});

/** Global arguments for check tests. */
const ga = (extra: Record<string, unknown> = {}) =>
  model.globalArguments.parse({ adminPassword: PW, ...extra });
/** A CLI that answers every call with `r` (or throws it). */
const cliReturning = (r: CliResult | Error) => (_args: string[]) =>
  r instanceof Error ? Promise.reject(r) : Promise.resolve(r);

Deno.test("checkRuntimeReady: docker up, docker down, CLI missing", async () => {
  assertEquals(await checkRuntimeReady(ga(), cliReturning(ok("29.7.2"))), {
    pass: true,
  });
  const down = await checkRuntimeReady(
    ga(),
    cliReturning(fail("Cannot connect to the Docker daemon")),
  );
  assertEquals(down.pass, false);
  assertEquals(down.errors![0].startsWith("Docker is not running"), true);
  const missingCli = await checkRuntimeReady(
    ga(),
    cliReturning(new Error("Cannot run docker: not found")),
  );
  assertEquals(missingCli, {
    pass: false,
    errors: ["Cannot run docker: not found"],
  });
});

Deno.test("checkRuntimeReady: Apple container system running or stopped", async () => {
  const g = ga(apple);
  assertEquals(
    await checkRuntimeReady(g, cliReturning(ok('{"status":"running"}'))),
    { pass: true },
  );
  const stopped = await checkRuntimeReady(
    g,
    cliReturning(ok('{"status":"stopped"}')),
  );
  assertEquals(stopped.pass, false);
  assertEquals(stopped.errors![0].includes("container system start"), true);
});

Deno.test("checkExistingIsNexus refuses an unrelated container with the same name", async () => {
  assertEquals(await checkExistingIsNexus(ga(), cliReturning(missing)), {
    pass: true,
  });
  assertEquals(
    await checkExistingIsNexus(
      ga(),
      cliReturning(dockerInfo("abc", true, "sonatype/nexus3:3.80.0")),
    ),
    { pass: true },
  );
  const other = await checkExistingIsNexus(
    ga(),
    cliReturning(dockerInfo("abc", true, "postgres:17")),
  );
  assertEquals(other.pass, false);
  assertEquals(other.errors![0].includes("runs postgres:17, not Nexus"), true);
  const appleOther = await checkExistingIsNexus(
    ga(apple),
    cliReturning(appleInfo("running", "redis:8")),
  );
  assertEquals(appleOther.pass, false);
});

Deno.test("checkPortAvailable", async () => {
  const busy = () => Promise.resolve(false);
  // Our own container holds the port: fine, and the port is not probed.
  assertEquals(
    await checkPortAvailable(
      ga(),
      cliReturning(dockerInfo("abc", true)),
      () => {
        throw new Error("should not probe");
      },
    ),
    { pass: true },
  );
  assertEquals(
    await checkPortAvailable(
      ga(),
      cliReturning(missing),
      () => Promise.resolve(true),
    ),
    { pass: true },
  );
  const taken = await checkPortAvailable(ga(), cliReturning(missing), busy);
  assertEquals(taken.pass, false);
  assertEquals(
    taken.errors![0],
    "Port 8081 on 127.0.0.1 is already in use; stop what is using it or choose another port",
  );
});

Deno.test("checks that inspect leave an unreachable runtime to runtime-ready", async () => {
  const gone = cliReturning(new Error("Cannot run docker: not found"));
  assertEquals(await checkExistingIsNexus(ga(), gone), { pass: true });
  assertEquals(
    await checkPortAvailable(ga(), gone, () => Promise.resolve(false)),
    { pass: true },
  );
});

Deno.test("portFree sees a port that is in use", async () => {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  assertEquals(await portFree("127.0.0.1", port), false);
  listener.close();
  assertEquals(await portFree("127.0.0.1", port), true);
});

Deno.test("checkMemory", () => {
  assertEquals(checkMemory(ga()), { pass: true }); // docker, no limit
  assertEquals(checkMemory(ga(apple)), { pass: true }); // container, 4g default
  assertEquals(checkMemory(ga({ memory: "4096m" })), { pass: true });
  const low = checkMemory(ga({ ...apple, memory: "2g" }));
  assertEquals(low.pass, false);
  assertEquals(low.errors![0].startsWith("memory 2g is below the 3072m"), true);
});

Deno.test("checks are registered with labels and scopes", () => {
  const c = model.checks;
  assertEquals(Object.keys(c).sort(), [
    "existing-container-is-nexus",
    "existing-container-matches",
    "memory-sufficient",
    "port-available",
    "runtime-ready",
  ]);
  assertEquals(c["port-available"].appliesTo, ["start"]);
  assertEquals(c["existing-container-matches"].appliesTo, ["start"]);
  assertEquals(c["memory-sufficient"].labels, ["policy"]);
});

Deno.test("upgrade moves a custom dockerPath to runtimePath", () => {
  const up = model.upgrades[0].upgradeAttributes;
  assertEquals(up({ dockerPath: "/opt/bin/docker", port: 9000 }), {
    runtimePath: "/opt/bin/docker",
    port: 9000,
  });
  assertEquals(up({ dockerPath: "docker", port: 9000 }), { port: 9000 });
  assertEquals(up({ port: 9000 }), { port: 9000 });
});

Deno.test("checkExistingMatches passes a matching container, docker.io prefix or not", async () => {
  assertEquals(await checkExistingMatches(ga(), cliReturning(missing)), {
    pass: true,
  });
  assertEquals(
    await checkExistingMatches(
      ga(),
      cliReturning(dockerInfo("abc", true, "sonatype/nexus3:3.96.4")),
    ),
    { pass: true },
  );
  assertEquals(
    await checkExistingMatches(ga(apple), cliReturning(appleInfo("stopped"))),
    { pass: true },
  );
});

Deno.test("checkExistingMatches flags a changed image or port", async () => {
  const r = await checkExistingMatches(
    ga({ image: "docker.io/sonatype/nexus3:3.97.0", port: 9000 }),
    cliReturning(dockerInfo("abc", true)),
  );
  assertEquals(r.pass, false);
  assertEquals(r.errors, [
    "nexus runs docker.io/sonatype/nexus3:3.96.4 but image is docker.io/sonatype/nexus3:3.97.0",
    "nexus publishes port 8081 but port is 9000",
    "Run delete (the nexus-data volume is kept) and then start to recreate it, or change the arguments back",
  ]);
  const apple2 = await checkExistingMatches(
    ga({ ...apple, port: 9000 }),
    cliReturning(appleInfo("running")),
  );
  assertEquals(apple2.errors![0], "nexus publishes port 8081 but port is 9000");
});

Deno.test("checkPortAvailable reports an address it cannot bind", async () => {
  const r = await checkPortAvailable(
    ga({ bindAddress: "192.0.2.10" }),
    cliReturning(missing),
    () => {
      throw new Error("Can't assign requested address");
    },
  );
  assertEquals(r, {
    pass: false,
    errors: ["Cannot bind 192.0.2.10:8081: Can't assign requested address"],
  });
});

Deno.test("portFree sees a port held on another address", async () => {
  // Held on 0.0.0.0, asked about 127.0.0.1: a bind alone would succeed.
  const listener = Deno.listen({ hostname: "0.0.0.0", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  assertEquals(await portFree("127.0.0.1", port), false);
  listener.close();
});

Deno.test("start fails fast when the container dies while Nexus is starting", async () => {
  const f = fakes({
    // stopped; running when the wait begins; then stopped again
    "container inspect": [
      dockerInfo("abc123", false),
      dockerInfo("abc123", true),
      dockerInfo("abc123", false),
    ],
    start: [ok()],
  }, {});
  const test = createModelTestContext({
    globalArgs: ga(),
    methodName: "start",
  });
  const began = Date.now();
  await assertRejects(
    () =>
      model.methods.start.execute(
        {
          timeoutSeconds: 300,
          _cli: f.docker,
          _probe: () => Promise.resolve(false),
          _intervalMs: 1,
        },
        test.context as unknown as Ctx,
      ),
    Error,
    "nexus stopped while Nexus was starting; see `docker logs nexus`",
  );
  assertEquals(Date.now() - began < 5000, true);
});

Deno.test("start fails fast when Docker keeps restarting a crashing container", async () => {
  const looping = (restarts: number) =>
    dockerInfo("abc123", true, IMAGE, 8081, { restarts });
  const f = fakes({
    "container inspect": [dockerInfo("abc123", false), looping(0), looping(2)],
    start: [ok()],
  }, {});
  const test = createModelTestContext({
    globalArgs: ga(),
    methodName: "start",
  });
  await assertRejects(
    () =>
      model.methods.start.execute(
        {
          timeoutSeconds: 300,
          _cli: f.docker,
          _probe: () => Promise.resolve(false),
          _intervalMs: 1,
        },
        test.context as unknown as Ctx,
      ),
    Error,
    "stopped while Nexus was starting",
  );
});

Deno.test("a container Docker is restarting does not count as running", async () => {
  const g = ga();
  const r = await checkExistingMatches(
    g,
    cliReturning(dockerInfo("abc", true)),
  );
  assertEquals(r.pass, true);
  const { inspect } = await import("./nexus_instance.ts");
  const info = await inspect(
    g,
    cliReturning(
      dockerInfo("abc", true, IMAGE, 8081, { restarting: true, restarts: 3 }),
    ),
  );
  assertEquals([info?.running, info?.restarts], [false, 3]);
});

Deno.test({
  name: "portFree gives up quickly on an address that is not local",
  // The abandoned connect keeps running in the OS until it times out.
  sanitizeOps: false,
  sanitizeResources: false,
  fn: async () => {
    const began = Date.now();
    await assertRejects(() => portFree("192.0.2.10", 8081));
    assertEquals(Date.now() - began < 5000, true);
  },
});

/** Every call sync made was a read. */
function assertReadOnly(dockerCalls: string[][], apiCalls: ApiRequest[]) {
  for (const c of dockerCalls) {
    assertEquals(c.slice(0, 2), ["container", "inspect"]);
  }
  for (const c of apiCalls) assertEquals(c.method, "GET");
}

/** Nexus answers for a healthy, configured instance as sync reads it. */
const healthy = (anon = { ...ANON, enabled: true }) => ({
  ...signIn(200),
  "GET /v1/security/anonymous": [res(200, anon)],
  "GET /internal/ui/onboarding": [res(200, [])],
});

Deno.test("sync records a healthy instance with no drift", async () => {
  const { dockerCalls, apiCalls, instance } = await run("sync", {
    "container inspect": [dockerInfo("abc123", true)],
  }, healthy());
  assertReadOnly(dockerCalls, apiCalls);
  assertEquals(
    [
      instance.action,
      instance.state,
      instance.nexusReady,
      instance.anonymousAccess,
      instance.pendingOnboarding,
      instance.drift,
    ],
    ["synced", "running", true, true, [], []],
  );
});

Deno.test("sync records a missing container as absent", async () => {
  const { dockerCalls, apiCalls, instance } = await run("sync", {
    "container inspect": [missing],
  });
  assertReadOnly(dockerCalls, apiCalls);
  assertEquals([
    instance.state,
    instance.containerId,
    instance.nexusReady,
    instance.drift,
  ], ["absent", "", false, []]);
});

Deno.test("sync on a stopped container reports image and port drift without starting it", async () => {
  const { dockerCalls, apiCalls, instance } = await run("sync", {
    "container inspect": [
      dockerInfo("abc123", false, "sonatype/nexus3:3.90.0", 9000),
    ],
  });
  assertReadOnly(dockerCalls, apiCalls);
  assertEquals(instance.state, "stopped");
  assertEquals(instance.drift, [
    "nexus runs sonatype/nexus3:3.90.0 but image is docker.io/sonatype/nexus3:3.96.4",
    "nexus publishes port 9000 but port is 8081",
  ]);
});

Deno.test("sync reports Nexus not ready without waiting", async () => {
  const f = fakes({ "container inspect": [dockerInfo("abc123", true)] }, {});
  const test = createModelTestContext({ globalArgs: ga(), methodName: "sync" });
  await model.methods.sync.execute(
    { _cli: f.docker, _api: f.api, _probe: () => Promise.resolve(false) },
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  const instance = r[r.length - 1].data as Record<string, unknown>;
  assertEquals(
    [instance.state, instance.nexusReady, instance.anonymousAccess],
    ["running", false, null],
  );
  assertEquals(f.apiCalls.length, 0);
});

Deno.test("sync reports a rejected password instead of bootstrapping", async () => {
  const { dockerCalls, apiCalls, instance } = await run("sync", {
    "container inspect": [dockerInfo("abc123", true)],
  }, signIn(401));
  assertReadOnly(dockerCalls, apiCalls);
  assertEquals(instance.drift, [
    "Nexus rejects admin's password; run start to set it up, or update adminPassword",
  ]);
});

Deno.test("sync reports anonymous access and a re-enabled built-in admin as drift", async () => {
  const { dockerCalls, apiCalls, instance } = await run("sync", {
    "container inspect": [dockerInfo("abc123", true)],
  }, {
    ...healthy({ ...ANON, enabled: true }),
    "GET /v1/security/users?userId=admin&source=default": [res(200, [BUILTIN])],
    "GET /internal/ui/onboarding": [res(200, [{ type: "CommunityEula" }])],
  }, { globalArgs: { adminUsername: "taylor", anonymousAccess: false } });
  assertReadOnly(dockerCalls, apiCalls);
  assertEquals(instance.anonymousAccess, true);
  assertEquals(instance.drift, [
    "anonymous access is on in Nexus but anonymousAccess is false",
    "the built-in admin user is enabled, but adminUsername is taylor",
  ]);
  assertEquals(instance.pendingOnboarding, ["CommunityEula"]);
});

Deno.test("sync works with Apple's container", async () => {
  const { dockerCalls, instance } = await run(
    "sync",
    {
      inspect: [appleInfo("running")],
    },
    healthy(),
    { globalArgs: apple },
  );
  assertEquals(dockerCalls, [["inspect", "nexus"]]);
  assertEquals([instance.runtime, instance.state, instance.drift], [
    "container",
    "running",
    [],
  ]);
});

Deno.test("start, stop and delete record the new fields", async () => {
  const started = await run("start", {
    "container inspect": [dockerInfo("abc123", true)],
  }, {
    ...signIn(200),
    ...afterSignIn(),
  });
  assertEquals([
    started.instance.nexusReady,
    started.instance.anonymousAccess,
    started.instance.drift,
  ], [true, true, []]);
  const stopped = await run("stop", {
    "container inspect": [dockerInfo("abc123", true)],
    stop: [ok()],
  });
  assertEquals([
    stopped.instance.nexusReady,
    stopped.instance.anonymousAccess,
    stopped.instance.drift,
  ], [false, null, null]);
});
