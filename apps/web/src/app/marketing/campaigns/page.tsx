/**
 * AX.1 — /marketing/campaigns is RETIRED.
 *
 * The thin cross-channel roster competed with the deep Amazon cockpit and
 * confused "Campaigns" vs "Advertising". There is now ONE advertising console
 * at /marketing/ads; this route permanently redirects into it so old links and
 * bookmarks land on the real surface. (ACR.6 repointed this: it used to hop to
 * /marketing/advertising/campaigns, which is itself now a redirect — chaining
 * one redirect into another costs a round trip and hides where you end up.) The cross-channel
 * MarketingCampaignsClient is kept in the tree for reference but no longer
 * routed. (The detail page /marketing/campaigns/[id] still resolves for any
 * deep links.)
 */

import { redirect } from 'next/navigation'

export const dynamic = 'force-dynamic'

export default function RetiredCampaignsRedirect() {
  redirect('/marketing/ads/campaigns')
}
