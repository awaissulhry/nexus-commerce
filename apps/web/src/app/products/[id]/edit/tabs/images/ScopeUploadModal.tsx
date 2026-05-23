'use client'

// IE.10 — Variant-targeted upload modal.
//
// Opens between file picker and POST so the operator pre-tags the
// upload's scope instead of inflating the master gallery first and
// fanning out manually. Two scope choices:
//
//   Master   — current behaviour. ProductImage row only.
//   Variant  — also writes pending ListingImage upserts for the
//              chosen variant axis value across the selected
//              channels, so the image lands in the right matrix
//              cells / gallery rows immediately.
//
// Channel selection is per-row checkboxes. Per-channel slot defaults:
//   Amazon  → maps from ProductImage.type (MAIN→MAIN, LIFESTYLE→
//             next free PT01..PT08, SWATCH→SWCH, others→next free PT)
//   eBay    → append to gallery
//   Shopify → append to pool

import { useEffect, useMemo, useState } from 'react'
import { X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { IconButton } from '@/components/ui/IconButton'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { VariantSummary } from './types'

const IMAGE_TYPES = ['MAIN', 'ALT', 'LIFESTYLE', 'SWATCH', 'DIAGRAM'] as const
export type ImageType = typeof IMAGE_TYPES[number]
export type Channel = 'amazon' | 'ebay' | 'shopify'

export type ScopeChoice =
  | { kind: 'master'; type: ImageType }
  | {
      kind: 'variant'
      axis: string
      value: string
      type: ImageType
      channels: Channel[]
    }

interface Props {
  open: boolean
  files: File[]
  variants: VariantSummary[]
  availableAxes: string[]
  defaultAxis: string
  defaultType?: ImageType
  onCancel: () => void
  onConfirm: (scope: ScopeChoice) => void
}

export default function ScopeUploadModal({
  open,
  files,
  variants,
  availableAxes,
  defaultAxis,
  defaultType = 'ALT',
  onCancel,
  onConfirm,
}: Props) {
  const { t } = useTranslations()
  const [kind, setKind] = useState<'master' | 'variant'>('master')
  const [axis, setAxis] = useState<string>(defaultAxis)
  const [value, setValue] = useState<string>('')
  const [type, setType] = useState<ImageType>(defaultType)
  const [channels, setChannels] = useState<Record<Channel, boolean>>({
    amazon: true,
    ebay: true,
    shopify: true,
  })

  // Reset state every time the modal opens with a fresh batch.
  useEffect(() => {
    if (!open) return
    setKind('master')
    setAxis(defaultAxis)
    setValue('')
    setType(defaultType)
    setChannels({ amazon: true, ebay: true, shopify: true })
  }, [open, defaultAxis, defaultType])

  // Distinct values for the active axis. Empty when the product has
  // no variants on that axis (single-variant or different axis chosen).
  const axisValues = useMemo(() => {
    if (!axis) return []
    if (axis === 'ASIN') {
      return Array.from(new Set(variants.map((v) => v.amazonAsin ?? '').filter(Boolean))).sort()
    }
    if (axis === 'SKU') {
      return Array.from(new Set(variants.map((v) => v.sku))).sort()
    }
    const vs = new Set<string>()
    for (const v of variants) {
      const a = (v.variantAttributes as Record<string, string> | null)?.[axis]
      if (a) vs.add(a)
    }
    return Array.from(vs).sort()
  }, [axis, variants])

  // Pre-seed the value when axis changes and there's a single option,
  // so the operator doesn't have to click a dropdown showing one item.
  useEffect(() => {
    if (axisValues.length === 1) setValue(axisValues[0])
    else if (!axisValues.includes(value)) setValue('')
  }, [axis, axisValues]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!open) return null

  const canSubmit =
    kind === 'master'
      ? true
      : !!axis && !!value && (channels.amazon || channels.ebay || channels.shopify)

  function submit() {
    if (kind === 'master') {
      onConfirm({ kind: 'master', type })
      return
    }
    onConfirm({
      kind: 'variant',
      axis,
      value,
      type,
      channels: (['amazon', 'ebay', 'shopify'] as Channel[]).filter((c) => channels[c]),
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onCancel} />

      <div className="relative bg-white dark:bg-slate-900 rounded-2xl shadow-2xl w-full max-w-lg flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-200 dark:border-slate-700">
          <div>
            <h2 className="text-sm font-semibold text-slate-900 dark:text-slate-100">
              {t('products.edit.images.scopeUpload.title', { count: files.length })}
            </h2>
            <p className="text-xs text-slate-500 dark:text-slate-400 mt-0.5">
              {t('products.edit.images.scopeUpload.subtitle')}
            </p>
          </div>
          <IconButton size="sm" onClick={onCancel} aria-label={t('products.edit.images.lightbox.close')}>
            <X className="w-4 h-4" />
          </IconButton>
        </div>

        {/* File list */}
        <div className="px-5 py-3 border-b border-slate-100 dark:border-slate-800 max-h-32 overflow-y-auto">
          <ul className="text-xs text-slate-600 dark:text-slate-400 space-y-0.5 font-mono">
            {files.slice(0, 8).map((f) => (
              <li key={f.name} className="truncate" title={f.name}>
                {f.name} · {(f.size / 1024).toFixed(0)} KB
              </li>
            ))}
            {files.length > 8 && (
              <li className="text-slate-400">+{files.length - 8} more…</li>
            )}
          </ul>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* Scope */}
          <fieldset>
            <legend className="text-xs font-medium text-slate-600 dark:text-slate-300 mb-1.5">
              {t('products.edit.images.scopeUpload.scopeLabel')}
            </legend>
            <label className="flex items-start gap-2 text-sm py-1 cursor-pointer">
              <input
                type="radio"
                checked={kind === 'master'}
                onChange={() => setKind('master')}
                className="mt-1"
              />
              <span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {t('products.edit.images.scopeUpload.scopeMaster')}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {t('products.edit.images.scopeUpload.scopeMasterHint')}
                </span>
              </span>
            </label>
            <label className={'flex items-start gap-2 text-sm py-1 cursor-pointer ' + (availableAxes.length === 0 ? 'opacity-50 pointer-events-none' : '')}>
              <input
                type="radio"
                checked={kind === 'variant'}
                onChange={() => setKind('variant')}
                className="mt-1"
                disabled={availableAxes.length === 0}
              />
              <span>
                <span className="font-medium text-slate-700 dark:text-slate-200">
                  {t('products.edit.images.scopeUpload.scopeVariant')}
                </span>
                <span className="block text-xs text-slate-500 dark:text-slate-400">
                  {availableAxes.length === 0
                    ? t('products.edit.images.scopeUpload.scopeVariantNone')
                    : t('products.edit.images.scopeUpload.scopeVariantHint')}
                </span>
              </span>
            </label>
          </fieldset>

          {kind === 'variant' && (
            <div className="ml-6 space-y-3 pl-2 border-l-2 border-slate-100 dark:border-slate-800">
              <div className="grid grid-cols-2 gap-2">
                <label className="block">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {t('products.edit.images.scopeUpload.axisLabel')}
                  </span>
                  <select
                    value={axis}
                    onChange={(e) => setAxis(e.target.value)}
                    className="mt-1 w-full text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                  >
                    {availableAxes.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </label>
                <label className="block">
                  <span className="text-xs text-slate-500 dark:text-slate-400">
                    {t('products.edit.images.scopeUpload.valueLabel')}
                  </span>
                  <select
                    value={value}
                    onChange={(e) => setValue(e.target.value)}
                    className="mt-1 w-full text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
                  >
                    <option value="">—</option>
                    {axisValues.map((v) => (
                      <option key={v} value={v}>{v}</option>
                    ))}
                  </select>
                </label>
              </div>

              <fieldset>
                <legend className="text-xs text-slate-500 dark:text-slate-400 mb-1">
                  {t('products.edit.images.scopeUpload.channelsLabel')}
                </legend>
                <div className="flex flex-wrap gap-3">
                  {(['amazon', 'ebay', 'shopify'] as Channel[]).map((c) => (
                    <label key={c} className="inline-flex items-center gap-1.5 text-sm cursor-pointer">
                      <input
                        type="checkbox"
                        checked={channels[c]}
                        onChange={(e) => setChannels({ ...channels, [c]: e.target.checked })}
                      />
                      <span className="capitalize text-slate-700 dark:text-slate-200">{c}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </div>
          )}

          <label className="block">
            <span className="text-xs text-slate-500 dark:text-slate-400">
              {t('products.edit.images.scopeUpload.typeLabel')}
            </span>
            <select
              value={type}
              onChange={(e) => setType(e.target.value as ImageType)}
              className="mt-1 w-full max-w-xs text-sm rounded border border-slate-200 dark:border-slate-700 bg-white dark:bg-slate-900 px-2 py-1.5"
            >
              {IMAGE_TYPES.map((tt) => (
                <option key={tt} value={tt}>{tt}</option>
              ))}
            </select>
          </label>
        </div>

        <div className="flex items-center justify-end gap-2 px-5 py-3 border-t border-slate-100 dark:border-slate-800">
          <Button size="sm" variant="ghost" onClick={onCancel} className="text-xs">
            {t('products.edit.images.lightbox.cancel')}
          </Button>
          <Button size="sm" onClick={submit} disabled={!canSubmit} className="text-xs">
            {t('products.edit.images.scopeUpload.confirm', { count: files.length })}
          </Button>
        </div>
      </div>
    </div>
  )
}
