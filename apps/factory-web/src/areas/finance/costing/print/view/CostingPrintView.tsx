'use client'

import { Printer } from 'lucide-react'
import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { Button, Spinner } from '@nexus/ui/primitives'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { CostTiles, MethodView, WorkOrderCostRow } from '../../api'
import { basisPhrase, COSTING_NAMESPACE, methodPhrase, moneyText, pctText, signedMoney, statePhrase, type CostingAddress, type CostingCan } from '../../model'
import '../../costing.css'

/** SCR-154-print — the variance report on paper: one view model, nothing fetched. */
export interface CostingPrintModel {
  /** Who printed it (said at the top with the time). */
  readonly person: string
  readonly company: string
  readonly can: CostingCan
  readonly address: CostingAddress
  readonly period: { readonly month: string; readonly from: string; readonly to: string }
  readonly read: { readonly rows: readonly WorkOrderCostRow[] | null; readonly tiles: CostTiles | null; readonly more: boolean; readonly problem: string | null }
  readonly method: MethodView | null
  /** When it was read (an instant). */
  readonly readAt: string | null
}

/**
 * Finance › Costing › Variance report (print) (design finance.costing tab:print, "print stylesheet with scope written at
 * the top"): the company, the scope (rows view, search, period), when it was read and by whom, the costing method in
 * words (provisional while the accountant has not chosen), then one row per work order — basis, standard, estimate at
 * release, actual so far, variance and %, biggest reason, open or final — and the total variance of the rows. Amounts
 * only with the cost grain. The print stylesheet hides the Office frame; the browser saves it as a PDF.
 */
export function CostingPrintView({ model }: { model: CostingPrintModel }) {
  return (
    <WithMessages namespaces={[COSTING_NAMESPACE]}>
      <CostingPrint model={model} />
    </WithMessages>
  )
}

function CostingPrint({ model }: { model: CostingPrintModel }) {
  const t = useT(COSTING_NAMESPACE)
  const locale = useLocale()
  const monthText = new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${model.period.month}-15T12:00:00Z`))
  if (!model.can.view) {
    return (
      <article className="fw-fco-print">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body', { permission: 'costing.view' })} />
      </article>
    )
  }
  const rows = model.read.rows
  const cost = model.can.cost
  const method = methodPhrase(model.method)
  const methodName = model.method && model.method.method !== 'UNDECIDED' ? t(`method.name.${model.method.method}`) : ''
  const currencies = [...new Set((rows ?? []).map((row) => row.currency))]
  const totalVariance = rows && currencies.length === 1 ? rows.reduce((sum, row) => sum + (typeof row.variance === 'number' ? row.variance : 0), 0) : null
  const scope = [t(`rows.${model.address.rows}`, { month: monthText }), model.address.q ? t('print.search', { q: model.address.q }) : null, t('print.period', { from: formatDate(`${model.period.from}T12:00:00Z`, { locale }), to: formatDate(`${model.period.to}T12:00:00Z`, { locale }) })].filter(Boolean).join(' · ')
  return (
    <article className="fw-fco-print">
      <header className="fw-fco-print-head">
        <h2 className="fw-fco-print-title">{t('print.title', { company: model.company })}</h2>
        <p className="fw-fco-muted">{scope}</p>
        <p className="fw-fco-muted">{model.readAt ? t('print.meta', { at: formatDateTime(model.readAt, { locale }), person: model.person }) : model.person}</p>
        <p className="fw-fco-muted">{t(method.key, { method: methodName })}</p>
        {!cost && <p className="fw-fco-muted">{t('noCost.tiles')}</p>}
        <Button className="fw-fco-print-button" variant="secondary" onClick={() => window.print()} heldReason={rows ? undefined : t('print.held')}>
          <Printer size={14} aria-hidden /> {t('print.button')}
        </Button>
      </header>
      {model.read.problem ? (
        <Banner tone="danger" title={t('list.failed')}>
          {t(model.read.problem)}
        </Banner>
      ) : !rows ? (
        <p className="fw-fco-muted" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : rows.length === 0 ? (
        <EmptyState title={t('list.empty.title')} description={t('list.empty.body')} />
      ) : (
        <section className="fw-fco-section" aria-label={t('list.title')}>
          <SummaryTable
            label={t('list.title')}
            columns={[t('col.workOrder'), t('col.pieces'), t('col.basis'), ...(cost ? [t('col.standard'), t('col.estimate'), t('col.actual'), t('col.variance'), t('col.variancePct')] : []), t('col.reason'), t('col.state')]}
            align={[undefined, 'right', undefined, ...(cost ? (['right', 'right', 'right', 'right', 'right'] as const) : []), undefined, undefined]}
            rows={[
              ...rows.map((row) => ({
                id: row.workOrder.id,
                cells: [
                  `${row.workOrder.number} · ${row.workOrder.style.code}`,
                  String(row.workOrder.pieces),
                  t(basisPhrase(row).key),
                  ...(cost
                    ? [
                        moneyText(row.standardTotal ?? null, row.currency, locale),
                        moneyText(row.estimateTotal ?? null, row.currency, locale),
                        moneyText(row.actualTotal ?? null, row.currency, locale),
                        signedMoney(row.variance ?? null, row.currency, locale),
                        pctText(row.variancePct ?? null, locale, true),
                      ]
                    : []),
                  row.biggestReason ? t(`reason.${row.biggestReason}`) : t('reason.none'),
                  t(statePhrase(row).key),
                ],
              })),
              ...(cost && totalVariance !== null
                ? [{ id: 'total', cells: [t('print.total', { count: rows.length }), '', '', '', '', '', signedMoney(totalVariance, currencies[0] ?? null, locale), '', '', ''] }]
                : []),
            ]}
          />
          {model.read.more && <p className="fw-fco-muted">{t('print.more', { count: rows.length })}</p>}
        </section>
      )}
    </article>
  )
}
