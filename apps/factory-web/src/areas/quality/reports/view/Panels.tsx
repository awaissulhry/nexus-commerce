'use client'

import Link from 'next/link'
import { useEffect, useState, type ReactNode } from 'react'
import { Card, DetailPopover, EmptyState, MetricStrip, PerformanceGraph, Sparkline, SummaryTable, type Metric } from '@nexus/ui/components'
import { Button, SegmentedControl, Select, Skeleton, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { DIMENSIONS, KPI_KEYS, type Compare, type Dimension, type Incoming, type Kpis, type KpiKey, type TrendWeek } from '../api'
import { changeWords, closuresOf, countText, daysIn, hiddenWeeks, kpiValueText, oneText, pctText, refLabel, rowHref, sparkValues, supplierHref, tileHeld, tileHref, trendRows, weekLabel } from '../model'
import type { Read, ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const day = (date: string, locale: 'it' | 'en') => formatDate(`${date}T12:00:00Z`, { locale })

/** The panel's head: its title, what it says, and its own controls. */
function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-qr-head">
      <div className="fw-qr-head-text">
        <h2 className="fw-qr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-qr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-qr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons (design: "Skeleton of the panel's shape"). */
function Shape({ kind }: { kind: 'tiles' | 'chart' | 'table' }) {
  const t = useT('quality-reports')
  return (
    <div className={`fw-qr-shape fw-qr-shape-${kind}`} role="status" aria-label={t('common.loading')}>
      {kind === 'tiles' ? (
        Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={72} radius={8} />)
      ) : kind === 'chart' ? (
        <Skeleton height={220} radius={8} />
      ) : (
        Array.from({ length: 5 }, (_, index) => <Skeleton key={index} height={20} />)
      )}
    </div>
  )
}

/** The panel failed: what failed in words, and Try again; the rest of the page stays usable. */
function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT('quality-reports')
  const quality = useT('quality')
  return (
    <EmptyState
      title={title}
      description={quality(problem)}
      action={
        <Button size="sm" onClick={() => onRetry?.()}>
          {t('common.retry')}
        </Button>
      }
    />
  )
}

/** The read's state when it is not ready: loading, failed, or nothing to say (no site, idle). */
function stateOf<T>(read: Read<T>, failedTitle: string, shape: 'tiles' | 'chart' | 'table', onRetry?: () => void): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape kind={shape} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

// ---- Quality KPIs (qr-kpi) -------------------------------------------------------------------------------------------------------

const KPI_SIGHT: Readonly<Record<KpiKey, keyof Kpis['sight']>> = { fpy: 'inprocess', dhu: 'inprocess', aqlPass: 'inspections', ncrOpen: 'ncr', capaOnTime: 'capa', holdsOld: 'holds' }

/** What a tile stands on, in words ("38 of 40 pieces at end of line"), or why it shows nothing. */
function tileHint(kpi: KpiKey, value: Kpis, t: ReturnType<typeof useT>, locale: 'it' | 'en'): string {
  if (!value.sight[KPI_SIGHT[kpi]]) return t('tile.notInRole')
  const kpis = value.kpis
  if (kpi === 'ncrOpen') {
    const entry = kpis.ncrOpen!
    return entry.value === 0 ? t('tile.ncrNone') : t('tile.ncrAge', { days: oneText(entry.averageAgeDays, locale) })
  }
  if (kpi === 'holdsOld') return t('tile.holdsHint')
  const rate = kpis[kpi]!
  if (rate.tooFew) return t('tooFew', { count: value.minimumGroupSize })
  if (rate.whole === null || rate.whole === 0) return t(`tile.empty.${kpi}`)
  return t(`tile.basis.${kpi}`, { part: countText(rate.part, locale), whole: countText(rate.whole, locale), checks: countText(rate.checks, locale) })
}

export function KpiPanel({ model, actions }: Props) {
  const t = useT('quality-reports')
  const locale = useLocale()
  const read = model.kpis
  const state = stateOf(read, t('kpi.failed'), 'tiles', () => actions?.onRetry?.('kpi'))
  const value = read.status === 'ready' ? read.value : null
  const days = daysIn(model.range)
  const metrics: Metric[] = value
    ? KPI_KEYS.map((kpi) => {
        const seen = value.sight[KPI_SIGHT[kpi]]
        const entry = value.kpis[kpi]
        const change = seen && model.address.compare ? changeWords(kpi, entry?.change ?? null, days, locale) : null
        const href = seen ? tileHref(kpi, model.prefix, model.can, model.scope.siteId, model.address) : null
        const held = seen && !href ? tileHeld(kpi, model.can) : null
        const spark = kpi === 'fpy' || kpi === 'dhu' || kpi === 'aqlPass' ? sparkValues(value.kpis[kpi]) : []
        const hint = (
          <span className="fw-qr-tile-hint">
            <span>{tileHint(kpi, value, t, locale)}</span>
            {held ? <span className="fw-qr-muted">{t(held)}</span> : null}
            {spark.length > 1 && spark.some((point) => point !== null) ? (
              <Sparkline values={spark} label={t('tile.sparkLabel', { label: t(`kpi.${kpi}`) })} shape="line" domain={kpi === 'dhu' ? [0, null] : [null, 100]} format={(n) => (kpi === 'dhu' ? oneText(String(n), locale) : pctText(String(n), locale))} emptyLabel={t('tile.sparkEmpty')} fluid height={22} />
            ) : null}
          </span>
        )
        return {
          label: t(`kpi.${kpi}`),
          value: seen ? kpiValueText(kpi, value.kpis, locale) : '—',
          hint,
          ...(change ? { delta: { value: `${change.arrow} ${t(change.key, change.params)}`, tone: change.tone } } : {}),
          ...(href ? { href } : {}),
        }
      })
    : []
  return (
    <Card padded>
      <section aria-labelledby="fw-qr-kpi" className="fw-qr-panel" id="fw-qr-kpis">
        <Head id="fw-qr-kpi" title={t('section.kpi')} hint={t('kpi.hint')} />
        {state ?? (
          <>
            <MetricStrip metrics={metrics} minTileWidth={170} />
            {value?.amendments && value.amendments.signed > 0 ? <p className="fw-qr-hint">{t('kpi.amendments', { count: value.amendments.signed })}</p> : null}
            {value?.previous && model.address.compare ? <p className="fw-qr-hint">{t('kpi.previous', { from: day(value.previous.from, locale), to: day(value.previous.to, locale) })}</p> : null}
          </>
        )}
      </section>
    </Card>
  )
}

// ---- Trend (qr-trend) --------------------------------------------------------------------------------------------------------------

function WeekPopover({ week, model, open }: { week: TrendWeek; model: ReportsModel; open?: boolean }) {
  const t = useT('quality-reports')
  const locale = useLocale()
  const label = weekLabel(week.week)
  const inspections = model.can.inspections ? `${model.prefix}/quality/inspections?view=all` : null
  return (
    <DetailPopover
      trigger={
        <span className="fw-qr-week-trigger">
          <span className="fw-qr-week-label">{label}</span>
          <span className="fw-qr-muted">{week.tooFew ? t('trend.weekHidden') : pctText(week.fpy, locale)}</span>
        </span>
      }
      triggerLabel={t('trend.weekOpen', { week: label, from: day(week.from, locale), to: day(week.to, locale) })}
      triggerClassName="fw-qr-week"
      label={t('trend.weekTitle', { week: label })}
      {...(open ? { open: true } : {})}
    >
      <div className="fw-qr-pop">
        <p className="fw-qr-pop-title">{t('trend.weekRange', { week: label, from: day(week.from, locale), to: day(week.to, locale) })}</p>
        {week.tooFew ? (
          <p className="fw-qr-hint">{t('tooFew', { count: model.trend.status === 'ready' ? model.trend.value.minimumGroupSize : 3 })}</p>
        ) : (
          <dl className="fw-qr-pop-list">
            <dt>{t('kpi.fpy')}</dt>
            <dd>{pctText(week.fpy, locale)}</dd>
            <dt>{t('kpi.dhu')}</dt>
            <dd>{oneText(week.dhu, locale)}</dd>
            <dt>{t('trend.pieces')}</dt>
            <dd>{countText(week.pieces, locale)}</dd>
            <dt>{t('trend.checks')}</dt>
            <dd>{countText(week.checks, locale)}</dd>
          </dl>
        )}
        <dl className="fw-qr-pop-list">
          <dt>{t('kpi.aqlPass')}</dt>
          <dd>{week.aql ? t('trend.aql', { pct: pctText(week.aql.pct, locale), passed: week.aql.passed, decided: week.aql.decided }) : week.aqlTooFew ? t('tooFewShort') : '—'}</dd>
          {week.capaClosed ? (
            <>
              <dt>{t('trend.capaClosed')}</dt>
              <dd>{week.capaClosed.count === 0 ? '—' : week.capaClosed.capas.map((capa) => capa.number).join(', ') + (week.capaClosed.count > week.capaClosed.capas.length ? ` ${t('trend.more', { count: week.capaClosed.count - week.capaClosed.capas.length })}` : '')}</dd>
            </>
          ) : null}
        </dl>
        {inspections ? (
          <Link className="fw-qr-link" href={inspections}>
            {t('trend.openInspections')}
          </Link>
        ) : null}
      </div>
    </DetailPopover>
  )
}

export function TrendPanel({ model, actions }: Props) {
  const t = useT('quality-reports')
  const locale = useLocale()
  const read = model.trend
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('trend.failed'), 'chart', () => actions?.onRetry?.('trend'))
  const rows = value ? trendRows(value.weeks) : []
  const anything = rows.some((row) => row.fpy !== undefined || row.dhu !== undefined)
  const closures = value ? closuresOf(value.weeks) : []
  const hidden = value ? hiddenWeeks(value.weeks) : 0
  // A pop-over draws through a portal: a design case opens it once the page is on the client.
  const [openWeek, setOpenWeek] = useState<string | undefined>(undefined)
  useEffect(() => setOpenWeek(model.openWeek), [model.openWeek])
  return (
    <Card padded>
      <section aria-labelledby="fw-qr-trend" className="fw-qr-panel" id="fw-qr-trends">
        <Head id="fw-qr-trend" title={t('section.trend')} hint={t('trend.hint')}>
          {value && value.lines.length > 0 ? (
            <Select size="sm" aria-label={t('trend.line')} value={model.address.lineId ?? ''} onChange={(event) => actions?.onAddress?.({ lineId: event.target.value || null })}>
              <option value="">{t('trend.allLines')}</option>
              {value.lines.map((line) => (
                <option key={line.id} value={line.id}>{`${line.code} · ${line.name}`}</option>
              ))}
            </Select>
          ) : null}
        </Head>
        {state ??
          (value && !value.sight.inprocess && !value.sight.inspections ? (
            <EmptyState title={t('trend.notInRole')} description={t('trend.notInRoleBody')} />
          ) : (
            <>
              {anything ? (
                <figure className="fw-qr-chart" aria-label={t('trend.chartLabel')}>
                  <PerformanceGraph
                    data={rows}
                    xKey="week"
                    left={{ key: 'fpy', label: t('kpi.fpy'), axisLabel: t('trend.fpyAxis'), color: chart.positive, axis: 'left', format: (n) => pctText(String(n), locale) }}
                    right={{ key: 'dhu', label: t('kpi.dhu'), axisLabel: t('trend.dhuAxis'), color: chart.negative, axis: 'right', shape: 'bar', format: (n) => oneText(String(n), locale) }}
                    height={240}
                  />
                  <figcaption className="fw-qr-hint">{t('trend.caption')}</figcaption>
                </figure>
              ) : (
                <EmptyState title={t('trend.empty')} description={hidden > 0 ? t('trend.emptyHidden') : t('trend.emptyBody')} />
              )}
              {value ? (
                <ul className="fw-qr-weeks" aria-label={t('trend.weeksLabel')}>
                  {value.weeks.map((week) => (
                    <li key={week.week}>
                      <WeekPopover week={week} model={model} open={openWeek === week.week} />
                    </li>
                  ))}
                </ul>
              ) : null}
              {hidden > 0 ? <p className="fw-qr-hint">{t('trend.hidden', { count: hidden, minimum: value?.minimumGroupSize ?? 3 })}</p> : null}
              {value?.sight.capa ? (
                <p className="fw-qr-hint">
                  {closures.length === 0
                    ? t('trend.noClosures')
                    : t('trend.closures', { list: closures.map((entry) => `${weekLabel(entry.week)}: ${entry.capas.map((capa) => capa.number).join(', ')}${entry.more > 0 ? ` +${entry.more}` : ''}`).join(' · ') })}
                </p>
              ) : null}
            </>
          ))}
      </section>
    </Card>
  )
}

// ---- By line, operation, supplier and style (qr-table) -----------------------------------------------------------------------------

function CompareTable({ value, model }: { value: Compare; model: ReportsModel }) {
  const t = useT('quality-reports')
  const locale = useLocale()
  if (value.rows.length === 0) return <EmptyState title={t('table.empty')} description={t(`table.emptyBody.${value.by}`)} />
  return (
    <SummaryTable
      label={t('table.tableLabel', { by: t(`dimension.${value.by}`) })}
      stackOnPhone
      columns={[t(`dimension.${value.by}`), t('table.inspected'), t('table.defects'), t('table.dhu'), t('table.aql'), t('table.ncrs')]}
      widths={['34%', '13%', '13%', '12%', '16%', undefined]}
      align={[undefined, 'right', 'right', 'right', 'right', 'right']}
      rows={value.rows.map((row) => {
        const label = refLabel(row.ref) ?? t(`table.none.${value.by}`)
        const href = rowHref(value.by, row, model.prefix, model.can)
        const name = href ? (
          <Link key="n" className="fw-qr-link" href={href}>
            {label}
          </Link>
        ) : (
          label
        )
        if (row.tooFew) return { id: row.key, cells: [name, <Tag key="f" tone="neutral">{t('tooFewShort')}</Tag>, '—', '—', '—', '—'] }
        return {
          id: row.key,
          cells: [
            name,
            countText(row.inspected, locale),
            countText(row.defects, locale),
            oneText(row.dhu, locale),
            row.aql ? (row.aql.decided === 0 ? '—' : t('table.aqlCell', { pct: pctText(row.aql.pct, locale), passed: row.aql.passed, decided: row.aql.decided })) : '—',
            countText(row.ncrs, locale),
          ],
        }
      })}
    />
  )
}

export function ComparePanel({ model, actions }: Props) {
  const t = useT('quality-reports')
  const read = model.compare
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('table.failed'), 'table', () => actions?.onRetry?.('table'))
  const by: Dimension = model.address.by
  const nothingSeen = value && !value.sight.counts && !value.sight.aql && !value.sight.ncrs
  return (
    <Card padded>
      <section aria-labelledby="fw-qr-table-title" className="fw-qr-panel" id="fw-qr-table">
        <Head id="fw-qr-table-title" title={t('section.table')} hint={t('table.hint')}>
          <SegmentedControl size="sm" wrap ariaLabel={t('table.by')} value={by} onChange={(next) => actions?.onDimension?.(next as Dimension)} options={DIMENSIONS.map((dimension) => ({ value: dimension, label: t(`dimension.${dimension}`) }))} />
        </Head>
        {state ??
          (nothingSeen ? (
            <EmptyState title={t('table.notInRole')} description={t(`table.notInRoleBody.${by}`)} />
          ) : value ? (
            <>
              <CompareTable value={value} model={model} />
              <p className="fw-qr-hint">{t(`table.source.${value.by}`)}</p>
              {value.hidden > 0 ? <p className="fw-qr-hint">{t('table.hidden', { count: value.hidden, minimum: value.minimumGroupSize })}</p> : null}
            </>
          ) : null)}
      </section>
    </Card>
  )
}

// ---- Incoming quality (qr-supplier) ------------------------------------------------------------------------------------------------

export function IncomingPanel({ model, actions }: Props) {
  const t = useT('quality-reports')
  const locale = useLocale()
  const read = model.incoming
  const value: Incoming | null = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('incoming.failed'), 'table', () => actions?.onRetry?.('supplier'))
  return (
    <Card padded>
      <section aria-labelledby="fw-qr-supplier-title" className="fw-qr-panel" id="fw-qr-supplier">
        <Head id="fw-qr-supplier-title" title={t('section.supplier')} hint={t('incoming.hint')} />
        {state ??
          (value && !value.sight.incoming && !value.sight.lots ? (
            <EmptyState title={t('incoming.notInRole')} description={t('incoming.notInRoleBody')} />
          ) : value && value.suppliers.length === 0 ? (
            <EmptyState title={t('incoming.empty')} description={t('incoming.emptyBody')} />
          ) : value ? (
            <>
              <SummaryTable
                label={t('incoming.tableLabel')}
                stackOnPhone
                columns={[t('incoming.supplier'), t('incoming.lots'), t('incoming.rejected'), t('incoming.crVi'), t('incoming.days'), t('incoming.inspections'), t('incoming.failedInspections')]}
                widths={['28%', '11%', '11%', '11%', '14%', '12%', undefined]}
                align={[undefined, 'right', 'right', 'right', 'right', 'right', 'right']}
                rows={value.suppliers.map((row) => {
                  const label = row.party ? `${row.party.code} · ${row.party.name}` : t('incoming.noSupplier')
                  const href = supplierHref(row, model.prefix, model.can)
                  return {
                    id: row.party?.id ?? 'none',
                    cells: [
                      <span key="s" className="fw-qr-supplier">
                        {href ? (
                          <Link className="fw-qr-link" href={href}>
                            {label}
                          </Link>
                        ) : (
                          label
                        )}
                        {row.workshop ? <Tag tone="info">{t('incoming.workshop')}</Tag> : null}
                      </span>,
                      countText(row.lotsReceived, locale),
                      countText(row.rejected, locale),
                      row.crViFails && row.crViFails > 0 ? <Tag key="c" tone="danger">{countText(row.crViFails, locale)}</Tag> : countText(row.crViFails, locale),
                      row.averageQuarantineDays === null ? '—' : t('incoming.daysCell', { days: oneText(row.averageQuarantineDays, locale), waiting: row.inQuarantine ?? 0 }),
                      countText(row.inspections, locale),
                      countText(row.inspectionsFailed, locale),
                    ],
                  }
                })}
              />
              {!value.sight.lots ? <p className="fw-qr-hint">{t('incoming.noLots')}</p> : null}
              {!value.sight.incoming ? <p className="fw-qr-hint">{t('incoming.noInspections')}</p> : null}
              <p className="fw-qr-hint">{t('incoming.rowHint')}</p>
            </>
          ) : null)}
      </section>
    </Card>
  )
}
