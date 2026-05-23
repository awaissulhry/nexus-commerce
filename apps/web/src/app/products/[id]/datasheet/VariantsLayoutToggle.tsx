'use client'

/**
 * VR.2 — Variants layout toggle.
 *
 * Lets the operator switch between the 2-D Color × Size matrix
 * (default when axes detected) and the flat audit table. Writes
 * the choice into the querystring (?layout=matrix|flat) so deep-
 * links and bookmarks honor it.
 *
 * No cookie persistence — the matrix is the right default in
 * almost every case, and per-document flexibility beats a sticky
 * preference for a layout the operator might switch only when
 * doing identifier-style audit work.
 */

import { useTransition } from 'react'
import { useRouter, usePathname, useSearchParams } from 'next/navigation'
import { LayoutGrid, Rows } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

export type VariantsLayout = 'matrix' | 'flat'

const LAYOUTS: VariantsLayout[] = ['matrix', 'flat']

interface VariantsLayoutToggleProps {
  current: VariantsLayout
  parentId: string
}

export default function VariantsLayoutToggle({
  current,
}: VariantsLayoutToggleProps) {
  const { t } = useTranslations()
  const router = useRouter()
  const pathname = usePathname()
  const searchParams = useSearchParams()
  const [pending, startTransition] = useTransition()

  const onPick = (next: VariantsLayout) => {
    if (next === current) return
    const sp = new URLSearchParams(searchParams.toString())
    sp.set('tab', 'variants')
    sp.set('layout', next)
    startTransition(() => {
      router.replace(`${pathname}?${sp.toString()}`, { scroll: false })
    })
  }

  return (
    <div
      className="inline-flex rounded-md border border-slate-300 overflow-hidden dark:border-slate-700"
      role="group"
      aria-label={t('products.datasheetHub.variants.layout.aria')}
    >
      {LAYOUTS.map((l) => {
        const active = l === current
        const Icon = l === 'matrix' ? LayoutGrid : Rows
        return (
          <button
            key={l}
            type="button"
            onClick={() => onPick(l)}
            disabled={pending}
            aria-pressed={active}
            title={t(`products.datasheetHub.variants.layout.${l}`)}
            className={
              'h-7 px-2 inline-flex items-center gap-1 text-xs font-medium border-r last:border-r-0 border-slate-300 dark:border-slate-700 transition-colors ' +
              (active
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-700 hover:bg-slate-100 dark:bg-slate-900 dark:text-slate-200 dark:hover:bg-slate-800')
            }
          >
            <Icon className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">
              {t(`products.datasheetHub.variants.layout.${l}`)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
