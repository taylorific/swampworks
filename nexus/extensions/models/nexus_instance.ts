import { z } from "npm:zod@4";

// A Sonatype Nexus Repository instance running in one container, with its
// data in a named volume so it survives the container. Runs with Docker or
// Apple's `container` CLI. `start` creates the container (or starts a stopped
// one), waits until Nexus answers, and then does what the onboarding wizard
// would: sets the admin password, accepts the Community Edition EULA and
// configures anonymous access, so the wizard is never shown. `stop` stops the
// container and `delete` removes it and, if asked, the volume. `sync` reads
// the container and Nexus without changing anything and records where they
// have drifted from the arguments. Pre-flight
// checks make sure the runtime is up, the port is free, there is enough
// memory, and that a container already using the name is a Nexus one created
// with the configured image and port.

const NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const DATA_DIR = "/nexus-data";
const BOOTSTRAP_PASSWORD = `${DATA_DIR}/admin.password`;
const PROPERTIES_FILE = `${DATA_DIR}/etc/nexus.properties`;
const NEXUS_PORT = 8081;
const NEXUS_UID = "200:200";
const BUILTIN_ADMIN = "admin";
/** Nexus's default JVM heap is 2703 MiB; leave room for the rest of it. */
export const MIN_MEMORY_MIB = 3072;
/** Apple's container gives 1 GiB by default, too little for Nexus. */
const APPLE_DEFAULT_MEMORY = "4g";

const RUNTIMES = ["docker", "container"] as const;
/** Container runtime CLI: Docker or Apple's `container`. */
export type Runtime = typeof RUNTIMES[number];

const GlobalArgsSchema = z.object({
  runtime: z.enum(RUNTIMES).default("docker").describe(
    "Container runtime: docker, or container (Apple's container CLI; start it with `container system start`)",
  ),
  runtimePath: z.string().optional().describe(
    "Path to the runtime CLI if it is not `docker`/`container` on PATH",
  ),
  containerName: z.string().regex(NAME).default("nexus").describe(
    "Container name",
  ),
  image: z.string().default("docker.io/sonatype/nexus3:3.96.4").describe(
    "Nexus Repository image",
  ),
  port: z.number().int().min(1).max(65535).default(8081).describe(
    "Host port for the Nexus web UI and API",
  ),
  bindAddress: z.string().default("127.0.0.1").describe(
    "Host address to publish the port on; 0.0.0.0 exposes it to the network",
  ),
  volume: z.string().regex(NAME).default("nexus-data").describe(
    `Named volume mounted at ${DATA_DIR}`,
  ),
  memory: z.string().regex(/^\d+[mMgG]$/).optional().describe(
    `Memory limit such as 4g or 6144m; at least ${MIN_MEMORY_MIB}m. Defaults to no limit on docker and ${APPLE_DEFAULT_MEMORY} on container`,
  ),
  ports: z.array(z.number().int().min(1).max(65535)).default([]).describe(
    "Extra container ports to publish on the same host port, e.g. [10080, 10443] for docker repository connectors",
  ),
  properties: z.record(
    z.string().regex(/^[A-Za-z0-9._-]+$/),
    z.union([z.string(), z.number(), z.boolean()]).refine(
      (v) => !/[\r\n]/.test(String(v)),
      "values cannot contain line breaks",
    ),
  ).default({}).describe(
    "Settings written to /nexus-data/etc/nexus.properties, e.g. { nexus.skipDefaultRepositories: true }; the file is replaced, and Nexus restarted when it changes. Empty leaves the file alone",
  ),
  adminUsername: z.string().regex(NAME).default(BUILTIN_ADMIN).describe(
    "Administrator to sign in as; any name but admin is created with the nx-admin role and the built-in admin is disabled",
  ),
  adminPassword: z.string().min(1).meta({ sensitive: true }).describe(
    "Administrator password, set on first start; use a vault expression",
  ),
  anonymousAccess: z.boolean().default(true).describe(
    "Let anonymous users read repositories without signing in",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const InstanceSchema = z.object({
  runtime: z.enum(RUNTIMES),
  containerName: z.string(),
  containerId: z.string(),
  image: z.string(),
  volume: z.string(),
  url: z.string(),
  adminUsername: z.string(),
  state: z.enum(["running", "stopped", "removed", "absent"]).describe(
    "absent: sync found no container",
  ),
  action: z.enum([
    "created",
    "started",
    "stopped",
    "removed",
    "unchanged",
    "synced",
    "restarted",
  ]),
  nexusReady: z.boolean().nullable().describe(
    "Whether Nexus answered its status endpoint; null when the container was not checked",
  ),
  bootstrapped: z.boolean().describe(
    "True when this run replaced the generated admin password",
  ),
  anonymousAccess: z.boolean().nullable().describe(
    "Anonymous access as Nexus reports it; null when it could not be read",
  ),
  pendingOnboarding: z.array(z.string()).nullable().describe(
    "Onboarding wizard steps Nexus still reports; empty when the wizard will not be shown, null when not checked (stop, delete) or unreadable",
  ),
  drift: z.array(z.string()).nullable().describe(
    "Where the live instance differs from the model's arguments (sync); empty after start, null when not checked",
  ),
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

/** Outcome of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** Result of one runtime CLI call. */
export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the runtime CLI with the given arguments. Injectable for tests. */
export type Cli = (args: string[]) => Promise<CliResult>;

export {
  type Api,
  apiClient,
  type ApiRequest,
  type ApiResponse,
  basicAuth,
  expectOk,
  type Probe,
  statusProbe,
  waitUntilReady,
} from "./_lib/nexus_api.ts";
import {
  type Api,
  apiClient,
  type ApiRequest,
  expectOk,
  type Probe,
  statusProbe,
  waitUntilReady,
} from "./_lib/nexus_api.ts";

/** Runs a container runtime CLI and captures its output. */
export function cliRunner(bin: string): Cli {
  return async (args) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs the docker or Apple container CLI; argument lists are built in this file, see README What it runs
      out = await new Deno.Command(bin, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(600000),
      }).output();
    } catch (err) {
      throw new Error(`Cannot run ${bin}: ${(err as Error).message}`);
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}

/** The runtime CLI the global arguments select. */
export function cliFor(g: GlobalArgs): Cli {
  return cliRunner(g.runtimePath ?? g.runtime);
}

/** A container as the runtime reports it. */
export interface ContainerInfo {
  id: string;
  running: boolean;
  image: string;
  /** Host port published for Nexus's 8081, or null if none. */
  hostPort: number | null;
  /** Other published container ports, sorted. */
  extraPorts: number[];
  /** Times the runtime restarted it after it exited (Docker only). */
  restarts: number;
}

/** Commands and output that differ between Docker and Apple's container. */
export const RUNTIME_ARGS: Record<Runtime, {
  inspect: (name: string) => string[];
  parse: (json: unknown) => ContainerInfo;
  remove: (name: string) => string[];
  removeVolume: (volume: string) => string[];
  runFlags: string[];
  status: string[];
  isReady: (r: CliResult) => boolean;
  notReady: string;
}> = {
  docker: {
    inspect: (name) => ["container", "inspect", name],
    parse: (json) => {
      const c = (json as {
        Id?: string;
        State?: { Running?: boolean; Restarting?: boolean };
        RestartCount?: number;
        Config?: { Image?: string };
        HostConfig?: {
          PortBindings?: Record<string, { HostPort?: string }[] | null>;
        };
      }[])[0] ?? {};
      const bound = c.HostConfig?.PortBindings?.[`${NEXUS_PORT}/tcp`]?.[0];
      return {
        id: String(c.Id ?? ""),
        // A crash-looping container reports Running and Restarting at once.
        running: c.State?.Running === true && c.State?.Restarting !== true,
        image: String(c.Config?.Image ?? ""),
        hostPort: bound?.HostPort ? Number(bound.HostPort) : null,
        extraPorts: otherPorts(
          Object.entries(c.HostConfig?.PortBindings ?? {})
            .filter(([, b]) => b?.length)
            .map(([key]) => Number(key.split("/")[0])),
        ),
        restarts: Number(c.RestartCount ?? 0),
      };
    },
    remove: (name) => ["rm", "--force", name],
    removeVolume: (volume) => ["volume", "rm", volume],
    // Apple's container has no restart policy; `start` brings it back.
    runFlags: ["--restart", "unless-stopped"],
    status: ["version", "--format", "{{.Server.Version}}"],
    isReady: (r) => r.code === 0,
    notReady:
      "Docker is not running; start Docker Desktop or the docker daemon",
  },
  container: {
    inspect: (name) => ["inspect", name],
    parse: (json) => {
      const c = (json as {
        id?: string;
        status?: { state?: string };
        configuration?: {
          image?: { reference?: string };
          publishedPorts?: { containerPort?: number; hostPort?: number }[];
        };
      }[])[0] ?? {};
      const bound = c.configuration?.publishedPorts?.find((p) =>
        p.containerPort === NEXUS_PORT
      );
      return {
        id: String(c.id ?? ""),
        running: c.status?.state === "running",
        image: String(c.configuration?.image?.reference ?? ""),
        hostPort: bound?.hostPort ?? null,
        extraPorts: otherPorts(
          (c.configuration?.publishedPorts ?? []).map((p) =>
            Number(p.containerPort)
          ),
        ),
        restarts: 0,
      };
    },
    remove: (name) => ["delete", "--force", name],
    removeVolume: (volume) => ["volume", "delete", volume],
    runFlags: [],
    status: ["system", "status", "--format", "json"],
    isReady: (r) => {
      if (r.code !== 0) return false;
      try {
        return JSON.parse(r.stdout).status === "running";
      } catch {
        return false;
      }
    },
    notReady:
      "Apple's container system is not running; run `container system start`",
  },
};

/** Container ports other than Nexus's own, sorted and without repeats. */
export function otherPorts(ports: number[]): number[] {
  return [...new Set(ports.filter((p) => p !== NEXUS_PORT))].sort((a, b) =>
    a - b
  );
}

/** Fails with the runtime's message when a call did not succeed. */
function check(r: CliResult, what: string): string {
  if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** The container, or null when there is none with that name. */
export async function inspect(
  g: GlobalArgs,
  cli: Cli,
): Promise<ContainerInfo | null> {
  const rt = RUNTIME_ARGS[g.runtime];
  const r = await cli(rt.inspect(g.containerName));
  if (r.code !== 0) {
    if (/no such (container|object)|not found/i.test(r.stderr)) return null;
    check(r, `${g.runtime} inspect ${g.containerName}`);
  }
  let json: unknown;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`Unexpected ${g.runtime} inspect output: ${r.stdout}`);
  }
  if (!Array.isArray(json) || json.length === 0) return null;
  return rt.parse(json);
}

/** Memory limit in MiB, e.g. "4g" → 4096. */
export function memoryMiB(spec: string): number {
  const n = Number(spec.slice(0, -1));
  return /g$/i.test(spec) ? n * 1024 : n;
}

/** The memory limit passed to the runtime, if any. */
export function effectiveMemory(g: GlobalArgs): string | undefined {
  return g.memory ??
    (g.runtime === "container" ? APPLE_DEFAULT_MEMORY : undefined);
}

/** Tries to bind the port; true when it is free. Injectable for tests. */
export type PortFree = (hostname: string, port: number) => Promise<boolean>;

/**
 * Whether the port is free. Binding alone is not enough: with SO_REUSEADDR a
 * bind to 127.0.0.1 succeeds while another process (or Docker) holds
 * 0.0.0.0, and the other way round, so a successful connect also means the
 * port is taken. Throws when the address cannot be bound at all.
 */
export const portFree: PortFree = async (hostname, port) => {
  const host = hostname === "0.0.0.0" ? "127.0.0.1" : hostname;
  // A connect to an address that isn't local can hang for 75s; give up after
  // 2s and let the bind below report the address. A connection that arrives
  // after that is still closed by the handler.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const answered = await Promise.race([
    Deno.connect({ hostname: host, port }).then((conn) => {
      conn.close();
      return true;
    }, () => false),
    new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), 2000);
    }),
  ]);
  clearTimeout(timer);
  if (answered) return false;
  try {
    Deno.listen({ hostname, port }).close();
    return true;
  } catch (err) {
    if (err instanceof Deno.errors.AddrInUse) return false;
    throw err;
  }
};

/**
 * The container for a check, or "unknown" when the runtime cannot be asked;
 * `runtime-ready` reports that, so other checks need not repeat it.
 */
async function inspectForCheck(
  g: GlobalArgs,
  cli: Cli,
): Promise<ContainerInfo | null | "unknown"> {
  try {
    return await inspect(g, cli);
  } catch {
    return "unknown";
  }
}

/** Pre-flight: the runtime CLI is installed and its engine is running. */
export async function checkRuntimeReady(
  g: GlobalArgs,
  cli: Cli,
): Promise<CheckResult> {
  const rt = RUNTIME_ARGS[g.runtime];
  let r: CliResult;
  try {
    r = await cli(rt.status);
  } catch (err) {
    return { pass: false, errors: [(err as Error).message] };
  }
  return rt.isReady(r)
    ? { pass: true }
    : { pass: false, errors: [`${rt.notReady} (${r.stderr || r.stdout})`] };
}

/** Pre-flight: a container that already has the name runs Nexus. */
export async function checkExistingIsNexus(
  g: GlobalArgs,
  cli: Cli,
): Promise<CheckResult> {
  const current = await inspectForCheck(g, cli);
  if (
    current === null || current === "unknown" || /nexus/i.test(current.image)
  ) {
    return { pass: true };
  }
  return {
    pass: false,
    errors: [
      `Container ${g.containerName} already exists and runs ${current.image}, not Nexus; choose another containerName`,
    ],
  };
}

/** Image reference without the implied docker.io/ and library/ parts. */
export function normalizeImage(ref: string): string {
  return ref.replace(/^docker\.io\//, "").replace(/^library\//, "");
}

/** How the container differs from the configured image and port. */
export function containerDrift(
  g: GlobalArgs,
  current: ContainerInfo,
): string[] {
  const drift: string[] = [];
  if (normalizeImage(current.image) !== normalizeImage(g.image)) {
    drift.push(
      `${g.containerName} runs ${current.image} but image is ${g.image}`,
    );
  }
  if (current.hostPort !== g.port) {
    drift.push(
      `${g.containerName} publishes port ${
        current.hostPort ?? "none"
      } but port is ${g.port}`,
    );
  }
  const want = otherPorts(g.ports);
  if (JSON.stringify(current.extraPorts) !== JSON.stringify(want)) {
    drift.push(
      `${g.containerName} publishes extra ports [${
        current.extraPorts.join(", ")
      }] but ports is [${want.join(", ")}]`,
    );
  }
  return drift;
}

/**
 * Pre-flight: an existing container was created with this image and port.
 * `start` reuses the container as it is, so a changed image or port would
 * otherwise be ignored. Recreating it is left to the user because a newer
 * image migrates the Nexus database, which cannot be undone.
 */
export async function checkExistingMatches(
  g: GlobalArgs,
  cli: Cli,
): Promise<CheckResult> {
  const current = await inspectForCheck(g, cli);
  if (current === null || current === "unknown") return { pass: true };
  const errors = containerDrift(g, current);
  if (!errors.length) return { pass: true };
  errors.push(
    `Run delete (the ${g.volume} volume is kept) and then start to recreate it, or change the arguments back`,
  );
  return { pass: false, errors };
}

/** Pre-flight: the port is free, unless our container already holds it. */
export async function checkPortAvailable(
  g: GlobalArgs,
  cli: Cli,
  free: PortFree = portFree,
): Promise<CheckResult> {
  const current = await inspectForCheck(g, cli);
  if (current !== null) return { pass: true }; // ours, or runtime-ready fails
  const errors: string[] = [];
  for (const port of [g.port, ...otherPorts(g.ports)]) {
    try {
      if (!await free(g.bindAddress, port)) {
        errors.push(
          `Port ${port} on ${g.bindAddress} is already in use; stop what is using it or choose another port`,
        );
      }
    } catch (err) {
      errors.push(
        `Cannot bind ${g.bindAddress}:${port}: ${(err as Error).message}`,
      );
    }
  }
  return errors.length ? { pass: false, errors } : { pass: true };
}

/** Pre-flight: a memory limit, if any, leaves room for Nexus's JVM. */
export function checkMemory(g: GlobalArgs): CheckResult {
  const memory = effectiveMemory(g);
  if (!memory || memoryMiB(memory) >= MIN_MEMORY_MIB) return { pass: true };
  return {
    pass: false,
    errors: [
      `memory ${memory} is below the ${MIN_MEMORY_MIB}m Nexus needs for its 2703m JVM heap; raise memory`,
    ],
  };
}

/** `run` arguments that create the Nexus container. */
export function runArgs(g: GlobalArgs): string[] {
  const memory = effectiveMemory(g);
  return [
    "run",
    "--detach",
    "--name",
    g.containerName,
    ...RUNTIME_ARGS[g.runtime].runFlags,
    ...(memory ? ["--memory", memory] : []),
    "--publish",
    `${g.bindAddress}:${g.port}:${NEXUS_PORT}`,
    ...otherPorts(g.ports).flatMap((p) => [
      "--publish",
      `${g.bindAddress}:${p}:${p}`,
    ]),
    "--volume",
    `${g.volume}:${DATA_DIR}`,
    g.image,
  ];
}

/** The nexus.properties the arguments ask for, or "" to leave it alone. */
export function propertiesContent(g: GlobalArgs): string {
  const keys = Object.keys(g.properties).sort();
  if (!keys.length) return "";
  return [
    "# Managed by @taylor/nexus; changes here are overwritten by start",
    ...keys.map((k) => `${k}=${g.properties[k]}`),
    "",
  ].join("\n");
}

/** Shell that writes $1 to nexus.properties, owned by the nexus user. */
const WRITE_PROPERTIES =
  `mkdir -p ${DATA_DIR}/etc && printf '%s' "$1" > ${PROPERTIES_FILE} && chown -R ${NEXUS_UID} ${DATA_DIR}/etc`;

/**
 * `run` arguments for a throwaway root container that prepares the volume
 * before Nexus runs on it: hands its root to the nexus user (Docker copies
 * the image's ownership into a new volume, Apple's container creates it
 * owned by root) and writes nexus.properties, which Nexus reads at boot.
 */
export function prepareArgs(g: GlobalArgs): string[] {
  const content = propertiesContent(g);
  const script = `chown ${NEXUS_UID} ${DATA_DIR}` +
    (content ? ` && ${WRITE_PROPERTIES}` : "");
  return [
    "run",
    "--rm",
    "--user",
    "root",
    "--entrypoint",
    "sh",
    "--volume",
    `${g.volume}:${DATA_DIR}`,
    g.image,
    "-c",
    script,
    "sh",
    content,
  ];
}

/** Whether a running container's nexus.properties differs from the arguments. */
export async function propertiesDiffer(
  g: GlobalArgs,
  cli: Cli,
): Promise<boolean> {
  const want = propertiesContent(g);
  if (!want) return false;
  const r = await cli(["exec", g.containerName, "cat", PROPERTIES_FILE]);
  // cliRunner trims output, so compare trimmed.
  return r.code !== 0 || r.stdout.trim() !== want.trim();
}

/** Base URL of the Nexus UI, as reachable from this host. */
export function nexusUrl(g: GlobalArgs): string {
  const host = g.bindAddress === "0.0.0.0" ? "127.0.0.1" : g.bindAddress;
  return `http://${host.includes(":") ? `[${host}]` : host}:${g.port}`;
}

/** What `configure` did and what Nexus still asks for. */
export interface Configured {
  bootstrapped: boolean;
  pendingOnboarding: string[] | null;
}

/**
 * Brings a running Nexus to the state the onboarding wizard would leave it
 * in: the admin password replaced, the EULA accepted and anonymous access
 * configured, so the wizard has nothing left to show. When the configured
 * credentials do not work yet, signs in with the generated password from
 * `admin.password` first. Safe to repeat.
 */
export async function configure(
  g: GlobalArgs,
  api: Api,
  cli: Cli,
  logger: Logger,
): Promise<Configured> {
  const pw = g.adminPassword;
  const user = g.adminUsername;
  const custom = user !== BUILTIN_ADMIN;
  // Only a 401 means the password is wrong; anything else is a real failure
  // and must not send us down the bootstrap path.
  const signsIn = async (u: string, p: string) => {
    const r = await api({
      method: "GET",
      path: "/v1/security/realms/active",
      user: u,
      password: p,
    });
    if (r.status === 401) return false;
    expectOk(r, `Signing in as ${u}`);
    return true;
  };

  let bootstrapped = false;
  if (!(await signsIn(user, pw))) {
    // A custom user may be missing after a run that already set admin's
    // password; otherwise sign in with the generated one.
    if (!custom || !(await signsIn(BUILTIN_ADMIN, pw))) {
      const file = await cli([
        "exec",
        g.containerName,
        "cat",
        BOOTSTRAP_PASSWORD,
      ]);
      if (file.code !== 0 || !file.stdout) {
        throw new Error(
          `Nexus rejected ${user}'s password and ${BOOTSTRAP_PASSWORD} is gone, so it was set up with a different password. Change it in Nexus or delete the volume ${g.volume}.`,
        );
      }
      logger.info("Replacing the generated admin password");
      expectOk(
        await api({
          method: "PUT",
          path: `/v1/security/users/${BUILTIN_ADMIN}/change-password`,
          user: BUILTIN_ADMIN,
          password: file.stdout,
          text: pw,
        }),
        "Changing the admin password",
      );
      bootstrapped = true;
    }
    if (custom) {
      logger.info("Creating administrator {user}", { user });
      expectOk(
        await api({
          method: "POST",
          path: "/v1/security/users",
          user: BUILTIN_ADMIN,
          password: pw,
          json: {
            userId: user,
            firstName: "Nexus",
            lastName: "Administrator",
            emailAddress: `${user}@example.invalid`,
            password: pw,
            status: "active",
            roles: ["nx-admin"],
          },
        }),
        `Creating user ${user}`,
      );
    }
    if (!(await signsIn(user, pw))) {
      throw new Error(`Nexus still rejects ${user}'s password after setup`);
    }
  }
  const call = (method: ApiRequest["method"], path: string, json?: unknown) =>
    api({ method, path, user, password: pw, json });

  // Community Edition asks for the EULA; other editions answer 404.
  const eula = await call("GET", "/v1/system/eula");
  if (eula.status !== 404) {
    const terms = JSON.parse(expectOk(eula, "Reading the EULA").body);
    if (terms.accepted !== true) {
      logger.info("Accepting the Nexus Community Edition EULA");
      expectOk(
        await call("POST", "/v1/system/eula", {
          accepted: true,
          disclaimer: terms.disclaimer,
        }),
        "Accepting the EULA",
      );
    }
  }

  const anon = JSON.parse(
    expectOk(
      await call("GET", "/v1/security/anonymous"),
      "Reading anonymous access",
    ).body,
  );
  // The wizard counts anonymous access as configured only once it has been
  // saved, so save it even when it already has the wanted value.
  expectOk(
    await call("PUT", "/v1/security/anonymous", {
      ...anon,
      enabled: g.anonymousAccess,
    }),
    "Setting anonymous access",
  );

  if (custom) {
    const found = JSON.parse(
      expectOk(
        await call(
          "GET",
          `/v1/security/users?userId=${BUILTIN_ADMIN}&source=default`,
        ),
        "Reading the built-in admin",
      ).body,
    ) as Record<string, unknown>[];
    const admin = found.find((u) => u.userId === BUILTIN_ADMIN);
    if (admin && admin.status !== "disabled") {
      logger.info("Disabling the built-in admin user");
      expectOk(
        await call("PUT", `/v1/security/users/${BUILTIN_ADMIN}`, {
          ...admin,
          status: "disabled",
        }),
        "Disabling the built-in admin",
      );
    }
  }

  // Internal API behind the wizard; anything unexpected is recorded as
  // unknown (null) rather than as nothing pending.
  let pendingOnboarding: string[] | null = null;
  const onboarding = await call("GET", "/internal/ui/onboarding");
  if (onboarding.status === 200) {
    const items: unknown = JSON.parse(onboarding.body);
    if (Array.isArray(items)) {
      pendingOnboarding = items.map((item) => String(item?.type));
    }
  }
  if (pendingOnboarding === null) {
    logger.warn("Could not read the onboarding steps Nexus still lists");
  } else if (pendingOnboarding.length) {
    logger.warn("Nexus still lists onboarding steps: {steps}", {
      steps: pendingOnboarding.join(", "),
    });
  }
  return { bootstrapped, pendingOnboarding };
}

/** What `sync` saw inside a running container. */
export interface Observed {
  nexusReady: boolean;
  anonymousAccess: boolean | null;
  pendingOnboarding: string[] | null;
  drift: string[];
}

/**
 * Reads a running Nexus without changing it: one readiness probe, then GET
 * requests only, signed in as adminUsername. Never bootstraps, so a password
 * Nexus rejects is reported as drift rather than fixed.
 */
export async function observe(
  g: GlobalArgs,
  api: Api,
  probe: Probe,
): Promise<Observed> {
  const seen: Observed = {
    nexusReady: await probe(nexusUrl(g)),
    anonymousAccess: null,
    pendingOnboarding: null,
    drift: [],
  };
  if (!seen.nexusReady) return seen;
  const get = (path: string) =>
    api({
      method: "GET",
      path,
      user: g.adminUsername,
      password: g.adminPassword,
    });

  const signIn = await get("/v1/security/realms/active");
  if (signIn.status === 401) {
    seen.drift.push(
      `Nexus rejects ${g.adminUsername}'s password; run start to set it up, or update adminPassword`,
    );
    return seen;
  }
  expectOk(signIn, `Signing in as ${g.adminUsername}`);

  const anon = JSON.parse(
    expectOk(await get("/v1/security/anonymous"), "Reading anonymous access")
      .body,
  );
  seen.anonymousAccess = anon.enabled === true;
  if (seen.anonymousAccess !== g.anonymousAccess) {
    seen.drift.push(
      `anonymous access is ${
        seen.anonymousAccess ? "on" : "off"
      } in Nexus but anonymousAccess is ${g.anonymousAccess}`,
    );
  }

  if (g.adminUsername !== BUILTIN_ADMIN) {
    const found = JSON.parse(
      expectOk(
        await get(`/v1/security/users?userId=${BUILTIN_ADMIN}&source=default`),
        "Reading the built-in admin",
      ).body,
    ) as Record<string, unknown>[];
    const admin = found.find((u) => u.userId === BUILTIN_ADMIN);
    if (admin && admin.status !== "disabled") {
      seen.drift.push(
        `the built-in admin user is enabled, but adminUsername is ${g.adminUsername}`,
      );
    }
  }

  const onboarding = await get("/internal/ui/onboarding");
  if (onboarding.status === 200) {
    const items: unknown = JSON.parse(onboarding.body);
    if (Array.isArray(items)) {
      seen.pendingOnboarding = items.map((item) => String(item?.type));
    }
  }
  return seen;
}

function record(
  g: GlobalArgs,
  fields:
    & Pick<Instance, "containerId" | "state" | "action" | "nexusReady">
    & Partial<Instance>,
): Instance {
  return {
    runtime: g.runtime,
    containerName: g.containerName,
    image: g.image,
    volume: g.volume,
    url: nexusUrl(g),
    adminUsername: g.adminUsername,
    anonymousAccess: null,
    bootstrapped: false,
    pendingOnboarding: null,
    drift: null,
    ...fields,
    checkedAt: new Date().toISOString(),
  };
}

interface CheckContext {
  globalArgs: unknown;
}

/** True when any string in `v` is still a `${{ ... }}` expression. */
function unresolved(v: unknown): boolean {
  if (typeof v === "string") return v.includes("${{");
  if (Array.isArray(v)) return v.some(unresolved);
  if (typeof v === "object" && v !== null) {
    return Object.values(v).some(unresolved);
  }
  return false;
}

/**
 * Runs a check on the arguments with their defaults applied: `swamp model
 * validate` hands checks the arguments as written, without defaults.
 */
function withArgs(
  check: (g: GlobalArgs) => Promise<CheckResult>,
): (ctx: CheckContext) => Promise<CheckResult> {
  return (ctx) => {
    // An argument swamp has not resolved yet (validate leaves data.latest()
    // expressions as written) cannot be judged; method runs check it.
    if (unresolved(ctx.globalArgs)) return Promise.resolve({ pass: true });
    const parsed = GlobalArgsSchema.safeParse(ctx.globalArgs);
    return parsed.success ? check(parsed.data) : Promise.resolve({
      pass: false,
      errors: parsed.error.issues.map((i) =>
        `${i.path.join(".")}: ${i.message}`
      ),
    });
  };
}

/** The `@taylor/nexus/instance` swamp model type. */
export const model = {
  type: "@taylor/nexus/instance",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.11.2",
      description:
        "Add runtime (docker or Apple's container) and memory; rename dockerPath to runtimePath",
      upgradeAttributes: (old: Record<string, unknown>) => {
        const { dockerPath, ...rest } = old;
        return dockerPath && dockerPath !== "docker"
          ? { ...rest, runtimePath: dockerPath }
          : rest;
      },
    },
    {
      toVersion: "2026.10.11.3",
      description:
        "Add ports and properties; both default to empty, which keeps the old behaviour",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.14.1",
      description: "Declares the license in the manifest; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    instance: {
      description: "The Nexus container and where to reach it",
      schema: InstanceSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  checks: {
    "runtime-ready": {
      description: "The container runtime CLI is installed and running",
      labels: ["live"],
      execute: withArgs((g) => checkRuntimeReady(g, cliFor(g))),
    },
    "existing-container-is-nexus": {
      description:
        "A container that already has containerName runs a Nexus image, so it is safe to start, stop or delete",
      labels: ["live"],
      execute: withArgs((g) => checkExistingIsNexus(g, cliFor(g))),
    },
    "existing-container-matches": {
      description:
        "An existing Nexus container was created with this image and port, so start does not silently ignore a change",
      labels: ["live"],
      appliesTo: ["start"],
      execute: withArgs((g) => checkExistingMatches(g, cliFor(g))),
    },
    "port-available": {
      description:
        "The host port is free, unless the Nexus container already holds it",
      labels: ["live"],
      appliesTo: ["start"],
      execute: withArgs((g) => checkPortAvailable(g, cliFor(g))),
    },
    "memory-sufficient": {
      description: `The memory limit, if any, is at least ${MIN_MEMORY_MIB}m`,
      labels: ["policy"],
      appliesTo: ["start"],
      execute: withArgs((g) => Promise.resolve(checkMemory(g))),
    },
  },
  methods: {
    start: {
      description:
        "Create the Nexus container (or start a stopped one), wait until Nexus is ready, and complete onboarding",
      arguments: z.object({
        timeoutSeconds: z.number().int().positive().default(300).describe(
          "How long to wait for Nexus to become ready; first boot takes a few minutes",
        ),
      }),
      execute: async (
        args: {
          timeoutSeconds: number;
          _cli?: Cli;
          _probe?: Probe;
          _api?: Api;
          _intervalMs?: number;
        },
        context: Context,
      ) => {
        const g = context.globalArgs;
        const cli = args._cli ?? cliFor(g);
        const url = nexusUrl(g);

        let action: Instance["action"];
        let current = await inspect(g, cli);
        if (!current) {
          context.logger.info("Creating {name} from {image} with {runtime}", {
            name: g.containerName,
            image: g.image,
            runtime: g.runtime,
          });
          if (g.runtime === "container" || propertiesContent(g)) {
            check(await cli(prepareArgs(g)), `Preparing volume ${g.volume}`);
          }
          check(await cli(runArgs(g)), `${g.runtime} run ${g.image}`);
          current = await inspect(g, cli);
          if (!current) {
            throw new Error(`${g.containerName} vanished right after creation`);
          }
          action = "created";
        } else if (!current.running) {
          context.logger.info("Starting {name}", { name: g.containerName });
          if (propertiesContent(g)) {
            check(await cli(prepareArgs(g)), `Preparing volume ${g.volume}`);
          }
          check(
            await cli(["start", g.containerName]),
            `${g.runtime} start ${g.containerName}`,
          );
          action = "started";
        } else if (await propertiesDiffer(g, cli)) {
          context.logger.info(
            "Rewriting nexus.properties and restarting {name}",
            { name: g.containerName },
          );
          check(
            await cli([
              "exec",
              g.containerName,
              "sh",
              "-c",
              WRITE_PROPERTIES,
              "sh",
              propertiesContent(g),
            ]),
            "Writing nexus.properties",
          );
          check(
            await cli(["stop", "--time", "120", g.containerName]),
            `${g.runtime} stop ${g.containerName}`,
          );
          check(
            await cli(["start", g.containerName]),
            `${g.runtime} start ${g.containerName}`,
          );
          action = "restarted";
        } else {
          action = "unchanged";
        }

        // Docker's restart policy hides a crash, so a rising restart count
        // counts as dying too.
        const baseline = (await inspect(g, cli))?.restarts ?? 0;
        context.logger.info("Waiting for Nexus at {url}", { url });
        await waitUntilReady(
          args._probe ?? statusProbe,
          url,
          args.timeoutSeconds * 1000,
          args._intervalMs,
          async () => {
            const now = await inspect(g, cli);
            return now?.running && now.restarts === baseline
              ? null
              : `${g.containerName} stopped while Nexus was starting; see \`${g.runtime} logs ${g.containerName}\``;
          },
        );
        const configured = await configure(
          g,
          args._api ?? apiClient(url),
          cli,
          context.logger,
        );
        context.logger.info(
          "Nexus is ready at {url}; sign in as {user} ({action})",
          { url, user: g.adminUsername, action },
        );

        const handle = await context.writeResource(
          "instance",
          "instance",
          record(g, {
            containerId: current.id,
            state: "running",
            action,
            nexusReady: true,
            anonymousAccess: g.anonymousAccess,
            drift: [],
            ...configured,
          }),
        );
        return { dataHandles: [handle] };
      },
    },
    stop: {
      description: "Stop the Nexus container, keeping it and its data",
      arguments: z.object({}),
      execute: async (args: { _cli?: Cli }, context: Context) => {
        const g = context.globalArgs;
        const cli = args._cli ?? cliFor(g);
        const current = await inspect(g, cli);
        if (!current) {
          throw new Error(`No container named ${g.containerName}`);
        }
        if (current.running) {
          context.logger.info("Stopping {name}", { name: g.containerName });
          check(
            await cli(["stop", "--time", "120", g.containerName]),
            `${g.runtime} stop ${g.containerName}`,
          );
        }
        const handle = await context.writeResource(
          "instance",
          "instance",
          record(g, {
            containerId: current.id,
            state: "stopped",
            action: current.running ? "stopped" : "unchanged",
            nexusReady: false,
          }),
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description:
        "Remove the Nexus container; the data volume is kept unless removeVolume is set",
      arguments: z.object({
        removeVolume: z.boolean().default(false).describe(
          "Also delete the data volume, losing all repositories and settings",
        ),
      }),
      execute: async (
        args: { removeVolume: boolean; _cli?: Cli },
        context: Context,
      ) => {
        const g = context.globalArgs;
        const cli = args._cli ?? cliFor(g);
        const rt = RUNTIME_ARGS[g.runtime];
        const current = await inspect(g, cli);
        if (current) {
          context.logger.info("Removing {name}", { name: g.containerName });
          check(
            await cli(rt.remove(g.containerName)),
            `Removing ${g.containerName}`,
          );
        }
        if (args.removeVolume) {
          // Only delete a volume that exists; the runtimes word "missing"
          // differently.
          if ((await cli(["volume", "inspect", g.volume])).code === 0) {
            context.logger.warn("Removing volume {volume}", {
              volume: g.volume,
            });
            check(
              await cli(rt.removeVolume(g.volume)),
              `Removing volume ${g.volume}`,
            );
          }
        }
        const handle = await context.writeResource(
          "instance",
          "instance",
          record(g, {
            containerId: current?.id ?? "",
            state: "removed",
            action: current ? "removed" : "unchanged",
            nexusReady: false,
          }),
        );
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Read the container and Nexus as they are now and record any drift from the arguments, changing nothing",
      arguments: z.object({}),
      execute: async (
        args: { _cli?: Cli; _probe?: Probe; _api?: Api },
        context: Context,
      ) => {
        const g = context.globalArgs;
        const cli = args._cli ?? cliFor(g);
        const url = nexusUrl(g);
        const current = await inspect(g, cli);

        let data: Instance;
        if (!current) {
          data = record(g, {
            containerId: "",
            state: "absent",
            action: "synced",
            nexusReady: false,
            drift: [],
          });
        } else if (!current.running) {
          data = record(g, {
            containerId: current.id,
            state: "stopped",
            action: "synced",
            nexusReady: false,
            drift: containerDrift(g, current),
          });
        } else {
          const seen = await observe(
            g,
            args._api ?? apiClient(url),
            args._probe ?? statusProbe,
          );
          const properties = await propertiesDiffer(g, cli)
            ? [
              "nexus.properties differs from properties; start rewrites it and restarts Nexus",
            ]
            : [];
          data = record(g, {
            containerId: current.id,
            state: "running",
            action: "synced",
            ...seen,
            drift: [
              ...containerDrift(g, current),
              ...properties,
              ...seen.drift,
            ],
          });
        }

        context.logger.info("{name} is {state}; Nexus ready: {ready}", {
          name: g.containerName,
          state: data.state,
          ready: data.nexusReady,
        });
        for (const item of data.drift ?? []) {
          context.logger.warn("Drift: {item}", { item });
        }
        if (data.pendingOnboarding?.length) {
          context.logger.warn("Nexus still lists onboarding steps: {steps}", {
            steps: data.pendingOnboarding.join(", "),
          });
        }
        const handle = await context.writeResource(
          "instance",
          "instance",
          data,
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
