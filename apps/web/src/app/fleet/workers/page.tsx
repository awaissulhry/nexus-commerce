/**
 * NAF.SB.W — the worker registry page. First of the ten in
 * docs/2026-08-07-naf-sb-fleet-pages.md, built first because every control
 * plane researched for that document hangs everything else off one row per
 * agent. Its own study is docs/2026-08-07-naf-sbw-workers-page.md.
 *
 * Styling, and the order matters:
 *
 * 1. The four DS stylesheets. A DS component without its stylesheet renders
 *    unstyled — the Sync Control dropdown bug — so a page using DataGrid must
 *    import all four itself.
 * 2. control-room.css for the acr-* family the rest of the fleet uses.
 * 3. fleet-pages.css, which carries `.fleet-surface` and, since W.1, the DS
 *    light pin that lets a DS component render here at all. The pin is the
 *    `.productsNextLight` recipe, NOT `.h10-shell`'s — see the comment there.
 * 4. workers.css, this page's own rules. fleet-pages.css stays frozen to
 *    shared primitives so the parallel sessions have nothing to collide on.
 */
import { WorkersClient } from './WorkersClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './workers.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Workers</h1>
          <p className="acr-sub">
            Every AI worker in the fleet, what it is allowed to do, and how it has been doing it.
          </p>
        </div>
      </header>
      <WorkersClient />
    </div>
  )
}
