'use client'

import Link from 'next/link'
import type { ReactNode } from 'react'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Card, EmptyState, MetricStrip, Sparkline, SummaryTable, type Metric } from '@nexus/ui/components'
import { LimitMeter } from '@nexus/ui/components/LimitMeter/index'
import { Button, Skeleton, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { INTL_LOCALE } from '../../../../lib/i18n/locales'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { KPI_KEYS, type ExpiryItem, type Kpis, type KpiKey } from '../api'
import {
  boardBuilt,
  countText,
  expiryHref,
  failedLotsHref,
  gapHref,
  KPI_SIGHT,
  kpiValueText,
  mgNumber,
  mgText,
  monthLabel,
  oneText,
  pctText,
  refLabel,
  refusalsByGate,
  registerHref,
  supplierHref,
  tileHeld,
  tileHref,
} from '../model'
import type { Read, ReportsActions, ReportsModel } from './types'

type Props = { model: ReportsModel; actions?: ReportsActions | undefined }

const dayText = (date: string, locale: 'it' | 'en') => formatDate(`${date}T12:00:00Z`, { locale })

/** The panel's head: its title, what it says, and its own controls. */
function Head({ id, title, hint, children }: { id: string; title: string; hint?: string | undefined; children?: ReactNode }) {
  return (
    <div className="fw-cr-head">
      <div className="fw-cr-head-text">
        <h2 className="fw-cr-h2" id={id}>
          {title}
        </h2>
        {hint ? <p className="fw-cr-hint">{hint}</p> : null}
      </div>
      {children ? <div className="fw-cr-head-controls">{children}</div> : null}
    </div>
  )
}

/** Loading: the panel's shape in skeletons (design: "Skeleton of the panel's shape"). */
function Shape({ kind }: { kind: 'tiles' | 'bars' | 'months' | 'table' }) {
  const t = useT('compliance-reports')
  return (
    <div className={`fw-cr-shape fw-cr-shape-${kind}`} role="status" aria-label={t('common.loading')}>
      {kind === 'tiles'
        ? Array.from({ length: 6 }, (_, index) => <Skeleton key={index} height={72} radius={8} />)
        : kind === 'months'
          ? Array.from({ length: 12 }, (_, index) => <Skeleton key={index} height={64} radius={8} />)
          : Array.from({ length: kind === 'bars' ? 6 : 5 }, (_, index) => <Skeleton key={index} height={kind === 'bars' ? 24 : 20} />)}
    </div>
  )
}

/** The panel failed: what failed in words, and Try again; the rest of the page stays usable. */
function Failed({ title, problem, onRetry }: { title: string; problem: string; onRetry?: (() => void) | undefined }) {
  const t = useT('compliance-reports')
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

function stateOf<T>(read: Read<T>, failedTitle: string, shape: 'tiles' | 'bars' | 'months' | 'table', onRetry?: () => void): ReactNode | null {
  if (read.status === 'loading' || read.status === 'idle') return <Shape kind={shape} />
  if (read.status === 'error') return <Failed title={failedTitle} problem={read.problem} onRetry={onRetry} />
  return null
}

/** A link when there is somewhere to go, else the words alone. */
function MaybeLink({ href, children }: { href: string | null; children: ReactNode }) {
  return href ? (
    <Link className="fw-cr-link" href={href}>
      {children}
    </Link>
  ) : (
    <>{children}</>
  )
}

// ---- Coverage KPIs (cr-kpi) ------------------------------------------------------------------------------------------------------

/** What a tile stands on, in words, or why it shows nothing. */
function tileHint(kpi: KpiKey, value: Kpis, t: ReturnType<typeof useT>, locale: 'it' | 'en'): string {
  if (!KPI_SIGHT[kpi].every((sight) => value.sight[sight])) return t('tile.notInRole')
  const k = value.kpis
  switch (kpi) {
    case 'coverage':
      return k.coverage && k.coverage.needing > 0 ? t('tile.coverage', { covered: countText(k.coverage.covered, locale), needing: countText(k.coverage.needing, locale), expiring: k.coverage.expiring }) : t('tile.coverageNone')
    case 'shipped':
      if (!k.shipped || k.shipped.pairs === 0) return t('tile.shippedNone')
      return [t('tile.shipped', { covered: countText(k.shipped.covered, locale), needing: countText(k.shipped.needing, locale), shipments: k.shipped.shipments }), k.shipped.unknown > 0 ? t('tile.shippedUnknown', { count: k.shipped.unknown }) : null].filter(Boolean).join(' · ')
    case 'gaps':
      return k.gaps?.crViCounted ? t('tile.gaps') : t('tile.gapsNoLots')
    case 'refusals': {
      if (!k.refusals || k.refusals.count === 0) return t('tile.refusalsNone', { overridden: k.refusals?.overridden ?? 0 })
      const gates = refusalsByGate(k.refusals.byGate).map((entry) => `${t(`gate.${entry.gate}`)} ${countText(entry.count, locale)}`).join(' · ')
      return t('tile.refusals', { gates, overridden: k.refusals.overridden })
    }
    case 'registerOpen':
      return t('tile.registerOpen', { count: k.registerOpen?.risk ?? 0 })
    case 'crViLots':
      return k.crViLots && k.crViLots.lots > 0 ? t('tile.crViLots', { with: countText(k.crViLots.withEvidence, locale), lots: countText(k.crViLots.lots, locale) }) : t('tile.crViLotsNone')
  }
}

export function KpiPanel({ model, actions }: Props) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const read = model.kpis
  const state = stateOf(read, t('kpi.failed'), 'tiles', () => actions?.onRetry?.('kpi'))
  const value = read.status === 'ready' ? read.value : null
  const metrics: Metric[] = value
    ? KPI_KEYS.map((kpi) => {
        const seen = KPI_SIGHT[kpi].every((sight) => value.sight[sight])
        const href = seen ? tileHref(kpi, model.prefix, model.can) : null
        const held = seen && !href ? tileHeld(kpi, model.can) : null
        const hint = (
          <span className="fw-cr-tile-hint">
            <span>{tileHint(kpi, value, t, locale)}</span>
            {kpi === 'crViLots' && seen ? <span className="fw-cr-muted">{t('tile.crViTarget')}</span> : null}
            {held ? <span className="fw-cr-muted">{t(held)}</span> : null}
          </span>
        )
        return { label: t(`kpi.${kpi}`), value: seen ? kpiValueText(kpi, value.kpis, locale) : '—', hint, ...(href ? { href } : {}) }
      })
    : []
  return (
    <Card padded>
      <section aria-labelledby="fw-cr-kpi" className="fw-cr-panel" id="fw-cr-kpis">
        <Head id="fw-cr-kpi" title={t('section.kpi')} hint={t('kpi.hint')} />
        {state ?? (
          <>
            <MetricStrip metrics={metrics} minTileWidth={180} />
            {value?.styles?.more ? <p className="fw-cr-hint">{t('kpi.partial', { count: value.styles.read })}</p> : null}
            {value?.styles ? <p className="fw-cr-hint">{t('kpi.markets', { markets: value.styles.markets.map((market) => market.name).join(', ') || '—', count: value.styles.read })}</p> : null}
          </>
        )}
      </section>
    </Card>
  )
}

// ---- Gaps by type (cr-gaps) -------------------------------------------------------------------------------------------------------

export function GapsPanel({ model, actions }: Props) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.gaps
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('gaps.failed'), 'bars', () => actions?.onRetry?.('gaps'))
  const rows = value?.rows ?? []
  const nothingSeen = value !== null && rows.length === 0 && !value.sight.certificates && !value.sight.lots
  const total = rows.reduce((sum, row) => sum + row.count, 0)
  return (
    <Card padded>
      <section aria-labelledby="fw-cr-gaps-title" className="fw-cr-panel" id="fw-cr-gaps">
        <Head id="fw-cr-gaps-title" title={t('section.gaps')} hint={t('gaps.hint')} />
        {state ??
          (nothingSeen ? (
            <EmptyState title={t('gaps.notInRole')} description={t('gaps.notInRoleBody')} />
          ) : value && total === 0 ? (
            <EmptyState title={t('gaps.empty')} description={t('gaps.emptyBody')} />
          ) : value ? (
            <>
              <BarList
                label={t('gaps.chartLabel')}
                format={(n) => countText(n, locale)}
                labels={ds.barList}
                items={rows.map((row) => {
                  const href = gapHref(row.type, model.prefix, model.can)
                  const sub = row.type === 'crVi' ? t('gaps.crViSub') : t('gaps.sub', { styles: row.styles ?? 0, markets: row.markets ?? 0, blocking: row.blocking ?? 0 })
                  return { id: row.type, label: t(`gap.${row.type}`), sub, value: row.count, ...(href ? { href } : {}), ...(row.blocking && row.blocking > 0 ? { tone: 'danger' as const } : row.count > 0 ? { tone: 'warning' as const } : {}) }
                })}
              />
              <SummaryTable
                label={t('gaps.tableLabel')}
                stackOnPhone
                columns={[t('gaps.type'), t('gaps.count'), t('gaps.styles'), t('gaps.markets'), t('gaps.blocking'), t('gaps.requirements')]}
                widths={['22%', '10%', '10%', '10%', '14%', undefined]}
                align={[undefined, 'right', 'right', 'right', 'right', 'left']}
                rows={rows.map((row) => ({
                  id: row.type,
                  cells: [
                    <MaybeLink key="t" href={gapHref(row.type, model.prefix, model.can)}>
                      {t(`gap.${row.type}`)}
                    </MaybeLink>,
                    countText(row.count, locale),
                    countText(row.styles, locale),
                    countText(row.markets, locale),
                    countText(row.blocking, locale),
                    row.requirements.length > 0 ? row.requirements.join(', ') : '—',
                  ],
                }))}
              />
              <p className="fw-cr-hint">{boardBuilt() ? t('gaps.boardOpen') : t('gaps.boardHint')}</p>
              {value.styles?.more ? <p className="fw-cr-hint">{t('kpi.partial', { count: value.styles.read })}</p> : null}
            </>
          ) : null)}
      </section>
    </Card>
  )
}

// ---- Expiry calendar (cr-expiry) ------------------------------------------------------------------------------------------------

function ExpiryChip({ item, model }: { item: ExpiryItem; model: ReportsModel }) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const what = item.recordType === 'Certificate' ? t('expiry.certificate', { label: item.label, detail: item.detail ?? '' }) : t('expiry.declaration', { label: item.label, kind: item.detail ? t(`declaration.${item.detail}`) : '', party: item.party ?? '' })
  const tone = item.status === 'SUSPENDED' || item.endsWithBase ? 'warning' : item.recordType === 'Certificate' ? 'info' : 'neutral'
  return (
    <li className="fw-cr-chip-item">
      <Link className="fw-cr-chip" href={expiryHref(item, model.prefix)} aria-label={t('expiry.chipLabel', { what, date: dayText(item.validTo, locale) })}>
        <Tag tone={tone}>{item.recordType === 'Certificate' ? t('expiry.kindCertificate') : t('expiry.kindDeclaration')}</Tag>
        <span className="fw-cr-chip-text">
          <span className="fw-cr-chip-label">{item.label}</span>
          <span className="fw-cr-muted">{dayText(item.validTo, locale)}</span>
        </span>
      </Link>
      {item.status === 'SUSPENDED' ? <span className="fw-cr-muted">{t('expiry.suspended')}</span> : null}
      {item.endsWithBase ? <span className="fw-cr-muted">{t('expiry.endsWithBase')}</span> : null}
    </li>
  )
}

export function ExpiryPanel({ model, actions }: Props) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const read = model.expiries
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('expiry.failed'), 'months', () => actions?.onRetry?.('expiry'))
  return (
    <Card padded>
      <section aria-labelledby="fw-cr-expiry-title" className="fw-cr-panel" id="fw-cr-expiry">
        <Head id="fw-cr-expiry-title" title={t('section.expiry')} hint={value ? t('expiry.hintRange', { from: dayText(value.from, locale), to: dayText(value.to, locale) }) : t('expiry.hint')} />
        {state ??
          (value && !value.sight.certificates ? (
            <EmptyState title={t('expiry.notInRole')} description={t('expiry.notInRoleBody')} />
          ) : value && value.count === 0 ? (
            <EmptyState title={t('expiry.empty')} description={t('expiry.emptyBody')} />
          ) : value ? (
            <>
              <ol className="fw-cr-months" aria-label={t('expiry.monthsLabel')}>
                {value.months.map((month) => (
                  <li key={month.month} className="fw-cr-month">
                    <p className="fw-cr-month-head">
                      <span className="fw-cr-month-name">{monthLabel(month.month, locale)}</span>
                      <span className="fw-cr-muted">{month.count === 0 ? '—' : t('expiry.count', { count: month.count })}</span>
                    </p>
                    {month.items.length > 0 ? (
                      <ul className="fw-cr-chips">
                        {month.items.map((item) => (
                          <ExpiryChip key={`${item.recordType}-${item.recordId}`} item={item} model={model} />
                        ))}
                      </ul>
                    ) : null}
                  </li>
                ))}
              </ol>
              {model.address.brandId ? <p className="fw-cr-hint">{t('expiry.brandHint')}</p> : null}
            </>
          ) : null)}
      </section>
    </Card>
  )
}

// ---- Cr VI results per supplier (cr-cr6) -------------------------------------------------------------------------------------------

export function Cr6Panel({ model, actions }: Props) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const ds = useDsWords()
  const read = model.cr6
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('cr6.failed'), 'table', () => actions?.onRetry?.('cr6'))
  const failed = failedLotsHref(model.prefix, model.can)
  return (
    <Card padded>
      <section aria-labelledby="fw-cr-cr6-title" className="fw-cr-panel" id="fw-cr-cr6">
        <Head id="fw-cr-cr6-title" title={t('section.cr6')} hint={t('cr6.hint')} />
        {state ??
          (value && !value.sight.lots ? (
            <EmptyState title={t('cr6.notInRole')} description={t('cr6.notInRoleBody')} />
          ) : value && value.suppliers.length === 0 ? (
            <EmptyState title={t('cr6.empty')} description={t('cr6.emptyBody')} />
          ) : value ? (
            <>
              <SummaryTable
                label={t('cr6.tableLabel')}
                stackOnPhone
                columns={[t('cr6.supplier'), t('cr6.lots'), t('cr6.median'), t('cr6.highest'), t('cr6.fails'), t('cr6.evidence')]}
                widths={['24%', '9%', '11%', '30%', '9%', undefined]}
                align={[undefined, 'right', 'right', 'left', 'right', 'left']}
                rows={value.suppliers.map((row) => {
                  const label = refLabel(row.party) ?? t('cr6.noSupplier')
                  const limit = mgNumber(row.limit)
                  return {
                    id: row.party?.id ?? 'none',
                    cells: [
                      <MaybeLink key="s" href={supplierHref(row.party, model.prefix, model.can)}>
                        {label}
                      </MaybeLink>,
                      countText(row.lots, locale),
                      mgText(row.median, locale),
                      <LimitMeter
                        key="m"
                        value={mgNumber(row.highest)}
                        unit={value.unit}
                        limit={limit}
                        belowDetection={row.measured === 0 && row.belowDetection > 0}
                        locale={INTL_LOCALE[locale]}
                        labels={ds.limitMeter}
                      />,
                      row.fails > 0 ? (
                        <MaybeLink key="f" href={failed}>
                          <Tag tone="danger">{countText(row.fails, locale)}</Tag>
                        </MaybeLink>
                      ) : (
                        countText(row.fails, locale)
                      ),
                      <span key="e" className="fw-cr-stack">
                        <span>{t('cr6.reports', { lot: row.lotReports, supplier: row.supplierReports })}</span>
                        {row.belowDetection > 0 ? <span className="fw-cr-muted">{t('cr6.belowDetection', { count: row.belowDetection })}</span> : null}
                      </span>,
                    ],
                  }
                })}
              />
              <p className="fw-cr-hint">{t('cr6.rowHint', { results: value.results })}</p>
            </>
          ) : null)}
      </section>
    </Card>
  )
}

// ---- Register summary (cr-register) ------------------------------------------------------------------------------------------------

export function RegisterPanel({ model, actions }: Props) {
  const t = useT('compliance-reports')
  const locale = useLocale()
  const read = model.register
  const value = read.status === 'ready' ? read.value : null
  const state = stateOf(read, t('register.failed'), 'table', () => actions?.onRetry?.('register'))
  return (
    <Card padded>
      <section aria-labelledby="fw-cr-register-title" className="fw-cr-panel" id="fw-cr-register">
        <Head id="fw-cr-register-title" title={t('section.register')} hint={t('register.hint')} />
        {state ??
          (value && !value.sight.register ? (
            <EmptyState title={t('register.notInRole')} description={t('register.notInRoleBody')} />
          ) : value ? (
            <>
              <SummaryTable
                label={t('register.tableLabel')}
                stackOnPhone
                columns={[t('register.kind'), t('register.opened'), t('register.closed'), t('register.openAtEnd'), t('register.median'), t('register.trend')]}
                widths={['24%', '11%', '11%', '13%', '15%', undefined]}
                align={[undefined, 'right', 'right', 'right', 'right', 'left']}
                rows={[
                  ...value.kinds.map((row) => ({
                    id: row.kind,
                    cells: [
                      <MaybeLink key="k" href={registerHref(row.kind, model.prefix, model.can, false)}>
                        {t(`kind.${row.kind}`)}
                      </MaybeLink>,
                      countText(row.opened, locale),
                      countText(row.closed, locale),
                      row.openAtEnd > 0 ? (
                        <MaybeLink key="o" href={registerHref(row.kind, model.prefix, model.can, true)}>
                          {countText(row.openAtEnd, locale)}
                        </MaybeLink>
                      ) : (
                        countText(row.openAtEnd, locale)
                      ),
                      row.medianDaysToClose === null ? '—' : t('register.days', { days: oneText(row.medianDaysToClose, locale) }),
                      <Sparkline key="s" values={row.months} label={t('register.sparkLabel', { kind: t(`kind.${row.kind}`) })} shape="step" domain={[0, null]} format={(n) => countText(n, locale)} emptyLabel={t('register.sparkEmpty')} fluid height={22} />,
                    ],
                  })),
                  ...(value.all
                    ? [
                        {
                          id: 'all',
                          cells: [
                            <strong key="a">{t('register.all')}</strong>,
                            countText(value.all.opened, locale),
                            countText(value.all.closed, locale),
                            countText(value.all.openAtEnd, locale),
                            value.all.medianDaysToClose === null ? '—' : t('register.days', { days: oneText(value.all.medianDaysToClose, locale) }),
                            '',
                          ],
                        },
                      ]
                    : []),
                ]}
              />
              <ul className="fw-cr-facts" aria-label={t('register.factsLabel')}>
                {value.notices ? <li>{t('register.notices', { sent: value.notices.sent, drafts: value.notices.drafts })}</li> : null}
                {value.recalls ? <li>{t('register.recalls', { active: value.recalls.active, closed: value.recalls.closed, out: countText(value.recalls.unitsStillOut, locale) })}</li> : null}
                {value.requests ? (
                  <li>
                    {t('register.requests', { received: value.requests.received, open: value.requests.open, overdue: value.requests.overdue })}{' '}
                    {value.requests.answered > 0 ? t('register.onTime', { onTime: value.requests.onTime, answered: value.requests.answered, pct: pctText(value.requests.onTimePct, locale) }) : t('register.noneAnswered')}
                  </li>
                ) : null}
              </ul>
              {value.months.length > 1 ? <p className="fw-cr-hint">{t('register.trendHint', { from: monthLabel(value.months[0]!, locale), to: monthLabel(value.months.at(-1)!, locale) })}</p> : null}
            </>
          ) : null)}
      </section>
    </Card>
  )
}
