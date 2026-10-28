'use client'

/**
 * Stepper — a horizontal progress indicator for multi-step flows (builders, wizards,
 * publish pipelines). Numbered circular badges joined by connector lines; steps before
 * the active index are "done" (filled primary + check), the active index is ringed and
 * strong, later steps are muted upcoming. The parent owns `current`.
 *
 * Pass `onSelect` to make completed steps clickable — three builders in the ads console let you
 * click back to a finished step, and could not use this while it was an `<ol>` of `<li>` with no
 * click. UPCOMING steps stay inert by default: letting someone jump ahead past validation is a
 * different feature, and one a wizard has to opt into deliberately via `canSelect`.
 *
 * Requires `styles/components.css`.
 */
import { Check } from 'lucide-react'
import type { ReactNode } from 'react'

export interface StepperStep {
  key: string
  /**
   * `ReactNode`, not `string` — two builders nest a sub-step list inside the ACTIVE step's label
   * and would lose it otherwise.
   */
  label: ReactNode
}
export interface StepperProps {
  steps: StepperStep[]
  /** Index of the active step (0-based). Earlier = done, later = upcoming. */
  current: number
  /** Makes navigable steps clickable. Without it the stepper stays display-only, as before. */
  onSelect?: (index: number, step: StepperStep) => void
  /** Which steps may be clicked. Defaults to completed ones only. Needs `onSelect`. */
  canSelect?: (index: number) => boolean
  className?: string
}

export function Stepper({ steps, current, onSelect, canSelect, className }: StepperProps) {
  return (
    <ol className={`nds-stepper${className ? ` ${className}` : ''}`}>
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'upcoming'
        const selectable = onSelect != null && (canSelect ? canSelect(i) : state === 'done')
        const body = (
          <>
            <span className="nds-step-badge">
              {state === 'done' ? <Check size={14} aria-hidden /> : <span className="nds-step-num">{i + 1}</span>}
            </span>
            <span className="nds-step-label">{step.label}</span>
          </>
        )
        return (
          <li
            key={step.key}
            className={`nds-step ${state}${selectable ? ' selectable' : ''}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            {selectable ? (
              <button type="button" className="nds-step-hit" onClick={() => onSelect(i, step)}>
                {body}
              </button>
            ) : (
              body
            )}
            {i < steps.length - 1 && <span className="nds-step-line" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}
