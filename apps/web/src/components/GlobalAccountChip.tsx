'use client'

/**
 * MAP.1 — the global top-right account chip.
 *
 * Mounted in the root layout's `overlays` slot, beside `<NotificationsBell />`,
 * because that floating pair *is* the desktop top-right chrome. `AppShell`'s
 * `topBar` slot renders `MobileTopBar`, which is `md:hidden`, and
 * `components/layout/TopBar.tsx` — the file that looks like the app's top bar
 * and carries hard-coded "Amazon IT" / "eBay" chips — is imported by nothing.
 * Anything placed there would never render.
 *
 * Positioning matches the bell (`fixed top-14 md:top-3 right-3 z-40`), offset
 * left by the bell's 32px width plus a gutter so the two sit side by side.
 * Desktop only: on a phone the bell already owns that corner.
 *
 * Standalone routes (`/marketing/ads`, `/products/next`, `/shared`, auth) render
 * outside this chrome by design, so they do not get the chip. Both flat files
 * are NOT standalone, so they do — which is what MAP.1 set out to deliver
 * without editing a flat-file file.
 */

import { AccountSwitcher } from '@/design-system/components'
import { getBackendUrl } from '@/lib/backend-url'

export default function GlobalAccountChip() {
  return (
    <div className="hidden md:block fixed top-3 right-[52px] z-40" data-print-hide>
      <AccountSwitcher endpoint={`${getBackendUrl()}/api/accounts`} />
    </div>
  )
}
