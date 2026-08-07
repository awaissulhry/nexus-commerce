/**
 * NAF.SB.M — Fleet map. The operator asked for "an extensive version of the
 * current one": full viewport rather than a panel, and an instrument rather
 * than a picture.
 *
 * Boundary against Workflows, stated once and enforced: the MAP is the whole
 * fleet as it is right now; WORKFLOWS are named routines you author. Airflow's
 * cluster view versus one DAG. If the two ever drift toward each other they
 * should merge, not both ship.
 *
 * This page does NOT use FleetPageShell. The shell is title + sub inside a
 * scrolling `.acr` column, which is right for the other nine pages and wrong
 * for a full-viewport instrument: the canvas has to be a flex child with
 * `min-height: 0` so it takes whatever is left, and the window switch and the
 * as-of stamp belong on the header row beside the title. Rather than grow the
 * shared shell an actions slot that lands on ten pages at once, this one page
 * wears its own header — the same call `/fleet/workers` already made.
 *
 * Stylesheet order is the house convention (Workers and Workflows carry the
 * same block): the four DS sheets first, because a DS component without its
 * stylesheet renders unstyled; then the Control Room sheet, which owns the
 * `.acr-*` family this page borrows for its banners and buttons; then the
 * shared fleet primitives; then this page's own rules last, so they win.
 */
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './map.css'
import { MapClient } from './MapClient'

export const dynamic = 'force-dynamic'

export default function Page() {
  return <MapClient />
}
