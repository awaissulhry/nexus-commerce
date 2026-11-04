'use client'

import { Banner, EmptyState, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { KPI_KEYS, type Compare, type Incoming, type Kpis, type Trend } from '../../api'
import { changeWords, countText, daysIn, kpiValueText, oneText, pctText, refLabel, weekLabel, type ReportsAddress } from '../../model'
import '../../reports.css'

/** SCR-147-print — the quality report on paper or as a PDF (design tab:qr-pdf): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  site: string | null
  noSite: boolean
  can: boolean
  address: ReportsAddress
  /** The trend's line, by name (the filter written at the top). */
  lineName: string | null
  kpis: Kpis | null
  trend: Trend | null
  compare: Compare | null
  incoming: Incoming | null
  /** A message key (namespace quality) of the first part that failed. */
  problem: string | null
}

/**
 * The monthly report to print or send (design "filters written at the top"): the period, the previous period, the site, the
 * trend's line and the comparison's dimension on top; then the headline numbers with the previous period, the trend per week,
 * the comparison, incoming quality per supplier. Groups only, never a person; a hidden group prints "too few people", with no
 * figure to subtract.
 */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['quality-reports', 'quality']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('quality-reports')
  const quality = useT('quality')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const { kpis, trend, compare, incoming } = model
  const ready = !!kpis && !!trend && !!compare && !!incoming
  const filters = kpis
    ? [
        { label: t('print.period'), value: `${day(kpis.from)} – ${day(kpis.to)}` },
        ...(kpis.previous ? [{ label: t('print.previous'), value: `${day(kpis.previous.from)} – ${day(kpis.previous.to)}` }] : []),
        { label: t('print.site'), value: `${kpis.site.code} · ${kpis.site.name}` },
        { label: t('print.line'), value: model.lineName ?? t('trend.allLines') },
        { label: t('print.by'), value: t(`dimension.${model.address.by}`) },
      ]
    : []
  const days = kpis ? daysIn({ from: kpis.from, to: kpis.to }) : 0
  return (
    <PrintView
      title={t('print.title')}
      meta={[model.company, ...(model.site ? [model.site] : [])]}
      printedAt={formatDateTime(model.at, { locale })}
      printedBy={model.person}
      filters={filters}
      printHeld={ready ? null : t('print.held')}
      labels={ds.printView}
    >
      {!model.can ? (
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      ) : model.noSite ? (
        <EmptyState title={t('noSite.title')} description={t('noSite.body')} />
      ) : model.problem ? (
        <Banner tone="danger" title={t('print.failed')}>
          {quality(model.problem)}
        </Banner>
      ) : !ready ? (
        <p className="fw-qr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <p className="fw-qr-print-note">{t('print.privacy')}</p>
          <PrintSection title={t('section.kpi')}>
            <SummaryTable
              label={t('section.kpi')}
              columns={[t('print.figure'), t('print.now'), t('print.before'), t('print.change')]}
              align={[undefined, 'right', 'right', undefined]}
              rows={KPI_KEYS.filter((kpi) => kpis!.kpis[kpi] !== null).map((kpi) => {
                const entry = kpis!.kpis[kpi]!
                const before = entry.previous ? ('tooFew' in entry.previous ? (entry.previous.tooFew ? t('tooFewShort') : kpi === 'dhu' ? oneText(entry.previous.value, locale) : pctText(entry.previous.value, locale)) : countText(entry.previous.value, locale)) : '—'
                const change = changeWords(kpi, entry.change, days, locale)
                const now = 'tooFew' in entry && entry.tooFew ? t('tooFewShort') : kpiValueText(kpi, kpis!.kpis, locale)
                return { id: kpi, cells: [t(`kpi.${kpi}`), now, before, change ? `${change.arrow} ${t(change.key, change.params)}` : '—'] }
              })}
            />
            {kpis!.amendments && kpis!.amendments.signed > 0 ? <p className="fw-qr-hint">{t('kpi.amendments', { count: kpis!.amendments.signed })}</p> : null}
          </PrintSection>
          <PrintSection title={t('section.trend')}>
            <SummaryTable
              label={t('trend.chartLabel')}
              columns={[t('csv.week'), t('kpi.fpy'), t('kpi.dhu'), t('trend.pieces'), t('kpi.aqlPass'), t('trend.capaClosed')]}
              align={[undefined, 'right', 'right', 'right', 'right', undefined]}
              rows={trend!.weeks.map((week) => ({
                id: week.week,
                cells: [
                  `${weekLabel(week.week)} · ${day(week.from)} – ${day(week.to)}`,
                  week.tooFew ? t('tooFewShort') : pctText(week.fpy, locale),
                  week.tooFew ? '—' : oneText(week.dhu, locale),
                  week.tooFew ? '—' : countText(week.pieces, locale),
                  week.aql ? t('trend.aql', { pct: pctText(week.aql.pct, locale), passed: week.aql.passed, decided: week.aql.decided }) : week.aqlTooFew ? t('tooFewShort') : '—',
                  week.capaClosed && week.capaClosed.count > 0 ? week.capaClosed.capas.map((capa) => capa.number).join(', ') : '—',
                ],
              }))}
            />
          </PrintSection>
          <PrintSection title={`${t('section.table')} · ${t(`dimension.${compare!.by}`)}`}>
            {compare!.rows.length === 0 ? (
              <p>{t('table.empty')}</p>
            ) : (
              <SummaryTable
                label={t('table.tableLabel', { by: t(`dimension.${compare!.by}`) })}
                columns={[t(`dimension.${compare!.by}`), t('table.inspected'), t('table.defects'), t('table.dhu'), t('table.aql'), t('table.ncrs')]}
                align={[undefined, 'right', 'right', 'right', 'right', 'right']}
                rows={compare!.rows.map((row) => ({
                  id: row.key,
                  cells: row.tooFew
                    ? [refLabel(row.ref) ?? t(`table.none.${compare!.by}`), t('tooFewShort'), '—', '—', '—', '—']
                    : [refLabel(row.ref) ?? t(`table.none.${compare!.by}`), countText(row.inspected, locale), countText(row.defects, locale), oneText(row.dhu, locale), row.aql && row.aql.decided > 0 ? pctText(row.aql.pct, locale) : '—', countText(row.ncrs, locale)],
                }))}
              />
            )}
            <p className="fw-qr-hint">{t(`table.source.${compare!.by}`)}</p>
          </PrintSection>
          <PrintSection title={t('section.supplier')}>
            {incoming!.suppliers.length === 0 ? (
              <p>{t('incoming.empty')}</p>
            ) : (
              <SummaryTable
                label={t('incoming.tableLabel')}
                columns={[t('incoming.supplier'), t('incoming.lots'), t('incoming.rejected'), t('incoming.crVi'), t('incoming.days'), t('incoming.inspections'), t('incoming.failedInspections')]}
                align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right']}
                rows={incoming!.suppliers.map((row) => ({
                  id: row.party?.id ?? 'none',
                  cells: [row.party ? `${row.party.code} · ${row.party.name}` : t('incoming.noSupplier'), countText(row.lotsReceived, locale), countText(row.rejected, locale), countText(row.crViFails, locale), oneText(row.averageQuarantineDays, locale), countText(row.inspections, locale), countText(row.inspectionsFailed, locale)],
                }))}
              />
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
