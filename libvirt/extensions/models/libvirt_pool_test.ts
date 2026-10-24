import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import { fail, ok, runMethod } from "./_lib/fake_test_helpers.ts";
import { V } from "./_lib/fixtures_test_helpers.ts";
import { model as pool } from "./libvirt_pool.ts";

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

Deno.test("pool check before libvirt is installed says what apply would define", async () => {
  const { state } = await runMethod(pool, "check", { name: "iso" }, {
    hostname: ok("snuc"),
    [`${V} pool-list --all --name`]: fail("sudo: 'virsh': command not found"),
  });
  assertEquals(state!.status, "non_compliant");
  assertEquals(state!.changes, ["define pool iso at /var/lib/libvirt/iso"]);
});
