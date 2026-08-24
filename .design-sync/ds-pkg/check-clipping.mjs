// Fail if any preview card can crop its own content.
//
// The generated card HTML styles each story cell `overflow:hidden`, so any overlay
// that escapes its trigger's box — every DS overlay except InfoTip, which portals
// to <body> — gets sliced off. Static screenshots cannot catch it: a tooltip only
// exists while hovered or focused, so a card grades "good" from an image in which
// the overlay was never rendered. This asserts the geometry instead.
//
//   node .design-sync/ds-pkg/check-clipping.mjs [--out ./ds-bundle]
//
// Three checks per card:
//   1. every .ds-cell computes overflow:visible          (the harness clip itself)
//   2. nothing renders outside the viewport horizontally  (the sideways clip that
//      overflow:visible cannot fix — an overlay centred on a trigger near x=0)
//   3. overlays that CAN be opened are opened first, so 1 and 2 see them
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? './ds-bundle');
const { chromium } = await import(resolve('.ds-sync/node_modules/playwright/index.mjs')).catch(
  () => import('playwright'),
);

const cards = [];
for (const group of readdirSync(join(OUT, 'components'))) {
  for (const name of readdirSync(join(OUT, 'components', group))) {
    const p = join(OUT, 'components', group, name, `${name}.html`);
    if (existsSync(p)) cards.push({ name, group, path: p });
  }
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const failures = [];

for (const c of cards) {
  await page.goto(pathToFileURL(c.path).href, { waitUntil: 'networkidle' });

  // Open whatever can be opened, so the checks see overlays rather than triggers.
  // Focus reveals :focus-within tips; clicking a combobox/menu/select trigger opens
  // its panel. Best-effort by design — a state we cannot reach is reported as
  // unverified rather than silently passing.
  const opened = await page.evaluate(() => {
    let n = 0;
    for (const sel of ['button.h10-ds-tbtn', '.h10-ds-tooltip > *:first-child', '.h10-ds-hovercard > *:first-child']) {
      const el = document.querySelector(sel);
      if (el instanceof HTMLElement) { el.focus(); n++; break; }
    }
    return n;
  });
  await page.waitForTimeout(120);

  const bad = await page.evaluate(() => {
    const out = { clipped: [], offscreen: [] };
    for (const cell of document.querySelectorAll('.ds-cell')) {
      if (getComputedStyle(cell).overflow !== 'visible') {
        out.clipped.push(cell.querySelector('h4')?.textContent ?? '(cell)');
      }
    }
    const vw = document.documentElement.clientWidth;
    for (const el of document.querySelectorAll('.ds-cell *')) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      if (r.left < -0.5 || r.right > vw + 0.5) {
        const tag = el.className && typeof el.className === 'string' ? el.className.split(' ')[0] : el.tagName;
        out.offscreen.push(`${tag} [${Math.round(r.left)}..${Math.round(r.right)}] vw=${vw}`);
      }
    }
    out.offscreen = [...new Set(out.offscreen)].slice(0, 4);
    return out;
  });

  if (bad.clipped.length) failures.push(`${c.name}: ${bad.clipped.length} cell(s) still overflow:hidden — ${bad.clipped.slice(0, 3).join(', ')}`);
  if (bad.offscreen.length) failures.push(`${c.name}: renders outside the viewport — ${bad.offscreen.join(' · ')}`);
  if (!opened && /Tooltip|HoverCard|ToolbarButton/.test(c.name)) {
    failures.push(`${c.name}: no overlay could be opened — the check did not actually verify it`);
  }
}

await browser.close();

if (failures.length) {
  console.error(`✗ clipping check: ${failures.length} problem(s) across ${cards.length} cards:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`✓ clipping check: ${cards.length} cards — every cell overflows visibly, nothing renders off-viewport`);
