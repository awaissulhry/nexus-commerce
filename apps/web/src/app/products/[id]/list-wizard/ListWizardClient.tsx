'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import WizardStepper from './components/WizardStepper'
import WizardHeader from './components/WizardHeader'
import WizardNav from './components/WizardNav'
import PlaceholderStep from './components/PlaceholderStep'
import Step1Identifiers from './steps/Step1Identifiers'
import Step3ProductType from './steps/Step3ProductType'
import Step4Attributes from './steps/Step4Attributes'
import Step5Variations from './steps/Step5Variations'
import Step7Images from './steps/Step7Images'
import Step8Pricing from './steps/Step8Pricing'
import Step9Review from './steps/Step9Review'
import Step10Submit from './steps/Step10Submit'
import Step1Channels from './steps/Step1Channels'
import Step0Setup from './steps/Step0Setup'
import { STEPS, findStep } from './lib/steps'

export interface ChannelTuple {
  platform: string
  marketplace: string
}

export interface WizardData {
  id: string
  productId: string
  /** Multi-channel selection. Phase B: array may be empty when the
   *  user hasn't reached Step 1 yet. */
  channels: ChannelTuple[]
  channelsHash?: string
  currentStep: number
  state: Record<string, unknown>
  channelStates?: Record<string, Record<string, unknown>>
  submissions?: unknown[]
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
  /** Phase B canonical multi-channel selection. */
  channels: ChannelTuple[]
  /** Step 1 commits the user's selection here, optionally advancing. */
  updateWizardChannels: (
    next: ChannelTuple[],
    options?: { advance?: boolean },
  ) => Promise<void>
  /** Backwards-compat: first entry of channels[]. Phase D-G widen
   *  individual steps off these props. Throws conceptually if
   *  channels is empty — Step 1 enforces non-empty before advancing,
   *  so downstream steps can rely on these being defined. */
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
  const [channels, setChannels] = useState<ChannelTuple[]>(
    initialWizard.channels ?? [],
  )
  // L.1: GTIN exemption is no longer a separate step (merged into
  // Identifiers), so nothing currently writes to skippedSteps. Kept
  // around — and threaded into WizardStepper — so future conditional
  // steps can render greyed without re-plumbing.
  const [skippedSteps] = useState<Set<number>>(new Set())
  const [saveState, setSaveState] = useState<SaveState>('idle')

  // Keep the latest values on a ref so the save fn closure doesn't
  // capture stale state when called from event handlers.
  const stateRef = useRef({ wizardState, currentStep, channels })
  stateRef.current = { wizardState, currentStep, channels }

  // Persist (currentStep, state, channels) to the backend.
  // Fire-and-forget so step transitions feel instant; the saved
  // indicator updates when the request settles.
  const persist = useCallback(
    async (overrides?: {
      currentStep?: number
      state?: Record<string, unknown>
      channels?: ChannelTuple[]
    }): Promise<boolean> => {
      const target: Record<string, unknown> = {
        currentStep: overrides?.currentStep ?? stateRef.current.currentStep,
        state: overrides?.state ?? stateRef.current.wizardState,
      }
      if (overrides?.channels !== undefined) {
        target.channels = overrides.channels
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

  // NN.3 — beforeunload guard while a save is in flight. If the user
  // closes the tab between persist() armed and PATCH settled, the
  // wizard's last state delta vanishes. saveState === 'saving' is a
  // tight enough window that we don't want to confirm-on-leave when
  // there's nothing pending — the wizard auto-saves quickly.
  useEffect(() => {
    if (saveState !== 'saving') return
    function onBeforeUnload(e: BeforeUnloadEvent) {
      e.preventDefault()
      e.returnValue = ''
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    return () => window.removeEventListener('beforeunload', onBeforeUnload)
  }, [saveState])

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

  // Step 1's commit path. Persists channels[] AND optionally bumps
  // currentStep. We pass channels through the same persist() call so
  // the wizard row update is atomic.
  const updateWizardChannels = useCallback(
    async (next: ChannelTuple[], options?: { advance?: boolean }) => {
      setChannels(next)
      if (options?.advance) {
        const target = Math.min(currentStep + 1, STEPS.length)
        setCompletedSteps((prev) => {
          if (prev.has(currentStep)) return prev
          const set = new Set(prev)
          set.add(currentStep)
          return set
        })
        setCurrentStep(target)
        await persist({ currentStep: target, channels: next })
      } else {
        await persist({ channels: next })
      }
    },
    [currentStep, persist],
  )

  const step = findStep(currentStep) ?? STEPS[0]
  // Single source of truth for "first channel" used by step components
  // not yet widened to multi-channel. Phase D-G replace these reads
  // with full channels[] usage. Empty array (Step 1 not yet completed)
  // → empty strings, which the downstream steps treat as "no channel
  // selected" and refuse to render until Step 1 is done.
  const firstChannel = channels[0] ?? { platform: '', marketplace: '' }

  return (
    <div className="flex flex-col h-screen bg-slate-50">
      <WizardHeader
        productId={product.id}
        productSku={product.sku}
        productName={product.name}
        channels={channels}
        onClose={handleClose}
      />
      <WizardStepper
        currentStep={currentStep}
        completedSteps={completedSteps}
        skippedSteps={skippedSteps}
        onStepClick={handleStepClick}
      />
      <div className="flex-1 overflow-y-auto">
        {(() => {
          const stepProps = {
            wizardId,
            wizardState,
            updateWizardState,
            product,
            channels,
            updateWizardChannels,
            channel: firstChannel.platform,
            marketplace: firstChannel.marketplace,
          }

          // TT — Step 0: Setup (create-flow only). Existing wizards
          // never have currentStep === 0 — their default is 1, so
          // this branch is invisible to anyone editing an existing
          // product. Only the /products/new auto-create path lands
          // a wizard with currentStep=0 to surface this step.
          if (currentStep === 0) return <Step0Setup {...stepProps} />

          // ── Phase B step routing ────────────────────────────────
          // Step 1: Channels & Markets (NEW)
          if (currentStep === 1) return <Step1Channels {...stepProps} />

          // After Step 1 the user must have at least one channel
          // selected. If they're on a later step but the array is
          // empty (resumed wizard pre-Step-1), bounce them back.
          if (channels.length === 0) {
            return <NeedsChannelsBlock onPickChannels={() => navigateTo(1)} />
          }

          // Step 2: Product Type (was Step 3 in the old flow).
          // Step3ProductType itself walks every channel and dispatches
          // per-platform (Amazon list mode, eBay search mode, others
          // marked skipped) — so we always render it, regardless of
          // which channel happens to be first.
          if (currentStep === 2) return <Step3ProductType {...stepProps} />

          // Step 3: Identifiers — L.1 inlines the GTIN exemption form
          // when path === 'apply-now', so there's no separate Step 4
          // for GTIN anymore. /gtin-status auto-skip logic moved into
          // Step1Identifiers via the embedded Step2GtinExemption.
          if (currentStep === 3) return <Step1Identifiers {...stepProps} />
          // Step 4: Variations (was Step 5).
          if (currentStep === 4) return <Step5Variations {...stepProps} />
          // Step 5: Attributes (was Step 6).
          if (currentStep === 5) return <Step4Attributes {...stepProps} />
          // L.3 — Content step removed; the 4 content fields
          // (item_name, bullet_point, product_description,
          // generic_keyword) are surfaced inside Step 5 (Attributes)
          // via the curated common-optional set + per-field AI
          // generate (L.2). Pricing now sits at currentStep 7.
          if (currentStep === 6) return <Step7Images {...stepProps} />
          if (currentStep === 7) return <Step8Pricing {...stepProps} />
          if (currentStep === 8) return <Step9Review {...stepProps} />
          if (currentStep === 9) return <Step10Submit {...stepProps} />
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

function NeedsChannelsBlock({
  onPickChannels,
}: {
  onPickChannels: () => void
}) {
  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-4 text-center">
        <h3 className="text-[14px] font-semibold text-amber-900">
          Pick channels first
        </h3>
        <p className="mt-1 text-[12px] text-amber-800">
          The rest of the wizard adapts to your channel selection. Head
          back to Step 1 and pick at least one (platform, marketplace)
          to keep going.
        </p>
        <button
          type="button"
          onClick={onPickChannels}
          className="mt-3 h-8 px-3 rounded-md bg-amber-600 text-white text-[12px] font-medium hover:bg-amber-700"
        >
          Go to Step 1
        </button>
      </div>
    </div>
  )
}
