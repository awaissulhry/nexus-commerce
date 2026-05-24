/**
 * PIM C.6 — Saved views (personal, localStorage-backed).
 *
 * A saved view is a named bundle of matrix UI state (visible columns,
 * search, sort). Operators switch between views to focus on different
 * tasks: "Pricing focus" hides Channels and shows Price/Min/Max; "Stock
 * focus" highlights inventory; "All columns" is the everything view.
 *
 * Built-in views ship pre-seeded and read-only (operators can't edit/
 * delete them — they'd have to clone first). Custom views live next
 * to them in the dropdown and support full CRUD.
 *
 * C.6b will swap the storage layer for a SavedView Prisma model so
 * views can be shared across the team. Shape stays the same so the
 * UI doesn't change.
 */

export interface SavedView {
  /** Stable id used as React key + localStorage map key. */
  id: string
  /** Display name in the dropdown + save dialog. */
  name: string
  /** Visible column ids in order. Same as columnDefs.ts. */
  columnIds: string[]
  /** Optional baseline search string applied on view switch. */
  search?: string
  /** Optional initial sort. Phase C.6b adds the sort UI; the field
   *  is wired now so saved views are forward-compatible. */
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  /** When true, view is built-in and read-only (no edit/delete). */
  builtin?: boolean
}

// ────────────────────────────────────────────────────────────────────
// Pre-seeded built-in views
// ────────────────────────────────────────────────────────────────────

export const BUILTIN_VIEWS: SavedView[] = [
  {
    id: 'builtin:default',
    name: 'Default',
    columnIds: [
      '__select',
      '__expand',
      'sku',
      'name',
      'brand',
      'totalStock',
      'basePrice',
      'status',
      'channelCoverage',
      '__actions',
    ],
    builtin: true,
  },
  {
    id: 'builtin:pricing',
    name: 'Pricing focus',
    columnIds: ['__select', '__expand', 'sku', 'name', 'basePrice', 'status', '__actions'],
    builtin: true,
  },
  {
    id: 'builtin:stock',
    name: 'Stock focus',
    columnIds: ['__select', '__expand', 'sku', 'name', 'totalStock', 'status', 'channelCoverage', '__actions'],
    builtin: true,
  },
  {
    id: 'builtin:content',
    name: 'Content focus',
    columnIds: ['__select', '__expand', 'sku', 'name', 'brand', 'status', 'channelCoverage', '__actions'],
    builtin: true,
  },
]

// ────────────────────────────────────────────────────────────────────
// Storage
// ────────────────────────────────────────────────────────────────────

const STORAGE_KEY = 'catalog-matrix:saved-views:v1'
const ACTIVE_KEY = 'catalog-matrix:active-view:v1'

/** Load custom (operator-created) views from localStorage. Built-ins
 *  are listed separately by the consumer and never go through here. */
export function loadCustomViews(): SavedView[] {
  if (typeof window === 'undefined') return []
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (v): v is SavedView =>
        v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string'
        && Array.isArray(v.columnIds) && !v.builtin,
    )
  } catch {
    return []
  }
}

export function saveCustomViews(views: SavedView[]): void {
  if (typeof window === 'undefined') return
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views.filter((v) => !v.builtin)))
  } catch {
    /* quota / disabled — swallow */
  }
}

/** Track which view the operator currently has applied. Survives
 *  reloads so the matrix re-opens with the same lens. */
export function loadActiveViewId(): string | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage.getItem(ACTIVE_KEY)
  } catch {
    return null
  }
}

export function saveActiveViewId(id: string | null): void {
  if (typeof window === 'undefined') return
  try {
    if (id == null) window.localStorage.removeItem(ACTIVE_KEY)
    else window.localStorage.setItem(ACTIVE_KEY, id)
  } catch {
    /* swallow */
  }
}

// ────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────

/** Build a new custom view from the current matrix state. */
export function newCustomView(input: {
  name: string
  columnIds: string[]
  search?: string
}): SavedView {
  // ID format: "view:<timestamp>:<random>" so they sort chronologically
  // in dev tools + avoid collisions when two views are created in the
  // same millisecond.
  const id = `view:${Date.now()}:${Math.random().toString(36).slice(2, 7)}`
  return {
    id,
    name: input.name.trim() || 'Untitled view',
    columnIds: input.columnIds,
    search: input.search?.trim() || undefined,
  }
}

/** Return all views the operator can pick from (built-ins + custom). */
export function listAllViews(): SavedView[] {
  return [...BUILTIN_VIEWS, ...loadCustomViews()]
}

/** Find a view by id across both built-in and custom lists. */
export function findView(id: string): SavedView | null {
  return listAllViews().find((v) => v.id === id) ?? null
}
