'use client'

import { useMemo } from 'react'
import { Flag } from 'lucide-react'
import { Banner, Card, EmptyState } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../model'
import { MILESTONE_TONE, NAMESPACE, RISK_TONE } from '../model'
import type { OrderDepthActions, OrderDepthModel } from '../use-order-depth'

/**
 * Production finish forecast (design order.dates.lines "Production finish forecast (from work orders, W2b)"): the day the plan
 * says the line is ready (B-W2b-317's planned finish: the board, a work order's due day, a planned order, the engine), what
 * sets it, and the days to spare or short against the promise. "—" while it reads or nothing says when. Fetches nothing.
 */
export function ForecastCell({ model, lineId }: { model: OrderDepthModel | undefined; lineId: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const part = model?.forecasts
  if (!part) return <span className="fw-sod-hint">{d('forecast.noRight')}</span>
  if (!part.value) return <span className="fw-sod-hint">{part.problem ? d('forecast.failed') : d('forecast.reading')}</span>
  const forecast = part.value.get(lineId)
  if (!forecast) return <span className="fw-sod-hint">{d('forecast.none')}</span>
  return (
    <span className="fw-sod-cell">
      <span className="fw-sod-inline">
        {forecast.finish ? formatDate(dayInstant(forecast.finish), { locale }) : d('forecast.unknown')}
        {forecast.risk && forecast.risk !== 'NOT_PROMISED' && <Tag tone={RISK_TONE[forecast.risk]}>{forecast.slackDays === null ? d(`risk.${forecast.risk}`) : forecast.slackDays >= 0 ? d('forecast.spare', { count: forecast.slackDays }) : d('forecast.short', { count: -forecast.slackDays })}</Tag>}
      </span>
      <span className="fw-sod-hint">{d(`finish.${forecast.source}`)}</span>
    </span>
  )
}

/** The forecast's read state, said once above the table (failed: Try again). */
export function ForecastNote({ model, actions }: { model: OrderDepthModel | undefined; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  if (!model?.forecasts?.problem) return null
  return (
    <Banner
      tone="warning"
      title={d('forecast.failedTitle')}
      action={
        <Button size="sm" onClick={() => actions?.onRetry?.('forecasts')}>
          {d('common.retry')}
        </Button>
      }
    >
      {d(model.forecasts.problem)}
    </Banner>
  )
}

/**
 * The order's milestones (follow-up SO3:01: GET /planning/milestones?orderId=): its gates, production start and shipping as the
 * DS MilestoneTracker — done, started before the gate, the next one, to come, each with its day and target — and how many are
 * late. Only for the planner's readers (planning.view); the gates are kept in Planning › Time & action.
 */
export function MilestonesCard({ model, actions }: { model: OrderDepthModel | undefined; actions?: OrderDepthActions }) {
  if (!model?.milestones) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Milestones model={model} actions={actions} />
    </WithMessages>
  )
}

function Milestones({ model, actions }: { model: OrderDepthModel; actions?: OrderDepthActions }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const labels = useMemo(() => ({ ...ds.milestoneTracker, usually: (date: string) => d('milestone.target', { date }), states: { ...ds.milestoneTracker.states, skipped: d('milestone.state.STARTED_BEFORE') } }), [ds, d])
  const part = model.milestones!
  const day = (value: string) => formatDate(dayInstant(value), { locale })
  return (
    <Card padded>
      <div className="fw-sod-head">
        <h2 className="fw-sod-h2">
          <Flag size={15} aria-hidden /> {d('milestone.title')}
        </h2>
        {part.value && part.value.late > 0 && <Tag tone="danger">{d('milestone.late', { count: part.value.late })}</Tag>}
      </div>
      {part.problem ? (
        <EmptyState
          title={d('milestone.failed')}
          description={d(part.problem)}
          action={
            <Button size="sm" onClick={() => actions?.onRetry?.('milestones')}>
              {d('common.retry')}
            </Button>
          }
        />
      ) : part.value === null && !part.problem ? (
        <p className="fw-sod-hint" role="status">
          <Spinner size={14} /> {d('milestone.reading')}
        </p>
      ) : !part.value || part.value.milestones.length === 0 ? (
        <p className="fw-sod-hint">{d('milestone.none')}</p>
      ) : (
        <>
          <MilestoneTracker
            label={d('milestone.title')}
            labels={labels}
            steps={part.value.milestones.map((row) => ({
              id: row.id,
              label: row.kind === 'GATE' ? (row.label ?? d(`gate.${row.gateKind ?? 'OTHER'}`)) : d(`milestone.kind.${row.kind}`),
              state: row.state === 'DONE' ? ('done' as const) : row.state === 'STARTED_BEFORE' ? ('skipped' as const) : ('todo' as const),
              current: row.id === part.value!.next,
              date: row.actual ? day(row.actual) : null,
              expected: row.state !== 'DONE' && row.target ? day(row.target) : null,
            }))}
          />
          <ul className="fw-sod-legend-list">
            {part.value.milestones
              .filter((row) => row.late !== null && row.late > 0)
              .map((row) => (
                <li key={row.id}>
                  <Tag tone={MILESTONE_TONE[row.state] ?? 'neutral'}>{row.kind === 'GATE' ? (row.label ?? d(`gate.${row.gateKind ?? 'OTHER'}`)) : d(`milestone.kind.${row.kind}`)}</Tag> {d('milestone.lateBy', { count: row.late ?? 0 })}
                </li>
              ))}
          </ul>
        </>
      )}
    </Card>
  )
}
