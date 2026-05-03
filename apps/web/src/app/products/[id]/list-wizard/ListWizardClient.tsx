'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import WizardStepper from './components/WizardStepper'
import WizardHeader from './components/WizardHeader'
import WizardNav from './components/WizardNav'
import PlaceholderStep from './components/PlaceholderStep'
import Step1Identifiers from './steps/Step1Identifiers'
import Step2GtinExemption from './steps/Step2GtinExemption'
import Step3ProductType from './steps/Step3ProductType'
import Step4Attributes from './steps/Step4Attributes'
import Step5Variations from './steps/Step5Variations'
import Step6Content from './steps/Step6Content'
import Step7Images from './steps/Step7Images'
import Step8Pricing from './steps/Step8Pricing'
import Step9Review from './steps/Step9Review'
import Step10Submit from './steps/Step10Submit'
import { STEPS, findStep } from './lib/steps'

export interface WizardData {
  id: string
  productId: string
  channel: string
  marketplace: string
  currentStep: number
  state: Record<string, unknown>
  status: string
}

export interface WizardProduct {
  id: string
  sku: string
  name: string
  isParent: boolean
  brand?: string | null
  upc?: string | null
  ean?: string | null
  gtin?: string | null
}

export interface StepProps {
  wizardId: string
  wizardState: Record<string, unknown>
  updateWizardState: (
    patch: Record<string, unknown>,
    options?: { advance?: boolean },
  ) => Promise<void>
  product: WizardProduct
  channel: string
  marketplace: string
}

interface Props {
  initialWizard: WizardData
  product: WizardProduct
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export default function ListWizardClient({
  initialWizard,
  product,
}: Props) {
  const router = useRouter()

  const [wizardId] = useState(initialWizard.id)
  const [currentStep, setCurrentStep] = useState(initialWizard.currentStep)
  const [completedSteps, setCompletedSteps] = useState<Set<number>>(() => {
    // On resume, every step strictly before currentStep counts as
    // completed (the user got there by clicking Continue).
    const set = new Set<number>()
    for (let i = 1; i < initialWizard.currentStep; i++) set.add(i)
    return set
  })
  const [wizardState, setWizardState] = useState<Record<string, unknown>>(
    initialWizard.state ?? {},
  )
  const [saveState, setSaveState] = useState<SaveState>('idle')

  // Keep the latest values on a ref so the save fn closure doesn't
  // capture stale state when called from event handlers.
  const stateRef = useRef({ wizardState, currentStep })
  stateRef.current = { wizardState, currentStep }

  // Persist (currentStep, state) to the backend. Fire-and-forget so
  // step transitions feel instant; the saved indicator updates when
  // the request settles.
  const persist = useCallback(
    async (overrides?: {
      currentStep?: number
      state?: Record<string, unknown>
    }): Promise<boolean> => {
      const target = {
        currentStep: overrides?.currentStep ?? stateRef.current.currentStep,
        state: overrides?.state ?? stateRef.current.wizardState,
      }
      setSaveState('saving')
      try {
        const res = await fetch(
          `${getBackendUrl()}/api/listing-wizard/${wizardId}`,
          {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(target),
          },
        )
        if (!res.ok) {
          setSaveState('error')
          return false
        }
        setSaveState('saved')
        // Auto-revert the indicator back to idle after a moment so it
        // doesn't sit on "Saved" forever.
        window.setTimeout(() => {
          setSaveState((s) => (s === 'saved' ? 'idle' : s))
        }, 1500)
        return true
      } catch {
        setSaveState('error')
        return false
      }
    },
    [wizardId],
  )

  const navigateTo = useCallback(
    (target: number) => {
      const clamped = Math.min(Math.max(target, 1), STEPS.length)
      setCurrentStep(clamped)
      // Fire the save without awaiting — UI is already updated.
      void persist({ currentStep: clamped })
    },
    [persist],
  )

  const handleContinue = useCallback(() => {
    if (currentStep >= STEPS.length) return
    setCompletedSteps((prev) => {
      if (prev.has(currentStep)) return prev
      const next = new Set(prev)
      next.add(currentStep)
      return next
    })
    navigateTo(currentStep + 1)
  }, [currentStep, navigateTo])

  const handleBack = useCallback(() => {
    if (currentStep <= 1) return
    navigateTo(currentStep - 1)
  }, [currentStep, navigateTo])

  const handleStepClick = useCallback(
    (target: number) => {
      // Only allow clicking back to a completed step or the current
      // one — future steps are gated by Continue.
      if (target > currentStep && !completedSteps.has(target)) return
      navigateTo(target)
    },
    [currentStep, completedSteps, navigateTo],
  )

  const handleClose = useCallback(async () => {
    await persist()
    router.push(`/products/${product.id}/edit`)
  }, [persist, router, product.id])

  // Cmd/Ctrl + arrow shortcuts make stepping through the wizard feel
  // closer to a guided form than a series of clicks. Skip when an
  // input is focused so it doesn't fight text-cursor nav.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const ae = document.activeElement as HTMLElement | null
      if (
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)
      ) {
        return
      }
      if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleContinue()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleBack()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleContinue, handleBack])

  // Step components mutate their slice of wizardState via this
  // callback. The patch is shallow-merged at the top level (so Step
  // 1 writes into wizardState.identifiers without touching other
  // slices) and persisted on the next PATCH cycle. With advance=true
  // we also bump currentStep, which is what Step 1 uses when the
  // user picks a path that doesn't need Step 2.
  const updateWizardState = useCallback(
    async (
      patch: Record<string, unknown>,
      options?: { advance?: boolean },
    ) => {
      const merged = {
        ...stateRef.current.wizardState,
        ...patch,
      }
      setWizardState(merged)
      if (options?.advance) {
        const target = Math.min(currentStep + 1, STEPS.length)
        setCompletedSteps((prev) => {
          if (prev.has(currentStep)) return prev
          const next = new Set(prev)
          next.add(currentStep)
          return next
        })
        setCurrentStep(target)
        await persist({ currentStep: target, state: merged })
      } else {
        await persist({ state: merged })
      }
    },
    [currentStep, persist],
  )

  const step = findStep(currentStep) ?? STEPS[0]

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      <WizardHeader
        productId={product.id}
        productSku={product.sku}
        productName={product.name}
        channel={initialWizard.channel}
        marketplace={initialWizard.marketplace}
        onClose={handleClose}
      />
      <WizardStepper
        currentStep={currentStep}
        completedSteps={completedSteps}
        onStepClick={handleStepClick}
      />
      <div className="flex-1 overflow-y-auto">
        {(() => {
          const stepProps = {
            wizardId,
            wizardState,
            updateWizardState,
            product,
            channel: initialWizard.channel,
            marketplace: initialWizard.marketplace,
          }
          if (currentStep === 1) return <Step1Identifiers {...stepProps} />
          if (currentStep === 2) return <Step2GtinExemption {...stepProps} />
          if (currentStep === 3) {
            // Step 3 (Product Type) is Amazon-only — Shopify and
            // WooCommerce don't have an equivalent SKU-level taxonomy
            // pipeline, and eBay is blocked behind Phase 2A. For other
            // channels we render the placeholder card with the existing
            // "ships in Phase 6" copy so the user can still walk the
            // shell.
            if (initialWizard.channel === 'AMAZON') {
              return <Step3ProductType {...stepProps} />
            }
            return <PlaceholderStep step={step} />
          }
          if (currentStep === 4) {
            // Step 4 reads the productType selected in Step 3, so
            // it's also Amazon-only for now. The component itself
            // handles the non-Amazon case with a "skipping" message.
            return <Step4Attributes {...stepProps} />
          }
          if (currentStep === 5) {
            // Step 5 (Variations) works for any channel — it just
            // surfaces parent → children + a theme picker. Themes
            // come from the cached Amazon schema today; for other
            // channels the theme dropdown is empty until those
            // schemas are wired.
            return <Step5Variations {...stepProps} />
          }
          if (currentStep === 6) return <Step6Content {...stepProps} />
          if (currentStep === 7) return <Step7Images {...stepProps} />
          if (currentStep === 8) return <Step8Pricing {...stepProps} />
          if (currentStep === 9) return <Step9Review {...stepProps} />
          if (currentStep === 10) return <Step10Submit {...stepProps} />
          return <PlaceholderStep step={step} />
        })()}
      </div>
      <WizardNav
        currentStep={currentStep}
        saveState={saveState}
        onBack={handleBack}
        onContinue={handleContinue}
        onSaveAndExit={handleClose}
      />
    </div>
  )
}
