// group-model.ts — pure logic + persistence for the flat-file custom SKU groups.
// View-only: nothing here touches row DATA, the Amazon feed, or the variation
// structure (parent_sku). Groups hold item_sku strings (stable across sessions).

export type GroupMode = 'family' | 'fulfillment' | 'custom'

/** Mirrors the editor's FamilyColor / FAMILY_PALETTE. */
export type FamilyColorName = 'blue' | 'purple' | 'emerald' | 'orange' | 'teal' | 'amber'
export const GROUP_PALETTE: readonly FamilyColorName[] = ['blue', 'purple', 'emerald', 'orange', 'teal', 'amber']

export interface FlatFileGroup {
  id: string
  name: string
  color: FamilyColorName
  order: number
  memberSkus: string[]
}

const GROUPS_KEY = (market: string) => `ff-amazon-${market}-groups`
const MODE_KEY = (market: string) => `ff-amazon-${market}-group-mode`
const COLLAPSED_KEY = (market: string) => `ff-amazon-${market}-collapsed-groups`

/** Fulfillment bucket for the "Group by Fulfillment" preset.
 *  Precedence: an item_sku ending in `_FBM` is always FBM (explicit mirror SKU);
 *  otherwise a channel code starting AMAZON/AFN/FBA is FBA; everything else
 *  (merchant-fulfilled, or no channel) is FBM. */
export function fulfillmentBucket(row: Record<string, unknown>): 'FBA' | 'FBM' {
  const sku = String(row.item_sku ?? '')
  if (/_fbm$/i.test(sku)) return 'FBM'
  const code = String(row.fulfillment_availability__fulfillment_channel_code ?? '')
  if (/^(AMAZON|AFN|FBA)/i.test(code)) return 'FBA'
  return 'FBM'
}

/** The custom group a SKU belongs to, or null. A SKU is in at most one group. */
export function groupIdForSku(groups: FlatFileGroup[], sku: string): string | null {
  for (const g of groups) if (g.memberSkus.includes(sku)) return g.id
  return null
}

/** Add `skus` to `groupId`, removing them from any other group. Empty groups are
 *  kept (an operator can create an empty group and fill it later). Returns a new array. */
export function assignSkusToGroup(groups: FlatFileGroup[], groupId: string, skus: string[]): FlatFileGroup[] {
  const add = new Set(skus.filter(Boolean))
  return groups.map((g) => {
    if (g.id === groupId) {
      const merged = [...g.memberSkus.filter((s) => !add.has(s)), ...add]
      return { ...g, memberSkus: merged }
    }
    if (g.memberSkus.some((s) => add.has(s))) {
      return { ...g, memberSkus: g.memberSkus.filter((s) => !add.has(s)) }
    }
    return g
  })
}

/** Remove `skus` from every group (send them back to Ungrouped). Returns a new array. */
export function removeSkusFromGroups(groups: FlatFileGroup[], skus: string[]): FlatFileGroup[] {
  const drop = new Set(skus.filter(Boolean))
  return groups.map((g) =>
    g.memberSkus.some((s) => drop.has(s)) ? { ...g, memberSkus: g.memberSkus.filter((s) => !drop.has(s)) } : g,
  )
}

/** Deterministic next id: `g` + (max existing numeric suffix + 1). No Math.random/Date. */
export function makeGroupId(existing: FlatFileGroup[]): string {
  let max = 0
  for (const g of existing) {
    const m = /^g(\d+)$/.exec(g.id)
    if (m) max = Math.max(max, parseInt(m[1], 10))
  }
  return `g${max + 1}`
}

// ── localStorage (SSR-safe: never throws) ───────────────────────────────────
function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null
    if (raw == null) return fallback
    const parsed = JSON.parse(raw)
    return parsed == null ? fallback : (parsed as T)
  } catch {
    return fallback
  }
}
function writeJson(key: string, value: unknown): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(key, JSON.stringify(value))
  } catch {
    /* quota / disabled storage — non-fatal */
  }
}

export function loadGroups(market: string): FlatFileGroup[] {
  const raw = readJson<unknown>(GROUPS_KEY(market), [])
  if (!Array.isArray(raw)) return []
  // defensive normalisation: keep only well-formed entries
  return raw
    .filter((g): g is FlatFileGroup =>
      !!g && typeof g === 'object' &&
      typeof (g as FlatFileGroup).id === 'string' &&
      typeof (g as FlatFileGroup).name === 'string' &&
      Array.isArray((g as FlatFileGroup).memberSkus),
    )
    .map((g, i) => ({
      id: g.id,
      name: g.name,
      color: GROUP_PALETTE.includes(g.color) ? g.color : GROUP_PALETTE[i % GROUP_PALETTE.length],
      order: typeof g.order === 'number' ? g.order : i,
      memberSkus: g.memberSkus.map(String),
    }))
}
export function saveGroups(market: string, groups: FlatFileGroup[]): void {
  writeJson(GROUPS_KEY(market), groups)
}

export function loadGroupMode(market: string): GroupMode {
  const v = readJson<string>(MODE_KEY(market), 'family')
  return v === 'fulfillment' || v === 'custom' ? v : 'family'
}
export function saveGroupMode(market: string, mode: GroupMode): void {
  writeJson(MODE_KEY(market), mode)
}

export function loadCollapsedGroups(market: string): Set<string> {
  const arr = readJson<unknown>(COLLAPSED_KEY(market), [])
  return new Set(Array.isArray(arr) ? arr.map(String) : [])
}
export function saveCollapsedGroups(market: string, ids: Set<string>): void {
  writeJson(COLLAPSED_KEY(market), [...ids])
}
