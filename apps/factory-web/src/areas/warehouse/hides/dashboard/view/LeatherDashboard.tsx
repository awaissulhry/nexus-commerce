'use client'

import type { ReactNode } from 'react'
import { Card, Disclosure, EmptyState } from '@nexus/ui/components'
import { BarList } from '@nexus/ui/charts/bar-list/index'
import { Button, SegmentedControl, Skeleton } from '@nexus/ui/primitives'
import { AsOf, useDsWords } from '../../../../../lib/i18n/ds-parts'
import { useLocale } from '../../../../../lib/i18n/provider'
import type { Uom } from '../../../../_shared/stock/api'
import { money } from '../../../../_shared/stock/model'
import { useHideWords, type HideWords } from '../../words'
import {
  areaBarsOf,
  areaItems,
  HOLD_KEYS,
  holdSumLines,
  mixItems,
  mixKeys,
  onHoldItems,
  outsideItems,
  remnantLines,
  sumLines,
  YIELD_DAYS,
  yieldItems,
  type PanelRead,
} from '../dashboard-model'
import type { DashboardRead, LeatherDashboardActions, LeatherDashboardModel } from '../use-dashboard'
import '../dashboard.css'

export type { LeatherDashboardActions, LeatherDashboardModel } from '../use-dashboard'

/**
 * Hides › Leather dashboard (B-W2b-131; SCM-285, SCR-134; design warehouse.hides sec hd-dashboard): a collapsible section
 * (DS Disclosure, its open state kept per person) above the hide grid, with six panels, each with its own AsOf, empty and
 * error: area on hand by article and colour (bars; "Area value" only with the cost grain, held in words otherwise), the
 * grade mix per lot (stacked bars), the remnants in stock (pieces beside area), the area at subcontractors, the area on
 * hold (lot not released · quality hold, stacked) and the yield of the last 30 days by style and supplier lot (never by
 * cutter; held without production.cutting.view). A bar's name applies the same filter to the grid below. Bars compare in
 * m²; each value is written in its own unit with the other beside it, hides beside area.
 */
export function LeatherDashboard({ model, actions }: { model: LeatherDashboardModel; actions?: LeatherDashboardActions }) {
  const t = useHideWords()
  return (
    <Disclosure
      className="fw-hd-dash"
      open={model.open}
      onToggle={(event) => {
        const next = (event.currentTarget as HTMLDetailsElement).open
        if (next !== model.open) actions?.onToggle?.(next)
      }}
      summary={t('dash.title')}
    >
      {model.open && <Panels model={model} actions={actions} />}
    </Disclosure>
  )
}

function Panels({ model, actions }: { model: LeatherDashboardModel; actions?: LeatherDashboardActions }) {
  const t = useHideWords()
  const locale = useLocale()
  const ds = useDsWords()
  const unit = (uom: Uom) => t(`stock:uom.${uom}`)
  const m2 = (value: number) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value)} ${unit('M2')}`

  return (
    <div className="fw-hd-dash-grid">
      <Panel id="area" title={t('dash.area.title')} read={model.area} retry="area" actions={actions} wide>
        {(answer) => {
          const bars = areaBarsOf(answer)
          if (bars.length === 0) return <EmptyState title={t('dash.area.empty')} description={t('dash.area.emptyBody')} />
          const series = model.series
          return (
            <>
              <div className="fw-hd-dash-tools">
                <SegmentedControl
                  size="sm"
                  ariaLabel={t('dash.area.series')}
                  value={series}
                  onChange={(next) => actions?.onSeries?.(next === 'value' ? 'value' : 'area')}
                  options={[
                    { value: 'area', label: t('dash.area.seriesArea') },
                    { value: 'value', label: t('dash.area.seriesValue'), disabled: !model.cost, title: model.cost ? undefined : t('dash.area.valueHeld') },
                  ]}
                />
                {!model.cost && <span className="fw-hd-dash-held">{t('dash.area.valueHeld')}</span>}
              </div>
              <BarList
                labels={ds.barList}
                label={series === 'value' ? t('dash.area.valueLabel') : t('dash.area.label')}
                format={series === 'value' ? (value) => money(value, bars.find((bar) => bar.currency)?.currency ?? null, locale) : m2}
                items={areaItems(bars, series, unit, locale, t, (minor, currency) => money(minor, currency, locale))}
                active={model.active.article}
                onPick={(key) => actions?.onArticle?.(key)}
              />
              <p className="fw-hd-dash-hint">{t('dash.area.hint')}</p>
            </>
          )
        }}
      </Panel>

      <Panel id="mix" title={t('dash.mix.title')} read={model.mix} retry="mix" actions={actions} wide>
        {(answer) => {
          const items = mixItems(answer, unit, locale, t)
          if (items.length === 0) return <EmptyState title={t('dash.mix.empty')} description={t('dash.mix.emptyBody')} />
          return (
            <>
              <BarList labels={ds.barList} label={t('dash.mix.label')} format={m2} keys={mixKeys(answer, locale, t)} items={items} active={model.active.lot} onPick={(lotId) => actions?.onLot?.(lotId)} />
              <p className="fw-hd-dash-hint">{t('dash.mix.hint')}</p>
            </>
          )
        }}
      </Panel>

      <Panel id="remnants" title={t('dash.remnants.title')} read={model.mix} retry="mix" actions={actions}>
        {(answer) => {
          const lines = remnantLines(answer, unit, locale, t)
          return (
            <div className="fw-hd-dash-figures">
              {lines.length === 0 ? <p className="fw-hd-dash-big">{t('dash.remnants.none')}</p> : lines.map((line) => <p key={line} className="fw-hd-dash-big">{line}</p>)}
              <p className="fw-hd-dash-hint">{t('dash.remnants.hint')}</p>
              <Button size="sm" onClick={() => actions?.onRemnants?.()}>
                {t('dash.remnants.open')}
              </Button>
            </div>
          )
        }}
      </Panel>

      <Panel id="outside" title={t('dash.outside.title')} read={model.dashboard} retry="dashboard" actions={actions}>
        {(answer) => {
          const items = outsideItems(answer, unit, locale, t)
          if (items.length === 0) return <p className="fw-hd-dash-big">{t('dash.outside.none')}</p>
          return (
            <>
              <Sums lines={sumLines(answer.atSubcontractors.sums, unit, locale, t)} t={t} />
              <BarList labels={ds.barList} label={t('dash.outside.label')} format={m2} items={items} />
            </>
          )
        }}
      </Panel>

      <Panel id="onHold" title={t('dash.onHold.title')} read={model.dashboard} retry="dashboard" actions={actions}>
        {(answer) => {
          const items = onHoldItems(answer, unit, locale, t)
          if (items.length === 0) return <p className="fw-hd-dash-big">{t('dash.onHold.none')}</p>
          return (
            <>
              <Sums lines={holdSumLines(answer, unit, locale, t)} t={t} />
              <BarList
                labels={ds.barList}
                label={t('dash.onHold.label')}
                format={m2}
                keys={HOLD_KEYS.map((key) => ({ id: key, label: t(`dash.onHold.${key}`), tone: key === 'qualityHold' ? ('warning' as const) : undefined }))}
                items={items}
                onPick={(key) => actions?.onOnHold?.(key)}
              />
            </>
          )
        }}
      </Panel>

      <Panel id="yield" title={t('dash.yield.title', { days: YIELD_DAYS })} read={model.yield} retry="yield" actions={actions} wide>
        {(answer) => {
          const items = yieldItems(answer, locale, t)
          if (items.length === 0) return <EmptyState title={t('dash.yield.empty')} description={t('dash.yield.emptyBody', { days: YIELD_DAYS })} />
          return (
            <>
              <BarList labels={ds.barList} label={t('dash.yield.label')} format={(value) => `${new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value)} %`} items={items} max={100} />
              <p className="fw-hd-dash-hint">{t('dash.yield.hint')}</p>
            </>
          )
        }}
      </Panel>
    </div>
  )
}

function Sums({ lines, t }: { lines: string[]; t: HideWords }) {
  if (lines.length === 0) return null
  return (
    <p className="fw-hd-dash-big" aria-label={t('dash.sums')}>
      {lines.join(' · ')}
    </p>
  )
}

/** One panel: its title and AsOf, then loading (skeleton), held (why), failed (its words + Try again), or its body. */
function Panel<T>({ id, title, read, retry, actions, wide, children }: { id: string; title: string; read: PanelRead<T>; retry: DashboardRead; actions?: LeatherDashboardActions; wide?: boolean; children: (value: T) => ReactNode }) {
  const t = useHideWords()
  let body: ReactNode
  if (read.held) body = <p className="fw-hd-dash-held">{t(read.held)}</p>
  else if (read.problem)
    body = (
      <EmptyState
        title={t('dash.failed')}
        description={t(`stock:${read.problem}`)}
        action={
          <Button size="sm" onClick={() => actions?.onRetry?.(retry)}>
            {t('lots:rec.retry')}
          </Button>
        }
      />
    )
  else if (read.value === null) body = <Skeleton height={96} />
  else body = children(read.value)
  return (
    <section className={wide ? 'fw-hd-dash-panel wide' : 'fw-hd-dash-panel'} aria-labelledby={`fw-hd-dash-${id}`}>
      <Card padded>
        <div className="fw-hd-dash-stack">
          <div className="fw-hd-dash-head">
            <h3 className="fw-hd-dash-h3" id={`fw-hd-dash-${id}`}>
              {title}
            </h3>
            {!read.held && <AsOf at={read.asOf} />}
          </div>
          {body}
        </div>
      </Card>
    </section>
  )
}
