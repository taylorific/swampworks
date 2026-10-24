import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import type { RunResult } from "./runner.ts";

export const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
export const fail = (stderr = "error"): RunResult => ({
  code: 1,
  stdout: "",
  stderr,
});

/** Answers by command line; a function answer can see earlier calls. */
export type Answer = RunResult | ((calls: string[]) => RunResult);

/** A fake runner: exact command lines first, then prefixes; records calls. */
export function fakeRun(answers: Record<string, Answer>) {
  const calls: string[] = [];
  const run = (cmd: string, args: string[]) => {
    const line = [cmd, ...args].join(" ");
    calls.push(line);
    const key = line in answers
      ? line
      : Object.keys(answers).find((k) =>
        k.endsWith("*") && line.startsWith(k.slice(0, -1))
      );
    const a = key === undefined ? fail(`unexpected: ${line}`) : answers[key];
    return Promise.resolve(typeof a === "function" ? a(calls) : a);
  };
  return { run, calls };
}

interface Methods {
  // deno-lint-ignore no-explicit-any
  [name: string]: { execute: (args: any, ctx: any) => Promise<unknown> };
}

/** Runs one method with a fake runner and returns its saved state. */
export async function runMethod(
  // deno-lint-ignore no-explicit-any
  model: { globalArguments: { parse: (v: unknown) => any }; methods: Methods },
  method: string,
  globals: Record<string, unknown>,
  answers: Record<string, Answer>,
) {
  const test = createModelTestContext({
    globalArgs: model.globalArguments.parse(globals),
    methodName: method,
  });
  const { run, calls } = fakeRun(answers);
  let error: Error | null = null;
  try {
    await model.methods[method].execute({ _run: run }, test.context);
  } catch (err) {
    error = err as Error;
  }
  const [state] = test.getWrittenResources();
  return {
    state: state?.data as Record<string, unknown> | undefined,
    name: state?.name,
    calls,
    error,
  };
}
