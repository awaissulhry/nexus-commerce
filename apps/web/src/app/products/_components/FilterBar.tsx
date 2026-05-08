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
}

interface FilterBarProps {
  searchInput: string
  setSearchInput: (v: string) => void
  statusFilters: string[]
  channelFilters: string[]
  marketplaceFilters: string[]
  productTypeFilters: string[]
  brandFilters: string[]
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

const MARKETPLACE_DISPLAY_NAMES: Record<string, string> = {
  IT: 'Italy',
  DE: 'Germany',
  FR: 'France',
  ES: 'Spain',
  NL: 'Netherlands',
  SE: 'Sweden',
  PL: 'Poland',
  UK: 'United Kingdom',
  GB: 'United Kingdom',
  US: 'United States',
  CA: 'Canada',
  MX: 'Mexico',
  AU: 'Australia',
  JP: 'Japan',
  GLOBAL: 'Global',
}

export function FilterBar(props: FilterBarProps) {
  const {
    searchInput,
    setSearchInput,
    statusFilters,
    channelFilters,
    marketplaceFilters,
    productTypeFilters,
    brandFilters,
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
      label: 'Status',
      value: statusFilters
        .map((s) => s[0] + s.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ status: undefined, page: undefined }),
    })
  }
  if (channelFilters.length > 0) {
    activePills.push({
      key: 'channels',
      label: 'Channel',
      value: channelFilters
        .map((c) => c[0] + c.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ channels: undefined, page: undefined }),
    })
  }
  if (missingChannelFilters.length > 0) {
    activePills.push({
      key: 'missing',
      label: 'Missing on',
      value: missingChannelFilters
        .map((c) => c[0] + c.slice(1).toLowerCase())
        .join(', '),
      clear: () => updateUrl({ missingChannels: undefined, page: undefined }),
    })
  }
  if (marketplaceFilters.length > 0) {
    activePills.push({
      key: 'marketplaces',
      label: 'Marketplace',
      value: marketplaceFilters.join(', '),
      clear: () => updateUrl({ marketplaces: undefined, page: undefined }),
    })
  }
  if (fulfillmentFilters.length > 0) {
    activePills.push({
      key: 'fulfillment',
      label: 'Fulfillment',
      value: fulfillmentFilters.join(', '),
      clear: () => updateUrl({ fulfillment: undefined, page: undefined }),
    })
  }
  if (productTypeFilters.length > 0) {
    activePills.push({
      key: 'type',
      label: 'Type',
      value: productTypeFilters.map((v) => IT_TERMS[v] ?? v).join(', '),
      clear: () => updateUrl({ productTypes: undefined, page: undefined }),
    })
  }
  if (brandFilters.length > 0) {
    activePills.push({
      key: 'brand',
      label: 'Brand',
      value: brandFilters.join(', '),
      clear: () => updateUrl({ brands: undefined, page: undefined }),
    })
  }
  if (tagFilters.length > 0) {
    activePills.push({
      key: 'tags',
      label: 'Tag',
      value: tagFilters.map((id) => tagsById.get(id) ?? id).join(', '),
      clear: () => updateUrl({ tags: undefined, page: undefined }),
    })
  }
  if (stockLevel) {
    activePills.push({
      key: 'stock',
      label: 'Stock',
      value: stockLevel,
      clear: () => updateUrl({ stockLevel: undefined, page: undefined }),
    })
  }
  if (hasPhotos === 'true' || hasPhotos === 'false') {
    activePills.push({
      key: 'photos',
      label: 'Photos',
      value: hasPhotos === 'true' ? 'has photos' : 'no photos',
      clear: () => updateUrl({ hasPhotos: undefined, page: undefined }),
    })
  }
  if (hasDescription === 'true' || hasDescription === 'false') {
    activePills.push({
      key: 'description',
      label: 'Description',
      value:
        hasDescription === 'true' ? 'has description' : 'no description',
      clear: () => updateUrl({ hasDescription: undefined, page: undefined }),
    })
  }
  if (hasBrand === 'true' || hasBrand === 'false') {
    activePills.push({
      key: 'brand-set',
      label: 'Brand',
      value: hasBrand === 'true' ? 'brand set' : 'no brand',
      clear: () => updateUrl({ hasBrand: undefined, page: undefined }),
    })
  }
  if (hasGtin === 'true' || hasGtin === 'false') {
    activePills.push({
      key: 'gtin',
      label: 'GTIN',
      value: hasGtin === 'true' ? 'has GTIN' : 'no GTIN',
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
            placeholder="Search SKU, name, brand, GTIN…"
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
          Filters
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
            Clear all
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
                aria-label={`Remove ${p.label} filter`}
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
        // U.25 — was xl:grid-cols-4 which made columns narrow enough at
        // ~1280px laptops to break long brand / productType pill rows.
        // Stop at xl:grid-cols-3; 2xl gets 4 columns where there's
        // actual horizontal headroom.
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4 gap-x-6 gap-y-4 pt-3 mt-1 border-t border-slate-200 dark:border-slate-800">
          <FilterGroup
            label="Status"
            options={['ACTIVE', 'DRAFT', 'INACTIVE']}
            selected={statusFilters}
            counts={facets?.statuses.reduce<Record<string, number>>((m, s) => {
              m[s.value] = s.count
              return m
            }, {})}
            onToggle={(v) =>
              updateUrl({
                status: toggleArr(statusFilters, v).join(',') || undefined,
                page: undefined,
              })
            }
            onClear={() => updateUrl({ status: undefined, page: undefined })}
          />
          <FilterGroup
            label="Channels"
            options={['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']}
            selected={channelFilters}
            counts={facets?.channels?.reduce<Record<string, number>>(
              (m, c) => {
                m[c.value] = c.count
                return m
              },
              {},
            )}
            onToggle={(v) =>
              updateUrl({
                channels: toggleArr(channelFilters, v).join(',') || undefined,
                page: undefined,
              })
            }
            onClear={() => updateUrl({ channels: undefined, page: undefined })}
          />
          <FilterGroup
            label="Missing on…"
            options={['AMAZON', 'EBAY', 'SHOPIFY', 'WOOCOMMERCE', 'ETSY']}
            selected={missingChannelFilters}
            onToggle={(v) =>
              updateUrl({
                missingChannels:
                  toggleArr(missingChannelFilters, v).join(',') || undefined,
                page: undefined,
              })
            }
            onClear={() =>
              updateUrl({ missingChannels: undefined, page: undefined })
            }
          />
          {facets?.marketplaces &&
            facets.marketplaces.length > 0 &&
            (() => {
              const merged = new Map<string, number>()
              for (const m of facets.marketplaces!) {
                merged.set(m.value, (merged.get(m.value) ?? 0) + m.count)
              }
              const codes = Array.from(merged.keys()).sort(
                (a, b) => (merged.get(b) ?? 0) - (merged.get(a) ?? 0),
              )
              const counts = Object.fromEntries(merged)
              return (
                <FilterGroup
                  label="Marketplace"
                  options={codes}
                  selected={marketplaceFilters}
                  counts={counts}
                  renderLabel={(v) =>
                    MARKETPLACE_DISPLAY_NAMES[v]
                      ? `${MARKETPLACE_DISPLAY_NAMES[v]} (${v})`
                      : v
                  }
                  onToggle={(v) =>
                    updateUrl({
                      marketplaces:
                        toggleArr(marketplaceFilters, v).join(',') ||
                        undefined,
                      page: undefined,
                    })
                  }
                  onClear={() =>
                    updateUrl({ marketplaces: undefined, page: undefined })
                  }
                />
              )
            })()}
          <FilterGroup
            label="Fulfillment"
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
              label="Product type"
              options={facets.productTypes.slice(0, 24).map((p) => p.value)}
              selected={productTypeFilters}
              counts={facets.productTypes.reduce<Record<string, number>>(
                (m, s) => {
                  m[s.value] = s.count
                  return m
                },
                {},
              )}
              renderLabel={(v) => (IT_TERMS[v] ? `${IT_TERMS[v]} (${v})` : v)}
              onToggle={(v) =>
                updateUrl({
                  productTypes:
                    toggleArr(productTypeFilters, v).join(',') || undefined,
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
              label="Brand"
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
                  brands: toggleArr(brandFilters, v).join(',') || undefined,
                  page: undefined,
                })
              }
              onClear={() => updateUrl({ brands: undefined, page: undefined })}
              searchable
            />
          )}
          {tags.length > 0 && (
            <FilterGroup
              label="Tags"
              options={tags.map((t) => t.id)}
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
              onClear={() => updateUrl({ tags: undefined, page: undefined })}
              searchable
            />
          )}
          <FilterGroup
            label="Stock"
            mode="single"
            options={['in', 'low', 'out']}
            selected={stockLevel}
            renderLabel={(v) =>
              v === 'in'
                ? 'In stock'
                : v === 'low'
                  ? 'Low stock'
                  : 'Out of stock'
            }
            onToggle={(v) =>
              updateUrl({
                stockLevel: stockLevel === v ? undefined : v,
                page: undefined,
              })
            }
            onClear={() =>
              updateUrl({ stockLevel: undefined, page: undefined })
            }
          />
          <FilterGroup
            label={`Photos${facets?.hygiene ? ` · ${facets.hygiene.missingPhotos} missing` : ''}`}
            mode="single"
            options={['true', 'false']}
            selected={hasPhotos}
            renderLabel={(v) => (v === 'true' ? 'Has photos' : 'No photos')}
            onToggle={(v) =>
              updateUrl({
                hasPhotos: hasPhotos === v ? undefined : v,
                page: undefined,
              })
            }
            onClear={() =>
              updateUrl({ hasPhotos: undefined, page: undefined })
            }
          />
          <FilterGroup
            label={`Description${facets?.hygiene ? ` · ${facets.hygiene.missingDescription} missing` : ''}`}
            mode="single"
            options={['true', 'false']}
            selected={hasDescription}
            renderLabel={(v) =>
              v === 'true' ? 'Has description' : 'No description'
            }
            onToggle={(v) =>
              updateUrl({
                hasDescription: hasDescription === v ? undefined : v,
                page: undefined,
              })
            }
            onClear={() =>
              updateUrl({ hasDescription: undefined, page: undefined })
            }
          />
          <FilterGroup
            label={`Brand set${facets?.hygiene ? ` · ${facets.hygiene.missingBrand} missing` : ''}`}
            mode="single"
            options={['true', 'false']}
            selected={hasBrand}
            renderLabel={(v) => (v === 'true' ? 'Brand set' : 'No brand')}
            onToggle={(v) =>
              updateUrl({
                hasBrand: hasBrand === v ? undefined : v,
                page: undefined,
              })
            }
            onClear={() =>
              updateUrl({ hasBrand: undefined, page: undefined })
            }
          />
          <FilterGroup
            label={`GTIN${facets?.hygiene ? ` · ${facets.hygiene.missingGtin} missing` : ''}`}
            mode="single"
            options={['true', 'false']}
            selected={hasGtin}
            renderLabel={(v) => (v === 'true' ? 'Has GTIN' : 'No GTIN')}
            onToggle={(v) =>
              updateUrl({
                hasGtin: hasGtin === v ? undefined : v,
                page: undefined,
              })
            }
            onClear={() => updateUrl({ hasGtin: undefined, page: undefined })}
          />
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
            Clear
          </button>
        )}
      </div>
      {showSearch && (
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Filter ${label.toLowerCase()}…`}
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
          <div className="text-sm text-slate-400 dark:text-slate-500">No matches</div>
        )}
      </div>
    </div>
  )
}
