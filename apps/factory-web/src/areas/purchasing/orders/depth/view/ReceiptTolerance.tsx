'use client'

import { Card, SummaryTable } from '@nexus/ui/components'
import { Pill } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { quantity } from '../../../../_shared/buying/model'
import type { PurchaseOrder } from '../../api'
import { DEPTH, differencePct, receiptLines, type OrderDepthModel } from '../model'

const KIND_TONE = { EXACT: 'success', WITHIN_TOLERANCE: 'success', OVER: 'danger', SHORT: 'warning' } as const

/**
 * Receipts › received against the order (design rec receipts "over or under tolerance (W2b)", SCM-061): per line what came
 * of what it expects, the difference and its share, the tolerance either way and where it comes from (the line's own area
 * tolerance, a delivery tolerance rule, or none: exactly as ordered), and the verdict — as expected · within the tolerance
 * (the line counts as received) · over the tolerance · short (the order waits for the rest). The receipt command decides
 * with the same rule; this card shows where each line stands.
 */
export function ReceiptTolerance({ order, model }: { order: PurchaseOrder; model: OrderDepthModel | null }) {
  const t = useT(DEPTH)
  const tb = useT('buying')
  const locale = useLocale()
  if (order.status === 'DRAFT' || order.status === 'PENDING_APPROVAL' || order.lines.length === 0) return null
  const rows = receiptLines(order, model?.depth.value ?? null)
  const tolerance = (row: (typeof rows)[number]) =>
    row.tolerance.source === 'NONE' ? t('tolerance.none') : row.tolerance.over === row.tolerance.under ? t('tolerance.both', { pct: row.tolerance.over }) : t('tolerance.overUnder', { over: row.tolerance.over, under: row.tolerance.under })
  return (
    <Card padded>
      <div className="fw-by-stack">
        <h3 className="fw-by-h3">{t('tolerance.title')}</h3>
        <SummaryTable
          label={t('tolerance.title')}
          stackOnPhone
          columns={[tb('po.col.seq'), tb('po.col.material'), t('tolerance.col.received'), t('tolerance.col.difference'), t('tolerance.col.tolerance'), t('tolerance.col.state')]}
          align={['right', 'left', 'right', 'right', 'left', 'left']}
          widths={['48px', undefined, undefined, undefined, undefined, undefined]}
          rows={rows.map((row) => {
            const unit = tb(`uom.${row.baseUom}`)
            const pct = differencePct(row)
            return {
              id: row.id,
              cells: [
                String(row.seq),
                row.item,
                t('tolerance.of', { received: quantity(row.received, locale), expected: quantity(row.expected, locale), unit }),
                row.difference ? `${Number(row.difference.difference) > 0 ? '+' : ''}${quantity(row.difference.difference, locale)} ${unit}${pct !== null ? ` (${Number(pct) > 0 ? '+' : ''}${pct.replace('.', locale === 'it' ? ',' : '.')} %)` : ''}` : '—',
                <span key="tol" className="fw-by-cell">
                  <span>{tolerance(row)}</span>
                  <span className="nds-summary-sub">{t(`tolerance.source.${row.tolerance.source}`)}</span>
                </span>,
                row.difference ? <Pill key="state" tone={KIND_TONE[row.difference.kind]}>{t(`tolerance.kind.${row.difference.kind}`)}</Pill> : <span key="state">{t(row.ended ? 'tolerance.ended' : 'tolerance.nothing')}</span>,
              ],
            }
          })}
        />
        {model?.depth.problem && <p className="fw-by-hint fw-by-warning">{t('tolerance.depthFailed')}</p>}
      </div>
    </Card>
  )
}
