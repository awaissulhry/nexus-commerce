'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import type { Uom } from '../../../../_shared/stock/api'
import { quantity } from '../../../../_shared/stock/model'
import { AGE_BUCKETS, type Ageing, type Leather, type LeatherFigures } from '../../api'
import { articleLabel, bucketCell, daysText, leatherQuantities, lotLabel, quantitiesText, valueText, type ReportsCan } from '../../model'
import '../../reports.css'

/** SCR-353 — Warehouse reports on paper or as a PDF (design tab:wr-tab-print): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  /** The top bar's site; null: every site the person sees. */
  site: string | null
  can: ReportsCan
  range: { from: string; to: string }
  /** The report's page (the strip's way back). */
  back: string
  ageing: Ageing | null
  leather: Leather | null
  /** A message key (warehouse-reports) of the part that failed. */
  problem: string | null
}

/**
 * The monthly stock review on paper (design tab:wr-tab-print, "paper or PDF for a meeting"): the company, the site, the period
 * and the day it was printed on top; then the stock ageing by material type (as at the period's last day) with the articles of
 * each type, and the leather use by article and supplier lot. Values only with the cost grain.
 */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['warehouse-reports', 'stock']}>
      <Print model={model} />
    </WithMessages>
  )
}

const QUANTITY_COLUMNS = ['start', 'received', 'cut', 'remnant', 'scrapped', 'other', 'end'] as const

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('warehouse-reports')
  const stock = useT('stock')
  const locale = useLocale()
  const ds = useDsWords()
  const unitWord = (uom: Uom) => stock(`uom.${uom}`)
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const { ageing, leather } = model
  const ready = !!ageing && !!leather
  const cost = model.can.cost && (ageing?.sight.values ?? false)
  const filters = [
    { label: t('print.period'), value: `${day(model.range.from)} – ${day(model.range.to)}` },
    { label: t('print.asAt'), value: day(model.range.to) },
    { label: t('print.site'), value: model.site ?? t('print.allSites') },
  ]
  const quantityCells = (figures: LeatherFigures) => {
    const shown = leatherQuantities(figures)
    return [shown ? unitWord(shown.uom) : '—', ...QUANTITY_COLUMNS.map((key) => (shown ? quantity(shown.values[key], locale) : '—'))]
  }
  const values = (figures: LeatherFigures) => (cost ? [valueText(figures.values.received, figures.currency, locale), valueText(figures.values.cut, figures.currency, locale), valueText(figures.values.end, figures.currency, locale)] : [])
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      back={{ href: model.back, label: t('print.back') }}
      labels={ds.printView}
    >
      {!model.can.view ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {t(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-wr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <PrintSection title={t('print.ageingTitle', { day: day(ageing!.asAt) })}>
            {!ageing!.sight.stock ? (
              <p>{t('notInRole.stock')}</p>
            ) : ageing!.types.length === 0 ? (
              <p>{t('ageing.empty', { day: day(ageing!.asAt) })}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('ageing.tableLabel')}
                  widths={['14%']}
                  columns={[t('col.type'), ...AGE_BUCKETS.map((bucket) => t(`bucket.${bucket}`)), t('col.whole'), ...(cost ? [t('col.value')] : []), t('col.averageDays'), t('col.oldestDays')]}
                  align={[undefined, ...AGE_BUCKETS.map(() => 'right' as const), 'right', ...(cost ? ['right' as const] : []), 'right', 'right']}
                  rows={ageing!.types.map((row) => ({
                    id: row.type,
                    cells: [
                      t(`type.${row.type}`),
                      ...AGE_BUCKETS.map((bucket) => bucketCell(row.buckets[bucket], unitWord, locale)),
                      quantitiesText(row.whole.quantities, unitWord, locale),
                      ...(cost ? [valueText(row.whole.value, row.currency, locale)] : []),
                      daysText(row.averageDays, locale),
                      row.oldestDays === null ? '—' : t('ageing.days', { count: row.oldestDays }),
                    ],
                  }))}
                />
                <p className="fw-wr-print-note">{[t('ageing.definition'), cost ? t('ageing.allValue', { value: valueText(ageing!.all.value, ageing!.all.currency, locale) }) : t('ageing.noCost')].join(' ')}</p>
              </>
            )}
          </PrintSection>
          {ageing!.types.map((type) => (
            <PrintSection key={type.type} title={t('ageing.articlesOf', { type: t(`type.${type.type}`) })}>
              <SummaryTable
                label={t('ageing.articlesOf', { type: t(`type.${type.type}`) })}
                widths={['26%']}
                columns={[t('col.article'), ...AGE_BUCKETS.map((bucket) => t(`bucket.${bucket}`)), t('col.whole'), ...(cost ? [t('col.value')] : []), t('col.oldestDays')]}
                align={[undefined, ...AGE_BUCKETS.map(() => 'right' as const), 'right', ...(cost ? ['right' as const] : []), 'right']}
                rows={type.articles.map((article) => ({
                  id: `${article.item.id}|${article.colour?.id ?? ''}`,
                  cells: [
                    articleLabel(article),
                    ...AGE_BUCKETS.map((bucket) => quantitiesText(article.buckets[bucket].quantities, unitWord, locale)),
                    quantitiesText(article.whole.quantities, unitWord, locale),
                    ...(cost ? [valueText(article.whole.value, article.currency, locale)] : []),
                    article.oldestDays === null ? '—' : t('ageing.days', { count: article.oldestDays }),
                  ],
                }))}
              />
              {type.more > 0 ? <p className="fw-wr-print-note">{t('ageing.more', { count: type.more })}</p> : null}
            </PrintSection>
          ))}
          <PrintSection title={t('print.leatherTitle', { from: day(leather!.from), to: day(leather!.to) })}>
            {!leather!.sight.stock ? (
              <p>{t('notInRole.stock')}</p>
            ) : leather!.articles.length === 0 ? (
              <p>{t('leather.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('leather.tableLabel')}
                  widths={['20%', '5%']}
                  columns={[t('leather.col.article'), t('leather.col.unit'), ...QUANTITY_COLUMNS.map((key) => t(`leather.col.${key}`)), t('leather.col.hidesOnHand'), ...(cost ? [t('leather.col.valueReceived'), t('leather.col.valueCut'), t('leather.col.valueEnd')] : [])]}
                  align={[undefined, undefined, ...QUANTITY_COLUMNS.map(() => 'right' as const), 'right', ...(cost ? (['right', 'right', 'right'] as const) : [])]}
                  rows={[
                    ...leather!.articles.flatMap((article) => [
                      { id: `a:${article.item.id}|${article.colour?.id ?? ''}`, cells: [<strong key="a">{articleLabel(article)}</strong>, ...quantityCells(article.figures), String(article.figures.hidesOnHand), ...values(article.figures)] },
                      ...article.lots.map((lot) => ({
                        id: `l:${article.item.id}|${article.colour?.id ?? ''}|${lot.lot?.id ?? ''}`,
                        cells: [lotLabel(lot, t('leather.noLot')), ...quantityCells(lot.figures), String(lot.figures.hidesOnHand), ...values(lot.figures)],
                      })),
                    ]),
                    { id: 'all', cells: [<strong key="t">{t('leather.all')}</strong>, ...quantityCells(leather!.all), String(leather!.all.hidesOnHand), ...values(leather!.all)] },
                  ]}
                />
                <p className="fw-wr-print-note">{t('leather.definition')}</p>
              </>
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
