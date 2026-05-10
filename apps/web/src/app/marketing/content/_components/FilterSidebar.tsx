'use client'

// MC.1.3 — multi-dimension filter sidebar.
//
// Per feedback_filter_ux.md the operator wants the multi-dimension
// accordion shape — every dimension visible at once when a section
// is expanded, no single-dim popover. Each section is an independent
// <details> so multiple can stay open simultaneously.
//
// Dimensions:
//   1. Asset type        (image / video / document / model3d)
//   2. Source            (DAM / master gallery)
//   3. Usage             (in use / orphaned)
//   4. Quality           (missing alt text)
//   5. Date              (today / 7d / 30d / all time)
//
// Tag, channel, brand, and locale dimensions are deferred to MC.2 —
// they need taxonomy + AssetUsage scope expansion that doesn't exist
// yet.

import { ChevronDown, X } from 'lucide-react'
import { useTranslations } from '@/lib/i18n/use-translations'
import type { AssetSource } from '../_lib/types'

export type UsageFilter = 'in_use' | 'orphaned' | null
export type DateFilter = 'today' | 'last_7d' | 'last_30d' | null

export interface FilterState {
  types: string[]
  sources: AssetSource[]
  usage: UsageFilter
  missingAlt: boolean
  dateRange: DateFilter
}

export const EMPTY_FILTER: FilterState = {
  types: [],
  sources: [],
  usage: null,
  missingAlt: false,
  dateRange: null,
}

export function activeFilterCount(filter: FilterState): number {
  return (
    filter.types.length +
    filter.sources.length +
    (filter.usage ? 1 : 0) +
    (filter.missingAlt ? 1 : 0) +
    (filter.dateRange ? 1 : 0)
  )
}

interface Props {
  filter: FilterState
  onChange: (next: FilterState) => void
  onClose: () => void
}

interface CheckboxRowProps {
  label: string
  checked: boolean
  onChange: () => void
}

function CheckboxRow({ label, checked, onChange }: CheckboxRowProps) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100 dark:text-slate-200 dark:hover:bg-slate-800">
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500 dark:border-slate-600 dark:bg-slate-800"
      />
      <span>{label}</span>
    </label>
  )
}

interface SectionProps {
  title: string
  count?: number
  children: React.ReactNode
  defaultOpen?: boolean
}

function Section({ title, count, children, defaultOpen = true }: SectionProps) {
  return (
    <details
      open={defaultOpen}
      className="group border-b border-slate-200 last:border-b-0 dark:border-slate-800"
    >
      <summary className="flex cursor-pointer list-none items-center justify-between px-3 py-2.5 text-xs font-semibold uppercase tracking-wide text-slate-500 hover:bg-slate-50 dark:text-slate-400 dark:hover:bg-slate-800/50">
        <span className="flex items-center gap-1.5">
          {title}
          {count !== undefined && count > 0 && (
            <span className="rounded-full bg-blue-600 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white">
              {count}
            </span>
          )}
        </span>
        <ChevronDown className="w-4 h-4 transition-transform group-open:rotate-180" />
      </summary>
      <div className="px-1.5 pb-2">{children}</div>
    </details>
  )
}

export default function FilterSidebar({ filter, onChange, onClose }: Props) {
  const { t } = useTranslations()

  const toggleType = (v: string) =>
    onChange({
      ...filter,
      types: filter.types.includes(v)
        ? filter.types.filter((x) => x !== v)
        : [...filter.types, v],
    })

  const toggleSource = (v: AssetSource) =>
    onChange({
      ...filter,
      sources: filter.sources.includes(v)
        ? filter.sources.filter((x) => x !== v)
        : [...filter.sources, v],
    })

  const setUsage = (v: UsageFilter) =>
    onChange({ ...filter, usage: filter.usage === v ? null : v })

  const setDate = (v: DateFilter) =>
    onChange({ ...filter, dateRange: filter.dateRange === v ? null : v })

  const total = activeFilterCount(filter)

  return (
    <aside
      className="flex flex-col rounded-lg border border-slate-200 bg-white shadow-sm dark:border-slate-800 dark:bg-slate-900"
      aria-label={t('marketingContent.filters.sidebarLabel')}
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2 dark:border-slate-800">
        <p className="text-sm font-medium text-slate-900 dark:text-slate-100">
          {t('marketingContent.filters.title')}
          {total > 0 && (
            <span className="ml-1.5 text-xs font-normal text-slate-500 dark:text-slate-400">
              · {total}
            </span>
          )}
        </p>
        <div className="flex items-center gap-1">
          {total > 0 && (
            <button
              type="button"
              onClick={() => onChange(EMPTY_FILTER)}
              className="rounded px-2 py-1 text-xs text-slate-600 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-slate-800"
            >
              {t('marketingContent.filters.clearAll')}
            </button>
          )}
          <button
            type="button"
            onClick={onClose}
            aria-label={t('marketingContent.filters.close')}
            className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700 dark:hover:bg-slate-800 dark:hover:text-slate-200"
          >
            <X className="w-4 h-4" />
          </button>
        </div>
      </div>

      <div className="overflow-y-auto">
        <Section
          title={t('marketingContent.filters.type.title')}
          count={filter.types.length}
        >
          <CheckboxRow
            label={t('marketingContent.filters.type.image')}
            checked={filter.types.includes('image')}
            onChange={() => toggleType('image')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.type.video')}
            checked={filter.types.includes('video')}
            onChange={() => toggleType('video')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.type.document')}
            checked={filter.types.includes('document')}
            onChange={() => toggleType('document')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.type.model3d')}
            checked={filter.types.includes('model3d')}
            onChange={() => toggleType('model3d')}
          />
        </Section>

        <Section
          title={t('marketingContent.filters.source.title')}
          count={filter.sources.length}
        >
          <CheckboxRow
            label={t('marketingContent.filters.source.dam')}
            checked={filter.sources.includes('digital_asset')}
            onChange={() => toggleSource('digital_asset')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.source.master')}
            checked={filter.sources.includes('product_image')}
            onChange={() => toggleSource('product_image')}
          />
        </Section>

        <Section
          title={t('marketingContent.filters.usage.title')}
          count={filter.usage ? 1 : 0}
        >
          <CheckboxRow
            label={t('marketingContent.filters.usage.inUse')}
            checked={filter.usage === 'in_use'}
            onChange={() => setUsage('in_use')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.usage.orphaned')}
            checked={filter.usage === 'orphaned'}
            onChange={() => setUsage('orphaned')}
          />
        </Section>

        <Section
          title={t('marketingContent.filters.quality.title')}
          count={filter.missingAlt ? 1 : 0}
        >
          <CheckboxRow
            label={t('marketingContent.filters.quality.missingAlt')}
            checked={filter.missingAlt}
            onChange={() =>
              onChange({ ...filter, missingAlt: !filter.missingAlt })
            }
          />
        </Section>

        <Section
          title={t('marketingContent.filters.date.title')}
          count={filter.dateRange ? 1 : 0}
        >
          <CheckboxRow
            label={t('marketingContent.filters.date.today')}
            checked={filter.dateRange === 'today'}
            onChange={() => setDate('today')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.date.last7d')}
            checked={filter.dateRange === 'last_7d'}
            onChange={() => setDate('last_7d')}
          />
          <CheckboxRow
            label={t('marketingContent.filters.date.last30d')}
            checked={filter.dateRange === 'last_30d'}
            onChange={() => setDate('last_30d')}
          />
        </Section>
      </div>
    </aside>
  )
}
