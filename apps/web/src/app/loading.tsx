import { Loader2 } from 'lucide-react'

/**
 * Root loading boundary. Cascades to every route below unless a more
 * specific loading.tsx is added at a deeper segment. Without this,
 * App Router shows nothing during the server-render wait — the user
 * sees a blank page until the response lands.
 *
 * U.66 — added after the QA audit found 0 loading.tsx files across
 * 119 routes.
 */
export default function GlobalLoading() {
  return (
    <div
      role="status"
      aria-live="polite"
      className="min-h-[40vh] flex items-center justify-center text-slate-500 dark:text-slate-400"
    >
      <Loader2 className="w-4 h-4 animate-spin mr-2" />
      <span className="text-base">Loading…</span>
    </div>
  )
}
