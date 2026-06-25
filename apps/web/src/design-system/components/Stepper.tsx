'use client'

/**
 * Stepper — a horizontal progress indicator for multi-step flows (builders, wizards,
 * publish pipelines). Numbered circular badges joined by connector lines; steps before
 * the active index are "done" (filled primary + check), the active index is ringed and
 * strong, later steps are muted upcoming. Display-only — the parent owns `current`.
 * Requires `styles/components.css`.
 */
import { Check } from 'lucide-react'

export interface StepperStep {
  key: string
  label: string
}
export interface StepperProps {
  steps: StepperStep[]
  /** Index of the active step (0-based). Earlier = done, later = upcoming. */
  current: number
}

export function Stepper({ steps, current }: StepperProps) {
  return (
    <ol className="h10-ds-stepper">
      {steps.map((step, i) => {
        const state = i < current ? 'done' : i === current ? 'active' : 'upcoming'
        return (
          <li
            key={step.key}
            className={`h10-ds-step ${state}`}
            aria-current={state === 'active' ? 'step' : undefined}
          >
            <span className="h10-ds-step-badge">
              {state === 'done' ? <Check size={14} aria-hidden /> : <span className="h10-ds-step-num">{i + 1}</span>}
            </span>
            <span className="h10-ds-step-label">{step.label}</span>
            {i < steps.length - 1 && <span className="h10-ds-step-line" aria-hidden />}
          </li>
        )
      })}
    </ol>
  )
}
