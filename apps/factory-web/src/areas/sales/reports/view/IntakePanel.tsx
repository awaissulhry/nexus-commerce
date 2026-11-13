'use client'

import { EmptyState, KeyValue, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Select } from '@nexus/ui/primitives'
import { chart, palette } from '@nexus/ui/tokens'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { INTAKE_BUCKETS, INTAKE_SPLITS, type Intake } from '../api'
import { bucketLabel, countText, groupName, intakeChartRows, intakeMeasure, OTHERS, pctText, stackParts, valueText } from '../model'
import { Head, NAMESPACE, Opens, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** The stacked groups' colours (the design's chart roles; Others in the reference grey). */
const STACK_COLOURS = [palette.blue[600], palette.green[600], palette.amber[600], palette.purple[600], palette.cyan[700]]

/**
 * Order intake (design sec intake, SAL-105: "Orders booked by period, customer, style, season"; "PerformanceGraph by week or
 * month; split by customer / style / season"; "Click a bar → Orders filtered to it"; empty "No orders in this period"): the
 * orders booked in the period — the value (price grain) or the pieces per week or month as bars, stacked by the split's largest
 * groups, the orders booked as a line; each bucket below the chart and each group of the table opens the orders behind it.
 */
export function IntakePanel({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.intake
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const head = (
    <Head id="slr-intake" title={t('section.intake')} hint={t('intake.hint', { from: day(model.range.from), to: day(model.range.to) })}>
      <Select size="sm" value={model.address.by} aria-label={t('intake.by')} onChange={(event) => actions?.onAddress?.({ by: event.target.value as Intake['by'] })}>
        {INTAKE_BUCKETS.map((by) => (
          <option key={by} value={by}>
            {t(`intake.byOption.${by}`)}
          </option>
        ))}
      </Select>
      <Select size="sm" value={model.address.split} aria-label={t('intake.split')} onChange={(event) => actions?.onAddress?.({ split: event.target.value as Intake['split'] })}>
        {INTAKE_SPLITS.map((split) => (
          <option key={split} value={split}>
            {t(`intake.splitOption.${split}`)}
          </option>
        ))}
      </Select>
    </Head>
  )
  const waiting = stateOf(read, t('intake.failed'), () => actions?.onRetry?.('intake'), { axes: t('intake.axes') })
  if (waiting || read.status !== 'ready') {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-intake">
        {head}
        {waiting}
      </section>
    )
  }
  const answer = read.value
  if (!answer.sight.orders) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-intake">
        {head}
        <EmptyState title={t('common.ordersOutside')} description={t('common.ordersOutsideBody')} />
      </section>
    )
  }
  if (answer.all.orders === 0) {
    return (
      <section className="fw-slr-panel" aria-labelledby="slr-intake">
        {head}
        <EmptyState title={t('intake.empty')} description={t('intake.emptyHint')} />
      </section>
    )
  }
  const price = answer.sight.values
  const measure = intakeMeasure(answer)
  const words = { none: t(`intake.none.${answer.split}`), fees: t('intake.fees') }
  const parts = stackParts(answer, (group) => groupName(group, words), t('intake.others'))
  const rows = intakeChartRows(answer, parts, measure, locale)
  const format = (value: number) => (measure === 'value' ? valueText({ byCurrency: [], value: Math.round(value * 100), currency: answer.all.currency, mixedCurrencies: false }, locale) : countText(value, locale))
  const share = (value: number | null | undefined) => (price && typeof value === 'number' && typeof answer.all.value === 'number' && answer.all.value > 0 ? pctText(((value / answer.all.value) * 100).toFixed(1), locale) : null)
  return (
    <section className="fw-slr-panel" aria-labelledby="slr-intake">
      {head}
      <KeyValue
        columns={price ? 3 : 2}
        items={[
          { label: t('intake.kv.orders'), value: countText(answer.all.orders, locale), hint: t('intake.kv.ordersHint') },
          { label: t('intake.kv.pieces'), value: countText(answer.all.pieces, locale), hint: t('intake.kv.piecesHint') },
          ...(price ? [{ label: t('intake.kv.value'), value: valueText(answer.all, locale), hint: answer.all.mixedCurrencies ? t('common.mixed') : t('intake.kv.valueHint') }] : []),
        ]}
      />
      <figure className="fw-slr-chart" aria-label={t('intake.chartLabel', { measure: t(`intake.measure.${measure}`) })}>
        <PerformanceGraph
          data={rows}
          xKey="bucket"
          left={{
            key: 'total',
            label: t(`intake.measure.${measure}`),
            axisLabel: measure === 'value' ? t('intake.axis.value', { currency: answer.all.currency ?? '' }) : t('intake.axis.pieces'),
            color: chart.actual,
            axis: 'left',
            shape: 'bar',
            format,
            ...(parts.length > 0 ? { stack: parts.map((part, index) => ({ key: part.key, label: part.label, color: part.key === OTHERS ? chart.reference : STACK_COLOURS[index % STACK_COLOURS.length]! })) } : {}),
          }}
          right={{ key: 'orders', label: t('intake.series.orders'), axisLabel: t('intake.axis.orders'), color: chart.reference, axis: 'right', format: (value) => countText(value, locale) }}
          height={240}
        />
        <figcaption className="fw-slr-hint">{t(measure === 'value' ? 'intake.captionValue' : 'intake.captionPieces')}</figcaption>
      </figure>
      <ul className="fw-slr-buckets" aria-label={t('intake.bucketsLabel')}>
        {answer.buckets.map((bucket) => {
          const label = bucketLabel(bucket, locale)
          const text = `${t('intake.bucketOrders', { count: bucket.figures.orders })} · ${price && measure === 'value' ? valueText(bucket.figures, locale) : t('common.pieces', { count: bucket.figures.pieces })}`
          return (
            <li key={bucket.key}>
              {bucket.figures.orders > 0 ? (
                <button type="button" className="fw-slr-bucket" onClick={() => actions?.onDrill?.({ section: 'intake', bucket: bucket.key, group: null })} aria-label={t('intake.bucketOpen', { bucket: label })}>
                  <span className="fw-slr-bucket-label">{label}</span>
                  <span className="fw-slr-muted">{text}</span>
                </button>
              ) : (
                <span className="fw-slr-bucket fw-slr-bucket-quiet">
                  <span className="fw-slr-bucket-label">{label}</span>
                  <span className="fw-slr-muted">{t('intake.bucketNone')}</span>
                </span>
              )}
            </li>
          )
        })}
      </ul>
      {answer.split !== 'none' ? (
        <SummaryTable
          label={t('intake.tableLabel', { split: t(`intake.splitOption.${answer.split}`) })}
          stackOnPhone
          widths={['36%']}
          columns={[t(`intake.col.${answer.split}`), t('intake.col.orders'), t('intake.col.pieces'), ...(price ? [t('intake.col.value'), t('intake.col.share')] : [])]}
          rows={answer.groups.map((group) => {
            const name = groupName(group, words)
            return {
              id: group.key,
              cells: [
                <Opens key="n" label={t('intake.groupOpen', { name })} onOpen={() => actions?.onDrill?.({ section: 'intake', bucket: null, group: group.key })}>
                  {name}
                </Opens>,
                countText(group.figures.orders, locale),
                countText(group.figures.pieces, locale),
                ...(price ? [valueText(group.figures, locale), share(group.figures.value) ?? '—'] : []),
              ],
            }
          })}
        />
      ) : null}
      <p className="fw-slr-muted">{[t('intake.definition'), answer.split === 'style' ? t('intake.styleNote') : null, answer.more > 0 ? t('common.moreGroups', { count: answer.more }) : null, price ? null : t('common.noPrice'), answer.complete ? null : t('common.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
