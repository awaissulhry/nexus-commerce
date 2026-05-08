'use client'

/**
 * U.43 — client-only wrapper for BulkOperationsClient.
 *
 * The bulk-ops grid is a complex client-heavy spreadsheet. Two
 * earlier U.41 / U.42 fixes addressed specific lazy-init reads of
 * localStorage that produced server/client divergence + React Error
 * #418 hydration mismatch. Symptom of the mismatch was page-wide
 * click delegation breaking — sidebar Links, in-page Job History
 * Link, every clickable thing dead.
 *
 * Even after those fixes the user reported the error persisting.
 * Rather than chase the next mismatch source, mount the entire
 * client component AFTER hydration completes. Server renders nothing
 * (the placeholder); client renders the placeholder; hydration
 * compares them — they match because both are empty. Then the
 * useEffect fires, swap to the real component. No mismatch is
 * possible because the swap happens after hydration.
 *
 * Tradeoff: one extra paint frame before the spreadsheet appears.
 * On a heavy client component like this it's already ~200ms before
 * the grid is interactive (data fetch + virtualization compute), so
 * the extra ~16ms paint is invisible.
 */

import { useEffect, useState } from 'react'
import BulkOperationsClient from './BulkOperationsClient'

export default function BulkOperationsClientWrapper() {
  const [mounted, setMounted] = useState(false)
  useEffect(() => {
    setMounted(true)
  }, [])
  if (!mounted) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="text-md text-slate-500 dark:text-slate-400 py-12 text-center"
      >
        Loading bulk operations…
      </div>
    )
  }
  return <BulkOperationsClient />
}
