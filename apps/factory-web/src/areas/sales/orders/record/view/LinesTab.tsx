'use client'

import Link from 'next/link'
import { Card, KeyValue, RecordLayout, SummaryTable } from '@nexus/ui/components'
import { SizeGridView } from '@nexus/ui/grid/size-grid/index'
import { SegmentedControl, Tag } from '@nexus/ui/primitives'
import { formatDate } from '../../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { recordAddress } from '../../../../../lib/records/record-links'
import { OFFICE_PAGES } from '../../../../../shell/nav/office-nav'
import { money, percent, unitPrice } from '../../../quotes/model'
import { sizeGridWords } from '../../../quotes/record/view/grid-copy'
import type { Order } from '../../api'
import { dayInstant, depositGate, gridOf, SIZE_LAYERS, stillToPay, styleGroups } from '../../model'
import type { OrderRecordActions, OrderRecordModel } from '../record-model'

/**
 * Lines (design `order.lines.cards` + `order.lines.summary`): one card per style — the colourways × sizes in the DS size
 * grid with a "Show" switch (ordered · in work orders · released by quality · shipped · still to ship; pieces made per
 * size are counted on each work order) and each colour line's price, net and VAT (price grain) — and the summary rail:
 * units, net, VAT, gross, the deposit, invoiced / paid / balance (invoices.view), the estimated margin % (margin grain),
 * and the record chain from the quote to the invoices, every step a real link. Read-only: an order changes through an
 * amendment (W2a).
 */
export function LinesTab({ order, model, actions }: { order: Order; model: OrderRecordModel; actions?: OrderRecordActions }) {
  const t = useT('orders')
  const sales = useT('sales')
  const locale = useLocale()
  const groups = styleGroups(order.lines)
  const copy = sizeGridWords(sales)

  return (
    <RecordLayout
      asideLabel={t('summary.label')}
      main={
        <div className="fw-so-stack">
          <div className="fw-so-card-head">
            <p className="fw-so-hint">{t('lines.readOnly')}</p>
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
                <SummaryTable label={t('lines.pricesOf', { style: group.code })} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
              </Card>
            )
          })}
          {model.sizeLayer === 'inWorkOrders' && <p className="fw-so-hint">{t('lines.madeHint')}</p>}
        </div>
      }
      aside={<SummaryRail order={order} model={model} />}
    />
  )
}

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
      <RecordChain order={order} model={model} />
    </div>
  )
}

/**
 * The record chain (design RecordChain, composed: the DS has none yet): Quote → Order → Deposit → Work orders →
 * Shipments → Invoices, each step with its state in words and a real link; an unknown step says "—".
 */
export function RecordChain({ order, model }: { order: Order; model: OrderRecordModel }) {
  const t = useT('orders')
  const record = `${model.prefix}/sales/orders/${order.id}`
  const open = (type: string, id: string, label: string) => `${model.prefix}${recordAddress({ type, id, label, companyId: order.companyId }, OFFICE_PAGES)}`
  const deposit = depositGate(order)
  const steps: Array<{ key: string; label: string; value: string; href: string | null }> = [
    {
      key: 'quote',
      label: t('chain.quote'),
      value: order.chain.quote ? t('chain.quoteValue', { number: order.chain.quote.number, revision: order.chain.quote.revision }) : t('chain.noQuote'),
      href: order.chain.quote && model.can.viewQuotes ? `${model.prefix}/sales/quotes/${order.chain.quote.id}` : null,
    },
    { key: 'order', label: t('chain.order'), value: t(`status.${order.status}`), href: null },
    { key: 'deposit', label: t('chain.deposit'), value: t(`gate.state.${deposit.state}`), href: `${record}?tab=money` },
    {
      key: 'workOrders',
      label: t('chain.workOrders'),
      value: order.chain.workOrders.length === 0 ? '—' : order.chain.workOrders.length === 1 ? order.chain.workOrders[0]!.number : t('chain.count', { count: order.chain.workOrders.length }),
      href: order.chain.workOrders.length === 0 ? null : order.chain.workOrders.length === 1 ? open('WorkOrder', order.chain.workOrders[0]!.id, order.chain.workOrders[0]!.number) : `${record}?tab=production`,
    },
    {
      key: 'shipments',
      label: t('chain.shipments'),
      value: order.chain.shipments.length === 0 ? '—' : t('chain.count', { count: order.chain.shipments.length }),
      href: order.chain.shipments.length === 0 ? null : `${record}?tab=shipments`,
    },
    {
      key: 'invoices',
      label: t('chain.invoices'),
      value: order.chain.invoices.length === 0 ? '—' : t('chain.count', { count: order.chain.invoices.length }),
      href: order.chain.invoices.length === 0 ? null : `${record}?tab=money`,
    },
  ]
  return (
    <Card padded>
      <h2 className="fw-so-h2">{t('chain.title')}</h2>
      <ol className="fw-so-chain" aria-label={t('chain.title')}>
        {steps.map((step) => (
          <li key={step.key} className="fw-so-chain-step">
            <span className="fw-so-chain-label">{step.label}</span>
            {step.href ? (
              <Link className="fw-so-link" href={step.href}>
                {step.value}
              </Link>
            ) : (
              <span>{step.value}</span>
            )}
          </li>
        ))}
      </ol>
    </Card>
  )
}
