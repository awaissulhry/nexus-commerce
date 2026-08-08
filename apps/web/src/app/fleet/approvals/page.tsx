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
 * S1.a (Part 12) — `FleetPageShell` moved INTO the client component, the same
 * move Activity made at its own S1R and for the same reason: the header's
 * right-hand slot carries the teaching control, and what that control says
 * about the expiry clock is read from the live gate state rather than retyped
 * (retyping it is how the glossary drifted 7× — AQ.0). A server component
 * cannot pass client state, so the client owns the shell and this file owns
 * only the page's identity: the route, the stylesheets, and the `.aq-page`
 * root.
 *
 * `.aq-page` scopes this page's overrides. Deliberately NOT `.acr` or
 * `.acr-fleet`, which siblings also carry: a page-local stylesheet survives a
 * client-side route change, so an override hung on a shared class silently
 * restyles a neighbour's page. Recorded in the locks file by the Workflows
 * stream, which hit it first.
 *
 * Styling, and the order matters (copied from the Workers page, which settled
 * it): the four DS stylesheets first, because a DS component without its sheet
 * renders unstyled — and since S1.b the teaching layer is a DS `Drawer`; then
 * control-room.css for the acr-* family; then fleet-sections.css, because
 * `ApprovalLists` is still built from its `ap-*` rules; then fleet-pages.css
 * for `.fleet-surface` and its DS light pin; then this page's own rules last.
 * The prefix here is `aq-`, never `ap-` — that belongs to fleet-sections.css
 * and both load on this page.
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
    <div className="aq-page">
      <ApprovalsClient />
    </div>
  )
}
