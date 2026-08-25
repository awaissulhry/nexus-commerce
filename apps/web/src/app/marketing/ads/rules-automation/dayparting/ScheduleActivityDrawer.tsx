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
import { ToolbarButton } from '@/design-system/primitives'
import { X } from 'lucide-react'
import { ChangeList } from './ScheduleActivity'
import { ScheduleVersions, type TargetPalette } from './ScheduleVersions'
import { Next24Preview } from './Next24Preview'

export type DrawerTab = 'next24' | 'activity' | 'changes'

export const DRAWER_TABS: DrawerTab[] = ['next24', 'activity', 'changes']
export const isDrawerTab = (v: string): v is DrawerTab => (DRAWER_TABS as string[]).includes(v)

export function ScheduleActivityDrawer({ group, palette, initialTab = 'next24', onTabChange, onClose }: {
  group: { id: string; name: string }
  palette: TargetPalette
  /** Which panel to land on. The row's explicit "Activity" button opens its own tab, so the label
      someone clicked matches what they get; a plain row click gets the forward view. */
  initialTab?: DrawerTab
  /** RD.P0 (additive) — fired when the operator switches panel, so the page can put the panel in
      the URL. Without it `?drawer=` could only ever set the tab you LAND on, and a link copied
      after clicking "Plan edits" would reopen on "Next 24 hours". */
  onTabChange?: (tab: DrawerTab) => void
  onClose: () => void
}) {
  const [tab, setTab] = useState<DrawerTab>(initialTab)
  // The URL is allowed to drive the panel too (back/forward, or a link pasted into the open page).
  useEffect(() => { setTab(initialTab) }, [initialTab])
  const pick = useCallback((t: DrawerTab) => { setTab(t); onTabChange?.(t) }, [onTabChange])

  /**
   * FB.3e — Escape must close the TOPMOST layer. The Plan-edits tab opens a restore confirm
   * (`.h10-ntm-back`) OVER this drawer; the document-level listener used to fire behind it and
   * close the whole drawer while the confirm was still asking. If a confirm overlay is in the
   * DOM, Escape is its to handle, not ours.
   */
  const esc = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Escape') return
    if (document.querySelector('.h10-ntm-back')) return
    onClose()
  }, [onClose])
  useEffect(() => { document.addEventListener('keydown', esc); return () => document.removeEventListener('keydown', esc) }, [esc])

  return (
    <div className="h10-hist-back" onClick={onClose}>
      <div className="h10-hist wide" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={`Schedule — ${group.name}`}>
        <div className="h10-hist-h">
          {/* Retitled from "History" when the forward view landed: two of the three panels are
              still history, but the drawer as a whole is no longer only about the past. */}
          <div><b>Schedule</b><span title={group.name}>{group.name}</span></div>
          <ToolbarButton icon={<X size={18} />} label="Close" tooltip={false} onClick={onClose} />
        </div>

        {/* FB.3e — real tab semantics: each tab names the panel it controls, the panel names the
            tab that labels it, and only the active tab sits in the tab order (arrow keys move
            within the list, the ARIA tabs pattern). */}
        <div className="h10-act-tabs" role="tablist" aria-label="Schedule detail"
          onKeyDown={(e) => {
            if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
            const order: DrawerTab[] = ['next24', 'activity', 'changes']
            const i = order.indexOf(tab)
            pick(order[(i + (e.key === 'ArrowRight' ? 1 : order.length - 1)) % order.length])
          }}>
          <button type="button" role="tab" id="sad-tab-next24" aria-controls="sad-panel" tabIndex={tab === 'next24' ? 0 : -1} aria-selected={tab === 'next24'} className={tab === 'next24' ? 'on' : ''} onClick={() => pick('next24')}>Next 24 hours</button>
          <button type="button" role="tab" id="sad-tab-activity" aria-controls="sad-panel" tabIndex={tab === 'activity' ? 0 : -1} aria-selected={tab === 'activity'} className={tab === 'activity' ? 'on' : ''} onClick={() => pick('activity')}>Amazon changes</button>
          <button type="button" role="tab" id="sad-tab-changes" aria-controls="sad-panel" tabIndex={tab === 'changes' ? 0 : -1} aria-selected={tab === 'changes'} className={tab === 'changes' ? 'on' : ''} onClick={() => pick('changes')}>Plan edits</button>
        </div>

        <div className="h10-hist-b" role="tabpanel" id="sad-panel" aria-labelledby={`sad-tab-${tab}`}>
          {tab === 'next24' ? <Next24Preview groupId={group.id} />
            : tab === 'changes' ? <ScheduleVersions groupId={group.id} palette={palette} />
            : <ChangeList groupId={group.id} />}
        </div>
      </div>
    </div>
  )
}
