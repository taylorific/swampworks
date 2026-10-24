import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  adviseNetwork,
  cidrsOverlap,
  findUplink,
  netplanWarnings,
  type NetworkFacts,
  parseDefaultRoute,
  parseInterfaces,
} from "./network.ts";

// Trimmed from `ip -j -d link` and `ip -j addr` on a NUC whose eno1 is a
// port of br0, with Wi-Fi it doesn't use.
const NUC_LINKS = JSON.stringify([
  { ifname: "lo", link_type: "loopback", operstate: "UNKNOWN" },
  {
    ifname: "enp113s0",
    link_type: "ether",
    operstate: "DOWN",
    address: "02:00:00:00:00:02",
  },
  {
    ifname: "eno1",
    link_type: "ether",
    operstate: "UP",
    address: "02:00:00:00:00:01",
    master: "br0",
  },
  {
    ifname: "wlp4s0",
    link_type: "ether",
    operstate: "DOWN",
    address: "02:00:00:00:00:03",
  },
  {
    ifname: "br0",
    link_type: "ether",
    operstate: "UP",
    address: "02:00:00:00:00:04",
    linkinfo: { info_kind: "bridge" },
  },
]);
const NUC_ADDRS = JSON.stringify([
  {
    ifname: "br0",
    addr_info: [
      { family: "inet", local: "192.0.2.10", prefixlen: 24 },
      { family: "inet6", local: "fe80::948a:5dff:fe1c:f06d", prefixlen: 64 },
    ],
  },
]);

function facts(
  links: string,
  addrs: string,
  wireless: string[],
  route: string,
  extra: Partial<NetworkFacts> = {},
): NetworkFacts {
  const interfaces = parseInterfaces(links, addrs, wireless);
  const defaultRoute = parseDefaultRoute(route);
  return {
    interfaces,
    defaultRoute,
    uplink: findUplink(interfaces, defaultRoute),
    renderer: "NetworkManager",
    virtualization: "none",
    docker: false,
    brNetfilter: false,
    netplanReadable: true,
    netplanWarnings: [],
    ...extra,
  };
}

const nuc = () =>
  facts(
    NUC_LINKS,
    NUC_ADDRS,
    ["wlp4s0"],
    '[{"dev":"br0","gateway":"192.0.2.1"}]',
  );

/** A laptop on Wi-Fi, nothing bridged. */
const laptop = (extra: Partial<NetworkFacts> = {}) =>
  facts(
    JSON.stringify([
      { ifname: "wlp0s20f3", link_type: "ether", operstate: "UP" },
    ]),
    JSON.stringify([{
      ifname: "wlp0s20f3",
      addr_info: [{ family: "inet", local: "198.51.100.40", prefixlen: 24 }],
    }]),
    ["wlp0s20f3"],
    '[{"dev":"wlp0s20f3","gateway":"198.51.100.1"}]',
    extra,
  );

/** A wired server with nothing bridged. */
const server = (extra: Partial<NetworkFacts> = {}) =>
  facts(
    JSON.stringify([{ ifname: "ens33", link_type: "ether", operstate: "UP" }]),
    JSON.stringify([{
      ifname: "ens33",
      addr_info: [{ family: "inet", local: "203.0.113.112", prefixlen: 22 }],
    }]),
    [],
    '[{"dev":"ens33","gateway":"203.0.113.1"}]',
    extra,
  );

Deno.test("parseInterfaces names Wi-Fi from sysfs, bridges from linkinfo", () => {
  const ifs = parseInterfaces(NUC_LINKS, NUC_ADDRS, ["wlp4s0"]);
  assertEquals(
    ifs.map((i) => `${i.name}:${i.kind}:${i.master}`),
    [
      "enp113s0:ethernet:null",
      "eno1:ethernet:br0",
      "wlp4s0:wifi:null",
      "br0:bridge:null",
    ],
  );
  assertEquals(ifs[3].addresses, [
    "192.0.2.10/24",
    "fe80::948a:5dff:fe1c:f06d/64",
  ]);
});

Deno.test("the uplink is the default route's bridge and its ports", () => {
  assertEquals(nuc().uplink, {
    device: "br0",
    kind: "bridge",
    ports: ["eno1"],
    wireless: false,
    addresses: ["192.0.2.10/24"],
  });
});

Deno.test("an existing bridge over a wired uplink is the recommendation", () => {
  const a = adviseNetwork(nuc());
  assertEquals(a.recommended, "bridge");
  assertEquals(a.modes.bridge.status, "recommended");
  assertEquals(a.modes.macvtap.status, "unavailable");
  assertStringIncludes(a.modes.macvtap.reasons[0], "eno1 is a port of br0");
});

Deno.test("Wi-Fi rules out bridge and macvtap and recommends NAT", () => {
  const a = adviseNetwork(laptop());
  assertEquals(a.recommended, "nat");
  assertEquals(a.modes.nat.status, "recommended");
  assertEquals(a.modes.bridge.status, "unavailable");
  assertEquals(a.modes.macvtap.status, "unavailable");
  assertEquals(a.modes.routed.status, "ok");
  assertStringIncludes(a.modes.bridge.reasons[0], "wlp0s20f3 is Wi-Fi");
  assertStringIncludes(a.summary, "Wi-Fi");
});

Deno.test("a wired host with no bridge is told bridging moves its address", () => {
  const a = adviseNetwork(server({ renderer: "networkd" }));
  assertEquals(a.recommended, "bridge");
  assertStringIncludes(a.modes.bridge.reasons[0], "networkd renderer");
  assertStringIncludes(a.modes.macvtap.reasons[0], "can't reach each other");
});

Deno.test("a host that is itself a VM gets NAT and cautions", () => {
  const a = adviseNetwork(server({ virtualization: "vmware" }));
  assertEquals(a.recommended, "nat");
  assertEquals(a.modes.bridge.status, "caution");
  assertStringIncludes(a.modes.bridge.reasons[1], "forged transmits");
});

Deno.test("Docker with br_netfilter cautions about bridging", () => {
  const a = adviseNetwork({ ...nuc(), docker: true, brNetfilter: true });
  assertEquals(a.modes.bridge.status, "caution");
  assertStringIncludes(a.modes.bridge.reasons[1], "DOCKER-USER");
});

Deno.test("a LAN on 192.168.122.0/24 clashes with the default NAT network", () => {
  const f = laptop();
  f.interfaces[0].addresses = ["192.168.122.50/24"];
  const a = adviseNetwork(f);
  assertEquals(a.recommended, "nat");
  assertEquals(a.modes.nat.status, "caution");
  assertStringIncludes(a.modes.nat.reasons[1], "overlaps");
});

Deno.test("libvirt's own virbr0 doesn't count as a clash", () => {
  const f = nuc();
  f.interfaces.push({
    name: "virbr0",
    kind: "bridge",
    state: "down",
    mac: null,
    master: null,
    addresses: ["192.168.122.1/24"],
  });
  assertEquals(adviseNetwork(f, ["virbr0"]).modes.nat.status, "ok");
  assertEquals(adviseNetwork(f).modes.nat.status, "caution");
});

Deno.test("no default route leaves only NAT", () => {
  const a = adviseNetwork(facts(NUC_LINKS, NUC_ADDRS, ["wlp4s0"], "[]"));
  assertEquals(a.recommended, "nat");
  assertEquals(a.modes.bridge.status, "unavailable");
});

Deno.test("netplan Wi-Fi under ethernets is flagged, with the renderer's fix", () => {
  const nm = {
    network: {
      renderer: "NetworkManager",
      ethernets: { eno1: {}, wlp4s0: { dhcp4: true } },
      bridges: { br0: { interfaces: ["eno1"] } },
    },
  };
  const [w] = netplanWarnings(nm, ["wlp4s0"]);
  assertStringIncludes(w, "wlp4s0 under ethernets");
  assertStringIncludes(w, "let NetworkManager manage it");
  const networkd = { network: { ethernets: { wlan0: {} } } };
  assertEquals(
    netplanWarnings(networkd, ["wlan0"])[0].includes("NetworkManager"),
    false,
  );
});

Deno.test("netplan Wi-Fi in a bridge is flagged", () => {
  const cfg = {
    network: {
      wifis: { wlan0: {} },
      bridges: { br0: { interfaces: ["wlan0"] } },
    },
  };
  assertStringIncludes(netplanWarnings(cfg, ["wlan0"])[0], "can't be bridged");
});

Deno.test("cidrsOverlap compares by the shorter prefix", () => {
  assertEquals(cidrsOverlap("192.168.122.50/24", "192.168.122.0/24"), true);
  assertEquals(cidrsOverlap("192.168.0.0/16", "192.168.122.0/24"), true);
  assertEquals(cidrsOverlap("192.0.2.10/24", "192.168.122.0/24"), false);
});
