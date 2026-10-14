import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.19";
import {
  block,
  codeBlocks,
  extractCommands,
  findSlide,
  shellSegments,
  shellWords,
} from "./deck.ts";

const deck = [
  "# Intro",
  "",
  "Run `swamp behavior run x check` or `swamp.png`, not ``swamp double``.",
  "",
  "```bash",
  "$ swamp data query 'a == \"b\" && c' --json   # a comment",
  "swamp behavior create t n \\",
  "  --global-arg path=x",
  "echo hi && swamp audit | head",
  "```",
  "",
  "```yaml",
  "swamp: not a command",
  "```",
  "",
  "---",
  "",
  "# Part 1: the schemas",
  "",
  "```ts {1|2}",
  "const a = 1;",
  "```",
  "",
  "```text",
  "swamp behavior run <definition name> <method name>",
  "```",
  "",
  "---",
].join("\n");

Deno.test("shellWords keeps quotes and placeholders together", () => {
  assertEquals(
    shellWords(`swamp data query 'a == "b"' <instance name> [opt x] --json`),
    [
      "swamp",
      "data",
      "query",
      'a == "b"',
      "<instance name>",
      "[opt x]",
      "--json",
    ],
  );
});

Deno.test("shellSegments splits pipelines and drops comments", () => {
  assertEquals(shellSegments("a 'x && y' && b | c; d # e"), [
    "a 'x && y'",
    "b",
    "c",
    "d",
  ]);
});

Deno.test("extractCommands finds commands in shell blocks and inline code", () => {
  assertEquals(extractCommands(deck), [
    { text: "swamp behavior run x check", line: 3 },
    { text: `swamp data query 'a == "b" && c' --json`, line: 6 },
    { text: "swamp behavior create t n --global-arg path=x", line: 7 },
    { text: "swamp audit", line: 9 },
    { text: "swamp behavior run <definition name> <method name>", line: 25 },
  ]);
});

Deno.test("findSlide stops at the next separator and numbers code blocks", () => {
  const s = findSlide(deck, "Part 1:");
  assertEquals(s.line, 18);
  assertEquals(codeBlocks(s).map((b) => [b.lang, b.line]), [
    ["ts", 21],
    ["text", 25],
  ]);
  assertEquals(block(s, ["ts"]).code, "const a = 1;");
});

Deno.test("findSlide and block name what's missing", () => {
  assertThrows(() => findSlide(deck, "Part 9"), Error, '"# Part 9"');
  assertThrows(
    () => block(findSlide(deck, "Intro"), ["json"]),
    Error,
    "no json code block",
  );
});
