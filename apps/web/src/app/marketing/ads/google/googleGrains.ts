/**
 * Google Ads step 1b, WB — the pure half of the campaign window (its tabs) and of the grain grids: ad groups, keywords,
 * negatives, asset groups, search terms, products, and one campaign's "Google acts on its own".
 *
 * The rules this file keeps, each with a test (`googleGrains.vitest.test.ts`):
 *  - Which tabs a campaign has comes from its type (`campaignTabs`); a tab that does not apply is absent, never held.
 *    A campaign whose settings Nexus has not read has only Overview and Changes.
 *  - "Not read yet" is `read.readAt === null` — never an empty list, never a 0. An empty list is only a list Google
 *    answered with nothing. Day gaps come from `coverage`, in the 1a words (`coverageNote`).
 *  - Google's words, in plain English: match types, statuses, ad strength, product status, brand.
 *  - Read only: nothing here changes Google Ads.
 */
import type {
  EntityStatus,
  Flag,
  GoogleCampaignAutomation,
  GoogleCoverage,
  GoogleMatchType,
  GoogleNegative,
  GoogleNegativeList,
  GoogleNegativesPage,
  GoogleOutsideChange,
  GoogleProduct,
  GoogleRead,
} from '@/lib/google-ads/contract'
import { campaignStatusLabel, coverageNote, formatInt, formatMoment, withoutEmails } from './googleAds'

const DASH = '—'

/** "SEARCH_DYNAMIC_ADS" → "Search dynamic ads". */
function words(code: string): string {
  const w = code.toLowerCase().split('_').filter(Boolean).join(' ')
  return w ? w[0]!.toUpperCase() + w.slice(1) : code
}

export type Tone = 'neutral' | 'info' | 'success' | 'warning' | 'danger'
export interface Word { text: string; tone: Tone }

// ─── The campaign window's tabs ─────────────────────────────────────────

export type CampaignTab =
  | 'overview'
  | 'ad-groups'
  | 'keywords'
  | 'asset-groups'
  | 'products'
  | 'negatives'
  | 'search-terms'
  | 'on-its-own'
  | 'changes'

export const CAMPAIGN_TAB_LABEL: Readonly<Record<CampaignTab, string>> = {
  overview: 'Overview',
  'ad-groups': 'Ad groups',
  keywords: 'Keywords',
  'asset-groups': 'Asset groups',
  products: 'Products',
  negatives: 'Negatives',
  'search-terms': 'Search terms',
  'on-its-own': 'Google acts on its own',
  changes: 'Changes',
}

const TABS_BY_TYPE: Readonly<Record<string, readonly CampaignTab[]>> = {
  SEARCH: ['overview', 'ad-groups', 'keywords', 'negatives', 'search-terms', 'on-its-own', 'changes'],
  SHOPPING: ['overview', 'ad-groups', 'products', 'negatives', 'search-terms', 'on-its-own', 'changes'],
  PERFORMANCE_MAX: ['overview', 'asset-groups', 'products', 'negatives', 'search-terms', 'on-its-own', 'changes'],
}
const OTHER_TABS: readonly CampaignTab[] = ['overview', 'ad-groups', 'on-its-own', 'changes']
const NOT_READ_TABS: readonly CampaignTab[] = ['overview', 'changes']

/**
 * The tabs of one campaign, from its type (the eBay `TABS_BY_STRATEGY` precedent: absent, never disabled). A campaign
 * whose settings Nexus has not read (no status, or type UNKNOWN) has only what Nexus knows: its days and its changes.
 */
export function campaignTabs(type: string | null | undefined, status: EntityStatus | undefined): CampaignTab[] {
  const t = type?.trim().toUpperCase() ?? ''
  if (!status || !t || t === 'UNKNOWN') return [...NOT_READ_TABS]
  return [...(TABS_BY_TYPE[t] ?? OTHER_TABS)]
}

export function isCampaignTab(tab: unknown): tab is CampaignTab {
  return typeof tab === 'string' && tab in CAMPAIGN_TAB_LABEL
}

/** The tab to show: the address's when this campaign has it, else Overview. */
export function campaignTabOf(tab: string | null | undefined, tabs: readonly CampaignTab[]): CampaignTab {
  return isCampaignTab(tab) && tabs.includes(tab) ? tab : 'overview'
}

// ─── Read state: not read yet, empty, gaps ──────────────────────────────

export interface Noun { one: string; many: string }

export const NOUN = {
  adGroup: { one: 'ad group', many: 'ad groups' },
  keyword: { one: 'keyword', many: 'keywords' },
  negative: { one: 'negative keyword', many: 'negative keywords' },
  assetGroup: { one: 'asset group', many: 'asset groups' },
  searchTerm: { one: 'search term', many: 'search terms' },
  product: { one: 'product', many: 'products' },
  setting: { one: 'setting', many: 'settings' },
} as const satisfies Record<string, Noun>

/** Whose list it is: one campaign's (in the campaign window) or the account's (a page tab). */
export type GrainScope = 'campaign' | 'account'

export function scopeWords(noun: Noun, scope: GrainScope): string {
  return scope === 'campaign' ? `this campaign’s ${noun.many}` : `the ${noun.many} of this account`
}

/** Never read: no `read`, or a read with no time. A read that failed after a good one is still read. */
export function notReadYet(read: Pick<GoogleRead, 'readAt'> | null | undefined): boolean {
  return !read?.readAt
}

/** Why the last try did not give a read, in words, or null. */
export function lastTryText(read: Pick<GoogleRead, 'lastStatus' | 'lastError'> | null | undefined): string | null {
  if (!read) return null
  if (read.lastStatus === 'FAILED') return `The last try failed: ${read.lastError?.trim() || 'Google did not say why.'}`
  if (read.lastStatus === 'SKIPPED_BUDGET') return 'The last read was put off: Nexus had used its daily allowance of Google requests.'
  return null
}

/** "Not read yet. Nexus has not read this campaign's keywords from Google yet. It reads them in the next daily read (next: …)." */
export function notReadText(noun: Noun, scope: GrainScope, read: Pick<GoogleRead, 'lastStatus' | 'lastError'> | null | undefined, nextReadAt: string | null, timeZone?: string): string {
  const next = formatMoment(nextReadAt, timeZone)
  const why = lastTryText(read)
  return `Nexus has not read ${scopeWords(noun, scope)} from Google yet. It reads them in the next daily read${next ? ` (next: ${next})` : ''}.${why ? ` ${why}` : ''}`
}

/** One answer with nothing in it: Google reported none (never "not read"). */
export function emptyText(noun: Noun, scope: GrainScope, windowed: boolean): string {
  return `Google reported no ${noun.many} for ${scope === 'campaign' ? 'this campaign' : 'this account'}${windowed ? ' in these days' : ''}.`
}

export type GrainKind = 'not_read' | 'empty' | 'ok'

export interface GrainNote { tone: 'warning' | 'info'; text: string }

export interface GrainView {
  kind: GrainKind
  /** The words for `not_read` / `empty`; null for `ok`. */
  text: string | null
  /** Above the grid, in order: a failed last read, numbers not read, days not read, a list cut at its cap. */
  notes: GrainNote[]
}

/**
 * What a grain shows. `read` is the list itself (structure, or the terms); `numbersRead` the daily numbers when they
 * come from another read (ad groups, keywords, asset groups, products). Pure, so each state is a test.
 */
export function grainView(input: {
  noun: Noun
  scope: GrainScope
  read: GoogleRead | null
  numbersRead?: GoogleRead | null
  coverage?: GoogleCoverage | null
  count: number
  /** The list has days (a window); negatives do not. */
  windowed: boolean
  truncated?: boolean
  nextReadAt: string | null
  timeZone?: string
}): GrainView {
  const { noun, scope, read, numbersRead, coverage, count, windowed, truncated, nextReadAt, timeZone } = input
  if (notReadYet(read)) return { kind: 'not_read', text: notReadText(noun, scope, read, nextReadAt, timeZone), notes: [] }
  const notes: GrainNote[] = []
  const failed = lastTryText(read)
  if (failed) notes.push({ tone: 'warning', text: `${failed} This shows the read of ${formatMoment(read!.readAt, timeZone) ?? DASH}.` })
  if (count === 0) return { kind: 'empty', text: emptyText(noun, scope, windowed), notes }
  if (numbersRead !== undefined && notReadYet(numbersRead)) {
    notes.push({ tone: 'info', text: `Nexus has not read the numbers of these ${noun.many} yet. They show as — until it does.` })
  } else if (windowed && coverage) {
    const gaps = coverageNote({ coverage })
    if (gaps) notes.push({ tone: 'warning', text: gaps })
  }
  if (truncated) notes.push({ tone: 'warning', text: truncatedText(noun, count) })
  return { kind: 'ok', text: null, notes }
}

export function truncatedText(noun: Noun, count: number): string {
  return `There are more ${noun.many} than this window loads at once. The list and its totals show the first ${formatInt(count)}.`
}

/** "Read 13 Oct 2026, 08:25" — when Nexus read the list; null when it never did. */
export function readLine(read: Pick<GoogleRead, 'readAt'> | null | undefined, timeZone?: string): string | null {
  const at = formatMoment(read?.readAt ?? null, timeZone)
  return at ? `Read from Google ${at}` : null
}

// ─── Words ──────────────────────────────────────────────────────────────

const MATCH: Readonly<Record<GoogleMatchType, string>> = { EXACT: 'Exact', PHRASE: 'Phrase', BROAD: 'Broad' }

export function matchTypeLabel(m: GoogleMatchType | null | undefined): string {
  return (m && MATCH[m]) || DASH
}

export const MATCH_TYPE_OPTIONS = (Object.keys(MATCH) as GoogleMatchType[]).map((value) => ({ value, label: MATCH[value] }))

/** Enabled / the other status Google gave / "Not read yet" (numbers seen, settings not read). */
export function entityStatusWord(status: EntityStatus | undefined): Word {
  return { text: campaignStatusLabel(status), tone: status === 'ENABLED' ? 'success' : 'neutral' }
}

const PRIMARY: Readonly<Record<string, Word | null>> = {
  ELIGIBLE: null,
  LIMITED: { text: 'Limited', tone: 'warning' },
  NOT_ELIGIBLE: { text: 'Not eligible', tone: 'danger' },
  LEARNING: { text: 'Learning', tone: 'neutral' },
  MISCONFIGURED: { text: 'Set-up incomplete', tone: 'warning' },
  PENDING: { text: 'Not started', tone: 'neutral' },
  ENDED: { text: 'Ended', tone: 'neutral' },
  PAUSED: null,
  REMOVED: null,
  UNSPECIFIED: null,
  UNKNOWN: null,
}

/** Google's primary status beyond the status itself ("Limited", "Not eligible"), or null when it adds nothing. */
export function primaryWord(e: { status: EntityStatus | undefined; primaryStatus: string | null }): Word | null {
  if (!e.status || e.status === 'REMOVED' || !e.primaryStatus) return null
  const code = e.primaryStatus.toUpperCase()
  return code in PRIMARY ? PRIMARY[code]! : { text: words(code), tone: 'neutral' }
}

/**
 * What stops a keyword showing, in Google's words: Disapproved, Under review, Rarely shown — else its primary status.
 * Null when nothing does (or the keyword is removed).
 */
export function keywordWord(k: { status: EntityStatus | undefined; approvalStatus: string | null; servingStatus: string | null; primaryStatus: string | null }): Word | null {
  if (!k.status || k.status === 'REMOVED') return null
  const approval = k.approvalStatus?.toUpperCase()
  if (approval === 'DISAPPROVED') return { text: 'Disapproved', tone: 'danger' }
  if (approval === 'UNDER_REVIEW' || approval === 'PENDING_REVIEW') return { text: 'Under review', tone: 'warning' }
  if (k.servingStatus?.toUpperCase() === 'RARELY_SERVED') return { text: 'Rarely shown', tone: 'warning' }
  return primaryWord(k)
}

const AD_GROUP_TYPE: Readonly<Record<string, string>> = {
  SEARCH_STANDARD: 'Standard',
  SEARCH_DYNAMIC_ADS: 'Dynamic search ads',
  SHOPPING_PRODUCT_ADS: 'Product ads',
  SHOPPING_SMART_ADS: 'Smart shopping',
  SHOPPING_COMPARISON_LISTING_ADS: 'Comparison listing ads',
  DISPLAY_STANDARD: 'Display',
  HOTEL_ADS: 'Hotel ads',
  UNSPECIFIED: DASH,
  UNKNOWN: DASH,
}

export function adGroupTypeLabel(type: string | null | undefined): string {
  if (!type) return DASH
  const code = type.toUpperCase()
  if (code in AD_GROUP_TYPE) return AD_GROUP_TYPE[code]!
  if (code.startsWith('VIDEO_')) return 'Video'
  return words(code)
}

const AD_STRENGTH: Readonly<Record<string, Word>> = {
  EXCELLENT: { text: 'Excellent', tone: 'success' },
  GOOD: { text: 'Good', tone: 'success' },
  AVERAGE: { text: 'Average', tone: 'warning' },
  POOR: { text: 'Poor', tone: 'danger' },
  PENDING: { text: 'Being rated', tone: 'neutral' },
  NO_ADS: { text: 'No ads', tone: 'neutral' },
}

/** Google's ad strength of an asset group; "—" when Google gave none. */
export function adStrengthWord(code: string | null | undefined): Word {
  if (!code) return { text: DASH, tone: 'neutral' }
  const c = code.toUpperCase()
  return AD_STRENGTH[c] ?? (c === 'UNSPECIFIED' || c === 'UNKNOWN' ? { text: DASH, tone: 'neutral' } : { text: words(c), tone: 'neutral' })
}

/** "example.com/shoes" or "example.com/shoes +2": the first final URL without its scheme, and how many more. */
export function finalUrlText(urls: readonly string[]): string {
  const list = urls.map((u) => u.trim()).filter(Boolean)
  if (!list.length) return DASH
  const first = list[0]!.replace(/^https?:\/\//i, '').replace(/\/$/, '')
  return list.length > 1 ? `${first} +${list.length - 1}` : first
}

const PRODUCT_STATUS: Readonly<Record<NonNullable<GoogleProduct['status']>, Word>> = {
  no_issue: { text: 'Eligible', tone: 'success' },
  limited: { text: 'Limited', tone: 'warning' },
  not_eligible: { text: 'Not eligible', tone: 'danger' },
}

/** Whether Google shows the product; "Not read yet" when Nexus has not read its status. */
export function productStatusWord(status: GoogleProduct['status'] | undefined): Word {
  return status ? PRODUCT_STATUS[status] : { text: 'Not read yet', tone: 'neutral' }
}

export const PRODUCT_STATUS_OPTIONS = (Object.keys(PRODUCT_STATUS) as Array<keyof typeof PRODUCT_STATUS>).map((value) => ({ value, label: PRODUCT_STATUS[value].text }))

/** Google's own sentences for a product's issues, one per line, most severe first. Never Nexus's guess. */
export function productIssuesText(p: Pick<GoogleProduct, 'issues'>): string | null {
  if (!p.issues.length) return null
  const rank = (s: string) => (/disapprov|not.?eligible|error/i.test(s) ? 0 : /demot|limit|warn/i.test(s) ? 1 : 2)
  return [...p.issues].sort((a, b) => rank(a.severity) - rank(b.severity)).map((i) => i.text.trim()).filter(Boolean).join('\n') || null
}

// ─── Brand ──────────────────────────────────────────────────────────────

/** Brand / Not brand; "—" when Nexus has no brand words (never "Not brand" for every term). */
export function brandLabel(brand: boolean | null | undefined): string {
  return brand === true ? 'Brand' : brand === false ? 'Not brand' : DASH
}

/** The brand filter's value for a term: '' when unknown, so "Brand" and "Not brand" both leave it out. */
export function brandKey(brand: boolean | null | undefined): '' | 'brand' | 'non_brand' {
  return brand === true ? 'brand' : brand === false ? 'non_brand' : ''
}

export const BRAND_FILTER_OPTIONS = [
  { value: 'brand', label: 'Brand' },
  { value: 'non_brand', label: 'Not brand' },
]

/** What counts as a brand search, in words; the words as the business keeps them, quoted. */
export function brandRuleText(terms: readonly string[], max = 8): string {
  const shown = terms.map((t) => t.trim()).filter(Boolean)
  if (!shown.length) return 'Nexus does not know your brand names yet, so it cannot split brand searches from the rest.'
  const listed = shown.slice(0, max).map((t) => `“${t}”`).join(', ')
  const more = shown.length - Math.min(shown.length, max)
  // "matches", not "contains": Nexus matches each protected term by its own match type (exact, starts with, contains).
  return `A search counts as brand when it matches one of your protected terms: ${listed}${more > 0 ? ` and ${more} more` : ''}.`
}

export const SEARCH_TERM_SCOPE_TEXT = 'Only searches that got at least one click. Google leaves out searches that few people made.'

// ─── Negatives ──────────────────────────────────────────────────────────

/** The negative itself: its words, or the brand list it excludes. */
export function negativeText(n: Pick<GoogleNegative, 'kind' | 'text' | 'listName'>): string {
  if (n.kind === 'brand_list') return n.listName?.trim() || n.text?.trim() || 'A brand list'
  return n.text?.trim() || DASH
}

export function negativeMatchLabel(n: Pick<GoogleNegative, 'kind' | 'matchType'>): string {
  return n.kind === 'brand_list' ? 'Brand list' : matchTypeLabel(n.matchType)
}

/** Where the negative is set: on an ad group, on the campaign, or in a list attached to it. */
export function negativeLevelText(n: Pick<GoogleNegative, 'level' | 'adGroupName' | 'listName'>): string {
  if (n.level === 'ad_group') return `Ad group: ${n.adGroupName?.trim() || DASH}`
  if (n.level === 'list') return `List: ${n.listName?.trim() || DASH}`
  return 'Campaign'
}

export const NEGATIVE_LEVEL_OPTIONS = [
  { value: 'campaign', label: 'Campaign' },
  { value: 'ad_group', label: 'Ad group' },
  { value: 'list', label: 'List' },
]

/** Negatives that still apply (a removed one blocks nothing), A→Z. */
export function activeNegatives(items: readonly GoogleNegative[]): GoogleNegative[] {
  return items
    .filter((n) => n.status !== 'REMOVED')
    .sort((a, b) => negativeText(a).localeCompare(negativeText(b), 'en', { sensitivity: 'base' }))
}

/**
 * R7 has three reads (the campaign's own negatives, its ad groups', the lists attached to it). As one: never read only
 * when none of the three was; `missing` names the parts not read yet, so the list never passes for complete.
 */
export function negativesRead(read: GoogleNegativesPage['read']): { read: GoogleRead; missing: string[] } {
  const parts: Array<[GoogleRead, string]> = [
    [read.campaign, 'the campaign’s own negative keywords'],
    [read.adGroup, 'the ad groups’ negative keywords'],
    [read.lists, 'the negative keyword lists'],
  ]
  const done = parts.filter(([r]) => !notReadYet(r))
  if (!done.length) return { read: read.campaign, missing: [] }
  return { read: done[0]![0], missing: parts.filter(([r]) => notReadYet(r)).map(([, words]) => words) }
}

export function negativesMissingText(missing: readonly string[]): string | null {
  if (!missing.length) return null
  const list = missing.length === 1 ? missing[0] : `${missing.slice(0, -1).join(', ')} and ${missing[missing.length - 1]}`
  return `Nexus has not read ${list} yet, so they are not in this list.`
}

export const NEGATIVE_LIST_COLUMNS = ['List', 'Negative keywords', 'Used by'] as const

/** The negative keyword lists attached to the campaign (a removed list blocks nothing), by name. */
export function negativeListRows(lists: readonly GoogleNegativeList[]): Array<{ id: string; cells: [name: string, keywords: string, usedBy: string] }> {
  return lists
    .filter((l) => l.status?.toUpperCase() !== 'REMOVED')
    .sort((a, b) => a.name.localeCompare(b.name, 'en', { sensitivity: 'base' }))
    .map((l) => ({
      id: l.listId,
      cells: [l.name, formatInt(l.memberCount), `${formatInt(l.campaigns.length)} ${l.campaigns.length === 1 ? 'campaign' : 'campaigns'}`],
    }))
}

// ─── Google acts on its own (one campaign) ─────────────────────────────

/** On / Off / "—" (does not apply to this campaign) / "Not read yet". `null` is never "Off". */
export function flagWord(f: Flag | undefined): Word {
  if (f === 'on') return { text: 'On', tone: 'warning' }
  if (f === 'off') return { text: 'Off', tone: 'neutral' }
  if (f === 'not_applicable') return { text: DASH, tone: 'neutral' }
  return { text: 'Not read yet', tone: 'neutral' }
}

export type ActsFlagKey = 'aiMax' | 'campaignBroadMatch' | 'finalUrlExpansion' | 'textCustomization' | 'searchPartners' | 'displayExpansion' | 'dynamicSearchAds'

export const ACTS_FLAGS: ReadonlyArray<{ key: ActsFlagKey; label: string; tip: string }> = [
  { key: 'aiMax', label: 'AI Max', tip: 'Google finds new searches and writes ad text from your site, beyond your keywords.' },
  { key: 'campaignBroadMatch', label: 'Broad match', tip: 'Every keyword also matches related searches.' },
  { key: 'finalUrlExpansion', label: 'Final URL expansion', tip: 'Google may send people to other pages of your site.' },
  { key: 'textCustomization', label: 'Text from your site', tip: 'Google writes headlines and descriptions from your site.' },
  { key: 'searchPartners', label: 'Search partners', tip: 'Ads also show on sites that partner with Google Search.' },
  { key: 'displayExpansion', label: 'Display expansion', tip: 'A Search campaign also shows ads on other websites.' },
  { key: 'dynamicSearchAds', label: 'Dynamic search ads', tip: 'Google picks searches from the pages of your site and writes the headline.' },
]

/** How many of the widening settings are on. Null when Nexus has read none of them. */
export function flagsOnCount(c: Pick<GoogleCampaignAutomation, ActsFlagKey>): number | null {
  const read = ACTS_FLAGS.map((f) => c[f.key]).filter((v) => v != null)
  return read.length ? read.filter((v) => v === 'on').length : null
}

const WHO: Readonly<Record<GoogleOutsideChange['who'], string>> = {
  google_auto_apply: 'Google, by auto-apply',
  google_recommendation: 'Google’s recommendation, applied',
  your_google_rules_or_scripts: 'Your rules or scripts in Google Ads',
  person: 'A person in Google Ads',
  api: 'Another tool, through the API',
  other: 'Other',
}

export function whoText(who: GoogleOutsideChange['who']): string {
  return WHO[who] ?? WHO.other
}

/** Google made it by itself (auto-apply or its automatic changes) — not a person. */
export function byGoogle(c: Pick<GoogleOutsideChange, 'who' | 'source'>): boolean {
  return c.who === 'google_auto_apply' || c.source === 'google_automatic'
}

export interface OutsideChangeRow {
  id: string
  cells: [when: string, who: string, what: string]
}

export const OUTSIDE_CHANGE_COLUMNS = ['When', 'Made by', 'What changed'] as const

/** One campaign's changes made outside Nexus (every change, since Nexus makes none yet), newest first, never an e-mail. */
export function campaignOutsideChanges(items: readonly GoogleOutsideChange[], externalCampaignId: string, timeZone?: string): OutsideChangeRow[] {
  return items
    .filter((c) => c.externalCampaignId === externalCampaignId)
    .sort((a, b) => (a.changedAt < b.changedAt ? 1 : -1))
    .map((c, i) => ({
      id: `${c.changedAt}:${i}`,
      cells: [formatMoment(c.changedAt, timeZone) ?? c.changedAt, whoText(c.who), withoutEmails(c.summary)],
    }))
}
