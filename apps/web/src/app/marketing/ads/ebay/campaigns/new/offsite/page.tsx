/**
 * ER2 — Offsite explainer (SPEC §6.4): the write layer does not create
 * Offsite campaigns yet (verified: CreateCampaignInput carries no OFF_SITE
 * channel path) — an honest explainer instead of a dead flow.
 */
import Link from 'next/link'
import '../../../ebay.css'

export default function Page() {
  return (
    <div className="h10-cd-card pad eb-root" style={{ maxWidth: 640, margin: '40px auto' }}>
      <h2 className="eb-explainer-h">Promoted Offsite</h2>
      <p className="eb-explainer-p">
        Offsite campaigns put your listings on external networks (Google, social) with eBay managing placement
        and CPC — the daily budget is the only lever. Creating them from Nexus lands in a later phase; for now
        they are created in Seller Hub, and once live, this console tracks their spend, reports and lifecycle
        like any other campaign (see the existing &quot;Jacket Shopping Ad Google&quot; campaign).
      </p>
      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <a className="h10-am-btn primary" href="https://www.ebay.it/sh/mkt/marketing/campaigns" target="_blank" rel="noreferrer">Open Seller Hub</a>
        <Link className="h10-am-btn" href="/marketing/ads/ebay/campaigns/new">Back to campaign types</Link>
      </div>
    </div>
  )
}
