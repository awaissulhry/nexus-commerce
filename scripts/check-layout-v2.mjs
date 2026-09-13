#!/usr/bin/env node
/**
 * UX.1 — Product Edit Studio LAYOUT v2 conformance, MEASURED in a real browser.
 *
 * Holds the built studio against `docs/2026-09-01-layout-v2-spec.md` (Owner-approved, hub ruling
 * #182): the band budget (§2.1/§2.2), the merged chips+tabs row (§3), the collapse scroll source
 * (§4.4), the slide-over drawer (§5.1/§5.3), where warnings may live (§6.2), the no-horizontal-
 * scroll invariant (§7), the ratified row + thumbnail (§8.3) and the required-columns-fit rule
 * (§9.1).
 *
 * Every assertion returns the MEASURED value, never a bare boolean, so a failure is already a
 * filable cross-lane request — the lane that owns the section can act on it without re-probing.
 * §11 of the spec says who owns each one; each failure prints its section.
 *
 * 🔴 Two things this script deliberately does NOT do, because both have burned this programme:
 *  - It never measures a half-built page. AG renders a placeholder header before the column model
 *    arrives; reading it produces confident, wrong geometry (it produced a withdrawn "511px of
 *    unused width" figure). The probe waits for RENDERED ROWS and fails loudly if none arrive.
 *  - It never reports a pass it could not have failed. Checks match on what the spec forbids (a
 *    warning GLYPH or tone) rather than on one CSS class — the §6.2 check first shipped matching
 *    `.nds-pill.warning`, found nothing, and cleared a build with the chip plainly in the toolbar.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * TRAPS THIS SCRIPT HAS ALREADY FALLEN INTO. Every one produced a confident wrong reading that
 * reached other lanes before it was caught. Read before adding a check.
 *
 *  1. MEASURING BEFORE THE GEOMETRY SETTLES. Rows existing is not the sheet being laid out: the
 *     default column view applies in an effect AFTER first paint (15,664px → 2,914px at t=500ms),
 *     and a popover positions in a `useLayoutEffect` after its portal mounts. Everything waits for
 *     three identical samples.
 *  2. A NEGATIVE CHECK WHOSE SELECTOR MATCHES NOTHING. `.nds-pill.warning` and
 *     `.ag-header-row-column-group` both matched zero elements and both reported COMPLIANCE on a
 *     violating build. Absence checks take a witness and abstain — see `absent()`.
 *  3. COLUMN VIRTUALISATION — FOUR TIMES, AND IT WILL BE FIVE. **The DOM is a WINDOW, so every
 *     question phrased against "the columns" silently means "the columns you can currently see."**
 *     That is why fixing it once does not hold: each instance was a different question.
 *       (a) comparing rendered sets across two scroll positions → measures the scroll, not columns;
 *       (b) a denominator of "rendered required columns" → shrinks with the viewport, so three
 *           viewports gave three incomparable numbers and all understated the failure;
 *       (c) a last-column comparison → needs both states swept to max, not read where they sit;
 *       (d) a trailing-band membership test → read only what was rendered and reported "no column
 *           lies in the band" where a sweep finds four. **That one was inside the check written to
 *           correct a claim this same trap had caused.**
 *     Count against a FIXED set, sweep the width, or compare at a fixed scroll position — and when
 *     you write a new question about columns, assume it is instance five until you have swept.
 *  4. AN UNPINNED COORDINATE. A studio deep link without `market`/`locale` resolves a remembered
 *     one — comparing two runs that differed there had me report a colleague's landed fix as
 *     broken. Every URL is built from a pinned coordinate; see COORD.
 *  5. ASSERTING THE WEAKER PROPERTY. "Not covered by the panel" passes for a cell scrolled off the
 *     screen entirely. The assertion is RENDERED **and** CLEAR.
 *  7. SHARING A CONTEXT WITH YOUR OWN PREDECESSOR. `checkUrlPathReveal` claims a COLD load and ran
 *     in the same context as `checkRevealAndPad`, which wheels the grid fully right. `useGridState`
 *     persists `api.getState()` wholesale — AG 36's `GridState` includes `scroll` — and replays it
 *     as `initialState`, so the "cold" check inherited a max-scrolled grid and reported three
 *     failures as a product regression. **A probe that shares a context with its predecessor is not
 *     measuring a cold load**, and localStorage outlives the navigation that was supposed to reset
 *     it. Each cold-load check now gets its own context.
 *  6. A COMPUTED VALUE IS NOT THE DECLARED VALUE — AND THE CASCADE IS NOT THE ONLY THING BETWEEN
 *     THEM. This script reads computed style constantly. A pill landed as `display: inline-flex`
 *     computes to `flex`, and I reported it as "something else is winning that declaration" and
 *     prescribed a grep. Wrong: it is CSS BLOCKIFICATION — a flex item's display is blockified
 *     (CSS Display §2.7), so `inline-flex` computes to `flex` whenever the element is a flex child,
 *     and would read `inline-flex` in text flow. The rule as landed was the rule in force.
 *     **Observing that computed ≠ declared is a finding; naming the cause is a separate claim that
 *     needs its own check** — the used value can differ from the declared one by the spec's own
 *     rules (blockification, `contents`, absolute/float coercion) with no cascade involved at all.
 *  8. A SAFETY PROPERTY INHERITED FROM THE PRODUCT, NEVER RE-MEASURED. The first trap here that
 *     was not a wrong number. `checkPopovers` clicked EVERY button >20px in the header and scope
 *     bar to discover which opened a panel, and `checkSelectClamp` opened a live cell editor and
 *     left teardown to close it. Both are safe today only by accident of the product's state:
 *     `PublishMenu`'s items are all `disabled: true` while publish is unwired, and no editor value
 *     was changed. **Local dev writes to the PRODUCTION database**, so when PES.5 wires publish,
 *     the unchanged line clicks a live trigger — and AG's `destroy()` calls `stopEditing()` with
 *     COMMIT semantics, so "just navigate away" is a write. The tell: a direct-action button opens
 *     no panel, so it lands in the ABSTAIN branch reading "no popover opened" — indistinguishable
 *     from a benign nothing. Clicks are now gated on a DECLARED `aria-haspopup`; anything else is
 *     reported unclicked, and the editor is closed with an explicit Escape.
 *     **Ask of every probe not what it measures but what it DOES, and re-ask when the page grows a
 *     control** — a probe's safety is a property of the probe, never a loan from the page.
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 *
 * Needs a dev server on :3000 whose API serves the studio routes (see the local-API recipe in
 * docs/pes-claims.md). Says loudly when it skips — a silent pass with no server is the
 * empty-assertion trap.
 *
 *   npm run layout:v2                              # against http://localhost:3000
 *   LAYOUT_BASE=https://… npm run layout:v2
 *   LAYOUT_PRODUCT=<id> npm run layout:v2          # default: GALE-JACKET
 *   node scripts/check-layout-v2.mjs --strict      # a missing server is a FAILURE
 */
import { authenticatedStudioPage } from './studio-browser-auth.mjs'
import { requiredColumnKeys, sameRequiredSet, compareRequiredColumns } from './studio-required-columns.mjs'
import { chromium } from '@playwright/test'
import { statSync, readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { loadavg } from 'node:os'

/**
 * 🔴 THE BUILD STAMP IS A PROPERTY OF THE PATH, NOT OF ONE FILE.
 *
 * §5.4's acceptance was stamped with the drawer file, because that was the file under discussion.
 * The two SHEETS that consume `data-resting-left` then changed — edited by neither of the two lanes
 * arguing about the stamp — and nobody noticed until a re-measure happened to catch it. An mtime
 * moves without a change (a `cp` restore did exactly that here) and a change arrives in a file
 * nobody is watching. **An acceptance is a property of the system, so the stamp that matters is
 * every file on the path, not the one whose author happens to be reporting.**
 *
 * Printing it on every run means any number quoted from this suite carries its own provenance, and
 * drift between two runs is visible without anyone remembering to look.
 */
const STAMP_FILES = [
  'apps/web/src/app/products/[id]/edit/_studio/drawer/StudioDock.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/master/MasterSheet.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/ChannelSheet.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/ProductSheet.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/ProductSheetSurface.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/ProductSheetTab.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/master/useMasterSheetAdapter.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/useChannelSheetAdapter.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useProductSheetInteraction.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetGeometry.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetPreferences.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetGridBindings.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetChips.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/sheetChips.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/useSheetSaveStatus.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/productSheetRows.ts',
  // 🔴 ADDED 2026-09-02 (#684). These two decide WHICH COLUMNS EXIST and in WHAT ORDER, so every
  // §9.1 number depends on them — and neither was on the stamp. `views.ts` was innocent when I
  // checked (06:14:05, older than the reading it would have invalidated), but I know that only
  // because #679's channel numbers failed to reproduce and I went looking for a cause. The stamp
  // exists so that hunt is unnecessary; a file on the read path that is not on the stamp is the
  // exact hole the stamp was minted to close.
  /* 🔴 MOVED, and the stamp said so itself: `sheet/master/views.ts` was hoisted to `sheet/views.ts`
     by CH.1 (2026-09-05, one views module for both scopes), so this entry read MISSING on every run
     since and the stamp has been silently INCOMPLETE — the one file it exists to watch was the one
     it had stopped watching. Verified present at the new path 2026-09-11 before repointing. A stamp
     naming a path that no longer exists is a set claim that has gone stale, exactly like a gate's
     allow-list; both need the same treatment, which is to fail loudly when a member disappears. */
  'apps/web/src/app/products/[id]/edit/_studio/sheet/views.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/master/columns.tsx',
  // 🔴 ADDED 2026-09-02 (#690), and the reason is the same one twice in one day. `presets.ts` sets
  // the `actions` column's width — which IS §9.1's right pinned band, and therefore a term in every
  // shortfall this suite prints. It changed 120 → 56 during #690 and the stamp would have said the
  // build was unchanged. `flaggedColumns.ts` feeds `flaggedKeys`, which decides part of the column
  // SET. Both are on the read path; neither was on the stamp. The stamp is a property of the PATH,
  // and the path grows whenever someone moves a number into a new file.
  'apps/web/src/design-system/grid/columns/presets.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/flaggedColumns.ts',
  // 🔴 ADDED 2026-09-02 (#741). The identity band is now the WHOLE pinned geometry on every scope,
  // so the files that derive its width are a term in every §9.1 shortfall this suite prints. The hub
  // named the first two. **The third I found by reading the import graph rather than the message:**
  // `IdentityBand.tsx:24` imports `readyPillTone` from `./readiness`, and `readiness.ts` had moved at
  // 16:51 — a file on the read path that nobody had listed, which is the exact hole the stamp exists
  // to close and the third time today the path grew under it. `buildSkuFont` needs no entry of its
  // own: the hoist landed inside `bandWidth.ts:80`.
  'apps/web/src/design-system/grid/renderers/bandWidth.ts',
  'apps/web/src/design-system/grid/renderers/IdentityBand.tsx',
  'apps/web/src/design-system/grid/renderers/readiness.ts',
  // 🔴 ADDED 2026-09-02 (#746), decided from the IMPORT GRAPH rather than from anyone's list — the
  // hub asked whether four candidates belonged and the graph said all four do:
  //  · `renderers/index.ts` — the BARREL. `design-system/grid/index.ts:67` is `export * from
  //    './renderers'`, and the barrel is what re-exports `IdentityBand` and `deriveBandWidthFromDom`
  //    to the sheets. It moved in the same 18:04:35 save as `bandWidth.ts` and was left off the
  //    declaration; a stale copy of it breaks a consumer with a symptom pointing at the consumer.
  //  · `channel/AliasBandCell.tsx` — imports `IdentityBand` and renders it (`:188`); ChannelSheet
  //    mounts it at `:1108`. It decides the band's TRAILING width on a channel scope.
  //  · `channel/rows.ts` — supplies `summariseAlias` to that cell, so it decides what the band draws.
  //  · `channel/types.ts` — **and this one nearly got waved through.** It looks like a type module,
  //    and a types-only file is erased at build and cannot move a rendered pixel. It is NOT
  //    types-only: it exports `aliasKeyOf` (:433), `wireAliasKey` (:448) and `studioRowId` (:452) as
  //    RUNTIME functions, and `rows.ts:22` imports two of them as values. The name was the argument
  //    for excluding it; the exports are the evidence for keeping it.
  'apps/web/src/design-system/grid/renderers/index.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/AliasBandCell.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/rows.ts',
  'apps/web/src/app/products/[id]/edit/_studio/sheet/channel/types.ts',
  // 🔴 ADDED 2026-09-02 (#748). `revealCell.ts` IS §5.4's rule — every `[64]`/`[82]`/`[112]` this
  // suite prints is its output, and it was not on the stamp while the suite quoted its numbers all
  // day. `StudioDock.tsx:27` consumes it, `drawer/index.ts:25` re-exports it, and
  // `channel/rows.ts:297` re-exports `isRevealAnchor` from it, so it is on BOTH scopes' path.
  // ⚠ `revealCell.vitest.test.ts` is part of PES.2's declared build and is deliberately NOT here:
  // a test file does not ship, so it cannot move a rendered pixel. The stamp answers "what can
  // invalidate a number below", not "what did the author change".
  // 🔴 ADDED 2026-09-03. `revealColumn` was hoisted out of `revealCell.ts` into `revealHost.ts` as the
  // ONE host rule for both sheets (PES.2, #752). A new module on the read path is the same hole the
  // stamp has now grown four times in two days — `views.ts`, `presets.ts`/`flaggedColumns.ts`,
  // `bandWidth.ts`/`IdentityBand.tsx`/`readiness.ts`, `revealCell.ts` — so it goes on before the run
  // that quotes its output, not after.
  'apps/web/src/app/products/[id]/edit/_studio/drawer/revealHost.ts',
  'apps/web/src/app/products/[id]/edit/_studio/drawer/revealCell.ts',
  'apps/web/src/app/products/[id]/edit/_studio/drawer/index.ts',
  'apps/web/src/app/products/[id]/edit/_studio/contracts.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/StudioBar.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/StudioHeader.tsx',
  'apps/web/src/app/products/[id]/edit/_studio/studio.module.css',
  'apps/web/src/design-system/grid/theme/grid.css',
  'apps/web/src/design-system/grid/hosts/GridSheet.tsx',
]
const stampOf = () => STAMP_FILES.map((f) => { try { return `${statSync(f).mtimeMs}` } catch { return 'MISSING' } }).join('|')
/**
 * 🔴 SAMPLE THE STAMP AS THE RUN GOES, so a drift names a TIME and a FILE — not just the run.
 *
 * Comparing only start against end says "the build moved somewhere in here", which condemns every
 * row including the ones taken before it moved, and says nothing about which. On 2026-09-02 a lane
 * saved `contracts.tsx` 20 seconds into a run and every §9.1 reading was taken AFTER it — so the run
 * was flagged, correctly, while all nine of its numbers were in fact on one build. A reader could
 * only recover that by hand, from the per-row timestamps. Sampled between viewports, the notice can
 * say it itself: which file, at what time, and therefore which rows are on which side.
 */
let stampLast = null, stampLastAt = null
const stampSamples = []
const sampleStamp = (where) => {
  const now = STAMP_FILES.map((f) => { try { return statSync(f).mtimeMs } catch { return null } })
  const at = new Date().toTimeString().slice(0, 8)
  if (stampLast) {
    const moved = STAMP_FILES.filter((f, i) => now[i] !== stampLast[i])
    if (moved.length) stampSamples.push({ at, since: stampLastAt, where, moved })
  }
  stampLast = now; stampLastAt = at
}
const buildStamp = () => {
  const rows = STAMP_FILES.map((f) => {
    try {
      const t = statSync(f).mtime
      // 🔴 THE DIGEST, AND ITS ALGORITHM NAMED. The stamp printed mtimes only, and an mtime is a
      // claim about the FILE, not about its bytes — it moves on a `cp` that changed nothing. Worse,
      // two lanes traded digests today without naming the algorithm and read a sha256-vs-sha1
      // comparison as a corrupt file; two hashes of identical bytes are indistinguishable from a
      // real mismatch unless the algorithm is stated. `sha1` because that is `shasum` with no flags,
      // which is what the other lanes quote by default.
      const sha = createHash('sha1').update(readFileSync(f)).digest('hex').slice(0, 8)
      return `   ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}:${String(t.getSeconds()).padStart(2, '0')}  sha1:${sha}  ${f}`
    } catch { return `   ????????  ${f}  — MISSING: this path no longer exists, so the stamp is incomplete` }
  })
  console.log(`\n📌 BUILD STAMP — every file whose change can invalidate a number below (digests are sha1, first 8):`)
  for (const r of rows) console.log(r)
}

const BASE = process.env.LAYOUT_BASE ?? 'http://localhost:3000'
const PRODUCT = process.env.LAYOUT_PRODUCT ?? 'cmokmy3a40078pm0p1fvnu523'
const STRICT = process.argv.includes('--strict')
// 🔴 PIN THE COORDINATE. A studio deep link without `market`/`locale` is NOT a fixed input: the
// studio resolves a remembered market, and I reported a landed fix as broken (3/6, "the two paths
// do not share the fixed code") on readings taken at an unpinned coordinate. Pinned, all six pass
// with the verb path's exact values. Every URL this script builds carries the coordinate.
/** Required keys are derived from each coordinate; this ID only identifies historical residuals. */
const FIXTURE = 'cmokmy3a40078pm0p1fvnu523' // GALE-JACKET, OUTERWEAR
const MARKET = process.env.LAYOUT_MARKET ?? 'DE'
const LOCALE = process.env.LAYOUT_LOCALE ?? 'de'
const COORD = `market=${MARKET}&locale=${LOCALE}`
const STUDIO = `${BASE}/products/${PRODUCT}/edit/studio?${COORD}`

/**
 * 🔴 §9.1 CARRIES A CHANNEL COORDINATE PERMANENTLY (#679, ruled; built #684).
 *
 * §9.1's fixture was master OUTERWEAR alone for the life of this spec, and the invariant it states
 * — "every REQUIRED column fits at 1440" — is scope-independent by its own wording. So the suite
 * asserted on one scope and read as though it covered them all: on 2026-09-02 the channel scope was
 * measured for the FIRST time and missed the bar, on a build nobody had changed. **The check had
 * never been pointed at half its own subject**, and no number in it was wrong.
 *
 * Master OUTERWEAR and Amazon·IT now both run, every width, every run. The web URL's vocabulary is
 * `scope=<CHANNEL ID>` (`AMAZON`) — NOT the API's `scope=channel&channel=AMAZON`; the two contracts
 * differ and mixing them silently lands you on master, which looks like a measurement.
 */
const CH_SCOPE = process.env.LAYOUT_CH_SCOPE ?? 'AMAZON'
const CH_MARKET = process.env.LAYOUT_CH_MARKET ?? 'IT'
const CH_LOCALE = process.env.LAYOUT_CH_LOCALE ?? 'it'
const CHANNEL_STUDIO = `${BASE}/products/${PRODUCT}/edit/studio?scope=${CH_SCOPE}&market=${CH_MARKET}&locale=${CH_LOCALE}`

/* VP.5 — the two Variants states §2's budget is asserted against. eBay·IT rather than the
   `LAYOUT_CH_*` coordinate: §4 and the canvas's second artboard are both eBay·IT, and a band
   budget measured on a coordinate the design was never drawn at proves less than it looks. */
const VARIANTS_STATES = [
  { label: 'shared product', url: `${BASE}/products/${PRODUCT}/edit/studio?tab=variants` },
  { label: 'eBay·IT projection', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=EBAY&market=IT&locale=it&tab=variants` },
]
/* MX.P — the Matrix page's two states: every coordinate (master), and the same page narrowed by the
   scope bar to one channel's groups. The Matrix has NO page band (design 2026-09-13 Revision: chrome is
   top bar · subheader · scope bar · toolbar · strip · header), which the probe asserts as an ABSENCE. */
const MATRIX_STATES = [
  { label: 'every coordinate', url: `${BASE}/products/${PRODUCT}/edit/studio?tab=matrix` },
  { label: 'Amazon·DE filtered', url: `${BASE}/products/${PRODUCT}/edit/studio?scope=AMAZON&market=DE&locale=de&tab=matrix` },
]
/**
 * §9.1's coordinates. `want` is the scope chip that MUST be lit, or the reading abstains.
 *
 * 🔴 THREE, NOT TWO, AND THE THIRD IS THE CONTROL. I first reported `color.scope` as a
 * master-vs-channel difference on the strength of two payloads — master·DE against Amazon·IT — which
 * differ in the SCOPE and in the MARKET. PES.3 varied one at a time and showed it is the MARKET:
 * `color` is `per_variant` at IT and `global` at DE, on both scopes. My pair could not have told
 * those apart, and I had already drawn the conclusion from it.
 *
 * So master runs at BOTH markets. `master · CH_MARKET` holds the market fixed against the channel
 * reading, which is the only pair that isolates the scope; `master · MARKET` keeps the historical
 * baseline every §9 number in this spec was taken against. A comparison across two changed variables
 * is not a comparison, and this list is what stops the suite offering one.
 */
const SCOPES = [
  { key: 'master', label: `master · ${MARKET}/${LOCALE}`, url: STUDIO, want: 'master',
    apiQ: `scope=master&market=${MARKET}&locale=${LOCALE}` },
  { key: 'master-at-channel-market', label: `master · ${CH_MARKET}/${CH_LOCALE}`,
    url: `${BASE}/products/${PRODUCT}/edit/studio?market=${CH_MARKET}&locale=${CH_LOCALE}`, want: 'master',
    apiQ: `scope=master&market=${CH_MARKET}&locale=${CH_LOCALE}` },
  { key: 'channel', label: `${CH_SCOPE} · ${CH_MARKET}/${CH_LOCALE}`, url: CHANNEL_STUDIO, want: CH_SCOPE,
    apiQ: `scope=channel&channel=${CH_SCOPE}&market=${CH_MARKET}&locale=${CH_LOCALE}` },
  /*
   * 🔴 eBay·IT — added for #724's acceptance, and it CANNOT CARRY #724's §9.1 CLAUSE.
   *
   * The acceptance reads "§9.1 7/7 at 1440 on all three". eBay·IT declares **one** required column
   * (`brand`) against Amazon·IT's seven ⟦measured, `/studio/columns`: 35 columns, 20 defaultVisible,
   * `requiredBy` non-empty on 1⟧. Pointed here, §9.1 is 1-of-1 and **cannot go red at any width or
   * any layout** — the exact vacuous pass this suite spent the day removing in two other places.
   * So this coordinate is measured against its OWN required set, and RECORDED with its denominator
   * rather than asserted. Its value to #724 is the PINNED-BAND reading, which is a real claim here.
   */
  { key: 'ebay', label: `EBAY · ${CH_MARKET}/${CH_LOCALE}`, want: 'EBAY',
    url: `${BASE}/products/${PRODUCT}/edit/studio?scope=EBAY&market=${CH_MARKET}&locale=${CH_LOCALE}`,
    apiQ: `scope=channel&channel=EBAY&market=${CH_MARKET}&locale=${CH_LOCALE}` },
]

/** Read this coordinate's required keys; an absent contract never falls back to a fixture. */
const requiredFor = async (sc) => {
  try {
    const r = await fetch(`${API}/api/products/${PRODUCT}/studio/columns?${sc.apiQ}`, { signal: AbortSignal.timeout(60000) })
    if (!r.ok) return { keys: null, why: `columns ${r.status}` }
    const j = await r.json()
    return { keys: requiredColumnKeys(j.columns), why: null }
  } catch (e) { return { keys: null, why: String(e?.message ?? e).slice(0, 60) } }
}

/** Historical seven-key residual only. Never used as a measurement denominator or fallback. */
const LEGACY_REQUIRED = ['brand', 'item_name', 'bullet_point', 'product_description',
  'supplier_declared_dg_hz_regulation', 'fabric_type', 'country_of_origin']

/**
 * 🔴 D11's BAR IS 1440. Below it, §9.1 RECORDS a ruled residual; it does not assert (#693, #708).
 *
 * The rule the hub drew, and it is general: **an UNRULED gap is asserted red; a RULED residual is
 * recorded with its numbers on screen.** Both halves matter. Asserting an unruled gap is what caught
 * D11 in the first place. But once the hub has ruled that 1280 is not D11's bar and that no width
 * gives, keeping it red makes a suite that CANNOT GO GREEN however well the product conforms — and a
 * gate nobody can satisfy is a gate people stop reading. That is the vacuous green by another road:
 * the first kind is a check that cannot fail, this is a check that cannot pass, and both end with
 * nobody looking.
 *
 * So the 1280 rows print in full — fits, shortfall, pinned bands, centre band, scrollWidth and the
 * whole column set — labelled as the residual, every run, never dropped.
 *
 * 🔴 AND THEY ARE RATCHETED, because "not asserted" must not mean "unwatched". A residual that gets
 * WORSE is news, and recording it without a floor would swallow exactly that. These are the figures
 * #693 ruled on (measured 14:55:48–14:59:11, no disturbance, no drift); fewer columns fitting, or a
 * larger shortfall, FAILS. Tightening never does.
 */
const D11_BAR_PX = 1440
const RULED_RESIDUAL = {
  /*
   * RE-BASELINED 2026-09-02 18:1x on the CONVERGENCE build (#747), confirmed by the hub — not by me.
   * Was `6/87 · 6/87 · 6/38`, measured before #724/#725 merged the identity band; the band grew to
   * 404 and the pinned block to 447, so the below-bar residual moved by design and the ratchet fired
   * on all three as #733 said it would. The run behind these numbers had ZERO drift and ZERO
   * disturbance — a run with either is not a baseline, which is the condition the hub set and the
   * reason the first three attempts were not offered.
   *
   * 🔴 The author of a ratchet does not move its own floor. The runner PRINTS a proposed block when
   * the residual differs; a human ruled on it; only then is it pasted. That separation is the whole
   * value of the guard.
   */
  1280: {
    master: { fits: 5, shortfall: 145 },
    'master-at-channel-market': { fits: 5, shortfall: 145 },
    channel: { fits: 5, shortfall: 145 },
  },
}

// 🔴 A TIMEOUT IS A LOWER BOUND ON LATENCY, NOT A VERDICT. This gate used an 8s timeout and
// reported "no dev server" — on a box where the studio route served in 16s under load 4.8, and
// 4.9 MINUTES under load 21.8. The server was answering the whole time. **The message stated a
// conclusion the check cannot support**, which is the same error I had just filed against my own
// outage report. Long timeout, and the message says what was observed, not what it means.
/**
 * 🔴 `LAYOUT_ONLY=9.1` — the §9.1 matrix alone, for a HELD WRITE WINDOW.
 *
 * The full suite takes ~5 minutes and the windows other lanes can hold are five minutes. The merge
 * run finished at 17:39:49 and a save landed at 17:39:51 — two seconds of margin, which is not
 * margin. §9.1 plus its pinned bands is ~2.5 min, so a focused run fits a window with room to spare
 * and halves the chance of a drift landing inside the readings that matter.
 *
 * 🔴 It announces itself LOUDLY at the top and again in the verdict, naming every block it skipped.
 * A narrowed run that reads like a full pass is how a suite quietly stops asserting things — the
 * skipped blocks are not passing, they are UNRUN, and the two must never share an appearance.
 */
const ONLY = (process.env.LAYOUT_ONLY ?? '').trim()
/*
 * 🔴 AN UNRECOGNISED VALUE MUST REFUSE, NOT FALL BACK. `LAYOUT_ONLY=5,4` or `LAYOUT_ONLY=§5.4` would
 * otherwise run the FULL suite while the operator believed it was focused — the same
 * label-does-not-match-behaviour shape that made the first version of this flag print skips it never
 * performed. A typo is silent; a refusal is not.
 */
if (ONLY && !['9.1', '5.4', 'variants', 'matrix'].includes(ONLY)) {
  console.error(`❌ LAYOUT_ONLY="${ONLY}" is not a block name. Use 9.1 (the §9.1 matrix), 5.4 (the reveal), variants (the §2 variants band budget) or matrix (the Matrix page's band budget), or unset it for the full suite. Refusing rather than silently running everything.`)
  process.exit(2)
}
const FOCUS_91 = ONLY === '9.1'
const FOCUS_54 = ONLY === '5.4'
/* VP.5 — `LAYOUT_ONLY=variants` runs the §2 variants band budget ALONE. The end-of-wave pass
   re-measures those two states after every lane's fix, and making that cost a full suite run is
   how a measurement stops being taken. It narrows the RUN, never the rule: the block still counts
   itself into `measured`, so a focused run that asserts nothing still reports that it asserted
   nothing. */
const FOCUS_VP = ONLY === 'variants'
/* MX.P — `LAYOUT_ONLY=matrix` runs the Matrix page's band budget ALONE, for the same reason as `variants`. */
const FOCUS_MX = ONLY === 'matrix'
const FOCUSED = FOCUS_91 || FOCUS_54 || FOCUS_VP || FOCUS_MX
/** Anything that runs while FOCUS_91 is set records itself here, so the banner cannot lie unnoticed. */
const focusRan = []
const focusGuard = (name) => { if (FOCUS_91) focusRan.push(name) }
const SKIPPED_BLOCKS = FOCUS_VP || FOCUS_MX
  ? ['§2/§3/§4/§6/§7 band + chrome probe (both drawer states)', '§5.3 drawer geometry',
     '§9.1 required-columns-fit (all coordinates) + the pinned-band readings',
     '§5.4 reveal (verb path) + the phantom-column witness', '§5.4 reveal (URL path)',
     '§7 DS popovers', '§7 right-edge popup', FOCUS_MX ? 'the §2 variants band budget' : 'the Matrix band budget']
  : FOCUS_91
    ? ['§2/§3/§4/§6/§7 band + chrome probe (both drawer states)', '§5.3 drawer geometry',
       '§5.4 reveal (verb path) + the phantom-column witness', '§5.4 reveal (URL path)', '§7 DS popovers', '§7 right-edge popup']
    : ['§2/§3/§4/§6/§7 band + chrome probe (both drawer states)', '§5.3 drawer geometry',
       '§9.1 required-columns-fit (all coordinates) + the pinned-band readings', '§7 DS popovers', '§7 right-edge popup']
const LIVENESS_MS = Number(process.env.LAYOUT_LIVENESS_MS ?? 60000)
const ROWS_MS = Number(process.env.LAYOUT_ROWS_MS ?? 30000)
let stampPrinted = false
// 🔴 …AND THE OPPOSITE ERROR IS ALSO POSSIBLE. The caution above is right for a TIMEOUT and wrong
// for a REFUSED CONNECTION: on 2026-09-02 the dev server actually died mid-run and this gate printed
// "did not answer within 0.0s — this does NOT mean the server is down" while nothing was listening
// on :3000. A `.catch(() => false)` had thrown away the one fact that separates the two cases.
// **Both messages assert a conclusion the check cannot support; the fix is to report the OBSERVATION
// — refused, timed out, or answered-not-ok — and let the reader draw it.**
const t0 = Date.now()
const live = await fetch(STUDIO, { signal: AbortSignal.timeout(LIVENESS_MS) })
  .then((r) => ({ ok: r.ok, how: r.ok ? 'ok' : `answered HTTP ${r.status}` }))
  .catch((e) => ({ ok: false, how: e?.name === 'TimeoutError' || /timeout/i.test(String(e?.message))
    ? 'timed out' : /ECONNREFUSED|fetch failed/i.test(`${e?.cause?.code ?? ''} ${e?.message ?? ''}`)
      ? 'CONNECTION REFUSED — nothing is listening' : `failed: ${String(e?.message ?? e).slice(0, 80)}` }))
if (!live.ok) {
  const waited = ((Date.now() - t0) / 1000).toFixed(1)
  const refused = live.how.startsWith('CONNECTION REFUSED')
  const msg = `layout v2 conformance: ${BASE} ${live.how} after ${waited}s — NOT MEASURED. ` +
    (refused
      ? `The dev server is genuinely DOWN (verify: \`lsof -iTCP:3000 -sTCP:LISTEN\`). Restarting it is ` +
        `someone's call, not this script's — a shared tree may have other lanes depending on that process.`
      : `This does NOT mean the server is down: check \`lsof -iTCP:3000 -sTCP:LISTEN\` and the machine load ` +
        `(a starved box has served this route in 4.9 minutes). Raise LAYOUT_LIVENESS_MS if the box is busy.`)
  if (STRICT) { console.error(`❌ ${msg}`); process.exit(1) }
  console.warn(`⚠️  SKIPPED — ${msg}`)
  process.exit(2)
}

/** The band budget from §2.1. Heights above the rows area, at rest. */
// MEASURED band heights, not idealised ones. The toolbar is 40 + a 1px border and the AG header is
// 28 (it was 28 + AG's 29px filter row until CH.1 dropped the per-column filter row, Owner
// 2026-09-05); counting them at 40/56 is what made the §2.2 target 678 when the build
// measures 674 — a 4px hunt I nearly sent PES.2 on. `seams` is the 1px scope/toolbar gap plus the
// sheet card's top border.
const BANDS = { topbar: 56, subheaderSeam: 1, header: 48, headerCollapsed: 32, scopeTabs: 40, toolbar: 40, agHeader: 28, footer: 36, gutter: 8, seams: 2 }

/**
 * VP.5 — the VARIANTS band budget (spec 2026-09-11 §2, §8 row VP.5).
 *
 * The Variants page carries one band the sheet does not: a 40px PAGE BAND between the scope bar
 * and the sheet toolbar — the family band on the shared product (§3.1), the mapping band on a
 * channel (§4.1). So its budget is its own, and it is asserted separately rather than bent into
 * `probe()`'s §2.2 arithmetic, which is a statement about the SHEET and would quietly go wrong by
 * exactly 40px here.
 *
 *   49 · 40 · 40 · 40 · 30 · 28+1 · 36×n · 36   ·   dock 420   ·   identity 380
 *
 * Every assertion returns the MEASURED value, and every one that finds nothing reports NOT
 * MEASURED rather than passing: the dangerous green is the one produced by having nothing to look
 * at. Each check names the selector it looked for, so a lane can tell "this band is the wrong
 * height" from "your class is not the class I was told to find".
 */
const VARIANTS_BANDS = {
  subheader: 49,      // 48px toggle column + the 1px rule (§2, `.nds-workspace-subheader`)
  scopeBar: 40,       // `--nds-toolbar-h`
  pageBand: 40,       // NEW — this spec's own band
  toolbar: 40,        // SheetToolbar inside `.nds-grid-sheet`
  groupStrip: 30,     // the AG column-group strip, `--nds-grid-strip-h`
  agHeader: 28,       // + a 1px rule
  row: 36,            // rows="media-line" — 🔴 never 28
  footer: 36,         // `.nds-grid-sheet-status`
  dock: 420,          // the mapping dock, in-flow flex sibling
  identity: 380,      // the identity column
}

/**
 * MX.P — the MATRIX band budget (`docs/2026-09-13-matrix-page-design.md` Revision; `docs/mx-prompts.md`
 * § MX.P): top 56 · subheader 49 · scope 40 · toolbar 40 · strip 30 · header 28 · rows 36 · footer 36 ·
 * identity 380. No page band. Same discipline as `VARIANTS_BANDS`: every check returns its MEASURED value,
 * and one that finds nothing says NOT MEASURED.
 */
const MATRIX_BANDS = {
  subheader: 49, scopeBar: 40, toolbar: 40, groupStrip: 30, agHeader: 28, row: 36, footer: 36, identity: 380,
}

const matrixProbe = ({ B }) => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const q = (s) => document.querySelector(s)
  const checks = []
  const band = (id, sec, sel, want, tol = 0) => {
    const el = q(sel)
    if (!el) { checks.push({ id, sec, expected: String(want), measured: `NOT MEASURED — nothing matched \`${sel}\``, ok: false, note: 'probe defect or an unbuilt surface — confirm the selector before filing this against a lane' }); return null }
    const m = R(el)
    checks.push({ id, sec, expected: `${want}${tol ? ` (±${tol})` : ''}`, measured: String(m.h), ok: Math.abs(m.h - want) <= tol })
    return m
  }
  const vp = q('.ag-grid-viewport.ag-layout-normal')
  const rows = document.querySelectorAll('.ag-row').length
  if (!vp || rows === 0) return { ABORT: 'no rendered rows — the Matrix grid did not load, or is still loading', vp: !!vp, rows }
  const surface = q('[data-matrix-surface]')
  if (!surface) return { ABORT: 'no `[data-matrix-surface]` — this is not the Matrix page' }

  band('matrix-subheader-h', 'MX', '.nds-workspace-subheader', B.subheader, 1)
  band('matrix-scopebar-h', 'MX', '.nds-scopebar', B.scopeBar)
  band('matrix-footer-h', 'MX', '.nds-grid-sheet-status', B.footer)
  band('matrix-ag-header-h', 'MX', '.ag-header-row-column', B.agHeader, 1)
  /* NO page band on the Matrix — an absence, asserted with the toolbar as its witness. */
  const pageband = q('.nds-pageband')
  checks.push({ id: 'matrix-no-pageband', sec: 'MX', expected: 'no .nds-pageband (the Matrix has no page band)', measured: pageband ? `present, ${R(pageband).h}px` : 'absent', ok: !pageband })
  const tb = q('.nds-grid-sheet .nds-toolbar')
  if (!tb) {
    checks.push({ id: 'matrix-toolbar-h', sec: 'MX', expected: String(B.toolbar), measured: 'NOT MEASURED — nothing matched `.nds-grid-sheet .nds-toolbar`', ok: false })
  } else {
    /* 🔴 The BOX is the band. Measured 2026-09-13 on the Matrix AND on the Variants page alike: the DS
       toolbar is a `box-sizing: border-box` element of `min-height: var(--nds-toolbar-h)` = 40 with its
       1px rule INSIDE that 40 (content 39 + rule 1), which is the same reading the census gate makes
       (`toolbarH >= 40`). Asserting "40 of content + a rule" (the variants block's phrasing) is a
       41px band nobody renders — a copied assertion, not a measured one. The rule is reported. */
    const rule = Math.round(parseFloat(getComputedStyle(tb).borderBottomWidth) || 0)
    const box = Math.round(R(tb).h)
    checks.push({ id: 'matrix-toolbar-h', sec: 'MX', expected: `${B.toolbar} (the box, ${rule}px rule inside)`, measured: `${box} (content ${box - rule} + rule ${rule})`, ok: box === B.toolbar })
    /* A WRAP puts a child a full control-row lower. The count span is a 19px block sitting 4px below
       the 28px controls' top on every sheet — distinct `top`s, one row. Tops are clustered within half
       a control height so a 4px baseline offset is one row and a 28px+ drop is two. */
    const tops = [...tb.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => Math.round(c.getBoundingClientRect().top)).sort((a, b) => a - b)
    const rows = tops.reduce((acc, t) => (acc.length && t - acc[acc.length - 1] < 14 ? acc : [...acc, t]), [])
    checks.push({ id: 'matrix-toolbar-wrap', sec: 'MX', expected: 'one row', measured: `${rows.length} row(s) of controls (child tops ${[...new Set(tops)].join(', ')})`, ok: rows.length <= 1, note: rows.length > 1 ? 'the bar WRAPPED: a child sits a full row lower' : undefined })
    /* The Matrix HAS views (D-MX8) — the opposite of the Variants page's §1.5 absence. */
    const views = [...tb.querySelectorAll('button')].filter((b) => /everything|inventory|pricing|listings|custom \(|^view$/i.test((b.innerText || '').replace(/\s+/g, ' ').trim()))
    checks.push({ id: 'matrix-views-trigger', sec: 'MX/D-MX8', expected: 'a views trigger (Everything · Inventory · Pricing · Listings + saved views)', measured: views.length ? views.map((b) => `"${(b.innerText || '').trim()}"`).join(', ') : 'none', ok: views.length > 0 })
  }
  const strip = q('.ag-header-row-group')
  if (!strip) checks.push({ id: 'matrix-group-strip-h', sec: 'MX', expected: String(B.groupStrip), measured: 'NOT MEASURED — no `.ag-header-row-group`; the Matrix requires the column-group strip', ok: false })
  else checks.push({ id: 'matrix-group-strip-h', sec: 'MX', expected: String(B.groupStrip), measured: String(R(strip).h), ok: R(strip).h === B.groupStrip })
  const rowHs = [...new Set([...document.querySelectorAll('.ag-row')].map((r) => Math.round(r.getBoundingClientRect().height)))].sort((a, b) => a - b)
  checks.push({ id: 'matrix-row-h', sec: 'MX', expected: `${B.row} on every row`, measured: `${rowHs.join(' · ')} across ${rows} rows`, ok: rowHs.length === 1 && rowHs[0] === B.row })
  const idCell = q('.ag-row .ag-cell[col-id="identity"]') || q('.ag-header-cell[col-id="identity"]')
  if (!idCell) checks.push({ id: 'matrix-identity-w', sec: 'MX', expected: String(B.identity), measured: 'NOT MEASURED — no cell with col-id `identity`', ok: false })
  else checks.push({ id: 'matrix-identity-w', sec: 'MX', expected: String(B.identity), measured: String(R(idCell).w), ok: R(idCell).w === B.identity })
  /* Every group id is `grp-` prefixed (AG's one namespace for columns and groups) — read, not asserted. */
  const groups = [...document.querySelectorAll('.ag-header-group-cell[col-id]')].map((g) => g.getAttribute('col-id'))
  checks.push({ id: 'matrix-groups', sec: 'MX', expected: 'every group id grp-*', measured: `${groups.length} groups: ${groups.slice(0, 6).join(', ')}${groups.length > 6 ? ', …' : ''}`, ok: groups.length > 0 && groups.every((g) => /^grp-/.test(g)) })
  const source = surface.getAttribute('data-matrix-source')
  const banner = q('.nds-matrix-banner')
  checks.push({ id: 'matrix-preview-banner', sec: 'MX/rule 7', expected: 'banner on screen iff source=preview', measured: `source=${source} · banner ${banner ? 'present' : 'absent'}`, ok: (source === 'preview') === !!banner })
  return { checks, rows, viewport: `${innerWidth}×${innerHeight}` }
}

const variantsProbe = ({ B }) => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const q = (s) => document.querySelector(s)
  const checks = []
  /* A check that cannot find its subject ABSTAINS LOUDLY — ok:false with the selector named — so
     "the band is 44px" and "I was looking for a class nobody renders" never share an outcome. */
  const band = (id, sec, sel, want, tol = 0) => {
    const el = q(sel)
    if (!el) { checks.push({ id, sec, expected: String(want), measured: `NOT MEASURED — nothing matched \`${sel}\``, ok: false, note: 'probe defect or an unbuilt surface — confirm the selector before filing this against a lane' }); return null }
    const m = R(el)
    checks.push({ id, sec, expected: `${want}${tol ? ` (±${tol})` : ''}`, measured: String(m.h), ok: Math.abs(m.h - want) <= tol })
    return m
  }

  const vp = q('.ag-grid-viewport.ag-layout-normal')
  const rows = document.querySelectorAll('.ag-row').length
  if (!vp || rows === 0) return { ABORT: 'no rendered rows — the variants grid did not load, or is still loading', vp: !!vp, rows }

  band('variants-subheader-h', '§2', '.nds-workspace-subheader', B.subheader, 1)
  band('variants-scopebar-h', '§2', '.nds-scopebar', B.scopeBar)
  band('variants-pageband-h', '§2/§3.1/§4.1', '.nds-pageband', B.pageBand)
  band('variants-footer-h', '§2', '.nds-grid-sheet-status', B.footer)

  /* 🔴 THE AG HEADER BAND IS A ROW, NOT THE CONTAINER. `.ag-header` wraps EVERY header row, so on
     a grouped grid — which §3.3 requires here — it measures the strip AND the header together and
     reported 59 on the shared product and 57 on the channel against an expectation of 28. §2 lists
     the strip and the header as two separate bands, so each is measured on its own row. Found by
     VP.4 from the gate's own output; the numbers below are mine, measured at 1440×900:
       master · variants   container 59 = group 30 + column 28 + 1 rule
       ebay·IT · variants  container 57 = group 28 + column 28 + 1 rule
     The old expectation passed on the SHEET only because an ungrouped grid has one row. */
  band('variants-ag-header-h', '§2', '.ag-header-row-column', B.agHeader, 1)

  /* The toolbar is `height: auto; min-height: --nds-toolbar-h` with `flex-wrap: wrap`, and it
     carries a 1px divider. So two DIFFERENT things can make it taller than 40 and they must not
     share an assertion: the divider, which §2's own table spells out for the subheader (49 = 48+1)
     and the AG header (28+1) but omits for this row; and WRAPPING, which is a real defect — the
     bar at 1440 wrapped to 77 on the shared product while every child measured 28 or less.
     Measured, so neither is a tolerance for the other. */
  const tb = q('.nds-grid-sheet .nds-toolbar')
  if (!tb) {
    checks.push({ id: 'variants-toolbar-h', sec: '§2/§3.2', expected: String(B.toolbar), measured: 'NOT MEASURED — nothing matched `.nds-grid-sheet .nds-toolbar`', ok: false })
  } else {
    const rule = Math.round(parseFloat(getComputedStyle(tb).borderBottomWidth) || 0)
    const content = Math.round(R(tb).h) - rule
    checks.push({ id: 'variants-toolbar-h', sec: '§2/§3.2', expected: `${B.toolbar} of content + a ${rule}px rule`, measured: `${content} + ${rule}`, ok: content === B.toolbar })
    const lines = new Set([...tb.children].filter((c) => c.getBoundingClientRect().height > 0).map((c) => Math.round(c.getBoundingClientRect().top)))
    checks.push({
      id: 'variants-toolbar-wrap', sec: '§2/§3.2', expected: 'one row',
      measured: `${lines.size} row(s) of controls, tallest child ${Math.max(0, ...[...tb.children].map((c) => Math.round(c.getBoundingClientRect().height)))}px`,
      ok: lines.size <= 1,
      note: lines.size > 1 ? 'the bar WRAPPED: its controls do not fit the width, which is a layout defect and not the divider' : undefined,
    })
  }

  /* The 30px group strip. AG 36 spells it `.ag-header-row-group`; the other spelling matched
     nothing and once reported a build WITH a strip as compliant. §3.3 REQUIRES the strip here
     (PRODUCT · AXES · CHANNEL PROJECTIONS), so its absence is a failure, not a pass. */
  const strip = q('.ag-header-row-group')
  if (!strip) {
    checks.push({ id: 'variants-group-strip-h', sec: '§3.3', expected: String(B.groupStrip), measured: 'NOT MEASURED — no `.ag-header-row-group`; §3.3 requires the column-group strip on this page', ok: false })
  } else {
    checks.push({ id: 'variants-group-strip-h', sec: '§3.3', expected: String(B.groupStrip), measured: String(R(strip).h), ok: R(strip).h === B.groupStrip })
  }

  /* Rows are 36, and EVERY row is measured, not the first: a band row or a parent row rendered at
     another height is exactly the defect a single sample misses. */
  const rowHs = [...new Set([...document.querySelectorAll('.ag-row')].map((r) => Math.round(r.getBoundingClientRect().height)))].sort((a, b) => a - b)
  checks.push({
    id: 'variants-row-h', sec: '§2/§3.3', expected: `${B.row} on every row`,
    measured: `${rowHs.join(' · ')} across ${rows} rows`,
    ok: rowHs.length === 1 && rowHs[0] === B.row,
    note: rowHs.includes(28) ? '🔴 28 is the compact rowHeight, not rowMediaLine — tokens/grid.ts' : undefined,
  })

  /* The identity column, by col-id, and the dock, which is an in-flow flex sibling rather than an
     overlay — so its WIDTH is the thing to assert. */
  /* `__identity` is the CHANNEL SHEET's own name for this column (`ChannelSheet.tsx:1506`
     `identityColumn: '__identity'`), so a gate that insisted on `identity` would be asking the
     channel surface to invent a second convention for the same column. Measured: the shared
     product renders `identity`, the eBay·IT projection renders `__identity`. Both accepted. */
  const ID_COLS = '[col-id="identity"], [col-id="__identity"], [col-id="sku"]'
  const idCell = q(`.ag-row .ag-cell:is(${ID_COLS})`) || q(`.ag-header-cell:is(${ID_COLS})`)
  if (!idCell) {
    checks.push({ id: 'variants-identity-w', sec: '§3.3/§4.3', expected: String(B.identity), measured: 'NOT MEASURED — no cell with col-id `identity`, `__identity` or `sku`', ok: false, note: 'tell VP.5 the col-id the identity column uses and the gate will accept it' })
  } else {
    checks.push({ id: 'variants-identity-w', sec: '§3.3/§4.3', expected: String(B.identity), measured: String(R(idCell).w), ok: R(idCell).w === B.identity })
  }
  /* Three spellings: the DS drawer's two dock modes plus VP.4's `.nds-vp-dock`
     (`MappingDock.tsx:145`). §2 points at the StudioDock PATTERN, so a page-local root is within
     the spec; the gate simply has to be told the name. */
  const dock = q('.nds-drawer-dock, .nds-drawer-embedded, .nds-vp-dock')
  /* Measure the TRACK — §2 puts `--studio-dock-w` on it, and it spends 1px of its 420 on a
     border-left separator, so the panel inside fills 419. Measured 2026-09-11. */
  /* A custom property INHERITS, so "the element carrying the token" matches the panel too. The
     rule that works is "the ancestor whose WIDTH IS the token". */
  let dockTrack = null
  if (dock) {
    const want = parseFloat(getComputedStyle(dock).getPropertyValue('--studio-dock-w')) || null
    if (want) for (let n = dock; n; n = n.parentElement) {
      if (Math.round(n.getBoundingClientRect().width) === Math.round(want)) { dockTrack = n; break }
    }
  }
  checks.push({
    id: 'variants-dock-w', sec: '§2/§4.4', expected: `${B.dock} on the track when open, absent when closed`,
    measured: !dock ? 'closed' : dockTrack ? `track ${R(dockTrack).w} · panel ${R(dock).w}` : `NOT MEASURED — no ancestor measures --studio-dock-w; the panel is ${R(dock).w}`,
    ok: !dock ? null : dockTrack ? R(dockTrack).w === B.dock : false,
  })

  /* §1.5 — the views trigger is ABSENT on this page, and the reason is on screen. A negative check
     needs a WITNESS: with no toolbar found, "no views trigger" means nothing. */
  const toolbar = q('.nds-grid-sheet .nds-toolbar')
  if (!toolbar) {
    checks.push({ id: 'variants-no-views', sec: '§1.5', expected: 'no views trigger', measured: 'NOT MEASURED — no `.nds-grid-sheet .nds-toolbar` to look in', ok: false })
  } else {
    const views = [...toolbar.querySelectorAll('button')].filter((b) => /all attributes|views?$/i.test((b.innerText || '').replace(/\s+/g, ' ').trim()))
    checks.push({ id: 'variants-no-views', sec: '§1.5', expected: 'no views trigger (fixed column set)', measured: views.length ? views.map((b) => `"${(b.innerText || '').trim()}"`).join(', ') : 'none', ok: views.length === 0 })
  }

  return { checks, rows, viewport: `${innerWidth}×${innerHeight}` }
}

// Runs in the page. Returns {ABORT} or {checks}. Keep it self-contained — no closures from here.
const probe = ({ BANDS, closedVpWidth }) => {
  const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width), h: Math.round(b.height) } }
  const q = (s) => document.querySelector(s)
  const vp = q('.ag-grid-viewport.ag-layout-normal')
  const rows = document.querySelectorAll('.ag-row').length
  if (!vp || rows === 0) return { ABORT: 'no rendered rows — the sheet did not load, or is still loading', vp: !!vp, rows }

  const checks = []
  const chk = (id, sec, expected, measured, ok, note) => checks.push({ id, sec, expected: String(expected), measured: String(measured), ok, note })
  const info = (id, sec, measured, note) => checks.push({ id, sec, expected: '(informational)', measured: String(measured), ok: null, note })
  /**
   * 🔴 A NEGATIVE check whose selector matches nothing must ABSTAIN, not pass.
   * Two checks here shipped as false PASSES because their selector was written from the class I
   * assumed rather than the class the DOM uses (`.nds-pill.warning` for a chip that is
   * `button.nds-btn.sm`; `.ag-header-row-column-group` for a row that is `.ag-header-row-group`).
   * "I found none" and "I cannot see this" are different answers and must not share an outcome.
   * `absent()` takes a WITNESS selector — something that must match if the probe is looking in the
   * right place — and reports NOT MEASURED when the witness is missing.
   */
  const absent = (id, sec, expected, witnessSel, matches, describe) => {
    if (!document.querySelector(witnessSel)) {
      checks.push({ id, sec, expected: String(expected), measured: `NOT MEASURED — witness \`${witnessSel}\` matched nothing, so a "none found" here would be meaningless`, ok: false, note: 'probe defect, not necessarily a build defect — fix the selector before filing this' })
      return
    }
    checks.push({ id, sec, expected: String(expected), measured: matches.length ? describe : 'none', ok: matches.length === 0 })
  }

  const H = innerHeight, W = innerWidth
  const topbar = q('.nds-topbar'), hdr = q('.nds-detailhdr'), scope = q('.nds-scopebar')
  const navigation = q('.nds-workspace-subheader-toggle button')
  const toolbar = q('.nds-toolbar')
  const family = q('.nds-grid-footstrip'), agh = q('.ag-header'), dock = q('.nds-drawer-dock')
  const collapsed = !!(hdr && R(hdr).h <= 36)

  // VP.F approved canvas supersedes §2.3: the 56px AppTopBar is present.
  chk('app-topbar', 'VP.F canvas / §2', 'present, h=56', topbar ? `present, h=${R(topbar).h}` : 'absent', !!topbar && R(topbar).h === 56)

  // §2.1b / D9 (#214) — the header's right side is autosave + Publish and nothing else; the `⋯`
  // link-out overflow is removed. Printed as the full control list rather than a boolean, so the
  // measured value shows what IS there — an absence check that only says "none found" is the trap
  // `absent()` exists for.
  if (hdr) {
    const controls = [...hdr.querySelectorAll('button, a[href]')].map((e) => ({
      name: (e.getAttribute('aria-label') || e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 24) || '(unnamed)',
      icons: [...e.querySelectorAll('svg')].map((i) => String(i.getAttribute('class') || '')).join(' '),
    }))
    const overflow = controls.filter((c) => /more|overflow|⋯|…/i.test(c.name) || /more-horizontal|ellipsis/i.test(c.icons))
    absent('no-header-overflow', '§2.1b', 'no `⋯` link-out overflow in the header (D9)', '.nds-detailhdr',
      overflow, overflow.map((c) => `"${c.name}"`).join(', '))
    info('header-controls', '§2.1b', controls.map((c) => `"${c.name}"`).join(' · ') || '(none)',
      'D9: the right side should be autosave state + Publish ▾ only')
  }

  // §2.1 — band heights.
  if (hdr) chk('header-h', '§2.1', collapsed ? BANDS.headerCollapsed : BANDS.header, R(hdr).h, R(hdr).h === (collapsed ? BANDS.headerCollapsed : BANDS.header))
  chk('product-navigation', 'VP.F canvas / Product navigation', 'navigation trigger in the subheader; scope bar has no page tabs', navigation ? `trigger ${R(navigation).h}px; ${scope?.querySelectorAll('[role=tab]').length ?? 0} page tabs` : 'navigation trigger missing', !!navigation && !!scope && !scope.querySelector('[role=tab]'))
  if (scope) chk('scopetabs-h', '§2.1', BANDS.scopeTabs, R(scope).h, R(scope).h === BANDS.scopeTabs)
  // 41 = the 40px `--nds-toolbar-h` box + a 1px bottom border (measured: box-sizing border-box,
  // padding 6/6, border-bottom 1px). The border is a divider the design wants, so the tolerance
  // lives here rather than making a lane chase a pixel — same treatment as the AG header's 57.
  if (toolbar) chk('toolbar-h', '§2.1', `${BANDS.toolbar} exactly (divider inside the token)`, R(toolbar).h, R(toolbar).h === BANDS.toolbar)
  const familyAbove = !!(family && R(family).y < R(vp).y)
  chk('family-bar-folded', '§2.1', 'no family bar above the grid', familyAbove ? `present, h=${R(family).h}` : 'absent', !familyAbove)
  // 🔴 The toolbar's ±1 IS GONE, and its history is the reason it should be: it existed only because
  // the bar floored at `min-height` instead of holding `--nds-toolbar-h`, and I had explained the
  // resulting 41 as "40 + a 1px border, correct by design" without doing the sum (6+28+6+1). The
  // tolerance kept the defect invisible until a second product moved the tallest child to 34.
  // PES.2 now sets `height` + `border-box` + `align-items:center` with the divider inside the 40.
  // **A tolerance introduced for a defect must die with the defect, or it becomes permission for
  // the defect to return.** This expectation is exact.
  // 28 = the header row alone. The 29px floating-filter row is GONE (CH.1, Owner 2026-09-05, row 18),
  // so the old 57 would now be a tolerance for a band that no longer exists.
  if (agh) chk('ag-header-h', '§2.1', `${BANDS.agHeader} (28 header; no AG filter row since CH.1)`, R(agh).h, Math.abs(R(agh).h - BANDS.agHeader) <= 1)
  // AG 36 spells it `.ag-header-row-group`. Matching `.ag-header-row-column-group` found nothing and
  // reported a build with a 30px group strip as compliant — the witness guard below is why.
  const groupRows = [...document.querySelectorAll('.ag-header-row-group')]
  absent('no-group-strip', '§2.1a', '0 column-group rows', '.ag-header-row', groupRows,
    groupRows.map((r) => `${R(r).h}px group strip`).join(', '))
  // 🔴 THE CHECK ABOVE CANNOT CONFIRM §9.2a's PRECONDITION. A group row is absent whenever no
  // VISIBLE column belongs to a group — which the default view achieves by HIDING the grouped
  // attribute columns while `marryChildren: true` is still in `columns.tsx`. So a pass here means
  // "no 30px strip is being painted", NOT "the married groups are gone". §9.2's column ORDERING
  // stays blocked until they are removed in source: grep `marryChildren`, do not read the DOM.
  // The caveat this line used to carry is RETIRED (#232): the grep it pointed at now answers yes —
  // `columns.tsx:323` returns before the grouping branch and `grouped` defaults to false, so
  // `marryChildren` is unreachable for this sheet and §9.2a's precondition is genuinely met.
  // Kept as a reminder that the DOM check alone never could have told you that.
  info('married-groups', '§9.2a', 'precondition MET — verified by grep, not by this DOM check',
    'a hidden grouped column paints no group row; absence in the DOM was never removal in source')

  // §2.2 — the rows area. The number the whole spec exists for.
  const rowsArea = R(vp).h - (agh ? R(agh).h : 0)
  const expected = H - BANDS.topbar - BANDS.subheaderSeam - BANDS.header - BANDS.scopeTabs - BANDS.toolbar - BANDS.agHeader - BANDS.footer - BANDS.gutter - BANDS.seams + (collapsed ? BANDS.header - BANDS.headerCollapsed : 0)
  chk('rows-area', '§2.2', `${expected} (${(expected / H * 100).toFixed(1)}% of ${H})`, `${rowsArea} (${(rowsArea / H * 100).toFixed(1)}%)`, Math.abs(rowsArea - expected) <= 4)

  // §8.3 — the ratified row height and thumbnail.
  const r0 = q('.ag-row')
  const rowH = r0 ? Math.round(r0.getBoundingClientRect().height) : 0
  chk('row-height', '§8.3', 36, rowH, rowH === 36,
    rowH === 28 ? '🔴 28px ALSO BREAKS §4.3: at 28 the v2 budget leaves zero scroll range, so the collapsing header can never fire. This is not only a density change.' : undefined)
  const thumb = q('.ag-row .nds-thumb, .ag-row img')
  chk('thumbnail', '§8.3', '32×32 in the identity cell', thumb ? `${R(thumb).w}×${R(thumb).h}` : 'absent', !!thumb && R(thumb).w === 32)

  // §4 — collapse. Arming is a RULE, not a defect either way, so it is reported, not graded.
  // NOTE: this asserts the scroll SOURCE exists and scrolls. It does NOT test collapse behaviour —
  // a programmatic scrollTop + dispatched `scroll` does not fire the collapse; only a real wheel
  // does (PES.1, measured). Exercising collapse needs `page.mouse.wheel()` from the runner.
  chk('scroll-source', '§4.4', '.ag-grid-viewport.ag-layout-normal scrolls', getComputedStyle(vp).overflowY, ['auto', 'scroll'].includes(getComputedStyle(vp).overflowY))
  const C = BANDS.header - BANDS.headerCollapsed, T = 32
  const S = vp.scrollHeight, Hv = vp.clientHeight
  const Rexpanded = S - (collapsed ? Hv - C : Hv)
  const armed = Rexpanded - C >= T
  info('collapse-arming', '§4.2', `S=${S} H(expanded)=${collapsed ? Hv - C : Hv} R=${Rexpanded} → ${armed ? 'ARMED' : 'NOT armed'} (needs R >= ${C + T})`,
    `measured against EXPANDED geometry per §4.2 — never recompute it from collapsed geometry. §4.3a: R is consumed by the vertical budget, so this reading describes THIS build at THIS ${innerHeight}px viewport and nothing else — the same build arms on a shorter screen and not on a taller one, and any vertical pixel won anywhere shrinks R again.`)

  // §5 — the slide-over overlays; it does not displace, and it sits below the confirm band.
  // 🔴 `if (dock) { … }` SILENTLY OMITTED FIVE ASSERTIONS. The drawer mounts AFTER the grid settles,
  // so the probe ran before it existed and §5's checks simply did not appear — and **an absent check
  // is indistinguishable from an absent problem in a summary that counts failures.** §13 carried
  // them as 🟢 on that basis for an unknown stretch. **A conditional block around a GROUP of
  // assertions must ABSTAIN when its precondition is missing, never skip.**
  if (!dock) {
    for (const id of ['drawer-fixed', 'drawer-below-overlay', 'sheet-not-displaced', 'sheet-reachable-behind-drawer', 'not-aria-modal']) {
      checks.push({ id, sec: '§5', expected: 'measured with the drawer open', ok: null,
        measured: 'NOT MEASURED — no `.nds-drawer-dock` at probe time. An absence of evidence, not evidence of compliance.' })
    }
  }
  if (dock) {
    const cs = getComputedStyle(dock), z = parseInt(cs.zIndex, 10)
    chk('drawer-fixed', '§5.3', 'fixed (overlays the sheet)', cs.position, cs.position === 'fixed')
    chk('drawer-below-overlay', '§5.1', '< 1400 so ActionConfirm lands on top', cs.zIndex, !Number.isNaN(z) && z < 1400)
    // 🔴 EXACT, not a tolerance. This was `> W − 200`, which is loose enough that a partial
    // displacement passes — and worse, at 1728 the whole §5 block ABSTAINED (no dock) and I read
    // its absence from the failure list as a pass. **An abstain is not a pass**, and I conflated
    // them in a summary after building the abstain mechanism to prevent exactly that.
    // The rule is binary: §5.1 chose the slide-over so the sheet keeps its width with the drawer
    // open. Compare against the drawer-CLOSED width, passed in from the runner.
    if (closedVpWidth == null) {
      checks.push({ id: 'sheet-not-displaced', sec: '§5.3', ok: null, expected: 'open width === closed width',
        measured: 'NOT MEASURED — no drawer-closed width captured for this viewport' })
    } else {
      chk('sheet-not-displaced', '§5.3', `open width === closed width (${closedVpWidth})`,
        `${R(vp).w} (displaced by ${closedVpWidth - R(vp).w}px)`, R(vp).w === closedVpWidth)
    }
    // 🔴 This was `!q('.nds-drawer-backdrop, [class*=backdrop]')` — an absence check against a
    // GUESSED class with no witness. Had the class been named anything else it would have reported
    // compliance forever, exactly as the `.nds-pill.warning` and `.ag-header-row-column-group`
    // selectors did. **Assert the OUTCOME §5.1 rules on — the sheet behind stays reachable — not
    // the absence of one element name.** Anything with pointer events covering the sheet shows up
    // as itself under `elementFromPoint`, whatever it is called.
    const probePt = { x: R(vp).x + Math.min(200, R(vp).w / 3), y: R(vp).y + Math.min(120, R(vp).h / 3) }
    const atPoint = document.elementFromPoint(probePt.x, probePt.y)
    const reachable = !!(atPoint && atPoint.closest('.ag-root-wrapper'))
    const named = q('.nds-drawer-backdrop, [class*=backdrop]')
    chk('sheet-reachable-behind-drawer', '§5.1 §5.2', 'a point over the sheet hits the GRID (no blocking overlay, whatever it is named)',
      reachable ? `hit .${String(atPoint.className || atPoint.tagName).split(/\s+/)[0]} inside the grid` : `hit ${atPoint ? String(atPoint.className || atPoint.tagName).slice(0, 40) : 'nothing'} — something is covering the sheet`,
      reachable, named ? `note: an element matching a backdrop class is also present (${String(named.className).slice(0, 40)})` : undefined)
    chk('not-aria-modal', '§5.2', 'aria-modal absent or false', String(dock.getAttribute('aria-modal')), dock.getAttribute('aria-modal') !== 'true')
  }

  // §6.2 — no warning-glyphed or warning-toned control above the grid.
  // Matched on GLYPH and TONE, not on one class: the chip is `button.nds-btn.sm` carrying a lucide
  // AlertTriangle and has no `.warning` class, so a class-only selector clears a violating build.
  const bars = [...document.querySelectorAll('.nds-toolbar, .nds-channel-toolbar, .nds-grid-prefsbar')]
  const warnChips = bars.flatMap((bar) => [...bar.querySelectorAll('button, .nds-pill')]
    .filter((e) => e.querySelector('svg[class*="alert"], svg[class*="triangle"]') || /\bwarning\b/.test(String(e.className)))
    .map((e) => `${e.tagName.toLowerCase()}.${String(e.className || '').trim().replace(/\s+/g, '.')} "${(e.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 26)}"`))
  absent('no-warning-chip', '§6.2', 'none above the grid — a count of work is a VIEW, not a warning',
    '.nds-toolbar, .nds-channel-toolbar, .nds-grid-prefsbar', warnChips, warnChips.join(' | '))

  // §7 — the document never scrolls horizontally. NECESSARY, NOT SUFFICIENT (§7.3).
  const de = document.documentElement
  chk('no-h-scroll', '§7', `scrollWidth === clientWidth (${de.clientWidth})`, de.scrollWidth, de.scrollWidth === de.clientWidth,
    'necessary, not sufficient — §7.3 anchoring is the other half and no static probe can see it')

  // §9.1 IS NO LONGER MEASURED HERE — see `measureRequiredFit` in the runner (#684).
  //
  // 🔴 The rule this block used was WRONG on any scope with a pinned RIGHT band, and I only found
  // that by pointing it at one. It compared each header against the grid ROOT box and subtracted no
  // pinned section, so a column sitting UNDER the channel's right-pinned `actions` column
  // counted as visible. On master the answer is unaffected (right band 0), which is why the defect
  // survived every run this suite ever made: **the arm that would have failed was the arm that was
  // never run.** A second implementation living beside the corrected one would drift, so this one is
  // gone rather than fixed in place — one rule, one implementation, run at every coordinate in `SCOPES`.
  const seen = new Set(), cols = []
  document.querySelectorAll('.ag-header-cell').forEach((h) => { const id = h.getAttribute('col-id'); if (id && !seen.has(id)) { seen.add(id); cols.push({ id, ...R(h) }) } })
  info('column-order', '§9.2', cols.map((c) => c.id).join(','), 'read for review — identity → required-and-incomplete → commerce spine → the rest')

  return { viewport: `${W}×${H}`, collapsed, rows, rowH, checks, nCols: cols.length, colIds: cols.map((c) => c.id), vpWidth: R(vp).w }
}

/**
 * §7 at the RIGHT EDGE — the position where the Owner's complaint actually lives.
 *
 * Runs in the RUNNER, not the page: opening the editor needs a real wheel and real keys, and a
 * programmatic scrollLeft does not inform AG (headers move, the rendered column range does not).
 *
 * Witnesses `.ag-virtual-list-viewport` with rendered rows — NOT `.ag-popup`, which is a
 * full-width zero-height container that answers "no border, no shadow" and looks like a measured
 * negative. If the list never renders, this ABSTAINS: AG.1 measured the select editor being torn
 * down ~2ms after opening (the DS Listbox portals to body and autofocuses, AG sees focus leave the
 * cell and stops editing), so "no overflow found" here would be a fact about a panel that never
 * existed.
 */
async function checkRightEdgePopup(page, vpSize) {
  const out = { id: 'popup-at-right-edge', sec: '§7', vp: `${vpSize.w}×${vpSize.h}` }
  // Scroll the grid fully right with a REAL wheel.
  const box = await page.locator('.ag-grid-viewport.ag-layout-normal').boundingBox().catch(() => null)
  if (!box) return { ...out, measured: 'NOT MEASURED — no grid viewport', ok: false }
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  for (let i = 0; i < 12; i++) await page.mouse.wheel(600, 0)
  await page.waitForTimeout(500)

  // Target the rightmost cell whose column is an EDITABLE SELECT — not merely the rightmost cell.
  // A first version picked `ready:scope`, a readiness chip that is not editable at all, and
  // "the list never rendered" there says nothing about select clamping: it would be an abstain
  // about the wrong control, which reads like evidence and is not.
  const SELECTS = ['status', 'supplier_declared_dg_hz_regulation', 'country_of_origin',
    'product_expiration_type', 'parentage_level', 'skip_offer', 'map_policy', 'target_gender',
    'ghs_chemical_h_code', 'gpsr_safety_attestation', 'handmade_classification']
  const target = await page.evaluate((SELECTS) => {
    const vp = document.querySelector('.ag-grid-viewport.ag-layout-normal')
    const box = vp.getBoundingClientRect()
    const cells = [...document.querySelectorAll('.ag-row .ag-cell')]
      .filter((c) => SELECTS.includes(c.getAttribute('col-id')))
      .filter((c) => { const r = c.getBoundingClientRect(); return r.width > 40 && r.right <= box.right + 1 && r.left >= box.left })
    if (!cells.length) return null
    // rightmost of them
    const last = cells.reduce((a, c) => (c.getBoundingClientRect().right > a.getBoundingClientRect().right ? c : a))
    const r = last.getBoundingClientRect()
    return { colId: last.getAttribute('col-id'), x: r.x + r.width / 2, y: r.y + r.height / 2,
      right: Math.round(r.right), gapToEdge: Math.round(box.right - r.right) }
  }, SELECTS)
  if (!target) return { ...out, ok: null,
    measured: 'ABSTAIN — no editable SELECT column is visible at the right edge after scrolling; nothing to clamp-test here' }

  // Open the editor. Try the gestures in the order §5.5 specifies, and report which one worked.
  let opened = null
  for (const [how, act] of [
    ['Enter', async () => { await page.mouse.click(target.x, target.y); await page.keyboard.press('Enter') }],
    ['F2', async () => { await page.mouse.click(target.x, target.y); await page.keyboard.press('F2') }],
    ['double-click', async () => { await page.mouse.dblclick(target.x, target.y) }],
  ]) {
    await act()
    const got = await page.waitForFunction(() => {
      const l = document.querySelector('.ag-virtual-list-viewport, .nds-listbox-panel, [role="listbox"]')
      return !!l && l.querySelectorAll('[role="option"], .ag-virtual-list-item').length > 0
    }, null, { timeout: 1500, polling: 100 }).then(() => true).catch(() => false)
    if (got) { opened = how; break }
    await page.keyboard.press('Escape').catch(() => {})
  }
  if (!opened) {
    return { ...out, colId: target.colId, ok: null,
      measured: `ABSTAIN — the list never rendered on SELECT column \`${target.colId}\` (${target.gapToEdge}px from the viewport's right edge; tried Enter, F2, double-click). This IS an editable select, so the abstain is about the editor and not the cell: consistent with AG.1's finding that it is torn down ~2ms after opening. "No overflow" here would describe a panel that never existed.` }
  }
  const geom = await page.evaluate(() => {
    const l = document.querySelector('.ag-virtual-list-viewport, .nds-listbox-panel, [role="listbox"]')
    const r = l.getBoundingClientRect()
    return { right: Math.round(r.right), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height),
      options: l.querySelectorAll('[role="option"], .ag-virtual-list-item').length,
      docScrollW: document.documentElement.scrollWidth, docClientW: document.documentElement.clientWidth }
  })
  // Close it with an EXPLICIT cancel. This probe opened a live editor on a real row, and local dev
  // writes to the PRODUCTION database — so how the editor closes is a write question, not a
  // cleanup detail. Leaving it open let teardown decide: AG's `destroy()` calls `stopEditing()`
  // with COMMIT semantics by default, which is the opposite of what a read-only probe wants. No
  // option was chosen here, so a commit would have written the value back unchanged — harmless
  // today only because nothing changed it. Escape cancels, and says so.
  await page.keyboard.press('Escape').catch(() => {})
  await page.waitForTimeout(80)

  const fitsRight = geom.right <= vpSize.w
  const fitsBottom = geom.bottom <= vpSize.h
  const noWiden = geom.docScrollW === geom.docClientW
  return { ...out, colId: target.colId, ok: fitsRight && fitsBottom && noWiden,
    measured: `opened via ${opened} on ${target.colId} (${geom.options} options, ${geom.w}×${geom.h}) — right ${geom.right}/${vpSize.w}${fitsRight ? '' : ' OVERFLOWS'}, bottom ${geom.bottom}/${vpSize.h}${fitsBottom ? '' : ' OVERFLOWS'}, document ${geom.docScrollW}/${geom.docClientW}${noWiden ? '' : ' WIDENED'}` }
}

/**
 * §7 for the DS popovers — DS.2's three assertions, at every width this script runs.
 *
 * The third is the one that matters and the one a width comparison misses: DS.2's bug was a panel
 * of the CORRECT WIDTH at the WRONG X, so any check comparing panel width to trigger width passed.
 * Anchoring — one of the panel's edges aligned to the trigger's — is what convicts it.
 */
async function checkPopovers(page, vpSize) {
  const results = []
  // 🔴 EIGHTH TRAP — and the first that was about SAFETY rather than a wrong number.
  // This probe used to click EVERY button wider than 20px in the header and scope bar, to find out
  // which ones opened a panel. That was safe only because the studio's one action button
  // (`PublishMenu`) happens to be inert today: every item is `disabled: true` while publish is
  // unwired. The instrument inherited its safety from the product's current state — and NOBODY
  // RE-MEASURES AN INHERITED PROPERTY. When PES.5 wires publish (preflight-first, dry-run by
  // default), the same line would click a live trigger against a PRODUCTION row, because local dev
  // writes to the prod DB. Worse, the failure would look benign: a direct-action button opens no
  // panel, so it lands in the ABSTAIN branch below as "no popover opened" — the quiet measurement
  // that is not a negative result, wearing a new costume.
  // So gate on a DECLARED affordance. Every DS popover trigger sets `aria-haspopup` (Menu → menu,
  // Listbox → listbox, DateField/AccountSwitcher → dialog). A button that declares it opens a
  // popup is a button this probe may click. Anything else is REPORTED, never clicked — if a new
  // control belongs in this check, it says so in its own markup.
  const { triggers, skipped } = await page.evaluate(() => {
    const out = [], skip = []
    const nameOf = (b) => (b.getAttribute('aria-label') || b.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 22)
    document.querySelectorAll('.nds-scopebar-right button, .nds-detailhdr button').forEach((b, i) => {
      const r = b.getBoundingClientRect()
      if (r.width <= 20) return
      const pop = b.getAttribute('aria-haspopup')
      if (!pop) { skip.push({ name: nameOf(b), disabled: b.disabled }); return }
      out.push({ i, pop, name: nameOf(b), x: r.x + r.width / 2, y: r.y + r.height / 2, left: Math.round(r.left), right: Math.round(r.right) })
    })
    return { triggers: out, skipped: skip }
  })
  for (const s of skipped) {
    results.push({ name: s.name, ok: null,
      measured: `SKIPPED — declares no \`aria-haspopup\`, so this probe will not click it to find out what it does${s.disabled ? ' (currently disabled)' : ''}. A control that opens a panel should declare it; one that performs an action must never be clicked by a layout probe.` })
  }
  const POP_SEL = '.nds-combo-pop, .nds-menu, .nds-listbox-panel, [role="listbox"], [role="menu"]'
  for (const t of triggers) {
    // 🔴 NINTH TRAP — THE STALE PANEL, and the tell was three triggers reporting ONE geometry.
    // At 1280 the Publish, Market and Content-locale panels each measured 983–1264 w281. Three
    // different triggers cannot anchor to one identical position: the previous panel had not
    // closed, and this selector matched IT every time. So "Market NOT ANCHORED" was the probe
    // reading Publish's panel, and "Content locale" PASSED FOR THE WRONG REASON — its trigger
    // happens to share a right edge with the stale panel. One defect, one false failure and one
    // false pass, and I nearly filed the false failure as a DS.2 bug.
    // Escape is a request, not a guarantee. Wait for the panel to be GONE before opening the next
    // one, and abstain loudly rather than measure whatever is still on screen.
    const clear = await page.waitForFunction((sel) => !document.querySelector(sel), POP_SEL,
      { timeout: 2000, polling: 100 }).then(() => true).catch(() => false)
    if (!clear) {
      results.push({ name: t.name, ok: null,
        measured: `ABSTAIN — a previous popover was still open when this trigger's turn came, so any geometry read here would describe THAT panel, not this one.` })
      continue
    }
    // Coordinates captured before the loop go STALE: closing a panel re-flows the scope bar, and at
    // 1440/1280 the re-flow moved these triggers enough that the click landed beside them and the
    // check read "no popover opened" — a probe defect wearing the costume of a product finding.
    const live = await page.evaluate((i) => {
      const b = document.querySelectorAll('.nds-scopebar-right button, .nds-detailhdr button')[i]
      if (!b) return null
      const r = b.getBoundingClientRect()
      return { x: r.x + r.width / 2, y: r.y + r.height / 2, left: Math.round(r.left), right: Math.round(r.right) }
    }, t.i)
    if (!live) { results.push({ name: t.name, ok: null, measured: 'ABSTAIN — the trigger is no longer in the DOM at the index it was found at.' }); continue }
    t.x = live.x; t.y = live.y; t.left = live.left; t.right = live.right
    await page.mouse.click(t.x, t.y)
    // 🔴 SETTLE THE PANEL, not just witness it. A first version measured on first appearance and
    // reported the Publish menu as 273px wide ending at x=1728 (unanchored, past the margin); the
    // settled panel is 257px ending at 1712 and correct. Fourth transient this script has read as a
    // fact — a popover positions AFTER it mounts, exactly as the sheet applies its view after
    // first paint. Wait for the rect to hold steady across three samples.
    const shown = await page.waitForFunction(() => {
      const p = document.querySelector('.nds-combo-pop, .nds-menu, .nds-listbox-panel, [role="listbox"], [role="menu"]')
      if (!p) return false
      const r = p.getBoundingClientRect()
      const n = `${Math.round(r.left)}x${Math.round(r.right)}x${Math.round(r.height)}`
      if (window.__pop === n) { window.__popS = (window.__popS || 0) + 1 } else { window.__pop = n; window.__popS = 0 }
      return window.__popS >= 3
    }, null, { timeout: 2500, polling: 100 }).then(() => true).catch(() => false)
    if (!shown) { results.push({ name: t.name, ok: null, measured: `ABSTAIN — no popover opened, or its position never settled within 2.5s` }); continue }
    await page.evaluate(() => { window.__pop = null; window.__popS = 0 })
    const g = await page.evaluate(() => {
      const p = document.querySelector('.nds-combo-pop, .nds-menu, .nds-listbox-panel, [role="listbox"], [role="menu"]')
      const r = p.getBoundingClientRect()
      // `selectedInView` (DS.2's ask): the defect it catches is invisible to every geometric check —
      // the panel lands perfectly and the SELECTED value is highlighted below the fold, so the
      // operator cannot see what is currently chosen. Placement being right says nothing about it.
      const sel = p.querySelector('[role="option"][aria-selected="true"], [aria-selected="true"]')
      let selectedInView = null
      if (sel) { const sr = sel.getBoundingClientRect()
        selectedInView = sr.top >= r.top - 1 && sr.bottom <= r.bottom + 1 }
      return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width),
        docW: document.documentElement.scrollWidth, clientW: document.documentElement.clientWidth,
        selectedInView, scrollTop: Math.round(p.scrollTop),
        selTop: sel ? Math.round(sel.getBoundingClientRect().top - r.top + p.scrollTop) : null }
    })
    const noWiden = g.docW === g.clientW
    const insideMargin = g.right <= vpSize.w - 8
    const anchored = Math.abs(g.left - t.left) <= 1 || Math.abs(g.right - t.right) <= 1
    const selOk = g.selectedInView !== false
    results.push({ name: t.name, ok: noWiden && insideMargin && anchored && selOk,
      measured: `panel ${g.left}–${g.right} (w ${g.w}) · trigger ${t.left}–${t.right} · document ${g.docW}/${g.clientW}` +
        `${g.selectedInView === null ? '' : ` · selectedInView ${g.selectedInView} (scrollTop ${g.scrollTop}, sel at ${g.selTop})`}` +
        `${selOk ? '' : ' — SELECTED VALUE IS BELOW THE FOLD: placement is right and the operator cannot see what is chosen'}` +
        `${noWiden ? '' : ' WIDENED'}${insideMargin ? '' : ` RIGHT ${g.right} > ${vpSize.w - 8}`}${anchored ? '' : ' NOT ANCHORED to its trigger'}` })
    // Close it, then CONFIRM. Escape reaches whatever holds focus, which after a mouse click is not
    // reliably the panel — that is how the stale panel above survived a press that looked like a
    // close. If it is still there, click a neutral point well away from any trigger and re-check.
    await page.keyboard.press('Escape').catch(() => {})
    let gone = await page.waitForFunction((sel) => !document.querySelector(sel), POP_SEL,
      { timeout: 800, polling: 80 }).then(() => true).catch(() => false)
    if (!gone) {
      // Re-click the SAME trigger to toggle it shut. Not a blind outside click: at 1280 the far-left
      // point I first reached for is the AppNavRail, which would have been trap 8 committed twice in
      // one function — clicking an unknown control to find out what it does. This trigger declared
      // `aria-haspopup`, so toggling it is the one click here that is known-safe.
      await page.mouse.click(t.x, t.y).catch(() => {})
      gone = await page.waitForFunction((sel) => !document.querySelector(sel), POP_SEL,
        { timeout: 800, polling: 80 }).then(() => true).catch(() => false)
    }
    if (!gone) results.push({ name: `${t.name} (close)`, ok: null,
      measured: 'ABSTAIN — this popover would not close via Escape or an outside click, so every reading after it in this state is suspect.' })
  }
  return results
}

/**
 * §5.4 — the drawer must not cover the cell it was opened from, and the trailing scroll pad that
 * makes that possible for trailing columns (#249) must be a VIEWPORT PAD, never a phantom column.
 *
 * Two assertions, and the second is the one that convicts the likely mis-build: a phantom column
 * would satisfy the reveal and then leak into column counts, export, keyboard nav and Customise.
 */
async function checkRevealAndPad(page, vpSize, closedColIds) {
  const out = { sec: '§5.4', vp: `${vpSize.w}×${vpSize.h}` }
  const box = await page.locator('.ag-grid-viewport.ag-layout-normal').boundingBox().catch(() => null)
  if (!box) return [{ ...out, id: 'reveal', ok: null, measured: 'ABSTAIN — no grid viewport' }]

  /*
   * 🔴 THE ANCHOR WAS A COLUMN THAT NO LONGER EXISTS. This clicked `.ag-cell[col-id="sku"]`, chosen
   * because SKU is non-editable — and #724 absorbed `sku` into the identity band, so on the merged
   * build the check returned "ABSTAIN — no sku cell to start from" at all three widths. **Not a
   * wrong number: an absent one wearing an honest label**, which is the shape that would have spent
   * a held six-minute window producing three abstains on the clause the window was called for.
   *
   * Anchor on the FIRST CELL OF THE SCROLLING SECTION instead — the check needs "a focusable cell
   * left of the panel to walk right from", never that column specifically, and a positional anchor
   * survives a column model that is still moving. The pinned band is deliberately NOT used: #724 put
   * the ⋯ verb menu inside it, so a click there could open a menu, and a layout probe must never
   * click a control whose action it has not established (`reference_probe_safety…`).
   *
   * A single click focuses rather than edits in this grid, but that is a property of the build and
   * not of the click, so it is CHECKED rather than assumed: if an editor opened, Escape closes it
   * and the reading says so.
   */
  const anchor = await page.evaluate(() => {
    const row = [...document.querySelectorAll('.ag-row')][2]
    if (!row) return null
    const c = row.querySelector('.ag-grid-scrolling-cells .ag-cell')
      ?? [...row.querySelectorAll('.ag-cell')].find((e) => !e.closest('.ag-grid-pinned-left-cells, .ag-grid-pinned-right-cells'))
    if (!c) return null
    const r = c.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2, colId: c.getAttribute('col-id') }
  })
  if (!anchor) return [{ ...out, id: 'reveal', ok: null, measured: 'ABSTAIN — no scrolling-section cell on row 3 to start from (looked for `.ag-grid-scrolling-cells .ag-cell`, then any `.ag-cell` outside the pinned containers)' }]
  await page.mouse.click(anchor.x, anchor.y)
  const editorOpened = await page.evaluate(() => !!document.querySelector('.ag-cell-inline-editing, .ag-popup-editor'))
  if (editorOpened) { await page.keyboard.press('Escape'); await page.waitForTimeout(120) }
  const PANEL = 520
  for (let i = 0; i < 24; i++) {
    const s = await page.evaluate(() => {
      const f = document.querySelector('.ag-cell-focus'); const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      if (!f) return null; const r = f.getBoundingClientRect()
      return { right: Math.round(r.right), vpRight: Math.round(v.getBoundingClientRect().right), colId: f.getAttribute('col-id') }
    })
    if (!s) break
    if (s.right > s.vpRight - PANEL) break
    await page.keyboard.press('ArrowRight'); await page.waitForTimeout(70)
  }
  out.anchor = `${anchor.colId}${editorOpened ? ' ⚠ a click opened an EDITOR here — Escaped before measuring; this cell is editable on single click' : ''}`
  const before = await page.evaluate(() => {
    const f = document.querySelector('.ag-cell-focus'); const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
    if (!f) return { colId: null, right: null, scrollLeft: Math.round(v.scrollLeft), fullyVisible: null }
    const r = f.getBoundingClientRect(), vb = v.getBoundingClientRect()
    // 🔴 THE PRECONDITION THE VERB PATH IMPLIES. An operator cannot right-click a cell that is off
    // screen, so on this path the reveal should be a NO-OP whenever the cell was already fully
    // visible. Capturing it turns a clearance check that cannot fail under overlap 0 into one that
    // can: **no write when the cell was already readable.** Reset the write log here so only the
    // reveal's writes are counted, not AG's own scroll-into-view during keyboard navigation.
    window.__revealWrites = []
    return { colId: f.getAttribute('col-id'), right: Math.round(r.right), scrollLeft: Math.round(v.scrollLeft),
      fullyVisible: r.left >= vb.left - 1 && r.right <= vb.right + 1 }
  })

  // Open the record with the explicit verb (§5.5): the row context menu, not a double-click.
  const opened = await page.evaluate(() => {
    const f = document.querySelector('.ag-cell-focus'); if (!f) return false
    const r = f.getBoundingClientRect()
    f.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.x + r.width / 2, clientY: r.y + r.height / 2 }))
    return true
  })
  if (opened) {
    await page.waitForTimeout(500)
    await page.evaluate(() => {
      const el = [...document.querySelectorAll('.ag-menu-option-text, [role=menuitem]')].find((e) => /open record/i.test(e.textContent || ''))
      if (el) (el.closest('[role=menuitem]') || el).dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
    await page.waitForTimeout(1800)
  }
  const after = await page.evaluate(() => {
    const f = document.querySelector('.ag-cell-focus'); const d = document.querySelector('.nds-drawer-dock')
    const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
    const writes = (window.__revealWrites || []).map((w) => (typeof w === 'object' ? w.v : w))
    const hook = window.__revealHookInstalled === true
    const seen = new Set(); let n = 0; const ids = []
    document.querySelectorAll('.ag-header-cell').forEach((h) => { const id = h.getAttribute('col-id'); if (id && !seen.has(id)) { seen.add(id); n++; ids.push(id) } })
    return { drawerLeft: d ? Math.round(d.getBoundingClientRect().left) : null,
      focusRight: f ? Math.round(f.getBoundingClientRect().right) : null, colId: f?.getAttribute('col-id') ?? null, hook,
      scrollLeft: Math.round(v.scrollLeft), maxScroll: Math.round(v.scrollWidth - v.clientWidth), nCols: n, colIds: ids, writes,
      gridLeft: Math.round(v.getBoundingClientRect().left), gridRight: Math.round(v.getBoundingClientRect().right),
      focusLeft: f ? Math.round(f.getBoundingClientRect().left) : null }
  })

  const results = []
  if (after.drawerLeft == null || after.focusRight == null) {
    results.push({ ...out, id: 'reveal', ok: null, measured: `ABSTAIN — drawer ${after.drawerLeft == null ? 'did not open' : 'open'}, focus ${after.focusRight == null ? 'lost' : 'kept'}` })
  } else {
    const clear = after.focusRight <= after.drawerLeft
    // Was the TRAILING case exercised? A cell within a panel-width of the end of the column list is
    // the one §5.4's pad exists for — the grid runs out of scroll and no reveal can clear it. If the
    // probed cell is not trailing, this row says nothing about that case and must say so.
    const trailingSlack = after.maxScroll - after.scrollLeft
    if (trailingSlack > 0) {
      results.push({ ...out, id: 'reveal-trailing-case', ok: null,
        measured: `not exercised by this cell (${trailingSlack}px of scroll remained) — see reveal-trailing-deliberate below, which targets the band on purpose.` })
    }
    // 🔴 DELIBERATE trailing case. The walk-right-from-SKU cell never reaches the band, and I
    // reported that absence to the hub as "the trailing case has never been observed" — a fact
    // about this probe stated as a fact about the product. It is reachable: on master the last
    // 520px holds `productType`, `dsa_responsible_party_address`, `gpsr_safety_attestation` and
    // `ready:scope`, two of which #173 puts in the view because they are flagged on 104/120 rows.
    // Reported as a MEASUREMENT, not an assertion: no mechanism (§9.2's tail or §5.4's inset) has
    // landed, so there is nothing yet to convict — the witness-abstains-until-its-mechanism rule.
    {
      // 🔴 SWEEP THE WIDTH. A first version read only the columns rendered at the current scroll and
      // reported "no column lies in the trailing band" where a sweep finds four — AG virtualises
      // columns, so the DOM holds a window and never the model. **Fourth time this trap has bitten
      // this script, and this time inside the check written to correct a claim it had caused.**
      // 🔴 The band must be measured against the OVERLAP, not an assumed panel width — the same
      // conflation AG.1 found in the reveal rule (`panelWidth` is the panel's width under an
      // overlay and ZERO under an inset), sitting in my own instrument. Under the staged inset the
      // panel sits beside the grid and there is no uncoverable band at all; a hardcoded 520 would
      // keep reporting four columns that are perfectly reachable.
      const overlap = await page.evaluate(() => {
        const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
        const d = document.querySelector('.nds-drawer-dock')
        if (!v || !d) return null
        return Math.max(0, Math.round(v.getBoundingClientRect().right - d.getBoundingClientRect().left))
      })
      const band = await page.evaluate(async (PANEL) => {
        const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
        const seen = new Map()
        const grab = () => document.querySelectorAll('.ag-header-cell').forEach((h) => {
          const id = h.getAttribute('col-id')
          if (id && !seen.has(id)) { const r = h.getBoundingClientRect()
            seen.set(id, { id, left: Math.round(r.left - v.getBoundingClientRect().left + v.scrollLeft), w: Math.round(r.width) }) } })
        const before = v.scrollLeft, end = v.scrollWidth, max = end - v.clientWidth
        grab()
        for (let x = 0; x <= max; x += 300) { v.scrollLeft = x; await new Promise((r) => setTimeout(r, 110)); grab() }
        v.scrollLeft = max; await new Promise((r) => setTimeout(r, 180)); grab()
        v.scrollLeft = before
        return { end, client: v.clientWidth, total: seen.size,
          inBand: [...seen.values()].filter((c) => c.left + c.w > end - PANEL).map((c) => c.id) }
      }, overlap ?? 520)
      results.push({ ...out, id: 'reveal-trailing-deliberate', ok: null,
        measured: band.inBand.length
          ? `${band.inBand.length} of ${band.total} column(s) lie in the uncoverable trailing ${overlap ?? 520}px (MEASURED overlap${overlap === null ? ' unavailable — assumed 520' : ''}) and can never be cleared of an overlay panel at any scroll: ${band.inBand.join(', ')} (content ${band.end}, client ${band.client}). Becomes an assertion when §9.2's non-interactive tail or §5.4's inset lands.`
          : `no column lies in the uncoverable trailing ${overlap ?? 520}px (content ${band.end}) — ${overlap === 0 ? 'the panel does not overlap the grid, so there is no uncoverable band at all' : "§9.2's tail is satisfied here"}.` })
    }
    /**
     * 🔴 THE WITNESS ASKED THE WRONG QUESTION, AND THE HUB CAUGHT IT. I compared the cell against
     * the grid viewport BEFORE the verb — but under the staged inset, opening the drawer NARROWS
     * the grid (rootRight 1439 → 919 at 1440). A cell at 856..986 is fully visible before and
     * clipped by 67px after, so the reveal scrolling it to 903 (= 919 − 16) is CORRECT, and my
     * witness called it "scrolled a cell the operator could already read".
     *
     * **"Was it visible before" is only the right question when opening the panel does not change
     * the viewport.** Under an overlay it is; under an inset it is not. So the test is whether the
     * cell is fully visible in the POST-OPEN geometry — which is the geometry the operator is
     * looking at when the reveal decides.
     */
    if (before.fullyVisible !== null && after.gridRight != null) {
      const w = after.writes || []
      // 🔴 READABLE ≠ INSIDE THE GRID. This compared the cell against the GRID's bounds only, so a
      // cell sitting under the slide-over counted as "visible" and any reveal that moved it was
      // reported as scrolling a cell the operator could already read. That was harmless while the
      // §5.4 inset existed — the grid was narrowed out from under the panel, so inside-the-grid and
      // readable were the same set — and it started firing the moment the reveal actually began
      // working, convicting three CORRECT scrolls (48/66/96px of genuine cover). Fourth time today a
      // repair exposed a check written against the broken world. **A cell is readable only if it is
      // inside the grid AND clear of the panel overlaying it.**
      // 🔴 …AND THE FRAME IS POST-OPEN, PRE-SCROLL. Using `after.focusRight` asks whether the cell is
      // readable AFTER the reveal moved it, which is circular: every successful reveal makes its own
      // cell readable and then gets convicted for having moved a readable cell. The question is what
      // the operator faced when the rule DECIDED — panel present, scroll not yet applied — which is
      // `before.right` (the panel opening does not move the grid; §5.3 proved displacement is 0).
      // I corrected this witness once already today in the other direction, from pre-open to
      // post-open. Neither endpoint was right: the decision frame is between them.
      const rightAtDecision = before.right
      const clearOfPanel = after.drawerLeft == null || rightAtDecision <= after.drawerLeft
      const visibleAfterOpen = after.focusLeft != null && after.focusLeft >= after.gridLeft - 1
        && rightAtDecision <= after.gridRight + 1 && clearOfPanel
      const quiet = !(visibleAfterOpen && w.length > 0)
      results.push({ ...out, id: 'reveal-no-op-when-visible', ok: quiet,
        measured: `${before.colId}: visible before the verb ${before.fullyVisible}, READABLE in the POST-OPEN geometry ${visibleAfterOpen} (at DECISION time: cell right ${rightAtDecision} vs panel left ${after.drawerLeft}, grid ${after.gridLeft}..${after.gridRight}, clear of panel ${clearOfPanel}); reveal wrote [${w.join(', ')}]` +
          `${quiet ? '' : ' — SCROLLED A CELL THE OPERATOR COULD ALREADY READ IN THE GEOMETRY IT DECIDED IN'}` })
    }
    results.push({ ...out, id: 'reveal', ok: clear,
      // Print the WRITES, not just the resulting scroll. Geometry alone cannot separate the hub's
      // three outcomes for this path (#644): a rule never called, a rule called with overlap 0
      // because the panel is measured before it mounts, and a rule that computed a distance and
      // wrote nothing. `writes []` collapses the first two and excludes the third; a non-empty list
      // that did not land IS the third. One field, and the next lane starts one hypothesis in.
      // The ANCHOR is printed because it is no longer a fixed column: it is "whatever the scrolling
      // section starts with", so a reader has to be told which cell the walk began from before the
      // distance means anything.
      measured: `[from ${out.anchor}] ${before.colId} right ${after.focusRight} vs panel left ${after.drawerLeft} — ${clear ? 'clear' : `COVERED by ${after.focusRight - after.drawerLeft}px`} (scrollLeft ${before.scrollLeft} → ${after.scrollLeft} of max ${after.maxScroll})` +
        (after.hook
          ? ` · writes [${(after.writes || []).join(', ')}]` +
            `${(after.writes || []).length === 0 ? ' — no scroll write attempted (interceptor CONFIRMED installed)' : ''}`
          : ` · writes NOT MEASURED — the scrollLeft interceptor is not installed on this page, so an empty list would be empty by construction and proves nothing`) })
  }
  /**
   * The phantom-column witness for #249's scroll pad.
   *
   * 🔴 The first version compared the RENDERED column sets drawer-open vs drawer-closed and fired
   * on five real attribute columns — because the reveal had scrolled the grid, and AG virtualises
   * columns, so a different scroll position renders a different set. That is the banked
   * column-virtualisation trap, applied to a check I had just written to catch someone else's
   * mistake. **A comparison across two scroll positions measures the scroll, not the columns.**
   *
   * The scroll-independent form: wheel BOTH states fully right and compare the LAST rendered
   * column id. A viewport pad leaves the last real column last; a phantom column appears after it.
   */
  const lastColAtMaxScroll = async () => {
    const b = await page.locator('.ag-grid-viewport.ag-layout-normal').boundingBox().catch(() => null)
    if (!b) return null
    await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2)
    for (let i = 0; i < 16; i++) await page.mouse.wheel(700, 0)
    await page.waitForTimeout(400)
    return page.evaluate(() => {
      const cells = [...document.querySelectorAll('.ag-header-cell')].filter((h) => h.getAttribute('col-id'))
      if (!cells.length) return null
      const last = cells.reduce((a, c) => (c.getBoundingClientRect().right > a.getBoundingClientRect().right ? c : a))
      const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      return { id: last.getAttribute('col-id'), scrollWidth: v.scrollWidth }
    })
  }
  const openEnd = await lastColAtMaxScroll()
  await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
  await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: 30000 })
  const closedEnd = await lastColAtMaxScroll()
  if (openEnd && closedEnd) {
    const same = openEnd.id === closedEnd.id
    const padExists = openEnd.scrollWidth !== closedEnd.scrollWidth
    if (!padExists) {
      // 🔴 ABSTAIN, don't pass. This check convicts a phantom column in the #249 scroll pad — and
      // no pad mechanism has landed (scrollWidth is identical open and closed, so nothing widens
      // the scroll container). A green here means "there is nothing to inspect", which is not the
      // same claim as "the pad is a viewport pad and not a phantom". Passing by absence is the
      // #388 pattern: a check must abstain on exactly the assertion it cannot make.
      results.push({ ...out, id: 'no-phantom-column', ok: null,
        measured: `NOT MEASURED — no pad exists yet (scrollWidth ${closedEnd.scrollWidth} identical open and closed), so there is nothing for this check to convict. It will mean something when a pad mechanism lands.` })
    } else {
      results.push({ ...out, id: 'no-phantom-column', ok: same,
        measured: same
          ? `pad present (scrollWidth ${closedEnd.scrollWidth} → ${openEnd.scrollWidth}) and the last column at max scroll is \`${closedEnd.id}\` in both states — a viewport pad, not a phantom column`
          : `drawer-open ends on \`${openEnd.id}\`, drawer-closed on \`${closedEnd.id}\` — a phantom column, not a viewport pad` })
    }
  } else {
    results.push({ ...out, id: 'no-phantom-column', ok: null, measured: 'ABSTAIN — could not read the last column in both states' })
  }
  return results
}

/**
 * §5.4 via the URL path — `?rec=&cell=` on a COLD load.
 *
 * A second, independent failure from the verb path: the reveal fires before the grid exists and
 * never re-fires, so `scrollLeft` stays 0 at every width regardless of which column is named.
 * Baseline before AG.1's hold-until-gridReady-and-replay (measured 2026-09-02 02:0x):
 *   1280 bullet_point  COVERED by 666px · 1280 supplier_… NOT RENDERED
 *   1728 bullet_point  COVERED by 218px · 1728 supplier_… COVERED by 508px
 * This asserts the CORRECT end state, so it fails against that baseline today and passes when the
 * fix lands — no baseline numbers are encoded, only the behaviour they violate.
 */
async function checkUrlPathReveal(browser, vpSize, rowId) {
  /**
   * 🔴 THIS CHECK CLAIMS A COLD LOAD, SO IT MUST HAVE A COLD CONTEXT — and for several runs it did
   * not. `checkRevealAndPad` legitimately wheels the grid fully right, `useGridState` persists
   * `api.getState()` wholesale to `localStorage` (AG 36's `GridState` includes `scroll`), and the
   * next navigation in the SAME context replays it as `initialState`. So this check inherited a
   * max-scrolled grid from its own predecessor and reported four failures as a product regression.
   * **A probe that shares a context with its predecessor is not measuring a cold load.**
   * (AG.1 proved the restore with a `scrollLeft` setter intercept — zero programmatic writes in the
   * failing case; the writer was this script.)
   */
  const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: vpSize.w, height: vpSize.h } }).catch(async error => { await browser.close(); console.error(error.message); process.exit(2) })
  /**
   * 🔴 CAPTURE THE WRITES, NOT JUST THE OUTCOME (AG.1, #413). "Cell is clear of the panel" is scored
   * the same by a correct rule and by one that over-scrolls — the overlay-era bug wanted 853 and
   * still landed some cells clear. **The four NO-OPS are the load-bearing evidence: they prove the
   * rule is not moving grids the operator can already read.** So assert the write behaviour too, or
   * the check cannot fail in the direction that produced the defect it exists for.
   */
  /*
   * 🔴 THE INTERCEPTOR MUST WITNESS ITSELF — the verb path does, and this one did NOT.
   *
   * `writes []` is the most false-negative-prone value in this suite (see the header), and it means
   * two different things: "the rule attempted no scroll" and "nothing was watching". This path
   * installed its hook on an interval and never recorded whether the install SUCCEEDED, so an empty
   * list here was indistinguishable from an unpatched element — and I quoted that field three times
   * to another lane as evidence their fix had not worked. PES.2 named this class from their side the
   * same hour ("a measurement that could not be taken, reported as one that came back empty"); this
   * is the same defect inside the instrument that found theirs.
   */
  await page.addInitScript(() => {
    window.__revealWrites = []
    window.__revealWriteStacks = []
    window.__revealHookInstalled = false
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
    const install = () => {
      const el = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      if (!el || el.__uxPatched) return false
      Object.defineProperty(el, 'scrollLeft', { configurable: true,
        get() { return proto.get.call(this) },
        /*
         * 🔴 CAPTURE WHO WROTE, NOT JUST WHAT. `writes [136,136]` is two writes of one value, and
         * "the reveal computed it" and "AG restored it" are indistinguishable by value alone — the
         * hub's position is that nobody can tell from outside the call. A setter interceptor CAN:
         * `new Error().stack` at the moment of the write names the frame that made it. Next's dev
         * build ships source maps, so the frames carry real function and file names.
         * Cheap, read-only, and it answers the question a whole build cycle was about to be spent on.
         */
        set(v) {
          const st = (new Error().stack || '').split('\n').slice(2, 6)
            .map((l) => l.trim().replace(/^at\s+/, '').replace(/\?[0-9a-f]+/g, '').slice(0, 110))
          window.__revealWrites.push(Math.round(v))
          window.__revealWriteStacks.push({ v: Math.round(v), at: Math.round(performance.now()), frames: st })
          proto.set.call(this, v)
        } })
      el.__uxPatched = true; window.__revealHookInstalled = true; return true
    }
    const t = setInterval(() => { if (install()) clearInterval(t) }, 40)
  })
  try {
  const results = []
  if (!rowId) return [{ sec: '§5.4', id: 'url-path-reveal', vp: `${vpSize.w}×${vpSize.h}`, ok: null, measured: 'ABSTAIN — no row id' }]
  for (const col of ['bullet_point', 'supplier_declared_dg_hz_regulation']) {
    const out = { sec: '§5.4', id: `url-path-reveal:${col}`, vp: `${vpSize.w}×${vpSize.h}` }
    await page.goto(`${STUDIO}&rec=${encodeURIComponent(rowId)}&cell=${col}`, { waitUntil: 'domcontentloaded' })
    const ok = await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: 30000 }).then(() => true).catch(() => false)
    if (!ok) { results.push({ ...out, ok: null, measured: 'ABSTAIN — no rows rendered' }); continue }
    await page.waitForTimeout(3000) // past the 1.3s early fire
    const r = await page.evaluate((c) => {
      const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      const d = document.querySelector('.nds-drawer-dock')
      const cell = document.querySelector(`.ag-cell[col-id="${c}"]`)
      return { scrollLeft: Math.round(v.scrollLeft), max: Math.round(v.scrollWidth - v.clientWidth),
        panelLeft: d ? Math.round(d.getBoundingClientRect().left) : null,
        gridRight: Math.round(v.getBoundingClientRect().right),
        cellRight: cell ? Math.round(cell.getBoundingClientRect().right) : null,
        writes: (window.__revealWrites || []).slice(), hook: window.__revealHookInstalled === true,
        stacks: (window.__revealWriteStacks || []).slice() }
    }, col)
    if (r.panelLeft == null) { results.push({ ...out, ok: null, measured: 'ABSTAIN — drawer did not open' }); continue }
    if (r.cellRight == null) {
      // The silent shape: not covered, ABSENT. Worse than a covered cell — the operator gets no
      // signal the deep link took them anywhere.
      results.push({ ...out, ok: false, measured: `target column NOT RENDERED — virtualised out, scrollLeft ${r.scrollLeft}/${r.max}. The named cell is nowhere on screen; this is the SILENT shape, not merely a covered one.` })
      continue
    }
    const clear = r.cellRight <= r.panelLeft
    const w = r.writes || []
    // 🔴 CLEARANCE IS UNFALSIFIABLE WHEN THE PANEL DOES NOT OVERLAP THE GRID. Under the staged
    // inset the measured overlap is 0, so `cellRight <= panelLeft` is trivially true for any
    // rendered cell — 21 green ticks that could not have failed. **Abstain on the assertion that
    // cannot fail; keep the one that can.** The write behaviour stays asserted, and it is what
    // found the rule scrolling 14 of 21 grids that needed no scrolling.
    // 🔴 The `writes []` sentence below used to read "the cell was already clear" unconditionally.
    // That was true only while PES.2's staged §5.4 inset existed: the inset narrowed the grid out
    // from under the panel, so overlap was ALWAYS 0 and no-op ALWAYS meant clear. When the inset
    // was deleted (MasterSheet.tsx 08:21:55) the panel began genuinely overlaying, and the same
    // sentence started printing beside "COVERED by 66px" — a false explanation bolted to a correct
    // verdict. **An explanation can be true by coincidence of the environment, and it does not
    // announce itself when the environment moves.** Branch it on `clear`, which is the fact.
    // 🔴 DO NOT UNIFY THIS SELECTOR WITH THE HOST'S. This probe resolves the panel as
    // `.nds-drawer-dock` — the actual `position: fixed` panel. The studio hosts resolve it as
    // `.nds-studio-dock, [data-studio-dock]`, which matches the FRAME'S 0-width flex track pinned to
    // the viewport's right edge (`.nds-studio-dock` does not exist at all). So the hosts measure
    // panelLeft 1728 and compute overlap 0, `isCellCovered` is never true, and `revealDistance`
    // correctly returns 0 — PES.4's diagnosis of the `writes []` this check convicted on.
    // **The conviction exists ONLY because the probe and the host resolve the panel differently.**
    // Adopting the host's hook — including the unambiguous one PES.4 is adding — would make a wrong
    // hook agree with itself and report silence. An independent check must measure the RENDERED
    // THING, never the name the code under test uses for it.
    // Print WHO made each write, once per distinct writer. This is the discriminator between "the
    // reveal computed a distance" and "AG restored a scroll position and the reveal never fired".
    if ((r.stacks || []).length) {
      for (const st of r.stacks) {
        console.log(`        ↳ scrollLeft = ${st.v} at +${st.at}ms, written from:`)
        for (const f of st.frames) console.log(`             ${f}`)
      }
    }
    const overlap = Math.max(0, r.gridRight - r.panelLeft)
    // At most ONE write: the reveal decides once. More than one means something is competing with
    // it — which is exactly how AG's deferred `initialState` restore clobbered a correct 333 with a
    // stale 93 (#425). And the last write must be the landed value, or something overwrote it.
    const oneDecision = w.length <= 1
    const landedAsWanted = w.length === 0 || w[w.length - 1] === r.scrollLeft
    // 🔴 An UNWITNESSED empty write list may not convict. Without the hook confirmed, `writes []`
    // says nothing about the rule — so the verdict abstains rather than reporting a defect that
    // might be the probe's silence. It still FAILS on a covered cell when the hook IS confirmed.
    const writesUsable = r.hook === true || w.length > 0
    results.push({ ...out, ok: !writesUsable ? null : overlap === 0 ? (oneDecision && landedAsWanted) : (clear && oneDecision && landedAsWanted),
      note: overlap === 0 ? 'clearance NOT ASSERTED — measured panel/grid overlap is 0, so "clear" cannot fail here; only the write behaviour is under test' : undefined,
      measured: `overlap ${overlap} · cell right ${r.cellRight} vs panel left ${r.panelLeft}, scrollLeft ${r.scrollLeft}/${r.max} — ${overlap === 0 ? 'clearance not asserted (no overlap)' : clear ? 'clear' : `COVERED by ${r.cellRight - r.panelLeft}px`}` +
        ` · writes [${w.join(', ')}]${oneDecision ? '' : ' — MORE THAN ONE WRITE: something is competing with the reveal'}` +
        `${landedAsWanted ? '' : ` — LAST WRITE ${w[w.length - 1]} DID NOT LAND (${r.scrollLeft}): overwritten`}` +
        `${w.length === 0 ? (r.hook
          ? (clear
            ? ' (no-op, interceptor CONFIRMED installed — the cell was already clear, which is the rule declining to move a grid the operator can read)'
            : ' (no-op, interceptor CONFIRMED installed — AND THE CELL IS COVERED: the rule declined to move a grid the operator CANNOT read. This is the defect, not the restraint.)')
          : ' — ⚠ WRITES NOT MEASURED: the scrollLeft interceptor is NOT confirmed installed on this page, so this empty list is empty BY CONSTRUCTION and is not evidence of anything') : ''}` })
  }
  return results
  } finally { await page.close() }
}

/**
 * W-1 / W-2 — SC.1's contract witnesses (cross-lane request, `docs/2026-09-02-writability-matrix.md` §8).
 *
 * These run BEFORE the browser work, and they belong here for a reason beyond being asked: **§9.1
 * counts required columns from the rendered DOM.** If the sheet payload and the columns payload
 * disagreed, every §9 number in this suite would be measuring a set the sheet does not have. W-1 is
 * a precondition for my own assertions, not scope creep.
 *
 * W-3 is deliberately NOT here — see the note at the call site.
 */
async function checkContract(apiBase, productId) {
  // 🔴 The API's vocabulary is `scope=master|channel` plus `channel=<NAME>` — NOT `scope=AMAZON`.
  // I wrote the latter and got three NOT MEASUREDs; the sheet endpoint said so plainly
  // ("channel was given without scope"), and I had to read the 400 body rather than the status.
  // ⚠ Worth knowing: the COLUMNS endpoint accepted `scope=AMAZON` and silently returned the MASTER
  // scope (`kind: "master"`), while SHEET 400'd on the same input. Two endpoints, one invalid
  // parameter, different strictness — so a lane can compare a master columns payload against a
  // channel sheet and see nothing wrong. Reported separately.
  /*
   * The first two are DERIVED from the coordinates §9.1 actually measures, never restated: a
   * control that has drifted from its subject is worse than no control, because it still prints
   * green. `assert: true` marks the pair W-4 holds to the hardcoded required set.
   */
  const COORDS = [
    { label: `master ${MARKET}/${LOCALE}`, q: `scope=master&market=${MARKET}&locale=${LOCALE}`, assert: true },
    { label: `${CH_SCOPE}·${CH_MARKET}/${CH_LOCALE}`, q: `scope=channel&channel=${CH_SCOPE}&market=${CH_MARKET}&locale=${CH_LOCALE}`, assert: true },
    { label: 'Amazon·DE/de', q: 'scope=channel&channel=AMAZON&market=DE&locale=de' },
    { label: 'eBay·IT/it', q: 'scope=channel&channel=EBAY&market=IT&locale=it' },
  ]
  const out = []
  for (const c of COORDS) {
    const base = `${apiBase}/api/products/${productId}/studio`
    const [cols, sheet] = await Promise.all([
      fetch(`${base}/columns?${c.q}`, { signal: AbortSignal.timeout(60000) }).then(async (r) => r.ok ? r.json() : { __err: `columns ${r.status}: ${(await r.text()).slice(0, 120)}` }).catch((e) => ({ __err: `columns ${e.message}` })),
      fetch(`${base}/sheet?${c.q}`, { signal: AbortSignal.timeout(60000) }).then(async (r) => r.ok ? r.json() : { __err: `sheet ${r.status}: ${(await r.text()).slice(0, 120)}` }).catch((e) => ({ __err: `sheet ${e.message}` })),
    ])
    // Print the SERVER's message, not "did not answer" — the body named my mistake and my first
    // version threw it away, which cost three coordinates and a round trip to the hub.
    if (cols?.__err || sheet?.__err) { out.push({ id: `W-1 ${c.label}`, ok: null, measured: `NOT MEASURED — ${cols?.__err ?? ''}${sheet?.__err ?? ''}` }); continue }
    const declared = (cols.columns ?? []).map((x) => x.key)
    const inSheet = (sheet.columns ?? []).map((x) => x.key)
    // Denominator per coordinate, never hardcoded: master DE declares 96 and Amazon·IT 97 on this
    // product, and another family declares 119/114. A fixed count passes on the wrong family.
    const sameOrder = declared.length === inSheet.length && declared.every((k, i) => k === inSheet[i])
    const rows = sheet.rows ?? []
    const short = rows.filter((r) => Object.keys(r.values ?? {}).length !== declared.length)
    const missingKey = rows.filter((r) => !declared.every((k) => k in (r.values ?? {})))
    out.push({ id: `W-1 ${c.label}`, ok: sameOrder && short.length === 0 && missingKey.length === 0,
      measured: `${inSheet.length}/${declared.length} columns, same order ${sameOrder} · ${rows.length} rows · ${short.length} short · ${missingKey.length} missing a declared key` })
    // W-2 — a cell that cannot be edited must say why.
    const mute = []
    for (const r of rows) for (const [k, v] of Object.entries(r.values ?? {}))
      if (v && (v.writable === false || v.editable === false) && v.writeBlockedReason == null && v.cellBlockedReason == null) mute.push(k)
    const uniq = [...new Set(mute)]
    out.push({ id: `W-2 ${c.label}`, ok: uniq.length === 0,
      measured: uniq.length ? `${uniq.length} column(s) refuse an edit with no stated reason: ${uniq.slice(0, 6).join(', ')}${uniq.length > 6 ? '…' : ''}` : 'every non-editable cell states a reason' })
    // W-4 compares the two contracts at this coordinate. Canonical key migrations must not
    // turn a hardcoded historical set into either a false failure or an unmeasured fit pass.
    try {
      const required = compareRequiredColumns(cols.columns, sheet.columns)
      out.push({ id: `W-4 ${c.label}`, ok: required.ok,
        measured: `${required.declared.length} required [${required.declared.join(', ')}]; sheet ${required.rendered.length}; missing ${required.missing.length}; extra ${required.extra.length}${required.declared.length ? '' : ' — no required denominator measured'}` })
    } catch (error) {
      out.push({ id: `W-4 ${c.label}`, ok: false, measured: error.message })
    }
  }
  return out
}

/**
 * §9.1, THE ONLY IMPLEMENTATION — run at BOTH coordinates, every width, every run (#684).
 *
 * > "The identity block plus every column that is REQUIRED for this row's product type must fit
 * >  without horizontal scroll at 1440."
 *
 * 🔴 THE BAND, NOT THE BOX. A required column is visible when it lies inside the SCROLLABLE CENTRE
 * BAND — the grid root minus the pinned-left section minus the pinned-right section. Comparing
 * against the root box (what §9.1 did until today) counts a column sitting underneath a pinned
 * column as visible. Master has no right-pinned band, so that error was invisible for the whole life
 * of this check; Amazon·IT pins an `actions` column (120px when this was found, 56px since #690 —
 * the band is READ FROM THE DOM, so only this sentence needed the number) and the same code
 * over-counted there.
 *
 * 🔴 THE SELECTORS ARE THIS BUILD'S, NOT AG's. The pinned sections are `.ag-grid-pinned-left-cells`
 * / `.ag-grid-pinned-right-cells` — the GDS names. I wrote AG's stock `.ag-pinned-left-header` first
 * and every arm returned the same answer, which is the tell that the confound is in the instrument
 * and not in the subject: a probe that cannot see the thing it subtracts reports a uniform verdict.
 * `nL === 0` therefore ABSTAINS: master carries a 389px pinned-left band on this build, so "no
 * pinned section found" means the selector has rotted, never that the sheet stopped pinning.
 *
 * 🔴 THE MODEL IS STITCHED, AND THE STITCH IS CONTROLLED. AG virtualises columns, so one read at
 * scrollLeft 0 sees only the rendered range and a required column beyond it has no position at all —
 * which is enough for the fit VERDICT but not for the SHORTFALL, the number that says how much too
 * narrow the band is. The model is merged across a wheel-scrolled sweep and then checked for
 * arithmetic closure: `pinnedLeft + Σ(centre widths) + pinnedRight === root.scrollWidth`. If it does
 * not close, the sweep missed columns and the verdict ABSTAINS rather than under-reporting.
 *
 * What this does to the page: navigation and a horizontal wheel over the grid body — the same
 * gesture `checkRightEdgePopup` already makes. No click, no key, no cell editor, so no write path is
 * touched (the rule from `reference_probe_safety_is_not_a_loan_from_the_page`: ask what a probe
 * DOES, not what it measures).
 */
async function measureRequiredFit(browser, vpSize, scope, REQ) {
  const at = new Date().toTimeString().slice(0, 8)
  const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: vpSize.w, height: vpSize.h } }).catch(async error => { await browser.close(); console.error(error.message); process.exit(2) })
  page.on('request', (r) => {
    try { const u = new URL(r.url()); if (/\/api\//.test(u.pathname)) apiOrigins.add(u.origin) } catch { /* data: and blob: URLs */ }
  })
  // loadavg lives INSIDE the reading, never beside it: a duration or a geometry quoted without the
  // load it was taken under is a number whose conditions cannot be recovered later.
  const load = () => loadavg().map((n) => n.toFixed(2)).join('/')
  const base = { sec: '§9.1', vp: `${vpSize.w}×${vpSize.h}`, scope: scope.label, required: REQ, at, loadStart: load() }
  const read = () => page.evaluate(() => {
    const R = (el) => { const b = el.getBoundingClientRect(); return { x: Math.round(b.x), w: Math.round(b.width) } }
    const root = document.querySelector('.ag-grid-viewport.ag-layout-normal')
    if (!root) return { ABORT: 'no .ag-grid-viewport.ag-layout-normal' }
    const rb = R(root), S = root.scrollLeft
    const Ls = [...document.querySelectorAll('.ag-grid-pinned-left-cells')]
    const Rs = [...document.querySelectorAll('.ag-grid-pinned-right-cells')]
    const bandW = (els) => (els.length ? Math.max(...els.map((e) => R(e).w)) : 0)
    const cells = []
    document.querySelectorAll('.ag-header-cell').forEach((h) => {
      const id = h.getAttribute('col-id'); if (!id) return
      const sec = h.closest('.ag-grid-pinned-left-cells') ? 'L' : h.closest('.ag-grid-pinned-right-cells') ? 'R' : 'C'
      const b = R(h)
      cells.push({ id, sec, w: b.w, abs: sec === 'C' ? b.x - rb.x + S : b.x - rb.x })
    })
    return { rootW: rb.w, S, nL: Ls.length, nR: Rs.length, PL: bandW(Ls), PR: bandW(Rs),
      scrollWidth: root.scrollWidth, clientWidth: root.clientWidth, cells,
      chip: document.querySelector('.nds-scope.on')?.getAttribute('data-scope-id') ?? null,
      chipLabel: (document.querySelector('.nds-scope.on .nds-scope-label')?.textContent ?? '').trim() }
  })

  try {
    await page.goto(scope.url, { waitUntil: 'domcontentloaded' })
    const rows = await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
    if (!rows) return { ...base, ok: null, measured: `NOT MEASURED — no rows rendered within ${ROWS_MS}ms [${base.at}→${new Date().toTimeString().slice(0, 8)}] at load ${load()}`, disturbed: true }
    // Same settle rule as the main loop: rows existing is not the geometry settling — the channel
    // sheet reads 15,664px wide before its default view lands and 2,914 after.
    await page.evaluate(() => { window.__uxLast = null; window.__uxStable = 0 })
    const settled = await page.waitForFunction(() => {
      const v = document.querySelector('.ag-grid-viewport.ag-layout-normal'); if (!v) return false
      const now = `${v.scrollWidth}x${v.clientHeight}x${document.querySelectorAll('.ag-row').length}`
      if (window.__uxLast === now) window.__uxStable = (window.__uxStable || 0) + 1
      else { window.__uxLast = now; window.__uxStable = 0 }
      return window.__uxStable >= 3
    }, null, { timeout: 20000, polling: 250 }).then(() => true).catch(() => false)
    if (!settled) return { ...base, ok: null, measured: `NOT MEASURED — geometry never settled within 20s [${base.at}→${new Date().toTimeString().slice(0, 8)}] at load ${load()}`, disturbed: true }

    const first = await read()
    if (first.ABORT) return { ...base, ok: null, measured: `NOT MEASURED — ${first.ABORT}` }
    // 🔴 A SCOPE THAT FELL BACK IS NOT THE SCOPE YOU ASKED FOR. The studio silently resolves an
    // unknown/unserved scope to master (`contracts.tsx` deriveScope), and a master payload measured
    // under a channel label is the plausible wrong answer #483 refused at the API for the same
    // reason. Assert the lit chip, and say what landed.
    if (first.chip !== scope.want) {
      return { ...base, ok: null, measured: `NOT MEASURED — asked for scope "${scope.want}", the lit chip is "${first.chip}" (${first.chipLabel || 'no label'}). The studio falls back to master for a scope this market does not serve, so this would have been a MASTER reading wearing a channel label.` }
    }
    if (first.nL === 0) {
      return { ...base, ok: false, measured: `PROBE DEFECT, not a build defect — \`.ag-grid-pinned-left-cells\` matched nothing. Master carries a 389px pinned-left band on this build, so zero matches means the selector has rotted; without the pinned bands this check silently reverts to the root-box rule that was wrong on the channel. Fix the selector before reading anything below.` }
    }

    // Stitch: wheel right until scrollLeft stops moving, merging each read.
    const model = new Map(first.cells.map((c) => [c.id, c]))
    const box = await page.locator('.ag-grid-viewport.ag-layout-normal').boundingBox()
    if (box) {
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      let lastS = -1
      for (let i = 0; i < 60; i++) {
        await page.mouse.wheel(400, 0)
        await page.waitForTimeout(50)
        const r = await read()
        if (r.ABORT) break
        r.cells.forEach((c) => { if (!model.has(c.id)) model.set(c.id, c) })
        if (r.S === lastS) break
        lastS = r.S
      }
    }
    const cols = [...model.values()]
    const centre = cols.filter((c) => c.sec === 'C').sort((a, b) => a.abs - b.abs)
    const pinnedL = cols.filter((c) => c.sec === 'L').sort((a, b) => a.abs - b.abs)
    const pinnedR = cols.filter((c) => c.sec === 'R').sort((a, b) => a.abs - b.abs)
    const sumC = centre.reduce((n, c) => n + c.w, 0)
    const closure = first.PL + sumC + first.PR
    /*
     * 🔴 THE CLOSURE CONTROL ONLY WORKS ON A GRID THAT OVERFLOWS — found by pointing this at eBay·IT.
     *
     * `scrollWidth` is `max(content, client)`. When the columns are NARROWER than the viewport the
     * grid does not scroll, `scrollWidth` is pinned to `clientWidth`, and comparing the column sum
     * against it reports a shortfall that is the EMPTY SPACE TO THE RIGHT, not a missed column.
     * eBay·IT totals 1223px: at 1280 (client 1212) it overflows and the control closed exactly; at
     * 1440 and 1728 it does not, and the control abstained with "the sweep missed columns — 149px /
     * 437px unaccounted", which is the viewport minus the content and nothing to do with the sweep.
     *
     * The abstain was the right FAILURE MODE — it refused to publish a fit count rather than
     * under-reporting one — but it was a false alarm, and a control that cries wolf on every
     * narrow grid is one a reader learns to wave through. So: when the grid overflows, the sum must
     * equal `scrollWidth` exactly; when it does not, `scrollWidth` cannot testify and the test is
     * that the sum FITS inside the client width.
     */
    const overflows = first.scrollWidth > first.clientWidth
    const closes = overflows ? closure === first.scrollWidth : closure <= first.clientWidth
    const bandL = first.PL, bandR = first.rootW - first.PR
    const verdict = REQ.map((id) => {
      const c = model.get(id)
      if (!c) return { id, state: 'NOT FOUND even after scrolling the full width' }
      if (c.sec !== 'C') return { id, state: `pinned-${c.sec} (always visible)`, abs: c.abs, w: c.w }
      const fits = c.abs >= bandL - 1 && c.abs + c.w <= bandR + 1
      return { id, state: fits ? 'fits' : 'covered', abs: c.abs, w: c.w, over: c.abs + c.w - bandR }
    })
    const fits = verdict.filter((v) => v.state === 'fits' || v.state.startsWith('pinned')).length
    const placed = verdict.filter((v) => v.abs != null)
    const last = placed.length ? placed.reduce((a, v) => (a.abs + a.w > v.abs + v.w ? a : v)) : null
    const shortfall = last ? last.abs + last.w - bandR : null
    const detail = {
      ...base, loadEnd: load(),
      rootW: first.rootW, PL: first.PL, PR: first.PR, band: bandR - bandL, bandL, bandR,
      scrollWidth: first.scrollWidth, clientWidth: first.clientWidth, overflows, closure, closes,
      pinnedLeft: pinnedL.map((c) => `${c.id}(${c.w})`), pinnedRight: pinnedR.map((c) => `${c.id}(${c.w})`),
      centre: centre.map((c) => ({ id: c.id, abs: c.abs, w: c.w })),
      verdict, fits, shortfall,
    }
    if (!closes) {
      return { ...detail, ok: null, measured: `NOT MEASURED — the stitched column model does not close: pinnedLeft ${first.PL} + centre ${sumC} + pinnedRight ${first.PR} = ${closure} against ${overflows ? `root scrollWidth ${first.scrollWidth}` : `a client width of ${first.clientWidth} on a grid that does NOT overflow`} (${Math.abs((overflows ? first.scrollWidth : first.clientWidth) - closure)}px unaccounted). The sweep missed columns, so a fit count here would UNDER-report.` }
    }
    /*
     * 🔴 THE CLOCK, NOT JUST THE LOAD. The hub voids readings by WALL-CLOCK WINDOW when the API
     * restarts ("void 14:29:50–14:32:10"), and this suite's own record run spanned one such window
     * while printing only `load` — so not one row could be checked against it and the whole run had
     * to be treated as suspect. The time was already captured in the reading and dropped at the last
     * step, which is the `writes []` shape again: a field that exists and never reaches the reader
     * is not a field.
     */
    return { ...detail, ok: fits === REQ.length, nRequired: REQ.length,
      measured: `[${base.at}→${new Date().toTimeString().slice(0, 8)}] ${fits} of ${REQ.length} required columns inside the ${bandR - bandL}px centre band ` +
        `(root ${first.rootW} − pinned-left ${first.PL} − pinned-right ${first.PR})` +
        (shortfall != null ? ` · shortfall ${shortfall > 0 ? `+${shortfall}px` : `${-shortfall}px SPARE`}` : '') +
        (verdict.some((v) => v.state === 'covered') ? ` · covered: ${verdict.filter((v) => v.state === 'covered').map((v) => `${v.id} +${v.over}`).join(', ')}` : '') +
        ` · load ${base.loadStart}→${load()}` }
  } catch (e) {
    return { ...base, ok: null, measured: `NOT MEASURED — ${String(e.message).split('\n')[0]}` }
  } finally {
    await page.close()
  }
}

const ALL_VIEWPORTS = [{ w: 1728, h: 906 }, { w: 1440, h: 900 }, { w: 1280, h: 900 }]
/* `LAYOUT_VIEWPORTS=1280` narrows the run to one width — for a re-measure of a defect that lives at
 * one width only. Same rule as LAYOUT_ONLY: an unrecognised width REFUSES rather than quietly
 * running all three, and the narrowing is announced. */
const VIEWPORTS = (() => {
  const want = (process.env.LAYOUT_VIEWPORTS ?? '').split(',').map((x) => x.trim()).filter(Boolean)
  if (!want.length) return ALL_VIEWPORTS
  const picked = want.map((w) => {
    const v = ALL_VIEWPORTS.find((x) => String(x.w) === w)
    if (!v) { console.error(`❌ LAYOUT_VIEWPORTS="${w}" is not one of ${ALL_VIEWPORTS.map((x) => x.w).join(', ')}. Refusing.`); process.exit(2) }
    return v
  })
  console.log(`\n🔎 NARROWED TO ${picked.map((v) => `${v.w}×${v.h}`).join(', ')} — the other widths are UNRUN, not passing.`)
  return picked
})()
const failures = []
// 🔴 A RUN THAT LOST A STATE IS NOT A RUN WHOSE OTHER NUMBERS ARE SAFE TO QUOTE. On 2026-09-02 a run
// reported "1728 drawer closed: NOT MEASURED — no rows rendered within 30s" AND a URL-path reveal
// regression. I footnoted the first and quoted the second to the owning lane; the regression did not
// reproduce, and they spent a fix on it. Nothing in the SHAPE of a results table says "this run was
// disturbed", so the disturbance had to be carried by the person reading it — and was not.
// PES.4's suggestion, taken: the harness marks it, so the discipline stops depending on memory.
const disturbances = []
// W-1 / W-2 run first: if the contract disagrees with itself, the layout readings below are
// measuring a set the sheet does not have.
const API = process.env.LAYOUT_API ?? 'http://127.0.0.1:8091'
console.log(`\n── contract witnesses (SC.1's W-1/W-2) · ${API}`)
for (const r of await checkContract(API, PRODUCT)) {
  if (r.ok === null) { console.log(`   ·  ${r.id}: ${r.measured}`); continue }
  console.log(`   ${r.ok ? '✅' : '❌'} ${r.id}: ${r.measured}`)
  if (!r.ok) failures.push(`${r.id}: ${r.measured}`)
}

const browser = await chromium.launch()
let measured = 0
/** Every §9.1 reading of the run, keyed `<width>|<scope key>`, for the side-by-side below. */
const fitReadings = new Map()
/**
 * 🔴 WHICH BACKEND IS THE PAGE ACTUALLY TALKING TO?
 *
 * `backend-url.ts` falls back to the DEPLOYED Railway API when `NEXT_PUBLIC_API_URL` is unset, so a
 * web server started with a bare `npm run dev` serves a studio that reads PRODUCTION — and every
 * number this suite prints would describe a different database while looking entirely normal. PES.2
 * hit exactly that for ~10 minutes on 2026-09-03. This suite reads the API directly for W-1/W-4, so
 * those stay honest; the BROWSER's own calls are the blind spot, and nothing here was watching them.
 * Collect every API origin the page dials and refuse the run if it is not the one we think.
 */
const apiOrigins = new Set()
/*
 * 🔴 COMPARE THE HOST, NOT THE SPELLING. The first version compared `origin` STRINGS and failed a
 * clean run: the page dials `localhost:8091` while LAYOUT_API is `127.0.0.1:8091` — one listener,
 * two names. A guard that reds on every good run is one a reader learns to wave through, and it is
 * the same "an identifier's FORM is not an identity" trap that produced a ::ffff:127.0.0.1 / ::1
 * false alarm between two lanes tonight. Loopback aliases are ONE host; a genuinely different host
 * (a deployed Railway domain) is the thing this check exists to catch.
 */
const LOOPBACK = new Set(['localhost','127.0.0.1','::1','[::1]','0.0.0.0'])
const hostKey = (u) => { try { const x = new URL(u); return `${LOOPBACK.has(x.hostname) ? 'loopback' : x.hostname}:${x.port}` } catch { return null } }
const expectedApiOrigin = hostKey(API)
/** Measured below-bar residuals, for the proposed-floor block at the end. */
const residualSeen = []
const stampAtStart = stampOf()
sampleStamp('run start')

if (FOCUSED) {
  console.log(`\n🔎 FOCUSED RUN — \`LAYOUT_ONLY=${ONLY}\`. ONLY ${FOCUS_91 ? '§9.1 (four coordinates × three widths) and its pinned-band readings' : '§5.4 (the reveal, verb path and URL path)'} runs.`)
  console.log(`   NOT RUN, and therefore NOT PASSING — these are UNRUN, not green:`)
  for (const b of SKIPPED_BLOCKS) console.log(`     · ${b}`)
  console.log(`   Do not quote this run as a suite pass. Use it for the §9.1 matrix inside a held write window.`)
  // 🔴 The first version of this flag printed the banner and gated NOTHING — every block above ran
  // while the header said they had not, which is a label asserting a property the code lacks. It was
  // caught only by counting the output lines afterwards, so the count is now the run's own check.
  process.on('exit', () => {
    if (focusRan.length) console.error(`\n🔴 FOCUS BROKEN — these blocks ran despite LAYOUT_ONLY=9.1: ${[...new Set(focusRan)].join(', ')}. The banner above is FALSE for this run; do not trust its skip list.`)
  })
}
if (!stampPrinted) { buildStamp(); stampPrinted = true }
for (const vpSize of VIEWPORTS) {
  const page = await authenticatedStudioPage(browser, { base: BASE, viewport: { width: vpSize.w, height: vpSize.h } }).catch(async error => { await browser.close(); console.error(error.message); process.exit(2) })
  // 🔴 TENTH TRAP — AN EMPTY FIELD THAT COULD NEVER BE NON-EMPTY. The verb-path reveal reported
  // `writes []` at every width and I relayed that to another lane as excluding a hypothesis. The
  // interceptor that fills `__revealWrites` was installed by `addInitScript` on a page created
  // INSIDE the URL-path check; this page never had it, so the field was empty BY CONSTRUCTION.
  // Trap 2 of this file's own header, committed in the act of adding a new field, one message after
  // calling the field "free". Install it here, and see `revealWritesUsable` below — the field now
  // ABSTAINS unless the interceptor is proven present.
  await page.addInitScript(() => {
    window.__revealWrites = []
    window.__revealHookInstalled = false
    const proto = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollLeft')
    const install = () => {
      const el = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      if (!el) return false
      Object.defineProperty(el, 'scrollLeft', { configurable: true,
        get() { return proto.get.call(this) },
        set(v) { window.__revealWrites.push({ v: Math.round(v), t: Math.round(performance.now()) }); proto.set.call(this, v) } })
      window.__revealHookInstalled = true
      return true
    }
    const iv = setInterval(() => { if (install()) clearInterval(iv) }, 100)
    setTimeout(() => clearInterval(iv), 30000)
  })

  // The drawer pass needs a real row id, so it is discovered from the first load rather than
  // hard-coded — a hard-coded child id rots the moment the fixture family changes.
  let closedCols = null
  let closedVpWidth = null
  const states = [{ label: 'drawer closed', url: STUDIO }]
  if (!FOCUSED) {
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
    const rowId = await page.waitForFunction(() => {
      const r = document.querySelector('.ag-row[row-id]')
      return r ? r.getAttribute('row-id') : null
    }, null, { timeout: 30000 }).then((h) => h.jsonValue()).catch(() => null)
    if (rowId) // 🔴 `&`, not `?`. STUDIO carries the pinned coordinate (`?market=…&locale=…`), so a second `?`
    // made `rec` part of the locale value — the drawer never opened, and §5's five assertions
    // abstained for hours as "no dock at probe time". **The abstain was honest and pointed at the
    // wrong cause: the dock was absent because my URL was malformed, not because it mounts late.**
    // Introduced by me when I pinned the coordinate into STUDIO; the abstain is what kept it from
    // reading as five silent passes.
    states.push({ label: 'drawer open', url: `${STUDIO}&rec=${encodeURIComponent(rowId)}` })
    else console.warn(`⚠️  ${vpSize.w}×${vpSize.h}: no row id found — the §5 drawer assertions are NOT MEASURED at this viewport.`)
  }

  for (const { label, url } of (FOCUSED ? [] : states)) {
    focusGuard('band+chrome probe')
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    // Wait for RENDERED ROWS, not for networkidle: one hung request would hold networkidle forever,
    // and a header without a column model is the skeleton this script refuses to measure.
    // `LAYOUT_ROWS_MS` exists so the disturbance branch can be PROVEN reachable on a real page
    // (`LAYOUT_ROWS_MS=1 npm run layout:v2`). A red branch nobody has seen fire is not a red branch.
    const ok = await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
    if (!ok) {
      const t = new Date().toTimeString().slice(0, 8)
      failures.push(`${vpSize.w}×${vpSize.h} ${label}: NOT MEASURED — no rows rendered within ${ROWS_MS}ms (at ${t})`)
      disturbances.push(`${vpSize.w}×${vpSize.h} ${label} — no rows rendered within ${ROWS_MS}ms (at ${t})`)
      continue
    }

    // 🔴 ROWS EXISTING IS NOT THE GEOMETRY SETTLING. Sheets apply their default column view ONCE,
    // in an effect that runs AFTER the first rows render. Measuring on the first row painted caught
    // the channel sheet at 15,664px when it settles to 2,914 within 500ms — and I filed that
    // 15,664 as "PES.3's landing didn't take". Third transient this script has read as a fact.
    // Wait for scrollWidth AND clientHeight to hold steady across consecutive samples.
    const settled = await page.waitForFunction(() => {
      const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
      if (!v) return false
      const now = `${v.scrollWidth}x${v.clientHeight}x${document.querySelectorAll('.ag-row').length}`
      const w = window
      if (w.__uxLast === now) { w.__uxStable = (w.__uxStable || 0) + 1 } else { w.__uxLast = now; w.__uxStable = 0 }
      return w.__uxStable >= 3
    }, null, { timeout: 20000, polling: 250 }).then(() => true).catch(() => false)
    if (!settled) { const t = new Date().toTimeString().slice(0, 8); failures.push(`${vpSize.w}×${vpSize.h} ${label}: NOT MEASURED — grid geometry never settled within 20s (at ${t})`); disturbances.push(`${vpSize.w}×${vpSize.h} ${label} — geometry never settled within 20s (at ${t})`); continue }

    // The drawer mounts AFTER the grid settles, so waiting on the grid is not waiting on the dock.
    if (label === 'drawer open') {
      const docked = await page.waitForSelector('.nds-drawer-dock', { timeout: 8000 }).then(() => true).catch(() => false)
      if (docked) await page.waitForTimeout(300)
      else console.log(`   ·  §5 @ ${vpSize.w}×${vpSize.h}: drawer never mounted within 8s of the grid settling — §5 abstains`)
    }
    const out = await page.evaluate(probe, { BANDS, closedVpWidth })
    if (out.ABORT) { failures.push(`${vpSize.w}×${vpSize.h} ${label}: NOT MEASURED — ${out.ABORT}`); continue }
    measured++
    if (label === 'drawer closed') { closedCols = out.colIds; closedVpWidth = out.vpWidth }
    console.log(`\n── ${out.viewport} · ${label} · ${out.rows} rows @ ${out.rowH}px · header ${out.collapsed ? 'collapsed' : 'at rest'}`)
    for (const c of out.checks) {
      if (c.ok === null) { console.log(`   ·  ${c.sec} ${c.id}: ${c.measured}${c.note ? `\n        ${c.note}` : ''}`); continue }
      console.log(`   ${c.ok ? '✅' : '❌'} ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}`)
      if (c.note) console.log(`        ${c.note}`)
      if (!c.ok) failures.push(`${out.viewport} ${label} — ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}${c.note ? ` · ${c.note}` : ''}`)
    }
  }
  /*
   * §9.1 AT BOTH COORDINATES (#684). Master OUTERWEAR and Amazon·IT, every width, every run.
   *
   * Drawer CLOSED only. §9.1 is a statement about the sheet an operator arrives at; with a record
   * open §5.4 governs what is reachable, and the drawer-open §9.1 reading this suite used to take
   * was noise — it failed whenever §5.3 failed, and dragged three extra rows into the failure list
   * for one defect.
   */
  for (const sc of (FOCUS_54 || FOCUS_VP || FOCUS_MX ? [] : SCOPES)) {
    const { keys: REQ, why: reqWhy } = await requiredFor(sc)
    if (!REQ?.length) {
      const message = `${vpSize.w}×${vpSize.h} ${sc.label}: required fit NOT MEASURED — ${reqWhy ?? 'no required keys'}; no fallback denominator`
      console.error(message)
      failures.push(message)
      continue
    }
    const sameLegacySet = sameRequiredSet(REQ, LEGACY_REQUIRED)
    const r = await measureRequiredFit(browser, vpSize, sc, REQ)
    fitReadings.set(`${vpSize.w}|${sc.key}`, r)
    const head = `${r.sec} required-columns-fit @ ${r.vp} · ${r.scope}`
    if (r.ok === null) {
      console.log(`   ·  ${head}: ${r.measured}`)
      if (r.disturbed) disturbances.push(`${r.vp} ${r.scope} — ${r.measured}`)
      if (vpSize.w >= D11_BAR_PX) failures.push(`${head}: ${r.measured}`)
      continue
    }
    measured++
    /*
     * 🔴 "BELOW THE BAR" IS DECIDED BY THE BAR, NOT BY HAVING A BASELINE ENTRY.
     *
     * This read `const ruled = … RULED_RESIDUAL[w]?.[key]` and then `asserts = !ruled`, so a
     * coordinate with no entry in the map ASSERTED at 1280 — meaning the day someone adds a fourth
     * coordinate (as I just did), the suite quietly starts asserting D11 at a width the hub ruled is
     * not D11's bar, and the person who added it gets a red they did not cause. **A rule implemented
     * through the presence of a lookup silently changes meaning when the lookup grows.** The bar
     * decides; a missing floor means "not ratcheted yet", never "assert here".
     */
    const belowBar = vpSize.w < D11_BAR_PX
    const ruled = belowBar && sameLegacySet ? RULED_RESIDUAL[vpSize.w]?.[sc.key] : null
    const asserts = !belowBar
    if (asserts) console.log(`   ${r.ok ? '✅' : '❌'} ${head}: ${r.measured}`)
    else console.log(`   📌 ${head}: ${r.measured}\n        RECORDED below the ${D11_BAR_PX}px bar; ${ruled ? `legacy residual ${ruled.fits}/${REQ.length} at +${ruled.shortfall}px` : `no comparable ruled residual for these ${REQ.length} required keys`}`)
    // 🔴 THE SET, BESIDE THE VERDICT. The default view admits readiness-`flagged` keys and the
    // family's variation axes, so the column SET is partly a function of the DATA — and this
    // fixture is written by several lanes. Two §9.1 numbers taken on one build are not comparable
    // unless each carries the set it was taken over; #679's channel reading could not be
    // reproduced and this line is why that took a hunt instead of a glance.
    console.log(`        pinned L ${r.PL}px [${r.pinnedLeft.join(' ') || '—'}] · pinned R ${r.PR}px [${r.pinnedRight.join(' ') || '—'}] · centre band ${r.band}px · scrollWidth ${r.scrollWidth}`)
    console.log(`        centre set (${r.centre.length}): ${r.centre.map((c) => `${c.id}(${c.w})`).join(' ')}`)
    if (asserts) {
      if (!r.ok) failures.push(`${r.vp} ${r.scope} — §9.1 required-columns-fit: ${r.measured}`)
    } else if (ruled) {
      residualSeen.push({ w: vpSize.w, key: sc.key, fits: r.fits, shortfall: r.shortfall, ruled })
      if (r.fits < ruled.fits || r.shortfall > ruled.shortfall) {
      // The residual moved the WRONG WAY. Not a D11 failure — a regression against what was ruled.
        failures.push(`${r.vp} ${r.scope} — §9.1 RULED RESIDUAL GOT WORSE: ${r.fits}/${REQ.length} at +${r.shortfall}px against the ruled ${ruled.fits}/${REQ.length} at +${ruled.shortfall}px (#693). Not D11's bar, but a regression against the figure the hub ruled on.`)
      } else if (r.fits > ruled.fits || r.shortfall < ruled.shortfall) {
        console.log(`        ↑ IMPROVED on the ruled residual (${ruled.fits}/${REQ.length} at +${ruled.shortfall}px) — re-baseline RULED_RESIDUAL with the hub before this drifts into a floor nobody set.`)
      }
    }
  }

  // §5.4 — the reveal, and the phantom-column witness for #249's scroll pad.
  if (!FOCUS_91 && !FOCUS_VP && !FOCUS_MX) try {
    focusGuard('§5.4 reveal (verb path)')
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: 30000 })
    /*
     * 🔴 `measured` COUNTS STATES, AND ONLY §9.1 WAS COUNTING THEM. Under `LAYOUT_ONLY=5.4` the §9.1
     * block is skipped, so the counter stayed 0 and the run ended "NOTHING WAS MEASURED. A run that
     * asserts nothing is not a pass" — while six §5.4 assertions had just run and one had FAILED.
     * The summary contradicted the body, and the `measured === 0` branch exits BEFORE the failure
     * list, so the red never printed. A verdict that denies the run's own output is worse than no
     * verdict; every block that asserts must count itself.
     */
    measured++
    for (const r of await checkRevealAndPad(page, vpSize, closedCols)) {
      if (r.ok === null) { console.log(`   ·  ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`); continue }
      console.log(`   ${r.ok ? '✅' : '❌'} ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`)
      if (!r.ok) failures.push(`${r.vp} — ${r.sec} ${r.id}: ${r.measured}`)
    }
  } catch (e) {
    console.log(`   ·  §5.4 reveal @ ${vpSize.w}×${vpSize.h}: NOT MEASURED — ${e.message.split('\n')[0]}`)
  }

  // §5.4 via the URL path — the cold `?rec=&cell=` case, baselined pre-fix (#289).
  if (!FOCUS_91 && !FOCUS_VP && !FOCUS_MX) try {
    focusGuard('§5.4 reveal (URL path)')
    // Read the row id from a CLEAN sheet: the previous check leaves the page on a `?rec=` URL, and
    // at 1280 that produced `ABSTAIN — no row id` from my own navigation rather than from the page.
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('.ag-row[row-id]').length > 0, null, { timeout: 30000 }).catch(() => {})
    const rid = await page.evaluate(() => [...document.querySelectorAll('.ag-row[row-id]')][2]?.getAttribute('row-id') ?? null)
    measured++
    for (const r of await checkUrlPathReveal(browser, vpSize, rid)) {
      if (r.ok === null) { console.log(`   ·  ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`); continue }
      console.log(`   ${r.ok ? '✅' : '❌'} ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`)
      if (!r.ok) failures.push(`${r.vp} — ${r.sec} ${r.id}: ${r.measured}`)
    }
  } catch (e) {
    console.log(`   ·  §5.4 url-path @ ${vpSize.w}×${vpSize.h}: NOT MEASURED — ${e.message.split('\n')[0]}`)
  }

  // §7 for DS popovers (DS.2's three assertions) — once per viewport.
  if (!FOCUSED) try {
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: 30000 })
    focusGuard('§7 DS popovers')
    for (const r of await checkPopovers(page, vpSize)) {
      if (r.ok === null) { console.log(`   ·  §7 popover "${r.name}" @ ${vpSize.w}×${vpSize.h}: ${r.measured}`); continue }
      console.log(`   ${r.ok ? '✅' : '❌'} §7 popover "${r.name}" @ ${vpSize.w}×${vpSize.h}: ${r.measured}`)
      if (!r.ok) failures.push(`${vpSize.w}×${vpSize.h} — §7 popover "${r.name}": ${r.measured}`)
    }
  } catch (e) {
    console.log(`   ·  §7 popovers @ ${vpSize.w}×${vpSize.h}: NOT MEASURED — ${e.message.split('\n')[0]}`)
  }

  // §7 at the right edge — once per viewport, on the drawer-closed state.
  if (!FOCUSED) try {
    await page.goto(STUDIO, { waitUntil: 'domcontentloaded' })
    await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: 30000 })
    focusGuard('§7 right-edge popup')
    const r = await checkRightEdgePopup(page, vpSize)
    if (r.ok === null) console.log(`   ·  ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`)
    else {
      console.log(`   ${r.ok ? '✅' : '❌'} ${r.sec} ${r.id} @ ${r.vp}: ${r.measured}`)
      if (!r.ok) failures.push(`${r.vp} — ${r.sec} ${r.id}: ${r.measured}`)
    }
  } catch (e) {
    console.log(`   ·  §7 popup-at-right-edge @ ${vpSize.w}×${vpSize.h}: NOT MEASURED — ${e.message.split('\n')[0]}`)
  }

  /* ── VP.5: the Variants band budget, §2, at every viewport ────────────────────────────────
     Two states (shared product, and the eBay·IT projection), each measured against §2's own
     budget. `LAYOUT_ONLY` still narrows the run; this block counts itself into `measured`, because
     a block that asserts without counting is how this file once printed "NOTHING WAS MEASURED"
     over six real assertions and one real failure. */
  if (!FOCUSED || FOCUS_VP) {
    for (const st of VARIANTS_STATES) {
      /* 🔴 A PAGE THAT THREW AND A PAGE THAT IS SLOW BOTH RENDER NO ROWS. On 2026-09-11 this block
         reported "no rows within 60s" on the channel surface and I wrote it off as a lane being
         mid-edit; it was a real crash to Next's error boundary (a `valueFormatter` reading a nested
         shape the API had flattened), and only VP.4 chasing it found that out. A gate that cannot
         tell a throw from a slow load hands its reader the wrong diagnosis with the same words. */
      const thrown = []
      const failedRequests = []
      const consoleErrors = []
      const onPageError = (e) => thrown.push(String(e.message ?? e).split('\n')[0])
      /* A console error is NOT a throw: a failed resource logs one and the page is fine. Three
         buckets, three diagnoses — over-claiming toward alarm is still over-claiming. */
      const onConsole = (m) => {
        if (m.type() !== 'error') return
        const t = m.text().split('\n')[0]
        if (/Failed to load resource|net::ERR_|ERR_FAILED/i.test(t)) failedRequests.push(t)
        else consoleErrors.push(t)
      }
      page.on('pageerror', onPageError)
      page.on('console', onConsole)
      try {
        await page.goto(st.url, { waitUntil: 'domcontentloaded' })
        const ready = await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
        if (!ready) {
          const boundary = await page.evaluate(() => /Application error|client-side exception|Unhandled Runtime Error/i.test(document.body?.innerText ?? '')).catch(() => false)
          const why = thrown.length
            ? `the page THREW — ${thrown.length} uncaught error(s), first: ${thrown[0].slice(0, 160)}`
            : boundary
              ? 'the page rendered an error boundary with no error captured on this listener'
              : failedRequests.length
                ? `the page did not throw; ${failedRequests.length} REQUEST(S) FAILED, first: ${failedRequests[0].slice(0, 160)} — its data did not arrive`
                : consoleErrors.length
                  ? `no throw, no failed request, but ${consoleErrors.length} console error(s), first: ${consoleErrors[0].slice(0, 160)}`
                  : `no rows within ${ROWS_MS}ms, nothing thrown, no failed request — a slow load, or the surface is not built yet`
          const line = `${vpSize.w}×${vpSize.h} variants · ${st.label}: NOT MEASURED — ${why}`
          console.log(`   ·  §2 ${line}`)
          failures.push(line)
          continue
        }
        // A surface that rendered but threw on the way is measurable AND worth naming.
        if (thrown.length || failedRequests.length || consoleErrors.length) {
          const bits = []
          if (thrown.length) bits.push(`${thrown.length} UNCAUGHT: ${thrown[0].slice(0, 100)}`)
          if (failedRequests.length) bits.push(`${failedRequests.length} failed request(s): ${failedRequests[0].slice(0, 100)}`)
          if (consoleErrors.length) bits.push(`${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 100)}`)
          console.log(`   ·  §2 ${vpSize.w}×${vpSize.h} variants · ${st.label}: rendered · ${bits.join(' · ')}`)
        }
        // Same settling rule as the sheet: rows existing is not the geometry settling.
        await page.waitForFunction(() => {
          const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
          if (!v) return false
          const now = `${v.scrollWidth}x${v.clientHeight}x${document.querySelectorAll('.ag-row').length}`
          const w = window
          if (w.__vpLast === now) { w.__vpStable = (w.__vpStable || 0) + 1 } else { w.__vpLast = now; w.__vpStable = 0 }
          return w.__vpStable >= 3
        }, null, { timeout: 20000, polling: 250 }).catch(() => {})
        const out = await page.evaluate(variantsProbe, { B: VARIANTS_BANDS })
        if (out.ABORT) { failures.push(`${vpSize.w}×${vpSize.h} variants · ${st.label}: NOT MEASURED — ${out.ABORT}`); continue }
        measured++
        console.log(`\n── ${out.viewport} · variants · ${st.label} · ${out.rows} rows`)
        for (const c of out.checks) {
          if (c.ok === null) { console.log(`   ·  ${c.sec} ${c.id}: ${c.measured}`); continue }
          console.log(`   ${c.ok ? '✅' : '❌'} ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}`)
          if (c.note) console.log(`        ${c.note}`)
          if (!c.ok) failures.push(`${out.viewport} variants · ${st.label} — ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}`)
        }
      } catch (e) {
        const line = `${vpSize.w}×${vpSize.h} variants · ${st.label}: NOT MEASURED — ${e.message.split('\n')[0]}${thrown.length ? ` · the page also threw: ${thrown[0].slice(0, 120)}` : failedRequests.length ? ` · ${failedRequests.length} request(s) had failed` : ''}`
        console.log(`   ·  §2 ${line}`)
        failures.push(line)
      } finally {
        page.off('pageerror', onPageError)
        page.off('console', onConsole)
      }
    }
  }

  /* ── MX.P: the Matrix band budget, at every viewport ─────────────────────────────────────────
     Two states (every coordinate; Amazon·DE filtered), each measured against the Matrix's own budget.
     Counts itself into `measured`, like the variants block, for the same reason. */
  if (!FOCUSED || FOCUS_MX) {
    for (const st of MATRIX_STATES) {
      const thrown = []
      const failedRequests = []
      const consoleErrors = []
      const onPageError = (e) => thrown.push(String(e.message ?? e).split('\n')[0])
      const onConsole = (m) => {
        if (m.type() !== 'error') return
        const t = m.text().split('\n')[0]
        if (/Failed to load resource|net::ERR_|ERR_FAILED/i.test(t)) failedRequests.push(t)
        else consoleErrors.push(t)
      }
      page.on('pageerror', onPageError)
      page.on('console', onConsole)
      try {
        await page.goto(st.url, { waitUntil: 'domcontentloaded' })
        const ready = await page.waitForFunction(() => document.querySelectorAll('.ag-row').length > 0, null, { timeout: ROWS_MS }).then(() => true).catch(() => false)
        if (!ready) {
          const boundary = await page.evaluate(() => /Application error|client-side exception|Unhandled Runtime Error/i.test(document.body?.innerText ?? '')).catch(() => false)
          const why = thrown.length ? `the page THREW — ${thrown.length} uncaught error(s), first: ${thrown[0].slice(0, 160)}`
            : boundary ? 'the page rendered an error boundary with no error captured on this listener'
              : failedRequests.length ? `the page did not throw; ${failedRequests.length} REQUEST(S) FAILED, first: ${failedRequests[0].slice(0, 160)} — its data did not arrive`
                : consoleErrors.length ? `no throw, no failed request, but ${consoleErrors.length} console error(s), first: ${consoleErrors[0].slice(0, 160)}`
                  : `no rows within ${ROWS_MS}ms, nothing thrown, no failed request — a slow load, or the surface is not built yet`
          const line = `${vpSize.w}×${vpSize.h} matrix · ${st.label}: NOT MEASURED — ${why}`
          console.log(`   ·  MX ${line}`)
          failures.push(line)
          continue
        }
        if (thrown.length || failedRequests.length || consoleErrors.length) {
          const bits = []
          if (thrown.length) bits.push(`${thrown.length} UNCAUGHT: ${thrown[0].slice(0, 100)}`)
          if (failedRequests.length) bits.push(`${failedRequests.length} failed request(s): ${failedRequests[0].slice(0, 100)}`)
          if (consoleErrors.length) bits.push(`${consoleErrors.length} console error(s): ${consoleErrors[0].slice(0, 100)}`)
          console.log(`   ·  MX ${vpSize.w}×${vpSize.h} matrix · ${st.label}: rendered · ${bits.join(' · ')}`)
        }
        await page.waitForFunction(() => {
          const v = document.querySelector('.ag-grid-viewport.ag-layout-normal')
          if (!v) return false
          const now = `${v.scrollWidth}x${v.clientHeight}x${document.querySelectorAll('.ag-row').length}`
          const w = window
          if (w.__mxLast === now) { w.__mxStable = (w.__mxStable || 0) + 1 } else { w.__mxLast = now; w.__mxStable = 0 }
          return w.__mxStable >= 3
        }, null, { timeout: 20000, polling: 250 }).catch(() => {})
        const out = await page.evaluate(matrixProbe, { B: MATRIX_BANDS })
        if (out.ABORT) { failures.push(`${vpSize.w}×${vpSize.h} matrix · ${st.label}: NOT MEASURED — ${out.ABORT}`); continue }
        measured++
        console.log(`\n── ${out.viewport} · matrix · ${st.label} · ${out.rows} rows`)
        for (const c of out.checks) {
          if (c.ok === null) { console.log(`   ·  ${c.sec} ${c.id}: ${c.measured}`); continue }
          console.log(`   ${c.ok ? '✅' : '❌'} ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}`)
          if (c.note) console.log(`        ${c.note}`)
          if (!c.ok) failures.push(`${out.viewport} matrix · ${st.label} — ${c.sec} ${c.id}: expected ${c.expected}, measured ${c.measured}`)
        }
      } catch (e) {
        const line = `${vpSize.w}×${vpSize.h} matrix · ${st.label}: NOT MEASURED — ${e.message.split('\n')[0]}`
        console.log(`   ·  MX ${line}`)
        failures.push(line)
      } finally {
        page.off('pageerror', onPageError)
        page.off('console', onConsole)
      }
    }
  }

  await page.close()
  sampleStamp(`after the ${vpSize.w}×${vpSize.h} block`)
}
await browser.close()
sampleStamp('run end')

/*
 * THE SIDE-BY-SIDE (#679/#684). Both scopes at one width, from ONE instrument in one run — which is
 * what makes the comparison a comparison. Printed as the DIFFERENCE, because the identical rows are
 * not the finding: the required block is the same seven keys at the same seven widths on both
 * scopes, and every px of divergence is therefore in what surrounds it.
 */
const sideBySide = (w, ka, kb, note) => {
  const a = fitReadings.get(`${w}|${ka}`), b = fitReadings.get(`${w}|${kb}`)
  if (!a || !b || a.ok === null || b.ok === null) {
    console.log(`\n·  §9.1 side-by-side @ ${w} (${ka} vs ${kb}): NOT PRINTED — ${!a || a.ok === null ? ka : kb} did not measure at this width`)
    return
  }
  console.log(`\n══ §9.1 SIDE BY SIDE @ ${w} · ${a.scope} vs ${b.scope} — ${note} · load ${a.loadStart}→${b.loadEnd}`)
  const row = (k, x, y) => console.log(`   ${String(k).padEnd(34)} ${String(x).padStart(11)} ${String(y).padStart(11)}   ${typeof x === 'number' && typeof y === 'number' ? (y - x > 0 ? `+${y - x}` : `${y - x}`) : ''}`)
  row('grid root width', a.rootW, b.rootW)
  row('pinned LEFT band', a.PL, b.PL)
  row('pinned RIGHT band', a.PR, b.PR)
  row('centre band available', a.band, b.band)
  const blockOf = (r) => { const p = r.verdict.filter((v) => v.abs != null); if (!p.length) return null
    const lo = Math.min(...p.map((v) => v.abs)), hi = Math.max(...p.map((v) => v.abs + v.w)); return { lo, hi } }
  const ba = blockOf(a), bb = blockOf(b)
  if (ba && bb) {
    row('required block starts at', ba.lo, bb.lo)
    row('required block ends at', ba.hi, bb.hi)
    row('required block width', ba.hi - ba.lo, bb.hi - bb.lo)
    // What sits INSIDE the block without being required — the number §9.3b was written about.
    const intruder = (r, bl) => r.centre.filter((c) => !r.required.includes(c.id) && c.abs >= bl.lo && c.abs + c.w <= bl.hi)
    const ia = intruder(a, ba), ib = intruder(b, bb)
    row('…of which NOT required', ia.reduce((n, c) => n + c.w, 0), ib.reduce((n, c) => n + c.w, 0))
    if (ia.length || ib.length) console.log(`      ${a.scope}: ${ia.map((c) => `${c.id}(${c.w})`).join(' ') || 'none'}\n      ${b.scope}: ${ib.map((c) => `${c.id}(${c.w})`).join(' ') || 'none'}`)
  }
  row('§9.1', `${a.fits}/${a.required.length}`, `${b.fits}/${b.required.length}`)
  row('shortfall (+ = short)', a.shortfall, b.shortfall)
  console.log(`   ${'columns in one scope only'.padEnd(34)} ${[...new Set([...a.centre, ...a.pinnedLeft.map((t) => ({ id: t.split('(')[0] })), ...a.pinnedRight.map((t) => ({ id: t.split('(')[0] }))].map((c) => c.id))].filter((id) => !b.centre.some((c) => c.id === id) && !b.pinnedLeft.concat(b.pinnedRight).some((t) => t.startsWith(id + '('))).join(', ') || '—'}`)
  console.log(`   ${'…and in the other only'.padEnd(34)} ${[...new Set([...b.centre, ...b.pinnedLeft.map((t) => ({ id: t.split('(')[0] })), ...b.pinnedRight.map((t) => ({ id: t.split('(')[0] }))].map((c) => c.id))].filter((id) => !a.centre.some((c) => c.id === id) && !a.pinnedLeft.concat(a.pinnedRight).some((t) => t.startsWith(id + '('))).join(', ') || '—'}`)
}
/*
 * 🔴 A PROPOSED FLOOR, NEVER AN APPLIED ONE. When a below-bar residual differs from the ruled figure
 * the run prints the measured values in the literal shape `RULED_RESIDUAL` takes — so the hub can
 * confirm them verbatim instead of anyone transcribing three pairs of numbers out of a log. It is
 * printed, not written: the author of a ratchet does not move its own floor, and a block you can
 * paste is not the same as a block that has been pasted.
 */
if (residualSeen.some((x) => x.fits !== x.ruled.fits || x.shortfall !== x.ruled.shortfall)) {
  console.log(`\n📋 THE BELOW-BAR RESIDUAL MOVED. Measured values, in \`RULED_RESIDUAL\` shape — NOT APPLIED, for the hub to confirm:`)
  const byW = {}
  for (const x of residualSeen) (byW[x.w] ||= []).push(x)
  for (const [w, list] of Object.entries(byW)) {
    console.log(`  ${w}: {`)
    for (const x of list) console.log(`    ${/[^a-zA-Z0-9_$]/.test(x.key) ? `'${x.key}'` : x.key}: { fits: ${x.fits}, shortfall: ${x.shortfall} },${x.fits === x.ruled.fits && x.shortfall === x.ruled.shortfall ? '' : `   // was ${x.ruled.fits}/${x.ruled.shortfall}`}`)
    console.log(`  },`)
  }
  console.log(`  ⚠ Confirm these are the FINAL build's numbers — a run with a drift event or an abstain is not a baseline.`)
}

// W-5 — the page's own backend, asserted rather than assumed.
if (apiOrigins.size === 0) {
  console.log(`\n·  W-5 backend origin: NOT MEASURED — no /api/ request was seen from the page at all`)
} else {
  const foreign = [...apiOrigins].filter((o) => hostKey(o) !== expectedApiOrigin)
  if (foreign.length) {
    const msg = `W-5 backend origin: the PAGE dialled ${foreign.join(', ')} — expected only ${expectedApiOrigin}. `
      + `\`backend-url.ts\` falls back to the deployed Railway API when NEXT_PUBLIC_API_URL is unset, so these numbers `
      + `may describe a DIFFERENT DATABASE. Restart web as: cd apps/web && NEXT_PUBLIC_API_URL=${API} npm run dev`
    console.error(`\n   ❌ ${msg}`)
    failures.push(msg)
  } else {
    console.log(`\n   ✅ W-5 backend origin: the page dialled only ${[...apiOrigins].join(', ')} — same host:port as LAYOUT_API (${API}); loopback aliases counted as one host`)
  }
}

for (const v of VIEWPORTS) {
  sideBySide(v.w, 'master-at-channel-market', 'channel', 'MARKET HELD FIXED, scope varies — the controlled pair')
  sideBySide(v.w, 'master', 'channel', 'the historical baseline: scope AND market both vary, so a difference here names neither')
}

/*
 * 🔴 THE STAMP AGAIN, AT THE END. An mtime read once at the top says what the build was when the run
 * STARTED. This tree has several lanes saving into it, and a file that moves mid-run invalidates
 * every number taken after it while the header still shows the old, reassuring stamp. SC.1 stamps
 * before and after for the same reason; #684 is the run that needed it, because MasterSheet.tsx
 * moved at 13:55:05 between one reading and the next.
 */
/*
 * `LAYOUT_SELFTEST_STAMP=1` forces the comparison to differ, so the banner below can be SEEN to
 * fire on a real run. A branch nobody has watched fail is not a branch that has been shown to work —
 * the same reason `LAYOUT_ROWS_MS=1` exists for the disturbance path.
 */
/*
 * 🔴 THE SELF-TEST MUST NOT MASK THE THING IT TESTS. The first version was
 * `if (SELFTEST || stampOf() !== stampAtStart)`, so a forced run and a real drift printed the same
 * line and the real signal could not be recovered — and that bit immediately: PES.3 landed #690
 * while a `LAYOUT_SELFTEST_STAMP=1` run was in flight, and its output could not say whether the
 * build had moved under it. The two conditions are now evaluated and reported SEPARATELY.
 */
const stampDrifted = stampOf() !== stampAtStart
const stampSelfTest = process.env.LAYOUT_SELFTEST_STAMP === '1'
if (stampSelfTest) {
  console.error(`\n🧪 LAYOUT_SELFTEST_STAMP=1 — forcing the build-drift branch. Real drift on this run: ${stampDrifted ? 'YES, THE BUILD ALSO MOVED — the banner below is BOTH' : 'no, the stamp is unchanged; the banner below is the self-test alone'}.`)
}
for (const m of stampSamples) {
  console.error(`\n🔶 BUILD MOVED between ${m.since} and ${m.at} (${m.where}) — every reading TIMESTAMPED AFTER ${m.at} is on the new build, every one before ${m.since} is on the old:`)
  for (const f of m.moved) console.error(`   ! ${f}`)
  disturbances.push(`build moved ${m.since}→${m.at} (${m.where}): ${m.moved.map((f) => f.split('/').pop()).join(', ')} — compare each row's [hh:mm:ss] against that interval before discarding it`)
}
if (stampSelfTest || (stampDrifted && !stampSamples.length)) {
  disturbances.push(stampDrifted
    ? 'a file on the BUILD STAMP path changed DURING this run — the stamp printed at the top is not the build every number below was taken on'
    : 'LAYOUT_SELFTEST_STAMP=1 forced this notice; the build did NOT move (self-test only — do not read this as a real disturbance)')
  console.error(`\n🔶 BUILD MOVED DURING THIS RUN. Stamp now:`)
  buildStamp()
}

/*
 * 🔴 THE NOTICE PRINTS FIRST, ON EVERY EXIT PATH. Two defects lived here and both were found by
 * running the thing rather than reading it (2026-09-02, #684):
 *
 * 1. `suspect()` was called on the nothing-measured path and on the all-green path, and NOT on the
 *    FAILURE path — so a run that was both disturbed AND red printed its failure list with no
 *    disturbance notice. That is the worst of the three cases, because a failure list is the output
 *    that actually gets quoted to another lane. It happened on this suite's own record run: one
 *    coordinate abstained ("no rows in 30s") while four §9.1 assertions failed, and the banner that
 *    exists to stop exactly that quotation stayed silent. The banner was written after a disturbed
 *    run was quoted to a lane who spent a fix on a regression that did not reproduce — and it would
 *    not have fired for that run either.
 * 2. `const suspect` was declared INSIDE `if (measured === 0) {`, so the trailing call on the
 *    all-green path referenced a block-scoped binding: `ReferenceError: suspect is not defined`.
 *    The success path has never run to completion since. A path nobody has reached is not a path
 *    that works, and "the suite has been red for days" is why nobody noticed.
 */
const suspect = () => {
  if (!disturbances.length) return
  console.error(`\n🔶 THIS RUN WAS DISTURBED — EVERY NUMBER IN IT IS SUSPECT, INCLUDING THE PASSES.`)
  for (const d of disturbances) console.error(`   ! ${d}`)
  console.error(`   A state that never rendered means the environment moved under this run (a rebuild,`)
  console.error(`   a restart, load). Re-run before quoting ANY row of it to another lane — a green`)
  console.error(`   assertion from a disturbed run is no more trustworthy than a red one.`)
}
suspect()
if (measured === 0) {
  console.error(`\n❌ layout v2 conformance: NOTHING WAS MEASURED. A run that asserts nothing is not a pass.`)
  process.exit(1)
}
if (failures.length) {
  console.error(`\n❌ layout v2 conformance — ${failures.length} failure(s) across ${measured} measured state(s)${disturbances.length ? `, ${disturbances.length} of them DISTURBED — see the notice above before quoting any row` : ''}:`)
  for (const f of failures) console.error(`   • ${f}`)
  console.error(`\n   docs/2026-09-01-layout-v2-spec.md §11 says who owns each section.`)
  process.exit(1)
}
console.log(`\n${disturbances.length ? '🔶' : '✅'} layout v2 conformance: ${measured} state(s) measured, all assertions hold${disturbances.length ? ' — BUT SEE THE DISTURBANCE NOTICE ABOVE: do not quote these numbers without a clean re-run.' : '.'}`)
