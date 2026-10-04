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
 */
import { useCallback, useEffect, useId, useMemo, useState } from 'react'
import type { PublicationBatchChild, PublicationBatchView } from '@nexus/shared/studio-publication'
import { Button, Checkbox, Pill } from '@/design-system/primitives'
import { Banner, JobProgress, Modal, Tabs, tabPanelProps } from '@/design-system/components'
import { DataGrid, type Column } from '@/design-system/grid/datagrid'
import { PublishStatusPill } from '@/design-system/grid'
import { useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { usePermission } from '@/lib/auth/AuthProvider'
import { publicationRequest as request } from './request'
import { publicationEventOf } from './outcome'
import { batchCancellable, batchChildMeta, batchProgress, batchSentence, batchTone, euRefusal, MAX_BATCH_DESTINATIONS } from './destinations'
import type { PublicationDestinationOption } from './model'
import { activeTab, childMarketKey, initialChoice, manySummary, manyTabWords, marketShortLabel, type PickerChoice } from './pickers'
import { DestinationPicker } from './DestinationPicker'
import {
  MANY_CHANNELS_NOTE, estimateText, manyCapMessage, manyCheckButtonText, manyDestinationLabel, manyDestinationOptions, manyPlan, manyPublishButtonText,
  manyRequest, manyReviewed, manyReviewing, manyRowLabel, manyRowState, reviewProgress,
} from './many'
import { ManyRowReview } from './ManyRowReview'
import styles from './publication.module.css'

export interface ManyPublishDialogProps {
  /** The selected products. A selected variation means its family; the server removes duplicates. */
  productIds: string[]
  /** How many families the selection reaches. */
  familyCount: number
  /** Every destination of the business; only Amazon and eBay are offered here. */
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

export function ManyPublishDialog({ productIds, familyCount, destinations, loadingDestinations = false, discoveryFailed = null, onClose }: ManyPublishDialogProps) {
  const canPublish = usePermission('products.publish')
  const options = useMemo(() => manyDestinationOptions(destinations), [destinations])
  // The compact pickers (Owner, 2026-10-02): one channel, one account, the markets. Nothing is pre-chosen unless the
  // business has exactly one destination; the markets arrive after the window opens, so the choice follows them once.
  const [choice, setChoice] = useState<PickerChoice>(() => initialChoice(options, []))
  useEffect(() => { if (!choice.channel && options.length) setChoice(initialChoice(options, [])) }, [choice.channel, options])
  const ticked = useMemo(() => new Set(choice.keys), [choice.keys])
  const [active, setActive] = useState<string | null>(null)
  const tabBase = useId()
  const [replaceDiffers, setReplaceDiffers] = useState(false)
  const [batch, setBatch] = useState<PublicationBatchView | null>(null)
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
    try { setBatch(await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(id)}`, 'GET')); setError(null) }
    catch (e) { setError(message(e)) }
  }, [])
  const check = async () => {
    if (busy || !tickedOptions.length || cap || !canPublish) return
    setBusy('check'); setError(null); setEu(null)
    try {
      const created = await request<{ batchId: string }>('/api/publication-batches', 'POST', manyRequest(productIds, tickedOptions.map(o => o.scope), replaceDiffers))
      setStartedAt(Date.now())
      await read(created.batchId)
    } catch (e) { setError(message(e)) }
    finally { setBusy(null) }
  }
  const submit = async () => {
    if (!batch || busy) return
    setBusy('submit'); setError(null); setEu(null)
    try { setBatch(await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/submit`, 'POST', {})); setStartedAt(Date.now()) }
    catch (e) { const refusal = euRefusal(e); if (refusal) setEu(refusal); else setError(message(e)) }
    finally { setBusy(null) }
  }
  const cancel = async () => {
    if (!batch || busy) return
    setBusy('cancel'); setError(null)
    try { setBatch(await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {})) }
    catch (e) { setError(message(e)) }
    finally { setBusy(null) }
  }
  // "Check again": the reviewed batch is closed (nothing of it was sent) and the same markets are checked anew.
  const checkAgain = async () => {
    if (!batch || busy) return
    setBusy('cancel'); setError(null)
    try { await request<PublicationBatchView>(`/api/publication-batches/${encodeURIComponent(batch.batchId)}/cancel`, 'POST', {}) }
    catch { /* already closed: start again regardless */ }
    finally { setBusy(null) }
    setBatch(null); setExpanded(new Set()); setEu(null)
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
    if (announced?.key !== key) setAnnounced({ key, message: batchSentence(batch, LISTING) })
  }, [batch, announced?.key])

  const reviewing = manyReviewing(batch), reviewed = manyReviewed(batch)
  const sending = !!batch && !reviewing && !reviewed
  const plan = useMemo(() => manyPlan(batch?.children ?? [], now), [batch, now])
  const estimate = estimateText(batch)
  const progress = reviewProgress(batch)
  const sendProgress = sending && batch ? batchProgress(batch) : null
  const pick = (next: PickerChoice) => { if (!batch) { setChoice(next); setError(null) } }
  const onTicksSaved = useCallback(() => { if (batch) void read(batch.batchId) }, [batch?.batchId, read])
  const toggle = (id: string) => setExpanded(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next })

  // ── stages 2 and 3: one row per family × market ────────────────────────────────────────────────────────────────
  const rowStatus = (child: PublicationBatchChild) => {
    if (sending) return <PublishStatusPill meta={batchChildMeta(child)} />
    const shown = manyRowLabel(manyRowState(child, now))
    return <span title={shown.hint}><Pill tone={shown.tone} dot>{shown.label}</Pill></span>
  }
  // The verdict sits next to the product, so a phone shows it without scrolling sideways.
  const rowColumns: Array<Column<PublicationBatchChild>> = [
    { key: 'product', label: 'Product', render: c => <span className={styles.destination}><strong>{c.familySku ?? '—'}</strong>{c.familyTitle && <span className={styles.muted}>{c.familyTitle}</span>}</span> },
    { key: 'review', label: sending ? 'Result' : 'Review', render: rowStatus },
    { key: 'changes', label: 'Changes', numeric: true, render: c => { const s = manyRowState(c, now); return s.kind === 'ready' ? s.changes.toLocaleString('en') : '—' } },
    { key: 'details', label: <span className="nds-vh">Details</span>, render: c => {
      const open = expanded.has(c.publicationId)
      return <Button size="sm" variant="ghost" aria-expanded={open} aria-label={`${open ? 'Hide' : 'Show'} details for ${c.familySku ?? 'this product'} on ${manyDestinationLabel(c, options)}`}
        onClick={() => toggle(c.publicationId)}>{open ? 'Hide' : 'Details'}</Button>
    } },
  ]
  // A row opened: its saved review with its ticks (T1). Changing a tick saves it and re-reads the batch's counts.
  const renderRow = (c: PublicationBatchChild) => {
    if (!expanded.has(c.publicationId)) return null
    return <div className={styles.expanded}>
      <ManyRowReview child={c} sending={sending || !!busy} onTicksSaved={onTicksSaved} />
    </div>
  }

  // ── one tab per market, its products under it ─────────────────────────────────────────────────────────────────
  const stage = reviewing ? 'reviewing' as const : reviewed ? 'reviewed' as const : 'sending' as const
  const marketKeys = useMemo(() => {
    const fromChildren = (batch?.children ?? []).map(childMarketKey)
    const chosen = choice.keys.filter(key => !batch || !fromChildren.length || fromChildren.includes(key))
    return [...new Set([...chosen, ...fromChildren])]
  }, [batch, choice.keys])
  const childrenOf = useCallback((key: string) => (batch?.children ?? []).filter(c => childMarketKey(c) === key), [batch])
  const shownTab = activeTab(marketKeys, active)
  const tabs = marketKeys.map(key => {
    const option = optionOf(key), rows = childrenOf(key)
    const code = option ? marketShortLabel(option) : rows[0]?.marketplace ?? key
    return { id: key, label: `${code} · ${manyTabWords(rows, stage, now)}` }
  })

  // ── footer ─────────────────────────────────────────────────────────────────────────────────────────────────────
  const primary = (() => {
    if (!batch) {
      return <Button size="sm" variant="primary" disabled={!!busy || !tickedOptions.length || !!cap || !canPublish || loadingDestinations} onClick={() => void check()}>
        {busy === 'check' ? 'Starting the check…' : manyCheckButtonText(familyCount, tickedOptions.length)}</Button>
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
      {options.length > 0 && <div className={styles.top}>
        <DestinationPicker options={options} choice={choice} onChange={pick} locked={!!batch} />
        {batch && tabs.length > 0 && <Tabs ariaLabel="Markets" size="sm" overflow="scroll" idBase={tabBase} tabs={tabs} active={shownTab ?? ''} onChange={setActive} />}
      </div>}
      {!canPublish && <Banner tone="warning" title="Publishing permission required">Your role needs product publishing access.</Banner>}
      {discoveryFailed && <Banner tone="danger" title="Markets could not be loaded">Close this window and try again. Nexus could not read the connected channels.</Banner>}
      {error && <Banner tone="danger" title="That did not complete" action={batch && <Button size="sm" onClick={() => void read(batch.batchId)}>Try again</Button>}>{error}</Banner>}
      {eu && <Banner tone="danger" title={eu.title}><ul className={styles.issues}>{eu.lines.map(line => <li key={line}>{line}</li>)}</ul></Banner>}
      <p className="nds-vh" role="status" aria-live="polite">{announced?.message ?? ''}</p>

      {!batch && <>
        <p>Choose the channel and the markets above. Nexus checks each product in each market first and shows what it would send. Nothing is sent until you press Publish.</p>
        <p className={styles.muted}>{MANY_CHANNELS_NOTE}</p>
        {cap && <Banner tone="warning" title="Too many to check at once">{cap}</Banner>}
        {loadingDestinations && <p className={styles.muted}>Loading the connected markets…</p>}
        {!loadingDestinations && !discoveryFailed && !options.length && <Banner tone="neutral" title="No Amazon or eBay market connected">Connect Amazon or eBay to publish many products at once.</Banner>}
        {ticked.size >= MAX_BATCH_DESTINATIONS && <p className={styles.muted}>At most {MAX_BATCH_DESTINATIONS} markets can be published at once.</p>}
        <Checkbox checked={replaceDiffers} onChange={e => setReplaceDiffers(e.target.checked)}
          label="Also replace values that were changed on the channel itself" />
        <p className={styles.muted}>Off: a value someone changed on Amazon or eBay is left as it is. On: Nexus’s value replaces it.</p>
      </>}

      {reviewing && batch && <Banner tone="info" title={`Checking ${plural(batch.request?.families ?? familyCount, 'product', 'products')} in ${plural(batch.request?.destinations ?? tickedOptions.length, 'market', 'markets')}`}>
        <p>{estimate ? `This takes ${estimate}. ` : ''}You can close this window. The check continues, and nothing is sent until you press Publish.</p>
      </Banner>}
      {reviewing && progress && <JobProgress label="Checking products" value={progress.done} max={progress.total}
        detail={`${progress.done.toLocaleString('en')} of ${plural(progress.total, 'review', 'reviews')}`} startedAt={startedAt ?? undefined} />}

      {reviewed && batch && <>
        <p className={styles.summary}>{manySummary(plan)}</p>
        {estimate && plan.listings > 0 && <p className={styles.muted}>Sending takes {estimate}. You can close this window once it has started.</p>}
        {!plan.listings && <Banner tone="neutral" title="Nothing to publish">No row has a change ready to send. Open a row to see why.</Banner>}
      </>}

      {sending && batch && sendProgress && <>
        <Banner tone={batchTone(batch)} title={`Publish to ${plural(sendProgress.total, LISTING.one, LISTING.many)}`}>
          <p>{batchSentence(batch, LISTING)}</p>
          {!batch.done && <p>You can close this window. Results appear on each product’s sheet and in Publish history.</p>}
        </Banner>
        {!batch.done && <JobProgress label="Publishing products" value={sendProgress.done} max={sendProgress.total}
          detail={`${sendProgress.done.toLocaleString('en')} of ${plural(sendProgress.total, LISTING.one, LISTING.many)}${estimate ? ` · ${estimate} left` : ''}`} startedAt={startedAt ?? undefined} />}
      </>}

      {(reviewed || sending) && batch && shownTab && <div className={styles.tabPanel} {...tabPanelProps(tabBase, shownTab)}>
        <DataGrid ariaLabel={`Products in ${optionOf(shownTab) ? marketShortLabel(optionOf(shownTab)!) : 'this market'}`} size="sm" columns={rowColumns} rows={childrenOf(shownTab)}
          rowKey={c => c.publicationId} renderExpanded={renderRow} expanded={expanded} />
      </div>}
    </div>
  </Modal>
}
