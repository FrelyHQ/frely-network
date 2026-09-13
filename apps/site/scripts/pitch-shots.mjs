import { createRequire } from "node:module";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(
  path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../../../../信息/ethglobal-cover/package.json",
  ),
);
const { chromium } = require("playwright");

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT = path.join(ROOT, "tmp-shots");
const BASE = process.env.SITE_URL || "http://127.0.0.1:3040";

const SLIDES = [
  { n: 1, expect: "Agents can work" },
  { n: 2, expect: "open service layer" },
  { n: 3, expect: "Which Agent" },
  { n: 4, expect: "Who is this Agent" },
  { n: 5, expect: "How do Agents pay" },
  { n: 6, expect: "Discover. Verify. Pay. Execute" },
  { n: 7, expect: "Not just an x402" },
  { n: 8, expect: "find, trust, and buy" },
];

async function measureSlide(page) {
  return page.evaluate(() => {
    const pageEl = [...document.querySelectorAll(".slidev-page")].find(
      (el) => getComputedStyle(el).display !== "none" && el.getBoundingClientRect().height > 40,
    );
    if (!pageEl) return { vh: window.innerHeight, error: "no-active-page" };
    const layout = pageEl.querySelector(".slidev-layout");
    const frame = pageEl.querySelector(".slide-frame");
    const head = pageEl.querySelector(".slide-head");
    const body = pageEl.querySelector(".slide-body");
    const foot = pageEl.querySelector(".slide-foot");
    const vh = window.innerHeight;
    const parts = [head, body, foot].filter(Boolean).map((el) => {
      const r = el.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom };
    });
    const firstTop = parts[0]?.top ?? 0;
    const lastBottom = parts[parts.length - 1]?.bottom ?? 0;
    const span = lastBottom - firstTop;
    const gaps = [];
    for (let i = 1; i < parts.length; i++) {
      gaps.push(parts[i].top - parts[i - 1].bottom);
    }
    const gapSpread =
      gaps.length > 1 ? Math.max(...gaps) - Math.min(...gaps) : 0;
    return {
      vh,
      firstTop: Math.round(firstTop),
      lastBottom: Math.round(lastBottom),
      spanRatio: Number((span / vh).toFixed(3)),
      gaps: gaps.map((g) => Math.round(g)),
      gapSpread: Math.round(gapSpread),
      hasFrame: Boolean(frame),
      layoutH: layout ? Math.round(layout.getBoundingClientRect().height) : 0,
    };
  });
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
  const report = [];

  await page.goto(BASE + "/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(1200);
  await page.screenshot({ path: path.join(OUT, "00-landing.png"), fullPage: false });
  report.push({
    page: "landing",
    hasPlanet: (await page.locator("[data-testid='first-screen'], [data-testid='stage']").count()) > 0,
    hasPitchBtn: (await page.locator("[data-testid='cta-pitch'], [data-testid='nav-pitch']").count()) > 0,
    title: await page.title(),
  });

  await page.locator("#details").scrollIntoViewIfNeeded().catch(() => {});
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(OUT, "00b-details-cta.png"), fullPage: false });

  for (const slide of SLIDES) {
    const url = `${BASE}/pitch/index.html#/${slide.n}`;
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForFunction(
      (text) => document.body?.innerText?.includes(text),
      slide.expect,
      { timeout: 15000 },
    );
    await page.waitForTimeout(400);
    const metrics = await measureSlide(page);
    const name = `slide-${String(slide.n).padStart(2, "0")}.png`;
    await page.screenshot({ path: path.join(OUT, name), fullPage: false });
    // Content should span most of the viewport; gaps between bands should be similar.
    const balanced =
      metrics.spanRatio >= 0.62 &&
      metrics.firstTop < 160 &&
      metrics.vh - metrics.lastBottom < 160 &&
      metrics.gapSpread < 140;
    report.push({ page: `slide-${slide.n}`, expect: slide.expect, ...metrics, balanced });
  }

  await browser.close();
  await writeFile(path.join(OUT, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));

  const bad = report.filter((r) => r.page?.startsWith("slide-") && !r.balanced);
  if (bad.length) {
    console.error("Layout check failed:", bad.map((b) => b.page).join(", "));
    process.exitCode = 1;
  } else {
    console.log("Layout check passed.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
