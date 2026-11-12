'use client'

import Link from 'next/link'
import { useState, type ReactNode } from 'react'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Banner, EmptyState, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { chart, color } from '@nexus/ui/tokens'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import type { Uom } from '../../../_shared/stock/api'
import { quantity } from '../../../_shared/stock/model'
import { AGE_BUCKETS, LEATHER_MEASURES, type AgeingType, type LeatherFigures, type LeatherMeasure } from '../api'
import {
  ageingChartRows,
  articleHrefs,
  articleLabel,
  AGEING_SERIES,
  bucketCell,
  daysText,
  hidesHref,
  leatherQuantities,
  lotLabel,
  measureOf,
  quantitiesText,
  typesWithoutShare,
  valueText,
} from '../model'
import type { Read, ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** The bucket colours: young to old (never colour alone: the legend and the table name each one). */
const BUCKET_COLOURS = { d0to90: color.success, d91to180: chart.actual, d181to365: color.warning, overYear: color.danger } as const

const dayText = (date: string, locale: 'it' | 'en') => formatDate(`${date}T12:00:00Z`, { locale })

/** The panel's head: its title, what it says, and its own controls. */
function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-wr-head">
      <div className="fw-wr-head-text">
        <h2 className="fw-wr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-wr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-wr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons. */
function Shape() {
  const t = useT('warehouse-reports')
  return (
    <div className="fw-wr-shape" role="status" aria-label={t('common.loading')}>
      <Skeleton height={220} radius={8} />
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={20} />
      ))}
    </div>
  )
}

/** The panel failed: what failed in words, and Try again; the other panel stays. */
function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT('warehouse-reports')
  return (
    <EmptyState
      title={title}
      description={t(problem)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  )
}

function stateOf<T>(read: Read<T>, failedTitle: string, onRetry?: () => void): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

/** A link when there is somewhere to go, else the words alone. */
function MaybeLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <Link className="fw-wr-link" href={href}>
      {children}
    </Link>
  ) : (
    <>{children}</>
  )
}

function useUnitWord() {
  const stock = useT('stock')
  return (uom: Uom) => stock(`uom.${uom}`)
}

// ---- Stock ageing (wr-ageing) ------------------------------------------------------------------------------------------------

export function AgeingPanel({ model, actions }: Props) {
  const t = useT('warehouse-reports')
  const locale = useLocale()
  const unitWord = useUnitWord()
  const typeWord = (type: AgeingType['type']) => t(`type.${type}`)
  const read = model.ageing
  const answer = read.status === 'ready' ? read.value : null
  const [picked, setPicked] = useState<AgeingType['type'] | null>(null)
  const cost = model.can.cost && (answer?.sight.cost ?? true)
  const series = cost ? model.series : 'share'
  const hint = answer ? t('ageing.hint', { day: dayText(answer.asAt, locale) }) : t('ageing.hintLoading')
  const head = (
    <Head id="wr-ageing" title={t('section.ageing')} hint={hint}>
      {cost ? (
        <SegmentedControl
          size="sm"
          ariaLabel={t('ageing.series')}
          value={series}
          onChange={(value) => actions?.onSeries?.(value as typeof series)}
          options={AGEING_SERIES.map((value) => ({ value, label: t(`ageing.seriesOf.${value}`) }))}
        />
      ) : null}
    </Head>
  )
  const waiting = stateOf(read, t('ageing.failed'), () => actions?.onRetry?.('ageing'))
  if (waiting || !answer) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-ageing">
        {head}
        {waiting}
      </section>
    )
  }
  if (!answer.sight.stock) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-ageing">
        {head}
        <EmptyState title={t('notInRole.title')} description={t('notInRole.stock')} />
      </section>
    )
  }
  if (answer.types.length === 0) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-ageing">
        {head}
        <EmptyState title={t('ageing.empty', { day: dayText(answer.asAt, locale) })} description={t('ageing.emptyHint')} />
      </section>
    )
  }
  const rows = ageingChartRows(answer.types, series, typeWord)
  const leftOut = series === 'share' ? typesWithoutShare(answer.types) : []
  const chosen = answer.types.find((row) => row.type === picked) ?? answer.types[0]!
  const valueColumns = cost
  const columns = [t('col.type'), ...AGE_BUCKETS.map((bucket) => t(`bucket.${bucket}`)), t('col.whole'), ...(valueColumns ? [t('col.value')] : []), t('col.averageDays'), t('col.oldestDays')]
  const articleColumns = [t('col.article'), ...AGE_BUCKETS.map((bucket) => t(`bucket.${bucket}`)), t('col.whole'), ...(valueColumns ? [t('col.value')] : []), t('col.oldestDays')]
  return (
    <section className="fw-wr-panel" aria-labelledby="wr-ageing">
      {head}
      {rows.length > 0 ? (
        <figure className="fw-wr-chart" aria-label={t('ageing.chartLabel')}>
          <PerformanceGraph
            data={rows}
            xKey="type"
            left={{
              key: 'buckets',
              label: series === 'value' ? t('ageing.axisValue') : t('ageing.axisShare'),
              axisLabel: series === 'value' ? t('ageing.axisValue') : t('ageing.axisShare'),
              color: chart.actual,
              axis: 'left',
              shape: 'bar',
              ...(series === 'share' ? { domain: [0, 100] as [number, number], ticks: [0, 25, 50, 75, 100] } : {}),
              format: (value) => (series === 'value' ? formatNumber(value, locale, { maximumFractionDigits: 0 }) : `${formatNumber(value, locale, { maximumFractionDigits: 1 })} %`),
              stack: AGE_BUCKETS.map((bucket) => ({ key: bucket, label: t(`bucket.${bucket}`), color: BUCKET_COLOURS[bucket] })),
            }}
            right={{ key: 'averageDays', label: t('ageing.averageDays'), axisLabel: t('ageing.axisDays'), color: chart.reference, axis: 'right', format: (value) => daysText(value, locale) }}
            height={260}
          />
          <figcaption className="fw-wr-muted">
            {[series === 'value' ? t('ageing.captionValue', { currency: answer.all.currency ?? '' }) : t('ageing.captionShare'), leftOut.length > 0 ? t('ageing.leftOut', { types: leftOut.map(typeWord).join(', ') }) : null].filter(Boolean).join(' ')}
          </figcaption>
        </figure>
      ) : (
        <p className="fw-wr-muted">{t('ageing.noChart')}</p>
      )}
      <SummaryTable
        label={t('ageing.tableLabel')}
        stackOnPhone
        columns={columns}
        widths={['16%']}
        align={[undefined, ...AGE_BUCKETS.map(() => 'right' as const), 'right', ...(valueColumns ? ['right' as const] : []), 'right', 'right']}
        rows={answer.types.map((row) => ({
          id: row.type,
          cells: [
            typeWord(row.type),
            ...AGE_BUCKETS.map((bucket) => bucketCell(row.buckets[bucket], unitWord, locale)),
            quantitiesText(row.whole.quantities, unitWord, locale),
            ...(valueColumns ? [row.mixedCurrencies ? t('ageing.mixedCurrencies') : valueText(row.whole.value, row.currency, locale)] : []),
            daysText(row.averageDays, locale),
            row.oldestDays === null ? '—' : t('ageing.days', { count: row.oldestDays }),
          ],
        }))}
      />
      <p className="fw-wr-muted">
        {[
          t('ageing.definition'),
          answer.customerOwned > 0 ? t('ageing.customerOwned', { count: answer.customerOwned }) : null,
          valueColumns && answer.all.unvalued > 0 ? t('ageing.unvalued', { count: answer.all.unvalued }) : null,
          valueColumns ? (answer.all.mixedCurrencies ? t('ageing.mixedCurrencies') : t('ageing.allValue', { value: valueText(answer.all.value, answer.all.currency, locale) })) : t('ageing.noCost'),
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      <div className="fw-wr-articles">
        <div className="fw-wr-head">
          <h3 className="fw-wr-h3" id="wr-ageing-articles">
            {t('ageing.articlesOf', { type: typeWord(chosen.type) })}
          </h3>
          <Select size="sm" aria-label={t('ageing.pickType')} value={chosen.type} onChange={(event) => setPicked(event.target.value as AgeingType['type'])}>
            {answer.types.map((row) => (
              <option key={row.type} value={row.type}>
                {typeWord(row.type)}
              </option>
            ))}
          </Select>
        </div>
        <SummaryTable
          label={t('ageing.articlesOf', { type: typeWord(chosen.type) })}
          stackOnPhone
          columns={articleColumns}
          widths={['24%']}
          align={[undefined, ...AGE_BUCKETS.map(() => 'right' as const), 'right', ...(valueColumns ? ['right' as const] : []), 'right']}
          rows={chosen.articles.map((article) => {
            const hrefs = articleHrefs(model.prefix, article)
            return {
              id: `${article.item.id}|${article.colour?.id ?? ''}`,
              cells: [
                <span key="a" className="fw-wr-cell">
                  <MaybeLink href={model.can.stock ? hrefs.stock : null}>{articleLabel(article)}</MaybeLink>
                  {model.can.stock && hrefs.moves ? (
                    <Link className="fw-wr-link fw-wr-sub" href={hrefs.moves}>
                      {t('ageing.moves')}
                    </Link>
                  ) : null}
                </span>,
                ...AGE_BUCKETS.map((bucket) => quantitiesText(article.buckets[bucket].quantities, unitWord, locale)),
                quantitiesText(article.whole.quantities, unitWord, locale),
                ...(valueColumns ? [valueText(article.whole.value, article.currency, locale)] : []),
                article.oldestDays === null ? '—' : t('ageing.days', { count: article.oldestDays }),
              ],
            }
          })}
        />
        {chosen.more > 0 ? <p className="fw-wr-muted">{t('ageing.more', { count: chosen.more })}</p> : null}
        <p className="fw-wr-muted">{t('ageing.drill')}</p>
      </div>
    </section>
  )
}

// ---- Leather use (wr-leather) ------------------------------------------------------------------------------------------------

const QUANTITY_COLUMNS = ['start', 'received', 'cut', 'remnant', 'scrapped', 'other', 'end'] as const

export function LeatherPanel({ model, actions }: Props) {
  const t = useT('warehouse-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const unitWord = useUnitWord()
  const read = model.leather
  const answer = read.status === 'ready' ? read.value : null
  const cost = model.can.cost && (answer?.sight.cost ?? true)
  const period = answer ? { from: answer.from, to: answer.to } : model.range
  const head = (
    <Head id="wr-leather" title={t('section.leather')} hint={t('leather.hint', { from: dayText(period.from, locale), to: dayText(period.to, locale) })}>
      <SegmentedControl
        size="sm"
        wrap
        ariaLabel={t('leather.measure')}
        value={model.measure}
        onChange={(value) => actions?.onMeasure?.(value as LeatherMeasure)}
        options={LEATHER_MEASURES.map((value) => ({ value, label: t(`leather.col.${value}`) }))}
      />
    </Head>
  )
  const waiting = stateOf(read, t('leather.failed'), () => actions?.onRetry?.('leather'))
  if (waiting || !answer) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-leather">
        {head}
        {waiting}
      </section>
    )
  }
  if (!answer.sight.stock) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-leather">
        {head}
        <EmptyState title={t('notInRole.title')} description={t('notInRole.stock')} />
      </section>
    )
  }
  if (answer.articles.length === 0) {
    return (
      <section className="fw-wr-panel" aria-labelledby="wr-leather">
        {head}
        <EmptyState title={t('leather.empty')} description={t('leather.emptyHint')} />
      </section>
    )
  }
  const m2 = (value: number) => `${quantity(value, locale)} ${unitWord('M2')}`
  const items = answer.articles.map((article) => {
    const lots = article.lots.length
    return {
      id: `${article.item.id}|${article.colour?.id ?? ''}`,
      label: articleLabel(article),
      sub: t('leather.barSub', { lots, hides: article.figures.hidesOnHand }),
      value: measureOf(article.figures, model.measure),
      ...(model.can.stock && hidesHref(model.prefix, { itemId: article.item.id, colourId: article.colour?.id ?? null }) ? { href: hidesHref(model.prefix, { itemId: article.item.id, colourId: article.colour?.id ?? null })! } : {}),
    }
  })
  const quantityCells = (figures: LeatherFigures) => {
    const shown = leatherQuantities(figures)
    return QUANTITY_COLUMNS.map((key) => (shown ? quantity(shown.values[key], locale) : '—'))
  }
  const valueCells = (figures: LeatherFigures) => (cost ? [valueText(figures.values.received, figures.currency, locale), valueText(figures.values.cut, figures.currency, locale), valueText(figures.values.end, figures.currency, locale)] : [])
  const columns = [
    t('leather.col.article'),
    t('leather.col.unit'),
    ...QUANTITY_COLUMNS.map((key) => t(`leather.col.${key}`)),
    t('leather.col.hidesReceived'),
    t('leather.col.hidesOnHand'),
    ...(cost ? [t('leather.col.valueReceived'), t('leather.col.valueCut'), t('leather.col.valueEnd')] : []),
  ]
  const unitOf = (figures: LeatherFigures) => {
    const shown = leatherQuantities(figures)
    return shown ? unitWord(shown.uom) : '—'
  }
  const tableRows = answer.articles.flatMap((article) => [
    {
      id: `a:${article.item.id}|${article.colour?.id ?? ''}`,
      cells: [
        <strong key="a" className="fw-wr-cell">
          <MaybeLink href={model.can.stock ? hidesHref(model.prefix, { itemId: article.item.id, colourId: article.colour?.id ?? null }) : null}>{articleLabel(article)}</MaybeLink>
        </strong>,
        unitOf(article.figures),
        ...quantityCells(article.figures),
        String(article.figures.hidesReceived),
        String(article.figures.hidesOnHand),
        ...valueCells(article.figures),
      ],
    },
    ...article.lots.map((lot) => ({
      id: `l:${article.item.id}|${article.colour?.id ?? ''}|${lot.lot?.id ?? ''}`,
      cells: [
        <span key="l" className="fw-wr-cell fw-wr-lot">
          <MaybeLink href={model.can.stock && lot.lot ? hidesHref(model.prefix, { lotId: lot.lot.id }) : null}>{lotLabel(lot, t('leather.noLot'))}</MaybeLink>
          {lot.children > 0 ? <span className="fw-wr-sub">{t('leather.children', { count: lot.children })}</span> : null}
          {lot.dyeBatch ? <span className="fw-wr-sub">{t('leather.dyeBatch', { batch: lot.dyeBatch })}</span> : null}
        </span>,
        unitOf(lot.figures),
        ...quantityCells(lot.figures),
        String(lot.figures.hidesReceived),
        String(lot.figures.hidesOnHand),
        ...valueCells(lot.figures),
      ],
    })),
  ])
  const allShown = leatherQuantities(answer.all)
  const notAdding = answer.articles.some((article) => !article.figures.addsUp || article.lots.some((lot) => !lot.figures.addsUp))
  return (
    <section className="fw-wr-panel" aria-labelledby="wr-leather">
      {head}
      <BarList labels={ds.barList} label={t('leather.barsLabel', { measure: t(`leather.col.${model.measure}`) })} format={m2} items={items} />
      <p className="fw-wr-muted">{t('leather.barsHint', { measure: t(`leather.col.${model.measure}`) })}</p>
      {notAdding ? <Banner tone="warning" title={t('leather.notAdding')} /> : null}
      <SummaryTable
        label={t('leather.tableLabel')}
        stackOnPhone
        columns={columns}
        widths={['22%', '5%']}
        align={[undefined, undefined, ...QUANTITY_COLUMNS.map(() => 'right' as const), 'right', 'right', ...(cost ? (['right', 'right', 'right'] as const) : [])]}
        rows={[
          ...tableRows,
          {
            id: 'all',
            cells: [
              <strong key="t">{t('leather.all')}</strong>,
              allShown ? unitWord(allShown.uom) : '—',
              ...quantityCells(answer.all),
              String(answer.all.hidesReceived),
              String(answer.all.hidesOnHand),
              ...valueCells(answer.all),
            ],
          },
        ]}
      />
      <p className="fw-wr-muted">
        {[
          t('leather.definition'),
          answer.more > 0 ? t('leather.more', { count: answer.more }) : null,
          cost && answer.unvaluedMoves > 0 ? t('leather.unvalued', { count: answer.unvaluedMoves }) : null,
          cost ? null : t('leather.noCost'),
          allShown ? null : t('leather.severalUnits'),
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
      <p className="fw-wr-muted">{t('leather.drill')}</p>
    </section>
  )
}

