/**
 * Google Ads changes (2026-10-15, programme 2 group G3) — URLs and tracking of campaigns, ad groups, keywords and ads:
 * the tracking template, the final URL suffix and the custom parameters at each of those levels, and a keyword's own
 * final URL and final mobile URL. One atomic request; `null` takes a value away (the level above then applies).
 *
 * Checked 2026-10-15 in Google's v25 reference (curl of developers.google.com/google-ads/api/reference/rpc/v25/…):
 *   Campaign, AdGroup, AdGroupCriterion, Ad  tracking_url_template, final_url_suffix, url_custom_parameters[]
 *                       (CustomParameter: key, value) — none marked Immutable; AdGroupCriterion also final_urls[],
 *                       final_mobile_urls[]. Updated by CampaignOperation / AdGroupOperation / AdGroupCriterionOperation /
 *                       AdOperation `update` with an update mask (snake_case; a masked field left out is cleared).
 *   UrlFieldError       FINAL_URL_SUFFIX_MALFORMED ("cannot begin with '?' or '&'"), INVALID_TAG_IN_FINAL_URL_SUFFIX ("cannot
 *                       contain {lpurl} related or {ignore} tags"), MISSING_PROTOCOL_IN_TRACKING_URL_TEMPLATE ("must start
 *                       with a valid protocol (or lpurl tag)"), URL_CUSTOM_PARAMETERS_COUNT_EXCEEDS_LIMIT,
 *                       NULL_CUSTOM_PARAMETER_VALUE, INVALID_CHARACTERS_IN_URL_CUSTOM_PARAMETER_KEY.
 * Google Ads Help "About custom parameters" (support.google.com/google-ads/answer/6325879, read 2026-10-15): up to 8
 *   custom parameters at a level; name "up to 16 alphanumeric characters"; value "up to 250 characters"; the most specific
 *   level wins; "Changes to tracking templates take 24–48 hours to be reflected in your ads serving".
 * Everything else (a tag Google does not know, a malformed query string) is Google's check (validate_only).
 *
 * Money: none of these raises a bid or a budget, nor widens who sees the ads (no SPENDS MONEY).
 */
import { changeLines, plural, type GoogleChangeDraft } from './change-draft.js'
import { httpsUrlProblem } from './change-ads.js'
import type { CustomParameter, LiveAdGroupUrls, LiveCampaignUrls, LiveEditAd, LiveKeywordUrls, LiveUrlFields } from './live-edit.js'
import type { GoogleMutateOperation } from './write-client.js'

export const URL_LEVELS = ['campaign', 'ad-group', 'keyword', 'ad'] as const
export type UrlLevel = typeof URL_LEVELS[number]

export const CUSTOM_PARAMETER_LIMITS = { perLevel: 8, keyLength: 16, valueLength: 250 } as const

export interface UrlItem {
  level: UrlLevel
  /** campaign / ad group: its id; keyword: `adGroupId~criterionId`; ad: `adGroupId~adId`. */
  id: string
  trackingTemplate?: string | null
  finalUrlSuffix?: string | null
  /** The whole new list (null or [] = none). */
  customParameters?: CustomParameter[] | null
  /** A keyword's own landing page (null = none: the ad's final URL is used). */
  finalUrl?: string | null
  finalMobileUrl?: string | null
}
export interface UrlsRequest { items: UrlItem[] }

export interface UrlsLiveState {
  campaigns: LiveCampaignUrls[]
  adGroups: LiveAdGroupUrls[]
  keywords: LiveKeywordUrls[]
  ads: LiveEditAd[]
}

/** Per item, only the fields the change wrote (before: what they were; null = none). */
export interface UrlsEntry {
  level: UrlLevel
  id: string
  trackingTemplate?: string | null
  finalUrlSuffix?: string | null
  customParameters?: CustomParameter[] | null
  finalUrl?: string | null
  finalMobileUrl?: string | null
}
export interface UrlsRecord { items: UrlsEntry[] }

export const MAX_URL_ITEMS = 100

const LEVEL_WORD: Record<UrlLevel, string> = { campaign: 'campaign', 'ad-group': 'ad group', keyword: 'keyword', ad: 'ad' }
const FIELDS = ['trackingTemplate', 'finalUrlSuffix', 'customParameters', 'finalUrl', 'finalMobileUrl'] as const
type Field = typeof FIELDS[number]
const FIELD_WORD: Record<Field, string> = { trackingTemplate: 'tracking template', finalUrlSuffix: 'final URL suffix', customParameters: 'custom parameters', finalUrl: 'final URL', finalMobileUrl: 'final mobile URL' }
const MASK: Record<Field, string> = { trackingTemplate: 'tracking_url_template', finalUrlSuffix: 'final_url_suffix', customParameters: 'url_custom_parameters', finalUrl: 'final_urls', finalMobileUrl: 'final_mobile_urls' }
/** The field in Google's JSON body (a final URL is a list of one). */
const BODY: Record<Field, string> = { trackingTemplate: 'trackingUrlTemplate', finalUrlSuffix: 'finalUrlSuffix', customParameters: 'urlCustomParameters', finalUrl: 'finalUrls', finalMobileUrl: 'finalMobileUrls' }

const LPURL_START = /^\{(?:lpurl(?:\+[23])?|unescapedlpurl|escapedlpurl)\}/i
const LPURL_ANY = /\{(?:lpurl(?:\+[23])?|unescapedlpurl|escapedlpurl)\}|\{ignore\}/i
const KEY = /^[A-Za-z0-9]+$/

/** A text value as Nexus sends it: trimmed; empty = none. */
const value = (s: string | null | undefined): string | null => (s ?? '').trim() || null
const params = (list: CustomParameter[] | null | undefined): CustomParameter[] =>
  (list ?? []).map((p) => ({ key: p.key.trim(), value: p.value.trim() })).sort((a, b) => a.key.localeCompare(b.key))
const paramsText = (list: CustomParameter[] | null | undefined) => (list?.length ? list.map((p) => `{_${p.key}}=${p.value}`).join(', ') : '(none)')
const sameParams = (a: CustomParameter[], b: CustomParameter[]) => a.length === b.length && a.every((p, i) => p.key === b[i].key && p.value === b[i].value)

/** Google's rules Nexus checks before asking Google (every problem of the request at once). */
export function urlItemProblems(item: UrlItem, where: string): string[] {
  const problems: string[] = []
  const tracking = item.trackingTemplate === undefined ? null : value(item.trackingTemplate)
  if (tracking !== null) {
    if (/\s/.test(tracking)) problems.push(`${where}: the tracking template holds a space`)
    else if (!/^https?:\/\//i.test(tracking) && !LPURL_START.test(tracking)) problems.push(`${where}: the tracking template must start with http://, https:// or {lpurl} (Google's rule)`)
  }
  const suffix = item.finalUrlSuffix === undefined ? null : value(item.finalUrlSuffix)
  if (suffix !== null) {
    if (/^[?&]/.test(suffix)) problems.push(`${where}: the final URL suffix cannot begin with "?" or "&" (Google's rule: write it as key=value&key2=value2)`)
    if (/\s/.test(suffix)) problems.push(`${where}: the final URL suffix holds a space`)
    if (LPURL_ANY.test(suffix)) problems.push(`${where}: the final URL suffix cannot hold {lpurl} or {ignore} tags (Google's rule)`)
  }
  const list = item.customParameters ?? []
  if (list.length > CUSTOM_PARAMETER_LIMITS.perLevel) problems.push(`${where}: ${list.length} custom parameters (Google allows ${CUSTOM_PARAMETER_LIMITS.perLevel} at a level)`)
  const keys = new Set<string>()
  for (const p of list) {
    const key = p.key.trim()
    if (!KEY.test(key) || key.length > CUSTOM_PARAMETER_LIMITS.keyLength) problems.push(`${where}: custom parameter name "${key}" must be 1 to ${CUSTOM_PARAMETER_LIMITS.keyLength} letters and digits (no "_" or braces: {_${key || 'name'}} is how a URL uses it)`)
    if (keys.has(key)) problems.push(`${where}: custom parameter "${key}" is named twice`)
    keys.add(key)
    const v = p.value.trim()
    if (!v) problems.push(`${where}: custom parameter "${key}" has no value`)
    else if (v.length > CUSTOM_PARAMETER_LIMITS.valueLength) problems.push(`${where}: custom parameter "${key}" has a value of ${v.length} characters (Google allows ${CUSTOM_PARAMETER_LIMITS.valueLength})`)
  }
  if (item.level !== 'keyword' && (item.finalUrl !== undefined || item.finalMobileUrl !== undefined)) {
    problems.push(item.level === 'ad'
      ? `${where}: an ad's final URLs are changed with edit-google-rsa`
      : `${where}: a ${LEVEL_WORD[item.level]} has no final URL of its own (only keywords and ads do)`)
  }
  if (item.finalUrl) { const p = httpsUrlProblem(where, item.finalUrl); if (p) problems.push(p) }
  if (item.finalMobileUrl) { const p = httpsUrlProblem(`${where}, mobile`, item.finalMobileUrl); if (p) problems.push(p) }
  return problems
}

interface Target {
  name: string
  resource: string
  op: string
  urls: LiveUrlFields
  finalUrl: string | null
  finalMobileUrl: string | null
}

function targetOf(customer: string, item: UrlItem, live: UrlsLiveState): Target | { refusal: string } {
  const notThere = { refusal: `${LEVEL_WORD[item.level]} ${item.id} is not in this account (or it is removed). google-ads-live shows the ids.` }
  switch (item.level) {
    case 'campaign': {
      const c = live.campaigns.find((x) => x.campaignId === item.id)
      return c ? { name: `campaign "${c.name}"`, resource: `${customer}/campaigns/${c.campaignId}`, op: 'campaignOperation', urls: c.urls, finalUrl: null, finalMobileUrl: null } : notThere
    }
    case 'ad-group': {
      const g = live.adGroups.find((x) => x.adGroupId === item.id)
      return g ? { name: `ad group "${g.name}" (${g.campaignName})`, resource: `${customer}/adGroups/${g.adGroupId}`, op: 'adGroupOperation', urls: g.urls, finalUrl: null, finalMobileUrl: null } : notThere
    }
    case 'keyword': {
      const k = live.keywords.find((x) => x.id === item.id)
      if (!k) return notThere
      if (k.negative) return { refusal: `Keyword ${item.id} is a negative keyword: it has no URLs.` }
      return { name: `keyword ${k.matchType === 'EXACT' ? `[${k.text}]` : k.matchType === 'PHRASE' ? `"${k.text}"` : k.text} ("${k.adGroupName}")`, resource: `${customer}/adGroupCriteria/${k.id}`, op: 'adGroupCriterionOperation', urls: k.urls, finalUrl: k.finalUrls[0] ?? null, finalMobileUrl: k.finalMobileUrls[0] ?? null }
    }
    case 'ad': {
      const a = live.ads.find((x) => x.id === item.id)
      return a ? { name: `ad ${a.id} ("${a.adGroupName}")`, resource: `${customer}/ads/${a.adId}`, op: 'adOperation', urls: a.urls, finalUrl: null, finalMobileUrl: null } : notThere
    }
  }
}

/** Each item's URL fields as they are now, in the record's shape (undo's "now"; the preview's from side). */
export function urlsNow(item: { level: UrlLevel; id: string }, live: UrlsLiveState): Required<Omit<UrlsEntry, 'level' | 'id'>> | null {
  const t = targetOf('customers/0', { level: item.level, id: item.id }, live)
  if ('refusal' in t) return null
  return { trackingTemplate: t.urls.trackingTemplate, finalUrlSuffix: t.urls.finalUrlSuffix, customParameters: t.urls.customParameters.length ? t.urls.customParameters : null, finalUrl: t.finalUrl, finalMobileUrl: t.finalMobileUrl }
}

export function urlsChangeDraft(customer: string, request: UrlsRequest, live: UrlsLiveState): GoogleChangeDraft | { refusal: string } {
  const items = request.items ?? []
  if (!items.length) return { refusal: 'Name at least one campaign, ad group, keyword or ad (items).' }
  if (items.length > MAX_URL_ITEMS) return { refusal: `At most ${MAX_URL_ITEMS} items in one request (${items.length} asked).` }
  const seen = new Set<string>()
  const problems: string[] = []
  for (const item of items) {
    const key = `${item.level}:${item.id}`
    if (seen.has(key)) return { refusal: `${LEVEL_WORD[item.level]} ${item.id} is named twice.` }
    seen.add(key)
    if (!FIELDS.some((f) => item[f] !== undefined)) return { refusal: `${LEVEL_WORD[item.level]} ${item.id}: say what changes (trackingTemplate, finalUrlSuffix, customParameters${item.level === 'keyword' ? ', finalUrl, finalMobileUrl' : ''}).` }
    problems.push(...urlItemProblems(item, `${LEVEL_WORD[item.level]} ${item.id}`))
  }
  if (problems.length) return { refusal: `Not queued — the URLs break Google's rules (nothing was sent): ${problems.join('; ')}.` }

  const operations: GoogleMutateOperation[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const skipped: string[] = []
  const before: UrlsRecord = { items: [] }
  const after: UrlsRecord = { items: [] }
  const stands: unknown[] = []
  let trackingTouched = 0
  const cleared: string[] = []
  const newPages: string[] = []
  const ownPageGone: string[] = []
  for (const item of items) {
    const t = targetOf(customer, item, live)
    if ('refusal' in t) return t
    const now = urlsNow(item, live)!
    stands.push({ level: item.level, id: item.id, ...now })
    const update: Record<string, unknown> = { resourceName: t.resource }
    const mask: string[] = []
    const was: UrlsEntry = { level: item.level, id: item.id }
    const is: UrlsEntry = { level: item.level, id: item.id }
    for (const f of FIELDS) {
      if (item[f] === undefined) continue
      if (f === 'customParameters') {
        const to = params(item.customParameters)
        const from = now.customParameters ?? []
        if (sameParams(to, from)) { skipped.push(`${t.name}: the custom parameters are already so.`); continue }
        if (to.length) update[BODY.customParameters] = to
        was.customParameters = from.length ? from : null
        is.customParameters = to.length ? to : null
        lines.push([`${t.name} custom parameters`, paramsText(from), paramsText(to)])
        if (!to.length) cleared.push(`${t.name} custom parameters`)
      } else {
        const to = value(item[f] as string | null)
        const from = now[f] as string | null
        if (to === from) { skipped.push(`${t.name}: the ${FIELD_WORD[f]} is already ${to === null ? 'none' : 'so'}.`); continue }
        if (to !== null) update[BODY[f]] = f === 'finalUrl' || f === 'finalMobileUrl' ? [to] : to
        was[f] = from
        is[f] = to
        lines.push([`${t.name} ${FIELD_WORD[f]}`, from ?? '(none)', to ?? '(none)'])
        if (f === 'trackingTemplate' || f === 'finalUrlSuffix') trackingTouched += 1
        if (f === 'finalUrl') (to === null ? ownPageGone : newPages).push(t.name)
        else if (to === null && f !== 'finalMobileUrl') cleared.push(`${t.name} ${FIELD_WORD[f]}`)
      }
      mask.push(MASK[f])
    }
    if (!mask.length) continue
    operations.push({ [t.op]: { update, updateMask: mask.join(',') } })
    before.items.push(was)
    after.items.push(is)
  }
  if (!operations.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }

  const warnings: string[] = []
  if (cleared.length) {
    warnings.push(`Taken away: ${cleared.slice(0, 10).join('; ')}${cleared.length > 10 ? ` (+${cleared.length - 10} more)` : ''}. The setting of the level above (ad group, campaign, account) applies instead, if there is one; tracking that rests on it (sales tracking, analytics tags) can stop for these clicks.`)
  }
  if (trackingTouched) warnings.push('Google says a tracking template change can take 24–48 hours to reach the ads that serve.')
  if (newPages.length) warnings.push(`${plural(newPages.length, 'keyword')} ${newPages.length === 1 ? 'leads' : 'lead'} to another page from now (its own final URL wins over the ad's); Google reviews the new page.`)
  if (ownPageGone.length) warnings.push(`No own final URL any more: ${ownPageGone.slice(0, 10).join('; ')}${ownPageGone.length > 10 ? ` (+${ownPageGone.length - 10} more)` : ''}. Their clicks go to the ad's final URL.`)
  const { changes, more } = changeLines(lines)
  const counts = URL_LEVELS.map((l) => [l, after.items.filter((i) => i.level === l).length] as const).filter(([, n]) => n > 0)
  return {
    summary: `Google Ads URLs and tracking: change ${counts.map(([l, n]) => plural(n, LEVEL_WORD[l])).join(', ')}.`,
    changes,
    totals: { operations: operations.length, items: after.items.length, ...(more ? { linesNotShown: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped,
    operations,
    stands,
    before,
    after,
  }
}
