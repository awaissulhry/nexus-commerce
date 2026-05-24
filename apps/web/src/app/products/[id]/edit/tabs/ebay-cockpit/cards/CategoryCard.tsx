'use client'

// EC.4.2 — CategoryCard.
//
// Cockpit card showing the currently-picked eBay category for this
// (product, marketplace) plus a "Change" button that opens the
// CategoryPickerModal. Replaces the EC.1 placeholder for "Category &
// Aspects" — the Aspects half lands in EC.5 once the schema endpoint
// is reused here to render the field grid.
//
// Refresh on save: PATCH /api/ebay/cockpit/category writes
// platformAttributes; useRouter().refresh() inside the modal already
// re-fetches the server payload, so the parent EbayCockpit re-mounts
// with fresh composed listing data.

import { useState } from 'react'
import { Tag, ChevronRight, History } from 'lucide-react'
import { Card } from '@/components/ui/Card'
import { Badge } from '@/components/ui/Badge'
import CategoryPickerModal from './CategoryPickerModal'

interface Props {
  productId: string
  marketplace: string
  marketName: string
  siblingMarketCodes: string[]
  /** Listing text used to seed the AI-suggest mode. */
  seedTitle: string
  seedDescription: string
  current: { id: string | null; name: string | null; path: string | null }
}

export default function CategoryCard({
  productId,
  marketplace,
  marketName,
  siblingMarketCodes,
  seedTitle,
  seedDescription,
  current,
}: Props) {
  const [open, setOpen] = useState(false)

  return (
    <Card noPadding>
      <div className="px-4 py-2.5 border-b border-slate-100 dark:border-slate-800 flex items-center gap-2">
        <Tag className="w-4 h-4 text-blue-500" />
        <div className="text-md font-medium text-slate-900 dark:text-slate-100">
          Category
        </div>
        <Badge variant="info">EC.4</Badge>
        <span className="text-xs text-slate-500 dark:text-slate-400 ml-auto">
          Aspects land in EC.5
        </span>
      </div>

      <div className="p-4 space-y-2">
        {current.id ? (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-sm font-medium text-slate-900 dark:text-slate-100 truncate">
                {current.name ?? `Category ${current.id}`}
              </div>
              {current.path && (
                <div className="text-[10.5px] font-mono text-slate-500 dark:text-slate-400 truncate mt-0.5">
                  {current.path}
                </div>
              )}
              <div className="text-[10.5px] text-slate-400 mt-1 flex items-center gap-2 flex-wrap">
                <span>id: {current.id}</span>
                <span>·</span>
                <span>{marketName}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium rounded border border-slate-200 dark:border-slate-700 text-slate-700 dark:text-slate-300 hover:bg-slate-50 dark:hover:bg-slate-800 whitespace-nowrap"
            >
              Change <ChevronRight className="w-3 h-3" />
            </button>
          </div>
        ) : (
          <div className="flex items-center justify-between gap-3">
            <div className="text-xs text-slate-500 dark:text-slate-400">
              No category picked yet — eBay won&apos;t accept the listing
              until one is set.
            </div>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="px-2.5 py-1 text-xs font-medium rounded bg-blue-600 hover:bg-blue-700 text-white whitespace-nowrap"
            >
              Pick category
            </button>
          </div>
        )}
        <div className="text-[10.5px] text-slate-400 italic pt-1 border-t border-slate-100 dark:border-slate-800 flex items-center gap-1">
          <History className="w-3 h-3" />
          Re-categorising preserves your aspect work — the new schema is
          reconciled at render time, not destructively rewritten.
        </div>
      </div>

      {open && (
        <CategoryPickerModal
          productId={productId}
          marketplace={marketplace}
          marketName={marketName}
          siblingMarketCodes={siblingMarketCodes}
          seedTitle={seedTitle}
          seedDescription={seedDescription}
          current={current}
          onClose={() => setOpen(false)}
          onApplied={() => setOpen(false)}
        />
      )}
    </Card>
  )
}
