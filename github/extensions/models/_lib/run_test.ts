import { assertEquals } from "jsr:@std/assert@1.0.19";
import { commandRunner } from "./run.ts";

const text = "\n  indented: true\nlast line\n";

Deno.test("commandRunner trims output by default", async () => {
  const run = commandRunner("printf", { timeoutMs: 5000, hint: "" });
  assertEquals((await run(["%s", text])).stdout, "indented: true\nlast line");
});

Deno.test("commandRunner keeps output exact with trim false", async () => {
  const run = commandRunner("printf", {
    timeoutMs: 5000,
    hint: "",
    trim: false,
  });
  assertEquals((await run(["%s", text])).stdout, text);
});
