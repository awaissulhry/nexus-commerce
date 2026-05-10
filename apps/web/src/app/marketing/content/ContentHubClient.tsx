'use client'

// MC.1.1 — DAM hub client (header + KPI strip + toolbar).
// MC.1.2 — virtualized grid/list library now wired in. Filter
// sidebar, dedicated search, detail drawer land in MC.1.3 → MC.1.5.

import { useEffect, useState, type ReactNode } from 'react'
import {
  Layers,
  Image as ImageIcon,
  Film,
  HardDrive,
  Link as LinkIcon,
  AlertTriangle,
  BarChart3,
} from 'lucide-react'
import PageHeader from '@/components/layout/PageHeader'
import { useTranslations } from '@/lib/i18n/use-translations'
import KpiStrip from './_components/KpiStrip'
import DeliveryProfileBadge from './_components/DeliveryProfileBadge'
import ContentToolbar, { type ViewMode } from './_components/ContentToolbar'
import AssetLibrary from './_components/AssetLibrary'
import AssetDetailDrawer from './_components/AssetDetailDrawer'
import BulkActionBar from './_components/BulkActionBar'
import FilterSidebar, {
  EMPTY_FILTER,
  activeFilterCount,
  type FilterState,
} from './_components/FilterSidebar'
import FolderTree, { type FolderSelection } from './_components/FolderTree'
import UploadModal from './_components/UploadModal'
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
  const [foldersOpen, setFoldersOpen] = useState(false)
  const [folderSelection, setFolderSelection] =
    useState<FolderSelection>('all')
  const [filter, setFilter] = useState<FilterState>(EMPTY_FILTER)
  const [selected, setSelected] = useState<LibraryItem | null>(null)
  const [uploadOpen, setUploadOpen] = useState(false)
  // MC.2.3 — bulk-selection set, keyed by item.id ("da_..." | "pi_...").
  // Map (not Set) so we can render the bar without re-fetching the
  // items the operator has already paged past.
  const [bulkSelected, setBulkSelected] = useState<Map<string, LibraryItem>>(
    new Map(),
  )
  const [libraryRefreshKey, setLibraryRefreshKey] = useState(0)
  const filterCount = activeFilterCount(filter)

  // MC.14.3 — global keyboard shortcuts. We register on the window
  // (capture=false) so input/textarea focus disables them; the
  // CommandPalette owns Cmd+K independently.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null
      const inEditable =
        target?.tagName === 'INPUT' ||
        target?.tagName === 'TEXTAREA' ||
        target?.isContentEditable
      // Esc closes drawer and bulk selection regardless of focus.
      if (e.key === 'Escape') {
        if (selected) setSelected(null)
        else if (bulkSelected.size > 0) setBulkSelected(new Map())
        return
      }
      if (inEditable || e.metaKey || e.ctrlKey || e.altKey) return
      if (e.key === '/') {
        e.preventDefault()
        const input = document.querySelector<HTMLInputElement>(
          'input[type="search"], input[role="searchbox"]',
        )
        input?.focus()
        return
      }
      if (e.key === 'u' || e.key === 'U') {
        e.preventDefault()
        setUploadOpen(true)
        return
      }
      if (e.key === 'f' || e.key === 'F') {
        e.preventDefault()
        setFiltersOpen((v) => !v)
        return
      }
      if (e.key === 'g' || e.key === 'G') {
        e.preventDefault()
        setView('grid')
        return
      }
      if (e.key === 'l' || e.key === 'L') {
        e.preventDefault()
        setView('list')
        return
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [selected, bulkSelected])

  const toggleBulk = (item: LibraryItem) => {
    setBulkSelected((prev) => {
      const next = new Map(prev)
      if (next.has(item.id)) next.delete(item.id)
      else next.set(item.id, item)
      return next
    })
  }
  const clearBulk = () => setBulkSelected(new Map())
  const handleAfterDelete = (deletedIds: string[]) => {
    setBulkSelected((prev) => {
      const next = new Map(prev)
      for (const id of deletedIds) next.delete(id)
      return next
    })
    if (selected && deletedIds.includes(selected.id)) setSelected(null)
    setLibraryRefreshKey((k) => k + 1)
  }

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
      // MC.13.1 — surface workspace cap when env-set. "12.3 / 50 GB"
      // gives the operator the budget at a glance; tone shifts when
      // soft cap is breached so the tile pre-warns before uploads
      // start failing with 507.
      secondary: overview.storageQuota?.hardCapBytes
        ? `${formatBytes(overview.storageBytes)} / ${formatBytes(overview.storageQuota.hardCapBytes)} (${overview.storageQuota.usagePercent ?? 0}%)`
        : undefined,
      icon: HardDrive,
      tone: overview.storageQuota?.atHardCap
        ? ('warn' as const)
        : overview.storageQuota?.atSoftCap
          ? ('warn' as const)
          : ('default' as const),
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

      <div className="flex items-center justify-end gap-2">
        <a
          href="/marketing/content/analytics"
          className="inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-700 transition hover:border-slate-300 dark:border-slate-700 dark:bg-slate-900 dark:text-slate-200 dark:hover:border-slate-600"
        >
          <BarChart3 className="w-3.5 h-3.5 text-slate-500 dark:text-slate-400" />
          {t('marketingContent.viewAnalytics')}
        </a>
        <DeliveryProfileBadge apiBase={apiBase} />
      </div>

      <ContentToolbar
        view={view}
        onViewChange={setView}
        search={search}
        onSearchChange={setSearch}
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((prev) => !prev)}
        activeFilterCount={filterCount}
        foldersOpen={foldersOpen}
        onToggleFolders={() => setFoldersOpen((prev) => !prev)}
        folderActive={folderSelection !== 'all'}
        filter={filter}
        onApplyView={(s, f) => {
          setSearch(s)
          setFilter(f)
        }}
        onUploadClick={() => setUploadOpen(true)}
      />

      <div
        className={`grid grid-cols-1 gap-3 ${
          foldersOpen && filtersOpen
            ? 'lg:grid-cols-[220px_240px_minmax(0,1fr)]'
            : foldersOpen
              ? 'lg:grid-cols-[220px_minmax(0,1fr)]'
              : filtersOpen
                ? 'lg:grid-cols-[260px_minmax(0,1fr)]'
                : ''
        }`}
      >
        {foldersOpen && (
          <FolderTree
            apiBase={apiBase}
            selected={folderSelection}
            onSelect={setFolderSelection}
          />
        )}
        {filtersOpen && (
          <FilterSidebar
            filter={filter}
            onChange={setFilter}
            onClose={() => setFiltersOpen(false)}
            apiBase={apiBase}
          />
        )}
        <AssetLibrary
          view={view}
          search={search}
          filter={filter}
          folderSelection={folderSelection}
          apiBase={apiBase}
          onSelect={(item) => setSelected(item)}
          selectedId={selected?.id ?? null}
          bulkSelectedIds={bulkSelected}
          onToggleBulk={toggleBulk}
          refreshKey={libraryRefreshKey}
        />
      </div>

      <AssetDetailDrawer
        selected={selected}
        apiBase={apiBase}
        onClose={() => setSelected(null)}
      />

      <BulkActionBar
        selected={[...bulkSelected.values()]}
        apiBase={apiBase}
        onClear={clearBulk}
        onAfterDelete={handleAfterDelete}
      />

      <UploadModal
        open={uploadOpen}
        onClose={() => setUploadOpen(false)}
        apiBase={apiBase}
        folderId={
          folderSelection === 'all' || folderSelection === 'unfiled'
            ? null
            : folderSelection
        }
        onComplete={() => setLibraryRefreshKey((k) => k + 1)}
      />
    </div>
  )
}
