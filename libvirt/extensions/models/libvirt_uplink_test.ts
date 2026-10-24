import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { ok, runMethod } from "./_lib/fake_test_helpers.ts";
import { wifiUplink } from "./_lib/fixtures_test_helpers.ts";
import { model as uplink } from "./libvirt_uplink.ts";

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
