/**
 * NAF.AQ — Approvals. The blocking queue, and the only fleet page that earns a permanent count badge in the rail.
 *
 * Approvals grid (docs/approvals-grid/PLAN.md, 2026-10-05): ONE grid for every request — from Claude, the fleet
 * agents or a rule — with a health strip, bulk approve of one kind, a side drawer and "Automate this kind…". The
 * client (`grid/ApprovalsGrid.tsx`) owns the `FleetPageShell`, because the header's right-hand slot carries the "How
 * it works" drawer (S1.a); this file owns the page's identity: the route, the stylesheets and the `.aq-page` root.
 *
 * `.aq-page` scopes this page's overrides (and pins `--nds-danger-strong` light, approvals.css). Deliberately NOT
 * `.acr` or `.acr-fleet`, which siblings also carry: a page-local stylesheet survives a client-side route change, so
 * an override hung on a shared class silently restyles a neighbour's page.
 *
 * Styling, in order: the four DS stylesheets (a DS component without its sheet renders unstyled); control-room.css for
 * the shell's acr-* header; fleet-pages.css for `.fleet-surface` and its DS light pin (and `.fleet-portal` for the
 * drawer and modals, which portal out of it); approvals.css for the header and the "How it works" drawer; then the
 * grid's own layout. `fleet-sections.css` (the old card lists' `ap-*` rules) is no longer loaded here: nothing on this
 * page uses it.
 */
import { ApprovalsGrid } from './grid/ApprovalsGrid'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '../fleet-pages.css'
import './approvals.css'
import './grid/approvalsGrid.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="aq-page">
      <ApprovalsGrid />
    </div>
  )
}
