'use client'

import { Banner, Card, EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Tag } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import type { QuoteDetail } from '../../api'
import { lowestMarginLine, marginTone, money, percent, unitPrice } from '../../model'
import type { QuoteRecordViewModel } from '../record-model'

/**
 * Price & margin (design `quote.price.strip`, `quote.price.lines`): the quote's money in a few numbers, then how each
 * line is priced and what it earns. Cost columns need the cost grain, margin columns the margin grain, the margin AMOUNT
 * both (net − margin is the cost: the API leaves it out otherwise); a column the person may not see is absent, and the
 * tab says so once. Prices change on the Lines tab only (one edit path).
 */
export function PriceTab({ quote, model }: { quote: QuoteDetail; model: QuoteRecordViewModel }) {
  const t = useT('sales')
  const locale = useLocale()
  const current = quote.current
  const currency = current.currency
  const { grains } = model
  if (!grains.price) {
    return (
      <Card padded>
        <EmptyState title={t('price.noPrice.title')} description={t('price.noPrice.body')} />
      </Card>
    )
  }
  if (quote.lines.length === 0) {
    return (
      <Card padded>
        <EmptyState title={t('price.empty.title')} description={t('price.empty.body')} />
      </Card>
    )
  }
  const lowest = grains.margin ? lowestMarginLine(quote.lines) : null
  const tone = marginTone(current.marginPct, current.marginFloorPct)
  const columns = [
    t('price.col.line'),
    t('price.col.qty'),
    t('price.col.list'),
    t(current.priceBasis === 'GROSS' ? 'price.col.unitGross' : 'price.col.unitNet'),
    t('price.col.net'),
    ...(grains.cost ? [t('price.col.unitCost'), t('price.col.source')] : []),
    ...(grains.cost && grains.margin ? [t('price.col.marginAmount')] : []),
    ...(grains.margin ? [t('price.col.marginPct')] : []),
  ]
  const rows = [...quote.lines]
    .sort((a, b) => a.seq - b.seq)
    .map((line) => {
      const lineTone = marginTone(line.marginPct, current.marginFloorPct)
      return {
        id: line.id,
        cells: [
          <span key="l" className="fw-q-cell">
            <strong>{line.style.code}</strong> {line.colourway.code} · {line.colourway.name}
          </span>,
          String(line.quantity),
          unitPrice(line.listUnitPrice, currency, locale),
          unitPrice(line.unitPrice, currency, locale),
          money(line.netAmount, currency, locale),
          ...(grains.cost
            ? [
                line.costComplete ? unitPrice(line.unitCost, currency, locale) : <Tag key="c" tone="danger">{t('lines.costMissing')}</Tag>,
                line.styleRevision ? t(line.styleRevision.status === 'RELEASED' ? 'lines.revReleased' : 'lines.revEstimate', { revision: line.styleRevision.revision }) : t('lines.noCostSheet'),
              ]
            : []),
          ...(grains.cost && grains.margin ? [money(line.marginAmount, currency, locale)] : []),
          ...(grains.margin
            ? [
                <span key="m" className="fw-q-inline">
                  {percent(line.marginPct, locale)}
                  {lineTone === 'danger' ? <Tag tone="danger">{t('price.negative')}</Tag> : lineTone === 'warning' ? <Tag tone="warning">{t('lines.belowFloor')}</Tag> : null}
                </span>,
              ]
            : []),
        ],
      }
    })

  return (
    <div className="fw-q-stack">
      <MetricStrip
        metrics={[
          { label: t('price.tile.net'), value: money(current.netAmount, currency, locale) },
          ...(grains.cost ? [{ label: t('price.tile.cost'), value: current.costComplete ? money(current.costAmount, currency, locale) : '—', hint: current.costComplete ? undefined : t('summary.costIncomplete') }] : []),
          ...(grains.cost && grains.margin ? [{ label: t('price.tile.marginAmount'), value: money(current.marginAmount, currency, locale) }] : []),
          ...(grains.margin
            ? [
                { label: t('price.tile.marginPct'), value: percent(current.marginPct, locale), hint: t('price.tile.floor', { floor: percent(current.marginFloorPct, locale) }), accent: tone === 'success' ? 'var(--nds-success)' : tone === 'warning' ? 'var(--nds-warning)' : tone === 'danger' ? 'var(--nds-danger)' : undefined },
                { label: t('price.tile.lowest'), value: lowest ? percent(lowest.marginPct, locale) : '—', hint: lowest ? `${lowest.style.code} ${lowest.colourway.code}` : undefined },
              ]
            : []),
        ]}
      />
      {(!grains.cost || !grains.margin) && <Banner tone="info" title={t(grains.margin ? 'price.grainNoteMargin' : 'price.grainNote')} />}
      <Card>
        <div className="fw-q-table">
          <SummaryTable label={t('price.tableLabel')} columns={columns} rows={rows} density="roomy" stackOnPhone align={columns.map((_, index) => (index === 0 ? 'left' : 'right'))} />
        </div>
      </Card>
      <p className="fw-q-hint">{t('price.editOnLines')}</p>
    </div>
  )
}
