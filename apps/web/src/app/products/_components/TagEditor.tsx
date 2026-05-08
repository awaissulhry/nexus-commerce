'use client'

/**
 * P.1l — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep.
 *
 * Drawer for product tags. Reads the product's current tags via a
 * POST-with-empty-tagIds round-trip (the API treats an empty array
 * as a fetch), then toggles individual tags on/off + lets the
 * operator create new tags inline. Emits onChanged() so the
 * workspace can refresh its grid row + facet counts.
 */

import { useCallback, useEffect, useState } from 'react'
import { CheckCircle2, Tag as TagIcon, X } from 'lucide-react'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'

export interface TagShape {
  id: string
  name: string
  color: string | null
  productCount?: number
}

interface TagEditorProps {
  productId: string
  onClose: () => void
  onChanged: () => void
  allTags: TagShape[]
}

export function TagEditor({
  productId,
  onClose,
  onChanged,
  allTags,
}: TagEditorProps) {
  const { toast } = useToast()
  const [productTags, setProductTags] = useState<TagShape[]>([])
  const [newTagName, setNewTagName] = useState('')
  const [newTagColor, setNewTagColor] = useState('#3b82f6')
  const [loading, setLoading] = useState(true)

  const refresh = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(
        `${getBackendUrl()}/api/products/${productId}/tags`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tagIds: [] }),
        },
      )
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const data = await res.json()
      setProductTags(data.tags ?? [])
    } catch (e) {
      // U.22 — surface fetch failures via toast instead of leaving the
      // operator with a blank list and no signal.
      toast.error(
        `Failed to load tags: ${e instanceof Error ? e.message : String(e)}`,
      )
    } finally {
      setLoading(false)
    }
  }, [productId, toast])

  useEffect(() => {
    refresh()
  }, [refresh])

  const toggle = async (tag: TagShape) => {
    const has = productTags.some((t) => t.id === tag.id)
    try {
      const res = has
        ? await fetch(
            `${getBackendUrl()}/api/products/${productId}/tags/${tag.id}`,
            { method: 'DELETE' },
          )
        : await fetch(`${getBackendUrl()}/api/products/${productId}/tags`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ tagIds: [tag.id] }),
          })
      if (!res.ok) {
        const j = await res.json().catch(() => ({}))
        throw new Error(j.error ?? `HTTP ${res.status}`)
      }
      refresh()
      onChanged()
    } catch (e) {
      toast.error(
        `${has ? 'Remove' : 'Attach'} tag failed: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
  }

  const createTag = async () => {
    if (!newTagName.trim()) return
    const res = await fetch(`${getBackendUrl()}/api/tags`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: newTagName.trim(), color: newTagColor }),
    })
    if (res.ok) {
      const newTag = await res.json()
      await fetch(`${getBackendUrl()}/api/products/${productId}/tags`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tagIds: [newTag.id] }),
      })
      setNewTagName('')
      onChanged()
      refresh()
    } else {
      const err = await res.json()
      toast.error(err.error ?? 'Failed to create tag')
    }
  }

  return (
    <div className="fixed inset-0 z-30 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-slate-900/30 dark:bg-slate-950/60" />
      <aside
        onClick={(e) => e.stopPropagation()}
        className="relative h-full w-full max-w-md bg-white shadow-2xl overflow-y-auto dark:bg-slate-900"
      >
        <header className="px-5 py-3 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white dark:border-slate-800 dark:bg-slate-900">
          <div className="text-md font-semibold text-slate-900 dark:text-slate-100 inline-flex items-center gap-1.5">
            <TagIcon size={14} /> Tags
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            className="h-7 w-7 min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 inline-flex items-center justify-center rounded hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <X size={16} />
          </button>
        </header>
        <div className="p-5 space-y-4">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
              Available tags
            </div>
            {loading ? (
              <div className="text-base text-slate-500 dark:text-slate-400">Loading…</div>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {allTags.map((t) => {
                  const active = productTags.some((p) => p.id === t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggle(t)}
                      className={`inline-flex items-center gap-1 px-2 py-1 text-sm border rounded transition-colors ${active ? 'border-slate-900 dark:border-slate-100' : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'}`}
                      style={
                        active
                          ? {
                              background: t.color
                                ? `${t.color}20`
                                : '#f1f5f9',
                              color: t.color ?? '#64748b',
                            }
                          : undefined
                      }
                    >
                      {t.color && (
                        <span
                          className="w-1.5 h-1.5 rounded-full"
                          style={{ background: t.color }}
                        />
                      )}
                      {t.name}
                      {active && <CheckCircle2 size={10} />}
                    </button>
                  )
                })}
                {allTags.length === 0 && (
                  <span className="text-base text-slate-400 dark:text-slate-500">
                    No tags yet — create one below.
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              Create new tag
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder="Tag name"
                className="flex-1 h-8 px-2 text-md border border-slate-200 rounded dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
              />
              <input
                type="color"
                value={newTagColor}
                onChange={(e) => setNewTagColor(e.target.value)}
                className="h-8 w-10 border border-slate-200 rounded dark:border-slate-800"
              />
              <button
                onClick={createTag}
                className="h-8 px-3 text-base bg-slate-900 text-white rounded-md hover:bg-slate-800 dark:bg-slate-100 dark:text-slate-900 dark:hover:bg-slate-200"
              >
                Add
              </button>
            </div>
          </div>
        </div>
      </aside>
    </div>
  )
}
