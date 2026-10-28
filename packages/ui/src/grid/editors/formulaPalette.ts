/**
 * GDS — which colour each `$reference` wears while a formula is being edited (#730).
 *
 * The Owner's ask is Excel's: every reference in the text is coloured, and the cell it reads in the
 * SAME ROW is outlined in that colour, so an operator can see what the formula is pulling from
 * before they commit it.
 *
 * 🔴 The swatches are a SUBSET of the DS tag palette, and the subset is the whole point. `colors.ts`
 * records a measured, known defect in that palette: **Purple 1.79, Teal 2.84, Pink 2.52 and Grey
 * 2.58 fail WCAG 1.4.11's 3:1 on the dark ground**, and they are kept only because a tag's colour is
 * persisted data that must not be re-snapped under saved rows. Nothing here is persisted — a
 * reference's colour lives for the length of one edit — so there is no reason to inherit that
 * defect, and every hue below is one `colors.ts` states passes on BOTH grounds.
 *
 * An outline is a graphical object carrying meaning, so 3:1 is the bar, not 4.5:1. The row ground it
 * must clear is the GRID's, not the page's, and it is measured on the surface rather than assumed —
 * a selected row and a striped row are different grounds.
 */
import { tagSwatches } from '../../tokens/colors'

/**
 * The reference cycle, in order.
 *
 * Taken by NAME from `tagSwatches` rather than by index, so a reorder there cannot silently swap a
 * hue for one of the four that fail on dark. A name that disappears is a build error, not a quiet
 * downgrade.
 */
const CYCLE_NAMES = ['Indigo', 'Emerald', 'Orange', 'Fuchsia', 'Rose', 'Violet', 'Stone'] as const

/**
 * Contrast against the GRID ROW grounds, measured on the master sheet 2026-09-02 — white
 * `rgb(255,255,255)` for an even row and `rgb(238,241,245)` for the odd stripe. Worst of the two.
 *
 * 🔴 These are NOT `colors.ts`'s numbers, and the difference is why they are here. That file
 * measures against the PAGE grounds (#ffffff and #18263b). The grid's odd row is a light grey
 * stripe the DS never measured against, and on it **Lime drops to 2.73 — below the 3:1 an outline
 * owes** — as do Green (2.91) and Amber (2.81), which is why none of the three is in the cycle.
 * Lime passes `colors.ts`'s own check at 3.09/4.93; it fails HERE. A palette is only accessible
 * against the ground it is actually drawn on.
 *
 * ⚠ Red is deliberately absent although it passes (3.32): red is the `unknownRefs` colour, and a
 * valid reference wearing the error hue is the one confusion this feature cannot afford. Blue
 * passes best of all (4.56) and is also absent: it is the grid's selection and focus colour, so an
 * outline in it would read as "this cell is selected".
 */
export const CYCLE_MEASURED_CONTRAST: Readonly<Record<string, number>> = {
  Indigo: 3.94, Emerald: 3.33, Orange: 3.14, Fuchsia: 4.16, Rose: 3.24, Violet: 3.74, Stone: 4.08,
}

export interface RefColour {
  name: string
  hex: string
}

export const REF_CYCLE: readonly RefColour[] = CYCLE_NAMES.map((n) => {
  const hit = tagSwatches.find((s) => s.name === n)
  if (!hit) throw new Error(`formulaPalette: DS swatch "${n}" is gone — pick a replacement that clears 3:1 on BOTH grounds`)
  return { name: hit.name, hex: hit.hex }
})

/**
 * Assign a colour to every distinct reference in a formula, in first-appearance order.
 *
 * 🔴 Keyed by NAME, not by occurrence: `$brand + " " + $brand` is ONE source cell and must be one
 * colour, or the outline on that cell could only match half its mentions. Comparison is
 * case-insensitive because `$BRAND` and `$brand` resolve to the same attribute.
 *
 * More distinct references than swatches wraps rather than running out. Two references sharing a
 * hue is a real ambiguity, and `distinctRefCount` lets the caller say so rather than pretending.
 */
export function assignRefColours(refNames: readonly string[]): Map<string, RefColour> {
  const out = new Map<string, RefColour>()
  for (const raw of refNames) {
    const key = raw.toLowerCase()
    if (key === '' || out.has(key)) continue
    out.set(key, REF_CYCLE[out.size % REF_CYCLE.length])
  }
  return out
}

/** Does this formula have more distinct references than the cycle can colour uniquely? */
export const refColoursWrap = (refNames: readonly string[]): boolean =>
  new Set(refNames.filter(Boolean).map((r) => r.toLowerCase())).size > REF_CYCLE.length

/** The colour for one reference, or `null` when it has none (an unknown ref is red, not a hue). */
export function colourFor(refName: string, assigned: ReadonlyMap<string, RefColour>): RefColour | null {
  return assigned.get(refName.toLowerCase()) ?? null
}
