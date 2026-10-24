import { z } from "npm:zod@4";
import {
  type Context,
  converge,
  type Resource,
  type Seams,
  StateBaseSchema,
} from "./_lib/converge.ts";
import { check, connectionChecks, ConnectionSchema } from "./_lib/runner.ts";
import {
  listNames,
  parseInfo,
  parsePoolTarget,
  parsePoolType,
} from "./_lib/virsh.ts";

// A directory storage pool: where libvirt keeps disk images or ISOs. Ubuntu
// 26.04's -hwe packages create /var/lib/libvirt/images but no pool for it,
// so the deck defines `default` there and an `iso` pool beside it, both
// started and autostarted. `apply` defines, builds, starts and autostarts
// the pool; a pool pointing somewhere else is redefined. With ensure:
// absent it's stopped and undefined; the directory and its files stay.

const GlobalArgsSchema = ConnectionSchema.extend({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/).describe("Pool name"),
  target: z.string().startsWith("/").optional().describe(
    "Directory the pool keeps volumes in. Defaults to /var/lib/libvirt/<name>, or /var/lib/libvirt/images for default.",
  ),
  ensure: z.enum(["present", "absent"]).default("present"),
  autostart: z.boolean().default(true),
  uri: z.string().default("qemu:///system").describe(
    "libvirt connection URI, as the host sees it",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = StateBaseSchema.extend({
  name: z.string().optional(),
  exists: z.boolean().optional(),
  type: z.string().nullable().optional(),
  target: z.string().nullable().optional(),
  running: z.boolean().optional(),
  autostart: z.boolean().optional(),
});

/** A pool as virsh describes it. */
export interface PoolState {
  name: string;
  exists: boolean;
  type: string | null;
  target: string | null;
  running: boolean;
  autostart: boolean;
}

/** The directory a pool should use. */
export function poolTarget(g: GlobalArgs): string {
  return g.target ??
    (g.name === "default"
      ? "/var/lib/libvirt/images"
      : `/var/lib/libvirt/${g.name}`);
}

/** One libvirt storage pool. */
export const poolResource: Resource<GlobalArgs, PoolState> = {
  label: (g) => `pool ${g.name}`,
  async read(s, g) {
    const virsh = ["-c", g.uri];
    const none = {
      name: g.name,
      exists: false,
      type: null,
      target: null,
      running: false,
      autostart: false,
    };
    if (!(await listNames(s.sudo, g.uri, "pool-list")).includes(g.name)) {
      return none;
    }
    const info = parseInfo(
      check(
        await s.sudo("virsh", [...virsh, "pool-info", g.name]),
        "virsh pool-info",
      ).stdout,
    );
    const xml = check(
      await s.sudo("virsh", [...virsh, "pool-dumpxml", g.name]),
      "virsh pool-dumpxml",
    ).stdout;
    return {
      name: g.name,
      exists: true,
      type: parsePoolType(xml),
      target: parsePoolTarget(xml),
      running: info.state === "running",
      autostart: info.autostart === "yes",
    };
  },
  diff(p, g) {
    if (g.ensure === "absent") return p.exists ? [`remove pool ${g.name}`] : [];
    const want = poolTarget(g);
    if (!p.exists) return [`define pool ${g.name} at ${want}`];
    const changes: string[] = [];
    if (p.type !== "dir" || p.target !== want) {
      changes.push(
        `redefine pool ${g.name}: wanted dir at ${want}, found ${p.type} at ${p.target}`,
      );
    }
    if (!p.running) changes.push(`start pool ${g.name}`);
    if (p.autostart !== g.autostart) {
      changes.push(`${g.autostart ? "enable" : "disable"} autostart`);
    }
    return changes;
  },
  async apply(s, g, p) {
    const virsh = (...args: string[]) =>
      s.sudo("virsh", ["-c", g.uri, ...args]);
    const want = poolTarget(g);
    const redefine = p.exists &&
      (g.ensure === "absent" || p.type !== "dir" || p.target !== want);
    if (redefine) {
      if (p.running) check(await virsh("pool-destroy", g.name), "pool-destroy");
      check(await virsh("pool-undefine", g.name), "pool-undefine");
    }
    if (g.ensure === "absent") return;
    if (!p.exists || redefine) {
      check(
        await virsh(
          "pool-define-as",
          "--name",
          g.name,
          "--type",
          "dir",
          "--target",
          want,
        ),
        "pool-define-as",
      );
      check(await virsh("pool-build", g.name), "pool-build");
    }
    const now = await poolResource.read(s, g);
    if (!now.running) check(await virsh("pool-start", g.name), "pool-start");
    if (now.autostart !== g.autostart) {
      check(
        await virsh(
          "pool-autostart",
          ...(g.autostart ? [] : ["--disable"]),
          g.name,
        ),
        "pool-autostart",
      );
    }
  },
  details: (p) => ({ ...p }),
};

/** The libvirt pool behavior. */
export const model = {
  type: "@taylor/libvirt/pool",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  checks: connectionChecks(["check", "apply"]),
  resources: {
    state: {
      description:
        "The pool's type, target, and whether it's running and autostarted",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read the pool and save what apply would change; changes nothing",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("check", poolResource, args, context),
    },
    apply: {
      description:
        "Define, build, start and autostart the pool, or with ensure: absent stop and undefine it",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("apply", poolResource, args, context),
    },
  },
};
