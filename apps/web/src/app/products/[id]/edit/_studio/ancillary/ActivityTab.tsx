'use client'

/** Activity reads only explicitly attributed product/listing events. Audit access
 * remains with the audit log's existing permission boundary. */
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

import type { HistoryRun, HistoryTotals } from '@nexus/shared/publication-history'
import type { StudioPublishScope, StudioRetrySelection } from '@nexus/shared/studio-publication'
import { fillResultSentence } from '@nexus/shared/publish-actions'
import { Button, Pill, SegmentedControl } from '@/design-system/primitives'

import { Banner, ProgressBar, useToast } from '@/design-system/components'
import { PublishRuns } from '@/app/products/_publication/history/PublishRuns'
import { PublishHistoryHost, type PublishHistoryHostValue } from '@/app/products/_publication/history/PublishRunDrawer'
import { historyRequest, parseHistoryDeepLink, requestSheetLanding, sheetFieldHints, sheetRowIdOf, type RunUndo } from '@/app/products/_publication/history/runActions'
import { useStudioProduct, useStudioRecord, useStudioScope } from '../contracts'
import { StudioPublishDialog } from '../StudioPublishDialog'
import { readPublishActions, writePublishActions } from '../sheet/publishActionsApi'
import { useWorkspaceRead } from '../useWorkspaceRead'
import {
  groupEvents, readValue, summariseActivity, type EventKind, type ProductEvent,
} from './activity/readEvents'
import styles from './analytics.module.css'

const KIND_TONE: Record<EventKind, 'info' | 'success' | 'warning' | 'neutral'> = {
  images: 'info', import: 'neutral', bulk: 'warning', other: 'neutral',
}

interface ActivityPage { events: ProductEvent[]; nextCursor: string | null; coverageNote: string }

/** Everything attributed to this product. `viewSwitch` sits above it, in the same page. */
function AllActivity({ viewSwitch }: { viewSwitch: ReactNode }) {
  const [events, setEvents] = useState<ProductEvent[]>([])
  const [cursor, setCursor] = useState<string>()
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const read = useWorkspaceRead<ActivityPage>('activity', cursor ? new URLSearchParams({ cursor }).toString() : '')
  useEffect(() => {
    if (read.data) setEvents(previous => cursor ? [...previous, ...read.data!.events.filter(event => !previous.some(old => old.id === event.id))] : read.data!.events)
  }, [read.data, cursor])

  const groups = useMemo(() => groupEvents(events ?? []), [events])
  const summary = useMemo(() => summariseActivity(events ?? []), [events])

  const toggle = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id); else next.add(id)
      return next
    })
  }, [])

  return (
    <div className={styles.page}>
      {viewSwitch}
      <header className={styles.head}>
        <h2 className={styles.title}>Activity</h2>
        {summary.total > 0 && (
          <>
            <Pill tone="neutral">{summary.total} {summary.total === 1 ? 'event' : 'events'}</Pill>
            {summary.firstAt && (
              <span className={styles.unknown}>
                since {new Date(summary.firstAt).toLocaleDateString()}
              </span>
            )}
          </>
        )}
      </header>

      {read.loading && <ProgressBar indeterminate ariaLabel="Reading activity for the selected scope" />}
      {read.error && <Banner tone="danger">{read.error}</Banner>}
      {read.data && <Banner tone="neutral">{read.data.coverageNote}</Banner>}
      {!read.loading && !read.error && summary.total === 0 && <p className={styles.state}>No attributed activity has been recorded in this scope.</p>}

      {groups.length > 0 && (
        <section className={styles.card}>
          {groups.map((group) => {
            const r = group.reading
            const open = expanded.has(group.id)
            return (
              <div key={group.id} className={styles.eventRow}>
                <div className={styles.eventMain}>
                  <Pill tone={KIND_TONE[r.kind]}>{r.title}</Pill>
                  {/* A group states its own size — summarising, not dropping. */}
                  {group.grouped && (
                    <span className={styles.unknown}>{group.events.length} events</span>
                  )}
                  {r.detail && <span className={styles.eventDetail}>{r.detail}</span>}
                  {r.actor && <span className={styles.unknown}>{r.actor}</span>}
                  <span className={styles.spacer} />
                  <span className={styles.eventWhen}>
                    {new Date(group.at).toLocaleString()}
                  </span>
                  {/* Offered only where there is something behind it. */}
                  {r.fields && (
                    <Button size="sm" variant="ghost" onClick={() => toggle(group.id)}>
                      {open ? 'Hide' : `${r.fields.length} change${r.fields.length === 1 ? '' : 's'}`}
                    </Button>
                  )}
                </div>
                {open && r.fields && (
                  /*
                   * 🔴 A description list, not a grid and not a table.
                   *
                   * This is one or two field→value pairs inside an expanded row — a property list,
                   * which `<dl>` is the semantic element for. The programme rule that grid chrome
                   * lives in the engine is about GRIDS: there is nothing here to sort, filter,
                   * virtualise or customise, and mounting an AG instance per expanded row would put
                   * several on screen at once to render four words. It also counts against neither
                   * arm of `check-grid-kit-ratchet`, so this is not a way around the gate — the
                   * gate is green either way.
                   */
                  <dl className={styles.delta}>
                    {r.fields.map((f) => (
                      <div key={f.field}>
                        <dt>{f.field}</dt>
                        <dd className={f.value === null ? styles.unknown : undefined}>
                          {readValue(f.value)}
                        </dd>
                      </div>
                    ))}
                  </dl>
                )}
              </div>
            )
          })}
        </section>
      )}

      {read.data?.nextCursor && <Button disabled={read.loading} onClick={() => setCursor(read.data!.nextCursor!)}>Load earlier activity</Button>}
    </div>
  )
}

type ActivityView = 'publishes' | 'all'

/** The view in the URL (`?view=`), written with every other key kept; leaving Publishes drops the open run. */
function writeView(view: ActivityView) {
  const url = new URL(window.location.href)
  url.searchParams.set('view', view)
  if (view === 'all') { url.searchParams.delete('run'); url.searchParams.delete('sku') }
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`)
}

/**
 * Activity, in two views (sheet publish parity, step 4): this product's publish history, and everything else that
 * happened to it. Publishes is the default when the product has any. Deep link:
 * `?tab=activity&view=publishes&run=<id>[&sku=<sku>]` — the list opens the run, the drawer expands the SKU.
 */
export function ActivityTab() {
  const product = useStudioProduct()
  const scope = useStudioScope()
  const record = useStudioRecord()
  const [link] = useState(() => (typeof window === 'undefined' ? { view: null, run: null, sku: null } : parseHistoryDeepLink(window.location.search)))
  const [view, setView] = useState<ActivityView | null>(link.view)
  /** How many publishes this product's family has — the server's exact count. null = not read (or the read failed). */
  const [count, setCount] = useState<number | null>(null)

  useEffect(() => {
    const controller = new AbortController()
    historyRequest<HistoryTotals>(`/api/products/${encodeURIComponent(product.id)}/publications/counts`, { signal: controller.signal })
      .then(totals => {
        setCount(totals.total)
        setView(current => current ?? (totals.total > 0 ? 'publishes' : 'all'))
      })
      .catch(() => { if (!controller.signal.aborted) setView(current => current ?? 'all') })
    return () => controller.abort()
  }, [product.id])

  const choose = useCallback((next: string) => {
    const value: ActivityView = next === 'all' ? 'all' : 'publishes'
    setView(value)
    writeView(value)
  }, [])

  /*
   * "Show in sheet" lands on a row only on the destination the studio is showing now: the studio's market and
   * account writers each rebuild the scope keys from the CURRENT scope, so switching channel, market and account in
   * one step would undo itself. Same pattern as the Errors & Sync tab: one tab write plus the record. It lands on the
   * FIELD the channel named (build shape v2): the request (`requestSheetLanding`) carries the channel's field names, and
   * the sheet — the only one that knows its columns — maps them to a column and lands there with `landOnCell`.
   */
  /* "Publish failed products again…": a NEW review of the failed publish's destination with its failed fields ticked —
   * the studio's own Publish dialog, never a replay of the stored request. */
  const [retry, setRetry] = useState<StudioRetrySelection | null>(null)
  /* Undo of a selling change (D-M2 A): Status back to Active is set, then Publish opens on that destination. */
  const [undoReview, setUndoReview] = useState<StudioPublishScope | null>(null)
  const { toast } = useToast()
  const undoSelling = useCallback(async (undo: RunUndo) => {
    const { run } = undo
    if (!run.accountId) throw new Error('This publish did not record its account. Set Status to Active in the sheet and publish.')
    const destination = { channel: run.channel, marketplace: run.marketplace, accountId: run.accountId, aliasKey: run.aliasKey }
    // Compare-and-set: each row as it is stored now. A value someone set since is theirs: the write keeps it and says so.
    const stored = await readPublishActions(product.id, destination)
    const setAt = new Map(stored.rows.map(row => [row.listingId, row.status.setAt]))
    const listingIds = undo.listingIds.filter(id => setAt.has(id))
    if (!listingIds.length) throw new Error('These listings are no longer on this destination. Nothing was changed.')
    const result = await writePublishActions(product.id, { column: 'status', target: 'active' },
      { listingIds, expected: Object.fromEntries(listingIds.map(id => [id, setAt.get(id) ?? null])) })
    toast(`${fillResultSentence('Active', result)} Nothing is sent until you publish.`, result.applied.length ? 'success' : 'warning')
    if (result.applied.length) setUndoReview({ channel: run.channel, marketplace: run.marketplace ?? '', accountId: run.accountId })
  }, [product.id, toast])
  const host = useMemo<PublishHistoryHostValue>(() => ({
    focusSku: link.sku,
    publishAgain: selection => setRetry(selection),
    undoSelling,
    canShowInSheet: (run: HistoryRun) => run.channel === scope.scope && run.marketplace === scope.market
      && (!run.accountId || !scope.accountId || run.accountId === scope.accountId),
    showInSheet: (run, item) => {
      const rowId = sheetRowIdOf(run, item)
      if (rowId) requestSheetLanding({ rowId, fieldNames: sheetFieldHints(item), channel: run.channel, marketplace: run.marketplace })
      scope.setTab('sheet')
      if (rowId) record.open(rowId)
    },
  }), [link.sku, scope, record, undoSelling])

  const publishesLabel = count != null ? `Publishes (${count.toLocaleString('en-GB')})` : 'Publishes'
  const viewSwitch = (
    <SegmentedControl
      ariaLabel="Activity view"
      size="sm"
      value={view ?? 'publishes'}
      onChange={choose}
      options={[{ value: 'publishes', label: publishesLabel }, { value: 'all', label: 'All activity' }]}
    />
  )

  if (view === 'all') return <AllActivity viewSwitch={viewSwitch} />
  return (
    <div className={styles.page}>
      {viewSwitch}
      {view === null
        ? <ProgressBar indeterminate ariaLabel="Reading this product's publishes" />
        : (
          <PublishHistoryHost value={host}>
            <PublishRuns scope="product" productId={product.id} />
          </PublishHistoryHost>
        )}
      {undoReview && <StudioPublishDialog onClose={() => setUndoReview(null)} initialDestination={undoReview} />}
      {retry && <StudioPublishDialog onClose={() => setRetry(null)}
        initialDestination={{ channel: retry.destination.channel, marketplace: retry.destination.marketplace, accountId: retry.destination.accountId,
          ...(retry.destination.listingId ? { listingId: retry.destination.listingId } : {}) }}
        initialSelection={{ productIds: retry.productIds, fieldIds: retry.fieldIds }} />}
    </div>
  )
}
