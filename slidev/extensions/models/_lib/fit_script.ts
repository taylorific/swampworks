/**
 * The fit check that runs inside the Slidev container. It waits for the dev
 * server, opens every slide with all clicks revealed in the deck's own
 * playwright-chromium, and records how far the content reaches (in slide
 * pixels: the slide is 980 wide), which element reaches furthest, and code
 * blocks or tables that scroll. Exit codes: 3 no playwright-chromium, 4 the
 * server never answered, 5 Chromium would not start.
 */
export const FIT_SCRIPT =
  `// Runs inside the slidev container: waits for the dev server, then opens
// every slide with all clicks revealed and measures how far the content
// reaches, in slide pixels (the slide is 980 wide).
// Usage: node fit.mjs <port> <outDir> <bottomMargin> <rightMargin> <shots: all|flagged|none> [slides]
import { createRequire } from "node:module";
import fs from "node:fs";

const [port, outDir, bottomMargin, rightMargin, shots, only] = process.argv.slice(2);
const require = createRequire("/slidev/package.json");
let chromium;
try {
  ({ chromium } = require("playwright-chromium"));
} catch {
  console.error("FIT_ERROR no-playwright");
  process.exit(3);
}

// Vite may listen on IPv4 or only on IPv6 loopback; use whichever answers.
const candidates = [\`http://localhost:\${port}\`, \`http://[::1]:\${port}\`, \`http://127.0.0.1:\${port}\`];
const deadline = Date.now() + Number(process.env.FIT_WAIT_MS ?? 300_000);
let base;
while (!base) {
  for (const c of candidates) {
    try {
      if ((await fetch(c)).ok) { base = c; break; }
    } catch { /* not up yet */ }
  }
  if (base) break;
  if (Date.now() > deadline) {
    console.error("FIT_ERROR server-timeout");
    process.exit(4);
  }
  await new Promise((r) => setTimeout(r, 1000));
}

let browser;
try {
  browser = await chromium.launch();
} catch (e) {
  console.error("FIT_ERROR no-browser " + e.message.split("\\n")[0]);
  process.exit(5);
}
const page = await browser.newPage({ viewport: { width: 1960, height: 1104 } });
await page.goto(\`\${base}/1\`, { waitUntil: "networkidle" });
await page.waitForTimeout(1500);

const slides = await page.evaluate(() => {
  const nav = window.__slidev__?.nav;
  const routes = nav?.slides?.value ?? nav?.slides ?? [];
  return routes.map((r, i) => {
    const s = r?.meta?.slide ?? {};
    return {
      no: r?.no ?? i + 1,
      title: s.title ?? "",
      file: s.source?.filepath ?? s.filepath ?? "",
      line: (s.source?.start ?? s.start ?? -1) + 1,
      routeAlias: s.frontmatter?.routeAlias ?? "",
      layout: s.frontmatter?.layout ?? "",
    };
  });
});
const total = slides.length;
const wanted = only ? new Set(only.split(",").map(Number)) : null;

const results = [];
for (const s of slides) {
  if (wanted && !wanted.has(s.no)) continue;
  await page.goto(\`\${base}/\${s.no}?clicks=999\`, { waitUntil: "networkidle" });
  await page.waitForTimeout(400);
  const m = await page.evaluate(() => {
    const pages = [...document.querySelectorAll(".slidev-page")].filter((p) =>
      getComputedStyle(p).display !== "none" && p.getBoundingClientRect().width > 0
    );
    const pg = pages[pages.length - 1];
    if (!pg) return null;
    const box = pg.getBoundingClientRect();
    const scale = box.width / 980;
    let bottom = 0, right = 0, bottomEl = "", rightEl = "";
    const describe = (el) =>
      \`\${el.tagName.toLowerCase()}: \${(el.textContent || "").trim().replace(/\\s+/g, " ").slice(0, 60)}\`;
    // Absolutely positioned boxes (corner buttons, abs-br, overlays) are
    // placed deliberately, so neither they nor their contents count.
    const placed = new WeakMap();
    const isPlaced = (el) => {
      if (!el || el === pg) return false;
      if (placed.has(el)) return placed.get(el);
      const pos = getComputedStyle(el).position;
      const v = pos === "absolute" || pos === "fixed" || isPlaced(el.parentElement);
      placed.set(el, v);
      return v;
    };
    // A box that scrolls or clips (a code block with maxHeight, a wide
    // table) hides whatever doesn't fit inside it. Report the box as
    // scrolled, and measure the box rather than the content hidden in it.
    const clips = (cs) =>
      cs.overflowX !== "visible" || cs.overflowY !== "visible";
    const layouts = new Set(pg.querySelectorAll(".slidev-layout"));
    const inside = new WeakMap();
    const isInsideClip = (el) => {
      const parent = el.parentElement;
      if (!parent || parent === pg || layouts.has(parent)) return false;
      if (inside.has(el)) return inside.get(el);
      const v = clips(getComputedStyle(parent)) || isInsideClip(parent);
      inside.set(el, v);
      return v;
    };
    const overflows = (el) =>
      el.scrollWidth > el.clientWidth + 4 || el.scrollHeight > el.clientHeight + 4;
    const scrolledEls = new Set();
    for (const el of pg.querySelectorAll(".slidev-layout *")) {
      const cs = getComputedStyle(el);
      if (
        isPlaced(el) || isInsideClip(el) || cs.visibility === "hidden" ||
        cs.opacity === "0" || cs.display === "none"
      ) continue;
      const rb = el.getBoundingClientRect();
      if (rb.height === 0 || rb.width === 0) continue;
      if (clips(cs) && overflows(el)) scrolledEls.add(el);
      const b = (rb.bottom - box.top) / scale;
      const r = (rb.right - box.left) / scale;
      if (b > bottom) { bottom = b; bottomEl = describe(el); }
      if (r > right) { right = r; rightEl = describe(el); }
    }
    // Code blocks and tables can also scroll without clipping their parent.
    for (const el of pg.querySelectorAll(".slidev-layout pre, .slidev-layout table, .slidev-layout .slidev-code")) {
      if (!isPlaced(el) && !isInsideClip(el) && overflows(el)) scrolledEls.add(el);
    }
    const scrolled = [...scrolledEls].map(describe);
    return {
      height: Math.round(box.height / scale),
      bottom: Math.round(bottom),
      right: Math.round(right),
      bottomEl,
      rightEl,
      scrolled,
      clip: { x: box.left, y: box.top, width: box.width, height: box.height },
    };
  });
  if (!m) {
    results.push({ ...s, problems: ["render"], screenshot: false });
    continue;
  }
  const problems = [];
  if (m.bottom > m.height - Number(bottomMargin)) problems.push("bottom");
  if (m.right > 980 - Number(rightMargin)) problems.push("right");
  if (m.scrolled.length) problems.push("scroll");
  const shot = shots === "all" || (shots === "flagged" && problems.length);
  if (shot) {
    await page.screenshot({
      path: \`\${outDir}/slide-\${String(s.no).padStart(3, "0")}.png\`,
      clip: m.clip,
    });
  }
  delete m.clip;
  results.push({ ...s, ...m, problems, screenshot: Boolean(shot) });
}
await browser.close();
fs.writeFileSync(\`\${outDir}/results.json\`, JSON.stringify({ total, results }));
console.log(\`FIT_DONE \${results.length}\`);
`;
