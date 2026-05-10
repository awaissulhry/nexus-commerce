'use client'

// MC.1.1 — toolbar shell for the DAM hub. Just the chrome in this
// commit: search input, filter button, view toggle (grid/list), upload
// button, and an "AI bulk process" button placeholder. The handlers
// fire toasts in this commit; MC.1.2/1.3/1.4 wire each control to a
// real surface.

import { Filter, LayoutGrid, List, Upload, Sparkles } from 'lucide-react'
import { Button } from '@/components/ui/Button'
import { useTranslations } from '@/lib/i18n/use-translations'
import { useToast } from '@/components/ui/Toast'
import SearchInput from './SearchInput'

export type ViewMode = 'grid' | 'list'

interface Props {
  view: ViewMode
  onViewChange: (next: ViewMode) => void
  search: string
  onSearchChange: (next: string) => void
  filtersOpen: boolean
  onToggleFilters: () => void
  activeFilterCount?: number
}

export default function ContentToolbar({
  view,
  onViewChange,
  search,
  onSearchChange,
  filtersOpen,
  onToggleFilters,
  activeFilterCount = 0,
}: Props) {
  const { t } = useTranslations()
  const { toast } = useToast()

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-slate-200 bg-white p-3 shadow-sm dark:border-slate-800 dark:bg-slate-900 sm:flex-row sm:items-center">
      <SearchInput value={search} onChange={onSearchChange} />

      <div className="flex items-center gap-2 flex-wrap">
        {/* Filter toggle */}
        <Button
          variant={filtersOpen || activeFilterCount > 0 ? 'primary' : 'secondary'}
          size="sm"
          onClick={onToggleFilters}
          aria-pressed={filtersOpen}
          aria-label={t('marketingContent.toolbar.filters')}
        >
          <Filter className="w-4 h-4" />
          <span className="hidden sm:inline ml-1">
            {t('marketingContent.toolbar.filters')}
          </span>
          {activeFilterCount > 0 && (
            <span className="ml-1 rounded-full bg-white/25 px-1.5 py-0.5 text-[10px] font-bold leading-none">
              {activeFilterCount}
            </span>
          )}
        </Button>

        {/* View toggle */}
        <div
          className="inline-flex rounded-md border border-slate-300 dark:border-slate-700"
          role="group"
          aria-label={t('marketingContent.toolbar.viewMode')}
        >
          <button
            type="button"
            onClick={() => onViewChange('grid')}
            aria-pressed={view === 'grid'}
            aria-label={t('marketingContent.toolbar.viewGrid')}
            className={`px-2.5 py-1.5 text-sm transition-colors ${
              view === 'grid'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
            }`}
          >
            <LayoutGrid className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={() => onViewChange('list')}
            aria-pressed={view === 'list'}
            aria-label={t('marketingContent.toolbar.viewList')}
            className={`border-l border-slate-300 px-2.5 py-1.5 text-sm transition-colors dark:border-slate-700 ${
              view === 'list'
                ? 'bg-slate-900 text-white dark:bg-slate-100 dark:text-slate-900'
                : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-slate-900 dark:text-slate-400 dark:hover:bg-slate-800'
            }`}
          >
            <List className="w-4 h-4" />
          </button>
        </div>

        <div className="hidden sm:block w-px h-6 bg-slate-200 dark:bg-slate-700" />

        {/* AI bulk process — placeholder, MC.4 */}
        <Button
          variant="secondary"
          size="sm"
          onClick={() =>
            toast({
              title: t('marketingContent.toolbar.aiBulkComing.title'),
              description: t('marketingContent.toolbar.aiBulkComing.body'),
              tone: 'info',
            })
          }
        >
          <Sparkles className="w-4 h-4" />
          <span className="hidden sm:inline ml-1">
            {t('marketingContent.toolbar.aiBulk')}
          </span>
        </Button>

        {/* Upload — placeholder, MC.3 */}
        <Button
          variant="primary"
          size="sm"
          onClick={() =>
            toast({
              title: t('marketingContent.toolbar.uploadComing.title'),
              description: t('marketingContent.toolbar.uploadComing.body'),
              tone: 'info',
            })
          }
        >
          <Upload className="w-4 h-4" />
          <span className="ml-1">{t('marketingContent.toolbar.upload')}</span>
        </Button>
      </div>
    </div>
  )
}
