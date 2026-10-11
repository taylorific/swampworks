import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.19";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20261008.49";
import {
  decodeBase64,
  DEFAULT_IMAGE,
  MAX_SINGLE_DEVICE_PX,
  model,
  NOTO_PACKAGES,
  notoDockerfile,
  notoImageTag,
  parseDockerPort,
  planCapture,
  resolveChrome,
  slugFromUrl,
} from "./webshot.ts";

type CaptureContext = Parameters<typeof model.methods.capture.execute>[1];

Deno.test("slugFromUrl turns the host into a data-name slug", () => {
  assertEquals(
    slugFromUrl("https://www.Example.com/a/b?c=d"),
    "www-example-com",
  );
  assertEquals(slugFromUrl("http://localhost:8080/"), "localhost");
  assertEquals(slugFromUrl("http://[::1]/"), "1");
  assertEquals(slugFromUrl("https://photo.capture/"), "photo-capture-page");
});

Deno.test("decodeBase64 decodes binary content", () => {
  const png = decodeBase64("iVBORw0KGgo=");
  assertEquals(Array.from(png), [
    0x89,
    0x50,
    0x4e,
    0x47,
    0x0d,
    0x0a,
    0x1a,
    0x0a,
  ]);
});

Deno.test("capture rejects non-http URLs", () => {
  const args = model.methods.capture.arguments;
  assertEquals(args.safeParse({ url: "https://example.com" }).success, true);
  assertEquals(args.safeParse({ url: "file:///etc/passwd" }).success, false);
  assertEquals(args.safeParse({ url: "not a url" }).success, false);
});

Deno.test("capture reserves the -capture name suffix", () => {
  const args = model.methods.capture.arguments;
  const url = "https://example.com";
  assertEquals(args.safeParse({ url, name: "home" }).success, true);
  assertEquals(args.safeParse({ url, name: "home-capture" }).success, false);
  assertEquals(args.safeParse({ url, name: "Bad Name" }).success, false);
});

Deno.test("capture applies argument defaults", () => {
  const parsed = model.methods.capture.arguments.parse({
    url: "https://example.com",
  });
  assertEquals(parsed.hideFixed, true);
  assertEquals(parsed.maxHeight, 50000);
});

Deno.test("resolveChrome errors on a missing explicit chromePath", async () => {
  await assertRejects(
    () => resolveChrome("/nonexistent/chrome", undefined, []),
    Error,
    "from chromePath",
  );
});

Deno.test("resolveChrome errors on a missing $CHROME_PATH", async () => {
  await assertRejects(
    () => resolveChrome(undefined, "/nonexistent/chrome", []),
    Error,
    "from $CHROME_PATH",
  );
});

Deno.test("resolveChrome falls back to the first existing candidate", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const bin = `${dir}/chrome`;
    await Deno.writeTextFile(bin, "");
    assertEquals(
      await resolveChrome(undefined, undefined, [`${dir}/missing`, bin]),
      bin,
    );
    await assertRejects(
      () => resolveChrome(undefined, undefined, [`${dir}/missing`]),
      Error,
      "No Chrome/Chromium binary found",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function expectCaptureFailure(
  globalArgs: Record<string, unknown>,
  message: string,
) {
  const { context, getWrittenFiles, getWrittenResources } =
    createModelTestContext({
      globalArgs: model.globalArguments.parse(globalArgs),
      methodName: "capture",
    });
  const args = model.methods.capture.arguments.parse({
    url: "https://example.com",
  });
  await assertRejects(
    () =>
      model.methods.capture.execute(
        args,
        context as unknown as CaptureContext,
      ),
    Error,
    message,
  );
  assertEquals(getWrittenFiles().length, 0);
  assertEquals(getWrittenResources().length, 0);
}

Deno.test("local backend fails before writing data when Chrome is missing", async () => {
  await expectCaptureFailure(
    { backend: "local", chromePath: "/nonexistent/chrome" },
    "Chrome binary not found",
  );
});

Deno.test("docker backend fails before writing data when Docker is missing", async () => {
  await expectCaptureFailure(
    { dockerPath: "/nonexistent/docker" },
    "Cannot run /nonexistent/docker",
  );
});

Deno.test("global arguments default to the pinned docker image", () => {
  const g = model.globalArguments.parse({});
  assertEquals(g.backend, "docker");
  assertEquals(g.image, DEFAULT_IMAGE);
  assertEquals(
    model.globalArguments.safeParse({ image: "--privileged" }).success,
    false,
  );
});

Deno.test("parseDockerPort prefers the IPv4 loopback mapping", () => {
  assertEquals(parseDockerPort("127.0.0.1:57578\n"), 57578);
  assertEquals(parseDockerPort("[::1]:49000\n127.0.0.1:49001"), 49001);
  assertEquals(parseDockerPort("0.0.0.0:32768"), 32768);
  assertThrows(
    () => parseDockerPort(""),
    Error,
    "Unexpected docker port output",
  );
});

Deno.test("planCapture uses a single capture for pages that fit", () => {
  const plan = planCapture({
    height: 8000,
    deviceScaleFactor: 1,
    viewportHeight: 800,
    format: "png",
    hideFixed: true,
  });
  assertEquals(plan.mode, "single");
  assertEquals(plan.tiles, [{ y: 0, height: 8000 }]);
  // One pixel more no longer fits under Chrome's 8192px software limit margin.
  assertEquals(
    planCapture({
      height: 8001,
      deviceScaleFactor: 1,
      viewportHeight: 800,
      format: "png",
      hideFixed: true,
    }).mode,
    "scroll",
  );
});

Deno.test("planCapture scrolls in viewport-sized tiles for tall PNGs", () => {
  const plan = planCapture({
    height: 2000,
    deviceScaleFactor: 4,
    viewportHeight: 800,
    format: "png",
    hideFixed: true,
  });
  // 2000 CSS px x 4 = 8000 device px fits exactly.
  assertEquals(plan.mode, "single");
  const tall = planCapture({
    height: 40000,
    deviceScaleFactor: 1,
    viewportHeight: 800,
    format: "png",
    hideFixed: true,
  });
  assertEquals(tall.mode, "scroll");
  assertEquals(tall.tiles.length, 50);
  assertEquals(tall.tiles[49], { y: 39200, height: 800 });
  assertEquals(tall.tiles.reduce((n, t) => n + t.height, 0), 40000);
});

Deno.test("planCapture falls back to beyond-viewport bands without hideFixed", () => {
  const plan = planCapture({
    height: 20000,
    deviceScaleFactor: 2,
    viewportHeight: 800,
    format: "png",
    hideFixed: false,
  });
  assertEquals(plan.mode, "beyond");
  // 4096 device px bands at scale 2 are 2048 CSS px.
  assertEquals(plan.tiles.length, 10);
  assertEquals(plan.tiles.map((t) => t.height).slice(-2), [2048, 1568]);
  assertEquals(plan.tiles.reduce((n, t) => n + t.height, 0), 20000);
});

Deno.test("planCapture cuts JPEG and WebP to one capture", () => {
  for (const format of ["jpeg", "webp"] as const) {
    const plan = planCapture({
      height: 40000,
      deviceScaleFactor: 2,
      viewportHeight: 800,
      format,
      hideFixed: true,
    });
    assertEquals(plan.mode, "single");
    assertEquals(plan.cutByFormat, true);
    assertEquals(plan.height, MAX_SINGLE_DEVICE_PX / 2);
  }
});

Deno.test("noto image helpers pin packages to the base image", () => {
  assertEquals(
    notoImageTag(DEFAULT_IMAGE),
    "webshot-noto:chromedp-headless-shell-156.0.8078.12",
  );
  const dockerfile = notoDockerfile(DEFAULT_IMAGE);
  assertEquals(dockerfile.split("\n")[0], `FROM ${DEFAULT_IMAGE}`);
  for (const pkg of NOTO_PACKAGES) {
    assertEquals(dockerfile.includes(pkg), true, pkg);
    assertEquals(pkg.includes("="), true, `${pkg} is version-pinned`);
  }
});

Deno.test("capture validates format, quality, and HTTP error defaults", () => {
  const args = model.methods.capture.arguments;
  const url = "https://example.com";
  const parsed = args.parse({ url });
  assertEquals(parsed.format, "png");
  assertEquals(parsed.failOnHttpError, true);
  assertEquals(args.safeParse({ url, format: "gif" }).success, false);
  assertEquals(args.safeParse({ url, quality: 0 }).success, false);
  assertEquals(args.safeParse({ url, quality: 101 }).success, false);
});

Deno.test("global arguments require a whole-number scale and default to Noto fonts", () => {
  const g = model.globalArguments;
  assertEquals(g.parse({}).fonts, "noto");
  assertEquals(g.safeParse({ deviceScaleFactor: 1.5 }).success, false);
  assertEquals(g.safeParse({ deviceScaleFactor: 5 }).success, false);
  assertEquals(g.safeParse({ fonts: "comic-sans" }).success, false);
});
