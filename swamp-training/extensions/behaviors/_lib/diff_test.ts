import { assertEquals } from "jsr:@std/assert@1.0.19";
import { unifiedDiff } from "./diff.ts";

Deno.test("equal texts have no diff", () => {
  assertEquals(unifiedDiff("a\nb", "a\nb"), "");
});

Deno.test("shows changes with context in one hunk", () => {
  const before = "1\n2\n3\n4\n5\n6\n7\n8";
  const after = "1\n2\n3\nfour\n5\n6\n7\n8";
  assertEquals(
    unifiedDiff(before, after, 1),
    "@@ -3,3 +3,3 @@\n 3\n-4\n+four\n 5",
  );
});

Deno.test("splits far-apart changes into hunks", () => {
  const before = "a\n1\n2\n3\n4\n5\n6\nb";
  const after = "A\n1\n2\n3\n4\n5\n6\nB";
  assertEquals(
    unifiedDiff(before, after, 1).split("\n").filter((l) => l.startsWith("@@")),
    ["@@ -1,2 +1,2 @@", "@@ -7,2 +7,2 @@"],
  );
});

Deno.test("additions at the end", () => {
  assertEquals(unifiedDiff("a", "a\nb", 3), "@@ -1,1 +1,2 @@\n a\n+b");
});
