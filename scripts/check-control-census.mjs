#!/usr/bin/env node
/**
 * check-control-census — the studio's CONTROL VOCABULARY, asserted from the rendered DOM.
 *
 * Why this exists (CT.1, 2026-09-04). One viewport of the Product Edit Studio held five control
 * heights (26 · 28 · 30 · 31 · 48), four type sizes and five radii on controls sharing a 40px bar;
 * the Errors & Sync facets were a clickable Pill rendering at the PAGE's 16px / 400 because of a
 * DS rule that had been filed as a one-line fix nine days earlier; the toolbar's filter toggles
 * were buttons; the global "Ask AI" button sat on the sheet's scrollbar. Every one of those was a
 * control someone reached for without a rule saying which control, at which size. The fix put the
 * rule in the DS (`--nds-control-h-sm`, `FilterChip size="md"`, `Tabs size="sm"`, …); this gate
 * is what keeps it true after the next lane adds a button.
 *
 * The RULE, in three clauses, each asserted below against the live page:
 *
 *   1. BARS are on the tier. Inside the product header, the scope row, the sheet toolbar and the
 *      record drawer's strip, every control is exactly `--nds-control-h-sm` (28px) — except a tab,
 *      which is a strip-height element (it stretches to its 40px host so the indicator meets the
 *      host's edge), and a plain text link, which is not a control box.
 *   2. EVERYTHING is DS. Inside the studio frame — outside AG Grid's own DOM and the app rail — no
 *      interactive element renders without an `nds-*` class from the allow-list below. A raw
 *      `<button>` or a Tailwind-styled one is a fork the DS guards cannot see, because they read
 *      source and this reads the screen.
 *   3. PANELS use DS tiers. Inside a tab panel (Errors & Sync, Analytics & Ads, Activity, Images),
 *      every control is one of the DS's own sizes (24 filter chip · 26 segmented option · 28 sm ·
 *      30 md), and a filter chip in a bar is the `md` 28.
 *
 * Plus two facts that are cheap to assert and expensive to lose: the "Ask AI" FAB is ABSENT on
 * every studio surface, and the record panel starts immediately below the visible global header.
 *
 * What it deliberately does NOT assert: anything inside AG Grid (`.ag-root`) — cells, header
 * buttons, editors — which is the open-gesture gate's ground; and the drawer's field controls,
 * which are a form, not a bar.
 *
 * Exit codes (the open-gesture gate's convention, #781): 0 green · 1 a real miss · 2 refused to
 * run (another browser gate is mid-run, or the dev servers are not up — a gate that cannot look is
 * not passing, and it says so rather than printing green over nothing).
 *
 * 🔴 Before a run against a SHARED dev server: announce it in `docs/pes-claims.md` and ask peers
 * to hold apps/web AND apps/api writes until it ends — an HMR recompile or an API restart mid-run
 * produces false failures (b0's run 2, 2026-09-04, five rows lost to seventeen saves). Engine and
 * CSS saves recompile the studio page too.
 *
 * Usage:  node scripts/check-control-census.mjs                      # all surfaces
 *         CENSUS_ONLY=variants node scripts/check-control-census.mjs  # surfaces whose key matches
 *         CENSUS_BASE=http://localhost:3000 CENSUS_PRODUCT=<id> node scripts/check-control-census.mjs
 *
 * 🔴 `CENSUS_ONLY` narrows the RUN, never the rule. A filtered run that matches nothing exits 2
 * (refused), not 0 — "I looked at no surfaces" must never read as "every surface passed".
 */
import { authenticatedStudioPage } from './studio-browser-auth.mjs'
import { assertVariantsSelection } from './studio-variants-selection.mjs'
import { chromium } from '@playwright/test'
import { execSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { loadavg } from 'node:os'

const BASE = process.env.CENSUS_BASE ?? process.env.EDITOR_BASE ?? 'http://localhost:3000'
const PRODUCT = process.env.CENSUS_PRODUCT ?? process.env.EDITOR_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const ROWS_MS = Number(process.env.CENSUS_ROWS_MS ?? 60000)
const SM = 28
const TOOLBAR_H = 40
/** The record/mapping dock's width — spec 2026-09-11 §2, `--studio-dock-w` on the track. */
const DOCK_W = 420

/* The mapping dock's root. Three spellings, and that is a CONTRACT rather than a guess: the DS
   drawer's two dock modes, plus `.nds-vp-dock`, which is what VP.4 built (`MappingDock.tsx:145`,
   an `<aside role="dialog">`). §2 points at the `StudioDock` pattern rather than the component, so
   a page-local root is within the spec — but the gate has to be told the name, exactly as it had
   to be told `.nds-pageband`. Measured 2026-09-11: pressing `Edit mapping` opened a surface this
   list did not name, and the gate correctly reported NOT MEASURED rather than passing. */
/* 🔴 MEASURE THE TRACK, NOT THE PANEL. §2 says "420 wide, in-flow flex sibling
   (`--studio-dock-w` on the TRACK)" — and the track spends 1px of its 420 on a border-left
   separator, so under `border-box` its content is 419 and the panel inside fills exactly that.
   Measured 2026-09-11: panel 419.00 / computed `width: 419px` / zero borders, inside a track of
   420.00 / `width: 420px` / `border-left: 1px` / `--studio-dock-w: 420px`. Measuring the panel
   reported a 1px defect that does not exist, and I nearly routed it to a lane. The rule is the
   same one §2 already spells out for the subheader (49 = 48 + 1) and the AG header (28 + 1): the
   band includes its rule. So: walk up to the element that CARRIES the token and measure that. */
const DOCK_ROOT = '.nds-drawer-dock, .nds-drawer-embedded, .nds-vp-dock'

/**
 * Classes a studio control may carry. A control outside this set is a fork, whatever it looks like.
 *
 * 🔴 FOUR OF THESE NAMES WERE NAMES THE APP NEVER RENDERS, and the gate was convicting the real
 * controls because of it. Measured 2026-09-11 across `apps/web/src`:
 *
 *     nds-toolbarbtn   0 files   — `ToolbarButton` emits `nds-tbtn`, which spec §2 itself names
 *     nds-combobox     0 files   — `Combobox` emits `nds-combo` / `nds-combo-in`
 *     nds-checkbox     0 files   — `Checkbox` emits `nds-check`
 *     nds-switch       0 files   — there is no switch; `Toggle` emits `nds-toggle`
 *
 * `nds-toolbarbtn` alone convicted the subheader's "Expand product navigation" button as NOT DS on
 * EVERY surface of the run, which is a gate reporting its own staleness as a build defect (VP.3's
 * 18:36 run, exit 1). An allow-list is a SET CLAIM about another file and goes stale in hours —
 * so it is no longer only curated: `assertAllowListIsReal()` below refuses the run if any name
 * here has stopped appearing in the design system. Found by VP.4 and VP.3, verified in the
 * sources rather than relayed.
 */
const ALLOWED = new Set([
  'nds-btn', 'nds-scope', 'nds-tab', 'nds-listbox-btn', 'nds-fchip', 'nds-seg-opt', 'nds-modal-x',
  'nds-field', 'nds-select', 'nds-pill', 'nds-prow-action', 'nds-tbtn', 'nds-drawer-grip',
  'nds-check', 'nds-radio', 'nds-toggle', 'nds-ms-btn', 'nds-combo-in', 'nds-thumb',
  'nds-expand',
  // VP.5 — the Variants page's band chips (spec 2026-09-11 §3.1). `MappingChip` is a static span
  // and is never queried: only interactive elements reach the census.
  'nds-axischip',
])

/**
 * Every name in ALLOWED must still be a class the design system renders. A name that has stopped
 * appearing cannot be worn by any control, so it can only do one thing: convict whatever replaced
 * it. Refuses (exit 2) rather than failing, because a stale list is a defect in the GATE and the
 * run it would produce is not evidence about the build.
 */
function assertAllowListIsReal() {
  /* 🔴 READ THE FILES; DO NOT `grep` THEM. A single raw NUL byte makes BSD grep treat a source
     file as binary and print NOTHING — not a match, not "binary file matches", not even
     `grep -c ""` — while exiting 1, the same code it uses for "no match". `tsc` passes. So a
     class that lives only in such a file reads as ABSENT, and this check would refuse the run
     over a name that is perfectly alive. Measured 2026-09-11 (VP.1): 2 of 3304 files under
     `apps/web/src` were in that state, one of them in `design-system/grid/workspace/`. Verified
     NUL-safely that no allowed name lives only in a blinded file today — but a check that could
     be blinded tomorrow is not a check. */
  const root = 'apps/web/src/design-system'
  const seen = new Set()
  const walk = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) { walk(full); continue }
      if (!/\.(ts|tsx|css)$/.test(e.name)) continue
      const text = readFileSync(full, 'latin1') // byte-preserving; a NUL is just another char
      for (const name of ALLOWED) if (!seen.has(name) && text.includes(name)) seen.add(name)
    }
  }
  try {
    walk(root)
  } catch {
    return null // cannot look; say so rather than assert
  }
  return [...ALLOWED].filter((n) => !seen.has(n))
}
/** DS control tiers a PANEL control may sit on: filter chip · segmented option · sm · md. */
const PANEL_TIERS = new Set([24, 26, 28, 30])

const ONLY = (process.env.CENSUS_ONLY ?? '').trim()

const STUDIO = `${BASE}/products/${PRODUCT}/edit/studio`
const ALL_SURFACES = [
  { key: 'master · sheet', url: STUDIO, kind: 'sheet' },
  { key: 'amazon·DE · sheet', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de`, kind: 'sheet' },
  { key: 'amazon·DE · errors', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de&tab=errors`, kind: 'panel' },
  { key: 'amazon·DE · analytics', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de&tab=analytics`, kind: 'panel' },
  { key: 'amazon·DE · activity', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de&tab=activity`, kind: 'panel' },
  { key: 'amazon·DE · images', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de&tab=images`, kind: 'panel' },
  // A third coordinate on a different channel: the census must hold on every sheet, not the two it
  // was written against (a fixture pins a dimension — the arm never run is the one that fails).
  { key: 'ebay·IT · sheet', url: `${STUDIO}?scope=EBAY&market=IT&locale=it`, kind: 'sheet' },
  { key: 'amazon·DE · drawer', url: null, kind: 'drawer' }, // url is derived from the sheet's first row

  /* ── VP.5: the four Variants surfaces (spec 2026-09-11 §2, §8 row VP.5) ─────────────────────
     Two are sheets and behave like any other. Two are OVERLAYS that no URL reaches: the mapping
     dock opens on `Edit mapping` (§4.4) and the generate modal on `Generate combinations` (§3.4),
     so the gate has to press the control the operator presses. Pressing is safe here and stays
     safe by construction, not by assumption: every non-GET to the API is aborted at the network
     layer a few lines below, and both of these controls only open a surface. A probe's safety is
     not a loan from the page — if a lane ever makes one of these buttons write, this list is the
     place that has to change. */
  { key: 'master · variants', url: `${STUDIO}?tab=variants`, kind: 'sheet' },
  { key: 'ebay·IT · variants', url: `${STUDIO}?scope=EBAY&market=IT&locale=it&tab=variants`, kind: 'sheet' },
  {
    key: 'ebay·IT · variants · dock open',
    url: `${STUDIO}?scope=EBAY&market=IT&locale=it&tab=variants`,
    kind: 'overlay',
    open: { label: /^Edit mapping$/, witness: DOCK_ROOT },
  },
  {
    key: 'master · variants · generate modal',
    url: `${STUDIO}?tab=variants`,
    kind: 'overlay',
    open: { label: /^Generate combinations$/, witness: '.nds-modal' },
  },

  /* ── MX.P: the Matrix surfaces (design 2026-09-13, Revision) ────────────────────────────────
     ONE state — every coordinate at once — and the scope bar FILTERS the groups rather than
     switching surfaces, so the second row here is the same page narrowed to one channel's groups
     (a fixture pins a dimension: a census taken on the full page alone never sees the filtered
     toolbar). Both are sheets: `SheetToolbar` + `GridSheet` + `NexusGrid`, like the Variants page.
     In preview mode (while `GET …/studio/matrix` answers 404) every write goes to an in-memory
     store, and the non-GET abort below is the belt to that. */
  { key: 'master · matrix', url: `${STUDIO}?tab=matrix`, kind: 'sheet' },
  { key: 'amazon·DE · matrix', url: `${STUDIO}?scope=AMAZON&market=DE&locale=de&tab=matrix`, kind: 'sheet' },
]

/** A filtered run measures fewer surfaces; it never measures them more loosely. */
const SURFACES = ONLY ? ALL_SURFACES.filter((s) => s.key.includes(ONLY)) : ALL_SURFACES

/* ── refuse to run over another browser gate, or without the servers ───────────────────────── */

function otherGateRunning() {
  let rows = []
  try {
    rows = execSync('ps -Ao pid=,ppid=,args=', { encoding: 'utf8' }).split('\n').map((l) => {
      const m = l.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/)
      return m ? { pid: Number(m[1]), ppid: Number(m[2]), args: m[3] } : null
    }).filter(Boolean)
  } catch {
    return null
  }
  /* 🔴 PARSE THE FIELDS; NEVER REGEX THE COMPOSED LINE (the open-gesture gate's own lesson, and
     this script's first run repeated it): the `zsh -c` WRAPPER that launched THIS process carries
     the script name in its command line, so a substring test reported "another gate is running" on
     every solo run, by construction. A gate is a process whose args START with `node ` and name a
     gate script, and is not this pid. */
  /* 🔴 …AND NOT THIS PROCESS'S PARENT (VT.2, 2026-09-13). The `startsWith('node ')` test above was
     written to defeat a `zsh -c` wrapper, and `scripts/studio-gate-session.mjs` — the signed-in
     session every lane now runs gates inside (R-GATE-1) — defeats it right back: its own argv IS
     `node scripts/studio-gate-session.mjs -- node scripts/check-control-census.mjs`, which both
     starts with `node ` and names a gate script. Excluded by PID, so a genuine second gate started
     through the same wrapper is still reported. */
  return rows
    .filter((r) => r.pid !== process.pid && r.pid !== process.ppid)
    .filter((r) => r.args.startsWith('node ') && /scripts\/check-(editor-open|control-census)\.mjs/.test(r.args))
    .map((r) => `pid ${r.pid} ppid ${r.ppid}  ${r.args}`)
}

async function reachable(url) {
  try {
    const r = await fetch(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(8000) })
    return r.status > 0
  } catch {
    return false
  }
}

/* ── the census, evaluated in the page ─────────────────────────────────────────────────────── */

/** Runs in the browser. Returns every interactive element outside AG and the rail, with its box. */
function censusInPage({ ALLOWED, SM, TOOLBAR_H, keepFormControls, DOCK_ROOT }) {
  const allowed = new Set(ALLOWED)
  const r = (el) => {
    const b = el.getBoundingClientRect()
    return { x: Math.round(b.left), y: Math.round(b.top), w: Math.round(b.width), h: Math.round(b.height) }
  }
  const inBar = (el) =>
    !!el.closest('.nds-detailhdr, .nds-scopebar, .nds-toolbar') || !!el.closest('.nds-drawer-dock .nds-tabs') ||
    el.classList.contains('nds-modal-x')
  const els = [...document.querySelectorAll('button, [role="tab"], [role="button"], a.nds-btn, input, select, textarea')]
    .filter((e) => {
      const b = e.getBoundingClientRect()
      if (b.width === 0 || b.height === 0) return false
      if (e.closest('.ag-root') || e.closest('.h10-rail') || e.closest('.nds-topbar')) return false
      /* The record drawer's FORM controls are a form, not a bar (clause 3 does not apply to them
         either). An OVERLAY surface keeps them: the mapping dock IS the thing being censused
         there, and dropping its listboxes and radios would leave that surface asserting nothing
         about the controls it exists to check. They are graded on clause 2 and on the DS tiers,
         never on the 28px bar tier. */
      if (!keepFormControls && e.closest('.nds-drawer-dock') && !inBar(e)) return false
      // A `<Field>` renders the border on a wrapper span; measure the wrapper, not the input.
      return true
    })
  const out = []
  for (const e of els) {
    /* A `<Field>` / `<Select>` / `Checkbox` / `Radio` renders its class AND its border on a
       WRAPPER; measure and classify the wrapper.

       🔴 This used to look only for `.nds-field` around an INPUT. The DS `Checkbox` and `Radio`
       render `<label class="nds-check|nds-radio"><input …></label>` with the input carrying NO
       class at all, so the query found nothing, `nds` came back empty, and clause 2 reported a
       genuine DS radio as `NOT DS: <input class="">`. It had never fired because no censused
       surface held one — the drawer's form controls are excluded a few lines below — and the
       mapping dock's two listing-split radios (§4.4.3) are the first that would have. Found by
       VP.4, 2026-09-11. */
    const wrap =
      e.tagName === 'INPUT'
        ? e.closest('.nds-field, .nds-check, .nds-radio')
        : e.tagName === 'SELECT'
          ? e.closest('.nds-select')
          : null
    const box = r(wrap ?? e)
    const cs = getComputedStyle(e)
    const classes = [...(wrap ?? e).classList]
    const nds = classes.filter((c) => c.startsWith('nds-'))
    const ok = nds.some((c) => allowed.has(c))
    const chipLabel = e.classList.contains('nds-fchip') ? e.querySelector('.t') : null
    const text = (e.innerText || e.getAttribute('aria-label') || e.placeholder || '').replace(/\s+/g, ' ').trim().slice(0, 24)
    out.push({
      tag: e.tagName.toLowerCase(),
      classes: classes.join(' '),
      nds: nds.join(' '),
      dsClass: ok,
      bar: inBar(e),
      // In an overlay's BODY rather than one of its bars: a form control.
      inForm: !inBar(e) && !!e.closest(`${DOCK_ROOT}, .nds-modal-b`),
      isTab: e.classList.contains('nds-tab'),
      // Text-level things are not control boxes: a plain link, the DS `link`/`inline` button
      // variants (which the DS itself defines as sentence-level), and a pressable ROW.
      isLink:
        (e.tagName === 'A' && !e.classList.contains('nds-btn')) ||
        e.classList.contains('link') || e.classList.contains('inline') || e.classList.contains('nds-prow-action') ||
        // Binary inputs are DS controls at their OWN size (15px tick, 17px switch), not control
        // boxes on a tier. Read the WRAPPER's classes, not the input's: a Checkbox and a Radio
        // carry their class on the label, so testing the input exempted neither.
        ['nds-toggle', 'nds-check', 'nds-radio'].some((c) => classes.includes(c)),
      h: box.h,
      chipLabelH: chipLabel?.getBoundingClientRect().height ?? null,
      chipLineH: chipLabel ? parseFloat(getComputedStyle(chipLabel).lineHeight) : null,
      fs: cs.fontSize,
      fw: cs.fontWeight,
      text,
    })
  }
  const fab = [...document.querySelectorAll('button')].some((b) => /Ask AI/.test(b.innerText))
  const panel = document.querySelector('.nds-drawer-dock')
  const tabsStrip = document.querySelector('.nds-drawer-dock .nds-tabs')
  return {
    controls: out,
    fab,
    headerBottom: (() => {
      const header = document.querySelector('.nds-topbar')
      return header && header.getBoundingClientRect().height > 0 ? Math.round(header.getBoundingClientRect().bottom) : 0
    })(),
    panelTop: panel ? Math.round(panel.getBoundingClientRect().top) : null,
    drawerStripH: tabsStrip ? Math.round(tabsStrip.parentElement.getBoundingClientRect().height) : null,
    dockW: (() => {
      const d = document.querySelector(DOCK_ROOT)
      if (!d) return null
      /* MEASURE THE TRACK, NOT THE PANEL: §2 puts `--studio-dock-w` on the track, and the track
         spends 1px of its 420 on a border-left separator, so the panel inside fills 419. Measuring
         the panel reports a 1px defect that does not exist. */
      /* 🔴 A CUSTOM PROPERTY INHERITS, so "the element carrying `--studio-dock-w`" matched the
         PANEL itself and the walk stopped before it began — the token is readable on every
         descendant. Measured: the gate reported "track w419, panel 419" where a direct read of
         `d.parentElement` gives 420. The honest rule is not "who declares it" (CSS cannot answer
         that) but "whose WIDTH IS it": parse the token and find the ancestor that measures it. */
      const want = parseFloat(getComputedStyle(d).getPropertyValue('--studio-dock-w')) || null
      let track = null
      if (want) for (let n = d; n; n = n.parentElement) {
        if (Math.round(n.getBoundingClientRect().width) === Math.round(want)) { track = n; break }
      }
      return {
        panel: Math.round(d.getBoundingClientRect().width),
        track: track ? Math.round(track.getBoundingClientRect().width) : null,
        token: want,
      }
    })(),
    modalPresent: !!document.querySelector('.nds-modal'),
    scopebarH: document.querySelector('.nds-scopebar') ? Math.round(document.querySelector('.nds-scopebar').getBoundingClientRect().height) : null,
    toolbarH: document.querySelector('.nds-toolbar') ? Math.round(document.querySelector('.nds-toolbar').getBoundingClientRect().height) : null,
    SM,
    TOOLBAR_H,
  }
}

/* ── the rules ─────────────────────────────────────────────────────────────────────────────── */

function judge(surface, c) {
  const fails = []
  const seen = new Map()
  for (const k of c.controls) {
    if (k.bar && k.chipLabelH != null && Number.isFinite(k.chipLineH) && k.chipLabelH > k.chipLineH + 1) {
      fails.push(`STACKED CHIP LABEL: "${k.text}" occupies ${k.chipLabelH}px for a ${k.chipLineH}px line`)
    }
    const sig = `${k.tag} ${k.nds || '(no nds class)'} h${k.h} ${k.fs}/${k.fw}`
    seen.set(sig, (seen.get(sig) ?? 0) + 1)
    // clause 2 — everything is DS
    if (!k.dsClass && !k.isLink) fails.push(`NOT DS: <${k.tag} class="${k.classes || ''}"> "${k.text}"`)
    if (k.isLink) continue
    if (k.bar) {
      // clause 1 — bars are on the tier; a tab is strip-height
      if (k.isTab) {
        if (k.h !== TOOLBAR_H && k.h !== TOOLBAR_H - 1) fails.push(`TAB NOT STRIP-HEIGHT: "${k.text}" h${k.h} (want ${TOOLBAR_H - 1}–${TOOLBAR_H})`)
      } else if (k.h !== SM) {
        fails.push(`BAR CONTROL OFF TIER: <${k.tag} ${k.nds}> "${k.text}" h${k.h} (want ${SM})`)
      }
      if (k.nds.includes('nds-fchip') && !k.classes.split(' ').includes('md')) fails.push(`BAR CHIP NOT md: "${k.text}"`)
    } else if (surface.kind === 'panel') {
      // clause 3 — panels use DS tiers
      if (!PANEL_TIERS.has(k.h)) fails.push(`PANEL CONTROL OFF ANY TIER: <${k.tag} ${k.nds}> "${k.text}" h${k.h}`)
    } else if (surface.kind === 'overlay' && k.inForm) {
      // clause 3, applied to an overlay's body. §4.4 puts the dock on the DS's own sizes
      // (`Listbox sm`, a ghost button, a 28px close), so an off-tier control there is a fork.
      if (!PANEL_TIERS.has(k.h)) fails.push(`OVERLAY CONTROL OFF ANY TIER: <${k.tag} ${k.nds}> "${k.text}" h${k.h}`)
    }
  }
  if (c.fab) fails.push('ASK AI FAB PRESENT on a studio surface (it opts out with the top bar)')
  if (c.scopebarH != null && c.scopebarH !== TOOLBAR_H) fails.push(`SCOPE ROW h${c.scopebarH} (want ${TOOLBAR_H})`)
  if (surface.kind === 'sheet' && c.toolbarH != null && c.toolbarH < TOOLBAR_H) fails.push(`SHEET TOOLBAR h${c.toolbarH} (minimum ${TOOLBAR_H})`)
  if (surface.kind === 'overlay') {
    // Every assertion returns its MEASURED value, so a reader never has to re-derive one.
    if (surface.open.witness === DOCK_ROOT) {
      if (c.dockW == null) fails.push('MAPPING DOCK NOT FOUND after pressing Edit mapping — NOT MEASURED')
      else if (c.dockW.track == null) fails.push(`MAPPING DOCK: no ancestor measures --studio-dock-w (${c.dockW.token ?? 'token unset'}) — NOT MEASURED. The panel is ${c.dockW.panel}.`)
      else if (c.dockW.track !== DOCK_W) fails.push(`MAPPING DOCK TRACK w${c.dockW.track} (want ${DOCK_W} — spec §2, §4.4; the panel inside measures ${c.dockW.panel})`)
      else console.log(`   ·  mapping dock: track ${c.dockW.track} · panel ${c.dockW.panel} (the track's 1px separator is the difference)`)
    } else if (!c.modalPresent) {
      fails.push('GENERATE MODAL NOT FOUND after pressing Generate combinations — NOT MEASURED')
    }
  }
  if (surface.kind === 'drawer') {
    if (c.panelTop == null) fails.push('RECORD PANEL NOT FOUND')
    else if (c.panelTop !== c.headerBottom) fails.push(`RECORD PANEL TOP ${c.panelTop} (want ${c.headerBottom} — immediately below the visible global header)`)
    if (c.drawerStripH != null && c.drawerStripH !== TOOLBAR_H) fails.push(`DRAWER STRIP h${c.drawerStripH} (want ${TOOLBAR_H})`)
  }
  return { fails, seen }
}

// The toolbar may wrap. Guard actual visibility, including card padding, instead of enforcing
// a fixed height that clipped Amazon's More button. Keep this check independent of control tiers.
function toolbarLayoutInPage() {
  const bar = document.querySelector('.nds-grid-sheet .nds-toolbar')
  if (!bar) return ['Sheet toolbar not found']
  const box = bar.getBoundingClientRect()
  const css = getComputedStyle(bar)
  const left = box.left + parseFloat(css.paddingLeft)
  const right = Math.min(innerWidth, box.right - parseFloat(css.paddingRight))
  const failures = []
  if (bar.scrollWidth > bar.clientWidth + 1) failures.push('Toolbar overflows horizontally')
  for (const el of bar.querySelectorAll('button,input,[role="note"]')) {
    const r = el.getBoundingClientRect()
    if (!r.width || !r.height) continue
    if (r.left < left - 1 || r.right > right + 1 || r.top < box.top || r.bottom > box.bottom) {
      failures.push(`Clipped toolbar control: ${el.getAttribute('aria-label') || el.textContent?.trim() || el.tagName}`)
    }
  }
  return failures
}

/* ── main ──────────────────────────────────────────────────────────────────────────────────── */

const stale = assertAllowListIsReal()
if (stale === null) {
  console.error('⚠ could not READ the design system to verify the allow-list; running anyway (staleness unknown)')
} else if (stale.length) {
  console.error(`⛔ the control allow-list names ${stale.length} class(es) the design system no longer renders:`)
  for (const n of stale) console.error(`   ${n}`)
  console.error('   A name nothing wears cannot exempt anything — it can only convict whatever replaced it.')
  console.error('   Fix the list in this script before running; a census taken against a stale list is not evidence.')
  process.exit(2)
}

const running = otherGateRunning()
if (running === null) {
  console.error('⚠ could not list processes; running anyway (contention unknown)')
} else if (running.length) {
  console.error('⛔ another browser gate is mid-run; gate runs are serialised (announce-and-acknowledge):')
  for (const l of running) console.error(`   ${l.slice(0, 120)}`)
  process.exit(2)
}
if (!(await reachable(BASE))) {
  console.error(`⛔ ${BASE} is not reachable — the census reads the SCREEN and has nothing to look at. Start the web dev server, or export CENSUS_BASE.`)
  process.exit(2)
}
if (SURFACES.length === 0) {
  console.error(`⛔ CENSUS_ONLY="${ONLY}" matched none of the ${ALL_SURFACES.length} surfaces. A run that looks at nothing is not a pass.`)
  console.error(`   surfaces: ${ALL_SURFACES.map((s) => s.key).join(' · ')}`)
  process.exit(2)
}
console.log(`control census · ${BASE} · product ${PRODUCT} · ${SURFACES.length}/${ALL_SURFACES.length} surface(s)${ONLY ? ` (CENSUS_ONLY="${ONLY}")` : ''} · load ${loadavg()[0].toFixed(2)} · ${new Date().toISOString()}`)

const browser = await chromium.launch()
const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: 1440, height: 900 } }).catch(async error => { await browser.close(); console.error(error.message); process.exit(2) })
// This gate LOOKS. It never writes: every non-GET to the API is aborted at the network layer.
await page.route('**/*', (route) => {
  const req = route.request()
  const preview = req.method() === 'POST' && /\/studio\/family\/generate(?:\?|$)/.test(req.url()) && req.postDataJSON()?.dryRun === true
  if (req.method() !== 'GET' && /\/api\//.test(req.url()) && !preview) return route.abort()
  return route.continue()
})

/* 🔴 The same discrimination the layout gate needed: a page that THREW and a page that is slow
   both render no controls, and "did not render within N ms" is the wrong diagnosis for the first.
   Collected per surface and cleared before each one, so an error is attributed to the page that
   raised it. (VP.4, 2026-09-11: a flattened API field took the channel surface to Next's error
   boundary and my other gate called it a slow load.) */
/* 🔴 A CONSOLE ERROR IS NOT A THROW, and my first version said it was. A failed resource logs
   `Failed to load resource: … 401` to the console; collecting that into `thrown` made four panel
   surfaces report "the page THREW" when nothing threw — an `anon` session simply could not fetch
   their data. Over-claiming in the direction of alarm is still over-claiming. Three buckets now,
   because they are three different diagnoses and each points somewhere else:
     pageerror   — a genuine uncaught exception: the page is broken
     request     — `Failed to load resource` / net::ERR_*: the page is fine, the FETCH failed
     console     — anything else the page logged as an error */
let thrown = []
let failedRequests = []
let consoleErrors = []
page.on('pageerror', (e) => thrown.push(String(e.message ?? e).split('\n')[0]))
page.on('console', (m) => {
  if (m.type() !== 'error') return
  const t = m.text().split('\n')[0]
  if (/Failed to load resource|net::ERR_|ERR_FAILED/i.test(t)) failedRequests.push(t)
  else consoleErrors.push(t)
})

let exit = 0
let drawerUrl = null
const summary = []
for (const s of SURFACES) {
  let url = s.url
  if (s.kind === 'drawer') {
    if (!drawerUrl) { summary.push(`✗ ${s.key}: no row id captured from the sheet — NOT MEASURED`); exit = 1; continue }
    url = drawerUrl
  }
  thrown = []; failedRequests = []; consoleErrors = []
  // The sheet and family requests resolve independently. Rows alone do not make the
  // Generate control ready: it needs the family axes as well.
  const familyRead = s.open?.witness === '.nds-modal'
    ? page.waitForResponse(response => response.request().method() === 'GET' && new URL(response.url()).pathname.endsWith('/studio/family'), { timeout: ROWS_MS })
        .then(async response => ({ ok: response.ok(), body: await response.json() }))
        .catch(error => ({ ok: false, error: error.message }))
    : null
  await page.goto(url, { waitUntil: 'domcontentloaded' })
  let ready = true
  if (s.kind === 'sheet' || s.kind === 'drawer' || s.kind === 'overlay') {
    ready = await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
  } else {
    /* 🔴 THIS CONDITION COULD NEVER BE TRUE, AND HAD NOT BEEN FOR DAYS. It waited for
       `.nds-tab.on` + `[role="tabpanel"]`, and the studio stopped rendering a tab strip when
       navigation became the 224px drawer — the only `_studio` file importing the DS `Tabs` is
       `drawer/RecordDrawer.tsx`. Measured 2026-09-11 on three surfaces: `.nds-tab` 0 and
       `[role=tabpanel]` 0 on ALL of them, including `master · variants`, which renders 21 AG rows
       and 142 controls.

       ⚠ SCOPE, and be exact about it (VP.1's correction to my own first write-up): this condition
       only ever RAN on `kind: 'panel'` — the branch above sends sheet, drawer and overlay to
       `.ag-row[row-id]`. So the selector matching nothing on `master · variants` is a fact about
       the SELECTOR, not about that surface's reading: the sheets did not pass despite a dead
       condition, the condition never ran on them. Blast radius FOUR surfaces, not twelve. A claim
       that overstates its reach is the kind that goes false later.

       So the four panel surfaces were never measured — and I had reported them
       as a PERMISSION hole, because each also logs one failed request. They are not: the same
       failed request appears on every green surface too, `amazon·DE · images` renders 53 visible
       controls and `errors` 12, and VP.1 reproduced the same zero counts SIGNED IN with no 401 at
       all. That is the discriminator: fixing the session would not have made these measurable.
       Found by VP.1; the selector, not the auth, and it is mine.

       The replacement asks the page a question it can actually answer: wait until the visible
       control count OUTSIDE the rail and top bar has STOPPED CHANGING across consecutive samples
       and is non-zero. That is readiness by behaviour rather than by a named container, so it does
       not invent a second selector contract that can rot the same way. */
    ready = await page.waitForFunction(() => {
      const panel = document.querySelector('section[aria-label]')
      if (!panel || panel.querySelector('[role=progressbar]') || /Reading this product’s figures|Loading…/.test(panel.textContent ?? '')) return false
      const n = [...panel.querySelectorAll('button, [role="tab"], [role="button"], a.nds-btn, input, select, textarea')]
        .filter((e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 })
        .filter((e) => !e.closest('.h10-rail') && !e.closest('.nds-topbar') && !e.closest('.ag-root')).length
      const w = window
      if (w.__censusLast === n) { w.__censusStable = (w.__censusStable || 0) + 1 } else { w.__censusLast = n; w.__censusStable = 0 }
      // An attributed-activity scope can legitimately have no events or controls.
      const emptyActivity = panel.getAttribute('aria-label') === 'Activity' && /No attributed activity has been recorded in this scope/.test(panel.textContent ?? '')
      return (n > 0 || emptyActivity) && w.__censusStable >= 3
    }, null, { timeout: ROWS_MS, polling: 400 }).then(() => true).catch(() => false)
    // Let a late fetch land: a panel still "Loading…" has settled at the wrong count otherwise.
    await page.waitForTimeout(2500)
  }
  if (s.kind === 'drawer') {
    ready = ready && await page.waitForFunction(() => !!document.querySelector('.nds-drawer-dock .nds-tabs'), null, { timeout: 15000 }).then(() => true).catch(() => false)
  }
  if (!ready) {
    const why = thrown.length
      ? `the page THREW — ${thrown.length} uncaught error(s), first: ${thrown[0].slice(0, 160)}`
      : failedRequests.length
        ? `the page did not throw; ${failedRequests.length} REQUEST(S) FAILED, first: ${failedRequests[0].slice(0, 160)} — the surface is not broken, its data did not arrive (a browser gate session is \`anon\`)`
        : consoleErrors.length
          ? `no throw and no failed request, but ${consoleErrors.length} console error(s), first: ${consoleErrors[0].slice(0, 160)}`
          : `did not render within ${ROWS_MS} ms, with nothing thrown, no failed request and no console error — a slow load, or the surface is not built yet`
    summary.push(`✗ ${s.key}: NOT MEASURED — ${why}`)
    exit = 1
    continue
  }

  /* An OVERLAY has to be opened by the control an operator presses: no URL reaches the mapping
     dock or the generate modal. Each step reports what it SAW — a button that is not there and a
     witness that never appears are different failures and must not share a message, and neither
     may pass. */
  if (s.kind === 'overlay') {
    if (familyRead) {
      const family = await familyRead
      if (!family.ok) {
        summary.push(`✗ ${s.key}: family read failed — NOT MEASURED`); exit = 1; continue
      }
      if (family.body.axes?.length) {
        await page.getByRole('button', { name: s.open.label }).waitFor({ state: 'visible', timeout: ROWS_MS })
        await page.waitForFunction(() => [...document.querySelectorAll('button')].some(button => button.textContent?.trim() === 'Generate combinations' && !button.disabled), null, { timeout: ROWS_MS }).catch(() => {})
      }
    }
    const src = s.open.label.source
    /* 🔴 THREE OUTCOMES, NOT TWO. The first version pressed and then waited, so a control that
       REFUSED and a witness that never appeared shared one line — the exact conflation this gate
       honours everywhere else. `Generate combinations` is gated on `products.edit` and a local
       browser session is `anon`, so the press landed on a held button and the run reported the
       modal as unbuilt. Found by VP.3, 2026-09-11. A held control is asked WHY instead. */
    const found = await page.evaluate((pattern) => {
      const re = new RegExp(pattern)
      const btn = [...document.querySelectorAll('button, [role="button"]')].find((b) =>
        re.test((b.innerText || b.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim()),
      )
      if (!btn) {
        return { ok: false, why: 'absent', saw: [...document.querySelectorAll('button')].map((b) => (b.innerText || '').replace(/\s+/g, ' ').trim()).filter(Boolean).slice(0, 24) }
      }
      const held = btn.disabled || btn.getAttribute('aria-disabled') === 'true'
      if (held) {
        return {
          ok: false, why: 'refused',
          how: btn.disabled ? 'the `disabled` attribute' : 'aria-disabled',
          reason: btn.getAttribute('title') || btn.getAttribute('aria-description') || '(the control gives no reason)',
        }
      }
      btn.click()
      return { ok: true }
    }, src)
    if (!found.ok && found.why === 'refused') {
      summary.push(`✗ ${s.key}: the control matching ${s.open.label} REFUSED the press (${found.how}) — NOT MEASURED, and this is NOT evidence the surface is unbuilt. It says: "${found.reason}".`)
      exit = 1
      continue
    }
    if (!found.ok) {
      summary.push(`✗ ${s.key}: no control matching ${s.open.label} on the page — NOT MEASURED. Buttons seen: ${found.saw.join(' · ') || '(none)'}`)
      exit = 1
      continue
    }
    const opened = await page.waitForFunction((sel) => !!document.querySelector(sel), s.open.witness, { timeout: 15000 }).then(() => true).catch(() => false)
    if (!opened) {
      summary.push(`✗ ${s.key}: pressed ${s.open.label} but \`${s.open.witness}\` never appeared within 15000 ms — NOT MEASURED`)
      exit = 1
      continue
    }
    // Let the overlay's own fetch land, the way the panel surfaces do.
    await page.waitForTimeout(2000)
  }
  if (s.key === 'amazon·DE · sheet') {
    // The first VARIANT row — the band row is `primary:<parent>` and opens no record.
    const rowId = await page.evaluate((parent) => [...document.querySelectorAll('.ag-row[row-id]')].map((r) => r.getAttribute('row-id')).find((id) => id && id !== `primary:${parent}` && id !== parent) ?? null, PRODUCT)
    if (rowId) drawerUrl = `${s.url}&rec=${encodeURIComponent(rowId)}`
  }
  const c = await page.evaluate(censusInPage, { ALLOWED: [...ALLOWED], SM, TOOLBAR_H, keepFormControls: s.kind === 'overlay', DOCK_ROOT })
  const { fails, seen } = judge(s, c)
  if (s.kind === 'sheet' && s.key.includes('variants')) fails.push(...await assertVariantsSelection(page))
  const n = c.controls.length
  if (n === 0) { summary.push(`✗ ${s.key}: 0 controls seen — vacuous, NOT MEASURED`); exit = 1; continue }
  summary.push(`${fails.length ? '✗' : '✓'} ${s.key}: ${n} controls, ${seen.size} signatures, fab ${c.fab ? 'PRESENT' : 'absent'}${fails.length ? `, ${fails.length} fail(s)` : ''}`)
  for (const [sig, cnt] of [...seen].sort()) console.log(`   ${String(cnt).padStart(3)} × ${sig}`)
  for (const f of fails) { console.log(`   ✗ ${f}`); exit = 1 }
  if (s.kind === 'sheet') {
    for (const width of [320, 375, 640, 768, 1024, 1280, 1440, 1728, 2048]) {
      await page.setViewportSize({ width, height: 906 })
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
      const clipped = await page.evaluate(toolbarLayoutInPage)
      for (const failure of clipped) { console.log(`   ✗ ${s.key} at ${width}px: ${failure}`); exit = 1 }
    }
    await page.setViewportSize({ width: 1440, height: 900 })
  }
}
await browser.close()

console.log('')
for (const l of summary) console.log(l)
console.log(exit ? '❌ control census: RED' : '✅ control census: green — every studio control is a DS control on its tier')
process.exit(exit)
