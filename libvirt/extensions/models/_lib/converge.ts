import { z } from "npm:zod@4";
import {
  commandRunner,
  type Connection,
  openSession,
  type Run,
  type Session,
} from "./runner.ts";

// The check/apply pattern @adam/cfgmgmt uses, so these types sit beside its
// steps in a workflow: `check` reads the host and saves what would change
// without touching anything; `apply` makes those changes and reads the host
// again to prove it converged. Both save the same `state` data, named after
// the host, and a failure is saved too before it fails the step.

export const STATUSES = [
  "compliant",
  "non_compliant",
  "applied",
  "failed",
] as const;

/** Fields every type's `state` data has. */
export const StateBaseSchema = z.object({
  status: z.enum(STATUSES).describe(
    "compliant: nothing to change; non_compliant: check found changes; applied: apply made them; failed: see error",
  ),
  changes: z.array(z.string()).describe(
    "What differs (check) or what was changed (apply)",
  ),
  error: z.string().nullable(),
  host: z.string().describe("The host's name, which the data is named after"),
  checkedAt: z.string(),
});

interface Logger {
  info(msg: string, props?: Record<string, unknown>): void;
  warn(msg: string, props?: Record<string, unknown>): void;
}

/** What swamp hands a method. */
export interface Context<G> {
  globalArgs: G;
  logger: Logger;
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Test seams accepted by every method. */
export interface Seams {
  _run?: Run;
}

/** One kind of resource on the host. */
export interface Resource<G, T> {
  /** What the resource is called in log lines, e.g. "pool iso". */
  label(g: G): string;
  /** Reads the resource's current state. Changes nothing. */
  read(s: Session, g: G): Promise<T>;
  /** What would have to change; empty when the host already matches. */
  diff(current: T, g: G): string[];
  /** Makes the changes. */
  apply(s: Session, g: G, current: T, changes: string[]): Promise<void>;
  /** The resource's own fields for the state data. */
  details(current: T): Record<string, unknown>;
  /** Lines worth logging after a check or apply. */
  notes?(current: T, g: G): string[];
}

/** Runs `check` or `apply` for one resource and saves its state. */
export async function converge<G extends Connection, T>(
  mode: "check" | "apply",
  resource: Resource<G, T>,
  seams: Seams,
  context: Context<G>,
) {
  const g = context.globalArgs;
  const s: Session = await openSession(g, seams._run ?? commandRunner());
  const label = resource.label(g);
  const save = (data: Record<string, unknown>) =>
    context.writeResource("state", s.host, {
      ...data,
      host: s.host,
      checkedAt: new Date().toISOString(),
    });
  try {
    let current = await resource.read(s, g);
    const changes = resource.diff(current, g);
    let status: typeof STATUSES[number] = changes.length
      ? "non_compliant"
      : "compliant";
    if (mode === "apply" && changes.length) {
      for (const c of changes) {
        context.logger.info("{label}: {change}", { label, change: c });
      }
      await resource.apply(s, g, current, changes);
      current = await resource.read(s, g);
      const left = resource.diff(current, g);
      if (left.length) {
        throw new Error(`still differs after apply: ${left.join("; ")}`);
      }
      status = "applied";
    } else if (changes.length) {
      for (const c of changes) {
        context.logger.warn("{label} differs: {change}", {
          label,
          change: c,
        });
      }
    } else {
      context.logger.info("{label} is compliant", { label });
    }
    for (const note of resource.notes?.(current, g) ?? []) {
      context.logger.info("{label}: {note}", { label, note });
    }
    s.assertConnected();
    const handle = await save({
      ...resource.details(current),
      status,
      changes,
      error: null,
    });
    return { dataHandles: [handle] };
  } catch (err) {
    // A probe that failed because the connection dropped says so, and
    // nothing is saved for a host we lost track of.
    s.assertConnected();
    const message = (err as Error).message;
    await save({ status: "failed", changes: [], error: message });
    throw new Error(`${label}: ${message}`);
  } finally {
    await s.close();
  }
}
