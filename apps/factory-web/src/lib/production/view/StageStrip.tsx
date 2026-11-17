'use client'

import { PauseCircle } from 'lucide-react'
import { EmptyState } from '@nexus/ui/components'
import { MilestoneTracker, type MilestonePromise, type MilestoneStep } from '@nexus/ui/components/MilestoneTracker/index'
import { Button, Pill, Skeleton } from '@nexus/ui/primitives'
import type { PromiseReasonCode } from '@nexus/factory-domain/sales/portal-orders/promise'
import { useDsWords } from '../../i18n/ds-parts'
import { stageSteps, type Face, type StageStripInput } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface StageStripProps extends StageStripInput {
  face: Face
  /** `auto`: across on a wide box, down on a narrow one; `compact`: the one-row form for a list cell or a phone card. */
  layout?: 'auto' | 'compact'
  /** The list's name for a screen reader ("WO-0311 stages"). */
  label?: string
  /**
   * The ex-factory date and how it moved (calendar days), with the curated reason of each move. Office: "Ex-factory 18
   * Nov"; customer: "Expected 18 Nov" — never "promised".
   */
  promise?: { date: string; history?: readonly { on: string; from: string | null; to: string; reason: PromiseReasonCode | null }[] } | null
  loading?: boolean
  /** The stages could not be read: only this part says so, with Try again. */
  problem?: boolean
  onRetry?: () => void
}

/**
 * F-PR-01 — the five plain stages (plan §4: Preparing · Cutting · Sewing · Quality check · Ready to ship), drawn with the
 * DS MilestoneTracker (its `compact` row form for a list cell or a phone card; the full form across or down by its own
 * width). A blocked stage keeps the tracker's current step and adds a blocked mark with why in words beside it (DS gap G1,
 * plan §8: the tracker has no blocked state; until the Owner's word the mark lives here). Unknown stage: "—", never step
 * 1. Office dates read "Planned"; the customer's "Expected by". Never interactive except the date's history.
 */
export function StageStrip({ face, layout = 'auto', label, promise, loading, problem, onRetry, ...input }: StageStripProps) {
  const w = useProductionWords()
  const ds = useDsWords()
  const name = label ?? w.t('parts.stage.label')
  if (loading) {
    return (
      <div className="fw-prp-strip" data-layout={layout} role="status" aria-label={w.t('parts.stage.loading')}>
        <Skeleton width={layout === 'compact' ? 140 : '100%'} height={layout === 'compact' ? 14 : 44} />
      </div>
    )
  }
  if (problem) {
    return <EmptyState title={w.t('parts.stage.failed')} action={onRetry ? <Button size="sm" onClick={onRetry}>{w.t('common.retry')}</Button> : undefined} />
  }
  const steps = stageSteps(input)
  if (steps.length === 0) {
    return (
      <div className="fw-prp-strip fw-prp-unknown" data-layout={layout}>
        <span aria-hidden>—</span>
        <span className="nds-vh">{`${name}: ${w.t('parts.stage.unknown')}`}</span>
      </div>
    )
  }
  const milestones: MilestoneStep[] = steps.map((step) => ({
    id: step.id,
    label: w.say(step.label),
    state: step.state,
    date: step.date ? w.day(step.date) : null,
    expected: step.expected ? w.day(step.expected) : null,
    note: step.note ? w.say(step.note) : null,
  }))
  const milestonePromise: MilestonePromise | null = promise
    ? { date: w.day(promise.date), history: (promise.history ?? []).map((move) => ({ on: w.day(move.on), from: move.from ? w.day(move.from) : null, to: w.day(move.to), reason: move.reason ? w.reason(move.reason) : null })) }
    : null
  const labels = {
    ...ds.milestoneTracker,
    usually: (date: string) => w.t(face === 'office' ? 'parts.stage.office.planned' : 'parts.stage.customer.expected', { date }),
    promised: (date: string) => w.t(face === 'office' ? 'parts.stage.office.promised' : 'parts.stage.customer.promised', { date }),
  }
  const blocked = input.blocked ? (
    <Pill tone="warning" icon={<PauseCircle size={12} aria-hidden />} className="fw-prp-blocked">
      {layout === 'compact' && input.blocked.why ? w.t('parts.stage.blockedWhy', { why: input.blocked.why }) : w.t('parts.stage.blocked')}
    </Pill>
  ) : null
  // The full form puts the mark above the steps (the current step's line says why); the row form puts it after the dots.
  return (
    <div className="fw-prp-strip" data-layout={layout} data-blocked={input.blocked ? 'true' : undefined}>
      {layout === 'compact' ? null : blocked}
      <MilestoneTracker steps={milestones} promise={layout === 'compact' ? null : milestonePromise} layout={layout} label={name} labels={labels} />
      {layout === 'compact' ? blocked : null}
    </div>
  )
}
