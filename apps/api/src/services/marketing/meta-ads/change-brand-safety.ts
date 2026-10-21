/**
 * Meta step 39 — set-meta-brand-safety as a draft (D6: the controls that need no Meta grant). Pure: the request and the
 * live state (live-brand-safety.ts) in, the draft (or a refusal in words) out. Master rows:
 *   BS-001 / TG-093  an ad set's inventory filter (`targeting.brand_safety_content_filter_levels`: per placement in-content
 *                    FACEBOOK_, Audience Network AN_, feeds FEED_ × RELAXED / STANDARD / STRICT = Expanded / Moderate /
 *                    Limited)
 *   BS-003 / TG-095  excluded publisher categories (dating, gambling; Audience Network and in-stream also
 *                    debated_social_issues, mature_audiences, tragedy_and_conflict)
 *   BS-004 / TG-096  block lists an ad set excludes (`excluded_publisher_list_ids`; each one the chosen ad account may use —
 *                    the gateway checks it)
 *   TG-094           content severity levels (`brand_safety_content_severity_levels`: values on no Meta page)
 *   TG-097           excluded content types (`excluded_brand_safety_content_types`, "for example Instream live gaming";
 *                    Meta's one documented value: INSTREAM_LIVE, feed-verification.md "Ad Set API" sample)
 *   AA-060           the ad account's inventory filter (POST /act_{id}/brand_safety_content_filter_levels; SDK only)
 * All of an ad set's are fields INSIDE its `targeting`, which Meta takes only whole (Q7: targeting-merge.ts): the request
 * sends the live spec with only these keys changed, and the gateway compares it with the live targeting itself.
 *
 * Meta's rules it follows (placement-targeting.md; best-practices.md "Ad changes triggering ad reviews"; reference/ad-campaign
 * "Updating" has no validate_only, facts F1 X2):
 *   - "When a filter is applied at the ad account level, only more restrictive options will be available at the campaign
 *     level": an ad-set level looser than the account's for the same placement is refused before any call; the effective
 *     level is "the most conservative merge" (Graph targeting reference, effective_brand_safety_content_filter_levels).
 *   - Any targeting change sends the ad set's ads back to Meta's review (a paused ad stays paused): said in the preview.
 *   - Meta has no check (validate_only) for an ad set update or the account's filter: "Meta has no check for this change".
 * Spending: a stricter filter, a category or block list added can only narrow where the ads show — no spend. A LOOSER
 * level, a category, list or content type removed, a level dropped (Meta's default for a placement with none set is not
 * documented, so it may be looser) and any change of the undocumented severity levels can widen delivery: on an ad set
 * that is on, that is SPENDS MONEY (the line says when its campaign is off, so nothing spends yet). At the account level,
 * a looser level is SPENDS MONEY when any campaign of the account delivers.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import { mergeTargeting } from './targeting-merge.js'
import {
  BRAND_SAFETY_TARGETING_KEYS, brandSafetyValueProblem, FILTER_STRENGTHS, MAX_TARGETING_BODY, surfaceOf, type BrandSafetyTargetingKey, type FilterStrength, type FilterSurface,
} from '../../gateway/meta-brand-safety-rules.js'
import type { AdSetSafetyState } from './live-brand-safety.js'

/** Meta's words in Ads Manager, and NONE (no level of Nexus's on that placement: Meta's default). */
export const FILTER_CHOICES = ['EXPANDED', 'MODERATE', 'LIMITED', 'NONE'] as const
export type FilterChoice = typeof FILTER_CHOICES[number]
export interface FilterLevelsChoice { inContent?: FilterChoice; audienceNetwork?: FilterChoice; feed?: FilterChoice }

const CHOICE_STRENGTH: Readonly<Record<Exclude<FilterChoice, 'NONE'>, FilterStrength>> = { EXPANDED: 'RELAXED', MODERATE: 'STANDARD', LIMITED: 'STRICT' }
const STRENGTH_WORD: Readonly<Record<FilterStrength, string>> = { RELAXED: 'Expanded', STANDARD: 'Moderate', STRICT: 'Limited' }
const SURFACE_OF_CHOICE: Readonly<Record<keyof FilterLevelsChoice, FilterSurface>> = { inContent: 'FACEBOOK', audienceNetwork: 'AN', feed: 'FEED' }
const SURFACE_WORD: Readonly<Record<FilterSurface, string>> = { FACEBOOK: 'in-content (Facebook in-stream, Reels)', AN: 'Audience Network', FEED: 'feeds' }

export interface AdSetSafetyChange {
  adSetId: string
  filterLevels?: FilterLevelsChoice
  addCategories?: string[]; removeCategories?: string[]
  addBlockLists?: string[]; removeBlockLists?: string[]
  /** The whole list (Meta's values; [] clears it). */
  severityLevels?: string[]
  addContentTypes?: string[]; removeContentTypes?: string[]
}
export interface BrandSafetyRequest { adSets?: AdSetSafetyChange[]; account?: { filterLevels: FilterLevelsChoice } }

/** The brand-safety keys of one targeting spec, each as a list (absent = []). */
export type SafetyValues = Record<BrandSafetyTargetingKey, string[]>
export interface BrandSafetyRecord {
  adSets?: Array<{ id: string; name: string | null; safety: SafetyValues }>
  account?: { levels: string[] }
}

const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
/** Review A5 — every list in one order (sorted), so a record and a later read compare equal whatever order Meta answers. */
export const sortSafety = (values: SafetyValues): SafetyValues =>
  Object.fromEntries(BRAND_SAFETY_TARGETING_KEYS.map((key) => [key, [...values[key]].sort()])) as SafetyValues
export const safetyOf = (targeting: Record<string, unknown>): SafetyValues =>
  sortSafety(Object.fromEntries(BRAND_SAFETY_TARGETING_KEYS.map((key) => [key, strings(targeting[key])])) as SafetyValues)
/** Review A4 — a brand-safety key Meta holds as anything but a list of names (a number, an object): never changed by Nexus. */
const notNames = (v: unknown): boolean => v !== undefined && v !== null && !(Array.isArray(v) && v.every((x) => typeof x === 'string'))
/** Meta's block-list caps per campaign (block-list.md "Thresholds"), said when an ad set gets a list (BS-004). */
const CAMPAIGN_LIST_CAPS = 'Meta caps what one campaign\'s block lists block: 1,000 publishers in in-stream videos and on Reels, 12,500 on Audience Network (native, banner, interstitial) and 3,400 in Audience Network rewarded videos (block-list.md, "Thresholds").'
const uniq = (list: string[]) => [...new Set(list)]
const sameSet = (a: readonly string[], b: readonly string[]) => a.length === b.length && new Set(a).size === new Set([...a, ...b]).size
const named = (s: AdSetSafetyState) => `ad set "${s.name ?? 'no name'}" (${s.id})`

/** The level a list holds for one placement (documented values only), or null. */
export function levelFor(levels: readonly string[], surface: FilterSurface): FilterStrength | null {
  const level = levels.find((l) => surfaceOf(l) === surface)
  return level ? level.slice(surface.length + 1) as FilterStrength : null
}
const rank = (s: FilterStrength | null) => (s ? FILTER_STRENGTHS.indexOf(s) : null)
/** An undocumented value of the account's list for that placement (FEED_SELECT, …), or null. */
const oddLevelFor = (levels: readonly string[], surface: FilterSurface) => levels.find((l) => l.startsWith(`${surface}_`) && !surfaceOf(l)) ?? null

/** The levels after the change: each placement named replaced (or dropped for NONE), the rest kept in place. */
export function applyLevels(current: readonly string[], choice: FilterLevelsChoice): string[] {
  let out = [...current]
  for (const [arg, surface] of Object.entries(SURFACE_OF_CHOICE) as Array<[keyof FilterLevelsChoice, FilterSurface]>) {
    const wanted = choice[arg]
    if (!wanted) continue
    const next = wanted === 'NONE' ? null : `${surface}_${CHOICE_STRENGTH[wanted]}`
    const at = out.findIndex((l) => l.startsWith(`${surface}_`))
    if (at >= 0) out = next ? out.map((l, i) => (i === at ? next : l)) : out.filter((_, i) => i !== at)
    else if (next) out.push(next)
  }
  return out
}

/**
 * Is moving one placement from `before` to `after` looser, given the account's own level (the effective level is the
 * stricter of the two)? A placement with no level at all reads as Meta's default, which is not documented: moving to it
 * is looser unless it was already the loosest; moving from it is looser unless to the strictest.
 */
export function looserLevel(before: FilterStrength | null, after: FilterStrength | null, account: FilterStrength | null): boolean {
  const eff = (x: FilterStrength | null) => { const r = rank(x); const a = rank(account); return r === null ? a : a === null ? r : Math.max(r, a) }
  const b = eff(before)
  const a = eff(after)
  if (a === b) return false
  if (a !== null && b !== null) return a < b
  if (a === null) return (b ?? 0) > 0
  return a < FILTER_STRENGTHS.length - 1
}

const words = (strength: FilterStrength | null) => (strength ? STRENGTH_WORD[strength] : 'none set (Meta\'s default)')

/** What the change loosens on one ad set, in words (empty: it can only narrow where the ads show). */
function looserParts(before: SafetyValues, after: SafetyValues, account: readonly string[]): string[] {
  const out: string[] = []
  for (const surface of ['FACEBOOK', 'AN', 'FEED'] as const) {
    const b = levelFor(before.brand_safety_content_filter_levels, surface)
    const a = levelFor(after.brand_safety_content_filter_levels, surface)
    if (b !== a && looserLevel(b, a, levelFor(account, surface))) out.push(`the ${SURFACE_WORD[surface]} inventory filter from ${words(b)} to ${words(a)}`)
  }
  const removed = (key: BrandSafetyTargetingKey) => before[key].filter((v) => !after[key].includes(v))
  if (removed('excluded_publisher_categories').length) out.push(`no longer excluding ${removed('excluded_publisher_categories').join(', ')}`)
  if (removed('excluded_publisher_list_ids').length) out.push(`no longer excluding block list ${removed('excluded_publisher_list_ids').join(', ')}`)
  if (removed('excluded_brand_safety_content_types').length) out.push(`no longer excluding content type ${removed('excluded_brand_safety_content_types').join(', ')}`)
  if (!sameSet(before.brand_safety_content_severity_levels, after.brand_safety_content_severity_levels)) out.push('the content severity levels (Meta does not document their values, so Nexus cannot tell whether the change narrows or widens delivery)')
  return out
}

const list = (v: readonly string[]) => (v.length ? `[${v.join(', ')}]` : 'none')

/** The read-back judge of an ad set's change: the keys it set, as Meta reads them now (order aside). */
export function adSetJudge(wanted: Partial<SafetyValues>) {
  return (node: Record<string, unknown>) => {
    const targeting = node.targeting && typeof node.targeting === 'object' && !Array.isArray(node.targeting) ? node.targeting as Record<string, unknown> : {}
    const keys = Object.keys(wanted) as BrandSafetyTargetingKey[]
    const moved = keys.filter((key) => !sameSet(strings(targeting[key]), wanted[key] ?? []))
    return { moved, reads: keys.map((key) => `${key} ${list(strings(targeting[key]))}`).join(', ') || 'as before' }
  }
}

/** The read-back judge of the account's filter: its levels as Meta reads them now (order aside). */
export function accountJudge(wanted: readonly string[]) {
  return (node: Record<string, unknown>) => {
    const levels = strings(node.brand_safety_content_filter_levels)
    return { moved: sameSet(levels, wanted) ? [] : ['brand_safety_content_filter_levels'], reads: `brand_safety_content_filter_levels ${list(levels)}` }
  }
}

const REVIEW = 'Meta sends every ad of a changed ad set back to its review after a targeting change (an ad that is paused stays paused); an ad under review may not deliver for a while.'

export interface AdSetSafetyLive { adSets: Map<string, AdSetSafetyState>; accountLevels: string[] }

export function adSetSafetyDraft(request: AdSetSafetyChange[], live: AdSetSafetyLive): MetaChangeDraft | { refusal: string } {
  if (!request.length) return { refusal: 'Name at least one ad set.' }
  const seen = new Set<string>()
  for (const item of request) {
    if (seen.has(item.adSetId)) return { refusal: `Ad set ${item.adSetId} is named twice: name each ad set once.` }
    seen.add(item.adSetId)
    const changes = [item.filterLevels && Object.keys(item.filterLevels).length, item.addCategories?.length, item.removeCategories?.length, item.addBlockLists?.length, item.removeBlockLists?.length,
      item.severityLevels !== undefined, item.addContentTypes?.length, item.removeContentTypes?.length]
    if (!changes.some(Boolean)) return { refusal: `Say what to change on ad set ${item.adSetId} (filterLevels, categories, block lists, severity levels or content types).` }
    for (const [add, remove, what] of [[item.addCategories, item.removeCategories, 'category'], [item.addBlockLists, item.removeBlockLists, 'block list'], [item.addContentTypes, item.removeContentTypes, 'content type']] as const) {
      const both = (add ?? []).filter((v) => (remove ?? []).includes(v))
      if (both.length) return { refusal: `Ad set ${item.adSetId}: ${what} ${both.join(', ')} is both added and removed.` }
    }
  }
  const account = live.accountLevels
  const refusals: string[] = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const requests: MetaChangeRequest[] = []
  const lines: Array<[string, unknown, unknown]> = []
  const before: NonNullable<BrandSafetyRecord['adSets']> = []
  const after: NonNullable<BrandSafetyRecord['adSets']> = []
  const stands: unknown[] = []
  let undocumented = false
  for (const item of request) {
    const state = live.adSets.get(item.adSetId)
    if (!state) { refusals.push(`Nexus could not read ad set ${item.adSetId} from Meta.`); continue }
    const who = named(state)
    const now = safetyOf(state.targeting)
    // Review A8 — a placement whose live level is not one Meta documents (e.g. FEED_SELECT) is never changed by Nexus.
    const oddNamed = item.filterLevels ? (Object.entries(SURFACE_OF_CHOICE) as Array<[keyof FilterLevelsChoice, FilterSurface]>)
      .filter(([arg]) => item.filterLevels![arg]).map(([, surface]) => oddLevelFor(now.brand_safety_content_filter_levels, surface)).find(Boolean) : null
    if (oddNamed) { refusals.push(`${who}: its level for that placement reads ${oddNamed}, a value Meta does not document, so Nexus does not change it (and could not put it back): change it in Ads Manager.`); continue }
    const next: SafetyValues = {
      brand_safety_content_filter_levels: item.filterLevels ? applyLevels(now.brand_safety_content_filter_levels, item.filterLevels) : now.brand_safety_content_filter_levels,
      excluded_publisher_categories: uniq([...now.excluded_publisher_categories, ...(item.addCategories ?? [])]).filter((v) => !(item.removeCategories ?? []).includes(v)),
      excluded_publisher_list_ids: uniq([...now.excluded_publisher_list_ids, ...(item.addBlockLists ?? [])]).filter((v) => !(item.removeBlockLists ?? []).includes(v)),
      brand_safety_content_severity_levels: item.severityLevels !== undefined ? uniq(item.severityLevels) : now.brand_safety_content_severity_levels,
      excluded_brand_safety_content_types: uniq([...now.excluded_brand_safety_content_types, ...(item.addContentTypes ?? [])]).filter((v) => !(item.removeContentTypes ?? []).includes(v)),
    }
    // "Only more restrictive options are available at the campaign level": never looser than the account's own level.
    for (const surface of ['FACEBOOK', 'AN', 'FEED'] as const) {
      const set = levelFor(next.brand_safety_content_filter_levels, surface)
      if (!set || set === levelFor(now.brand_safety_content_filter_levels, surface)) continue
      const accountLevel = levelFor(account, surface)
      if (accountLevel && rank(set)! < rank(accountLevel)!) refusals.push(`${who}: the ${SURFACE_WORD[surface]} level ${words(set)} is looser than the ad account's own (${words(accountLevel)}); Meta allows only a level at least as strict per ad set.`)
      const odd = oddLevelFor(account, surface)
      if (odd) warnings.push(`The ad account's ${SURFACE_WORD[surface]} filter reads ${odd}, a value Meta does not document an order for: Meta judges whether ${who}'s ${words(set)} is allowed.`)
    }
    const set: Record<string, unknown> = {}
    for (const key of BRAND_SAFETY_TARGETING_KEYS) {
      if (sameSet(now[key], next[key])) continue
      set[key] = next[key].length ? next[key] : null
    }
    const odd = Object.keys(set).find((key) => notNames(state.targeting[key]))
    if (odd) { refusals.push(`${who}: Meta holds its ${odd} as ${JSON.stringify(state.targeting[odd]).slice(0, 80)}, not a list of names, so Nexus changes nothing there (change it in Ads Manager).`); continue }
    // A key the change sets is judged as the gateway judges it: a value Meta wrote that Nexus does not send (an undocumented
    // level, a category Nexus does not know) is refused here, not at the run.
    const judged = Object.entries(set).filter(([, v]) => v !== null).map(([key, v]) => brandSafetyValueProblem(key as BrandSafetyTargetingKey, v)).find(Boolean)
    if (judged) { refusals.push(`${who}: ${judged} — Meta's own value there is one Nexus does not send; change that part in Ads Manager.`); continue }
    const merge = mergeTargeting(state.targeting, set)
    if (!merge.changed.length) { skipped.push(`${who} already has these brand-safety settings.`); continue }
    // Measured as the gateway measures it: the form body as sent.
    if (new URLSearchParams({ targeting: merge.sent }).toString().length > MAX_TARGETING_BODY) {
      refusals.push(`${who}'s targeting is too large for one Nexus change (Meta takes it only whole); change its brand safety in Ads Manager.`)
      continue
    }
    if (item.severityLevels !== undefined || item.addContentTypes?.length || item.removeContentTypes?.length) undocumented = true
    const looser = looserParts(now, next, account)
    const on = state.status === 'ACTIVE'
    if (looser.length && on) {
      spendsMoney.push(state.campaign?.status === 'ACTIVE'
        ? `${who} is on: ${looser.join('; ')} can widen where its ads show and what they spend.`
        : `${who}: ${looser.join('; ')} can widen where its ads show — nothing spends yet, its campaign "${state.campaign?.name ?? 'no name'}" (${state.campaign?.id ?? '?'}) is not on; it spends once that is switched on.`)
    } else if (looser.length) {
      warnings.push(`${who} is not on: ${looser.join('; ')} widens where its ads can show once it is switched on (switching it on is SPENDS MONEY then).`)
    }
    for (const c of merge.changed) lines.push([`${who}: ${c.key}`, c.from ?? 'none', c.to ?? 'none'])
    const wanted = Object.fromEntries(Object.keys(set).map((key) => [key, next[key as BrandSafetyTargetingKey]])) as Partial<SafetyValues>
    requests.push({
      step: requests.length + 1,
      label: `Brand safety of ${who}`,
      kind: 'adset',
      // Its own kind on the gateway: an ad set's targeting (Q7), never step 18's ad set settings.
      objectKind: 'adsettargeting',
      objectId: state.id,
      params: { targeting: merge.sent },
      check: 'none',
      raisesSpend: looser.length > 0 && on,
      readBackInPost: false,
      budget: false,
      undoable: true,
      operation: 'adset.brandSafety',
      readBackFields: 'id,targeting',
      judge: adSetJudge(wanted),
    })
    if (item.addBlockLists?.length && !warnings.includes(CAMPAIGN_LIST_CAPS)) warnings.push(CAMPAIGN_LIST_CAPS)
    before.push({ id: state.id, name: state.name, safety: now })
    after.push({ id: state.id, name: state.name, safety: sortSafety(next) })
    stands.push({ id: state.id, status: state.status, campaign: state.campaign?.status ?? null, safety: now })
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  if (!requests.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  warnings.push(REVIEW)
  warnings.push('Each ad set\'s whole targeting is sent (Meta takes it only whole): every other part of it goes back exactly as Meta has it now, and Nexus\'s gateway reads it again itself and sends nothing if anything else would change.')
  if (undocumented) warnings.push('Meta documents no values for content severity levels, and only one example for excluded content types (INSTREAM_LIVE, live videos in in-stream): Nexus sends them as given and Meta\'s answer says whether it takes them.')
  const { changes, more } = changeLines(lines)
  return {
    summary: requests.length <= 3 ? `Meta: ${requests.map((r) => r.label).join('; ')}.` : `Meta: brand safety of ${plural(requests.length, 'ad set')} — one request per ad set.`,
    changes,
    totals: { adSets: requests.length, requests: requests.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings, spendsMoney, skipped, requests,
    stands: { adSets: stands, accountLevels: account },
    before: { adSets: before } satisfies BrandSafetyRecord,
    after: { adSets: after } satisfies BrandSafetyRecord,
  }
}

export function accountSafetyDraft(choice: FilterLevelsChoice, live: { adAccountId: string; accountLevels: string[]; delivering: boolean | null }): MetaChangeDraft | { refusal: string } {
  const entries = Object.entries(choice).filter(([, v]) => !!v) as Array<[keyof FilterLevelsChoice, FilterChoice]>
  if (!entries.length) return { refusal: 'Say which placement\'s level to set on the ad account (inContent, audienceNetwork, feed).' }
  if (entries.some(([, v]) => v === 'NONE')) return { refusal: 'Meta documents no way to clear the ad account\'s inventory filter by API: name a level (EXPANDED, MODERATE or LIMITED) for each placement, or clear it in Meta\'s Brand Safety and Suitability hub.' }
  const now = live.accountLevels
  // Review A8 — a placement whose account level is not one Meta documents is never changed (nor put back) by Nexus.
  const oddNamed = entries.map(([arg]) => oddLevelFor(now, SURFACE_OF_CHOICE[arg])).find(Boolean)
  if (oddNamed) return { refusal: `The ad account's level for that placement reads ${oddNamed}, a value Meta does not document, so Nexus does not change it: a person changes it in Meta's Brand Safety and Suitability hub.` }
  const next = applyLevels(now, choice)
  const odd = next.filter((l) => !surfaceOf(l))
  if (odd.length) return { refusal: `The ad account's filter also reads ${odd.join(', ')}, which Meta does not document; Nexus sends only documented levels, so set that placement too (or change it in Meta's Brand Safety and Suitability hub).` }
  if (sameSet(now, next)) return { refusal: `Nothing to change: the ad account's inventory filter already reads ${list(now)}.` }
  const looser: string[] = []
  const lines: Array<[string, unknown, unknown]> = []
  for (const surface of ['FACEBOOK', 'AN', 'FEED'] as const) {
    const b = levelFor(now, surface)
    const a = levelFor(next, surface)
    if (b === a) continue
    lines.push([`the ad account's ${SURFACE_WORD[surface]} filter`, words(b), words(a)])
    if (looserLevel(b, a, null)) looser.push(`the ${SURFACE_WORD[surface]} filter from ${words(b)} to ${words(a)}`)
  }
  const spendsMoney = looser.length && live.delivering !== false
    ? [`Loosening the ad account's inventory filter (${looser.join('; ')}) widens where EVERY campaign's ads can show${live.delivering === null ? ' (Nexus could not read whether a campaign delivers now)' : ' — campaigns of this account deliver now'}.`]
    : []
  const warnings = [
    'The ad account\'s inventory filter applies to every campaign and ad set of the account: an ad set may then only be as strict or stricter.',
    'Meta documents setting the account\'s filter only in its own SDK (no reference page): if Meta refuses it, its own words say why, and a person sets it in Meta\'s Brand Safety and Suitability hub.',
    ...(looser.length && live.delivering === false ? [`Loosening it (${looser.join('; ')}) spends nothing yet: no campaign of the account delivers now.`] : []),
  ]
  const act = `act_${live.adAccountId}`
  const { changes } = changeLines(lines)
  const request: MetaChangeRequest = {
    step: 1,
    label: `Set the ad account's inventory filter to ${list(next)}`,
    objectKind: 'adaccount',
    objectId: act,
    params: { brand_safety_content_filter_levels: JSON.stringify(next) },
    check: 'none',
    raisesSpend: looser.length > 0,
    readBackInPost: false,
    budget: false,
    undoable: true,
    operation: 'adAccount.brandSafetyFilter',
    edge: 'brand_safety_content_filter_levels',
    readBackOf: act,
    readBackFields: 'id,brand_safety_content_filter_levels',
    judge: accountJudge(next),
  }
  return {
    summary: `Meta: ${request.label}.`,
    changes, totals: { requests: 1 }, warnings, spendsMoney, skipped: [], requests: [request],
    stands: { accountLevels: now, delivering: looser.length ? live.delivering : 'not read' },
    before: { account: { levels: [...now].sort() } } satisfies BrandSafetyRecord,
    after: { account: { levels: [...next].sort() } } satisfies BrandSafetyRecord,
  }
}

/** Undo — the arguments that put each ad set's (or the account's) brand-safety keys back as `before` from `after`. */
export function brandSafetyUndoArgs(before: BrandSafetyRecord, after: BrandSafetyRecord): { adSets: AdSetSafetyChange[] } | { account: { filterLevels: FilterLevelsChoice } } | { refusal: string } {
  if (before.account && after.account) {
    const choice: FilterLevelsChoice = {}
    for (const [arg, surface] of Object.entries(SURFACE_OF_CHOICE) as Array<[keyof FilterLevelsChoice, FilterSurface]>) {
      const b = levelFor(before.account.levels, surface)
      const a = levelFor(after.account.levels, surface)
      if (b === a) continue
      if (!b) return { refusal: `Before this change the ad account had no ${SURFACE_WORD[surface]} filter, and Meta documents no way to clear one by API: a person clears it in Meta's Brand Safety and Suitability hub.` }
      choice[arg] = (Object.keys(CHOICE_STRENGTH) as Array<keyof typeof CHOICE_STRENGTH>).find((c) => CHOICE_STRENGTH[c] === b)!
    }
    return Object.keys(choice).length ? { account: { filterLevels: choice } } : { refusal: 'This change left the ad account\'s filter as it was: nothing to put back.' }
  }
  const afterById = new Map((after.adSets ?? []).map((a) => [a.id, a.safety]))
  const items: AdSetSafetyChange[] = []
  for (const b of before.adSets ?? []) {
    const a = afterById.get(b.id)
    if (!a) continue
    const item: AdSetSafetyChange = { adSetId: b.id }
    const levels: FilterLevelsChoice = {}
    for (const [arg, surface] of Object.entries(SURFACE_OF_CHOICE) as Array<[keyof FilterLevelsChoice, FilterSurface]>) {
      const was = levelFor(b.safety.brand_safety_content_filter_levels, surface)
      if (was === levelFor(a.brand_safety_content_filter_levels, surface)) continue
      levels[arg] = was ? (Object.keys(CHOICE_STRENGTH) as Array<keyof typeof CHOICE_STRENGTH>).find((c) => CHOICE_STRENGTH[c] === was)! : 'NONE'
    }
    if (Object.keys(levels).length) item.filterLevels = levels
    const diff = (key: BrandSafetyTargetingKey) => ({ add: b.safety[key].filter((v) => !a[key].includes(v)), remove: a[key].filter((v) => !b.safety[key].includes(v)) })
    const cats = diff('excluded_publisher_categories')
    if (cats.add.length) item.addCategories = cats.add
    if (cats.remove.length) item.removeCategories = cats.remove
    const lists = diff('excluded_publisher_list_ids')
    if (lists.add.length) item.addBlockLists = lists.add
    if (lists.remove.length) item.removeBlockLists = lists.remove
    if (!sameSet(b.safety.brand_safety_content_severity_levels, a.brand_safety_content_severity_levels)) item.severityLevels = b.safety.brand_safety_content_severity_levels
    const types = diff('excluded_brand_safety_content_types')
    if (types.add.length) item.addContentTypes = types.add
    if (types.remove.length) item.removeContentTypes = types.remove
    if (Object.keys(item).length > 1) items.push(item)
  }
  return items.length ? { adSets: items } : { refusal: 'This change left every ad set as it was: nothing to put back.' }
}
