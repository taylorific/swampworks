import { z } from "npm:zod@4";

// A NetBox instance run as a Docker Compose project: NetBox itself, its
// background worker, PostgreSQL and Valkey (Redis), using the
// netbox-community/netbox-docker images. The compose file is generated here
// and piped to `docker compose`, so nothing is written to disk. The secret
// key, API token pepper and database and Redis passwords are generated on the
// first start inside a secrets volume and never leave it. `start` brings the
// project up, waits for every service to be healthy, then makes sure the
// admin user exists with the vault password and, if one is given, that the
// admin owns the API token from the vault.

export const DEFAULT_IMAGE = "docker.io/netboxcommunity/netbox:v4.7-5.1.1";
const POSTGRES_IMAGE = "docker.io/postgres:18-alpine";
const VALKEY_IMAGE = "docker.io/valkey/valkey:9.1-alpine";

const NAME = /^[a-z0-9][a-z0-9_-]*$/;
const SECRETS = "/run/secrets";
/** A NetBox v2 API token: nbt_<12-character key>.<40-character secret>. */
const API_TOKEN = /^nbt_[A-Za-z0-9]{12}\.[A-Za-z0-9]{40}$/;

const GlobalArgsSchema = z.object({
  name: z.string().regex(NAME).default("netbox").describe(
    "Compose project name; also the prefix for its volumes (<name>-postgres, <name>-media, ...)",
  ),
  image: z.string().default(DEFAULT_IMAGE).describe(
    "NetBox image, used for both NetBox and its worker",
  ),
  port: z.number().int().min(1).max(65535).default(8000).describe(
    "Host port for the NetBox web UI and API",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Host address to publish the port on; 0.0.0.0 exposes it to the network",
  ),
  adminUsername: z.string().regex(/^[\w.@+-]+$/).default("admin").describe(
    "Superuser created on the first start",
  ),
  adminEmail: z.string().email().default("admin@example.com").describe(
    "Email address of the superuser",
  ),
  adminPassword: z.string().min(1).meta({ sensitive: true }).describe(
    "Superuser password, set on every start; use a vault expression",
  ),
  apiToken: z.string().regex(API_TOKEN).optional().meta({ sensitive: true })
    .describe(
      "Optional v2 API token for the superuser, nbt_<12 letters/digits>.<40 letters/digits>; use a vault expression",
    ),
  dockerPath: z.string().default("docker").describe("Docker CLI binary"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StartArgsSchema = z.object({
  timeoutSeconds: z.number().int().min(30).max(1800).default(600).describe(
    "How long to wait for every service to be healthy; the first start runs database migrations",
  ),
});
type StartArgs = z.infer<typeof StartArgsSchema>;

const RemoveArgsSchema = z.object({
  deleteVolumes: z.boolean().default(false).describe(
    "Also delete the database, media, scripts, Redis and secrets volumes",
  ),
});
type RemoveArgs = z.infer<typeof RemoveArgsSchema>;

const STATES = ["running", "stopped", "absent"] as const;
type State = (typeof STATES)[number];

const InstanceSchema = z.object({
  name: z.string(),
  image: z.string(),
  state: z.enum(STATES),
  action: z.enum([
    "created",
    "started",
    "running",
    "status",
    "stopped",
    "removed",
  ]),
  url: z.string(),
  apiUrl: z.string(),
  username: z.string(),
  apiToken: z.boolean().nullable().describe(
    "Whether the superuser has the API token from apiToken; null when not checked (status, stop, remove)",
  ),
  version: z.string().nullable().describe(
    "NetBox version; null when not checked (status, stop, remove)",
  ),
  services: z.record(z.string(), z.string()).describe(
    "State of each compose service's container",
  ),
  volumes: z.array(z.string()),
  checkedAt: z.string(),
});
type Instance = z.infer<typeof InstanceSchema>;

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

/** Result of one `docker` call. */
export interface DockerResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs `docker` with the given arguments, standard input and environment. */
export type Docker = (
  args: string[],
  opts?: { input?: string; env?: Record<string, string> },
) => Promise<DockerResult>;

/** Test hooks; never set from the CLI. */
interface Hooks {
  _docker?: Docker;
}

/** Runs the Docker CLI and captures its output. */
export function dockerRunner(bin: string): Docker {
  return async (args, opts = {}) => {
    let out: Deno.CommandOutput;
    let child: Deno.ChildProcess | undefined;
    try {
      // swamp-quality-ignore deno-command: runs the Docker CLI; argument lists are built in this file, see README What it runs
      child = new Deno.Command(bin, {
        args,
        env: opts.env,
        stdin: opts.input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
        // Longer than the longest `up --wait` timeoutSeconds allows.
        signal: AbortSignal.timeout(1900000),
      }).spawn();
      if (opts.input !== undefined) {
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode(opts.input));
        await w.close();
      }
      out = await child.output();
    } catch (err) {
      try {
        child?.kill();
      } catch {
        // already exited
      }
      throw new Error(
        `Cannot run ${bin}: ${
          (err as Error).message
        }. Install Docker and make sure it is running.`,
      );
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}

function check(r: DockerResult, what: string): string {
  if (r.code !== 0) {
    throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  }
  return r.stdout;
}

/** Named volumes for one instance, by their compose key. */
export function volumes(name: string): Record<string, string> {
  return Object.fromEntries(
    ["secrets", "postgres", "redis", "media", "scripts", "reports"].map(
      (v) => [v, `${name}-${v}`],
    ),
  );
}

// Writes each secret once, so recreating containers keeps the database
// password and the pepper that existing API tokens are hashed with.
const MAKE_SECRETS = `
import os, secrets, string
chars = string.ascii_letters + string.digits
def put(name, value):
    path = os.path.join("${SECRETS}", name)
    if not os.path.exists(path):
        with open(path + ".tmp", "w") as f:
            f.write(value)
        os.chmod(path + ".tmp", 0o644)
        os.replace(path + ".tmp", path)
for name, length in [("secret_key", 60), ("api_token_pepper_1", 50),
                     ("db_password", 32), ("redis_password", 32)]:
    put(name, "".join(secrets.choice(chars) for _ in range(length)))
with open(os.path.join("${SECRETS}", "redis_password")) as f:
    put("redis_cache_password", f.read())
`;

// The Valkey password goes into a config file and the environment rather
// than onto a command line, where `docker top` would show it. "$$" because
// compose interpolates "$"; the shell sees "$(cat ...)".
const REDIS_PASSWORD = `"$$(cat ${SECRETS}/redis_password)"`;
const VALKEY_CONF = "/tmp/valkey.conf";

/**
 * The compose file for one instance, as JSON (which compose reads as YAML).
 * Only NetBox publishes a port; PostgreSQL and Valkey are reachable only on
 * the project's network.
 */
export function composeFile(g: GlobalArgs): string {
  const v = volumes(g.name);
  const secretsRo = `secrets:${SECRETS}:ro`;
  const afterSecrets = {
    secrets: { condition: "service_completed_successfully" },
  };
  const netbox = {
    image: g.image,
    user: "netbox:root",
    restart: "unless-stopped",
    environment: {
      DB_HOST: "postgres",
      DB_NAME: "netbox",
      DB_USER: "netbox",
      REDIS_HOST: "redis",
      REDIS_DATABASE: "0",
      REDIS_CACHE_HOST: "redis",
      REDIS_CACHE_DATABASE: "1",
      SKIP_SUPERUSER: "true",
      GRAPHQL_ENABLED: "true",
      WEBHOOKS_ENABLED: "true",
      MEDIA_ROOT: "/opt/netbox/netbox/media",
    },
    volumes: [
      secretsRo,
      "media:/opt/netbox/netbox/media",
      "scripts:/opt/netbox/netbox/scripts",
      "reports:/opt/netbox/netbox/reports",
    ],
  };
  return JSON.stringify(
    {
      name: g.name,
      services: {
        secrets: {
          image: g.image,
          user: "root",
          command: ["python3", "-c", MAKE_SECRETS],
          volumes: [`secrets:${SECRETS}`],
        },
        postgres: {
          image: POSTGRES_IMAGE,
          restart: "unless-stopped",
          depends_on: afterSecrets,
          environment: {
            POSTGRES_DB: "netbox",
            POSTGRES_USER: "netbox",
            POSTGRES_PASSWORD_FILE: `${SECRETS}/db_password`,
          },
          healthcheck: {
            test: ["CMD", "pg_isready", "-q", "-d", "netbox", "-U", "netbox"],
            start_period: "20s",
            interval: "5s",
            timeout: "5s",
            retries: 10,
          },
          volumes: [secretsRo, "postgres:/var/lib/postgresql"],
        },
        redis: {
          image: VALKEY_IMAGE,
          restart: "unless-stopped",
          depends_on: afterSecrets,
          command: [
            "sh",
            "-c",
            `umask 077 && printf 'appendonly yes\\nrequirepass %s\\n' ${REDIS_PASSWORD} > ${VALKEY_CONF} && exec valkey-server ${VALKEY_CONF}`,
          ],
          healthcheck: {
            test: [
              "CMD-SHELL",
              `[ "$$(REDISCLI_AUTH=${REDIS_PASSWORD} valkey-cli ping)" = PONG ]`,
            ],
            interval: "2s",
            timeout: "3s",
            retries: 10,
          },
          volumes: [secretsRo, "redis:/data"],
        },
        netbox: {
          ...netbox,
          depends_on: {
            postgres: { condition: "service_healthy" },
            redis: { condition: "service_healthy" },
          },
          ports: [`${g.bindAddress}:${g.port}:8080`],
          healthcheck: {
            test: ["CMD", "/opt/netbox/health.sh"],
            // Migrations on the first start can take several minutes;
            // `start` bounds the wait with timeoutSeconds instead.
            start_period: "1800s",
            interval: "5s",
            timeout: "3s",
          },
        },
        "netbox-worker": {
          ...netbox,
          depends_on: { netbox: { condition: "service_healthy" } },
          command: [
            "/opt/netbox/venv/bin/python",
            "/opt/netbox/netbox/manage.py",
            "rqworker",
          ],
          healthcheck: {
            test: ["CMD-SHELL", "ps -aux | grep -v grep | grep -q rqworker"],
            start_period: "20s",
            interval: "15s",
            timeout: "3s",
          },
        },
      },
      volumes: Object.fromEntries(
        Object.entries(v).map(([key, name]) => [key, { name }]),
      ),
    },
    null,
    2,
  );
}

/** `docker compose` arguments for the instance, reading the file from stdin. */
export function composeArgs(g: GlobalArgs, ...rest: string[]): string[] {
  return ["compose", "--project-name", g.name, "--file", "-", ...rest];
}

const PsRowsSchema = z.array(
  z.object({ Service: z.string(), State: z.string() }),
);

/**
 * The state of each service's container from `docker compose ps --format
 * json`, which prints one JSON object per line (older releases: an array).
 */
export function parsePs(stdout: string): Record<string, string> {
  if (!stdout) return {};
  let rows: unknown;
  try {
    rows = stdout.startsWith("[")
      ? JSON.parse(stdout)
      : stdout.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  } catch {
    throw new Error(`Unexpected docker compose ps output: ${stdout}`);
  }
  return Object.fromEntries(
    PsRowsSchema.parse(rows).map((r) => [r.Service, r.State]),
  );
}

/** The project's state, judged by the NetBox container. */
export function projectState(services: Record<string, string>): State {
  if (!("netbox" in services)) return "absent";
  return services.netbox === "running" ? "running" : "stopped";
}

async function ps(
  docker: Docker,
  g: GlobalArgs,
): Promise<Record<string, string>> {
  const out = check(
    await docker(composeArgs(g, "ps", "--all", "--format", "json"), {
      input: composeFile(g),
    }),
    `Listing ${g.name}'s containers`,
  );
  return parsePs(out);
}

// Run inside the NetBox container with `manage.py shell`. The password and
// token reach it through the environment, not the argument list. A token
// with the same key is replaced if its secret or owner differ or it has been
// disabled, expired or made read-only. Prints one JSON line for `start`.
export const ENSURE_ADMIN = `
import json, os
from django.conf import settings
from users.models import User
env = os.environ
user = User.objects.filter(username=env["NB_USER"]).first()
created = user is None
if created:
    user = User.objects.create_superuser(env["NB_USER"], env["NB_EMAIL"], env["NB_PASSWORD"])
else:
    user.set_password(env["NB_PASSWORD"])
    user.is_active = True
    user.is_superuser = True
    user.save()
token = "absent"
if env.get("NB_TOKEN"):
    # v2 tokens arrived in NetBox 4.5; imported here so older images work
    # without apiToken.
    from users.choices import TokenVersionChoices
    from users.models import Token
    key, secret = env["NB_TOKEN"].removeprefix("nbt_").split(".", 1)
    t = Token.objects.filter(key=key).first()
    token = "unchanged" if t is not None else "created"
    if t is not None and (t.user_id != user.pk or not t.validate(secret)
                          or not t.is_active or not t.write_enabled):
        t.delete()
        t = None
        token = "replaced"
    if t is None:
        Token.objects.create(user=user, version=TokenVersionChoices.V2, key=key,
                             token=secret, description="Managed by swamp")
print(json.dumps({"user": "created" if created else "updated",
                  "token": token, "version": settings.RELEASE.version}))
`;

/** `docker compose exec` arguments that run ENSURE_ADMIN. */
export function ensureAdminArgs(g: GlobalArgs): string[] {
  return composeArgs(
    g,
    "exec",
    "-T",
    ...["NB_USER", "NB_EMAIL", "NB_PASSWORD", "NB_TOKEN"].flatMap((
      e,
    ) => ["--env", e]),
    "netbox",
    "/opt/netbox/venv/bin/python",
    "/opt/netbox/netbox/manage.py",
    "shell",
    "--command",
    ENSURE_ADMIN,
  );
}

const EnsuredSchema = z.object({
  user: z.enum(["created", "updated"]),
  token: z.enum(["absent", "created", "replaced", "unchanged"]),
  version: z.string(),
});
/** What ENSURE_ADMIN reported. */
export type Ensured = z.infer<typeof EnsuredSchema>;

/** The JSON line ENSURE_ADMIN printed, ignoring anything NetBox logs first. */
export function parseEnsured(stdout: string): Ensured {
  const line = stdout.split("\n").reverse().find((l) => l.startsWith("{"));
  try {
    return EnsuredSchema.parse(JSON.parse(line ?? ""));
  } catch {
    throw new Error(
      `Unexpected output from NetBox's superuser setup: ${stdout}`,
    );
  }
}

function baseUrl(g: GlobalArgs): string {
  const host = g.bindAddress === "0.0.0.0" ? "127.0.0.1" : g.bindAddress;
  return `http://${host.includes(":") ? `[${host}]` : host}:${g.port}`;
}

function describe(
  g: GlobalArgs,
  action: Instance["action"],
  services: Record<string, string>,
  ensured?: Ensured,
): Instance {
  const url = baseUrl(g);
  return {
    name: g.name,
    image: g.image,
    state: projectState(services),
    action,
    url,
    apiUrl: `${url}/api/`,
    username: g.adminUsername,
    apiToken: ensured ? ensured.token !== "absent" : null,
    version: ensured?.version ?? null,
    services,
    volumes: Object.values(volumes(g.name)),
    checkedAt: new Date().toISOString(),
  };
}

async function save(context: Context, instance: Instance) {
  const handle = await context.writeResource("instance", "instance", instance);
  return { dataHandles: [handle] };
}

function dockerFor(g: GlobalArgs, hooks: Hooks): Docker {
  return hooks._docker ?? dockerRunner(g.dockerPath);
}

/** Outcome of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

interface CheckContext {
  globalArgs: GlobalArgs;
}

/** Pre-flight: the Docker daemon is running and has the compose plugin. */
export async function checkDockerReady(docker: Docker): Promise<CheckResult> {
  const errors: string[] = [];
  try {
    const info = await docker(["info", "--format", "{{.ServerVersion}}"]);
    if (info.code !== 0) {
      errors.push(
        `Docker is not running; start Docker Desktop or the docker daemon (${
          info.stderr || info.stdout
        })`,
      );
    }
    const compose = await docker(["compose", "version"]);
    if (compose.code !== 0) {
      errors.push(
        `docker compose is not available; install the Docker Compose plugin (${
          compose.stderr || compose.stdout
        })`,
      );
    }
  } catch (err) {
    errors.push((err as Error).message);
  }
  return errors.length ? { pass: false, errors } : { pass: true };
}

/** Tries to bind the port; true when it is free. Injectable for tests. */
export type PortFree = (hostname: string, port: number) => Promise<boolean>;

/** Binds and releases the port to see whether something else holds it. */
export const portFree: PortFree = (hostname, port) => {
  try {
    Deno.listen({ hostname, port }).close();
    return Promise.resolve(true);
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) return Promise.resolve(false);
    throw err;
  }
};

/** Pre-flight: the port is free, unless this project's NetBox holds it. */
export async function checkPortAvailable(
  g: GlobalArgs,
  docker: Docker,
  free: PortFree = portFree,
): Promise<CheckResult> {
  let services: Record<string, string>;
  try {
    services = await ps(docker, g);
  } catch {
    return { pass: true }; // docker-ready reports why Docker can't be asked
  }
  if (services.netbox === "running") return { pass: true };
  return await free(g.bindAddress, g.port) ? { pass: true } : {
    pass: false,
    errors: [
      `Port ${g.port} on ${g.bindAddress} is already in use; stop what is using it or choose another port`,
    ],
  };
}

/** The `@taylor/netbox/instance` swamp model type. */
export const model = {
  type: "@taylor/netbox/instance",
  version: "2026.10.22.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.22.1",
      description: "Relicenses under AGPL-3.0-or-later; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    instance: {
      description:
        "The NetBox compose project, where to reach it and its services' states",
      schema: InstanceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "docker-ready": {
      description: "Docker is running and has the compose plugin",
      labels: ["live"],
      execute: (ctx: CheckContext) =>
        checkDockerReady(dockerRunner(ctx.globalArgs.dockerPath)),
    },
    "port-available": {
      description:
        "The host port is free, unless this project's NetBox already holds it",
      labels: ["live"],
      appliesTo: ["start"],
      execute: (ctx: CheckContext) =>
        checkPortAvailable(
          ctx.globalArgs,
          dockerRunner(ctx.globalArgs.dockerPath),
        ),
    },
  },
  methods: {
    start: {
      description:
        "Bring up NetBox, its worker, PostgreSQL and Valkey, wait until they are healthy, and set up the superuser and API token",
      arguments: StartArgsSchema,
      execute: async (args: StartArgs & Hooks, context: Context) => {
        const g = context.globalArgs;
        const docker = dockerFor(g, args);
        const before = projectState(await ps(docker, g));
        context.logger.info(
          "Bringing up {name} from {image}; the first start runs migrations and takes a few minutes",
          { name: g.name, image: g.image },
        );
        check(
          await docker(
            composeArgs(
              g,
              "up",
              "--detach",
              "--wait",
              "--wait-timeout",
              String(args.timeoutSeconds),
            ),
            { input: composeFile(g) },
          ),
          `Starting ${g.name} (see \`docker compose --project-name ${g.name} logs\`)`,
        );

        const ensured = parseEnsured(check(
          await docker(ensureAdminArgs(g), {
            input: composeFile(g),
            env: {
              NB_USER: g.adminUsername,
              NB_EMAIL: g.adminEmail,
              NB_PASSWORD: g.adminPassword,
              NB_TOKEN: g.apiToken ?? "",
            },
          }),
          "Setting up the superuser",
        ));
        context.logger.info("Superuser {user} {result}", {
          user: g.adminUsername,
          result: ensured.user,
        });
        if (ensured.token === "replaced") {
          context.logger.warn(
            "An existing API token with that key had a different secret or owner; replaced it",
          );
        } else if (ensured.token !== "absent") {
          context.logger.info("API token {result}", { result: ensured.token });
        }

        const action = before === "absent"
          ? "created"
          : before === "stopped"
          ? "started"
          : "running";
        const instance = describe(g, action, await ps(docker, g), ensured);
        context.logger.info("NetBox {version} is up at {url}", {
          version: ensured.version,
          url: instance.url,
        });
        return save(context, instance);
      },
    },
    status: {
      description: "Report whether NetBox and each of its services is running",
      arguments: z.object({}),
      execute: async (args: Hooks, context: Context) => {
        const g = context.globalArgs;
        const services = await ps(dockerFor(g, args), g);
        const instance = describe(g, "status", services);
        context.logger.info("{name} is {state}", {
          name: g.name,
          state: instance.state,
        });
        return save(context, instance);
      },
    },
    stop: {
      description: "Stop every container, keeping them and their volumes",
      arguments: z.object({}),
      execute: async (args: Hooks, context: Context) => {
        const g = context.globalArgs;
        const docker = dockerFor(g, args);
        check(
          await docker(composeArgs(g, "stop"), { input: composeFile(g) }),
          `Stopping ${g.name}`,
        );
        context.logger.info("Stopped {name}", { name: g.name });
        return save(context, describe(g, "stopped", await ps(docker, g)));
      },
    },
    remove: {
      description:
        "Remove the containers and network; the volumes are kept unless deleteVolumes is set",
      arguments: RemoveArgsSchema,
      execute: async (args: RemoveArgs & Hooks, context: Context) => {
        const g = context.globalArgs;
        const docker = dockerFor(g, args);
        check(
          await docker(
            composeArgs(
              g,
              "down",
              "--remove-orphans",
              ...(args.deleteVolumes ? ["--volumes"] : []),
            ),
            { input: composeFile(g) },
          ),
          `Removing ${g.name}`,
        );
        if (args.deleteVolumes) {
          context.logger.warn("Deleted volumes {volumes}", {
            volumes: Object.values(volumes(g.name)).join(", "),
          });
        }
        context.logger.info("Removed {name}", { name: g.name });
        return save(context, describe(g, "removed", {}));
      },
    },
  },
};
