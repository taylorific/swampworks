import { z } from "npm:zod@4";
import {
  type Context,
  converge,
  type Resource,
  type Seams,
  StateBaseSchema,
} from "./_lib/converge.ts";
import {
  adviseNetwork,
  MODES,
  NetworkAdviceSchema,
  type NetworkFacts,
  NetworkFactsSchema,
  readNetworkFacts,
} from "./_lib/network.ts";
import { connectionChecks, ConnectionSchema } from "./_lib/runner.ts";

// The host's uplink, and which ways of connecting guests can work on it.
// The interface holding the default route decides most of it: an access
// point only accepts frames from the MAC address that associated with it,
// so guests can't share a Wi-Fi link the way they share a cable, and a host
// that is itself a VM needs its hypervisor to pass guest MACs. `check`
// fails when the mode a workflow asks for can't work here, so the steps
// that would build that network don't run; mistakes in netplan show up as
// changes. There is no apply: fixing an uplink means changing the host's
// own network, which this type leaves to you.

const GlobalArgsSchema = ConnectionSchema.extend({
  mode: z.enum(MODES).optional().describe(
    "The way guests will connect. check fails when it can't work on this host.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = StateBaseSchema.extend(
  NetworkFactsSchema.partial().extend({
    advice: NetworkAdviceSchema.optional(),
  }).shape,
);

type Uplink = NetworkFacts & { advice: z.infer<typeof NetworkAdviceSchema> };

/** The uplink and the advice for it. */
export const uplinkResource: Resource<GlobalArgs, Uplink> = {
  label: (g) => g.mode ? `uplink (${g.mode})` : "uplink",
  async read(s, g) {
    const facts = await readNetworkFacts(s.run);
    // libvirt's own NAT bridges aren't LAN addresses, so they can't clash.
    const libvirtBridges = facts.interfaces.filter((i) =>
      i.kind === "bridge" && /^virbr\d+$/.test(i.name)
    ).map((i) => i.name);
    const advice = adviseNetwork(facts, libvirtBridges);
    if (g.mode && advice.modes[g.mode].status === "unavailable") {
      throw new Error(
        `${g.mode} can't work on this host: ${
          advice.modes[g.mode].reasons.join("; ")
        }. ${advice.summary}`,
      );
    }
    return { ...facts, advice };
  },
  diff: (u) => u.netplanWarnings,
  apply: () => Promise.reject(new Error("uplink has no apply")),
  details: (u) => ({ ...u }),
  notes(u, g) {
    const notes = [u.advice.summary];
    if (g.mode) {
      const m = u.advice.modes[g.mode];
      if (m.status === "caution") notes.push(...m.reasons);
    }
    if (!u.netplanReadable) {
      notes.push(
        "Couldn't read netplan's config (it takes passwordless sudo), so netplan mistakes weren't checked",
      );
    }
    return notes;
  },
};

/** The libvirt uplink behavior. */
export const model = {
  type: "@taylor/libvirt/uplink",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  checks: connectionChecks(["check"]),
  resources: {
    state: {
      description:
        "The host's interfaces, uplink and network manager, which ways of connecting guests can work, and netplan mistakes",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read the uplink and save which ways of connecting guests can work; fails when mode can't. Changes nothing.",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("check", uplinkResource, args, context),
    },
  },
};
