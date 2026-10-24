import { parse as parseYaml } from "jsr:@std/yaml@1.2.0";
import { z } from "npm:zod@4";
import type { Run } from "./runner.ts";

// What a host's network looks like to libvirt, and which ways of connecting
// guests can work on it. The uplink is the interface holding the default
// route, or the physical ports under it when it's a bridge or bond. Whether
// that uplink is Wi-Fi decides most of it: an access point only accepts
// frames from the MAC address that associated with it, so guests with their
// own MACs can't share a Wi-Fi link the way they share a cable, and the
// kernel refuses to add a Wi-Fi interface in managed mode to a bridge.

/** The subnet libvirt's default NAT network uses. */
export const DEFAULT_NAT_SUBNET = "192.168.122.0/24";

/** Ways to connect guests, as `@taylor/libvirt/network` names them. */
export const MODES = ["nat", "bridge", "macvtap", "routed"] as const;
export type Mode = typeof MODES[number];

const InterfaceSchema = z.object({
  name: z.string(),
  kind: z.string(),
  state: z.string(),
  mac: z.string().nullable(),
  master: z.string().nullable(),
  addresses: z.array(z.string()),
});
/** One network interface: `kind` is ethernet, wifi, bridge, bond, macvtap, … */
export type Interface = z.infer<typeof InterfaceSchema>;

export const NetworkFactsSchema = z.object({
  interfaces: z.array(InterfaceSchema),
  defaultRoute: z.object({ device: z.string(), gateway: z.string().nullable() })
    .nullable(),
  uplink: z.object({
    device: z.string(),
    kind: z.string(),
    ports: z.array(z.string()),
    wireless: z.boolean(),
    addresses: z.array(z.string()),
  }).nullable(),
  renderer: z.string().nullable(),
  virtualization: z.string(),
  docker: z.boolean(),
  brNetfilter: z.boolean(),
  netplanReadable: z.boolean(),
  netplanWarnings: z.array(z.string()),
});
/** What sync found out about the host's network. */
export type NetworkFacts = z.infer<typeof NetworkFactsSchema>;

const ModeAdviceSchema = z.object({
  status: z.enum(["recommended", "ok", "caution", "unavailable"]),
  reasons: z.array(z.string()),
});
export const NetworkAdviceSchema = z.object({
  recommended: z.enum(MODES).nullable(),
  summary: z.string(),
  modes: z.object({
    nat: ModeAdviceSchema,
    bridge: ModeAdviceSchema,
    macvtap: ModeAdviceSchema,
    routed: ModeAdviceSchema,
  }),
});
/** Which ways of connecting guests work on this host, and why. */
export type NetworkAdvice = z.infer<typeof NetworkAdviceSchema>;
type ModeAdvice = z.infer<typeof ModeAdviceSchema>;

interface IpLink {
  ifname: string;
  link_type?: string;
  operstate?: string;
  address?: string;
  master?: string;
  linkinfo?: { info_kind?: string };
}

interface IpAddr {
  ifname: string;
  addr_info?: { family: string; local: string; prefixlen: number }[];
}

/** Interfaces from `ip -j -d link` and `ip -j addr`, without loopback. */
export function parseInterfaces(
  linkJson: string,
  addrJson: string,
  wireless: string[],
): Interface[] {
  const links = JSON.parse(linkJson || "[]") as IpLink[];
  const addrs = JSON.parse(addrJson || "[]") as IpAddr[];
  return links.filter((l) => l.link_type !== "loopback").map((l) => ({
    name: l.ifname,
    kind: wireless.includes(l.ifname) ? "wifi" : l.linkinfo?.info_kind ??
      (l.link_type === "ether" ? "ethernet" : l.link_type ?? "unknown"),
    state: (l.operstate ?? "UNKNOWN").toLowerCase(),
    mac: l.address ?? null,
    master: l.master ?? null,
    addresses: (addrs.find((a) => a.ifname === l.ifname)?.addr_info ?? [])
      .filter((a) => a.family === "inet" || a.family === "inet6")
      .map((a) => `${a.local}/${a.prefixlen}`),
  }));
}

/** The default route's device and gateway from `ip -j route show default`. */
export function parseDefaultRoute(
  json: string,
): { device: string; gateway: string | null } | null {
  const routes = JSON.parse(json || "[]") as {
    dev?: string;
    gateway?: string;
  }[];
  const r = routes.find((r) => r.dev);
  return r ? { device: r.dev!, gateway: r.gateway ?? null } : null;
}

/** The interface carrying traffic out, and what it's made of. */
export function findUplink(
  interfaces: Interface[],
  route: { device: string } | null,
): NetworkFacts["uplink"] {
  if (!route) return null;
  const dev = interfaces.find((i) => i.name === route.device);
  if (!dev) return null;
  const ports = interfaces.filter((i) => i.master === dev.name).map((i) =>
    i.name
  );
  const physical = ports.length ? ports : [dev.name];
  return {
    device: dev.name,
    kind: dev.kind,
    ports,
    wireless: physical.some((n) =>
      interfaces.find((i) => i.name === n)?.kind === "wifi"
    ),
    addresses: dev.addresses.filter((a) => !a.includes(":")),
  };
}

/** Netplan's renderer, NetworkManager or networkd (its default). */
export function netplanRenderer(config: unknown): string {
  const r = (config as { network?: { renderer?: string } })?.network?.renderer;
  return r ?? "networkd";
}

/**
 * Mistakes in netplan that break networking on a libvirt host: a Wi-Fi
 * interface declared as ethernet, which gives it a wired profile that can
 * never connect, or a Wi-Fi interface put in a bridge.
 */
export function netplanWarnings(config: unknown, wireless: string[]): string[] {
  const net = (config as { network?: Record<string, unknown> })?.network ?? {};
  const ethernets = Object.keys((net.ethernets ?? {}) as object);
  const bridges = (net.bridges ?? {}) as Record<
    string,
    { interfaces?: string[] }
  >;
  const warnings: string[] = [];
  for (const name of ethernets.filter((n) => wireless.includes(n))) {
    warnings.push(
      `netplan declares the Wi-Fi interface ${name} under ethernets, so it gets a wired profile that can never connect; ${
        netplanRenderer(config) === "NetworkManager"
          ? "remove it from netplan and let NetworkManager manage it, or move it under wifis with its access-points"
          : "move it under wifis with its access-points"
      }`,
    );
  }
  for (const [bridge, def] of Object.entries(bridges)) {
    for (
      const name of (def.interfaces ?? []).filter((n) => wireless.includes(n))
    ) {
      warnings.push(
        `netplan puts the Wi-Fi interface ${name} in bridge ${bridge}; Wi-Fi can't be bridged, so the bridge will never get an address from it`,
      );
    }
  }
  return warnings;
}

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => !(p >= 0 && p <= 255))) {
    return null;
  }
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>>
    0;
}

/** Whether two IPv4 CIDRs share any address. */
export function cidrsOverlap(a: string, b: string): boolean {
  const [ipA, lenA] = a.split("/");
  const [ipB, lenB] = b.split("/");
  const x = ipv4ToInt(ipA);
  const y = ipv4ToInt(ipB);
  if (x === null || y === null) return false;
  const len = Math.min(Number(lenA), Number(lenB));
  const mask = len === 0 ? 0 : (~0 << (32 - len)) >>> 0;
  return ((x & mask) >>> 0) === ((y & mask) >>> 0);
}

/** Reads the host's network. Nothing here changes anything. */
export async function readNetworkFacts(run: Run): Promise<NetworkFacts> {
  const wirelessOut = await run("sh", [
    "-c",
    'for d in /sys/class/net/*; do [ -d "$d/wireless" ] && basename "$d"; done; true',
  ]);
  const wireless = wirelessOut.stdout.split("\n").filter(Boolean);
  const links = await run("ip", ["-j", "-d", "link", "show"]);
  const addrs = await run("ip", ["-j", "addr", "show"]);
  if (links.code !== 0) {
    throw new Error(`Couldn't list interfaces: ${links.stderr}`);
  }
  const interfaces = parseInterfaces(links.stdout, addrs.stdout, wireless);
  const routeOut = await run("ip", ["-j", "route", "show", "default"]);
  const defaultRoute = routeOut.code === 0
    ? parseDefaultRoute(routeOut.stdout)
    : null;

  // netplan's files are root's alone, so reading them takes sudo.
  const netplan = await run("sudo", ["-n", "netplan", "get", "all"]);
  let config: unknown = null;
  if (netplan.code === 0) {
    try {
      config = parseYaml(netplan.stdout);
    } catch {
      config = null;
    }
  }
  let renderer: string | null = config ? netplanRenderer(config) : null;
  if (!renderer) {
    // Without netplan, ask whichever manager owns the uplink.
    const nm = await run("nmcli", ["-t", "-f", "DEVICE,STATE", "device"]);
    const owned = nm.code === 0 &&
      nm.stdout.split("\n").some((l) =>
        l.startsWith(`${defaultRoute?.device}:connected`)
      );
    renderer = owned
      ? "NetworkManager"
      : (await run("networkctl", ["status", defaultRoute?.device ?? "lo"]))
          .code === 0
      ? "networkd"
      : null;
  }

  const virt = await run("systemd-detect-virt", []);
  const docker = await run("systemctl", ["is-active", "--quiet", "docker"]);
  const nf = await run("cat", ["/proc/sys/net/bridge/bridge-nf-call-iptables"]);
  return {
    interfaces,
    defaultRoute,
    uplink: findUplink(interfaces, defaultRoute),
    renderer,
    // systemd-detect-virt prints "none" and exits 1 on bare metal.
    virtualization: virt.stdout.trim() || "unknown",
    docker: docker.code === 0,
    brNetfilter: nf.code === 0 && nf.stdout.trim() === "1",
    netplanReadable: config !== null,
    netplanWarnings: config ? netplanWarnings(config, wireless) : [],
  };
}

/**
 * Which ways of connecting guests can work on this host, and which to use:
 * an existing bridge over the uplink, NAT on Wi-Fi or inside another
 * hypervisor, and otherwise a bridge, which is the deck's choice for a
 * wired host.
 */
export function adviseNetwork(
  f: NetworkFacts,
  libvirtBridges: string[] = [],
): NetworkAdvice {
  const u = f.uplink;
  const nat: ModeAdvice = {
    status: "ok",
    reasons: [
      "Guests reach out through the host, and nothing else on the LAN can reach them without port forwards; works on any uplink, Wi-Fi included",
    ],
  };
  const clash = f.interfaces
    .filter((i) => !libvirtBridges.includes(i.name))
    .flatMap((i) => i.addresses.map((a) => ({ i, a })))
    .find(({ a }) => !a.includes(":") && cidrsOverlap(a, DEFAULT_NAT_SUBNET));
  if (clash) {
    nat.status = "caution";
    nat.reasons.push(
      `${clash.i.name} has ${clash.a}, which overlaps the default network's ${DEFAULT_NAT_SUBNET} (common when this host is itself a libvirt guest); give the NAT network another subnet`,
    );
  }
  const routed: ModeAdvice = {
    status: "ok",
    reasons: [
      `Guests get their own subnet that the host routes, reachable from the LAN once the router has a static route to it via ${
        u?.addresses[0]?.split("/")[0] ?? "this host"
      }; works over Wi-Fi`,
    ],
  };
  const bridge: ModeAdvice = { status: "ok", reasons: [] };
  const macvtap: ModeAdvice = { status: "ok", reasons: [] };

  if (!u) {
    const why = "There is no default route, so there is no uplink to share";
    bridge.status = macvtap.status = "unavailable";
    bridge.reasons.push(why);
    macvtap.reasons.push(why);
    nat.status = "recommended";
    return {
      recommended: "nat",
      summary: `${why}; use NAT.`,
      modes: { nat, bridge, macvtap, routed },
    };
  }

  const physical = u.ports.length ? u.ports.join(", ") : u.device;
  if (u.wireless) {
    const why =
      `${physical} is Wi-Fi: an access point only accepts frames from the MAC address that associated with it, so guests with their own MACs can't share the link`;
    bridge.status = "unavailable";
    bridge.reasons.push(
      `${why}, and the kernel won't add a Wi-Fi interface in managed mode to a bridge`,
    );
    macvtap.status = "unavailable";
    macvtap.reasons.push(
      `${why}; macvtap starts without error but the guests never get an address`,
    );
  } else if (u.kind === "bridge" && u.ports.length) {
    bridge.status = "recommended";
    bridge.reasons.push(
      `${u.device} already carries the uplink (${physical}); point a libvirt network at it with forward mode='bridge' and guests join the LAN with no host network change`,
    );
    macvtap.status = "unavailable";
    macvtap.reasons.push(
      `${physical} is a port of ${u.device}; macvtap needs an interface that isn't, and ${u.device} already gives guests the LAN`,
    );
  } else {
    bridge.reasons.push(
      `Guests join the LAN and the host can reach them, but ${u.device}'s address has to move to a new bridge${
        f.renderer ? ` (netplan, ${f.renderer} renderer)` : ""
      }; over SSH, apply it behind a timer that restores the old config, since a mistake cuts the session and netplan try refuses bridges with parameters such as stp or forward-delay`,
    );
    macvtap.reasons.push(
      `Guests join the LAN with no host network change, but the host and its guests can't reach each other over macvtap`,
    );
  }

  if (f.virtualization !== "none" && !u.wireless) {
    const why =
      `This host is a ${f.virtualization} guest itself, so the outer hypervisor has to pass frames from guest MACs (VMware: promiscuous mode, MAC address changes and forged transmits; Hyper-V: MAC spoofing; AWS, GCP and Azure don't allow it)`;
    for (const m of [bridge, macvtap]) {
      if (m.status === "unavailable") continue;
      m.status = "caution";
      m.reasons.push(why);
    }
  }
  if (f.docker && f.brNetfilter && bridge.status !== "unavailable") {
    bridge.status = "caution";
    bridge.reasons.push(
      "Docker is running and br_netfilter is loaded, so bridged guest traffic goes through Docker's FORWARD DROP policy; allow it with `iptables -I DOCKER-USER -i <bridge> -o <bridge> -j ACCEPT`",
    );
  }

  let recommended: Mode;
  let summary: string;
  if (bridge.status === "recommended") {
    recommended = "bridge";
    summary = `Use bridge mode on the existing ${u.device}.`;
  } else if (u.wireless) {
    recommended = "nat";
    summary =
      `The uplink is Wi-Fi (${physical}), so guests can't be bridged onto the LAN: use NAT, or routed if the LAN must reach the guests and you can add a route on the router.`;
  } else if (f.virtualization !== "none") {
    recommended = "nat";
    summary =
      `This host is a ${f.virtualization} guest, so NAT is the safe choice; bridge or macvtap only if the outer hypervisor passes guest MACs.`;
  } else {
    recommended = "bridge";
    summary =
      `${u.device} is wired: bridge it so guests join the LAN, or use NAT to leave the host's network alone.`;
  }
  const chosen = { nat, bridge, macvtap, routed }[recommended];
  if (chosen.status === "ok") chosen.status = "recommended";
  return { recommended, summary, modes: { nat, bridge, macvtap, routed } };
}
