'use client'

/**
 * RDX/A4 + E1 — the per-schedule detail drawer: what it is about to do, and what it has done.
 *
 * A shell only. All three panels live in components shared with the BUILDER, so the surfaces
 * cannot drift:
 *   · Next24Preview     — RDX/E1, the FORWARD view: the next 24 hours hour by hour, with each
 *                         hour's governing target, the bias held, and the ceiling permitted. It
 *                         leads because it is the one that informs a decision still to be made.
 *   · ScheduleActivity  — what the ENGINE changed on Amazon: bid moves, placement percentages,
 *                         and separately whether each one actually landed.
 *   · ScheduleVersions  — what the OPERATOR changed about the plan: which windows moved, and when.
 *
 * Separate tabs, not one merged feed. A schedule makes a handful of plan edits and thousands of
 * automated bid moves; blending them buries the edits that explain the moves.
 *
 * Chrome reuses the h10-hist-* shell from RuleListTab's execution-history drawer, so the two read
 * as the same kind of object in the same console.
 */
import { useCallback, useEffect, useState } from 'react'
import { X } from 'lucide-react'
import { ScheduleActivity } from './ScheduleActivity'
import { ScheduleVersions, type TargetPalette } from './ScheduleVersions'
import { Next24Preview } from './Next24Preview'

export type DrawerTab = 'next24' | 'activity' | 'changes'

export function ScheduleActivityDrawer({ group, palette, initialTab = 'next24', onClose }: {
  group: { id: string; name: string }
  palette: TargetPalette
  /** Which panel to land on. The row's explicit "Activity" button opens its own tab, so the label
      someone clicked matches what they get; a plain row click gets the forward view. */
  initialTab?: DrawerTab
  onClose: () => void
}) {
  const [tab, setTab] = useState<DrawerTab>(initialTab)

  const esc = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Schedule — ${group.name}`}>
        <div className="h10-hist-h">
          {/* Retitled from "History" when the forward view landed: two of the three panels are
              still history, but the drawer as a whole is no longer only about the past. */}
          <div><b>Schedule</b><span title={group.name}>{group.name}</span></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="h10-act-tabs" role="tablist" aria-label="Schedule detail">
          <button type="button" role="tab" aria-selected={tab === 'next24'} className={tab === 'next24' ? 'on' : ''} onClick={() => setTab('next24')}>Next 24 hours</button>
          <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Amazon changes</button>
          <button type="button" role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Plan edits</button>
        </div>

        <div className="h10-hist-b">
          {tab === 'next24' ? <Next24Preview groupId={group.id} />
            : tab === 'changes' ? <ScheduleVersions groupId={group.id} palette={palette} />
            : <ScheduleActivity groupId={group.id} />}
        </div>
      </div>
    </div>
  )
}
