'use client'

/**
 * PIM B.1 — One locale column for the Global tab.
 *
 * Renders title / description / bullet points / keywords for a single
 * locale (en or it). Stateless: parent owns the slot value + onChange.
 * Renders side-by-side in two-column layout on the Global tab.
 */

import { useCallback } from 'react'
import { X, Plus } from 'lucide-react'
import { Input } from '@/components/ui/Input'
import { IconButton } from '@/components/ui/IconButton'
import { cn } from '@/lib/utils'

export interface LocaleSlot {
  title: string | null
  description: string | null
  bulletPoints: string[]
  keywords: string[]
}

interface Props {
  locale: 'en' | 'it'
  /** Display label shown above the column ("English", "Italian"). */
  label: string
  value: LocaleSlot
  onChange: (next: LocaleSlot) => void
  className?: string
}

export default function LocaleColumn({ locale, label, value, onChange, className }: Props) {
  const setTitle = useCallback(
    (next: string) => onChange({ ...value, title: next.length === 0 ? null : next }),
    [value, onChange],
  )
  const setDescription = useCallback(
    (next: string) => onChange({ ...value, description: next.length === 0 ? null : next }),
    [value, onChange],
  )

  const addBullet = useCallback(() => {
    onChange({ ...value, bulletPoints: [...value.bulletPoints, ''] })
  }, [value, onChange])
  const updateBullet = useCallback(
    (i: number, text: string) => {
      const next = [...value.bulletPoints]
      next[i] = text
      onChange({ ...value, bulletPoints: next })
    },
    [value, onChange],
  )
  const removeBullet = useCallback(
    (i: number) => {
      onChange({ ...value, bulletPoints: value.bulletPoints.filter((_, idx) => idx !== i) })
    },
    [value, onChange],
  )

  const addKeyword = useCallback(() => {
    onChange({ ...value, keywords: [...value.keywords, ''] })
  }, [value, onChange])
  const updateKeyword = useCallback(
    (i: number, text: string) => {
      const next = [...value.keywords]
      next[i] = text
      onChange({ ...value, keywords: next })
    },
    [value, onChange],
  )
  const removeKeyword = useCallback(
    (i: number) => {
      onChange({ ...value, keywords: value.keywords.filter((_, idx) => idx !== i) })
    },
    [value, onChange],
  )

  return (
    <div className={cn('flex flex-col gap-4', className)} data-locale={locale}>
      <div className="flex items-center gap-2 text-sm font-semibold text-zinc-700 dark:text-zinc-200">
        <span className="inline-flex items-center justify-center w-6 h-6 rounded text-[10px] font-mono uppercase bg-zinc-100 dark:bg-zinc-800">
          {locale}
        </span>
        <span>{label}</span>
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Title</label>
        <Input
          value={value.title ?? ''}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={locale === 'it' ? 'Titolo del prodotto…' : 'Product title…'}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Description</label>
        <textarea
          value={value.description ?? ''}
          onChange={(e) => setDescription(e.target.value)}
          rows={6}
          className="w-full px-3 py-2 text-sm rounded-md border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-900 focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder={locale === 'it' ? 'Descrizione…' : 'Description…'}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">
            Bullet points
          </label>
          <button
            type="button"
            onClick={addBullet}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
          >
            <Plus className="w-3 h-3" /> add
          </button>
        </div>
        {value.bulletPoints.length === 0 ? (
          <div className="text-xs italic text-zinc-400 px-1">No bullet points yet.</div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {value.bulletPoints.map((b, i) => (
              <div key={i} className="flex items-center gap-1.5">
                <Input
                  value={b}
                  onChange={(e) => updateBullet(i, e.target.value)}
                  placeholder={`Bullet ${i + 1}`}
                  className="flex-1"
                />
                <IconButton
                  aria-label={`Remove bullet ${i + 1}`}
                  onClick={() => removeBullet(i)}
                  size="sm"
                >
                  <X className="w-3.5 h-3.5" />
                </IconButton>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-zinc-600 dark:text-zinc-400">Keywords</label>
          <button
            type="button"
            onClick={addKeyword}
            className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700"
          >
            <Plus className="w-3 h-3" /> add
          </button>
        </div>
        {value.keywords.length === 0 ? (
          <div className="text-xs italic text-zinc-400 px-1">No keywords yet.</div>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {value.keywords.map((k, i) => (
              <div
                key={i}
                className="inline-flex items-center gap-1 px-2 py-1 rounded-md bg-zinc-100 dark:bg-zinc-800"
              >
                <input
                  type="text"
                  value={k}
                  onChange={(e) => updateKeyword(i, e.target.value)}
                  className="bg-transparent text-xs focus:outline-none"
                  size={Math.max(k.length, 4)}
                />
                <button
                  type="button"
                  onClick={() => removeKeyword(i)}
                  aria-label={`Remove keyword ${k}`}
                  className="text-zinc-400 hover:text-zinc-700"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
