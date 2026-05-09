'use client'

import { Card } from '@/components/ui/Card'
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
    <Card title={t('overview.catalog.heading')}>
      <div className="grid grid-cols-2 gap-3 text-base">
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
    </Card>
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
      ? 'text-rose-700 dark:text-rose-400'
      : tone === 'amber'
      ? 'text-amber-700 dark:text-amber-400'
      : 'text-slate-900 dark:text-slate-100'
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500 dark:text-slate-400 font-medium">
        {label}
      </div>
      <div className={cn('mt-0.5 text-xl font-semibold tabular-nums', valueClass)}>
        {value}
      </div>
    </div>
  )
}
