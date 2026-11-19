'use client'

import { useEffect } from 'react'
import { useSearchParams } from 'next/navigation' // F-OP-210 (lead, in A08): the artwork link keeps the dock's scope
import { FileImage, PencilLine } from 'lucide-react'
import { Banner, Card, Disclosure, Field, KeyValue, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Spinner, Tag } from '@nexus/ui/primitives'
import { DateField, Textarea } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { money, percent, unitPrice } from '../../../quotes/model'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order, OrderLine } from '../../api'
import { amendHeld, changeCount, closeLinesHeld, minimumsOf, reopenHeld, reviewHeld } from '../../daily-model'
import { dayInstant, gridOf, isFinal, styleGroups, type Phrase } from '../../model'
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
// ---- F-OP-210 (lead, in A08): an in-page tab link keeps the dock's scope (tabHref + TabLink) ----
import { tabHref } from '../../../../_shared/record-frame/address'
import { TabLink } from '../../../../../lib/tab-link/TabLink'
import type { AmendState, OrderRecordActions, OrderRecordModel } from '../record-model'
import { readOf } from '../overview/model'
import { LinesEditor } from './LinesEditor'
// ---- B-W2b-323 (orders in depth on screen) ----
import { FrozenSizes, frozenIssues } from '../../depth/view/LinesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'
// ---- F-SA-231b: the artwork chip opens the artwork in the thread's ONE viewer (the frame's openFiles)
import { useRecordFrame } from '../../../../_shared/record-frame/RecordFrame'
import { artworkOfGroup } from '../production'
// F-SA-266: each colour line's Discuss door and its anchor ("Show on the page")
import { DiscussDoor } from './Discuss'
import { rowAnchor } from '../dock/discuss'

/**
 * F-SA-231 (sales page plan N2, picks P2, R9; 10-order-page §2.2) — Lines, the commercial truth: a totals strip (lines · units · net ·
 * VAT · gross by grain) instead of the rail (the money is on Money, the record chain on Overview), the head ("What the customer
 * ordered, as accepted. Changes go through Amend order." with Amend order, Close remaining lines…, Reopen lines…, each held with its
 * reason), and one card per style — its picture (the one picture part, 56 px), its code and name, the revision it is made to, its
 * artwork ("Artwork (2)", the order's Files), the ordered sizes in the DS size grid (no layer switch: what is made is on Overview,
 * Production and Shipments), the frozen sizes, and per colour line its picture (40 px), options, cost mark, closed short (by whom,
 * when, why), the line's note and description, pieces, shipped, price, net and VAT by grain, the promise. Amend mode unchanged
 * (B-W2a-50) — except the floor of a size: what is already CUT (under what work orders make is said; the work order follows).
 */
export function LinesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const groups = styleGroups(order.lines)
  const copy = sizeGridWords(sales)
  const held = amendHeld(order, model.can)
  const closeWait = closeLinesHeld(order, model.can)
  const reopenWait = reopenHeld(order, model.can)
  const busy = model.busy ? t('held.busy') : null
  const frame = useRecordFrame() // F-SA-231b
  const search = useSearchParams()?.toString() ?? '' // F-OP-210

  if (model.amend) return <AmendLines order={order} amend={model.amend} model={model} actions={actions} />

  return (
    <div className="fw-so-stack">
      <Totals order={order} model={model} />
      <div className="fw-so-card-head">
        <p className="fw-so-hint">{t('lines.readOnly')}</p>
        {model.can.manage && !isFinal(order) && (
          <span className="fw-so-actions">
            <Button size="sm" heldReason={held ? t(held.key) : busy} onClick={() => actions?.onAmendStart?.()}>
              <PencilLine size={14} aria-hidden /> {t('amend.start')}
            </Button>
            <Button size="sm" variant="quiet" heldReason={closeWait ? t(closeWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'closeLines' })}>
              {t('action.closeLines')}
            </Button>
            {order.lines.some((line) => line.closedShort) && (
              <Button size="sm" variant="quiet" heldReason={reopenWait ? t(reopenWait.key) : busy} onClick={() => actions?.onDialog?.({ kind: 'reopenLines' })}>
                {t('action.reopenLines')}
              </Button>
            )}
          </span>
        )}
      </div>
      {groups.map((group) => {
        const grid = gridOf(group, 'ordered')
        const currency = order.currency
        const first = group.lines[0]!
        // F-SA-231b: the artwork files the order read names (files.read), each once; the count the read gave where it names none.
        const artwork = artworkOfGroup(group.lines)
        const rows = group.lines.map((line) => ({
          id: line.id,
          cells: [
            <span key="c" className="fw-so-lineopen is-static" id={rowAnchor('SalesOrderLine', line.id) /* F-SA-266 */} tabIndex={-1}>
              <LinePicture order={order} line={line} size="line" />
              <span className="fw-so-cell">
                <span className="fw-so-inline">
                  {line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—'}
                  {line.kind === 'MADE_TO_MEASURE' && <Tag tone="neutral">{t('record.madeToMeasure')}</Tag>}
                  {/* F-SA-231b: the rider (name, garment, revision — never a measurement), only when the read names it (sales.measurements.view). */}
                  {line.kind === 'MADE_TO_MEASURE' && line.rider && <span className="fw-so-cell-sub">{t('lines.rider', { rider: line.rider.name, garment: line.rider.garmentType, revision: line.rider.revision })}</span>}
                  {model.lineOptions?.(line) /* B-W2b-340: the line's options */}
                  {model.lineCost?.(line) /* B-W2b-380: cost changed since priced */}
                  {/* F-SA-266: discuss this line (the customer reads "your order · line 2 · …": no price, no work-order number). */}
                  <DiscussDoor order={order} part={t('discuss.line', { seq: line.seq, name: `${line.style?.code ?? '—'} ${line.colourway?.name ?? ''}`.trim() })} target={{ kind: 'SalesOrderLine', id: line.id }} />
                </span>
                {line.closedShort && (
                  <span className="fw-so-closed">
                    <Tag tone="warning">{t('lines.closedShort', { count: line.closedShort.quantity })}</Tag>
                    {/* F-SA-231: who closed it and when (loaded, never shown before). */}
                    {line.closedShort.byId && <span className="fw-so-hint">{t('lines.closedBy', { name: order.people.find((person) => person.id === line.closedShort!.byId)?.name ?? t('dates.someone'), day: line.closedShort.at ? formatDate(line.closedShort.at, { locale }) : '—' })}</span>}
                    {/* B-W2b-16: the close's CANCEL reason code, in words (the code itself when the list is not read). */}
                    {line.closedShort.reasonCode && <span className="fw-so-hint">{reasonWords(line.closedShort.reasonCode, model.cancelReasons ?? null, locale)}</span>}
                    {line.closedShort.reason && <span className="fw-so-hint">{line.closedShort.reason}</span>}
                  </span>
                )}
                {/* F-SA-231: the line's description and note (loaded, never shown before). */}
                {line.description && <span className="fw-so-cell-sub">{line.description}</span>}
                {line.note && <span className="fw-so-cell-sub">{t('lines.note', { note: line.note })}</span>}
              </span>
            </span>,
            String(line.quantity),
            String(line.progress.shipped),
            ...(model.can.price ? [unitPrice(line.unitPrice, currency, locale), money(line.netAmount, currency, locale), line.vatNature ? t('lines.vatNature', { nature: line.vatNature }) : percent(String(Number(line.vatRatePct)), locale)] : []),
            line.promiseDate && line.promiseDate !== order.promiseDate ? formatDate(dayInstant(line.promiseDate), { locale }) : t('lines.orderDate'),
          ],
        }))
        const columns = [t('lines.col.colour'), t('lines.col.pieces'), t('lines.col.shipped'), ...(model.can.price ? [t(order.priceBasis === 'GROSS' ? 'lines.col.unitGross' : 'lines.col.unitNet'), t('lines.col.net'), t('lines.col.vat')] : []), t('lines.col.promise')]
        return (
          <Card padded key={group.styleId} className="fw-so-block">
            <div className="fw-so-card-head">
              <span className="fw-so-lineopen is-static">
                <LinePicture order={order} line={first} size="lineLarge" />
                <h2 className="fw-so-h3">
                  {group.code} · {group.name}
                </h2>
              </span>
              <span className="fw-so-inline">
                {group.revision ? <Tag tone={group.revision.status === 'RELEASED' ? 'success' : 'warning'}>{t('lines.revision', { revision: group.revision.revision })}</Tag> : <Tag tone="neutral">{t('lines.noRevision')}</Tag>}
                {/* F-SA-231: the artwork the reader may open (the order read counts it). F-SA-231b: it opens in the thread's ONE viewer
                    (the files the read names, the first shown; ← / → walk them); with no docked thread, the order's Files as before. */}
                {artwork.count > 0 &&
                  (frame?.openFiles && artwork.files.length > 0 ? (
                    <Button
                      size="sm"
                      variant="quiet"
                      title={t('lines.artworkOpen')}
                      onClick={(event) => frame.openFiles?.({ files: artwork.files.map((file) => ({ id: file.fileId, name: file.name, contentType: file.contentType, sizeBytes: file.sizeBytes })), fileId: artwork.files[0]!.fileId, returnTo: event.currentTarget })}
                    >
                      <FileImage size={13} aria-hidden /> {t('lines.artwork', { count: artwork.count })}
                    </Button>
                  ) : (
                    <Button size="sm" variant="quiet" asChild>
                      <TabLink href={tabHref(`${model.prefix}/sales/orders/${order.id}`, 'files', search) /* F-OP-210 */}>
                        <FileImage size={13} aria-hidden /> {t('lines.artwork', { count: artwork.count })}
                      </TabLink>
                    </Button>
                  ))}
              </span>
            </div>
            <div className="fw-so-gridbox">
              <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={t('lines.gridCaption', { style: group.code })} locale={INTL_LOCALE[locale]} copy={copy} />
            </div>
            {/* B-W2b-323: the size cells already cut, locked with their reason. */}
            <FrozenSizes model={model.depth} lines={group.lines} />
            <SummaryTable label={t('lines.pricesOf', { style: group.code })} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
          </Card>
        )
      })}
    </div>
  )
}

/** A colour line's (or a style's) picture: the one picture part with the address the order read holds; no file: its placeholder. */
function LinePicture({ order, line, size }: { order: Order; line: OrderLine; size: 'line' | 'lineLarge' }) {
  const name = `${line.style?.code ?? '—'}${line.colourway ? ` · ${line.colourway.name}` : ''}`
  return (
    <RecordPicture
      source="order"
      recordId={order.id}
      number={name}
      size={size}
      picture={line.style ? { styleId: line.styleId, styleCode: line.style.code, styleName: line.style.name, fileId: line.picture?.fileId ?? null, small: !!line.picture?.small } : null}
      held={line.picture?.small ?? null}
    />
  )
}

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
function AmendLines({ order, amend, model, actions }: { order: Order; amend: AmendState; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH) // B-W2b-323
  const locale = useLocale()
  const minimums = minimumsOf(order)
  const headerChanged = (amend.customerRef.trim() || null) !== (order.customerRef ?? null) || (amend.requestedDate || null) !== (order.requestedDate ?? null)
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
  const held = stripHeld(strip, { reason: amend.reason, busy: model.busy, local, extraOutcome: amend.extraOutcome, offer, fee: amend.fee })
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
      <Banner tone="info" title={t('amend.how')} />
      <Card padded>
        <h2 className="fw-so-h2">{t('amend.header')}</h2>
        <div className="fw-so-two">
          <Field label={t('amend.customerRef')}>
            <Input value={amend.customerRef} onChange={(event) => actions?.onAmendHeader?.('customerRef', event.target.value)} maxLength={100} autoComplete="off" />
          </Field>
          <Field label={t('amend.requestedDate')} hint={t('amend.requestedHint')}>
            <DateField value={amend.requestedDate} onChange={(value) => actions?.onAmendHeader?.('requestedDate', value)} min={model.today} locale={INTL_LOCALE[locale]} ariaLabel={t('amend.requestedDate')} />
          </Field>
        </div>
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
          <div>
            <Button size="sm" variant="quiet" heldReason={model.busy ? t('held.busy') : null} onClick={() => actions?.onPricedOffer?.()}>
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


/** B-W2b-16: a CANCEL reason code in the person's language (the code itself when the list was not read). */
function reasonWords(code: string, reasons: readonly { code: string; labelIt: string; labelEn: string }[] | null, locale: string): string {
  const found = reasons?.find((entry) => entry.code === code)
  return found ? (locale === 'it' ? found.labelIt : found.labelEn) : code
}
