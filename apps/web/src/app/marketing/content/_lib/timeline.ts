// MC.2.6 — timeline grouping helpers.
//
// Buckets the library feed into Today / Yesterday / This week / This
// month / Older sections. Bucket selection is "createdAt relative to
// now" so the partition shifts with the page-load time — the
// operator browsing at midnight sees the same buckets they will at
// 09:00 the next morning, just shifted.
//
// Buckets are listed in display order; empty buckets are skipped at
// render time, not here, so the data is stable for testing.

import type { LibraryItem } from './types'

export type TimelineBucket =
  | 'today'
  | 'yesterday'
  | 'this_week'
  | 'this_month'
  | 'older'

export interface TimelineGroup {
  bucket: TimelineBucket
  items: LibraryItem[]
}

const ORDER: TimelineBucket[] = [
  'today',
  'yesterday',
  'this_week',
  'this_month',
  'older',
]

function startOfDay(date: Date): number {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

function bucketFor(createdAt: string, now = Date.now()): TimelineBucket {
  const created = new Date(createdAt).getTime()
  const todayStart = startOfDay(new Date(now))
  const day = 24 * 60 * 60 * 1000
  if (created >= todayStart) return 'today'
  if (created >= todayStart - day) return 'yesterday'
  if (created >= todayStart - 7 * day) return 'this_week'
  if (created >= todayStart - 30 * day) return 'this_month'
  return 'older'
}

export function groupByTimeline(
  items: LibraryItem[],
  now = Date.now(),
): TimelineGroup[] {
  const map = new Map<TimelineBucket, LibraryItem[]>()
  for (const b of ORDER) map.set(b, [])
  for (const item of items) {
    const b = bucketFor(item.createdAt, now)
    map.get(b)!.push(item)
  }
  return ORDER.map((bucket) => ({
    bucket,
    items: map.get(bucket) ?? [],
  })).filter((g) => g.items.length > 0)
}

// MC.2.6 — flatten timeline groups into a virtualizer-friendly row
// stream. Each group becomes one header row plus N grid rows of
// `cols` items each. Returning a discriminated union keeps the
// render branch in AssetLibrary readable.

export type TimelineRow =
  | { kind: 'header'; bucket: TimelineBucket; count: number }
  | { kind: 'tiles'; items: LibraryItem[] }

export function flattenTimelineRows(
  groups: TimelineGroup[],
  cols: number,
): TimelineRow[] {
  const rows: TimelineRow[] = []
  for (const g of groups) {
    rows.push({ kind: 'header', bucket: g.bucket, count: g.items.length })
    for (let i = 0; i < g.items.length; i += cols) {
      rows.push({ kind: 'tiles', items: g.items.slice(i, i + cols) })
    }
  }
  return rows
}
