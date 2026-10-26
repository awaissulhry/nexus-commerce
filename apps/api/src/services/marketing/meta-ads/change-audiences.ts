/**
 * Meta ads step 31 — the drafts of the audience changes (pure: the request and the live state in, the requests Meta gets
 * out — what a person reads, the facts it stands on, what it replaces and writes for undo):
 *   create-meta-audience        a customer list (empty) or value-based seed, a website, engagement, offline, video or
 *                               catalog audience, a lookalike (each tier its own request) — AU-021, 030, 032–038, 040,
 *                               041, 043, 049–053 (AU-047, AU-064: said why not)
 *   set-meta-audience           name, description, rule, opt-out link, lookalike size, customer-file source, labels,
 *                               retention, product set, allowed domains, campaign / product use; the account's existing-
 *                               customer audiences and audience-type URL tags — AU-057–062, 074, 075
 *   set-meta-audience-members   add / replace consenting Shopify buyers (hashed e-mails, only while the business's switch
 *                               "Upload customer lists to Meta" is on and Meta's terms are signed: D8, consent PR 2);
 *                               remove / opt out everywhere the people who said no — AU-022–029
 *   set-meta-audience-sharing   share / unshare with ad accounts — AU-065, 066
 *   remove-meta-audience        delete, lookalikes first — AU-054, 063
 * Meta documents no validate_only on any custom-audience edge (facts F1 §M8): every request is `check: 'none'`. An
 * audience is never what spends money; what can let ads that use one spend more is said as SPENDS MONEY — review A2:
 * ANY change of who is in an audience that ads use (here or in an account it is shared with), in either direction (an ad
 * set may target it or exclude it), people taken out of it, every opt-out everywhere, labels value rules may raise bids
 * for, and a new existing-customer list that active ad sets read (A3).
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { AudienceDetail, AudienceSharing, AudienceUse, TermsState } from './live-audience-change.js'
import { memberBatches, MAX_PEOPLE, NO_CONSENT, replaceBatches, type HashedPeople } from './audience-members.js'
import {
  audienceRuleProblem, lookalikeRatioOk, lookalikeSpecProblem, OPT_OUT_LINK, type AudienceSourceType,
  AUDIENCE_LABELS, CUSTOMER_FILE_SOURCES, LOOKALIKE_TYPES, PRODUCT_EVENTS, SHARE_PERMISSIONS, USE_FOR_PRODUCTS, VIDEO_EVENTS,
} from '../../gateway/meta-audience-rules.js'
import { typedTextOk } from '../../gateway/meta-settings-rules.js'
import { META_NAME_TEXT, META_STRICT_TEXT } from '../../gateway/meta-write-text.js'

export type AudienceLabel = typeof AUDIENCE_LABELS[number]
export type CustomerFileSource = typeof CUSTOMER_FILE_SOURCES[number]
export type VideoEvent = typeof VIDEO_EVENTS[number]
export type ProductEvent = typeof PRODUCT_EVENTS[number]
export type LookalikeType = typeof LOOKALIKE_TYPES[number]
export type SharePermission = typeof SHARE_PERMISSIONS[number]
export type UseForProduct = typeof USE_FOR_PRODUCTS[number]

/** An audience rule in Meta's own syntax (audiences/guides/audience-rules), as the tools take it. */
export interface AudienceRuleArg {
  inclusions: { operator: 'and' | 'or'; rules: AudienceRuleItem[] }
  exclusions?: { operator: 'and' | 'or'; rules: AudienceRuleItem[] }
}
export interface AudienceRuleItem {
  event_sources: Array<{ id: string; type: AudienceSourceType }>
  retention_seconds: number
  filter?: unknown
  aggregation?: unknown
}

const DAY = 86_400
/** The longest retention Meta documents per event source (engagement-custom-audiences "Max retention days", audience-rules). */
const MAX_RETENTION_DAYS: Readonly<Record<AudienceSourceType, number>> = {
  pixel: 365, offline_events: 365, page: 730, ig_business: 730, canvas: 730, lead: 90, ig_lead_generation: 90, shopping_page: 365, shopping_ig: 365,
}
const WEBSITE_SOURCES: readonly AudienceSourceType[] = ['pixel']
const OFFLINE_SOURCES: readonly AudienceSourceType[] = ['offline_events']
const ENGAGEMENT_SOURCES: readonly AudienceSourceType[] = ['page', 'ig_business', 'lead', 'ig_lead_generation', 'canvas', 'shopping_page', 'shopping_ig']

/**
 * One request of an audience change. `kind` is step 17's status kind and is not read for these requests: `objectKind`
 * names the object the gateway confirms (an audience, or the ad account itself), and every request names its operation.
 */
function audienceRequest(step: number, label: string, o: {
  objectId: string; objectKind: 'customaudience' | 'adaccount'; params: Record<string, string>; operation: string
  edge?: MetaChangeRequest['edge']; method?: 'DELETE'; expect?: Record<string, string>; readBackFields?: string; raisesSpend?: boolean; undoable?: boolean
  /** Consent PR 2 — what the plan's hash reads instead of the params (a replace's new session id left out). */
  planParams?: Record<string, string>
  /** Consent PR 2 — the earlier steps it goes after only when they happened (a replace session's next batch). */
  needs?: number[]
}): MetaChangeRequest {
  return {
    step, label, kind: 'campaign', objectId: o.objectId, params: o.params,
    check: 'none', raisesSpend: o.raisesSpend ?? false, readBackInPost: false, budget: false, undoable: o.undoable ?? false,
    operation: o.operation, objectKind: o.objectKind,
    ...(o.edge ? { edge: o.edge } : {}), ...(o.method ? { method: o.method } : {}), ...(o.expect ? { expect: o.expect } : {}), ...(o.readBackFields ? { readBackFields: o.readBackFields } : {}),
    ...(o.planParams ? { planParams: o.planParams } : {}), ...(o.needs?.length ? { needs: o.needs } : {}),
  }
}

const quoted = (name: string | null) => (name ? `"${name}"` : '(no name)')
const who = (a: Pick<AudienceDetail, 'id' | 'name'>) => `audience ${quoted(a.name)} (${a.id})`
const termsRefusal = (terms: TermsState) => `Meta's Custom Audience terms are not signed for this ad account, so Meta makes no custom audience for it and takes no customer list. A person (never a system user) signs them in Meta for the business that owns the ad account: ${terms.signLink} — then ask again.`

/** The sources a rule uses, and why they are not the kind's, or its retention is longer than Meta keeps them. */
function ruleSourcesProblem(rule: AudienceRuleArg, allowed: readonly AudienceSourceType[], what: string): string | null {
  const shape = audienceRuleProblem(rule)
  if (shape) return `The rule is not one Nexus sends: ${shape}.`
  for (const set of [rule.inclusions, rule.exclusions]) {
    for (const r of set?.rules ?? []) {
      const bad = r.event_sources.find((s) => !allowed.includes(s.type))
      if (bad) return `A ${what} audience's rule takes event sources of type ${allowed.join(', ')} only (this one names ${bad.type}).`
      const max = Math.min(...r.event_sources.map((s) => MAX_RETENTION_DAYS[s.type]))
      if (r.retention_seconds > max * DAY) return `Meta keeps people of a ${r.event_sources[0].type} source at most ${max} days (retention_seconds ${max * DAY}).`
      if (r.retention_seconds === 0 && what !== 'engagement') return 'retention_seconds 0 is only for a Page\'s current fans (page_liked); give the days to keep people.'
    }
  }
  return null
}

/** Event names a rule filters on that Meta may not offer in Europe (engagement-custom-audiences). */
const EUROPE_MAYBE = /"(page_messaged|ig_user_messaged_business)"/

// ── create-meta-audience ────────────────────────────────────────────────────────────────────────────────────────────

export const CREATE_KINDS = ['customer_list', 'value_seed', 'website', 'engagement', 'offline', 'video', 'catalog', 'lookalike'] as const
export type AudienceCreateKind = typeof CREATE_KINDS[number]
const KIND_WORDS: Readonly<Record<AudienceCreateKind, string>> = {
  customer_list: 'customer list', value_seed: 'value-based customer list', website: 'website', engagement: 'engagement', offline: 'offline activity',
  video: 'video viewers', catalog: 'catalog product', lookalike: 'lookalike',
}

export interface AudienceCreateRequest {
  kind: AudienceCreateKind
  name: string
  description?: string
  customerFileSource?: CustomerFileSource
  retentionDays?: number
  labels?: AudienceLabel[]
  optOutLink?: string
  rule?: AudienceRuleArg
  prefill?: boolean
  video?: { videoIds: string[]; event: VideoEvent }
  catalog?: { productSetId: string; include: Array<{ event: ProductEvent; days: number }>; exclude?: Array<{ event: ProductEvent; days: number }>; pixelId?: string }
  lookalike?: {
    seedAudienceId?: string; campaignIds?: string[]; adSetIds?: string[]; pageFans?: boolean
    type?: LookalikeType; percent?: number; fromPercent?: number; tiers?: Array<{ fromPercent: number; toPercent: number }>; allowInternationalSeeds?: boolean
  }
}

export interface AudienceCreateLive {
  adAccountId: string
  terms: TermsState
  sameName: { ids: string[]; checked: boolean }
  /** The lookalike's seed audience (the chosen account's own), when it learns from one. */
  seed: AudienceDetail | null
  pageId: string | null
  /** Whose every id named inside it is (audience-ids.ts, ownPixel, the catalog rule): the problems in words. */
  idProblems: string[]
}

export interface AudienceCreateRecord { created: Array<{ audienceId: string | null; name: string; kind: AudienceCreateKind }> }

/** What a new audience is built from, for its kind (the other kinds' arguments are refused in words). */
const KIND_ARGS: Readonly<Record<AudienceCreateKind, ReadonlyArray<keyof AudienceCreateRequest>>> = {
  customer_list: ['customerFileSource', 'retentionDays', 'labels', 'optOutLink'],
  value_seed: ['customerFileSource', 'retentionDays', 'optOutLink'],
  website: ['rule', 'prefill', 'retentionDays', 'labels'],
  engagement: ['rule', 'prefill'],
  offline: ['rule'],
  video: ['video', 'prefill'],
  catalog: ['catalog'],
  lookalike: ['lookalike'],
}
const ALL_KIND_ARGS: ReadonlyArray<keyof AudienceCreateRequest> = ['customerFileSource', 'retentionDays', 'labels', 'optOutLink', 'rule', 'prefill', 'video', 'catalog', 'lookalike']

export function createAudienceDraft(request: AudienceCreateRequest, live: AudienceCreateLive): MetaChangeDraft | { refusal: string } {
  const { kind } = request
  const stray = ALL_KIND_ARGS.filter((k) => request[k] !== undefined && !KIND_ARGS[kind].includes(k))
  if (stray.length) return { refusal: `A ${KIND_WORDS[kind]} audience takes ${KIND_ARGS[kind].join(', ') || 'no more arguments'}, not ${stray.join(', ')}.` }
  if (!live.terms.signed) return { refusal: termsRefusal(live.terms) }
  if (live.idProblems.length) return { refusal: `Not built: ${live.idProblems.join(' ')}` }
  const base: Record<string, string> = { name: request.name, ...(request.description ? { description: request.description } : {}) }
  const warnings: string[] = []
  const account = `act_${live.adAccountId}`
  let params: Array<{ name: string; params: Record<string, string> }> = []
  let edge: 'customaudiences' | 'product_audiences' = 'customaudiences'

  switch (kind) {
    case 'customer_list':
    case 'value_seed': {
      // AU-021 / AU-030 — an EMPTY customer list: people come only with set-meta-audience-members (D8, consent PR 2).
      params = [{ name: request.name, params: {
        ...base, subtype: 'CUSTOM', customer_file_source: request.customerFileSource ?? 'USER_PROVIDED_ONLY',
        ...(request.labels?.length ? { audience_labels: JSON.stringify(request.labels) } : {}),
        ...(request.retentionDays ? { retention_days: String(request.retentionDays) } : {}),
        ...(request.optOutLink ? { opt_out_link: request.optOutLink } : {}),
        ...(kind === 'value_seed' ? { is_value_based: 'true' } : {}),
      } }]
      warnings.push(kind === 'value_seed'
        ? 'It starts EMPTY and Nexus adds nobody to it: a value-based list takes people with a value each (LOOKALIKE_VALUE), which Nexus does not send.'
        : 'It starts EMPTY. Nexus adds people to it only with set-meta-audience-members (mode add or replace): the hashed e-mails of Shopify buyers who said yes to the business\'s e-mail, and only while the business\'s switch "Upload customer lists to Meta" is on.')
      if (kind === 'value_seed') warnings.push('A value-based seed needs Meta\'s value-based lookalike terms signed for this ad account too (facebook.com/customaudiences/value_based/tos.php): Meta\'s answer decides.')
      break
    }
    case 'website':
    case 'engagement':
    case 'offline': {
      if (!request.rule) return { refusal: `A ${KIND_WORDS[kind]} audience needs its rule (Meta's audience-rule syntax).` }
      const problem = ruleSourcesProblem(request.rule, kind === 'website' ? WEBSITE_SOURCES : kind === 'offline' ? OFFLINE_SOURCES : ENGAGEMENT_SOURCES, kind)
      if (problem) return { refusal: problem }
      const rule = JSON.stringify(request.rule)
      params = [{ name: request.name, params: {
        ...base, rule,
        ...(request.labels?.length ? { audience_labels: JSON.stringify(request.labels) } : {}),
        ...(request.prefill !== undefined ? { prefill: String(request.prefill) } : {}),
        ...(request.retentionDays ? { retention_days: String(request.retentionDays) } : {}),
      } }]
      if (kind === 'engagement' && EUROPE_MAYBE.test(rule)) warnings.push('page_messaged and ig_user_messaged_business may not be available in Europe (Meta, engagement audiences): Meta\'s answer decides.')
      if (kind === 'offline') warnings.push('An offline audience is built from events the pixel (dataset) gets with action_source physical_store; Meta documents an offline event set id here, and Nexus names the dataset (offline event sets are datasets since Meta merged them): Meta\'s answer decides (LIVE-PROBES AU-041).')
      break
    }
    case 'video': {
      if (!request.video) return { refusal: 'A video viewers audience needs its videos and the view event.' }
      params = [{ name: request.name, params: {
        ...base, subtype: 'ENGAGEMENT',
        rule: JSON.stringify(request.video.videoIds.map((id) => ({ object_id: id, event_name: request.video!.event }))),
        ...(request.prefill !== undefined ? { prefill: String(request.prefill) } : {}),
      } }]
      warnings.push('Meta needs advertiser permission on the Page that holds each video, and counts views from 2015-10-16 on.')
      break
    }
    case 'catalog': {
      // AU-043 — POST /act_{id}/product_audiences: one event (eq) per rule; the pixel must be connected to the catalog.
      const c = request.catalog
      if (!c) return { refusal: 'A catalog product audience needs its product set and what people did (include).' }
      const rules = (list: Array<{ event: ProductEvent; days: number }>) => JSON.stringify(list.map((r) => ({ retention_seconds: r.days * DAY, rule: { event: { eq: r.event } } })))
      params = [{ name: request.name, params: {
        ...base, product_set_id: c.productSetId, inclusions: rules(c.include),
        ...(c.exclude?.length ? { exclusions: rules(c.exclude) } : {}),
        ...(c.pixelId ? { event_sources: JSON.stringify([{ id: c.pixelId, type: 'PIXEL' }]) } : {}),
      } }]
      edge = 'product_audiences'
      warnings.push('The pixel must be connected to the catalog first (Events Manager or set-meta-dataset); an exclusion counts every product of the same product group.')
      break
    }
    case 'lookalike': {
      const l = request.lookalike
      if (!l) return { refusal: 'A lookalike needs its source (a seed audience, campaigns or ad sets, or the Page\'s fans) and its size.' }
      const sources = [l.seedAudienceId ? 1 : 0, (l.campaignIds?.length || l.adSetIds?.length) ? 1 : 0, l.pageFans ? 1 : 0].reduce((a, b) => a + b, 0)
      if (sources !== 1) return { refusal: 'A lookalike learns from ONE source: seedAudienceId, campaignIds / adSetIds (their converters), or pageFans.' }
      const sized = l.percent !== undefined || !!l.tiers?.length
      if ((l.percent !== undefined && l.tiers?.length) || (!sized && !l.type) || (sized && l.type && l.type !== 'custom_ratio') || (l.type === 'custom_ratio' && !sized)) {
        return { refusal: 'Give the lookalike ONE size: type similarity (about 1%) or reach (about 5%), percent (1–20), or tiers (custom_ratio takes a percent or tiers).' }
      }
      // Review B3 — converter and Page-fan lookalikes are documented with a ratio only (lookalike-audiences #campaign, #page_fan).
      if (!l.seedAudienceId && (!sized || l.type)) return { refusal: 'A lookalike of campaign or ad set converters or of the Page\'s fans takes a percent or tiers (Meta documents a ratio there, no type).' }
      const seed = live.seed
      // A value-based seed's lookalike is custom_ratio (value-based-lookalike-audiences): Nexus sends it so.
      const valueSeed = !!(l.seedAudienceId && seed?.isValueBased)
      if (l.seedAudienceId) {
        if (!seed) return { refusal: 'Nexus could not read the seed audience.' }
        if (seed.flagged) return { refusal: `The seed ${who(seed)} is flagged for integrity: Meta makes no lookalike of it (100/1713232).` }
        if (valueSeed && !sized) return { refusal: 'The seed is a value-based customer list: its lookalike is type custom_ratio with a percent or tiers (value-based-lookalike-audiences).' }
        if (seed.deliveryCode === 300) warnings.push(`The seed ${who(seed)} is too small yet: Meta needs at least 100 people in it.`)
      }
      if (l.pageFans && !live.pageId) return { refusal: 'This business has chosen no Facebook Page, so there are no Page fans to learn from.' }
      const tiers = l.tiers?.length ? l.tiers : [{ fromPercent: l.fromPercent ?? 0, toPercent: l.percent ?? 0 }]
      for (const [i, t] of tiers.entries()) {
        if (l.tiers?.length || l.percent !== undefined) {
          if (!lookalikeRatioOk(t.toPercent / 100) || t.fromPercent < 0 || t.fromPercent >= t.toPercent || !Number.isInteger(t.fromPercent)) {
            return { refusal: 'Each lookalike size is whole percents: from (0–19) below to (1–20).' }
          }
          if (i > 0 && t.fromPercent < tiers[i - 1].toPercent) return { refusal: 'Lookalike tiers do not overlap: each starts where the one before ends or later.' }
        }
      }
      if (tiers.length > 5) return { refusal: 'At most 5 lookalike tiers in one change.' }
      params = []
      for (const t of tiers) {
        // One canonical spelling: type, ratio, starting_ratio, allow_international_seeds, then the source (never a country).
        const spec: Record<string, unknown> = {}
        if (valueSeed || l.type) spec.type = valueSeed ? 'custom_ratio' : l.type
        if (sized) spec.ratio = t.toPercent / 100
        if (sized && t.fromPercent > 0) spec.starting_ratio = t.fromPercent / 100
        if (l.allowInternationalSeeds !== undefined) spec.allow_international_seeds = l.allowInternationalSeeds
        if (l.pageFans) { spec.conversion_type = 'page_like'; spec.page_id = live.pageId }
        else if (!l.seedAudienceId) { spec.origin_ids = [...(l.campaignIds ?? []), ...(l.adSetIds ?? [])]; spec.conversion_type = 'campaign_conversions' }
        const problem = lookalikeSpecProblem(spec)
        if (problem) return { refusal: `The lookalike is not one Nexus sends: ${problem}.` }
        const name = tiers.length > 1 || l.tiers?.length ? `${request.name} ${t.fromPercent}-${t.toPercent}%` : request.name
        params.push({ name, params: { name, subtype: 'LOOKALIKE', ...(l.seedAudienceId ? { origin_audience_id: l.seedAudienceId } : {}), lookalike_spec: JSON.stringify(spec), ...(request.description ? { description: request.description } : {}) } })
      }
      warnings.push('Meta builds a lookalike in 1 to 6 hours and gives it no size (-1); it delivers where the ad set\'s locations say (Meta ignores a lookalike\'s country since v26, so Nexus sends none). At most 500 lookalikes per ad account; not for special ad categories.')
      if (!l.seedAudienceId) warnings.push(l.pageFans ? 'Page fans are the Page\'s followers.' : 'Meta needs at least 100 conversions (200 or more is better) of these campaigns or ad sets in the last 180 days.')
      break
    }
  }

  if (live.sameName.ids.length) warnings.push(`An audience named so exists already (${live.sameName.ids.slice(0, 5).join(', ')}): Meta allows two of one name, but they are easy to confuse.`)
  warnings.push('Nexus never asks Meta to hand back an identical existing audience instead (enable_fetch_or_create): undo would then delete an audience this change did not make. Meta has no check for an audience change.')
  const requests = params.map((p, i) => audienceRequest(i + 1, `Create the ${KIND_WORDS[kind]} audience ${quoted(p.name)}`, {
    objectId: account, objectKind: 'adaccount', params: p.params, operation: 'audience.create', edge, expect: { name: p.name }, readBackFields: 'id,name',
  }))
  const sizeOf = (spec: string) => { const o = JSON.parse(spec) as { ratio?: number; starting_ratio?: number; type?: string }; return o.ratio ? `${Math.round((o.starting_ratio ?? 0) * 100)}-${Math.round(o.ratio * 100)}%` : o.type ?? '' }
  const { changes, more } = changeLines(params.map((p) => [`New ${KIND_WORDS[kind]} audience ${quoted(p.name)}`, '(none)', kind === 'lookalike' ? `lookalike ${sizeOf(p.params.lookalike_spec)}` : KIND_WORDS[kind]]))
  return {
    summary: `Meta: create ${plural(params.length, `${KIND_WORDS[kind]} audience`)} on the chosen ad account (none of them spends anything until an ad set uses it).`,
    changes,
    totals: { audiences: params.length, requests: requests.length, ...(more ? { moreLines: more } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests,
    stands: { terms: live.terms.signed, sameName: live.sameName.ids, seed: live.seed ? { id: live.seed.id, subtype: live.seed.subtype, isValueBased: live.seed.isValueBased, flagged: live.seed.flagged, operation: live.seed.operationCode } : null, pageId: live.pageId },
    before: { created: [] } satisfies AudienceCreateRecord,
    after: { created: params.map((p) => ({ audienceId: null, name: p.name, kind })) } satisfies AudienceCreateRecord,
  }
}

// ── set-meta-audience ───────────────────────────────────────────────────────────────────────────────────────────────

export interface AudienceSetRequest {
  audienceId?: string
  name?: string
  description?: string
  rule?: AudienceRuleArg
  optOutLink?: string
  lookalike?: { type?: LookalikeType; percent?: number; fromPercent?: number; allowInternationalSeeds?: boolean }
  customerFileSource?: CustomerFileSource
  labels?: AudienceLabel[]
  retentionDays?: number
  productSetId?: string
  allowedDomains?: string[]
  useInCampaigns?: boolean
  useForProducts?: UseForProduct[]
  existingCustomers?: string[]
  audienceTypeTags?: { paramName: string; newCustomerTag?: string; existingCustomerTag?: string }
}

export const AUDIENCE_SET_FIELDS = ['name', 'description', 'rule', 'optOutLink', 'lookalike', 'customerFileSource', 'labels', 'retentionDays', 'productSetId', 'allowedDomains', 'useInCampaigns', 'useForProducts'] as const

export interface AudienceSetLive {
  adAccountId: string
  audience: AudienceDetail | null
  use: AudienceUse | null
  terms: TermsState | null
  tags: Record<string, string> | null
  idProblems: string[]
  /** Review A3 — the ACTIVE ad sets that read the existing-customer list (null: not asked), or why they could not be read. */
  existingUsers?: { adSets: Array<{ id: string; name: string | null; campaignId: string | null }>; problem: string | null } | null
}

export interface AudienceSetRecord {
  audienceId: string | null
  /** What it wrote (or replaced): field → value as a person reads it. */
  fields: Record<string, unknown>
  /** set-meta-audience arguments that put back what it replaced (null: nothing can be). */
  undo: Record<string, unknown> | null
  noUndo: string[]
}

const RULE_SUBTYPES: Readonly<Record<string, readonly AudienceSourceType[]>> = { WEBSITE: WEBSITE_SOURCES, ENGAGEMENT: ENGAGEMENT_SOURCES, OFFLINE_CONVERSION: OFFLINE_SOURCES }
const LABEL_SUBTYPES = new Set(['CUSTOM', 'WEBSITE', 'APP'])
/**
 * A written field as the change's record keeps it — and as undo reads it back now (meta-ads-audience-changes.tools.ts):
 * the fields Meta reads back plainly are compared (COMPARED_AUDIENCE_FIELDS); a rule, a lookalike spec and the fields
 * Meta gives no read-back of are kept as sent and not compared (Meta may write a rule back in another spelling).
 */
export const COMPARED_AUDIENCE_FIELDS = ['name', 'description', 'opt_out_link', 'customer_file_source', 'retention_days', 'audience_labels'] as const
export function audienceFieldView(param: string, value: unknown): unknown {
  if (value === null || value === undefined) return null
  if (param === 'audience_labels') {
    const list = typeof value === 'string' ? (() => { try { return JSON.parse(value) as unknown } catch { return null } })() : value
    return Array.isArray(list) ? [...list].map(String).sort() : null
  }
  return String(value)
}
/**
 * Review A2 — who delivers with this audience: the chosen account's active ads, or ads of an ad account it is shared with
 * (another business's: counted as in use). Null when nothing delivers with it.
 */
export function inUseWords(a: Pick<AudienceDetail, 'id' | 'name'>, use: AudienceUse | null): string | null {
  if (!use) return null
  const others = use.otherAccounts.filter((o) => o.takenByAnotherBusiness || (o.ads ?? 0) > 0)
  if (!use.activeAds && !others.length) return null
  const parts = [use.activeAds ? plural(use.activeAds, 'active ad') : '', others.length ? `ads of ${plural(others.length, 'ad account')} it is shared with` : ''].filter(Boolean)
  return `${who(a)} is used by ${parts.join(' and ')}`
}
/**
 * Review A2 — any change of WHO is in an audience ads use can let them spend more, in either direction: an ad set that
 * targets it reaches more people when it grows, one that excludes it reaches more when it shrinks. Nexus does not read
 * which ad set includes or excludes it, so every such change is the person's decision.
 */
const sizeSpends = (inUse: string, what: string) => `${inUse}: ${what} changes who is in it — where an ad set targets it a bigger audience, where one excludes it a smaller one, can let it spend more of its budget.`
const sameList = (a: readonly string[] | null | undefined, b: readonly string[] | null | undefined) => JSON.stringify([...(a ?? [])].sort()) === JSON.stringify([...(b ?? [])].sort())
const percentOf = (ratio: unknown) => (typeof ratio === 'number' ? Math.round(ratio * 100) : null)

export function setAudienceDraft(request: AudienceSetRequest, live: AudienceSetLive): MetaChangeDraft | { refusal: string } {
  const audienceAsked = AUDIENCE_SET_FIELDS.some((f) => request[f] !== undefined)
  const accountAsked = request.existingCustomers !== undefined || request.audienceTypeTags !== undefined
  if (!audienceAsked && !accountAsked) return { refusal: 'Nothing to change: name a field of the audience, or the account\'s existingCustomers or audienceTypeTags.' }
  if (audienceAsked && !request.audienceId) return { refusal: 'Name the audience (audienceId from meta-audiences view list).' }
  if (live.idProblems.length) return { refusal: `Not changed: ${live.idProblems.join(' ')}` }
  const lines: Array<[string, unknown, unknown]> = []
  const warnings: string[] = []
  const spendsMoney: string[] = []
  const skipped: string[] = []
  const noUndo: string[] = []
  const undo: Record<string, unknown> = {}
  const requests: MetaChangeRequest[] = []
  const fieldsWritten: Record<string, unknown> = {}
  const fieldsBefore: Record<string, unknown> = {}

  const a = live.audience
  if (audienceAsked) {
    if (!a) return { refusal: 'Nexus could not read the audience.' }
    const params: Record<string, string> = {}
    const expect: Record<string, string> = {}
    const readable: string[] = []
    const inUse = inUseWords(a, live.use)
    if (a.flagged && (a.subtype === 'CUSTOM' || a.subtype === 'LOOKALIKE')) return { refusal: `${who(a)} is flagged for integrity: Meta lets no flagged customer list or lookalike be edited (100/1713228); a person asks for a review in Audience Manager, or makes a new one.` }
    if (a.flagged) warnings.push(`${who(a)} is flagged for integrity (${a.flaggedFields.join(', ') || 'operation 471'}): Meta refuses an edit that leaves the flagged ${a.flaggedFields.length ? 'fields' : 'parts'} as they are (100/1713231).`)
    const set = (from: unknown, to: unknown, param: string, value: string, label: string, opts: { scalar?: boolean } = {}) => {
      params[param] = value
      lines.push([`${who(a)}: ${label}`, from ?? '(none)', to])
      fieldsWritten[param] = audienceFieldView(param, value)
      fieldsBefore[param] = from ?? null
      if (opts.scalar) { expect[param] = value; readable.push(param) }
    }

    if (request.name !== undefined) {
      if (request.name === a.name) skipped.push(`${who(a)} is already named so.`)
      else {
        set(a.name, request.name, 'name', request.name, 'name', { scalar: true })
        if (typedTextOk(a.name, META_NAME_TEXT, 200)) undo.name = a.name
        else noUndo.push('Its old name is not one Nexus can send again.')
      }
    }
    if (request.description !== undefined) {
      if (request.description === a.description) skipped.push(`${who(a)} already has that description.`)
      else {
        set(a.description, request.description, 'description', request.description, 'description', { scalar: true })
        if (typedTextOk(a.description, META_STRICT_TEXT, 1000)) undo.description = a.description
        else noUndo.push('It had no description (or one Nexus cannot send again): Meta documents no way to clear one.')
      }
    }
    if (request.rule !== undefined) {
      if (a.rule?.trim().startsWith('[')) return { refusal: `${who(a)} is a video viewers audience: its rule is a list of videos, changed by making a new audience (create-meta-audience kind video).` }
      const allowed = a.subtype ? RULE_SUBTYPES[a.subtype] : undefined
      if (!allowed) return { refusal: `${who(a)} is a ${a.subtype ?? 'kind of'} audience: only a website, engagement or offline audience has a rule Nexus changes.` }
      const what = a.subtype === 'WEBSITE' ? 'website' : a.subtype === 'OFFLINE_CONVERSION' ? 'offline' : 'engagement'
      const problem = ruleSourcesProblem(request.rule, allowed, what)
      if (problem) return { refusal: problem }
      const rule = JSON.stringify(request.rule)
      let previous: unknown
      try { previous = a.rule ? JSON.parse(a.rule) : undefined } catch { previous = undefined }
      if (previous !== undefined && JSON.stringify(previous) === rule) skipped.push(`${who(a)} already has that rule.`)
      else {
        set(a.rule ? 'its current rule' : null, 'the new rule', 'rule', rule, 'rule')
        warnings.push('Meta keeps the people the old rule matched until their retention ends: a new rule adds people at once but takes none out (audience-rules).')
        if (previous !== undefined && !audienceRuleProblem(previous)) undo.rule = previous
        else noUndo.push('Its old rule uses parts Nexus does not send, so undo cannot put it back (Ads Manager can).')
        if (inUse) spendsMoney.push(sizeSpends(inUse, 'a new rule'))
      }
    }
    if (request.optOutLink !== undefined) {
      if (request.optOutLink === a.optOutLink) skipped.push(`${who(a)} already has that opt-out link.`)
      else {
        set(a.optOutLink, request.optOutLink, 'opt_out_link', request.optOutLink, 'opt-out link', { scalar: true })
        if (a.optOutLink && OPT_OUT_LINK.test(a.optOutLink)) undo.optOutLink = a.optOutLink
        else noUndo.push('It had no opt-out link: Meta documents no way to clear one.')
      }
    }
    if (request.lookalike !== undefined) {
      if (a.subtype !== 'LOOKALIKE') return { refusal: `${who(a)} is not a lookalike.` }
      const l = request.lookalike
      const cur = a.lookalikeSpec ?? {}
      const spec: Record<string, unknown> = {
        ...(l.type ? { type: l.type } : {}),
        ...(l.percent !== undefined ? { ratio: l.percent / 100 } : {}),
        ...(l.fromPercent !== undefined && l.fromPercent > 0 ? { starting_ratio: l.fromPercent / 100 } : {}),
        ...(l.allowInternationalSeeds !== undefined ? { allow_international_seeds: l.allowInternationalSeeds } : {}),
      }
      if (l.fromPercent !== undefined && l.percent === undefined) return { refusal: 'A starting percent goes with the percent (its end).' }
      const problem = Object.keys(spec).length ? lookalikeSpecProblem(spec, true) : 'name what changes in the lookalike'
      if (problem) return { refusal: `The lookalike change is not one Nexus sends: ${problem}.` }
      const from = `${cur.type ?? ''}${percentOf(cur.ratio) !== null ? ` ${percentOf(cur.starting_ratio) ?? 0}-${percentOf(cur.ratio)}%` : ''}`.trim() || '(not read)'
      set(from, JSON.stringify(spec), 'lookalike_spec', JSON.stringify(spec), 'lookalike size')
      warnings.push('Meta documents lookalike_spec on an update but not which parts may change once it is built (Ads Manager makes a new one): Meta\'s answer decides (LIVE-PROBES AU-060).')
      const back: Record<string, unknown> = {}
      if (typeof cur.type === 'string' && (LOOKALIKE_TYPES as readonly string[]).includes(cur.type)) back.type = cur.type
      if (lookalikeRatioOk(cur.ratio)) back.percent = percentOf(cur.ratio)
      if (lookalikeRatioOk(cur.starting_ratio, 0)) back.fromPercent = percentOf(cur.starting_ratio)
      if (typeof cur.allow_international_seeds === 'boolean') back.allowInternationalSeeds = cur.allow_international_seeds
      if (Object.keys(back).length && (back.type || back.percent !== undefined)) undo.lookalike = back
      else noUndo.push('Its old lookalike size was not readable, so undo cannot put it back.')
      if (percentOf(cur.starting_ratio) && l.fromPercent === undefined && l.percent !== undefined) {
        warnings.push(`Its size starts at ${percentOf(cur.starting_ratio)}% now: the size sent replaces it, so without fromPercent it starts at 0% (${percentOf(cur.starting_ratio)}–${percentOf(cur.ratio)}% becomes 0–${l.percent}%).`)
      }
      if (inUse) spendsMoney.push(sizeSpends(inUse, 'a new lookalike size'))
    }
    if (request.customerFileSource !== undefined) {
      if (a.subtype !== 'CUSTOM') return { refusal: `${who(a)} is not a customer list: it has no customer-file source.` }
      if (request.customerFileSource === a.customerFileSource) skipped.push(`${who(a)} already has that customer-file source.`)
      else {
        set(a.customerFileSource, request.customerFileSource, 'customer_file_source', request.customerFileSource, 'customer-file source', { scalar: true })
        if (a.customerFileSource && (CUSTOMER_FILE_SOURCES as readonly string[]).includes(a.customerFileSource)) undo.customerFileSource = a.customerFileSource
        else noUndo.push('Its old customer-file source was not readable.')
      }
    }
    if (request.labels !== undefined) {
      if (!a.subtype || !LABEL_SUBTYPES.has(a.subtype)) return { refusal: `${who(a)} is a ${a.subtype ?? 'kind of'} audience: Meta keeps labels on customer lists, website and app audiences only.` }
      if (sameList(request.labels, a.labels)) skipped.push(`${who(a)} already has those labels.`)
      else {
        set(a.labels?.join(', ') || null, request.labels.join(', '), 'audience_labels', JSON.stringify(request.labels), 'labels')
        if (a.labels?.length && a.labels.every((l) => (AUDIENCE_LABELS as readonly string[]).includes(l))) undo.labels = a.labels
        else noUndo.push('It had no labels (or ones Nexus cannot send): Meta documents no way to clear them.')
        const added = request.labels.filter((l) => !(a.labels ?? []).includes(l))
        if (added.length) spendsMoney.push(`Labels ${added.join(', ')}: value rules and customer goals read labels — a value rule that raises bids for one can spend more on these people.`)
      }
    }
    if (request.retentionDays !== undefined) {
      if (a.subtype !== 'CUSTOM') return { refusal: `${who(a)} is not a customer list: Meta keeps retention_days on customer lists only (a rule audience keeps people by its rule's retention).` }
      // Review B5 — Meta's 0 (or none) is "for good": 0 → 30 is shorter, never longer.
      const forever = !a.retentionDays
      if (request.retentionDays === a.retentionDays) skipped.push(`${who(a)} already keeps people ${request.retentionDays} days.`)
      else {
        set(forever ? 'for good' : a.retentionDays, request.retentionDays, 'retention_days', String(request.retentionDays), 'kept (days)', { scalar: true })
        warnings.push('retention_days on an existing audience is in Meta\'s SDK only (not its update table): Meta\'s answer decides (LIVE-PROBES AU-058).')
        if (a.retentionDays && a.retentionDays >= 1 && a.retentionDays <= 180) undo.retentionDays = a.retentionDays
        else noUndo.push('It kept people without an end: Meta documents no way back to that.')
        if (inUse) spendsMoney.push(sizeSpends(inUse, `keeping people ${forever ? 'not for good but' : a.retentionDays! < request.retentionDays ? 'longer,' : 'shorter,'} ${request.retentionDays} days`))
      }
    }
    if (request.productSetId !== undefined) {
      set('(not read)', request.productSetId, 'product_set_id', request.productSetId, 'product set')
      if (inUse) spendsMoney.push(sizeSpends(inUse, 'another product set'))
      noUndo.push('Meta does not let Nexus read an audience\'s product set back, so undo cannot put the old one back.')
    }
    if (request.allowedDomains !== undefined) {
      set('(not read)', request.allowedDomains.join(', '), 'allowed_domains', JSON.stringify(request.allowedDomains), 'allowed domains')
      if (inUse) spendsMoney.push(sizeSpends(inUse, 'other allowed domains'))
      noUndo.push('Allowed domains: Meta documents the field by its name only and gives it no read-back, so undo cannot put the old ones back.')
    }
    if (request.useInCampaigns !== undefined) {
      set('(not read)', request.useInCampaigns, 'use_in_campaigns', String(request.useInCampaigns), 'use in campaigns')
      noUndo.push('use_in_campaigns: Meta documents it by its name only and gives no read-back.')
    }
    if (request.useForProducts !== undefined) {
      set('(not read)', request.useForProducts.join(', '), 'use_for_products', JSON.stringify(request.useForProducts), 'used for')
      noUndo.push('use_for_products: Meta gives no read-back of it.')
      if (request.useForProducts.includes('MARKETING_MESSAGES')) warnings.push('MARKETING_MESSAGES lets the audience be used for Meta\'s marketing messages too, not only ads.')
    }
    if (Object.keys(params).length) {
      const fields = Object.keys(params).map((k) => k.replace(/_/g, ' ')).join(', ')
      requests.push(audienceRequest(requests.length + 1, `Change ${who(a)}: ${fields}`, {
        objectId: a.id, objectKind: 'customaudience', params, operation: 'audience.update',
        expect: Object.keys(expect).length ? expect : { id: a.id }, readBackFields: ['id', ...readable].join(','),
        raisesSpend: spendsMoney.length > 0, undoable: true,
      }))
      if (inUse && params.rule) warnings.push(`${inUse}: a rule change does not send them back to Meta's review; their delivery follows the audience as Meta refills it.`)
    }
  }

  if (accountAsked) {
    const accountParams: Record<string, string> = {}
    const accountSpends: string[] = []
    const accountId = `act_${live.adAccountId}`
    if (request.existingCustomers !== undefined) {
      const current = live.terms?.existingCustomers
      // AU-074 — the POST replaces the WHOLE list (assumed: RECHECK-C3), so it is read first; unread, nothing is sent.
      if (!current) return { refusal: `Nexus could not read the ad account's existing-customer audiences (${live.terms?.existingProblem ?? 'no answer'}): a change replaces the whole list, so it is read first for the undo. Nothing was queued.` }
      if (sameList(current, request.existingCustomers)) skipped.push('The account already counts exactly these audiences as its existing customers.')
      else {
        accountParams.existing_customers = JSON.stringify(request.existingCustomers)
        lines.push(['The ad account\'s existing-customer audiences (the whole list)', current.join(', ') || '(none)', request.existingCustomers.join(', ') || '(none)'])
        fieldsWritten.existing_customers = [...request.existingCustomers].sort()
        fieldsBefore.existing_customers = current
        undo.existingCustomers = current
        const users = live.existingUsers
        if (!users || users.problem) {
          accountSpends.push(`Nexus could not read which active ad sets use the account's existing-customer list (${users?.problem ?? 'not read'}): an existing-customer budget cap or a new-customer goal reads it, so a new list can let them spend more on other people.`)
        } else if (users.adSets.length) {
          const named = users.adSets.slice(0, 10).map((x) => `${x.name ? `"${x.name}"` : 'an ad set'} (${x.id}${x.campaignId ? `, campaign ${x.campaignId}` : ''})`).join(', ')
          accountSpends.push(`${plural(users.adSets.length, 'active ad set')} read the existing-customer list (an existing-customer budget cap or a new-customer goal): ${named}${users.adSets.length > 10 ? ' and more' : ''}. Who counts as an existing customer changes on whom they may spend.`)
        }
        warnings.push('This replaces the WHOLE list of the account\'s existing-customer audiences (Advantage+ campaigns count them as existing customers, and an ad set\'s existing-customer budget share reads them). Meta documents it in its Advantage+ Shopping guide; whether a POST replaces or adds to the list is not documented: Nexus sends the whole list (LIVE-PROBES AU-074).')
      }
    }
    if (request.audienceTypeTags !== undefined) {
      const t = request.audienceTypeTags
      const merged: Record<string, string> = { audience_type_param_name: t.paramName }
      const prev = live.tags ?? {}
      const neu = t.newCustomerTag ?? prev.new_customer_tag
      const old = t.existingCustomerTag ?? prev.existing_customer_tag
      if (neu) merged.new_customer_tag = neu
      if (old) merged.existing_customer_tag = old
      if (!neu && !old) return { refusal: 'The audience-type URL tags need a new-customer tag, an existing-customer tag, or both.' }
      if (JSON.stringify(merged) === JSON.stringify({ audience_type_param_name: prev.audience_type_param_name, ...(prev.new_customer_tag ? { new_customer_tag: prev.new_customer_tag } : {}), ...(prev.existing_customer_tag ? { existing_customer_tag: prev.existing_customer_tag } : {}) })) {
        skipped.push('The account already has these audience-type URL tags.')
      } else {
        accountParams.custom_audience_info = JSON.stringify(merged)
        lines.push(['The ad account\'s audience-type URL tags', live.tags ? JSON.stringify(live.tags) : '(none)', JSON.stringify(merged)])
        fieldsWritten.custom_audience_info = merged
        fieldsBefore.custom_audience_info = live.tags
        if (live.tags?.audience_type_param_name && (live.tags.new_customer_tag || live.tags.existing_customer_tag)) {
          undo.audienceTypeTags = { paramName: live.tags.audience_type_param_name, ...(live.tags.new_customer_tag ? { newCustomerTag: live.tags.new_customer_tag } : {}), ...(live.tags.existing_customer_tag ? { existingCustomerTag: live.tags.existing_customer_tag } : {}) }
        } else noUndo.push('The account had no audience-type URL tags: Meta documents no way to remove them.')
        warnings.push('Meta adds these tags to the URL of an Advantage+ campaign\'s ad clicks (new or existing customer); they work once the existing-customer audiences are set.')
      }
    }
    if (Object.keys(accountParams).length) {
      requests.push(audienceRequest(requests.length + 1, `Change the ad account's audience settings: ${Object.keys(accountParams).map((k) => k.replace(/_/g, ' ')).join(', ')}`, {
        objectId: accountId, objectKind: 'adaccount', params: accountParams, operation: 'adaccount.audiences', expect: { id: accountId }, readBackFields: 'id', undoable: true,
        raisesSpend: accountSpends.length > 0,
      }))
      spendsMoney.push(...accountSpends)
    }
  }

  if (!requests.length) return { refusal: `Nothing to change: ${skipped.join(' ') || 'it is already so.'}` }
  const { changes, more } = changeLines(lines)
  const hasUndo = Object.keys(undo).length > 0
  const before: AudienceSetRecord = { audienceId: a?.id ?? null, fields: fieldsBefore, undo: hasUndo ? { ...(a ? { audienceId: a.id } : {}), ...undo } : null, noUndo }
  const after: AudienceSetRecord = { audienceId: a?.id ?? null, fields: fieldsWritten, undo: null, noUndo: [] }
  return {
    summary: `Meta: ${requests.map((r) => r.label).join('; then ')}.`,
    changes,
    totals: { fields: lines.length, requests: requests.length, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'Meta has no check for an audience change: it is built from the live state and read again before it is sent.', ...(noUndo.length ? [`No undo for: ${noUndo.join(' ')}`] : [])],
    spendsMoney,
    skipped,
    requests,
    stands: {
      // Re-review N2 — every fact a SPENDS MONEY verdict rests on: the ads that use it here AND in the accounts it is
      // shared with, and the active ad sets that read the existing-customer list.
      audience: a ? { ...a } : null, use: live.use ? { activeAds: live.use.activeAds, otherAccounts: live.use.otherAccounts } : null,
      existingCustomers: request.existingCustomers !== undefined ? live.terms?.existingCustomers ?? null : undefined,
      existingUsers: request.existingCustomers !== undefined ? live.existingUsers ?? null : undefined,
      tags: request.audienceTypeTags !== undefined ? live.tags : undefined,
    },
    before,
    after,
  }
}

// ── set-meta-audience-members ───────────────────────────────────────────────────────────────────────────────────────

export const MEMBER_MODES = ['add', 'replace', 'remove', 'opt_out_everywhere'] as const
export type MemberMode = typeof MEMBER_MODES[number]
/**
 * Whom mode remove takes out: the people who said no (the default: opted out of the business's e-mail, or whose yes ended
 * on Shopify — UNSUBSCRIBED), or the undo of an add (`added`, with the add's run time `addRanAt`): the rows that said yes
 * or whose yes ended and that Nexus already held when the add ran.
 */
export const REMOVE_WHO = ['said_no', 'added'] as const
export type RemoveWho = typeof REMOVE_WHO[number]

export interface AudienceMembersRequest { mode: MemberMode; audienceId?: string; since?: string; who?: RemoveWho; addRanAt?: string }
export interface AudienceMembersLive {
  adAccountId: string
  /** The business's switch "Upload customer lists to Meta" (customer-lists-switch.ts): an add or a replace only while on. */
  uploadsOn: boolean
  /** Meta's Custom Audience terms as the ad account reads them (tos_accepted); null when Nexus could not read them. */
  terms: TermsState | null
  /** Why the terms could not be read (with `terms` null). */
  termsProblem?: string | null
  audience: AudienceDetail | null
  use: AudienceUse | null
  people: HashedPeople
  /** remove, who said_no: how many opted out of the business's e-mail, and how many whose yes ended on Shopify. */
  saidNo?: { optedOut: number; consentEnded: number } | null
}
export interface AudienceMembersRecord {
  mode: MemberMode; audienceId: string | null; people: number; batches: number; since: string | null; who?: RemoveWho
  /** An add, once it ran: when (ISO) — its undo takes out only rows Nexus already held then. */
  ranAt?: string
}

const UPLOADS = new Set<MemberMode>(['add', 'replace'])
/** What an upload sends, in words (D8, P1 = B, P2 = A): short, and in full. */
const CONSENTED_SHORT = 'Shopify buyers who said yes to the business\'s e-mail'
const CONSENTED = 'Shopify buyers of this business who said yes to its e-mail marketing (Nexus\'s copy of Shopify\'s consent, from its active Shopify accounts), less everyone who opted out of its e-mail; never an Amazon, eBay or Etsy buyer'
/** #691 — the truth about "Claude's changes need no approval": the uploads switch is the real gate. */
const NO_APPROVAL_UPLOAD = 'With this business\'s "Claude\'s changes need no approval" switch on, an upload Claude asks for runs about 20 s after it is asked, unless someone stops it: "Upload customer lists to Meta" is the switch that decides whether Nexus uploads at all.'
/**
 * Consent PR 2 review — what a person reads about the people an undo of an add, or any removal, cannot reach: Nexus no
 * longer holds their hash.
 */
const ERASED_STAY = 'A person erased at Shopify (customers/redact) stays in Meta\'s lists until the next replace, or a remove that finds them on the business\'s opt-out list: Nexus no longer holds their hash.'
const ADD_UNDO = 'Undo takes the people out again (set-meta-audience-members mode remove, who added): the rows that said yes, or whose yes ended since, and that Nexus already held when this add ran. Nexus keeps no list of whom it sent, so the undo can also take out people another add put in. It cannot take out people erased at Shopify since, people whose shop was uninstalled since, people whose e-mail changed at Shopify since, or people whose Shopify state is now neither subscribed nor unsubscribed.'
const termsUnread = (problem: string | null | undefined, upload: boolean) => `Nexus could not read whether Meta's Custom Audience terms are signed for this ad account (${problem ?? 'Meta gave no answer'}), so it ${upload ? 'uploads nobody: Meta takes no customer list without them' : 'takes nobody out'}. Ask again later.`

function nobodyWords(request: AudienceMembersRequest, since: string | null, skipped: number): string {
  const rows = skipped ? ` (${plural(skipped, 'row')} without a usable e-mail address or hash)` : ''
  const from = since ? ` recorded since ${since}` : ''
  if (request.mode === 'add') return `Nobody to add: no Shopify buyer of this business's active Shopify accounts${from} says yes to its e-mail in Nexus's copy of Shopify's consent, or each who does opted out of its e-mail${rows}. If the Shopify consent backfill never ran, a person runs it first.`
  if (request.mode === 'replace') return `Nobody to put in the list: no Shopify buyer of this business's active Shopify accounts says yes to its e-mail in Nexus's copy of Shopify's consent${rows}, and a replace with nobody would empty the list (to empty it, delete it: remove-meta-audience).`
  if (request.mode === 'remove' && request.who === 'added') return `Nobody to take out: Nexus held no Shopify consent row that said yes or whose yes ended when the add ran${from}${rows}.`
  return `Nobody to take out: Nexus's list of people who opted out of the business's e-mail${request.mode === 'remove' ? ' or whose yes ended on Shopify' : ''}${since ? ` since ${since}` : ''} is empty${rows}.`
}

function tooManyWords(request: AudienceMembersRequest, count: number, since: string | null): string {
  if (request.mode === 'replace') return `${count} consenting Shopify buyers: a replace sends everyone in ONE session of at most 10 requests of 10,000 (${MAX_PEOPLE} people). Add them in parts instead (mode add with since).`
  const who = request.mode === 'add' ? 'consenting Shopify buyers' : request.who === 'added' ? 'people the add may have sent' : 'people said no'
  return `${count} ${who}${since ? ` since ${since}` : ''}: Nexus sends at most ${MAX_PEOPLE} in one change (10 requests of 10,000). Ask with since (a later day) to ${request.mode === 'add' ? 'add' : 'take out'} them in parts.`
}

/**
 * Why this change is refused before anything is read at Meta, or null: the switch first (an add or a replace only while
 * "Upload customer lists to Meta" is on — off, nothing else is judged), then arguments that do not go together.
 */
export function membersArgsProblem(request: AudienceMembersRequest, uploadsOn: boolean): string | null {
  // D8 — the business's own switch first: off, nobody is added and nothing is replaced.
  if (UPLOADS.has(request.mode) && !uploadsOn) return NO_CONSENT
  if (request.who && request.mode !== 'remove') return 'who goes with mode remove only.'
  if (request.who === 'added' && !request.addRanAt) return 'who added is the undo of an add: it takes addRanAt, the time the add ran (from the add\'s record; undo-change passes it).'
  if (request.addRanAt && request.who !== 'added') return 'addRanAt goes with who added only (the undo of an add).'
  if (request.mode === 'replace' && request.since) return 'A replace puts the WHOLE list of consenting Shopify buyers in place of everyone in it now: it takes no since (a replace with a part would leave only that part).'
  return null
}

/**
 * Why this change of a list's people is refused before anyone's hash is read, or null: membersArgsProblem, then Meta's
 * terms (signed, not signed, or not read — never guessed), then the list itself (the chosen account's own customer list,
 * not value-based for an upload, not being replaced, not flagged). The tool asks it before it reads the people;
 * membersDraft asks it again.
 */
export function membersProblem(request: AudienceMembersRequest, live: Omit<AudienceMembersLive, 'people' | 'saidNo'>): string | null {
  const upload = UPLOADS.has(request.mode)
  const args = membersArgsProblem(request, live.uploadsOn)
  if (args) return args
  // Meta's own field (act_<id>?fields=tos_accepted, custom_audience_tos 1): signed, not signed, or not read — never guessed.
  if (!live.terms) return termsUnread(live.termsProblem, upload)
  if (!live.terms.signed) return termsRefusal(live.terms)
  const a = live.audience
  if (request.mode === 'opt_out_everywhere') return null
  if (!a) return 'Name the customer list (audienceId from meta-audiences view list).'
  if (a.subtype !== 'CUSTOM') return `${who(a)} is not a customer list: Meta ${upload ? 'takes people into' : 'takes people out of'} customer lists only (a rule audience follows its rule).`
  if (upload && a.isValueBased === true) return `${who(a)} is a value-based customer list: its people go with a value each (LOOKALIKE_VALUE), which Nexus does not send (it uploads hashed e-mails only, and Meta never replaces a value-based list with one without values).`
  if (a.operationCode === 414) return `${who(a)} is being replaced right now (Meta 414): Meta takes no other change of its people until that ends. Ask again later.`
  if (a.flagged) return `${who(a)} is flagged for integrity: Meta takes no change of its people until that is resolved in Audience Manager (100/1713230).`
  // Consent PR 2 review — Meta's guide #replace-api: "Make sure your audience's operation_status is Normal" (200).
  if (request.mode === 'replace' && a.operationCode !== 200) {
    return `Meta replaces a customer list's people only while its status is Normal (operation_status 200), and ${who(a)} reads ${a.operationCode === null ? 'no status' : `status ${a.operationCode}`}${a.operationCode === 410 ? ' (no upload yet: add people first with mode add, then replace)' : ''}. Nothing was queued.`
  }
  return null
}

export function membersDraft(request: AudienceMembersRequest, live: AudienceMembersLive): MetaChangeDraft | { refusal: string } {
  const problem = membersProblem(request, live)
  if (problem) return { refusal: problem }
  const upload = UPLOADS.has(request.mode)
  const a = live.audience
  const since = request.since ?? null
  const { hashes, skipped } = live.people
  if (!hashes.length) return { refusal: nobodyWords(request, since, skipped) }
  if (hashes.length > MAX_PEOPLE) return { refusal: tooManyWords(request, hashes.length, since) }
  // Review A2 — a change of who is in a list ads use, in either direction, can let them spend more: the person's decision.
  const inUse = request.mode === 'opt_out_everywhere' ? null : inUseWords(a!, live.use)
  const what = request.mode === 'add' ? 'adding these people' : request.mode === 'replace' ? 'replacing its people' : 'taking these people out'
  const spendsMoney = request.mode === 'opt_out_everywhere'
    ? ['Taking people out of EVERY customer list of the ad account: an ad set that excludes one of those lists can then reach them, and so spend more of its budget (Nexus does not read which lists active ads exclude).']
    : inUse ? [sizeSpends(inUse, what)] : []
  const list = request.mode === 'opt_out_everywhere' ? 'EVERY customer list of the ad account' : `customer list ${quoted(a!.name)} (${a!.id})`
  const account = `act_${live.adAccountId}`
  const n = plural(hashes.length, 'hashed e-mail')
  const people = plural(hashes.length, 'person', 'people')
  const record: AudienceMembersRecord = { mode: request.mode, audienceId: a?.id ?? null, people: hashes.length, batches: 0, since, ...(request.mode === 'remove' ? { who: request.who ?? 'said_no' } : {}) }
  // A removal's facts in step 31's own shape (an approval asked before this release does not go stale); an upload's also
  // whether the list is value-based.
  const stands = { terms: true, audience: a ? { id: a.id, subtype: a.subtype, operation: a.operationCode, flagged: a.flagged, ...(upload ? { isValueBased: a.isValueBased } : {}) } : null, use: live.use ? { activeAds: live.use.activeAds, otherAccounts: live.use.otherAccounts } : null, people: hashes.length }
  const notSent = skipped ? [`${plural(skipped, 'row')} without a usable e-mail address or hash ${skipped === 1 ? 'is' : 'are'} not sent.`] : []

  let requests: MetaChangeRequest[]
  let summary: string
  let changes: MetaChangeDraft['changes']
  let warnings: string[]
  if (request.mode === 'add') {
    const batches = memberBatches(hashes)
    requests = batches.map((b, i) => audienceRequest(i + 1, `Add ${plural(b.count, 'hashed e-mail')} of consenting Shopify buyers to ${list}${batches.length > 1 ? ` (batch ${i + 1} of ${batches.length})` : ''}`, {
      objectId: a!.id, objectKind: 'customaudience', params: b.params, operation: 'audience.users.add', edge: 'users', raisesSpend: spendsMoney.length > 0, undoable: true,
    }))
    summary = `Meta: add ${n} (${CONSENTED_SHORT}) to ${list} of ad account ${account}.`
    changes = { [`People in ${list}`]: { from: 'as Meta has them', to: `${n} more at most (those Meta matches and does not have yet)` } }
    warnings = [
      `${n} go to Meta, into ${list} of ad account ${account}: the SHA-256 of each e-mail (trimmed, lower case — Meta's rule), never the address itself, a name or a phone. They are ${CONSENTED}. Nexus keeps no list of them, and the answer counts what Meta received, never who.`,
      ADD_UNDO,
      ERASED_STAY,
      'Meta needs up to 24 hours to apply it, and matches only people it knows.',
      ...(inUse ? [`${inUse}: adding people through /users restarts the learning phase of their ad sets (Meta; a replace does not).`] : []),
      NO_APPROVAL_UPLOAD,
      ...notSent,
      'Meta has no check for an audience change.',
    ]
  } else if (request.mode === 'replace') {
    const batches = replaceBatches(hashes)
    requests = batches.map((b, i) => audienceRequest(i + 1, `Replace the people of ${list} with ${hashes.length} hashed e-mails of consenting Shopify buyers${batches.length > 1 ? ` (batch ${i + 1} of ${batches.length} of one session)` : ''}`, {
      objectId: a!.id, objectKind: 'customaudience', params: b.params, planParams: b.planParams, operation: 'audience.users.replace', edge: 'usersreplace',
      raisesSpend: spendsMoney.length > 0, ...(i > 0 ? { needs: [i] } : {}),
    }))
    summary = `Meta: replace everyone in ${list} of ad account ${account} with ${n} (${CONSENTED_SHORT}).`
    changes = { [`People in ${list}`]: { from: 'as Meta has them (Meta does not list them)', to: `the ${n} sent (those Meta matches)` } }
    warnings = [
      `${n} go to Meta and REPLACE everyone in ${list} of ad account ${account}: the SHA-256 of each e-mail (trimmed, lower case — Meta's rule), never the address itself, a name or a phone. They are ${CONSENTED}. Nexus keeps no list of them, and the answer counts what Meta received, never who.`,
      'No undo: Meta does not list a Custom Audience\'s members, so Nexus cannot know who was in the list before and cannot put them back. To change it again, replace it again or take people out.',
      'Meta asks that the list be Normal (operation_status 200) before a replace: it reads Normal now.',
      `It goes as ONE replace session of ${plural(batches.length, 'request')}: the first starts the replace, the last ends it, and Meta keeps the session open 90 minutes at most. If a later request does not reach Meta, Meta keeps only what it got, so the list is smaller until the next replace.`,
      'A replace does not restart the learning phase of the ad sets that use the list (Meta); Meta needs up to 24 hours to apply it, and matches only people it knows.',
      NO_APPROVAL_UPLOAD,
      ...notSent,
      'Meta has no check for an audience change.',
    ]
  } else {
    const batches = memberBatches(hashes)
    const added = request.mode === 'remove' && request.who === 'added'
    const whom = added ? 'whom the add may have sent (the undo of an add)' : request.mode === 'remove' ? 'who said no (opted out of the business\'s e-mail, or whose yes ended on Shopify)' : 'who opted out of the business\'s e-mail'
    requests = batches.map((b, i) => audienceRequest(i + 1, `Take ${plural(b.count, 'person', 'people')} ${whom} out of ${list}${batches.length > 1 ? ` (batch ${i + 1} of ${batches.length})` : ''}`, request.mode === 'remove'
      ? { objectId: a!.id, objectKind: 'customaudience', params: b.params, operation: 'audience.users.remove', edge: 'users', method: 'DELETE', raisesSpend: spendsMoney.length > 0 }
      : { objectId: account, objectKind: 'adaccount', params: b.params, operation: 'adaccount.optOut', edge: 'usersofanyaudience', method: 'DELETE', raisesSpend: true }))
    summary = `Meta: take ${people} ${whom} out of ${list}.`
    changes = { [request.mode === 'remove' ? `People in ${list}` : 'People in every customer list of the ad account']: { from: 'as Meta has them', to: `${people} fewer at most (those Meta matches)` } }
    const parts = live.saidNo && request.mode === 'remove' && !added
      ? [
        `Of them, ${live.saidNo.optedOut} opted out of the business's e-mail and ${live.saidNo.consentEnded} had said yes on Shopify and unsubscribed since (one person may be both); someone who still says yes on another active Shopify account of the business stays.`,
        'Nobody who never said yes is sent, not even here: a person a Shopify admin moved straight from subscribed to not subscribed is not taken out — they leave the list with the next replace.',
      ] : []
    warnings = [
      'Each e-mail goes as its SHA-256 hash only (trimmed, lower case — Meta\'s rule); Nexus keeps no list of them, and the answer counts what Meta received, never who.',
      'Meta needs up to 24 hours to apply it, and matches only people it knows.',
      ...parts,
      added
        ? `It is the undo of an add that ran at ${request.addRanAt}: it takes out the rows that said yes, or whose yes ended since, and that Nexus already held then. Nexus keeps no list of whom the add sent, so this can also take out people another add put in. It cannot take out people erased at Shopify since, people whose shop was uninstalled since, people whose e-mail changed at Shopify since, or people whose Shopify state is now neither subscribed nor unsubscribed.`
        : 'No undo: people who said no are never put back.',
      ERASED_STAY,
      ...(inUse ? [`${inUse}: taking people out of it restarts the learning phase of their ad sets (Meta).`] : []),
      ...(request.mode === 'opt_out_everywhere' ? ['It covers every customer list of the ad account, also one shared with an ad account another business in Nexus uses: an opt-out is honoured everywhere.'] : []),
      ...notSent,
      'Meta has no check for an audience change.',
    ]
  }
  record.batches = requests.length
  return {
    summary,
    changes,
    totals: { ...(upload ? { hashedEmails: hashes.length } : { people: hashes.length }), requests: requests.length, ...(skipped ? { withoutEmail: skipped } : {}) },
    warnings,
    spendsMoney,
    skipped: [],
    requests,
    // Review A8 — no hash of the people here: the plan already covers the requests (their hashes), and a new person moves it.
    stands,
    before: record,
    after: record,
  }
}

// ── set-meta-audience-sharing ───────────────────────────────────────────────────────────────────────────────────────

export interface AudienceShareRequest { audienceId: string; action: 'share' | 'unshare'; adAccountIds: string[]; permissions?: SharePermission }
export interface AudienceShareLive { audience: AudienceDetail; sharing: AudienceSharing; use: AudienceUse; idProblems: string[] }
export interface AudienceShareRecord { audienceId: string; action: 'share' | 'unshare'; adAccountIds: string[]; permissions: SharePermission | null }

export function shareDraft(request: AudienceShareRequest, live: AudienceShareLive): MetaChangeDraft | { refusal: string } {
  const a = live.audience
  // Review A1 — an audience shared with another business's account is changed by nothing but its unshare (that is how
  // such a share ends): a share of it is refused.
  if (live.sharing.problem && request.action === 'share') return { refusal: live.sharing.problem }
  // Re-review N1 — who it is shared with could not be read: an unshare is not judged against an empty list.
  if (live.sharing.accounts === null) return { refusal: live.sharing.problem ?? 'Nexus could not read who the audience is shared with, so it changes nothing of it.' }
  if (live.idProblems.length) return { refusal: `Not shared: ${live.idProblems.join(' ')}` }
  const asked = [...new Set(request.adAccountIds)]
  const shared = new Set(live.sharing.accounts)
  const skipped: string[] = []
  const ids = request.action === 'share' ? asked.filter((id) => !shared.has(id)) : asked.filter((id) => shared.has(id))
  for (const id of asked) if (!ids.includes(id)) skipped.push(request.action === 'share' ? `It is already shared with ad account ${id}.` : `It is not shared with ad account ${id}.`)
  if (!ids.length) return { refusal: `Nothing to change: ${skipped.join(' ')}` }
  if (request.action === 'unshare' && request.permissions) return { refusal: 'permissions go with a share, not an unshare.' }
  const params: Record<string, string> = { adaccounts: JSON.stringify(ids), ...(request.action === 'share' && request.permissions ? { permissions: request.permissions } : {}) }
  const warnings: string[] = []
  const lines: Array<[string, unknown, unknown]> = ids.map((id) => [`${who(a)}: ad account ${id}`, request.action === 'share' ? 'not shared' : 'shared', request.action === 'share' ? `shared (${request.permissions ?? 'targeting_and_insights, Meta\'s default'})` : 'not shared'])
  if (request.action === 'share') {
    warnings.push('The recipient can target it, never change it or make a lookalike of it; Meta needs both ad accounts claimed by the business portfolio (its answer says which share failed).')
    if (a.subtype === 'CUSTOM') warnings.push('A customer list shared stays under the Custom Audience terms of the business that owns it.')
  } else {
    const ads = live.use.otherAccounts.filter((o) => ids.includes(o.adAccountId))
    const count = ads.reduce((n, o) => n + (o.ads ?? 0), 0)
    warnings.push(`Unsharing stops the recipients' ads that use it, and those ads can NEVER be restarted (Meta)${count ? `: ${plural(count, 'ad')} of ${plural(ads.length, 'ad account')} use it now` : ''}. Sharing it again gives back only the targeting.`)
  }
  const requests = [audienceRequest(1, `${request.action === 'share' ? 'Share' : 'Stop sharing'} ${who(a)} with ${plural(ids.length, 'ad account')}`, {
    objectId: a.id, objectKind: 'customaudience', params, operation: request.action === 'share' ? 'audience.share' : 'audience.unshare', edge: 'ad_accounts',
    ...(request.action === 'unshare' ? { method: 'DELETE' as const } : {}), undoable: true,
  })]
  const { changes, more } = changeLines(lines)
  const before: AudienceShareRecord = { audienceId: a.id, action: request.action, adAccountIds: ids, permissions: request.permissions ?? null }
  return {
    summary: `Meta: ${requests[0].label}.`,
    changes,
    totals: { adAccounts: ids.length, requests: 1, ...(skipped.length ? { alreadySo: skipped.length } : {}), ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'Meta has no check for an audience change.'],
    spendsMoney: [],
    skipped,
    requests,
    stands: { audience: a.id, sharedWith: [...shared].sort(), otherAccountAds: live.use.otherAccounts },
    before,
    after: before,
  }
}

// ── remove-meta-audience ────────────────────────────────────────────────────────────────────────────────────────────

export interface AudienceRemoveRequest { audienceIds: string[]; includeLookalikes?: boolean }
export interface AudienceRemoveLive {
  audiences: Array<{ audience: AudienceDetail; use: AudienceUse; lookalikes: Array<{ audience: AudienceDetail; use: AudienceUse }> }>
}
export interface AudienceRemoveRecord { audiences: Array<{ audienceId: string; name: string | null; subtype: string | null; ads: number; activeAds: number }> }
export const MAX_DELETES = 10

export function removeDraft(request: AudienceRemoveRequest, live: AudienceRemoveLive): MetaChangeDraft | { refusal: string } {
  const order: Array<{ audience: AudienceDetail; use: AudienceUse; seedOf?: string }> = []
  const seen = new Set<string>()
  for (const entry of live.audiences) {
    const a = entry.audience
    if (a.lookalikeIds.length && !request.includeLookalikes) {
      return { refusal: `${who(a)} has ${plural(a.lookalikeIds.length, 'lookalike')} (${a.lookalikeIds.join(', ')}): Meta refuses to delete a seed while they exist (2656). Ask with includeLookalikes: true to delete them first — their ads stop for good too.` }
    }
    for (const l of entry.lookalikes) if (!seen.has(l.audience.id)) { seen.add(l.audience.id); order.push({ ...l, seedOf: a.id }) }
    if (!seen.has(a.id)) { seen.add(a.id); order.push(entry) }
  }
  if (order.length > MAX_DELETES) return { refusal: `This deletes ${order.length} audiences (lookalikes included): at most ${MAX_DELETES} in one change.` }
  const warnings: string[] = ['DELETING IS FOR GOOD: Meta removes the audience, the ads that use it stop and can NEVER be restarted (a new audience is a new, empty one). The safer way is to take it out of their ad sets\' targeting.']
  const lines: Array<[string, unknown, unknown]> = []
  for (const { audience: a, use, seedOf } of order) {
    lines.push([`${who(a)}${seedOf ? ` (a lookalike of ${seedOf})` : ''}`, `${a.subtype ?? 'audience'}; used by ${plural(use.ads.length, 'ad')}${use.more ? ' or more' : ''} (${use.activeAds} active)`, 'deleted'])
    if (use.ads.length) {
      const named = use.ads.slice(0, 10).map((ad) => `${ad.name ? `"${ad.name}"` : 'an ad'} (${ad.adId}, ${ad.effectiveStatus ?? '?'})`).join(', ')
      warnings.push(`${who(a)} — the ads that stop for good: ${named}${use.ads.length > 10 || use.more ? ` and more (meta-audiences view ads-using lists them)` : ''}.`)
    }
    if (a.subtype === 'WEBSITE' && use.activeAds) warnings.push(`${who(a)} is a website audience used by active ads: Meta pauses their campaign when it is deleted.`)
    const others = use.otherAccounts.filter((o) => o.takenByAnotherBusiness || (o.ads ?? 0) > 0)
    if (others.length) warnings.push(`${who(a)} is also used by ads of ${plural(others.length, 'other ad account')} it is shared with: they stop for good too.`)
  }
  const requests = order.map(({ audience: a, seedOf }, i) => audienceRequest(i + 1, `Delete ${who(a)}${seedOf ? ' (lookalike first)' : ''}`, {
    objectId: a.id, objectKind: 'customaudience', params: {}, operation: 'audience.delete', method: 'DELETE',
  }))
  const { changes, more } = changeLines(lines)
  const record: AudienceRemoveRecord = { audiences: order.map(({ audience: a, use }) => ({ audienceId: a.id, name: a.name, subtype: a.subtype, ads: use.ads.length, activeAds: use.activeAds })) }
  return {
    summary: `Meta: delete ${plural(order.length, 'audience')} for good${order.some((o) => o.seedOf) ? ' (lookalikes before their seed)' : ''}.`,
    changes,
    totals: { audiences: order.length, ads: order.reduce((n, o) => n + o.use.ads.length, 0), requests: requests.length, ...(more ? { moreLines: more } : {}) },
    warnings: [...warnings, 'Meta has no check for a delete; one Meta refuses deletes nothing of that audience, and the next goes on.'],
    spendsMoney: [],
    skipped: [],
    requests,
    stands: order.map(({ audience: a, use }) => ({ id: a.id, subtype: a.subtype, lookalikes: a.lookalikeIds, ads: use.ads.map((ad) => `${ad.adId}:${ad.effectiveStatus}`) })),
    before: record,
    after: { audiences: [] } satisfies AudienceRemoveRecord,
  }
}
