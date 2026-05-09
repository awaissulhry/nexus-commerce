'use client'

/**
 * C.1 — resume context banner.
 *
 * Renders briefly at the top of the wizard when the user opens a
 * wizard they had paused (currentStep > 1 AND the last edit was
 * more than 5 minutes ago). Tells them WHERE they are + WHEN they
 * left off so they re-orient instantly. Auto-dismisses after 8s
 * or on first user interaction inside the wizard surface.
 *
 * Cold starts (Step 1, no prior edits) skip the banner — fresh
 * wizards don't need a "resuming" hint.
 */

import { useEffect, useState } from 'react'
import { History, X } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useTranslations } from '@/lib/i18n/use-translations'
import { STEPS, findStep } from '../lib/steps'

type Translator = ReturnType<typeof useTranslations>['t']

interface Props {
  currentStep: number
  /** ISO string of last-edit time. When unset, banner doesn't render. */
  updatedAt?: string
  /** Override the show threshold for testing. Default 5 minutes. */
  staleThresholdMs?: number
  /** Override the auto-dismiss delay. Default 8 seconds. */
  autoDismissMs?: number
}

const FIVE_MINUTES_MS = 5 * 60 * 1000
const EIGHT_SECONDS_MS = 8 * 1000

function formatRelative(t: Translator, deltaMs: number): string {
  const seconds = Math.floor(deltaMs / 1000)
  if (seconds < 60) return t('listWizard.resume.justNow')
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) {
    return t(
      minutes === 1
        ? 'listWizard.resume.minuteOne'
        : 'listWizard.resume.minuteOther',
      { n: minutes },
    )
  }
  const hours = Math.floor(minutes / 60)
  if (hours < 24) {
    return t(
      hours === 1
        ? 'listWizard.resume.hourOne'
        : 'listWizard.resume.hourOther',
      { n: hours },
    )
  }
  const days = Math.floor(hours / 24)
  if (days < 7) {
    return t(
      days === 1
        ? 'listWizard.resume.dayOne'
        : 'listWizard.resume.dayOther',
      { n: days },
    )
  }
  const weeks = Math.floor(days / 7)
  return t(
    weeks === 1
      ? 'listWizard.resume.weekOne'
      : 'listWizard.resume.weekOther',
    { n: weeks },
  )
}

export default function ResumeBanner({
  currentStep,
  updatedAt,
  staleThresholdMs = FIVE_MINUTES_MS,
  autoDismissMs = EIGHT_SECONDS_MS,
}: Props) {
  const { t } = useTranslations()
  // Compute once on mount — banner shouldn't reappear if the user
  // actively edits and updatedAt refreshes.
  const [shouldShow] = useState(() => {
    if (!updatedAt || currentStep <= 1) return false
    const last = new Date(updatedAt).getTime()
    if (!Number.isFinite(last)) return false
    return Date.now() - last > staleThresholdMs
  })
  const [dismissed, setDismissed] = useState(false)

  useEffect(() => {
    if (!shouldShow) return
    const id = window.setTimeout(() => setDismissed(true), autoDismissMs)
    return () => window.clearTimeout(id)
  }, [shouldShow, autoDismissMs])

  if (!shouldShow || dismissed) return null

  const step = findStep(currentStep) ?? STEPS[0]
  const lastDelta = updatedAt
    ? Date.now() - new Date(updatedAt).getTime()
    : 0
  const relative = formatRelative(t, lastDelta)

  return (
    <div
      role="status"
      aria-live="polite"
      className={cn(
        'sticky top-0 z-10 px-6 py-2.5 border-b flex items-center gap-3',
        'bg-blue-50 border-blue-200 text-blue-900',
        'dark:bg-blue-950 dark:border-blue-900 dark:text-blue-100',
        'motion-safe:animate-fade-in',
      )}
    >
      <History className="w-4 h-4 flex-shrink-0" aria-hidden="true" />
      <div className="flex-1 min-w-0 text-base">
        <span className="font-semibold">
          {t('listWizard.resume.resuming')}
        </span>
        {' '}
        {t('listWizard.resume.fromConnector')}
        {' '}
        <span className="font-mono">
          {t('listWizard.resume.stepLabel', { n: step.id })}
        </span>
        {' — '}
        <span className="text-blue-700 dark:text-blue-300">{step.title}</span>
        <span className="mx-1.5 text-blue-700 dark:text-blue-300">·</span>
        <span className="text-blue-700 dark:text-blue-300">
          {t('listWizard.resume.lastEdited', { when: relative })}
        </span>
      </div>
      <button
        type="button"
        onClick={() => setDismissed(true)}
        aria-label={t('listWizard.resume.dismiss')}
        className={cn(
          'flex-shrink-0 inline-flex items-center justify-center w-6 h-6 rounded',
          'text-blue-700 hover:bg-blue-100 dark:text-blue-300 dark:hover:bg-blue-900',
        )}
      >
        <X className="w-4 h-4" aria-hidden="true" />
      </button>
    </div>
  )
}
