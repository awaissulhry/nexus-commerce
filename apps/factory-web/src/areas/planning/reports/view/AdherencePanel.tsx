'use client'

import { EmptyState, KeyValue, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Adherence, AdherenceFigures } from '../api'
import { adherenceChartRows, cellWords, figuresOf, pctText, signedDays, weekLabel } from '../model'
import { Head, NAMESPACE, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** A line's key in the chart picker and the drill ('none': the work orders on no line). */
const lineKeyOf = (line: Adherence['lines'][number]['line']): string => line?.id ?? 'none'

/**
 * Schedule adherence (design sec adherence, PLN-202: "Planned vs actual start and finish per line and week"; "PerformanceGraph %
 * on time per week; table below"; "Bar → work orders"): the finished work orders of the period against the plan the floor had
 * when each started — the % on time per week (a line) over the work orders finished (bars), for every line or the one picked;
 * each week below the chart and each cell of the table (lines × weeks) opens the work orders behind it. No money.
 */
export function AdherencePanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.adherence
  const answer = read.status === 'ready' ? read.value : null
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const period = answer ? { from: answer.from, to: answer.to } : model.range
  const lineName = (line: Adherence['lines'][number]['line']) => (line ? `${line.code} · ${line.name}` : t('adherence.noLine'))
  const head = (
    <Head id="plr-adherence" title={t('section.adherence')} hint={t('adherence.hint', { from: day(period.from), to: day(period.to) })}>
      {answer && answer.lines.length > 0 ? (
        <Select size="sm" value={model.adherenceLine ?? 'ALL'} aria-label={t('adherence.line')} onChange={(event) => actions?.onAdherenceLine?.(event.target.value === 'ALL' ? null : event.target.value)}>
          <option value="ALL">{t('adherence.allLines')}</option>
          {answer.lines.map((line) => (
            <option key={lineKeyOf(line.line)} value={lineKeyOf(line.line)}>
              {lineName(line.line)}
            </option>
          ))}
        </Select>
      ) : null}
    </Head>
  )
  const waiting = stateOf(read, t('adherence.failed'), () => actions?.onRetry?.('adherence'), { axes: t('adherence.axes') })
  if (waiting || !answer) {
    return (
      <section className="fw-plr-panel" aria-labelledby="plr-adherence">
        {head}
        {waiting}
      </section>
    )
  }
  if (answer.all.finished === 0) {
    return (
      <section className="fw-plr-panel" aria-labelledby="plr-adherence">
        {head}
        <EmptyState title={t('adherence.empty')} description={t('adherence.emptyHint')} />
      </section>
    )
  }
  const lineKey = model.adherenceLine && answer.lines.some((line) => lineKeyOf(line.line) === model.adherenceLine) ? model.adherenceLine : null
  const shown = figuresOf(answer, lineKey, null) ?? answer.all
  const rows = adherenceChartRows(answer, lineKey)
  const words = { cell: (onTime: number, planned: number) => t('adherence.cell', { onTime, planned }), none: '—', unplanned: (count: number) => t('adherence.cellUnplanned', { count }) }
  const cellButton = (key: string, label: string, figures: AdherenceFigures | null, target: { lineKey: string | null; week: string | null }) =>
    figures && figures.finished > 0 ? (
      <button key={key} type="button" className="fw-plr-cell-link" onClick={() => actions?.onDrill?.({ section: 'adherence', ...target })} aria-label={label}>
        {cellWords(figures, words)}
        {figures.onTimePct ? <span className="fw-plr-muted"> · {pctText(figures.onTimePct, locale)}</span> : null}
      </button>
    ) : (
      <span key={key} className="fw-plr-muted">
        —
      </span>
    )
  return (
    <section className="fw-plr-panel" aria-labelledby="plr-adherence">
      {head}
      <KeyValue
        columns={2}
        items={[
          { label: t('adherence.kv.onTime'), value: pctText(shown.onTimePct, locale), hint: t('adherence.kv.onTimeHint', { onTime: shown.onTime, planned: shown.planned }) },
          { label: t('adherence.kv.finished'), value: String(shown.finished), hint: shown.notPlanned > 0 ? t('adherence.kv.notPlanned', { count: shown.notPlanned }) : t('adherence.kv.allPlanned') },
          { label: t('adherence.kv.late'), value: String(shown.late), hint: t('adherence.kv.meanFinish', { days: signedDays(shown.meanFinishDays, locale) }) },
          { label: t('adherence.kv.startedLate'), value: String(shown.startedLate), hint: t('adherence.kv.meanStart', { days: signedDays(shown.meanStartDays, locale) }) },
        ]}
      />
      <figure className="fw-plr-chart" aria-label={t('adherence.chartLabel', { line: lineKey ? lineName(answer.lines.find((line) => lineKeyOf(line.line) === lineKey)!.line) : t('adherence.allLines') })}>
        <PerformanceGraph
          data={rows}
          xKey="week"
          left={{ key: 'onTime', label: t('adherence.series.onTime'), axisLabel: t('adherence.axis.onTime'), color: chart.positive, axis: 'left', domain: [0, 100], ticks: [0, 25, 50, 75, 100], format: (value) => pctText(String(value), locale) }}
          right={{ key: 'finished', label: t('adherence.series.finished'), axisLabel: t('adherence.axis.finished'), color: chart.reference, axis: 'right', shape: 'bar', format: (value) => String(value) }}
          height={240}
        />
        <figcaption className="fw-plr-hint">{t('adherence.caption')}</figcaption>
      </figure>
      <ul className="fw-plr-weeks" aria-label={t('adherence.weeksLabel')}>
        {answer.weeks.map((week) => {
          const figures = figuresOf(answer, lineKey, week.key)
          const label = weekLabel(week, locale)
          return (
            <li key={week.key}>
              {figures && figures.finished > 0 ? (
                <button type="button" className="fw-plr-week" onClick={() => actions?.onDrill?.({ section: 'adherence', lineKey, week: week.key })} aria-label={t('adherence.weekOpen', { week: label })}>
                  <span className="fw-plr-week-label">{label}</span>
                  <span className="fw-plr-muted">{`${cellWords(figures, words)}${figures.onTimePct ? ` · ${pctText(figures.onTimePct, locale)}` : ''}`}</span>
                </button>
              ) : (
                <span className="fw-plr-week fw-plr-week-quiet">
                  <span className="fw-plr-week-label">{label}</span>
                  <span className="fw-plr-muted">{t('adherence.weekNone')}</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <SummaryTable
        label={t('adherence.tableLabel')}
        stackOnPhone
        widths={['20%']}
        columns={[t('adherence.col.line'), ...answer.weeks.map((week) => weekLabel(week, locale)), t('adherence.col.period')]}
        rows={[
          ...answer.lines.map((line) => ({
            id: lineKeyOf(line.line),
            cells: [
              lineName(line.line),
              ...answer.weeks.map((week) => cellButton(week.key, t('adherence.cellOpen', { line: lineName(line.line), week: weekLabel(week, locale) }), line.weeks.find((entry) => entry.key === week.key)?.figures ?? null, { lineKey: lineKeyOf(line.line), week: week.key })),
              cellButton('period', t('adherence.cellOpen', { line: lineName(line.line), week: t('adherence.col.period') }), line.figures, { lineKey: lineKeyOf(line.line), week: null }),
            ],
          })),
          {
            id: 'all',
            cells: [
              <strong key="t">{t('adherence.all')}</strong>,
              ...answer.weeks.map((week) => cellButton(week.key, t('adherence.cellOpen', { line: t('adherence.all'), week: weekLabel(week, locale) }), week.figures, { lineKey: null, week: week.key })),
              cellButton('period', t('adherence.cellOpen', { line: t('adherence.all'), week: t('adherence.col.period') }), answer.all, { lineKey: null, week: null }),
            ],
          },
        ]}
      />
      <p className="fw-plr-muted">{[t('adherence.definition'), answer.complete ? null : t('adherence.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
