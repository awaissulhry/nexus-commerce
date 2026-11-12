'use client'

import type { ReactNode } from 'react'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { EmptyState, KeyValue, SummaryTable } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate, formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { money } from '../../../_shared/stock/model'
import { SPEND_GROUPS, type SpendGroup, type SpendGroupRow } from '../api'
import { amountText, groupLabel, measureOf, measuresFor, monthOf, monthText, pivotMonths, shareText, type SpendMeasure } from '../model'
import type { Read, ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

/** The panel's head: its title, what it says, and its own controls. */
export function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-pr-head">
      <div className="fw-pr-head-text">
        <h2 className="fw-pr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-pr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-pr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons. */
export function Shape({ chart = true }: { chart?: boolean }) {
  const t = useT('purchasing-reports')
  return (
    <div className="fw-pr-shape" role="status" aria-label={t('common.loading')}>
      {chart ? <Skeleton height={200} radius={8} /> : null}
      {Array.from({ length: 4 }, (_, index) => (
        <Skeleton key={index} height={20} />
      ))}
    </div>
  )
}

/** The panel failed: what failed in words, and Try again; the other panel stays. */
export function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT('purchasing-reports')
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

export function stateOf<T>(read: Read<T>, failedTitle: string, onRetry?: () => void, chart = true): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape chart={chart} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

// ---- Spend (sec spend) ---------------------------------------------------------------------------------------------------------

export function SpendPanel({ model, actions }: Props) {
  const t = useT('purchasing-reports')
  const wr = useT('warehouse-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.spend
  const answer = read.status === 'ready' ? read.value : null
  const cost = model.can.cost && (answer?.sight.values ?? true)
  const measures = measuresFor(cost)
  const measure: SpendMeasure = measures.includes(model.measure) ? model.measure : measures[0]!
  const by = model.address.by
  const period = answer ? { from: answer.from, to: answer.to } : model.range
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const label = (group: Pick<SpendGroupRow, 'key' | 'code' | 'name'>) => groupLabel(group, by, { category: (kind) => wr(`type.${kind}`), locale })
  const head = (
    <Head id="pr-spend" title={t('section.spend')} hint={t('spend.hint', { from: day(period.from), to: day(period.to) })}>
      <Select size="sm" value={by} aria-label={t('spend.by')} onChange={(event) => actions?.onAddress?.({ by: event.target.value as SpendGroup })}>
        {SPEND_GROUPS.map((group) => (
          <option key={group} value={group}>
            {t(`by.${group}`)}
          </option>
        ))}
      </Select>
      <SegmentedControl size="sm" wrap ariaLabel={t('spend.measure')} value={measure} onChange={(value) => actions?.onMeasure?.(value as SpendMeasure)} options={measures.map((value) => ({ value, label: t(`measure.${value}`) }))} />
    </Head>
  )
  const waiting = stateOf(read, t('spend.failed'), () => actions?.onRetry?.('spend'))
  if (waiting || !answer) {
    return (
      <section className="fw-pr-panel" aria-labelledby="pr-spend">
        {head}
        {waiting}
      </section>
    )
  }
  if (!answer.sight.orders) {
    return (
      <section className="fw-pr-panel" aria-labelledby="pr-spend">
        {head}
        <EmptyState title={t('notInRole.title')} description={t('notInRole.orders')} />
      </section>
    )
  }
  if (answer.groups.length === 0) {
    return (
      <section className="fw-pr-panel" aria-labelledby="pr-spend">
        {head}
        <EmptyState title={t('spend.empty')} description={t('spend.emptyHint')} />
      </section>
    )
  }
  const amountMeasure = measure === 'production' || measure === 'samples'
  const currency = answer.all.currency ?? answer.companyCurrency
  const format = (value: number) => (amountMeasure ? money(value, currency, locale) : formatNumber(value, locale))
  const items = answer.groups.map((group) => ({
    id: group.key,
    label: label(group),
    sub: [t('spend.sub.orders', { count: group.orders }), group.sampleOrders > 0 ? t('spend.sub.samples', { count: group.sampleOrders }) : null, cost && group.share ? t('spend.sub.share', { share: shareText(group.share, locale) }) : null].filter(Boolean).join(' · '),
    value: measureOf(group, measure),
    ...(amountMeasure && group.mixedCurrencies ? { valueText: amountText(group, measure, locale) } : {}),
  }))
  const months = cost ? pivotMonths(answer) : []
  const columns = [t(`by.${by}`), ...months.map((month) => monthText(month, locale)), ...(cost ? [t('col.production'), t('col.samples')] : []), t('col.orders'), t('col.lines'), t('col.sampleOrders'), ...(cost ? [t('col.share')] : [])]
  const cells = (group: SpendGroupRow | null) => {
    const figures = group ?? answer.all
    return [
      ...months.map((month) => {
        const entry = group ? monthOf(group, month) : null
        return entry ? money(entry.production ?? null, entry.currency, locale) : '—'
      }),
      ...(cost ? [amountText(figures, 'production', locale), amountText(figures, 'samples', locale)] : []),
      String(figures.orders),
      String(figures.lines),
      String(figures.sampleOrders),
      ...(cost ? [group ? shareText(group.share, locale) : shareText(answer.all.production ? '100.0' : null, locale)] : []),
    ]
  }
  const rows = [
    ...answer.groups.map((group) => ({
      id: group.key,
      cells: [
        <button key="g" type="button" className="fw-pr-cell-link" onClick={() => actions?.onDrill?.(group.key)}>
          {label(group)}
        </button>,
        ...cells(group),
      ],
    })),
    { id: 'all', cells: [<strong key="t">{t('spend.all')}</strong>, ...cells(null)] },
  ]
  return (
    <section className="fw-pr-panel" aria-labelledby="pr-spend">
      {head}
      <KeyValue
        columns={cost ? 2 : 3}
        items={[
          ...(cost
            ? [
                { label: t('spend.kv.production'), value: amountText(answer.all, 'production', locale) },
                { label: t('spend.kv.samples'), value: amountText(answer.all, 'samples', locale), hint: t('spend.kv.samplesHint') },
              ]
            : []),
          { label: t('spend.kv.orders'), value: String(answer.all.orders), hint: t('spend.kv.lines', { count: answer.all.lines }) },
          { label: t('spend.kv.sampleOrders'), value: String(answer.all.sampleOrders) },
          ...(cost ? [] : [{ label: t('spend.kv.amounts'), value: t('spend.kv.amountsHeld') }]),
        ]}
      />
      <BarList labels={ds.barList} label={t('spend.barsLabel', { measure: t(`measure.${measure}`), by: t(`by.${by}`) })} format={format} items={items} onPick={(key) => actions?.onDrill?.(key)} active={model.drill?.key ?? null} />
      <p className="fw-pr-muted">{t('spend.barsHint')}</p>
      <SummaryTable label={t('spend.tableLabel')} stackOnPhone columns={columns} widths={['24%']} align={[undefined, ...columns.slice(1).map(() => 'right' as const)]} rows={rows} />
      <p className="fw-pr-muted">
        {[
          t('spend.definition'),
          answer.more > 0 ? t('spend.more', { count: answer.more }) : null,
          answer.complete ? null : t('spend.incomplete'),
          answer.all.mixedCurrencies ? t('spend.mixed') : null,
          cost ? null : t('spend.noCost'),
        ]
          .filter(Boolean)
          .join(' ')}
      </p>
    </section>
  )
}
