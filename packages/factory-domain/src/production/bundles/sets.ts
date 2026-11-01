import type { BundleRefusal } from './rules'

/**
 * Pair and set matching (B-W2b-41; MES-078; design floor.operation "Checks before it counts": "sleeves or suit parts from
 * different shade lots → refusal"), pure. Leather of two dye batches never matches in one garment: a part bundle (the
 * sleeves travelling on their own) joins the other parts of its cell only from the same shade.
 *
 *   shade     of a bundle: the shades of the hides its cut log entries cut (the hide's own shade, else its lot's shade,
 *             else the lot's dye batch). Unknown (none recorded): it matches anything, and the answer says so (shade
 *             rules start the day the hides carry a shade). A bundle cut from two known shades is MIXED: it pairs with
 *             nothing until it is split by shade.
 *   sets      per cell and shade, how many complete garments the part bundles make: the fewest pieces of any of the
 *             cell's parts in that shade; what is left over is unmatched (the parts it waits for in that shade). A
 *             bundle of whole garments is complete on its own (its parts were cut together).
 *   check     bundles meant to be joined: the same cell, no mixed one, and one known shade at most.
 */

export interface ShadeSource {
  readonly hideShade: string | null
  readonly lotShade: string | null
  readonly dyeBatch: string | null
}

/** A hide's shade as recorded (trimmed, upper case), or null. */
export function shadeOf(source: ShadeSource): string | null {
  const value = [source.hideShade, source.lotShade, source.dyeBatch].find((candidate) => candidate !== null && candidate.trim() !== '')
  return value ? value.trim().toUpperCase() : null
}

export interface SetBundle {
  readonly id: string
  readonly code: string
  readonly workOrderSizeId: string
  /** The part it carries; null: whole garments. */
  readonly part: string | null
  readonly quantity: number
  /** The known shades of its hides, distinct. */
  readonly shades: readonly string[]
}

export interface CellSet {
  /** Null: no shade recorded. */
  readonly shade: string | null
  /** Complete garments of one shade (whole bundles, and part bundles that make a whole). */
  readonly complete: number
  readonly bundles: readonly { readonly id: string; readonly code: string; readonly part: string | null; readonly quantity: number }[]
  /** Parts with pieces left over in this shade, and the parts they wait for. */
  readonly unmatched: readonly { readonly part: string; readonly pieces: number; readonly waitsFor: readonly string[] }[]
}

export interface CellSets {
  readonly sets: readonly CellSet[]
  /** Bundles cut from more than one known shade. */
  readonly mixed: readonly { readonly id: string; readonly code: string; readonly shades: readonly string[] }[]
}

const shadeKey = (shade: string | null) => shade ?? ''

/** A cell's bundles matched by shade. `parts`: the cell's BOM parts (what a whole garment needs). */
export function cellSets(parts: readonly string[], bundles: readonly SetBundle[]): CellSets {
  const mixed = bundles.filter((bundle) => bundle.shades.length > 1).map((bundle) => ({ id: bundle.id, code: bundle.code, shades: [...bundle.shades].sort() }))
  const single = bundles.filter((bundle) => bundle.shades.length <= 1)
  const groups = new Map<string, SetBundle[]>()
  for (const bundle of single) groups.set(shadeKey(bundle.shades[0] ?? null), [...(groups.get(shadeKey(bundle.shades[0] ?? null)) ?? []), bundle])
  const sets: CellSet[] = []
  for (const [key, group] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const whole = group.filter((bundle) => bundle.part === null).reduce((sum, bundle) => sum + bundle.quantity, 0)
    const pieces = new Map(parts.map((part) => [part, group.filter((bundle) => bundle.part === part).reduce((sum, bundle) => sum + bundle.quantity, 0)]))
    const partBundles = group.some((bundle) => bundle.part !== null)
    const fromParts = partBundles && parts.length > 0 ? Math.min(...[...pieces.values()]) : 0
    const unmatched = partBundles
      ? [...pieces.entries()]
          .filter(([, count]) => count > fromParts)
          .map(([part, count]) => ({ part, pieces: count - fromParts, waitsFor: [...pieces.entries()].filter(([, other]) => other < count).map(([name]) => name).sort() }))
      : []
    sets.push({
      shade: key === '' ? null : key,
      complete: whole + fromParts,
      bundles: group.map((bundle) => ({ id: bundle.id, code: bundle.code, part: bundle.part, quantity: bundle.quantity })),
      unmatched,
    })
  }
  return { sets, mixed }
}

/** Bundles meant to be joined into garments (a pair of sleeves and a body, a suit's parts): null when they match. */
export function pairRefusal(bundles: readonly SetBundle[]): BundleRefusal | null {
  if (new Set(bundles.map((bundle) => bundle.workOrderSizeId)).size > 1) {
    return { code: 'NOT_ONE_SET', message: 'These bundles are of different colours or sizes: only bundles of one cell make garments together.' }
  }
  const mixed = bundles.find((bundle) => bundle.shades.length > 1)
  if (mixed) return { code: 'MIXED_SHADES', message: `Bundle ${mixed.code} was cut from hides of ${mixed.shades.length} shades (${[...mixed.shades].sort().join(', ')}): split it by shade before it is paired.` }
  const known = bundles.filter((bundle) => bundle.shades.length === 1)
  const shades = [...new Set(known.map((bundle) => bundle.shades[0]!))].sort()
  if (shades.length > 1) {
    const words = shades.map((shade) => `${known.filter((bundle) => bundle.shades[0] === shade).map((bundle) => bundle.code).join(', ')} shade ${shade}`).join('; ')
    return { code: 'SHADE_MISMATCH', message: `These bundles come from different shades (${words}): pair bundles of one shade only.` }
  }
  return null
}
