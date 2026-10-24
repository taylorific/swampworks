import { z } from "npm:zod@4";

// Runs a KVM host's commands either where swamp runs or over SSH. Leave
// nodeHost unset when the method runs on the host itself, as it does on a
// swamp worker there; set it to reach the host over SSH from anywhere else.
// The argument names are @adam/cfgmgmt's, so a workflow can set the same
// connection settings on its steps and ours.

/** Result of one command. `code` is 127 when the command can't be run. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command with the given arguments. Injectable for tests. */
export type Run = (cmd: string, args: string[]) => Promise<RunResult>;

/** Where commands run, and whether they run with sudo. */
export const ConnectionSchema = z.object({
  nodeHost: z.string().min(1).optional().describe(
    "Host to reach over SSH: a hostname, user@host, or a name from ~/.ssh/config. Unset, commands run where swamp runs: on the KVM host itself when the step is placed on a worker there.",
  ),
  nodeUser: z.string().min(1).optional().describe(
    "SSH user; otherwise ssh's own configuration decides",
  ),
  nodePort: z.number().int().positive().optional().describe("SSH port"),
  nodeIdentityFile: z.string().optional().describe("Private key for SSH"),
  sshOptions: z.array(z.string()).default([]).describe(
    'More ssh arguments, ahead of the extension\'s own so they win, e.g. ["-J", "bastion"]',
  ),
  become: z.boolean().default(true).describe(
    "Run commands that need root with `sudo -n`, which needs passwordless sudo",
  ),
});
/** How to reach the host. */
export type Connection = z.infer<typeof ConnectionSchema>;

/** Runs real commands, reporting one that can't be started as code 127. */
export function commandRunner(timeoutMs = 600000): Run {
  return async (cmd, args) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs ssh and the probes and changes listed in README What it runs; argument lists are built in this extension
      out = await new Deno.Command(cmd, {
        args,
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(timeoutMs),
      }).output();
    } catch (err) {
      return { code: 127, stdout: "", stderr: (err as Error).message };
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}

/** Quotes a word for a POSIX shell. */
export function shQuote(s: string): string {
  return /^[A-Za-z0-9_./:=@%+,-]+$/.test(s)
    ? s
    : `'${s.replaceAll("'", `'\\''`)}'`;
}

/** The ssh destination for a connection, e.g. `taylor@kvm1`. */
export function sshDest(c: Connection): string {
  return c.nodeUser ? `${c.nodeUser}@${c.nodeHost}` : c.nodeHost!;
}

/**
 * The ssh arguments: the caller's first, since ssh keeps the first value it
 * sees for each setting; no prompts; and one shared connection.
 */
export function sshArgs(c: Connection, controlDir: string | null): string[] {
  return [
    ...c.sshOptions,
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=15",
    ...(c.nodePort ? ["-p", String(c.nodePort)] : []),
    ...(c.nodeIdentityFile
      ? ["-i", c.nodeIdentityFile, "-o", "IdentitiesOnly=yes"]
      : []),
    ...(controlDir
      ? [
        "-o",
        "ControlMaster=auto",
        "-o",
        `ControlPath=${controlDir}/%C`,
        "-o",
        "ControlPersist=60",
      ]
      : []),
  ];
}

/**
 * Runs commands on another machine with `ssh`, which hands the remote login
 * shell one command line, so each word is quoted.
 */
export function sshRunner(run: Run, dest: string, opts: string[]): Run {
  return (cmd, args) =>
    run("ssh", [
      ...opts,
      "--",
      dest,
      [cmd, ...args].map(shQuote).join(" "),
    ]);
}

/** Commands on the host, plain and as root. */
export interface Session {
  /** Runs as the connecting user. */
  run: Run;
  /** Runs as root with `sudo -n` when `become` is set, otherwise plainly. */
  sudo: Run;
  /** The host's name, which per-host data is named after. */
  host: string;
  /** Throws if the SSH connection dropped at any point. */
  assertConnected(): void;
  close(): Promise<void>;
}

/**
 * Opens a session on the host. ssh exits 255 when the connection fails,
 * which a probe would otherwise read as a missing tool, so once that
 * happens the session refuses to report anything.
 */
export async function openSession(c: Connection, local: Run): Promise<Session> {
  let run = local;
  let lost: RunResult | null = null;
  let control: string | null = null;
  if (c.nodeHost) {
    // A short path: a socket path can't be much over 100 bytes.
    control = await Deno.makeTempDir({ dir: "/tmp", prefix: "libvirt-ssh-" })
      .catch(() => null);
    const ssh = sshRunner(local, sshDest(c), sshArgs(c, control));
    run = async (cmd, args) => {
      const r = await ssh(cmd, args);
      if (r.code === 255) lost ??= r;
      return r;
    };
  }
  const close = async () => {
    if (!control) return;
    await local("ssh", [
      "-o",
      `ControlPath=${control}/%C`,
      "-O",
      "exit",
      "--",
      sshDest(c),
    ]);
    await Deno.remove(control, { recursive: true }).catch(() => {});
  };
  const name = await run("hostname", []);
  if (name.code !== 0) {
    await close();
    throw new Error(
      c.nodeHost
        ? `Could not run a command on ${sshDest(c)} over SSH: ${
          name.stderr || `ssh exited ${name.code}`
        }`
        : `Could not run hostname: ${name.stderr}`,
    );
  }
  return {
    run,
    sudo: c.become ? (cmd, args) => run("sudo", ["-n", cmd, ...args]) : run,
    host: name.stdout.trim(),
    assertConnected() {
      if (lost) {
        throw new Error(
          `Lost the SSH connection to ${c.nodeHost}, so nothing was recorded: ${
            lost.stderr || "ssh exited 255"
          }`,
        );
      }
    },
    close,
  };
}

/** Fails with the command's error output when it didn't succeed. */
export function check(r: RunResult, what: string): RunResult {
  if (r.code !== 0) {
    throw new Error(
      `${what} failed: ${r.stderr || r.stdout || `exit ${r.code}`}`,
    );
  }
  return r;
}
