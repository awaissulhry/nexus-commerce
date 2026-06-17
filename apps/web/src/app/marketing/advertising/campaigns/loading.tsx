/**
 * PERF — route-level skeleton for the campaigns list. Renders instantly on
 * navigation (the page shell + a table skeleton) while the server fetches the
 * roster + v1 metrics, so the transition feels immediate instead of showing the
 * generic centered spinner.
 */
export default function CampaignsLoading() {
  return (
    <div className="px-4 py-4" role="status" aria-live="polite" aria-busy="true">
      <span className="sr-only">Loading campaigns…</span>
      <div className="h-9 w-full max-w-md rounded bg-slate-100 dark:bg-slate-800 animate-pulse mb-3" />
      <div className="mb-4 space-y-1">
        <div className="h-6 w-40 rounded bg-slate-200 dark:bg-slate-800 animate-pulse" />
        <div className="h-4 w-96 rounded bg-slate-100 dark:bg-slate-800/70 animate-pulse" />
      </div>
      <div className="rounded-lg border border-default dark:border-slate-800 overflow-hidden">
        <div className="h-9 bg-slate-50 dark:bg-slate-900/60 border-b border-default dark:border-slate-800" />
        {Array.from({ length: 12 }).map((_, i) => (
          <div key={i} className="flex items-center gap-4 px-3 py-2.5 border-b border-subtle dark:border-slate-800/60">
            <div className="h-4 flex-1 max-w-[18rem] rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-16 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse ml-auto" />
            <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
            <div className="h-4 w-14 rounded bg-slate-100 dark:bg-slate-800 animate-pulse" />
          </div>
        ))}
      </div>
    </div>
  )
}
