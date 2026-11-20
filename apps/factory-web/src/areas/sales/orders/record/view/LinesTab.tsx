'use client'

import { useEffect } from 'react'
import { Lock } from 'lucide-react' // F-CP-149: Lock
import { Banner, Card, Disclosure, EmptyState, Field, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Button, Input, Select, Spinner, Tag } from '@nexus/ui/primitives' // F-OP-110: Select
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, unitPrice } from '../../../quotes/model'
import type { Order } from '../../api'
import { amendHeld, changeCount, minimumsOf, reviewHeld } from '../../daily-model'
import { dayInstant, type Phrase } from '../../model'
// ---- F-OP-106: the "What changes" strip (the preview's pieces, net, work orders), ONE Apply; Review amendment folded in ----
import { amendKeyOf, amendPairs, changeLabel, namesOf, sizesText, stripHeld, stripOf, workOrderWords, type AmendStrip, type StripChange } from '../../daily-model'
// ---- F-OP-107 (B2): each cell's floors and the line's figures; the extra-pieces picker (the review window's part) ----
import { cellFloorsOf, extraChoicesOf, heldWordsOf, lineFiguresOf } from '../../daily-model'
// ---- F-OP-108: a frozen field turns Apply into "Apply as a priced change" with its optional fee (one button) ----
import { feeHeld, pricedOfferOf } from '../../daily-model'
// ---- F-OP-109: a removed line's work orders ("WO-0311 loses this line") ----
import { followedNumbers, piecesOf, workOrdersOfLine } from '../../daily-model'
import { ExtraPieces } from '../../../../home/approvals/requests/view/ExtraPieces'
import { ConversationTick } from '../../../../home/approvals/requests/view/ConversationTick'
import { tellHeld, tickOn } from '../../../../home/approvals/requests/model'
import { FrozenOffer } from '../../changes-depth/view/ChangesDepth'
import type { AmendState, OrderRecordActions, OrderRecordModel } from '../record-model'
import { readOf } from '../overview/model'
import { LinesEditor } from './LinesEditor'
// ---- B-W2b-323 (orders in depth on screen) ----
import { frozenIssues } from '../../depth/view/LinesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'
import { REQUESTED_FIELD_ID } from '../overview/model' // F-OP-104
import { CUSTOMER_REF_FIELD_ID } from '../record-model' // F-OO-209
import { addressLineOf, headerChangedOf, SHIP_TO_FIELD_ID } from '../../daily-model' // F-OP-110
// ---- F-OL-02 (Order LINES lane): the new tab — one table per style, change in place, the save bar, the ONE line ⋯ ----
import { EMPTY_DRAFT } from '../lines-draft'
import { headOf, linesReaderOf, orderTotalOf, ownDatesOf, styleCardsOf, taxBasisOf, totalsOf } from '../lines-table'
import { useLineMenu } from './LineMenu'
import { LinesHead } from './lines/LinesHead'
import { lineNameOf, StyleTable, type LinesCtx } from './lines/StyleTable'
import { ChargesBlock, TotalsBlock } from './lines/LinesMoney'
import './lines/lines.css'
// ---- end F-OL-02
// ---- F-OL-03: the save bar, Review and save, two people ----
import { formatTime } from '../../../../../lib/i18n/format'
import { frozenCells } from '../../depth/model'
import { rowAnchor } from '../dock/discuss'
import { draftHoldsOf, holdPhrase } from '../lines-draft'
import { SaveBar } from './lines/SaveBar'
import { ReviewSave } from './lines/ReviewSave'
// ---- end F-OL-03

/**
 * F-OL-02 (Order LINES lane, plan v2 §1; 10-design-tab; replaces F-SA-231's view mode) — Lines, the commercial truth, changed in
 * place: the head ("17 pieces · 3 lines · 1 charge · Ready by … ✎", the order total for price readers, Add a style, the tab ⋯), one
 * card per style with ONE native table (thin DS boxes for who changes lines, plain numbers for everyone else; marks "was 3", New,
 * struck + Put back; floors "min 3" only where cut or shipped binds; the company lock said before typing), the notes folded under
 * each row, the charges read-only, the totals in plain words. Sales sees no money anywhere and one line why; Read-only and Warehouse
 * see no button and no ⋯. What is typed waits in the draft (use-lines-draft.ts) for the save bar. Fetches nothing.
 */
export function LinesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  if (model.amend) return <AmendLines order={order} amend={model.amend} model={model} actions={actions} />
  return <LinesView order={order} model={model} actions={actions} />
}

function LinesView({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const tab = model.linesTab ?? null
  const draft = tab?.draft ?? EMPTY_DRAFT
  const reader = linesReaderOf(model.can)
  // Held by the order's state (shipped, closed, waiting: today's words); the right is the reader's (no boxes without it).
  const held = amendHeld(order, model.can)
  const busy = model.busy || !!tab?.saving
  const boxes = reader.writes && held === null && !busy
  const menu = useLineMenu(order, model, actions)
  const styles = tab?.styles ?? {}
  const cards = styleCardsOf(order, draft, styles)
  const basis = taxBasisOf(order)
  const totals = totalsOf(order, draft, cards)
  const ctx: LinesCtx = {
    order,
    model,
    actions,
    draft,
    reader,
    boxes,
    readyBy: ownDatesOf(order),
    floors: cellFloorsOf(readOf(model.production)?.lines ?? []),
    freeze: model.depth?.freeze?.value ?? null,
    menu,
    clashes: tab?.clashes ?? [],
    moved: tab?.moved?.lineIds ?? [],
    styles,
    basis,
    colleague: tab?.moved?.by ?? null,
  }
  // F-OL-03: what holds "Review and save…", in order, said for its cell (a size locked for good never changes).
  const lockedForGood = frozenCells(ctx.freeze).filter((cell) => cell.state === 'BLOCKED').map((cell) => ({ lineId: cell.lineId, size: cell.size }))
  const holds = draftHoldsOf(draft, order, { floors: ctx.floors, clashes: ctx.clashes.length, lockedForGood, unlisted: tab?.unlisted })
  const say = (phrase: Phrase) => t(phrase.key, phrase.params)
  return (
    <div className="fw-lt">
      <LinesHead order={order} model={model} actions={actions} head={headOf(order, draft)} total={orderTotalOf(totals)} basis={basis} reader={reader} held={held} busy={busy} />
      <LinesNotices order={order} model={model} actions={actions} />
      {model.production?.status === 'failed' && reader.writes && <p className="fw-lt-quiet">{t('lines.floorsUnread')}</p>}
      {cards.length === 0 ? (
        <Card padded>
          <EmptyState title={t('lines.empty')} description={t('lines.emptyHint')} />
        </Card>
      ) : (
        cards.map((card, index) => <StyleTable key={card.styleId} card={card} first={index === 0} ctx={ctx} />)
      )}
      <ChargesBlock order={order} reader={reader} />
      {reader.prices && cards.length > 0 && <TotalsBlock order={order} rows={totals} basis={basis} />}
      {tab?.options}
      {/* ---- F-OL-03: the save bar (only while the draft holds a change), the ONE Review window ---- */}
      {tab && reader.writes && <SaveBar order={order} draft={draft} canUndo={tab.canUndo} held={busy ? t('held.busy') : holds[0] ? say(holdPhrase(holds[0], (key) => lineNameOf(order, draft, key))) : null} saving={tab.saving} actions={actions?.linesTab} />}
      {tab?.review && <ReviewSave order={order} draft={draft} review={tab.review} seesPrices={reader.prices} freeze={ctx.freeze} floors={ctx.floors} portalGone={tab.portalGone} saving={busy} actions={actions?.linesTab} />}
    </div>
  )
}

/** F-OL-03: another person saved while I had changes — who, when, which lines moved; Show scrolls to the first; and a failed ask. */
function LinesNotices({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  const tab = model.linesTab ?? null
  if (!tab) return null
  const moved = tab.moved
  const name = (lineId: string) => {
    const line = order.lines.find((entry) => entry.id === lineId)
    return line ? t('save.lineName', { seq: line.seq, colour: lineNameOf(order, tab.draft, lineId) }) : null
  }
  return (
    <>
      {moved && (
        <Banner
          tone="info"
          title={moved.lineIds.length > 0 ? t('save.moved', { name: moved.by ?? t('dates.someone'), time: formatTime(moved.at, { locale }), lines: moved.lineIds.map(name).filter(Boolean).join(', ') }) : t('save.movedNone', { name: moved.by ?? t('dates.someone'), time: formatTime(moved.at, { locale }) })}
          action={
            moved.lineIds.length > 0 ? (
              <Button size="sm" variant="quiet" onClick={() => document.getElementById(rowAnchor('SalesOrderLine', moved.lineIds[0]!))?.scrollIntoView({ block: 'center' })}>
                {t('save.show')}
              </Button>
            ) : undefined
          }
          onDismiss={() => actions?.linesTab?.onMovedDismiss?.()}
        >
          {moved.gone.length > 0 ? t('save.gone', { count: moved.gone.length }) : undefined}
        </Banner>
      )}
      {tab.askFailed && (
        <Banner
          tone="warning"
          title={t('save.askFailed', { customer: order.party?.legalName ?? '' })}
          action={
            <Button size="sm" onClick={() => actions?.linesTab?.onAskAgain?.()}>
              {t('save.askAgain')}
            </Button>
          }
          onDismiss={() => actions?.linesTab?.onAskDismiss?.()}
        />
      )}
    </>
  )
}
// ---- end F-OL-02

// ---- the old edit mode (F-OP-106 … F-OP-110): F-OL-05 removes it whole ----

/** F-SA-231: the totals strip (it replaces the rail): lines · units, and net · VAT · gross with the price grain. */
function Totals({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const locale = useLocale()
  const currency = order.currency
  return (
    <section aria-label={t('lines.totals')}>
      <MetricStrip
        metrics={[
          { label: t('summary.lines'), value: String(order.lines.length) },
          { label: t('lines.units'), value: String(order.progress.ordered) },
          ...(model.can.price
            ? [
                { label: t('summary.net'), value: money(order.netAmount, currency, locale) },
                { label: t('summary.vat'), value: money(order.vatAmount, currency, locale) },
                { label: t(order.priceBasis === 'GROSS' ? 'summary.grossConsumer' : 'summary.gross'), value: money(order.grossAmount, currency, locale) },
              ]
            : []),
        ]}
      />
    </section>
  )
}

/**
 * The Lines tab in amend mode. F-OP-106 (order page N2; 10-order-page §4.1): the bar becomes the sticky "What changes" strip —
 * "Amendment N — not applied · 3 changes", Discard, ONE Apply (⌘↵, held with its reason); what changes as the API's preview says it
 * (asked 500 ms after the last edit and on blur; "Working out what changes…"; a failure with Try again): pieces, the net (price grain
 * only), each work order "follows now" or "waits for production — decide on this page" (the API's rule and this reader's rights,
 * R-4); "Applies at once — no approval"; whether the customer is told. Below it (not sticky): Why (required), the words for the
 * customer with their tick, what stops it by place, what froze, re-acceptance, and Show all changes (the old review's before → after
 * table, in place). Then the order's customer PO and requested date, and the lines editor. Leaving the page with changes asks first.
 */
/**
 * F-OP-110 (10-order-page §4.5): Ship to — a Select of the order's customer's active delivery addresses (ours or approved by us; the
 * API's wall: never another customer's); the first choice keeps the order's own. Without the right to see customers it is held in
 * words (the order keeps its address). A shipment being prepared for the old address is the strip's refusal, naming it.
 */
function ShipToField({ order, amend, actions }: { order: Order; amend: AmendState; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const addresses = amend.addresses ?? null
  const now = addressLineOf(order.shipTo as Record<string, unknown> | null | undefined) ?? '—'
  const hint = addresses === null ? t('edit.shipToHeld') : addresses.problem ? t('edit.shipToFailed') : addresses.value === null ? t('split.shipToReading') : undefined
  return (
    <Field label={t('edit.shipTo')} hint={hint}>
      <Select id={SHIP_TO_FIELD_ID} value={amend.shipToAddressId ?? ''} onChange={(event) => actions?.onAmendHeader?.('shipToAddressId', event.target.value)} aria-label={t('edit.shipTo')}>
        <option value="">{t('edit.shipToKeep', { address: now })}</option>
        {(addresses?.value ?? []).map((address) => (
          <option key={address.id} value={address.id}>
            {addressLineOf(address) ?? address.id}
          </option>
        ))}
      </Select>
    </Field>
  )
}

function AmendLines({ order, amend, model, actions }: { order: Order; amend: AmendState; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH) // B-W2b-323
  const locale = useLocale()
  const minimums = minimumsOf(order)
  const headerChanged = headerChangedOf(amend, order) // F-OP-110: the ship-to counts too
  const count = changeCount(amend.lines, order) + (headerChanged ? 1 : 0)
  // F-OP-107 (B2): each cell's floors (the production read's own cells): under what shipped holds; under what is cut its extra pieces
  // get an outcome; under work orders the work order follows. Each colour line says "Cut 40 · Sewn 32 · Shipped 0".
  const read = readOf(model.production)?.lines ?? []
  const floors = cellFloorsOf(read)
  const local = reviewHeld(amend.lines, order, { changed: headerChanged }, floors)
  // F-OP-106: the strip of THIS draft (an answer for an older one is never drawn), and why Apply waits.
  const pairs = amendPairs(amend.lines, order)
  const label = (index: number) => {
    const draft = pairs[index]?.draft
    if (!draft) return null
    const names = namesOf(draft, order, amend.styles[draft.styleId])
    return `${names.style} · ${names.colour}`
  }
  const strip = stripOf({ order, review: amend.review, key: amendKeyOf(amend, order), local, price: model.can.price, label })
  const offer = pricedOfferOf(strip, model.depth?.freeze?.value ?? null) // F-OP-108
  // F-OP-109: each removed line of the order, with the work orders of the preview that lose it.
  const losing = Object.fromEntries(
    amend.lines.flatMap((line): [string, { numbers: string; count: number }][] => {
      const wos = line.lineId && !line.locked && piecesOf(line) === 0 ? workOrdersOfLine(strip.workOrders, line.lineId) : []
      return line.lineId && wos.length > 0 ? [[line.lineId, { numbers: followedNumbers(wos), count: wos.length }]] : []
    }),
  )
  const asPriced = offer === 'priced'
  const held = stripHeld(strip, { reason: amend.reason, busy: model.busy, local, extraOutcome: amend.extraOutcome, offer, fee: amend.fee, price: model.can.price /* F-CP-149 */ })
  const heldText = held ? heldWordsOf(held, t, locale) : null
  useEffect(() => {
    if (count === 0) return
    const onLeave = (event: BeforeUnloadEvent) => {
      event.preventDefault()
      event.returnValue = ''
    }
    window.addEventListener('beforeunload', onLeave)
    return () => window.removeEventListener('beforeunload', onLeave)
  }, [count])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key !== 'Enter' || model.dialog) return
      if ((event.target as HTMLElement | null)?.closest('[role="dialog"]')) return
      event.preventDefault()
      if (!heldText) actions?.onAmendApply?.(asPriced)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
    // F-OP-106: leaving a field asks the preview at once (nothing when the draft is the one already asked).
    <div className="fw-so-stack" onBlur={() => actions?.onAmendPreview?.()}>
      <Totals order={order} model={model} />
      <div className="fw-so-amendbar" role="region" aria-label={t('amend.barLabel')}>
        <span className="fw-so-amendbar-words">
          <strong>{t('amend.title', { revision: amend.revision })}</strong> <span className="fw-so-hint">{t('amend.count', { count })}</span>
        </span>
        <span className="fw-so-actions">
          <Button size="sm" onClick={() => actions?.onAmendDiscard?.()} heldReason={model.busy ? t('held.busy') : null}>
            {t('amend.discard')}
          </Button>
          <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onAmendApply?.(asPriced)} aria-keyshortcuts="Meta+Enter Control+Enter">
            {model.busy ? t('common.working') : t(asPriced ? 'edit.applyPriced' : 'amend.apply')}
          </Button>
        </span>
        <StripFacts order={order} strip={strip} local={local} model={model} actions={actions} />
        <p className="fw-so-strip-line">
          <span>{t('edit.appliesAtOnce')}</span>
          {order.party && <span>{t(tellOn(amend, model) ? 'edit.strip.told' : 'edit.strip.notTold', { customer: order.party.legalName })}</span>}
        </p>
      </div>
      <WhatChanges order={order} amend={amend} strip={strip} asPriced={asPriced} model={model} actions={actions} />
      {/* F-OP-312 (follow-up 13): a reader without the price grain is never told to change prices (the words follow the grain). */}
      <Banner tone="info" title={t(model.can.price ? 'amend.how' : 'amend.howNoPrice')} />
      <Card padded>
        <h2 className="fw-so-h2">{t('amend.header')}</h2>
        <div className="fw-so-two">
          {/* F-OO-209: Overview › Order facts' Customer PO "Change…" lands here with the focus (its id). */}
          <Field label={t('amend.customerRef')}>
            <Input id={CUSTOMER_REF_FIELD_ID} value={amend.customerRef} onChange={(event) => actions?.onAmendHeader?.('customerRef', event.target.value)} maxLength={100} autoComplete="off" />
          </Field>
          {/* F-OP-104: the field's id (F-OO-144: Overview's requested date "Change…" opens its own small dialog now). */}
          <Field label={t('amend.requestedDate')} hint={t('amend.requestedHint')}>
            <DateField id={REQUESTED_FIELD_ID} value={amend.requestedDate} onChange={(value) => actions?.onAmendHeader?.('requestedDate', value)} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('amend.requestedDate')} />
          </Field>
        </div>
        <ShipToField order={order} amend={amend} actions={actions} />
      </Card>
      <LinesEditor
        model={{ mode: 'amend', lines: amend.lines, order, styles: amend.styles, composer: amend.composer, price: model.can.price, currency: order.currency, priceBasis: order.priceBasis, minimums, floors /* F-OP-107 */, figures: lineFiguresOf(read) /* F-OP-107 */, losing /* F-OP-109 */, busy: model.busy, frozen: frozenIssues(model.depth, d) /* B-W2b-323 */, newLineOptions: model.newLineOptions /* B-W2b-374 */ }}
        actions={{ onCells: actions?.onAmendCells, onPrice: actions?.onAmendPrice, onComposerQuery: actions?.onComposerQuery, onComposerPick: actions?.onComposerPick, onComposerToggle: actions?.onComposerToggle, onComposerAdd: actions?.onComposerAdd, onText: actions?.onAmendText /* F-OP-109 */, onRemove: actions?.onAmendRemove /* F-OP-109 */ }}
      />
    </div>
  )
}

// ---- F-OP-106: the strip's parts ------------------------------------------------------------------------------------------------

/** The customer is told: the words are typed and the tick stands (the tick's own rule, F-SA-242). */
const tellOn = (amend: AmendState, model: OrderRecordModel): boolean => {
  const tick = { chosen: amend.tell.chosen, reach: model.portalGone ? ('none' as const) : ('portal' as const) }
  return tickOn(tick, amend.tell.words) && tellHeld(tick, amend.tell.words) === null
}

const signed = (delta: number, text: string): string => `${delta >= 0 ? '+' : '−'}${text}`

/** The strip's second line: pieces · net · each work order — or the draft's own hold, "Working out what changes…", the failure. */
function StripFacts({ order, strip, local, model, actions }: { order: Order; strip: AmendStrip; local: Phrase | null; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const locale = useLocale()
  if (strip.phase === 'idle') return <p className="fw-so-strip-line fw-so-hint">{local ? t(local.key, local.params) : null}</p>
  if (strip.phase === 'reading')
    return (
      <p className="fw-so-strip-line fw-so-hint" role="status">
        <Spinner size={12} /> {t('edit.strip.reading')}
      </p>
    )
  if (strip.phase === 'failed')
    return (
      <p className="fw-so-strip-line" role="alert">
        <span>{strip.problem ? t(strip.problem.key, strip.problem.params) : t('amend.failed')}</span>
        <Button size="sm" variant="quiet" onClick={() => actions?.onAmendPreview?.()}>
          {t('common.retry')}
        </Button>
      </p>
    )
  const change = (key: string, value: StripChange, text: (n: number) => string) => t(key, { before: text(value.before), after: text(value.after), delta: signed(value.delta, text(Math.abs(value.delta))) })
  return (
    <p className="fw-so-strip-line" aria-live="polite">
      {strip.pieces && <span>{change('edit.strip.pieces', strip.pieces, String)}</span>}
      {model.can.price && strip.net && <span>{change('edit.strip.net', strip.net, (n) => money(n, order.currency, locale))}</span>}
      {/* F-CP-149 (the money wall): no price grain — the net's place says so in words, never a blank. */}
      {!model.can.price && strip.netHeld && <span className="fw-so-hint">{t('edit.pricedHeld.net')}</span>}
      {strip.workOrders.map((wo) => (
        <span key={wo.key} className={wo.now ? undefined : 'fw-so-strip-waits'}>
          {workOrderWords(wo, t, locale)}
        </span>
      ))}
    </p>
  )
}

/**
 * Below the strip: Why (required), the words for the customer and their tick (F-SA-242), what stops the amendment by place, what froze
 * by the production stage (B-W2b-323), re-acceptance (information: it blocks nothing), and Show all changes (lines old → new, header).
 */
function WhatChanges({ order, amend, strip, asPriced, model, actions }: { order: Order; amend: AmendState; strip: AmendStrip; asPriced: boolean; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH)
  const locale = useLocale()
  const diff = strip.diff
  const rows = (diff?.lines ?? []).map((line) => {
    const name = changeLabel(line, order, amend.styles)
    const price = diff?.prices?.find((entry) => entry.lineId === line.lineId)
    return {
      id: line.lineId,
      cells: [
        <span key="l" className="fw-so-cell">
          {name.what ? t('changes.lineWhat', { line: name.line, what: name.what }) : t('changes.line', { line: name.line })}
        </span>,
        <Tag key="c" tone={line.change === 'REMOVED' ? 'danger' : line.change === 'ADDED' ? 'info' : 'warning'}>
          {/* F-OP-109 (B-OP-014): a line left out while work orders make it is closed short, never deleted. */}
          {line.closedShort ? t('edit.closedShort') : t(`changes.kind.${line.change}`)}
        </Tag>,
        sizesText(line.sizes) || t('changes.sizesSame'),
        t('changes.pieces', { before: line.piecesBefore, after: line.piecesAfter }),
        ...(model.can.price ? [price?.unitPrice ? `${unitPrice(price.unitPrice.before, order.currency, locale)} → ${unitPrice(price.unitPrice.after, order.currency, locale)}` : t('changes.priceSame')] : []),
      ],
    }
  })
  const columns = [t('changes.col.line'), t('changes.col.change'), t('changes.col.sizes'), t('changes.col.pieces'), ...(model.can.price ? [t('changes.col.price')] : [])]
  const tick = { chosen: amend.tell.chosen, reach: model.portalGone ? ('none' as const) : ('portal' as const) }
  return (
    <Card padded className="fw-so-stack">
      {/* B-W2b-323: frozen by the production stage — what froze, and the way on. F-OP-108: the way on is the strip's one Apply ("Apply
          as a priced change") with its optional fee (price grain); its own dialog sets an extra deposit or the words per line. */}
      {strip.frozen.length > 0 && <FrozenOffer order={order} problems={strip.frozen} model={model.depth} />}
      {asPriced && (
        <div className="fw-so-two">
          {model.can.price && (
            <Field label={d('priced.fee')} hint={d('priced.feeHint', { currency: order.currency })} error={feeHeld(amend.fee) ? d('priced.problem.fee') : undefined}>
              <Input value={amend.fee} inputMode="decimal" onChange={(event) => actions?.onAmendFee?.(event.target.value)} placeholder="0,00" autoComplete="off" />
            </Field>
          )}
          {/* ---- F-CP-149 (the money wall; review A8, D5): without the price grain the fee's place says so in words (never a blank),
              and the priced change waits for a price holder (Apply and its dialog held with the same words). */}
          {!model.can.price && (
            <Field label={d('priced.fee')}>
              <p className="fw-so-hint">
                <Lock size={13} aria-hidden /> {t('summary.noPrice')}
              </p>
            </Field>
          )}
          {/* ---- end F-CP-149 */}
          <div>
            <Button size="sm" variant="quiet" heldReason={model.busy ? t('held.busy') : !model.can.price ? t('edit.pricedHeld.apply') /* F-CP-149 */ : null} onClick={() => actions?.onPricedOffer?.()}>
              {t('edit.pricedMore')}
            </Button>
          </div>
        </div>
      )}
      {strip.problems.length > 0 && (
        <Banner tone="danger" title={t('amend.problems', { count: strip.problems.length })}>
          <ul className="fw-so-list">
            {strip.problems.map((entry, index) => (
              <li key={`${entry.key}-${index}`}>{t(entry.key, entry.params)}</li>
            ))}
          </ul>
        </Banner>
      )}
      {/* F-OP-107 (B2): pieces already cut beyond the new figures — what happens to them, picked before Apply (none for the reader). */}
      {strip.extra && <ExtraPieces name={`fw-so-extra-${order.id}`} {...extraChoicesOf(strip.extra, order, model.can.price)} chosen={amend.extraOutcome} onChoose={actions?.onAmendOutcome} />}
      {strip.reaccept !== null && (strip.reaccept ? <Banner tone="info" title={t('amend.reaccept')} /> : <p className="fw-so-hint">{t('amend.noReaccept')}</p>)}
      <Field label={t('amend.reason')} hint={t('amend.reasonHint')} required>
        <Textarea value={amend.reason} onChange={(event) => actions?.onAmendReason?.(event.target.value)} rows={2} maxLength={1000} />
      </Field>
      {/* F-SA-242 (14-change-flow §2.10, §4.2): the customer is told only when the person writes it — the words, and the tick. */}
      {order.party && (
        <>
          <Field label={t('amend.tell.words')} hint={t('amend.tell.hint')}>
            <Textarea value={amend.tell.words} onChange={(event) => actions?.onAmendTell?.({ words: event.target.value })} rows={2} maxLength={2000} />
          </Field>
          <ConversationTick id={`amend-${order.id}`} tick={tick} words={amend.tell.words} customer={order.party.legalName} onTick={(on) => actions?.onAmendTell?.({ chosen: on })} />
        </>
      )}
      {diff && (rows.length > 0 || diff.header.length > 0) && (
        <Disclosure summary={t('edit.showAll')}>
          <div className="fw-so-stack">
            {rows.length > 0 && <SummaryTable label={t('amend.tableLabel')} columns={columns} rows={rows} density="roomy" stackOnPhone />}
            {diff.header.length > 0 && (
              <KeyValue
                dense
                labelCase="sentence"
                items={diff.header.map((entry) => ({
                  label: t(`amend.field.${entry.field}`),
                  value: `${entry.field === 'requestedDate' && entry.before ? formatDate(dayInstant(entry.before), { locale }) : (entry.before ?? '—')} → ${entry.field === 'requestedDate' && entry.after ? formatDate(dayInstant(entry.after), { locale }) : (entry.after ?? '—')}`,
                }))}
              />
            )}
          </div>
        </Disclosure>
      )}
    </Card>
  )
}
// ---- end F-OP-106
