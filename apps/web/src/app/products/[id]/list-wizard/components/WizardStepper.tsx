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
  onStepClick,
}: Props) {
  return (
    <div className="flex items-center justify-center px-6 py-3 border-b border-slate-200 bg-white overflow-x-auto">
      <div className="flex items-center gap-1 min-w-max">
        {STEPS.map((step, idx) => {
          const isCurrent = step.id === currentStep
          const isCompleted = completedSteps.has(step.id)
          const isSkipped = skippedSteps?.has(step.id) ?? false
          const isClickable = isCompleted || step.id < currentStep || isCurrent

          const lineActive = step.id < currentStep || isCompleted
          return (
            <Fragment key={step.id}>
              <button
                type="button"
                onClick={() => {
                  if (isClickable && !isCurrent) onStepClick(step.id)
                }}
                disabled={!isClickable}
                title={
                  isSkipped
                    ? `Step ${step.id}: ${step.title} (auto-skipped)`
                    : `Step ${step.id}: ${step.title}`
                }
                className={cn(
                  'relative flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-medium transition-colors flex-shrink-0',
                  isCurrent &&
                    'bg-blue-600 text-white ring-4 ring-blue-100',
                  isSkipped &&
                    !isCurrent &&
                    'bg-slate-200 text-slate-400 line-through cursor-default',
                  isCompleted &&
                    !isCurrent &&
                    !isSkipped &&
                    'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer',
                  !isCompleted &&
                    !isCurrent &&
                    !isSkipped &&
                    'bg-slate-100 text-slate-400',
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
              </button>

              {idx < STEPS.length - 1 && (
                <div
                  className={cn(
                    'h-0.5 w-8 flex-shrink-0',
                    lineActive ? 'bg-blue-600' : 'bg-slate-200',
                  )}
                />
              )}
            </Fragment>
          )
        })}
      </div>
    </div>
  )
}
