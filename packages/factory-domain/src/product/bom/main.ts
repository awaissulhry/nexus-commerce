/**
 * owb-pd3 step 3.3 (S4; design plan § 5zc "Main material"; the wave #2076 `BomLine.isMain`, unique per revision) — the main material
 * of a product: the BOM line the customer's leather choice hangs on (the leathers the customer can pick stay the style's MATERIAL
 * option group). Pure: the refusals in words and what a change asks.
 *
 *   MAIN_REQUIRED   the main line is not taken out, nor unmarked: another line is marked main instead (that moves the mark)
 *   SAME_MATERIAL   design § 5zc "the same material twice is refused": a line added (or changed) to a material that another line
 *                   already uses at the same placement for the same colourways (the same item, placement — letter case and
 *                   spaces aside, none = none — and colourway). The same leather on the body and on the collar stays allowed:
 *                   two placements are two lines of the real BOM.
 */

export const MAIN_REFUSALS = ['MAIN_REQUIRED', 'SAME_MATERIAL'] as const
export type MainRefusal = (typeof MAIN_REFUSALS)[number]

export const MAIN_REFUSAL_WORDS: Readonly<Record<MainRefusal, string>> = Object.freeze({
  MAIN_REQUIRED: 'The main material cannot be taken out: mark another line as the main material first.',
  SAME_MATERIAL: 'This material is in the list already, at the same place: change that line instead.',
})

const placementKey = (value: string | null | undefined): string => (value ?? '').trim().toLowerCase()

/** The main line of a BOM, or null. */
export const mainLineOf = <L extends { readonly isMain?: boolean }>(lines: readonly L[]): L | null => lines.find((line) => line.isMain === true) ?? null

/**
 * Why a line change is refused, or null: `lineId` null for a new line; `itemId` the material it will have; `wantsMain` what was asked
 * (undefined: not asked).
 */
export function mainRefusalOf(
  lines: readonly { readonly id: string; readonly itemId: string; readonly placement?: string | null; readonly colourwayId?: string | null; readonly isMain?: boolean }[],
  change: { readonly lineId: string | null; readonly itemId: string; readonly placement: string | null; readonly colourwayId: string | null; readonly wantsMain: boolean | undefined },
): MainRefusal | null {
  const main = mainLineOf(lines)
  if (change.wantsMain === false && main !== null && main.id === change.lineId) return 'MAIN_REQUIRED'
  const twin = lines.some((line) => line.id !== change.lineId && line.itemId === change.itemId && placementKey(line.placement) === placementKey(change.placement) && (line.colourwayId ?? null) === change.colourwayId)
  return twin ? 'SAME_MATERIAL' : null
}

/** Why a line is not taken out, or null. */
export const removeRefusalOf = (line: { readonly isMain?: boolean }): MainRefusal | null => (line.isMain === true ? 'MAIN_REQUIRED' : null)
