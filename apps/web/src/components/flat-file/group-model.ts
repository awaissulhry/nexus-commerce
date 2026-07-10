// group-model.ts — shared, channel-agnostic logic + persistence for the
// flat-file custom SKU groups (used by the shared FlatFileGrid: eBay, bulk-ops).
// View-only: nothing here touches row DATA, feeds, or variation structure.
// Groups hold item_sku strings (stable across sessions). Generalized from the
// Amazon page's group-model.ts; storage is keyed by an opaque `scope` string
// (e.g. "ebay-IT") so each channel+market keeps its own groups.

/** The shared grid's grouping modes (user choice: Family/Custom/None, plus the
 *  opt-in consumer 'bucket' auto-section mode — UFX P3, e.g. Amazon FBA/FBM). */
export type CustomGroupMode = 'family' | 'custom' | 'none' | 'bucket'

export type GroupColorName = 'blue' | 'purple' | 'emerald' | 'orange' | 'teal' | 'amber'
export const GROUP_PALETTE: readonly GroupColorName[] = ['blue', 'purple', 'emerald', 'orange', 'teal', 'amber']

export interface CustomGroup {
  id: string
  name: string
  color: GroupColorName
  order: number
  memberSkus: string[]
}

const GROUPS_KEY = (scope: string) => `ff-${scope}-groups`
const MODE_KEY = (scope: string) => `ff-${scope}-group-mode`
const COLLAPSED_KEY = (scope: string) => `ff-${scope}-collapsed-groups`

/** The custom group a SKU belongs to, or null. A SKU is in at most one group. */
export function groupIdForSku(groups: CustomGroup[], sku: string): string | null {
  for (const g of groups) if (g.memberSkus.includes(sku)) return g.id
  return null
}

/** Add `skus` to `groupId`, removing them from any other group. Empty groups are
 *  kept (create an empty group and fill it later). Returns a new array. */
export function assignSkusToGroup(groups: CustomGroup[], groupId: string, skus: string[]): CustomGroup[] {
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
export function removeSkusFromGroups(groups: CustomGroup[], skus: string[]): CustomGroup[] {
  const drop = new Set(skus.filter(Boolean))
  return groups.map((g) =>
    g.memberSkus.some((s) => drop.has(s)) ? { ...g, memberSkus: g.memberSkus.filter((s) => !drop.has(s)) } : g,
  )
}

/** Deterministic next id: `g` + (max existing numeric suffix + 1). No Math.random/Date. */
export function makeGroupId(existing: CustomGroup[]): string {
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

export function loadGroups(scope: string): CustomGroup[] {
  const raw = readJson<unknown>(GROUPS_KEY(scope), [])
  if (!Array.isArray(raw)) return []
  return raw
    .filter((g): g is CustomGroup =>
      !!g && typeof g === 'object' &&
      typeof (g as CustomGroup).id === 'string' &&
      typeof (g as CustomGroup).name === 'string' &&
      Array.isArray((g as CustomGroup).memberSkus),
    )
    .map((g, i) => ({
      id: g.id,
      name: g.name,
      color: GROUP_PALETTE.includes(g.color) ? g.color : GROUP_PALETTE[i % GROUP_PALETTE.length],
      order: typeof g.order === 'number' ? g.order : i,
      memberSkus: g.memberSkus.map(String),
    }))
}
export function saveGroups(scope: string, groups: CustomGroup[]): void {
  writeJson(GROUPS_KEY(scope), groups)
}

export function loadGroupMode(scope: string): CustomGroupMode {
  const v = readJson<string>(MODE_KEY(scope), 'family')
  // UFX P3 — 'fulfillment' is the Amazon page's legacy stored value for its
  // FBA/FBM auto-sections; it maps onto the grid's 'bucket' mode. A grid
  // without a bucketMode prop falls back to 'family' at runtime.
  if (v === 'fulfillment' || v === 'bucket') return 'bucket'
  return v === 'custom' || v === 'none' ? v : 'family'
}
export function saveGroupMode(scope: string, mode: CustomGroupMode): void {
  writeJson(MODE_KEY(scope), mode)
}

export function loadCollapsedGroups(scope: string): Set<string> {
  const arr = readJson<unknown>(COLLAPSED_KEY(scope), [])
  return new Set(Array.isArray(arr) ? arr.map(String) : [])
}
export function saveCollapsedGroups(scope: string, ids: Set<string>): void {
  writeJson(COLLAPSED_KEY(scope), [...ids])
}
