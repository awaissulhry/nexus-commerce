/**
 * PERF — shared skeleton for the campaign + ad-group detail pages. Mirrors their
 * layout (back link · header · KPI strip · chart · sidebar nav · table) so the
 * route transition paints instantly while the server aggregates metrics.
 */
export function DetailSkeleton() {
  return (
    <div className="px-4 py-4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading…</span>
      <div className="h-4 w-40 rounded bg-slate-100 dark:bg-slate-800 animate-pulse mb-2" />
      <div className="h-7 w-72 rounded bg-slate-200 dark:bg-slate-800 animate-pulse mb-1" />
      <div className="h-4 w-56 rounded bg-slate-100 dark:bg-slate-800/70 animate-pulse mb-4" />
      <div className="flex gap-5 items-start">
        <div className="w-52 flex-shrink-0 space-y-1.5 hidden md:block">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-8 w-full rounded-md bg-slate-100 dark:bg-slate-800 animate-pulse" />
          ))}
        </div>
        <div className="flex-1 min-w-0">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mb-3">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-20 rounded-lg border border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 animate-pulse" />
            ))}
          </div>
          <div className="h-44 rounded-lg border border-default dark:border-slate-800 bg-slate-50 dark:bg-slate-900/40 animate-pulse mb-3" />
          <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
            <div className="h-9 bg-slate-50 dark:bg-slate-900/60 border-b border-default dark:border-slate-800" />
            {Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="flex items-center gap-4 px-3 py-2.5 border-b border-subtle dark:border-slate-800/60">
                <div className="h-4 flex-1 max-w-[20rem] rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                <div className="h-4 w-16 rounded bg-slate-100 dark:bg-slate-800 animate-pulse ml-auto" />
                <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
                <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
