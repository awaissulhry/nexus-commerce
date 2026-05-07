'use client'

import { ChevronLeft, ChevronRight } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { STEPS } from '../lib/steps'

interface Props {
  currentStep: number
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  onBack: () => void
  onContinue: () => void
  onSaveAndExit: () => void
  /** Disabled when the current step is in a state that blocks
   *  forward progress (e.g. validation errors). For the 5.3 shell
   *  every step is always free to continue. */
  continueDisabled?: boolean
}

export default function WizardNav({
  currentStep,
  saveState,
  onBack,
  onContinue,
  onSaveAndExit,
  continueDisabled,
}: Props) {
  const isFirst = currentStep <= 1
  const isLast = currentStep >= STEPS.length
  return (
    <div className="px-6 py-3 border-t border-slate-200 bg-white flex items-center justify-between flex-shrink-0">
      <div className="flex items-center gap-3 text-base text-slate-500">
        <button
          type="button"
          onClick={onSaveAndExit}
          className="hover:text-slate-900"
        >
          Save & exit
        </button>
        <span className="text-slate-300">·</span>
        <span>
          {saveState === 'saving' && 'Saving…'}
          {saveState === 'saved' && 'Saved'}
          {saveState === 'idle' && `Step ${currentStep} of ${STEPS.length}`}
          {saveState === 'error' && (
            <span className="text-red-600">Save failed</span>
          )}
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="secondary"
          size="sm"
          onClick={onBack}
          disabled={isFirst}
        >
          <ChevronLeft className="w-3.5 h-3.5 mr-0.5" />
          Back
        </Button>
        <Button
          variant="primary"
          size="sm"
          onClick={onContinue}
          disabled={isLast || !!continueDisabled}
        >
          {isLast ? 'Final step' : 'Continue'}
          {!isLast && <ChevronRight className="w-3.5 h-3.5 ml-0.5" />}
        </Button>
      </div>
    </div>
  )
}
