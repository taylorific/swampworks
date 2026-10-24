import type { Mode } from "./network.ts";
import { check, type Run, type Session } from "./runner.ts";

// virsh output parsing, and the libvirt network XML for each way of
// connecting guests, as the kvm-training deck writes it.

/** `Key: value` lines from `virsh net-info` or `pool-info`, keyed lowercase. */
export function parseInfo(out: string): Record<string, string> {
  const info: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = line.match(/^([^:]+):\s*(.*)$/);
    if (m) info[m[1].trim().toLowerCase()] = m[2].trim();
  }
  return info;
}

/** The target path from `virsh pool-dumpxml`. */
export function parsePoolTarget(xml: string): string | null {
  return xml.match(/<target>\s*<path>([^<]+)<\/path>/)?.[1] ?? null;
}

/** The pool type from `virsh pool-dumpxml`, e.g. dir. */
export function parsePoolType(xml: string): string | null {
  return xml.match(/<pool\s+type=['"]([^'"]+)['"]/)?.[1] ?? null;
}

/**
 * Names from `virsh net-list` or `pool-list` with `--all --name`. A host
 * without virsh yet has none, so a check before libvirt is installed says
 * what apply would define rather than failing.
 */
export async function listNames(
  virsh: Run,
  uri: string,
  what: "net-list" | "pool-list",
): Promise<string[]> {
  const r = await virsh("virsh", ["-c", uri, what, "--all", "--name"]);
  if (r.code === 127 || /virsh'?: command not found/.test(r.stderr)) {
    return [];
  }
  check(r, `virsh ${what}`);
  return r.stdout.split("\n").map((s) => s.trim()).filter(Boolean);
}

/** The parts of a libvirt network definition this extension manages. */
export interface NetworkDef {
  mode: Mode | "isolated";
  bridge: string | null;
  interface: string | null;
  /** The host's address on the network, as a CIDR, for nat and routed. */
  address: string | null;
}

function attr(tag: string | undefined, name: string): string | null {
  return tag?.match(new RegExp(`\\b${name}=['"]([^'"]*)['"]`))?.[1] ?? null;
}

function maskToPrefix(mask: string): number {
  return mask.split(".").reduce(
    (n, o) => n + (Number(o) >>> 0).toString(2).replace(/0/g, "").length,
    0,
  );
}

/** Reads `virsh net-dumpxml` into the fields this extension manages. */
export function parseNetworkXml(xml: string): NetworkDef {
  const forward = xml.match(/<forward\b[^>]*>/)?.[0];
  const forwardMode = forward ? attr(forward, "mode") ?? "nat" : null;
  const bridgeTag = xml.match(/<bridge\b[^>]*>/)?.[0];
  const ifaceTag = xml.match(/<forward\b[^>]*>\s*<interface\b[^>]*>/)?.[0];
  const ipTag = xml.match(/<ip\b[^>]*>/)?.[0];
  const ip = attr(ipTag, "address");
  const prefix = attr(ipTag, "prefix") ??
    (attr(ipTag, "netmask")
      ? String(maskToPrefix(attr(ipTag, "netmask")!))
      : null);
  const iface = ifaceTag
    ? attr(ifaceTag.match(/<interface\b[^>]*>/)?.[0], "dev")
    : null;
  let mode: NetworkDef["mode"];
  if (!forwardMode) mode = "isolated";
  else if (forwardMode === "route") mode = "routed";
  else if (forwardMode === "bridge") mode = iface ? "macvtap" : "bridge";
  else mode = "nat";
  return {
    mode,
    bridge: attr(bridgeTag, "name"),
    interface: iface,
    address: ip && prefix ? `${ip}/${prefix}` : null,
  };
}

function ipv4(n: number): string {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

function toInt(ip: string): number {
  return ip.split(".").reduce((n, o) => ((n << 8) | Number(o)) >>> 0, 0);
}

/** The DHCP range for a host address: the rest of its subnet. */
export function dhcpRange(cidr: string): { start: string; end: string } {
  const [ip, len] = cidr.split("/");
  const host = toInt(ip);
  const mask = Number(len) === 0 ? 0 : (~0 << (32 - Number(len))) >>> 0;
  const net = (host & mask) >>> 0;
  const broadcast = (net | ~mask) >>> 0;
  const first = net + 1 === host ? net + 2 : net + 1;
  const last = broadcast - 1 === host ? broadcast - 2 : broadcast - 1;
  return { start: ipv4(first), end: ipv4(last) };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/'/g, "&apos;").replace(/</g, "&lt;");
}

/** The network XML `virsh net-define` takes for a mode. */
export function networkXml(name: string, want: NetworkDef): string {
  const lines = ["<network>", `  <name>${esc(name)}</name>`];
  if (want.mode === "bridge") {
    lines.push("  <forward mode='bridge'/>");
    lines.push(`  <bridge name='${esc(want.bridge!)}'/>`);
  } else if (want.mode === "macvtap") {
    lines.push("  <forward mode='bridge'>");
    lines.push(`    <interface dev='${esc(want.interface!)}'/>`);
    lines.push("  </forward>");
  } else {
    lines.push(
      `  <forward mode='${want.mode === "routed" ? "route" : "nat"}'/>`,
    );
    if (want.bridge) {
      lines.push(`  <bridge name='${esc(want.bridge)}' stp='on' delay='0'/>`);
    }
    const [ip, prefix] = want.address!.split("/");
    const range = dhcpRange(want.address!);
    lines.push(`  <ip address='${ip}' prefix='${prefix}'>`);
    lines.push("    <dhcp>");
    lines.push(`      <range start='${range.start}' end='${range.end}'/>`);
    lines.push("    </dhcp>");
    lines.push("  </ip>");
  }
  lines.push("</network>");
  return lines.join("\n") + "\n";
}

/**
 * Writes text to a new temporary file on the host and returns its path,
 * passing the text as an argument because commands get no stdin.
 */
export async function writeTemp(s: Session, text: string): Promise<string> {
  const path =
    check(await s.run("mktemp", ["-t", "libvirt-XXXXXX.xml"]), "mktemp")
      .stdout;
  check(
    await s.run("sh", ["-c", 'printf "%s" "$1" > "$2"', "sh", text, path]),
    `Writing ${path}`,
  );
  return path;
}
