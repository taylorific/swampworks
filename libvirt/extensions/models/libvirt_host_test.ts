import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { fail, ok, runMethod } from "./_lib/fake_test_helpers.ts";
import { DPKG, fresh } from "./_lib/fixtures_test_helpers.ts";
import { model as host } from "./libvirt_host.ts";

Deno.test("host check lists what's missing and changes nothing", async () => {
  const { state, name, calls } = await runMethod(host, "check", {}, fresh);
  assertEquals(name, "snuc");
  assertEquals(state!.status, "non_compliant");
  assertEquals(state!.changes, [
    "install qemu-system-hwe",
    "install libvirt-daemon-system-hwe",
    "install virtinst",
    "install ca-certificates",
    "install curl",
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
    "sudo -n env DEBIAN_FRONTEND=noninteractive apt-get install -y -q qemu-system-hwe libvirt-daemon-system-hwe virtinst ca-certificates curl":
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

Deno.test("nodeHost sends every command through one ssh connection", async () => {
  const { calls, state } = await runMethod(
    host,
    "check",
    { nodeHost: "kvm1.example.com", nodeUser: "admin" },
    {
      "ssh *": (c) => {
        const line = c[c.length - 1].split(" -- admin@kvm1.example.com ")[1]
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
