/**
 * CE.1 — Mapping Canvas.
 *
 * The core of the Feed Transform Engine: operators define IF/THEN rules
 * that compile master Product records into channel-correct attribute
 * packages for Amazon, eBay, and Shopify.
 *
 * Each rule maps a condition (e.g. brand == 'Xavia') to a field action
 * (e.g. APPEND ' - Premium Motorcycle Gear' to title). Rules are
 * evaluated in priority order; first match per field wins.
 *
 * Data loads client-side in MappingCanvasLoader — the cross-site API
 * session cookie means server fetches can never authenticate. The page
 * stays a server component so router.refresh() (seed-schemas + Refresh)
 * mints a new refreshToken and re-triggers the loader.
 */

import { Layers } from 'lucide-react'
import { MappingCanvasLoader } from './MappingCanvasLoader'

export const dynamic = 'force-dynamic'

export default function MappingCanvasPage() {
  return (
    <div className="px-4 py-4 max-w-6xl">
      <div className="flex items-start gap-3 mb-5">
        <Layers className="h-6 w-6 text-violet-600 dark:text-violet-400 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h1 className="text-xl font-semibold text-slate-900 dark:text-slate-100">
            Mapping Canvas
          </h1>
          <p className="text-sm text-slate-500 dark:text-slate-400 mt-0.5">
            IF/THEN field rules that transform your master catalog into channel-ready attribute
            packages for Amazon, eBay, and Shopify. Rules run at listing generation and feed
            export time — first match per field wins.
          </p>
        </div>
      </div>

      <MappingCanvasLoader refreshToken={Date.now()} />
    </div>
  )
}
