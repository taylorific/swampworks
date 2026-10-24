import {
  assert,
  assertEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.19";
import { parse } from "jsr:@std/yaml@1.2.0";
import { metaData, userData } from "./_lib/cloudinit.ts";
import { fail, ok, runMethod } from "./_lib/fake_test_helpers.ts";
import {
  imageUrl,
  model as vm,
  parseDomifaddr,
  parseDomiflist,
  parseVersion,
  sumFor,
  virtInstallSeeds,
} from "./libvirt_vm.ts";

const V = "sudo -n virsh -c qemu:///system";
const SHA = "a".repeat(64);
const IMG = "resolute-server-cloudimg-amd64.img";
const URL = `https://cloud-images.ubuntu.com/resolute/current/${IMG}`;

const DOMIFADDR = ` Name       MAC address          Protocol     Address
-------------------------------------------------------------------------------
 lo         00:00:00:00:00:00    ipv4         127.0.0.1/8
 enp1s0     52:54:00:6b:3c:58    ipv4         192.0.2.40/24
 -          -                    ipv6         fe80::5054:ff:fe6b:3c58/64`;

const DOMIFLIST = ` Interface   Type      Source         Model    MAC
---------------------------------------------------------------
 vnet0       network   host-network   virtio   52:54:00:6b:3c:58`;

Deno.test("parse helpers read virsh's tables", () => {
  assertEquals(parseDomifaddr(DOMIFADDR), "192.0.2.40");
  assertEquals(parseDomifaddr(""), null);
  assertEquals(parseDomiflist(DOMIFLIST), {
    network: "host-network",
    mac: "52:54:00:6b:3c:58",
  });
});

Deno.test("virt-install builds the seed itself only after 4.1.0", () => {
  assertEquals(virtInstallSeeds(parseVersion("5.1.0")), true);
  assertEquals(virtInstallSeeds(parseVersion("4.1.1")), true);
  assertEquals(virtInstallSeeds(parseVersion("4.1.0")), false);
  assertEquals(virtInstallSeeds(parseVersion("4.0.0")), false);
});

Deno.test("imageUrl maps release and architecture to the cloud image", () => {
  const g = vm.globalArguments.parse({ name: "u1" });
  assertEquals(imageUrl(g, "x86_64"), URL);
  assertEquals(
    imageUrl({ ...g, release: "24.04" }, "aarch64"),
    "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-arm64.img",
  );
});

Deno.test("sumFor reads SHA256SUMS with and without the binary marker", () => {
  const sums = `${"b".repeat(64)} *other.img\n${SHA} *${IMG}\n`;
  assertEquals(sumFor(sums, IMG), SHA);
  assertEquals(sumFor(`${SHA}  ${IMG}`, IMG), SHA);
  assertEquals(sumFor(sums, "missing.img"), null);
});

Deno.test("user-data adds keys, an optional password and the guest agent", () => {
  const ud = userData({
    hostname: "u1",
    sshAuthorizedKeys: ["ssh-ed25519 AAAA me"],
    packages: ["htop", "qemu-guest-agent"],
  });
  assert(ud.startsWith("#cloud-config\n"));
  const c = parse(ud) as Record<string, unknown>;
  assertEquals(c.ssh_authorized_keys, ["ssh-ed25519 AAAA me"]);
  assertEquals(c.packages, ["qemu-guest-agent", "htop"]);
  assertEquals(c.ssh_pwauth, undefined);
  const withPw = parse(
    userData({
      hostname: "u1",
      sshAuthorizedKeys: [],
      password: "s3",
      packages: [],
    }),
  ) as Record<string, unknown>;
  assertEquals(withPw.ssh_pwauth, true);
  assertEquals(parse(metaData("u1")), {
    "instance-id": "u1",
    "local-hostname": "u1",
  });
});

const base = {
  hostname: ok("pxe"),
  "uname -m": ok("x86_64"),
  [`curl -fsSL --retry 3 https://cloud-images.ubuntu.com/resolute/current/SHA256SUMS`]:
    ok(`${SHA} *${IMG}`),
  [`sudo -n sha256sum /var/lib/libvirt/cloud-images/${IMG}`]: ok(
    `${SHA}  /var/lib/libvirt/cloud-images/${IMG}`,
  ),
  [`${V} pool-dumpxml default`]: ok(
    "<pool type='dir'><target><path>/var/lib/libvirt/images</path></target></pool>",
  ),
  "sudo -n test -e /var/lib/libvirt/images/u1.qcow2": fail(),
  "sudo -n qemu-img *": ok(),
  [`${V} pool-refresh default`]: ok(),
  "mktemp -t libvirt-XXXXXX.user-data": ok("/tmp/libvirt-a.user-data"),
  "mktemp -t libvirt-XXXXXX.meta-data": ok("/tmp/libvirt-b.meta-data"),
  "sh -c *": ok(""),
  "rm -f /tmp/libvirt-a.user-data /tmp/libvirt-b.meta-data": ok(),
  "virt-install --version": ok("5.1.0"),
  "sudo -n virt-install *": ok(),
  "sudo -n chmod 600 /var/lib/libvirt/boot/u1-cloud-init.iso": ok(),
  [`${V} dominfo u1`]: ok("State: running\nCPU(s): 2\nMax memory: 2097152 KiB"),
  [`${V} domiflist u1`]: ok(DOMIFLIST),
  [`${V} domifaddr u1 --source agent`]: ok(DOMIFADDR),
};

/** VM u1 appears once virt-install has run. */
const listed = (calls: string[]) =>
  ok(
    calls.some((c) => c.startsWith("sudo -n virt-install --connect"))
      ? "u1"
      : "",
  );

Deno.test("vm check before it exists says what apply would create", async () => {
  const { state } = await runMethod(vm, "check", { name: "u1" }, {
    hostname: ok("pxe"),
    [`${V} list --all --name`]: ok(""),
  });
  assertEquals(state!.status, "non_compliant");
  assertStringIncludes(
    (state!.changes as string[])[0],
    "create vm u1: Ubuntu 26.04",
  );
});

Deno.test("vm apply uses the cached image, virt-install's seed, and waits for the IP", async () => {
  const { state, calls } = await runMethod(
    vm,
    "apply",
    {
      name: "u1",
      network: "host-network",
      sshAuthorizedKeys: ["ssh-ed25519 AAAA me"],
    },
    { ...base, [`${V} list --all --name`]: listed },
  );
  assertEquals(state!.status, "applied");
  assertEquals(state!.ip, "192.0.2.40");
  assert(
    !calls.some((c) => c.includes("curl -fsSL --retry 3 -o")),
    "cache hit",
  );
  const install = calls.find((c) =>
    c.startsWith("sudo -n virt-install --connect")
  )!;
  assertStringIncludes(
    install,
    "--cloud-init user-data=/tmp/libvirt-a.user-data,meta-data=/tmp/libvirt-b.meta-data,disable=on",
  );
  assertStringIncludes(install, "--network network=host-network,model=virtio");
  assertStringIncludes(install, "--boot uefi");
  assertStringIncludes(
    calls.find((c) => c.includes("qemu-img resize"))!,
    "/var/lib/libvirt/images/u1.qcow2 32G",
  );
});

Deno.test("vm apply on old virt-install builds a cidata seed ISO", async () => {
  const { calls } = await runMethod(vm, "apply", { name: "u1" }, {
    ...base,
    [`${V} list --all --name`]: listed,
    "virt-install --version": ok("4.1.0"),
    "sudo -n mkdir -p /var/lib/libvirt/boot": ok(),
    "sudo -n genisoimage *": ok(),
  });
  const iso = calls.find((c) => c.startsWith("sudo -n genisoimage"))!;
  assertStringIncludes(iso, "-volid cidata");
  assertStringIncludes(
    iso,
    "user-data=/tmp/libvirt-a.user-data meta-data=/tmp/libvirt-b.meta-data",
  );
  assertStringIncludes(
    calls.find((c) => c.startsWith("sudo -n virt-install --connect"))!,
    "--disk /var/lib/libvirt/boot/u1-cloud-init.iso,device=cdrom",
  );
});

Deno.test("vm apply downloads and verifies an image that isn't cached", async () => {
  let downloaded = false;
  const { calls, error } = await runMethod(vm, "apply", { name: "u1" }, {
    ...base,
    [`${V} list --all --name`]: listed,
    [`sudo -n sha256sum /var/lib/libvirt/cloud-images/${IMG}`]: fail(),
    "sudo -n mkdir -p /var/lib/libvirt/cloud-images": ok(),
    "sudo -n curl *": () => {
      downloaded = true;
      return ok();
    },
    [`sudo -n sha256sum /var/lib/libvirt/cloud-images/${IMG}.part`]: ok(
      `${"c".repeat(64)}  x`,
    ),
    "sudo -n rm -f *": ok(),
  });
  assert(downloaded);
  assertStringIncludes(error!.message, "expected " + SHA);
  assert(!calls.some((c) => c.includes("virt-install --connect")));
});

Deno.test("vm apply won't rebuild a VM whose memory differs", async () => {
  const { state, error, calls } = await runMethod(vm, "apply", {
    name: "u1",
    memory: 4096,
  }, {
    ...base,
    [`${V} list --all --name`]: ok("u1"),
  });
  assertEquals(state!.status, "failed");
  assertStringIncludes(error!.message, "memory: wanted 4096 MiB, found 2048");
  assert(!calls.some((c) => c.includes("undefine")));
});

Deno.test("vm apply with ensure absent removes it with its storage", async () => {
  const { state, calls } = await runMethod(vm, "apply", {
    name: "u1",
    ensure: "absent",
  }, {
    ...base,
    [`${V} list --all --name`]: (c) =>
      ok(c.some((l) => l.includes("undefine")) ? "" : "u1"),
    [`${V} dominfo u1`]: ok(
      "State: shut off\nCPU(s): 2\nMax memory: 2097152 KiB",
    ),
    [`${V} undefine u1 --nvram --remove-all-storage --snapshots-metadata`]:
      ok(),
    "sudo -n rm -f /var/lib/libvirt/boot/u1-cloud-init.iso": ok(),
  });
  assertEquals(state!.status, "applied");
  assertEquals(state!.exists, false);
  assert(calls.some((c) => c.includes("--remove-all-storage")));
});

Deno.test("snapshot saves the VM's snapshot list", async () => {
  const { state } = await runMethod(vm, "snapshot", { name: "u1" }, {
    hostname: ok("pxe"),
    [`${V} domstate u1`]: ok("running"),
    [`${V} snapshot-create-as --domain u1 --name clean --description Initial install --disk-only --atomic --quiesce`]:
      ok(),
    [`${V} snapshot-list u1 --name`]: ok("clean\n"),
    [`${V} snapshot-current u1 --name`]: ok("clean"),
  });
  assertEquals(state, {
    ...state,
    vm: "u1",
    snapshots: ["clean"],
    current: "clean",
  });
});

Deno.test("revert starts a VM that was running, since disk-only reverts shut it off", async () => {
  const { calls } = await runMethod(vm, "revert", { name: "u1" }, {
    hostname: ok("pxe"),
    [`${V} domstate u1`]: (c) =>
      ok(c.some((l) => l.includes("snapshot-revert")) ? "shut off" : "running"),
    [`${V} snapshot-revert u1 clean`]: ok(),
    [`${V} start u1`]: ok(),
    [`${V} snapshot-list u1 --name`]: ok("clean"),
    [`${V} snapshot-current u1 --name`]: ok("clean"),
  });
  assert(calls.some((c) => c.endsWith("start u1")));
});

Deno.test("the password reaches the host on stdin, never in a command line", async () => {
  const { calls, inputs } = await runMethod(
    vm,
    "apply",
    { name: "u1", password: "s3cr3t-pw" },
    { ...base, [`${V} list --all --name`]: listed },
  );
  assert(!calls.some((c) => c.includes("s3cr3t-pw")));
  assertStringIncludes(
    inputs['sh -c cat > "$1" sh /tmp/libvirt-a.user-data'],
    "password: s3cr3t-pw",
  );
});

Deno.test("a seed ISO is readable only by root", async () => {
  const { calls } = await runMethod(vm, "apply", {
    name: "u1",
    cloudInit: "seed-iso",
  }, {
    ...base,
    [`${V} list --all --name`]: listed,
    "sudo -n mkdir -p /var/lib/libvirt/boot": ok(),
    "sh -c command -v genisoimage": fail(),
    "sudo -n xorriso *": ok(),
  });
  const iso = calls.findIndex((c) =>
    c.startsWith("sudo -n xorriso -as mkisofs")
  );
  const chmod = calls.indexOf(
    "sudo -n chmod 600 /var/lib/libvirt/boot/u1-cloud-init.iso",
  );
  assert(iso >= 0 && chmod > iso);
});

Deno.test("a failed virt-install removes the disk and seed it made", async () => {
  const { state, calls, error } = await runMethod(
    vm,
    "apply",
    { name: "u1", cloudInit: "seed-iso" },
    {
      ...base,
      [`${V} list --all --name`]: ok(""),
      "sudo -n mkdir -p /var/lib/libvirt/boot": ok(),
      "sudo -n genisoimage *": ok(),
      "sudo -n virt-install *": fail("ERROR    Network not found"),
      "sudo -n rm -f /var/lib/libvirt/images/u1.qcow2 /var/lib/libvirt/boot/u1-cloud-init.iso":
        ok(),
    },
  );
  assertEquals(state!.status, "failed");
  assertStringIncludes(error!.message, "Network not found");
  assert(calls.includes(
    "sudo -n rm -f /var/lib/libvirt/images/u1.qcow2 /var/lib/libvirt/boot/u1-cloud-init.iso",
  ));
});
