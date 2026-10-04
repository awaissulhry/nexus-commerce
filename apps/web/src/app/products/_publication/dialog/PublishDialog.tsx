'use client'

/**
 * The one Publish dialog (sheet publish parity F2): one review per destination, one send.
 *
 * Context-free: the surface that opens it passes the families, the destinations it can reach, the save bridge and
 * what to tick first, so the studio, the publish history and (step 6) the products list mount the SAME dialog.
 * Ticking a destination reviews it — its own change plan and ticks, never merged with another's. One ready
 * destination sends through the single-publish path exactly as before; two or more go to the background batch
 * (`POST /api/publication-batches`), which keeps sending when the dialog closes.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { PublicationBatchView, StudioPublishResult, StudioPublishReview, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'
import { Button, Pill } from '@/design-system/primitives'
import { Banner, Disclosure, JobProgress, Modal, Tabs, tabPanelProps } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { saveFirstNotice } from '@/app/products/[id]/edit/_studio/saveFirst'
import { PublishStatusPill, publicationStatusMeta } from '@/design-system/grid'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePermission } from '@/lib/auth/AuthProvider'
import { matchesPublicationReview, matchesPublicationSelection, retainPublicationReceipt, type PublicationDestinationOption } from './model'
import { publicationRequest as request } from './request'
import { destinationLabel, isSettled, publicationEventOf, publicationOutcome, resultCounts } from './outcome'
import {
  EMPTY_ENTRY, MAX_BATCH_DESTINATIONS, batchCancellable, batchChildMeta, batchProgress, batchRequest, batchSending, batchSentence, batchTone,
  destinationState, destinationStateLabel, euRefusal, initialTicked, initialTicks, isSparse, publishButtonText, publishPath,
  publishPlan, reviewRequestsText, tickedChanges, withInitialOptions, type DestinationEntry, type DestinationState,
} from './destinations'
import { activeTab, familySummary, initialChoice, marketOptionLabel, marketTabLabel, type PickerChoice } from './pickers'
import { DestinationPicker } from './DestinationPicker'
import { ReviewBody } from './ReviewBody'
import { ManyPublishDialog, type ManyPublishDialogProps } from './ManyPublishDialog'
import styles from './publication.module.css'

export { publicationDestinationParts } from './ReviewBody'

/** How the opening surface's autosave meets the dialog: a review waits for saving to finish. */
type ResultRow = StudioPublishResult['results'][number]
const REFUSED_COLUMNS: Column<ResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'message', label: 'What the channel said', width: 560, className: styles.textCol, render: row => <span className={styles.fix}>{row.message}</span> },
]

export interface PublicationSaveBridge {
  state: { kind: string; at?: number; message?: string }
  /** Flush pending edits; a message means the review cannot start. */
  prepare(): Promise<string | null>
  /** A reason the send must not start now (unsaved edits), or null. */
  blocker(): string | null
}

/** "Publish failed products again…" — the fields to tick in the NEW review of the destination. */
export interface PublicationInitialSelection {
  productIds: string[]
  fieldIds: string[]
}

export interface FamilyPublishDialogProps {
  mode?: 'family'
  /** The family to publish (the first id). Many products use `mode: 'many'`. */
  productIds: string[]
  /** The family SKU, for the subtitle. */
  productLabel: string
  /** Every destination this business can publish to. */
  destinations: PublicationDestinationOption[]
  /** Ticked when the dialog opens. */
  initialDestinations: StudioPublishScope[]
  /** Pre-ticked fields for the first destination's review (publish failed products again). */
  initialSelection?: PublicationInitialSelection | null
  save: PublicationSaveBridge
  discoveryFailed?: boolean | null
  onClose(): void
}

/**
 * The one Publish dialog. `mode: 'many'` (the products list) checks many products in many markets in the background and
 * sends them with one button; the default publishes one family, reviewed field by field, to one or more markets.
 */
export type PublishDialogProps = FamilyPublishDialogProps | ({ mode: 'many' } & ManyPublishDialogProps)

export function PublishDialog(props: PublishDialogProps) {
  return props.mode === 'many' ? <ManyPublishDialog {...props} /> : <FamilyPublishDialog {...props} />
}

type Busy = 'selection' | 'publish' | 'status' | 'batch' | null
const REVIEW_SLOTS = 2
const BATCH_READ_MS = 4_000
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function FamilyPublishDialog({ productIds, productLabel, destinations, initialDestinations, initialSelection = null, save, discoveryFailed = null, onClose }: FamilyPublishDialogProps) {
  const productId = productIds[0]
  const canPublish = usePermission('products.publish')
  const base = `/api/products/${encodeURIComponent(productId)}/studio-publication`
  const options = useMemo(() => withInitialOptions(destinations, initialDestinations), [destinations, initialDestinations])
  const optionOf = useCallback((key: string) => options.find(o => o.key === key), [options])
  const firstTicked = useMemo(() => initialTicked(options, initialDestinations), [options, initialDestinations])
  // The compact pickers (Owner, 2026-10-02): one channel, one account, the chosen markets — prefilled with the sheet's
  // own destination. Each chosen market is one tab; only the open tab's review is drawn.
  const [choice, setChoice] = useState<PickerChoice>(() => initialChoice(options, firstTicked))
  useEffect(() => { if (!choice.channel && options.length) setChoice(initialChoice(options, firstTicked)) }, [choice.channel, options, firstTicked])
  const ticked = useMemo(() => new Set(choice.keys), [choice.keys])
  const [active, setActive] = useState<string | null>(firstTicked[0] ?? null)
  const shownTab = activeTab(choice.keys, active)
  const tabBase = useId()
  const [entries, setEntries] = useState<Record<string, DestinationEntry>>({})
  const entryOf = useCallback((key: string) => entries[key] ?? EMPTY_ENTRY, [entries])
  const update = useCallback((key: string, patch: Partial<DestinationEntry>) => setEntries(prev => ({ ...prev, [key]: { ...(prev[key] ?? EMPTY_ENTRY), ...patch } })), [])
  const [now, setNow] = useState(() => Date.now())

  // ── the single-destination send (today's path, unchanged) ─────────────────────────────────────────────────────
  const [result, setResult] = useState<StudioPublishResult | null>(null)
  const [sentKey, setSentKey] = useState<string | null>(null)
  const [uncertain, setUncertain] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<Busy>(null)
  // When the current wait started: the progress shows the time passed, as the Import dialog's does.
  const [busySince, setBusySince] = useState<number | null>(null)
  useEffect(() => { setBusySince(busy ? Date.now() : null) }, [busy])
  const [announced, setAnnounced] = useState<{ key: string; message: string } | null>(null)
  const sending = useRef(false)
  const recheck = useRef(false)
  // ── the batch (two or more destinations) ──────────────────────────────────────────────────────────────────────
  const [batch, setBatch] = useState<PublicationBatchView | null>(null)
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null)
  const [eu, setEu] = useState<{ title: string; lines: string[] } | null>(null)
  const [requestsReady, setRequestsReady] = useState(false)

  const blockedSave = save.state.kind === 'saving' || save.state.kind === 'error'
  const saveNotice = saveFirstNotice(save.state as Parameters<typeof saveFirstNotice>[0], 'The review loads')
  const saveRevision = save.state.kind === 'saved' ? String(save.state.at) : save.state.kind
  const locked = !!batch || !!result || uncertain || busy === 'publish' || busy === 'batch'

  // ── reviews: every ticked destination is reviewed once, two at a time ─────────────────────────────────────────
  const controllers = useRef(new Map<string, AbortController>())
  const slots = useRef({ used: 0, waiting: [] as Array<() => void> })
  const preparing = useRef<Promise<string | null> | null>(null)
  const retryApplied = useRef(false)
  const initialKey = firstTicked[0] ?? null
  const acquire = () => new Promise<void>(resolve => {
    if (slots.current.used < REVIEW_SLOTS) { slots.current.used++; resolve() } else slots.current.waiting.push(() => { slots.current.used++; resolve() })
  })
  const release = () => { slots.current.used--; slots.current.waiting.shift()?.() }
  useEffect(() => () => { for (const c of controllers.current.values()) c.abort() }, [])

  const startReview = useCallback((key: string) => {
    const option = optionOf(key)
    if (!option) return
    controllers.current.get(key)?.abort()
    const controller = new AbortController()
    controllers.current.set(key, controller)
    update(key, { loading: true, error: null })
    void (async () => {
      await acquire()
      try {
        preparing.current ??= save.prepare().finally(() => { preparing.current = null })
        const blocker = await preparing.current
        if (controller.signal.aborted) return
        if (blocker) throw new Error(blocker)
        const data = await request<StudioPublishReview>(`${base}/preview`, 'POST', option.scope, controller.signal)
        if (controller.signal.aborted) return
        if (!matchesPublicationReview(data, productId, option.scope)) throw new Error('The review does not match this product and destination. Check again.')
        const given = key === initialKey && initialSelection && !retryApplied.current ? initialSelection : null
        if (given) retryApplied.current = true
        update(key, { review: data, loading: false, error: null, selectedIds: initialTicks(data, given), selection: null, selecting: false,
          locationId: data.locations?.length === 1 ? data.locations[0].id : '', confirmedReviewId: null })
      } catch (e) {
        if (!controller.signal.aborted) update(key, { loading: false, error: message(e) })
      } finally { release() }
    })()
  }, [optionOf, update, save, base, productId, initialKey, initialSelection])

  // Review what is ticked and not reviewed yet. Nothing changes once a publish has started.
  useEffect(() => {
    if (locked || blockedSave || !canPublish || discoveryFailed) return
    for (const key of ticked) {
      const entry = entries[key]
      if (!entry || (!entry.loading && !entry.review && !entry.error)) startReview(key)
    }
  }, [ticked, entries, locked, blockedSave, canPublish, discoveryFailed, startReview])

  // A save after the reviews makes them out of date: review the ticked destinations again (as the single dialog did).
  const lastRevision = useRef(saveRevision)
  useEffect(() => {
    if (lastRevision.current === saveRevision) return
    lastRevision.current = saveRevision
    if (sending.current || locked) return
    for (const c of controllers.current.values()) c.abort()
    controllers.current.clear()
    setEntries({}); setRequestsReady(false); setError(null)
  }, [saveRevision, locked])

  // Reviews expire after 15 minutes: re-read the clock now and then so "Review expired" appears on time.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  const stateOf = useCallback((key: string): DestinationState => destinationState(entryOf(key), ticked.has(key), now), [entryOf, ticked, now])
  const tickedKeys = useMemo(() => options.map(o => o.key).filter(key => ticked.has(key)), [options, ticked])
  const plan = useMemo(() => publishPlan(tickedKeys, stateOf), [tickedKeys, stateOf])
  const path = publishPath(plan)
  const singleKey = tickedKeys.length === 1 ? tickedKeys[0] : null
  const scopeOf = useCallback((key: string) => optionOf(key)?.scope, [optionOf])

  const checkAgain = (key: string) => {
    controllers.current.get(key)?.abort()
    setEntries(prev => ({ ...prev, [key]: { ...EMPTY_ENTRY } }))
    setRequestsReady(false)
  }
  const pick = (next: PickerChoice) => {
    if (locked) return
    const keep = new Set(next.keys)
    for (const key of ticked) if (!keep.has(key)) { controllers.current.get(key)?.abort(); const e = entries[key]; if (e?.loading) update(key, { loading: false }) }
    // A market just added opens its tab, so the person sees its review at once.
    const added = next.keys.find(key => !ticked.has(key))
    if (added) setActive(added)
    setChoice(next); setRequestsReady(false); setError(null); setEu(null)
  }
  const choose = (key: string, ids: string[]) => { update(key, { selectedIds: ids, selection: null }); setRequestsReady(false); setError(null) }

  // ── exact requests (Amazon and eBay): one per ticked destination ──────────────────────────────────────────────
  const selectionVersion = useRef(new Map<string, number>())
  const prepareRequest = async (key: string): Promise<boolean> => {
    const entry = entryOf(key), review = entry.review
    const ids = tickedChanges(entry)
    if (!review?.id || !review.changes || !ids.length) return false
    const version = (selectionVersion.current.get(key) ?? 0) + 1
    selectionVersion.current.set(key, version)
    update(key, { selecting: true, selection: null })
    try {
      const data = await request<StudioPublishSelection>(`${base}/${encodeURIComponent(review.id)}/selection`, 'POST', { selectedIds: ids })
      if (selectionVersion.current.get(key) !== version) return false
      if (!matchesPublicationSelection(data, review, ids)) throw new Error('The request preview does not match your selected fields. Review the selection again.')
      update(key, { selection: data, selecting: false })
      return true
    } catch (e) {
      if (selectionVersion.current.get(key) === version) { update(key, { selecting: false }); setError(message(e)) }
      return false
    }
  }
  const requestsRegion = useRef<HTMLDivElement>(null)
  const singleRequest = useRef<HTMLDivElement>(null)
  const reviewRequests = async () => {
    if (busy || locked || !plan.needsRequest.length) return
    setBusy('selection'); setError(null)
    const done = await Promise.all(plan.needsRequest.map(prepareRequest))
    setBusy(null)
    if (done.every(Boolean)) setRequestsReady(true)
  }
  // Focus the prepared request, as the single dialog always did; for several, the summary of all of them.
  const singleToken = singleKey ? entryOf(singleKey).selection?.token : undefined
  useEffect(() => {
    if (!singleToken) return
    singleRequest.current?.scrollIntoView({ block: 'start' })
    singleRequest.current?.focus({ preventScroll: true })
  }, [singleToken])
  useEffect(() => {
    if (!requestsReady || singleKey) return
    requestsRegion.current?.scrollIntoView({ block: 'start' })
    requestsRegion.current?.focus({ preventScroll: true })
  }, [requestsReady, singleKey])

  // ── single send ───────────────────────────────────────────────────────────────────────────────────────────────
  const acceptResult = (data: StudioPublishResult, id: string) => {
    if (data.id !== id || !Array.isArray(data.results) || !['SUBMITTED', 'ACCEPTED', 'VERIFIED', 'PARTIAL', 'FAILED', 'PUBLISHING', 'UNVERIFIED'].includes(data.status)) throw new Error('The publication result could not be verified. Check its status.')
    setResult(previous => retainPublicationReceipt(previous, data)); setUncertain(['PUBLISHING', 'UNVERIFIED', 'SUBMITTED'].includes(data.status))
  }
  const sendSingle = async (key: string) => {
    const entry = entryOf(key), review = entry.review, state = stateOf(key)
    if (state.kind !== 'ready' || !review?.id || sending.current || !canPublish || blockedSave || result || uncertain) return
    if (!state.whole && !state.requestReady) return
    const saveBlocker = save.blocker()
    if (saveBlocker) { update(key, { review: null, error: saveBlocker }); setError(saveBlocker); return }
    sending.current = true; setBusy('publish'); setError(null); setSentKey(key)
    const id = review.id
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}/submit`, 'POST', { locationId: entry.locationId, confirmOverwrite: entry.confirmedReviewId === id, selectionToken: entry.selection?.token }), id) }
    catch (e) {
      const status = (e as { status?: number }).status
      setUncertain(!status || status >= 500)
      if (status && status < 500) update(key, { review: null, selection: null, error: message(e) })
      setError(message(e))
    }
    finally { sending.current = false; setBusy(null) }
  }
  // The dialog opened on an earlier publish to the one ticked destination that has no answer yet: wait on it.
  const singleReview = singleKey ? entryOf(singleKey).review : null
  const earlierWaiting = !result && !!singleReview?.previousPublicationId
  const watchedId = result?.id ?? singleReview?.previousPublicationId ?? null
  const shownKey = sentKey ?? singleKey
  const shownReview = shownKey ? entryOf(shownKey).review : null
  const checkStatus = async () => {
    const id = watchedId
    if (!id) return
    if (sending.current) { recheck.current = true; return }
    sending.current = true; setBusy('status'); setError(null)
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}`, 'GET'), id); if (singleKey && !sentKey) setSentKey(singleKey) }
    catch (e) { setError(message(e)) }
    finally {
      sending.current = false; setBusy(null)
      if (recheck.current) { recheck.current = false; void checkStatusRef.current() }
    }
  }
  const checkStatusRef = useRef(checkStatus)
  checkStatusRef.current = checkStatus

  // ── batch send ────────────────────────────────────────────────────────────────────────────────────────────────
  const readBatch = useCallback(async (id: string) => {
    try { setBatch(await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(id)}`, 'GET')) }
    catch (e) { setError(message(e)) }
  }, [])
  const sendBatch = async () => {
    if (path !== 'batch' || busy || locked || plan.needsRequest.length || plan.pending.length || !canPublish || blockedSave) return
    const saveBlocker = save.blocker()
    if (saveBlocker) { setError(saveBlocker); return }
    setBusy('batch'); setError(null); setEu(null)
    try {
      const created = await request<{ batchId: string }>('/api/publication-batches', 'POST', batchRequest(plan.send, entryOf))
      setBatchStartedAt(Date.now())
      await readBatch(created.batchId)
    } catch (e) {
      const refusal = euRefusal(e)
      if (refusal) setEu(refusal); else setError(message(e))
    } finally { setBusy(null) }
  }
  const cancelBatch = async () => {
    if (!batch) return
    try { setBatch(await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {})) }
    catch (e) { setError(message(e)) }
  }
  // While the batch is still SENDING, read it every few seconds (it ends in seconds to minutes). Afterwards the
  // channels' answers arrive as events, like every other publish: no polling while Nexus waits for a channel.
  useEffect(() => {
    if (!batch || !batchSending(batch)) return
    const t = setTimeout(() => void readBatch(batch.batchId), BATCH_READ_MS)
    return () => clearTimeout(t)
  }, [batch, readBatch])

  // One stream for both paths: the server's sweep settled a publication this dialog waits on.
  useInvalidationChannel('publication.status_changed', event => {
    const changed = publicationEventOf(event)
    if (!changed) return
    if (batch && changed.batchId === batch.batchId) { void readBatch(batch.batchId); return }
    if (!watchedId || changed.publicationId !== watchedId || !(uncertain || result || earlierWaiting)) return
    if (result && result.status === changed.status) return
    void checkStatusRef.current()
  })

  // Announce a final result once, politely. The banner shows it; this line is for a screen reader.
  useEffect(() => {
    if (!result || !shownReview || !(isSettled(result.status) || result.status === 'UNVERIFIED')) return
    const key = `${result.id}:${result.status}`
    if (announced?.key === key) return
    const outcome = publicationOutcome(result.status, resultCounts(result), shownReview.scope.channel, shownReview.scope.marketplace)
    if (outcome) setAnnounced({ key, message: outcome.message })
  }, [result, shownReview, announced?.key])
  useEffect(() => {
    if (!batch?.done) return
    const key = `${batch.batchId}:${batch.outcome}`
    if (announced?.key === key) return
    setAnnounced({ key, message: batchSentence(batch) })
  }, [batch, announced?.key])

  // The earlier publish just got its answer: the review below was made while it blocked the destination, so its notes
  // are out of date. Offer a fresh review instead of showing two statements that disagree.
  const staleReview = !!result && !!singleReview?.previousPublicationId && singleReview.previousPublicationId === result.id && isSettled(result.status)
  const panelRef = useRef<HTMLDivElement>(null)
  const focusFirst = useRef(false)
  const reviewAgain = () => {
    focusFirst.current = true
    setResult(null); setUncertain(false); setError(null); setSentKey(null)
    if (singleKey) checkAgain(singleKey)
  }
  useEffect(() => {
    if (!focusFirst.current || result || uncertain) return
    focusFirst.current = false
    panelRef.current?.focus()
  }, [result, uncertain])

  // ── what the footer offers ────────────────────────────────────────────────────────────────────────────────────
  const pending = busy === 'publish' || busy === 'status' || busy === 'batch'
  const singleState = singleKey ? stateOf(singleKey) : null
  const singleSparse = !!singleReview && isSparse(singleReview)
  const singleCanReview = !!singleKey && singleState?.kind === 'ready' && !singleState.whole && !singleState.requestReady && !busy && !blockedSave && canPublish && !locked
  const singleCanSend = !!singleKey && singleState?.kind === 'ready' && (singleState.whole || singleState.requestReady) && !busy && !blockedSave && canPublish && !locked
  const multiReady = !busy && !blockedSave && canPublish && !locked && plan.pending.length === 0 && plan.send.length > 0
  const singleButtonText = () => {
    const selection = singleKey ? entryOf(singleKey).selection : null
    if (singleSparse) return selection ? `Publish ${selection.fieldCount} ${selection.fieldCount === 1 ? 'change' : 'changes'}` : 'Publish changes'
    return singleReview?.visibility === 'DRAFT' ? 'Send draft to Shopify' : 'Publish product'
  }
  const primary = (() => {
    if (batch) return null
    if (uncertain || earlierWaiting) return <Button size="sm" disabled={!!busy} onClick={checkStatus}>{busy === 'status' ? 'Checking…' : 'Check now'}</Button>
    if (staleReview) return <Button size="sm" variant="primary" disabled={!!busy || blockedSave} onClick={reviewAgain}>Review again</Button>
    if (result) return null
    if (tickedKeys.length <= 1) {
      if (singleSparse && singleState?.kind !== 'ready') return <Button size="sm" variant="primary" disabled>Review selected changes</Button>
      if (singleSparse && singleState?.kind === 'ready' && !singleState.requestReady) {
        return <Button size="sm" variant="primary" disabled={!singleCanReview} onClick={reviewRequests}>{busy === 'selection' ? 'Preparing request…' : 'Review selected changes'}</Button>
      }
      return <Button size="sm" variant="primary" disabled={!singleCanSend} onClick={() => singleKey && void sendSingle(singleKey)}>{busy === 'publish' ? 'Publishing…' : singleButtonText()}</Button>
    }
    if (plan.needsRequest.length) {
      return <Button size="sm" variant="primary" disabled={!(!busy && !blockedSave && canPublish && !locked && plan.pending.length === 0)} onClick={reviewRequests}>
        {busy === 'selection' ? 'Preparing requests…' : reviewRequestsText(plan.needsRequest.length)}</Button>
    }
    const send = path === 'single' ? () => void sendSingle(plan.send[0]) : () => void sendBatch()
    return <Button size="sm" variant="primary" disabled={!multiReady} onClick={send}>{busy === 'publish' || busy === 'batch' ? 'Publishing…' : publishButtonText(plan, scopeOf)}</Button>
  })()
  const waitingHint = tickedKeys.length > 1 && !locked && plan.pending.length > 0
    ? `${plan.pending.length} ${plan.pending.length === 1 ? 'destination is' : 'destinations are'} not ready yet: ${plan.pending.map(key => `${optionOf(key)?.marketName ?? ''} (${destinationStateLabel(stateOf(key)).label.toLowerCase()})`).join(', ')}.`
    : null

  // ── one tab per chosen market ───────────────────────────────────────────────────────────────────────────────
  const childOf = useCallback((key: string) => {
    const id = entryOf(key).review?.id
    return batch && id ? batch.children.find(child => child.publicationId === id) ?? null : null
  }, [batch, entryOf])
  const sentWord = (key: string) => {
    const child = childOf(key)
    if (child) return batchChildMeta(child).label
    return result && key === shownKey ? publicationStatusMeta(result.status).label : null
  }
  const tabs = choice.keys.flatMap(key => { const o = optionOf(key); return o ? [{ id: key, label: marketTabLabel(o, stateOf(key), sentWord(key)) }] : [] })
  const renderPanel = (key: string) => {
    const option = optionOf(key)
    if (!option) return null
    const entry = entryOf(key), state = stateOf(key), child = childOf(key)
    const shown = destinationStateLabel(state)
    const status = child
      ? <span className={styles.resultTitle}><PublishStatusPill meta={batchChildMeta(child)} />{child.message && <span className={styles.muted}>{child.message}</span>}</span>
      : result && key === shownKey ? null
      : <span className={styles.resultTitle}><Pill tone={shown.tone} dot>{shown.label}</Pill><span className={styles.muted}>{shown.hint}</span></span>
    const canCheckAgain = !locked && (state.kind === 'expired' || state.kind === 'error' || state.kind === 'earlier') && choice.keys.length > 1
    const stale = staleReview && key === singleKey
    return <div className={styles.tabPanel} {...tabPanelProps(tabBase, key)} ref={panelRef} aria-label={`Review for ${marketOptionLabel(option)}`}>
      {status}
      {canCheckAgain && <div className={styles.actions}><Button size="sm" onClick={() => checkAgain(key)} aria-label={`Check ${option.marketName} again`}>Check again</Button></div>}
      {entry.error && !entry.review && <Banner tone="danger" title="Review could not complete" action={!locked && <Button size="sm" onClick={() => checkAgain(key)}>Check again</Button>}>{entry.error}</Banner>}
      {!entry.review && !entry.error && <p className={styles.muted}>Reading the saved values and the channel for {marketOptionLabel(option)}…</p>}
      {entry.review && stale && <p>This review was made while that publish was still waiting, so its notes are out of date. Review again to publish to {destinationLabel(entry.review.scope.channel, entry.review.scope.marketplace)}.</p>}
      {entry.review && !stale && <ReviewBody review={entry.review} selectedIds={entry.selectedIds} selection={matchesPublicationSelection(entry.selection, entry.review, tickedChanges(entry)) ? entry.selection : null}
        locationId={entry.locationId} confirmed={entry.confirmedReviewId === entry.review.id} locked={locked || !!busy}
        onSelectionChange={ids => choose(key, ids)} onLocationChange={id => update(key, { locationId: id })}
        onConfirmChange={confirmed => update(key, { confirmedReviewId: confirmed ? entry.review!.id : null })}
        requestRef={key === singleKey ? singleRequest : undefined} />}
      {state.kind === 'expired' && !locked && choice.keys.length === 1 && <div className={styles.actions}><Button size="sm" onClick={() => checkAgain(key)}>Check again</Button></div>}
    </div>
  }

  const progress = batch ? batchProgress(batch) : null
  const word = new Set(tickedKeys.map(k => optionOf(k)?.scope.channel)).size <= 1 ? { one: 'market', many: 'markets' } : { one: 'destination', many: 'destinations' }

  return <Modal open onClose={() => { if (!pending) onClose() }} size="lg" readable title="Publish product"
    subtitle={`${productLabel} · Saved product information and included variants`}
    footer={<>
      <Button size="sm" disabled={pending} onClick={onClose}>{result || batch ? 'Done' : 'Cancel'}</Button>
      {batch && !batch.done && <Button size="sm" disabled={!!busy} onClick={() => void readBatch(batch.batchId)}>Check now</Button>}
      {batchCancellable(batch) && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void cancelBatch()}>Cancel {word.many} not sent yet</Button>}
      {primary}
    </>}>
    <div className={styles.body} aria-busy={!!busy}>
      {options.length > 0 && <div className={styles.top}>
        <DestinationPicker options={options} choice={choice} onChange={pick} locked={locked} />
        {tabs.length > 0 && <Tabs ariaLabel="Chosen markets" size="sm" overflow="scroll" idBase={tabBase} tabs={tabs} active={shownTab ?? ''} onChange={setActive} />}
      </div>}
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Destinations could not be loaded">Close this dialog, then choose Try again in the sheet footer.</Banner>}
      {/* Step 4 (D3) — the same "save first" notice as the Import dialog. */}
      {saveNotice && <Banner tone={saveNotice.tone} title={saveNotice.title}>{saveNotice.body}</Banner>}
      {initialSelection && !locked && <Banner tone="info" title="Publishing the failed products again">
        This is a new review against the current saved values. The fields that failed are ticked; nothing is sent until you publish, and no earlier request is sent again.
      </Banner>}
      {!options.length && !discoveryFailed && <Banner tone="neutral" title="No connected destinations">Connect a sales channel to publish this product.</Banner>}
      {pending && <JobProgress label={busy === 'status' ? 'Checking publication status' : busy === 'batch' ? 'Starting the publish' : 'Publishing'}
        detail={busy === 'status' ? 'Asking the channel for the result…' : busy === 'batch' ? 'Starting the publish to every ready destination…' : 'Submitting the reviewed changes. Waiting for the channel’s response…'}
        startedAt={busySince ?? undefined} />}
      {error && <Banner tone="danger" title={uncertain ? 'Publication result needs checking' : 'Review could not complete'}>{error}</Banner>}
      {eu && <Banner tone="danger" title={eu.title}><ul className={styles.issues}>{eu.lines.map(line => <li key={line}>{line}</li>)}</ul></Banner>}
      {/* An earlier publish to this destination has no answer yet: say so first, not only inside the review's issues. */}
      {earlierWaiting && singleReview && <Banner tone="info" title={`Waiting for ${destinationLabel(singleReview.scope.channel, singleReview.scope.marketplace)}`}>
        <p>An earlier publish to this destination has no answer from the channel yet. This window updates when the channel answers. Use Check now to ask the channel yourself.</p>
      </Banner>}
      {/* The result leads: a long review below must never hide what became of the publication. */}
      {result && (() => {
        const meta = publicationStatusMeta(result.status)
        const where = shownReview ? destinationLabel(shownReview.scope.channel, shownReview.scope.marketplace) : null
        return <Banner tone={meta.tone} title={<span className={styles.resultTitle}><PublishStatusPill meta={meta} />{where && <span>{where}</span>}</span>}>
          <p>{result.message}</p>
          {!meta.terminal && result.status !== 'UNVERIFIED' && <p>You can close this window. Nexus checks the channel by itself and tells you when it answers.</p>}
        </Banner>
      })()}
      {/* Audit D4 — what the channel refused, by SKU, in one table; its notes in one section under it. */}
      {result && result.results.some(r => r.status === 'FAILED') && <DataGrid ariaLabel="Products the channel refused" size="sm" keyboardScroll columns={REFUSED_COLUMNS}
        rows={result.results.filter(r => r.status === 'FAILED')} rowKey={row => row.sku} />}
      {!!result?.warnings?.length && <Disclosure open summary={`${result.warnings.length} ${result.warnings.length === 1 ? 'note' : 'notes'} from the channel`}>
        <ul className={styles.issues}>{result.warnings.map(message => <li key={message}>{message}</li>)}</ul>
      </Disclosure>}
      {batch && progress && <>
        <Banner tone={batchTone(batch)} title={`Publish to ${progress.total} ${progress.total === 1 ? word.one : word.many}`}>
          <p>{batchSentence(batch, word)}</p>
          {!batch.done && <p>You can close this window. Results appear on the sheet and in publish history.</p>}
        </Banner>
        {!batch.done && <JobProgress label={`Publishing to ${progress.total} ${word.many}`} value={progress.done} max={progress.total}
          detail={`${progress.done} of ${progress.total} ${progress.total === 1 ? word.one : word.many}`} startedAt={batchStartedAt ?? undefined} />}
      </>}
      <p className="nds-vh" role="status" aria-live="polite">{announced?.message ?? ''}</p>

      {options.length > 0 && !choice.keys.length && !locked && <p className={styles.muted}>Choose one or more markets above. Each market gets its own review, in its own tab.</p>}
      {choice.keys.length > 1 && !batch && !result && <p className={styles.summary}>{familySummary(choice.keys.length, plan)}</p>}
      {shownTab && renderPanel(shownTab)}
      {ticked.size >= MAX_BATCH_DESTINATIONS && !locked && <p className={styles.muted}>At most {MAX_BATCH_DESTINATIONS} markets can be published at once.</p>}
      {waitingHint && <p className={styles.muted}>{waitingHint}</p>}

      {requestsReady && !singleKey && !locked && <div ref={requestsRegion} tabIndex={-1} role="region" aria-label="Prepared requests">
        <Banner tone="info" title={`${plan.send.length} ${plan.send.length === 1 ? 'request' : 'requests'} ready`}>
          <ul className={styles.issues}>{plan.send.map(key => {
            const entry = entryOf(key), selection = entry.selection
            const option = optionOf(key)
            return <li key={key}><strong>{option?.marketName ?? key}: </strong>{selection
              ? `${selection.fieldCount} ${selection.fieldCount === 1 ? 'change' : 'changes'} affecting ${selection.products.length} ${selection.products.length === 1 ? 'product' : 'products'}.`
              : 'The whole product.'}</li>
          })}</ul>
          <p>Open a destination’s review to see its exact request. Only the selected changes will be applied.</p>
        </Banner>
      </div>}

      {singleKey && !locked && (singleState?.kind === 'error' || singleState?.kind === 'blocked') && <div className={styles.actions}>
        <Button size="sm" disabled={!!busy || blockedSave} onClick={() => checkAgain(singleKey)}>Refresh review</Button>
        <Button size="sm" disabled={!!busy} onClick={onClose}>Back to editing</Button>
      </div>}
    </div>
  </Modal>
}
