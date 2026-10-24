import { z } from "npm:zod@4";
import { metaData, userData } from "./_lib/cloudinit.ts";
import {
  type Context,
  converge,
  type Resource,
  type Seams,
  StateBaseSchema,
  withSession,
} from "./_lib/converge.ts";
import { check, ConnectionSchema, type Session } from "./_lib/runner.ts";
import { parseInfo, parsePoolTarget, writeTemp } from "./_lib/virsh.ts";

// An Ubuntu Server guest made the way the kvm-training deck makes one: the
// release's cloud image, checked against Ubuntu's SHA256SUMS and cached on
// the host, copied into a storage pool and resized, then imported with
// virt-install and configured on first boot by cloud-init. user-data adds
// the SSH keys and qemu-guest-agent, which is how the host learns the
// guest's address. virt-install builds the cloud-init seed itself where it
// can (newer than 4.1.0, so Ubuntu 26.04); on 24.04 the seed is a cidata
// ISO made with genisoimage or xorriso, as in the deck's legacy method.
//
// Snapshots are external and disk-only: a UEFI guest's NVRAM is raw, and
// libvirt refuses internal snapshots of pflash firmware unless the NVRAM is
// QCOW2, which Ubuntu's OVMF doesn't ship. The guest agent quiesces the
// filesystems while the snapshot is taken.
//
// `apply` creates a missing VM and starts a stopped one, then waits for the
// guest agent to report an address. It never rebuilds a VM whose memory,
// CPUs or network differ: `check` reports that, and `ensure: absent` then
// `present` rebuilds it. Removing shuts the guest down and undefines it with
// its NVRAM and storage.

/** Ubuntu releases whose cloud images the type knows, by codename. */
export const RELEASES: Record<string, string> = {
  "24.04": "noble",
  "26.04": "resolute",
};

/** Where cloud images are cached on the host. */
export const IMAGE_CACHE = "/var/lib/libvirt/cloud-images";
/** Where seed ISOs go when virt-install can't build one. */
export const SEED_DIR = "/var/lib/libvirt/boot";

const GlobalArgsSchema = ConnectionSchema.extend({
  name: z.string().regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/).describe(
    "VM name, also its hostname",
  ),
  ensure: z.enum(["present", "absent"]).default("present"),
  running: z.boolean().default(true).describe(
    "Keep the VM running; apply starts it",
  ),
  release: z.enum(["24.04", "26.04"]).default("26.04").describe(
    "Ubuntu Server release for the cloud image",
  ),
  imageUrl: z.string().url().optional().describe(
    "Cloud image to use instead of cloud-images.ubuntu.com's, e.g. from a mirror; its directory must have SHA256SUMS unless imageSha256 is set",
  ),
  imageSha256: z.string().regex(/^[0-9a-f]{64}$/).optional().describe(
    "Pin the image's SHA-256 instead of reading SHA256SUMS",
  ),
  pool: z.string().default("default").describe(
    "Storage pool the disk goes in",
  ),
  diskSize: z.string().regex(/^\d+[MGT]$/).default("32G"),
  memory: z.number().int().min(256).default(2048).describe("Memory in MiB"),
  vcpus: z.number().int().min(1).default(2),
  network: z.string().default("default").describe(
    "libvirt network the VM attaches to",
  ),
  osVariant: z.string().default("ubuntu-lts-latest"),
  sshAuthorizedKeys: z.array(z.string().min(1)).default([]).describe(
    "Public keys for the ubuntu user",
  ),
  password: z.string().optional().meta({ sensitive: true }).describe(
    "Password for the ubuntu user, with SSH password logins on; better from a vault",
  ),
  packages: z.array(z.string()).default([]).describe(
    "More packages for cloud-init to install; qemu-guest-agent is always added",
  ),
  cloudInit: z.enum(["auto", "virt-install", "seed-iso"]).default("auto")
    .describe(
      "How the seed reaches the guest: virt-install --cloud-init (newer than 4.1.0), or a cidata ISO; auto picks by version",
    ),
  waitForIp: z.boolean().default(true).describe(
    "After starting the VM, wait for the guest agent to report an address",
  ),
  timeoutSeconds: z.number().int().positive().default(900),
  uri: z.string().default("qemu:///system"),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = StateBaseSchema.extend({
  name: z.string().optional(),
  exists: z.boolean().optional(),
  state: z.string().nullable().optional(),
  memory: z.number().nullable().optional(),
  vcpus: z.number().nullable().optional(),
  network: z.string().nullable().optional(),
  mac: z.string().nullable().optional(),
  ip: z.string().nullable().optional().describe(
    "IPv4 address from the guest agent",
  ),
});

const SnapshotsSchema = z.object({
  vm: z.string(),
  snapshots: z.array(z.string()),
  current: z.string().nullable(),
  host: z.string(),
  checkedAt: z.string(),
});

/** A VM as virsh describes it. */
export interface VmState {
  name: string;
  exists: boolean;
  state: string | null;
  memory: number | null;
  vcpus: number | null;
  network: string | null;
  mac: string | null;
  ip: string | null;
}

/** The cloud image's URL for a release on the host's architecture. */
export function imageUrl(g: GlobalArgs, arch: string): string {
  if (g.imageUrl) return g.imageUrl;
  const deb = arch === "aarch64" ? "arm64" : arch === "x86_64" ? "amd64" : arch;
  const code = RELEASES[g.release];
  return `https://cloud-images.ubuntu.com/${code}/current/${code}-server-cloudimg-${deb}.img`;
}

/** A file's SHA-256 from a SHA256SUMS listing. */
export function sumFor(sums: string, file: string): string | null {
  for (const line of sums.split("\n")) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (m && m[2] === file) return m[1];
  }
  return null;
}

/** The first non-loopback IPv4 address in `virsh domifaddr` output. */
export function parseDomifaddr(out: string): string | null {
  for (const line of out.split("\n")) {
    const m = line.match(/\sipv4\s+(\d+\.\d+\.\d+\.\d+)\/\d+/);
    if (m && !m[1].startsWith("127.")) return m[1];
  }
  return null;
}

/** The first interface's network and MAC from `virsh domiflist`. */
export function parseDomiflist(
  out: string,
): { network: string | null; mac: string | null } {
  for (const line of out.split("\n").slice(2)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length >= 5) return { network: cols[2], mac: cols[4] };
  }
  return { network: null, mac: null };
}

/** virt-install's version, e.g. [5, 1, 0]. */
export function parseVersion(out: string): number[] {
  return (out.match(/\d+(\.\d+)*/)?.[0] ?? "0").split(".").map(Number);
}

/** Whether virt-install can build a cloud-init seed: newer than 4.1.0. */
export function virtInstallSeeds(version: number[]): boolean {
  const [a = 0, b = 0, c = 0] = version;
  return a > 4 || (a === 4 && (b > 1 || (b === 1 && c > 0)));
}

function memoryMiB(info: Record<string, string>): number | null {
  const m = info["max memory"]?.match(/^(\d+)\s*KiB/);
  return m ? Math.round(Number(m[1]) / 1024) : null;
}

async function readVm(s: Session, g: GlobalArgs): Promise<VmState> {
  const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
  const list = await virsh("list", "--all", "--name");
  const none: VmState = {
    name: g.name,
    exists: false,
    state: null,
    memory: null,
    vcpus: null,
    network: null,
    mac: null,
    ip: null,
  };
  if (list.code === 127 || /virsh'?: command not found/.test(list.stderr)) {
    return none;
  }
  check(list, "virsh list");
  if (!list.stdout.split("\n").map((l) => l.trim()).includes(g.name)) {
    return none;
  }
  const info = parseInfo(
    check(await virsh("dominfo", g.name), "dominfo").stdout,
  );
  const nic = parseDomiflist(
    check(await virsh("domiflist", g.name), "domiflist").stdout,
  );
  const state = info.state ?? null;
  // The agent answers only once the guest has booted and installed it.
  const addr = state === "running"
    ? await virsh("domifaddr", g.name, "--source", "agent")
    : null;
  return {
    name: g.name,
    exists: true,
    state,
    memory: memoryMiB(info),
    vcpus: info["cpu(s)"] ? Number(info["cpu(s)"]) : null,
    network: nic.network,
    mac: nic.mac,
    ip: addr?.code === 0 ? parseDomifaddr(addr.stdout) : null,
  };
}

/** Differences apply won't fix on an existing VM. */
function rebuildChanges(v: VmState, g: GlobalArgs): string[] {
  const out: string[] = [];
  const hint = "remove the VM (ensure: absent) and apply again to rebuild it";
  if (v.memory !== null && v.memory !== g.memory) {
    out.push(`memory: wanted ${g.memory} MiB, found ${v.memory}; ${hint}`);
  }
  if (v.vcpus !== null && v.vcpus !== g.vcpus) {
    out.push(`vcpus: wanted ${g.vcpus}, found ${v.vcpus}; ${hint}`);
  }
  if (v.network !== null && v.network !== g.network) {
    out.push(`network: wanted ${g.network}, found ${v.network}; ${hint}`);
  }
  return out;
}

/** Downloads the cloud image into the cache unless a verified copy is there. */
async function cachedImage(s: Session, g: GlobalArgs): Promise<string> {
  const arch = check(await s.run("uname", ["-m"]), "uname -m").stdout.trim();
  const url = imageUrl(g, arch);
  const file = url.split("/").pop()!;
  let want = g.imageSha256 ?? null;
  if (!want) {
    const sumsUrl = url.slice(0, url.lastIndexOf("/") + 1) + "SHA256SUMS";
    const sums = check(
      await s.run("curl", ["-fsSL", "--retry", "3", sumsUrl]),
      `Fetching ${sumsUrl}`,
    );
    want = sumFor(sums.stdout, file);
    if (!want) throw new Error(`${sumsUrl} doesn't list ${file}`);
  }
  const path = `${IMAGE_CACHE}/${file}`;
  const sha = async (p: string) =>
    (await s.sudo("sha256sum", [p])).stdout.split(/\s+/)[0] ?? "";
  if ((await sha(path)) === want) return path;
  check(await s.sudo("mkdir", ["-p", IMAGE_CACHE]), `mkdir ${IMAGE_CACHE}`);
  const part = `${path}.part`;
  check(
    await s.sudo("curl", ["-fsSL", "--retry", "3", "-o", part, url]),
    `Downloading ${url}`,
  );
  const got = await sha(part);
  if (got !== want) {
    await s.sudo("rm", ["-f", part]);
    throw new Error(`${url} has SHA-256 ${got}, expected ${want}`);
  }
  check(await s.sudo("mv", ["-f", part, path]), `mv ${part}`);
  return path;
}

async function waitForIp(s: Session, g: GlobalArgs): Promise<string> {
  const deadline = Date.now() + g.timeoutSeconds * 1000;
  while (Date.now() < deadline) {
    const r = await s.sudo("virsh", [
      "-c",
      g.uri,
      "domifaddr",
      g.name,
      "--source",
      "agent",
    ]);
    const ip = r.code === 0 ? parseDomifaddr(r.stdout) : null;
    if (ip) return ip;
    await new Promise((res) => setTimeout(res, 5000));
  }
  throw new Error(
    `${g.name} didn't report an address through qemu-guest-agent within ${g.timeoutSeconds}s; see virsh console ${g.name}`,
  );
}

async function createVm(s: Session, g: GlobalArgs): Promise<void> {
  const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
  const image = await cachedImage(s, g);
  const target = parsePoolTarget(
    check(await virsh("pool-dumpxml", g.pool), `pool ${g.pool}`).stdout,
  );
  if (!target) throw new Error(`pool ${g.pool} has no target directory`);
  const disk = `${target}/${g.name}.qcow2`;
  if ((await s.sudo("test", ["-e", disk])).code === 0) {
    throw new Error(
      `${disk} already exists but no VM ${g.name} does; move or delete it first`,
    );
  }
  check(
    await s.sudo("qemu-img", [
      "convert",
      "-f",
      "qcow2",
      "-O",
      "qcow2",
      image,
      disk,
    ]),
    "qemu-img convert",
  );
  check(
    await s.sudo("qemu-img", ["resize", "-f", "qcow2", disk, g.diskSize]),
    "qemu-img resize",
  );
  await virsh("pool-refresh", g.pool);

  const user = await writeTemp(
    s,
    userData({
      hostname: g.name,
      sshAuthorizedKeys: g.sshAuthorizedKeys,
      password: g.password,
      packages: g.packages,
    }),
    ".user-data",
  );
  const meta = await writeTemp(s, metaData(g.name), ".meta-data");
  try {
    let mode = g.cloudInit;
    if (mode === "auto") {
      const v = await s.run("virt-install", ["--version"]);
      mode = virtInstallSeeds(parseVersion(v.stdout))
        ? "virt-install"
        : "seed-iso";
    }
    const seed: string[] = [];
    if (mode === "virt-install") {
      seed.push(
        "--cloud-init",
        `user-data=${user},meta-data=${meta},disable=on`,
      );
    } else {
      const iso = `${SEED_DIR}/${g.name}-cloud-init.iso`;
      const tool =
        (await s.run("sh", ["-c", "command -v genisoimage"])).code ===
            0
          ? ["genisoimage"]
          : ["xorriso", "-as", "mkisofs"];
      check(await s.sudo("mkdir", ["-p", SEED_DIR]), `mkdir ${SEED_DIR}`);
      check(
        await s.sudo(tool[0], [
          ...tool.slice(1),
          "-output",
          iso,
          "-volid",
          "cidata",
          "-joliet",
          "-rock",
          "-graft-points",
          `user-data=${user}`,
          `meta-data=${meta}`,
        ]),
        "Building the cloud-init seed ISO",
      );
      seed.push("--disk", `${iso},device=cdrom`);
    }
    check(
      await s.sudo("virt-install", [
        "--connect",
        g.uri,
        "--name",
        g.name,
        "--boot",
        "uefi",
        "--memory",
        String(g.memory),
        "--vcpus",
        String(g.vcpus),
        "--os-variant",
        g.osVariant,
        "--disk",
        `${disk},bus=virtio`,
        ...seed,
        "--network",
        `network=${g.network},model=virtio`,
        "--graphics",
        "spice",
        "--noautoconsole",
        "--console",
        "pty,target_type=serial",
        "--import",
      ]),
      "virt-install",
    );
  } finally {
    await s.run("rm", ["-f", user, meta]);
  }
}

async function removeVm(s: Session, g: GlobalArgs, v: VmState): Promise<void> {
  const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
  if (v.state === "running") {
    // Ask the guest to shut down, and pull the plug if it hasn't in a minute.
    await virsh("shutdown", g.name);
    for (let i = 0; i < 12; i++) {
      await new Promise((res) => setTimeout(res, 5000));
      const st = await virsh("domstate", g.name);
      if (st.stdout.trim() !== "running") break;
    }
    const st = await virsh("domstate", g.name);
    if (st.stdout.trim() === "running") {
      check(await virsh("destroy", g.name), "virsh destroy");
    }
  }
  check(
    await virsh(
      "undefine",
      g.name,
      "--nvram",
      "--remove-all-storage",
      "--snapshots-metadata",
    ),
    "virsh undefine",
  );
  await s.sudo("rm", ["-f", `${SEED_DIR}/${g.name}-cloud-init.iso`]);
}

/** One VM. */
export const vmResource: Resource<GlobalArgs, VmState> = {
  label: (g) => `vm ${g.name}`,
  read: readVm,
  diff(v, g) {
    if (g.ensure === "absent") {
      return v.exists ? [`remove vm ${g.name} and its storage`] : [];
    }
    if (!v.exists) {
      return [
        `create vm ${g.name}: Ubuntu ${g.release}, ${g.vcpus} vCPU, ${g.memory} MiB, ${g.diskSize} disk in pool ${g.pool}, network ${g.network}`,
      ];
    }
    const changes = rebuildChanges(v, g);
    if (g.running && v.state !== "running") changes.push(`start vm ${g.name}`);
    if (!g.running && v.state === "running") {
      changes.push(`shut down vm ${g.name}`);
    }
    return changes;
  },
  async apply(s, g, v) {
    if (g.ensure === "absent") return await removeVm(s, g, v);
    if (v.exists) {
      const rebuild = rebuildChanges(v, g);
      if (rebuild.length) throw new Error(rebuild.join("; "));
    } else {
      await createVm(s, g);
    }
    const now = await readVm(s, g);
    const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
    if (g.running && now.state !== "running") {
      check(await virsh("start", g.name), "virsh start");
    }
    if (!g.running && now.state === "running") {
      check(await virsh("shutdown", g.name), "virsh shutdown");
      return;
    }
    if (g.running && g.waitForIp) await waitForIp(s, g);
  },
  details: (v) => ({ ...v }),
  notes(v) {
    return v.ip ? [`${v.name} is at ${v.ip}; ssh ubuntu@${v.ip}`] : [];
  },
};

const SnapshotArgsSchema = z.object({
  snapshot: z.string().regex(/^[A-Za-z0-9_.-]+$/).default("clean"),
  description: z.string().default("Initial install"),
});

async function saveSnapshots(
  s: Session,
  g: GlobalArgs,
  context: Context<GlobalArgs>,
) {
  const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
  const names = check(
    await virsh("snapshot-list", g.name, "--name"),
    "snapshot-list",
  ).stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  const cur = await virsh("snapshot-current", g.name, "--name");
  const handle = await context.writeResource("snapshots", s.host, {
    vm: g.name,
    snapshots: names,
    current: cur.code === 0 ? cur.stdout.trim() || null : null,
    host: s.host,
    checkedAt: new Date().toISOString(),
  });
  return { dataHandles: [handle] };
}

function snapshotMethod(
  description: string,
  action: (
    virsh: (...a: string[]) => ReturnType<Session["run"]>,
    g: GlobalArgs,
    a: z.infer<typeof SnapshotArgsSchema>,
  ) => Promise<unknown>,
) {
  return {
    description,
    arguments: SnapshotArgsSchema,
    execute: (
      args: z.infer<typeof SnapshotArgsSchema> & Seams,
      context: Context<GlobalArgs>,
    ) =>
      withSession(context.globalArgs, args, async (s) => {
        const g = context.globalArgs;
        const virsh = (...a: string[]) => s.sudo("virsh", ["-c", g.uri, ...a]);
        await action(virsh, g, SnapshotArgsSchema.parse(args));
        return saveSnapshots(s, g, context);
      }),
  };
}

/** The libvirt VM behavior. */
export const model = {
  type: "@taylor/libvirt/vm",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    state: {
      description:
        "The VM's state, memory, CPUs, network, MAC and address, and whether they match",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
    snapshots: {
      description: "The VM's snapshots and the current one",
      schema: SnapshotsSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read the VM and save what apply would change; changes nothing",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("check", vmResource, args, context),
    },
    apply: {
      description:
        "Create the VM from the cloud image, or start it, and wait for its address; with ensure: absent shut it down and remove it with its storage",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("apply", vmResource, args, context),
    },
    snapshot: snapshotMethod(
      "Take an external, disk-only snapshot (virsh snapshot-create-as --disk-only), quiesced through the guest agent when the VM is running",
      async (virsh, g, a) => {
        const running =
          (await virsh("domstate", g.name)).stdout.trim() === "running";
        check(
          await virsh(
            "snapshot-create-as",
            "--domain",
            g.name,
            "--name",
            a.snapshot,
            "--description",
            a.description,
            "--disk-only",
            "--atomic",
            ...(running ? ["--quiesce"] : []),
          ),
          "snapshot-create-as",
        );
      },
    ),
    revert: snapshotMethod(
      "Revert to a snapshot (virsh snapshot-revert), starting the VM again if it was running",
      async (virsh, g, a) => {
        const running =
          (await virsh("domstate", g.name)).stdout.trim() === "running";
        check(
          await virsh("snapshot-revert", g.name, a.snapshot),
          "snapshot-revert",
        );
        // A disk-only snapshot has no memory to resume, so the VM comes
        // back shut off.
        const now = (await virsh("domstate", g.name)).stdout.trim();
        if (running && now !== "running") {
          check(await virsh("start", g.name), "virsh start");
        }
      },
    ),
    deleteSnapshot: snapshotMethod(
      "Delete a snapshot (virsh snapshot-delete)",
      async (virsh, g, a) =>
        check(
          await virsh("snapshot-delete", g.name, a.snapshot),
          "snapshot-delete",
        ),
    ),
  },
};
