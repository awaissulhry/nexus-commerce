'use client'

/**
 * IR.14.2 — Imagen lifestyle scene generation modal.
 *
 * Operator types a scene prompt (or picks a preset for Italian
 * motorcycle gear), picks an aspect ratio, submits. Server hits
 * Imagen 3, the result is saved as a new master ProductImage with
 * type=LIFESTYLE. Modal then closes + workspace reloads.
 *
 * Imagen 3 needs a paid plan on the Gemini key — the error path
 * surfaces that requirement so the operator can fix the auth
 * instead of staring at a vague failure.
 */

import { useState } from 'react'
import { Loader2, Sparkles, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { cn } from '@/lib/utils'
import { beFetch } from './api'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { ProductImage } from './types'

type AspectRatio = '1:1' | '3:4' | '4:3' | '9:16' | '16:9'

const ASPECT_RATIOS: AspectRatio[] = ['1:1', '3:4', '4:3', '9:16', '16:9']

const PRESET_KEYS = ['cafe', 'cobblestone', 'trackday', 'studio'] as const

interface Props {
  productId: string
  onClose: () => void
  onGenerated: (img: ProductImage) => void
}

export default function LifestyleGenerationModal({ productId, onClose, onGenerated }: Props) {
  const { t } = useTranslations()
  const [prompt, setPrompt] = useState('')
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>('1:1')
  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function applyPreset(key: typeof PRESET_KEYS[number]) {
    setPrompt(t(`products.edit.images.lifestyle.preset.${key}`))
  }

  async function submit() {
    if (prompt.trim().length < 10) {
      setError(t('products.edit.images.lifestyle.errorTooShort'))
      return
    }
    setGenerating(true)
    setError(null)
    try {
      const res = await beFetch(`/api/products/${productId}/images/generate-lifestyle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: prompt.trim(), aspectRatio }),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body?.message ?? body?.error ?? `Generate failed: ${res.status}`)
      }
      const { image } = await res.json() as { image: ProductImage }
      onGenerated(image)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Generation failed')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div role="dialog" aria-modal="true" aria-label="Lifestyle image generation" className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <button
        type="button"
        aria-label="Close"
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />
      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-xl flex flex-col overflow-hidden max-h-[85vh]">
        <div className="flex items-center justify-between px-5 py-4 border-b border-default dark:border-slate-700 flex-shrink-0">
          <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100 flex items-center gap-1.5">
            <Sparkles className="w-4 h-4 text-purple-500" />
            {t('products.edit.images.lifestyle.title')}
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="p-1 text-tertiary hover:text-slate-700 dark:hover:text-slate-200"
            disabled={generating}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">
          {/* Prompt */}
          <div>
            <label className="text-xs font-medium text-slate-700 dark:text-slate-300 mb-1 block">
              {t('products.edit.images.lifestyle.promptLabel')}
              <span className="text-tertiary ml-1 font-normal">({prompt.length}/2000)</span>
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value.slice(0, 2000))}
              disabled={generating}
              rows={4}
              placeholder={t('products.edit.images.lifestyle.promptPlaceholder')}
              className="w-full text-sm border border-default dark:border-slate-700 rounded px-2 py-1.5 bg-white dark:bg-slate-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:ring-1 focus:ring-purple-400 resize-none"
            />
          </div>

          {/* Presets */}
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 block">
              {t('products.edit.images.lifestyle.presetsLabel')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {PRESET_KEYS.map((key) => (
                <button
                  key={key}
                  type="button"
                  onClick={() => applyPreset(key)}
                  disabled={generating}
                  className="text-[11px] px-2 py-1 rounded border border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-purple-50 dark:hover:bg-purple-950/30 hover:border-purple-300"
                >
                  {t(`products.edit.images.lifestyle.presetLabel.${key}`)}
                </button>
              ))}
            </div>
          </div>

          {/* Aspect ratio */}
          <div>
            <label className="text-[10px] uppercase tracking-wide text-slate-500 dark:text-slate-400 mb-1 block">
              {t('products.edit.images.lifestyle.aspectLabel')}
            </label>
            <div className="flex flex-wrap gap-1.5">
              {ASPECT_RATIOS.map((r) => (
                <button
                  key={r}
                  type="button"
                  onClick={() => setAspectRatio(r)}
                  disabled={generating}
                  className={cn(
                    'text-xs px-2.5 py-1 rounded border transition-colors font-mono',
                    aspectRatio === r
                      ? 'bg-purple-50 dark:bg-purple-950/40 border-purple-400 text-purple-700 dark:text-purple-300'
                      : 'border-default dark:border-slate-700 text-slate-600 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800',
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
          )}

          <p className="text-[10px] text-tertiary dark:text-slate-500">
            {t('products.edit.images.lifestyle.audit')}
          </p>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-default dark:border-slate-700 flex-shrink-0">
          <Button variant="ghost" onClick={onClose} disabled={generating} className="text-xs">
            {t('products.edit.images.lifestyle.cancel')}
          </Button>
          <Button onClick={submit} disabled={generating || prompt.trim().length < 10} className="text-xs gap-1.5">
            {generating ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
            {generating ? t('products.edit.images.lifestyle.generating') : t('products.edit.images.lifestyle.generate')}
          </Button>
        </div>
      </div>
    </div>
  )
}
