'use client'

import type { ReactNode } from 'react'
import type { Tone } from '../primitives/tone'
import { AsOf } from './AsOf'

export interface TimelineStep {
  key: string
  /** What happened, in words that carry the outcome on their own: "Channel refused 2 of 23", not "Processed". */
  label: ReactNode
  tone: Tone
  /**
   * When it happened (ISO). `null` = this step has not happened yet ("not yet"). Omit when the step has no time of its
   * own.
   */
  at?: string | null
  /** A muted line under the label: a reference, a count, the channel's sentence. */
  detail?: ReactNode
}

export interface TimelineProps {
  steps: readonly TimelineStep[]
  /** The list's accessible name: "Publish steps". */
  label: string
  /** The read's clock, for "2 min ago". Default: now. */
  now?: number
  className?: string
}

/** Read by a screen reader before the label, so a warning or a failure is never told by colour alone. */
const TONE_WORD: Partial<Record<Tone, string>> = { warning: 'Needs attention: ', danger: 'Problem: ' }

/**
 * Timeline — a read-only record of what happened, in order (sheet publish parity, 2026-10-02).
 *
 * Not `Stepper`: a stepper is wizard navigation (a current step, clickable finished steps); this records events that
 * already happened and offers no action. Each step is a tone dot (decorative), a label, a time and a muted detail. The
 * dot is filled with the tone's TEXT colour, so it clears 3:1 on the surface (WCAG 1.4.11) in both themes; a step
 * that has not happened is a hollow ring.
 */
export function Timeline({ steps, label, now, className }: TimelineProps) {
  return (
    <ol className={`nds-timeline${className ? ` ${className}` : ''}`} aria-label={label}>
      {steps.map(step => (
        <li key={step.key} className={`nds-timeline-step tone-${step.tone}${step.at === null ? ' is-pending' : ''}`}>
          <span className="nds-timeline-dot" aria-hidden="true" />
          <span className="nds-timeline-body">
            <span className="nds-timeline-head">
              <span className="nds-timeline-label">
                {TONE_WORD[step.tone] && <span className="nds-vh">{TONE_WORD[step.tone]}</span>}
                {step.label}
              </span>
              {step.at === null
                ? <span className="nds-as-of">not yet</span>
                : step.at !== undefined && <AsOf at={step.at} kind="event" now={now} />}
            </span>
            {step.detail != null && <span className="nds-timeline-detail">{step.detail}</span>}
          </span>
        </li>
      ))}
    </ol>
  )
}
