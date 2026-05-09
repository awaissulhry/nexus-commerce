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
import { CheckCircle2, Tag as TagIcon } from 'lucide-react'
import { Modal } from '@/components/ui/Modal'
import { useToast } from '@/components/ui/Toast'
import { getBackendUrl } from '@/lib/backend-url'
import { useTranslations } from '@/lib/i18n/use-translations'

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
  const { t } = useTranslations()
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
        t('products.tags.failed.load', { msg: e instanceof Error ? e.message : String(e) }),
      )
    } finally {
      setLoading(false)
    }
  }, [productId, toast, t])

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
        t(
          has
            ? 'products.tags.failed.remove'
            : 'products.tags.failed.attach',
          { msg: e instanceof Error ? e.message : String(e) },
        ),
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
      toast.error(err.error ?? t('products.tags.failed.create'))
    }
  }

  return (
    <Modal
      open={true}
      onClose={onClose}
      placement="drawer-right"
      title={
        <span className="inline-flex items-center gap-1.5">
          <TagIcon size={14} /> {t('products.tags.title')}
        </span>
      }
    >
        <div className="p-5 space-y-4 overflow-y-auto">
          <div>
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
              {t('products.tags.available')}
            </div>
            {loading ? (
              <div className="text-base text-slate-500 dark:text-slate-400">{t('products.tags.loading')}</div>
            ) : (
              <div className="flex items-center gap-1.5 flex-wrap">
                {allTags.map((t) => {
                  const active = productTags.some((p) => p.id === t.id)
                  return (
                    <button
                      key={t.id}
                      onClick={() => toggle(t)}
                      // U.25 — drop tag color from text; theme text
                      // (slate-700/300) guarantees contrast across any
                      // operator-picked color. Identity shows through
                      // the dot + tinted background.
                      className={`inline-flex items-center gap-1 px-2 py-1 text-sm border rounded transition-colors text-slate-700 dark:text-slate-200 ${active ? 'border-slate-900 dark:border-slate-100' : 'border-slate-200 hover:border-slate-300 dark:border-slate-800 dark:hover:border-slate-700'}`}
                      style={
                        active
                          ? {
                              background: t.color
                                ? `${t.color}20`
                                : '#f1f5f9',
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
                  <span className="text-base text-slate-500 dark:text-slate-400">
                    {t('products.tags.empty')}
                  </span>
                )}
              </div>
            )}
          </div>
          <div className="border-t border-slate-100 dark:border-slate-800 pt-4 space-y-2">
            <div className="text-sm uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold">
              {t('products.tags.createSection')}
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newTagName}
                onChange={(e) => setNewTagName(e.target.value)}
                placeholder={t('products.tags.namePlaceholder')}
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
                {t('products.tags.add')}
              </button>
            </div>
          </div>
        </div>
    </Modal>
  )
}
