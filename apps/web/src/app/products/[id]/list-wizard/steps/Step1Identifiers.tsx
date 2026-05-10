'use client'

// GTIN identifiers are now collected in the Product Type step (Step 2).
// This step always auto-advances on mount, carrying the identifiers state
// that was already saved there.

import { useEffect, useRef } from 'react'
import { Loader2 } from 'lucide-react'
import type { StepProps } from '../ListWizardClient'

export default function Step1Identifiers({ updateWizardState }: StepProps) {
  const firedRef = useRef(false)
  useEffect(() => {
    if (firedRef.current) return
    firedRef.current = true
    // Advance without touching identifiers — Step 2 already saved them.
    void updateWizardState({}, { advance: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="max-w-2xl mx-auto py-12 px-3 md:px-6 text-center">
      <Loader2 className="w-5 h-5 animate-spin text-slate-400 dark:text-slate-500 mx-auto mb-2" />
      <p className="text-md text-slate-500 dark:text-slate-400">Continuing…</p>
    </div>
  )
}
