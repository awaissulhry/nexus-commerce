/**
 * W2-A (CC-2, CC-16, CC-17) — what a campaign launch answers, and when a builder must stop and show it.
 *
 * Every launch route answers `launch` (apps/api/src/services/advertising/launch-outcome.ts): each campaign asked for is
 * live, partly made (what failed, and why) or not made (why), and `ok` is true only when every one is live. Beside it,
 * `verification` is Amazon's read-back of what the launch left (or null when it could not run).
 *
 * A builder navigates away only when both say everything is right; otherwise it stays and shows the receipt. A read-back
 * that is missing is never a pass (SPW used to treat it as one).
 */

export type LaunchStep =
  | 'campaign' | 'ad_group' | 'product_ad' | 'keyword' | 'product_target' | 'auto_targeting'
  | 'negative_keyword' | 'negative_product' | 'placement'

export interface LaunchStepFailure { step: LaunchStep; item: string; reason: string }

export type LaunchCampaignStatus = 'live' | 'partial' | 'failed'

export interface LaunchMade {
  adGroups: number; productAds: number; keywords: number; productTargets: number; autoTargeting: number
  negativeKeywords: number; negativeProducts: number; placement: boolean | null
}

export interface LaunchCampaignResult {
  name: string
  campaignId: string | null
  externalCampaignId: string | null
  status: LaunchCampaignStatus
  reason: string | null
  made: LaunchMade
  failed: LaunchStepFailure[]
}

export interface LaunchResult {
  ok: boolean
  asked: number
  live: number
  partial: number
  failed: number
  campaigns: LaunchCampaignResult[]
}

/** The read-back's shape, as far as a builder needs it (the receipt component holds the full one). */
export interface ReadBack { ok: boolean }

/** What a launch route answers, as far as a builder needs it. */
export interface LaunchAnswer {
  ok?: boolean
  error?: string
  launch?: LaunchResult | null
  verification?: ReadBack | null
  created?: Array<{ campaignId?: string | null; externalCampaignId?: string | null }>
  campaignId?: string | null
  externalCampaignId?: string | null
}

/** Stop and show the receipt? Yes when anything asked for is not live, or the read-back failed or did not run. */
export function needsReceipt(a: LaunchAnswer): boolean {
  if (a.launch && !a.launch.ok) return true
  if (!a.verification) return true
  return a.verification.ok !== true
}

/** The campaigns a Re-check reads back: the ones Amazon holds (a campaign not on Amazon has nothing to read). */
export function recheckIds(a: LaunchAnswer): string[] {
  const fromLaunch = (a.launch?.campaigns ?? []).filter((c) => c.campaignId && c.externalCampaignId).map((c) => c.campaignId as string)
  if (fromLaunch.length || a.launch) return fromLaunch
  const fromCreated = (a.created ?? []).filter((c) => c.campaignId && c.externalCampaignId !== null).map((c) => c.campaignId as string)
  if (fromCreated.length) return fromCreated
  return a.campaignId ? [a.campaignId] : []
}

export const STATUS_LABEL: Record<LaunchCampaignStatus, string> = { live: 'Live', partial: 'Partly made', failed: 'Not made' }

export const STEP_LABEL: Record<LaunchStep, string> = {
  campaign: 'Campaign', ad_group: 'Ad group', product_ad: 'Product ad', keyword: 'Keyword', product_target: 'Product target',
  auto_targeting: 'Auto group', negative_keyword: 'Negative keyword', negative_product: 'Negative product', placement: 'Placements',
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

/** "1 ad group · 2 product ads · 4 auto groups · placements set" — what reached Amazon. */
export function madeSummary(m: LaunchMade): string {
  const parts = [
    m.adGroups ? plural(m.adGroups, 'ad group') : '',
    m.productAds ? plural(m.productAds, 'product ad') : '',
    m.keywords ? plural(m.keywords, 'keyword') : '',
    m.productTargets ? plural(m.productTargets, 'product target') : '',
    m.autoTargeting ? plural(m.autoTargeting, 'auto group') : '',
    m.negativeKeywords ? plural(m.negativeKeywords, 'negative keyword') : '',
    m.negativeProducts ? plural(m.negativeProducts, 'negative product') : '',
    m.placement === true ? 'placements set' : '',
  ].filter(Boolean)
  return parts.length ? parts.join(' · ') : 'nothing under it'
}

/** The receipt's headline for the launch half: "1 of 3 campaigns is live on Amazon · 1 partly made · 1 not made". */
export function launchHeadline(l: LaunchResult): string {
  const lead = `${l.live} of ${plural(l.asked, 'campaign')} ${l.live === 1 ? 'is' : 'are'} live on Amazon`
  return [lead, l.partial ? `${l.partial} partly made` : '', l.failed ? `${l.failed} not made` : ''].filter(Boolean).join(' · ')
}
