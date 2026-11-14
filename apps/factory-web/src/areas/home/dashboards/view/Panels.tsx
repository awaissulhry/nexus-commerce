'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { AlertTriangle, ArrowUpRight, Gauge, Info, Layers, Pin, TrendingUp } from 'lucide-react'
import { Card, DetailPopover, EmptyState, EntityPath, MetricStrip, PerformanceGraph, PressableRow, Sparkline, SummaryTable, type Metric } from '@nexus/ui/components'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { AsOf } from '../../../../lib/i18n/ds-parts'
import { formatNumber } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { periodText, problemOf, problemText, valueNumber, valueText } from '../../kpis/model'
import { WIP_AGE_BUCKETS, type ByCompanyCell, type DashNumber, type NeedsRow } from '../api'
import { companyHref, definitionHref, needsHrefOf, onTimeHref, recordsHrefOf, sayIn, SEE_ALL_HREF, sparkOf, weeksWithData, wipHref, type PinnedPanel, type Translate } from '../model'
import type { DashboardsActions, DashboardsModel, Read } from './types'

type Props = { model: DashboardsModel; actions?: DashboardsActions | undefined }

/** A panel: its question as its title, what it reads, its own loading, error and empty states. */
function Panel({ id, icon, title, hint, children, foot }: { id: string; icon: ReactNode; title: string; hint?: ReactNode; children: ReactNode; foot?: ReactNode }) {
  return (
    <Card padded className="fw-dash-panel">
      <div className="fw-dash-panel-head">
        <h2 className="fw-dash-h" id={`fw-dash-${id}`}>
          {icon} {title}
        </h2>
        {hint ? <p className="fw-dash-muted">{hint}</p> : null}
      </div>
      <div className="fw-dash-panel-body" aria-labelledby={`fw-dash-${id}`}>
        {children}
      </div>
      {foot ? <div className="fw-dash-panel-foot">{foot}</div> : null}
    </Card>
  )
}

/** The loading and error states every panel shares (design: skeleton in the section's own shape; the problem in words). */
function ReadState<T>({ read, rows = 3, onRetry, children }: { read: Read<T>; rows?: number; onRetry?: (() => void) | undefined; children: (value: T) => ReactNode }) {
  const t = useT('home-dashboards')
  if (read.status === 'loading') {
    return (
      <div className="fw-dash-skeleton" role="status" aria-label={t('panel.loading')}>
        {Array.from({ length: rows }, (_, index) => (
          <Skeleton key={index} height={18} />
        ))}
        <span className="fw-dash-muted">{t('panel.stillLoading')}</span>
      </div>
    )
  }
  if (read.status === 'error') {
    return (
      <EmptyState
        icon={<AlertTriangle size={20} aria-hidden />}
        title={t('panel.failed')}
        description={t(read.problem)}
        action={
          onRetry ? (
            <Button size="sm" onClick={onRetry}>
              {t('panel.retry')}
            </Button>
          ) : undefined
        }
      />
    )
  }
  return <>{children(read.value)}</>
}

/** A link inside the office (company-prefixed), or plain words when the page is not built. */
function Door({ prefix, href, children }: { prefix: string; href: string | null; children: ReactNode }) {
  if (!href) return null
  return (
    <Link className="fw-dash-link" href={href.startsWith('/w/') ? href : `${prefix}${href}`}>
      {children} <ArrowUpRight size={12} aria-hidden />
    </Link>
  )
}

// ---- the five numbers ---------------------------------------------------------------------------------------------------------

function numberText(number: Pick<DashNumber, 'unit' | 'value' | 'currency' | 'problem' | 'grain'>, tk: Translate, locale: 'it' | 'en'): { text: string; problem: string | null } {
  const problem = problemOf(number, number.grain)
  const text = problem ? null : valueText(number.unit, number.value, number.currency, tk, locale)
  return { text: text ?? '—', problem: problem ? problemText(problem, tk) : null }
}

/** "How this number is made" (design pop:explain): the KPI library's definition and source, and the door to the KPI. */
function Explain({ number, model }: { number: DashNumber; model: DashboardsModel }) {
  const t = useT('home-dashboards')
  const tk = useT('home-kpis')
  const locale = useLocale()
  const name = sayIn(number.name, locale)
  // A design case opens it after the page is drawn (open while hydrating, the popover's portal redraws the whole page).
  const wanted = model.explain === number.kpiKey
  const [open, setOpen] = useState(false)
  useEffect(() => {
    if (wanted) setOpen(true)
  }, [wanted])
  return (
    <DetailPopover
      trigger={<Info size={14} aria-hidden />}
      triggerLabel={t('explain.open', { name })}
      triggerClassName="fw-dash-explain"
      label={t('explain.title', { name })}
      {...(wanted ? { open, onOpenChange: setOpen } : {})}
    >
      <div className="fw-dash-pop">
        <p>{sayIn(number.definition, locale)}</p>
        <p className="fw-dash-formula">{sayIn(number.formula, locale)}</p>
        <dl className="fw-dash-facts">
          <dt>{t('explain.from')}</dt>
          <dd>{number.sources.map((source) => t(`source.${source}`)).join(' · ')}</dd>
          <dt>{t('explain.period')}</dt>
          <dd>{periodText(number.period, tk, locale)}</dd>
          <dt>{t('explain.unit')}</dt>
          <dd>
            {tk(`unit.${number.unit}`)}
            {number.grain ? ` · ${t('explain.grain', { grain: tk(`grain.${number.grain.toLowerCase()}`) })}` : ''}
          </dd>
        </dl>
        {number.standsFor ? <p className="fw-dash-muted">{t('explain.standsFor', { name: sayIn(number.standsFor.name, locale) })}</p> : null}
        {model.built.has('/home/kpis/[key]') ? (
          <Door prefix={model.prefix} href={definitionHref(number.kpiKey)}>
            {t('explain.library')}
          </Door>
        ) : null}
      </div>
    </DetailPopover>
  )
}

export function NumbersPanel({ model, actions }: Props) {
  const t = useT('home-dashboards')
  const tk = useT('home-kpis')
  const locale = useLocale()
  const read = model.numbers
  return (
    <Panel id="numbers" icon={<Gauge size={16} aria-hidden />} title={t('numbers.title')} hint={read.status === 'ready' ? t('numbers.hint', { period: t(`periodWord.${read.value.period}`) }) : undefined}>
      <ReadState read={read} rows={2} onRetry={() => actions?.onRetry?.('numbers')}>
        {(value) =>
          value.numbers.length === 0 ? (
            <EmptyState icon={<Gauge size={20} aria-hidden />} title={t('numbers.none')} description={t('numbers.noneBody')} />
          ) : (
            <MetricStrip
              className="fw-dash-numbers"
              minTileWidth={model.mode === 'present' ? 260 : 210}
              metrics={value.numbers.map((number, index): Metric => {
                const said = numberText(number, tk, locale)
                const records = recordsHrefOf(number, model.built)
                const spark = sparkOf(number)
                return {
                  label: (
                    <span className="fw-dash-tile-label">
                      <span>{sayIn(number.name, locale)}</span>
                      {model.mode === 'page' ? <Explain number={number} model={model} /> : null}
                    </span>
                  ),
                  value: said.text,
                  hint: (
                    <span className="fw-dash-tile-foot">
                      <Sparkline fluid height={model.mode === 'present' ? 40 : 28} shape="line" values={spark} label={t('numbers.spark', { name: sayIn(number.name, locale), count: spark.length })} emptyLabel={t('numbers.sparkEmpty')} />
                      <span className="fw-dash-muted">{periodText(number.period, tk, locale)}</span>
                      {said.problem ? (
                        <span className="fw-dash-muted">{said.problem}</span>
                      ) : (
                        <span className="fw-dash-muted">
                          {number.asOf ? <AsOf at={number.asOf} now={model.now} /> : t('numbers.noRebuild')} · {t('numbers.from', { sources: number.sources.map((source) => t(`source.${source}`)).join(', ') })}
                        </span>
                      )}
                      {number.stale ? <Tag tone="warning">{t('numbers.stale')}</Tag> : null}
                      {number.live ? <Tag tone="info">{t('numbers.live')}</Tag> : null}
                      {number.wholeCompany ? <span className="fw-dash-muted">{t('numbers.wholeCompany')}</span> : null}
                      {number.standsFor ? <span className="fw-dash-muted">{t('numbers.standsFor', { name: sayIn(number.standsFor.name, locale) })}</span> : null}
                      {model.mode === 'page' && records ? (
                        <Link className="fw-dash-link" href={`${model.prefix}${records}`} aria-keyshortcuts={String(index + 1)}>
                          {t('numbers.records')} <ArrowUpRight size={12} aria-hidden />
                        </Link>
                      ) : null}
                    </span>
                  ),
                }
              })}
            />
          )
        }
      </ReadState>
    </Panel>
  )
}

// ---- needs action -------------------------------------------------------------------------------------------------------------

const SEVERITY_TONE = { HIGH: 'danger', MEDIUM: 'warning', LOW: 'neutral' } as const

export function NeedsPanel({ model, actions }: Props) {
  const t = useT('home-dashboards')
  const th = useT('home')
  const read = model.needs
  const label = (row: NeedsRow) => t('needs.row', { count: row.count, kind: th(`today.kind.${row.kind}`) })
  return (
    <Panel
      id="needs"
      icon={<AlertTriangle size={16} aria-hidden />}
      title={t('needs.title')}
      hint={t('needs.hint')}
      foot={
        read.status === 'ready' && read.value.all > read.value.rows.reduce((sum, row) => sum + row.count, 0) && model.mode === 'page' ? (
          <Door prefix={model.prefix} href={SEE_ALL_HREF}>
            {t('needs.seeAll', { count: read.value.all })}
          </Door>
        ) : read.status === 'ready' && read.value.all > 0 && model.mode === 'page' ? (
          <Door prefix={model.prefix} href={SEE_ALL_HREF}>
            {t('needs.openToday')}
          </Door>
        ) : null
      }
    >
      <ReadState read={read} onRetry={() => actions?.onRetry?.('needs')}>
        {(value) =>
          value.rows.length === 0 ? (
            <p className="fw-dash-calm">{t('needs.none')}</p>
          ) : (
            <ul className="fw-dash-needs">
              {value.rows.map((row) => (
                <li key={row.kind}>
                  {model.mode === 'page' ? (
                    <PressableRow
                      label={label(row)}
                      leading={<Tag tone={SEVERITY_TONE[row.severity]}>{th(`today.severity.${row.severity}`)}</Tag>}
                      onClick={() => actions?.onOpen?.(`${model.prefix}${needsHrefOf(row, model.built)}`)}
                      {...(row.oldestDays !== null ? { actions: <span className="fw-dash-muted">{t('needs.oldest', { count: row.oldestDays })}</span> } : {})}
                    />
                  ) : (
                    <span className="fw-dash-need">
                      <Tag tone={SEVERITY_TONE[row.severity]}>{th(`today.severity.${row.severity}`)}</Tag> {label(row)}
                    </span>
                  )}
                  {!row.complete ? <span className="fw-dash-muted">{t('needs.atLeast')}</span> : null}
                </li>
              ))}
            </ul>
          )
        }
      </ReadState>
    </Panel>
  )
}

// ---- are we shipping on time? ------------------------------------------------------------------------------------------------

export function TrendsPanel({ model, actions }: Props) {
  const t = useT('home-dashboards')
  const tk = useT('home-kpis')
  const locale = useLocale()
  const read = model.trends
  const pct = (n: number) => `${formatNumber(n, locale, { maximumFractionDigits: 1 })} %`
  return (
    <Panel
      id="trends"
      icon={<TrendingUp size={16} aria-hidden />}
      title={t('trends.title')}
      hint={read.status === 'ready' ? t('trends.hint', { target: read.value.target }) : undefined}
      foot={model.mode === 'page' ? <Door prefix={model.prefix} href={onTimeHref(model.built)}>{t('trends.open')}</Door> : null}
    >
      <ReadState read={read} rows={4} onRetry={() => actions?.onRetry?.('trends')}>
        {(value) => {
          const having = weeksWithData(value.values)
          if (value.problem && value.problem !== 'NOT_BUILT') return <p className="fw-dash-muted">{problemText(problemOf({ problem: value.problem, value: null }, null)!, tk)}</p>
          if (having < 2) return <EmptyState icon={<TrendingUp size={20} aria-hidden />} title={t('trends.notEnough', { count: having, of: value.weeks.length })} description={t('trends.notEnoughBody')} />
          const data = value.weeks.map((week, index) => ({ week: periodText(week, tk, locale), onTime: valueNumber('PERCENT', value.values[index] ?? null) ?? Number.NaN, target: value.target }))
          return (
            <>
              <figure className="fw-dash-figure">
                <PerformanceGraph
                  data={data}
                  xKey="week"
                  left={{ key: 'onTime', label: sayIn(value.kpi.name, locale), color: chart.positive, axis: 'left', domain: [0, 100], format: pct }}
                  right={{ key: 'target', label: t('trends.target'), color: chart.negative, axis: 'right', domain: [0, 100], format: pct }}
                  height={model.mode === 'present' ? 320 : 220}
                />
                <figcaption className="fw-dash-muted">
                  {t('trends.caption', { count: having, of: value.weeks.length })}
                  {value.asOf ? (
                    <>
                      {' · '}
                      <AsOf at={value.asOf} now={model.now} />
                    </>
                  ) : null}
                  {value.stale ? ` · ${t('numbers.stale')}` : ''}
                </figcaption>
              </figure>
              {value.series.length > 0 ? (
                <ul className="fw-dash-series" aria-label={t('trends.byCompany')}>
                  {value.series.map((line) => {
                    const last = [...line.values].reverse().find((entry) => entry !== null) ?? null
                    return (
                      <li key={line.company.id}>
                        <span className="fw-dash-series-name">{line.company.name}</span>
                        <Sparkline fluid height={22} shape="line" domain={[0, 100]} values={line.values.map((entry) => valueNumber('PERCENT', entry))} label={t('trends.lineOf', { company: line.company.name })} emptyLabel={t('numbers.sparkEmpty')} />
                        <span className="fw-dash-muted">{last === null ? '—' : pct(Number(last))}</span>
                      </li>
                    )
                  })}
                </ul>
              ) : null}
            </>
          )
        }}
      </ReadState>
    </Panel>
  )
}

// ---- is work piling up? (a flow strip, not a chart) -------------------------------------------------------------------------

export function WipPanel({ model, actions }: Props) {
  const t = useT('home-dashboards')
  const read = model.wip
  return (
    <Panel
      id="wip"
      icon={<Layers size={16} aria-hidden />}
      title={t('wip.title')}
      hint={read.status === 'ready' ? t('wip.hint', { waiting: read.value.overall.waiting, workOrders: read.value.overall.workOrders }) : undefined}
      foot={model.mode === 'page' && read.status === 'ready' ? <Door prefix={model.prefix} href={wipHref(read.value.kpiKey, model.built)}>{t('wip.open')}</Door> : null}
    >
      <ReadState read={read} rows={2} onRetry={() => actions?.onRetry?.('wip')}>
        {(value) =>
          value.stages.length === 0 ? (
            <p className="fw-dash-calm">{t('wip.none')}</p>
          ) : (
            <ol className="fw-dash-flow" aria-label={t('wip.flowLabel')}>
              {value.stages.map((stage) => {
                const oldest = [...WIP_AGE_BUCKETS].reverse().find((bucket) => stage.ageing[bucket] > 0) ?? null
                return (
                  <li key={stage.code} className="fw-dash-stage">
                    <span className="fw-dash-stage-name">{stage.name}</span>
                    <strong className="fw-dash-stage-count">{t('wip.waiting', { count: stage.waiting })}</strong>
                    <span className="fw-dash-muted">{t('wip.workOrders', { count: stage.workOrders })}</span>
                    <span className="fw-dash-bands" aria-label={t('wip.bandsLabel', { stage: stage.name })}>
                      {WIP_AGE_BUCKETS.filter((bucket) => stage.ageing[bucket] > 0).map((bucket) => (
                        <Tag key={bucket} tone={bucket === 'D11_PLUS' ? 'danger' : bucket === 'D6_10' ? 'warning' : 'neutral'}>
                          {t(`wip.band.${bucket}`, { count: stage.ageing[bucket] })}
                        </Tag>
                      ))}
                    </span>
                    {oldest === 'D11_PLUS' || oldest === 'D6_10' ? <span className="fw-dash-muted">{t('wip.oldest', { band: t(`wip.bandName.${oldest}`) })}</span> : null}
                  </li>
                )
              })}
            </ol>
          )
        }
      </ReadState>
    </Panel>
  )
}

// ---- by company and site (the Owner's group view) ------------------------------------------------------------------------------

function cellText(cell: ByCompanyCell, unit: DashNumber['unit'], grain: DashNumber['grain'], tk: Translate, t: Translate, locale: 'it' | 'en'): string {
  if (cell.perCompanyOnly) return t('byCompany.perCompany')
  const said = numberText({ ...cell, unit, grain }, tk, locale)
  return said.problem ? `— · ${said.problem}` : said.text
}

export function ByCompanyPanel({ model, actions }: Props) {
  const t = useT('home-dashboards')
  const tk = useT('home-kpis')
  const locale = useLocale()
  const read = model.byCompany
  const drills = new Map(model.numbers.status === 'ready' ? model.numbers.value.numbers.map((number) => [number.kpiKey, number]) : [])
  return (
    <Panel id="by-company" icon={<Layers size={16} aria-hidden />} title={t('byCompany.title')} hint={read.status === 'ready' ? t('byCompany.hint', { period: periodText(read.value.period, tk, locale) }) : undefined}>
      <ReadState read={read} rows={4} onRetry={() => actions?.onRetry?.('byCompany')}>
        {(value) =>
          value.rows.length === 0 ? (
            <EmptyState icon={<Layers size={20} aria-hidden />} title={t('byCompany.none')} description={t('byCompany.noneBody')} />
          ) : (
            <SummaryTable
              label={t('byCompany.title')}
              stackOnPhone
              columns={[t('byCompany.place'), ...value.columns.map((column) => sayIn(column.name, locale))]}
              align={['left', ...value.columns.map(() => 'right' as const)]}
              rows={value.rows.map((row) => ({
                id: `${row.company.id}:${row.site?.id ?? ''}`,
                cells: [
                  <span key="place" className="fw-dash-place">
                    <EntityPath items={row.site ? [{ id: row.company.id, name: row.company.name }, { id: row.site.id, name: row.site.name }] : [{ id: row.company.id, name: row.company.name }]} label={t('byCompany.place')} />
                    {row.sites && row.sites.read < row.sites.of ? <span className="fw-dash-muted">{t('byCompany.partial', { read: row.sites.read, of: row.sites.of })}</span> : null}
                  </span>,
                  ...row.cells.map((cell, index) => {
                    const column = value.columns[index]!
                    const text = cellText(cell, column.unit, column.grain, tk, t, locale)
                    const number = drills.get(cell.kpiKey)
                    const href = number && !cell.perCompanyOnly && model.mode === 'page' ? recordsHrefOf({ ...number, period: value.period }, model.built) : null
                    return href && row.site === null ? (
                      <Link key={cell.kpiKey} className="fw-dash-link" href={companyHref(row.company.code, href)} title={t('byCompany.opensIn', { company: row.company.name })}>
                        {text}
                      </Link>
                    ) : (
                      <span key={cell.kpiKey} className={cell.perCompanyOnly ? 'fw-dash-muted' : undefined}>
                        {text}
                        {cell.stale ? ` · ${t('numbers.stale')}` : ''}
                      </span>
                    )
                  }),
                ],
              }))}
            />
          )
        }
      </ReadState>
    </Panel>
  )
}

// ---- a pinned report (follow-up DB1:01) ---------------------------------------------------------------------------------------

export function PinnedReportPanel({ model, pinned }: { model: DashboardsModel; pinned: PinnedPanel }) {
  const t = useT('home-dashboards')
  const tr = useT('home-reports')
  const title = pinned.kind === 'report' ? tr(`report.${pinned.key}.title`) : t(`pinned.${pinned.area}.${pinned.panel}`)
  const where = pinned.kind === 'report' ? t('pinned.fromPack') : t('pinned.fromArea', { area: t(`pinned.area.${pinned.area}`) })
  const href = pinned.kind === 'report' ? (model.built.has('/home/reports/[key]') ? `/home/reports/${encodeURIComponent(pinned.key)}` : null) : model.built.has(pinned.page) ? pinned.page : null
  return (
    <Panel id={pinned.id.replace(/[^a-z0-9-]/g, '-')} icon={<Pin size={16} aria-hidden />} title={title} hint={where} foot={model.mode === 'page' ? <Door prefix={model.prefix} href={href}>{t('pinned.open')}</Door> : null}>
      <p className="fw-dash-muted">{pinned.kind === 'report' ? t('pinned.reportBody') : t('pinned.panelBody')}</p>
    </Panel>
  )
}
