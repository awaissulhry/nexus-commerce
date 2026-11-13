'use client'

import Link from 'next/link'
import { EmptyState, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { SegmentedControl, Select, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { HeatBand, UtilisationCell, UtilisationLane } from '../api'
import { AHEAD_CHOICES, capacityHref, chosenLane, laneKeyOf, laneLabel, pctText, pointOpens, utilisationChartRows, weekLabel } from '../model'
import { Head, NAMESPACE, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const BAND_TONE: Record<HeatBand, 'success' | 'info' | 'warning' | 'danger' | 'neutral'> = { LOW: 'neutral', MEDIUM: 'info', HIGH: 'warning', OVER: 'danger', UNKNOWN: 'neutral' }

/**
 * The utilisation trend (design sec utilisation, PLN-204: "Load and utilisation per line, plant and workshop over time"; "Lines
 * over weeks"): for the lane picked (the plant by default, in the address) the utilisation of the weeks that happened (earned ÷
 * the minutes its people were there, a line) and the plan's load of this week and the weeks ahead (booked ÷ capacity, bars, as
 * Capacity & load counts it); below, every lane by week — a line's, work centre's or the plant's point opens the work orders
 * behind it; a workshop's cells open on Capacity & load. No money, no person.
 */
export function UtilisationPanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.utilisation
  const answer = read.status === 'ready' ? read.value : null
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const period = answer ? { from: answer.from, to: answer.to } : model.range
  const label = (lane: UtilisationLane) => laneLabel(lane, { plant: t('utilisation.plant'), kind: (kind) => t(`utilisation.kind.${kind}`) })
  const lane = answer ? chosenLane(answer, model.address.lane) : null
  const head = (
    <Head id="plr-utilisation" title={t('section.utilisation')} hint={model.address.ahead === 0 ? t('utilisation.hintPast', { from: day(period.from), to: day(period.to) }) : t('utilisation.hint', { from: day(period.from), to: day(period.to), count: model.address.ahead })}>
      {answer && lane ? (
        <Select size="sm" value={laneKeyOf(lane)} aria-label={t('utilisation.lane')} onChange={(event) => actions?.onAddress?.({ lane: event.target.value })}>
          {answer.lanes.map((entry) => (
            <option key={`${laneKeyOf(entry)}`} value={laneKeyOf(entry)}>
              {`${t(`utilisation.laneKind.${entry.kind}`)}: ${label(entry)}`}
            </option>
          ))}
        </Select>
      ) : null}
      <SegmentedControl size="sm" wrap ariaLabel={t('utilisation.ahead')} value={String(model.address.ahead)} onChange={(value) => actions?.onAddress?.({ ahead: Number(value) })} options={AHEAD_CHOICES.map((value) => ({ value: String(value), label: value === 0 ? t('utilisation.aheadNone') : t('utilisation.aheadWeeks', { count: value }) }))} />
    </Head>
  )
  const waiting = stateOf(read, t('utilisation.failed'), () => actions?.onRetry?.('utilisation'), { axes: t('utilisation.axes') })
  if (waiting || !answer || !lane) {
    return (
      <section className="fw-plr-panel" aria-labelledby="plr-utilisation">
        {head}
        {waiting ?? (answer ? <EmptyState title={t('utilisation.empty')} description={t('utilisation.emptyHint')} /> : null)}
      </section>
    )
  }
  const anything = answer.lanes.some((entry) => entry.cells.some((cell) => (cell.earnedMinutes !== null && Number(cell.earnedMinutes) > 0) || (cell.booked !== null && Number(cell.booked) > 0)))
  if (!anything) {
    return (
      <section className="fw-plr-panel" aria-labelledby="plr-utilisation">
        {head}
        <EmptyState title={t('utilisation.empty')} description={t('utilisation.emptyHint')} />
      </section>
    )
  }
  const rows = utilisationChartRows(answer, lane)
  const highest = Math.max(100, ...rows.flatMap((row) => [Number(row.utilisation ?? 0), Number(row.load ?? 0)]))
  const top = Math.ceil(highest / 25) * 25
  const ticks = Array.from({ length: top / 25 + 1 }, (_, index) => index * 25)
  const opens = pointOpens(lane)
  const cellText = (entry: UtilisationLane, cell: UtilisationCell | undefined) => {
    if (!cell) return '—'
    const parts = [cell.utilisationPct !== null ? t('utilisation.used', { pct: pctText(cell.utilisationPct, locale) }) : null, cell.loadPct !== null ? t('utilisation.load', { pct: pctText(cell.loadPct, locale) }) : cell.booked !== null && cell.capacity === null && entry.kind === 'WORKSHOP' ? t('utilisation.noCapacity') : null].filter(Boolean)
    return parts.length > 0 ? parts.join(' · ') : '—'
  }
  const cellNode = (entry: UtilisationLane, week: (typeof answer.weeks)[number]) => {
    const cell = entry.cells.find((item) => item.key === week.key)
    const text = cellText(entry, cell)
    const tone = cell && cell.loadPct !== null ? BAND_TONE[cell.band] : null
    const body = (
      <>
        {text}
        {tone && cell && (cell.band === 'OVER' || cell.band === 'HIGH') ? (
          <>
            {' '}
            <Tag tone={tone}>{t(`utilisation.band.${cell.band}`)}</Tag>
          </>
        ) : null}
      </>
    )
    if (text === '—' || !pointOpens(entry)) return <span key={week.key}>{body}</span>
    return (
      <button key={week.key} type="button" className="fw-plr-cell-link" onClick={() => actions?.onDrill?.({ section: 'utilisation', laneKey: laneKeyOf(entry), week: week.key })} aria-label={t('utilisation.cellOpen', { lane: label(entry), week: weekLabel(week, locale) })}>
        {body}
      </button>
    )
  }
  const workshops = answer.lanes.some((entry) => entry.kind === 'WORKSHOP')
  return (
    <section className="fw-plr-panel" aria-labelledby="plr-utilisation">
      {head}
      <figure className="fw-plr-chart" aria-label={t('utilisation.chartLabel', { lane: label(lane) })}>
        <PerformanceGraph
          data={rows}
          xKey="week"
          left={{ key: 'utilisation', label: t('utilisation.series.used'), axisLabel: t('utilisation.axis.used'), color: chart.actual, axis: 'left', domain: [0, top], ticks, format: (value) => pctText(String(value), locale) }}
          right={{ key: 'load', label: t('utilisation.series.load'), axisLabel: t('utilisation.axis.load'), color: chart.reference, axis: 'right', shape: 'bar', domain: [0, top], ticks, format: (value) => pctText(String(value), locale) }}
          height={240}
        />
        <figcaption className="fw-plr-hint">{[t('utilisation.caption'), lane.plannedEfficiencyPct ? t('utilisation.yardstick', { pct: pctText(lane.plannedEfficiencyPct, locale) }) : null].filter(Boolean).join(' ')}</figcaption>
      </figure>
      <ul className="fw-plr-weeks" aria-label={t('utilisation.weeksLabel', { lane: label(lane) })}>
        {answer.weeks.map((week) => {
          const cell = lane.cells.find((item) => item.key === week.key)
          const text = cellText(lane, cell)
          const name = weekLabel(week, locale)
          return (
            <li key={week.key}>
              {opens && text !== '—' ? (
                <button type="button" className="fw-plr-week" onClick={() => actions?.onDrill?.({ section: 'utilisation', laneKey: laneKeyOf(lane), week: week.key })} aria-label={t('utilisation.weekOpen', { lane: label(lane), week: name })}>
                  <span className="fw-plr-week-label">{name}</span>
                  <span className="fw-plr-muted">{text}</span>
                </button>
              ) : (
                <span className="fw-plr-week fw-plr-week-quiet">
                  <span className="fw-plr-week-label">{name}</span>
                  <span className="fw-plr-muted">{text}</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {!opens ? (
        <p className="fw-plr-muted">
          {t('utilisation.workshopHeld')}{' '}
          {model.site ? (
            <Link className="fw-plr-link" href={capacityHref(model.prefix, model.site.id)}>
              {t('utilisation.openCapacity')}
            </Link>
          ) : null}
        </p>
      ) : null}
      <SummaryTable
        label={t('utilisation.tableLabel')}
        stackOnPhone
        widths={['20%']}
        columns={[t('utilisation.col.lane'), ...answer.weeks.map((week) => `${weekLabel(week, locale)}${week.ahead && !week.actual ? ` (${t('utilisation.col.ahead')})` : ''}`)]}
        rows={answer.lanes.map((entry) => ({
          id: laneKeyOf(entry),
          cells: [entry.kind === 'PLANT' ? <strong key="n">{label(entry)}</strong> : label(entry), ...answer.weeks.map((week) => cellNode(entry, week))],
        }))}
      />
      <p className="fw-plr-muted">{[t('utilisation.definition'), workshops ? t('utilisation.workshopPast') : null].filter(Boolean).join(' ')}</p>
    </section>
  )
}
