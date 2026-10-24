import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.19";
import {
  checkConnection,
  ConnectionSchema,
  sshArgs,
  sshRunner,
} from "./runner.ts";
import { fail, fakeRun, ok } from "./fake_test_helpers.ts";

const conn = (v: Record<string, unknown> = {}) => ConnectionSchema.parse(v);

Deno.test("checkConnection wants Linux when there's no nodeHost", async () => {
  const { run } = fakeRun({});
  assertEquals(await checkConnection(conn(), "linux", run), { pass: true });
  const mac = await checkConnection(conn(), "darwin", run);
  assertEquals(mac.pass, false);
  assertStringIncludes(mac.errors![0], "set nodeHost");
});

Deno.test("checkConnection wants ssh when nodeHost is set", async () => {
  const yes = fakeRun({ "ssh -V": ok() }).run;
  const no = fakeRun({ "ssh -V": fail("not found") }).run;
  const c = conn({ nodeHost: "kvm1.example.com" });
  assertEquals(await checkConnection(c, "darwin", yes), { pass: true });
  assertEquals((await checkConnection(c, "darwin", no)).pass, false);
});

Deno.test("sshRunner quotes each word and passes stdin through", async () => {
  const { run, calls, inputs } = fakeRun({ "ssh *": ok() });
  const ssh = sshRunner(run, "admin@kvm1.example.com", sshArgs(conn(), null));
  await ssh("sh", ["-c", 'cat > "$1"', "sh", "/tmp/a b"], "secret");
  const line = calls[0];
  assertStringIncludes(
    line,
    `admin@kvm1.example.com sh -c 'cat > "$1"' sh '/tmp/a b'`,
  );
  assertEquals(inputs[line], "secret");
});
