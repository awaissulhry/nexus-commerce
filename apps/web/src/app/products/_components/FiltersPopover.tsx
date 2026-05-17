'use client'

import { createPortal } from 'react-dom'
import { useEffect, useRef, useState } from 'react'
import { useTranslations } from '@/lib/i18n/use-translations'
import { cn } from '@/lib/utils'

interface Tag { id: string; name: string; color: string | null; productCount?: number }
interface Facets {
  productTypes: Array<{ value: string; count: number }>
  brands: Array<{ value: string; count: number }>
  fulfillment: Array<{ value: string; count: number }>
  statuses: Array<{ value: string; count: number }>
  marketplaces?: Array<{ value: string; channel: string; label: string; region: string | null; count: number }>
  hygiene?: { total: number; missingPhotos: number; missingDescription: number; missingBrand: number; missingGtin: number }
  channels?: Array<{ value: string; count: number }>
  families?: Array<{ value: string; label: string; code: string | null; count: number }>
  workflowStages?: Array<{ value: string; label: string; workflowLabel: string | null; count: number }>
}

interface Props {
  anchorRect: DOMRect
  marketplaceFilters: string[]
  fulfillmentFilters: string[]
  productTypeFilters: string[]
  brandFilters: string[]
  familyFilters: string[]
  workflowStageFilters: string[]
  tagFilters: string[]
  missingChannelFilters: string[]
  driftOnly: string | null | undefined
  facets: Facets | null
  tags: Tag[]
  updateUrl: (patch: Record<string, string | undefined>) => void
  onClose: () => void
}

const IT_TERMS: Record<string, string> = {
  OUTERWEAR: 'Giacca', PANTS: 'Pantaloni', HELMET: 'Casco',
  BOOTS: 'Stivali', PROTECTIVE: 'Protezioni', GLOVES: 'Guanti', BAG: 'Borsa',
}
const ACTIVE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY']

export function FiltersPopover(props: Props) {
  const {
    marketplaceFilters, fulfillmentFilters, productTypeFilters, brandFilters,
    familyFilters, workflowStageFilters, tagFilters, missingChannelFilters,
    driftOnly, facets, tags, updateUrl, onClose, anchorRect,
  } = props
  const ref = useRef<HTMLDivElement>(null)
  const [mounted, setMounted] = useState(false)
  useEffect(() => { setMounted(true) }, [])

  useEffect(() => {
    const onOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose()
    }
    document.addEventListener('mousedown', onOutside)
    return () => document.removeEventListener('mousedown', onOutside)
  }, [onClose])

  const toggleArr = (current: string[], val: string) =>
    current.includes(val) ? current.filter((v) => v !== val) : [...current, val]

  const { t } = useTranslations()

  // Position: align left edge below the anchor button, clamp to viewport.
  const W = 800
  const top = anchorRect.bottom + 6
  const left = Math.min(anchorRect.left, window.innerWidth - W - 8)

  const popover = (
    <div
      ref={ref}
      style={{ position: 'fixed', top, left, width: W, zIndex: 9999, maxWidth: 'calc(100vw - 16px)' }}
      className="bg-white dark:bg-slate-900 border border-slate-200 dark:border-slate-800 rounded-lg shadow-2xl p-5"
    >
      {/* Catalog filters */}
      <div className="mb-5">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-3">
          {t('products.filter.section.catalog')}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-4">
          <FilterGroup
            label={t('products.filter.label.fulfillment')}
            options={['FBA', 'FBM']}
            selected={fulfillmentFilters}
            counts={facets?.fulfillment.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
            onToggle={(v) => updateUrl({ fulfillment: toggleArr(fulfillmentFilters, v).join(',') || undefined, page: undefined })}
            onClear={() => updateUrl({ fulfillment: undefined, page: undefined })}
          />
          {facets && facets.productTypes.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.productType')}
              options={facets.productTypes.slice(0, 24).map((p) => p.value)}
              selected={productTypeFilters}
              counts={facets.productTypes.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
              renderLabel={(v) => IT_TERMS[v] ? `${IT_TERMS[v]} (${v})` : v}
              onToggle={(v) => updateUrl({ productTypes: toggleArr(productTypeFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ productTypes: undefined, page: undefined })}
              searchable
            />
          )}
          {facets && facets.brands.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.brand')}
              options={facets.brands.slice(0, 24).map((p) => p.value)}
              selected={brandFilters}
              counts={facets.brands.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
              onToggle={(v) => updateUrl({ brands: toggleArr(brandFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ brands: undefined, page: undefined })}
              searchable
            />
          )}
          {tags.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.tags')}
              options={tags.map((tag) => tag.id)}
              selected={tagFilters}
              renderLabel={(id) => tags.find((t) => t.id === id)?.name ?? id}
              onToggle={(v) => updateUrl({ tags: toggleArr(tagFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ tags: undefined, page: undefined })}
              searchable
            />
          )}
          {facets?.families && facets.families.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.family')}
              options={facets.families.map((f) => f.value)}
              selected={familyFilters}
              counts={facets.families.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
              renderLabel={(id) => facets.families!.find((f) => f.value === id)?.label ?? id}
              onToggle={(v) => updateUrl({ families: toggleArr(familyFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ families: undefined, page: undefined })}
              searchable
            />
          )}
          {facets?.workflowStages && facets.workflowStages.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.workflowStage')}
              options={facets.workflowStages.map((s) => s.value)}
              selected={workflowStageFilters}
              counts={facets.workflowStages.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
              renderLabel={(id) => facets.workflowStages!.find((s) => s.value === id)?.label ?? id}
              onToggle={(v) => updateUrl({ workflowStages: toggleArr(workflowStageFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ workflowStages: undefined, page: undefined })}
              searchable
            />
          )}
          {facets?.marketplaces && facets.marketplaces.length > 0 && (
            <FilterGroup
              label={t('products.filter.label.marketplace')}
              options={facets.marketplaces.map((m) => m.value)}
              selected={marketplaceFilters}
              counts={facets.marketplaces.reduce<Record<string, number>>((m, s) => { m[s.value] = s.count; return m }, {})}
              renderLabel={(v) => facets.marketplaces!.find((m) => m.value === v)?.label ?? v}
              onToggle={(v) => updateUrl({ marketplaces: toggleArr(marketplaceFilters, v).join(',') || undefined, page: undefined })}
              onClear={() => updateUrl({ marketplaces: undefined, page: undefined })}
            />
          )}
        </div>
      </div>

      {/* Distribution filters */}
      <div className="border-t border-slate-100 dark:border-slate-800 pt-4">
        <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-3">
          {t('products.filter.section.distribution')}
        </div>
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-x-6 gap-y-4">
          <FilterGroup
            label={t('products.filter.label.missingOnAccordion')}
            options={ACTIVE_CHANNELS}
            selected={missingChannelFilters}
            onToggle={(v) => updateUrl({ missingChannels: toggleArr(missingChannelFilters, v).join(',') || undefined, page: undefined })}
            onClear={() => updateUrl({ missingChannels: undefined, page: undefined })}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 mb-1.5">
              Channel drift
            </div>
            <button
              type="button"
              onClick={() => updateUrl({ driftOnly: driftOnly === 'true' ? undefined : 'true', page: undefined })}
              className={cn(
                'inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-medium transition-colors',
                driftOnly === 'true'
                  ? 'bg-amber-100 dark:bg-amber-900/30 border-amber-300 dark:border-amber-700 text-amber-800 dark:text-amber-300'
                  : 'border-slate-200 dark:border-slate-700 text-slate-600 dark:text-slate-400 hover:bg-slate-50 dark:hover:bg-slate-800',
              )}
            >
              Has overrides
            </button>
          </div>
        </div>
      </div>

      {/* Footer */}
      <div className="flex items-center justify-end mt-4 pt-3 border-t border-slate-100 dark:border-slate-800">
        <button
          type="button"
          onClick={onClose}
          className="text-sm font-medium text-slate-700 dark:text-slate-300 hover:text-slate-900 dark:hover:text-slate-100 px-3 py-1.5 rounded-md hover:bg-slate-100 dark:hover:bg-slate-800 transition-colors"
        >
          Done
        </button>
      </div>
    </div>
  )

  if (!mounted) return null
  return createPortal(popover, document.body)
}

// ── FilterGroup ──────────────────────────────────────────────────────
function FilterGroup({
  label, options, selected, onToggle, counts, renderLabel, onClear,
  mode = 'multi', searchable = false,
}: {
  label: string
  options: string[]
  selected: string[] | string | null | undefined
  onToggle: (v: string) => void
  counts?: Record<string, number>
  renderLabel?: (v: string) => string
  onClear?: () => void
  mode?: 'multi' | 'single'
  searchable?: boolean
}) {
  const { t } = useTranslations()
  const [query, setQuery] = useState('')
  const isActive = (opt: string) =>
    mode === 'single' ? selected === opt : Array.isArray(selected) ? selected.includes(opt) : false
  const selectedCount = Array.isArray(selected) ? selected.length : selected ? 1 : 0
  if (options.length === 0) return null
  const showSearch = searchable && options.length > 8
  const visibleOptions = showSearch && query
    ? options.filter((o) => (renderLabel ? renderLabel(o) : o).toLowerCase().includes(query.toLowerCase()))
    : options
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
          {label}
          {selectedCount > 0 && (
            <span className="ml-1.5 text-slate-700 dark:text-slate-300 normal-case font-medium">({selectedCount})</span>
          )}
        </div>
        {selectedCount > 0 && onClear && (
          <button type="button" onClick={onClear} className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100">
            {t('products.filter.group.clear')}
          </button>
        )}
      </div>
      {showSearch && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('products.filter.group.searchPlaceholder', { label: label.toLowerCase() })}
          className="w-full h-7 px-2 mb-1.5 text-sm border border-slate-200 rounded-md focus:outline-none focus:ring-1 focus:ring-slate-400 dark:border-slate-800 dark:bg-slate-900 dark:text-slate-100"
        />
      )}
      <div className="flex items-center gap-1.5 flex-wrap">
        {visibleOptions.map((opt) => {
          const active = isActive(opt)
          const count = counts?.[opt]
          return (
            <button
              key={opt}
              onClick={() => onToggle(opt)}
              className={`h-7 px-2.5 text-sm border rounded-md inline-flex items-center gap-1.5 transition-colors ${active ? 'bg-slate-900 text-white border-slate-900 dark:bg-slate-100 dark:text-slate-900 dark:border-slate-100' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50 hover:border-slate-300 dark:bg-slate-900 dark:text-slate-300 dark:border-slate-800 dark:hover:bg-slate-800 dark:hover:border-slate-700'}`}
            >
              {renderLabel ? renderLabel(opt) : opt}
              {count != null && (
                <span className={`tabular-nums ${active ? 'text-slate-300 dark:text-slate-600' : 'text-slate-400 dark:text-slate-500'}`}>
                  {count}
                </span>
              )}
            </button>
          )
        })}
        {showSearch && visibleOptions.length === 0 && (
          <div className="text-sm text-slate-500 dark:text-slate-400">{t('products.filter.group.noMatches')}</div>
        )}
      </div>
    </div>
  )
}
