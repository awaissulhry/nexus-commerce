'use client'

/**
 * C.0 / A2 — generic sticky blocker banner.
 *
 * Rendered above the step content by ListWizardClient when the
 * current step reports valid=false. Surfaces the blocker count +
 * top-3 reasons + a "Show me" CTA that fires the registered
 * jump-to-blocker callback (A1).
 *
 * Step 4 Attributes already has its own richer ValidationSummary
 * with per-channel breakdown; ListWizardClient hides this banner
 * on that step to avoid stacking two summaries. For Steps 5–8 this
 * is the always-visible affordance that pairs with the WizardNav
 * pill so users always see what's blocking forward progress.
 *
 * Accessibility:
 *   - role="status" + aria-live="polite" so screen readers
 *     announce blocker changes without interrupting.
 *   - Reasons render in a deterministic order so re-renders don't
 *     reshuffle.
 *   - "Show me" button has aria-label that includes the count.
 */

import { Target, AlertCircle } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Props {
  blockerCount: number
  reasons: string[]
  onJump: () => void
  /** When true, render the banner sticky to the step container's
   *  scroll context. The wizard's outer scroll container is the
   *  flex-1 div in ListWizardClient. */
  sticky?: boolean
}

export default function BlockerBanner({
  blockerCount,
  reasons,
  onJump,
  sticky = true,
}: Props) {
  const { t } = useTranslations()
  if (blockerCount <= 0) return null
  const top = reasons.slice(0, 3)
  const more = reasons.length > top.length ? reasons.length - top.length : 0
  const countText = t(
    blockerCount === 1
      ? 'listWizard.blocker.countOne'
      : 'listWizard.blocker.countOther',
    { n: blockerCount },
  )
  const jumpLabel = t(
    blockerCount === 1
      ? 'listWizard.blocker.jumpAriaOne'
      : 'listWizard.blocker.jumpAriaOther',
    { n: blockerCount },
  )
  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'px-6 py-2.5 border-b flex items-center gap-3',
        'bg-amber-50 border-amber-200 text-amber-900',
        'dark:bg-amber-950 dark:border-amber-900 dark:text-amber-100',
        sticky && 'sticky top-0 z-10',
      )}
    >
      <AlertCircle className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 text-base">
        <span className="font-semibold tabular-nums">{countText}</span>
        {top.length > 0 && (
          <>
            <span className="mx-1.5">·</span>
            <span className="truncate">
              {top.join('; ')}
              {more > 0 && (
                <span className="text-amber-700 dark:text-amber-300">
                  {t('listWizard.blocker.andMore', { n: more })}
                </span>
              )}
            </span>
          </>
        )}
      </div>
      <button
        type="button"
        onClick={onJump}
        aria-label={jumpLabel}
        className={cn(
          'inline-flex items-center gap-1 h-7 px-2 text-sm font-medium rounded',
          'border border-amber-300 bg-white text-amber-900 hover:bg-amber-100',
          'dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100 dark:hover:bg-amber-900/50',
          'flex-shrink-0',
        )}
      >
        <Target className="w-3 h-3" aria-hidden="true" />
        {t('listWizard.blocker.showMe')}
        <kbd className="ml-1 px-1 py-px text-xs bg-amber-100 border border-amber-200 rounded font-mono dark:bg-amber-950 dark:border-amber-800">
          ⌘G
        </kbd>
      </button>
    </div>
  )
}
