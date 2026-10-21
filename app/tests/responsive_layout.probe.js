/* t_1fbc1ef4 local verification probe — §14.4 checklist per §14.3 viewport matrix.
   Run: python3 -m http.server 8765 (from app/), then node app/tests/responsive_layout.probe.js
   Negative control: SOLIN_BASE=http://127.0.0.1:8766 node ... runs against a pre-fix snapshot. */
"use strict";
const puppeteer = require("puppeteer-core");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = (process.env.SOLIN_BASE || "http://127.0.0.1:8765") + "/index.html";
const VIEWPORTS = [
  [1920, 1080], [2560, 1440], [1440, 900], [1280, 800],
  [1440, 700], [390, 844], [844, 390],
];

function fail(t, s) { t.push("FAIL: " + s); }

(async () => {
  const browser = await puppeteer.launch({
    executablePath: CHROME, headless: "new",
    args: ["--no-first-run", "--no-default-browser-check"],
  });
  let bad = 0;
  for (const [W, H] of VIEWPORTS) {
    const page = await browser.newPage();
    await page.setViewport({ width: W, height: H, deviceScaleFactor: 1 });
    const t = [];
    const tag = `${W}x${H}`;
    // ---------- checklist 1: nav geometry + hit-tests ----------
    await page.goto(BASE + "#browse", { waitUntil: "load" });
    await page.waitForSelector("#bottom-nav button", { timeout: 5000 });
    const nav = await page.evaluate(() => {
      const nav = document.getElementById("bottom-nav");
      const r = nav.getBoundingClientRect();
      const cs = getComputedStyle(nav);
      const btns = [...nav.querySelectorAll("button")].map((b) => {
        const br = b.getBoundingClientRect();
        const mid = { x: Math.round(br.x + br.width / 2), y: Math.round(br.y + br.height / 2) };
        const hit = document.elementFromPoint(mid.x, mid.y);
        return { nav: b.dataset.nav, x: Math.round(br.x), right: Math.round(br.right),
                 y: Math.round(br.y), bottom: Math.round(br.bottom),
                 inViewport: br.x >= 0 && br.right <= innerWidth && br.y >= 0 && br.bottom <= innerHeight,
                 hit: hit ? (hit.tagName + (hit.dataset && hit.dataset.nav ? ":" + hit.dataset.nav : "")) : "null" };
      });
      return {
        rect: { x: Math.round(r.x), right: Math.round(r.right), y: Math.round(r.y), bottom: Math.round(r.bottom) },
        position: cs.position, bottomAnchor: cs.bottom, transform: cs.transform,
        btns,
        stripHits: [0.3, 0.5, 0.7].map((fx) => {
          const x = Math.round(innerWidth * fx), y = innerHeight - 30;
          const el = document.elementFromPoint(x, y);
          return el ? el.tagName.toLowerCase() + "#" + (el.id || el.className.toString().split(" ")[0]) : "null";
        }),
      };
    });
    if (nav.rect.bottom > H) fail(t, `nav bottom ${nav.rect.bottom} > viewport ${H} (floating/occluding)`);
    for (const b of nav.btns) {
      if (!b.inViewport) fail(t, `button ${b.nav} outside viewport (x ${b.x}, right ${b.right})`);
      if (b.right < 1) fail(t, `button ${b.nav} clipped (right=${b.right})`);
    }
    if (nav.transform && nav.transform !== "none") fail(t, `nav has transform displacement risk: ${nav.transform}`);
    if (nav.position === "sticky" && nav.bottomAnchor === "auto") fail(t, "sticky without pin anchor (DEFECT-1 regression)");
    // ---------- checklist 2: real-pointer clicks switch pages ----------
    const clickBtn = async (navName) => {
      const box = await page.evaluate((name) => {
        const b = document.querySelector(`#bottom-nav button[data-nav="${name}"]`);
        const r = b.getBoundingClientRect();
        return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
      }, navName);
      await page.mouse.click(box.x, box.y);
      return page.evaluate((name) => ({
        hash: location.hash,
        viewHidden: document.getElementById("view-" + name).classList.contains("hidden"),
        hit: (() => { const b = document.querySelector(`#bottom-nav button[data-nav="${name}"]`); const r = b.getBoundingClientRect(); const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return el && el.closest ? (el.closest(`#bottom-nav button[data-nav="${name}"]`) ? "button" : el.tagName.toLowerCase()) : "null"; })(),
      }), navName);
    };
    for (const name of ["inventory", "match", "foodcounter", "browse"]) {
      const r = await clickBtn(name);
      if (r.hit !== "button") fail(t, `hit-test/click ${name}: pointer fell to <${r.hit}> (dead zone)`);
      const wantHash = "#/" + name, wantHash2 = "#" + name;
      if (r.hash !== wantHash && r.hash !== wantHash2) fail(t, `click ${name}: hash=${r.hash} (no switch)`);
      if (r.viewHidden) fail(t, `click ${name}: #view-${name} still hidden (no render)`);
    }
    // ---------- checklist 3+4+5: recipe detail scroll / pairing card / edit btn ----------
    await page.goto(BASE + "#recipe/r1", { waitUntil: "networkidle0", timeout: 30000 }).catch(() => {});
    await page.evaluate(() => scrollTo(0, 0));
    const detail = await page.evaluate(() => {
      const de = document.documentElement;
      const max = de.scrollHeight - de.clientHeight;
      scrollTo(0, max);
      return { max, noHOverflow: de.scrollWidth === innerWidth, scrollWidth: de.scrollWidth, innerWidth: innerWidth };
    });
    if (!detail.noHOverflow) fail(t, `horizontal overflow: scrollWidth ${detail.scrollWidth} != ${detail.innerWidth}`);
    // after scroll-to-max: pairing card bottom edge visible above the fixed nav,
    // not occluded (contract §14.2-C3 "fully visible (not occluded by nav or dead zone)")
    const pair = await page.evaluate(() => {
      const el = document.getElementById("pairing");
      if (!el) return { found: false };
      const r = el.getBoundingClientRect();
      const nav = document.getElementById("bottom-nav");
      const navTop = nav.getBoundingClientRect().top;
      // sample interior points of the card (incl. its BOTTOM EDGE) — must stay
      // inside the card (never HTML/BODY dead zone, never covered by nav)
      const pts = [[r.bottom - 6, r.x + 8], [r.bottom - 6, r.x + r.width / 2], [r.bottom - 6, r.right - 8]];
      const misses = [];
      for (const [y, x] of pts) {
        if (y < 0 || y >= innerHeight || x < 0 || x >= innerWidth) { misses.push(`pt(${x},${y}) offscreen`); continue; }
        const hit = document.elementFromPoint(Math.round(x), Math.round(y));
        if (!hit) { misses.push(`null`); continue; }
        const inCard = el.contains(hit) || hit === el || el.contains(hit.parentElement) || el.contains(hit);
        if (el.contains(hit) || el.contains(hit.parentElement) || el.contains(hit)) continue; // card or its children
        if (nav.contains(hit) || nav === hit) { misses.push(`covered by nav at (${x},${y})`); continue; }
        misses.push(`${hit.tagName.toLowerCase()}.${String(hit.className||"").split(" ")[0]}@(${x},${y})`);
      }
      return { found: true, bottomAboveNav: r.bottom <= navTop, bottom: Math.round(r.bottom),
               navTop: Math.round(navTop), misses: misses.join(" | ") };
    });
    if (!pair.found) fail(t, "pairing card missing on detail page");
    else if (pair.misses) fail(t, `pairing card bottom edge occluded: ${pair.misses}`);
    else if (!pair.bottomAboveNav) fail(t, `pairing card bottom ${pair.bottom} below nav top ${pair.navTop} (occluded)`);
    const detail2 = await page.evaluate(() => {
      const m = document.querySelector(".detail-wrap .detail-media");
      const mr = m ? m.getBoundingClientRect() : null;
      const wrap = document.querySelector(".detail-wrap");
      const twoCol = wrap ? getComputedStyle(wrap).display === "grid" : false;
      const sticky = m ? getComputedStyle(m).position === "sticky" : false;
      const edit = document.getElementById("edit-open");
      const er = edit ? edit.getBoundingClientRect() : null;
      return { twoCol, sticky, mr: mr ? { x: Math.round(mr.x), y: Math.round(mr.y) } : null,
               editVisible: !!er && er.width > 0 && er.height > 0,
               wrap: !!wrap };
    });
    if (W >= 700) {
      if (!detail2.wrap) fail(t, ".detail-wrap wrapper not rendered (two-column CSS dead again)");
      else if (!detail2.twoCol) fail(t, ".detail-wrap not grid at >=700px");
      if (!detail2.sticky) fail(t, "detail-media not sticky at >=700px");
      if (!detail2.editVisible) fail(t, "Edit button hidden at >=700px (C5 regression)");
    }
    console.log(`[${tag}] nav y${nav.rect.y}..${nav.rect.bottom} pos=${nav.position} twoCol=${detail2.twoCol} stickyMedia=${JSON.stringify(detail2.mr)} scrollMax=${detail.max} pairBottom=${pair.bottom} edit=${detail2.editVisible} ${t.length ? "\n  " + t.join("\n  ") : "OK"}`);
    bad += t.length;
    await page.close();
  }
  await browser.close();
  console.log(bad === 0 ? "ALL-VIEWPORTS-PASS" : `${bad} FAILURES`);
  process.exit(bad === 0 ? 0 : 1);
})().catch((e) => { console.error("PROBE ERROR:", e.message); process.exit(2); });
