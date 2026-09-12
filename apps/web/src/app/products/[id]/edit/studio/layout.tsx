/**
 * PES.1 — the Product Edit Studio's shell: the `/products/next` family, exactly.
 *
 *   AppShell (`NO_RAIL_PATTERNS`) renders the global `AppTopBar` and suppresses the app rail
 *   → this layout renders `.h10-shell` + the rail
 *     → the studio frame fills the remainder.
 *
 * `AppNavRail` is rendered directly rather than through `/products/next`'s one-line `ProductsRail`
 * wrapper: that file returns `<AppNavRail />` and nothing else, so this IS the same component, and
 * importing it from another route's `_shell` folder would make one page's private directory a
 * dependency of another's.
 *
 * The responsive semantic theme opts this workspace into the user's light/dark preference.
 */

// The rail/shell rules. Already loaded app-wide by AppShell; imported here too, as the benchmark
// layout does, so this route's chrome does not depend on another component's import list.
import '@/app/_shared/shared-shell.css'

import type { ReactNode } from 'react'

import { AppNavRail } from '@/app/_shared/AppNavRail'

export default function ProductStudioLayout({ children }: { children: ReactNode }) {
  return (
    <div className="h10-shell nds-theme-responsive">
      <AppNavRail />
      {children}
    </div>
  )
}
