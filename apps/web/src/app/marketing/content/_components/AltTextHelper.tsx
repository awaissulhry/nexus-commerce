'use client'

// MC.14.7 — Italian alt-text helper.
//
// Reads /api/terminology?marketplace=AMAZON_IT&language=it and shows
// a collapsible glossary panel inside the AssetDetailDrawer with
// preferred Italian terms (giacca / giubbotto / casco / guanti …)
// + the avoid-list. Operators writing or reviewing alt text can
// expand it for terminology guidance without leaving the drawer.
//
// AI-generated suggestions stay in the MC.4 deferred plan; the
// glossary by itself is high-value because the operator already
// curates it via /settings/terminology.

import { useEffect, useState } from 'react'
import { Languages, ChevronDown } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'

interface TerminologyRow {
  id: string
  brand: string | null
  marketplace: string
  language: string
  preferred: string
  avoid: string[]
  context: string | null
}

interface Props {
  apiBase: string
  marketplace?: string
  language?: string
  brand?: string | null
}

export default function AltTextHelper({
  apiBase,
  marketplace = 'AMAZON_IT',
  language = 'it',
  brand,
}: Props) {
  const { t } = useTranslations()
  const [rows, setRows] = useState<TerminologyRow[]>([])
  const [open, setOpen] = useState(false)
  const [loaded, setLoaded] = useState(false)

  useEffect(() => {
    if (!open || loaded) return
    const params = new URLSearchParams({ marketplace, language })
    if (brand) params.set('brand', brand)
    fetch(`${apiBase}/api/terminology?${params.toString()}`)
      .then((r) => (r.ok ? r.json() : { items: [] }))
      .then((d: { items?: TerminologyRow[] } | TerminologyRow[]) => {
        const arr = Array.isArray(d) ? d : (d.items ?? [])
        setRows(arr)
      })
      .catch(() => undefined)
      .finally(() => setLoaded(true))
  }, [open, loaded, apiBase, marketplace, language, brand])

  return (
    <details
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800"
    >
      <summary className="flex cursor-pointer list-none items-center gap-1.5 px-2 py-1.5 text-xs font-medium text-slate-700 dark:text-slate-200">
        <Languages className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
        {t('marketingContent.altHelper.title', {
          marketplace,
          language: language.toUpperCase(),
        })}
        <ChevronDown
          className={`ml-auto w-3 h-3 text-slate-400 transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </summary>
      <div className="border-t border-slate-200 px-2 py-1.5 dark:border-slate-700">
        {!loaded ? (
          <p className="text-xs text-slate-400">
            {t('marketingContent.altHelper.loading')}
          </p>
        ) : rows.length === 0 ? (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            {t('marketingContent.altHelper.empty')}
          </p>
        ) : (
          <ul className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
            {rows.map((row) => (
              <li
                key={row.id}
                className="rounded bg-white p-1.5 text-xs dark:bg-slate-900"
              >
                <div className="flex items-baseline gap-1.5">
                  <span className="font-semibold text-emerald-700 dark:text-emerald-300">
                    {row.preferred}
                  </span>
                  {row.avoid.length > 0 && (
                    <span className="text-slate-400 line-through">
                      {row.avoid.join(', ')}
                    </span>
                  )}
                </div>
                {row.context && (
                  <p className="mt-0.5 text-[11px] italic text-slate-500 dark:text-slate-400">
                    {row.context}
                  </p>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}
