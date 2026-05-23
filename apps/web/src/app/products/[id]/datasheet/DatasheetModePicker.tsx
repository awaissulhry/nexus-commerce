'use client'

/**
 * DS.6 — Audience-mode segmented picker for the datasheet toolbar.
 *
 * Three options, each with a different visibility map applied on
 * the server page:
 *
 *   B2B       — default. price + specs + identifiers visible;
 *               stock + cost + internal-only meta hidden.
 *   Internal  — full operator view. Everything visible incl. stock,
 *               family, workflow stage, fulfillment, keywords.
 *   Public    — retail catalog. Hides channel identifiers + coverage
 *               so a customer-facing handout doesn't out our
 *               marketplace operations.
 *
 * On change: writes `nexus:datasheet-mode` cookie (12-month TTL),
 * then navigates to `?mode=<new>` so the server re-renders with
 * the new visibility map. The cookie persists the choice across
 * navigations; the query string is what the current page reads.
 */

import { useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from '@/lib/i18n/use-translations'

type Mode = 'b2b' | 'internal' | 'public'

interface DatasheetModePickerProps {
  current: Mode
}

const MODES: Mode[] = ['b2b', 'internal', 'public']
const COOKIE_KEY = 'nexus:datasheet-mode'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365 // 12 months

export default function DatasheetModePicker({
  current,
}: DatasheetModePickerProps) {
  const { t } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const onPick = (mode: Mode) => {
    if (mode === current) return
    // SameSite=Lax so a B2B-mode print from a Slack-shared link still
    // honors the operator's last choice; Secure off in dev (http).
    document.cookie = `${COOKIE_KEY}=${mode}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
    const sp = new URLSearchParams(searchParams.toString())
    sp.set('mode', mode)
    startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    })
  }

  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden dark:border-slate-700"
      role="group"
      aria-label={t('products.datasheet.mode.aria')}
    >
      {MODES.map((m) => {
        const active = m === current
        return (
          <button
            key={m}
            type="button"
            onClick={() => onPick(m)}
            disabled={pending}
            aria-pressed={active}
            title={t(`products.datasheet.mode.${m}.description`)}
            className={
              'h-8 px-3 text-xs font-medium border-r last:border-r-0 border-slate-300 dark:border-slate-700 transition-colors ' +
              (active
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800')
            }
          >
            {t(`products.datasheet.mode.${m}.label`)}
          </button>
        )
      })}
    </div>
  )
}
