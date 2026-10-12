import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  type Change,
  checkAdmin,
  checkReferences,
  dependencyOrder,
  differences,
  model,
  plan,
  repositoryPayload,
} from "./nexus_config.ts";
import type { ApiRequest, ApiResponse } from "./_lib/nexus_api.ts";
import { errorText } from "./_lib/nexus_api.ts";

type Json = Record<string, unknown>;
type Ctx = Parameters<typeof model.methods.apply.execute>[1];

const PW = "Admin-Secret-1";

/** Global arguments with the admin password filled in. */
const ga = (extra: Json = {}) =>
  model.globalArguments.parse({ adminPassword: PW, ...extra });
const repo = (r: Json) => ga({ repositories: [r] }).repositories[0];

/**
 * An in-memory Nexus that keeps state across calls, answering the endpoints
 * the config model uses the way Nexus 3.96 does (upper-case writePolicy,
 * nulls for unset docker fields, secrets not returned).
 */
class FakeNexus {
  realms = ["NexusAuthenticatingRealm"];
  available = ["NexusAuthenticatingRealm", "DockerToken"];
  privileges = ["nx-all", "nx-search-read", "nx-healthcheck-read"];
  stores = new Map<string, Json>([["default", {
    type: "File",
    path: "default",
  }]]);
  roles = new Map<string, Json>([
    ["nx-admin", {
      id: "nx-admin",
      source: "default",
      name: "nx-admin",
      description: "Administrator Role",
      readOnly: true,
      privileges: ["nx-all"],
      roles: [],
    }],
    ["nx-anonymous", {
      id: "nx-anonymous",
      source: "default",
      name: "nx-anonymous",
      description: "Anonymous Role",
      readOnly: true,
      privileges: ["nx-search-read"],
      roles: [],
    }],
  ]);
  users = new Map<string, Json>([
    ["admin", {
      userId: "admin",
      firstName: "Administrator",
      lastName: "User",
      emailAddress: "admin@example.org",
      source: "default",
      status: "active",
      readOnly: false,
      roles: ["nx-admin"],
      externalRoles: [],
      password: PW,
    }],
    ["anonymous", {
      userId: "anonymous",
      firstName: "Anonymous",
      lastName: "User",
      emailAddress: "anonymous@example.org",
      source: "default",
      status: "active",
      readOnly: false,
      roles: ["nx-anonymous"],
      externalRoles: [],
      password: "x",
    }],
  ]);
  repos = new Map<string, Json>();
  calls: ApiRequest[] = [];

  api = (req: ApiRequest): Promise<ApiResponse> => {
    this.calls.push(req);
    return Promise.resolve(this.handle(req));
  };

  private ok(body?: unknown, status = 200): ApiResponse {
    return {
      status: body === undefined ? 204 : status,
      body: body === undefined ? "" : JSON.stringify(body),
    };
  }

  private handle(req: ApiRequest): ApiResponse {
    const user = this.users.get(req.user);
    if (!user || user.password !== req.password) {
      return { status: 401, body: "" };
    }
    const admin = (user.roles as string[]).includes("nx-admin");
    const [path, query] = req.path.split("?");
    const parts = path.split("/").filter(Boolean).map(decodeURIComponent);
    const key = `${req.method} /${parts.slice(0, 3).join("/")}`;
    if (key === "GET /v1/security/realms" && parts[3] === "active") {
      return admin ? this.ok(this.realms) : { status: 403, body: "" };
    }
    if (!admin) return { status: 403, body: "" };
    const json = req.json as Json;
    switch (`${req.method} ${parts.slice(0, 2).join("/")}`) {
      case "GET v1/security":
        if (parts[2] === "realms") {
          return this.ok(
            parts[3] === "available"
              ? this.available.map((id) => ({ id }))
              : this.realms,
          );
        }
        if (parts[2] === "privileges") {
          return this.ok(this.privileges.map((name) => ({ name })));
        }
        if (parts[2] === "roles") return this.ok([...this.roles.values()]);
        if (parts[2] === "users") {
          void query;
          return this.ok(
            [...this.users.values()].map(({ password: _p, ...u }) => u),
          );
        }
        break;
      case "PUT v1/security":
        if (parts[2] === "realms") {
          this.realms = req.json as string[];
          return this.ok();
        }
        if (parts[2] === "roles") {
          this.roles.set(parts[3], { ...this.roles.get(parts[3]), ...json });
          return this.ok();
        }
        if (parts[2] === "users" && parts[4] === "change-password") {
          this.users.get(parts[3])!.password = req.text;
          return this.ok();
        }
        if (parts[2] === "users") {
          this.users.set(parts[3], {
            ...json,
            password: this.users.get(parts[3])!.password,
          });
          return this.ok();
        }
        break;
      case "POST v1/security":
        if (parts[2] === "roles") {
          this.roles.set(String(json.id), {
            source: "default",
            readOnly: false,
            ...json,
          });
          return this.ok({});
        }
        if (parts[2] === "users") {
          this.users.set(String(json.userId), {
            source: "default",
            readOnly: false,
            externalRoles: [],
            ...json,
          });
          return this.ok({});
        }
        break;
      case "DELETE v1/security":
        (parts[2] === "roles" ? this.roles : this.users).delete(parts[3]);
        return this.ok();
      case "GET v1/blobstores":
        if (!parts[2]) {
          return this.ok(
            [...this.stores].map(([name, s]) => ({ name, type: s.type })),
          );
        }
        return this.stores.has(parts[3])
          ? this.ok({ softQuota: null, path: this.stores.get(parts[3])!.path })
          : { status: 404, body: "" };
      case "POST v1/blobstores":
        this.stores.set(String(json.name), {
          type: parts[2] === "file" ? "File" : "S3",
          path: json.path,
        });
        return this.ok();
      case "PUT v1/blobstores":
        this.stores.set(parts[3], {
          ...this.stores.get(parts[3]),
          path: json.path,
        });
        return this.ok();
      case "DELETE v1/blobstores":
        if (
          [...this.repos.values()].some((r) =>
            (r.storage as Json).blobStoreName === parts[2]
          )
        ) {
          return { status: 400, body: "in use" };
        }
        this.stores.delete(parts[2]);
        return this.ok();
      case "GET v1/repositories": {
        if (!parts[2]) {
          return this.ok(
            [...this.repos.values()].map((r) => ({
              name: r.name,
              format: r.format,
              type: r.type,
            })),
          );
        }
        const r = this.repos.get(parts[4]);
        if (!r || r.format !== parts[2] || r.type !== parts[3]) {
          return { status: 404, body: "" };
        }
        return this.ok(this.view(r));
      }
      case "POST v1/repositories":
        if (this.repos.has(String(json.name))) {
          return { status: 400, body: "exists" };
        }
        for (const port of this.ports(json)) {
          const holder = [...this.repos.values()].find((r) =>
            this.ports(r).includes(port)
          );
          if (holder) {
            return {
              status: 400,
              body:
                `Port must be unique (conflicts with repository '${holder.name}')`,
            };
          }
        }
        this.repos.set(String(json.name), {
          ...json,
          format: parts[2],
          type: parts[3],
        });
        return this.ok({}, 201);
      case "PUT v1/repositories":
        this.repos.set(parts[4], { ...json, format: parts[2], type: parts[3] });
        return this.ok();
      case "DELETE v1/repositories":
        this.repos.delete(parts[2]);
        return this.ok();
    }
    throw new Error(`fake Nexus has no ${req.method} ${req.path}`);
  }

  private ports(r: Json): number[] {
    const d = r.docker as Json | undefined;
    return [d?.httpPort, d?.httpsPort].filter((p): p is number =>
      typeof p === "number"
    );
  }

  /** A repository as Nexus reports it: secrets dropped, writePolicy upper-case, extra fields. */
  private view(r: Json): Json {
    const v = structuredClone(r) as Json;
    const storage = v.storage as Json;
    if (storage.writePolicy) {
      storage.writePolicy = String(storage.writePolicy).toUpperCase();
    }
    const auth = (v.httpClient as Json | undefined)?.authentication as
      | Json
      | undefined;
    if (auth) delete auth.password;
    if (v.aptSigning) delete (v.aptSigning as Json).passphrase;
    if (v.routingRule) {
      v.routingRuleName = v.routingRule;
      delete v.routingRule;
    }
    return {
      ...v,
      url: `http://nexus/repository/${v.name}`,
      cleanup: v.cleanup ?? null,
    };
  }
}

const RECIPE = {
  realms: ["NexusAuthenticatingRealm", "DockerToken"],
  roles: [{
    id: "engineering-read-only",
    privileges: ["nx-search-read", "nx-healthcheck-read"],
  }],
  users: [{
    userId: "chef",
    firstName: "Chef",
    lastName: "User",
    emailAddress: "chef@example.org",
    password: "superseekret",
    roles: ["engineering-read-only"],
  }],
  blobStores: [{ name: "fast", type: "file" }],
  repositories: [
    { name: "raw-hosted", format: "raw", type: "hosted", blobStore: "fast" },
    {
      name: "raw-group",
      format: "raw",
      type: "group",
      members: ["raw-hosted", "raw-proxy"],
    },
    {
      name: "raw-proxy",
      format: "raw",
      type: "proxy",
      remoteUrl: "https://releases.example.org",
      online: false,
    },
    {
      name: "apt-proxy",
      format: "apt",
      type: "proxy",
      remoteUrl: "http://archive.example.org/ubuntu/",
      distribution: "jammy",
    },
    {
      name: "docker-proxy",
      format: "docker",
      type: "proxy",
      remoteUrl: "https://registry-1.docker.io",
      docker: { v1Enabled: true, httpPort: 10080, httpsPort: 10443 },
      dockerProxy: { indexType: "HUB" },
    },
    {
      name: "npm-proxy",
      format: "npm",
      type: "proxy",
      remoteUrl: "https://registry.npmjs.org",
    },
    { name: "pypi-hosted", format: "pypi", type: "hosted" },
  ],
};

async function runMethod(
  method: "apply" | "sync",
  nexus: FakeNexus,
  globalArgs: Json,
  args: Json = {},
) {
  const test = createModelTestContext({
    globalArgs: ga(globalArgs),
    methodName: method,
  });
  const m = model.methods[method];
  await (m.execute as (a: unknown, c: Ctx) => Promise<unknown>)(
    { ...m.arguments.parse(args), _api: nexus.api },
    test.context as unknown as Ctx,
  );
  const r = test.getWrittenResources();
  return r[r.length - 1].data as {
    inSync: boolean;
    changes: Change[];
    undeclared: { kind: string; name: string }[];
    conflicts: string[];
    unchanged: number;
  };
}

const writes = (n: FakeNexus) => n.calls.filter((c) => c.method !== "GET");

// ------------------------------------------------------------ payloads

Deno.test("repositoryPayload: hosted defaults to strict validation and ALLOW", () => {
  assertEquals(
    repositoryPayload(repo({ name: "r", format: "raw", type: "hosted" })),
    {
      name: "r",
      online: true,
      storage: {
        blobStoreName: "default",
        strictContentTypeValidation: true,
        writePolicy: "ALLOW",
      },
    },
  );
});

Deno.test("repositoryPayload: proxy carries remote, caching and auth; not strict", () => {
  const p = repositoryPayload(repo({
    name: "p",
    format: "npm",
    type: "proxy",
    remoteUrl: "https://registry.npmjs.org",
    authentication: { username: "u", password: "remote-secret" },
    routingRule: "only-scoped",
  }));
  assertEquals((p.storage as Json).strictContentTypeValidation, false);
  assertEquals(p.proxy, {
    remoteUrl: "https://registry.npmjs.org",
    contentMaxAge: 1440,
    metadataMaxAge: 1440,
  });
  assertEquals(p.negativeCache, { enabled: true, timeToLive: 1440 });
  assertEquals(p.httpClient, {
    blocked: false,
    autoBlock: true,
    authentication: {
      type: "username",
      username: "u",
      password: "remote-secret",
    },
  });
  assertEquals(p.routingRule, "only-scoped");
});

Deno.test("repositoryPayload: docker sends unset connector ports as null", () => {
  const p = repositoryPayload(repo({
    name: "d",
    format: "docker",
    type: "proxy",
    remoteUrl: "https://registry-1.docker.io",
    docker: { httpPort: 10080 },
    dockerProxy: { indexType: "HUB" },
  }));
  assertEquals(p.docker, {
    v1Enabled: false,
    forceBasicAuth: true,
    httpPort: 10080,
    httpsPort: null,
    subdomain: null,
  });
  assertEquals(p.dockerProxy, { indexType: "HUB" });
});

Deno.test("repositoryPayload: apt proxy has flat, apt hosted has signing", () => {
  const proxy = repositoryPayload(
    repo({
      name: "a",
      format: "apt",
      type: "proxy",
      remoteUrl: "http://x.example.org/",
      distribution: "jammy",
    }),
  );
  assertEquals(proxy.apt, { distribution: "jammy", flat: false });
  const hosted = repositoryPayload(
    repo({
      name: "h",
      format: "apt",
      type: "hosted",
      distribution: "jammy",
      signing: { keypair: "KEY" },
    }),
  );
  assertEquals([hosted.apt, hosted.aptSigning], [{ distribution: "jammy" }, {
    keypair: "KEY",
  }]);
});

Deno.test("repositoryPayload: group lists members; settings deep-merge", () => {
  const p = repositoryPayload(repo({
    name: "g",
    format: "docker",
    type: "group",
    members: ["a", "b"],
    writableMember: "a",
    settings: {
      docker: { subdomain: "g" },
      component: { proprietaryComponents: true },
    },
  }));
  assertEquals(p.group, { memberNames: ["a", "b"], writableMember: "a" });
  assertEquals((p.docker as Json).subdomain, "g");
  assertEquals((p.docker as Json).forceBasicAuth, true);
  assertEquals(p.component, { proprietaryComponents: true });
});

Deno.test("differences: ignores case of writePolicy, secrets, and fields left unset", () => {
  const desired = {
    storage: { writePolicy: "ALLOW", blobStoreName: "default" },
    httpClient: { authentication: { username: "u", password: "secret" } },
    routingRule: "r",
  };
  const current = {
    storage: {
      writePolicy: "allow",
      blobStoreName: "default",
      strictContentTypeValidation: true,
    },
    httpClient: { authentication: { username: "u" } },
    routingRuleName: "r",
  };
  assertEquals(differences(desired, current), []);
  assertEquals(
    differences({ docker: { httpsPort: null }, online: true }, {
      docker: { httpsPort: 10443 },
      online: false,
    }),
    [
      "docker.httpsPort",
      "online",
    ],
  );
});

Deno.test("dependencyOrder puts references first and reports cycles", () => {
  const items = [{ n: "group", r: ["mid"] }, { n: "mid", r: ["leaf"] }, {
    n: "leaf",
    r: [],
  }];
  assertEquals(
    dependencyOrder(items, (i) => i.n, (i) => i.r)?.map((i) => i.n),
    ["leaf", "mid", "group"],
  );
  assertEquals(
    dependencyOrder(
      [{ n: "a", r: ["b"] }, { n: "b", r: ["a"] }],
      (i) => i.n,
      (i) => i.r,
    ),
    null,
  );
});

// ------------------------------------------------------------ schema

Deno.test("schema rejects incomplete or clashing declarations", () => {
  const issues = (extra: Json) => {
    const r = model.globalArguments.safeParse({ adminPassword: PW, ...extra });
    return r.success ? [] : r.error.issues.map((i) => i.message);
  };
  const repos = (...rs: Json[]) => ({ repositories: rs });
  assertEquals(issues(repos({ name: "p", format: "raw", type: "proxy" })), [
    "p: a proxy needs remoteUrl",
  ]);
  assertEquals(issues(repos({ name: "g", format: "npm", type: "group" })), [
    "g: a group needs members",
  ]);
  assertEquals(
    issues(
      repos({
        name: "a",
        format: "apt",
        type: "proxy",
        remoteUrl: "http://x.example.org/",
      }),
    ),
    ["a: apt needs distribution"],
  );
  assertEquals(
    issues(
      repos({
        name: "a",
        format: "apt",
        type: "hosted",
        distribution: "jammy",
      }),
    ),
    ["a: apt hosted needs signing.keypair"],
  );
  assertEquals(
    issues(
      repos({
        name: "a",
        format: "apt",
        type: "group",
        members: ["x"],
        distribution: "jammy",
      }),
    ),
    ["a: apt has no group repositories"],
  );
  assertEquals(
    issues(
      repos({ name: "x", format: "raw", type: "hosted" }, {
        name: "x",
        format: "npm",
        type: "hosted",
      }),
    ),
    ["duplicate repository x"],
  );
  assertEquals(
    issues(repos(
      {
        name: "d1",
        format: "docker",
        type: "hosted",
        docker: { httpPort: 10080 },
      },
      {
        name: "d2",
        format: "docker",
        type: "hosted",
        docker: { httpPort: 10080 },
      },
    )),
    ["duplicate docker connector port 10080"],
  );
  assertEquals(
    issues({
      users: [{
        userId: "admin",
        firstName: "A",
        lastName: "B",
        emailAddress: "a@example.org",
        password: "longenough",
        roles: ["nx-admin"],
      }],
    }),
    ["user admin is managed by @taylor/nexus/instance, not here"],
  );
  assertEquals(
    issues({ realms: ["DockerToken"] })[0].startsWith(
      "realms must include NexusAuthenticatingRealm",
    ),
    true,
  );
  assertEquals(
    issues({
      users: [{
        userId: "u",
        firstName: "A",
        lastName: "B",
        emailAddress: "a@example.org",
        password: "short",
        roles: ["x"],
      }],
    }).length,
    1,
  );
});

// ------------------------------------------------------------ plan/apply

Deno.test("apply builds the recipe on an empty Nexus in dependency order and converges", async () => {
  const nexus = new FakeNexus();
  const out = await runMethod("apply", nexus, RECIPE);
  assertEquals(out.inSync, true);
  const order = out.changes.map((c) => `${c.action} ${c.kind} ${c.name}`);
  assertEquals(order, [
    "update realms active",
    "create blobStore fast",
    "create role engineering-read-only",
    "create user chef",
    "create repository raw-hosted",
    "create repository raw-proxy",
    "create repository raw-group",
    "create repository apt-proxy",
    "create repository docker-proxy",
    "create repository npm-proxy",
    "create repository pypi-hosted",
  ]);
  assertEquals(nexus.realms, ["NexusAuthenticatingRealm", "DockerToken"]);
  assertEquals(nexus.repos.get("raw-proxy")!.online, false);
  assertEquals(nexus.users.get("chef")!.password, "superseekret");
});

Deno.test("apply is a no-op when Nexus already matches", async () => {
  const nexus = new FakeNexus();
  await runMethod("apply", nexus, RECIPE);
  nexus.calls = [];
  const out = await runMethod("apply", nexus, RECIPE);
  assertEquals([out.changes, out.inSync, out.unchanged], [[], true, 11]);
  assertEquals(writes(nexus), []);
});

Deno.test("sync reports drift made in Nexus, field names only, and never writes", async () => {
  const nexus = new FakeNexus();
  await runMethod("apply", nexus, RECIPE);
  (nexus.repos.get("raw-proxy")!.proxy as Json).contentMaxAge = 5;
  (nexus.repos.get("docker-proxy")!.docker as Json).httpsPort = null;
  nexus.roles.get("engineering-read-only")!.privileges = ["nx-all"];
  nexus.users.get("chef")!.password = "changed-in-the-ui";
  nexus.calls = [];
  const out = await runMethod("sync", nexus, RECIPE);
  assertEquals(writes(nexus), []);
  assertEquals(out.inSync, false);
  assertEquals(out.changes, [
    {
      kind: "role",
      name: "engineering-read-only",
      action: "update",
      fields: ["privileges"],
    },
    { kind: "user", name: "chef", action: "update", fields: ["password"] },
    {
      kind: "repository",
      name: "raw-proxy",
      action: "update",
      fields: ["proxy.contentMaxAge"],
    },
    {
      kind: "repository",
      name: "docker-proxy",
      action: "update",
      fields: ["docker.httpsPort"],
    },
  ]);
  const fixed = await runMethod("apply", nexus, RECIPE);
  assertEquals([fixed.inSync, nexus.users.get("chef")!.password], [
    true,
    "superseekret",
  ]);
});

Deno.test("without prune, undeclared items are listed and kept", async () => {
  const nexus = new FakeNexus();
  nexus.repos.set("maven-central", {
    name: "maven-central",
    format: "maven2",
    type: "proxy",
    storage: { blobStoreName: "default" },
  });
  nexus.users.set("old", {
    userId: "old",
    source: "default",
    roles: [],
    password: "x",
  });
  const out = await runMethod("apply", nexus, RECIPE);
  assertEquals(out.undeclared, [
    { kind: "repository", name: "maven-central" },
    { kind: "user", name: "old" },
    // Undeclared but used by declared repositories, so always kept.
    { kind: "blobStore", name: "default" },
  ]);
  assertEquals([nexus.repos.has("maven-central"), nexus.users.has("old")], [
    true,
    true,
  ]);
});

Deno.test("prune deletes undeclared items before creating, groups first, blob stores last", async () => {
  const nexus = new FakeNexus();
  nexus.stores.set("legacy", { type: "File", path: "legacy" });
  nexus.repos.set("old-hosted", {
    name: "old-hosted",
    format: "raw",
    type: "hosted",
    storage: { blobStoreName: "legacy" },
  });
  nexus.repos.set("old-group", {
    name: "old-group",
    format: "raw",
    type: "group",
    storage: { blobStoreName: "legacy" },
    group: { memberNames: ["old-hosted"] },
  });
  // Holds the docker-proxy connector port; prune must delete it first.
  nexus.repos.set("old-docker", {
    name: "old-docker",
    format: "docker",
    type: "hosted",
    storage: { blobStoreName: "default" },
    docker: { httpPort: 10080 },
  });
  nexus.roles.set("old-role", {
    id: "old-role",
    source: "default",
    readOnly: false,
    privileges: [],
    roles: [],
  });
  nexus.users.set("old-user", {
    userId: "old-user",
    source: "default",
    roles: [],
    password: "x",
  });
  const out = await runMethod("apply", nexus, RECIPE, { prune: true });
  const deletes = out.changes.filter((c) => c.action === "delete").map((c) =>
    `${c.kind} ${c.name}`
  );
  assertEquals(deletes, [
    "repository old-group",
    "repository old-hosted",
    "repository old-docker",
    "user old-user",
    "role old-role",
    "blobStore legacy",
  ]);
  const firstCreateRepo = out.changes.findIndex((c) =>
    c.kind === "repository" && c.action === "create"
  );
  const lastRepoDelete = out.changes.findLastIndex((c) =>
    c.kind === "repository" && c.action === "delete"
  );
  assertEquals(lastRepoDelete < firstCreateRepo, true);
  assertEquals(out.inSync, true);
  assertEquals([
    nexus.users.has("admin"),
    nexus.users.has("anonymous"),
    nexus.roles.has("nx-admin"),
  ], [true, true, true]);
});

Deno.test("prune keeps an undeclared blob store that declared repositories use", async () => {
  const nexus = new FakeNexus();
  const out = await runMethod("apply", nexus, {
    repositories: [{ name: "r", format: "raw", type: "hosted" }],
  }, { prune: true });
  assertEquals(out.undeclared, [{ kind: "blobStore", name: "default" }]);
  assertEquals(nexus.stores.has("default"), true);
});

Deno.test("apply refuses, changing nothing, when an undeclared repository holds a port", async () => {
  const nexus = new FakeNexus();
  nexus.repos.set("old-docker", {
    name: "old-docker",
    format: "docker",
    type: "hosted",
    storage: { blobStoreName: "default" },
    docker: { httpPort: 10080 },
  });
  await assertRejects(
    () => runMethod("apply", nexus, RECIPE),
    Error,
    "repository docker-proxy needs port 10080, which undeclared repository old-docker uses",
  );
  assertEquals(writes(nexus), []);
});

Deno.test("apply refuses conflicts it cannot fix", async () => {
  const cases: [Json, (n: FakeNexus) => void, string][] = [
    [
      { repositories: [{ name: "x", format: "raw", type: "hosted" }] },
      (n) =>
        n.repos.set("x", {
          name: "x",
          format: "npm",
          type: "hosted",
          storage: { blobStoreName: "default" },
        }),
      "repository x is npm hosted, declared raw hosted",
    ],
    [
      { roles: [{ id: "nx-admin", privileges: [] }] },
      () => {},
      "role nx-admin is built into Nexus and read-only",
    ],
    [
      {
        repositories: [{
          name: "g",
          format: "raw",
          type: "group",
          members: ["kept"],
        }],
      },
      (n) =>
        n.repos.set("kept", {
          name: "kept",
          format: "raw",
          type: "hosted",
          storage: { blobStoreName: "default" },
        }),
      "repository g has member kept, which is not declared, so prune would delete it",
    ],
  ];
  for (const [args, setup, message] of cases) {
    const nexus = new FakeNexus();
    setup(nexus);
    await assertRejects(
      () => runMethod("apply", nexus, args, { prune: true }),
      Error,
      message,
    );
    assertEquals(writes(nexus), []);
  }
});

Deno.test("apply fails if Nexus does not converge", async () => {
  const nexus = new FakeNexus();
  const original = nexus.api;
  // A Nexus that silently ignores updates to contentMaxAge.
  nexus.api = (req) => {
    if (req.method === "PUT" && req.path.startsWith("/v1/repositories/")) {
      const json = structuredClone(req.json) as Json;
      (json.proxy as Json).contentMaxAge = 1440;
      return original({ ...req, json });
    }
    return original(req);
  };
  const decl = {
    repositories: [{
      name: "p",
      format: "raw",
      type: "proxy",
      remoteUrl: "https://x.example.org",
      contentMaxAge: 60,
    }],
  };
  nexus.repos.set("p", {
    ...repositoryPayload(repo(decl.repositories[0])),
    format: "raw",
    type: "proxy",
    proxy: {
      remoteUrl: "https://x.example.org",
      contentMaxAge: 1440,
      metadataMaxAge: 1440,
    },
  });
  await assertRejects(
    () => runMethod("apply", nexus, decl),
    Error,
    "Nexus still differs after apply: update repository p (proxy.contentMaxAge)",
  );
});

Deno.test("a disabled user's password is not checked", async () => {
  const nexus = new FakeNexus();
  const users = [{ ...RECIPE.users[0], status: "disabled" }];
  await runMethod("apply", nexus, { roles: RECIPE.roles, users });
  nexus.calls = [];
  const out = await runMethod("sync", nexus, { roles: RECIPE.roles, users });
  assertEquals(out.inSync, true);
  assertEquals(nexus.calls.some((c) => c.user === "chef"), false);
});

Deno.test("plan never writes", async () => {
  const nexus = new FakeNexus();
  const p = await plan(ga(RECIPE), nexus.api, true);
  assertEquals(p.steps.length, 11);
  assertEquals(writes(nexus), []);
});

// ------------------------------------------------------------ checks

Deno.test("checkAdmin distinguishes a wrong password from a non-admin", async () => {
  const nexus = new FakeNexus();
  assertEquals(await checkAdmin(ga(), nexus.api), { pass: true });
  assertEquals(
    await checkAdmin(ga({ adminPassword: "wrong-one" }), nexus.api),
    {
      pass: false,
      errors: ["Nexus rejects admin's password"],
    },
  );
  nexus.users.set("viewer", {
    userId: "viewer",
    roles: ["nx-anonymous"],
    password: "viewer-pass",
  });
  assertEquals(
    await checkAdmin(
      ga({ adminUsername: "viewer", adminPassword: "viewer-pass" }),
      nexus.api,
    ),
    {
      pass: false,
      errors: ["viewer is not an administrator"],
    },
  );
});

Deno.test("checkReferences catches typos before apply changes anything", async () => {
  const nexus = new FakeNexus();
  assertEquals(await checkReferences(ga(RECIPE), nexus.api), { pass: true });
  const r = await checkReferences(
    ga({
      realms: ["NexusAuthenticatingRealm", "DockerTokn"],
      roles: [{
        id: "r",
        privileges: ["nx-serach-read"],
        roles: ["missing-role"],
      }],
      users: [{
        userId: "u",
        firstName: "A",
        lastName: "B",
        emailAddress: "a@example.org",
        password: "longenough",
        roles: ["nope"],
      }],
      repositories: [
        { name: "h", format: "raw", type: "hosted", blobStore: "nowhere" },
        { name: "n", format: "npm", type: "hosted" },
        {
          name: "g",
          format: "raw",
          type: "group",
          members: ["h", "n", "ghost"],
        },
      ],
    }),
    nexus.api,
  );
  assertEquals(r.errors, [
    "realm DockerTokn is not available",
    "role r: privilege nx-serach-read does not exist",
    "role r: role missing-role does not exist",
    "user u: role nope does not exist",
    "repository h: blob store nowhere does not exist",
    "repository g: member n is npm, not raw",
    "repository g: member ghost does not exist",
  ]);
});

Deno.test("checks pass arguments swamp has not resolved yet, and apply defaults", async () => {
  const unresolved = {
    url: '${{ data.latest("nexus", "instance").attributes.url }}',
    adminPassword: PW,
  };
  for (const check of Object.values(model.checks)) {
    assertEquals(await check.execute({ globalArgs: unresolved }), {
      pass: true,
    });
  }
});

Deno.test("errorText turns an HTML error page into one line", () => {
  const html =
    '<!DOCTYPE html><html><head><title>429 - Sonatype Nexus Repository</title></head><body><span class="title">Error 429</span><span>Too Many Requests</span><div>Too many authentication attempts</div></body></html>';
  const text = errorText({ status: 429, body: html });
  assertEquals(
    text.startsWith("Too Many Requests Too many authentication attempts"),
    true,
  );
  assertEquals(
    text.endsWith(
      "(Nexus is throttling sign-ins after failed attempts; wait a minute)",
    ),
    true,
  );
  assertEquals(
    errorText({ status: 400, body: '[{"message":"bad"}]' }),
    '[{"message":"bad"}]',
  );
});
