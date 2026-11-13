'use client'

import { EmptyState, KeyValue, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Select, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { BACKLOG_GROUPS, BACKLOG_HORIZONS, type BacklogGroup } from '../api'
import { backlogChartRows, backlogWeekLabel, countText, hasValue, valueText } from '../model'
import { Head, NAMESPACE, Opens, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/**
 * Backlog by promise week (design sec backlog, SAL-106: "Confirmed, not shipped"; "Bars per promise week, late weeks toned";
 * "Table by customer and style"; "Click → Orders 'By week' view"): every open size of the open orders at its promise now — the
 * pieces per ISO week as bars (late pieces in the danger tone, the rest due), the open value (price grain) or the orders as a
 * line; each week below the chart and each cell of the table (late, this week, the next 4 weeks, later, no promise) opens the
 * open sizes behind it. Now, not a period.
 */
export function BacklogPanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.backlog
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const head = (
    <Head id="slr-backlog" title={t('section.backlog')} hint={t('backlog.hint', { today: day(read.status === 'ready' ? read.value.today : model.today) })}>
      <Select size="sm" value={model.address.backlog} aria-label={t('backlog.by')} onChange={(event) => actions?.onAddress?.({ backlog: event.target.value as BacklogGroup })}>
        {BACKLOG_GROUPS.map((by) => (
          <option key={by} value={by}>
            {t(`backlog.byOption.${by}`)}
          </option>
        ))}
      </Select>
    </Head>
  )
  const waiting = stateOf(read, t('backlog.failed'), () => actions?.onRetry?.('backlog'), { axes: t('backlog.axes') })
  if (waiting || read.status !== 'ready') {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-backlog">
        {head}
        {waiting}
      </section>
    )
  }
  const answer = read.value
  if (!answer.sight.orders) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-backlog">
        {head}
        <EmptyState title={t('common.ordersOutside')} description={t('common.ordersOutsideBody')} />
      </section>
    )
  }
  if (answer.all.pieces === 0) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-backlog">
        {head}
        <EmptyState title={t('backlog.empty')} description={t('backlog.emptyHint')} />
      </section>
    )
  }
  const price = answer.sight.values
  const withValue = price && hasValue(answer.all)
  const short = { earlier: t('backlog.earlierShort'), later: t('backlog.laterShort'), none: t('backlog.noneShort') }
  const long = { earlier: (to: string) => t('backlog.earlier', { day: day(to) }), later: (from: string) => t('backlog.later', { day: day(from) }), none: t('backlog.none') }
  const rows = backlogChartRows(answer, short)
  return (
    <section className="fw-slr-panel" aria-labelledby="slr-backlog">
      {head}
      <KeyValue
        columns={price ? 2 : 3}
        items={[
          { label: t('backlog.kv.pieces'), value: countText(answer.all.pieces, locale), hint: t('backlog.kv.piecesHint', { orders: answer.all.orders, lines: answer.all.lines }) },
          { label: t('backlog.kv.late'), value: countText(answer.all.late, locale), hint: answer.all.late > 0 ? t('backlog.kv.lateHint') : t('backlog.kv.noneLate') },
          { label: t('backlog.kv.weeks'), value: countText(answer.weeks.filter((week) => week.kind === 'WEEK' && week.figures.pieces > 0).length, locale), hint: t('backlog.kv.weeksHint') },
          ...(price ? [{ label: t('backlog.kv.value'), value: valueText(answer.all, locale), hint: answer.all.mixedCurrencies ? t('common.mixed') : t('backlog.kv.valueHint') }] : []),
        ]}
      />
      <figure className="fw-slr-chart" aria-label={t('backlog.chartLabel')}>
        <PerformanceGraph
          data={rows}
          xKey="week"
          left={{
            key: 'pieces',
            label: t('backlog.series.pieces'),
            axisLabel: t('backlog.axis.pieces'),
            color: chart.actual,
            axis: 'left',
            shape: 'bar',
            format: (value) => countText(value, locale),
            stack: [
              { key: 'late', label: t('backlog.series.late'), color: chart.negative },
              { key: 'due', label: t('backlog.series.due'), color: chart.actual },
            ],
          }}
          right={
            withValue
              ? { key: 'value', label: t('backlog.series.value'), axisLabel: t('backlog.axis.value', { currency: answer.all.currency ?? '' }), color: chart.reference, axis: 'right', format: (value) => valueText({ byCurrency: [], value: Math.round(value * 100), currency: answer.all.currency, mixedCurrencies: false }, locale) }
              : { key: 'orders', label: t('backlog.series.orders'), axisLabel: t('backlog.axis.orders'), color: chart.reference, axis: 'right', format: (value) => countText(value, locale) }
          }
          height={240}
        />
        <figcaption className="fw-slr-hint">{t('backlog.caption')}</figcaption>
      </figure>
      <ul className="fw-slr-buckets" aria-label={t('backlog.weeksLabel')}>
        {answer.weeks.map((week) => {
          const label = backlogWeekLabel(week, locale, long)
          return (
            <li key={week.key}>
              {week.figures.pieces > 0 ? (
                <button type="button" className={`fw-slr-bucket${week.figures.late > 0 ? ' fw-slr-bucket-late' : ''}`} onClick={() => actions?.onDrill?.({ section: 'backlog', week: week.key, group: null, horizon: null })} aria-label={t('backlog.weekOpen', { week: label })}>
                  <span className="fw-slr-bucket-label">
                    {label} {week.current ? <Tag tone="info">{t('backlog.thisWeek')}</Tag> : null}
                    {week.figures.late > 0 ? <Tag tone="danger">{t('backlog.lateTag')}</Tag> : null}
                  </span>
                  <span className="fw-slr-muted">{`${t('common.pieces', { count: week.figures.pieces })}${week.figures.late > 0 && week.figures.late < week.figures.pieces ? ` · ${t('backlog.ofThemLate', { count: week.figures.late })}` : ''}${withValue ? ` · ${valueText(week.figures, locale)}` : ''}`}</span>
                </button>
              ) : (
                <span className="fw-slr-bucket fw-slr-bucket-quiet">
                  <span className="fw-slr-bucket-label">
                    {label} {week.current ? <Tag tone="info">{t('backlog.thisWeek')}</Tag> : null}
                  </span>
                  <span className="fw-slr-muted">{t('backlog.weekNone')}</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      <SummaryTable
        label={t('backlog.tableLabel', { by: t(`backlog.byOption.${answer.by}`) })}
        stackOnPhone
        widths={['28%']}
        columns={[t(`backlog.col.${answer.by}`), ...BACKLOG_HORIZONS.map((horizon) => t(`backlog.horizon.${horizon}`)), t('backlog.col.total'), ...(price ? [t('backlog.col.value')] : [])]}
        rows={answer.groups.map((group) => {
          const name = [group.code, group.name].filter(Boolean).join(' · ')
          return {
            id: group.key,
            cells: [
              <Opens key="n" label={t('backlog.groupOpen', { name })} onOpen={() => actions?.onDrill?.({ section: 'backlog', week: null, group: group.key, horizon: null })}>
                {name}
              </Opens>,
              ...BACKLOG_HORIZONS.map((horizon) =>
                group.horizons[horizon] > 0 ? (
                  <Opens key={horizon} label={t('backlog.cellOpen', { name, horizon: t(`backlog.horizon.${horizon}`) })} onOpen={() => actions?.onDrill?.({ section: 'backlog', week: null, group: group.key, horizon })}>
                    <span className={horizon === 'late' ? 'fw-slr-late' : undefined}>{countText(group.horizons[horizon], locale)}</span>
                  </Opens>
                ) : (
                  <span key={horizon} className="fw-slr-muted">
                    —
                  </span>
                ),
              ),
              countText(group.figures.pieces, locale),
              ...(price ? [valueText(group.figures, locale)] : []),
            ],
          }
        })}
      />
      <p className="fw-slr-muted">{[t('backlog.definition'), answer.more > 0 ? t('common.moreGroups', { count: answer.more }) : null, price ? null : t('common.noPrice'), answer.complete ? null : t('common.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
