'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { FileImage, PencilLine } from 'lucide-react'
import { Banner, Card, Field, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, Tag } from '@nexus/ui/primitives'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { RecordPicture } from '../../../../../lib/record-picture/view/RecordPicture'
import { money, percent, unitPrice } from '../../../quotes/model'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order, OrderLine } from '../../api'
import { amendHeld, changeCount, closeLinesHeld, cutFloorsOf, minimumsOf, reopenHeld, reviewHeld } from '../../daily-model'
import { dayInstant, gridOf, isFinal, styleGroups, type Phrase } from '../../model'
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
                      <Link href={`${model.prefix}/sales/orders/${order.id}?tab=files`}>
                        <FileImage size={13} aria-hidden /> {t('lines.artwork', { count: artwork.count })}
                      </Link>
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
 * The Lines tab in amend mode: the bar (composed: the DS EditModeBar speaks English only) — "Amendment N — not applied ·
 * 3 lines change", Discard, Review (⌘↵, held with its reason) — the order's customer PO and requested date, and the lines
 * editor. Leaving the page while it holds changes asks first.
 */
function AmendLines({ order, amend, model, actions }: { order: Order; amend: AmendState; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const d = useT(DEPTH) // B-W2b-323
  const locale = useLocale()
  const minimums = minimumsOf(order)
  const headerChanged = (amend.customerRef.trim() || null) !== (order.customerRef ?? null) || (amend.requestedDate || null) !== (order.requestedDate ?? null)
  const count = changeCount(amend.lines, order) + (headerChanged ? 1 : 0)
  // F-SA-231: the floor of a size is what is already cut (the production read's own cells); under work orders is said, not held.
  const floors = cutFloorsOf(readOf(model.production)?.lines ?? [])
  const held = model.busy ? phraseOf('held.busy') : reviewHeld(amend.lines, order, { changed: headerChanged }, floors)
  const heldText = held ? t(held.key, held.params) : null
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
      if (!heldText) actions?.onAmendReview?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
  return (
        <div className="fw-so-stack">
          <Totals order={order} model={model} />
          <div className="fw-so-amendbar" role="region" aria-label={t('amend.barLabel')}>
            <span className="fw-so-amendbar-words">
              <strong>{t('amend.title', { revision: amend.revision })}</strong> <span className="fw-so-hint">{t('amend.count', { count })}</span>
            </span>
            <span className="fw-so-actions">
              <Button size="sm" onClick={() => actions?.onAmendDiscard?.()} heldReason={model.busy ? t('held.busy') : null}>
                {t('amend.discard')}
              </Button>
              <Button size="sm" variant="primary" heldReason={heldText} onClick={() => actions?.onAmendReview?.()} aria-keyshortcuts="Meta+Enter Control+Enter">
                {t('amend.review')}
              </Button>
            </span>
          </div>
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
            model={{ mode: 'amend', lines: amend.lines, order, styles: amend.styles, composer: amend.composer, price: model.can.price, currency: order.currency, priceBasis: order.priceBasis, minimums, floors /* F-SA-231 */, busy: model.busy, frozen: frozenIssues(model.depth, d) /* B-W2b-323 */, newLineOptions: model.newLineOptions /* B-W2b-374 */ }}
            actions={{ onCells: actions?.onAmendCells, onPrice: actions?.onAmendPrice, onComposerQuery: actions?.onComposerQuery, onComposerPick: actions?.onComposerPick, onComposerToggle: actions?.onComposerToggle, onComposerAdd: actions?.onComposerAdd }}
          />
        </div>
  )
}

const phraseOf = (key: string): Phrase => ({ key })

/** B-W2b-16: a CANCEL reason code in the person's language (the code itself when the list was not read). */
function reasonWords(code: string, reasons: readonly { code: string; labelIt: string; labelEn: string }[] | null, locale: string): string {
  const found = reasons?.find((entry) => entry.code === code)
  return found ? (locale === 'it' ? found.labelIt : found.labelEn) : code
}
