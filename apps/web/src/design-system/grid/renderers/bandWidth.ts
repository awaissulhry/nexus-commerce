/**
 * GDS — the identity band's width, DERIVED from its content (#731).
 *
 * 🔴 It replaces a constant, and the constant was the defect. Master's band was 376 because that is
 * what the three pinned columns it replaced added up to (104 + 180 + 90 = 374); the channel's was
 * 240 because that is what its `__identity` had always been. Two scopes, two numbers, for one row
 * that #710 exists to make identical — and neither was derived from anything the row contains, so
 * removing the product name (#725) changed the layout not at all while adding the `⋯` (#724) pushed
 * SKUs into truncation. A number nobody derived cannot respond to the content changing.
 *
 * The arithmetic is here and pure; the two browser measurements it needs — the widest SKU in the
 * mono face, and the slots as actually rendered — are taken by the caller and passed in. That split
 * is deliberate: this repo's vitest has no DOM and no JSX transform, so a rule that measured its own
 * text could not be tested at all (banked, #731).
 */

/** Every fixed-width thing in the band, as RENDERED — not as declared. */
export interface BandSlots {
  /** The tree control or its alignment slot. Always present, so the SKUs share one left edge. */
  expand: number
  /** The P/C chip, or a channel's primary/alias mark. */
  role: number
  /** The thumbnail, 0 when the scope draws none. */
  thumb: number
  /** Readiness pill + any state pill, together. */
  trailing: number
  /** The `⋯` menu trigger. */
  menu: number
  /** One gap. Multiplied by the number of visible gaps. */
  gap: number
  /** The cell's own left + right padding, together. */
  padding: number
}

export const BAND_WIDTH_FLOOR = 240
export const BAND_WIDTH_CEILING = 420

/**
 * The width that lets the family's longest SKU sit unbroken beside the fixed slots.
 *
 * Clamped to `[240, 420]`. Below the ceiling nothing truncates; at the ceiling the SKU ellipsizes
 * and the full key stays available on hover — a band that grew without limit would take the width
 * §9.1 is fighting for on behalf of one long key.
 *
 * 🔴 Gaps are counted from the slots that are actually THERE. Counting a fixed number of gaps was
 * the first version and it over-reserved on any scope without a thumbnail, which is precisely the
 * "same number on both scopes" the ruling asks for — so the count follows the content.
 */
export function deriveBandWidth(longestSkuPx: number, slots: BandSlots): number {
  const boxes = [slots.expand, slots.role, slots.thumb, longestSkuPx, slots.trailing, slots.menu]
  const present = boxes.filter((w) => w > 0)
  const gaps = Math.max(0, present.length - 1) * slots.gap
  const raw = present.reduce((a, b) => a + b, 0) + gaps + slots.padding
  return Math.min(BAND_WIDTH_CEILING, Math.max(BAND_WIDTH_FLOOR, Math.ceil(raw)))
}

/** Did the derivation have to give up on showing the whole SKU? Drives the hover affordance. */
export const bandTruncatesSku = (longestSkuPx: number, slots: BandSlots): boolean =>
  deriveBandWidth(longestSkuPx, slots) === BAND_WIDTH_CEILING &&
  longestSkuPx > skuBudget(BAND_WIDTH_CEILING, slots)

/** How much room a given band width leaves for the key itself. */
export function skuBudget(width: number, slots: BandSlots): number {
  const fixed = [slots.expand, slots.role, slots.thumb, slots.trailing, slots.menu].filter((w) => w > 0)
  const gaps = fixed.length * slots.gap // one gap between the SKU and each neighbouring box
  return width - fixed.reduce((a, b) => a + b, 0) - gaps - slots.padding
}

/**
 * The band whose complement should set the column's width: one that CARRIES A KEY.
 *
 * 🔴 Not simply the first band on screen, and the difference is a real 26px (PES.3, measured). A
 * channel scope draws an alias BAND row above its variants, and that row's trail carries a status
 * pill plus readiness (130px) where a variant's carries readiness and the `⋯` (104px). Measuring
 * the first band therefore reserves trail the rows with the long keys never spend — derived 412
 * instead of 404. Master has no band row of that kind, so this is invisible there, which is exactly
 * why it belongs here rather than in each caller: it is a decision two scopes can get wrong
 * independently and only one of them can see.
 *
 * Level 0 is the group/band row; the keys live on the variants beneath it. Falls back to any band
 * for a scope that has only one row kind.
 */
export function findKeyBearingBand(root: ParentNode = document): Element | null {
  return (
    root.querySelector('.ag-row:not(.ag-row-level-0) .nds-identity-band') ??
    root.querySelector('.nds-identity-band')
  )
}

/**
 * The width this band needs for a given key, measured as the COMPLEMENT of its text box (#743).
 *
 * 🔴 This is the derivation both scopes should use, and it exists because summing named slots is
 * unfixably approximate. Two attempts got it wrong in two different ways: the first split the trail
 * into pill + menu and charged a gap the row never spends; the second counted the five real flex
 * boxes and still came out **2px short**, because the text box carries its own inset that no slot
 * list mentions. Each time the answer looked plausible and truncated keys on screen.
 *
 * `cellWidth − textWidth` is every pixel the row spends on something that is not the key —
 * expander, chip, picture, trail, gaps, cell padding, and whatever else is added later — measured
 * rather than enumerated. A slot introduced tomorrow is counted without touching this function.
 *
 * `null` when the band is not laid out (zero width, hidden tab, detached). The caller keeps its
 * previous width rather than deriving from zeros — a clamp value is what a failed measurement looks
 * like, and both clamps have now been mistaken for a real answer once each.
 */
export function deriveBandWidthFromDom(band: Element | null, longestSkuPx: number): number | null {
  if (!band) return null
  const cell = band.closest('.ag-cell')
  const text = band.querySelector('.nds-identity-band-text')
  if (!cell || !text) return null
  const cellW = cell.getBoundingClientRect().width
  const textW = text.getBoundingClientRect().width
  if (cellW === 0) return null
  const chrome = cellW - textW
  return Math.min(BAND_WIDTH_CEILING, Math.max(BAND_WIDTH_FLOOR, Math.ceil(chrome + longestSkuPx)))
}

/**
 * Read the band's fixed slots off the FIRST RENDERED BAND, once per family (#742).
 *
 * 🔴 This replaces per-scope slot CONSTANTS, and the constants were a live defect rather than an
 * inelegance. `MASTER_BAND_SLOTS` was a measurement of another component's rendering, held as a
 * number in a different file: nothing type-checked it, no test could see it, and when
 * `CompletenessPill` gained its fixed-width number slot the pill went 65.2 → 70 while the constant
 * stayed 66 — five SKUs truncated silently, in the same edit that caused it. Measuring means the
 * two scopes cannot drift either: one derivation, one set of numbers, taken from whatever each
 * scope actually drew.
 *
 * Every slot here is `flex: none`, so its width does not depend on the column's — which is what
 * makes measuring at the current width safe, and is worth checking before adding a slot that
 * stretches.
 *
 * Returns `null` when the band is not laid out yet (zero-width, detached, a hidden tab). The caller
 * keeps its previous width rather than deriving from zeros — the honest answer for "not measured".
 */
export function measureBandSlots(band: Element): BandSlots | null {
  const rect = band.getBoundingClientRect()
  if (rect.width === 0) return null
  const cs = getComputedStyle(band)
  const widthOf = (sel: string): number => {
    const el = band.querySelector(sel)
    return el ? el.getBoundingClientRect().width : 0
  }
  const cell = band.closest('.ag-cell')
  const cellCs = cell ? getComputedStyle(cell) : null
  /*
   * 🔴 The band lays out FIVE flex items — expander · role · picture · text · trail — and the `⋯`
   * lives INSIDE the trail, not beside it (PES.3, measured on both scopes: `.nds-identity-band-trail`
   * is 104 on each). Measuring the pill and the menu as two slots charged a gap the row never
   * spends and under-counted the trail; the two errors nearly cancelled, which is why 406 looked
   * right. Two wrong numbers agreeing is not one right one.
   *
   * So `trailing` is the WHOLE trail and `menu` is 0: `deriveBandWidth` counts gaps from the boxes
   * that are present, so a zero menu removes the phantom gap by itself.
   */
  return {
    expand: widthOf('.nds-cell-expand, .nds-cell-expand-slot'),
    role: widthOf('.nds-cell-chip'),
    /* The picture WRAPPER, not the `img` — it also holds the inherited-image mark. */
    thumb: widthOf('.nds-identity-band-pic'),
    trailing: widthOf('.nds-identity-band-trail'),
    menu: 0,
    gap: parseFloat(cs.columnGap || cs.gap || '0') || 0,
    /* The cell's OWN padding, read rather than assumed — it computes 9/9 here, not the 10/10 the
       constants carried. */
    padding: cellCs ? (parseFloat(cellCs.paddingLeft) || 0) + (parseFloat(cellCs.paddingRight) || 0) : 0,
  }
}

/**
 * The SKU face, built from the DS TOKENS rather than read off a rendered node.
 *
 * 🔴 In the engine because both scopes derive a width and two builders would be two faces and two
 * widths for one row (#739). And built from tokens because the obvious source is the wrong one:
 * the width must be known when the COLUMN is defined, which is before any band exists — reading
 * `.nds-identity-band-sku` returns null on that pass and silently falls back to a different size.
 * Measured: the fallback inflated the widest key from 171.6px to ~187 and pushed the derived width
 * to the ceiling. `documentElement` exists at first render and its tokens measure byte-identical to
 * the rendered face.
 */
export function buildSkuFont(): string {
  if (typeof document === 'undefined') return ''
  const cs = getComputedStyle(document.documentElement)
  const family = cs.getPropertyValue('--nds-font-mono').trim() || 'ui-monospace, SFMono-Regular, Menlo, monospace'
  const size = cs.getPropertyValue('--nds-font-size-xs').trim() || '11px'
  return `600 ${size} ${family}`
}

/**
 * Measure the widest of a family's SKUs in the face the band actually renders them in.
 *
 * 🔴 Canvas, not a DOM probe: measuring by inserting spans forces layout per SKU and, on a
 * virtualised grid, the element whose font you want may not be mounted. The caller passes the
 * resolved `font` shorthand from `getComputedStyle` of a real `.nds-identity-band-sku`, so the
 * measurement uses the face that is on screen rather than one this module guessed at.
 *
 * Returns 0 when there is no canvas (SSR, a test) — the caller then falls back to the floor, which
 * is the honest answer for "not measured" and never a fabricated width.
 */
export function measureLongestSku(skus: readonly string[], font: string): number {
  if (skus.length === 0) return 0
  const canvas = typeof document === 'undefined' ? null : document.createElement('canvas')
  const ctx = canvas?.getContext('2d')
  if (!ctx) return 0
  ctx.font = font
  let max = 0
  for (const s of skus) max = Math.max(max, ctx.measureText(s).width)
  return Math.ceil(max)
}
