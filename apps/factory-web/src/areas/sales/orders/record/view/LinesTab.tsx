'use client'

import { useEffect } from 'react'
import Link from 'next/link'
import { PencilLine } from 'lucide-react'
import { Banner, Card, Field, KeyValue, RecordLayout, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { Button, Input, SegmentedControl, Tag } from '@nexus/ui/primitives'
import { DateField } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { money, percent, unitPrice } from '../../../quotes/model'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order } from '../../api'
import { amendHeld, changeCount, minimumsOf, reviewHeld } from '../../daily-model'
import { dayInstant, depositGate, gridOf, SIZE_LAYERS, stillToPay, styleGroups, type Phrase } from '../../model'
import type { AmendState, OrderRecordActions, OrderRecordModel } from '../record-model'
import { LinesEditor } from './LinesEditor'
// ---- B-W2b-323 (orders in depth on screen) ----
import { FrozenSizes, frozenIssues } from '../../depth/view/LinesDepth'
import { NAMESPACE as DEPTH } from '../../depth/model'

/**
 * Lines (design `order.lines.cards` + `order.lines.summary`): one card per style — the colourways × sizes in the DS size
 * grid with a "Show" switch (ordered · in work orders · released by quality · shipped · still to ship; pieces made per
 * size are counted on each work order) and each colour line's price, net and VAT (price grain) — and the summary rail:
 * units, net, VAT, gross, the deposit, invoiced / paid / balance (invoices.view), the estimated margin % (margin grain),
 * and the record chain from the quote to the invoices, every step a real link. Read-only: an order changes through an
 * amendment: "Amend order" (B-W2a-50) turns the lines into an amendment draft — the lines editor, the order's customer PO
 * and requested date, and the bar "Amendment 2 — not applied" with Discard and Review (⌘↵) — and a line closed short
 * says so with its pieces and reason.
 */
export function LinesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const groups = styleGroups(order.lines)
  const copy = sizeGridWords(sales)
  const held = amendHeld(order, model.can)

  if (model.amend) return <AmendLines order={order} amend={model.amend} model={model} actions={actions} />

  return (
    <RecordLayout
      asideLabel={t('summary.label')}
      main={
        <div className="fw-so-stack">
          <div className="fw-so-card-head">
            <span className="fw-so-inline">
              <p className="fw-so-hint">{t('lines.readOnly')}</p>
              {model.can.manage && (
                <Button size="sm" heldReason={held ? t(held.key) : model.busy ? t('held.busy') : null} onClick={() => actions?.onAmendStart?.()}>
                  <PencilLine size={14} aria-hidden /> {t('amend.start')}
                </Button>
              )}
            </span>
            <SegmentedControl
              size="sm"
              ariaLabel={t('lines.show')}
              value={model.sizeLayer}
              onChange={(value) => actions?.onSizeLayer?.(value as (typeof SIZE_LAYERS)[number])}
              options={SIZE_LAYERS.map((layer) => ({ value: layer, label: t(`layer.${layer}`) }))}
              wrap
            />
          </div>
          {groups.map((group) => {
            const grid = gridOf(group, model.sizeLayer)
            const currency = order.currency
            const rows = group.lines.map((line) => ({
              id: line.id,
              cells: [
                <span key="c" className="fw-so-cell">
                  {line.colourway ? `${line.colourway.code} · ${line.colourway.name}` : '—'}
                  {model.lineOptions?.(line) /* B-W2b-340: the line's options */}
                  {model.lineCost?.(line) /* B-W2b-380: cost changed since priced */}
                  {line.closedShort && (
                    <span className="fw-so-closed">
                      <Tag tone="warning">{t('lines.closedShort', { count: line.closedShort.quantity })}</Tag>
                      {/* B-W2b-16: the close's CANCEL reason code, in words (the code itself when the list is not read). */}
                      {line.closedShort.reasonCode && <span className="fw-so-hint">{reasonWords(line.closedShort.reasonCode, model.cancelReasons ?? null, locale)}</span>}
                      {line.closedShort.reason && <span className="fw-so-hint">{line.closedShort.reason}</span>}
                    </span>
                  )}
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
                  <h2 className="fw-so-h3">
                    {group.code} · {group.name}
                  </h2>
                  {group.revision ? <Tag tone={group.revision.status === 'RELEASED' ? 'success' : 'warning'}>{t('lines.revision', { revision: group.revision.revision })}</Tag> : <Tag tone="neutral">{t('lines.noRevision')}</Tag>}
                </div>
                <div className="fw-so-gridbox">
                  <SizeGridView colours={grid.colours} sizes={grid.sizes} value={grid.value} caption={t('lines.gridCaption', { style: group.code, layer: t(`layer.${model.sizeLayer}`) })} locale={INTL_LOCALE[locale]} copy={copy} />
                </div>
                {/* B-W2b-323: the size cells already cut, locked with their reason. */}
                <FrozenSizes model={model.depth} lines={group.lines} />
                <SummaryTable label={t('lines.pricesOf', { style: group.code })} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
              </Card>
            )
          })}
          {model.sizeLayer === 'inWorkOrders' && <p className="fw-so-hint">{t('lines.madeHint')}</p>}
          {/* F-SA-235: Customer-supplied materials moved to Production › Materials. */}
        </div>
      }
      aside={<SummaryRail order={order} model={model} />}
    />
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
  const held = model.busy ? phraseOf('held.busy') : reviewHeld(amend.lines, order, minimums, { changed: headerChanged })
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
    <RecordLayout
      asideLabel={t('summary.label')}
      main={
        <div className="fw-so-stack">
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
            model={{ mode: 'amend', lines: amend.lines, order, styles: amend.styles, composer: amend.composer, price: model.can.price, currency: order.currency, priceBasis: order.priceBasis, minimums, busy: model.busy, frozen: frozenIssues(model.depth, d) /* B-W2b-323 */, newLineOptions: model.newLineOptions /* B-W2b-374 */ }}
            actions={{ onCells: actions?.onAmendCells, onPrice: actions?.onAmendPrice, onComposerQuery: actions?.onComposerQuery, onComposerPick: actions?.onComposerPick, onComposerToggle: actions?.onComposerToggle, onComposerAdd: actions?.onComposerAdd }}
          />
        </div>
      }
      aside={<SummaryRail order={order} model={model} />}
    />
  )
}

const phraseOf = (key: string): Phrase => ({ key })

/** The summary rail (`order.lines.summary`): the order's money and gates in view, and the record chain. */
export function SummaryRail({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const locale = useLocale()
  const currency = order.currency
  const gate = depositGate(order)
  const settlement = model.settlement?.value ?? null
  const request = gate.request
  const left = request ? stillToPay(request) : null
  const items = [
    { label: t('summary.lines'), value: t('summary.linesValue', { lines: order.lines.length, units: order.progress.ordered }) },
    ...(model.can.price
      ? [
          { label: t('summary.net'), value: money(order.netAmount, currency, locale) },
          { label: t('summary.vat'), value: money(order.vatAmount, currency, locale) },
          { label: t(order.priceBasis === 'GROSS' ? 'summary.grossConsumer' : 'summary.gross'), value: <strong>{money(order.grossAmount, currency, locale)}</strong> },
        ]
      : [{ label: t('summary.money'), value: t('summary.noPrice') }]),
    {
      label: t('summary.deposit'),
      value:
        gate.state === 'NOT_NEEDED'
          ? t('summary.depositNotNeeded')
          : !request
            ? t('summary.depositMissing')
            : request.status === 'PAID'
              ? t('summary.depositPaid', { amount: money(request.amount, currency, locale) })
              : request.status === 'WAIVED'
                ? t('summary.depositWaived')
                : t('summary.depositOpen', { amount: money(left ?? request.amount, currency, locale), date: formatDate(dayInstant(request.dueDate), { locale }) }),
    },
    ...(model.can.viewInvoices && model.can.price && settlement
      ? [
          { label: t('summary.invoiced'), value: money(settlement.invoicedAmount, currency, locale) },
          { label: t('summary.paid'), value: money(settlement.paidAmount, currency, locale) },
          { label: t('summary.balance'), value: money(settlement.balanceDueAmount, currency, locale) },
        ]
      : []),
    ...(model.can.margin ? [{ label: t('summary.margin'), value: order.marginPct === null || order.marginPct === undefined ? t('summary.marginUnknown') : t('summary.marginValue', { pct: percent(order.marginPct, locale) }) }] : []),
    ...(model.can.cost ? [{ label: t('summary.cost'), value: order.costAmount === null || order.costAmount === undefined ? t('summary.costIncomplete') : money(order.costAmount, currency, locale) }] : []),
  ]
  return (
    <div className="fw-so-rail">
      <Card padded>
        <h2 className="fw-so-h2">{t('summary.title')}</h2>
        <KeyValue dense labelCase="sentence" items={items} />
      </Card>
      {/* F-SA-233: the record chain left Lines: Overview › Linked records (each a real link, counted by right). */}
    </div>
  )
}

/** B-W2b-16: a CANCEL reason code in the person's language (the code itself when the list was not read). */
function reasonWords(code: string, reasons: readonly { code: string; labelIt: string; labelEn: string }[] | null, locale: string): string {
  const found = reasons?.find((entry) => entry.code === code)
  return found ? (locale === 'it' ? found.labelIt : found.labelEn) : code
}
