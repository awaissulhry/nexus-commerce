'use client'

import { Hourglass } from 'lucide-react'
import { Pill, Skeleton } from '@nexus/ui/primitives'
import { waitingView, type Face, type WaitingInput } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface WaitingOnPillProps extends WaitingInput {
  face: Face
  /** The clock the ages count from (ms); the page passes its read's clock so a list does not jump. */
  now?: number
  loading?: boolean
}

/**
 * F-PR-01 — who the work waits on, as a DS Pill (icon + words, never colour alone). Office: "Waiting on us · 4 h",
 * "Waiting on customer · PP sample · 2 d", supplier, workshop. Customer: "Waiting on you" or "Waiting on us" — supplier
 * and workshop are ours to solve and never named to a customer. Amber once the wait is overdue (model `waitingView`).
 * Nobody waiting: nothing drawn; not known: "—". Plain text, not a control.
 */
export function WaitingOnPill({ face, now, loading, ...input }: WaitingOnPillProps) {
  const w = useProductionWords()
  if (loading) {
    return (
      <span role="status" aria-label={w.t('common.loading')}>
        <Skeleton width={80} height={18} radius={999} />
      </span>
    )
  }
  const view = waitingView(face, input, now ?? Date.now())
  if (view === null) return null
  if (view === 'unknown') {
    return (
      <span className="fw-prp-unknown">
        <span aria-hidden>—</span>
        <span className="nds-vh">{w.t('parts.waiting.unknown')}</span>
      </span>
    )
  }
  const parts = [w.say(view.words), view.what, view.age ? w.say(view.age) : null].filter((part): part is string => !!part)
  return (
    <Pill tone={view.tone} icon={<Hourglass size={12} aria-hidden />} truncate>
      {parts.join(' · ')}
    </Pill>
  )
}
