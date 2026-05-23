'use client'

/**
 * DS.8 — Paper-size picker.
 *
 * Default A4 (Italian + EU standard). Letter for US distributors,
 * A5 for compact pocket spec cards / counter handouts. Selection
 * persists to `nexus:datasheet-paper` cookie so the operator's
 * preferred default sticks across SKUs.
 *
 * Implementation note: the actual @page rule is injected by a
 * `<style>` tag in the server-rendered page based on the resolved
 * paper choice — the CSS can't be a Tailwind variant because
 * @page lives outside the cascade.
 */

import { useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { useTranslations } from '@/lib/i18n/use-translations'

type Paper = 'a4' | 'letter' | 'a5'
const PAPERS: Paper[] = ['a4', 'letter', 'a5']
const COOKIE_KEY = 'nexus:datasheet-paper'
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365

interface DatasheetPaperPickerProps {
  current: Paper
}

export default function DatasheetPaperPicker({
  current,
}: DatasheetPaperPickerProps) {
  const { t } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const onPick = (p: Paper) => {
    if (p === current) return
    document.cookie = `${COOKIE_KEY}=${p}; path=/; max-age=${COOKIE_MAX_AGE}; SameSite=Lax`
    const sp = new URLSearchParams(searchParams.toString())
    sp.set('paper', p)
    startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    })
  }

  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden dark:border-slate-700"
      role="group"
      aria-label={t('products.datasheet.paper.aria')}
    >
      {PAPERS.map((p) => {
        const active = p === current
        return (
          <button
            key={p}
            type="button"
            onClick={() => onPick(p)}
            disabled={pending}
            aria-pressed={active}
            className={
              'h-8 px-2.5 text-xs font-medium uppercase tracking-wider border-r last:border-r-0 border-slate-300 dark:border-slate-700 transition-colors ' +
              (active
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800')
            }
          >
            {p === 'letter' ? 'US' : p.toUpperCase()}
          </button>
        )
      })}
    </div>
  )
}
