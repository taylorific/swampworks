import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { fail, ok, runMethod } from "./_lib/fake_test_helpers.ts";
import { model as host } from "./libvirt_host.ts";
import { model as network } from "./libvirt_network.ts";
import { model as pool } from "./libvirt_pool.ts";
import { model as uplink } from "./libvirt_uplink.ts";

const DPKG = "dpkg-query -W -f ${Status}\t${Version}";
const V = "sudo -n virsh -c qemu:///system";

/** A fresh 26.04 host: nothing installed, user in no extra groups. */
const fresh = {
  "hostname": ok("snuc"),
  "cat /etc/os-release": ok('ID=ubuntu\nVERSION_ID="26.04"'),
  "test -c /dev/kvm": ok(),
  [`${DPKG} *`]: fail("no packages found"),
  "id -un": ok("taylor"),
  "id -nG taylor": ok("users sudo"),
};

/** A wired host whose eno1 is a port of br0, as the NUC is. */
const bridgedUplink = {
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
    addr_info: [{ family: "inet", local: "10.63.45.217", prefixlen: 22 }],
  }])),
  "ip -j route show default": ok('[{"dev":"br0","gateway":"10.63.44.1"}]'),
  "sudo -n netplan get all": ok("network:\n  renderer: NetworkManager\n"),
  "systemd-detect-virt": { code: 1, stdout: "none", stderr: "" },
  "systemctl is-active --quiet docker": fail(),
  "cat /proc/sys/net/bridge/bridge-nf-call-iptables": fail(),
};

/** A laptop whose only uplink is Wi-Fi. */
const wifiUplink = {
  ...bridgedUplink,
  "sh -c *": ok("wlp0s20f3"),
  "ip -j -d link show": ok(
    '[{"ifname":"wlp0s20f3","link_type":"ether","operstate":"UP"}]',
  ),
  "ip -j addr show": ok(
    '[{"ifname":"wlp0s20f3","addr_info":[{"family":"inet","local":"192.168.1.40","prefixlen":24}]}]',
  ),
  "ip -j route show default": ok('[{"dev":"wlp0s20f3"}]'),
};

Deno.test("host check lists what's missing and changes nothing", async () => {
  const { state, name, calls } = await runMethod(host, "check", {}, fresh);
  assertEquals(name, "snuc");
  assertEquals(state!.status, "non_compliant");
  assertEquals(state!.changes, [
    "install qemu-system-hwe",
    "install libvirt-daemon-system-hwe",
    "install virtinst",
    "add taylor to libvirt",
    "add taylor to kvm",
  ]);
  assert(!calls.some((c) => c.startsWith("sudo")));
});

Deno.test("host apply installs, adds groups with -aG, and re-reads", async () => {
  const installed = (calls: string[]) =>
    calls.some((c) => c.includes("apt-get install"))
      ? ok("install ok installed\t1.0")
      : fail();
  const grouped = (calls: string[]) =>
    ok(
      calls.filter((c) => c.startsWith("sudo -n usermod")).length === 2
        ? "users sudo libvirt kvm"
        : "users sudo",
    );
  const { state, calls } = await runMethod(host, "apply", {}, {
    ...fresh,
    [`${DPKG} *`]: installed,
    "id -nG taylor": grouped,
    "sudo -n apt-get update -q": ok(),
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q qemu-system-hwe libvirt-daemon-system-hwe virtinst":
      ok(),
    "sudo -n usermod -aG libvirt taylor": ok(),
    "sudo -n usermod -aG kvm taylor": ok(),
  });
  assertEquals(state!.status, "applied");
  assertEquals((state!.groups as string[]).includes("sudo"), true);
  assert(!calls.some((c) => c.includes("usermod -G")));
});

Deno.test("host apply fails, and says why, when /dev/kvm is missing", async () => {
  const { state, error } = await runMethod(host, "apply", {}, {
    ...fresh,
    "test -c /dev/kvm": fail(),
    [`${DPKG} *`]: ok("install ok installed\t1.0"),
    "id -nG taylor": ok("users libvirt kvm"),
  });
  assertEquals(state!.status, "failed");
  assertStringIncludes(error!.message, "VT-x");
});

Deno.test("host check on an unknown release asks for packages", async () => {
  const { state } = await runMethod(host, "check", {}, {
    ...fresh,
    "cat /etc/os-release": ok('ID=ubuntu\nVERSION_ID="22.04"'),
  });
  assertEquals(state!.status, "failed");
  assertStringIncludes(state!.error as string, "set packages");
});

Deno.test("pool apply defines, builds, starts and autostarts in order", async () => {
  const defined = (calls: string[]) =>
    ok(calls.some((c) => c.includes("pool-define-as")) ? "default" : "");
  const started = (calls: string[]) =>
    ok(
      `State: ${
        calls.some((c) => c.includes("pool-start")) ? "running" : "inactive"
      }\nAutostart: ${
        calls.some((c) => c.includes("pool-autostart")) ? "yes" : "no"
      }`,
    );
  const { state, calls } = await runMethod(pool, "apply", { name: "default" }, {
    hostname: ok("snuc"),
    [`${V} pool-list --all --name`]: defined,
    [`${V} pool-info default`]: started,
    [`${V} pool-dumpxml default`]: ok(
      "<pool type='dir'><target><path>/var/lib/libvirt/images</path></target></pool>",
    ),
    [`${V} pool-define-as *`]: ok(),
    [`${V} pool-build default`]: ok(),
    [`${V} pool-start default`]: ok(),
    [`${V} pool-autostart default`]: ok(),
  });
  assertEquals(state!.status, "applied");
  assertEquals(
    calls.filter((c) => /pool-(define-as|build|start|autostart)/.test(c))
      .map((c) => c.split(" ")[5]),
    ["pool-define-as", "pool-build", "pool-start", "pool-autostart"],
  );
  assertStringIncludes(
    calls.find((c) => c.includes("pool-define-as"))!,
    "--target /var/lib/libvirt/images",
  );
});

Deno.test("pool check reports a pool pointing elsewhere", async () => {
  const { state } = await runMethod(pool, "check", { name: "iso" }, {
    hostname: ok("snuc"),
    [`${V} pool-list --all --name`]: ok("iso"),
    [`${V} pool-info iso`]: ok("State: running\nAutostart: yes"),
    [`${V} pool-dumpxml iso`]: ok(
      "<pool type='dir'><target><path>/srv/iso</path></target></pool>",
    ),
  });
  assertEquals(state!.changes, [
    "redefine pool iso: wanted dir at /var/lib/libvirt/iso, found dir at /srv/iso",
  ]);
});

Deno.test("network apply defines a bridge network on the existing br0", async () => {
  const defined = (calls: string[]) =>
    ok(
      calls.some((c) => c.includes("net-define"))
        ? "default\nhost-network"
        : "default",
    );
  const { state, calls } = await runMethod(
    network,
    "apply",
    { name: "host-network", mode: "bridge", bridge: "br0" },
    {
      hostname: ok("snuc"),
      ...bridgedUplink,
      [`${V} net-list --all --name`]: defined,
      [`${V} net-info host-network`]: (c) =>
        ok(
          `Active: ${
            c.some((l) => l.includes("net-start")) ? "yes" : "no"
          }\nAutostart: ${
            c.some((l) => l.includes("net-autostart")) ? "yes" : "no"
          }`,
        ),
      [`${V} net-dumpxml --inactive host-network`]: ok(
        "<network><name>host-network</name><forward mode='bridge'/><bridge name='br0'/></network>",
      ),
      "mktemp -t libvirt-XXXXXX.xml": ok("/tmp/libvirt-abc.xml"),
      "sh -c *": ok(""),
      [`${V} net-define /tmp/libvirt-abc.xml`]: ok(),
      "rm -f /tmp/libvirt-abc.xml": ok(),
      [`${V} net-start host-network`]: ok(),
      [`${V} net-autostart host-network`]: ok(),
    },
  );
  assertEquals(state!.status, "applied");
  assertEquals(state!.mode, "bridge");
  const write = calls.find((c) => c.startsWith("sh -c printf"))!;
  assertStringIncludes(write, "<bridge name='br0'/>");
});

Deno.test("network refuses bridge mode on Wi-Fi before touching libvirt", async () => {
  const { state, calls, error } = await runMethod(
    network,
    "apply",
    { name: "host-network", mode: "macvtap", interface: "wlp0s20f3" },
    { hostname: ok("laptop"), ...wifiUplink },
  );
  assertEquals(state!.status, "failed");
  assertStringIncludes(error!.message, "is Wi-Fi");
  assert(!calls.some((c) => c.includes("virsh")));
});

Deno.test("network bridge mode needs the bridge to exist", async () => {
  const { error } = await runMethod(
    network,
    "check",
    { name: "host-network", mode: "bridge", bridge: "br1" },
    { hostname: ok("snuc"), ...bridgedUplink },
  );
  assertStringIncludes(error!.message, "create the bridge in netplan first");
});

Deno.test("uplink check fails a mode the host can't carry", async () => {
  const { state, error } = await runMethod(
    uplink,
    "check",
    { mode: "bridge" },
    {
      hostname: ok("laptop"),
      ...wifiUplink,
    },
  );
  assertEquals(state!.status, "failed");
  assertStringIncludes(error!.message, "use NAT");
});

Deno.test("uplink check passes NAT on Wi-Fi and records the advice", async () => {
  const { state } = await runMethod(uplink, "check", { mode: "nat" }, {
    hostname: ok("laptop"),
    ...wifiUplink,
  });
  assertEquals(state!.status, "compliant");
  assertEquals(
    (state!.advice as { recommended: string }).recommended,
    "nat",
  );
});

Deno.test("nodeHost sends every command through one ssh connection", async () => {
  const { calls, state } = await runMethod(
    host,
    "check",
    { nodeHost: "10.63.45.217", nodeUser: "taylor" },
    {
      "ssh *": (c) => {
        const line = c[c.length - 1].split(" -- taylor@10.63.45.217 ")[1]
          .replaceAll("'", "");
        const map: Record<string, string> = {
          hostname: "snuc",
          "cat /etc/os-release": 'ID=ubuntu\nVERSION_ID="26.04"',
          "id -un": "taylor",
          "id -nG taylor": "users libvirt kvm",
        };
        if (line.startsWith("dpkg-query")) return ok("install ok installed\t1");
        return line in map || line === "test -c /dev/kvm"
          ? ok(map[line] ?? "")
          : fail(`unexpected ${line}`);
      },
    },
  );
  assertEquals(state!.status, "compliant");
  assert(calls.every((c) => c.startsWith("ssh ")));
  assertStringIncludes(calls[0], "ControlMaster=auto");
});

Deno.test("a dropped SSH connection saves nothing", async () => {
  let n = 0;
  const { state, error } = await runMethod(
    host,
    "check",
    { nodeHost: "kvm1" },
    {
      "ssh *": () =>
        ++n === 1 ? ok("kvm1") : { code: 255, stdout: "", stderr: "reset" },
    },
  );
  assertEquals(state, undefined);
  assertStringIncludes(error!.message, "Lost the SSH connection to kvm1");
});

Deno.test("pool check before libvirt is installed says what apply would define", async () => {
  const { state } = await runMethod(pool, "check", { name: "iso" }, {
    hostname: ok("snuc"),
    [`${V} pool-list --all --name`]: fail("sudo: 'virsh': command not found"),
  });
  assertEquals(state!.status, "non_compliant");
  assertEquals(state!.changes, ["define pool iso at /var/lib/libvirt/iso"]);
});
