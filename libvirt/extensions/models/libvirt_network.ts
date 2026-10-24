import { z } from "npm:zod@4";
import {
  type Context,
  converge,
  type Resource,
  type Seams,
  StateBaseSchema,
} from "./_lib/converge.ts";
import { adviseNetwork, MODES, readNetworkFacts } from "./_lib/network.ts";
import { check, connectionChecks, ConnectionSchema } from "./_lib/runner.ts";
import {
  listNames,
  type NetworkDef,
  networkXml,
  parseInfo,
  parseNetworkXml,
  writeTemp,
} from "./_lib/virsh.ts";

// A libvirt network: how guests reach the world. nat gives them a private
// subnet behind the host; bridge puts them on the LAN through a Linux
// bridge the host already has; macvtap puts them on the LAN straight
// through a wired interface, though the host can't reach them that way;
// routed gives them a subnet the LAN reaches through a route to the host.
// Before defining a bridge or macvtap network, the host's uplink is read,
// and a mode that can't work there (Wi-Fi, an interface that's already a
// bridge port) fails with the reason instead of leaving guests with no
// address. This type never changes the host's own network: a bridge has to
// exist before a bridge network can use it.

const GlobalArgsSchema = ConnectionSchema.extend({
  name: z.string().regex(/^[A-Za-z0-9_.-]+$/).describe("Network name"),
  mode: z.enum(MODES).describe(
    "nat, bridge (an existing Linux bridge), macvtap (a wired interface) or routed",
  ),
  bridge: z.string().min(1).optional().describe(
    "bridge mode: the host's Linux bridge, e.g. br0. nat and routed: the bridge libvirt creates, e.g. virbr1 (libvirt picks one if unset).",
  ),
  interface: z.string().min(1).optional().describe(
    "macvtap mode: the wired interface guests share, e.g. eno1",
  ),
  address: z.string().regex(/^\d+\.\d+\.\d+\.\d+\/\d+$/).optional().describe(
    "nat and routed: the host's address on the guest subnet, e.g. 198.51.100.1/24; DHCP serves the rest",
  ),
  ensure: z.enum(["present", "absent"]).default("present"),
  autostart: z.boolean().default(true),
  uri: z.string().default("qemu:///system").describe(
    "libvirt connection URI, as the host sees it",
  ),
}).superRefine((g, ctx) => {
  if (g.ensure === "absent") return;
  if (g.mode === "bridge" && !g.bridge) {
    ctx.addIssue({ code: "custom", message: "bridge mode needs bridge" });
  }
  if (g.mode === "macvtap" && !g.interface) {
    ctx.addIssue({ code: "custom", message: "macvtap mode needs interface" });
  }
  if ((g.mode === "nat" || g.mode === "routed") && !g.address) {
    ctx.addIssue({ code: "custom", message: `${g.mode} mode needs address` });
  }
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = StateBaseSchema.extend({
  name: z.string().optional(),
  exists: z.boolean().optional(),
  mode: z.string().nullable().optional(),
  bridge: z.string().nullable().optional(),
  interface: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  active: z.boolean().optional(),
  autostart: z.boolean().optional(),
});

/** A network as virsh describes it. */
export interface NetworkState {
  name: string;
  exists: boolean;
  def: NetworkDef | null;
  active: boolean;
  autostart: boolean;
}

/** The definition the arguments ask for. */
export function wantedDef(g: GlobalArgs): NetworkDef {
  return {
    mode: g.mode,
    bridge: g.mode === "macvtap" ? null : g.bridge ?? null,
    interface: g.mode === "macvtap" ? g.interface! : null,
    address: g.mode === "nat" || g.mode === "routed" ? g.address! : null,
  };
}

/** How a definition differs from the one wanted, field by field. */
export function defDiff(have: NetworkDef, want: NetworkDef): string[] {
  const out: string[] = [];
  for (const k of ["mode", "bridge", "interface", "address"] as const) {
    // libvirt names a NAT bridge itself when none is asked for.
    if (k === "bridge" && want.bridge === null && want.mode !== "bridge") {
      continue;
    }
    if (have[k] !== want[k]) {
      out.push(`${k}: wanted ${want[k]}, found ${have[k]}`);
    }
  }
  return out;
}

/** One libvirt network. */
export const networkResource: Resource<GlobalArgs, NetworkState> = {
  label: (g) => `network ${g.name}`,
  async read(s, g) {
    if (
      g.ensure === "present" && (g.mode === "bridge" || g.mode === "macvtap")
    ) {
      // Guests on a bridge or macvtap network share the uplink, so check it
      // can carry them before saying anything about the network.
      const facts = await readNetworkFacts(s.run);
      const advice = adviseNetwork(facts);
      const m = advice.modes[g.mode];
      if (m.status === "unavailable") {
        throw new Error(
          `${g.mode} can't work on this host: ${m.reasons.join("; ")}`,
        );
      }
      const dev = g.mode === "bridge" ? g.bridge! : g.interface!;
      const found = facts.interfaces.find((i) => i.name === dev);
      if (!found) {
        throw new Error(
          `${dev} doesn't exist on this host${
            g.mode === "bridge"
              ? "; create the bridge in netplan first (this type doesn't change the host's own network)"
              : ""
          }`,
        );
      }
      if (g.mode === "bridge" && found.kind !== "bridge") {
        throw new Error(`${dev} is ${found.kind}, not a bridge`);
      }
    }
    const virsh = ["-c", g.uri];
    if (!(await listNames(s.sudo, g.uri, "net-list")).includes(g.name)) {
      return {
        name: g.name,
        exists: false,
        def: null,
        active: false,
        autostart: false,
      };
    }
    const info = parseInfo(
      check(await s.sudo("virsh", [...virsh, "net-info", g.name]), "net-info")
        .stdout,
    );
    const xml = check(
      await s.sudo("virsh", [...virsh, "net-dumpxml", "--inactive", g.name]),
      "net-dumpxml",
    ).stdout;
    return {
      name: g.name,
      exists: true,
      def: parseNetworkXml(xml),
      active: info.active === "yes",
      autostart: info.autostart === "yes",
    };
  },
  diff(n, g) {
    if (g.ensure === "absent") {
      return n.exists ? [`remove network ${g.name}`] : [];
    }
    if (!n.exists) return [`define ${g.mode} network ${g.name}`];
    const changes = defDiff(n.def!, wantedDef(g)).map((d) =>
      `redefine network ${g.name}: ${d}`
    );
    if (!n.active) changes.push(`start network ${g.name}`);
    if (n.autostart !== g.autostart) {
      changes.push(`${g.autostart ? "enable" : "disable"} autostart`);
    }
    return changes;
  },
  async apply(s, g, n) {
    const virsh = (...args: string[]) =>
      s.sudo("virsh", ["-c", g.uri, ...args]);
    const redefine = n.exists &&
      (g.ensure === "absent" || defDiff(n.def!, wantedDef(g)).length > 0);
    if (redefine) {
      if (n.active) check(await virsh("net-destroy", g.name), "net-destroy");
      check(await virsh("net-undefine", g.name), "net-undefine");
    }
    if (g.ensure === "absent") return;
    if (!n.exists || redefine) {
      const path = await writeTemp(s, networkXml(g.name, wantedDef(g)));
      try {
        check(await virsh("net-define", path), "net-define");
      } finally {
        await s.run("rm", ["-f", path]);
      }
    }
    const now = await networkResource.read(s, g);
    if (!now.active) check(await virsh("net-start", g.name), "net-start");
    if (now.autostart !== g.autostart) {
      check(
        await virsh(
          "net-autostart",
          ...(g.autostart ? [] : ["--disable"]),
          g.name,
        ),
        "net-autostart",
      );
    }
  },
  details: (n) => ({
    name: n.name,
    exists: n.exists,
    active: n.active,
    autostart: n.autostart,
    mode: n.def?.mode ?? null,
    bridge: n.def?.bridge ?? null,
    interface: n.def?.interface ?? null,
    address: n.def?.address ?? null,
  }),
};

/** The libvirt network behavior. */
export const model = {
  type: "@taylor/libvirt/network",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  checks: connectionChecks(["check", "apply"]),
  resources: {
    state: {
      description:
        "The network's mode, bridge or interface, address, and whether it's active and autostarted",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read the network, and the uplink for bridge and macvtap, and save what apply would change; changes nothing",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("check", networkResource, args, context),
    },
    apply: {
      description:
        "Define, start and autostart the network, redefining it if it differs, or with ensure: absent stop and undefine it",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("apply", networkResource, args, context),
    },
  },
};
