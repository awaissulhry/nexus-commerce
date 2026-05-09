'use client'

/**
 * P.1h — extracted from ProductsWorkspace.tsx as part of the
 * file-decomposition sweep. The /products filter row + accordion
 * (E.20 multi-dimension layout, E.22 no-Card-wrapper, E.23 unified
 * FilterGroup with single + multi modes).
 *
 * Contract: receives every filter dimension's current value plus
 * facets + tags + updateUrl from the workspace. Renders:
 *   - Search input + Filters toggle button + Clear-all
 *   - Active-filter pills row (E.5)
 *   - Multi-dimension accordion (10 FilterGroups when expanded)
 *
 * The filter state itself stays URL-driven and owned by the
 * workspace (so saved-views + back/forward keep working). This
 * file only renders + emits updateUrl(...) calls.
 *
 * IT_TERMS + MARKETPLACE_DISPLAY_NAMES are inlined here as a
 * local copy of the workspace's seed-mirrored glossary. A final
 * P.1z cleanup commit will consolidate constants into a shared
 * lib once decomposition is complete.
 */

import { useEffect, useMemo, useRef, useState } from 'react'
import { Filter, Search, X } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { useTranslations } from '@/lib/i18n/use-translations'

interface Tag {
  id: string
  name: string
  color: string | null
  productCount?: number
}

interface Facets {
  productTypes: Array<{ value: string; count: number }>
  brands: Array<{ value: string; count: number }>
  fulfillment: Array<{ value: string; count: number }>
  statuses: Array<{ value: string; count: number }>
  marketplaces?: Array<{
    value: string
    channel: string
    label: string
    region: string | null
    count: number
  }>
  hygiene?: {
    total: number
    missingPhotos: number
    missingDescription: number
    missingBrand: number
    missingGtin: number
  }
  channels?: Array<{ value: string; count: number }>
  // W2.12 — PIM family facet. The first row (value='null') represents
  // products with no family attached. The rest are real family ids
  // sorted by descending count.
  families?: Array<{
    value: string
    label: string
    code: string | null
    count: number
  }>
  // W3.9 — Workflow stage facet. Same shape: 'null' bucket first,
  // then per-stage rows. Label includes the workflow name.
  workflowStages?: Array<{
    value: string
    label: string
    workflowLabel: string | null
    count: number
  }>
}

interface FilterBarProps {
  searchInput: string
  setSearchInput: (v: string) => void
  statusFilters: string[]
  channelFilters: string[]
  marketplaceFilters: string[]
  productTypeFilters: string[]
  brandFilters: string[]
  // W2.12 — selected ProductFamily ids. The literal string 'null'
  // represents the "products with no family attached" bucket; mixing
  // it with real ids is allowed (matches families IN list OR familyId
  // IS NULL semantically — see products.routes.ts where clause).
  familyFilters: string[]
  // W3.9 — selected WorkflowStage ids. Same 'null' literal convention.
  workflowStageFilters: string[]
  tagFilters: string[]
  fulfillmentFilters: string[]
  missingChannelFilters: string[]
  stockLevel: string | null | undefined
  hasPhotos: string | null | undefined
  hasDescription: string | null | undefined
  hasBrand: string | null | undefined
  hasGtin: string | null | undefined
  filterCount: number
  facets: Facets | null
  tags: Tag[]
  updateUrl: (patch: Record<string, string | undefined>) => void
}

const IT_TERMS: Record<string, string> = {
  OUTERWEAR: 'Giacca',
  PANTS: 'Pantaloni',
  HELMET: 'Casco',
  BOOTS: 'Stivali',
  PROTECTIVE: 'Protezioni',
  GLOVES: 'Guanti',
  BAG: 'Borsa',
}

// U.36 — Status / Stock / Marketplace / Channels lifted to the
// QuickFilters row above the FilterBar; their constants and labels
// live there now. The accordion only references ACTIVE_CHANNELS
// for the Missing-on filter.
const ACTIVE_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY']

export function FilterBar(props: FilterBarProps) {
  const {
    searchInput,
    setSearchInput,
    statusFilters,
    channelFilters,
    marketplaceFilters,
    productTypeFilters,
    brandFilters,
    familyFilters,
    workflowStageFilters,
    tagFilters,
    fulfillmentFilters,
    missingChannelFilters,
    stockLevel,
    hasPhotos,
    hasDescription,
    hasBrand,
    hasGtin,
    filterCount,
    facets,
    tags,
    updateUrl,
  } = props
  const { t } = useTranslations()

  // F2 — listen for the global "/" focus-search event dispatched by
  // CommandPalette and focus the search input here.
  const searchInputRef = useRef<HTMLInputElement | null>(null)
  useEffect(() => {
    const onFocusSearch = () => {
      searchInputRef.current?.focus()
      searchInputRef.current?.select()
    }
    window.addEventListener('nexus:focus-search', onFocusSearch)
    return () =>
      window.removeEventListener('nexus:focus-search', onFocusSearch)
  }, [])

  // E.20 — bare-F shortcut toggles the accordion.
  useEffect(() => {
    const onOpenFilterMenu = () => setFiltersOpen((o) => !o)
    window.addEventListener('nexus:open-filter-menu', onOpenFilterMenu)
    return () =>
      window.removeEventListener('nexus:open-filter-menu', onOpenFilterMenu)
  }, [])

  const toggleArr = (current: string[], val: string) =>
    current.includes(val)
      ? current.filter((v: string) => v !== val)
      : [...current, val]

  const [filtersOpen, setFiltersOpen] = useState(false)

  // E.5 — active-filter pills.
  const tagsById = useMemo(
    () => new Map<string, string>(tags.map((t) => [t.id, t.name])),
    [tags],
  )
  const activePills: Array<{
    key: string
    label: string
    value: string
    clear: () => void
  }> = []
  if (statusFilters.length > 0) {
    activePills.push({
      key: 'status',
      label: t('products.filter.label.status'),
      value: statusFilters
        .map((s) => s[0] + s.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ status: undefined, page: undefined }),
    })
  }
  if (channelFilters.length > 0) {
    activePills.push({
      key: 'channels',
      label: t('products.filter.label.channel'),
      value: channelFilters
        .map((c) => c[0] + c.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ channels: undefined, page: undefined }),
    })
  }
  if (missingChannelFilters.length > 0) {
    activePills.push({
      key: 'missing',
      label: t('products.filter.label.missingOn'),
      value: missingChannelFilters
        .map((c) => c[0] + c.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ missingChannels: undefined, page: undefined }),
    })
  }
  if (marketplaceFilters.length > 0) {
    activePills.push({
      key: 'marketplaces',
      label: t('products.filter.label.marketplace'),
      value: marketplaceFilters.join(', '),
      clear: () => updateUrl({ marketplaces: undefined, page: undefined }),
    })
  }
  if (fulfillmentFilters.length > 0) {
    activePills.push({
      key: 'fulfillment',
      label: t('products.filter.label.fulfillment'),
      value: fulfillmentFilters.join(', '),
      clear: () => updateUrl({ fulfillment: undefined, page: undefined }),
    })
  }
  if (productTypeFilters.length > 0) {
    activePills.push({
      key: 'type',
      label: t('products.filter.label.type'),
      value: productTypeFilters.map((v) => IT_TERMS[v] ?? v).join(', '),
      clear: () => updateUrl({ productTypes: undefined, page: undefined }),
    })
  }
  if (brandFilters.length > 0) {
    activePills.push({
      key: 'brand',
      label: t('products.filter.label.brand'),
      value: brandFilters.join(', '),
      clear: () => updateUrl({ brands: undefined, page: undefined }),
    })
  }
  // W2.12 — Family pill. Resolves the id back to the label via the
  // facets lookup so the pill reads "Motorcycle Jacket" not the cuid.
  if (familyFilters.length > 0) {
    const familyLookup = new Map(
      (facets?.families ?? []).map((f) => [f.value, f.label]),
    )
    activePills.push({
      key: 'family',
      label: t('products.filter.label.family'),
      value: familyFilters
        .map((id) => familyLookup.get(id) ?? id)
        .join(', '),
      clear: () => updateUrl({ families: undefined, page: undefined }),
    })
  }
  // W3.9 — Workflow stage pill. Same lookup pattern.
  if (workflowStageFilters.length > 0) {
    const stageLookup = new Map(
      (facets?.workflowStages ?? []).map((s) => [s.value, s.label]),
    )
    activePills.push({
      key: 'stage',
      label: t('products.filter.label.stage'),
      value: workflowStageFilters
        .map((id) => stageLookup.get(id) ?? id)
        .join(', '),
      clear: () =>
        updateUrl({ workflowStages: undefined, page: undefined }),
    })
  }
  if (tagFilters.length > 0) {
    activePills.push({
      key: 'tags',
      label: t('products.filter.label.tag'),
      value: tagFilters.map((id) => tagsById.get(id) ?? id).join(', '),
      clear: () => updateUrl({ tags: undefined, page: undefined }),
    })
  }
  if (stockLevel) {
    activePills.push({
      key: 'stock',
      label: t('products.filter.label.stock'),
      value: stockLevel,
      clear: () => updateUrl({ stockLevel: undefined, page: undefined }),
    })
  }
  if (hasPhotos === 'true' || hasPhotos === 'false') {
    activePills.push({
      key: 'photos',
      label: t('products.filter.label.photos'),
      value: t(
        hasPhotos === 'true'
          ? 'products.filter.pillVal.hasPhotos'
          : 'products.filter.pillVal.noPhotos',
      ),
      clear: () => updateUrl({ hasPhotos: undefined, page: undefined }),
    })
  }
  if (hasDescription === 'true' || hasDescription === 'false') {
    activePills.push({
      key: 'description',
      label: t('products.filter.label.description'),
      value: t(
        hasDescription === 'true'
          ? 'products.filter.pillVal.hasDescription'
          : 'products.filter.pillVal.noDescription',
      ),
      clear: () => updateUrl({ hasDescription: undefined, page: undefined }),
    })
  }
  if (hasBrand === 'true' || hasBrand === 'false') {
    activePills.push({
      key: 'brand-set',
      label: t('products.filter.label.brand'),
      value: t(
        hasBrand === 'true'
          ? 'products.filter.pillVal.brandSet'
          : 'products.filter.pillVal.noBrand',
      ),
      clear: () => updateUrl({ hasBrand: undefined, page: undefined }),
    })
  }
  if (hasGtin === 'true' || hasGtin === 'false') {
    activePills.push({
      key: 'gtin',
      label: t('products.filter.label.gtin'),
      value: t(
        hasGtin === 'true'
          ? 'products.filter.pillVal.hasGtin'
          : 'products.filter.pillVal.noGtin',
      ),
      clear: () => updateUrl({ hasGtin: undefined, page: undefined }),
    })
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex-1 min-w-[240px] max-w-md relative">
          <Search
            size={12}
            className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-400 dark:text-slate-500"
          />
          <Input
            ref={searchInputRef}
            placeholder={t('products.filter.search.placeholder')}
            value={searchInput}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
              setSearchInput(e.target.value)
            }
            className="pl-7"
          />
        </div>
        <button
          onClick={() => setFiltersOpen(!filtersOpen)}
          aria-expanded={filtersOpen}
          className={`h-8 min-h-11 sm:min-h-8 px-3 text-base border rounded-md inline-flex items-center gap-1.5 transition-colors ${filtersOpen ? 'border-slate-900 bg-slate-900 text-white dark:border-slate-100 dark:bg-slate-100 dark:text-slate-900' : filterCount > 0 ? 'border-slate-300 bg-slate-50 text-slate-700 hover:bg-slate-100 dark:border-slate-700 dark:bg-slate-800 dark:text-slate-300 dark:hover:bg-slate-700' : 'border-slate-200 text-slate-700 hover:bg-slate-50 dark:border-slate-800 dark:text-slate-300 dark:hover:bg-slate-800'}`}
        >
          <Filter size={12} />
          {t('products.filter.toggle')}
          {filterCount > 0 && (
            <span
              className={`text-xs px-1.5 py-0.5 rounded-full font-semibold ${filtersOpen ? 'bg-white text-slate-900 dark:bg-slate-900 dark:text-slate-100' : 'bg-slate-700 text-white dark:bg-slate-300 dark:text-slate-900'}`}
            >
              {filterCount}
            </span>
          )}
        </button>
        {filterCount > 0 && (
          <Button
            variant="ghost"
            onClick={() =>
              updateUrl({
                status: '',
                channels: '',
                marketplaces: '',
                productTypes: '',
                brands: '',
                tags: '',
                fulfillment: '',
                missingChannels: '',
                stockLevel: undefined,
                hasPhotos: undefined,
                hasDescription: undefined,
                hasBrand: undefined,
                hasGtin: undefined,
                page: undefined,
              })
            }
            className="text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
            icon={<X size={12} />}
          >
            {t('products.filter.clearAll')}
          </Button>
        )}
      </div>

      {activePills.length > 0 && (
        <div className="flex items-center gap-1.5 flex-wrap">
          {activePills.map((p) => (
            <span
              key={p.key}
              className="inline-flex items-center gap-0.5 h-7 text-sm rounded-full bg-blue-50 text-blue-900 border border-blue-200 dark:bg-blue-950/40 dark:text-blue-100 dark:border-blue-800"
            >
              <button
                type="button"
                onClick={() => setFiltersOpen(true)}
                className="inline-flex items-center gap-1 pl-2 pr-1 h-full hover:bg-blue-100 rounded-l-full dark:hover:bg-blue-900/40"
              >
                <span className="font-medium text-blue-700 dark:text-blue-300">{p.label}:</span>
                <span className="truncate max-w-[180px]">{p.value}</span>
              </button>
              <button
                type="button"
                onClick={p.clear}
                aria-label={t('products.filter.removeAria', { label: p.label })}
                // U.22 — visible swatch stays w-5 h-5 via inner span;
                // hit zone expands to 44×44 on mobile.
                className="inline-flex items-center justify-center min-h-11 min-w-11 sm:min-h-0 sm:min-w-0 sm:w-5 sm:h-5 rounded-full hover:bg-blue-100 text-blue-700 dark:hover:bg-blue-900/40 dark:text-blue-300"
              >
                <X size={11} />
              </button>
            </span>
          ))}
        </div>
      )}

      {filtersOpen && (
        // U.36 — accordion now scoped to advanced filters only.
        // Status / Stock / Marketplace / Channels moved to the
        // QuickFilters row above (always visible). Hygiene 4
        // removed entirely — HygieneStrip is the canonical surface
        // for those (and was duplicating the chips here).
        //
        // What remains: Product type / Brand / Tags / Fulfillment /
        // Missing on… — long-tail dimensions used a few times per
        // session, organized into Catalog + Distribution sub-
        // sections.
        <div className="pt-3 mt-1 border-t border-slate-200 dark:border-slate-800 space-y-5">
          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
              {t('products.filter.section.catalog')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-x-6 gap-y-4">
              <FilterGroup
                label={t('products.filter.label.fulfillment')}
                options={['FBA', 'FBM']}
                selected={fulfillmentFilters}
                counts={facets?.fulfillment.reduce<Record<string, number>>(
                  (m, s) => {
                    m[s.value] = s.count
                    return m
                  },
                  {},
                )}
                onToggle={(v) =>
                  updateUrl({
                    fulfillment:
                      toggleArr(fulfillmentFilters, v).join(',') || undefined,
                    page: undefined,
                  })
                }
                onClear={() =>
                  updateUrl({ fulfillment: undefined, page: undefined })
                }
              />
              {facets && facets.productTypes.length > 0 && (
                <FilterGroup
                  label={t('products.filter.label.productType')}
                  options={facets.productTypes
                    .slice(0, 24)
                    .map((p) => p.value)}
                  selected={productTypeFilters}
                  counts={facets.productTypes.reduce<Record<string, number>>(
                    (m, s) => {
                      m[s.value] = s.count
                      return m
                    },
                    {},
                  )}
                  renderLabel={(v) =>
                    IT_TERMS[v] ? `${IT_TERMS[v]} (${v})` : v
                  }
                  onToggle={(v) =>
                    updateUrl({
                      productTypes:
                        toggleArr(productTypeFilters, v).join(',') ||
                        undefined,
                      page: undefined,
                    })
                  }
                  onClear={() =>
                    updateUrl({ productTypes: undefined, page: undefined })
                  }
                  searchable
                />
              )}
              {facets && facets.brands.length > 0 && (
                <FilterGroup
                  label={t('products.filter.label.brand')}
                  options={facets.brands.slice(0, 24).map((p) => p.value)}
                  selected={brandFilters}
                  counts={facets.brands.reduce<Record<string, number>>(
                    (m, s) => {
                      m[s.value] = s.count
                      return m
                    },
                    {},
                  )}
                  onToggle={(v) =>
                    updateUrl({
                      brands:
                        toggleArr(brandFilters, v).join(',') || undefined,
                      page: undefined,
                    })
                  }
                  onClear={() =>
                    updateUrl({ brands: undefined, page: undefined })
                  }
                  searchable
                />
              )}
              {tags.length > 0 && (
                <FilterGroup
                  label={t('products.filter.label.tags')}
                  options={tags.map((tag) => tag.id)}
                  selected={tagFilters}
                  renderLabel={(id) =>
                    tags.find((t) => t.id === id)?.name ?? id
                  }
                  onToggle={(v) =>
                    updateUrl({
                      tags: toggleArr(tagFilters, v).join(',') || undefined,
                      page: undefined,
                    })
                  }
                  onClear={() =>
                    updateUrl({ tags: undefined, page: undefined })
                  }
                  searchable
                />
              )}
              {/* W2.12 — Family facet. The first option is the
                  "no family yet" bucket (value='null') so the
                  operator can quickly find the unfamilied backlog. */}
              {facets && facets.families && facets.families.length > 0 && (
                <FilterGroup
                  label={t('products.filter.label.family')}
                  options={facets.families.map((f) => f.value)}
                  selected={familyFilters}
                  counts={facets.families.reduce<Record<string, number>>(
                    (m, s) => {
                      m[s.value] = s.count
                      return m
                    },
                    {},
                  )}
                  renderLabel={(id: string) =>
                    facets.families!.find((f) => f.value === id)?.label ?? id
                  }
                  onToggle={(v) =>
                    updateUrl({
                      families:
                        toggleArr(familyFilters, v).join(',') || undefined,
                      page: undefined,
                    })
                  }
                  onClear={() =>
                    updateUrl({ families: undefined, page: undefined })
                  }
                  searchable
                />
              )}
              {/* W3.9 — Workflow stage facet. 'null' bucket first
                  ("products not on any workflow yet"). */}
              {facets &&
                facets.workflowStages &&
                facets.workflowStages.length > 0 && (
                  <FilterGroup
                    label={t('products.filter.label.workflowStage')}
                    options={facets.workflowStages.map((s) => s.value)}
                    selected={workflowStageFilters}
                    counts={facets.workflowStages.reduce<Record<string, number>>(
                      (m, s) => {
                        m[s.value] = s.count
                        return m
                      },
                      {},
                    )}
                    renderLabel={(id: string) =>
                      facets.workflowStages!.find((s) => s.value === id)
                        ?.label ?? id
                    }
                    onToggle={(v) =>
                      updateUrl({
                        workflowStages:
                          toggleArr(workflowStageFilters, v).join(',') ||
                          undefined,
                        page: undefined,
                      })
                    }
                    onClear={() =>
                      updateUrl({ workflowStages: undefined, page: undefined })
                    }
                    searchable
                  />
                )}
            </div>
          </div>

          <div>
            <div className="text-xs uppercase tracking-wider text-slate-500 dark:text-slate-400 font-semibold mb-2">
              {t('products.filter.section.distribution')}
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-x-6 gap-y-4">
              <FilterGroup
                label={t('products.filter.label.missingOnAccordion')}
                options={ACTIVE_CHANNELS}
                selected={missingChannelFilters}
                onToggle={(v) =>
                  updateUrl({
                    missingChannels:
                      toggleArr(missingChannelFilters, v).join(',') ||
                      undefined,
                    page: undefined,
                  })
                }
                onClear={() =>
                  updateUrl({
                    missingChannels: undefined,
                    page: undefined,
                  })
                }
              />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// E.23 — unified FilterGroup. Multi-select (default) for
// Status/Channels/Tags/etc; single-select for Stock + Photos +
// hygiene tri-states via mode='single'. Header carries label +
// "(N selected)" + per-group Clear; long lists (>8) get an inline
// search input.
function FilterGroup({
  label,
  options,
  selected,
  onToggle,
  counts,
  renderLabel,
  onClear,
  mode = 'multi',
  searchable = false,
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
    mode === 'single'
      ? selected === opt
      : Array.isArray(selected)
        ? selected.includes(opt)
        : false
  const selectedCount = Array.isArray(selected)
    ? selected.length
    : selected
      ? 1
      : 0
  if (options.length === 0) return null
  const showSearch = searchable && options.length > 8
  const visibleOptions =
    showSearch && query
      ? options.filter((o) => {
          const display = (renderLabel ? renderLabel(o) : o).toLowerCase()
          return display.includes(query.toLowerCase())
        })
      : options
  return (
    <div className="min-w-0">
      <div className="flex items-center justify-between gap-2 mb-1.5">
        <div className="text-sm font-semibold uppercase tracking-wider text-slate-500 dark:text-slate-400 truncate">
          {label}
          {selectedCount > 0 && (
            <span className="ml-1.5 text-slate-700 dark:text-slate-300 normal-case font-medium">
              ({selectedCount})
            </span>
          )}
        </div>
        {selectedCount > 0 && onClear && (
          <button
            type="button"
            onClick={onClear}
            className="text-xs text-slate-500 hover:text-slate-900 dark:text-slate-400 dark:hover:text-slate-100"
          >
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
        {visibleOptions.map((opt: string) => {
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
                <span
                  className={`tabular-nums ${active ? 'text-slate-300 dark:text-slate-600' : 'text-slate-400 dark:text-slate-500'}`}
                >
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
