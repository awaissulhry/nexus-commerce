'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { getBackendUrl } from '@/lib/backend-url'
import WizardStepper from './components/WizardStepper'
import WizardHeader from './components/WizardHeader'
import WizardNav from './components/WizardNav'
import BlockerBanner from './components/BlockerBanner'
import ResumeBanner from './components/ResumeBanner'
import PlaceholderStep from './components/PlaceholderStep'
import Step1Identifiers from './steps/Step1Identifiers'
import Step3ProductType from './steps/Step3ProductType'
import Step4Attributes from './steps/Step4Attributes'
import Step5Variations from './steps/Step5Variations'
import Step7Images from './steps/Step7Images'
import Step8Pricing from './steps/Step8Pricing'
import Step9Review from './steps/Step9Review'
import Step9Submit from './steps/Step9Submit'
import Step1Channels from './steps/Step1Channels'
import { STEPS, findStep } from './lib/steps'
import { postWizardEvent } from './lib/telemetry'
import { useConfirm } from '@/components/ui/ConfirmProvider'
import { useToast } from '@/components/ui/Toast'
import { useTranslations } from '@/lib/i18n/use-translations'
import { emitInvalidation } from '@/lib/sync/invalidation-channel'

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
  /** ISO timestamp of the last server-side mutation. Used by the
   *  resume context banner to compute "last edited X ago". */
  updatedAt?: string
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

export interface StepValidity {
  valid: boolean
  /** 0 means valid; >0 means N reasons preventing forward progress. */
  blockers: number
  /** Human-readable; first 3 surfaced in the WizardNav tooltip. */
  reasons?: string[]
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
  /** U.4 — exposed so Step 9 (Review) can deep-link incomplete
   *  checklist rows back to the originating step. */
  onJumpToStep: (stepId: number) => void
  /** C.0 — step reports its validity up to the wizard so the global
   *  Continue button can gate. Stable identity across renders, so
   *  it's safe to use directly in useEffect deps. Steps that don't
   *  need gating can ignore it. */
  reportValidity: (validity: StepValidity) => void
  /** C.0 / A1 — step registers a callback to scroll + focus its
   *  first blocker. Fired when the user clicks the disabled Continue
   *  button or hits Cmd+Enter / Cmd+G while gated. Pass null on
   *  unmount to clear the registration. Steps without gating can
   *  ignore. */
  setJumpToBlocker: (fn: (() => void) | null) => void
}

interface Props {
  initialWizard: WizardData
  product: WizardProduct
  /** C.7 — true when /start created a fresh ListingWizard row (vs
   *  resuming an existing DRAFT). When true, the client fires a
   *  one-shot wizard.created broadcast on mount so /products/drafts
   *  in another tab refreshes within ~200ms instead of waiting for
   *  its 30s polling tick. */
  isNew?: boolean
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error'

export default function ListWizardClient({
  initialWizard,
  product,
  isNew,
}: Props) {
  const router = useRouter()
  const { t } = useTranslations()

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

  // C.0 — per-step validity, keyed by routing step id. Steps that
  // don't report validity (Step 1 Channels, Step 2 Product Type,
  // Step 9 Submit) leave their key undefined; the chrome treats
  // undefined as "no opinion" and lets Continue through.
  const [stepValidity, setStepValidity] = useState<
    Record<number, StepValidity>
  >({})
  const stepValidityRef = useRef(stepValidity)
  stepValidityRef.current = stepValidity

  // C.0 / A1 — current step's "jump to first blocker" callback.
  // Set by the active step on mount, cleared on unmount. The chrome
  // calls it via onContinueAttemptWhileBlocked from WizardNav.
  const jumpToBlockerRef = useRef<(() => void) | null>(null)

  // C.0 / A6 — optimistic-concurrency conflict detection. PATCH /:id
  // bumps the row version; a 409 means the local wizard state diverged
  // from the server (e.g., another tab edited it). We surface a
  // sticky banner with a refresh CTA — silently overwriting would
  // discard the other tab's edits.
  const [conflictDetected, setConflictDetected] = useState(false)

  // C.0 / A7 — time-on-step. Resets when currentStep changes; ticks
  // every second. WizardNav renders mm:ss after 30s of dwell so
  // power users notice when they've stalled, but it stays out of
  // the chrome for fast steppers.
  const stepEnteredAtRef = useRef<number>(Date.now())
  const [timeOnStepSeconds, setTimeOnStepSeconds] = useState(0)

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
          // C.0 / A6 — 409 means optimistic-concurrency conflict.
          // Surface the sticky banner so the user notices and
          // refreshes rather than continuing on top of a stale
          // wizard. Telemetry captures the conflict for analytics.
          if (res.status === 409) {
            setConflictDetected(true)
            postWizardEvent(wizardId, {
              type: 'validation_failed',
              step: stateRef.current.currentStep,
              errorCode: 'conflict_409',
              errorContext: { reason: 'conflict_409' },
            })
          }
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

  // C.0 / A5 — Discard wizard.
  // Soft-deletes the DRAFT wizard server-side (status='DISCARDED' so
  // the WizardStepEvent trail survives), broadcasts wizard.deleted
  // so /products/drafts and /products refresh without polling, then
  // navigates back to the product edit page.
  const confirm = useConfirm()
  const { toast } = useToast()
  const handleDiscard = useCallback(async () => {
    const ok = await confirm({
      title: t('listWizard.client.discardConfirmTitle'),
      description: t('listWizard.client.discardConfirmDesc'),
      confirmLabel: t('listWizard.client.discardConfirmAction'),
      tone: 'danger',
    })
    if (!ok) return
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/listing-wizard/${wizardId}`,
        { method: 'DELETE' },
      )
      if (!res.ok) {
        const json = (await res.json().catch(() => ({}))) as {
          error?: string
        }
        toast({
          tone: 'error',
          title: t('listWizard.client.discardErrorTitle'),
          description: json.error ?? `HTTP ${res.status}`,
        })
        return
      }
      emitInvalidation({
        type: 'wizard.deleted',
        id: wizardId,
        meta: { productId: product.id },
      })
      router.push(`/products/${product.id}/edit`)
    } catch (err) {
      toast({
        tone: 'error',
        title: t('listWizard.client.discardErrorTitle'),
        description: err instanceof Error ? err.message : String(err),
      })
    }
  }, [confirm, t, toast, wizardId, product.id, router])

  // C.0 — steps call this to report their validity. We compare to
  // the previous record before bumping state to avoid render loops
  // when a step re-reports the same {valid, blockers} on every
  // render (which is the common case — useEffect deps fire even
  // when content is identical).
  //
  // Edge transitions (valid→invalid or invalid→valid) emit a
  // validation_failed/validation_passed telemetry event so we can
  // measure time-to-validity per step. Bug #10 fix — first-time
  // reports (prev undefined) emit too when the step landed invalid,
  // so analytics see "user hit step N already broken" without having
  // to infer it from the absence of a passed event.
  const reportValidity = useCallback((next: StepValidity) => {
    const stepNow = stateRef.current.currentStep
    const prev = stepValidityRef.current[stepNow]
    if (
      prev &&
      prev.valid === next.valid &&
      prev.blockers === next.blockers
    ) {
      return
    }
    setStepValidity((cur) => ({ ...cur, [stepNow]: next }))

    const isFirstReport = !prev
    const flipped = !!prev && prev.valid !== next.valid
    if (flipped || (isFirstReport && !next.valid)) {
      postWizardEvent(wizardId, {
        type: next.valid ? 'validation_passed' : 'validation_failed',
        step: stepNow,
        errorCode: next.valid ? undefined : 'missing_required',
        errorContext: { blockerCount: next.blockers },
      })
    }
  }, [wizardId])

  // C.0 / A1 — steps register their first-blocker focus callback
  // here. Stable identity (deps: []), so a step can pass it directly
  // into a useEffect that runs once on mount.
  const setJumpToBlocker = useCallback(
    (fn: (() => void) | null) => {
      jumpToBlockerRef.current = fn
    },
    [],
  )

  // C.0 / A1 — fired when the user clicks the disabled Continue or
  // hits Cmd+Enter / Cmd+G while gated. Calls the active step's
  // registered focus callback (if any) and emits a jumped_to_step
  // event so analytics can measure how often users hit the gate.
  const handleContinueAttemptWhileBlocked = useCallback(() => {
    const stepNow = stateRef.current.currentStep
    postWizardEvent(wizardId, {
      type: 'jumped_to_step',
      step: stepNow,
      errorContext: {
        reason: 'continue_attempt_while_blocked',
        fromStep: stepNow,
        toStep: stepNow,
        blockerCount:
          stepValidityRef.current[stepNow]?.blockers ?? 0,
      },
    })
    jumpToBlockerRef.current?.()
  }, [wizardId])

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

  // Cmd/Ctrl + arrow shortcuts + Cmd+Enter (smart Continue, A8) +
  // Cmd+G (jump to first blocker, A1). Skip when an input/textarea
  // is focused so it doesn't fight text-cursor nav. Cmd+Enter is
  // smart: when validity is gated it jumps to the blocker instead
  // of trying to advance.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey)) return
      const ae = document.activeElement as HTMLElement | null
      const inText =
        ae &&
        (ae.tagName === 'INPUT' ||
          ae.tagName === 'TEXTAREA' ||
          ae.isContentEditable)

      // Cmd+G works even from inside an input — the user is
      // explicitly asking "where am I stuck?" and the focus stays
      // captured as part of the jump action.
      if (e.key === 'g' || e.key === 'G') {
        const cur =
          stepValidityRef.current[stateRef.current.currentStep]
        if (cur && !cur.valid) {
          e.preventDefault()
          handleContinueAttemptWhileBlocked()
        }
        return
      }

      if (inText) return

      if (e.key === 'ArrowRight') {
        e.preventDefault()
        handleContinue()
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault()
        handleBack()
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const cur =
          stepValidityRef.current[stateRef.current.currentStep]
        if (cur && !cur.valid) {
          handleContinueAttemptWhileBlocked()
        } else {
          handleContinue()
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleContinue, handleBack, handleContinueAttemptWhileBlocked])

  // C.0 / A7 — reset stepEnteredAt + tick timeOnStepSeconds while
  // the user is on a step. Resets to 0 on transition; ticks every
  // second. Cheap (one re-render per second on the chrome only —
  // the step content doesn't depend on this state).
  useEffect(() => {
    stepEnteredAtRef.current = Date.now()
    setTimeOnStepSeconds(0)
    const id = window.setInterval(() => {
      setTimeOnStepSeconds(
        Math.floor((Date.now() - stepEnteredAtRef.current) / 1000),
      )
    }, 1000)
    return () => window.clearInterval(id)
  }, [currentStep])

  // C.7 — one-shot wizard.created broadcast on fresh mount. The /start
  // handler returns isNew=true exactly when it created a new row (vs
  // resuming an existing DRAFT). Guarded by a ref so React strict-mode
  // double-invocation, hot reload, and re-mounts can't double-fire
  // the event. /products/drafts subscribes and refreshes within
  // ~200ms cross-tab instead of waiting for its 30s polling tick.
  const wizardCreatedFiredRef = useRef(false)
  useEffect(() => {
    if (!isNew) return
    if (wizardCreatedFiredRef.current) return
    wizardCreatedFiredRef.current = true
    emitInvalidation({
      type: 'wizard.created',
      id: wizardId,
      meta: { productId: product.id },
    })
  }, [isNew, wizardId, product.id])

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
    <div className="flex flex-col h-[100dvh] bg-slate-50">
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
        blockerCounts={Object.fromEntries(
          Object.entries(stepValidity)
            .filter(([, v]) => !v.valid)
            .map(([k, v]) => [Number(k), v.blockers]),
        )}
        onStepClick={handleStepClick}
      />
      <div className="flex-1 overflow-y-auto">
        {/* C.1 / A.5.5 — resume context banner. Renders briefly when
            the user opened a wizard they had paused (>5min stale +
            beyond Step 1). Self-dismisses after 8s. */}
        <ResumeBanner
          currentStep={initialWizard.currentStep}
          updatedAt={initialWizard.updatedAt}
        />
        {/* C.0 / A2 — global sticky blocker banner. Hidden on Step 5
            (Attributes) which has its richer in-step ValidationSummary.
            Visible on Steps 4, 6, 7, 8 — the steps where validity is
            otherwise only signalled by the chrome pill. */}
        {currentStep !== 5 &&
          stepValidity[currentStep] &&
          !stepValidity[currentStep].valid && (
            <BlockerBanner
              blockerCount={stepValidity[currentStep].blockers}
              reasons={stepValidity[currentStep].reasons ?? []}
              onJump={handleContinueAttemptWhileBlocked}
            />
          )}
        {conflictDetected && (
          <div
            role="alert"
            className="sticky top-0 z-20 px-6 py-3 bg-rose-50 border-b border-rose-200 flex items-center justify-between gap-3 dark:bg-rose-950 dark:border-rose-800"
          >
            <div className="text-base text-rose-800 dark:text-rose-200">
              <span className="font-semibold">
                {t('listWizard.client.conflictTitle')}
              </span>{' '}
              {t('listWizard.client.conflictDesc')}
            </div>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="flex-shrink-0 h-8 px-3 rounded-md bg-rose-600 text-white text-base font-medium hover:bg-rose-700 dark:bg-rose-500 dark:hover:bg-rose-400"
            >
              {t('listWizard.client.conflictRefresh')}
            </button>
          </div>
        )}
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
            onJumpToStep: navigateTo,
            reportValidity,
            setJumpToBlocker,
          }

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
          if (currentStep === 9) return <Step9Submit {...stepProps} />
          return <PlaceholderStep step={step} />
        })()}
      </div>
      <WizardNav
        currentStep={currentStep}
        saveState={saveState}
        onBack={handleBack}
        onContinue={handleContinue}
        onSaveAndExit={handleClose}
        continueDisabled={
          stepValidity[currentStep]
            ? !stepValidity[currentStep].valid
            : false
        }
        blockerCount={stepValidity[currentStep]?.blockers ?? 0}
        blockerReasons={stepValidity[currentStep]?.reasons}
        onContinueAttemptWhileBlocked={handleContinueAttemptWhileBlocked}
        onDiscard={
          initialWizard.status === 'DRAFT' ? handleDiscard : undefined
        }
        timeOnStepSeconds={timeOnStepSeconds}
      />
    </div>
  )
}

function NeedsChannelsBlock({
  onPickChannels,
}: {
  onPickChannels: () => void
}) {
  const { t } = useTranslations()
  return (
    <div className="max-w-xl mx-auto py-12 px-6">
      <div className="border border-amber-200 bg-amber-50 rounded-lg px-4 py-4 text-center">
        <h3 className="text-lg font-semibold text-amber-900">
          {t('listWizard.client.needsChannelsTitle')}
        </h3>
        <p className="mt-1 text-base text-amber-800">
          {t('listWizard.client.needsChannelsDesc')}
        </p>
        <button
          type="button"
          onClick={onPickChannels}
          className="mt-3 h-8 px-3 rounded-md bg-amber-600 text-white text-base font-medium hover:bg-amber-700"
        >
          {t('listWizard.client.needsChannelsAction')}
        </button>
      </div>
    </div>
  )
}
