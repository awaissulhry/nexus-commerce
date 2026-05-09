'use client'

import { cn } from '@/lib/utils'
import { NUM_FMT } from '../_lib/format'
import type { OverviewPayload, T } from '../_lib/types'

/**
 * Catalog snapshot tile — six counts in a 2-column grid:
 * products, parents, variants, live listings, draft listings,
 * failed listings. Failed-listings count flushes rose when non-zero
 * to draw the eye.
 */
export default function CatalogSnapshot({
  t,
  catalog,
}: {
  t: T
  catalog: OverviewPayload['catalog']
}) {
  return (
    <div className="border border-slate-200 rounded-lg bg-white">
      <div className="px-4 py-3 border-b border-slate-100">
        <h2 className="text-md font-semibold text-slate-900">
          {t('overview.catalog.heading')}
        </h2>
      </div>
      <div className="px-4 py-3 grid grid-cols-2 gap-3 text-base">
        <SnapshotCell
          label={t('overview.catalog.products')}
          value={NUM_FMT.format(catalog.totalProducts)}
        />
        <SnapshotCell
          label={t('overview.catalog.parents')}
          value={NUM_FMT.format(catalog.totalParents)}
        />
        <SnapshotCell
          label={t('overview.catalog.variants')}
          value={NUM_FMT.format(catalog.totalVariants)}
        />
        <SnapshotCell
          label={t('overview.catalog.live')}
          value={NUM_FMT.format(catalog.liveListings)}
        />
        <SnapshotCell
          label={t('overview.catalog.draft')}
          value={NUM_FMT.format(catalog.draftListings)}
        />
        <SnapshotCell
          label={t('overview.catalog.failed')}
          value={NUM_FMT.format(catalog.failedListings)}
          tone={catalog.failedListings > 0 ? 'rose' : 'slate'}
        />
      </div>
    </div>
  )
}

function SnapshotCell({
  label,
  value,
  tone = 'slate',
}: {
  label: string
  value: string
  tone?: 'slate' | 'rose' | 'amber'
}) {
  const valueClass =
    tone === 'rose'
      ? 'text-rose-700'
      : tone === 'amber'
      ? 'text-amber-700'
      : 'text-slate-900'
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 font-medium">
        {label}
      </div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
    </div>
  )
}
