'use client'

/**
 * The Listing window's three live tabs (step 5 of docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md). Shown only when
 * the readiness read carries what the channel says (`ReadinessDetail.channel`); words and decisions are in
 * `listingDialogModel.ts`.
 *
 *   On <channel>   the destination's live state, its id and link, the last push, suppressions (Mark resolved in Nexus ·
 *                  Diagnose with AI… for one listing, after a confirm: it costs money), the channel's messages word
 *                  for word, where the channel differs from Nexus, and every listing here.
 *   Price & stock  one listing (a picker when there are several): price, master, rule, quantity (read only, with the
 *                  Amazon EU note), FBA fee. The ONLY edits in the window: Pin price… and Follow master, through
 *                  `PATCH /api/listings/:id` in the legacy drawer's save line (`drawer-save.ts`). Buffer, quantity,
 *                  fulfilment and rules are the studio Matrix's (one place to write, with Undo).
 *   History        one listing's pushes and reads, newest first (the reads the window's data carries — its newest 10 —
 *                  and the listing's publish attempts).
 *
 * Price and stock are what Nexus last sent or read, never a fresh channel read. A write that answers 403 holds its
 * button with the API's own words.
 */
import { useCallback, useEffect, useId, useRef, useState } from 'react'
import { ExternalLink, Sparkles } from 'lucide-react'
import type { ReadinessChannelListing, ReadinessChannelSection, ReadinessDestination } from '@nexus/shared/listing-readiness'
import { pricingRuleLabel } from '@nexus/shared/listing-price'
import Link from '@/lib/workspaces/Link'
import { emitInvalidation, useInvalidationChannel } from '@/lib/sync/invalidation-channel'
import { Button, Input, Pill, Select, Spinner, Tag } from '@/design-system/primitives'
import { AsOf, Banner, EmptyState, Field, KeyValue, Modal, SummaryTable, useActionConfirm, useToast, type KeyValueItem } from '@/design-system/components'
import { SELLING_STATE_TONE, SELLING_STATE_WORD, SellingStatePill, SkuTag } from '@/design-system/grid'
import { drawerSave, readDrawerListing, RELOAD_FIRST, sendDrawerPatch } from '../drawer-save'
import { priceDriftView } from '../listing-price-view'
import { listingCall } from './listingCall'
import {
  channelIdLabel, diagnoseConfirm, errorText, followConfirm, followMasterBody, historyRows, inBusiness, lastPushOf, matrixHref, moneyWords,
  parsePinPrice, pinPriceBody, priceActions, priceWords, pricingWords, problemSentence, pushWords, quantityNote, refusalText,
  resolveConfirm, sentOnlyNote, statusSentence, syncAttemptRows, type PublishAttemptRow, type SyncAttemptRow,
} from './listingDialogModel'
import { channelLabel } from './marketChips'
import { absoluteTime } from './relativeTime'
import styles from './ListingDialog.module.css'

const count = (n: number) => n.toLocaleString('en')

/** The listing picker of the per-listing tabs: one SKU among the listings here. */
function ListingPicker({ listings, focus, onFocus }: { listings: readonly ReadinessChannelListing[]; focus: string | null; onFocus: (id: string) => void }) {
  if (listings.length < 2) return null
  return (
    <div className={styles.picker}>
      <Field label="Listing" hint={`${count(listings.length)} listings here`}>
        <Select size="sm" value={focus ?? ''} onChange={(e) => onFocus(e.target.value)}>
          {listings.map((listing) => <option key={listing.live.listingId} value={listing.live.listingId}>{listing.sku}</option>)}
        </Select>
      </Field>
    </div>
  )
}

/* ── On <channel> ───────────────────────────────────────────────────────────────────────────────────────────────── */

interface Diagnosis {
  explanation: string | null
  rootCause: string | null
  suggestedFix: string[]
  confidence: string | null
  provider: { name: string; model: string; costUSD: number }
}
type DiagnoseState = { busy?: boolean; error?: string; result?: Diagnosis }

export interface ChannelTabProps {
  channel: ReadinessChannelSection
  destination: ReadinessDestination
  family: boolean
  /** Re-read the window (after a suppression was marked resolved). */
  onChanged: () => void
  now: number
}

export function ChannelTab({ channel, destination, family, onChanged, now }: ChannelTabProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const word = channelLabel(destination.channel)
  const amazon = destination.channel.toUpperCase() === 'AMAZON'
  const { summary, listings } = channel
  const lastPush = lastPushOf(listings)
  const suppressed = listings.flatMap((listing) => listing.suppressions.map((suppression) => ({ listing, suppression, key: suppression.id })))
  const messages = listings.flatMap((listing) => listing.messages.map((message, i) => ({ listing, message, key: `${listing.live.listingId}:${i}` })))
  const differs = listings.flatMap((listing) => listing.differs.map((differ, i) => ({ listing, differ, key: `${listing.live.listingId}:${i}` })))
  const problems = problemSentence(summary)
  const [diagnoses, setDiagnoses] = useState<Record<string, DiagnoseState>>({})
  const [resolving, setResolving] = useState<string | null>(null)
  // The API's own refusal (403), per kind of write: the buttons of that kind are held with it.
  const [refused, setRefused] = useState<{ diagnose?: string; resolve?: string }>({})
  const place = destination.label

  const diagnose = async (listing: ReadinessChannelListing) => {
    const id = listing.live.listingId
    if (!(await confirm.ask(diagnoseConfirm(listing.sku, place)))) return
    setDiagnoses((all) => ({ ...all, [id]: { busy: true } }))
    try {
      const answer = await listingCall<{ diagnosis?: Omit<Diagnosis, 'provider'>; provider?: Diagnosis['provider']; error?: string }>(
        `listings/${encodeURIComponent(id)}/diagnose-suppression`, { method: 'POST', body: {} },
      )
      const refusal = refusalText(answer.status, answer.json)
      if (refusal) setRefused((r) => ({ ...r, diagnose: refusal }))
      if (!answer.ok || !answer.json.diagnosis || !answer.json.provider) {
        setDiagnoses((all) => ({ ...all, [id]: { error: errorText(answer.status, answer.json) } }))
        return
      }
      setDiagnoses((all) => ({ ...all, [id]: { result: { ...answer.json.diagnosis!, provider: answer.json.provider! } } }))
    } catch (error) {
      setDiagnoses((all) => ({ ...all, [id]: { error: error instanceof Error ? error.message : String(error) } }))
    }
  }

  const resolve = async (listing: ReadinessChannelListing, suppression: ReadinessChannelListing['suppressions'][number], key: string) => {
    if (!(await confirm.ask(resolveConfirm(listing.sku, place, destination.channel)))) return
    setResolving(key)
    try {
      // The suppression's own record (`AmazonSuppression.id`, in the window's data since step 3).
      const answer = await listingCall(`listings/amazon/suppressions/${encodeURIComponent(suppression.id)}`, { method: 'PATCH', body: { resolved: true } })
      const refusal = refusalText(answer.status, answer.json)
      if (refusal) setRefused((r) => ({ ...r, resolve: refusal }))
      if (!answer.ok) { toast(errorText(answer.status, answer.json), 'danger'); return }
      toast(`Marked resolved in Nexus. ${word} was not told.`, 'success')
      emitInvalidation({ type: 'listing.updated', id: listing.live.listingId })
      onChanged()
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'danger')
    } finally {
      setResolving(null)
    }
  }

  const status: KeyValueItem[] = [
    {
      label: `On ${word}`,
      value: statusSentence(summary),
      hint: problems ?? undefined,
    },
    {
      label: channelIdLabel(destination.channel, family),
      value: summary.externalId
        ? summary.url
          ? <a className={styles.extLink} href={summary.url} target="_blank" rel="noopener noreferrer">{summary.externalId} <ExternalLink size={11} aria-hidden /></a>
          : <SkuTag>{summary.externalId}</SkuTag>
        : '—',
    },
    {
      label: 'Last push',
      value: lastPush ? <span title={absoluteTime(lastPush.at)}>{pushWords(lastPush, now)}</span> : 'Never pushed from Nexus',
      hint: lastPush ? [family ? lastPush.sku : null, lastPush.message].filter(Boolean).join(' · ') || undefined : undefined,
    },
  ]
  if (amazon) status.push({ label: 'Buy Box', value: <Link className={styles.extLink} href={inBusiness('/pricing/buybox')}>Open Buy Box</Link> })
  if (summary.duplicates > 0) {
    status.push({ label: 'Twin listings', value: `${count(summary.duplicates)} ${summary.duplicates === 1 ? 'product has' : 'products have'} two listings here`, hint: 'Both are listed below; Nexus does not pick one.' })
  }

  return (
    <div className={styles.body}>
      {confirm.element}
      <KeyValue items={status} columns={2} labelCase="sentence" />
      <p className={styles.note}>What Nexus last sent to {word} or read from it, not a fresh read from {word} (as of <AsOf at={channel.readAt} />).</p>

      {listings.length === 0 && (
        <EmptyState title={`Not listed on ${place}`} description="Nexus has no listing for this product here. Publish creates it." />
      )}

      {suppressed.length > 0 && (
        <section className={styles.section} aria-label="Suppressed">
          <h2 className={styles.heading}>Suppressed</h2>
          <ul className={styles.problems}>
            {suppressed.map(({ listing, suppression, key }) => {
              const diag = diagnoses[listing.live.listingId]
              return (
                <li key={key} className={styles.problem}>
                  <div className={styles.problemHead}>
                    <Tag tone="danger">Suppressed</Tag>
                    <SkuTag>{listing.sku}</SkuTag>
                    <span className={styles.actionsEnd}>
                      {amazon && (
                        <Button size="sm" heldReason={refused.diagnose ?? (diag?.busy ? 'Diagnosing…' : null)} onClick={() => void diagnose(listing)}>
                          <Sparkles size={13} aria-hidden /> {diag?.result ? 'Diagnose again…' : 'Diagnose with AI…'}
                        </Button>
                      )}
                      {amazon && (
                        <Button size="sm" heldReason={refused.resolve ?? (resolving === key ? 'Marking it resolved…' : null)} onClick={() => void resolve(listing, suppression, key)}>
                          Mark resolved in Nexus
                        </Button>
                      )}
                    </span>
                  </div>
                  <p className={styles.quote}>“{suppression.reasonText}”{suppression.reasonCode ? ` (${suppression.reasonCode})` : ''}</p>
                  <div className={styles.meta}>
                    <span>{suppression.source}</span>
                    {suppression.suppressedAt && <span title={absoluteTime(suppression.suppressedAt)}>since <AsOf at={suppression.suppressedAt} kind="event" /></span>}
                    {suppression.severity && <span>{suppression.severity.toLowerCase()}</span>}
                  </div>
                  {diag?.busy && <div className={styles.inline}><Spinner size={14} /><span>Asking the AI provider…</span></div>}
                  {diag?.error && <Banner tone="warning" title="The diagnosis did not run">{diag.error}</Banner>}
                  {diag?.result && <DiagnosisView diagnosis={diag.result} />}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {messages.length > 0 && (
        <section className={styles.section} aria-label={`${word} says`}>
          <h2 className={styles.heading}>{word} says, word for word</h2>
          <ul className={styles.problems}>
            {messages.map(({ listing, message, key }) => (
              <li key={key} className={styles.problem}>
                <div className={styles.problemHead}>
                  <Tag tone={message.severity === 'error' ? 'danger' : message.severity === 'warning' ? 'warning' : 'neutral'}>
                    {message.severity === 'error' ? 'Error' : message.severity === 'warning' ? 'Warning' : 'Info'}
                  </Tag>
                  {message.code && <SkuTag>{message.code}</SkuTag>}
                  <SkuTag>{listing.sku}</SkuTag>
                </div>
                <p className={styles.quote}>“{message.message}”</p>
                <div className={styles.meta}>
                  {message.attributeNames.length > 0 && <span>{message.attributeNames.join(', ')}</span>}
                  <span>{message.source}</span>
                  {message.lastSeenAt && <span>seen <AsOf at={message.lastSeenAt} kind="event" /></span>}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}

      {differs.length > 0 && (
        <section className={styles.section} aria-label={`Where ${word} differs from Nexus`}>
          <h2 className={styles.heading}>Where {word} differs from Nexus</h2>
          <SummaryTable
            label={`Where ${word} differs from Nexus`}
            columns={['SKU', 'Field', 'In Nexus', `On ${word}`]}
            rows={differs.map(({ listing, differ, key }) => ({ id: key, cells: [<SkuTag key="s">{listing.sku}</SkuTag>, differ.field, differ.nexus ?? '—', differ.channel ?? '—'] }))}
          />
        </section>
      )}

      {listings.length > 0 && (
        <section className={styles.section} aria-label={family ? 'Variations' : 'Listing'}>
          <h2 className={styles.heading}>{family ? `Variations (${count(listings.length)})` : 'Listing'}</h2>
          <div className={styles.tableWrap}>
            <SummaryTable
              label={family ? `Variations on ${place}` : `The listing on ${place}`}
              columns={['SKU', 'Status', 'Price', 'Qty', channelIdLabel(destination.channel, false), 'Last push', 'Messages']}
              rows={listings.map((listing) => ({ id: listing.live.listingId, cells: variationCells(listing, now) }))}
            />
          </div>
        </section>
      )}
    </div>
  )
}

/** One listing's cells in the variations table. */
function variationCells(listing: ReadinessChannelListing, now: number) {
  const live = listing.live
  const push = listing.lastPublish
  const open = live.channelErrorCount + live.channelWarningCount
  return [
    <SkuTag key="sku">{listing.sku}</SkuTag>,
    <span key="status" className={styles.cellStatus}>
      <SellingStatePill pill={{ label: SELLING_STATE_WORD[live.state] ?? live.state, tone: SELLING_STATE_TONE[live.state] ?? 'neutral', glyph: 'dot' }} />
      {live.suppressed && <Tag tone="danger">Suppressed</Tag>}
      {live.held && <Tag>Held</Tag>}
    </span>,
    live.followsMasterPrice === false
      ? <span key="price" className={styles.cellStatus}>{priceWords(live)} <Tag title="Its own price, not the master price">Pinned</Tag></span>
      : priceWords(live),
    live.quantity == null ? '—' : `${count(live.quantity)}${live.fulfillment === 'FBA' ? ' (FBA)' : ''}`,
    live.externalId
      ? live.url ? <a key="id" className={styles.extLink} href={live.url} target="_blank" rel="noopener noreferrer">{live.externalId}</a> : live.externalId
      : '—',
    push ? <span key="push" title={push.message ?? absoluteTime(push.at)}>{pushWords(push, now)}</span> : live.lastSyncError ? <span key="push" title={live.lastSyncError}>Failed</span> : '—',
    open ? `${count(open)}${live.channelErrorCount ? ` (${count(live.channelErrorCount)} ${live.channelErrorCount === 1 ? 'error' : 'errors'})` : ''}` : '—',
  ]
}

function DiagnosisView({ diagnosis }: { diagnosis: Diagnosis }) {
  return (
    <div className={styles.diagnosis}>
      <div className={styles.meta}>
        <span>AI diagnosis · {diagnosis.provider.name} · {diagnosis.provider.model} · ${diagnosis.provider.costUSD.toFixed(4)}</span>
        {diagnosis.confidence && <span>confidence {diagnosis.confidence}</span>}
      </div>
      {diagnosis.rootCause && <p className={styles.message}><strong>Root cause:</strong> {diagnosis.rootCause}</p>}
      {diagnosis.explanation && <p className={styles.message}>{diagnosis.explanation}</p>}
      {diagnosis.suggestedFix.length > 0 && (
        <ol className={styles.steps}>{diagnosis.suggestedFix.map((step, i) => <li key={i}>{step}</li>)}</ol>
      )}
    </div>
  )
}

/* ── Price & stock ──────────────────────────────────────────────────────────────────────────────────────────────── */

/** `GET /api/listings/:id` — the part this tab reads. */
interface ListingRead {
  id: string
  version: number
  channel: string
  marketplace: string
  price: number | null
  quantity: number | null
  stockBuffer: number | null
  followMasterPrice: boolean
  pricingRule: string | null
  priceAdjustmentPercent: number | null
  masterPrice: number | null
  product: { sku: string; basePrice: number | null } | null
  amazonContext: { fbaEconomics?: { estimatedFbaFee: number | null; referralFeePercent: number | null; feeFetchedAt: string | null } } | null
}

export interface PriceTabProps {
  channel: ReadinessChannelSection
  destination: ReadinessDestination
  focus: string | null
  onFocus: (id: string) => void
  /** Re-read the window (after a price edit). */
  onChanged: () => void
}

export function PriceTab({ channel, destination, focus, onFocus, onChanged }: PriceTabProps) {
  const { toast } = useToast()
  const confirm = useActionConfirm()
  const listing = channel.listings.find((l) => l.live.listingId === focus) ?? null
  const [save] = useState(drawerSave)
  const [read, setRead] = useState<{ id: string; value?: ListingRead; error?: string } | null>(null)
  const shown = useRef<ListingRead | null>(null)
  const focusRef = useRef(focus)
  focusRef.current = focus
  const [writeError, setWriteError] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)
  const [busy, setBusy] = useState<'pin' | 'follow' | null>(null)
  const [pinOpen, setPinOpen] = useState(false)
  const [pinText, setPinText] = useState('')
  const [pinError, setPinError] = useState<string | null>(null)
  const pinId = useId()

  const load = useCallback(async () => {
    const id = focusRef.current
    if (!id) return
    const got = await readDrawerListing(save, () => focusRef.current ?? '', async () => {
      const answer = await listingCall<ListingRead & { error?: string }>(`listings/${encodeURIComponent(id)}`)
      if (!answer.ok) throw new Error(errorText(answer.status, answer.json))
      return answer.json
    })
    if (got.kind === 'fresh') {
      shown.current = got.value
      setRead({ id: got.value.id, value: got.value })
      setWriteError((e) => (e === RELOAD_FIRST ? null : e))
    } else if (got.kind === 'failed') {
      setRead({ id, error: got.error instanceof Error ? got.error.message : String(got.error) })
    }
  }, [save])
  useEffect(() => { setWriteError(null); void load() }, [focus, load])
  // Another tab or surface changed this listing: read it again.
  useInvalidationChannel(['listing.updated'], (event) => { if (!event.id || event.id === focusRef.current) void load() })

  const current = read && read.id === focus ? read : null
  const value = current?.value ?? null

  const patch = async (body: Record<string, unknown>): Promise<boolean> => {
    const id = focusRef.current
    if (!id || shown.current?.id !== id) { setWriteError(RELOAD_FIRST); return false }
    const seen: { refusal: string | null } = { refusal: null }
    const sent = await sendDrawerPatch(save, id, () => (shown.current?.id === id ? shown.current.version : undefined), body, async (withVersion) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const answer = await listingCall<any>(`listings/${encodeURIComponent(id)}`, { method: 'PATCH', body: withVersion })
      seen.refusal = refusalText(answer.status, answer.json)
      return answer
    })
    if (!sent.ok) {
      if (seen.refusal) setRefused(seen.refusal)
      setWriteError(sent.error)
      return false
    }
    setWriteError(null)
    const answer = sent.answer as { notSent?: string; queued?: boolean } | null
    if (answer?.notSent) toast(answer.notSent, 'warning')
    else if (answer?.queued) toast('Saved. Nexus sends the price to the channel in about 30 seconds.', 'success')
    else toast('Saved.', 'success')
    emitInvalidation({ type: 'listing.updated', id })
    await load()
    onChanged()
    return true
  }

  const savePin = async () => {
    const parsed = parsePinPrice(pinText)
    if (!parsed.ok) { setPinError(parsed.reason); return }
    setBusy('pin')
    try {
      if (await patch(pinPriceBody(parsed.value))) setPinOpen(false)
    } finally {
      setBusy(null)
    }
  }
  const follow = async () => {
    if (!listing || !(await confirm.ask(followConfirm(listing.sku, destination.label)))) return
    setBusy('follow')
    try { await patch(followMasterBody()) } finally { setBusy(null) }
  }

  if (channel.listings.length === 0) {
    return <EmptyState title={`Not listed on ${destination.label}`} description="There is no price or quantity here until Publish creates the listing." />
  }
  const live = listing?.live ?? null
  const can = priceActions(value, live)
  const master = value ? value.product?.basePrice ?? value.masterPrice : null
  const drift = value ? priceDriftView(value, master) : null
  const fba = value?.amazonContext?.fbaEconomics ?? null
  const held = refused ?? (busy ? 'Saving…' : null)
  const items: KeyValueItem[] = live ? [
    { label: 'Price', value: priceWords(live), hint: sentOnlyNote(destination.channel, 'price') ?? undefined },
    { label: 'Master price', value: master == null ? '—' : moneyWords(Number(master), null) },
    ...(value ? [{ label: 'How it is priced', value: pricingWords(value, pricingRuleLabel(value.pricingRule, value.priceAdjustmentPercent)), hint: drift?.label ?? undefined }]
      // Until the listing's own read lands, the window's data says whether it follows the master (step 4).
      : live.followsMasterPrice !== undefined ? [{ label: 'How it is priced', value: live.followsMasterPrice ? 'Follows the master price' : 'Pinned: its own price, not the master' }] : []),
    {
      label: 'Quantity',
      value: live.quantity == null ? '—' : count(live.quantity),
      hint: [quantityNote(destination.channel, destination.marketplace, live.fulfillment), sentOnlyNote(destination.channel, 'quantity')].filter(Boolean).join(' ') || undefined,
    },
    { label: 'Fulfilment', value: live.fulfillment ?? '—' },
    ...(value ? [{ label: 'Stock buffer', value: value.stockBuffer == null ? '—' : count(value.stockBuffer) }] : []),
    ...(fba ? [{
      label: 'Amazon FBA fee',
      value: fba.estimatedFbaFee == null ? 'Not read yet' : `${moneyWords(fba.estimatedFbaFee, live.currency)} per unit`,
      hint: fba.referralFeePercent == null ? undefined : `Referral fee ${fba.referralFeePercent.toFixed(1)}% of the price`,
    }] : []),
  ] : []

  return (
    <div className={styles.body}>
      {confirm.element}
      <ListingPicker listings={channel.listings} focus={focus} onFocus={onFocus} />
      {current?.error && <Banner tone="danger" title="Could not read this listing" action={<Button size="sm" onClick={() => void load()}>Try again</Button>}>{current.error}</Banner>}
      {live && (
        <>
          <KeyValue items={items} columns={2} labelCase="sentence" />
          {value ? (
            <div className={styles.actionsRow}>
              {can.pin && (
                <Button size="sm" heldReason={held} onClick={() => { setPinText(live.price != null ? String(live.price) : ''); setPinError(null); setPinOpen(true) }}>Pin price…</Button>
              )}
              {can.follow && <Button size="sm" heldReason={held} onClick={() => void follow()}>Follow master</Button>}
              {!can.follow && <span className={styles.metaText}>It follows the master price now.</span>}
            </div>
          ) : !current?.error && (
            <div className={styles.inline}><Spinner size={14} /><span>Reading the listing…</span></div>
          )}
          {writeError && <Banner tone="danger" title="Not saved">{writeError}</Banner>}
          <p className={styles.note}>
            Buffer, quantity, fulfilment and rules are changed in the studio’s Matrix, which has Undo.{' '}
            <Link className={styles.extLink} href={inBusiness(matrixHref(listing?.productId ?? '', destination))}>Open the Matrix</Link>
          </p>
        </>
      )}
      {pinOpen && listing && (
        <Modal
          open
          onClose={() => setPinOpen(false)}
          size="sm"
          title={`Pin the price of ${listing.sku}`}
          subtitle={destination.label}
          footer={<>
            <Button onClick={() => setPinOpen(false)}>Cancel</Button>
            <Button variant="primary" heldReason={refused ?? (busy === 'pin' ? 'Saving…' : null)} onClick={() => void savePin()}>Pin price</Button>
          </>}
        >
          <div className={styles.body}>
            <Field label={`Price${live?.currency ? ` (${live.currency})` : ''}`} error={pinError ?? undefined} htmlFor={pinId}
              hint="The listing stops following the master price and keeps this one. Nexus sends it to the channel in about 30 seconds.">
              <Input id={pinId} inputMode="decimal" autoFocus value={pinText} onChange={(e) => { setPinText(e.target.value); setPinError(null) }}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void savePin() } }} />
            </Field>
          </div>
        </Modal>
      )}
    </div>
  )
}

/* ── History ────────────────────────────────────────────────────────────────────────────────────────────────────── */

export interface HistoryTabProps {
  channel: ReadinessChannelSection
  destination: ReadinessDestination
  focus: string | null
  onFocus: (id: string) => void
  now: number
}

export function HistoryTab({ channel, destination, focus, onFocus, now }: HistoryTabProps) {
  const [read, setRead] = useState<{ id: string; reads?: SyncAttemptRow[]; pushes?: PublishAttemptRow[]; error?: string } | null>(null)
  const [attempt, setAttempt] = useState(0)
  // The reads are in the window's data (its newest 10, step 3); an older API sends none, so they are read here.
  const carried = channel.listings.find((l) => l.live.listingId === focus)?.syncAttempts
  const carriedRows = focus && carried ? syncAttemptRows(focus, carried) : null
  const carriedKey = carriedRows ? JSON.stringify(carried) : ''
  useEffect(() => {
    if (!focus) return
    const controller = new AbortController()
    const id = encodeURIComponent(focus)
    const own = carriedRows
    void Promise.all([
      own ? Promise.resolve({ ok: true, status: 200, json: { attempts: own } }) : listingCall<{ attempts?: SyncAttemptRow[] }>(`listings/${id}/sync-history?limit=50`, { signal: controller.signal }),
      listingCall<{ attempts?: PublishAttemptRow[] }>(`listings/${id}/publish-attempts?limit=50`, { signal: controller.signal }),
    ]).then(([reads, pushes]) => {
      if (controller.signal.aborted) return
      const failed = !reads.ok ? reads : !pushes.ok ? pushes : null
      setRead(failed ? { id: focus, error: errorText(failed.status, failed.json) } : { id: focus, reads: reads.json.attempts ?? [], pushes: pushes.json.attempts ?? [] })
    }).catch((error: unknown) => { if (!controller.signal.aborted) setRead({ id: focus, error: error instanceof Error ? error.message : String(error) }) })
    return () => controller.abort()
    // The carried reads by value: a re-read of the window with the same reads does not read the history again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus, attempt, carriedKey])

  if (channel.listings.length === 0) {
    return <EmptyState title={`Not listed on ${destination.label}`} description="Nothing was pushed to or read from this destination for this product." />
  }
  const current = read && read.id === focus ? read : null
  const rows = current?.reads && current.pushes ? historyRows(current.reads, current.pushes, destination.channel) : null
  return (
    <div className={styles.body}>
      <ListingPicker listings={channel.listings} focus={focus} onFocus={onFocus} />
      {!current ? (
        <div className={styles.inline}><Spinner size={14} /><span>Reading the history…</span></div>
      ) : current.error ? (
        <Banner tone="danger" title="Could not read the history" action={<Button size="sm" onClick={() => setAttempt((n) => n + 1)}>Try again</Button>}>{current.error}</Banner>
      ) : rows && rows.length === 0 ? (
        <EmptyState title="No pushes or reads yet" description={`Nexus has not pushed this listing to ${channelLabel(destination.channel)} or read it from there.`} />
      ) : rows ? (
        <div className={styles.tableWrap}>
          <SummaryTable
            label="Pushes and reads, newest first"
            columns={['When', 'What', 'Result', 'Message']}
            rows={rows.map((row) => ({
              id: row.id,
              cells: [
                <span key="at" title={absoluteTime(row.at)}><AsOf at={row.at} kind="event" now={now} /></span>,
                row.what,
                <Pill key="r" tone={row.result.tone}>{row.result.label}</Pill>,
                row.message ? <span key="m" className={styles.quote}>{row.message}</span> : '—',
              ],
            }))}
          />
        </div>
      ) : null}
      <p className={styles.note}>
        Every publish of every product: <Link className={styles.extLink} href={inBusiness('/listings/publish-status')}>Publish history</Link>
      </p>
    </div>
  )
}
