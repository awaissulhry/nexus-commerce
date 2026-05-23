'use client'

/**
 * DS.8 — Per-view locale override for the datasheet toolbar.
 *
 * The global `nexus:locale` cookie controls the app shell language.
 * On the datasheet specifically, the operator often needs to PRINT
 * in a different language than they READ — e.g. an Italian operator
 * generating an English handout for a German distributor. This
 * picker writes `?locale=en|it` to the URL without touching the app-
 * wide cookie, so cancelling the print returns to the original.
 *
 * Cookie persistence is intentionally NOT added here — the override
 * is meant to be ephemeral for one document. If the operator wants
 * to permanently switch app locale, they use the global picker.
 */

import { useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'

type DatasheetLocale = 'en' | 'it'
const LOCALES: DatasheetLocale[] = ['en', 'it']

interface DatasheetLocalePickerProps {
  current: DatasheetLocale
}

export default function DatasheetLocalePicker({
  current,
}: DatasheetLocalePickerProps) {
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const onPick = (loc: DatasheetLocale) => {
    if (loc === current) return
    const sp = new URLSearchParams(searchParams.toString())
    sp.set('locale', loc)
    startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    })
  }

  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden dark:border-slate-700"
      role="group"
      aria-label="Datasheet language"
    >
      {LOCALES.map((l) => {
        const active = l === current
        return (
          <button
            key={l}
            type="button"
            onClick={() => onPick(l)}
            disabled={pending}
            aria-pressed={active}
            className={
              'h-8 px-2.5 text-xs font-medium uppercase tracking-wider border-r last:border-r-0 border-slate-300 dark:border-slate-700 transition-colors ' +
              (active
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800')
            }
          >
            {l}
          </button>
        )
      })}
    </div>
  )
}
