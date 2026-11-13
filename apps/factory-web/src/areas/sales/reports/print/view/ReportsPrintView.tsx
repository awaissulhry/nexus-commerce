'use client'

import { Banner, EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { PrintSection, PrintView } from '@nexus/ui/patterns/print-view/index'
import { Spinner } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate, formatDateTime } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { BACKLOG_HORIZONS, type Backlog, type Headline, type Intake, type Returns } from '../../api'
import { backlogWeekLabel, bucketLabel, countText, groupName, pctText, reasonWords, valueText, workingTime, type ReportsCan } from '../../model'
import '../../reports.css'

/** The styles printed by the returns (the most returned first). */
export const PRINT_GROUPS = 30

/** SCR-427 — Sales reports on paper or as a PDF (design tab:print): one view model, nothing fetched. */
export interface ReportsPrintModel {
  person: string
  at: string
  company: string
  can: ReportsCan
  range: { from: string; to: string }
  /** The report's page (the strip's way back). */
  back: string
  headline: Headline | null
  intake: Intake | null
  backlog: Backlog | null
  returns: Returns | null
  /** A message key (sales-reports) of the part that failed. */
  problem: string | null
}

/**
 * The monthly sales review on paper (design tab:print, "Print stylesheet of the current view with filters written at the top"):
 * the company, the period, the intake's buckets and split, the backlog's rows and the day it was printed on top; then the five
 * numbers, the order intake (each bucket, each group of the split), the backlog by promise week (each week, each customer or
 * style by horizon) and the return reasons (each reason, the most returned styles by size). Amounts only with the price grain.
 */
export function ReportsPrintView({ model }: { model: ReportsPrintModel }) {
  return (
    <WithMessages namespaces={['sales-reports']}>
      <Print model={model} />
    </WithMessages>
  )
}

function Print({ model }: { model: ReportsPrintModel }) {
  const t = useT('sales-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const day = (date: string | null) => (date ? formatDate(`${date}T12:00:00Z`, { locale }) : '—')
  const { headline, intake, backlog, returns } = model
  const ready = !!headline && !!intake && !!backlog && !!returns
  const filters = [
    { label: t('print.period'), value: `${day(model.range.from)} – ${day(model.range.to)}` },
    ...(intake ? [{ label: t('print.intake'), value: `${t(`intake.byOption.${intake.by}`)} · ${t(`intake.splitOption.${intake.split}`)}` }] : []),
    ...(backlog ? [{ label: t('print.backlog'), value: `${t(`backlog.byOption.${backlog.by}`)} · ${t('print.backlogOn', { day: day(backlog.today) })}` }] : []),
  ]
  const price = !!headline?.sight.values
  const pieces = (count: number) => t('common.pieces', { count })
  const long = { earlier: (to: string) => t('backlog.earlier', { day: day(to) }), later: (from: string) => t('backlog.later', { day: day(from) }), none: t('backlog.none') }
  const time = workingTime(headline?.quotes?.medianAnswerMinutes ?? null, locale)
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
        <p className="fw-slr-hint" role="status">
          <Spinner size={14} /> {t('common.loading')}
        </p>
      ) : (
        <>
          <PrintSection title={t('section.strip')}>
            <KeyValue
              columns={3}
              items={[
                { label: t('strip.intake'), value: headline!.intake ? (price ? valueText(headline!.intake, locale) : pieces(headline!.intake.pieces)) : t('strip.notInRole'), hint: headline!.intake ? t('strip.intakeHint', { orders: countText(headline!.intake.orders, locale), pieces: countText(headline!.intake.pieces, locale) }) : undefined },
                { label: t('strip.backlog'), value: headline!.backlog ? (price ? valueText(headline!.backlog, locale) : pieces(headline!.backlog.pieces)) : t('strip.notInRole'), hint: headline!.backlog ? t('strip.backlogHint', { pieces: countText(headline!.backlog.pieces, locale), late: countText(headline!.backlog.late, locale) }) : undefined },
                { label: t('strip.winRate'), value: headline!.quotes ? pctText(headline!.quotes.winRatePct, locale) : t('strip.notInRole') },
                { label: t('strip.speed'), value: headline!.quotes ? (time ? t(`time.${time.unit}`, { value: time.value }) : '—') : t('strip.notInRole') },
                { label: t('strip.returnRate'), value: headline!.returns ? pctText(headline!.returns.returnRatePct, locale) : t('strip.notInRole') },
              ]}
            />
            <p className="fw-slr-print-note">{t('strip.definition')}</p>
          </PrintSection>
          <PrintSection title={t('section.intake')}>
            {intake!.all.orders === 0 ? (
              <p>{t('intake.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('intake.bucketsLabel')}
                  widths={['30%']}
                  columns={[t(`intake.byOption.${intake!.by}`), t('intake.col.orders'), t('intake.col.pieces'), ...(price ? [t('intake.col.value')] : [])]}
                  rows={[
                    ...intake!.buckets.map((bucket) => ({ id: bucket.key, cells: [bucketLabel(bucket, locale), countText(bucket.figures.orders, locale), countText(bucket.figures.pieces, locale), ...(price ? [valueText(bucket.figures, locale)] : [])] })),
                    { id: 'all', cells: [<strong key="a">{t('print.total')}</strong>, countText(intake!.all.orders, locale), countText(intake!.all.pieces, locale), ...(price ? [valueText(intake!.all, locale)] : [])] },
                  ]}
                />
                {intake!.split !== 'none' ? (
                  <SummaryTable
                    label={t('intake.tableLabel', { split: t(`intake.splitOption.${intake!.split}`) })}
                    widths={['40%']}
                    columns={[t(`intake.col.${intake!.split}`), t('intake.col.orders'), t('intake.col.pieces'), ...(price ? [t('intake.col.value')] : [])]}
                    rows={intake!.groups.map((group) => ({ id: group.key, cells: [groupName(group, { none: t(`intake.none.${intake!.split}`), fees: t('intake.fees') }), countText(group.figures.orders, locale), countText(group.figures.pieces, locale), ...(price ? [valueText(group.figures, locale)] : [])] }))}
                  />
                ) : null}
                <p className="fw-slr-print-note">{t('intake.definition')}</p>
              </>
            )}
          </PrintSection>
          <PrintSection title={t('section.backlog')}>
            {backlog!.all.pieces === 0 ? (
              <p>{t('backlog.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('backlog.weeksLabel')}
                  widths={['34%']}
                  columns={[t('backlog.col.week'), t('backlog.series.pieces'), t('backlog.series.late'), ...(price ? [t('backlog.col.value')] : [])]}
                  rows={backlog!.weeks.map((week) => ({ id: week.key, cells: [backlogWeekLabel(week, locale, long), countText(week.figures.pieces, locale), countText(week.figures.late, locale), ...(price ? [valueText(week.figures, locale)] : [])] }))}
                />
                <SummaryTable
                  label={t('backlog.tableLabel', { by: t(`backlog.byOption.${backlog!.by}`) })}
                  widths={['28%']}
                  columns={[t(`backlog.col.${backlog!.by}`), ...BACKLOG_HORIZONS.map((horizon) => t(`backlog.horizon.${horizon}`)), t('backlog.col.total'), ...(price ? [t('backlog.col.value')] : [])]}
                  rows={backlog!.groups.map((group) => ({ id: group.key, cells: [[group.code, group.name].filter(Boolean).join(' · '), ...BACKLOG_HORIZONS.map((horizon) => countText(group.horizons[horizon], locale)), countText(group.figures.pieces, locale), ...(price ? [valueText(group.figures, locale)] : [])] }))}
                />
                <p className="fw-slr-print-note">{t('backlog.definition')}</p>
              </>
            )}
          </PrintSection>
          <PrintSection title={t('section.returns')}>
            {returns!.all.pieces === 0 ? (
              <p>{t('returns.empty')}</p>
            ) : (
              <>
                <SummaryTable
                  label={t('returns.byReason')}
                  widths={['40%']}
                  columns={[t('drill.col.reason'), t('drill.col.pieces'), t('returns.col.returns'), ...(price ? [t('drill.col.credited')] : [])]}
                  rows={returns!.reasons.map((reason) => ({ id: reason.key, cells: [reasonWords(reason, locale), countText(reason.figures.pieces, locale), countText(reason.figures.returns, locale), ...(price ? [valueText(reason.figures, locale)] : [])] }))}
                />
                {returns!.heatmap.styles.length > 0 ? (
                  <SummaryTable
                    label={t('returns.heatTitle')}
                    widths={['30%']}
                    columns={[t('drill.col.style'), ...returns!.heatmap.sizes.map((size) => (size === 'none' ? t('returns.noSize') : size))]}
                    rows={returns!.heatmap.styles.slice(0, PRINT_GROUPS).map((style, row) => ({ id: style.key, cells: [`${style.code} · ${style.name}`, ...returns!.heatmap.cells[row]!.map((value) => (value === null ? '—' : countText(value, locale)))] }))}
                  />
                ) : null}
                <p className="fw-slr-print-note">{[t('returns.printRate', { rate: pctText(returns!.returnRatePct, locale), shipped: returns!.shipped === null ? '—' : countText(returns!.shipped, locale) }), t('returns.definition'), t('returns.noGroups')].join(' ')}</p>
              </>
            )}
          </PrintSection>
        </>
      )}
    </PrintView>
  )
}
