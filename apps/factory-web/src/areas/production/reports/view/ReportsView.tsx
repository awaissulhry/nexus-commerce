'use client'

import Link from 'next/link'
import { ChevronLeft, ChevronRight, Mail, MoreHorizontal } from 'lucide-react'
import { Banner, Card, EmptyState, Menu, MetricStrip, PerformanceGraph, SummaryTable } from '@nexus/ui/components'
import { Button, Select, Spinner, Tag } from '@nexus/ui/primitives'
import { chart } from '@nexus/ui/tokens'
import { AsOf, DateField } from '../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../lib/i18n/provider'
import { WithMessages } from '../../../../record-panels/i18n'
import type { DailyLane, DailyReport, Subscription } from '../api'
import { anythingRecorded, chartData, lineHref, pctText, printHref, siteEfficiency, styleHref, weekdaysPhrase, type ReportAddress, type ReportsCan } from '../model'
import { SubscribeDialog, type SubscribeActions, type SubscribeModel } from './SubscribeDialog'
import '../reports.css'

export type LiveState = 'connecting' | 'live' | 'offline'

/** SCR-240 — Production reports' view model (ReportsView draws it and fetches nothing). */
export interface ReportsModel {
  readonly prefix: string
  readonly can: ReportsCan
  readonly address: ReportAddress
  readonly daily: { readonly value: DailyReport | null; readonly problem: string | null }
  /** My subscription to the shown site's report (null: none, or not read yet). */
  readonly mine: Subscription | null
  readonly live: LiveState
  /** The clock for AsOf (ms). */
  readonly now: number
  /** The "Email me this report" dialog, when open. */
  readonly dialog: SubscribeModel | null
}

export interface ReportsActions extends SubscribeActions {
  onSite?: (siteId: string) => void
  onDay?: (date: string) => void
  onRetry?: () => void
  onOpenSubscribe?: () => void
}

/**
 * SCR-240 — Production › Reports (design production.reports; MES-301): the band (as of, live, Email me the daily report
 * every morning, Print in a new tab), the scope (site, day: the previous working day, a date, the next day), and Daily
 * production: the day's tiles (good, scrap, rework, the lines' efficiency), bars per lane (good, scrap and rework
 * stacked; a line's efficiency on the right axis), and per lane its table by style and size, each style opening its work
 * orders and each line opening Floor now on it. Per line, work centre, style and size only, never per person
 * (Statuto dei Lavoratori art. 4), and the page says so. Cutting & yield, WIP ageing (W2b) and machine OEE (W3) come
 * with their waves.
 */
export function ReportsView({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  return (
    <WithMessages namespaces={['production-reports']}>
      <Reports model={model} actions={actions} />
    </WithMessages>
  )
}

function Reports({ model, actions }: { model: ReportsModel; actions?: ReportsActions }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const daily = model.daily.value
  const day = (date: string) => formatDate(`${date}T12:00:00Z`, { locale })
  const address: ReportAddress = { site: daily?.site.id ?? model.address.site, date: daily?.day ?? model.address.date }
  const mine = model.mine?.active ? model.mine : null
  const weekdays = mine ? weekdaysPhrase(mine.weekdays) : null

  if (!model.can.view) {
    return (
      <div className="fw-prr">
        <EmptyState title={t('noAccess.title')} description={t('noAccess.body')} />
      </div>
    )
  }

  return (
    <div className="fw-prr">
      <div className="fw-prr-band" role="group" aria-label={t('band.label')}>
        <div className="fw-prr-status">
          {daily ? <AsOf at={daily.asOf} now={model.now} /> : <span className="fw-prr-muted">{t('band.reading')}</span>}
          <Tag tone={model.live === 'live' ? 'success' : model.live === 'offline' ? 'warning' : 'neutral'}>{t(`live.${model.live}`)}</Tag>
          {mine && weekdays && (
            <span className="fw-prr-muted fw-prr-inline">
              <Mail size={14} aria-hidden /> {t('band.subscribed', { time: mine.sendTime, days: t(weekdays.key, weekdays.params) })}
            </span>
          )}
        </div>
        <div className="fw-prr-actions">
          <Menu
            label={<MoreHorizontal size={16} aria-hidden />}
            align="right"
            triggerProps={{ 'aria-label': t('band.more') }}
            items={[
              { id: 'email', label: mine ? t('band.emailChange') : t('band.email'), onSelect: () => actions?.onOpenSubscribe?.(), ...(daily ? {} : { disabled: true, description: t('band.emailHeld') }) },
              { id: 'print', label: t('band.print'), href: printHref(model.prefix, address), target: '_blank' },
            ]}
          />
        </div>
      </div>

      <div className="fw-prr-scope" role="group" aria-label={t('scope.label')}>
        {daily && daily.sites.length > 1 && (
          <label className="fw-prr-inline">
            <span className="fw-prr-muted">{t('scope.site')}</span>
            <Select size="sm" value={daily.site.id} onChange={(event) => actions?.onSite?.(event.target.value)}>
              {daily.sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {`${site.code} · ${site.name}`}
                </option>
              ))}
            </Select>
          </label>
        )}
        {daily && daily.sites.length === 1 && <span className="fw-prr-muted">{`${daily.site.code} · ${daily.site.name}`}</span>}
        <span className="fw-prr-inline">
          <Button size="sm" onClick={() => daily?.previousWorkingDay && actions?.onDay?.(daily.previousWorkingDay)} heldReason={daily?.previousWorkingDay ? undefined : t('scope.noPrevious')} aria-label={t('scope.previous')}>
            <ChevronLeft size={14} aria-hidden /> {t('scope.previousShort')}
          </Button>
          <span className="fw-prr-date">
            <DateField value={daily?.day ?? model.address.date ?? ''} max={daily?.today} locale={locale === 'it' ? 'it-IT' : 'en-GB'} ariaLabel={t('scope.day')} onChange={(value) => value && actions?.onDay?.(value)} />
          </span>
          <Button size="sm" onClick={() => daily?.nextDay && actions?.onDay?.(daily.nextDay)} heldReason={daily?.nextDay ? undefined : t('scope.noNext')} aria-label={t('scope.next')}>
            {t('scope.nextShort')} <ChevronRight size={14} aria-hidden />
          </Button>
          {daily && daily.day !== daily.today && (
            <Button size="sm" onClick={() => actions?.onDay?.(daily.today)}>
              {t('scope.today')}
            </Button>
          )}
        </span>
        <span className="fw-prr-muted">{t('privacy')}</span>
      </div>

      <Card padded className="fw-prr-card">
        <div className="fw-prr-card-head">
          <h2 className="fw-prr-h2">{t('daily.title')}</h2>
          {daily && <span className="fw-prr-muted">{daily.day === daily.today ? t('daily.soFar', { day: day(daily.day) }) : t('daily.of', { day: day(daily.day) })}</span>}
        </div>
        {model.daily.problem ? (
          <EmptyState title={t('daily.failed')} description={t(model.daily.problem)} action={<Button size="sm" onClick={() => actions?.onRetry?.()}>{t('common.retry')}</Button>} />
        ) : !daily ? (
          <p className="fw-prr-muted" role="status">
            <Spinner size={12} /> {t('common.loading')}
          </p>
        ) : (
          <DailyPanel daily={daily} prefix={model.prefix} can={model.can} />
        )}
      </Card>

      {model.dialog && <SubscribeDialog model={model.dialog} actions={actions} />}
    </div>
  )
}

function DailyPanel({ daily, prefix, can }: { daily: DailyReport; prefix: string; can: ReportsCan }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const efficiency = siteEfficiency(daily.lanes)
  const recorded = anythingRecorded(daily.lanes)
  return (
    <div className="fw-prr-daily">
      {!daily.workingDay && <Banner tone="info" title={t('daily.closed')} />}
      <MetricStrip
        metrics={[
          { label: t('tile.good'), value: String(daily.totals.good), hint: t('tile.goodHint') },
          { label: t('tile.scrap'), value: String(daily.totals.scrap), hint: t('tile.scrapHint') },
          { label: t('tile.rework'), value: String(daily.totals.rework), hint: t('tile.reworkHint') },
          { label: t('tile.efficiency'), value: pctText(efficiency, locale), hint: t('tile.efficiencyHint') },
        ]}
      />
      {!recorded ? (
        <EmptyState title={t('daily.empty.title')} description={t('daily.empty.body')} />
      ) : (
        <figure className="fw-prr-chart" aria-label={t('chart.label')}>
          <PerformanceGraph
            data={chartData(daily.lanes)}
            xKey="lane"
            left={{
              key: 'garments',
              label: t('chart.garments'),
              axisLabel: t('chart.garments'),
              color: chart.actual,
              axis: 'left',
              shape: 'bar',
              stack: [
                { key: 'good', label: t('tile.good'), color: chart.positive },
                { key: 'scrap', label: t('tile.scrap'), color: chart.negative },
                { key: 'rework', label: t('tile.rework'), color: chart.reference },
              ],
            }}
            right={{ key: 'efficiency', label: t('chart.efficiency'), axisLabel: t('chart.efficiencyAxis'), color: chart.actual, axis: 'right', format: (value) => `${value} %` }}
            height={240}
          />
          <figcaption className="fw-prr-muted">{t('chart.caption')}</figcaption>
        </figure>
      )}
      <div className="fw-prr-lanes">
        {daily.lanes.map((lane) => (
          <LaneTable key={`${lane.kind}:${lane.id}`} lane={lane} prefix={prefix} can={can} />
        ))}
      </div>
    </div>
  )
}

function LaneTable({ lane, prefix, can }: { lane: DailyLane; prefix: string; can: ReportsCan }) {
  const t = useT('production-reports')
  const locale = useLocale()
  const title = `${lane.code} · ${lane.name}`
  return (
    <section className="fw-prr-lane" aria-label={title}>
      <div className="fw-prr-lane-head">
        <span className="fw-prr-inline">
          <h3 className="fw-prr-h3">{lane.kind === 'LINE' && can.floor ? <Link className="fw-prr-link" href={lineHref(prefix, lane.id)}>{title}</Link> : title}</h3>
          <Tag tone={lane.kind === 'LINE' ? 'info' : 'neutral'}>{t(`kind.${lane.kind}`)}</Tag>
        </span>
        <span className="fw-prr-muted">{t('lane.figures', { good: lane.good, scrap: lane.scrap, rework: lane.rework })}</span>
        {lane.kind === 'LINE' && (
          <span className="fw-prr-muted">
            {lane.efficiencyPct === null
              ? t('lane.noMinutes')
              : t('lane.efficiency', { pct: pctText(lane.efficiencyPct, locale), earned: lane.earnedMinutes ?? '0', available: lane.availableMinutes ?? '0', people: lane.people ?? 0, minutes: lane.workingMinutes ?? 0 })}
          </span>
        )}
      </div>
      {lane.rows.length === 0 ? (
        <p className="fw-prr-muted">{t('lane.nothing')}</p>
      ) : (
        <SummaryTable
          label={t('lane.tableLabel', { lane: title })}
          stackOnPhone
          columns={[t('col.style'), t('col.size'), t('col.good'), t('col.scrap'), t('col.rework')]}
          widths={['40%', '15%', '15%', '15%', undefined]}
          align={[undefined, undefined, 'right', 'right', 'right']}
          rows={lane.rows.map((row) => ({
            id: `${row.style.id}|${row.size}`,
            cells: [
              can.floor ? (
                <Link key="s" className="fw-prr-link" href={styleHref(prefix, row.style.code)}>
                  {`${row.style.code} · ${row.style.name}`}
                </Link>
              ) : (
                `${row.style.code} · ${row.style.name}`
              ),
              row.size,
              String(row.good),
              String(row.scrap),
              String(row.rework),
            ],
          }))}
        />
      )}
    </section>
  )
}
