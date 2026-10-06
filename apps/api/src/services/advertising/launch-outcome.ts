/**
 * W2-A (CC-2, CC-3, CC-17) — what a launch made, campaign by campaign. Every campaign launch answers with this one shape
 * (`launch` on the SP Super Wizard / Quick / Guided route, the Single launch and the AI Goal materialize).
 *
 * Before this a campaign whose create threw, or whose ad group failed after the campaign was already live on Amazon,
 * was dropped from the answer; a refused product ad left nothing behind; negatives and placements were only logged; and
 * the launch answered `ok: true` with 0 of N campaigns made. Now every campaign asked for is listed:
 *
 *   live     on Amazon (it has Amazon's id) and every part asked for reached Amazon
 *   partial  on Amazon, but at least one part did not reach it — each is listed with Amazon's or Nexus's reason
 *   failed   not on Amazon — the create threw, Amazon refused it, or the write gate / connection refused it (`reason`)
 *
 * `ok` is true only when every campaign asked for is live. Sandbox ids count as on Amazon (sandbox has no Amazon).
 *
 * Shape (documented in the PR for the other build lanes):
 *   LaunchResult         { ok, asked, live, partial, failed, campaigns: LaunchCampaignResult[] }
 *   LaunchCampaignResult { name, campaignId (Nexus id, null when nothing was written), externalCampaignId (Amazon id,
 *                          null = not on Amazon), status, reason (failed: why; partial: a one-line summary), made (counts
 *                          of what reached Amazon), failed: Array<{ step, item, reason }> }
 *
 * Pure: no I/O. The launch wrappers record what each create primitive answered; `summariseLaunch` totals it.
 */

export type LaunchStep =
  | 'campaign' | 'ad_group' | 'product_ad' | 'keyword' | 'product_target' | 'auto_targeting'
  | 'negative_keyword' | 'negative_product' | 'placement'

export interface LaunchStepFailure {
  step: LaunchStep
  /** What it was: the keyword, the SKU, "Loose match", "Top of search 50%"… */
  item: string
  /** Amazon's own words, or the write gate's / Nexus's sentence. Never empty. */
  reason: string
}

export type LaunchCampaignStatus = 'live' | 'partial' | 'failed'

/** What reached Amazon (sandbox included), per kind. `placement` is null when no placement was asked for. */
export interface LaunchMade {
  adGroups: number
  productAds: number
  keywords: number
  productTargets: number
  autoTargeting: number
  negativeKeywords: number
  negativeProducts: number
  placement: boolean | null
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

/** The sentence for a campaign Amazon has no id for when the create gave no reason of its own. */
export const CAMPAIGN_NOT_ON_AMAZON = 'Amazon did not return an id for this campaign, so it is not on Amazon.'

const STEP_WORD: Record<LaunchStep, string> = {
  campaign: 'campaign', ad_group: 'ad group', product_ad: 'product ad', keyword: 'keyword', product_target: 'product target',
  auto_targeting: 'auto group', negative_keyword: 'negative keyword', negative_product: 'negative product',
  placement: 'placement',
}

const errorText = (e: unknown): string => {
  const m = e instanceof Error ? e.message : String(e ?? '')
  return m.trim() || 'it failed without a message'
}

/** Why a create primitive did not reach Amazon, as the primitives answer it (createAdGroupLocal / createProductAdLocal /
 * createTargetLocal `notSent`, createKeywordLocal `denied` / `pushError`, the negative helpers' `refusal` / `error`). */
type NotSentLike = { reason: string } | null | undefined

/** One campaign's record while its launch runs. */
export class CampaignLaunch {
  campaignId: string | null = null
  externalCampaignId: string | null = null
  private campaignReason: string | null = null
  private adGroupOnAmazon = false
  readonly made: LaunchMade = { adGroups: 0, productAds: 0, keywords: 0, productTargets: 0, autoTargeting: 0, negativeKeywords: 0, negativeProducts: 0, placement: null }
  readonly failures: LaunchStepFailure[] = []

  constructor(readonly name: string) {}

  /** The campaign create answered: a row (and Amazon's id, or why there is none). */
  campaign(c: { id: string; externalCampaignId: string | null; reason?: string | null }): void {
    this.campaignId = c.id
    this.externalCampaignId = c.externalCampaignId
    if (!c.externalCampaignId) this.campaignReason = (c.reason ?? '').trim() || CAMPAIGN_NOT_ON_AMAZON
  }

  /** The campaign create threw: nothing was written. */
  campaignThrew(e: unknown): void {
    this.campaignReason = errorText(e)
  }

  /** Is the campaign on Amazon? Children of a campaign that is not are not listed one by one: its reason covers them. */
  get onAmazon(): boolean {
    return !!this.externalCampaignId
  }

  /** The ad group create answered (or threw: pass the error). Its children are listed only when it is on Amazon. */
  adGroup(item: string, r: { externalAdGroupId: string | null; notSent?: NotSentLike } | null, error?: unknown): void {
    this.adGroupOnAmazon = !!r?.externalAdGroupId
    if (!this.onAmazon) return
    if (this.adGroupOnAmazon) { this.made.adGroups++; return }
    const why = r ? (r.notSent?.reason ?? 'Amazon did not return an id for it') : errorText(error)
    this.fail('ad_group', item, `${why} — the campaign is on Amazon with nothing in it, so it cannot serve.`)
  }

  private get childrenListed(): boolean {
    return this.onAmazon && this.adGroupOnAmazon
  }

  productAd(item: string, r: { externalAdId: string | null; notSent?: NotSentLike }): void {
    if (!this.childrenListed) return
    if (r.externalAdId) this.made.productAds++
    else this.fail('product_ad', item, r.notSent?.reason)
  }

  keyword(item: string, r: { externalTargetId: string | null; existed?: boolean; denied?: NotSentLike; pushError?: string | null }): void {
    if (!this.childrenListed) return
    if (r.externalTargetId) { if (!r.existed) this.made.keywords++; return }
    if (r.existed) return // the same keyword twice in one launch: the first one is already counted or listed
    this.fail('keyword', item, r.denied?.reason ?? r.pushError)
  }

  productTarget(item: string, r: { externalTargetId: string | null; notSent?: NotSentLike }): void {
    if (!this.childrenListed) return
    if (r.externalTargetId) this.made.productTargets++
    else this.fail('product_target', item, r.notSent?.reason)
  }

  /** linkAutoTargeting's answer: each auto group asked for is linked to Amazon's (and set as asked) or listed with why. */
  autoGroups(r: { links: Array<{ label: string; ok: boolean; reason: string | null }> }): void {
    if (!this.childrenListed) return
    for (const l of r.links) {
      if (l.ok) this.made.autoTargeting++
      else this.fail('auto_targeting', l.label, l.reason)
    }
  }

  /** A negative helper's answer (createNegativeKeywordLocal / createNegativeProductTargetLocal). Sandbox has no Amazon id. */
  negative(step: 'negative_keyword' | 'negative_product', item: string, r: { externalTargetId: string | null; mode: string; refusal?: NotSentLike; error?: string | null }): void {
    if (!this.childrenListed) return
    if (r.externalTargetId || r.mode === 'sandbox') this.made[step === 'negative_keyword' ? 'negativeKeywords' : 'negativeProducts']++
    else this.fail(step, item, r.refusal?.reason ?? r.error)
  }

  /** updatePlacementBidding's answer. */
  placement(r: { ok: boolean; reason?: string | null; error?: string | null }): void {
    if (!this.onAmazon) return
    this.made.placement = r.ok
    if (!r.ok) this.fail('placement', 'Placement bid adjustments', r.reason ?? r.error)
  }

  /** A step that threw (a child of a campaign or ad group Amazon does not hold is covered by that one's reason). */
  threw(step: LaunchStep, item: string, e: unknown): void {
    if (step === 'placement' ? !this.onAmazon : !this.childrenListed) return
    if (step === 'placement') this.made.placement = false
    this.fail(step, item, errorText(e))
  }

  fail(step: LaunchStep, item: string, reason: string | null | undefined): void {
    this.failures.push({ step, item, reason: (reason ?? '').trim() || `the ${STEP_WORD[step]} did not reach Amazon` })
  }

  result(): LaunchCampaignResult {
    const status: LaunchCampaignStatus = !this.onAmazon ? 'failed' : this.failures.length ? 'partial' : 'live'
    const reason = status === 'failed'
      ? this.campaignReason
      : status === 'partial'
        ? `${this.failures.length} part${this.failures.length === 1 ? '' : 's'} did not reach Amazon.`
        : null
    return {
      name: this.name, campaignId: this.campaignId, externalCampaignId: this.externalCampaignId,
      status, reason, made: { ...this.made }, failed: [...this.failures],
    }
  }
}

export function summariseLaunch(campaigns: LaunchCampaignResult[]): LaunchResult {
  const live = campaigns.filter((c) => c.status === 'live').length
  const partial = campaigns.filter((c) => c.status === 'partial').length
  const failed = campaigns.filter((c) => c.status === 'failed').length
  return { ok: campaigns.length > 0 && live === campaigns.length, asked: campaigns.length, live, partial, failed, campaigns }
}

/** One plain line for logs, MCP answers and errors: "2 of 4 campaigns are live; 1 partly made; 1 failed (why)". */
export function describeLaunch(r: LaunchResult): string {
  const parts = [`${r.live} of ${r.asked} campaign${r.asked === 1 ? '' : 's'} live on Amazon`]
  if (r.partial) parts.push(`${r.partial} partly made`)
  if (r.failed) parts.push(`${r.failed} not made`)
  const first = r.campaigns.find((c) => c.status === 'failed') ?? r.campaigns.find((c) => c.status === 'partial')
  const why = first ? (first.status === 'failed' ? first.reason : first.failed[0] ? `${first.failed[0].item}: ${first.failed[0].reason}` : first.reason) : null
  return `${parts.join('; ')}${why ? ` — "${first!.name}": ${why}` : ''}`
}
