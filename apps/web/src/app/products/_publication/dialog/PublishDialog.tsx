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
 * one summary line and one table (`ReviewTable`: one row per change; with more than one market, "All markets" lists every
 * market's in one table first — grid audit wave 3). Ended and Delete read as removals (the danger tone); nothing is typed
 * to send them, and they need products.publish like every other change (Owner 2026-10-19). One market with
 * content only sends through the single-publish path exactly as before; several markets, a ticked status change or a
 * value to clear go to the background batch (`POST /api/publication-batches { plan }`), which keeps sending when the
 * dialog closes. Done offers Undo for Inactive and Ended (Status Active again, reviewed anew); a Delete cannot be undone.
 *
 * The frame (Owner audit 2026-10-19): a grey button says why beside it; after a batch, "All markets" lists every market's
 * results (a Where column) and each tab its own, with the review that was sent in a closed "What was reviewed" fold; a
 * single publish the channel refused in part or whole offers "Review again"; each error is titled by what failed; the X
 * is held (and says why) while a publish starts.
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
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react'
import type { StudioPublishResult, StudioPublishScope, StudioPublishSelection } from '@nexus/shared/studio-publication'
import { fillResultSentence, type PublishActionWriteResult } from '@nexus/shared/publish-actions'
import { defaultLifecycleTicks, type PublishPlan, type PublishPlanBatchView } from '@nexus/shared/publish-plan'
import { Button, Pill } from '@/design-system/primitives'
import type { Tone } from '@/design-system/primitives/tone'
import { Banner, Disclosure, JobProgress, Modal, Tabs, tabPanelProps } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { saveFirstNotice } from '@/app/products/[id]/edit/_studio/saveFirst'
import { PublishStatusPill, publicationStatusMeta } from '@/design-system/grid'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { matchesPublicationSelection, matchesPublishPlan, optionListingLabel, retainPublicationReceipt, type PublicationDestinationOption } from './model'
import { publicationRequest as request, requestFailure } from './request'
import { isRefusedResult, isSettled, publicationEventOf, publicationOutcome, publishErrorTitle, publishSendsWords, resultCounts, type PublishErrorKind } from './outcome'
import {
  EMPTY_ENTRY, MAX_BATCH_DESTINATIONS, REQUEST_PAUSE_MS, ReviewQueue, accountGroup, batchCancellable, batchLimitText, batchPlaces as countBatchPlaces, batchProgress,
  batchSending, batchSentence, batchTone, checkingButtonText, checkingProgress, destinationName, destinationPlace, destinationState, destinationStateLabel, euRefusal,
  initialTicked, initialTicks, isSparse, placesWord, publishButtonText, publishPlan, requestOutstanding, requestsDue, reviewOrder, tickedChanges, withInitialOptions,
  type DestinationEntry, type DestinationState, type ListedDestinations,
} from './destinations'
import {
  PLAN_CHANGED, PLAN_OUT_OF_DATE, actionPlanRows, actionPlanSend, createdCounts, destinationChildren, planBatchSentence, planButtonText, planFamilySummary,
  planResultRows, planResultWord, planStateLabel, planSubmit, planSummaryLine, planTabWords, planUndo, tickedLifecycleRows,
  undoButtonText, undoSentence, type PlanResultRow,
} from './actionPlan'
import { activeTab, initialChoice, marketOptionLabel, marketTabLabel, marketTabParts, refillChoice, type PickerChoice } from './pickers'
import { DestinationPicker } from './DestinationPicker'
import { ReviewBody } from './ReviewBody'
import { ReviewTable, type ReviewTableMarketProps } from './ReviewTable'
import { marketStateRow } from './reviewRows'
import { ManyPublishDialog, type ManyPublishDialogProps } from './ManyPublishDialog'
import styles from './publication.module.css'

export { publicationDestinationParts } from './ReviewBody'

/** How the opening surface's autosave meets the dialog: a review waits for saving to finish. */
type ResultRow = StudioPublishResult['results'][number]
// The widths fit the window's body (1040 px window; grid audit D2 — the 620 px body cut the end of every message): the
// channel's words wrap, whole.
const REFUSED_COLUMNS: Column<ResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku}>{row.sku}</span> },
  { key: 'message', label: 'What the channel said', width: 780, className: styles.textCol, render: row => <span className={styles.fix}>{row.message}</span> },
]
/** A market's results once the batch sent it: the content, and each listing of each status change. A phone scrolls sideways. */
const PLAN_RESULT_COLUMNS: Column<PlanResultRow>[] = [
  { key: 'sku', label: 'SKU', width: 180, className: styles.skuCol, render: row => <span className={styles.sku}>{row.sku}</span> },
  { key: 'what', label: 'What', width: 160, className: styles.textCol, render: row => <span className={styles.fix}>{row.what}</span> },
  { key: 'result', label: 'Result', width: 160, render: row => <span title={row.meta.hint}><PublishStatusPill meta={row.meta} /></span> },
  { key: 'message', label: 'What the channel said', width: 460, className: styles.textCol, render: row => <span className={styles.fix}>{row.message ?? row.meta.hint}</span> },
]
/** "All markets" after a send: every market's results in one table, with the market in a Where column. */
type WhereResultRow = PlanResultRow & { where: string }
const ALL_RESULT_COLUMNS: Column<WhereResultRow>[] = [
  { key: 'where', label: 'Where', width: 110, className: styles.textCol, render: row => <span className={styles.fix}>{row.where}</span> },
  { key: 'sku', label: 'SKU', width: 170, className: styles.skuCol, render: row => <span className={styles.sku}>{row.sku}</span> },
  { key: 'what', label: 'What', width: 150, className: styles.textCol, render: row => <span className={styles.fix}>{row.what}</span> },
  { key: 'result', label: 'Result', width: 150, render: row => <span title={row.meta.hint}><PublishStatusPill meta={row.meta} /></span> },
  { key: 'message', label: 'What the channel said', width: 380, className: styles.textCol, render: row => <span className={styles.fix}>{row.message ?? row.meta.hint}</span> },
]
/** "All markets": the first tab when more than one market is chosen — every market's changes in one table (wave 3). */
const ALL_MARKETS = '__all__'

/**
 * After a send, the review that was sent: closed under the results, drawn only once opened (a grid in a closed fold has
 * no width to lay out in).
 */
function ReviewedFold({ children }: { children: () => ReactNode }) {
  const [open, setOpen] = useState(false)
  return <Disclosure summary="What was reviewed" onToggle={event => setOpen(event.currentTarget.open)}>{open ? children() : null}</Disclosure>
}

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
      setActive(ALL_MARKETS)
      return
    }
    if (listedKeys && !filledListed.current) { filledListed.current = true; setChoice(initialChoice(options, firstTicked, listedKeys)); return }
    if (!choice.channel) setChoice(initialChoice(options, firstTicked, listedKeys))
  }, [choice.channel, options, firstTicked, firstSignature, listedKeys])
  const ticked = useMemo(() => new Set(choice.keys), [choice.keys])
  // With more than one market the window opens on "All markets": every change of every market in one table, no tab to
  // click through (grid audit wave 3). One market: its own tab, as before.
  const [active, setActive] = useState<string | null>(ALL_MARKETS)
  const tabKeys = useMemo(() => (choice.keys.length > 1 ? [ALL_MARKETS, ...choice.keys] : choice.keys), [choice.keys])
  const shownTab = activeTab(tabKeys, active)
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
  const [error, setError] = useState<{ kind: PublishErrorKind; message: string } | null>(null)
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
        update(key, { plan: planned, review, loading: false, error: null,
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
    setEntries({}); setError(null); setNotice(next)
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
    // Unsaved edits: nothing is sent; the review is made again once they are saved. The reason is said once, above.
    const saveBlocker = save.blocker()
    if (saveBlocker) { update(key, { review: null, plan: null }); setError({ kind: 'send', message: saveBlocker }); return }
    sending.current = true; setBusy('publish'); setError(null); setSentKey(key)
    const id = review.id
    try { acceptResult(await request<StudioPublishResult>(`${base}/${encodeURIComponent(id)}/submit`, 'POST', { locationId: entry.locationId, confirmOverwrite: entry.confirmedReviewId === id, selectionToken: entry.selection?.token }), id) }
    catch (e) {
      const status = (e as { status?: number }).status
      setUncertain(!status || status >= 500)
      // Refused (nothing was sent): the market is reviewed again; why it was refused is said once, above.
      if (status && status < 500) update(key, { review: null, plan: null, selection: null })
      setError({ kind: 'send', message: message(e) })
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
    catch (e) { setError({ kind: 'status', message: message(e) }) }
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
    catch (e) { setError({ kind: 'progress', message: message(e) }) }
  }, [])
  const sendPlan = async () => {
    if (!action.batch || busy || locked || plan.needsRequest.length || plan.pending.length || !action.send.length || !canPublish || blockedSave) return
    const saveBlocker = save.blocker()
    if (saveBlocker) { setError({ kind: 'start', message: saveBlocker }); return }
    setBusy('batch'); setError(null); setEu(null); setNotice(null)
    try {
      const body = planSubmit(productId, action, entryOf, scopeOf)
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
      if (refusal) setEu(refusal); else setError({ kind: 'start', message: message(e) })
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
    catch (e) { setError({ kind: 'cancel', message: message(e) }) }
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
    } catch (e) { setError({ kind: 'undo', message: message(e) }) }
    finally { setBusy(null) }
  }

  // The earlier publish just got its answer: the review below was made while it blocked the destination, so its notes
  // are out of date. Offer a fresh review instead of showing two statements that disagree.
  const staleReview = !!result && !!singleReview?.previousPublicationId && singleReview.previousPublicationId === result.id && isSettled(result.status)
  // A button that removes itself (Review again, Check again, Open IT) hands the focus to the panel it opened or refreshed,
  // never to the page behind the window.
  const panelRef = useRef<HTMLDivElement>(null)
  const focusPanel = useRef(false)
  const [focusTick, setFocusTick] = useState(0)
  const focusPanelNext = useCallback(() => { focusPanel.current = true; setFocusTick(n => n + 1) }, [])
  useEffect(() => {
    if (!focusPanel.current || result || uncertain) return
    focusPanel.current = false
    panelRef.current?.focus()
  }, [focusTick, result, uncertain, shownTab])
  // A stale review, or a publish the channel refused in part or whole: a new review of the market that was sent.
  const reviewAgain = () => {
    const again = sentKey ?? singleKey
    focusPanelNext()
    setResult(null); setUncertain(false); setError(null); setSentKey(null)
    if (again) checkAgain(again)
  }
  const checkAgainHere = (key: string) => { focusPanelNext(); checkAgain(key) }
  const openMarket = (key: string) => { focusPanelNext(); setActive(key) }

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
  const waitingHint = !locked && !checkingNow && plan.pending.length > 0
    ? `${plan.pending.length} ${plan.pending.length === 1 ? 'destination is' : 'destinations are'} not ready yet: ${plan.pending.map(key => { const o = optionOf(key); return `${o ? destinationName(o) : ''} (${destinationStateLabel(stateOf(key)).label.toLowerCase()})` }).join(', ')}.`
    : null
  const checkNowFirst = uncertain || (earlierWaiting && !action.lifecycle.length)
  // Why the one button is grey, in the footer beside it and read with it (aria-describedby): what holds the one market,
  // or which markets are not ready. A wait the button names itself ("Checking…", "Publishing…") and
  // a reason a banner above gives (permission, saving) are not repeated here.
  const footReason = (() => {
    if (batch || result || checkNowFirst || locked || busy || sendWaiting || checkingNow || blockedSave || !canPublish || discoveryFailed) return null
    if (listed?.loading && !choice.keys.length) return null
    if (tickedKeys.length > 1 || action.batch) return waitingHint
    if (!singleKey || !singleState) return options.length ? 'Choose a market above.' : null
    if (singleState.kind === 'ready') return null
    const shown = destinationStateLabel(singleState)
    return shown.hint.startsWith(shown.label) ? shown.hint : `${shown.label}. ${shown.hint}`
  })()
  const primary = (() => {
    if (batch) return null
    if (checkNowFirst) return <Button size="sm" disabled={!!busy} onClick={checkStatus}>{busy === 'status' ? 'Checking…' : 'Check now'}</Button>
    // A stale review, or products the channel refused: a new review of the market (the result stays above until then).
    if (staleReview || (result && isRefusedResult(result.status))) return <Button size="sm" variant="primary" disabled={!!busy || blockedSave} onClick={reviewAgain}>Review again</Button>
    if (result) return null
    // The one button keeps its place while the window works; its words wrap on a phone (the DS `sm` + `wrap` button grows).
    const one = { size: 'sm' as const, wrap: true, 'aria-describedby': footReason ? reasonId : undefined }
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
    return <Button {...one} variant={action.removes ? 'danger' : 'primary'} disabled={!multiReady}
      onClick={publish}>{busy === 'batch' ? 'Publishing…' : text}</Button>
  })()
  // Markets with nothing to send stay as quiet tabs: they are not counted in the line above the tabs.
  const quiet = plan.nothing.filter(key => !action.send.includes(key))
  const counted = choice.keys.length - quiet.length

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
  // A long listing name ends with an ellipsis (its whole name on hover); what the review says is always shown whole —
  // so a tab never runs past a phone's width (review 2026-10-05).
  const allTab = tabKeys[0] === ALL_MARKETS ? [{ id: ALL_MARKETS, label: <span className={styles.tabLabel}><span className={styles.tabName}>{`All ${word.many}`}</span></span> }] : []
  const tabs = [...allTab, ...choice.keys.flatMap(key => {
    const o = optionOf(key)
    if (!o) return []
    const said = sentWord(key) ?? planTabWords(stateOf(key), entryOf(key))
    const { name, words } = marketTabParts(o, stateOf(key), said)
    return [{ id: key, label: <span className={styles.tabLabel} title={marketTabLabel(o, stateOf(key), said)}>
      <span className={styles.tabName}>{name}</span><span className={styles.tabWords}>{` · ${words}`}</span></span> }]
  })]
  const renderPanel = (key: string) => {
    const option = optionOf(key)
    if (!option) return null
    const entry = entryOf(key), state = stateOf(key), kids = childrenOf(key)
    const shown = planStateLabel(state, entry, destinationStateLabel(state))
    const status = kids.length || batch || (result && key === shownKey) ? null
      : <span className={styles.resultTitle}><Pill tone={shown.tone} dot>{shown.label}</Pill><span className={styles.muted}>{shown.hint}</span></span>
    // One "Check again" per market, under its status (a review error's banner carries its own).
    const canCheckAgain = !locked && !(entry.error && !entry.plan)
      && (state.kind === 'expired' || state.kind === 'error' || (state.kind === 'blocked' && !state.request) || (state.kind === 'earlier' && choice.keys.length > 1))
    const requestFailed = !locked && state.kind === 'blocked' && !!state.request
    const stale = staleReview && key === singleKey
    const own = entry.plan ? actionPlanSend([key], stateOf, entryOf) : null
    const rows = entry.plan ? actionPlanRows(entry, state, now) : []
    // An alias (or the main listing of a market with aliases) is named with the band's mark; else the plan's own words.
    const place = optionListingLabel(option) ? destinationPlace(option.scope, option) : entry.plan?.label ?? destinationPlace(option.scope)
    const planPart = entry.plan && own ? {
      key, channel: option.scope.channel, label: place, summary: planSummaryLine(own.counts, own.wholeProducts, own.content.includes(key) ? createdCounts(rows) : null), rows,
      lifecycleIds: entry.lifecycleIds, contentError: entry.plan.error, now, onTicksChange: (next: { selectedIds: string[]; lifecycleIds: string[] }) => chooseTicks(key, next),
    } : null
    const review = entry.plan && !stale ? () => <ReviewBody review={entry.review} selectedIds={entry.selectedIds} plan={planPart} listing={optionListingLabel(option)}
      selection={matchesPublicationSelection(entry.selection, entry.review, tickedChanges(entry)) ? entry.selection : null}
      selecting={entry.selecting || requestOutstanding(state, entry)} nexusWins
      locationId={entry.locationId} confirmed={!!entry.review && entry.confirmedReviewId === entry.review.id} locked={locked || !!busy || sendWaiting}
      onSelectionChange={ids => choose(key, ids)} onLocationChange={id => update(key, { locationId: id })}
      onConfirmChange={confirmed => update(key, { confirmedReviewId: confirmed ? entry.review?.id ?? null : null })} /> : null
    return <div className={styles.tabPanel} {...tabPanelProps(tabBase, key)} ref={panelRef} aria-label={`Review for ${marketOptionLabel(option)}`}>
      {status}
      {kids.length > 0 && <DataGrid ariaLabel={`Results on ${place}`} size="sm" columns={PLAN_RESULT_COLUMNS}
        rows={planResultRows(kids, productLabel, tickedLifecycleRows(entry))} rowKey={row => row.key} />}
      {batch && !kids.length && <p className={styles.muted}>Nothing was sent to {place} in this publish.</p>}
      {canCheckAgain && <div className={styles.actions}><Button size="sm" onClick={() => checkAgainHere(key)} aria-label={`Check ${destinationName(option)} again`}>Check again</Button></div>}
      {requestFailed && <div className={styles.actions}><Button size="sm" disabled={!!busy || sendWaiting} onClick={() => { focusPanelNext(); retryRequest(key) }} aria-label={`Build the exact request for ${destinationName(option)} again`}>Try again</Button></div>}
      {entry.error && !entry.plan && <Banner tone="danger" title="Review could not complete" action={!locked && <Button size="sm" onClick={() => checkAgainHere(key)}>Check again</Button>}>{entry.error}</Banner>}
      {!entry.plan && !entry.error && <p className={styles.muted}>Reading the saved values, the waiting status changes and the channel for {marketOptionLabel(option)}…</p>}
      {entry.review && stale && <p>This review was made while that publish was still waiting, so its notes are out of date. Review again to publish to {placeOf(key, entry.review.scope)}.</p>}
      {review && (batch ? <ReviewedFold key={key}>{review}</ReviewedFold> : review())}
    </div>
  }

  /**
   * "All markets": every chosen market's rows in one table; a market not ready says why in a row of its own. After a
   * send: every market's results (with a Where column), and the review that was sent in a closed fold.
   */
  const renderAll = () => {
    const markets: ReviewTableMarketProps[] = choice.keys.flatMap(key => {
      const option = optionOf(key)
      if (!option) return []
      const entry = entryOf(key), state = stateOf(key)
      const label = optionListingLabel(option) ? destinationPlace(option.scope, option) : entry.plan?.label ?? destinationPlace(option.scope)
      return [{ key, label, channel: option.scope.channel, rows: entry.plan ? actionPlanRows(entry, state, now) : [], review: entry.review,
        selectedIds: entry.selectedIds, lifecycleIds: entry.lifecycleIds, state: marketStateRow(state),
        onTicksChange: (next: { selectedIds: string[]; lifecycleIds: string[] }) => chooseTicks(key, next) }]
    })
    const review = <ReviewTable allMarkets markets={markets} locked={locked || !!busy || sendWaiting} now={now} ariaLabel={`Changes in this publish to ${choice.keys.length} ${word.many}`}
      onCheckAgain={checkAgainHere} onOpen={openMarket} />
    if (!batch) return <div className={styles.tabPanel} {...tabPanelProps(tabBase, ALL_MARKETS)} ref={panelRef} aria-label={`Review for all ${word.many}`}>{review}</div>
    const results: WhereResultRow[] = markets.flatMap(m => planResultRows(childrenOf(m.key), productLabel, tickedLifecycleRows(entryOf(m.key)))
      .map(row => ({ ...row, key: `${m.key}|${row.key}`, where: m.label })))
    return <div className={styles.tabPanel} {...tabPanelProps(tabBase, ALL_MARKETS)} ref={panelRef} aria-label={`Results for all ${word.many}`}>
      <DataGrid ariaLabel={`Results on ${choice.keys.length} ${word.many}`} size="sm" columns={ALL_RESULT_COLUMNS} rows={results} rowKey={row => row.key}
        emptyState="No results yet." />
      <ReviewedFold key={ALL_MARKETS}>{() => review}</ReviewedFold>
    </div>
  }

  const progress = batch ? batchProgress(batch) : null
  const batchPlaces = batch ? countBatchPlaces(batch.children) : 0

  // The size of the Import window (grid audit D1: a 660 px box left 300 px for the review); a full-screen sheet on a phone.
  // While a publish starts (or its status is read), the window cannot close: the X says why instead of doing nothing.
  const closeHeld = !pending ? null : busy === 'status' ? 'This window can close once the status is read.'
    : busy === 'batch' ? 'This window can close once the publish has started.' : 'This window can close once the publish is sent.'
  return <Modal open onClose={() => { if (!pending) onClose() }} closeHeld={closeHeld} size="xxl" title="Publish product"
    subtitle={`${productLabel} · ${publishSendsWords(action.counts, action.wholeProducts)}`}
    footer={<>
      {footReason && <span id={reasonId} className={`grow ${styles.footReason}`}>{footReason}</span>}
      <Button size="sm" disabled={pending} onClick={onClose}>{result || batch ? 'Done' : 'Cancel'}</Button>
      {batch && !batch.done && <Button size="sm" disabled={!!busy} onClick={() => void readBatch(batch.batchId)}>Check now</Button>}
      {batchCancellable(batch) && <Button size="sm" variant="secondary" disabled={!!busy} onClick={() => void cancelBatch()}>Stop sending the rest</Button>}
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
      {error && <Banner tone="danger" title={publishErrorTitle(error.kind, uncertain)}>{error.message}</Banner>}
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
      {result && result.results.some(r => r.status === 'FAILED') && <DataGrid ariaLabel="Products the channel refused" size="sm" columns={REFUSED_COLUMNS}
        rows={result.results.filter(r => r.status === 'FAILED')} rowKey={row => row.sku} />}
      {!!result?.warnings?.length && <Disclosure open summary={`${result.warnings.length} ${result.warnings.length === 1 ? 'note' : 'notes'} from the channel`}>
        <ul className={styles.issues}>{result.warnings.map(message => <li key={message}>{message}</li>)}</ul>
      </Disclosure>}
      {batch && progress && <>
        <Banner tone={batchTone(batch)} title={`Publish to ${batchPlaces} ${batchPlaces === 1 ? word.one : word.many}`}
          action={<Button asChild size="sm"><Link href="/listings/publish-status">Open Publish history</Link></Button>}>
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
      {shownTab === ALL_MARKETS ? renderAll() : shownTab && renderPanel(shownTab)}
      {ticked.size >= MAX_BATCH_DESTINATIONS && !locked && <p className={styles.muted}>{batchLimitText(word)}</p>}

      {/* S10 — what an Amazon SKU move deletes, and that a refused new SKU deletes nothing (the server's own words), last,
          right above the button. Nothing is typed (Owner 2026-10-19). */}
      {action.moving.length > 0 && !locked && <div className={styles.moveNote}>
        {[...new Set(action.moving.map(key => entryOf(key).review?.confirm?.sentence).filter((line): line is string => !!line))].map(line => <p key={line}>{line}</p>)}
      </div>}

    </div>
  </Modal>
}
