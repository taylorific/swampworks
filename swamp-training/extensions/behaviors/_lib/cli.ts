// Checking deck commands against the CLI schema that `swamp help` prints.

import { shellWords } from "./deck.ts";

/** One option in `swamp help` output. */
export interface HelpOption {
  flags: string;
  description?: string;
  takesValue?: boolean;
  hidden?: boolean;
}

/** One command in `swamp help` output. */
export interface HelpNode {
  name: string;
  aliases?: string[];
  description?: string;
  hidden?: boolean;
  arguments?: { name: string }[];
  options?: HelpOption[];
  subcommands?: HelpNode[];
}

/** What the CLI makes of one deck command. */
export interface CommandCheck {
  /** `error`: the CLI doesn't accept it. `legacy`: accepted, but the path or an option is legacy or deprecated. */
  status: "ok" | "legacy" | "error";
  /** The command path swamp resolved, e.g. `swamp behavior run`. */
  resolved: string;
  problems: string[];
}

// Flags every command accepts without listing them.
const IMPLICIT = new Set(["-h", "--help", "-V", "--version"]);
const LEGACY = /\b(legacy|deprecated)\b/i;

function flagNames(o: HelpOption): string[] {
  return o.flags.split(",").map((f) => f.trim().split(/[\s=]/)[0]);
}

function isPlaceholder(word: string): boolean {
  return /^[<[]/.test(word) || word.includes("...") || word.includes("…");
}

/**
 * Looks up a command `swamp help` leaves out of the full tree because it is
 * hidden (such as `swamp audit`): `swamp help <path...>` still describes it.
 * Returns null when the CLI has no such command.
 */
export type HiddenLookup = (path: string[]) => Promise<HelpNode | null>;

/**
 * Checks one `swamp ...` command line against the CLI schema rooted at
 * `root`. `swamp help <command...>` is checked as the command it names.
 */
export async function checkCommand(
  text: string,
  root: HelpNode,
  lookup: HiddenLookup,
): Promise<CommandCheck> {
  let words = shellWords(text).slice(1);
  if (words[0] === "help") words = words.slice(1);
  const path: HelpNode[] = [root];
  const problems: string[] = [];
  const legacy: string[] = [];
  let positional = false;
  const where = () => path.map((n) => n.name).join(" ");

  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    if (isPlaceholder(w)) {
      positional = true;
      continue;
    }
    if (w.startsWith("-") && w.length > 1 && !/^-\d/.test(w)) {
      const name = w.split("=")[0];
      if (IMPLICIT.has(name)) continue;
      const opt = [...path].reverse().flatMap((n) => n.options ?? []).find((
        o,
      ) => flagNames(o).includes(name));
      if (!opt) {
        problems.push(`\`${where()}\` has no option ${name}`);
        continue;
      }
      if (LEGACY.test(opt.description ?? "")) {
        legacy.push(`${name}: ${opt.description}`);
      }
      if (opt.takesValue && !w.includes("=")) i++;
      continue;
    }
    if (positional) continue;
    const node = path[path.length - 1];
    const takesArgs = (node.arguments ?? []).length > 0;
    let sub = (node.subcommands ?? []).find((s) =>
      s.name === w || (s.aliases ?? []).includes(w)
    );
    // Only a word that would otherwise be an error is worth a hidden-command
    // lookup; each lookup runs the CLI once.
    if (!sub && !takesArgs && /^[a-z][a-z0-9-]*$/.test(w)) {
      sub = await lookup([...path.slice(1).map((n) => n.name), w]) ??
        undefined;
    }
    if (sub) {
      path.push(sub);
      if (LEGACY.test(sub.description ?? "")) {
        legacy.push(`${where()}: ${sub.description}`);
      }
      continue;
    }
    if ((node.subcommands ?? []).length > 0 && !takesArgs) {
      problems.push(`\`${where()}\` has no subcommand "${w}"`);
      break;
    }
    positional = true;
  }

  return {
    status: problems.length ? "error" : legacy.length ? "legacy" : "ok",
    resolved: where(),
    problems: problems.length ? problems : legacy,
  };
}
