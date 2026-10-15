// Running a command and capturing its output.

/** Result of one command. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/**
 * Runs a command with the given arguments, and `input` on its stdin.
 * Injectable for tests.
 */
export type Run = (args: string[], input?: string) => Promise<RunResult>;

/** Runs `bin` and captures its output. */
export function commandRunner(
  bin: string,
  opts: { timeoutMs: number; hint: string; env?: Record<string, string> },
): Run {
  return async (args, input) => {
    let out: Deno.CommandOutput;
    try {
      // swamp-quality-ignore deno-command: runs gh or git; argument lists are built in this extension, see README What it runs
      const child = new Deno.Command(bin, {
        args,
        env: opts.env,
        stdin: input === undefined ? "null" : "piped",
        stdout: "piped",
        stderr: "piped",
        signal: AbortSignal.timeout(opts.timeoutMs),
      }).spawn();
      if (input !== undefined) {
        const w = child.stdin.getWriter();
        await w.write(new TextEncoder().encode(input));
        await w.close();
      }
      out = await child.output();
    } catch (err) {
      throw new Error(
        `Cannot run ${bin}: ${(err as Error).message}. ${opts.hint}`,
      );
    }
    const dec = new TextDecoder();
    return {
      code: out.code,
      stdout: dec.decode(out.stdout).trim(),
      stderr: dec.decode(out.stderr).trim(),
    };
  };
}
