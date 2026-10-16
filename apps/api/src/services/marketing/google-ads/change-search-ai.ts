/**
 * Google Ads (2026-10-16, programme 2 G14b leftovers) — a Search campaign's AI Max controls, as set-google-campaign changes
 * them and build-google-campaigns / copy-google-campaign make them: text guidelines, page feeds (URL inclusions) linked to
 * the campaign, URL exclusions (landing pages never used) and an ad group's URL inclusions (the pages it may send people
 * to). Pure: request + live state → operations, lines, SPENDS MONEY sentences, warnings, the before / after record.
 *
 * Checked 2026-10-16 with curl in Google's v25 reference and guides (developers.google.com/google-ads/api/…):
 *   reference/rpc/v25/Campaign  text_guidelines "Only available in Performance Max and Search campaigns (Brand Guidelines does
 *                     not need to be enabled)"; Campaign.TextGuidelines term_exclusions (at most 25 of 30 characters),
 *                     messaging_restrictions (at most 40 of 300 characters, RESTRICTION_BASED_EXCLUSION only).
 *   docs/campaigns/ai-max-for-search-campaigns/getting-started  AI Max's "Additional controls": "URL inclusions and
 *                     exclusions" and "Text guidelines". Page feed inclusion lists at the ad group level: the page feed (an
 *                     AssetSet of type PAGE_FEED) "must be linked to the parent campaign" with a CampaignAssetSet; an ad group
 *                     criterion of type WEBPAGE, negative false ("in SEARCH_STANDARD ad groups, only positive WEBPAGE"), with
 *                     criterion_name (required on create) and conditions: URL with CONTAINS (default) or EQUALS ("argument must
 *                     be a full http:// or https:// URL"; "a URL EQUALS condition cannot be combined with any other
 *                     conditions"), CUSTOM_LABEL with EQUALS; "up to three conditions per WebpageInfo (logically ANDed)";
 *                     "Pages that match any of these positive WEBPAGE criteria form the Inclusion List for the ad group". For
 *                     SEARCH_STANDARD ad groups the campaign needs AI Max on (ai_max_setting.enable_ai_max) and text
 *                     customization opted in (TEXT_ASSET_AUTOMATION), "Otherwise, creating a WEBPAGE AdGroupCriterion fails".
 *   docs/campaigns/ai-max-for-search-campaigns/ai-max-reporting "Exclude landing pages (URL exclusions)": "Level: Campaign (in
 *                     SEARCH_STANDARD ad groups, negative webpage criteria are only permitted at the campaign level)";
 *                     webpage.conditions and negative = TRUE.
 *   WebpageInfo       criterion_name and conditions "required for CREATE operations and … prohibited on UPDATE operations": a
 *                     rule changed is removed and made again.
 *
 * Money (Owner's rules). In an ENABLED campaign: a text guideline taken away, a page feed linked, any URL exclusion taken
 * away (it also keeps pages from Dynamic Search Ads ad groups) — SPENDS MONEY; in a serving ad group: a URL inclusion added to an ad group that already
 * keeps to a list, or the last one taken away (it then may use every page) — SPENDS MONEY. Narrowing is said as a warning.
 */
import { plural } from './change-draft.js'
import { textGuidelinesBody, textGuidelinesOfAsk, urlExclusionKey, urlExclusionOfKey, urlExclusionsOf, type TextGuidelinesAsk, type UrlExclusion } from './change-ai-controls.js'
import type { LiveAiAdGroup, SearchAiLive, UrlRule } from './live-search-ai.js'
import type { PageFeedRef } from './live-pmax.js'
import type { GoogleMutateOperation } from './write-client.js'

export type { UrlRule } from './live-search-ai.js'

/** The AI Max controls as set-google-campaign takes them: each one WHOLE (what it should be); one left out stays. */
export interface SearchAiAsk {
  termExclusions?: string[]
  messagingRestrictions?: string[]
  /** The page feeds linked to the campaign, by id. */
  pageFeeds?: string[]
  urlExclusions?: UrlExclusion[]
  /** Per ad group named: its URL inclusion rules ([] = none: it may use every page). */
  urlInclusions?: Array<{ adGroupId: string; rules: UrlRule[] }>
}
export const SEARCH_AI_KEYS = ['termExclusions', 'messagingRestrictions', 'pageFeeds', 'urlExclusions', 'urlInclusions'] as const

const sorted = (xs: Iterable<string>) => [...new Set(xs)].sort()
const MAX_CONDITIONS = 3

/** A rule as Nexus keeps and compares it: its URLs and labels trimmed and sorted (the same rule however written). */
export function normalizeUrlRule(r: UrlRule): UrlRule {
  if (r.urlEquals?.trim()) return { urlEquals: r.urlEquals.trim() }
  return {
    ...(r.urlContains?.length ? { urlContains: sorted(r.urlContains.map((u) => u.trim()).filter(Boolean)) } : {}),
    ...(r.labels?.length ? { labels: sorted(r.labels.map((l) => l.trim()).filter(Boolean)) } : {}),
  }
}
export const urlRuleKey = (r: UrlRule) => JSON.stringify(normalizeUrlRule(r))
/** ONE order for an ad group's rules, wherever they are listed (the preview's after, what is read back, undo's compare). */
export const byUrlRule = (a: UrlRule, b: UrlRule): number => { const x = urlRuleKey(a); const y = urlRuleKey(b); return x < y ? -1 : x > y ? 1 : 0 }
export const sortedUrlRules = (rules: UrlRule[]): UrlRule[] => rules.map(normalizeUrlRule).sort(byUrlRule)
export const urlRuleWords = (r: UrlRule) => {
  const n = normalizeUrlRule(r)
  return n.urlEquals ? `the page ${n.urlEquals}` : [...(n.urlContains ?? []).map((u) => `URL contains "${u}"`), ...(n.labels ?? []).map((l) => `label "${l}"`)].join(' and ')
}

/** Why a rule is not one Google takes (the guide's rules above), or null. */
export function urlRuleProblem(r: UrlRule): string | null {
  const n = normalizeUrlRule(r)
  if (n.urlEquals !== undefined) {
    if (r.urlContains?.length || r.labels?.length) return 'a rule of one exact URL takes no other condition (Google\'s rule)'
    try { const u = new URL(n.urlEquals); if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('') } catch { return `"${n.urlEquals.slice(0, 60)}" is not a full http:// or https:// URL (Google's rule for an exact URL)` }
    return n.urlEquals.length > 2048 ? 'a URL is at most 2048 characters' : null
  }
  const count = (n.urlContains?.length ?? 0) + (n.labels?.length ?? 0)
  if (!count) return 'a rule needs a URL, a part of a URL or a custom label'
  if (count > MAX_CONDITIONS) return `a rule holds at most ${MAX_CONDITIONS} conditions (Google's rule): make several rules instead`
  if ([...(n.urlContains ?? []), ...(n.labels ?? [])].some((x) => x.length > 2048)) return 'a condition is at most 2048 characters'
  return null
}

/** Google's WebpageInfo of a rule (criterion_name is required on create; Nexus names it after the rule). */
export function urlRuleBody(r: UrlRule): Record<string, unknown> {
  const n = normalizeUrlRule(r)
  const conditions = n.urlEquals
    ? [{ operand: 'URL', operator: 'EQUALS', argument: n.urlEquals }]
    : [...(n.urlContains ?? []).map((a) => ({ operand: 'URL', operator: 'CONTAINS', argument: a })), ...(n.labels ?? []).map((a) => ({ operand: 'CUSTOM_LABEL', operator: 'EQUALS', argument: a }))]
  return { criterionName: `Include ${urlRuleWords(n)}`.slice(0, 255), conditions }
}

/** Google's WebpageInfo of a URL exclusion (one URL condition, as set-google-pmax makes them). */
export function urlExclusionBody(u: UrlExclusion): Record<string, unknown> {
  const key = urlExclusionKey(u)
  const arg = (u.contains ?? u.equals ?? '').trim()
  return { criterionName: `Exclude ${key}`.slice(0, 255), conditions: [{ operand: 'URL', operator: u.equals !== undefined ? 'EQUALS' : 'CONTAINS', argument: arg }] }
}

/** The values now, in the request's terms (URL inclusions only for the ad groups named). */
export function searchAiNow(live: SearchAiLive, groupIds?: string[]): SearchAiAsk {
  const out: SearchAiAsk = {}
  if (live.textGuidelines) { out.termExclusions = live.textGuidelines.termExclusions; out.messagingRestrictions = live.textGuidelines.messagingRestrictions }
  if (live.pageFeeds) out.pageFeeds = sorted(live.pageFeeds.map((f) => f.assetSetId))
  if (live.webpageCriteria) out.urlExclusions = sorted(urlExclusionsOf({ criteria: live.webpageCriteria }).map((u) => u.key)).map(urlExclusionOfKey)
  if (live.adGroups && groupIds) {
    out.urlInclusions = groupIds.map((id) => {
      const g = live.adGroups!.find((x) => x.adGroupId === id)
      const rules = sortedUrlRules((g?.rules ?? []).filter((r) => r.rule).map((r) => r.rule!))
      return { adGroupId: id, rules }
    })
  }
  return out
}

export interface SearchAiPart {
  /** Sent before the campaign's update (unlinks, rules taken away). */
  pre: GoogleMutateOperation[]
  /** Merged into the campaign's update. */
  fields: Record<string, unknown>
  mask: string[]
  /** Sent after it (links, exclusions, rules made). */
  post: GoogleMutateOperation[]
  lines: Array<[string, unknown, unknown]>
  spends: string[]
  warnings: string[]
  problems: string[]
  before: SearchAiAsk
  after: SearchAiAsk
}

/**
 * The part of a Search campaign's change for its AI Max controls. `after` says what the campaign's AI Max, text
 * customization and final URL expansion are once the change ran; `note` is said when the campaign is paused.
 */
export function searchAiPart(
  customer: string,
  c: { campaignId: string; name: string; status: string | null },
  ask: SearchAiAsk,
  live: SearchAiLive & { accountFeeds?: PageFeedRef[] },
  after: { aiMax: boolean; textCustomization: boolean; finalUrlExpansion: boolean },
  note: string,
): SearchAiPart {
  const out: SearchAiPart = { pre: [], fields: {}, mask: [], post: [], lines: [], spends: [], warnings: [], problems: [], before: {}, after: {} }
  const campaignRes = `${customer}/campaigns/${c.campaignId}`
  const now = searchAiNow(live, ask.urlInclusions?.map((g) => g.adGroupId))
  const listText = (l: string[] | undefined) => (l?.length ? l.map((t) => `"${t.length > 50 ? `${t.slice(0, 49)}…` : t}"`).join(', ') : '(none)')

  // Text guidelines.
  if (ask.termExclusions !== undefined || ask.messagingRestrictions !== undefined) {
    const asked = textGuidelinesOfAsk({ termExclusions: ask.termExclusions, messagingRestrictions: ask.messagingRestrictions }, 'text guidelines', out.problems)
    const write: TextGuidelinesAsk = {}
    for (const [key, path, word] of [['termExclusions', 'text_guidelines.term_exclusions', 'term exclusions'], ['messagingRestrictions', 'text_guidelines.messaging_restrictions', 'messaging restrictions']] as const) {
      const want = asked[key]
      const was = now[key] ?? []
      if (!want || JSON.stringify([...want].sort()) === JSON.stringify([...was].sort())) continue
      write[key] = want
      out.mask.push(path)
      out.lines.push([`text guidelines: ${word}`, listText(was), listText(want)])
      out.before[key] = was; out.after[key] = want
      const gone = was.filter((t) => !want.some((w) => w.toLowerCase() === t.toLowerCase()))
      if (gone.length) out.spends.push(`Takes away the ${word.replace(/s$/, '')}${gone.length > 1 ? 's' : ''} ${listText(gone)}: Google's generated text may say what it did not${note}.`)
    }
    if (Object.keys(write).length) {
      out.fields.textGuidelines = textGuidelinesBody(write)
      if (!after.textCustomization && !after.finalUrlExpansion) out.warnings.push('Text guidelines guide the text Google writes: with text customization and final URL expansion off, Google writes none in this campaign.')
    }
  }

  // Page feeds linked to the campaign.
  if (ask.pageFeeds !== undefined) {
    const has = now.pageFeeds ?? []
    const want = sorted(ask.pageFeeds)
    const nameOf = (id: string) => (live.accountFeeds ?? live.pageFeeds ?? []).find((f) => f.assetSetId === id)?.name ?? id
    for (const id of has.filter((x) => !want.includes(x))) {
      out.pre.push({ campaignAssetSetOperation: { remove: `${customer}/campaignAssetSets/${c.campaignId}~${id}` } })
      out.lines.push([`page feed "${nameOf(id)}"`, 'linked', '(none)'])
      out.warnings.push(`Unlinks the page feed "${nameOf(id)}": Google no longer takes its pages for this campaign (narrower).`)
    }
    for (const id of want.filter((x) => !has.includes(x))) {
      if (!(live.accountFeeds ?? []).some((f) => f.assetSetId === id)) { out.problems.push(`page feed ${id} is not a page feed of this account (set-google-page-feed makes one)`); continue }
      out.post.push({ campaignAssetSetOperation: { create: { campaign: campaignRes, assetSet: `${customer}/assetSets/${id}` } } })
      out.lines.push([`page feed "${nameOf(id)}"`, '(none)', 'linked'])
      out.spends.push(`Links the page feed "${nameOf(id)}": Google may send people to its pages and write ads from them${note}.`)
    }
    if (JSON.stringify(has) !== JSON.stringify(want)) {
      out.before.pageFeeds = has; out.after.pageFeeds = want
      if (want.length && !after.textCustomization && !after.finalUrlExpansion) out.warnings.push('A page feed reaches a Search campaign\'s ads through AI Max (text customization, final URL expansion, URL inclusions) or Dynamic Search Ads: with text customization and final URL expansion off here, it changes nothing yet.')
    }
  }

  // URL exclusions (negative WEBPAGE campaign criteria with one URL condition).
  if (ask.urlExclusions !== undefined) {
    const liveKeys = urlExclusionsOf({ criteria: live.webpageCriteria ?? [] })
    const has = new Map(liveKeys.map((u) => [u.key, u.criterionId]))
    const want = sorted(ask.urlExclusions.map(urlExclusionKey))
    for (const key of want) {
      const u = urlExclusionOfKey(key)
      const arg = (u.contains ?? u.equals ?? '').trim()
      if (!arg || arg.length > 2048) { out.problems.push(`URL exclusion "${arg.slice(0, 60)}": give the part of the address (1 to 2048 characters)`); continue }
      if (has.has(key)) continue
      out.post.push({ campaignCriterionOperation: { create: { campaign: campaignRes, negative: true, webpage: urlExclusionBody(u) } } })
      out.lines.push([`URL exclusion ${key}`, '(none)', 'never used as a landing page'])
    }
    for (const [key, id] of has) {
      if (want.includes(key)) continue
      out.post.push({ campaignCriterionOperation: { remove: `${customer}/campaignCriteria/${c.campaignId}~${id}` } })
      out.lines.push([`URL exclusion ${key}`, 'excluded', '(none)'])
      // Always SPENDS MONEY: a campaign's URL exclusions also keep pages from its Dynamic Search Ads ad groups, not only
      // from final URL expansion (urlExclusions: [] takes every one off).
      out.spends.push(`Takes the URL exclusion ${key} off: Google may send people to those pages again (final URL expansion, Dynamic Search Ads)${note}.`)
    }
    const before = sorted(has.keys())
    if (JSON.stringify(before) !== JSON.stringify(want)) { out.before.urlExclusions = before.map(urlExclusionOfKey); out.after.urlExclusions = want.map(urlExclusionOfKey) }
  }

  // An ad group's URL inclusions (positive WEBPAGE ad group criteria).
  if (ask.urlInclusions !== undefined) {
    const before: NonNullable<SearchAiAsk['urlInclusions']> = []
    const afterList: NonNullable<SearchAiAsk['urlInclusions']> = []
    const seen = new Set<string>()
    for (const asked of ask.urlInclusions) {
      const g: LiveAiAdGroup | undefined = (live.adGroups ?? []).find((x) => x.adGroupId === asked.adGroupId)
      if (!g) { out.problems.push(`ad group ${asked.adGroupId} is not in "${c.name}" (or it is removed)`); continue }
      if (seen.has(g.adGroupId)) { out.problems.push(`ad group ${g.adGroupId} is named twice`); continue }
      seen.add(g.adGroupId)
      const where = `ad group "${g.name}"`
      if (g.type !== 'SEARCH_STANDARD') { out.problems.push(`${where} is ${g.type ?? 'of another type'}: URL inclusions here are for standard Search ad groups (Dynamic Search Ads targets are Google Ads')`); continue }
      if (g.rules.some((r) => !r.rule)) { out.problems.push(`${where} keeps to a page rule Nexus cannot name (a page title, content or category): change its URL inclusions in Google Ads`); continue }
      const want = new Map<string, UrlRule>()
      for (const r of asked.rules) {
        const p = urlRuleProblem(r)
        if (p) { out.problems.push(`${where}: ${p}`); continue }
        want.set(urlRuleKey(r), normalizeUrlRule(r))
      }
      const has = new Map(g.rules.map((r) => [urlRuleKey(r.rule!), r]))
      const added = [...want.entries()].filter(([k]) => !has.has(k))
      const removed = [...has.entries()].filter(([k]) => !want.has(k))
      if (!added.length && !removed.length) continue
      if (added.length && !(after.aiMax && after.textCustomization)) {
        out.problems.push(`${where}: Google takes URL inclusions in a standard Search ad group only with AI Max on and text customization on (docs/campaigns/ai-max-for-search-campaigns): turn them on in the same change (aiMax, textCustomization)`)
        continue
      }
      for (const [, r] of removed) {
        out.pre.push({ adGroupCriterionOperation: { remove: `${customer}/adGroupCriteria/${g.adGroupId}~${r.criterionId}` } })
        out.lines.push([`${where} URL inclusion`, urlRuleWords(r.rule!), '(none)'])
      }
      for (const [, r] of added) {
        out.post.push({ adGroupCriterionOperation: { create: { adGroup: `${customer}/adGroups/${g.adGroupId}`, webpage: urlRuleBody(r) } } })
        out.lines.push([`${where} URL inclusion`, '(none)', urlRuleWords(r)])
      }
      const serves = c.status === 'ENABLED' && g.status === 'ENABLED'
      const gNote = serves ? '' : ' (it does not serve now)'
      if (has.size && added.length) (serves ? out.spends : out.warnings).push(`${where}: adds ${plural(added.length, 'URL inclusion')} to the ${has.size} it keeps to — Google may send people to more pages${gNote}.`)
      else if (has.size && !want.size) (serves ? out.spends : out.warnings).push(`${where}: takes away its last URL inclusion — Google may send people to any page of the site and the page feeds${gNote}.`)
      else if (!has.size && want.size) out.warnings.push(`${where}: keeps to ${plural(want.size, 'URL inclusion')} from now — only those pages are used (narrower).`)
      if ([...want.values()].some((r) => r.labels?.length) && !(out.after.pageFeeds ?? now.pageFeeds ?? []).length) {
        out.warnings.push(`${where}: a custom label names pages of a page feed, and no page feed is linked to "${c.name}" (pageFeeds).`)
      }
      before.push({ adGroupId: g.adGroupId, rules: sortedUrlRules([...has.values()].map((r) => r.rule!)) })
      afterList.push({ adGroupId: g.adGroupId, rules: sortedUrlRules([...want.values()]) })
    }
    if (afterList.length) { out.before.urlInclusions = before; out.after.urlInclusions = afterList }
  }
  return out
}
