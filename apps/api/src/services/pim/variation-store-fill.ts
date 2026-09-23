/**
 * Step 2.6d (A-27, R-26) — the data half of "one store for a child's size and colour". Pure planning; the script
 * `scripts/fill-variation-store.ts` reads, prints, and (with `--apply`) writes through `writeVariationValues`.
 *
 * Measured on production, 2026-09-23 (`tools/axis-stores.mjs`):
 * - 77 children hold a size only on a channel (37 on eBay only, 40 on eBay + Amazon), and 77 a colour — the store and
 *   the legacy bag are empty for them, so the sheet shows nothing while the live eBay·IT listing carries a value.
 *   FILL copies the eBay·IT item specific into the store, so the store matches the live listing — in the FAMILY's
 *   words: where the child's siblings hold both an eBay value and a store value, the store's name is used
 *   (VENTRA: eBay `Rosso | Donna` is stored as `Grigio-Rosso-Nero | Donna` by every sibling that has both).
 * - One child's legacy bag contradicts the store (AIR-MESH-JACKET-MEN-XXL-BLACK: legacy `XS`, store `XXL`, Amazon
 *   `XXL`). Since 2.6c no reader takes the legacy value first, but it is a trap. DROP removes a legacy key only where it
 *   contradicts the store; a legacy value that agrees stays untouched.
 */
import { canonicalVariantAxis } from './variant-attribute-keys.js'
import type { VariationWritePlan } from './shared-variation-values.js'

export type FillChild = {
  id: string
  sku: string
  parentId: string
  categoryAttributes: unknown
  variantAttributes: unknown
  /** The child's eBay·IT listing item specifics (`platformAttributes.itemSpecifics`), or null. */
  ebaySpecifics: Record<string, unknown> | null
}
export type FillAction = {
  id: string
  sku: string
  fills: Array<{ axis: FillAxis; key: string; value: string; from: 'eBay·IT' | 'siblings' }>
  drops: Array<{ key: string; legacy: string; store: string }>
  plan: VariationWritePlan
}
type FillAxis = 'size' | 'color'
const AXES: readonly FillAxis[] = ['size', 'color']

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
const scalar = (value: unknown): string | null => {
  const v = Array.isArray(value) ? value[0] : value
  return (typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null
}
const valueOf = (bag: Record<string, unknown>, axis: FillAxis) => {
  for (const [key, value] of Object.entries(bag)) if (canonicalVariantAxis(key) === axis && scalar(value)) return { key, value: scalar(value)! }
  return null
}

/** The key spelling a fill uses: the one the child's siblings already store (most common), else the parent's
 * declared axis, else the eBay aspect's own name. */
function chooseKey(axis: FillAxis, siblings: FillChild[], declared: readonly string[], ebayKey: string): string {
  const counts = new Map<string, number>()
  for (const sibling of siblings) for (const key of Object.keys(object(object(sibling.categoryAttributes).variations))) {
    if (canonicalVariantAxis(key) === axis) counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  const common = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0]
  return common ?? declared.find((key) => canonicalVariantAxis(key) === axis) ?? ebayKey
}

/** What the family calls an eBay value: the store value of every sibling holding both, when they all agree. */
function learnedName(siblings: readonly FillChild[], axis: FillAxis, ebayValue: string): string | null {
  const names = new Set<string>()
  for (const sibling of siblings) {
    const ebay = valueOf(object(sibling.ebaySpecifics), axis)
    const stored = valueOf(object(object(sibling.categoryAttributes).variations), axis)
    if (ebay && stored && ebay.value.toLowerCase() === ebayValue.toLowerCase()) names.add(stored.value)
  }
  return names.size === 1 ? [...names][0]! : null
}

export function planVariationStoreFill(children: readonly FillChild[], declaredAxes: ReadonlyMap<string, readonly string[]>): FillAction[] {
  const byParent = new Map<string, FillChild[]>()
  for (const child of children) byParent.set(child.parentId, [...(byParent.get(child.parentId) ?? []), child])
  const actions: FillAction[] = []
  for (const child of children) {
    const store = object(object(child.categoryAttributes).variations)
    const legacy = object(child.variantAttributes)
    const fills: FillAction['fills'] = []
    const drops: FillAction['drops'] = []
    for (const axis of AXES) {
      const stored = valueOf(store, axis)
      const old = valueOf(legacy, axis)
      if (!stored && !old) {
        const ebay = valueOf(object(child.ebaySpecifics), axis)
        if (ebay) {
          const siblings = byParent.get(child.parentId) ?? []
          const learned = learnedName(siblings, axis, ebay.value)
          fills.push({ axis, key: chooseKey(axis, siblings, declaredAxes.get(child.parentId) ?? [], ebay.key),
            value: learned ?? ebay.value, from: learned && learned !== ebay.value ? 'siblings' : 'eBay·IT' })
        }
      } else if (stored && old) {
        // Per legacy KEY, not per axis: a bag holding `Taglia: XXL` (agrees) and `Size: XS` (contradicts) must lose `Size`.
        for (const [key, value] of Object.entries(legacy)) {
          if (canonicalVariantAxis(key) === axis && scalar(value) && scalar(value)!.toLowerCase() !== stored.value.toLowerCase()) drops.push({ key, legacy: scalar(value)!, store: stored.value })
        }
      }
    }
    if (!fills.length && !drops.length) continue
    actions.push({ id: child.id, sku: child.sku, fills, drops, plan: {
      set: Object.fromEntries(fills.map((f) => [f.key, f.value])), unset: [], legacyDrop: drops.map((d) => d.key), changed: true,
    } })
  }
  return actions
}
