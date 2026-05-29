/**
 * AX.1 — /marketing/campaigns is RETIRED.
 *
 * The thin cross-channel roster competed with the deep Amazon Trading Desk
 * and confused "Campaigns" vs "Advertising". There is now ONE advertising
 * cockpit at /marketing/advertising; this route permanently redirects into
 * it so old links/bookmarks land on the real surface. The cross-channel
 * MarketingCampaignsClient is kept in the tree for reference but no longer
 * routed. (The detail page /marketing/campaigns/[id] still resolves for any
 * deep links.)
 */

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function RetiredCampaignsRedirect() {
  redirect('/marketing/advertising/campaigns')
}
