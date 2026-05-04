'use client'

import { Sparkles } from 'lucide-react'
import type { StepConfig } from '../lib/steps'

interface Props {
  step: StepConfig
}

/**
 * Generic placeholder shown for every step until the corresponding
 * phase fills in the real component. Driven entirely by STEP_CONFIG so
 * adding / re-ordering steps doesn't churn this file.
 */
export default function PlaceholderStep({ step }: Props) {
  return (
    <div className="max-w-2xl mx-auto py-12 px-6">
      <div className="text-center mb-8">
        <div className="inline-flex items-center justify-center w-12 h-12 rounded-full bg-blue-50 text-blue-600 mb-4">
          <Sparkles className="w-6 h-6" />
        </div>
        <h2 className="text-[20px] font-semibold text-slate-900">
          {step.title}
        </h2>
        <p className="text-[14px] text-slate-600 mt-1">
          {step.description}
        </p>
      </div>

      <div className="border border-slate-200 rounded-lg bg-white px-6 py-8 text-center">
        <p className="text-[13px] text-slate-700 mb-2">
          This step ships in{' '}
          <span className="font-semibold text-blue-700">
            {/* Some filledIn values already include the word "Phase". */}
            {step.filledIn.startsWith('Phase')
              ? step.filledIn
              : `Phase ${step.filledIn}`}
          </span>
        </p>
        <p className="text-[12px] text-slate-500 max-w-md mx-auto">
          {step.preview}
        </p>
      </div>

      <div className="mt-6 text-[12px] text-slate-400 text-center">
        For now, click Continue to walk through the wizard shell.
      </div>
    </div>
  )
}
