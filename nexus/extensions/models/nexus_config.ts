import { z } from "npm:zod@4";
import {
  type Api,
  apiClient,
  type ApiRequest,
  type ApiResponse,
  expectOk,
  type Probe,
  statusProbe,
} from "./_lib/nexus_api.ts";

// The configuration of a running Nexus Repository instance, declared as data:
// active security realms, blob stores, roles, users and repositories (apt,
// docker, npm, pypi and raw; hosted, proxy and group). `apply` creates and
// updates whatever differs from the declaration, in dependency order, and
// with `prune` deletes what is not declared. `sync` computes the same plan
// without carrying it out, so it doubles as drift detection.
//
// Recorded data names what changed, never the values: Nexus returns some
// secrets (an apt signing key) in plain text.

const ID = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;
const BUILTIN_USERS = ["admin", "anonymous"];
const FORMATS = ["apt", "docker", "npm", "pypi", "raw"] as const;
const TYPES = ["hosted", "proxy", "group"] as const;
const KINDS = ["realms", "blobStore", "role", "user", "repository"] as const;
type Kind = typeof KINDS[number];

const secret = (what: string) =>
  z.string().min(1).meta({ sensitive: true }).describe(
    `${what}; use a vault expression`,
  );

const BlobStoreSchema = z.discriminatedUnion("type", [
  z.object({
    name: z.string().regex(ID),
    type: z.literal("file"),
    path: z.string().min(1).optional().describe(
      "Directory under the data directory's blobs/; defaults to the name",
    ),
  }),
  z.object({
    name: z.string().regex(ID),
    type: z.literal("s3"),
    bucket: z.string().min(1),
    region: z.string().min(1),
    prefix: z.string().default(""),
    expirationDays: z.number().int().default(3).describe(
      "Days before deleted blobs are removed from the bucket",
    ),
    endpoint: z.string().optional().describe("S3-compatible endpoint URL"),
    forcePathStyle: z.boolean().default(false),
  }),
]);
type BlobStore = z.infer<typeof BlobStoreSchema>;

const RoleSchema = z.object({
  id: z.string().regex(ID),
  name: z.string().optional().describe("Defaults to the id"),
  description: z.string().default(""),
  privileges: z.array(z.string()).default([]),
  roles: z.array(z.string()).default([]).describe("Roles this role contains"),
});
type Role = z.infer<typeof RoleSchema>;

const UserSchema = z.object({
  userId: z.string().regex(ID),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  emailAddress: z.string().min(3),
  password: z.string().min(8).meta({ sensitive: true }).describe(
    "Nexus requires at least 8 characters; use a vault expression",
  ),
  status: z.enum(["active", "disabled"]).default("active"),
  roles: z.array(z.string()).min(1),
});
type User = z.infer<typeof UserSchema>;

const RepositorySchema = z.object({
  name: z.string().regex(ID),
  format: z.enum(FORMATS),
  type: z.enum(TYPES),
  online: z.boolean().default(true),
  blobStore: z.string().default("default"),
  strictContentTypeValidation: z.boolean().optional().describe(
    "Defaults to true for hosted and group, false for proxy",
  ),
  writePolicy: z.enum(["allow", "allow_once", "deny"]).default("allow")
    .describe("Hosted only"),
  cleanupPolicies: z.array(z.string()).default([]),
  // proxy
  remoteUrl: z.string().url().optional().describe("Proxy only; required"),
  contentMaxAge: z.number().int().default(1440),
  metadataMaxAge: z.number().int().default(1440),
  negativeCache: z.object({
    enabled: z.boolean().default(true),
    timeToLive: z.number().int().default(1440),
  }).default({ enabled: true, timeToLive: 1440 }),
  blocked: z.boolean().default(false),
  autoBlock: z.boolean().default(true),
  authentication: z.object({
    type: z.enum(["username", "ntlm"]).default("username"),
    username: z.string().min(1),
    password: secret("Password for the remote"),
    ntlmHost: z.string().optional(),
    ntlmDomain: z.string().optional(),
  }).optional().describe("Proxy only: credentials for the remote"),
  routingRule: z.string().optional(),
  // group
  members: z.array(z.string()).default([]).describe(
    "Group only; required, in resolution order",
  ),
  writableMember: z.string().optional().describe("Docker group only"),
  // apt
  distribution: z.string().optional().describe("Apt only; required"),
  flat: z.boolean().default(false).describe("Apt proxy only"),
  signing: z.object({
    keypair: secret("ASCII-armored PGP private key"),
    passphrase: secret("Key passphrase").optional(),
  }).optional().describe("Apt hosted only; required"),
  // docker
  docker: z.object({
    v1Enabled: z.boolean().default(false),
    forceBasicAuth: z.boolean().default(true),
    httpPort: z.number().int().min(1).max(65535).optional(),
    httpsPort: z.number().int().min(1).max(65535).optional(),
    subdomain: z.string().optional(),
  }).default({ v1Enabled: false, forceBasicAuth: true }),
  dockerProxy: z.object({
    indexType: z.enum(["HUB", "REGISTRY", "CUSTOM"]).default("REGISTRY"),
    indexUrl: z.string().url().optional(),
    cacheForeignLayers: z.boolean().optional(),
    foreignLayerUrlWhitelist: z.array(z.string()).optional(),
  }).default({ indexType: "REGISTRY" }),
  settings: z.record(z.string(), z.unknown()).default({}).describe(
    "Extra Nexus API fields, deep-merged into the request (e.g. { component: { proprietaryComponents: true } })",
  ),
}).superRefine((r, ctx) => {
  const need = (ok: unknown, msg: string) => {
    if (!ok) ctx.addIssue({ code: "custom", message: `${r.name}: ${msg}` });
  };
  need(
    !(r.format === "apt" && r.type === "group"),
    "apt has no group repositories",
  );
  need(r.type !== "proxy" || r.remoteUrl, "a proxy needs remoteUrl");
  need(r.type !== "group" || r.members.length, "a group needs members");
  need(r.format !== "apt" || r.distribution, "apt needs distribution");
  need(
    !(r.format === "apt" && r.type === "hosted") || r.signing,
    "apt hosted needs signing.keypair",
  );
  need(
    !r.writableMember || (r.format === "docker" && r.type === "group"),
    "writableMember is only for docker groups",
  );
});
type Repository = z.infer<typeof RepositorySchema>;

const GlobalArgsSchema = z.object({
  url: z.string().url().default("http://127.0.0.1:8081").describe(
    'Nexus base URL, e.g. ${{ data.latest("nexus", "instance").attributes.url }}',
  ),
  adminUsername: z.string().default("admin").describe(
    "Administrator to sign in as",
  ),
  adminPassword: z.string().min(1).meta({ sensitive: true }).describe(
    "Administrator password; use a vault expression",
  ),
  realms: z.array(z.string()).min(1).optional().describe(
    "Active security realms in order, e.g. [NexusAuthenticatingRealm, DockerToken]; omit to leave them alone",
  ),
  blobStores: z.array(BlobStoreSchema).default([]),
  roles: z.array(RoleSchema).default([]),
  users: z.array(UserSchema).default([]),
  repositories: z.array(RepositorySchema).default([]),
}).superRefine((g, ctx) => {
  const unique = (kind: string, names: string[]) => {
    const seen = new Set<string>();
    for (const n of names) {
      if (seen.has(n)) {
        ctx.addIssue({ code: "custom", message: `duplicate ${kind} ${n}` });
      }
      seen.add(n);
    }
  };
  unique("blob store", g.blobStores.map((b) => b.name));
  unique("role", g.roles.map((r) => r.id));
  unique("user", g.users.map((u) => u.userId));
  unique("repository", g.repositories.map((r) => r.name));
  unique(
    "docker connector port",
    g.repositories.flatMap((r) =>
      r.format === "docker"
        ? [r.docker.httpPort, r.docker.httpsPort].filter((x) => x !== undefined)
          .map(String)
        : []
    ),
  );
  if (g.realms && !g.realms.includes("NexusAuthenticatingRealm")) {
    ctx.addIssue({
      code: "custom",
      message:
        "realms must include NexusAuthenticatingRealm, or no local user (including the admin) can sign in",
    });
  }
  for (const u of g.users) {
    if ([...BUILTIN_USERS, g.adminUsername].includes(u.userId)) {
      ctx.addIssue({
        code: "custom",
        message:
          `user ${u.userId} is managed by @taylor/nexus/instance, not here`,
      });
    }
  }
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ChangeSchema = z.object({
  kind: z.enum(KINDS),
  name: z.string(),
  action: z.enum(["create", "update", "delete"]),
  fields: z.array(z.string()).describe(
    "Fields that differ (update); never their values",
  ),
});
/** One create, update or delete the plan calls for. */
export type Change = z.infer<typeof ChangeSchema>;

const ConfigSchema = z.object({
  url: z.string(),
  action: z.enum(["applied", "synced"]),
  prune: z.boolean(),
  inSync: z.boolean().describe(
    "True when Nexus matches the declaration (after apply: it converged)",
  ),
  changes: z.array(ChangeSchema).describe(
    "apply: what was changed; sync: what apply would change",
  ),
  undeclared: z.array(z.object({ kind: z.enum(KINDS), name: z.string() }))
    .describe("Present in Nexus but not declared; deleted by apply with prune"),
  conflicts: z.array(z.string()).describe(
    "Differences apply cannot fix by itself",
  ),
  unchanged: z.number().describe("Declared items that already match"),
  checkedAt: z.string(),
});
type Config = z.infer<typeof ConfigSchema>;

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

// ---------------------------------------------------------------- payloads

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `base` with `extra` merged in, recursively for objects. */
export function deepMerge(base: Json, extra: Json): Json {
  const out: Json = { ...base };
  for (const [k, v] of Object.entries(extra)) {
    out[k] = isObject(v) && isObject(out[k]) ? deepMerge(out[k] as Json, v) : v;
  }
  return out;
}

/** The Nexus API request body that creates or updates `r`. */
export function repositoryPayload(r: Repository): Json {
  const hosted = r.type === "hosted";
  const proxy = r.type === "proxy";
  const p: Json = {
    name: r.name,
    online: r.online,
    storage: {
      blobStoreName: r.blobStore,
      strictContentTypeValidation: r.strictContentTypeValidation ?? !proxy,
      ...(hosted ? { writePolicy: r.writePolicy.toUpperCase() } : {}),
    },
  };
  // Optional settings are sent as null when unset, so that removing one from
  // the declaration shows up as a difference and the update clears it.
  if (r.type !== "group") {
    p.cleanup = r.cleanupPolicies.length
      ? { policyNames: r.cleanupPolicies }
      : null;
  }
  if (proxy) {
    p.proxy = {
      remoteUrl: r.remoteUrl,
      contentMaxAge: r.contentMaxAge,
      metadataMaxAge: r.metadataMaxAge,
    };
    p.negativeCache = { ...r.negativeCache };
    p.httpClient = {
      blocked: r.blocked,
      autoBlock: r.autoBlock,
      authentication: r.authentication ? { ...r.authentication } : null,
    };
    p.routingRule = r.routingRule ?? null;
  }
  if (r.type === "group") {
    p.group = {
      memberNames: r.members,
      ...(r.writableMember ? { writableMember: r.writableMember } : {}),
    };
  }
  if (r.format === "apt") {
    p.apt = {
      distribution: r.distribution,
      ...(proxy ? { flat: r.flat } : {}),
    };
    if (hosted) p.aptSigning = { ...r.signing };
  }
  if (r.format === "docker") {
    p.docker = {
      v1Enabled: r.docker.v1Enabled,
      forceBasicAuth: r.docker.forceBasicAuth,
      // Sent as null when unset so that removing a connector port applies.
      httpPort: r.docker.httpPort ?? null,
      httpsPort: r.docker.httpsPort ?? null,
      subdomain: r.docker.subdomain ?? null,
    };
    if (proxy) p.dockerProxy = { ...r.dockerProxy };
  }
  return deepMerge(p, r.settings);
}

/** Request fields that Nexus reports back under another name. */
const RESPONSE_PATH: Record<string, string> = {
  routingRule: "routingRuleName",
};
/** Secret request fields: never compared, since Nexus does not return them. */
const SECRET_PATHS = [
  "httpClient.authentication.password",
  "aptSigning.keypair",
  "aptSigning.passphrase",
];
/** Values Nexus normalises, compared without regard to case. */
const CASELESS_PATHS = ["storage.writePolicy", "dockerProxy.indexType"];

/** Leaf paths of `obj` ("storage.blobStoreName"); arrays are leaves. */
export function leaves(obj: Json, prefix = ""): [string, unknown][] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const path = prefix ? `${prefix}.${k}` : k;
    return isObject(v) ? leaves(v, path) : [[path, v] as [string, unknown]];
  });
}

function at(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (o, k) => (isObject(o) ? o[k] : undefined),
    obj,
  );
}

function same(path: string, want: unknown, have: unknown): boolean {
  if (want === undefined) return true;
  if (CASELESS_PATHS.includes(path) && typeof want === "string") {
    return typeof have === "string" &&
      want.toUpperCase() === have.toUpperCase();
  }
  return JSON.stringify(want) === JSON.stringify(have ?? null);
}

/** Fields of `desired` that `current` (a Nexus GET) does not match. */
export function differences(desired: Json, current: Json): string[] {
  return leaves(desired)
    .filter(([path]) => !SECRET_PATHS.includes(path))
    .filter(([path, want]) =>
      !same(path, want, at(current, RESPONSE_PATH[path] ?? path))
    )
    .map(([path]) => path);
}

/** The Nexus API request body that creates or updates a blob store. */
export function blobStorePayload(b: BlobStore): Json {
  if (b.type === "file") return { name: b.name, path: b.path ?? b.name };
  return {
    name: b.name,
    bucketConfiguration: {
      bucket: {
        region: b.region,
        name: b.bucket,
        prefix: b.prefix,
        expiration: b.expirationDays,
      },
      ...(b.endpoint
        ? {
          advancedBucketConnection: {
            endpoint: b.endpoint,
            forcePathStyle: b.forcePathStyle,
          },
        }
        : {}),
    },
  };
}

/** The Nexus API request body for a role. */
export function rolePayload(r: Role): Json {
  return {
    id: r.id,
    name: r.name ?? r.id,
    description: r.description,
    privileges: r.privileges,
    roles: r.roles,
  };
}

const sorted = (xs: unknown) =>
  Array.isArray(xs) ? [...xs].map(String).sort() : [];

/**
 * Orders items so each comes after the declared items it references (roles
 * inside roles, groups inside groups). Returns null on a cycle.
 */
export function dependencyOrder<T>(
  items: T[],
  name: (t: T) => string,
  refs: (t: T) => string[],
): T[] | null {
  const byName = new Map(items.map((t) => [name(t), t]));
  const done = new Set<string>();
  const visiting = new Set<string>();
  const out: T[] = [];
  const visit = (t: T): boolean => {
    const n = name(t);
    if (done.has(n)) return true;
    if (visiting.has(n)) return false;
    visiting.add(n);
    for (const r of refs(t)) {
      const dep = byName.get(r);
      if (dep && !visit(dep)) return false;
    }
    visiting.delete(n);
    done.add(n);
    out.push(t);
    return true;
  };
  return items.every(visit) ? out : null;
}

// ------------------------------------------------------------------- plan

/** A planned change and how to carry it out. */
export interface Step {
  change: Change;
  run: () => Promise<void>;
}

/** What `apply` would do to make Nexus match the declaration. */
export interface Plan {
  steps: Step[];
  undeclared: { kind: Kind; name: string }[];
  conflicts: string[];
  unchanged: number;
}

/** Calls the API as the configured administrator. */
function adminApi(g: GlobalArgs, api: Api) {
  const call = (
    method: ApiRequest["method"],
    path: string,
    body?: { json?: unknown; text?: string },
  ) =>
    api({
      method,
      path,
      user: g.adminUsername,
      password: g.adminPassword,
      ...body,
    });
  const read = async (path: string, what: string) =>
    JSON.parse(expectOk(await call("GET", path), what).body);
  const write = async (
    method: ApiRequest["method"],
    path: string,
    what: string,
    body?: { json?: unknown; text?: string },
  ) => {
    expectOk(await call(method, path, body), what);
  };
  return { call, read, write };
}

/** True when Nexus accepts the user's password (403: signed in, no rights). */
async function passwordWorks(api: Api, user: User): Promise<boolean> {
  const r = await api({
    method: "GET",
    path: "/v1/security/realms/active",
    user: user.userId,
    password: user.password,
  });
  if (r.status === 401) return false;
  if (r.status === 200 || r.status === 403) return true;
  expectOk(r, `Checking ${user.userId}'s password`);
  return true;
}

/**
 * Compares the declaration with Nexus and returns the steps that would make
 * them match, in dependency order: realms, blob stores, roles, users, then
 * repositories (groups after their members). With `prune`, deletions of
 * undeclared items follow in reverse order; without it they are listed as
 * undeclared. Reads only; nothing changes until a step runs.
 */
export async function plan(
  g: GlobalArgs,
  api: Api,
  prune: boolean,
): Promise<Plan> {
  const { read, write } = adminApi(g, api);
  const steps: Step[] = [];
  const deletions: Step[] = [];
  const undeclared: Plan["undeclared"] = [];
  const conflicts: string[] = [];
  let unchanged = 0;
  const step = (
    change: Omit<Change, "fields"> & { fields?: string[] },
    run: () => Promise<void>,
  ) => ({ change: { fields: [], ...change }, run });
  const remove = (kind: Kind, name: string, path: string) => {
    if (prune) {
      deletions.push(step(
        { kind, name, action: "delete" },
        () => write("DELETE", path, `Deleting ${kind} ${name}`),
      ));
    } else {
      undeclared.push({ kind, name });
    }
  };

  // Realms
  if (g.realms) {
    const active = await read("/v1/security/realms/active", "Reading realms");
    if (JSON.stringify(active) === JSON.stringify(g.realms)) unchanged++;
    else {
      steps.push(step(
        { kind: "realms", name: "active", action: "update", fields: ["order"] },
        () =>
          write("PUT", "/v1/security/realms/active", "Setting realms", {
            json: g.realms,
          }),
      ));
    }
  }

  // Repositories are read first: blob store pruning needs to know what is
  // still in use once the plan has run.
  const repos = await read("/v1/repositories", "Listing repositories") as {
    name: string;
    format: string;
    type: string;
  }[];
  const repoByName = new Map(repos.map((r) => [r.name, r]));
  const declaredRepos = new Set(g.repositories.map((r) => r.name));

  // Blob stores
  const stores = await read("/v1/blobstores", "Listing blob stores") as {
    name: string;
    type: string;
  }[];
  const storeByName = new Map(stores.map((s) => [s.name, s]));
  for (const b of g.blobStores) {
    const have = storeByName.get(b.name);
    const payload = blobStorePayload(b);
    const path = `/v1/blobstores/${b.type}`;
    if (!have) {
      steps.push(step(
        { kind: "blobStore", name: b.name, action: "create" },
        () =>
          write("POST", path, `Creating blob store ${b.name}`, {
            json: payload,
          }),
      ));
      continue;
    }
    if (have.type.toLowerCase() !== b.type) {
      conflicts.push(
        `blob store ${b.name} is ${have.type}, declared ${b.type}; delete it in Nexus to recreate it`,
      );
      continue;
    }
    const current = await read(
      `${path}/${encodeURIComponent(b.name)}`,
      `Reading blob store ${b.name}`,
    );
    const { name: _name, ...settings } = payload;
    const fields = differences(settings, current);
    if (!fields.length) unchanged++;
    else {
      steps.push(step(
        { kind: "blobStore", name: b.name, action: "update", fields },
        () =>
          write(
            "PUT",
            `${path}/${encodeURIComponent(b.name)}`,
            `Updating blob store ${b.name}`,
            { json: payload },
          ),
      ));
    }
  }

  // Roles
  const roles = await read("/v1/security/roles", "Listing roles") as Json[];
  const roleById = new Map(roles.map((r) => [String(r.id), r]));
  const roleOrder = dependencyOrder(g.roles, (r) => r.id, (r) => r.roles);
  if (!roleOrder) conflicts.push("roles contain each other in a cycle");
  for (const r of roleOrder ?? []) {
    const have = roleById.get(r.id);
    const payload = rolePayload(r);
    if (!have) {
      steps.push(step(
        { kind: "role", name: r.id, action: "create" },
        () =>
          write("POST", "/v1/security/roles", `Creating role ${r.id}`, {
            json: payload,
          }),
      ));
      continue;
    }
    if (have.readOnly === true) {
      conflicts.push(`role ${r.id} is built into Nexus and read-only`);
      continue;
    }
    const fields = ["name", "description"].filter((f) =>
      payload[f] !== have[f]
    );
    for (const f of ["privileges", "roles"]) {
      if (
        JSON.stringify(sorted(payload[f])) !== JSON.stringify(sorted(have[f]))
      ) fields.push(f);
    }
    if (!fields.length) unchanged++;
    else {
      steps.push(step(
        { kind: "role", name: r.id, action: "update", fields },
        () =>
          write(
            "PUT",
            `/v1/security/roles/${encodeURIComponent(r.id)}`,
            `Updating role ${r.id}`,
            { json: payload },
          ),
      ));
    }
  }

  // Users
  const users = await read(
    "/v1/security/users?source=default",
    "Listing users",
  ) as Json[];
  const userById = new Map(users.map((u) => [String(u.userId), u]));
  for (const u of g.users) {
    const have = userById.get(u.userId);
    const fields: Json = {
      firstName: u.firstName,
      lastName: u.lastName,
      emailAddress: u.emailAddress,
      status: u.status,
      roles: u.roles,
    };
    if (!have) {
      steps.push(step(
        { kind: "user", name: u.userId, action: "create" },
        () =>
          write("POST", "/v1/security/users", `Creating user ${u.userId}`, {
            json: { userId: u.userId, password: u.password, ...fields },
          }),
      ));
      continue;
    }
    const differ = ["firstName", "lastName", "emailAddress", "status"].filter(
      (f) => fields[f] !== have[f],
    );
    if (
      JSON.stringify(sorted(fields.roles)) !==
        JSON.stringify(sorted(have.roles))
    ) differ.push("roles");
    const passwordStale = u.status === "active" &&
      !(await passwordWorks(api, u));
    if (!differ.length && !passwordStale) {
      unchanged++;
      continue;
    }
    steps.push(step(
      {
        kind: "user",
        name: u.userId,
        action: "update",
        fields: [...differ, ...(passwordStale ? ["password"] : [])],
      },
      async () => {
        const id = encodeURIComponent(u.userId);
        if (differ.length) {
          await write(
            "PUT",
            `/v1/security/users/${id}`,
            `Updating user ${u.userId}`,
            { json: { ...have, ...fields } },
          );
        }
        if (passwordStale) {
          await write(
            "PUT",
            `/v1/security/users/${id}/change-password`,
            `Setting ${u.userId}'s password`,
            { text: u.password },
          );
        }
      },
    ));
  }

  // Connector ports held by undeclared docker repositories: with prune they
  // are deleted before anything is created, otherwise the port is taken.
  const portHolder = new Map<number, string>();
  for (const r of repos) {
    if (r.format !== "docker" || declaredRepos.has(r.name)) continue;
    const d = await read(
      `/v1/repositories/docker/${r.type}/${encodeURIComponent(r.name)}`,
      `Reading repository ${r.name}`,
    );
    for (const port of [d.docker?.httpPort, d.docker?.httpsPort]) {
      if (typeof port === "number") portHolder.set(port, r.name);
    }
  }
  for (const r of g.repositories) {
    const ports = r.format === "docker"
      ? [r.docker.httpPort, r.docker.httpsPort]
      : [];
    for (const port of ports) {
      const holder = port === undefined ? undefined : portHolder.get(port);
      if (holder && !prune) {
        conflicts.push(
          `repository ${r.name} needs port ${port}, which undeclared repository ${holder} uses; apply with prune to delete ${holder} first`,
        );
      }
    }
    // Prune would delete an undeclared member out from under its group.
    for (const m of prune ? r.members : []) {
      if (repoByName.has(m) && !declaredRepos.has(m)) {
        conflicts.push(
          `repository ${r.name} has member ${m}, which is not declared, so prune would delete it; declare ${m} too`,
        );
      }
    }
  }

  // Repositories: members before the groups that contain them.
  const repoOrder = dependencyOrder(
    g.repositories,
    (r) => r.name,
    (r) => r.members,
  );
  if (!repoOrder) {
    conflicts.push("repository groups contain each other in a cycle");
  }
  for (const r of repoOrder ?? []) {
    const have = repoByName.get(r.name);
    const payload = repositoryPayload(r);
    const path = `/v1/repositories/${r.format}/${r.type}`;
    if (!have) {
      steps.push(step(
        { kind: "repository", name: r.name, action: "create" },
        () =>
          write("POST", path, `Creating repository ${r.name}`, {
            json: payload,
          }),
      ));
      continue;
    }
    if (have.format !== r.format || have.type !== r.type) {
      conflicts.push(
        `repository ${r.name} is ${have.format} ${have.type}, declared ${r.format} ${r.type}; delete it in Nexus to recreate it (its content is lost)`,
      );
      continue;
    }
    const current = await read(
      `${path}/${encodeURIComponent(r.name)}`,
      `Reading repository ${r.name}`,
    );
    const fields = differences(payload, current);
    if (!fields.length) unchanged++;
    else {
      steps.push(step(
        { kind: "repository", name: r.name, action: "update", fields },
        () =>
          write(
            "PUT",
            `${path}/${encodeURIComponent(r.name)}`,
            `Updating repository ${r.name}`,
            { json: payload },
          ),
      ));
    }
  }

  // Undeclared items, deleted in reverse dependency order: groups before
  // their members, repositories before blob stores, users before roles.
  const undeclaredRepos = repos.filter((r) => !declaredRepos.has(r.name))
    .sort((a, b) => Number(b.type === "group") - Number(a.type === "group"));
  for (const r of undeclaredRepos) {
    remove(
      "repository",
      r.name,
      `/v1/repositories/${encodeURIComponent(r.name)}`,
    );
  }
  // Repository deletions run before any repository is created or updated,
  // so a name or connector port they free can be reused in the same apply.
  const repoDeletions = deletions.splice(0);
  const protectedUsers = [...BUILTIN_USERS, g.adminUsername];
  const declaredUsers = new Set(g.users.map((u) => u.userId));
  for (const u of users) {
    const id = String(u.userId);
    if (protectedUsers.includes(id) || declaredUsers.has(id)) continue;
    remove("user", id, `/v1/security/users/${encodeURIComponent(id)}`);
  }
  const declaredRoles = new Set(g.roles.map((r) => r.id));
  for (const r of roles) {
    const id = String(r.id);
    if (r.readOnly === true || r.source !== "default") continue;
    if (declaredRoles.has(id)) continue;
    remove("role", id, `/v1/security/roles/${encodeURIComponent(id)}`);
  }
  // A blob store still used by a repository that stays cannot be deleted.
  const inUse = new Set(
    g.repositories.map((r) => r.blobStore),
  );
  const declaredStores = new Set(g.blobStores.map((b) => b.name));
  for (const s of stores) {
    if (declaredStores.has(s.name)) continue;
    if (inUse.has(s.name)) {
      // Declared repositories still use it, so even prune keeps it.
      undeclared.push({ kind: "blobStore", name: s.name });
      continue;
    }
    remove("blobStore", s.name, `/v1/blobstores/${encodeURIComponent(s.name)}`);
  }
  // Undeclared repositories on a blob store being pruned are deleted first,
  // so by the time the blob store's deletion runs it is free.

  const firstRepo = steps.findIndex((s) => s.change.kind === "repository");
  const at = firstRepo === -1 ? steps.length : firstRepo;
  return {
    steps: [
      ...steps.slice(0, at),
      ...repoDeletions,
      ...steps.slice(at),
      ...deletions,
    ],
    undeclared,
    conflicts,
    unchanged,
  };
}

// ----------------------------------------------------------------- checks

/** Pre-flight: Nexus answers at `url`. */
export async function checkReachable(
  g: GlobalArgs,
  probe: Probe = statusProbe,
): Promise<CheckResult> {
  return await probe(g.url) ? { pass: true } : {
    pass: false,
    errors: [
      `Nexus is not answering at ${g.url}; run start on the instance first`,
    ],
  };
}

/** Pre-flight: the administrator credentials work and have admin rights. */
export async function checkAdmin(
  g: GlobalArgs,
  api: Api,
): Promise<CheckResult> {
  let r: ApiResponse;
  try {
    r = await adminApi(g, api).call("GET", "/v1/security/realms/active");
  } catch (err) {
    return { pass: false, errors: [(err as Error).message] };
  }
  if (r.status === 200) return { pass: true };
  return {
    pass: false,
    errors: [
      r.status === 401
        ? `Nexus rejects ${g.adminUsername}'s password`
        : r.status === 403
        ? `${g.adminUsername} is not an administrator`
        : `Signing in as ${g.adminUsername} failed: HTTP ${r.status}`,
    ],
  };
}

/**
 * Pre-flight: everything the declaration refers to exists in Nexus or is
 * declared: realms, privileges, roles, blob stores, group members. Catches
 * typos before apply changes anything, rather than partway through.
 */
export async function checkReferences(
  g: GlobalArgs,
  api: Api,
): Promise<CheckResult> {
  const { read } = adminApi(g, api);
  const names = async (path: string, key: string) =>
    new Set(
      (await read(path, `Reading ${path}`) as Json[]).map((x) =>
        String(x[key])
      ),
    );
  const errors: string[] = [];
  try {
    if (g.realms) {
      const available = await names("/v1/security/realms/available", "id");
      for (const r of g.realms) {
        if (!available.has(r)) errors.push(`realm ${r} is not available`);
      }
    }
    const privileges = await names("/v1/security/privileges", "name");
    const roles = new Set([
      ...await names("/v1/security/roles", "id"),
      ...g.roles.map((r) => r.id),
    ]);
    for (const r of g.roles) {
      for (const p of r.privileges) {
        if (!privileges.has(p)) {
          errors.push(`role ${r.id}: privilege ${p} does not exist`);
        }
      }
      for (const x of r.roles) {
        if (!roles.has(x)) {
          errors.push(`role ${r.id}: role ${x} does not exist`);
        }
      }
    }
    for (const u of g.users) {
      for (const x of u.roles) {
        if (!roles.has(x)) {
          errors.push(`user ${u.userId}: role ${x} does not exist`);
        }
      }
    }
    const stores = new Set([
      ...await names("/v1/blobstores", "name"),
      ...g.blobStores.map((b) => b.name),
    ]);
    const repos = new Set([
      ...await names("/v1/repositories", "name"),
      ...g.repositories.map((r) => r.name),
    ]);
    const format = new Map(g.repositories.map((r) => [r.name, r.format]));
    for (const r of g.repositories) {
      if (!stores.has(r.blobStore)) {
        errors.push(
          `repository ${r.name}: blob store ${r.blobStore} does not exist`,
        );
      }
      for (const m of r.members) {
        if (!repos.has(m)) {
          errors.push(`repository ${r.name}: member ${m} does not exist`);
        } else if (format.has(m) && format.get(m) !== r.format) {
          errors.push(
            `repository ${r.name}: member ${m} is ${
              format.get(m)
            }, not ${r.format}`,
          );
        }
      }
      if (r.writableMember && !r.members.includes(r.writableMember)) {
        errors.push(
          `repository ${r.name}: writableMember ${r.writableMember} is not a member`,
        );
      }
    }
  } catch (err) {
    return { pass: false, errors: [(err as Error).message] };
  }
  return errors.length ? { pass: false, errors } : { pass: true };
}

// ------------------------------------------------------------------ model

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

function record(
  g: GlobalArgs,
  action: Config["action"],
  prune: boolean,
  p: Plan,
  changes: Change[],
  inSync: boolean,
): Config {
  return {
    url: g.url,
    action,
    prune,
    inSync,
    changes,
    undeclared: p.undeclared,
    conflicts: p.conflicts,
    unchanged: p.unchanged,
    checkedAt: new Date().toISOString(),
  };
}

const describeChange = (c: Change) =>
  `${c.action} ${c.kind} ${c.name}${
    c.fields.length ? ` (${c.fields.join(", ")})` : ""
  }`;

/** The `@taylor/nexus/config` swamp model type. */
export const model = {
  type: "@taylor/nexus/config",
  version: "2026.10.14.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.14.1",
      description:
        "apply clears cleanup policies, routing rules and remote credentials removed from the declaration; no settings changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    config: {
      description: "What apply changed, or what sync found out of date",
      schema: ConfigSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  checks: {
    "nexus-reachable": {
      description: "Nexus answers at url",
      labels: ["live"],
      execute: withArgs((g) => checkReachable(g)),
    },
    "admin-signs-in": {
      description: "adminUsername and adminPassword work and have admin rights",
      labels: ["live"],
      execute: withArgs((g) => checkAdmin(g, apiClient(g.url))),
    },
    "references-resolve": {
      description:
        "Realms, privileges, roles, blob stores and group members the declaration refers to exist or are declared",
      labels: ["live"],
      appliesTo: ["apply"],
      execute: withArgs((g) => checkReferences(g, apiClient(g.url))),
    },
  },
  methods: {
    apply: {
      description:
        "Create and update realms, blob stores, roles, users and repositories to match the declaration; with prune, delete undeclared ones",
      arguments: z.object({
        prune: z.boolean().default(false).describe(
          "Also delete repositories, users, roles and blob stores that are not declared (repository content is lost)",
        ),
      }),
      execute: async (
        args: { prune: boolean; _api?: Api },
        context: Context,
      ) => {
        const g = context.globalArgs;
        const api = args._api ?? apiClient(g.url);
        const p = await plan(g, api, args.prune);
        if (p.conflicts.length) {
          throw new Error(
            `Cannot apply: ${p.conflicts.join("; ")}. Nothing was changed.`,
          );
        }
        for (const s of p.steps) {
          context.logger.info("Will {change}", {
            change: describeChange(s.change),
          });
        }
        for (const s of p.steps) {
          await s.run();
          context.logger.info("Done: {change}", {
            change: describeChange(s.change),
          });
        }
        for (const u of p.undeclared) {
          context.logger.warn(
            "Not declared (kept; use prune to delete): {kind} {name}",
            u,
          );
        }
        // Plan again: anything still differing means Nexus normalised a value
        // this model does not expect, so apply would never converge.
        const after = await plan(g, api, args.prune);
        const left = after.steps.map((s) => s.change);
        for (const c of left) {
          context.logger.warn("Still differs after apply: {change}", {
            change: describeChange(c),
          });
        }
        context.logger.info(
          "Applied {count} changes to {url}; {unchanged} already matched",
          { count: p.steps.length, url: g.url, unchanged: p.unchanged },
        );
        const handle = await context.writeResource(
          "config",
          "config",
          record(
            g,
            "applied",
            args.prune,
            { ...p, undeclared: after.undeclared, conflicts: after.conflicts },
            p.steps.map((s) => s.change),
            left.length === 0,
          ),
        );
        if (left.length) {
          throw new Error(
            `Nexus still differs after apply: ${
              left.map(describeChange).join("; ")
            }`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Compare Nexus with the declaration and record what apply would change, changing nothing",
      arguments: z.object({}),
      execute: async (args: { _api?: Api }, context: Context) => {
        const g = context.globalArgs;
        const p = await plan(g, args._api ?? apiClient(g.url), false);
        const changes = p.steps.map((s) => s.change);
        for (const c of changes) {
          context.logger.warn("Drift: would {change}", {
            change: describeChange(c),
          });
        }
        for (const c of p.conflicts) {
          context.logger.warn("Conflict: {c}", { c });
        }
        for (const u of p.undeclared) {
          context.logger.info("Not declared: {kind} {name}", u);
        }
        const inSync = !changes.length && !p.conflicts.length;
        context.logger.info("{url} is {state}", {
          url: g.url,
          state: inSync ? "in sync" : "out of sync",
        });
        const handle = await context.writeResource(
          "config",
          "config",
          record(g, "synced", false, p, changes, inSync),
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
