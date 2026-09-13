/**
 * 🔴 R-VT-13 — `ChannelListing.variationMapping` is ORDERED, and every reader accepts BOTH shapes.
 *
 * ## What was measured (VT.F, 2026-09-13, `VX-TEST-3AX` AMAZON·IT, three steps with 8 s read-backs)
 *
 * An order-only change on Amazon/Shopify/Etsy answered **200**, bumped the listing version **6 → 7**, and the
 * read-back served the **ORIGINAL** order. One line on each side: the writer built a flat `{axisKey: target}` map
 * and dropped `entry.order`, and the reader re-derived `order` from the FAMILY axis index. So the order an
 * operator dragged had nowhere to go, and the 200 burned every other operator's CAS token for nothing
 * (`reference_api_accepts_a_flag_it_ignores`).
 *
 * ## The shape
 *
 *     ordered (written from now on):  { axes: [{ axisKey, target, order }, …] }
 *     flat    (every row written before, and two legacy writers): { [axisKey]: target, … }
 *
 * No migration: the column is JSON, and a flat row is read correctly for ever. There is **no flat mirror** inside
 * the ordered shape — two copies of the same fact in one column is how they come to disagree
 * (`reference_contract_emits_same_write_cell_twice`).
 *
 * ## Why this module lives in `packages/shared`
 *
 * Because the WEB reads this column too (the datasheet's axis detection, the print matrix, the legacy catalog
 * Platform tab). A second parser in `apps/web` would be the drift this programme's rule 4 forbids: one
 * definition, zero copies.
 *
 * ## The discriminator, and the collision it is built to survive
 *
 * `Array.isArray(value.axes)` — nothing weaker. A legacy flat map CAN contain an axis literally named `axes`
 * (`reference_workbook_escaped_header_collision`: a channel attribute can be literally named `sku`), but its
 * value is then a STRING target, never an array, so `{ axes: 'color' }` is read as the flat map it is.
 */

export interface VariationMappingEntry {
  /** The axis as the FAMILY stores it (`Colore`) or its canonical key — whatever the writer sent. */
  axisKey: string
  /** The channel's own name for it: Amazon's SP-API attribute, the Shopify option, the Etsy property. */
  target: string
  /** 0-based delivery order. Dense and gap-free after parsing, whatever the stored numbers were. */
  order: number
}

/** `'unreadable'` is never silent: a caller that must not guess can refuse on it. */
export type VariationMappingShape = 'ordered' | 'flat' | 'empty' | 'unreadable'

export interface ParsedVariationMapping {
  shape: VariationMappingShape
  /** In delivery order. Only entries with a non-empty string target — the writer stores no others. */
  entries: VariationMappingEntry[]
}

export interface OrderedVariationMapping {
  axes: VariationMappingEntry[]
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)

const cleanTarget = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v : null)

/** An explicitly saved empty ordered list means no axes; null/legacy {} means inherit. */
export function hasVariationMappingOverride(value: unknown): boolean {
  return isPlainObject(value) && (Array.isArray(value.axes) || parseVariationMapping(value).entries.length > 0)
}

/**
 * Read either shape. Opens nothing, throws nothing: an unreadable value yields `shape: 'unreadable'` with no
 * entries, so a reader degrades to "nothing is mapped here" rather than to a wrong mapping.
 */
export function parseVariationMapping(value: unknown): ParsedVariationMapping {
  if (value === null || value === undefined) return { shape: 'empty', entries: [] }
  if (!isPlainObject(value)) return { shape: 'unreadable', entries: [] }

  if (Array.isArray((value as { axes?: unknown }).axes)) {
    const raw = (value as { axes: unknown[] }).axes
    const entries: Array<VariationMappingEntry & { _at: number }> = []
    raw.forEach((item, index) => {
      if (!isPlainObject(item)) return
      const axisKey = typeof item.axisKey === 'string' && item.axisKey.trim() ? item.axisKey : null
      const target = cleanTarget(item.target)
      if (!axisKey || !target) return
      // A stored `order` wins; a missing or non-finite one falls back to the array position, which is the order
      // the writer serialised. Both are then re-densified below, so a gap or a duplicate cannot survive.
      const order = typeof item.order === 'number' && Number.isFinite(item.order) ? item.order : index
      entries.push({ axisKey, target, order, _at: index })
    })
    entries.sort((a, b) => (a.order - b.order) || (a._at - b._at))
    return { shape: raw.length === 0 ? 'empty' : 'ordered', entries: entries.map(({ axisKey, target }, i) => ({ axisKey, target, order: i })) }
  }

  const keys = Object.keys(value)
  if (keys.length === 0) return { shape: 'empty', entries: [] }
  const entries: VariationMappingEntry[] = []
  for (const key of keys) {
    const target = cleanTarget(value[key])
    if (!target) continue          // the flat reader's own rule, unchanged: a non-string value is not a target
    entries.push({ axisKey: key, target, order: entries.length })
  }
  // Every key held a non-string value: there is a mapping object here but nothing this repo can read as a target.
  if (entries.length === 0) return { shape: 'unreadable', entries: [] }
  return { shape: 'flat', entries }
}

/** The value a writer stores. Dense 0-based `order`, in the order given. */
export function orderedVariationMapping(
  entries: ReadonlyArray<{ axisKey: string; target: string; order?: number }>,
): OrderedVariationMapping {
  const kept = entries
    .map((entry, index) => ({
      axisKey: entry.axisKey,
      target: entry.target,
      order: typeof entry.order === 'number' && Number.isFinite(entry.order) ? entry.order : index,
      _at: index,
    }))
    .filter((entry) => typeof entry.axisKey === 'string' && entry.axisKey.trim() && cleanTarget(entry.target))
    .sort((a, b) => (a.order - b.order) || (a._at - b._at))
  return { axes: kept.map(({ axisKey, target }, i) => ({ axisKey, target, order: i })) }
}

/** Both shapes as the flat `{axisKey: target}` lookup a legacy reader expects. Delivery order is lost by design. */
export function flatVariationMapping(value: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  for (const entry of parseVariationMapping(value).entries) out[entry.axisKey] = entry.target
  return out
}

/**
 * The target for an axis, trying each alias in turn and then case-insensitively — the lookup
 * `amazon-publish.adapter.ts` has always done (`mapping?.[axis] ?? mapping?.[axis.toLowerCase()]`), in one place.
 */
export function variationMappingTarget(value: unknown, ...axisKeys: string[]): string | null {
  const entries = parseVariationMapping(value).entries
  for (const key of axisKeys) {
    if (!key) continue
    const exact = entries.find((entry) => entry.axisKey === key)
    if (exact) return exact.target
  }
  for (const key of axisKeys) {
    if (!key) continue
    const lower = key.toLowerCase()
    const loose = entries.find((entry) => entry.axisKey.toLowerCase() === lower)
    if (loose) return loose.target
  }
  return null
}

/** The axis keys, in delivery order. The one function an axis-DETECTION reader needs. */
export function variationMappingAxisKeys(value: unknown): string[] {
  return parseVariationMapping(value).entries.map((entry) => entry.axisKey)
}

/** The stored delivery position of one axis, or `null` when this mapping does not carry it. */
export function variationMappingOrder(value: unknown, ...axisKeys: string[]): number | null {
  const entries = parseVariationMapping(value).entries
  for (const key of axisKeys) {
    const hit = entries.find((entry) => entry.axisKey === key) ?? entries.find((entry) => entry.axisKey.toLowerCase() === String(key).toLowerCase())
    if (hit) return hit.order
  }
  return null
}

/**
 * Set one axis's target, keeping every other entry AND the delivery order. For the legacy per-axis editors
 * (the catalog Platform tab), which used to rebuild a flat object and would otherwise drop the order on save.
 */
export function setVariationMappingTarget(value: unknown, axisKey: string, target: string): OrderedVariationMapping {
  const entries = parseVariationMapping(value).entries.filter((entry) => entry.axisKey !== axisKey)
  const clean = cleanTarget(target)
  const position = parseVariationMapping(value).entries.findIndex((entry) => entry.axisKey === axisKey)
  if (!clean) return orderedVariationMapping(entries)                       // an emptied field REMOVES the mapping
  const next = [...entries]
  next.splice(position >= 0 ? position : next.length, 0, { axisKey, target: clean, order: 0 })
  return orderedVariationMapping(next.map((entry, index) => ({ ...entry, order: index })))
}
