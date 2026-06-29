/**
 * Route-shaped skeleton for /products/[id]/edit.
 *
 * The page is a server component that blocks on several no-store API
 * fetches before it can render, so without this the operator sees the
 * bare global "Loading…" spinner. This mirrors the real edit-page shape
 * (header + action row + tab strip + Master form) so the first frame
 * shows structure and the real content streams in with minimal CLS.
 */

import { Skeleton } from '@/components/ui/Skeleton'

export default function ProductEditLoading() {
  return (
    <div className="space-y-4">
      {/* ── Header: thumbnail + title/sku + action buttons ─────────── */}
      <header className="flex items-start justify-between gap-4 border-b border-default dark:border-slate-800 pb-3">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <Skeleton variant="block" width={56} height={56} className="rounded-md flex-shrink-0" />
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton variant="block" width="50%" height={22} />
            <div className="flex items-center gap-2">
              <Skeleton variant="block" width={150} height={13} />
              <Skeleton variant="pill" width={64} />
              <Skeleton variant="pill" width={48} />
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <Skeleton variant="block" width={100} height={32} className="rounded-md" />
          <Skeleton variant="block" width={90} height={32} className="rounded-md" />
          <Skeleton variant="block" width={120} height={32} className="rounded-md" />
        </div>
      </header>

      {/* ── Tab strip ──────────────────────────────────────────────── */}
      <nav
        className="flex items-center gap-1 border-b border-default dark:border-slate-800 overflow-x-auto"
        aria-hidden
      >
        {Array.from({ length: 9 }).map((_, i) => (
          <div key={i} className="h-9 px-3 flex items-center">
            <Skeleton variant="block" width={64} height={14} />
          </div>
        ))}
      </nav>

      {/* ── Master form body: labelled field grid ──────────────────── */}
      <section
        className="grid grid-cols-1 lg:grid-cols-2 gap-x-6 gap-y-5 max-w-4xl pt-1"
        role="status"
        aria-label="Loading product"
      >
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="space-y-2">
            <Skeleton variant="block" width={90} height={12} />
            <Skeleton variant="block" height={38} className="rounded-md" />
          </div>
        ))}
      </section>
    </div>
  )
}
