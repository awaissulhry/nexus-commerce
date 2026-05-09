'use client'

// T.6 — saved views were localStorage-only; now they're server-backed
// via /api/bulk-ops/templates so configurations survive across
// browsers and can be shared. The sync API surface here is preserved
// so call sites don't have to restructure into async/await — a
// module-level in-memory cache feeds the synchronous reads, and an
// async hydrate() call refreshes the cache from the server. Mutations
// (save/delete) hit the API, then refresh the cache, then dispatch
// `nexus:views-changed` so the React component re-reads via its
// existing event listener.

import { getBackendUrl } from '@/lib/backend-url'
import type { FilterState } from './types'
import type { SortKey } from './multi-sort'
import type { ConditionalRule } from './conditional-format'

const ACTIVE_VIEW_KEY = 'nexus_bulkops_active_view'

/**
 * W4.4 — view extras stored INSIDE filterState's jsonb under a
 * reserved `_viewExtras` key so we can persist Wave 4 state without
 * a Prisma migration. Migration to a dedicated column lands in a
 * follow-up; this keeps the change risk-controlled while concurrent
 * agents are committing migrations daily.
 *
 * The server's filterState jsonb is opaque, so packing the extras
 * here is a no-op as far as the route layer is concerned. When this
 * commit is in front of operators the new state survives a refresh;
 * when the migration lands later, a one-shot migration walks every
 * row and lifts the extras out into the dedicated column.
 */
export interface ViewExtras {
  sortKeys?: SortKey[]
  conditionalRules?: ConditionalRule[]
  groupByColumnId?: string
}

export const VIEW_EXTRAS_KEY = '_viewExtras' as const

export interface SavedView {
  id: string
  name: string
  columnIds: string[]
  /** T.6 — full filter state. Optional for backward compat with the
   *  pre-T.6 hardcoded default views which don't carry filters. */
  filterState?: FilterState
  channels?: string[]
  productTypes?: string[]
  /** W.10 — group keys collapsed in the band when the view was saved.
   *  Restored on selectView so the user's preferred density survives. */
  collapsedGroups?: string[]
  /** W4.4 — Wave 4 view state (sort / rules / group). Round-tripped
   *  through filterState's jsonb — see ViewExtras above. */
  extras?: ViewExtras
  isDefault?: boolean
  createdAt: number
  /** Set once the view is server-backed; absent on hardcoded defaults. */
  serverBacked?: boolean
}

/**
 * Lift the W4.4 extras out of a filterState payload. Returns the
 * cleaned filterState (without the reserved key) AND the extras.
 * Both parts are optional: when no extras are present, returns the
 * original filterState as-is.
 */
export function unpackViewExtras(filterState: FilterState | null | undefined): {
  filterState: FilterState | undefined
  extras: ViewExtras | undefined
} {
  if (!filterState || typeof filterState !== 'object') {
    return { filterState: filterState ?? undefined, extras: undefined }
  }
  const raw = filterState as unknown as Record<string, unknown>
  const extrasField = raw[VIEW_EXTRAS_KEY]
  if (!extrasField || typeof extrasField !== 'object') {
    return { filterState, extras: undefined }
  }
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { [VIEW_EXTRAS_KEY]: _drop, ...cleanedRaw } = raw
  return {
    filterState: cleanedRaw as unknown as FilterState,
    extras: extrasField as ViewExtras,
  }
}

/** Inverse of unpackViewExtras — pack extras back into filterState
 *  before sending to the server. */
export function packViewExtras(
  filterState: FilterState | null | undefined,
  extras: ViewExtras | undefined,
): FilterState | null {
  if (!extras || Object.keys(extras).length === 0) {
    return filterState ?? null
  }
  const base = (filterState ?? {}) as Record<string, unknown>
  return {
    ...base,
    [VIEW_EXTRAS_KEY]: extras,
  } as unknown as FilterState
}

export const DEFAULT_VIEWS: ReadonlyArray<SavedView> = [
  {
    id: 'default',
    name: 'Default',
    columnIds: [
      'sku',
      'name',
      'brand',
      'status',
      'fulfillmentChannel',
      'basePrice',
      'costPrice',
      'totalStock',
      'amazonAsin',
    ],
    isDefault: true,
    createdAt: 0,
  },
  {
    id: 'pricing',
    name: 'Pricing Focus',
    columnIds: [
      'sku',
      'name',
      'costPrice',
      'minMargin',
      'minPrice',
      'basePrice',
      'maxPrice',
      'totalStock',
    ],
    createdAt: 0,
  },
  {
    id: 'inventory',
    name: 'Inventory Quick',
    columnIds: [
      'sku',
      'name',
      'totalStock',
      'lowStockThreshold',
      'fulfillmentChannel',
      'status',
    ],
    createdAt: 0,
  },
]

// ── Server cache ────────────────────────────────────────────────
// Synchronous reads come from this; async hydrate fills it.

let serverViews: SavedView[] = []
let hydrating = false

interface ServerTemplate {
  id: string
  name: string
  description: string | null
  columnIds: string[]
  filterState: FilterState | null
  enabledChannels: string[]
  enabledProductTypes: string[]
  collapsedGroups: string[]
  createdAt: string
  updatedAt: string
}

function fromServer(t: ServerTemplate): SavedView {
  // W4.4 — split out the Wave 4 view extras packed into filterState
  // before handing the cleaned filterState to the rest of the app.
  const { filterState, extras } = unpackViewExtras(t.filterState)
  return {
    id: t.id,
    name: t.name,
    columnIds: t.columnIds,
    filterState,
    channels: t.enabledChannels,
    productTypes: t.enabledProductTypes,
    collapsedGroups: t.collapsedGroups ?? [],
    extras,
    createdAt: new Date(t.createdAt).getTime(),
    serverBacked: true,
  }
}

function emitChange() {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('nexus:views-changed'))
}

/** Fire-and-forget async pull. Call once on mount; the parent's
 *  existing nexus:views-changed listener picks up the cache update
 *  and re-renders the saved-views dropdown. Also runs the one-shot
 *  legacy-localStorage migration (U.3) — see migrateLegacyViews. */
export async function hydrateViewsFromServer(): Promise<void> {
  if (hydrating) return
  hydrating = true
  try {
    // U.3 — migrate any pre-T.6 localStorage saved-views before we
    // fetch the server list, so the migrated entries land in the same
    // payload. Idempotent: clears the legacy key on success.
    await migrateLegacyViews()
    const res = await fetch(`${getBackendUrl()}/api/bulk-ops/templates`, {
      cache: 'no-store',
    })
    if (!res.ok) return
    const json = await res.json()
    const list = Array.isArray(json.templates)
      ? (json.templates as ServerTemplate[])
      : []
    serverViews = list.map(fromServer)
    emitChange()
  } catch {
    /* network failure is non-fatal — saved-views just stays at the
     *  hardcoded defaults until the next mount or manual retry */
  } finally {
    hydrating = false
  }
}

const LEGACY_STORAGE_KEY = 'nexus_bulkops_views_v1'

/** U.3 — one-shot upload of pre-T.6 localStorage views to the server.
 *  No-op when the legacy key is empty / missing. Clears the key on
 *  success so subsequent mounts skip this. Failures keep the legacy
 *  key intact so the next attempt can retry. */
async function migrateLegacyViews(): Promise<void> {
  if (typeof window === 'undefined') return
  let raw: string | null
  try {
    raw = window.localStorage.getItem(LEGACY_STORAGE_KEY)
  } catch {
    return
  }
  if (!raw) return
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Corrupt entry — drop it so we don't keep retrying.
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    return
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
    return
  }
  let allOk = true
  for (const v of parsed as Array<Partial<SavedView>>) {
    if (!v.name || !Array.isArray(v.columnIds) || v.columnIds.length === 0) {
      continue
    }
    try {
      const res = await fetch(`${getBackendUrl()}/api/bulk-ops/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: `${v.name} (migrated)`,
          columnIds: v.columnIds,
          enabledChannels: v.channels ?? [],
          enabledProductTypes: v.productTypes ?? [],
          // Filter state didn't exist pre-T.6; leave null.
          filterState: null,
        }),
      })
      if (!res.ok) allOk = false
    } catch {
      allOk = false
    }
  }
  if (allOk) {
    try {
      window.localStorage.removeItem(LEGACY_STORAGE_KEY)
    } catch {
      /* ignore */
    }
  }
}

export function loadAllViews(): SavedView[] {
  return [...DEFAULT_VIEWS, ...serverViews]
}

/** Save (create or update) a server-side template. Returns the
 *  persisted SavedView. */
export async function saveUserView(
  view: Omit<SavedView, 'createdAt' | 'serverBacked'>,
): Promise<SavedView> {
  // W4.4 — pack Wave 4 view extras into the filterState jsonb so we
  // can round-trip them without a schema change. The server treats
  // filterState as opaque so this is transparent at the route layer.
  const filterStateForServer = packViewExtras(view.filterState, view.extras)
  const body: Record<string, unknown> = {
    name: view.name,
    columnIds: view.columnIds,
    filterState: filterStateForServer,
    enabledChannels: view.channels ?? [],
    enabledProductTypes: view.productTypes ?? [],
    collapsedGroups: view.collapsedGroups ?? [],
  }
  // If the id already exists in the server cache, PATCH; otherwise POST.
  const existing = serverViews.find((v) => v.id === view.id)
  let template: ServerTemplate | null = null
  try {
    if (existing) {
      const res = await fetch(
        `${getBackendUrl()}/api/bulk-ops/templates/${view.id}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      )
      if (res.ok) {
        const json = await res.json()
        template = json.template as ServerTemplate
      }
    } else {
      const res = await fetch(`${getBackendUrl()}/api/bulk-ops/templates`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (res.ok) {
        const json = await res.json()
        template = json.template as ServerTemplate
      }
    }
  } catch {
    /* fall through to local fallback below */
  }
  if (!template) {
    // Network failure — keep an in-memory copy so the user's work
    // isn't lost. Will sync on next successful hydrate.
    const fallback: SavedView = {
      ...view,
      createdAt: Date.now(),
      serverBacked: false,
    }
    serverViews = [
      ...serverViews.filter((v) => v.id !== view.id),
      fallback,
    ]
    emitChange()
    return fallback
  }
  const next = fromServer(template)
  serverViews = [
    ...serverViews.filter((v) => v.id !== next.id),
    next,
  ]
  emitChange()
  return next
}

export async function deleteUserView(id: string): Promise<void> {
  if (DEFAULT_VIEWS.some((v) => v.id === id)) return
  const existing = serverViews.find((v) => v.id === id)
  serverViews = serverViews.filter((v) => v.id !== id)
  emitChange()
  if (!existing?.serverBacked) return
  try {
    await fetch(`${getBackendUrl()}/api/bulk-ops/templates/${id}`, {
      method: 'DELETE',
    })
  } catch {
    /* swallow — local state already updated; next hydrate will
     *  reconcile if the server still has the row */
  }
}

export function isDefaultView(id: string): boolean {
  return DEFAULT_VIEWS.some((v) => v.id === id)
}

export function getActiveViewId(): string {
  if (typeof window === 'undefined') return DEFAULT_VIEWS[0].id
  return (
    window.localStorage.getItem(ACTIVE_VIEW_KEY) ?? DEFAULT_VIEWS[0].id
  )
}

export function setActiveViewId(id: string) {
  if (typeof window === 'undefined') return
  window.localStorage.setItem(ACTIVE_VIEW_KEY, id)
}
