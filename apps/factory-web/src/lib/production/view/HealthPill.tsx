'use client'

import type { ReactNode } from 'react'
import { AlertTriangle, CalendarClock, CalendarX, CircleCheck, Lock, MessageSquareText } from 'lucide-react'
import { DetailPopover } from '@nexus/ui/components'
import { Pill, Skeleton } from '@nexus/ui/primitives'
import { healthView, type Face, type HealthInput, type HealthState } from '../model'
import { useProductionWords } from '../words'
import '../production-parts.css'

export interface HealthPillProps extends HealthInput {
  face: Face
  loading?: boolean
  /** Office: the chip opens its "why" (plan, promise and a person's note); false draws the chip alone (a dense cell). */
  explain?: boolean
}

const ICON: Readonly<Record<HealthState, ReactNode>> = {
  LATE: <CalendarClock size={12} aria-hidden />,
  AT_RISK: <AlertTriangle size={12} aria-hidden />,
  NOT_PROMISED: <CalendarX size={12} aria-hidden />,
  ON_TIME: <CircleCheck size={12} aria-hidden />,
}

/**
 * F-PR-01 — the health chip (plan §4: computed + a person's raise, one chip): the worse of "Late · 3 d" / "At risk" / "No
 * date yet" / "On track" from the dates and a person's "At risk" with a curated reason (B-PR-35). Office: the chip opens a
 * DS DetailPopover with both signals in words — the dates, and the person's note marked "Office only" (one yellow: never
 * sent to the customer). Customer: the chip and the curated reason only, never the note. No plan: "—". The DS success pill
 * is blue: the word "On track" carries it.
 */
export function HealthPill({ face, loading, explain = true, ...input }: HealthPillProps) {
  const w = useProductionWords()
  if (loading) {
    return (
      <span role="status" aria-label={w.t('common.loading')}>
        <Skeleton width={72} height={18} radius={999} />
      </span>
    )
  }
  const view = healthView(face, input)
  if (view === 'unknown' || view.state === null) {
    return (
      <span className="fw-prp-unknown">
        <span aria-hidden>—</span>
        <span className="nds-vh">{w.t(view === 'unknown' ? 'parts.health.unknown' : 'parts.health.none')}</span>
      </span>
    )
  }
  const words = w.say(view.words)
  const reason = view.reason ? w.reason(view.reason) : null
  if (face === 'customer') {
    return (
      <Pill tone={view.tone} icon={ICON[view.state]} truncate>
        {reason ? w.t('parts.health.withReason', { health: words, reason }) : words}
      </Pill>
    )
  }
  const chip = (
    <Pill tone={view.tone} icon={ICON[view.state]}>
      {words}
      {view.note ? <MessageSquareText size={12} aria-hidden className="fw-prp-note-mark" /> : null}
    </Pill>
  )
  if (!explain) return chip
  const sentence = view.note ? w.t('parts.health.withNote', { health: words }) : words
  const dates = input.promise
    ? input.plan
      ? w.t('parts.health.fromDates', { plan: w.day(input.plan), promise: w.day(input.promise) })
      : w.t('parts.health.fromDatesNoPlan', { promise: w.day(input.promise) })
    : w.t('parts.health.noPromise')
  return (
    <DetailPopover trigger={chip} triggerLabel={w.t('parts.health.open', { health: sentence })} triggerClassName="fw-prp-pop-trigger" label={w.t('parts.health.title', { health: words })} hoverDelay={0}>
      <div className="fw-prp-pop">
        <p className="fw-prp-pop-line">
          {dates}
          {view.state === 'LATE' && input.daysLate ? ` — ${w.t('parts.health.lateDays', { count: input.daysLate })}` : ''}
        </p>
        {reason ? <p className="fw-prp-pop-line">{w.t('parts.health.raised', { reason })}</p> : null}
        {view.note ? (
          <div className="fw-prp-office-note">
            <span className="fw-prp-office-mark">
              <Lock size={12} aria-hidden /> {w.t('parts.health.officeOnly')}
            </span>
            <p className="fw-prp-pop-line">
              {view.note.by && view.note.at
                ? w.t('parts.health.note', { by: view.note.by, date: w.day(view.note.at), note: view.note.text })
                : view.note.by
                  ? w.t('parts.health.noteBy', { by: view.note.by, note: view.note.text })
                  : view.note.text}
            </p>
          </div>
        ) : null}
      </div>
    </DetailPopover>
  )
}
