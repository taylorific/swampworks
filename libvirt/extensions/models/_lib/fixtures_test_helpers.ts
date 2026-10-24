import { fail, ok } from "./fake_test_helpers.ts";

// Command answers shared by the types' tests.

export const DPKG = "dpkg-query -W -f ${Status}\t${Version}";
export const V = "sudo -n virsh -c qemu:///system";

/** A fresh 26.04 host: nothing installed, user in no extra groups. */
export const fresh = {
  "hostname": ok("snuc"),
  "cat /etc/os-release": ok('ID=ubuntu\nVERSION_ID="26.04"'),
  "test -c /dev/kvm": ok(),
  [`${DPKG} *`]: fail("no packages found"),
  "id -un": ok("taylor"),
  "id -nG taylor": ok("users sudo"),
};

/** A wired host whose eno1 is a port of br0, as the NUC is. */
export const bridgedUplink = {
  "sh -c *": ok(""),
  "ip -j -d link show": ok(JSON.stringify([
    { ifname: "eno1", link_type: "ether", operstate: "UP", master: "br0" },
    {
      ifname: "br0",
      link_type: "ether",
      operstate: "UP",
      linkinfo: { info_kind: "bridge" },
    },
  ])),
  "ip -j addr show": ok(JSON.stringify([{
    ifname: "br0",
    addr_info: [{ family: "inet", local: "192.0.2.10", prefixlen: 24 }],
  }])),
  "ip -j route show default": ok('[{"dev":"br0","gateway":"192.0.2.1"}]'),
  "sudo -n netplan get all": ok("network:\n  renderer: NetworkManager\n"),
  "systemd-detect-virt": { code: 1, stdout: "none", stderr: "" },
  "systemctl is-active --quiet docker": fail(),
  "cat /proc/sys/net/bridge/bridge-nf-call-iptables": fail(),
};

/** A laptop whose only uplink is Wi-Fi. */
export const wifiUplink = {
  ...bridgedUplink,
  "sh -c *": ok("wlp0s20f3"),
  "ip -j -d link show": ok(
    '[{"ifname":"wlp0s20f3","link_type":"ether","operstate":"UP"}]',
  ),
  "ip -j addr show": ok(
    '[{"ifname":"wlp0s20f3","addr_info":[{"family":"inet","local":"198.51.100.40","prefixlen":24}]}]',
  ),
  "ip -j route show default": ok('[{"dev":"wlp0s20f3"}]'),
};
