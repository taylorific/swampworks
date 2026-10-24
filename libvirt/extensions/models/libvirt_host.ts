import { z } from "npm:zod@4";
import {
  type Context,
  converge,
  type Resource,
  type Seams,
  StateBaseSchema,
} from "./_lib/converge.ts";
import {
  check,
  connectionChecks,
  ConnectionSchema,
  type Session,
} from "./_lib/runner.ts";

// An Ubuntu host ready to run KVM/QEMU guests with libvirt, as the
// kvm-training deck sets it up: the QEMU, libvirt and virtinst packages for
// the release (the -hwe ones on 26.04) and the user in the libvirt and kvm
// groups. Group membership is only ever added: unlike a user's full group
// list, it can't take the user out of sudo. `check` reads the host and
// `apply` installs what's missing; neither touches networks or pools, which
// are their own types.

/**
 * Packages the deck installs, by Ubuntu release: QEMU, libvirt and
 * virtinst, curl for cloud images, and on 24.04 genisoimage, since its
 * virt-install can't build a cloud-init seed itself.
 */
export const PACKAGES: Record<string, string[]> = {
  "24.04": [
    "qemu-kvm",
    "libvirt-daemon-system",
    "virtinst",
    "ca-certificates",
    "curl",
    "genisoimage",
  ],
  "26.04": [
    "qemu-system-hwe",
    "libvirt-daemon-system-hwe",
    "virtinst",
    "ca-certificates",
    "curl",
  ],
};

const GlobalArgsSchema = ConnectionSchema.extend({
  packages: z.array(z.string().regex(/^[a-z0-9][a-z0-9+.-]*$/)).optional()
    .describe(
      "Packages to install. Defaults to the deck's for the host's Ubuntu release.",
    ),
  user: z.string().min(1).optional().describe(
    "User to add to the groups. Defaults to the user the commands run as.",
  ),
  groups: z.array(z.string().min(1)).default(["libvirt", "kvm"]).describe(
    "Groups the user should be in: libvirt to manage VMs with virsh, kvm to open /dev/kvm. Only ever added to.",
  ),
});
type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StateSchema = StateBaseSchema.extend({
  release: z.string().nullable().optional(),
  kvm: z.boolean().optional(),
  packages: z.record(z.string(), z.string().nullable()).optional(),
  user: z.string().optional(),
  groups: z.array(z.string()).optional(),
});

/** What check found on the host. */
export interface HostState {
  release: string | null;
  kvm: boolean;
  packages: Record<string, string | null>;
  user: string;
  groups: string[];
}

/** The Ubuntu VERSION_ID from /etc/os-release, or null if it isn't Ubuntu. */
export function parseRelease(osRelease: string): string | null {
  const fields: Record<string, string> = {};
  for (const line of osRelease.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) fields[m[1]] = m[2].replace(/^"(.*)"$/, "$1");
  }
  return fields.ID === "ubuntu" ? fields.VERSION_ID ?? null : null;
}

/** The packages to manage: the arguments', or the deck's for the release. */
export function wantedPackages(
  g: GlobalArgs,
  release: string | null,
): string[] {
  if (g.packages) return g.packages;
  const pkgs = release ? PACKAGES[release] : undefined;
  if (!pkgs) {
    throw new Error(
      `${
        release ? `Ubuntu ${release}` : "This host"
      } isn't a release the deck covers (${
        Object.keys(PACKAGES).join(", ")
      }); set packages`,
    );
  }
  return pkgs;
}

async function packageVersions(
  s: Session,
  names: string[],
): Promise<Record<string, string | null>> {
  const versions: Record<string, string | null> = {};
  for (const name of names) {
    const r = await s.run("dpkg-query", [
      "-W",
      "-f",
      "${Status}\t${Version}",
      name,
    ]);
    const [status, version] = r.stdout.split("\t");
    versions[name] = r.code === 0 && status?.endsWith(" installed")
      ? version
      : null;
  }
  return versions;
}

/** The host's packages and the user's groups. */
export const hostResource: Resource<GlobalArgs, HostState> = {
  label: () => "host",
  async read(s, g) {
    const os = await s.run("cat", ["/etc/os-release"]);
    const release = os.code === 0 ? parseRelease(os.stdout) : null;
    const kvm = (await s.run("test", ["-c", "/dev/kvm"])).code === 0;
    const packages = await packageVersions(s, wantedPackages(g, release));
    const user = g.user ??
      check(await s.run("id", ["-un"]), "id -un").stdout.trim();
    // `id -nG` reads the group database, so it shows a membership apply just
    // added, before the user logs in again.
    const id = check(await s.run("id", ["-nG", user]), `id -nG ${user}`);
    return { release, kvm, packages, user, groups: id.stdout.split(/\s+/) };
  },
  diff(h, g) {
    const changes: string[] = [];
    for (const [pkg, version] of Object.entries(h.packages)) {
      if (!version) changes.push(`install ${pkg}`);
    }
    for (const group of g.groups) {
      if (!h.groups.includes(group)) {
        changes.push(`add ${h.user} to ${group}`);
      }
    }
    if (!h.kvm) {
      changes.push(
        "/dev/kvm is missing: turn on Intel VT-x or AMD-V in the firmware, then reboot",
      );
    }
    return changes;
  },
  async apply(s, g, h) {
    const missing = Object.entries(h.packages).filter(([, v]) => !v)
      .map(([p]) => p);
    if (missing.length) {
      check(await s.sudo("apt-get", ["update", "-q"]), "apt-get update");
      check(
        await s.sudo("env", [
          "DEBIAN_FRONTEND=noninteractive",
          "apt-get",
          "install",
          "-y",
          "-q",
          ...missing,
        ]),
        `apt-get install ${missing.join(" ")}`,
      );
    }
    for (const group of g.groups.filter((gr) => !h.groups.includes(gr))) {
      check(
        await s.sudo("usermod", ["-aG", group, h.user]),
        `usermod -aG ${group} ${h.user}`,
      );
    }
  },
  details: (h) => ({ ...h }),
  notes(h, g) {
    return g.groups.every((gr) => h.groups.includes(gr))
      ? [
        `${h.user} is in ${
          g.groups.join(" and ")
        }; a session started before the change needs a new login to use them`,
      ]
      : [];
  },
};

/** The libvirt host behavior. */
export const model = {
  type: "@taylor/libvirt/host",
  version: "2026.10.24.2",
  globalArguments: GlobalArgsSchema,
  checks: connectionChecks(["check", "apply"]),
  resources: {
    state: {
      description:
        "The host's release, /dev/kvm, packages and the user's groups, and whether they match",
      schema: StateSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    check: {
      description:
        "Read the host's packages and the user's groups and save what apply would change; changes nothing",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("check", hostResource, args, context),
    },
    apply: {
      description:
        "Install the missing packages and add the user to the missing groups",
      arguments: z.object({}),
      execute: (args: Seams, context: Context<GlobalArgs>) =>
        converge("apply", hostResource, args, context),
    },
  },
};
