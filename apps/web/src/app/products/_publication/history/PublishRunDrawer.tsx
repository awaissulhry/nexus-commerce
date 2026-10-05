'use client'

/**
 * Publish history — the detail of one run (sheet publish parity, step 4; plan docs/sheet-publish-parity/PLAN.md,
 * item 4, design agent B §5–§9).
 *
 * One drawer for every surface: the studio's Activity tab docks it beside its list; the business-wide history opens
 * it as a slide-over. It answers one question in order: what happened (pill + one sentence), when and by whom, the
 * steps, then each product — failed first — with what was sent and what the channel said.
 *
 * Honest by construction: nothing here invents a result. A run the channel never confirmed stays "Result unknown",
 * also after a person marks it as checked; "Publish failed products again…" opens a NEW review and never re-sends a
 * stored request; the stored answer is labelled as what Nexus saved, not as the channel's full report.
 *
 * Surface-specific powers (land on a sheet row, open a new review) come from `PublishHistoryHost`, so the list that
 * mounts this drawer does not have to pass them through.
 */
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Copy } from 'lucide-react'
import type { HistoryProduct, HistoryRun, HistoryRunDetail } from '@nexus/shared/publication-history'
import type { StudioPublishChange, StudioRetrySelection } from '@nexus/shared/studio-publication'
import { DELETE_OLD_SKU_AGAIN } from '@nexus/shared/publish-actions'
import { Button, FilterChip, Textarea } from '@/design-system/primitives'
import {
  Banner, ChangeReview, Disclosure, Drawer, DrawerOverlayCard, EmptyState, Field, JobProgress, KeyValue, ProgressBar, Timeline, useToast,
  type ChangeReviewItem, type KeyValueItem, type TimelineStep,
} from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishStatusPill, downloadCsv, publishFullTime, publishResultMeta } from '@/design-system/grid'
import { usePermission } from '@/lib/auth/AuthProvider'
import { listingUrl } from '@/app/products/[id]/edit/_studio/drawer/listingUrl'
import { publicationValueText } from '@/app/products/_publication/dialog/PublicationChanges'
import {
  KIND_LABEL, SOURCE_LABEL, changeStatusText, failedSkus, filterProducts, orderProducts, productFilterCounts, productsAsShown, resultsCsv, resultsFileName,
  runActionVisibility, runChangeLabel, runDestination, runHeadline, runListingLabel, runStatusMeta, runUndos, sentFieldsText, type ProductFilter, type RunUndo,
} from './runActions'
import { resultsText } from './runColumns'
import { usePublishRunDetail, type ListingRequest } from './usePublishRunDetail'
import styles from './PublishRunDrawer.module.css'

/** What the surface that mounts the history can do beyond reading it. Absent = this surface cannot. */
export interface PublishHistoryHostValue {
  /** Studio: land on this product's row in the sheet of the run's destination. */
  showInSheet?: (run: HistoryRun, product: HistoryProduct) => void
  /** Whether `showInSheet` can reach this run's destination from here. Absent = every run. */
  canShowInSheet?: (run: HistoryRun) => boolean
  /** Studio: open a NEW review of the run's destination with the failed products ticked. */
  publishAgain?: (selection: StudioRetrySelection, run: HistoryRun) => void
  /** Deep link `&sku=`: open the drawer with this product's row expanded. */
  focusSku?: string | null
  /**
   * Studio: put a selling change back (build shape v2, D-M2 A) — set Status back to Active on `undo.listingIds` and open
   * Publish on that destination. Nothing is sent from here. Resolves when the surface has done its part.
   */
  undoSelling?: (undo: RunUndo) => Promise<void> | void
}

const PublishHistoryHostContext = createContext<PublishHistoryHostValue>({})

export function PublishHistoryHost({ value, children }: { value: PublishHistoryHostValue; children: ReactNode }) {
  return <PublishHistoryHostContext.Provider value={value}>{children}</PublishHistoryHostContext.Provider>
}

/**
 * The docked panel's width. Exported because the list that mounts a dock must keep this much room free on its right:
 * the DS dock is a fixed slide-over (layout-v2 §5), so it covers whatever sits under it unless the host makes room.
 */
export const DOCK_WIDTH = 560

export interface PublishRunDrawerProps {
  runId: string | null
  mode: 'dock' | 'modal'
  onClose: () => void
  /** The run changed while open (a result arrived, or it was marked as checked): the list should read it again. */
  onRunChanged?: () => void
  /** Open one part of a Publish (`children`) in this drawer. Absent = parts are listed without a way in. */
  onOpenPart?: (runId: string) => void
  /** This run was opened from a Publish: go back to it. */
  onBack?: () => void
}

const FILTERS: Array<{ id: ProductFilter; label: string }> = [
  { id: 'all', label: 'All' }, { id: 'failed', label: 'Failed' }, { id: 'accepted', label: 'Accepted' }, { id: 'waiting', label: 'Waiting' },
]

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** A phone-width viewport: the drawer is full width there, and the products grid keeps three columns. */
function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(false)
  useEffect(() => {
    const query = window.matchMedia('(max-width: 639px)')
    const update = () => setNarrow(query.matches)
    update()
    query.addEventListener('change', update)
    return () => query.removeEventListener('change', update)
  }, [])
  return narrow
}

export function PublishRunDrawer({ runId, mode, onClose, onRunChanged, onOpenPart, onBack }: PublishRunDrawerProps) {
  const { state, detail, reload, checkNow, markChecked, retrySelection, deleteOldAgain, loadRequest } = usePublishRunDetail(runId)
  const host = useContext(PublishHistoryHostContext)
  const canPublish = usePermission('products.publish')
  const canDelete = usePermission('products.delete')
  const { toast } = useToast()
  const [filter, setFilter] = useState<ProductFilter>('all')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set())
  const [busy, setBusy] = useState<null | 'check' | 'mark' | 'again' | 'undo' | 'old-sku'>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [note, setNote] = useState('')
  const [announcement, setAnnouncement] = useState('')
  const narrow = useNarrow()

  // Every run opens clean: no filter, nothing expanded, no leftover confirmation.
  useEffect(() => {
    setFilter('all'); setExpanded(new Set()); setActionError(null); setConfirming(false); setNote(''); setAnnouncement('')
  }, [runId])

  const run = detail?.run ?? null
  const products = useMemo(() => (detail ? orderProducts(productsAsShown(detail.run, detail.products)) : []), [detail])

  // Deep link `&sku=`: expand that product once it is there.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    const sku = host.focusSku
    if (!sku || !detail || focused.current === `${detail.run.id}:${sku}`) return
    const product = detail.products.find(p => p.sku === sku)
    if (!product) return
    focused.current = `${detail.run.id}:${sku}`
    setExpanded(new Set([productKey(product)]))
  }, [host.focusSku, detail])

  // A change of the run while it is open: tell the list once, and a screen reader once when it finished.
  const previous = useRef<{ id: string; signature: string; state: HistoryRun['state'] } | null>(null)
  useEffect(() => {
    if (!run) return
    const signature = `${run.state}|${run.status}|${run.checkedAt ?? ''}|${run.finishedAt ?? ''}`
    const before = previous.current
    previous.current = { id: run.id, signature, state: run.state }
    if (!before || before.id !== run.id || before.signature === signature) return
    onRunChanged?.()
    if (before.state === 'in_progress' && run.state !== 'in_progress') setAnnouncement(`${runDestination(run)} publish finished. ${runHeadline(run)}`)
  }, [run, onRunChanged])

  const visibility = run ? runActionVisibility(run, { canPublish, canOpenReview: !!host.publishAgain, canDelete }, products, detail?.skuMoves ?? []) : null

  const act = useCallback(async (kind: 'check' | 'mark' | 'again' | 'undo' | 'old-sku', work: () => Promise<void>) => {
    setBusy(kind); setActionError(null)
    try { await work() } catch (error) { setActionError(error instanceof Error ? error.message : 'That did not work. Try again.') } finally { setBusy(null) }
  }, [])

  const onCheckNow = () => act('check', async () => { await checkNow(); toast('Nexus asked the channel again.', 'info') })
  // S10 — the old SKU of a moved Amazon listing: Nexus tries its delete again now; the run shows Amazon's answer.
  const onDeleteOldAgain = () => act('old-sku', async () => {
    const { moves } = await deleteOldAgain()
    const left = moves.filter(move => move.state === 'failed').length
    toast(left ? 'Amazon did not confirm the delete yet. The publish says why; Nexus keeps trying.' : 'Amazon took the delete of the old SKU.', left ? 'warning' : 'success')
  })
  const onMarkChecked = () => act('mark', async () => {
    await markChecked(note)
    setConfirming(false); setNote('')
    toast('Marked as checked. New publishes to this destination can start.', 'success')
  })
  const onPublishAgain = () => act('again', async () => {
    if (!run || !host.publishAgain) return
    const selection = await retrySelection()
    if (!selection.productIds.length) {
      // No failed product could be matched. Only say "all accepted" when no failed SKU was left unmatched.
      const unmatched = selection.unmatchedSkus.length
      toast(unmatched
        ? `${unmatched === 1 ? '1 failed SKU no longer matches' : `${unmatched} failed SKUs no longer match`} a product in this family. Open Publish and tick those products yourself.`
        : 'Every product of this publish was accepted. Nothing to publish again.', unmatched ? 'warning' : 'info')
      return
    }
    host.publishAgain(selection, run)
  })
  const onUndo = (undo: RunUndo) => act('undo', async () => {
    if (!host.undoSelling) return
    await host.undoSelling(undo)
  })
  const onDownload = () => {
    if (!run) return
    downloadCsv(resultsFileName(run), resultsCsv(run, products))
  }
  const onCopyFailed = async () => {
    const skus = failedSkus(products)
    try {
      await navigator.clipboard.writeText(skus.join('\n'))
      toast(`${plural(skus.length, 'SKU')} copied.`, 'success')
    } catch {
      toast('The browser did not allow copying. Download the results instead.', 'danger')
    }
  }

  const title = run ? `Publish · ${runDestination(run)}` : 'Publish'
  const subtitle = run ? `${runChangeLabel(run)} · ${SOURCE_LABEL[run.source]}` : undefined

  const footer = run && visibility ? (
    <div className={styles.footer}>
      {visibility.checkNow && <Button size="md" onClick={onCheckNow} disabled={busy !== null}>{busy === 'check' ? 'Checking…' : 'Check now'}</Button>}
      {visibility.markChecked && <Button size="md" onClick={() => { setConfirming(true); setActionError(null) }} disabled={busy !== null}>Mark as checked…</Button>}
      {visibility.publishAgain && <Button size="md" variant="primary" onClick={onPublishAgain} disabled={busy !== null}>{busy === 'again' ? 'Preparing…' : 'Publish failed products again…'}</Button>}
      {visibility.deleteOldAgain && <Button size="md" variant="danger" onClick={onDeleteOldAgain} disabled={busy !== null}>{busy === 'old-sku' ? 'Deleting…' : DELETE_OLD_SKU_AGAIN}</Button>}
      {visibility.download && <Button size="md" onClick={onDownload}>Download results</Button>}
      {visibility.copyFailed && <Button size="md" onClick={() => void onCopyFailed()}>Copy failed SKUs</Button>}
    </div>
  ) : undefined

  const cancelConfirm = useCallback(() => { setConfirming(false); setActionError(null) }, [])
  const overlay = confirming && run ? (
    <DrawerOverlayCard labelledBy="publish-run-check-title" onCancel={busy === 'mark' ? undefined : cancelConfirm}>
      <h3 id="publish-run-check-title" className={styles.overlayTitle}>Mark this publish as checked?</h3>
      <p className={styles.text}>
        Do this after you looked at the listing on {runDestination(run)}. The result stays unknown: Nexus records that you
        checked it, and new publishes to {runDestination(run)} can start again.
      </p>
      <Field label="Note (optional)" hint="What you saw on the channel. 500 characters at most.">
        {/* The one input of this step: focus it so the step can be read and answered without hunting. */}
        <Textarea value={note} maxLength={500} rows={3} autoFocus onChange={event => setNote(event.target.value)} />
      </Field>
      {actionError && <Banner tone="danger" title="Not marked">{actionError}</Banner>}
      <div className={styles.footer}>
        <Button size="md" onClick={cancelConfirm} disabled={busy === 'mark'}>Cancel</Button>
        <Button size="md" variant="primary" onClick={onMarkChecked} disabled={busy === 'mark'}>{busy === 'mark' ? 'Marking…' : 'Mark as checked'}</Button>
      </div>
    </DrawerOverlayCard>
  ) : undefined

  return (
    <Drawer
      open={!!runId}
      mode={mode}
      onClose={onClose}
      title={title}
      subtitle={subtitle}
      footer={footer}
      overlay={overlay}
      width={mode === 'dock' ? 560 : 680}
      closeLabel="Close publish details"
      className={styles.drawer}
    >
      <div className={styles.body}>
        <p className="nds-vh" role="status" aria-live="polite">{announcement}</p>
        {state.kind === 'loading' && <ProgressBar indeterminate ariaLabel="Reading this publish" />}
        {state.kind === 'not-found' && (
          <EmptyState title="Publish not found" description="This publish no longer exists or belongs to another business." />
        )}
        {state.kind === 'error' && (
          <Banner tone="danger" title="This publish could not be read." action={<Button size="sm" onClick={reload}>Try again</Button>}>{state.message}</Banner>
        )}
        {detail && run && (
          <RunBody
            detail={detail}
            run={run}
            products={products}
            stale={state.kind === 'ready' ? state.stale : undefined}
            onRetry={reload}
            actionError={confirming ? null : actionError}
            publishAgainUnavailable={!!visibility?.publishAgainUnavailable}
            filter={filter}
            onFilter={setFilter}
            expanded={expanded}
            onToggle={key => setExpanded(previous => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next })}
            showInSheet={host.showInSheet && run && (host.canShowInSheet?.(run) ?? true) ? host.showInSheet : undefined}
            canPublish={canPublish}
            loadRequest={loadRequest}
            narrow={narrow}
            onOpenPart={onOpenPart}
            onBack={onBack}
            onUndo={host.undoSelling && canPublish ? onUndo : undefined}
            undoBusy={busy === 'undo'}
          />
        )}
      </div>
    </Drawer>
  )
}

const productKey = (product: HistoryProduct) => `${product.listingId ?? ''}:${product.productId ?? ''}:${product.sku}`

interface RunBodyProps {
  detail: HistoryRunDetail
  run: HistoryRun
  products: HistoryProduct[]
  stale?: string
  onRetry: () => void
  actionError: string | null
  publishAgainUnavailable: boolean
  filter: ProductFilter
  onFilter: (filter: ProductFilter) => void
  expanded: Set<string>
  onToggle: (key: string) => void
  showInSheet?: PublishHistoryHostValue['showInSheet']
  canPublish: boolean
  loadRequest: (listingId: string) => Promise<ListingRequest>
  narrow: boolean
  onOpenPart?: (runId: string) => void
  onBack?: () => void
  /** Absent = this surface cannot prepare an Undo (the business page, or no products.publish): the note says where. */
  onUndo?: (undo: RunUndo) => void
  undoBusy: boolean
}

function RunBody({ detail, run, products, stale, onRetry, actionError, publishAgainUnavailable, filter, onFilter, expanded, onToggle, showInSheet, canPublish, loadRequest, narrow, onOpenPart, onBack, onUndo, undoBusy }: RunBodyProps) {
  const meta = runStatusMeta(run)
  const counts = productFilterCounts(products)
  const shown = filterProducts(products, filter)
  const answered = run.productCount - run.counts.waiting - run.counts.unknown
  const parts = detail.children ?? []
  const undos = runUndos(detail, products)

  const facts: KeyValueItem[] = [
    // The listing only when the source recorded it: the older pages never did, so they name none (never a guess).
    { label: 'Destination', value: [runDestination(run), run.accountLabel, runListingLabel(run)].filter(Boolean).join(' · ') },
    { label: 'Change', value: runChangeLabel(run) },
    { label: 'Started', value: <time dateTime={run.startedAt}>{publishFullTime(run.startedAt)}</time> },
    { label: 'Finished', value: run.finishedAt ? <time dateTime={run.finishedAt}>{publishFullTime(run.finishedAt)}</time> : run.state === 'in_progress' ? 'Not yet' : 'No result recorded' },
    { label: 'By', value: run.userName ?? 'Not recorded' },
    ...(run.reference ? [{ label: 'Channel reference', value: <Reference value={run.reference} /> }] : []),
    { label: 'Started from', value: SOURCE_LABEL[run.source] },
  ]

  // A step the channel has not reached yet is drawn as "not yet"; any other step without a time simply has none
  // recorded (the server keeps no receipt time, for example) — never "not yet" for something that happened.
  const steps: TimelineStep[] = detail.steps.map(step => ({
    key: step.key, label: step.label, tone: step.tone, detail: step.detail ?? undefined,
    at: step.at ?? (step.key === 'waiting' ? null : undefined),
  }))

  // Columns that fit the panel without sideways scrolling: what the product is, what became of it, what the channel
  // said, and the way into the rest (what was sent, the listing, the sheet, the request). A phone keeps three: the
  // channel's message moves into the details.
  const allColumns: Array<Column<HistoryProduct>> = [
    {
      key: 'sku', label: 'Product', width: 144,
      render: p => <span className={styles.skuCell}><span className={styles.sku} title={p.sku}>{p.sku}</span>{p.variationLabel && <span className={styles.muted}>{p.variationLabel}</span>}</span>,
    },
    {
      key: 'result', label: 'Result', width: 134,
      // In a Publish of several parts each product says which part it belongs to ("Pause offer").
      render: p => (
        <span className={styles.skuCell}>
          <PublishStatusPill meta={publishResultMeta(p.result)} />
          {parts.length > 0 && p.kind && <span className={styles.muted}>{KIND_LABEL[p.kind]}</span>}
        </span>
      ),
    },
    {
      key: 'message', label: 'Channel message',
      render: p => <span className={styles.message}>{p.message ?? <span className={styles.muted}>No message</span>}{p.fieldLabel && <span className={styles.muted}>Field: {p.fieldLabel}</span>}</span>,
    },
    {
      key: 'details', label: <span className="nds-vh">Details</span>, width: 76,
      render: p => {
        const open = expanded.has(productKey(p))
        return (
          <Button size="sm" variant="link" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for ${p.sku}`} onClick={() => onToggle(productKey(p))}>
            {open ? 'Hide' : 'Details'}
          </Button>
        )
      },
    },
  ]
  // On a phone three columns fit the full-width panel (measured at 390 px: 352 px for the grid).
  const columns = narrow
    ? allColumns.filter(column => column.key !== 'message').map(column => (column.key === 'sku' ? { ...column, width: 136 } : column))
    : allColumns

  // The parts of one Publish (build shape v2): each its own run, in send order, with its result and a way in.
  const partColumns: Array<Column<HistoryRun>> = [
    {
      // A phone keeps all three columns in the full-width panel (352 px): the part wraps, like the products' SKU.
      key: 'part', label: 'Part', ...(narrow ? { width: 136 } : {}),
      render: part => (
        <span className={styles.message}>
          <span className={styles.text}>{runChangeLabel(part)}</span>
          <span className={styles.muted}>{runDestination(part)} · {resultsText(part.counts)}</span>
        </span>
      ),
    },
    { key: 'result', label: 'Result', width: 134, render: part => <PublishStatusPill meta={runStatusMeta(part)} /> },
    ...(onOpenPart ? [{
      key: 'open', label: <span className="nds-vh">Open</span>, width: 76,
      render: (part: HistoryRun) => (
        <Button size="sm" variant="link" aria-label={`Open ${runChangeLabel(part)} on ${runDestination(part)}`} onClick={() => onOpenPart(part.id)}>Open</Button>
      ),
    }] : []),
  ]

  return (
    <>
      {onBack && (
        <div>
          <Button size="sm" variant="link" onClick={onBack}>Back to the whole Publish</Button>
        </div>
      )}
      {stale && (
        <Banner tone="warning" title="Showing the last result Nexus read." action={<Button size="sm" onClick={onRetry}>Try again</Button>}>
          The newest read failed: {stale}
        </Banner>
      )}
      <section className={styles.summary} aria-label="Result">
        <PublishStatusPill meta={meta} />
        <p className={styles.headline}>{runHeadline(run)}</p>
      </section>
      {actionError && <Banner tone="danger" title="That did not work">{actionError}</Banner>}
      {publishAgainUnavailable && (
        <p className={styles.muted}>
          Opening the review with these products ticked arrives in the next step. Until then, choose Publish on this destination and
          tick the failed products&apos; fields yourself.
        </p>
      )}
      {run.state === 'in_progress' && run.productCount > 0 && (
        <JobProgress
          label={`Waiting for ${runDestination(run)}`}
          value={answered}
          max={run.productCount}
          detail={`${answered} of ${plural(run.productCount, 'product')} answered`}
          note="This updates by itself. You can close it."
        />
      )}
      <KeyValue items={facts} columns={2} dense />

      {undos.length > 0 && (
        <section className={styles.section} aria-labelledby="publish-run-undo">
          <h3 id="publish-run-undo" className={styles.sectionTitle}>Undo</h3>
          <ul className={styles.undoList}>
            {undos.map(undo => (
              <li key={`${undo.run.id}:${undo.kind}`} className={styles.undoItem}>
                <span className={styles.text}>
                  {parts.length > 0 && <strong>{KIND_LABEL[undo.run.kind]} · {runDestination(undo.run)}. </strong>}
                  {undo.hint}
                </span>
                {undo.kind === 'none'
                  ? <span className={styles.muted}>{undo.label}</span>
                  : onUndo
                    ? <Button size="sm" onClick={() => onUndo(undo)} disabled={undoBusy}>{undoBusy ? 'Preparing…' : undo.label}</Button>
                    : <span className={styles.muted}>Undo from the product&apos;s Activity tab.</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {parts.length > 0 && (
        <section className={styles.section} aria-labelledby="publish-run-parts">
          <h3 id="publish-run-parts" className={styles.sectionTitle}>Parts ({parts.length})</h3>
          <p className={styles.muted}>One Publish sends its parts in this order. Open a part for its own fields and steps.</p>
          <DataGrid<HistoryRun>
            ariaLabel="Parts of this publish"
            columns={partColumns}
            rows={parts}
            rowKey={part => part.id}
            size="sm"
            maxHeight={320}
          />
        </section>
      )}

      <section className={styles.section} aria-labelledby="publish-run-steps">
        <h3 id="publish-run-steps" className={styles.sectionTitle}>Steps</h3>
        {steps.length ? <Timeline steps={steps} label="Publish steps" /> : <p className={styles.muted}>No steps recorded.</p>}
      </section>

      <section className={styles.section} aria-labelledby="publish-run-products">
        <div className={styles.sectionHead}>
          <h3 id="publish-run-products" className={styles.sectionTitle}>Products ({products.length})</h3>
          <div className={styles.chips} role="group" aria-label="Show products">
            {FILTERS.map(option => (
              <FilterChip key={option.id} pressed={filter === option.id} count={counts[option.id]} onClick={() => onFilter(option.id)}>{option.label}</FilterChip>
            ))}
          </div>
        </div>
        <DataGrid<HistoryProduct>
          ariaLabel="Products in this publish"
          columns={columns}
          rows={shown}
          rowKey={productKey}
          size="sm"
          maxHeight={440}
          expanded={expanded}
          renderExpanded={p => (expanded.has(productKey(p)) ? <SentDetail run={run} product={p} hasRequest={detail.hasRequest && canPublish} loadRequest={loadRequest} showInSheet={showInSheet} withMessage={narrow} /> : null)}
          emptyState={<p className={styles.muted}>{products.length ? 'No products match this filter.' : 'This publish recorded no products.'}</p>}
        />
      </section>

      {detail.rawResponse != null && (
        <Disclosure summary="What Nexus stored as the channel's answer">
          <p className={styles.muted}>This is the result Nexus saved for this publish, not the channel&apos;s full report.</p>
          <pre className={styles.payload} tabIndex={0} aria-label="Stored channel answer">{JSON.stringify(detail.rawResponse, null, 2)}</pre>
        </Disclosure>
      )}
    </>
  )
}

function Reference({ value }: { value: string }) {
  const { toast } = useToast()
  const copy = async () => {
    try { await navigator.clipboard.writeText(value); toast('Channel reference copied.', 'success') }
    catch { toast('The browser did not allow copying.', 'danger') }
  }
  return (
    <span className={styles.reference}>
      <span className={styles.mono}>{value}</span>
      <Button size="sm" variant="quiet" aria-label="Copy the channel reference" onClick={() => void copy()}><Copy size={14} aria-hidden /></Button>
    </span>
  )
}

function ListingLink({ run, product }: { run: HistoryRun; product: HistoryProduct }) {
  if (!product.externalId) return <span className={styles.muted}>—</span>
  const url = listingUrl(run.channel, run.marketplace, product.externalId)
  if (!url) return <span className={styles.mono}>{product.externalId}</span>
  return (
    <a className={styles.link} href={url} target="_blank" rel="noopener noreferrer" aria-label={`Open ${product.sku} on ${runDestination(run)} (opens in a new tab)`}>
      {product.externalId}
    </a>
  )
}

/** What the publish carried for one product, read only: the same rows the Publish dialog showed, then the request. */
function SentDetail({ run, product, hasRequest, loadRequest, showInSheet, withMessage = false }: {
  run: HistoryRun; product: HistoryProduct; hasRequest: boolean; loadRequest: (listingId: string) => Promise<ListingRequest>
  showInSheet?: PublishHistoryHostValue['showInSheet']
  /** The grid has no message column (a phone): say the channel's words here. */
  withMessage?: boolean
}) {
  const items: ChangeReviewItem[] = (product.changes ?? []).map((change: StudioPublishChange) => ({
    id: change.id,
    label: change.label,
    status: changeStatusText(change),
    note: change.reason,
    selectable: false,
    values: [
      { label: 'Sent', value: publicationValueText(change.current) },
      { label: 'Last accepted before', value: publicationValueText(change.lastAccepted) },
      { label: 'Channel had', value: publicationValueText(change.channel) },
    ],
  }))
  return (
    <div className={styles.sent}>
      <div className={styles.sentHead}>
        <span className={styles.text}>
          <strong>SKU:</strong> <span className={styles.mono}>{product.sku}</span>
          {' · '}<strong>Listing:</strong> <ListingLink run={run} product={product} />
        </span>
        {showInSheet && product.productId && (
          <Button size="sm" aria-label={`Show ${product.sku} in the sheet`} onClick={() => showInSheet(run, product)}>Show in sheet</Button>
        )}
      </div>
      {withMessage && (
        <p className={styles.text}><strong>Channel message:</strong> {product.message ?? 'No message'}{product.fieldLabel ? ` (field: ${product.fieldLabel})` : ''}</p>
      )}
      {items.length
        ? <ChangeReview label={`Fields sent for ${product.sku}`} items={items} selectedIds={[]} disabled onSelectionChange={() => {}} />
        : <p className={styles.text}><strong>Fields sent:</strong> {sentFieldsText(product)}</p>}
      {product.issues.length > 0 && (
        <ul className={styles.issues} aria-label={`What ${runDestination(run)} reported for ${product.sku}`}>
          {product.issues.map((issue, index) => (
            <li key={`${issue.code}:${index}`}>
              <strong>{issue.severity === 'error' ? 'Error' : issue.severity === 'warning' ? 'Warning' : 'Note'}</strong>{' '}
              {issue.message}
              {issue.attributeNames.length > 0 && <span className={styles.muted}> · {issue.attributeNames.join(', ')}</span>}
              {issue.code && <span className={styles.mono}> {issue.code}</span>}
            </li>
          ))}
        </ul>
      )}
      {hasRequest && product.listingId && <RequestDisclosure listingId={product.listingId} sku={product.sku} load={loadRequest} />}
    </div>
  )
}

/** The exact request, read only when opened: it can be large and it is only for people who may publish. */
function RequestDisclosure({ listingId, sku, load }: { listingId: string; sku: string; load: (listingId: string) => Promise<ListingRequest> }) {
  const [state, setState] = useState<{ kind: 'idle' | 'loading' } | { kind: 'ready'; data: ListingRequest } | { kind: 'error'; message: string }>({ kind: 'idle' })
  const read = () => {
    setState({ kind: 'loading' })
    load(listingId).then(data => setState({ kind: 'ready', data })).catch((error: unknown) => setState({ kind: 'error', message: error instanceof Error ? error.message : 'The request could not be read.' }))
  }
  return (
    <Disclosure summary="Exact request to the channel" onToggle={event => { if ((event.currentTarget as HTMLDetailsElement).open && state.kind === 'idle') read() }}>
      {state.kind === 'loading' && <ProgressBar indeterminate ariaLabel={`Reading the request for ${sku}`} />}
      {state.kind === 'error' && <Banner tone="danger" title="The request could not be read." action={<Button size="sm" onClick={read}>Try again</Button>}>{state.message}</Banner>}
      {state.kind === 'ready' && (
        <pre className={styles.payload} tabIndex={0} aria-label={`Request sent for ${sku}`}>{JSON.stringify(state.data.requests, null, 2)}</pre>
      )}
    </Disclosure>
  )
}
