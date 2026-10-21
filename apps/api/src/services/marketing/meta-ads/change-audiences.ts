/**
 * Meta ads step 31 — the drafts of the audience changes (pure: the request and the live state in, the requests Meta gets
 * out — what a person reads, the facts it stands on, what it replaces and writes for undo):
 *   create-meta-audience        a customer list (empty) or value-based seed, a website, engagement, offline, video or
 *                               catalog audience, a lookalike (each tier its own request) — AU-021, 030, 032–038, 040,
 *                               041, 043, 049–053 (AU-047, AU-064: said why not)
 *   set-meta-audience           name, description, rule, opt-out link, lookalike size, customer-file source, labels,
 *                               retention, product set, allowed domains, campaign / product use; the account's existing-
 *                               customer audiences and audience-type URL tags — AU-057–062, 074, 075
 *   set-meta-audience-members   remove / opt out everywhere the people who opted out of the business's e-mail (add and
 *                               replace refused: D8, no consent field) — AU-022–029
 *   set-meta-audience-sharing   share / unshare with ad accounts — AU-065, 066
 *   remove-meta-audience        delete, lookalikes first — AU-054, 063
 * Meta documents no validate_only on any custom-audience edge (facts F1 §M8): every request is `check: 'none'`. An
 * audience is never what spends money; what can let ads that use one spend more (a wider rule, a bigger lookalike, a
 * longer retention of an audience active ads use; labels that value rules raise bids for) is said as SPENDS MONEY.
 */
import { changeLines, plural, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { AudienceDetail, AudienceSharing, AudienceUse, TermsState } from './live-audience-change.js'
import { memberBatches, MAX_PEOPLE, NO_CONSENT, type HashedPeople } from './audience-members.js'
import {
  audienceRuleProblem, lookalikeRatioOk, lookalikeSpecProblem, OPT_OUT_LINK, type AudienceSourceType,
  AUDIENCE_LABELS, CUSTOMER_FILE_SOURCES, LOOKALIKE_TYPES, PRODUCT_EVENTS, SHARE_PERMISSIONS, USE_FOR_PRODUCTS, VIDEO_EVENTS,
} from '../../gateway/meta-audience-rules.js'
import { META_NAME_TEXT, META_STRICT_TEXT, typedTextOk } from '../../gateway/meta-settings-rules.js'

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
}): MetaChangeRequest {
  return {
    step, label, kind: 'campaign', objectId: o.objectId, params: o.params,
    check: 'none', raisesSpend: o.raisesSpend ?? false, readBackInPost: false, budget: false, undoable: o.undoable ?? false,
    operation: o.operation, objectKind: o.objectKind,
    ...(o.edge ? { edge: o.edge } : {}), ...(o.method ? { method: o.method } : {}), ...(o.expect ? { expect: o.expect } : {}), ...(o.readBackFields ? { readBackFields: o.readBackFields } : {}),
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
      // AU-021 / AU-030 — an EMPTY customer list: Nexus adds nobody to it (D8: no consent field in Nexus's customer data).
      params = [{ name: request.name, params: {
        ...base, subtype: 'CUSTOM', customer_file_source: request.customerFileSource ?? 'USER_PROVIDED_ONLY',
        ...(request.labels?.length ? { audience_labels: JSON.stringify(request.labels) } : {}),
        ...(request.retentionDays ? { retention_days: String(request.retentionDays) } : {}),
        ...(request.optOutLink ? { opt_out_link: request.optOutLink } : {}),
        ...(kind === 'value_seed' ? { is_value_based: 'true' } : {}),
      } }]
      warnings.push(`It starts EMPTY and Nexus adds nobody to it: ${NO_CONSENT}`)
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
    const active = live.use?.activeAds ?? 0
    const activeWords = `${who(a)} is used by ${plural(active, 'active ad')}`
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
        if (active > 0) spendsMoney.push(`${activeWords}: a wider rule can let them spend more of their budgets.`)
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
      const bigger = (l.percent !== undefined && (percentOf(cur.ratio) ?? 0) < l.percent) || l.type === 'reach' || l.allowInternationalSeeds === true
      if (active > 0 && bigger) spendsMoney.push(`${activeWords}: a bigger lookalike can let them spend more of their budgets.`)
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
      if (request.retentionDays === a.retentionDays) skipped.push(`${who(a)} already keeps people ${request.retentionDays} days.`)
      else {
        set(a.retentionDays, request.retentionDays, 'retention_days', String(request.retentionDays), 'kept (days)', { scalar: true })
        warnings.push('retention_days on an existing audience is in Meta\'s SDK only (not its update table): Meta\'s answer decides (LIVE-PROBES AU-058).')
        if (a.retentionDays && a.retentionDays >= 1 && a.retentionDays <= 180) undo.retentionDays = a.retentionDays
        else noUndo.push('It kept people without an end: Meta documents no way back to that.')
        // Longer than before can keep more people in it; from "forever" to a number is shorter.
        if (active > 0 && a.retentionDays !== null && request.retentionDays > a.retentionDays) spendsMoney.push(`${activeWords}: keeping people longer can let them spend more of their budgets.`)
      }
    }
    if (request.productSetId !== undefined) {
      set('(not read)', request.productSetId, 'product_set_id', request.productSetId, 'product set')
      noUndo.push('Meta does not let Nexus read an audience\'s product set back, so undo cannot put the old one back.')
    }
    if (request.allowedDomains !== undefined) {
      set('(not read)', request.allowedDomains.join(', '), 'allowed_domains', JSON.stringify(request.allowedDomains), 'allowed domains')
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
      if (active > 0 && params.rule) warnings.push(`${activeWords}: a rule change does not send them back to Meta's review; their delivery follows the audience as Meta refills it.`)
    }
  }

  if (accountAsked) {
    const accountParams: Record<string, string> = {}
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
      }))
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
      audience: a ? { ...a } : null, activeAds: live.use?.activeAds ?? null, existingCustomers: request.existingCustomers !== undefined ? live.terms?.existingCustomers ?? null : undefined,
      tags: request.audienceTypeTags !== undefined ? live.tags : undefined,
    },
    before,
    after,
  }
}

// ── set-meta-audience-members ───────────────────────────────────────────────────────────────────────────────────────

export const MEMBER_MODES = ['add', 'replace', 'remove', 'opt_out_everywhere'] as const
export type MemberMode = typeof MEMBER_MODES[number]

export interface AudienceMembersRequest { mode: MemberMode; audienceId?: string; since?: string }
export interface AudienceMembersLive {
  adAccountId: string
  terms: TermsState
  audience: AudienceDetail | null
  use: AudienceUse | null
  people: HashedPeople
}
export interface AudienceMembersRecord { mode: MemberMode; audienceId: string | null; people: number; batches: number; since: string | null }

export function membersDraft(request: AudienceMembersRequest, live: AudienceMembersLive): MetaChangeDraft | { refusal: string } {
  // D8 — no customer gave marketing consent Nexus knows of: nobody is added, nothing is replaced.
  if (request.mode === 'add' || request.mode === 'replace') return { refusal: NO_CONSENT }
  if (!live.terms.signed) return { refusal: termsRefusal(live.terms) }
  const a = live.audience
  if (request.mode === 'remove') {
    if (!a) return { refusal: 'Name the customer list (audienceId from meta-audiences view list).' }
    if (a.subtype !== 'CUSTOM') return { refusal: `${who(a)} is not a customer list: Meta takes people out of customer lists only (a rule audience follows its rule).` }
    if (a.operationCode === 414) return { refusal: `${who(a)} is being replaced right now (Meta 414): Meta takes no other change of its people until that ends. Ask again later.` }
    if (a.flagged) return { refusal: `${who(a)} is flagged for integrity: Meta takes no change of its people until that is resolved in Audience Manager (100/1713230).` }
  }
  const { hashes, skipped, fingerprint } = live.people
  const since = request.since ?? null
  if (!hashes.length) return { refusal: `Nobody to take out: Nexus's list of people who opted out of the business's e-mail${since ? ` since ${since}` : ''} is empty${skipped ? ` (${plural(skipped, 'row')} without a usable e-mail address)` : ''}.` }
  if (hashes.length > MAX_PEOPLE) return { refusal: `${hashes.length} people opted out${since ? ` since ${since}` : ''}: Nexus sends at most ${MAX_PEOPLE} in one change (10 requests of 10,000). Ask with since (a later day) to take them out in parts.` }
  const where = request.mode === 'remove' ? `${live.adAccountId}|${a!.id}|remove` : `${live.adAccountId}|any|opt-out`
  const batches = memberBatches(hashes, where)
  const target = request.mode === 'remove' ? `customer list ${quoted(a!.name)} (${a!.id})` : 'EVERY customer list of the ad account'
  const requests = batches.map((b, i) => audienceRequest(i + 1, `Take ${plural(b.count, 'person', 'people')} who opted out of the business's e-mail out of ${target}${batches.length > 1 ? ` (batch ${i + 1} of ${batches.length})` : ''}`, request.mode === 'remove'
    ? { objectId: a!.id, objectKind: 'customaudience', params: b.params, operation: 'audience.users.remove', edge: 'users', method: 'DELETE' }
    : { objectId: `act_${live.adAccountId}`, objectKind: 'adaccount', params: b.params, operation: 'adaccount.optOut', edge: 'usersofanyaudience', method: 'DELETE' }))
  const warnings = [
    'Each e-mail goes as its SHA-256 hash only (trimmed, lower case — Meta\'s rule); Nexus keeps no list of them, and the answer counts what Meta received, never who.',
    'Meta needs up to 24 hours to apply it, and matches only people it knows.',
    'No undo: people who opted out are never put back.',
    ...(request.mode === 'remove' && (live.use?.activeAds ?? 0) > 0 ? [`${who(a!)} is used by ${plural(live.use!.activeAds, 'active ad')}: taking people out of it restarts the learning phase of their ad sets (Meta).`] : []),
    ...(skipped ? [`${plural(skipped, 'opt-out row')} without a usable e-mail address ${skipped === 1 ? 'is' : 'are'} not sent.`] : []),
    'Meta has no check for an audience change.',
  ]
  const record: AudienceMembersRecord = { mode: request.mode, audienceId: a?.id ?? null, people: hashes.length, batches: batches.length, since }
  return {
    summary: `Meta: take ${plural(hashes.length, 'person', 'people')} who opted out of the business's e-mail out of ${target}.`,
    changes: { [request.mode === 'remove' ? `People in ${target}` : 'People in every customer list of the ad account']: { from: 'as Meta has them', to: `${plural(hashes.length, 'person', 'people')} fewer at most (those Meta matches)` } },
    totals: { people: hashes.length, requests: requests.length, ...(skipped ? { withoutEmail: skipped } : {}) },
    warnings,
    spendsMoney: [],
    skipped: [],
    requests,
    stands: { terms: live.terms.signed, audience: a ? { id: a.id, subtype: a.subtype, operation: a.operationCode, flagged: a.flagged } : null, people: hashes.length, fingerprint },
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
  if (live.sharing.problem) return { refusal: live.sharing.problem }
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
