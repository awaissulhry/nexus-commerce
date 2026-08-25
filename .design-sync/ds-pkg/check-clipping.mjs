// Fail if any preview card can hide its own overlays — by cropping them, or by
// painting another story on top of them.
//
//   node .design-sync/ds-pkg/check-clipping.mjs [--out ./ds-bundle]
//
// TWO independent failure modes, both invisible to a screenshot (an overlay only
// exists while open, so a card grades "good" from an image that never had one):
//
//   A. CROP    — `.ds-cell{overflow:hidden}` slices the overlay at the cell edge.
//   B. OCCLUDE — `.ds-cell{transform:translateZ(0)}` makes every cell its own
//                stacking context, so an overlay's z-index cannot order it
//                against anything outside its cell and sibling cells paint in
//                DOM order. Fixing A is what exposes B: the overlay escapes the
//                cell and the next story's heading paints straight over it.
//
// B only reproduces when a later story sits BELOW an earlier one, i.e. when the
// auto-fit grid has collapsed to fewer columns. At 1200px the Combobox card is
// clean and at 640px it had 55 occluded sample points — so this sweeps widths.
// Checking one width would have passed the exact bug a user reported.
import { readdirSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const OUT = resolve(process.argv[process.argv.indexOf('--out') + 1] ?? './ds-bundle');
const WIDTHS = [640, 900, 1200];   // 1 / 2 / 3+ column collapses of the auto-fit grid
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

// A sweep that finds nothing must never report success. This printed
// "✓ 0 cards" once, because package-build had just cleared ./ds-bundle and the
// enumeration ran into an empty tree — a green line for a check that inspected
// nothing at all.
if (cards.length < 40) {
  console.error(`✗ overlay check: found only ${cards.length} card(s) under ${OUT} — expected the full set. Is the bundle mid-build?`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const failures = [];

for (const c of cards) {
  for (const width of WIDTHS) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(pathToFileURL(c.path).href, { waitUntil: 'networkidle' });

    // Open each story's overlay IN TURN. Focusing one trigger per card is not
    // enough and produced a false pass: the Combobox card has no toolbar button,
    // so nothing opened, no panel existed, and the occlusion check sampled
    // nothing while the card was visibly broken. A check that cannot reach the
    // state it asserts about reports "unverified", never "clean".
    const cellCount = await page.evaluate(() => document.querySelectorAll('.ds-cell').length);
    let opened = 0;
    for (let ci = 0; ci < cellCount; ci++) {
      opened += await page.evaluate((i) => {
        const cell = document.querySelectorAll('.ds-cell')[i];
        if (!cell) return 0;
        // focus, never click: a click inside a file:// card can submit a form
        // and destroy the execution context mid-check.
        const t = cell.querySelector('input:not([type=checkbox]):not([type=radio]), [role=combobox], button.nds-tbtn, .nds-tooltip > *:first-child, .nds-hovercard > *:first-child, button');
        if (!(t instanceof HTMLElement)) return 0;
        t.focus();
        return 1;
      }, ci);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(140);

    const bad = await page.evaluate((isWidest) => {
      const out = { clipped: [], offscreen: [], occluded: [], panelsSeen: 0 };
      const cells = [...document.querySelectorAll('.ds-cell')];

      // A — the harness clip itself
      for (const cell of cells) {
        if (getComputedStyle(cell).overflow !== 'visible') {
          out.clipped.push(cell.querySelector('h4')?.textContent ?? '(cell)');
        }
      }

      // the sideways clip that overflow:visible cannot fix; only meaningful at
      // the width the cards are authored for
      if (isWidest) {
        const vw = document.documentElement.clientWidth;
        for (const el of document.querySelectorAll('.ds-cell *')) {
          const r = el.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          if (r.left < -0.5 || r.right > vw + 0.5) {
            const tag = typeof el.className === 'string' && el.className ? el.className.split(' ')[0] : el.tagName;
            out.offscreen.push(`${tag} [${Math.round(r.left)}..${Math.round(r.right)}]`);
          }
        }
        out.offscreen = [...new Set(out.offscreen)].slice(0, 4);
      }

      // B — a foreign story painting on top. Ownership, not geometry: the panel
      // legitimately overlaps its neighbour's BOX, and only loses if the top
      // element at a point belongs to a different cell.
      for (const panel of document.querySelectorAll('.ds-cell *')) {
        const cs = getComputedStyle(panel);
        if (cs.position !== 'absolute' && cs.position !== 'fixed') continue;
        const r = panel.getBoundingClientRect();
        if (r.height < 24 || r.width < 24) continue;
        const own = panel.closest('.ds-cell');
        out.panelsSeen++;
        let hits = 0, first = null;
        for (let fy = 0.06; fy < 1; fy += 0.08) {
          for (let fx = 0.12; fx < 1; fx += 0.18) {
            const top = document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy);
            if (!top) continue;
            const topCell = top.closest('.ds-cell');
            if (topCell && topCell !== own) {
              // An overlay may sit over ANOTHER overlay — two open panels have
              // to resolve somehow and the top one is still readable. The bug
              // being guarded is ordinary story content (a heading, a label, an
              // input) painting over a panel, which is what makes it unreadable.
              let overlayTop = false;
              for (let a = top; a && a !== topCell; a = a.parentElement) {
                const ps = getComputedStyle(a).position;
                if (ps === 'absolute' || ps === 'fixed') { overlayTop = true; break; }
              }
              if (overlayTop) continue;
              hits++;
              first ??= (topCell.querySelector('h4')?.textContent ?? '(cell)');
            }
          }
        }
        if (hits) {
          const label = own?.querySelector('h4')?.textContent ?? '(cell)';
          out.occluded.push(`${label}'s overlay covered by ${first} at ${hits} points`);
        }
      }
      // Modal, Drawer, HoverCard, Builder, PreferencesModal and ColumnGroupModal
      // portal their surface to <body>, so it sits outside every .ds-cell: never
      // occlusion-checked (it is above the whole grid by construction) but it IS
      // proof the overlay rendered, which is what "verified" means here.
      for (const el of document.body.children) {
        if (el.closest('.ds-cell')) continue;
        for (const n of [el, ...el.querySelectorAll('*')]) {
          const cs = getComputedStyle(n);
          if ((cs.position === 'fixed' || cs.position === 'absolute')
              && n.getBoundingClientRect().height > 24) { out.panelsSeen++; break; }
        }
      }
      out.occluded = [...new Set(out.occluded)].slice(0, 3);
      return out;
    }, width === Math.max(...WIDTHS));

    const at = `${c.name} @${width}px`;
    if (bad.clipped.length) failures.push(`${at}: ${bad.clipped.length} cell(s) still overflow:hidden — ${bad.clipped.slice(0, 3).join(', ')}`);
    if (bad.offscreen.length) failures.push(`${at}: renders outside the viewport — ${bad.offscreen.join(' · ')}`);
    if (bad.occluded.length) failures.push(`${at}: overlay painted over — ${bad.occluded.join(' · ')}`);
    // "Could not verify" is only a failure when there was something to verify.
    // Badge, Divider, Kbd and Pill have no overlay in their markup at all, and
    // reporting them as unverified is a probe inventing failures — the noise
    // then teaches you to skim the report, which is how the real line gets
    // missed.
    if (!opened && width === WIDTHS[0]) {
      const hasOverlay = await page.evaluate(() => !!document.querySelector(
        '[role=combobox], [role=listbox], [role=menu], [role=dialog], [aria-haspopup],' +
        '.nds-tooltip, .nds-hovercard, [class*="-pop"], [class*="-menu"], [class*="-drop"]',
      ));
      // A card whose overlay renders already-open (Modal, Drawer, PreferencesModal)
      // has no trigger to focus and needs none — its panel was inspected. Only a
      // card where nothing opened AND no panel was ever seen is unverified.
      if (hasOverlay && bad.panelsSeen === 0) {
        failures.push(`${c.name}: has overlay markup, no trigger could be focused, and no panel ever rendered — the check did not actually verify it`);
      }
    }
  }
}

await browser.close();

if (failures.length) {
  console.error(`✗ overlay check: ${failures.length} problem(s) across ${cards.length} cards × ${WIDTHS.length} widths:`);
  for (const f of failures) console.error('  ' + f);
  process.exit(1);
}
console.log(`✓ overlay check: ${cards.length} cards × ${WIDTHS.join('/')}px — nothing cropped, nothing off-viewport, no overlay painted over by another story`);
