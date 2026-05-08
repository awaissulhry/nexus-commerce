'use client'

import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEPS } from '../lib/steps'

interface Props {
  currentStep: number
  completedSteps: Set<number>
  /** Phase C: steps the wizard auto-determined unnecessary (e.g.
   *  GTIN exemption when the product already has a UPC). Rendered
   *  greyed-out with a strikethrough so the user understands they
   *  weren't missed. */
  skippedSteps?: Set<number>
  /** C.0 / A9 — per-step blocker count keyed by step id. Steps with
   *  a value > 0 render a small red number badge at the corner of
   *  their stepper circle so the user can see "step 5 has 3
   *  unfilled fields" at a glance from any other step. */
  blockerCounts?: Record<number, number>
  onStepClick: (stepId: number) => void
}

/**
 * Horizontal stepper with one numbered node per STEP. Completed and
 * current steps are clickable; future steps are disabled — you can
 * revisit but not skip ahead. Skipped steps (Phase C) render in a
 * neutral grey with the number replaced by a dash, signalling
 * "we walked past this on your behalf."
 */
export default function WizardStepper({
  currentStep,
  completedSteps,
  skippedSteps,
  blockerCounts,
  onStepClick,
}: Props) {
  // NN.15 — accessibility. Stepper is a single-select tablist by
  // semantics. aria-current marks the active step so screen readers
  // announce 'current page' / 'current step' on focus. Step labels
  // are exposed via aria-label so the visual number is paired with
  // the human title.
  return (
    <nav
      aria-label="Listing wizard steps"
      className="flex items-center justify-center px-6 py-3 border-b border-slate-200 bg-white overflow-x-auto dark:border-slate-800 dark:bg-slate-950"
    >
      <ol
        role="tablist"
        aria-orientation="horizontal"
        className="flex items-center gap-1 min-w-max"
      >
        {STEPS.map((step, idx) => {
          const isCurrent = step.id === currentStep
          const isCompleted = completedSteps.has(step.id)
          const isSkipped = skippedSteps?.has(step.id) ?? false
          const isClickable = isCompleted || step.id < currentStep || isCurrent

          const lineActive = step.id < currentStep || isCompleted
          return (
            <Fragment key={step.id}>
              <li role="presentation">
              {(() => {
                // C.0 / A9 — per-step blocker badge.
                const blockers = blockerCounts?.[step.id] ?? 0
                const showBadge = blockers > 0 && !isCurrent
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isCurrent}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-label={`Step ${step.id} of ${STEPS.length}: ${step.title}${
                      isCompleted ? ' (completed)' : isSkipped ? ' (skipped)' : ''
                    }${
                      showBadge
                        ? ` — ${blockers} blocker${blockers === 1 ? '' : 's'}`
                        : ''
                    }`}
                    tabIndex={isCurrent ? 0 : -1}
                    onClick={() => {
                      if (isClickable && !isCurrent) onStepClick(step.id)
                    }}
                    disabled={!isClickable}
                    title={
                      isSkipped
                        ? `Step ${step.id}: ${step.title} (auto-skipped)`
                        : showBadge
                          ? `Step ${step.id}: ${step.title} — ${blockers} blocker${blockers === 1 ? '' : 's'}`
                          : `Step ${step.id}: ${step.title}`
                    }
                    className={cn(
                      'relative flex items-center justify-center w-7 h-7 rounded-full text-sm font-medium transition-colors flex-shrink-0',
                      isCurrent &&
                        'bg-blue-600 text-white ring-4 ring-blue-100 dark:bg-blue-500 dark:ring-blue-900',
                      isSkipped &&
                        !isCurrent &&
                        'bg-slate-200 text-slate-400 line-through cursor-default dark:bg-slate-800 dark:text-slate-600',
                      isCompleted &&
                        !isCurrent &&
                        !isSkipped &&
                        'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer dark:bg-blue-500 dark:hover:bg-blue-400',
                      !isCompleted &&
                        !isCurrent &&
                        !isSkipped &&
                        'bg-slate-100 text-slate-400 dark:bg-slate-800 dark:text-slate-500',
                      isClickable && !isCurrent && !isSkipped && 'cursor-pointer',
                      !isClickable && !isSkipped && 'cursor-default',
                    )}
                  >
                    {isSkipped ? (
                      '–'
                    ) : isCompleted ? (
                      <Check className="w-3.5 h-3.5" />
                    ) : (
                      step.id
                    )}
                    {showBadge && (
                      <span
                        aria-hidden="true"
                        className={cn(
                          'absolute -top-1 -right-1 inline-flex items-center justify-center min-w-[1rem] h-4 px-1 rounded-full text-xs font-bold tabular-nums',
                          'bg-rose-500 text-white ring-2 ring-white',
                          'dark:bg-rose-500 dark:text-white dark:ring-slate-950',
                        )}
                      >
                        {blockers > 99 ? '99+' : blockers}
                      </span>
                    )}
                  </button>
                )
              })()}

              </li>
              {idx < STEPS.length - 1 && (
                <li
                  role="presentation"
                  aria-hidden="true"
                  className={cn(
                    'h-0.5 w-8 flex-shrink-0',
                    lineActive ? 'bg-blue-600 dark:bg-blue-500' : 'bg-slate-200 dark:bg-slate-800',
                  )}
                />
              )}
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}
