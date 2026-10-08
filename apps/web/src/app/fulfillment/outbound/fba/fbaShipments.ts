/**
 * The FBA shipments page (Fulfillment › Outbound, Owner 2026-10-08) — the pure part: the URL state (`?view=`, `?plan=`),
 * the list's cells, the empty states and the product search the draft's "Add SKUs" uses. The page shows every product
 * family's drafts and plans in one list; a row opens the shipment in a side panel. The plan's own view and clicks are
 * the Matrix drawer's (`matrix/fba/FbaPlanDetail.tsx`); a draft is edited with the Matrix dialog's form
 * (`matrix/fba/FbaSendForm.tsx`).
 */
import { FBA_PLAN_VIEWS, FBA_SEND_COPY, type FbaPlanListView, type FbaPlanView } from '@nexus/shared/fba-send'
import type { MediaChoice } from '@/design-system/lib/media-choice'

import { clockText, planBoxesText, planName, planUpdatedAt, statusText } from '@/app/products/[id]/edit/_studio/matrix/fba/plansDrawer'

/** `?view=` → a tab; anything else → null (the page picks Drafts, or In progress when there is no draft). */
export function viewOf(raw: string | null | undefined): FbaPlanListView | null {
  return raw && (FBA_PLAN_VIEWS as readonly string[]).includes(raw) ? (raw as FbaPlanListView) : null
}

/** The tab shown when the URL names none: Drafts while there is one, else In progress, else Drafts. */
export function defaultView(counts: Readonly<Record<FbaPlanListView, number>> | null): FbaPlanListView {
  if (!counts) return 'drafts'
  if (counts.drafts > 0) return 'drafts'
  return counts.active > 0 ? 'active' : 'drafts'
}

/** The page's query after a change: a tab (the panel closes), or a shipment opened / closed (the tab stays). */
export function pageQuery(current: string, change: { view?: FbaPlanListView | null; plan?: string | null }): string {
  const next = new URLSearchParams(current)
  if (change.view !== undefined) {
    if (change.view) next.set('view', change.view)
    else next.delete('view')
    next.delete('plan')
  }
  if (change.plan !== undefined) {
    if (change.plan) next.set('plan', change.plan)
    else next.delete('plan')
  }
  const q = next.toString()
  return q ? `?${q}` : '?'
}

export const PAGE_COPY = {
  subtitle: 'Drafts and shipments to Amazon FBA, for every product.',
  tabsLabel: 'FBA shipments',
  columns: { name: 'Name', to: 'To', from: 'From', skus: 'SKUs', units: 'Units', boxes: 'Boxes', status: 'Status', updated: 'Updated' },
  empty: {
    drafts: { title: 'No drafts', description: 'Send to FBA… in a product\'s Matrix adds SKUs to a draft. New draft starts one here.' },
    active: { title: 'Nothing in progress', description: 'A draft you send to Amazon shows here until it is at Amazon.' },
    done: { title: 'Nothing done yet', description: 'Shipments at Amazon and cancelled plans show here.' },
  } as Record<FbaPlanListView, { title: string; description: string }>,
  loadMore: 'Load more',
  loadingMore: 'Loading…',
  readFailed: 'FBA shipments could not be read',
  rowTitle: 'Open this shipment',
  pickTitle: 'Add SKUs',
  pickNoun: { one: 'SKU', other: 'SKUs' },
  pickSearch: 'Search a SKU or a name',
  newPickTitle: 'New draft: choose SKUs',
  panelClose: 'Close the shipment',
  notFound: 'This shipment is not there any more.',
} as const

/** One row of the list, as words (the grid draws them; a test reads them). */
export interface ShipmentRow {
  id: string
  name: string
  to: string
  from: string
  skus: number
  units: number
  boxes: string
  status: string
  updated: string
  updatedAt: string
}

export function shipmentRow(plan: FbaPlanView, opts: { now?: number; timeZone?: string } = {}): ShipmentRow {
  const updatedAt = planUpdatedAt(plan)
  return {
    id: plan.id,
    name: planName(plan),
    to: plan.market ? `Amazon ${plan.market}` : '—',
    from: plan.from?.code || plan.from?.name || '—',
    skus: plan.skus,
    units: plan.units,
    boxes: planBoxesText(plan),
    status: statusText(plan.status),
    updated: clockText(updatedAt, opts),
    updatedAt,
  }
}

/** The tab's label with its count. */
export const tabLabel = (view: FbaPlanListView): string => FBA_SEND_COPY.views[view]

/* ── "Add SKUs": the catalogue search (`GET /api/products?search=`) ────────────────────────────── */

export const productSearchUrl = (query: string, limit = 20): string =>
  `/api/products?search=${encodeURIComponent(query.trim())}&limit=${limit}`

/** The search answer as picker rows: the SKU, its name under it, its photo; malformed rows dropped, each id once. */
export function productChoices(body: unknown): MediaChoice[] {
  const list = body && typeof body === 'object' ? (body as Record<string, unknown>).products : null
  if (!Array.isArray(list)) return []
  const seen = new Set<string>()
  return list.flatMap((raw): MediaChoice[] => {
    const p = raw as Record<string, unknown> | null
    if (!p || typeof p.id !== 'string' || seen.has(p.id)) return []
    seen.add(p.id)
    const sku = typeof p.sku === 'string' && p.sku.trim() ? p.sku : p.id
    const name = typeof p.name === 'string' ? p.name : ''
    const image = typeof p.imageUrl === 'string' && p.imageUrl ? p.imageUrl : null
    return [{ value: p.id, label: sku, detail: name || undefined, image }]
  })
}
