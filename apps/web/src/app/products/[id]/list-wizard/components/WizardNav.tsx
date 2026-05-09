'use client'

import { useId } from 'react'
import {
  AlertCircle,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Loader2,
} from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Tooltip } from '@/components/ui/Tooltip'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { STEPS } from '../lib/steps'

type Translator = ReturnType<typeof useTranslations>['t']

interface Props {
  currentStep: number
  saveState: 'idle' | 'saving' | 'saved' | 'error'
  onBack: () => void
  onContinue: () => void
  onSaveAndExit: () => void
  /** Disabled when the current step is in a state that blocks
   *  forward progress (e.g. validation errors). C.0 wires this from
   *  per-step reportValidity so every step gets consistent gating. */
  continueDisabled?: boolean
  /** C.0 — when continueDisabled, render this count as a pill on
   *  the Continue button so the blocker count is visible without
   *  hovering. 0 hides the pill. */
  blockerCount?: number
  /** C.0 — top-3 reasons surfaced via the disabled button's tooltip.
   *  The Tooltip primitive (touch-friendly, screen-reader-friendly)
   *  replaces a native title= which Safari hid on disabled buttons
   *  and which never rendered on touch devices. */
  blockerReasons?: string[]
  /** C.0 / A1 — fired when the user clicks the disabled Continue
   *  button (or hits Cmd+Enter / Cmd+G while gated). The active
   *  step uses this to scroll + focus the first blocker. */
  onContinueAttemptWhileBlocked?: () => void
  /** C.0 / A5 — discard the draft. Only present when the wizard is
   *  in DRAFT status (terminal wizards aren't discardable). The
   *  caller handles confirmation + DELETE + navigation; this prop is
   *  just the trigger. */
  onDiscard?: () => void
  /** C.0 / A7 — seconds spent on the current step. Rendered next to
   *  save state so power users notice when they've stalled. Hidden
   *  under 30s so the chrome doesn't shout at quick steppers. */
  timeOnStepSeconds?: number
}

function buildBlockerSummary(
  t: Translator,
  blockerCount: number | undefined,
  reasons: string[] | undefined,
): string | undefined {
  if (!blockerCount || blockerCount <= 0) return undefined
  // Compose the count fragment with singular/plural picked from the
  // catalog rather than English's '' / 's' suffix shortcut so Italian
  // reads as "1 blocco" / "2 blocchi" instead of "1 blockers".
  const countFragment = t(
    blockerCount === 1
      ? 'listWizard.nav.blockerCountOne'
      : 'listWizard.nav.blockerCountOther',
    { n: blockerCount },
  )
  const top = (reasons ?? []).slice(0, 3)
  if (top.length === 0) {
    return t('listWizard.nav.blockerSummaryNoReasons', { count: countFragment })
  }
  const reasonsText = top.join('; ')
  const more = reasons && reasons.length > top.length
    ? reasons.length - top.length
    : 0
  return more > 0
    ? t('listWizard.nav.blockerSummaryWithTopAndMore', {
        count: countFragment,
        reasons: reasonsText,
        more,
      })
    : t('listWizard.nav.blockerSummaryWithTop', {
        count: countFragment,
        reasons: reasonsText,
      })
}

// A7 — compact mm:ss formatter for the time-on-step pill.
function formatSeconds(total: number): string {
  const s = Math.max(0, Math.floor(total))
  const mm = Math.floor(s / 60)
  const ss = s % 60
  return `${mm}:${ss.toString().padStart(2, '0')}`
}

export default function WizardNav({
  currentStep,
  saveState,
  onBack,
  onContinue,
  onSaveAndExit,
  continueDisabled,
  blockerCount,
  blockerReasons,
  onContinueAttemptWhileBlocked,
  onDiscard,
  timeOnStepSeconds,
}: Props) {
  const { t } = useTranslations()
  const isFirst = currentStep <= 1
  const isLast = currentStep >= STEPS.length
  const isGated = !!continueDisabled && !isLast
  const showBlockerPill = isGated && (blockerCount ?? 0) > 0
  const blockerSummary = buildBlockerSummary(t, blockerCount, blockerReasons)

  // Bug #1 — useId() so the pill's aria-describedby target is unique
  // even if two WizardNavs ever co-render in the same tree.
  const blockersId = useId()

  // A8 — smart Continue. When gated, click jumps to the first blocker
  // (the active step registers its focus callback via
  // onContinueAttemptWhileBlocked); when not, advance normally.
  // Using aria-disabled instead of disabled keeps the button reachable
  // by keyboard and click handlers — disabled HTMLButtonElement
  // swallows clicks, so we couldn't intercept "user tried to advance
  // but can't" without this.
  const handleContinueClick = () => {
    if (isLast) return
    if (isGated) {
      onContinueAttemptWhileBlocked?.()
      return
    }
    onContinue()
  }

  return (
    <div
      className={cn(
        'px-6 py-3 border-t flex items-center justify-between flex-shrink-0',
        'border-slate-200 bg-white',
        'dark:border-slate-800 dark:bg-slate-950',
      )}
    >
      {/* Bug #4 — aria-live region for validity / save state changes.
          Visually hidden; screen-reader-only. Announces when the
          blocker count changes or the save state flips so SR users
          don't have to re-focus the Continue button to learn the
          state. */}
      <div role="status" aria-live="polite" className="sr-only">
        {isGated && blockerSummary
          ? blockerSummary
          : isLast
            ? t('listWizard.nav.finalStepAlert')
            : saveState === 'error'
              ? t('listWizard.nav.saveFailedAlert')
              : ''}
      </div>

      <div className="flex items-center gap-3 text-base text-slate-500 dark:text-slate-400">
        <button
          type="button"
          onClick={onSaveAndExit}
          className="hover:text-slate-900 dark:hover:text-slate-100"
        >
          {t('listWizard.nav.saveExit')}
        </button>
        {onDiscard && (
          <>
            <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
            <Tooltip
              content={t('listWizard.nav.discardTooltip')}
              placement="top"
            >
              <button
                type="button"
                onClick={onDiscard}
                className="text-rose-600 hover:text-rose-800 dark:text-rose-400 dark:hover:text-rose-300"
              >
                {t('listWizard.nav.discard')}
              </button>
            </Tooltip>
          </>
        )}
        <span className="text-slate-300 dark:text-slate-700" aria-hidden="true">·</span>
        {/* U.10 — save state gets explicit iconography. Spinner for
            in-flight, emerald check for success, red alert for error.
            The plain "Step X of N" stays icon-less so the wizard's
            ambient state doesn't shout when nothing's happening. */}
        <span className="inline-flex items-center gap-1.5">
          {saveState === 'saving' && (
            <>
              <Loader2 className="w-3 h-3 animate-spin" />
              {t('listWizard.nav.saving')}
            </>
          )}
          {saveState === 'saved' && (
            <span className="inline-flex items-center gap-1.5 text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3 h-3" />
              {t('listWizard.nav.saved')}
            </span>
          )}
          {saveState === 'idle' && (
            <span className="tabular-nums">
              {t('listWizard.nav.stepXofN', {
                n: currentStep,
                total: STEPS.length,
              })}
              {typeof timeOnStepSeconds === 'number' &&
                timeOnStepSeconds >= 30 && (
                  <span className="ml-2 text-slate-400 dark:text-slate-500" aria-hidden="true">
                    · {formatSeconds(timeOnStepSeconds)}
                  </span>
                )}
            </span>
          )}
          {saveState === 'error' && (
            <span className="inline-flex items-center gap-1.5 text-red-600 dark:text-red-400">
              <AlertCircle className="w-3 h-3" />
              {t('listWizard.nav.saveFailed')}
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
          {t('listWizard.nav.back')}
        </Button>
        {/* U.10 — kbd hint for the existing ⌘← / ⌘→ shortcuts wired
            in ListWizardClient. Surfacing them in the nav makes them
            discoverable without changing any behaviour. */}
        <span
          className="hidden md:inline-flex items-center gap-1 text-xs text-slate-400 dark:text-slate-500"
          aria-hidden="true"
          title={t('listWizard.nav.kbdHint')}
        >
          <kbd className="font-mono px-1 py-px bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-500 dark:text-slate-400">⌘←</kbd>
          <kbd className="font-mono px-1 py-px bg-slate-100 dark:bg-slate-800 border border-slate-200 dark:border-slate-700 rounded text-slate-500 dark:text-slate-400">⌘→</kbd>
        </span>
        {/* Bug #2 + #9 — Tooltip primitive replaces native title=
            (works on Safari + touch devices, was broken in both). */}
        <Tooltip
          content={blockerSummary ?? ''}
          placement="top"
          // Don't render the tooltip when there's nothing to say.
          // The primitive handles the empty-content case by not
          // mounting the bubble; passing '' is the explicit signal.
        >
          <Button
            variant="primary"
            size="sm"
            onClick={handleContinueClick}
            // Bug #2 fix — use aria-disabled instead of `disabled` so
            // onClick keeps firing when gated (smart Continue / A8).
            // The terminal step still uses real `disabled` since
            // there's nothing to do there.
            disabled={isLast}
            aria-disabled={isGated || undefined}
            aria-describedby={
              showBlockerPill ? blockersId : undefined
            }
            className={cn(
              isGated &&
                'opacity-60 cursor-not-allowed hover:opacity-60',
            )}
          >
            {isLast
              ? t('listWizard.nav.finalStep')
              : t('listWizard.nav.continue')}
            {showBlockerPill && (
              <span
                id={blockersId}
                // Bug #5 + #6 — fade transition (motion-safe respects
                // prefers-reduced-motion). Bug #7 — dark mode pair.
                // Bug #3 — no aria-label here; the pill's content
                // (the number) is read directly + the
                // aria-describedby on the parent surfaces context.
                className={cn(
                  'ml-1.5 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1 rounded-full text-xs font-semibold tabular-nums',
                  'bg-amber-200 text-amber-900',
                  'dark:bg-amber-800 dark:text-amber-100',
                  'motion-safe:transition-all motion-safe:duration-150',
                )}
              >
                {blockerCount}
              </span>
            )}
            {!isLast && <ChevronRight className="w-3.5 h-3.5 ml-0.5" />}
          </Button>
        </Tooltip>
      </div>
    </div>
  )
}
