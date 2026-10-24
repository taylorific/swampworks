import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { ok, runMethod } from "./_lib/fake_test_helpers.ts";
import { bridgedUplink, V, wifiUplink } from "./_lib/fixtures_test_helpers.ts";
import { model as network } from "./libvirt_network.ts";

Deno.test("network apply defines a bridge network on the existing br0", async () => {
  const defined = (calls: string[]) =>
    ok(
      calls.some((c) => c.includes("net-define"))
        ? "default\nhost-network"
        : "default",
    );
  const { state, inputs } = await runMethod(
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
  // The XML goes to the temp file over stdin.
  const xml = inputs['sh -c cat > "$1" sh /tmp/libvirt-abc.xml'];
  assertStringIncludes(xml, "<bridge name='br0'/>");
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
