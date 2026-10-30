'use client'

import { Banner, Card, EmptyState, MetricStrip, SummaryTable } from '@nexus/ui/components'
import { Pill, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { LOT_TONE, type LotStatus } from '../../../../quality/_shared/lots'
import type { MaterialView } from '../../api'
import { numberText } from '../../model'
import type { MaterialRecordViewModel } from '../record-model'

/**
 * SCR-048 Stock (read only: Warehouse owns it): where the material stands now — on hand, available and on hold (a lot not
 * released yet), in its base unit, hides counted beside the area for leather — then each location, lot and hide. What is
 * on order and reserved is not in the stock answer: not drawn.
 */
export function StockTab({ material, model }: { material: MaterialView; model: MaterialRecordViewModel }) {
  const t = useT('library')
  const locale = useLocale()
  const read = model.stock
  const unit = t(`uom.${material.baseUom}`)
  if (!read) return null
  if (read.problem)
    return (
      <Banner tone="danger" title={t('material.stock.failed')}>
        {t(read.problem)}
      </Banner>
    )
  if (read.value === null)
    return (
      <Card padded aria-busy="true">
        <p className="fw-lib-hint fw-lib-inline" role="status">
          <Spinner size={12} /> {t('record.loading')}
        </p>
      </Card>
    )
  const stock = read.value
  const sum = (field: 'onHand' | 'held' | 'available') => stock.totals.reduce((total, row) => total + Number(row[field]), 0)
  const hides = stock.totals.reduce((total, row) => total + row.hides, 0)
  const qty = (value: number | string) => `${numberText(Number(value), locale, 2)} ${unit}`
  const colourOf = (id: string | null) => (id ? (material.colours.find((colour) => colour.id === id)?.code ?? '—') : t('material.stock.noColour'))
  return (
    <div className="fw-lib-stack">
      <MetricStrip
        metrics={[
          { label: t('material.stock.onHand'), value: qty(sum('onHand')), hint: material.kind === 'LEATHER' ? t('material.stock.hides', { count: hides }) : t('material.stock.onHandHint') },
          { label: t('material.stock.available'), value: qty(sum('available')), hint: t('material.stock.availableHint') },
          { label: t('material.stock.held'), value: qty(sum('held')), hint: t('material.stock.heldHint') },
        ]}
      />
      {stock.truncated && <Banner tone="warning" title={t('material.stock.truncated')} />}
      <Card header={t('material.stock.lots')}>
        {stock.rows.length === 0 ? (
          <EmptyState title={t('material.stock.empty')} />
        ) : (
          <SummaryTable
            label={t('material.stock.lots')}
            stackOnPhone
            columns={[t('material.stock.col.location'), t('material.stock.col.colour'), t('material.stock.col.lot'), t('material.stock.col.onHand'), t('material.stock.col.state')]}
            rows={stock.rows.map((row, index) => ({
              id: `${row.location.id}-${row.lot?.id ?? ''}-${row.hide?.id ?? ''}-${index}`,
              cells: [
                <span key="l" className="fw-lib-cell">
                  <span>{row.location.name}</span>
                  <span className="nds-summary-sub">{row.siteCode}</span>
                </span>,
                row.colour?.code ?? colourOf(null),
                row.hide ? t('material.stock.hide', { code: row.hide.code, lot: row.lot?.code ?? '—' }) : (row.lot?.code ?? '—'),
                qty(row.onHand),
                row.lot ? (
                  <Pill key="s" tone={LOT_TONE[row.lot.qualityStatus as LotStatus] ?? 'neutral'}>
                    {t(`lotStatus.${row.lot.qualityStatus}`)}
                  </Pill>
                ) : (
                  '—'
                ),
              ],
            }))}
          />
        )}
      </Card>
    </div>
  )
}
