import { assertEquals } from "jsr:@std/assert@1.0.19";
import { dhcpRange, networkXml, parseNetworkXml } from "./virsh.ts";

// The default network Ubuntu's libvirt-daemon-config-network installs.
const DEFAULT_XML = `<network>
  <name>default</name>
  <uuid>9a05da11-e96b-47f3-8253-a3a482e445f5</uuid>
  <forward mode='nat'>
    <nat><port start='1024' end='65535'/></nat>
  </forward>
  <bridge name='virbr0' stp='on' delay='0'/>
  <mac address='52:54:00:0a:cd:21'/>
  <ip address='192.168.122.1' netmask='255.255.255.0'>
    <dhcp><range start='192.168.122.2' end='192.168.122.254'/></dhcp>
  </ip>
</network>`;

Deno.test("parseNetworkXml reads libvirt's default NAT network", () => {
  assertEquals(parseNetworkXml(DEFAULT_XML), {
    mode: "nat",
    bridge: "virbr0",
    interface: null,
    address: "192.168.122.1/24",
  });
});

Deno.test("parseNetworkXml tells a bridge network from macvtap", () => {
  assertEquals(
    parseNetworkXml(
      "<network><name>host-network</name><forward mode='bridge'/><bridge name='br0'/></network>",
    ).mode,
    "bridge",
  );
  assertEquals(
    parseNetworkXml(
      "<network><name>mv</name><forward mode='bridge'>\n<interface dev='eno1'/>\n</forward></network>",
    ),
    { mode: "macvtap", bridge: null, interface: "eno1", address: null },
  );
  assertEquals(
    parseNetworkXml("<network><name>iso</name></network>").mode,
    "isolated",
  );
});

Deno.test("networkXml round-trips through parseNetworkXml for every mode", () => {
  const defs = [
    {
      mode: "nat",
      bridge: "virbr1",
      interface: null,
      address: "192.168.123.1/24",
    },
    { mode: "routed", bridge: null, interface: null, address: "10.10.0.1/24" },
    { mode: "bridge", bridge: "br0", interface: null, address: null },
    { mode: "macvtap", bridge: null, interface: "eno1", address: null },
  ] as const;
  for (const def of defs) {
    assertEquals(parseNetworkXml(networkXml("n", { ...def })), { ...def });
  }
});

Deno.test("dhcpRange skips the host's own address", () => {
  assertEquals(dhcpRange("192.168.122.1/24"), {
    start: "192.168.122.2",
    end: "192.168.122.254",
  });
  assertEquals(dhcpRange("10.0.0.254/24"), {
    start: "10.0.0.1",
    end: "10.0.0.253",
  });
});
