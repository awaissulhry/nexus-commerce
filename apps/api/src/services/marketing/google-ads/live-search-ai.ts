/**
 * Google Ads (2026-10-16, programme 2 G14b leftovers) — what a Search campaign's AI Max controls hold NOW, read live: its
 * text guidelines, the page feeds linked to it, its URL exclusions (negative WEBPAGE campaign criteria) and its ad groups'
 * URL inclusions (positive WEBPAGE ad group criteria). The "from" side of set-google-campaign's AI Max controls and of a
 * copy of a Search campaign. One GAQL query per part asked, on the account's change allowance (write-client.ts liveRows).
 *
 * Checked 2026-10-16 with curl in Google's v25 field reference (developers.google.com/google-ads/api/fields/v25/…):
 *   campaign.text_guidelines.term_exclusions (selectable, filterable) and .messaging_restrictions (selectable).
 *   campaign_criterion.webpage.conditions (selectable, not filterable, repeated), .webpage.criterion_name, .type (filterable).
 *   ad_group_criterion.webpage.conditions (selectable, not filterable, repeated), .webpage.criterion_name, .type, .negative,
 *   .status (filterable). ad_group.type, ad_group.status (selectable, filterable).
 *   campaign_asset_set (live-pmax.ts pmaxPageFeedLinksQuery: the page feeds linked to a campaign of any type).
 * rpc/v25 WebpageConditionInfo {operand WebpageConditionOperand URL | CUSTOM_LABEL | PAGE_TITLE | PAGE_CONTENT | CATEGORY,
 * operator WebpageConditionOperator EQUALS | CONTAINS, argument}. A rule with another operand than URL or CUSTOM_LABEL is
 * one Nexus cannot name: it is kept as is (never changed, a copy names it as not copied).
 */
import { gaqlId } from './live.js'
import { pmaxCriterionOf, pmaxPageFeedLinksQuery, textGuidelinesOf, type PageFeedRef, type PmaxCriterion, type TextGuidelines } from './live-pmax.js'
import type { GoogleAdsTarget } from './types.js'
import { liveRows } from './write-client.js'

type Json = Record<string, any>
const str = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : typeof value === 'number' ? String(value) : null)

/** An ad group URL inclusion rule: one URL exactly, or up to three conditions (URLs containing a text, custom labels) ANDed. */
export interface UrlRule { urlEquals?: string; urlContains?: string[]; labels?: string[] }

export interface LiveUrlRule { criterionId: string; name: string | null; rule: UrlRule | null }
export interface LiveAiAdGroup { adGroupId: string; name: string; status: string | null; type: string | null; rules: LiveUrlRule[]; otherWebpage: number }

export interface SearchAiLive {
  textGuidelines?: TextGuidelines
  /** The page feeds linked to the campaign. */
  pageFeeds?: PageFeedRef[]
  /** Its WEBPAGE campaign criteria (URL exclusions are the negative ones with one URL condition). */
  webpageCriteria?: PmaxCriterion[]
  adGroups?: LiveAiAdGroup[]
}

export const searchTextGuidelinesQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign.text_guidelines.term_exclusions, campaign.text_guidelines.messaging_restrictions FROM campaign ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')}`

export const campaignWebpageQuery = (campaignId: string): string =>
  'SELECT campaign.id, campaign_criterion.criterion_id, campaign_criterion.type, campaign_criterion.negative, campaign_criterion.status, ' +
  'campaign_criterion.bid_modifier, campaign_criterion.webpage.conditions, campaign_criterion.webpage.criterion_name FROM campaign_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND campaign_criterion.type = 'WEBPAGE' AND campaign_criterion.status != 'REMOVED'`

export const aiAdGroupsQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.name, ad_group.status, ad_group.type FROM ad_group ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group.status != 'REMOVED'`

export const adGroupWebpageQuery = (campaignId: string): string =>
  'SELECT campaign.id, ad_group.id, ad_group.status, ad_group_criterion.criterion_id, ad_group_criterion.type, ad_group_criterion.negative, ' +
  'ad_group_criterion.status, ad_group_criterion.webpage.conditions, ad_group_criterion.webpage.criterion_name FROM ad_group_criterion ' +
  `WHERE campaign.id = ${gaqlId(campaignId, 'The campaign')} AND ad_group_criterion.type = 'WEBPAGE' AND ad_group_criterion.status != 'REMOVED' ` +
  "AND ad_group.status != 'REMOVED'"

/** Google's webpage conditions as a rule Nexus names, or null (another operand, or an operator Nexus does not send). */
export function urlRuleOf(conditions: unknown): UrlRule | null {
  const list = Array.isArray(conditions) ? conditions as Json[] : []
  if (!list.length) return null
  const rule: UrlRule = {}
  for (const c of list) {
    const operand = str(c?.operand)
    // Google leaves a default out of its answer: no operator is its default (CONTAINS for a URL, EQUALS for a label).
    const operator = str(c?.operator)
    const argument = str(c?.argument)
    if (!argument) return null
    if (operand === 'URL' && operator === 'EQUALS') { if (list.length > 1) return null; rule.urlEquals = argument }
    else if (operand === 'URL' && (!operator || operator === 'CONTAINS')) rule.urlContains = [...(rule.urlContains ?? []), argument]
    else if (operand === 'CUSTOM_LABEL' && (!operator || operator === 'EQUALS')) rule.labels = [...(rule.labels ?? []), argument]
    else return null
  }
  return rule
}

/** The AI Max controls of one campaign, only the parts asked (each one GAQL query; ad groups two). */
export async function liveSearchAi(
  target: GoogleAdsTarget, campaignId: string, parts: { textGuidelines?: boolean; pageFeeds?: boolean; urlExclusions?: boolean; urlInclusions?: boolean },
): Promise<SearchAiLive> {
  const id = gaqlId(campaignId, 'The campaign')
  const out: SearchAiLive = {}
  if (parts.textGuidelines) {
    const rows = await liveRows<Json>(target, searchTextGuidelinesQuery(id), 'ads.search.live.search-text-guidelines')
    out.textGuidelines = textGuidelinesOf(rows[0]?.campaign?.textGuidelines)
  }
  if (parts.pageFeeds) {
    out.pageFeeds = (await liveRows<Json>(target, pmaxPageFeedLinksQuery(id), 'ads.search.live.search-page-feeds'))
      .map((r) => ({ assetSetId: str(r.assetSet?.id) ?? '', name: str(r.assetSet?.name) }))
      .sort((a, b) => a.assetSetId.localeCompare(b.assetSetId))
  }
  if (parts.urlExclusions) out.webpageCriteria = (await liveRows<Json>(target, campaignWebpageQuery(id), 'ads.search.live.search-webpage')).map(pmaxCriterionOf)
  if (parts.urlInclusions) {
    const groups = await liveRows<Json>(target, aiAdGroupsQuery(id), 'ads.search.live.search-ad-groups')
    const criteria = await liveRows<Json>(target, adGroupWebpageQuery(id), 'ads.search.live.search-ad-group-webpage')
    out.adGroups = groups.map((g) => {
      const adGroupId = str(g.adGroup?.id) ?? ''
      const mine = criteria.filter((r) => str(r.adGroup?.id) === adGroupId)
      return {
        adGroupId, name: str(g.adGroup?.name) ?? '', status: str(g.adGroup?.status), type: str(g.adGroup?.type),
        rules: mine.filter((r) => r.adGroupCriterion?.negative !== true).map((r) => ({
          criterionId: str(r.adGroupCriterion?.criterionId) ?? '', name: str(r.adGroupCriterion?.webpage?.criterionName), rule: urlRuleOf(r.adGroupCriterion?.webpage?.conditions),
        })),
        otherWebpage: mine.filter((r) => r.adGroupCriterion?.negative === true).length,
      }
    })
  }
  return out
}
