import { assertEquals } from "jsr:@std/assert@1.0.19";
import { checkCommand, type HelpNode } from "./cli.ts";

const root: HelpNode = {
  name: "swamp",
  options: [{ flags: "--json" }, { flags: "-q, --quiet" }],
  subcommands: [
    {
      name: "behavior",
      aliases: ["behaviour"],
      subcommands: [
        {
          name: "run",
          arguments: [{ name: "behavior" }, { name: "method" }],
          options: [{ flags: "--input", takesValue: true }],
        },
        { name: "create", arguments: [{ name: "type" }, { name: "name" }] },
      ],
    },
    {
      name: "model",
      description: "Manage models (legacy spelling of 'behavior')",
      subcommands: [{ name: "create", arguments: [{ name: "type" }] }],
    },
  ],
};

const audit: HelpNode = { name: "audit", hidden: true };
const lookups: string[] = [];
const lookup = (path: string[]) => {
  lookups.push(path.join(" "));
  return Promise.resolve(path.join(" ") === "audit" ? audit : null);
};

Deno.test("accepts known commands, aliases, options and values", async () => {
  for (
    const cmd of [
      "swamp behavior run x check --input a=b --json",
      "swamp behaviour run x check -q",
      "swamp behavior run <name> <method>",
      "swamp behavior",
      "swamp help behavior run",
      "swamp behavior run x check --help",
    ]
  ) {
    assertEquals((await checkCommand(cmd, root, lookup)).status, "ok", cmd);
  }
});

Deno.test("reports unknown subcommands and options", async () => {
  assertEquals(await checkCommand("swamp behavior launch x", root, lookup), {
    status: "error",
    resolved: "swamp behavior",
    problems: ['`swamp behavior` has no subcommand "launch"'],
  });
  assertEquals(
    (await checkCommand("swamp behavior run x y --inputs a", root, lookup))
      .problems,
    ["`swamp behavior run` has no option --inputs"],
  );
});

Deno.test("marks the legacy spelling", async () => {
  const r = await checkCommand("swamp model create t", root, lookup);
  assertEquals(r.status, "legacy");
  assertEquals(r.resolved, "swamp model create");
});

Deno.test("finds hidden commands, and only looks up words that would fail", async () => {
  lookups.length = 0;
  assertEquals((await checkCommand("swamp audit", root, lookup)).status, "ok");
  await checkCommand("swamp behavior run my-def check", root, lookup);
  assertEquals(lookups, ["audit"]);
});
