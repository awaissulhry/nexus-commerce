'use client'

import { useMemo, useState } from 'react'
import Link from 'next/link'
import { ListTree, ShieldOff, TableProperties } from 'lucide-react'
import { Banner, Card, EmptyState, Field, MetricStrip, SummaryTable } from '@nexus/ui/components'
import type { ColDef, ICellRendererParams } from '@nexus/ui/grid'
import { DetailHeader } from '@nexus/ui/patterns'
import { Button, Skeleton, Spinner } from '@nexus/ui/primitives'
import { ListFrame } from '../../../../list-frame/ListFrame'
import { AsOf, DateField } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { recordAddress } from '../../../../lib/records/record-links'
import { WithMessages } from '../../../../record-panels/i18n'
import type { DrillAnswer, KpiRecord } from '../api'
import { drillView, PERIOD_DRILLS, spanProblem, type DrillRow, type DrillSpan } from '../drills'
import { drillNameOf, kpiHref, wordsOf, type KpisAbilities } from '../model'
import '../kpis.css'

/**
 * SCR-471 — the records behind a KPI (design home.kpis rec:KPI/definition › Now "Click → records behind it"; ANA-003 "every
 * number opens its records"; B-W2b-429's drills, KP2:01): `/w/<company>/home/kpis/<key>/records?from=&to=`. The KPI's drill
 * with its own terms over the period asked (the KPI's current period by default): the overall — equal to the KPI's value
 * over the same period —, the rows in the shared list frame (each opens its record: a real link) and the groups the plan
 * names. A drill the person's rights do not reach says which right it needs. One view model, nothing fetched.
 */

type Loaded<T> = { readonly value: T | null; readonly problem: { readonly key: string; readonly params?: Readonly<Record<string, string>> } | null }

export interface RecordsModel {
  readonly can: KpisAbilities
  readonly prefix: string
  readonly key: string
  readonly kpi: Loaded<KpiRecord>
  /** The period read (from the address, else the KPI's current period). */
  readonly span: DrillSpan
  readonly drill: Loaded<DrillAnswer> & { readonly reading?: boolean }
  /** The office pages that are built (company-free): a row opens its record's page, else its panels. */
  readonly built: ReadonlySet<string>
  readonly now?: number
}

export interface RecordsActions {
  onSpan?: (span: { from: string; to: string }) => void
  onRetry?: () => void
}

export function RecordsView({ model, actions }: { model: RecordsModel; actions?: RecordsActions }) {
  return (
    <WithMessages namespaces={['home-kpis', 'lists']}>
      <RecordsScreen model={model} actions={actions} />
    </WithMessages>
  )
}

function RecordsScreen({ model, actions }: { model: RecordsModel; actions?: RecordsActions }) {
  const t = useT('home-kpis')
  const locale = useLocale()
  const kpi = model.kpi.value
  const name = kpi ? wordsOf(kpi, locale).name : null
  const drillName = kpi ? drillNameOf(kpi.calculation?.drill?.api ?? null) : null
  const view = useMemo(() => (model.drill.value ? drillView(model.drill.value, t, locale) : null), [model.drill.value, t, locale])
  const [typed, setTyped] = useState<{ from: string; to: string } | null>(null)
  const span = typed ?? { from: model.span.from ?? view?.period?.from ?? '', to: model.span.to ?? view?.period?.to ?? '' }
  const typedProblem = typed ? spanProblem(typed.from, typed.to) : null

  const columns = useMemo<ColDef<DrillRow>[]>(() => {
    if (!view) return []
    const First = ({ data }: ICellRendererParams<DrillRow>) =>
      data ? (
        <Link className="fw-kpi-link" href={`${model.prefix}${recordAddress(data.record, model.built)}`}>
          {data.cells[view.columns[0]!.id]}
        </Link>
      ) : null
    return view.columns.map((column, index) => ({
      colId: column.id,
      headerName: column.label,
      minWidth: index === 0 ? 150 : 110,
      flex: index === 0 ? 1.2 : 1,
      ...(column.align === 'right' ? { type: 'numericColumn' } : {}),
      valueGetter: ({ data }: { data?: DrillRow }) => data?.cells[column.id] ?? '',
      ...(index === 0 ? { cellRenderer: First } : {}),
    }))
  }, [view, model.prefix, model.built])

  if (!model.can.view) {
    return (
      <div className="fw-kpi">
        <Card padded>
          <EmptyState icon={<ShieldOff size={24} aria-hidden />} title={t('noAccess.title')} description={t('noAccess.body')} />
        </Card>
      </div>
    )
  }

  const back = <Link href={kpiHref(model.prefix, model.key)}>{name ? t('records.back', { name }) : t('kpi.back')}</Link>
  const problem = model.drill.problem ?? model.kpi.problem
  const withPeriod = drillName !== null && PERIOD_DRILLS.includes(drillName as (typeof PERIOD_DRILLS)[number])

  if (kpi && !drillName) {
    return (
      <div className="fw-kpi">
        <div className="fw-kpi-recband">
          <DetailHeader backAsChild backLabel={back} title={t('records.title', { name: name ?? '' })} />
        </div>
        <Card padded>
          <EmptyState icon={<ListTree size={24} aria-hidden />} title={t('records.noDrill')} description={t('records.noDrillBody')} />
        </Card>
      </div>
    )
  }

  return (
    <div className="fw-kpi">
      <div className="fw-kpi-recband">
        <DetailHeader backAsChild backLabel={back} title={name ? t('records.title', { name }) : <Skeleton width={280} height={22} />} />
        <div className="fw-kpi-meta">
          {view?.period && <span className="fw-kpi-muted">{t('records.period', { from: formatDate(`${view.period.from}T12:00:00Z`, { locale }), to: formatDate(`${view.period.to}T12:00:00Z`, { locale }) })}</span>}
          {view && (
            <span className="fw-kpi-muted">
              {t('now.asOf')} <AsOf at={view.asOf} now={model.now} />
            </span>
          )}
          {model.drill.reading && (
            <span className="fw-kpi-muted" role="status">
              <Spinner size={12} /> {t('common.reading')}
            </span>
          )}
        </div>
      </div>

      {withPeriod && (
        <div className="fw-kpi-row" role="group" aria-label={t('records.periodLabel')}>
          <Field label={t('records.from')}>
            <DateField value={span.from} onChange={(from) => setTyped({ from, to: span.to })} />
          </Field>
          <Field label={t('records.to')} error={typedProblem ? t(typedProblem) : undefined}>
            <DateField value={span.to} onChange={(to) => setTyped({ from: span.from, to })} />
          </Field>
          <Button
            size="sm"
            variant="primary"
            heldReason={!typed ? t('held.spanSame') : typedProblem ? t(typedProblem) : undefined}
            onClick={() => {
              if (typed && !typedProblem) {
                actions?.onSpan?.(typed)
                setTyped(null)
              }
            }}
          >
            {t('records.apply')}
          </Button>
        </div>
      )}

      {problem && !model.drill.value ? (
        <Card padded>
          <EmptyState
            icon={<ShieldOff size={24} aria-hidden />}
            title={t('records.failed')}
            description={t(problem.key, problem.params?.grain ? { grain: t(`grain.${problem.params.grain}`) } : problem.params)}
            action={
              problem.key.startsWith('records.needs') ? undefined : (
                <Button size="sm" onClick={() => actions?.onRetry?.()}>
                  {t('common.retry')}
                </Button>
              )
            }
          />
        </Card>
      ) : (
        <>
          {problem && (
            <Banner tone="warning" title={t('records.stale')}>
              {t(problem.key, problem.params)}
            </Banner>
          )}
          {view ? <MetricStrip minTileWidth={180} metrics={view.metrics.map((metric) => ({ label: metric.label, value: metric.value, hint: metric.hint }))} /> : <Skeleton width="100%" height={72} />}
          {view?.notes.map((note) => (
            <p key={note} className="fw-kpi-muted">
              {note}
            </p>
          ))}
          <section className="fw-kpi-section" aria-labelledby="fw-kpi-rows">
            <h2 id="fw-kpi-rows" className="fw-kpi-h">
              <TableProperties size={16} aria-hidden /> {t('records.rows')}
            </h2>
            <ListFrame<DrillRow>
              label={t('records.rows')}
              rows={view ? view.rows : null}
              rowId={(row) => row.id}
              columns={columns}
              count={view ? (view.more > 0 ? t('records.countMore', { count: view.rows.length, more: view.more }) : t('records.count', { count: view.rows.length })) : '—'}
              cards={{ hrefOf: (row) => `${model.prefix}${recordAddress(row.record, model.built)}` }}
              state={view && view.rows.length === 0 ? <EmptyState icon={<ListTree size={22} aria-hidden />} title={t('records.empty')} description={t(withPeriod ? 'records.emptyBody' : 'records.emptyNow')} /> : null}
              title={name ?? t('records.rows')}
            />
            {view && view.more > 0 && <p className="fw-kpi-muted">{t('records.more', { count: view.more })}</p>}
          </section>
          {view && view.groups.length > 0 && (
            <div className="fw-kpi-groups">
              {view.groups.map((group) => (
                <Card padded key={group.id}>
                  <section className="fw-kpi-card" aria-label={group.title}>
                    <h3 className="fw-kpi-h3">{group.title}</h3>
                    {group.rows.length === 0 ? <p className="fw-kpi-muted">{group.empty ?? t('records.groupEmpty')}</p> : <SummaryTable label={group.title} columns={group.columns} rows={group.rows} align={group.align} density="compact" stackOnPhone />}
                  </section>
                </Card>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
