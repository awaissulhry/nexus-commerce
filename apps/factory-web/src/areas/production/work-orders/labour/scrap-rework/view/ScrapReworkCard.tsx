'use client'

import { Card, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { useLocale, useT } from '../../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../../record-panels/i18n'
import { COSTING_NAMESPACE, decimalText, moneyText } from '../../../../../finance/costing/model'
import { CLOSE_NS } from '../../../close/model'
import type { ScrapReworkRow } from '../api'
import { costUnknown, reasonWords, scrapReworkState, type ScrapReworkModel } from '../model'

/**
 * SCR-461-scrap — Scrap and rework cost on the work order's Labour & cost tab (design production.workorders rec:labour
 * wo-cost; FIN-029; B-W2b-GB02, B-W2b-424's gap 5): per reason, the garments scrapped at an operation or in a rework and
 * their value, the material scrapped from stock for the work order, the garments reworked with their standard minutes and
 * cost, and the totals. Inside the cost section: it needs the cost grain like the rest of it (the tab says why without it).
 * A rework with no cost per minute in force says so (never a 0). Per work order and reason: never per person, never wages.
 */
export function ScrapReworkCard({ model, onRetry }: { model: ScrapReworkModel; onRetry?: () => void }) {
  return (
    <WithMessages namespaces={[CLOSE_NS, COSTING_NAMESPACE]}>
      <ScrapReworkPart model={model} onRetry={onRetry} />
    </WithMessages>
  )
}

function ScrapReworkPart({ model, onRetry }: { model: ScrapReworkModel; onRetry?: () => void }) {
  const t = useT(CLOSE_NS)
  const locale = useLocale()
  const state = scrapReworkState(model)
  const head = (
    <div className="fw-fco-section-head">
      <h2 className="fw-fco-h2">{t('scrapRework.title')}</h2>
    </div>
  )
  if (state === 'loading') {
    return (
      <Card padded className="fw-fco-card" aria-busy="true">
        {head}
        <p className="fw-fco-muted" role="status">
          <Spinner size={14} /> {t('scrapRework.loading')}
        </p>
      </Card>
    )
  }
  if (state === 'failed') {
    return (
      <Card padded className="fw-fco-card">
        <EmptyState
          title={t('scrapRework.failed')}
          description={t(model.part?.problem ?? 'problem.internal')}
          action={
            <Button size="sm" onClick={() => onRetry?.()}>
              {t('common.retry')}
            </Button>
          }
        />
      </Card>
    )
  }
  const value = model.part!.value!
  if (state === 'none') {
    return (
      <Card padded className="fw-fco-card">
        {head}
        <p className="fw-fco-muted">{t('scrapRework.none')}</p>
      </Card>
    )
  }
  const money = (minor: number | null | undefined) => moneyText(minor ?? null, value.currency, locale)
  const cells = (row: Omit<ScrapReworkRow, 'reasonCode'>) => [
    <span key="scrap" className="fw-fco-cell">
      <span className="fw-fco-num">{t('figure.garments', { count: row.scrappedGarments })}</span>
      <span className="nds-summary-sub">{money(row.scrapValue)}</span>
    </span>,
    <span key="stock" className="fw-fco-num">
      {money(row.stockScrapValue)}
    </span>,
    <span key="rework" className="fw-fco-cell">
      <span className="fw-fco-num">{t('scrapRework.reworked', { count: row.reworkGarments, minutes: decimalText(row.reworkMinutes, locale, 1) })}</span>
      <span className="nds-summary-sub">{costUnknown(row) ? t('scrapRework.noRate') : money(row.reworkCost)}</span>
    </span>,
    <span key="total" className="fw-fco-num">
      {row.total === null ? t('scrapRework.totalUnknown') : money(row.total)}
    </span>,
  ]
  return (
    <Card padded className="fw-fco-card">
      {head}
      <p className="fw-fco-muted">{t('scrapRework.hint')}</p>
      <SummaryTable
        label={t('scrapRework.title')}
        columns={[t('scrapRework.col.reason'), t('scrapRework.col.scrapped'), t('scrapRework.col.stock'), t('scrapRework.col.rework'), t('scrapRework.col.total')]}
        align={[undefined, 'right', 'right', 'right', 'right']}
        widths={['26%', undefined, undefined, undefined, '16%']}
        stackOnPhone
        rows={[
          ...value.rows.map((row) => ({ id: row.reasonCode, cells: [reasonWords(row.reasonCode, model.reasons, locale, t('scrapRework.noReason')), ...cells(row)] })),
          { id: 'total', cells: [<b key="label">{t('scrapRework.total')}</b>, ...cells(value.totals)] },
        ]}
      />
      <p className="fw-fco-muted">{t('scrapRework.never')}</p>
    </Card>
  )
}
