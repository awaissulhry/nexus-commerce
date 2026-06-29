/**
 * EH.2 — Skeleton for the Amazon Flat File editor.
 *
 * Mimics the full-screen workbench layout (channel strip + two
 * toolbar bars + grid body) so the operator sees the workbench
 * frame immediately instead of a blank tab. The SP-API schema fetch
 * can take 1–2 s on a cold cache; without this skeleton the tab is
 * blank for that entire window.
 */

import { Skeleton, SkeletonRow } from '@/components/ui/Skeleton'

export default function FlatFileLoading() {
  return (
    <div className="min-h-screen bg-slate-50 dark:bg-slate-950 flex flex-col">
      {/* ── Sticky header ──────────────────────────────────────────── */}
      <header className="bg-white dark:bg-slate-900 border-b border-slate-200 dark:border-slate-800">
        {/* Channel + Market strip */}
        <div className="px-3 h-9 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">
          <Skeleton variant="pill" width={90} />
          <Skeleton variant="pill" width={60} />
          <Skeleton variant="pill" width={140} />
        </div>
        {/* Bar 1 — App chrome + menus + primary actions */}
        <div className="px-3 h-10 flex items-center gap-2 border-b border-slate-100 dark:border-slate-800/60">
          <Skeleton variant="block" width={24} height={20} className="rounded" />
          <div className="flex items-center gap-1">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} variant="block" width={56} height={20} className="rounded" />
            ))}
          </div>
          <div className="flex-1" />
          <Skeleton variant="block" width={120} height={28} className="rounded-md" />
          <Skeleton variant="block" width={90} height={28} className="rounded-md" />
        </div>
        {/* Bar 2 — Toolbar */}
        <div className="px-3 h-10 flex items-center gap-3">
          <div className="flex items-center gap-1">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} variant="block" width={28} height={22} className="rounded" />
            ))}
          </div>
          <div className="w-px h-5 bg-slate-200 dark:bg-slate-700" />
          <Skeleton variant="block" width={220} height={26} className="rounded-md" />
          <div className="flex-1" />
          <Skeleton variant="block" width={140} height={22} className="rounded" />
        </div>
      </header>

      {/* ── Grid body ──────────────────────────────────────────────── */}
      <div className="flex-1 bg-white dark:bg-slate-900 m-3 rounded-md border border-slate-200 dark:border-slate-800 overflow-hidden">
        {/* Column header row */}
        <div className="border-b border-slate-200 dark:border-slate-800 px-3 py-2">
          <SkeletonRow columns={16} />
        </div>
        {/* Data rows */}
        <div className="px-3">
          {Array.from({ length: 14 }).map((_, i) => (
            <SkeletonRow key={i} columns={8} />
          ))}
        </div>
      </div>
    </div>
  )
}
