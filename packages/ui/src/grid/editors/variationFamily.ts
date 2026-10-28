/**
 * The family behind a variation-theme cell, as the pop-up shows it (sheet pop-up rebuild P2,
 * docs/sheet-popup-editor/PLAN-2026-09-27.md §4.2): each axis with its VALUES — a photo, a count, the order — and every
 * variant with its photo. Shopify's Variants card shows exactly this: an option row with its value chips, then the
 * variants, each with its picture.
 *
 * The design system does not fetch: a host passes a loader (`VariationFamilyLoader`) that answers this shape. Pure
 * helpers live here so the rules are tested without a DOM.
 */

export interface VariationFamilyValue {
  /** `<attribute code>:<option code>` for a dictionary value, `<code>:text:<text>` for one the dictionary lacks. */
  key: string
  /** The dictionary option code, or null when the value is not in the dictionary (it cannot be ordered by code). */
  option: string | null
  label: string
  /** How many variants carry it. */
  count: number
  /** Its photo: the plan's photo for the value, else the photo of the first variant carrying it. Null → no picture slot. */
  photo: string | null
}

export interface VariationFamilyAxis {
  /** The dictionary attribute code (`color`), or a slug when the family has no codes yet. */
  code: string
  /** The family's own spelling (`Colore`). */
  label: string
  /** True when the axis is a dictionary attribute — only then can its value order be saved. */
  dictionary: boolean
  /** In the family's saved order. */
  values: VariationFamilyValue[]
}

export interface VariationFamilyVariant {
  id: string
  sku: string
  /** Its values in axis order: `Nero · XS`. */
  label: string
  photo: string | null
}

export interface VariationFamilyView {
  axes: VariationFamilyAxis[]
  variants: VariationFamilyVariant[]
}

export type VariationFamilyLoader = (familyId: string) => Promise<VariationFamilyView>

export type VariationFamilyState =
  | { state: 'loading' }
  | { state: 'ready'; view: VariationFamilyView }
  | { state: 'error'; message: string }

/** Case-, accent- and separator-blind: `Colore`, `colore`, `COLORE ` are one axis. */
const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '')

/**
 * The family axis a cell axis names. A cell speaks the family's spelling (`familyKey` / `label`), the family view its
 * code and spelling; either may match. Unmatched → undefined, and the row shows no values rather than another axis's.
 */
export function familyAxisFor(view: VariationFamilyView | null | undefined, axis: { axisKey: string; familyKey?: string; label: string }): VariationFamilyAxis | undefined {
  if (!view) return undefined
  const names = new Set([axis.axisKey, axis.familyKey ?? '', axis.label].filter(Boolean).map(norm))
  return view.axes.find(a => names.has(norm(a.label)) || names.has(norm(a.code)))
}

/** Variants that carry a value on this axis. */
export const axisValueCount = (axis: VariationFamilyAxis | undefined) => axis?.values.reduce((sum, v) => sum + v.count, 0) ?? 0

/**
 * Why an axis may NOT be removed, or null when it may. The approved VT master rule
 * (`docs/2026-09-13-variation-theme-column-design.md` §4): an axis whose values are still on variants is refused —
 * removing it would leave those values orphaned under an axis the family no longer has. `fallbackCount` is the cell's
 * own `valueCount`, used while the family is not loaded.
 */
export function axisRemovalRefusal(label: string, axis: VariationFamilyAxis | undefined, fallbackCount = 0): string | null {
  const n = axis ? axisValueCount(axis) : fallbackCount
  if (n <= 0) return null
  return `${label} has values on ${n} ${n === 1 ? 'variant' : 'variants'} — clear them first, then remove ${label}.`
}

/**
 * The order to SAVE after a drag: option codes in the new order. Values outside the dictionary cannot be saved by code —
 * they are left out of the saved order and keep following it. Returns null when nothing about the order changed.
 */
export function valueOrderAfterDrag(axis: VariationFamilyAxis, keys: readonly string[]): string[] | null {
  const byKey = new Map(axis.values.map(v => [v.key, v]))
  const next = keys.map(k => byKey.get(k)?.option).filter((o): o is string => !!o)
  const before = axis.values.map(v => v.option).filter((o): o is string => !!o)
  return JSON.stringify(next) === JSON.stringify(before) ? null : next
}

/** The axis's values re-ordered by a saved order (option codes), for showing a draft. Unknown ones keep their place after. */
export function orderValues(axis: VariationFamilyAxis, order: readonly string[] | undefined): VariationFamilyValue[] {
  if (!order?.length) return axis.values
  const rank = new Map(order.map((o, i) => [o, i]))
  return axis.values.map((v, i) => ({ v, i })).sort((a, b) => {
    const ra = a.v.option != null && rank.has(a.v.option) ? rank.get(a.v.option)! : order.length + a.i
    const rb = b.v.option != null && rank.has(b.v.option) ? rank.get(b.v.option)! : order.length + b.i
    return ra - rb
  }).map(x => x.v)
}

/** Variants matching a search over their label and SKU. */
export function filterVariants(variants: readonly VariationFamilyVariant[], query: string): VariationFamilyVariant[] {
  const q = norm(query)
  return q ? variants.filter(v => norm(`${v.label} ${v.sku}`).includes(q)) : variants.slice()
}
