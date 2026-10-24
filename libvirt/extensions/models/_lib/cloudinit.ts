import { stringify } from "jsr:@std/yaml@1.2.0";

// The NoCloud seed a guest reads on first boot: meta-data names the
// instance, user-data configures it. The kvm-training deck writes both by
// hand and installs qemu-guest-agent after logging in; here the agent goes
// in user-data, since the host needs it to learn the guest's address.

/** What the generated user-data sets up. */
export interface UserDataOptions {
  hostname: string;
  sshAuthorizedKeys: string[];
  password?: string;
  packages: string[];
}

/** meta-data: required for NoCloud, and uniquely identifies the instance. */
export function metaData(name: string): string {
  return stringify({ "instance-id": name, "local-hostname": name });
}

/**
 * user-data for the default `ubuntu` user: SSH keys, an optional password,
 * and qemu-guest-agent plus any other packages.
 */
export function userData(o: UserDataOptions): string {
  const config: Record<string, unknown> = { hostname: o.hostname };
  if (o.sshAuthorizedKeys.length) {
    config.ssh_authorized_keys = o.sshAuthorizedKeys;
  }
  if (o.password) {
    config.password = o.password;
    config.chpasswd = { expire: false };
    config.ssh_pwauth = true;
  }
  config.package_update = true;
  config.packages = [...new Set(["qemu-guest-agent", ...o.packages])];
  config.runcmd = [["systemctl", "enable", "--now", "qemu-guest-agent"]];
  return `#cloud-config\n${stringify(config)}`;
}
