/**
 * MilestoneTracker — a record's steps in the customer's words, each with its date, the current step, and the promise date
 * with how it moved and why (B-W2b-155, design part MilestoneTracker): an order, a return, a tracked shipment. Not the
 * wizard `Stepper`.
 *
 *   <MilestoneTracker steps={order.milestones} promise={{ date: '14 Nov', history }} labels={ds.milestoneTracker} />
 *
 * - `layout` `auto` (default): across on a wide box, down on a narrow one (a container query, so a card on a desktop
 *   reads like a phone); `horizontal` / `vertical` force one; `compact` is the row form: one dot per step and the current
 *   step's name ("In production · Step 3 of 6").
 * - Each step says its state in words beside its mark (Done · Partly · Now · To come · Skipped), with its date or an
 *   estimate ("Usually by 12 Nov" — never a promise); the current one is `aria-current="step"`.
 * - The promise: "Promised for 14 Nov"; when it moved, "Date moved 2 times" opens the history: each move from → to with
 *   its reason. Dates come written from the page (its language, the site's zone).
 */
import { createElement } from 'react'
import { Check, CircleDot, Circle, Contrast, Minus } from 'lucide-react'

import { mergeLabels } from '../../lib/labels'
import { MILESTONE_TRACKER_LABELS, type MilestoneTrackerLabels } from './MilestoneTrackerLabels'
import { milestoneCurrentIndex, milestoneViews, promiseMoves, type MilestonePromise, type MilestoneShownState, type MilestoneStep } from './milestoneTrackerModel'
import './milestoneTracker.css'

export interface MilestoneTrackerProps {
  steps: readonly MilestoneStep[]
  /** The promise date and how it moved. */
  promise?: MilestonePromise | null
  /** `auto` (default) | `horizontal` | `vertical` | `compact` (dots, for a row). */
  layout?: 'auto' | 'horizontal' | 'vertical' | 'compact'
  /** The list's name ("Order SO-2026-0042 progress"). Default "Progress". */
  label?: string
  className?: string
  labels?: Partial<MilestoneTrackerLabels>
}

const MARK = { done: Check, partly: Contrast, current: CircleDot, todo: Circle, skipped: Minus } as const satisfies Record<MilestoneShownState, unknown>

export function MilestoneTracker({ steps, promise, layout = 'auto', label, className, labels }: MilestoneTrackerProps) {
  const lw = mergeLabels(MILESTONE_TRACKER_LABELS, labels)
  const views = milestoneViews(steps, lw)
  const current = milestoneCurrentIndex(steps)
  const name = label ?? lw.list
  if (!views.length) return null

  if (layout === 'compact') {
    const now = current >= 0 ? views[current] : null
    return (
      <div className={['nds-milestones', className].filter(Boolean).join(' ')} data-layout="compact">
        <span className="nds-milestones-dots" aria-hidden>
          {views.map((v) => (
            <span key={v.step.id} className="nds-milestones-dot" data-state={v.shown} />
          ))}
        </span>
        {now ? (
          <span className="nds-milestones-now">
            <span className="nds-milestones-now-label">{now.step.label}</span>
            <span className="nds-milestones-now-of">{lw.stepOf(current + 1, views.length)}</span>
          </span>
        ) : null}
        <ol className="nds-vh" aria-label={name}>
          {views.map((v) => (
            <li key={v.step.id} aria-current={v.isCurrent ? 'step' : undefined}>
              {`${v.step.label}: ${v.detail}`}
            </li>
          ))}
        </ol>
      </div>
    )
  }

  const moves = promiseMoves(promise)
  return (
    <div className={['nds-milestones', className].filter(Boolean).join(' ')} data-layout={layout}>
      <ol className="nds-milestones-list" aria-label={name}>
        {views.map((v) => (
          <li key={v.step.id} className="nds-milestone" data-state={v.shown} aria-current={v.isCurrent ? 'step' : undefined}>
            <span className="nds-milestone-mark" aria-hidden>
              {createElement(MARK[v.shown], { size: 14, 'aria-hidden': true })}
            </span>
            <span className="nds-milestone-text">
              <span className="nds-milestone-label">{v.step.label}</span>
              <span className="nds-milestone-detail">{v.detail}</span>
              {v.step.note ? <span className="nds-milestone-note">{v.step.note}</span> : null}
            </span>
          </li>
        ))}
      </ol>
      {promise?.date ? (
        <div className="nds-milestones-promise">
          <span className="nds-milestones-promised">{lw.promised(promise.date)}</span>
          {moves > 0 ? (
            <details className="nds-milestones-history">
              <summary>{lw.moved(moves)}</summary>
              <div className="nds-milestones-history-body">
                <span className="nds-milestones-history-h">{lw.history}</span>
                <ol className="nds-milestones-moves">
                  {(promise.history ?? []).map((m, i) => (
                    <li key={i}>
                      <span>{m.from ? lw.move(m.on, m.from, m.to) : lw.set(m.on, m.to)}</span>
                      {m.reason ? <span className="nds-milestones-reason">{m.reason}</span> : null}
                    </li>
                  ))}
                </ol>
              </div>
            </details>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
