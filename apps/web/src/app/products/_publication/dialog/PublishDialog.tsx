'use client'

/**
 * The one Publish dialog (sheet publish parity F2): one review per destination, one send.
 *
 * Context-free: the surface that opens it passes the families, the destinations it can reach, the save bridge and
 * what to tick first, so the studio, the publish history and (step 6) the products list mount the SAME dialog.
 * Ticking a destination reviews it — its own change plan and ticks, never merged with another's.
 *
 * Build shape v2 (P10): each chosen market reads its part of the Publish PLAN (`POST …/studio-publication/plan`): the
 * content review (Partial and Full update rows) AND the waiting Status changes and Deletes, the rows whose content is
 * held back and the values that no longer apply. Each market tab shows the review's metric strip and problems, then
 * one summary line and one table (`ActionPlanTable`). Ended and Delete need the typed family SKU. One market with
 * content only sends through the single-publish path exactly as before; several markets, a ticked status change or a
 * value to clear go to the background batch (`POST /api/publication-batches { plan }`), which keeps sending when the
 * dialog closes. Done offers Undo for Inactive and Ended (Status Active again, reviewed anew); a Delete cannot be undone.
 *
 * One-click publish (Owner 2026-10-04, OD1–OD4 A): the window starts with every market of the sheet's channel and account
 * where the family is listed (`listed`; from the Shared tab: the first channel where it is listed), reviews them one at a
 * time per account (the sheet's market first), builds each market's exact request by itself when its review arrives
 * (and again a short pause after its ticks change), and offers ONE button: "Checking 3 of 7 markets…", then "Publish 41
 * changes to 6 markets · skip 1 with problems". A market whose request cannot be built is skipped with its reason; a
 * click waits for a request still being built, then sends. Each tab opens with the "Nexus wins" line and its "Keep
 * Amazon's values" switch (`DiffersSummary`); the exact request sits in a closed fold.
 *
 * Aliases (Owner 2026-10-05): each listing alias of a market is a destination of its own — its own tab, review, ticks,
 * exact request and send — keyed by the alias id. A listed alias starts chosen like a listed main listing; the tabs,
 * banners and hints name it with the sheet band's mark ("IT ① Racing edition"), and the counts say "listings".
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react'
import type { StudioPublishResult, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'
import { fillResultSentence, type PublishActionWriteResult } from '@nexus/shared/publish-actions'
import { confirmMatches, defaultLifecycleTicks, type PublishPlan, type PublishPlanBatchView } from '@nexus/shared/publish-plan'
import { Button, Pill } from '@/design-system/primitives'
import type { Tone } from '@/design-system/primitives/tone'
import { Banner, ConfirmPhraseField, Disclosure, JobProgress, Modal, Tabs, tabPanelProps } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { saveFirstNotice } from '@/app/products/[id]/edit/_studio/saveFirst'
import { PublishStatusPill, publicationStatusMeta } from '@/design-system/grid'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePermission } from '@/lib/auth/AuthProvider'
import { matchesPublicationSelection, matchesPublishPlan, optionListingLabel, retainPublicationReceipt, type PublicationDestinationOption } from './model'
import { publicationRequest as request, requestFailure } from './request'
import { isSettled, publicationEventOf, publicationOutcome, resultCounts } from './outcome'
import {
  EMPTY_ENTRY, MAX_BATCH_DESTINATIONS, REQUEST_PAUSE_MS, ReviewQueue, accountGroup, batchCancellable, batchLimitText, batchPlaces as countBatchPlaces, batchProgress,
  batchSending, batchSentence, batchTone, checkingButtonText, checkingProgress, destinationName, destinationPlace, destinationState, destinationStateLabel, euRefusal,
  initialTicked, initialTicks, isSparse, placesWord, publishButtonText, publishPlan, requestOutstanding, requestsDue, reviewOrder, tickedChanges, withInitialOptions,
  type DestinationEntry, type DestinationState, type ListedDestinations,
} from './destinations'
import {
  PLAN_CHANGED, PLAN_OUT_OF_DATE, actionPlanRows, actionPlanSend, confirmReason, confirmWhat, createdCounts, destinationChildren, planBatchSentence, planButtonText, planFamilySummary,
  planResultRows, planResultWord, planStateLabel, planSubmit, planSummaryLine, planTabWords, planUndo, roleLockSentence, tickedLifecycleRows,
  undoButtonText, undoSentence, type PlanResultRow,
} from './actionPlan'
import { activeTab, initialChoice, marketOptionLabel, marketTabLabel, refillChoice, type PickerChoice } from './pickers'
import { DestinationPicker } from './DestinationPicker'
import { ReviewBody } from './ReviewBody'
import { ManyPublishDialog, type ManyPublishDialogProps } from './ManyPublishDialog'
import styles from './publication.module.css'
import oneClick from './oneClick.module.css'

export { publicationDestinationParts } from './ReviewBody'

/** How the opening surface's autosave meets the dialog: a review waits for saving to finish. */
type ResultRow = StudioPublishResult['results'][number]
const REFUSED_COLUMNS: Column<ResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'message', label: 'What the channel said', width: 560, className: styles.textCol, render: row => <span className={styles.fix}>{row.message}</span> },
]
/**
 * A market's results once the batch sent it: the content, and each listing of each status change. The widths fit the
 * window's 620 px body at desktop (the channel's words wrap instead of hiding past the edge); a phone scrolls sideways.
 */
const PLAN_RESULT_COLUMNS: Column<PlanResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 160, className: styles.skuCol, render: row => <span className={styles.sku} title={row.sku}>{row.sku}</span> },
  { key: 'what', label: 'What', width: 120, className: styles.textCol, render: row => <span className={styles.fix}>{row.what}</span> },
  { key: 'result', label: 'Result', width: 150, render: row => <span title={row.meta.hint}><PublishStatusPill meta={row.meta} /></span> },
  { key: 'message', label: 'What the channel said', width: 190, className: styles.textCol, render: row => <span className={styles.fix}>{row.message ?? row.meta.hint}</span> },
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
  /**
   * One-click publish (OD1/OD2 A): where the family is listed. The window starts with every such market of the asked-for
   * channel and account (none asked for — the Shared tab: the first channel where the family is listed) and refills the
   * same way when the channel or account changes. Null: only the asked-for destinations (a retry, an Undo review).
   */
  listed?: ListedDestinations | null
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

type Busy = 'publish' | 'status' | 'batch' | 'undo' | null
/** A one-off message above the review: the plan was read again (a value changed, or Undo set Active). */
type Notice = { tone: Tone; title: string; body: string }
const BATCH_READ_MS = 4_000
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))

function FamilyPublishDialog({ productIds, productLabel, destinations, initialDestinations, initialSelection = null, save, discoveryFailed = null, listed = null, onClose }: FamilyPublishDialogProps) {
  const productId = productIds[0]
  const canPublish = usePermission('products.publish')
  const base = `/api/products/${encodeURIComponent(productId)}/studio-publication`
  const options = useMemo(() => withInitialOptions(destinations, initialDestinations), [destinations, initialDestinations])
  const optionOf = useCallback((key: string) => options.find(o => o.key === key), [options])
  const firstTicked = useMemo(() => initialTicked(options, initialDestinations), [options, initialDestinations])
  // The compact pickers (Owner, 2026-10-02): one channel, one account, the chosen markets — prefilled with the sheet's
  // own destination and, with one-click publish (OD1 A), every market of it where the family is listed. Each chosen
  // market is one tab; only the open tab's review is drawn.
  const listedKeys = listed && !listed.loading ? listed.keys : null
  const [choice, setChoice] = useState<PickerChoice>(() => initialChoice(options, firstTicked, listedKeys))
  // The person changed the markets: the listed markets arriving later never undo that choice.
  const touched = useRef(false)
  const filledListed = useRef(!!listedKeys)
  // The asked-for destination can arrive after the window opened (a retry's listing is known once the family's listings
  // are read): it is chosen then, unless the person already chose.
  const firstSignature = firstTicked.join('\n')
  const filledFirst = useRef(firstSignature)
  useEffect(() => {
    if (touched.current || !options.length) return
    if (filledFirst.current !== firstSignature) {
      filledFirst.current = firstSignature
      if (listedKeys) filledListed.current = true
      setChoice(initialChoice(options, firstTicked, listedKeys))
      if (firstTicked[0]) setActive(firstTicked[0])
      return
    }
    if (listedKeys && !filledListed.current) { filledListed.current = true; setChoice(initialChoice(options, firstTicked, listedKeys)); return }
    if (!choice.channel) setChoice(initialChoice(options, firstTicked, listedKeys))
  }, [choice.channel, options, firstTicked, firstSignature, listedKeys])
  const ticked = useMemo(() => new Set(choice.keys), [choice.keys])
  const [active, setActive] = useState<string | null>(firstTicked[0] ?? null)
  const shownTab = activeTab(choice.keys, active)
  const shownRef = useRef(shownTab)
  shownRef.current = shownTab
  const tabBase = useId()
  const reasonId = useId()
  const [entries, setEntries] = useState<Record<string, DestinationEntry>>({})
  const entryOf = useCallback((key: string) => entries[key] ?? EMPTY_ENTRY, [entries])
  // The entries as last drawn, for the request builds (they finish after the render that started them).
  const entriesRef = useRef(entries)
  entriesRef.current = entries
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
  // ── the batch (several markets, a status change, or a value to clear) ────────────────────────────────────────
  const [batch, setBatch] = useState<PublishPlanBatchView | null>(null)
  const [batchStartedAt, setBatchStartedAt] = useState<number | null>(null)
  const [eu, setEu] = useState<{ title: string; lines: string[] } | null>(null)
  const [notice, setNotice] = useState<Notice | null>(null)
  // The typed confirmation Ended and Delete need (the family SKU). Cleared whenever the rows it confirms change.
  const [confirmText, setConfirmText] = useState('')

  const blockedSave = save.state.kind === 'saving' || save.state.kind === 'error'
  const saveNotice = saveFirstNotice(save.state as Parameters<typeof saveFirstNotice>[0], 'The review loads')
  const saveRevision = save.state.kind === 'saved' ? String(save.state.at) : save.state.kind
  const locked = !!batch || !!result || uncertain || busy === 'publish' || busy === 'batch'

  // ── plans: every chosen market is reviewed once, one at a time per account, the sheet's market first ───────────
  const controllers = useRef(new Map<string, AbortController>())
  // Two Amazon reviews at once were throttled by Amazon: one per account; the next turn goes to the open tab.
  const queue = useRef<ReviewQueue | null>(null)
  queue.current ??= new ReviewQueue(() => shownRef.current)
  const preparing = useRef<Promise<string | null> | null>(null)
  const retryApplied = useRef(false)
  const initialKey = firstTicked[0] ?? null
  useEffect(() => () => { for (const c of controllers.current.values()) c.abort() }, [])

  const startReview = useCallback((key: string) => {
    const option = optionOf(key)
    if (!option) return
    controllers.current.get(key)?.abort()
    const controller = new AbortController()
    controllers.current.set(key, controller)
    update(key, { loading: true, error: null })
    const turn = accountGroup(option.scope)
    void (async () => {
      await queue.current!.acquire(turn, key)
      try {
        preparing.current ??= save.prepare().finally(() => { preparing.current = null })
        const blocker = await preparing.current
        if (controller.signal.aborted) return
        if (blocker) throw new Error(blocker)
        // One destination per plan request: each market keeps its own review, ticks and "Check again".
        const data = await request<PublishPlan>(`${base}/plan`, 'POST', { destinations: [option.scope] }, controller.signal)
        if (controller.signal.aborted) return
        if (!matchesPublishPlan(data, productId, option.scope)) throw new Error('The review does not match this product and destination. Check again.')
        const planned = data.destinations[0]
        const review = planned.review
        const given = key === initialKey && initialSelection && !retryApplied.current ? initialSelection : null
        if (given) retryApplied.current = true
        // "Publish failed products again…" ticks only the failed fields: waiting status changes start unticked there.
        update(key, { plan: planned, familySku: data.familySku, canDelete: data.canDelete, review, loading: false, error: null,
          selectedIds: review ? initialTicks(review, given) : [], lifecycleIds: given ? [] : defaultLifecycleTicks({ destinations: [planned] }),
          selection: null, selecting: false, selectionError: null, ticksAt: 0,
          locationId: review?.locations?.length === 1 ? review.locations[0].id : '', confirmedReviewId: null })
      } catch (e) {
        if (!controller.signal.aborted) update(key, { loading: false, error: message(e) })
      } finally { queue.current!.release(turn) }
    })()
  }, [optionOf, update, save, base, productId, initialKey, initialSelection])

  // Review what is chosen and not reviewed yet — the sheet's market first, then the open tab. Nothing changes once a
  // publish has started.
  useEffect(() => {
    if (locked || blockedSave || !canPublish || discoveryFailed) return
    for (const key of reviewOrder(choice.keys, initialKey, shownTab)) {
      const entry = entries[key]
      if (!entry || (!entry.loading && !entry.plan && !entry.error)) startReview(key)
    }
  }, [choice.keys, initialKey, shownTab, entries, locked, blockedSave, canPublish, discoveryFailed, startReview])

  /** Read every chosen market's plan again (a waiting value changed, a save landed, Undo set Active). */
  const reloadPlans = useCallback((next: Notice | null) => {
    for (const c of controllers.current.values()) c.abort()
    controllers.current.clear()
    setEntries({}); setError(null); setConfirmText(''); setNotice(next)
  }, [])

  // A save after the reviews makes them out of date: review the ticked destinations again (as the single dialog did).
  const lastRevision = useRef(saveRevision)
  useEffect(() => {
    if (lastRevision.current === saveRevision) return
    lastRevision.current = saveRevision
    if (sending.current || locked) return
    reloadPlans(null)
  }, [saveRevision, locked, reloadPlans])

  // Reviews expire after 15 minutes: re-read the clock now and then so "Review expired" appears on time.
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  const stateOf = useCallback((key: string): DestinationState => destinationState(entryOf(key), ticked.has(key), now), [entryOf, ticked, now])
  const tickedKeys = useMemo(() => options.map(o => o.key).filter(key => ticked.has(key)), [options, ticked])
  // `plan`: the content of the ticked markets (as before); `action`: what one click sends with the status changes.
  const plan = useMemo(() => publishPlan(tickedKeys, stateOf), [tickedKeys, stateOf])
  const action = useMemo(() => actionPlanSend(tickedKeys, stateOf, entryOf, plan), [tickedKeys, stateOf, entryOf, plan])
  // New listings: the listings this Publish creates on the markets whose content goes ("2 new listings (1 inactive)").
  const created = useMemo(() => action.content.map(key => createdCounts(actionPlanRows(entryOf(key), stateOf(key), now)))
    .reduce((sum, c) => ({ total: sum.total + c.total, inactive: sum.inactive + c.inactive }), { total: 0, inactive: 0 }), [action.content, entryOf, stateOf, now])
  const singleKey = tickedKeys.length === 1 ? tickedKeys[0] : null
  const scopeOf = useCallback((key: string) => optionOf(key)?.scope, [optionOf])
  const dangerKey = useMemo(() => tickedKeys.flatMap(key => tickedLifecycleRows(entryOf(key)).filter(row => row.needsTypedConfirm).map(row => row.id)).sort().join(','),
    [tickedKeys, entryOf])
  useEffect(() => { setConfirmText('') }, [dangerKey])

  const checkAgain = (key: string) => {
    controllers.current.get(key)?.abort()
    setEntries(prev => ({ ...prev, [key]: { ...EMPTY_ENTRY } }))
  }
  const pick = (picked: PickerChoice) => {
    if (locked || sendWaiting) return
    touched.current = true
    // Another channel or account chooses its listed markets the same way (OD1 A).
    const next = refillChoice(options, choice, picked, listedKeys, firstTicked)
    const keep = new Set(next.keys)
    for (const key of ticked) if (!keep.has(key)) { controllers.current.get(key)?.abort(); const e = entries[key]; if (e?.loading) update(key, { loading: false }) }
    // A market just added opens its tab, so the person sees its review at once.
    const added = next.keys.find(key => !ticked.has(key))
    if (added) setActive(added)
    setChoice(next); setError(null); setEu(null)
  }
  // New ticks need a new exact request: it is built again a short pause after the last change.
  const choose = (key: string, ids: string[]) => { update(key, { selectedIds: ids, selection: null, selectionError: null, ticksAt: Date.now() }); setError(null) }
  /** A tick in the plan table: a row's fields (they need a new exact request) or a status change. */
  const chooseTicks = (key: string, next: { selectedIds: string[]; lifecycleIds: string[] }) => {
    const entry = entryOf(key)
    const fieldsChanged = next.selectedIds.length !== entry.selectedIds.length || next.selectedIds.some(id => !entry.selectedIds.includes(id))
    if (fieldsChanged) choose(key, next.selectedIds)
    update(key, { lifecycleIds: next.lifecycleIds })
    setError(null)
  }

  // ── exact requests (Amazon and eBay): built by themselves, one at a time per market ───────────────────────────────
  // The `…/selection` call makes no channel call. It runs when a review arrives, and again a short pause after the ticks
  // change; the server refuses two at once for a market, so a change during a build waits for it. A request that cannot
  // be built skips its market with the reason (OD4 A); the others are sent.
  const building = useRef(new Set<string>())
  const buildRequest = useCallback(async (key: string) => {
    const entry = entriesRef.current[key], review = entry?.review
    if (!entry || !review?.id || !review.changes || building.current.has(key)) return
    const ids = tickedChanges(entry)
    if (!ids.length) return
    const reviewId = review.id
    building.current.add(key)
    const settle = (patch: (current: DestinationEntry) => Partial<DestinationEntry>) => setEntries(prev => {
      const current = prev[key]
      return current?.review?.id === reviewId ? { ...prev, [key]: { ...current, ...patch(current) } } : prev
    })
    settle(() => ({ selecting: true }))
    let outcome: { selection: StudioPublishSelection } | { error: string }
    try {
      const data = await request<StudioPublishSelection>(`${base}/${encodeURIComponent(reviewId)}/selection`, 'POST', { selectedIds: ids })
      outcome = matchesPublicationSelection(data, review, ids) ? { selection: data } : { error: 'The request does not match the ticked fields.' }
    } catch (e) { outcome = { error: message(e) } }
    building.current.delete(key)
    settle(current => {
      // The ticks changed while it was built: this answer is for the old ones, and a new build follows.
      const ticks = tickedChanges(current)
      const same = ticks.length === ids.length && ticks.every(id => ids.includes(id))
      if (!same) return { selecting: false }
      return 'selection' in outcome ? { selecting: false, selection: outcome.selection, selectionError: null } : { selecting: false, selection: null, selectionError: outcome.error }
    })
  }, [base])
  // A click on Publish while a request is still to come waits for it: then without the pause.
  const [sendWaiting, setSendWaiting] = useState(false)
  useEffect(() => {
    if (locked || blockedSave || !canPublish) return
    const due = requestsDue(choice.keys, stateOf, entryOf, sendWaiting ? 0 : REQUEST_PAUSE_MS)
    const timers = due.map(({ key, at }) => setTimeout(() => void buildRequest(key), Math.max(0, at - Date.now())))
    return () => { for (const t of timers) clearTimeout(t) }
  }, [choice.keys, stateOf, entryOf, locked, blockedSave, canPublish, sendWaiting, buildRequest])
  const retryRequest = (key: string) => update(key, { selectionError: null, selection: null, ticksAt: 0 })
  const outstanding = choice.keys.some(key => requestOutstanding(stateOf(key), entryOf(key)))
  const checking = useMemo(() => checkingProgress(choice.keys, stateOf, entryOf), [choice.keys, stateOf, entryOf])

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
    if (saveBlocker) { update(key, { review: null, plan: null, error: saveBlocker }); setError(saveBlocker); return }
    sending.current = true; setBusy('publish'); setError(null); setSentKey(key)
    const id = review.id
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}/submit`, 'POST', { locationId: entry.locationId, confirmOverwrite: entry.confirmedReviewId === id, selectionToken: entry.selection?.token }), id) }
    catch (e) {
      const status = (e as { status?: number }).status
      setUncertain(!status || status >= 500)
      if (status && status < 500) update(key, { review: null, plan: null, selection: null, error: message(e) })
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

  // ── batch send: the whole plan ────────────────────────────────────────────────────────────────────────────────
  const readBatch = useCallback(async (id: string) => {
    try { setBatch(await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(id)}`, 'GET')) }
    catch (e) { setError(message(e)) }
  }, [])
  const confirmed = !action.confirm || confirmMatches(action.confirm.expected, confirmText)
  const sendPlan = async () => {
    if (!action.batch || busy || locked || plan.needsRequest.length || plan.pending.length || !action.send.length || !canPublish || blockedSave || !confirmed) return
    const saveBlocker = save.blocker()
    if (saveBlocker) { setError(saveBlocker); return }
    setBusy('batch'); setError(null); setEu(null); setNotice(null)
    try {
      const body = planSubmit(productId, action, entryOf, scopeOf, action.confirm ? confirmText : null)
      const created = await request<{ batchId: string }>('/api/publication-batches', 'POST', { plan: body })
      setBatchStartedAt(Date.now())
      await readBatch(created.batchId)
    } catch (e) {
      const failure = requestFailure(e)
      // A ticked value changed since the review (someone else, another window), or the review went out of date: read
      // the plan again, nothing was sent.
      if (failure.status === 409) {
        reloadPlans({ tone: 'warning', title: failure.code === 'changed' ? PLAN_CHANGED : PLAN_OUT_OF_DATE, body: message(e).replace(/\s*(Review|Check) again\.?\s*$/, '') })
        return
      }
      const refusal = euRefusal(e)
      if (refusal) setEu(refusal); else setError(message(e))
    } finally { setBusy(null) }
  }
  /** The one button: send now — through today's single publish when one market sends content only, else the batch. */
  const sendNow = () => {
    if (tickedKeys.length <= 1 && !action.batch) { if (singleKey) void sendSingle(singleKey); return }
    if (!action.batch) { if (plan.send[0]) void sendSingle(plan.send[0]); return }
    void sendPlan()
  }
  // A click while an exact request is still to come waits for it (built at once), then sends what is ready: a market
  // whose request could not be built is skipped with its reason (OD4 A).
  const publish = () => { if (outstanding) setSendWaiting(true); else sendNow() }
  useEffect(() => {
    if (!sendWaiting) return
    if (locked || blockedSave) { setSendWaiting(false); return }
    if (outstanding) return
    setSendWaiting(false)
    sendNow()
    // sendNow is this render's: it reads the requests just built.
  }, [sendWaiting, outstanding, locked, blockedSave]) // eslint-disable-line react-hooks/exhaustive-deps
  const cancelBatch = async () => {
    if (!batch) return
    try { setBatch(await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {})) }
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

  const withStatusChanges = !!batch?.children.some(child => child.kind === 'lifecycle')
  // "markets", "listings" once a listing alias is chosen (two listings of one market are not two markets), "destinations"
  // when channels mix.
  const word = useMemo(() => placesWord(tickedKeys, scopeOf), [tickedKeys, scopeOf])
  /** A destination's place with its listing when its market has more than one: "eBay · IT · ① Racing edition". */
  const placeOf = (key: string | null, scope: Pick<StudioPublishScope, 'channel' | 'marketplace'>) => destinationPlace(scope, key ? optionOf(key) : null)
  const batchLine = (view: PublishPlanBatchView) => (view.children.some(child => child.kind === 'lifecycle') ? planBatchSentence(view) : batchSentence(view, word))

  // Announce a final result once, politely. The banner shows it; this line is for a screen reader.
  useEffect(() => {
    if (!result || !shownReview || !(isSettled(result.status) || result.status === 'UNVERIFIED')) return
    const key = `${result.id}:${result.status}`
    if (announced?.key === key) return
    const outcome = publicationOutcome(result.status, resultCounts(result), shownReview.scope.channel, shownReview.scope.marketplace,
      destinationPlace(shownReview.scope, shownKey ? optionOf(shownKey) : null))
    if (outcome) setAnnounced({ key, message: outcome.message })
  }, [result, shownReview, shownKey, optionOf, announced?.key])
  useEffect(() => {
    if (!batch?.done) return
    const key = `${batch.batchId}:${batch.outcome}`
    if (announced?.key === key) return
    setAnnounced({ key, message: batchLine(batch) })
  }, [batch, announced?.key])

  // ── Done, with Undo: Inactive and Ended rows become Active again — written as waiting values, then reviewed anew ──
  const undo = useMemo(() => (batch?.done ? planUndo(batch.children) : null), [batch])
  const undoText = undo ? undoButtonText(undo) : null
  const undoLine = undo ? undoSentence(undo) : null
  const runUndo = async () => {
    if (!undo?.listingIds.length || busy) return
    setBusy('undo'); setError(null)
    try {
      const written = await request<PublishActionWriteResult>(`/api/products/${encodeURIComponent(productId)}/studio/publish-actions/status/active`, 'PUT',
        { listingIds: undo.listingIds, expected: Object.fromEntries(undo.listingIds.map(id => [id, null])) })
      setBatch(null); setBatchStartedAt(null); setAnnounced(null)
      reloadPlans({ tone: written.applied.length ? 'info' : 'warning', title: 'Undo: check the review, then publish',
        body: `${fillResultSentence('Active', written)} Nothing is sent until you press Publish.` })
    } catch (e) { setError(message(e)) }
    finally { setBusy(null) }
  }

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

  // ── what the footer offers: ONE button ─────────────────────────────────────────────────────────────────────────
  const pending = busy === 'publish' || busy === 'status' || busy === 'batch'
  const singleState = singleKey ? stateOf(singleKey) : null
  const singleSparse = !!singleReview && isSparse(singleReview)
  const ready = !busy && !sendWaiting && !blockedSave && canPublish && !locked
  const singleCanSend = !!singleKey && singleState?.kind === 'ready' && ready
  const multiReady = ready && plan.pending.length === 0 && action.send.length > 0
  // "Checking 3 of 7 markets…" while a review (or its first exact request) is still to come.
  const checkingNow = checking.checking > 0 && canPublish && !discoveryFailed && !locked && save.state.kind !== 'error'
  const singleButtonText = () => {
    if (singleSparse) return singleState?.kind === 'ready' ? `Publish ${singleState.changes} ${singleState.changes === 1 ? 'change' : 'changes'}` : 'Publish changes'
    return singleReview?.visibility === 'DRAFT' ? 'Send draft to Shopify' : 'Publish product'
  }
  const footReason = !batch && !result && action.batch && action.confirm && !confirmed ? confirmReason(action.confirm) : null
  const primary = (() => {
    if (batch) return null
    if (uncertain || (earlierWaiting && !action.lifecycle.length)) return <Button size="sm" disabled={!!busy} onClick={checkStatus}>{busy === 'status' ? 'Checking…' : 'Check now'}</Button>
    if (staleReview) return <Button size="sm" variant="primary" disabled={!!busy || blockedSave} onClick={reviewAgain}>Review again</Button>
    if (result) return null
    // The one button keeps its place while the window works; its words wrap on a phone.
    const one = { size: 'sm' as const, wrap: true, className: oneClick.oneButton }
    if (listed?.loading && !choice.keys.length && !locked) return <Button {...one} variant="primary" disabled>Finding the markets…</Button>
    if (checkingNow) return <Button {...one} variant="primary" disabled>{checkingButtonText(checking, word)}</Button>
    if (sendWaiting) return <Button {...one} variant="primary" disabled>{tickedKeys.length > 1 ? 'Preparing the requests…' : 'Preparing the request…'}</Button>
    // One market with content only: today's single publish.
    if (tickedKeys.length <= 1 && !action.batch) {
      return <Button {...one} variant="primary" disabled={!singleCanSend} onClick={publish}>{busy === 'publish' ? 'Publishing…' : singleButtonText()}</Button>
    }
    // Several markets with content only, of which one is ready: that one goes through today's single publish.
    if (!action.batch) {
      return <Button {...one} variant="primary" disabled={!multiReady || !plan.send[0]} onClick={publish}>
        {busy === 'publish' ? 'Publishing…' : publishButtonText(plan, scopeOf)}</Button>
    }
    // "skip N with problems": the markets that send nothing at all (a market whose content has problems but whose
    // status changes go is published, not skipped) — `planButtonText` counts them itself.
    const text = action.lifecycle.length
      ? planButtonText(action.counts, action.send, word, plan.skipped, action.wholeProducts)
      : publishButtonText(plan, scopeOf)
    return <Button {...one} variant={action.confirm ? 'danger' : 'primary'} disabled={!multiReady || !confirmed} aria-describedby={footReason ? reasonId : undefined}
      onClick={publish}>{busy === 'batch' ? 'Publishing…' : text}</Button>
  })()
  const waitingHint = tickedKeys.length > 1 && !locked && !checkingNow && plan.pending.length > 0
    ? `${plan.pending.length} ${plan.pending.length === 1 ? 'destination is' : 'destinations are'} not ready yet: ${plan.pending.map(key => { const o = optionOf(key); return `${o ? destinationName(o) : ''} (${destinationStateLabel(stateOf(key)).label.toLowerCase()})` }).join(', ')}.`
    : null
  // Markets with nothing to send stay as quiet tabs: they are not counted in the line above the tabs.
  const quiet = plan.nothing.filter(key => !action.send.includes(key))
  const counted = choice.keys.length - quiet.length
  const roleLock = !locked ? roleLockSentence(action.roleLocked) : null

  // ── one tab per chosen market ───────────────────────────────────────────────────────────────────────────────
  const childrenOf = useCallback((key: string) => {
    if (!batch) return []
    const entry = entryOf(key)
    return destinationChildren(batch.children, entry.review?.id, entry.plan?.destination)
  }, [batch, entryOf])
  const sentWord = (key: string) => {
    const sent = planResultWord(childrenOf(key))
    if (sent) return sent
    return result && key === shownKey ? publicationStatusMeta(result.status).label : null
  }
  const tabs = choice.keys.flatMap(key => {
    const o = optionOf(key)
    return o ? [{ id: key, label: marketTabLabel(o, stateOf(key), sentWord(key) ?? planTabWords(stateOf(key), entryOf(key))) }] : []
  })
  const renderPanel = (key: string) => {
    const option = optionOf(key)
    if (!option) return null
    const entry = entryOf(key), state = stateOf(key), kids = childrenOf(key)
    const shown = planStateLabel(state, entry, destinationStateLabel(state))
    const status = kids.length || (result && key === shownKey) ? null
      : <span className={styles.resultTitle}><Pill tone={shown.tone} dot>{shown.label}</Pill><span className={styles.muted}>{shown.hint}</span></span>
    const canCheckAgain = !locked && (state.kind === 'expired' || state.kind === 'error' || state.kind === 'earlier') && choice.keys.length > 1
    const requestFailed = !locked && state.kind === 'blocked' && !!state.request
    const stale = staleReview && key === singleKey
    const own = entry.plan ? actionPlanSend([key], stateOf, entryOf) : null
    const rows = entry.plan ? actionPlanRows(entry, state, now) : []
    // An alias (or the main listing of a market with aliases) is named with the band's mark; else the plan's own words.
    const place = optionListingLabel(option) ? destinationPlace(option.scope, option) : entry.plan?.label ?? destinationPlace(option.scope)
    const planPart = entry.plan && own ? {
      label: place, summary: planSummaryLine(own.counts, own.wholeProducts, own.content.includes(key) ? createdCounts(rows) : null), rows,
      lifecycleIds: entry.lifecycleIds, contentError: entry.plan.error, now, onTicksChange: (next: { selectedIds: string[]; lifecycleIds: string[] }) => chooseTicks(key, next),
    } : null
    return <div className={styles.tabPanel} {...tabPanelProps(tabBase, key)} ref={panelRef} aria-label={`Review for ${marketOptionLabel(option)}`}>
      {status}
      {kids.length > 0 && <DataGrid ariaLabel={`Results on ${place}`} size="sm" columns={PLAN_RESULT_COLUMNS}
        rows={planResultRows(kids, productLabel, tickedLifecycleRows(entry))} rowKey={row => row.key} />}
      {canCheckAgain && <div className={styles.actions}><Button size="sm" onClick={() => checkAgain(key)} aria-label={`Check ${destinationName(option)} again`}>Check again</Button></div>}
      {requestFailed && <div className={styles.actions}><Button size="sm" disabled={!!busy || sendWaiting} onClick={() => retryRequest(key)} aria-label={`Build the exact request for ${destinationName(option)} again`}>Try again</Button></div>}
      {entry.error && !entry.plan && <Banner tone="danger" title="Review could not complete" action={!locked && <Button size="sm" onClick={() => checkAgain(key)}>Check again</Button>}>{entry.error}</Banner>}
      {!entry.plan && !entry.error && <p className={styles.muted}>Reading the saved values, the waiting status changes and the channel for {marketOptionLabel(option)}…</p>}
      {entry.review && stale && <p>This review was made while that publish was still waiting, so its notes are out of date. Review again to publish to {placeOf(key, entry.review.scope)}.</p>}
      {entry.plan && !stale && <ReviewBody review={entry.review} selectedIds={entry.selectedIds} plan={planPart} listing={optionListingLabel(option)}
        selection={matchesPublicationSelection(entry.selection, entry.review, tickedChanges(entry)) ? entry.selection : null}
        selecting={entry.selecting || requestOutstanding(state, entry)} nexusWins
        locationId={entry.locationId} confirmed={!!entry.review && entry.confirmedReviewId === entry.review.id} locked={locked || !!busy || sendWaiting}
        onSelectionChange={ids => choose(key, ids)} onLocationChange={id => update(key, { locationId: id })}
        onConfirmChange={confirmed => update(key, { confirmedReviewId: confirmed ? entry.review?.id ?? null : null })} />}
      {state.kind === 'expired' && !locked && choice.keys.length === 1 && <div className={styles.actions}><Button size="sm" onClick={() => checkAgain(key)}>Check again</Button></div>}
    </div>
  }

  const progress = batch ? batchProgress(batch) : null
  const batchPlaces = batch ? countBatchPlaces(batch.children) : 0

  return <Modal open onClose={() => { if (!pending) onClose() }} size="lg" readable title="Publish product"
    subtitle={`${productLabel} · Saved product information and included variants`}
    footer={<>
      {footReason && <span id={reasonId} className={`grow ${styles.footReason}`}>{footReason}</span>}
      <Button size="sm" disabled={pending} onClick={onClose}>{result || batch ? 'Done' : 'Cancel'}</Button>
      {batch && !batch.done && <Button size="sm" disabled={!!busy} onClick={() => void readBatch(batch.batchId)}>Check now</Button>}
      {batchCancellable(batch) && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void cancelBatch()}>Cancel {withStatusChanges ? 'steps' : word.many} not sent yet</Button>}
      {undoText && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void runUndo()}>{busy === 'undo' ? 'Setting Active…' : undoText}</Button>}
      {primary}
    </>}>
    <div className={styles.body} aria-busy={!!busy}>
      {options.length > 0 && <div className={styles.top}>
        <DestinationPicker options={options} choice={choice} onChange={pick} locked={locked} />
        {tabs.length > 0 && <Tabs ariaLabel={`Chosen ${word.many}`} size="sm" overflow="scroll" idBase={tabBase} tabs={tabs} active={shownTab ?? ''} onChange={setActive} />}
      </div>}
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Destinations could not be loaded">Close this dialog, then choose Try again in the sheet footer.</Banner>}
      {/* Step 4 (D3) — the same "save first" notice as the Import dialog. */}
      {saveNotice && <Banner tone={saveNotice.tone} title={saveNotice.title}>{saveNotice.body}</Banner>}
      {initialSelection && !locked && <Banner tone="info" title="Publishing the failed products again">
        This is a new review against the current saved values. The fields that failed are ticked; nothing is sent until you publish, and no earlier request is sent again.
      </Banner>}
      {notice && !locked && <Banner tone={notice.tone} title={notice.title} onDismiss={() => setNotice(null)}>{notice.body}</Banner>}
      {!options.length && !discoveryFailed && <Banner tone="neutral" title="No connected destinations">Connect a sales channel to publish this product.</Banner>}
      {pending && <JobProgress label={busy === 'status' ? 'Checking publication status' : busy === 'batch' ? 'Starting the publish' : 'Publishing'}
        detail={busy === 'status' ? 'Asking the channel for the result…' : busy === 'batch' ? 'Starting the publish to every ready destination…' : 'Submitting the reviewed changes. Waiting for the channel’s response…'}
        startedAt={busySince ?? undefined} />}
      {error && <Banner tone="danger" title={uncertain ? 'Publication result needs checking' : 'Review could not complete'}>{error}</Banner>}
      {eu && <Banner tone="danger" title={eu.title}><ul className={styles.issues}>{eu.lines.map(line => <li key={line}>{line}</li>)}</ul></Banner>}
      {/* An earlier publish to this destination has no answer yet: say so first, not only inside the review's issues. */}
      {earlierWaiting && singleReview && <Banner tone="info" title={`Waiting for ${placeOf(singleKey, singleReview.scope)}`}>
        <p>An earlier publish to this destination has no answer from the channel yet. This window updates when the channel answers. Use Check now to ask the channel yourself.</p>
      </Banner>}
      {/* The result leads: a long review below must never hide what became of the publication. */}
      {result && (() => {
        const meta = publicationStatusMeta(result.status)
        const where = shownReview ? placeOf(shownKey, shownReview.scope) : null
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
        <Banner tone={batchTone(batch)} title={`Publish to ${batchPlaces} ${batchPlaces === 1 ? word.one : word.many}`}>
          <p>{batchLine(batch)}</p>
          {!batch.done && <p>You can close this window. Results appear on the sheet and in publish history.</p>}
          {batch.done && undoLine && <p>{undoLine}</p>}
        </Banner>
        {!batch.done && <JobProgress label={`Publishing to ${batchPlaces} ${batchPlaces === 1 ? word.one : word.many}`} value={progress.done} max={progress.total}
          detail={withStatusChanges ? `${progress.done} of ${progress.total} ${progress.total === 1 ? 'step' : 'steps'}` : `${progress.done} of ${progress.total} ${progress.total === 1 ? word.one : word.many}`}
          startedAt={batchStartedAt ?? undefined} />}
      </>}
      <p className="nds-vh" role="status" aria-live="polite">{announced?.message ?? ''}</p>

      {options.length > 0 && !choice.keys.length && !locked && <p className={styles.muted}>{listed?.loading
        ? 'Finding the markets where this product is listed…' : 'Choose one or more markets above. Each market gets its own review, in its own tab.'}</p>}
      {listed?.failed && !touched.current && !locked && <p className={styles.muted}>Where this product is listed could not be read, so only the markets shown are chosen. Add others above.</p>}
      {choice.keys.length > 1 && !batch && !result && <p className={styles.summary}>{counted > 0 || checkingNow
        ? planFamilySummary(counted, { ...plan, nothing: [] }, action.counts, action.wholeProducts, action.send, created, word)
        : `Nothing to send: these ${word.many} already have the saved values.`}</p>}
      {roleLock && <Banner tone="warning" title={roleLock}>The other changes can still be sent.</Banner>}
      {shownTab && renderPanel(shownTab)}
      {ticked.size >= MAX_BATCH_DESTINATIONS && !locked && <p className={styles.muted}>{batchLimitText(word)}</p>}
      {waitingHint && <p className={styles.muted}>{waitingHint}</p>}

      {/* Ended and Delete (and an Amazon SKU move, S10): the publisher's own typed confirmation (the family SKU), last, right above the button. */}
      {action.confirm && !locked && <div className={styles.confirm}>
        {/* S10 — what a move deletes, and that a refused new SKU deletes nothing (the server's own words). */}
        {action.confirm.moved ? [...new Set(action.content.map(key => entryOf(key).review?.confirm?.sentence).filter((line): line is string => !!line))]
          .map(line => <p key={line}>{line}</p>) : null}
        <ConfirmPhraseField phrase={action.confirm.expected} value={confirmText} onChange={setConfirmText} disabled={!!busy}
          label={<>Type <strong className="nds-confirm-h">{action.confirm.expected}</strong> {confirmWhat(action.confirm)}</>} />
      </div>}

      {singleKey && !locked && (singleState?.kind === 'error' || singleState?.kind === 'blocked') && <div className={styles.actions}>
        <Button size="sm" disabled={!!busy || blockedSave} onClick={() => checkAgain(singleKey)}>Refresh review</Button>
        <Button size="sm" disabled={!!busy} onClick={onClose}>Back to editing</Button>
      </div>}
    </div>
  </Modal>
}
