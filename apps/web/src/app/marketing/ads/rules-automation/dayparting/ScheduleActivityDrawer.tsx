'use client'

/**
 * RDX/A4 — the drawer that answers "what has this schedule actually done".
 *
 * A shell only. Both histories live in components shared with the BUILDER, so the two surfaces
 * cannot drift:
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

export function ScheduleActivityDrawer({ group, palette, onClose }: {
  group: { id: string; name: string }
  palette: TargetPalette
  onClose: () => void
}) {
  const [tab, setTab] = useState<'activity' | 'changes'>('activity')

  const esc = useCallback((e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }, [onClose])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`History — ${group.name}`}>
        <div className="h10-hist-h">
          <div><b>History</b><span title={group.name}>{group.name}</span></div>
          <button type="button" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>

        <div className="h10-act-tabs" role="tablist" aria-label="History type">
          <button type="button" role="tab" aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => setTab('activity')}>Amazon changes</button>
          <button type="button" role="tab" aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Plan edits</button>
        </div>

        <div className="h10-hist-b">
          {tab === 'changes'
            ? <ScheduleVersions groupId={group.id} palette={palette} />
            : <ScheduleActivity groupId={group.id} />}
        </div>
      </div>
    </div>
  )
}
