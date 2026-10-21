/**
 * Meta ads — the ONE table of what kind a Meta object id is (step 6 review fix A1 / B F3; step 17's write check and every
 * read's ownership check use it). Meta numbers campaigns, ad sets, ads, creatives, audiences, Pages and much more the same
 * way, so an id alone never says its kind: Nexus asks `account_id` and TWO fields only that kind has together, both always
 * set on it (step 17 re-review: one is not enough — a ReachFrequencyPrediction has account_id, objective, optimization_goal,
 * buying_type and campaign_id). A read asking them of another kind is answered with an error ("nonexisting field") or without one of them:
 * refused (the read side: marketing/meta-ads/live.ts objectInAccount; the write side: gateway/gateway.ts).
 *
 * Checked 2026-10-21 on the v26 field tables (marketing-api/reference ad-campaign-group.md, ad-campaign.md, adgroup.md,
 * ad-creative.md) and Meta's Python Business SDK (facebook_business/adobjects campaign.py, adset.py, ad.py, adcreative.py,
 * customaudience.py, adplacepageset.py, reachfrequencyprediction.py, savedaudience.py, page.py, pagepost.py, iguser.py,
 * igmedia.py, adimage.py, advideo.py, productcatalog.py, productset.py, adspixel.py, business.py, user.py, photo.py):
 *   campaign        objective + effective_status       (an ad set or ad has no objective; a reach-and-frequency
 *                                                       prediction no effective_status)
 *   adset           optimization_goal + billing_event  (a campaign or ad has neither; a prediction no billing_event)
 *   ad              adset_id + creative                (a campaign, ad set, creative or prediction has neither)
 *   creative        object_type + status               (no other node above has object_type)
 *   customaudience  subtype + time_created             (a saved audience has time_created but no subtype)
 *   placepageset    parent_page + pages_count          (only an ad place page set has them)
 *   reportrun       async_status + async_percent_completion  (step 7: an AdReportRun, SDK adreportrun.py; Meta's
 *                                                       insights best-practices page shows both on every run)
 */
export type MetaObjectKind = 'campaign' | 'adset' | 'ad' | 'creative' | 'customaudience' | 'placepageset' | 'reportrun'

export const META_KIND_FIELDS: Readonly<Record<MetaObjectKind, readonly [string, string]>> = {
  campaign: ['objective', 'effective_status'],
  adset: ['optimization_goal', 'billing_event'],
  ad: ['adset_id', 'creative'],
  creative: ['object_type', 'status'],
  customaudience: ['subtype', 'time_created'],
  placepageset: ['parent_page', 'pages_count'],
  reportrun: ['async_status', 'async_percent_completion'],
}

export const META_KIND_WORDS: Readonly<Record<MetaObjectKind, string>> = {
  campaign: 'campaign', adset: 'ad set', ad: 'ad', creative: 'creative', customaudience: 'custom audience', placepageset: 'place page set',
  reportrun: 'report run',
}

/** "a campaign", "an ad set". */
export const withArticle = (word: string) => `${/^[aeiou]/.test(word) ? 'an' : 'a'} ${word}`
