'use client'

// MC.1.1 — DAM hub client (header + KPI strip + toolbar).
// MC.1.2 — virtualized grid/list library now wired in. Filter
// sidebar, dedicated search, detail drawer land in MC.1.3 → MC.1.5.

import { useState, type ReactNode } from 'react'
import {
  Layers,
  Image as ImageIcon,
  Film,
  HardDrive,
  Link as LinkIcon,
  AlertTriangle,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import KpiStrip from './_components/KpiStrip'
import ContentToolbar, { type ViewMode } from './_components/ContentToolbar'
import AssetLibrary from './_components/AssetLibrary'
import AssetDetailDrawer from './_components/AssetDetailDrawer'
import FilterSidebar, {
  EMPTY_FILTER,
  activeFilterCount,
  type FilterState,
} from './_components/FilterSidebar'
import { formatBytes, formatCount } from './_lib/format'
import type { LibraryItem, OverviewPayload } from './_lib/types'

interface Props {
  overview: OverviewPayload
  overviewError: string | null
  apiBase: string
  icon: ReactNode
}

export default function ContentHubClient({
  overview,
  overviewError,
  apiBase,
}: Props) {
  const { t } = useTranslations()
  const [view, setView] = useState<ViewMode>('grid')
  const [search, setSearch] = useState('')
  const [filtersOpen, setFiltersOpen] = useState(false)
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER)
  const [selected, setSelected] = useState<LibraryItem | null>(null)
  const filterCount = activeFilterCount(filter)

  // Per the audit, ProductImage is the canonical master gallery and
  // DigitalAsset is the forward-compat DAM model. Until the W4.7
  // migration cuts ProductImage rows over to DigitalAsset+AssetUsage
  // we surface the larger of the two counts so the operator sees the
  // truth. After cutover, productImageCount goes to zero and the math
  // collapses to totalAssets.
  const headlineTotal =
    overview.totalAssets + overview.productImageCount

  const imageCount =
    (overview.byType.image ?? 0) + overview.productImageCount

  const tiles = [
    {
      label: t('marketingContent.kpi.totalAssets'),
      value: formatCount(headlineTotal),
      icon: Layers,
      tone: 'default' as const,
    },
    {
      label: t('marketingContent.kpi.images'),
      value: formatCount(imageCount),
      icon: ImageIcon,
      tone: 'default' as const,
    },
    {
      label: t('marketingContent.kpi.videos'),
      value: formatCount(overview.videoCount),
      icon: Film,
      tone: 'default' as const,
    },
    {
      label: t('marketingContent.kpi.storage'),
      value: formatBytes(overview.storageBytes),
      icon: HardDrive,
      tone: 'default' as const,
    },
    {
      label: t('marketingContent.kpi.inUse'),
      value: formatCount(overview.inUseCount),
      secondary: t('marketingContent.kpi.orphaned', {
        n: formatCount(overview.orphanedCount),
      }),
      icon: LinkIcon,
      tone: 'default' as const,
    },
    {
      label: t('marketingContent.kpi.needsAttention'),
      value: formatCount(overview.needsAttention.missingAltImages),
      secondary: t('marketingContent.kpi.missingAltDetail'),
      icon: AlertTriangle,
      tone:
        overview.needsAttention.missingAltImages > 0
          ? ('warn' as const)
          : ('success' as const),
    },
  ]

  return (
    <div className="space-y-4">
      <PageHeader
        title={t('marketingContent.title')}
        description={t('marketingContent.description')}
      />

      {overviewError && (
        <div
          role="alert"
          className="flex items-start gap-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200"
        >
          <AlertTriangle className="w-4 h-4 flex-shrink-0 mt-0.5" />
          <div>
            <p className="font-medium">
              {t('marketingContent.error.overviewTitle')}
            </p>
            <p className="text-xs opacity-80">
              {t('marketingContent.error.overviewDetail', {
                detail: overviewError,
              })}
            </p>
          </div>
        </div>
      )}

      <KpiStrip tiles={tiles} />

      <ContentToolbar
        view={view}
        onViewChange={setView}
        search={search}
        onSearchChange={setSearch}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((prev) => !prev)}
        activeFilterCount={filterCount}
      />

      <div
        className={
          filtersOpen
            ? 'grid grid-cols-1 gap-3 lg:grid-cols-[260px_minmax(0,1fr)]'
            : 'block'
        }
      >
        {filtersOpen && (
          <FilterSidebar
            filter={filter}
            onChange={setFilter}
            onClose={() => setFiltersOpen(false)}
          />
        )}
        <AssetLibrary
          view={view}
          search={search}
          filter={filter}
          apiBase={apiBase}
          onSelect={(item) => setSelected(item)}
          selectedId={selected?.id ?? null}
        />
      </div>

      <AssetDetailDrawer
        selected={selected}
        apiBase={apiBase}
        onClose={() => setSelected(null)}
      />
    </div>
  )
}
