'use client'

import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
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
        {/* U.10 — save state gets explicit iconography. Spinner for
            in-flight, emerald check for success, red alert for error.
            The plain "Step X of N" stays icon-less so the wizard's
            ambient state doesn't shout when nothing's happening. */}
        <span className="inline-flex items-center gap-1.5">
          {saveState === 'saving' && (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              Saving…
            </>
          )}
          {saveState === 'saved' && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700">
              <CheckCircle2 className="w-3 h-3" />
              Saved
            </span>
          )}
          {saveState === 'idle' && (
            <span className="tabular-nums">
              Step {currentStep} of {STEPS.length}
            </span>
          )}
          {saveState === 'error' && (
            <span className="inline-flex items-center gap-1.5 text-red-600">
              <AlertCircle className="w-3 h-3" />
              Save failed
            </span>
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
        {/* U.10 — kbd hint for the existing ⌘← / ⌘→ shortcuts already
            wired in ListWizardClient. Surfacing them in the nav makes
            them discoverable without changing any behaviour. */}
        <span
          className="hidden md:inline-flex items-center gap-1 text-xs text-slate-400"
          aria-hidden="true"
          title="Use ⌘← / ⌘→ to step through (Ctrl on Windows/Linux)"
        >
          <kbd className="font-mono px-1 py-px bg-slate-100 border border-slate-200 rounded text-slate-500">⌘←</kbd>
          <kbd className="font-mono px-1 py-px bg-slate-100 border border-slate-200 rounded text-slate-500">⌘→</kbd>
        </span>
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
