'use client'

// UC.2.2 — Shared Images summary card.
//
// The cockpit Images card is a SUMMARY (primary thumb + slot count +
// "open grid" action), not the full editor — Amazon's image grid and
// eBay's ImagesCard remain the deep editors. This presentational summary
// is channel-config-driven via props (label/openLabel) so both cockpits
// show the same compact card and hand off to their own editor on click.

import { Card } from '@/components/ui/Card'

export interface ImagesSummaryCardProps {
  title: string
  primaryImageUrl?: string | null
  galleryCount?: number
  /** Total expected slots, e.g. 9 for Amazon → renders "7 / 9". When
   *  omitted, just the filled count shows. */
  totalSlots?: number | null
  onOpen?: () => void
  openLabel?: string
  jumpTargetId?: string
  /** Localised "main set" / "no primary" hints. */
  primarySetLabel?: string
  noPrimaryLabel?: string
}

export default function ImagesSummaryCard({
  title,
  primaryImageUrl,
  galleryCount = 0,
  totalSlots,
  onOpen,
  openLabel = 'Open',
  jumpTargetId = 'images',
  primarySetLabel = 'main set',
  noPrimaryLabel = 'no primary image',
}: ImagesSummaryCardProps) {
  const hasPrimary = Boolean(primaryImageUrl)
  const filled = galleryCount + (hasPrimary ? 1 : 0)
  const countText =
    totalSlots != null ? `${filled} / ${totalSlots}` : `${filled}`

  return (
    <div data-jump-target={jumpTargetId} className="min-w-0 scroll-mt-32">
      <Card
        title={title}
        action={
          onOpen && (
            <button
              type="button"
              onClick={onOpen}
              className="text-xs font-medium text-sky-600 hover:text-sky-700 dark:text-sky-400"
            >
              {openLabel} ▸
            </button>
          )
        }
      >
        <div className="flex items-center gap-3">
          <div className="h-14 w-14 shrink-0 overflow-hidden rounded border border-slate-200 bg-slate-50 dark:border-slate-700 dark:bg-slate-800">
            {hasPrimary ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={primaryImageUrl as string}
                alt=""
                className="h-full w-full object-cover"
              />
            ) : (
              <div className="flex h-full w-full items-center justify-center text-slate-300">
                ▢
              </div>
            )}
          </div>
          <div className="min-w-0 text-sm">
            <div className="font-medium text-slate-800 dark:text-slate-200">{countText}</div>
            <div className="truncate text-xs text-slate-500 dark:text-slate-400">
              {hasPrimary ? `✓ ${primarySetLabel}` : noPrimaryLabel}
            </div>
          </div>
        </div>
      </Card>
    </div>
  )
}
