'use client'

import { KeyValue, SummaryTable } from '@nexus/ui/components'
import { Spinner } from '@nexus/ui/primitives'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { LAYER_LIMIT, type ValuationRow } from '../api'
import { decimalText, moneyText, unitCostText } from '../model'
import type { HowValuedState } from './ValuationView'

/**
 * "How this lot is valued" (design finance.reports pop:how-valued; opened from the value cell): the company's costing
 * method (the accountant's; UNDECIDED until chosen, to confirm with the accountant), what is on hand and its value, the
 * lot's cost the next issue leaves at, and the latest moves with their cost — each receipt with its purchase order's
 * price — and the balance after each. Cost grain only (the cell is drawn only then). Esc closes and returns the focus.
 */
export function HowValued({ row, state }: { row: ValuationRow; state: HowValuedState }) {
  const t = useT('finance-reports')
  const locale = useLocale()
  const day = (value: string) => formatDate(`${value}T12:00:00Z`, { locale })
  const title = row.lot ? t('how.lotTitle', { code: row.lot.code }) : t('how.itemTitle', { code: row.item?.code ?? '' })
  if (state.problem) {
    return (
      <div className="fw-frv-pop">
        <p className="fw-frv-pop-title">{title}</p>
        <p className="fw-frv-muted" role="alert">
          {t('how.failed')} {t(state.problem)}
        </p>
      </div>
    )
  }
  const layers = state.value
  if (!layers) {
    return (
      <div className="fw-frv-pop" aria-busy="true">
        <p className="fw-frv-pop-title">{title}</p>
        <p className="fw-frv-muted" role="status">
          <Spinner size={12} /> {t('common.loading')}
        </p>
      </div>
    )
  }
  const currency = layers.currency
  const uom = layers.item.baseUom
  return (
    <div className="fw-frv-pop">
      <p className="fw-frv-pop-title">{title}</p>
      <p className="fw-frv-muted">{`${layers.item.code} · ${layers.item.name} · ${layers.site.code}`}</p>
      <KeyValue
        columns={2}
        dense
        items={[
          { label: t('how.method'), value: t(`how.companyMethod.${layers.method.method}`) },
          { label: t('how.onHand'), value: `${decimalText(layers.quantity, locale)} ${uom}` },
          { label: t('how.value'), value: moneyText(layers.value ?? null, currency, locale) },
          { label: t('how.unitCost'), value: unitCostText(layers.unitCost ?? null, currency, locale) },
          { label: t('how.lotCost'), value: unitCostText(layers.lotCost ?? null, currency, locale) },
        ]}
      />
      <p className="fw-frv-muted">{layers.dependsOnMethod ? t('how.depends') : t('how.same')}</p>
      {!layers.complete && (
        <p className="fw-frv-muted">
          {t('how.before', { count: LAYER_LIMIT, quantity: `${decimalText(layers.opening.quantity, locale)} ${uom}`, value: moneyText(layers.opening.value ?? null, currency, locale) })}
        </p>
      )}
      {layers.layers.length === 0 ? (
        <p className="fw-frv-muted">{t('how.noMoves')}</p>
      ) : (
        <div className="fw-frv-pop-layers">
          <SummaryTable
            label={t('how.layersLabel')}
            density="compact"
            columns={[t('how.col.day'), t('how.col.move'), t('how.col.quantity'), t('how.col.cost'), t('how.col.balance')]}
            align={[undefined, undefined, 'right', 'right', 'right']}
            rows={layers.layers.map((layer) => {
              const po = layer.purchaseOrder
              const from = layer.receipt ? t('how.receipt', { receipt: layer.receipt.number, order: po?.number ?? '—', price: po ? `${unitCostText(po.unitPrice ?? null, po.currency, locale)}/${po.uom}` : '—' }) : layer.reference
              return {
                id: layer.moveId,
                cells: [
                  day(layer.day),
                  <span key="m" className="fw-frv-cell">
                    <span>{t(`reason.${layer.reason}`)}</span>
                    <span className="fw-frv-cell-sub">{[from, layer.hide?.code, layer.reversalOfId ? t('how.reversal') : null].filter(Boolean).join(' · ') || '—'}</span>
                  </span>,
                  decimalText(layer.quantity, locale),
                  <span key="c" className="fw-frv-cell">
                    <span>{layer.method ? moneyText(layer.value ?? null, currency, locale) : t('how.notValued')}</span>
                    <span className="fw-frv-cell-sub">{layer.method ? `${t(`basis.method.${layer.method}`)} · ${unitCostText(layer.unitCost ?? null, currency, locale)}` : '—'}</span>
                  </span>,
                  <span key="b" className="fw-frv-cell">
                    <span>{`${decimalText(layer.balanceQuantity, locale)} ${uom}`}</span>
                    <span className="fw-frv-cell-sub">{moneyText(layer.balanceValue ?? null, currency, locale)}</span>
                  </span>,
                ],
              }
            })}
          />
        </div>
      )}
      <p className="fw-frv-muted">{t('how.accountant')}</p>
    </div>
  )
}
