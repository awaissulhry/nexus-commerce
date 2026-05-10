'use client'

// MC.2.1 — tag picker for the detail drawer.
//
// Renders the asset's current AssetTag chips + a combo input that
// surfaces every existing tag (filtered by the input value) and
// also lets the operator type a fresh name and press Enter to
// create it on the fly.
//
// Persists by calling PUT /api/assets/:id/tags with a full
// replacement set. Tag-creation latency is hidden behind optimistic
// UI: chips render immediately, request fires in the background;
// failure rolls back + shows a toast.

import { useEffect, useRef, useState } from 'react'
import { X, Plus, Loader2 } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import type { AssetTagRef } from '../_lib/types'

interface Props {
  assetId: string
  rawAssetId: string // strip the "da_" prefix; the tag API uses the bare DigitalAsset id
  apiBase: string
  current: AssetTagRef[]
  onChange: (next: AssetTagRef[]) => void
  disabled?: boolean
}

interface AvailableTag {
  id: string
  name: string
  color: string | null
}

export default function AssetTagPicker({
  assetId,
  rawAssetId,
  apiBase,
  current,
  onChange,
  disabled,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()
  const [available, setAvailable] = useState<AvailableTag[]>([])
  const [input, setInput] = useState('')
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBase}/api/asset-tags`, { cache: 'no-store' })
      .then((r) => (r.ok ? r.json() : { tags: [] }))
      .then((data: { tags: AvailableTag[] }) => {
        if (!cancelled) setAvailable(data.tags ?? [])
      })
      .catch(() => {
        /* ignore — picker still works, just without suggestions */
      })
    return () => {
      cancelled = true
    }
  }, [apiBase])

  // Outside-click close.
  useEffect(() => {
    if (!open) return
    const onClick = (e: MouseEvent) => {
      if (!containerRef.current?.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onClick)
    return () => document.removeEventListener('mousedown', onClick)
  }, [open])

  const persist = async (next: AssetTagRef[]) => {
    setBusy(true)
    const prev = current
    onChange(next) // optimistic
    try {
      const res = await fetch(
        `${apiBase}/api/assets/${encodeURIComponent(rawAssetId)}/tags`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tagIds: next.map((t) => t.id) }),
        },
      )
      if (!res.ok) throw new Error(`Tag save failed (${res.status})`)
    } catch (err) {
      onChange(prev) // rollback
      toast.error(
        err instanceof Error ? err.message : t('marketingContent.tagPicker.saveError'),
      )
    } finally {
      setBusy(false)
    }
  }

  const addByName = async (rawName: string) => {
    const name = rawName.trim()
    if (!name) return
    // Already attached?
    if (current.some((t) => t.name.toLowerCase() === name.toLowerCase())) {
      setInput('')
      return
    }
    // Existing tag? Use its id.
    const existing = available.find(
      (a) => a.name.toLowerCase() === name.toLowerCase(),
    )
    if (existing) {
      const next = [
        ...current,
        { id: existing.id, name: existing.name, color: existing.color },
      ]
      setInput('')
      await persist(next)
      return
    }
    // New tag — use the name-form endpoint so the server creates it
    // and returns the new id. We optimistically add a row with a
    // placeholder id and reconcile after the response.
    setBusy(true)
    try {
      const res = await fetch(
        `${apiBase}/api/assets/${encodeURIComponent(rawAssetId)}/tags`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            tagIds: current.map((tg) => tg.id),
            tagNames: [name],
          }),
        },
      )
      if (!res.ok) throw new Error(`Tag save failed (${res.status})`)
      const data = (await res.json()) as { tags: AssetTagRef[] }
      onChange(data.tags)
      // Refresh the global tag list so the dropdown picks up the
      // new entry on next focus.
      setAvailable((prev) => {
        if (prev.some((p) => p.name.toLowerCase() === name.toLowerCase()))
          return prev
        const created = data.tags.find(
          (t) => t.name.toLowerCase() === name.toLowerCase(),
        )
        return created
          ? [...prev, { id: created.id, name: created.name, color: created.color }]
          : prev
      })
      setInput('')
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t('marketingContent.tagPicker.saveError'),
      )
    } finally {
      setBusy(false)
    }
  }

  const removeTag = async (tag: AssetTagRef) => {
    const next = current.filter((t) => t.id !== tag.id)
    await persist(next)
  }

  const suggestions = available
    .filter((a) => !current.some((c) => c.id === a.id))
    .filter(
      (a) =>
        !input.trim() ||
        a.name.toLowerCase().includes(input.trim().toLowerCase()),
    )
    .slice(0, 8)

  // We void the assetId prop intentionally — only rawAssetId hits the
  // API. Keeping the prefixed id available lets future-MC.2 wire the
  // ProductImage source path through the same picker once W4.7 makes
  // it taggable.
  void assetId

  return (
    <div ref={containerRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1.5 dark:border-slate-700 dark:bg-slate-900">
        {current.map((tag) => (
          <span
            key={tag.id}
            className="inline-flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 text-xs font-medium text-slate-700 dark:bg-slate-800 dark:text-slate-200"
            style={
              tag.color
                ? { backgroundColor: `${tag.color}22`, color: tag.color }
                : undefined
            }
          >
            {tag.name}
            <button
              type="button"
              onClick={() => removeTag(tag)}
              disabled={disabled || busy}
              aria-label={t('marketingContent.tagPicker.remove', {
                name: tag.name,
              })}
              className="rounded-full opacity-60 hover:opacity-100"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        ))}
        <input
          type="text"
          value={input}
          onChange={(e) => {
            setInput(e.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              void addByName(input)
            } else if (
              e.key === 'Backspace' &&
              !input &&
              current.length > 0
            ) {
              void removeTag(current[current.length - 1]!)
            }
          }}
          disabled={disabled || busy}
          placeholder={
            current.length === 0
              ? t('marketingContent.tagPicker.placeholderEmpty')
              : t('marketingContent.tagPicker.placeholderAdd')
          }
          className="flex-1 min-w-[120px] bg-transparent text-sm text-slate-900 placeholder-slate-400 focus:outline-none dark:text-slate-100 dark:placeholder-slate-500"
        />
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
      </div>
      {open && (suggestions.length > 0 || input.trim()) && (
        <div
          role="listbox"
          className="absolute left-0 right-0 top-full z-20 mt-1 max-h-56 overflow-y-auto rounded-md border border-slate-200 bg-white shadow-lg dark:border-slate-700 dark:bg-slate-900"
        >
          {suggestions.map((s) => (
            <button
              key={s.id}
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => void addByName(s.name)}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-slate-800"
            >
              <span
                className="h-2 w-2 rounded-full bg-slate-300 dark:bg-slate-600"
                style={s.color ? { backgroundColor: s.color } : undefined}
                aria-hidden="true"
              />
              {s.name}
            </button>
          ))}
          {input.trim() &&
            !suggestions.some(
              (s) => s.name.toLowerCase() === input.trim().toLowerCase(),
            ) &&
            !current.some(
              (c) => c.name.toLowerCase() === input.trim().toLowerCase(),
            ) && (
              <button
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => void addByName(input)}
                className="flex w-full items-center gap-2 border-t border-slate-200 px-3 py-1.5 text-left text-sm text-blue-600 hover:bg-slate-50 dark:border-slate-800 dark:text-blue-400 dark:hover:bg-slate-800"
              >
                <Plus className="w-3.5 h-3.5" />
                {t('marketingContent.tagPicker.create', { name: input.trim() })}
              </button>
            )}
        </div>
      )}
    </div>
  )
}
