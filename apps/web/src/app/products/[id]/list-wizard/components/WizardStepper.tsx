'use client'

import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { STEPS } from '../lib/steps'

interface Props {
  currentStep: number
  completedSteps: Set<number>
  onStepClick: (stepId: number) => void
}

/**
 * Horizontal stepper with 10 numbered nodes connected by lines.
 * Completed and current steps are clickable; future steps are
 * disabled — you can revisit but not skip ahead.
 */
export default function WizardStepper({
  currentStep,
  completedSteps,
  onStepClick,
}: Props) {
  return (
    <div className="flex items-center justify-center px-6 py-3 border-b border-slate-200 bg-white overflow-x-auto">
      <div className="flex items-center gap-1 min-w-max">
        {STEPS.map((step, idx) => {
          const isCurrent = step.id === currentStep
          const isCompleted = completedSteps.has(step.id)
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
                title={`Step ${step.id}: ${step.title}`}
                className={cn(
                  'relative flex items-center justify-center w-7 h-7 rounded-full text-[11px] font-medium transition-colors flex-shrink-0',
                  isCurrent &&
                    'bg-blue-600 text-white ring-4 ring-blue-100',
                  isCompleted &&
                    !isCurrent &&
                    'bg-blue-600 text-white hover:bg-blue-700 cursor-pointer',
                  !isCompleted &&
                    !isCurrent &&
                    'bg-slate-100 text-slate-400',
                  isClickable && !isCurrent && 'cursor-pointer',
                  !isClickable && 'cursor-default',
                )}
              >
                {isCompleted ? <Check className="w-3.5 h-3.5" /> : step.id}
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
