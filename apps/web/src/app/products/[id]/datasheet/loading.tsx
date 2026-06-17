/**
 * EH.2 — Skeleton that mirrors the real datasheet layout
 * (header + health pulse + tab strip + tab body) so the operator
 * sees structure within the first frame instead of a blank tab while
 * the server-side Prisma queries run.
 *
 * Layout intentionally matches `page.tsx`'s shape line-for-line to
 * minimize CLS when the real content streams in.
 */

import { Skeleton } from '@/components/ui/Skeleton'

export default function DatasheetLoading() {
  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="flex items-start justify-between gap-4 border-b border-default dark:border-slate-800 pb-3">
        <div className="min-w-0 flex-1 space-y-2">
          <Skeleton variant="block" width={120} height={12} />
          <Skeleton variant="block" width="60%" height={24} />
          <div className="flex items-center gap-2">
            <Skeleton variant="block" width={140} height={14} />
            <Skeleton variant="pill" width={60} />
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Skeleton variant="block" width={120} height={32} className="rounded-md" />
          <Skeleton variant="block" width={90} height={32} className="rounded-md" />
          <Skeleton variant="block" width={80} height={32} className="rounded-md" />
        </div>
      </header>

      {/* ── Health pulse strip ─────────────────────────────────────── */}
      <Skeleton variant="block" height={44} className="rounded-md" />

      {/* ── Tab nav ────────────────────────────────────────────────── */}
      <nav
        className="flex items-center gap-1 border-b border-default dark:border-slate-800 overflow-x-auto"
        aria-hidden
      >
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-9 px-3 flex items-center">
            <Skeleton variant="block" width={70} height={14} />
          </div>
        ))}
      </nav>

      {/* ── Tab body ───────────────────────────────────────────────── */}
      <section className="min-h-[40vh] grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
        <Skeleton variant="card" />
      </section>
    </div>
  )
}
