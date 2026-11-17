'use client'

import Link from 'next/link'
import { EmptyState, MetricStrip, SummaryTable, type Metric } from '@nexus/ui/components'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { formatDate } from '../../../../lib/i18n/format'
import { REQUEST_FIGURES, type RequestFigure, type RequestFigures } from '../api'
import { bucketLabel, countText, pctText, requestGroupName, requestsDoor, type RequestDoorScope } from '../model'
import { NAMESPACE, stateOf } from './Parts'
import type { ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** The period table's columns (the funnel); the customer table shows every part. */
const BUCKET_FIGURES: readonly RequestFigure[] = ['received', 'quoted', 'ordered']
const GROUP_FIGURES: readonly RequestFigure[] = ['received', 'quoted', 'ordered', 'declined', 'lost', 'withdrawn', 'notAnOrder', 'open'] // B-TH-095: withdrawn

/**
 * B-TH-235 (threads plan X-SAL-REPORTS.drill, L2-G10; on B-TH-052's GET /sales/reports/requests): the intake panel's request
 * figure — the requests that came in during the period by any door and what each became so far (received, quoted, ordered
 * straight or from its quote, declined, lost, "Not an order" apart and out of the rates, still open), per week or month and per
 * customer (the prospects in one group, never a person). EVERY number is a real link to Sales › Incoming with exactly the rows it
 * counts (Owner rule "every total opens its rows": the list's tile or `outcome`, the days, the customer); a 0 opens nothing. Only
 * the customers the reader reaches are in the answer (W27/W30: the API counts the reader's own requests); without the requests'
 * right the block says so, never 0. Counts only, no money.
 */
export function RequestsFigure({ model, actions }: Props) {
  const t = useT(NAMESPACE)
  const locale = useLocale()
  const read = model.requests
  if (!read) return null
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const head = (
    <div className="fw-slr-subhead">
      <h3 className="fw-slr-h3" id="slr-requests">
        {t('requests.title')}
      </h3>
      <p className="fw-slr-hint">{t('requests.hint', { from: day(model.range.from), to: day(model.range.to) })}</p>
    </div>
  )
  const waiting = stateOf(read, t('requests.failed'), () => actions?.onRetry?.('requests'), { chart: false })
  if (waiting || read.status !== 'ready') {
    return (
      <section className="fw-slr-requests" aria-labelledby="slr-requests">
        {head}
        {waiting}
      </section>
    )
  }
  const answer = read.value
  if (answer.all === null) {
    return (
      <section className="fw-slr-requests" aria-labelledby="slr-requests">
        {head}
        <EmptyState title={t('requests.outside')} description={t('requests.outsideBody')} />
      </section>
    )
  }
  if (answer.all.received === 0) {
    return (
      <section className="fw-slr-requests" aria-labelledby="slr-requests">
        {head}
        <EmptyState title={t('requests.empty')} description={t('requests.emptyHint')} />
      </section>
    )
  }
  const period: RequestDoorScope = { company: answer.company?.id ?? null, from: answer.from, to: answer.to, group: null }
  const words = (figure: RequestFigure) => t(`requests.figure.${figure}`)
  const rate = (pct: string | null) => (pct === null ? '—' : pctText(pct, locale))
  /** A number of the figure: a link to Incoming with its rows, or a plain 0 (nothing to open). */
  const door = (figure: RequestFigure, figures: RequestFigures, scope: RequestDoorScope, where: string) => {
    const count = figures[figure]
    if (count === 0) return <span className="fw-slr-muted">{countText(0, locale)}</span>
    return (
      <Link className="fw-slr-cell-link" href={requestsDoor(model.prefix, figure, scope)} aria-label={t('requests.open', { figure: words(figure), count, where })}>
        {countText(count, locale)}
      </Link>
    )
  }
  const all = answer.all
  const hintOf = (figure: RequestFigure): string =>
    figure === 'quoted' ? t('requests.hintRate', { pct: rate(all.quotedPct) }) : figure === 'ordered' ? t('requests.hintOrdered', { pct: rate(all.orderedPct) }) : t(`requests.figureHint.${figure}`)
  const metrics: Metric[] = REQUEST_FIGURES.map((figure) => {
    const base = { label: words(figure), value: countText(all[figure], locale), hint: hintOf(figure) }
    return all[figure] > 0 ? { ...base, href: requestsDoor(model.prefix, figure, period) } : base
  })
  const prospects = t('requests.prospects')
  const periodWord = t('requests.thePeriod')
  return (
    <section className="fw-slr-requests" aria-labelledby="slr-requests">
      {head}
      <MetricStrip metrics={metrics} minTileWidth={130} />
      <SummaryTable
        label={t(`requests.by.${answer.by}`)}
        stackOnPhone
        widths={['34%']}
        columns={[t(`requests.col.${answer.by}`), ...BUCKET_FIGURES.map(words), t('requests.col.orderedPct')]}
        rows={answer.buckets.map((bucket) => {
          const label = bucketLabel(bucket, locale)
          const scope = { ...period, from: bucket.from, to: bucket.to }
          return { id: bucket.key, cells: [label, ...BUCKET_FIGURES.map((figure) => door(figure, bucket.figures, scope, label)), rate(bucket.figures.orderedPct)] }
        })}
      />
      <SummaryTable
        label={t('requests.byCustomer')}
        stackOnPhone
        widths={['28%']}
        columns={[t('requests.col.customer'), ...GROUP_FIGURES.map(words), t('requests.col.orderedPct')]}
        rows={answer.groups.map((group) => {
          const name = requestGroupName(group, prospects)
          const scope = { ...period, group: group.key }
          return { id: group.key, cells: [name, ...GROUP_FIGURES.map((figure) => door(figure, group.figures, scope, `${name}, ${periodWord}`)), rate(group.figures.orderedPct)] }
        })}
      />
      <p className="fw-slr-muted">{[t('requests.definition'), answer.more > 0 ? t('common.moreGroups', { count: answer.more }) : null, answer.complete ? null : t('common.incomplete')].filter(Boolean).join(' ')}</p>
    </section>
  )
}
