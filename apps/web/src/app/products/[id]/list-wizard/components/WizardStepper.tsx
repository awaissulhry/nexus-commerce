'use client'

import { Fragment } from 'react'
import { Check } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { STEPS, stepTitleKey } from '../lib/steps'

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
  const { t } = useTranslations()
  // NN.15 — accessibility. Stepper is a single-select tablist by
  // semantics. aria-current marks the active step so screen readers
  // announce 'current page' / 'current step' on focus. Step labels
  // are exposed via aria-label so the visual number is paired with
  // the human title.
  //
  // M.1 — mobile-first split. The 9-circle horizontal layout doesn't
  // fit on a 375px viewport (~360px just for circles + connectors,
  // leaving zero room for padding). Below md (640px) we render a
  // compact "Step N of M: Title" strip + progress bar; the full
  // tablist stays available on md+ for desktop power users.
  const currentStepConfig = STEPS.find((s) => s.id === currentStep) ?? STEPS[0]
  const completedCount = STEPS.filter(
    (s) => completedSteps.has(s.id) || s.id < currentStep,
  ).length
  const progressPct = Math.min(
    100,
    Math.round((completedCount / STEPS.length) * 100),
  )
  const currentBlockers = blockerCounts?.[currentStep] ?? 0
  return (
    <>
      {/* M.1 — mobile compact stepper. Single row with current step
          info + progress bar. Tap-area is 44px tall to satisfy
          touch-target minimums. */}
      <nav
        aria-label={t('listWizard.stepper.aria.steps')}
        className="md:hidden border-b border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-950"
      >
        <div className="px-4 py-2 flex items-center gap-3">
          <span
            className="inline-flex items-center justify-center w-8 h-8 rounded-full bg-blue-600 text-white text-sm font-semibold flex-shrink-0 dark:bg-blue-500"
            aria-current="step"
          >
            {currentStep}
          </span>
          <div className="min-w-0 flex-1">
            <div className="text-base font-medium text-slate-900 dark:text-slate-100 truncate">
              {t(stepTitleKey(currentStep))}
            </div>
            <div className="text-xs text-slate-500 dark:text-slate-400 tabular-nums">
              {t('listWizard.stepper.mobileProgress', {
                current: currentStep,
                total: STEPS.length,
              })}
              {currentBlockers > 0 && (
                <span className="ml-1 text-rose-600 dark:text-rose-400">
                  · {t(
                    currentBlockers === 1
                      ? 'listWizard.stepper.aria.blockerSuffixOne'
                      : 'listWizard.stepper.aria.blockerSuffixOther',
                    { n: currentBlockers },
                  ).trim().replace(/^—\s*/, '')}
                </span>
              )}
            </div>
          </div>
        </div>
        {/* Linear progress bar — sums completed + current-step
            position. Mirrors the connector line tone on the desktop
            stepper so a glance maps to the same visual state. */}
        <div
          className="h-0.5 w-full bg-slate-100 dark:bg-slate-800"
          role="progressbar"
          aria-valuenow={progressPct}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div
            className="h-full bg-blue-600 dark:bg-blue-500 transition-all"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </nav>

      {/* Desktop tablist — unchanged from pre-M.1 except hidden below
          md so the mobile strip above takes over. */}
      <nav
        aria-label={t('listWizard.stepper.aria.steps')}
        className="hidden md:flex items-center justify-center px-6 py-3 border-b border-slate-200 bg-white overflow-x-auto dark:border-slate-800 dark:bg-slate-950"
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
                // I.3 — resolve step title through the catalog so
                // Italian operators see "Canali e mercati" instead
                // of "Channels & Markets" in tooltips + aria-labels.
                const localizedTitle = t(stepTitleKey(step.id))
                const ariaSuffix = isCompleted
                  ? t('listWizard.stepper.aria.completedSuffix')
                  : isSkipped
                    ? t('listWizard.stepper.aria.skippedSuffix')
                    : ''
                const blockerSuffix = showBadge
                  ? t(
                      blockers === 1
                        ? 'listWizard.stepper.aria.blockerSuffixOne'
                        : 'listWizard.stepper.aria.blockerSuffixOther',
                      { n: blockers },
                    )
                  : ''
                const titleStr = isSkipped
                  ? t('listWizard.stepper.title.skipped', {
                      id: step.id,
                      title: localizedTitle,
                    })
                  : showBadge
                    ? t(
                        blockers === 1
                          ? 'listWizard.stepper.title.withBlockerOne'
                          : 'listWizard.stepper.title.withBlockerOther',
                        { id: step.id, title: localizedTitle, n: blockers },
                      )
                    : t('listWizard.stepper.title.plain', {
                        id: step.id,
                        title: localizedTitle,
                      })
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isCurrent}
                    aria-current={isCurrent ? 'step' : undefined}
                    aria-label={`${t('listWizard.stepper.aria.step', {
                      n: step.id,
                      total: STEPS.length,
                      title: localizedTitle,
                    })}${ariaSuffix}${blockerSuffix}`}
                    tabIndex={isCurrent ? 0 : -1}
                    onClick={() => {
                      if (isClickable && !isCurrent) onStepClick(step.id)
                    }}
                    disabled={!isClickable}
                    title={titleStr}
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
    </>
  )
}
