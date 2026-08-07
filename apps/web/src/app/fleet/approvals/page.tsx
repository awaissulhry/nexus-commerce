/**
 * NAF.AQ — Approvals. The blocking queue: every archetype researched for the
 * page map has one (LangChain's Agent Inbox, UiPath's Action Center, Airflow's
 * Required Actions), and it is the only fleet page that earns a permanent
 * count badge in the rail.
 *
 * Study: docs/2026-08-07-naf-aq-approvals-page.md. AQ.1 was the page existing at
 * all; AQ.2 added the requests from outside the fleet — the only ones that can
 * actually change something — and AQ.3 replaced the borrowed inbox with the
 * card and lists this page owns, so there is exactly ONE card design on it.
 *
 * Styling, and the order matters (copied from the Workers page, which settled
 * it): the four DS stylesheets first, because a DS component without its sheet
 * renders unstyled; then control-room.css for the acr-* family; then
 * fleet-sections.css, because the inbox this page renders is built from its
 * `ap-*` rules; then fleet-pages.css for `.fleet-surface` and its DS light
 * pin; then this page's own rules last. The prefix here is `aq-`, never `ap-`
 * — that belongs to fleet-sections.css and both load on this page.
 */
import { ApprovalsClient } from './ApprovalsClient'
import '@/design-system/styles/tokens.css'
import '@/design-system/styles/primitives.css'
import '@/design-system/styles/components.css'
import '@/design-system/styles/patterns.css'
import '@/app/marketing/ads/rules-automation/control-room/control-room.css'
import '@/app/marketing/ads/rules-automation/fleet/fleet-sections.css'
import '../fleet-pages.css'
import './approvals.css'

export const dynamic = 'force-dynamic'

export default function Page() {
  return (
    <div className="acr">
      <header className="acr-head">
        <div>
          <h1>Approvals</h1>
          <p className="acr-sub">
            Everything the fleet wants to do and cannot do until you say yes.
          </p>
        </div>
      </header>
      <ApprovalsClient />
    </div>
  )
}
