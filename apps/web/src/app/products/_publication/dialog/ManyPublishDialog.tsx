'use client'

/**
 * The Publish dialog for many products (sheet publish parity T1), opened from the products list.
 *
 * Three stages, one window:
 *  1. Pick — choose the channel and its markets (Amazon and eBay), optionally "Also replace values changed on the channel", then check.
 *  2. Check — the server reviews every family × market in the background (it keeps going if the window closes) and
 *     waits; the window shows one row per family × market with what would be sent and why a row is skipped.
 *  3. Send — one counted button sends the ready rows; the same status rows, progress and cancel as a market batch.
 * Nothing is sent before the counted button. Each row is reviewed like a single publish: only the fields Nexus changed
 * since the last accepted publish are ticked.
 *
 * Build shape v2 (P11) — an **Action** picker above the markets: Send changes (the content, as above) or one Status for
 * every listing of the products in the chosen markets (Set Active · Set Inactive · Set Ended; no Delete here). A Status
 * is checked by the listing-action engine: one row per product × market with its listings, a summary per market tab
 * ("Inactive on Amazon · DE: 36 listings · 4 cannot"), and one counted button ("Set 36 listings inactive on 2 markets").
 * Set Ended needs permission to delete products and the typed count of listings it ends. It sends in the background;
 * the results appear in Publish history.
 *
 * New listings (ND4 B, Owner 2026-10-04) — with Send changes, "New listings start as: As each row says · Active ·
 * Inactive" (a SegmentedControl, its hint under it): how every listing the changes CREATE starts (`options.startAs`). A
 * Status action hides it (it applies only to listings the changes create). A checked row says what it creates
 * ("Creates GALE-M (inactive)."), and the summary counts them.
 *
 * One-click O5 (Owner 2026-10-04, OD3 A + OD4 A) — the studio window's rules: the Markets picker starts with every
 * market where a ticked product is listed (Active or Inactive; removable); Nexus wins, with a "Keep channel values"
 * switch (off by default); a product not listed in a market is skipped there with the reason (unless "New listings start
 * as" is chosen); one button: Check → "Checking 1 of 3 markets…" → "Publish 120 changes to 3 markets · skip 2 with
 * problems" (the server builds every request while it checks); each market tab says how many values differ.
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import {
  MANY_PUBLISH_ACTION_LABEL, START_AS_LABEL, TYPE_COUNT_TO_END, createsSentence, isStartAsTarget,
  type ListedStatusTarget, type ManyPublishAction, type PublishPlanBatchChild, type PublishPlanBatchView, type StartAsTarget,
} from '@nexus/shared/publish-plan'
import { Button, Pill, SegmentedControl, Toggle } from '@/design-system/primitives'
import { Banner, ConfirmPhraseField, JobProgress, Listbox, Modal, phraseMatches, Tabs, tabPanelProps } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishStatusPill } from '@/design-system/grid'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePermission } from '@/lib/auth/AuthProvider'
import Link from '@/lib/workspaces/Link'
import { publicationRequest as request } from './request'
import { publicationEventOf } from './outcome'
import { batchCancellable, batchChildMeta, batchProgress, batchSentence, batchTone, euRefusal, MAX_BATCH_DESTINATIONS } from './destinations'
import { planBatchSentence, planChildMeta } from './actionPlan'
import type { PublicationDestinationOption } from './model'
import { activeTab, childMarketKey, initialChoice, marketShortLabel, refillChoice, type PickerChoice } from './pickers'
import { DestinationPicker } from './DestinationPicker'
import {
  KEEP_CHANNEL_VALUES_HINT, KEEP_CHANNEL_VALUES_LABEL, MANY_ALIASES_NOTE, MANY_CHANNELS_NOTE, MANY_STATUS_CHANNELS_NOTE, MANY_STATUS_HINT, estimateText, keepChannelValuesState,
  manyActionOptions, manyBatchOptions, manyCapMessage, manyCheckButtonText, manyCheckingText, manyCreatesSummary, manyDestinationLabel,
  manyDestinationOptions, manyDiffersSummary, manyListedNote, manyListedSet, manyMarketName, manyMarketTabWords, manyNotListedSummary, manyPlan, manyPlanSummary,
  manyPublishButtonText, manyRequest, manyReviewed, manyReviewing, manyRowLabel, manyRowState,
  manyStartAsHint, manyStartAsLine, manyStartAsOptions,
  manyStatusButtonText, manyStatusMarketSummary, manyStatusPlan, manyStatusRowLabel, manyStatusRows, manyStatusSummary, manyStatusTabWords, reviewProgress,
  type ManyListedMarkets, type ManyStatusRow,
} from './many'
import { ManyRowReview, ManyStatusDetails } from './ManyRowReview'
import styles from './publication.module.css'

export interface ManyPublishDialogProps {
  /** The selected products. A selected variation means its family; the server removes duplicates. */
  productIds: string[]
  /** How many families the selection reaches. */
  familyCount: number
  /** Every destination of the business; Send changes offers Amazon and eBay, a Status every channel. */
  destinations: PublicationDestinationOption[]
  loadingDestinations?: boolean
  discoveryFailed?: boolean | null
  onClose(): void
}

type Busy = 'check' | 'submit' | 'cancel' | 'read' | null
const READ_MS = 4_000
const LISTING = { one: 'listing', many: 'listings' }
const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const plural = (n: number, one: string, many: string) => `${n.toLocaleString('en')} ${n === 1 ? one : many}`
const SUCCEEDED = new Set(['DONE', 'ACCEPTED', 'VERIFIED'])
/** One product × market of a Status batch, once sent: the child still moving, else the one that did not succeed, else done. */
function statusGroupMeta(children: readonly PublishPlanBatchChild[]) {
  const open = children.find(child => !child.terminal)
  return planChildMeta(open ?? children.find(child => !SUCCEEDED.has(child.status.toUpperCase())) ?? children[0])
}

export function ManyPublishDialog({ productIds, familyCount, destinations, loadingDestinations = false, discoveryFailed = null, onClose }: ManyPublishDialogProps) {
  const canPublish = usePermission('products.publish')
  const canEnd = usePermission('products.delete')
  // P11 — what the window does: Send changes, or one Status for every listing there.
  const [action, setAction] = useState<ManyPublishAction>('content')
  const status: ListedStatusTarget | null = action === 'content' ? null : action
  // ND4 B — how the listings the changes create start; null = as each row says (nothing is sent).
  const [startAs, setStartAs] = useState<StartAsTarget | null>(null)
  const options = useMemo(() => manyDestinationOptions(destinations, action), [destinations, action])
  // One-click O5 — where the ticked products are listed (Active or Inactive): the pickers start with those markets.
  const productKey = productIds.join('\n')
  const [listed, setListed] = useState<ManyListedMarkets | null>(null)
  const [listedState, setListedState] = useState<'loading' | 'done' | 'failed'>('loading')
  useEffect(() => {
    const controller = new AbortController()
    setListedState('loading')
    request<ManyListedMarkets>('/api/publication-batches/listed-markets', 'POST', { productIds: productKey.split('\n') }, controller.signal)
      .then(data => { if (!controller.signal.aborted) { setListed(data); setListedState('done') } })
      .catch(() => { if (!controller.signal.aborted) setListedState('failed') })
    return () => controller.abort()
  }, [productKey])
  const listedSet = useMemo(() => manyListedSet(listed), [listed])
  // The compact pickers (Owner, 2026-10-02): one channel, one account, the markets. The markets (and where the products
  // are listed) arrive after the window opens, so until the person picks, the choice follows them: the first channel and
  // account where a product is listed, with every such market (`initialChoice`); otherwise nothing is pre-chosen unless
  // the business has exactly one destination. A channel the chosen action does not reach starts the choice again.
  const [choice, setChoice] = useState<PickerChoice>(() => initialChoice(options, []))
  const [touched, setTouched] = useState(false)
  const [batch, setBatch] = useState<PublishPlanBatchView | null>(null)
  useEffect(() => {
    if (batch) return
    const lost = options.length > 0 && !options.some(o => o.scope.channel === choice.channel && o.scope.accountId === choice.accountId)
    if ((!touched && listedSet) || lost) setChoice(initialChoice(options, [], listedSet))
  }, [choice.channel, choice.accountId, options, listedSet, touched, batch])
  const [typed, setTyped] = useState('')
  const ticked = useMemo(() => new Set(choice.keys), [choice.keys])
  const [active, setActive] = useState<string | null>(null)
  const tabBase = useId()
  const keepLabelId = useId(), keepHintId = useId()
  // One-click O5 — Nexus wins unless "Keep channel values" is on.
  const [keepChannelValues, setKeepChannelValues] = useState(false)
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState<string | null>(null)
  const [eu, setEu] = useState<{ title: string; lines: string[] } | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [startedAt, setStartedAt] = useState<number | null>(null)
  const [announced, setAnnounced] = useState<{ key: string; message: string } | null>(null)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(t) }, [])

  const tickedOptions = useMemo(() => options.filter(o => ticked.has(o.key)), [options, ticked])
  const optionOf = useCallback((key: string) => options.find(o => o.key === key), [options])
  const cap = manyCapMessage(productIds.length, familyCount, tickedOptions.length)

  const read = useCallback(async (id: string) => {
    try { setBatch(await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(id)}`, 'GET')); setError(null) }
    catch (e) { setError(message(e)) }
  }, [])
  const check = async () => {
    if (busy || !tickedOptions.length || cap || !canPublish || (status === 'ended' && !canEnd)) return
    setBusy('check'); setError(null); setEu(null); setTyped('')
    try {
      const created = await request<{ batchId: string }>('/api/publication-batches', 'POST', manyRequest(productIds, tickedOptions.map(o => o.scope), keepChannelValues, action, startAs))
      setStartedAt(Date.now())
      await read(created.batchId)
    } catch (e) { setError(message(e)) }
    finally { setBusy(null) }
  }
  const submit = async () => {
    if (!batch || busy) return
    setBusy('submit'); setError(null); setEu(null)
    try {
      setBatch(await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/submit`, 'POST', status === 'ended' ? { confirmText: typed } : {}))
      setStartedAt(Date.now())
    } catch (e) {
      const refusal = euRefusal(e)
      if (refusal) setEu(refusal)
      else { setError(message(e)); void read(batch.batchId) }
    }
    finally { setBusy(null) }
  }
  const cancel = async () => {
    if (!batch || busy) return
    setBusy('cancel'); setError(null)
    try { setBatch(await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {})) }
    catch (e) { setError(message(e)) }
    finally { setBusy(null) }
  }
  // "Check again": the reviewed batch is closed (nothing of it was sent) and the same markets are checked anew.
  const checkAgain = async () => {
    if (!batch || busy) return
    setBusy('cancel'); setError(null)
    try { await request<PublishPlanBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {}) }
    catch { /* already closed: start again regardless */ }
    finally { setBusy(null) }
    setBatch(null); setExpanded(new Set()); setEu(null); setTyped('')
  }
  const pickAction = (next: string) => {
    if (batch) return
    setAction(next as ManyPublishAction); setError(null); setTyped('')
  }

  // While the server is reviewing or sending, read the batch every few seconds; REVIEWED waits for the person.
  const moving = !!batch && ['REVIEWING', 'QUEUED', 'RUNNING', 'CANCELLING'].includes(batch.phase)
  useEffect(() => {
    if (!batch || !moving) return
    const t = setTimeout(() => void read(batch.batchId), READ_MS)
    return () => clearTimeout(t)
  }, [batch, moving, read])
  // The channels' answers arrive as events for the batch's publications.
  useInvalidationChannel('publication.status_changed', event => {
    const changed = publicationEventOf(event)
    if (batch && changed?.batchId === batch.batchId) void read(batch.batchId)
  })
  useEffect(() => {
    if (!batch?.done || batch.stage !== 'send') return
    const key = `${batch.batchId}:${batch.outcome}`
    if (announced?.key !== key) setAnnounced({ key, message: status ? planBatchSentence(batch) : batchSentence(batch, LISTING) })
  }, [batch, announced?.key, status])

  const reviewing = manyReviewing(batch), reviewed = manyReviewed(batch)
  const sending = !!batch && !reviewing && !reviewed
  const plan = useMemo(() => manyPlan(batch?.children ?? [], now), [batch, now])
  // P11 — a Status batch: one row per product × market, and what the one button sends.
  const statusRows = useMemo(() => (status ? manyStatusRows(batch?.children ?? [], now) : []), [status, batch, now])
  const statusPlan = useMemo(() => manyStatusPlan(statusRows, now), [statusRows, now])
  const ending = status === 'ended' ? statusPlan.ending : 0
  // The typed count confirms one number: when it changes (a check expired, a row was re-read), type it again.
  useEffect(() => { setTyped('') }, [ending])
  const endConfirmed = !ending || phraseMatches(typed, String(ending))
  const estimate = estimateText(batch)
  const progress = reviewProgress(batch)
  const sendProgress = sending && batch ? batchProgress(batch) : null
  // Another channel or account chooses its listed markets the same way (`refillChoice`); the person's pick stands after.
  const pick = (next: PickerChoice) => { if (!batch) { setTouched(true); setChoice(refillChoice(options, choice, next, listedSet)); setError(null) } }
  const onTicksSaved = useCallback(() => { if (batch) void read(batch.batchId) }, [batch?.batchId, read])
  const toggle = (id: string) => setExpanded(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })
  const detailsButton = (id: string, sku: string | null | undefined, where: string) => {
    const open = expanded.has(id)
    return <Button size="sm" variant="ghost" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for ${sku ?? 'this product'} on ${where}`}
      onClick={() => toggle(id)}>{open ? 'Hide' : 'Details'}</Button>
  }

  // ── stages 2 and 3: one row per family × market ────────────────────────────────────────────────────────────────
  const rowStatus = (child: PublishPlanBatchChild) => {
    if (sending) return <PublishStatusPill meta={batchChildMeta(child)} />
    const shown = manyRowLabel(manyRowState(child, now))
    return <span title={shown.hint}><Pill tone={shown.tone} dot>{shown.label}</Pill></span>
  }
  // The verdict sits next to the product, so a phone shows it without scrolling sideways.
  const rowColumns: Array<Column<PublishPlanBatchChild>> = [
    { key: 'product', label: 'Product', render: c => { const creates = createsSentence(c.creates ?? []); return <span className={styles.destination}><strong>{c.familySku ?? '—'}</strong>{c.familyTitle && <span className={styles.muted}>{c.familyTitle}</span>}{creates && <span className={styles.muted}>{creates}</span>}</span> } },
    { key: 'review', label: sending ? 'Result' : 'Review', render: rowStatus },
    { key: 'changes', label: 'Changes', numeric: true, render: c => { const s = manyRowState(c, now); return s.kind === 'ready' ? s.changes.toLocaleString('en') : '—' } },
    { key: 'details', label: <span className="nds-vh">Details</span>, render: c => detailsButton(c.publicationId, c.familySku, manyDestinationLabel(c, options)) },
  ]
  // P11 — a Status row: the product × market's verdict before the send, its result after; the listings it changes.
  const statusColumns: Array<Column<ManyStatusRow>> = [
    { key: 'product', label: 'Product', width: 230, render: r => <span className={styles.sentCell}><strong>{r.familySku ?? '—'}</strong>{r.familyTitle && <span className={`${styles.muted} ${styles.clamp}`} title={r.familyTitle}>{r.familyTitle}</span>}</span> },
    { key: 'review', label: sending ? 'Result' : 'Review', width: 150, render: r => {
      if (sending) { const meta = statusGroupMeta(r.children); return <span title={meta.hint}><PublishStatusPill meta={meta} /></span> }
      const shown = manyStatusRowLabel(r, status ?? 'inactive')
      return <span title={shown.hint}><Pill tone={shown.tone} dot>{shown.label}</Pill></span>
    } },
    { key: 'listings', label: 'Listings', numeric: true, width: 120, render: r => r.send ? `${r.send.toLocaleString('en')}${r.refused ? ` · ${r.refused.toLocaleString('en')} cannot` : ''}`
      : r.refused ? `${r.refused.toLocaleString('en')} cannot` : '—' },
    { key: 'details', label: <span className="nds-vh">Details</span>, width: 90, render: r => detailsButton(r.key, r.familySku, manyMarketName(r)) },
  ]
  const renderStatusRow = (r: ManyStatusRow) => expanded.has(r.key)
    ? <div className={styles.expanded}><ManyStatusDetails row={r} sent={sending} /></div> : null
  // A row opened: its saved review with its ticks (T1). Changing a tick saves it and re-reads the batch's counts.
  const renderRow = (c: PublishPlanBatchChild) => {
    if (!expanded.has(c.publicationId)) return null
    return <div className={styles.expanded}>
      <ManyRowReview child={c} sending={sending || !!busy} onTicksSaved={onTicksSaved} />
    </div>
  }

  // ── one tab per market, its products under it ─────────────────────────────────────────────────────────────────
  const stage = reviewing ? 'reviewing' as const : reviewed ? 'reviewed' as const : 'sending' as const
  const families = batch?.request?.families ?? familyCount
  // The options the batch was made with (the server's echo, so they read the same after a reload), else this window's.
  const chosenOptions = manyBatchOptions(batch, { keepChannelValues, startAs })
  const listedNote = manyListedNote(choice.keys.filter(key => listedSet?.has(key)).length, listed)
  const marketKeys = useMemo(() => {
    const fromChildren = (batch?.children ?? []).map(childMarketKey)
    const chosen = choice.keys.filter(key => !batch || !fromChildren.length || fromChildren.includes(key))
    return [...new Set([...chosen, ...fromChildren])]
  }, [batch, choice.keys])
  const childrenOf = useCallback((key: string) => (batch?.children ?? []).filter(c => childMarketKey(c) === key), [batch])
  const statusRowsOf = useCallback((key: string) => statusRows.filter(r => r.marketKey === key), [statusRows])
  const shownTab = activeTab(marketKeys, active)
  const tabs = marketKeys.map(key => {
    const option = optionOf(key), rows = childrenOf(key)
    const code = option ? marketShortLabel(option) : rows[0]?.marketplace ?? key
    return { id: key, label: `${code} · ${status ? manyStatusTabWords(statusRowsOf(key), stage) : manyMarketTabWords(rows, stage, families, now)}` }
  })
  const shownMarket = shownTab ? (optionOf(shownTab) ? manyMarketName(optionOf(shownTab)!.scope) : manyMarketName(childrenOf(shownTab)[0] ?? { channel: null, marketplace: null })) : ''
  const marketSummary = status && shownTab ? manyStatusMarketSummary(statusRowsOf(shownTab), status, shownMarket) : null
  // One-click O5 — the shown market's Nexus-wins line and the products skipped there because they are not listed.
  const differsLine = !status && reviewed && shownTab ? manyDiffersSummary(childrenOf(shownTab), shownMarket, now) : null
  const notListedLine = !status && reviewed && shownTab ? manyNotListedSummary(childrenOf(shownTab), shownMarket, now) : null

  // ── footer ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const primary = (() => {
    if (!batch) {
      return <Button size="sm" variant="primary" disabled={!!busy || !tickedOptions.length || !!cap || !canPublish || loadingDestinations} onClick={() => void check()}>
        {busy === 'check' ? 'Starting the check…' : manyCheckButtonText(familyCount, tickedOptions.length)}</Button>
    }
    // One button (One-click O5): while the server checks (and builds every request), it says how far it is.
    if (reviewing) return <Button size="sm" variant="primary" disabled>{manyCheckingText(batch.children, marketKeys, families)}</Button>
    if (reviewed && status) {
      return <Button size="sm" variant={status === 'ended' ? 'danger' : 'primary'} disabled={!!busy || !statusPlan.listings || !canPublish || !endConfirmed || (status === 'ended' && !canEnd)}
        onClick={() => void submit()}>{busy === 'submit' ? 'Sending…' : manyStatusButtonText(statusPlan, status)}</Button>
    }
    if (reviewed) {
      return <Button size="sm" variant="primary" disabled={!!busy || !plan.listings || !canPublish} onClick={() => void submit()}>
        {busy === 'submit' ? 'Publishing…' : manyPublishButtonText(plan)}</Button>
    }
    return null
  })()

  return <Modal open onClose={() => { if (busy !== 'check' && busy !== 'submit') onClose() }} size="lg" readable title="Publish products"
    subtitle={`${plural(familyCount, 'product', 'products')} selected${productIds.length !== familyCount ? ` (${plural(productIds.length, 'row', 'rows')}: a selected variation publishes its whole product)` : ''}`}
    footer={<>
      <Button size="sm" disabled={busy === 'check' || busy === 'submit'} onClick={onClose}>{batch ? (batch.done ? 'Done' : 'Close') : 'Cancel'}</Button>
      {(reviewing || reviewed) && <Button size="sm" disabled={!!busy} onClick={() => void (reviewed ? checkAgain() : cancel())}>{reviewed ? 'Check again' : 'Stop checking'}</Button>}
      {sending && batch && !batch.done && <Button size="sm" disabled={!!busy} onClick={() => void read(batch.batchId)}>Check now</Button>}
      {sending && batchCancellable(batch) && <Button size="sm" disabled={!!busy} onClick={() => void cancel()}>Cancel listings not sent yet</Button>}
      {primary}
    </>}>
    <div className={styles.body} aria-busy={!!busy}>
      {(options.length > 0 || destinations.length > 0) && <div className={styles.top}>
        <div className={styles.pickerControls}>
          {batch ? <p className={styles.destinationLine}>Action: <strong>{MANY_PUBLISH_ACTION_LABEL[action]}</strong>
            {!status && manyStartAsLine(chosenOptions.startAs) && <> · {manyStartAsLine(chosenOptions.startAs)}</>}
            {!status && <> · {KEEP_CHANNEL_VALUES_LABEL}: {chosenOptions.keepChannelValues ? 'on' : 'off'}</>}</p>
            : <Listbox size="sm" width="auto" ariaLabel="Action" value={action} options={manyActionOptions(canEnd)} onChange={pickAction} />}
        </div>
        {options.length > 0 && <DestinationPicker options={options} choice={choice} onChange={pick} locked={!!batch} />}
        {!batch && options.length > 0 && (listedState === 'loading'
          ? <p className={styles.muted}>Finding the markets where these products are listed…</p>
          : listedNote && <p className={styles.muted}>{listedNote}</p>)}
        {batch && tabs.length > 0 && <Tabs ariaLabel="Markets" size="sm" overflow="scroll" idBase={tabBase} tabs={tabs} active={shownTab ?? ''} onChange={setActive} />}
      </div>}
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Markets could not be loaded">Close this window and try again. Nexus could not read the connected channels.</Banner>}
      {error && <Banner tone="danger" title="That did not complete" action={batch && <Button size="sm" onClick={() => void read(batch.batchId)}>Try again</Button>}>{error}</Banner>}
      {eu && <Banner tone="danger" title={eu.title}><ul className={styles.issues}>{eu.lines.map(line => <li key={line}>{line}</li>)}</ul></Banner>}
      <p className="nds-vh" role="status" aria-live="polite">{announced?.message ?? ''}</p>

      {!batch && !status && <>
        <p>Choose the channel and the markets above. Nexus checks each product in each market first and shows what it would send. Nothing is sent until you press Publish.</p>
        <p className={styles.muted}>{MANY_CHANNELS_NOTE} {MANY_ALIASES_NOTE}</p>
      </>}
      {!batch && status && <>
        <p>{MANY_STATUS_HINT[status]}</p>
        <p>Nexus checks each product in each market first and shows what would change. Nothing is sent until you press the counted button.</p>
        <p className={styles.muted}>{MANY_STATUS_CHANNELS_NOTE}</p>
      </>}
      {!batch && <>
        {cap && <Banner tone="warning" title="Too many to check at once">{cap}</Banner>}
        {loadingDestinations && <p className={styles.muted}>Loading the connected markets…</p>}
        {!loadingDestinations && !discoveryFailed && !options.length && (status
          ? <Banner tone="neutral" title="No market connected">Connect a channel to change the status of many products at once.</Banner>
          : <Banner tone="neutral" title="No Amazon or eBay market connected">Connect Amazon or eBay to publish many products at once.</Banner>)}
        {ticked.size >= MAX_BATCH_DESTINATIONS && <p className={styles.muted}>At most {MAX_BATCH_DESTINATIONS} markets can be published at once.</p>}
      </>}
      {!batch && !status && <>
        <label className={styles.whatCell}>
          <Toggle size="sm" checked={keepChannelValues} onChange={setKeepChannelValues} aria-labelledby={keepLabelId} aria-describedby={keepHintId} />
          <span id={keepLabelId}>{KEEP_CHANNEL_VALUES_LABEL}</span>
        </label>
        <p className={styles.muted} id={keepHintId}>{KEEP_CHANNEL_VALUES_HINT} {keepChannelValuesState(keepChannelValues)}</p>
        <div className={styles.pickerControls}>
          <span>{START_AS_LABEL}</span>
          <SegmentedControl size="sm" wrap ariaLabel={START_AS_LABEL} options={manyStartAsOptions()} value={startAs ?? ''}
            onChange={value => setStartAs(isStartAsTarget(value) ? value : null)} />
        </div>
        <p className={styles.muted}>{manyStartAsHint(startAs)}</p>
      </>}

      {reviewing && batch && <Banner tone="info" title={`Checking ${plural(batch.request?.families ?? familyCount, 'product', 'products')} in ${plural(batch.request?.destinations ?? tickedOptions.length, 'market', 'markets')}`}>
        <p>{estimate ? `This takes ${estimate}. ` : ''}You can close this window. The check continues, and nothing is sent until you press Publish.</p>
      </Banner>}
      {reviewing && progress && <JobProgress label="Checking products" value={progress.done} max={progress.total}
        detail={`${progress.done.toLocaleString('en')} of ${plural(progress.total, 'review', 'reviews')}`} startedAt={startedAt ?? undefined} />}

      {reviewed && batch && !status && <>
        <p className={styles.summary}>{[manyPlanSummary(plan), manyCreatesSummary(batch.children, now)].filter(Boolean).join(' · ')}</p>
        {estimate && plan.listings > 0 && <p className={styles.muted}>Sending takes {estimate}. You can close this window once it has started.</p>}
        {!plan.listings && <Banner tone="neutral" title="Nothing to publish">No row has a change ready to send. Open a row to see why.</Banner>}
      </>}
      {reviewed && batch && status && <>
        <p className={styles.summary}>{manyStatusSummary(statusPlan, status)}</p>
        {estimate && statusPlan.listings > 0 && <p className={styles.muted}>Sending takes {estimate}. You can close this window once it has started.</p>}
        {!statusPlan.listings && <Banner tone="neutral" title="Nothing to change">No listing here needs this change. Open a row to see why.</Banner>}
        {ending > 0 && <div className={styles.confirm}>
          {!canEnd && <Banner tone="warning" title="Ending listings needs permission">Your role cannot end listings: it needs permission to delete products.</Banner>}
          <ConfirmPhraseField phrase={String(ending)} value={typed} onChange={setTyped} disabled={!!busy || !canEnd}
            label={TYPE_COUNT_TO_END(ending)} />
        </div>}
      </>}

      {sending && batch && sendProgress && <>
        <Banner tone={batchTone(batch)} title={status ? manyStatusButtonText(statusPlan, status) : `Publish to ${plural(sendProgress.total, LISTING.one, LISTING.many)}`}
          action={batch.done && <Button asChild size="sm"><Link href="/listings/publish-status">Open Publish history</Link></Button>}>
          <p>{status ? planBatchSentence(batch) : batchSentence(batch, LISTING)}</p>
          {!batch.done && <p>You can close this window. Results appear on each product’s sheet and in Publish history.</p>}
        </Banner>
        {!batch.done && <JobProgress label={status ? 'Changing listings' : 'Publishing products'} value={sendProgress.done} max={sendProgress.total}
          detail={`${sendProgress.done.toLocaleString('en')} of ${status ? plural(sendProgress.total, 'step', 'steps') : plural(sendProgress.total, LISTING.one, LISTING.many)}${estimate ? ` · ${estimate} left` : ''}`} startedAt={startedAt ?? undefined} />}
      </>}

      {(reviewed || sending) && batch && shownTab && !status && <div className={styles.tabPanel} {...tabPanelProps(tabBase, shownTab)}>
        {differsLine && <p className={styles.planSummary}>{differsLine}</p>}
        {notListedLine && <p className={styles.muted}>{notListedLine}</p>}
        <DataGrid ariaLabel={`Products in ${optionOf(shownTab) ? marketShortLabel(optionOf(shownTab)!) : 'this market'}`} size="sm" columns={rowColumns} rows={childrenOf(shownTab)}
          rowKey={c => c.publicationId} renderExpanded={renderRow} expanded={expanded} />
      </div>}
      {(reviewed || sending) && batch && shownTab && status && <div className={styles.tabPanel} {...tabPanelProps(tabBase, shownTab)}>
        {reviewed && marketSummary && <>
          <p className={styles.planSummary}>{marketSummary.line}</p>
          {marketSummary.reasons.length > 0 && <ul className={styles.issues} aria-label="Why some listings cannot change">{marketSummary.reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>}
        </>}
        <DataGrid ariaLabel={`Products in ${shownMarket || 'this market'}`} size="sm" columns={statusColumns} rows={statusRowsOf(shownTab)}
          rowKey={r => r.key} renderExpanded={renderStatusRow} expanded={expanded} />
      </div>}
    </div>
  </Modal>
}
