'use client'

import { Globe } from 'lucide-react'
import { useTranslations, type Locale } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

/**
 * U.15 — locale toggle. Two-state today (en | it). Adding more locales
 * is one entry below + a JSON file in messages/.
 */

const FLAGS: Record<Locale, string> = {
  en: '🇬🇧',
  it: '🇮🇹',
}

const NEXT_LABEL: Record<Locale, string> = {
  en: 'Switch to Italian',
  it: "Passa all'inglese",
}

export function LocaleToggle({ className }: { className?: string }) {
  const { locale, setLocale } = useTranslations()
  const next: Locale = locale === 'en' ? 'it' : 'en'
  return (
    <button
      type="button"
      onClick={() => setLocale(next)}
      title={NEXT_LABEL[locale]}
      aria-label={NEXT_LABEL[locale]}
      className={cn(
        'inline-flex items-center gap-1 h-8 px-2 rounded-md text-sm font-medium text-slate-500 hover:text-slate-900 hover:bg-slate-100 transition-colors',
        'dark:text-slate-400 dark:hover:text-white dark:hover:bg-slate-800',
        'focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/40',
        className,
      )}
    >
      <Globe className="w-3.5 h-3.5" />
      <span>{FLAGS[locale]}</span>
      <span className="uppercase tracking-wider text-xs font-semibold">{locale}</span>
    </button>
  )
}
