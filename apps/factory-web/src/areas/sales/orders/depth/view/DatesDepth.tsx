'use client'

import { useMemo } from 'react'
import { Flag } from 'lucide-react'
import { Card, EmptyState } from '@nexus/ui/components'
import { MilestoneTracker } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Spinner, Tag } from '@nexus/ui/primitives'
import { useDsWords } from '../../../../../lib/i18n/ds-parts'
import { formatDate } from '../../../../../lib/i18n/format'
import { useLocale, useT } from '../../../../../lib/i18n/provider'
import { WithMessages } from '../../../../../record-panels/i18n'
import { dayInstant } from '../../model'
import { MILESTONE_TONE, NAMESPACE, RISK_TONE, type Forecast } from '../model'
import type { DepthPart } from '../use-order-depth'
import type { OrderMilestone } from '../api'

/**
 * Production finish forecast (design order.dates.lines "Production finish forecast (from work orders, W2b)"): the day the plan
 * says the line is ready (B-W2b-317's planned finish: the board, a work order's due day, a planned order, the engine), what
 * sets it, and the days to spare or short against the promise. "—" while it reads or nothing says when. Fetches nothing.
 * F-SA-234b: the part is the order's own production read's `dates.forecast` (record/production `forecastPart`), not a read of every
 * site's promise lines; a failed read is said once on the tab (its milestones card), the cell only "—".
 */
export function ForecastCell({ part, lineId }: { part: DepthPart<ReadonlyMap<string, Forecast>> | null; lineId: string }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
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

/**
 * The order's milestones (follow-up SO3:01: GET /planning/milestones?orderId=): its gates, production start and shipping as the
 * DS MilestoneTracker — done, started before the gate, the next one, to come, each with its day and target — and how many are
 * late. Only for the planner's readers (planning.view); the gates are kept in Planning › Time & action.
 */
// F-SA-234: fed by the order's own read (GET /sales/orders/:id/production `dates`, orders.view — P16), no longer the planner's
// /planning/milestones (planning.view): the part takes the milestones as a plain part and its Try again.
export interface MilestonesValue {
  readonly milestones: readonly OrderMilestone[]
  readonly next: string | null
  readonly late: number
}

export function MilestonesCard({ part, onRetry }: { part: DepthPart<MilestonesValue> | null | undefined; onRetry?: () => void }) {
  if (!part) return null
  return (
    <WithMessages namespaces={[NAMESPACE]}>
      <Milestones part={part} onRetry={onRetry} />
    </WithMessages>
  )
}

function Milestones({ part, onRetry }: { part: DepthPart<MilestonesValue>; onRetry?: () => void }) {
  const d = useT(NAMESPACE)
  const locale = useLocale()
  const ds = useDsWords()
  const labels = useMemo(() => ({ ...ds.milestoneTracker, usually: (date: string) => d('milestone.target', { date }), states: { ...ds.milestoneTracker.states, skipped: d('milestone.state.STARTED_BEFORE') } }), [ds, d])
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
            <Button size="sm" onClick={() => onRetry?.()}>
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
