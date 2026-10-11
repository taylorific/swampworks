import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  checkDockerReady,
  checkPortAvailable,
  composeFile,
  type DockerResult,
  ENSURE_ADMIN,
  model,
  parseEnsured,
  parsePs,
  projectState,
} from "./netbox_instance.ts";

type Ctx = Parameters<typeof model.methods.start.execute>[1];
type Method = keyof typeof model.methods;

const ok = (stdout = ""): DockerResult => ({ code: 0, stdout, stderr: "" });
const TOKEN = `nbt_${"a".repeat(12)}.${"b".repeat(40)}`;

const psLines = (states: Record<string, string>) =>
  Object.entries(states).map(([Service, State]) =>
    JSON.stringify({ Service, State })
  ).join("\n");
const up = psLines({
  secrets: "exited",
  postgres: "running",
  redis: "running",
  netbox: "running",
  "netbox-worker": "running",
});
const down = psLines({ secrets: "exited", netbox: "exited" });

/**
 * A fake docker: `compose ps` answers from a list (the last one repeats),
 * `compose exec` prints `ensured`, everything else succeeds. Records every
 * call with its input and env.
 */
function fakeDocker(ps: string[], ensured: string, fail?: string) {
  const calls: {
    verb: string;
    args: string[];
    input?: string;
    env?: Record<string, string>;
  }[] = [];
  let i = 0;
  const docker = (
    args: string[],
    opts: { input?: string; env?: Record<string, string> } = {},
  ) => {
    const verb = args[5];
    calls.push({ verb, args, ...opts });
    if (verb === fail) {
      return Promise.resolve({ code: 1, stdout: "", stderr: "boom" });
    }
    if (verb === "ps") {
      return Promise.resolve(ok(ps[Math.min(i++, ps.length - 1)]));
    }
    if (verb === "exec") return Promise.resolve(ok(ensured));
    return Promise.resolve(ok());
  };
  return { docker, calls };
}

async function run(
  method: Method,
  ps: string[],
  opts: {
    args?: Record<string, unknown>;
    globals?: Record<string, unknown>;
    ensured?: string;
    fail?: string;
  } = {},
) {
  const { docker, calls } = fakeDocker(
    ps,
    opts.ensured ??
      'Some log line\n{"user": "created", "token": "absent", "version": "4.7.2"}',
    opts.fail,
  );
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse({
      adminPassword: "s3cret",
      ...opts.globals,
    }),
    methodName: method,
  });
  const m = model.methods[method];
  await m.execute(
    // deno-lint-ignore no-explicit-any
    { ...m.arguments.parse(opts.args ?? {}), _docker: docker } as any,
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  return {
    calls,
    verbs: calls.map((c) => c.verb),
    instance: r[r.length - 1]?.data as Record<string, unknown>,
  };
}

Deno.test("composeFile publishes only NetBox, on the bind address", () => {
  const g = model.globalArguments.parse({ adminPassword: "x", port: 8123 });
  const c = JSON.parse(composeFile(g));
  assertEquals(c.services.netbox.ports, ["127.0.0.1:8123:8080"]);
  for (const s of ["postgres", "redis", "netbox-worker", "secrets"]) {
    assertEquals(c.services[s].ports, undefined);
  }
  assertEquals(c.volumes.postgres, { name: "netbox-postgres" });
});

Deno.test("composeFile keeps the admin password and token out", () => {
  const g = model.globalArguments.parse({
    adminPassword: "s3cret",
    apiToken: TOKEN,
  });
  const file = composeFile(g);
  assertEquals(file.includes("s3cret"), false);
  assertEquals(file.includes(TOKEN), false);
});

Deno.test("apiToken must be a v2 token", () => {
  const bad = model.globalArguments.safeParse({
    adminPassword: "x",
    apiToken: "0123456789abcdef0123456789abcdef01234567",
  });
  assertEquals(bad.success, false);
});

Deno.test("parsePs reads JSON lines and arrays", () => {
  assertEquals(parsePs(""), {});
  assertEquals(parsePs(down), { secrets: "exited", netbox: "exited" });
  assertEquals(parsePs('[{"Service":"netbox","State":"running"}]'), {
    netbox: "running",
  });
});

Deno.test("projectState follows the NetBox container", () => {
  assertEquals(projectState({}), "absent");
  assertEquals(projectState({ postgres: "running" }), "absent");
  assertEquals(projectState({ netbox: "exited" }), "stopped");
  assertEquals(projectState({ netbox: "running" }), "running");
});

Deno.test("parseEnsured takes the last JSON line", () => {
  assertEquals(
    parseEnsured(
      'noise\n{"user":"updated","token":"unchanged","version":"4.7.2"}',
    ),
    { user: "updated", token: "unchanged", version: "4.7.2" },
  );
});

Deno.test("start on a new project creates it and the superuser", async () => {
  const { verbs, calls, instance } = await run("start", ["", up]);
  assertEquals(verbs, ["ps", "up", "exec", "ps"]);
  assertEquals(calls[1].args.slice(5), [
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "600",
  ]);
  assertEquals(calls[1].input?.startsWith("{"), true);
  assertEquals(instance.action, "created");
  assertEquals(instance.state, "running");
  assertEquals(instance.version, "4.7.2");
  assertEquals(instance.apiToken, false);
  assertEquals(instance.url, "http://127.0.0.1:8000");
});

Deno.test("start passes secrets through the environment only", async () => {
  const { calls } = await run("start", ["", up], {
    globals: { apiToken: TOKEN },
    ensured: '{"user":"created","token":"created","version":"4.7.2"}',
  });
  const exec = calls[2];
  assertEquals(exec.env?.NB_PASSWORD, "s3cret");
  assertEquals(exec.env?.NB_TOKEN, TOKEN);
  assertEquals(exec.args.includes("s3cret"), false);
  assertEquals(exec.args.includes(TOKEN), false);
  assertEquals(exec.args.at(-1), ENSURE_ADMIN);
});

Deno.test("start on a stopped project reports started", async () => {
  const { instance } = await run("start", [down, up]);
  assertEquals(instance.action, "started");
});

Deno.test("start records the token when the superuser has it", async () => {
  const { instance } = await run("start", [up], {
    globals: { apiToken: TOKEN },
    ensured: '{"user":"updated","token":"unchanged","version":"4.7.2"}',
  });
  assertEquals(instance.action, "running");
  assertEquals(instance.apiToken, true);
});

Deno.test("start fails when compose up fails", async () => {
  await assertRejects(
    () => run("start", [""], { fail: "up" }),
    Error,
    "Starting netbox",
  );
});

Deno.test("stop stops the project", async () => {
  const { verbs, instance } = await run("stop", [down]);
  assertEquals(verbs, ["stop", "ps"]);
  assertEquals(instance.state, "stopped");
});

Deno.test("remove keeps volumes unless asked", async () => {
  const kept = await run("remove", []);
  assertEquals(kept.calls[0].args.slice(5), ["down", "--remove-orphans"]);
  assertEquals(kept.instance.state, "absent");
  const gone = await run("remove", [], { args: { deleteVolumes: true } });
  assertEquals(gone.calls[0].args.slice(5), [
    "down",
    "--remove-orphans",
    "--volumes",
  ]);
});

Deno.test("composeFile keeps the Valkey password off command lines", () => {
  const g = model.globalArguments.parse({ adminPassword: "x" });
  const redis = JSON.parse(composeFile(g)).services.redis;
  assertEquals(redis.command.join(" ").includes("--requirepass"), false);
  assertEquals(redis.healthcheck.test[1].includes("--pass"), false);
});

Deno.test("parseEnsured rejects output it doesn't recognise", () => {
  assertThrows(() => parseEnsured("Traceback ..."), Error, "Unexpected");
  assertThrows(() => parseEnsured('{"user":"maybe"}'), Error, "Unexpected");
});

Deno.test("parsePs rejects output it doesn't recognise", () => {
  assertThrows(() => parsePs("not json"), Error, "Unexpected");
});

Deno.test("start fails when the superuser setup fails", async () => {
  await assertRejects(
    () => run("start", ["", up], { fail: "exec" }),
    Error,
    "Setting up the superuser",
  );
});

Deno.test("start reports a replaced token", async () => {
  const { instance } = await run("start", [up], {
    globals: { apiToken: TOKEN },
    ensured: '{"user":"updated","token":"replaced","version":"4.7.2"}',
  });
  assertEquals(instance.apiToken, true);
});

Deno.test("status leaves unchecked fields null", async () => {
  const { verbs, instance } = await run("status", [up]);
  assertEquals(verbs, ["ps"]);
  assertEquals(instance.state, "running");
  assertEquals(instance.apiToken, null);
  assertEquals(instance.version, null);
});

Deno.test("start rejects a timeout longer than the runner allows", () => {
  assertEquals(
    model.methods.start.arguments.safeParse({ timeoutSeconds: 3600 }).success,
    false,
  );
});

Deno.test("checkDockerReady reports a stopped daemon", async () => {
  const docker = (args: string[]) =>
    Promise.resolve(
      args[0] === "info"
        ? { code: 1, stdout: "", stderr: "Cannot connect" }
        : ok("v5"),
    );
  const r = await checkDockerReady(docker);
  assertEquals(r.pass, false);
  assertEquals(r.errors?.[0].includes("Docker is not running"), true);
  assertEquals(
    (await checkDockerReady(() => Promise.resolve(ok()))).pass,
    true,
  );
});

Deno.test("checkPortAvailable", async (t) => {
  const g = model.globalArguments.parse({ adminPassword: "x" });
  const withPs = (out: string) => (args: string[]) =>
    Promise.resolve(args[5] === "ps" ? ok(out) : ok());
  const taken = () => Promise.resolve(false);
  await t.step("passes when our NetBox holds the port", async () => {
    assertEquals((await checkPortAvailable(g, withPs(up), taken)).pass, true);
  });
  await t.step("fails when something else holds it", async () => {
    const r = await checkPortAvailable(g, withPs(""), taken);
    assertEquals(r.pass, false);
    assertEquals(r.errors?.[0].includes("8000"), true);
  });
  await t.step("passes when the port is free", async () => {
    const free = () => Promise.resolve(true);
    assertEquals((await checkPortAvailable(g, withPs(down), free)).pass, true);
  });
});
