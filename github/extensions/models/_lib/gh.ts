// Running the GitHub CLI, shared by the @taylor/github types.

import { commandRunner, type Run, type RunResult } from "./run.ts";

/** Result of one `gh` call. */
export type GhResult = RunResult;

/** Runs `gh` with the given arguments. Injectable for tests. */
export type Gh = Run;

/** Runs the GitHub CLI and captures its output. */
export function ghRunner(bin: string): Gh {
  return commandRunner(bin, {
    timeoutMs: 60000,
    hint: "Install the GitHub CLI and run `gh auth login`.",
  });
}

/** True when a failed `gh api` call was a 404. */
export function isNotFound(r: GhResult): boolean {
  return r.code !== 0 && /\(HTTP 404\)/.test(r.stderr);
}

/** Parses `gh api` output, or throws with the API's message. */
export function parseOrThrow(
  r: GhResult,
  what: string,
): Record<string, unknown> {
  let body: Record<string, unknown> | undefined;
  try {
    body = JSON.parse(r.stdout);
  } catch { /* not JSON */ }
  // GraphQL reports errors in the body, sometimes with a zero exit.
  const errors = body?.errors as { message?: string }[] | undefined;
  if (r.code !== 0 || errors?.length) {
    const message = String(
      body?.message ?? errors?.[0]?.message ?? r.stderr.replace(/^gh: /, ""),
    );
    throw new Error(`${what} failed: ${message}`);
  }
  return body ?? {};
}
