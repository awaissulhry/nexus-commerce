'use client'

/**
 * FBA shipments (Fulfillment › Outbound, Owner 2026-10-08) — every product family's FBA drafts and shipments in one list:
 *
 *     FBA shipments                                              [New draft]
 *     Drafts 1 · In progress 2 · Done 14
 *     Name · To · From · SKUs · Units · Boxes · Status · Updated     ← a row opens the shipment (`?plan=`)
 *     [Load more]
 *
 * "Send to FBA…" in a Matrix fills the open draft for its From + To; "New draft" here picks SKUs and opens the same
 * dialog. The side panel edits and sends a draft, and follows a plan to Amazon (the Matrix drawer's own view). Live: the
 * server's plan events re-read the list and the panel.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { Plus } from 'lucide-react'

import { FBA_PLAN_VIEWS, FBA_SEND_COPY, type FbaPlanListView, type FbaPlanView } from '@nexus/shared/fba-send'

import { Banner, EmptyState, ProgressBar, ResourcePickerDialog, Tabs, ToastProvider, tabPanelProps, useToast } from '@/design-system/components'
import type { MediaChoice } from '@/design-system/lib/media-choice'
// The DS grid's DataGrid (AG Grid, the same props) — the retiring `components/DataGrid` is on the grid-kit ratchet.
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PageHeader } from '@/design-system/patterns'
import { Button, Pill } from '@/design-system/primitives'
import { getBackendUrl } from '@/lib/backend-url'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { useListingEvents } from '@/lib/sync/use-listing-events'
import { useRouter } from '@/lib/workspaces/navigation'

import { SendToFbaDialog, type SendToFbaAdded } from '@/app/products/[id]/edit/_studio/matrix/fba/SendToFbaDialog'
import { FBA_ROUTES, isFbaPlanEvent, isRunning, readPlanListAnswer, statusTone } from '@/app/products/[id]/edit/_studio/matrix/fba/plansDrawer'
import { DONE_COPY } from '@/app/products/[id]/edit/_studio/matrix/fba/sendToFba'
import { FbaShipmentPanel } from './FbaShipmentPanel'
import { PAGE_COPY, defaultView, pageQuery, productChoices, productSearchUrl, shipmentRow, tabLabel, viewOf, type ShipmentRow } from './fbaShipments'
import styles from './fbaShipments.module.css'

const TABS_ID = 'fba-shipments'
const PAGE_SIZE = 50
const LIVE_DEBOUNCE_MS = 400

export default function FbaShipmentsClient() {
  return (
    <ToastProvider>
      <FbaShipments />
    </ToastProvider>
  )
}

interface ListState {
  view: FbaPlanListView
  plans: FbaPlanView[]
  next: string | null
  counts: Record<FbaPlanListView, number> | null
  loading: boolean
  loadingMore: boolean
  error: string | null
}

function FbaShipments() {
  useListingEvents()
  const router = useRouter()
  const params = useSearchParams()
  const toast = useToast()
  const asked = viewOf(params.get('view'))
  const planId = params.get('plan')

  const [list, setList] = useState<ListState>({ view: asked ?? 'drafts', plans: [], next: null, counts: null, loading: true, loadingMore: false, error: null })
  const view: FbaPlanListView = asked ?? (list.counts ? defaultView(list.counts) : 'drafts')

  const go = useCallback((change: { view?: FbaPlanListView | null; plan?: string | null }) => {
    router.replace(pageQuery(params.toString(), change), { scroll: false })
  }, [router, params])

  /* ── reading ─────────────────────────────────────────────────────────────────────────────────── */

  const seq = useRef(0)
  const load = useCallback(async (which: FbaPlanListView, opts: { more?: string | null; quiet?: boolean } = {}) => {
    const mine = ++seq.current
    setList((l) => ({ ...l, view: which, loading: !opts.more && !opts.quiet ? true : l.loading, loadingMore: !!opts.more, error: null }))
    try {
      let response: Response
      try { response = await fetch(`${getBackendUrl()}${FBA_ROUTES.list(which, opts.more ?? null, PAGE_SIZE)}`) } catch { throw new Error('No answer from the server.') }
      const answer = readPlanListAnswer(response.status, await response.json().catch(() => null))
      if (mine !== seq.current) return
      setList((l) => ({
        view: which,
        plans: opts.more ? [...l.plans, ...answer.plans.filter((p) => !l.plans.some((x) => x.id === p.id))] : answer.plans,
        next: answer.next,
        counts: answer.counts,
        loading: false,
        loadingMore: false,
        error: null,
      }))
    } catch (e) {
      if (mine !== seq.current) return
      setList((l) => ({ ...l, loading: false, loadingMore: false, error: e instanceof Error ? e.message : String(e) }))
    }
  }, [])

  useEffect(() => { void load(view) }, [view, load])

  // Live: a plan event (any family) re-reads the tab, quietly — coalesced.
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null)
  const viewRef = useRef(view)
  viewRef.current = view
  const reload = useCallback(() => {
    if (debounce.current) return
    debounce.current = setTimeout(() => { debounce.current = null; void load(viewRef.current, { quiet: true }) }, LIVE_DEBOUNCE_MS)
  }, [load])
  useInvalidationChannel('inventory.stock_changed', (event) => { if (isFbaPlanEvent(event)) reload() })
  useEffect(() => () => { if (debounce.current) clearTimeout(debounce.current) }, [])
  // While the job moves a plan on this tab, read again every 8 s.
  useEffect(() => {
    if (!list.plans.some((p) => isRunning(p.status))) return
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(viewRef.current, { quiet: true }) }, 8_000)
    return () => clearInterval(t)
  }, [list.plans, load])

  /* ── the list ────────────────────────────────────────────────────────────────────────────────── */

  const rows = useMemo(() => list.plans.map((p) => ({ plan: p, row: shipmentRow(p) })), [list.plans])
  type Row = { plan: FbaPlanView; row: ShipmentRow }
  const columns: Column<Row>[] = [
    { key: 'name', label: PAGE_COPY.columns.name, width: 260, render: (r) => <span className={styles.name}>{r.row.name}</span> },
    { key: 'to', label: PAGE_COPY.columns.to, width: 120, render: (r) => r.row.to },
    { key: 'from', label: PAGE_COPY.columns.from, width: 110, render: (r) => r.row.from },
    { key: 'skus', label: PAGE_COPY.columns.skus, width: 80, numeric: true, render: (r) => r.row.skus.toLocaleString('en-GB') },
    { key: 'units', label: PAGE_COPY.columns.units, width: 90, numeric: true, render: (r) => r.row.units.toLocaleString('en-GB') },
    { key: 'boxes', label: PAGE_COPY.columns.boxes, width: 80, numeric: true, render: (r) => r.row.boxes },
    { key: 'status', label: PAGE_COPY.columns.status, width: 170, render: (r) => <Pill tone={statusTone(r.plan.status)} dot={isRunning(r.plan.status)}>{r.row.status}</Pill> },
    { key: 'updated', label: PAGE_COPY.columns.updated, width: 120, render: (r) => <span title={r.row.updatedAt}>{r.row.updated}</span> },
  ]

  /* ── New draft: pick SKUs, then the Matrix's own dialog ──────────────────────────────────────── */

  const [picking, setPicking] = useState(false)
  const [pickQuery, setPickQuery] = useState('')
  const [pickChoices, setPickChoices] = useState<MediaChoice[]>([])
  const [pickLoading, setPickLoading] = useState(false)
  const [pickError, setPickError] = useState<string | null>(null)
  const [sendTo, setSendTo] = useState<string[] | null>(null)

  useEffect(() => {
    if (!picking) return
    const q = pickQuery.trim()
    if (q.length < 2) { setPickChoices([]); setPickLoading(false); return }
    const ctrl = new AbortController()
    setPickLoading(true); setPickError(null)
    const t = setTimeout(() => {
      fetch(`${getBackendUrl()}${productSearchUrl(q)}`, { signal: ctrl.signal })
        .then(async (res) => {
          const body = await res.json().catch(() => null)
          if (!res.ok) throw new Error(`The search did not answer (HTTP ${res.status})`)
          setPickChoices(productChoices(body))
        })
        .catch((e: unknown) => { if (!ctrl.signal.aborted) setPickError(e instanceof Error ? e.message : String(e)) })
        .finally(() => { if (!ctrl.signal.aborted) setPickLoading(false) })
    }, 250)
    return () => { ctrl.abort(); clearTimeout(t) }
  }, [picking, pickQuery])

  const onAdded = useCallback((added: SendToFbaAdded | null) => {
    setSendTo(null)
    if (!added) return
    toast.toast(DONE_COPY.added(added.units), 'success')
    go({ view: 'drafts', plan: added.planId })
    reload()
  }, [toast, go, reload])

  /* ── render ──────────────────────────────────────────────────────────────────────────────────── */

  const tabs = FBA_PLAN_VIEWS.map((v) => ({ id: v, label: tabLabel(v), count: list.counts ? list.counts[v] : null }))
  const empty = PAGE_COPY.empty[view]

  return (
    <div className={styles.page}>
      <PageHeader
        title={FBA_SEND_COPY.pageTitle}
        subtitle={PAGE_COPY.subtitle}
        actions={(
          <Button size="sm" variant="primary" onClick={() => { setPickQuery(''); setPickChoices([]); setPicking(true) }}>
            <Plus size={14} aria-hidden="true" /> {FBA_SEND_COPY.newDraft}
          </Button>
        )}
      />
      <Tabs ariaLabel={PAGE_COPY.tabsLabel} tabs={tabs} active={view} onChange={(id) => go({ view: viewOf(id) })} />
      <div {...tabPanelProps(TABS_ID, view)} className={styles.panel}>
        {list.error && (
          <Banner tone={list.plans.length ? 'warning' : 'danger'} title={PAGE_COPY.readFailed}
            action={<Button size="sm" onClick={() => void load(view)}>Try again</Button>}>
            {list.error}
          </Banner>
        )}
        {list.loading && list.plans.length === 0 ? <ProgressBar indeterminate ariaLabel="Reading FBA shipments" /> : (
          <DataGrid<Row>
            ariaLabel={PAGE_COPY.tabsLabel}
            size="sm"
            keyboardScroll
            columns={columns}
            rows={rows}
            rowKey={(r) => r.plan.id}
            rowClassName={(r) => (r.plan.id === planId ? `${styles.row} ${styles.open}` : styles.row)}
            rowProps={(r) => ({
              'aria-label': `${r.row.name} · ${r.row.status}`,
              title: PAGE_COPY.rowTitle,
              onClick: () => go({ plan: r.plan.id }),
              onKeyDown: (event: ReactKeyboardEvent<HTMLTableRowElement>) => {
                if (event.key !== 'Enter') return
                event.preventDefault()
                go({ plan: r.plan.id })
              },
            })}
            emptyState={<EmptyState title={empty.title} description={empty.description} />}
          />
        )}
        {list.next && (
          <div className={styles.more}>
            <Button size="sm" onClick={() => void load(view, { more: list.next })} disabled={list.loadingMore}>
              {list.loadingMore ? PAGE_COPY.loadingMore : PAGE_COPY.loadMore}
            </Button>
          </div>
        )}
      </div>

      <FbaShipmentPanel planId={planId} onClose={() => go({ plan: null })} onChanged={reload} />

      <ResourcePickerDialog
        open={picking} title={PAGE_COPY.newPickTitle} noun={PAGE_COPY.pickNoun} choices={pickChoices} initialSelected={[]}
        search="remote" query={pickQuery} onQueryChange={setPickQuery} searchPlaceholder={PAGE_COPY.pickSearch}
        loading={pickLoading} error={pickError}
        onDone={(values) => { setPicking(false); if (values.length) setSendTo(values) }} onCancel={() => setPicking(false)}
      />
      {sendTo && <SendToFbaDialog target={{ productIds: sendTo }} onClose={onAdded} />}
    </div>
  )
}
