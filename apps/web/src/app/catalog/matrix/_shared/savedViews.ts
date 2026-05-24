/**
 * PIM C.6 / C.6b — Saved views (server-backed via existing SavedView model).
 *
 * Storage swap from C.6 localStorage → server-side SavedView rows
 * (surface='catalog-matrix'). UX in SavedViewsMenu unchanged; only
 * the storage primitives became async.
 *
 * Active view ID stays in localStorage — that's a per-device
 * preference (which view this operator last applied here), not a
 * shareable artifact.
 *
 * Built-in views stay as a static const — they don't need a server
 * round-trip and operators can't edit/delete them anyway.
 */

import { getBackendUrl } from '@/lib/backend-url'

export interface SavedView {
  id: string
  name: string
  columnIds: string[]
  search?: string
  sortBy?: string
  sortDir?: 'asc' | 'desc'
  builtin?: boolean
}

// ────────────────────────────────────────────────────────────────────
// Pre-seeded built-in views — read-only, no server round-trip needed
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
// Server storage (custom views — shared across operators)
// ────────────────────────────────────────────────────────────────────

const SURFACE = 'catalog-matrix'

interface ServerRow {
  id: string
  name: string
  filters: { columnIds?: string[]; search?: string; sortBy?: string; sortDir?: 'asc' | 'desc' } | null
}

/** Server → SavedView mapper. Filters JSON holds our per-view state. */
function fromServer(row: ServerRow): SavedView {
  const f = row.filters ?? {}
  return {
    id: row.id,
    name: row.name,
    columnIds: Array.isArray(f.columnIds) ? f.columnIds : [],
    search: f.search,
    sortBy: f.sortBy,
    sortDir: f.sortDir,
  }
}

/** Load custom (operator-created) views. Built-ins are listed
 *  separately by the consumer. Returns [] on failure (the menu
 *  surfaces built-ins regardless so a backend hiccup doesn't strand
 *  the operator). */
export async function loadCustomViews(): Promise<SavedView[]> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/saved-views?surface=${SURFACE}`, {
      cache: 'no-store',
    })
    if (!r.ok) return []
    const data = (await r.json()) as { items: ServerRow[] }
    return data.items.map(fromServer)
  } catch {
    return []
  }
}

/** Create a new custom view server-side. Returns the saved view with
 *  the server's generated id. */
export async function createCustomView(input: {
  name: string
  columnIds: string[]
  search?: string
}): Promise<SavedView | null> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/saved-views`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: input.name.trim() || 'Untitled view',
        surface: SURFACE,
        filters: {
          columnIds: input.columnIds,
          search: input.search?.trim() || undefined,
        },
      }),
    })
    if (!r.ok) return null
    const data = (await r.json()) as { item?: ServerRow } | ServerRow
    const row = (data as { item?: ServerRow }).item ?? (data as ServerRow)
    return row && row.id ? fromServer(row) : null
  } catch {
    return null
  }
}

/** Delete a custom view server-side. Returns true on success. */
export async function deleteCustomView(id: string): Promise<boolean> {
  try {
    const r = await fetch(`${getBackendUrl()}/api/saved-views/${id}`, {
      method: 'DELETE',
    })
    return r.ok
  } catch {
    return false
  }
}

// ────────────────────────────────────────────────────────────────────
// Active-view ID — per-device preference, stays in localStorage
// ────────────────────────────────────────────────────────────────────

const ACTIVE_KEY = 'catalog-matrix:active-view:v1'

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
