/**
 * Meta ads step 8 (2026-10-21) — reads of Meta's opportunity score and recommendations, its A/B tests and lift studies
 * (and the chosen Page's video A/B tests), and Meta's own automated rules, LIVE from Meta through the gateway (GET only).
 * Nothing here stores anything, and nothing here changes Meta: applying a recommendation (step 28), making or ending a
 * test (step 28) and making, changing, previewing or running a rule (step 29) are change tools of their own.
 *
 * ONLY the business's chosen assets (metaChosenAccount), with fixed field lists per node type (a caller never names a
 * Graph field or path):
 *   - the chosen ad account `act_<id>` (score, recommendations, score history, studies that touch it, rules, rule history)
 *     and its own campaigns, ad sets and ads (objectInAccount: Nexus's rows, else one live read of account_id and fields
 *     only that kind has);
 *   - the chosen account's business portfolio, asked ONLY about the chosen account (recommendations: ad_account_ids = the
 *     chosen one; any other row Meta sends back is dropped) and its studies (one that does not touch the chosen account is
 *     its id only: it may be another business's);
 *   - a study only when Meta's list of studies that impact the chosen account names it; an objective only when it is that
 *     study's; a rule only when its account_id is the chosen account; a Page video test only when the chosen Page's list
 *     names it;
 *   - an ad account another business in Nexus uses (a study's cells, the accounts that can use a study) is
 *     `{ adAccountId, takenByAnotherBusiness: true }` only; a person (who made a rule or a study, who may see a study, who a
 *     rule notifies) is Meta's id only, never a name.
 *
 * Checked 2026-10-21 (curl, ≥ 3 s apart, developers.facebook.com/documentation/ads-commerce/…/*.md and
 * developers.facebook.com/docs/…; Meta's Python Business SDK main, facebook_business/adobjects/*.py):
 *   - recommendations (marketing-api/overview/performance-recommendations): `GET /act_<id>/recommendations`
 *     (recommendation_stages mfr | pcr, recommendation_names snake case; answer `data[{recommendations[…]}]` with
 *     recommendation_signature, recommendation_stage, recommendation_time, type, object_ids, recommendation_content
 *     {lift_estimate, body, opportunity_score_lift}, url); `GET /<business>/recommendations` (ad_account_ids — "when
 *     supplied, pagination is disabled", recommendation_stages mid_flight_recommendation | pre_create_guidance — other
 *     spelling, recommendation_names, locale, fields=recommendation_content "to include the lift_estimate and body
 *     strings"; adds ad_account_id, opportunity_score, recommendation_name, level); a signature is missing for types that
 *     "cannot be resolved in the API"; "there could be fewer recommendations returned by the API versus what is shown in
 *     Ads Manager"; the apply types and their extra_data (the apply itself is step 28); there is no dismiss call (RC-024)
 *   - the score now: ad-account field `opportunity_score` (same page, "a field of an ad account")
 *   - score history (…/performance-recommendations-history-api): from_date, to_date (YYYY-MM-DD), get_reason; window
 *     ≤ 45 days (5014022), from defaults to to − 14 days, to today or later → 5014023, "data may be missing the most
 *     recent two days"; changelog[{campaign_id, score_change, campaign_details[{ad_object_id, ad_object_type, budget_then,
 *     budget_now, eligible_/applied_recommendation_types_then/_now}]}] — the budget's unit is not stated: read as Meta's
 *     budget unit like every Meta budget (LIVE-PROBES RC-004)
 *   - studies (reference/ad-study, ad-account/impacting_ad_studies, business/ad_studies, ad-study/cells, objectives,
 *     viewers, related_ad_accounts, instances, continuous_lift_config; guides/split-testing, guides/lift-studies; SDK
 *     adstudy.py, adstudycell.py, adstudyobjective.py, privateliftstudyinstance.py, campaign.py / adset.py
 *     get_ad_studies, graph-api/reference/adgroup/ad_studies): impacting_ad_studies documents NO parameter (the Ads CLI's
 *     filters have no documented Graph names), so Nexus filters the list itself (type, state, name); the AdStudy fields
 *     below; no status field: the state comes from the times and canceled_time; cells: the reference reads name,
 *     treatment_percentage, campaigns, adsets, adaccounts — control_percentage, ad_ids and ad_entities_count are SDK
 *     only (asked, and asked again without them when Meta refuses; LIVE-PROBES EX-005); objectives: error 270 for apps
 *     with development access; results: `GET /<objective>?fields=results&breakdowns=["cell_id"]` (cell_id, age, gender,
 *     country — country only with cell_id; a combination shows only with ≥ 100 conversions; studies started after
 *     2021-07-13 have no buyers metrics and no age / gender / country breakdowns); a creative test's results:
 *     high_performer_ids (authoritative), confidence_by_ad_object_id, winner_ad_object_id and winner_confidence always
 *     null; "Conversion Lift Measurement is currently limited" (Meta's grant); a study cannot be deleted (DELETE "can't")
 *   - brand lift: ad-account and campaign field can_create_brand_lift_study, campaign field brand_lift_studies
 *     (list<AdStudy>; SDK campaign.py)
 *   - Page video A/B tests (docs/video-api/ab-testing): `GET /<page>/ab_tests` (since, until: today, yesterday, epoch
 *     seconds or dd-mm-yyyy; until after since) and `GET /<test id>`; the guide asks for a Page access token, and its
 *     answer names test_insights {timestamp, videos{<video id>{plays, impressions, …, instream_ads_earnings}}} and
 *     declared_winning_video, where the SDK (pagepostexperiment.py) names insight_snapshots, declared_winning_video_id,
 *     declared_winning_time and publish_time — the guide's names are asked first, the SDK's after a refusal
 *     (LIVE-PROBES EX-900, EX-903); `GET /<test>/video_insights` is SDK only and its page is 404 (RECHECK EX-903: not used)
 *   - rules (ad-rules/guides/api-calls, reference/ad-account/adrules_library, docs/marketing-api/reference/ad-rule —
 *     fields id, account_id "the ad account that owns the rule", created_by, created_time, disable_error_code,
 *     evaluation_spec, execution_spec, name, schedule_spec, status, updated_time; one edge: history; SDK adrule.py,
 *     adrulehistory.py, adaccountadruleshistory.py, adrulehistoryresult.py, adrulehistoryresultaction.py): a rule's
 *     history and the account's (object_id, action, hide_no_changes; newest first; the account's carries rule_id);
 *     trigger rules are "API-only, not visible in Ads Manager"; money in specs and history is in the currency's base unit
 *     ("for USD, the base unit is the cent", ad-rules/overview/evaluation-spec "Insights Filters"; change-spec `limit`
 *     "5000 to represent $50"): ONE helper turns it into the account currency's minor units (metaBudgetCents)
 *   - the rule preview is a POST: "Preview the evaluation of a Schedule Based Rule by sending a POST request"
 *     (ad-rules/guides/api-calls "Preview a rule"); the SDK has only AdRule.create_preview (method POST) and the ad-rule
 *     reference lists no preview edge to read. Meta documents NO GET form, and the gateway's reads are GET only by
 *     construction, so the preview comes with set-meta-ad-rule (step 29) — RULE_PREVIEW_SENTENCE.
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import prisma from '../../../db.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { decimalToMicros, metaOffset, minorOf } from './money.js'
import { accountToday, addDays } from './dates.js'
import { graphSafe, list, metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { takenIds } from './taken.js'

type Row = Record<string, unknown>

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && String(v).trim() ? String(v).trim() : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const rowsOf = (v: unknown): Row[] => arr(obj(v)?.data).filter((r): r is Row => !!obj(r))
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(v); return v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(n) ? null : n }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : v === 'true' ? true : v === 'false' ? false : null)
const act = (id: string) => `act_${id}`
const clampRows = (n: number | undefined, dflt: number, max = 500) => Math.min(max, Math.max(1, Math.trunc(n ?? dflt)))
/** The ids of an expanded list field (`{ data: [{ id }] }`) or of a plain list of ids. */
const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v : rowsOf(v)).map((x) => idText(obj(x)?.id ?? x)).filter((x): x is string => !!x)

/** A Meta time (ISO with +0000, or epoch seconds as a number or digits) as ISO 8601, or null. */
export function metaTime(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null
  const raw = String(v).trim()
  const ms = /^\d{9,11}$/.test(raw) ? Number(raw) * 1000 : Date.parse(raw.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}

/**
 * THE money helper of this step: an amount in Meta's own unit of the account currency — its "base" unit, the cent for
 * USD or EUR, the whole unit for the currencies whose Meta offset is 1 (money.ts) — as minor units of the account
 * currency (the tools' `…Cents`). Rules' filters, triggers, change_spec amounts and limits and their history, and the
 * score history's budgets all come in this unit. Null for no value or something that is not a number.
 */
export function metaBudgetCents(value: unknown, currency: string | null | undefined): number | null {
  if (typeof value !== 'number' && typeof value !== 'string') return null
  const micros = decimalToMicros(typeof value === 'string' ? value.trim() : value)
  return micros === null ? null : minorOf(micros / BigInt(metaOffset(currency)), currency)
}

/** The same for a single amount or a [low, high] range (IN_RANGE / NOT_IN_RANGE, a change_spec limit range). */
function centsOrRange(value: unknown, currency: string | null): number | Array<number | null> | null {
  return Array.isArray(value) ? value.map((v) => metaBudgetCents(v, currency)) : metaBudgetCents(value, currency)
}

/** One part of an answer that may fail on its own (an edge Meta may refuse): its value, or Meta's sentence. */
async function part<T>(work: () => Promise<T>): Promise<{ value: T | null; notRead: string | null }> {
  try {
    return { value: await work(), notRead: null }
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { value: null, notRead: err.failure.sentence }
    if (err instanceof MetaLiveRefusal) return { value: null, notRead: err.message }
    throw err
  }
}

/** Meta refused a field this node does not have (#100): the read is asked again with fewer fields. */
function fieldRefused(err: unknown): err is MetaReadError {
  return err instanceof MetaReadError && err.failure.origin === 'meta' && !err.failure.authLost && !err.failure.throttled
    && !err.failure.permissionDenied && (err.failure.code ?? '').split('/')[0] === '100'
}

/** One object read with `core` plus the first of `extras` Meta takes (each tried in turn), else `core` alone. */
async function oneWithFallbacks(connectionId: string, operation: string, path: string, core: string, extras: string[], query: Record<string, MetaQueryValue> = {}) {
  let refused: MetaReadError | null = null
  for (const extra of extras) {
    try {
      return { body: (await metaReadOne({ connectionId }, { operation, path, query: { ...query, fields: `${core},${extra}` } })).body as Row, note: refused ? `Meta refused some fields here (${extras[0]}), so the others were asked: ${refused.failure.sentence}` : null as string | null }
    } catch (err) {
      if (!fieldRefused(err)) throw err
      refused = err
    }
  }
  const body = (await metaReadOne({ connectionId }, { operation, path, query: { ...query, fields: core } })).body as Row
  return { body, note: refused ? `Meta refused some fields here (${extras.join(' / ')}), so they are missing: ${refused.failure.sentence}` : null }
}

/** A list read with `core` plus the first of `extras` Meta takes (each tried in turn), else `core` alone. */
async function listWithFallback(connectionId: string, operation: string, path: string, core: string, extras: string | string[], query: Record<string, MetaQueryValue>, maxRows: number) {
  const tries = Array.isArray(extras) ? extras : [extras]
  let refused: MetaReadError | null = null
  for (const extra of tries) {
    try {
      return { ...(await list(connectionId, operation, path, { ...query, fields: `${core},${extra}` }, maxRows)), note: refused ? `Meta refused some fields here (${tries[0]}), so the others were asked: ${refused.failure.sentence}` : null as string | null }
    } catch (err) {
      if (!fieldRefused(err)) throw err
      refused = err
    }
  }
  return { ...(await list(connectionId, operation, path, { ...query, fields: core }, maxRows)), note: `Meta refused some fields here (${tries.join(' / ')}), so they are missing: ${refused!.failure.sentence}` }
}

/** Pages Nexus reads at most (100 rows each) while it filters a list itself. */
const MATCH_PAGE_CAP = 10

/**
 * Review fix B6 — a list Nexus filters itself (Meta takes no such filter): pages are read until `maxRows` rows MATCH or
 * the page cap, and the answer says plainly when the cap stopped it (`capNote`). `all` is every row read (for counts).
 */
async function readMatching<T>(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, map: (row: Row) => T, match: (item: T) => boolean, maxRows: number) {
  const all: T[] = []
  const items: T[] = []
  let after: string | null = null
  let pages = 0
  let morePages = false
  for (;;) {
    const read = await metaReadOne({ connectionId }, { operation, path, query: { ...query, limit: 100, ...(after ? { after } : {}) } })
    pages++
    const body = read.body as { data?: unknown; paging?: { cursors?: { after?: unknown }; next?: unknown } }
    for (const row of rowsOf(body)) {
      const item = map(row)
      all.push(item)
      if (match(item)) items.push(item)
    }
    const next = typeof body.paging?.cursors?.after === 'string' && body.paging?.next ? body.paging.cursors.after : null
    if (!next) break
    if (items.length >= maxRows || pages >= MATCH_PAGE_CAP) { morePages = true; break }
    after = next
  }
  const capped = morePages && items.length < maxRows
  return {
    items: items.slice(0, maxRows), all, more: morePages || items.length > maxRows,
    capNote: capped ? `Nexus read the first ${all.length} rows of Meta's list (${MATCH_PAGE_CAP} pages) and filtered them itself; more may match further on: ask with a narrower filter.` : null,
  }
}

/** A person as Meta names them: the id only (never a name), and whether it is this business's own system user (Nexus). */
function person(v: unknown, account: MetaChosenAccount) {
  const id = idText(obj(v)?.id ?? v)
  return id ? { id, isThisSystemUser: !!account.connection.systemUser && account.connection.systemUser.id === id } : null
}

/** The chosen account's own campaigns, ad sets and ads Nexus has read, by id: their kind and name (none for the others). */
async function knownObjects(account: MetaChosenAccount, ids: string[]): Promise<Map<string, { kind: 'campaign' | 'adset' | 'ad'; name: string | null }>> {
  const asked = [...new Set(ids.filter((id) => /^\d{1,25}$/.test(id)))].slice(0, 500)
  const known = new Map<string, { kind: 'campaign' | 'adset' | 'ad'; name: string | null }>()
  if (asked.length === 0) return known
  const where = { adAccountId: account.adAccountId }
  const [campaigns, adSets, ads] = await Promise.all([
    prisma.metaAdsCampaign.findMany({ where: { ...where, campaignId: { in: asked } }, select: { campaignId: true, name: true } }),
    prisma.metaAdsAdSet.findMany({ where: { ...where, adSetId: { in: asked } }, select: { adSetId: true, name: true } }),
    prisma.metaAdsAd.findMany({ where: { ...where, adId: { in: asked } }, select: { adId: true, name: true } }),
  ])
  for (const c of campaigns) known.set(c.campaignId, { kind: 'campaign', name: c.name ?? null })
  for (const s of adSets) known.set(s.adSetId, { kind: 'adset', name: s.name ?? null })
  for (const a of ads) known.set(a.adId, { kind: 'ad', name: a.name ?? null })
  return known
}

const accountHeader = (account: MetaChosenAccount) => ({ adAccountId: account.adAccountId, name: account.name, currency: account.currency, timeZone: account.timeZone })

// ── meta-recommendations ─────────────────────────────────────────────────────────────────────────────────────────

export const RECOMMENDATION_VIEWS = ['overview', 'score', 'list', 'portfolio', 'history'] as const
export type RecommendationView = typeof RECOMMENDATION_VIEWS[number]
export const RECOMMENDATION_STAGES = ['mid_flight', 'pre_create'] as const
export type RecommendationStage = typeof RECOMMENDATION_STAGES[number]
/** The account read and the portfolio read spell the stages differently (performance-recommendations, both tables). */
const ACCOUNT_STAGE: Record<RecommendationStage, string> = { mid_flight: 'mfr', pre_create: 'pcr' }
const PORTFOLIO_STAGE: Record<RecommendationStage, string> = { mid_flight: 'mid_flight_recommendation', pre_create: 'pre_create_guidance' }
const STAGE_WORDS: Record<string, string> = {
  mid_flight_recommendation: 'for campaigns, ad sets or ads that run now',
  pre_create_guidance: 'before a new campaign is made (account-level guidance)',
  pre_flight_recommendation: 'for a draft while it is made or edited',
}

/**
 * The types Meta applies by API (performance-recommendations "Recommendation-specific parameters"; master RC-008…RC-021):
 * apply-meta-recommendations (a later Nexus step, step 28) will send them, each a request a person approves. `spendsMoney` as the master rows
 * judge it: yes = can raise spend at once, maybe = can widen delivery, no = same budget.
 */
const APPLY_BY_API: Readonly<Record<string, { what: string; spendsMoney: 'yes' | 'maybe' | 'no' }>> = {
  ADVANTAGE_PLUS_AUDIENCE: { what: 'switches Advantage+ audience on for the ad sets (Meta may show the ads beyond the audience set)', spendsMoney: 'yes' },
  AUTOMATIC_PLACEMENTS: { what: 'switches Advantage+ placements on for the ad sets (more placements)', spendsMoney: 'yes' },
  LANDING_PAGE_VIEW_OPTIMIZATION_GOAL: { what: 'changes the ad sets\' goal to landing page views (learning restarts)', spendsMoney: 'no' },
  PRODUCT_SET_BOOSTING: { what: 'lets catalog ads show products beyond the product set', spendsMoney: 'maybe' },
  CONVERSION_LEADS_OPTIMIZATION: { what: 'duplicates the ad sets and ads with a conversion-leads goal (new objects)', spendsMoney: 'yes' },
  APLUSC_STANDARD_ENHANCEMENTS_BUNDLE: { what: 'switches Advantage+ creative standard enhancements on for the ads', spendsMoney: 'no' },
  AUTOFLOW_OPT_IN: { what: 'lets Meta deliver variations of the ads (standard enhancements)', spendsMoney: 'no' },
  MUSIC: { what: 'lets Meta add music to the ads (Sound Collection Terms apply)', spendsMoney: 'no' },
  UNCROP_IMAGE: { what: 'lets Meta\'s AI expand the images to more placements', spendsMoney: 'no' },
  CREATIVE_FATIGUE: { what: 'makes AI variations of fatigued ads (new ads)', spendsMoney: 'maybe' },
  BACKGROUND_GENERATION: { what: 'switches AI backgrounds on or off for product images', spendsMoney: 'no' },
  PERFORMANT_CREATIVE_REELS_OPT_IN: { what: 'adds Reels placements to the ad sets', spendsMoney: 'yes' },
  SHOPS_ADS_SAOFF: { what: 'turns website ad sets into Shops ads (website and shop)', spendsMoney: 'maybe' },
  SCALE_GOOD_CAMPAIGN: { what: 'raises the budgets of the campaigns or ad sets Meta names', spendsMoney: 'yes' },
}

/**
 * The types Meta does NOT apply by API (master RC-023; performance-recommendations "Option 3": use the object ids with the
 * campaign tools). Each names the Nexus tool that does the same (a tool not in this connection yet comes with a later
 * Nexus step) or Meta's own screens; the recommendation's Ads Manager link works for all of them.
 */
const ACT_ELSEWHERE: Readonly<Record<string, { tools: string[]; what: string }>> = {
  BUDGET_LIMITED: { tools: ['set-meta-ad-set', 'set-meta-campaign'], what: 'raise the budget of the limited campaign or ad set (SPENDS MONEY)' },
  CAPI_CRM_GUIDANCE_V2: { tools: ['meta-datasets'], what: 'connect CRM data to the Conversions API (lead ads; Nexus shops do not run them)' },
  CAPI_CRM_SETUP: { tools: ['meta-datasets'], what: 'finish the CRM set-up of the Conversions API (lead ads)' },
  CAPI_PERFORMANCE_MATCH_KEY_V2: { tools: ['meta-datasets', 'upload-meta-events'], what: 'send more match keys with server events (meta-datasets shows who sends what first)' },
  SIGNALS_GROWTH_CAPI_V2: { tools: ['meta-datasets', 'upload-meta-events'], what: 'add the Conversions API next to the pixel (check first whether the shop platform already sends server events)' },
  PIXEL_OPTIMIZATION_HIE: { tools: ['meta-datasets'], what: 'send high-intent events from the pixel' },
  PIXEL_UPSELL: { tools: ['meta-datasets', 'create-meta-dataset'], what: 'connect the website with a Meta pixel' },
  CREATIVE_LIMITED: { tools: ['create-meta-creative', 'create-meta-ad'], what: 'add fresh creatives to the ad set' },
  MULTI_TEXT: { tools: ['create-meta-creative'], what: 'give the ad more text options' },
  APLUSC_ADD_OVERLAYS: { tools: ['create-meta-creative'], what: 'switch Advantage+ overlays on in the creative' },
  APLUSC_TEXT_IMPROVEMENTS: { tools: ['create-meta-creative'], what: 'switch Advantage+ text improvements on in the creative' },
  APLUSC_VISUAL_TOUCHUPS: { tools: ['create-meta-creative'], what: 'switch Advantage+ visual touch-ups on in the creative' },
  GEN_AI_MVP: { tools: [], what: 'AI-made creative variations in Ads Manager\'s creation flow' },
  FRAGMENTATION_V3: { tools: ['set-meta-status', 'set-meta-ad-set'], what: 'merge similar ad sets (pause the extra ones, move their budget)' },
  OFFSITE_CONVERSION: { tools: ['set-meta-ad-set', 'create-meta-ad-set'], what: 'use the "maximise conversions" goal' },
  VALUE_OPTIMIZATION_GOAL: { tools: ['set-meta-ad-set', 'create-meta-ad-set'], what: 'use the "maximise value of conversions" goal' },
  PARTNERSHIP_ADS: { tools: ['create-meta-boost', 'create-meta-creative'], what: 'add a partnership ad to the campaign' },
  ADVANTAGE_PLUS_CATALOG_ADS: { tools: ['create-meta-campaign'], what: 'run Advantage+ catalog ads from the catalog' },
  CTX_CREATION_PACKAGE: { tools: [], what: 'a click-to-message creation package in Ads Manager' },
  MESSAGING_EVENTS: { tools: [], what: 'Meta\'s help page about messaging events' },
  MESSAGING_PARTNERS: { tools: [], what: 'Meta\'s messaging partners (Partner Showcase)' },
  WA_MESSAGING_PARTNERS: { tools: [], what: 'WhatsApp business partners (Partner Showcase)' },
  UNIFIED_INBOX: { tools: [], what: 'answer unread customer messages within 5 hours (Meta Business Suite inbox)' },
}

/** How a person acts on one recommendation (RC-023): Meta's apply (step 28), a Nexus tool, or Meta's screens. */
export function howToAct(type: string | null, hasSignature: boolean) {
  const apply = type ? APPLY_BY_API[type] : undefined
  if (apply && hasSignature) {
    return {
      byApi: true, tool: 'apply-meta-recommendations', toolComesWith: 'a later Nexus step (step 28)', spendsMoney: apply.spendsMoney, what: apply.what,
      sentence: `Meta applies this by API. Nexus's apply-meta-recommendations comes with a later Nexus step (step 28), and will ask for it as a request a person approves${apply.spendsMoney === 'yes' ? ' — it SPENDS MONEY' : apply.spendsMoney === 'maybe' ? ' — it can widen delivery' : ''}; until then, the Ads Manager link. The signature goes stale: read again right before.`,
    }
  }
  const elsewhere = type ? ACT_ELSEWHERE[type] : undefined
  const tools = elsewhere?.tools ?? []
  return {
    byApi: false, tool: null, spendsMoney: type === 'BUDGET_LIMITED' ? 'yes' as const : null, what: elsewhere?.what ?? apply?.what ?? null,
    nexusTools: tools,
    sentence: apply && !hasSignature
      ? 'Meta gave no signature for this one, so it cannot be applied by API now: use the Ads Manager link, or read again later.'
      : tools.length
        ? `Meta does not apply this type by API. Nexus does the same with ${tools.join(' or ')} (each a request a person approves; a tool not in this connection yet comes with a later Nexus step), or use the Ads Manager link.`
        : 'Meta does not apply this type by API and Nexus has no tool for it: use the Ads Manager link (adsManagerUrl).',
  }
}

/**
 * Review fix A6 — the budget recommendations' own texts can name amounts ("raise the budget by …"): for them the body and
 * the lift estimate sit under a restricted key (moneyTextAsMeta) instead.
 */
const MONEY_TEXT_TYPES = new Set(['BUDGET_LIMITED', 'SCALE_GOOD_CAMPAIGN'])
const isMoneyText = (type: string | null, name: string | null) => (!!type && MONEY_TEXT_TYPES.has(type)) || (!!name && /budget|scale_good/i.test(name))

/** One recommendation as Meta gives it (account or portfolio read), in Nexus's words. */
function mapRecommendation(raw: Row, known: Map<string, { kind: string; name: string | null }>) {
  const content = obj(raw.recommendation_content) ?? {}
  const type = text(raw.type)
  const name = text(raw.recommendation_name)
  const signature = text(raw.recommendation_signature) ?? idText(raw.recommendation_signature)
  const stage = text(raw.recommendation_stage)
  const objectIds = idsOf(raw.object_ids)
  const texts = { liftEstimate: text(content.lift_estimate ?? raw.lift_estimate), body: text(content.body ?? raw.body) }
  return {
    type, name, stage, stageText: stage ? STAGE_WORDS[stage] ?? stage : null, level: text(raw.level),
    signature, time: metaTime(raw.recommendation_time),
    ...(isMoneyText(type, name) ? { liftEstimate: null, body: null, moneyTextAsMeta: texts } : texts),
    opportunityScoreLift: num(content.opportunity_score_lift ?? raw.opportunity_score_lift),
    objects: objectIds.slice(0, 100).map((id) => ({ id, kind: known.get(id)?.kind ?? null, name: known.get(id)?.name ?? null })),
    objectCount: objectIds.length,
    adsManagerUrl: text(raw.url),
    howToAct: howToAct(type, !!signature),
  }
}

/** The recommendations inside an answer's rows (`data[{ recommendations: […] }]`, or the rows themselves). */
function recommendationsOf(rows: Row[]): Row[] {
  const out: Row[] = []
  for (const row of rows) {
    if (Array.isArray(row.recommendations)) out.push(...row.recommendations.filter((r): r is Row => !!obj(r)))
    else if (row.recommendation_signature !== undefined || row.type !== undefined || row.recommendation_name !== undefined) out.push(row)
  }
  return out
}

/** The answer's spelling of each stage asked (both reads answer the long form). */
const STAGE_ANSWERED: Record<RecommendationStage, string> = { mid_flight: 'mid_flight_recommendation', pre_create: 'pre_create_guidance' }

/**
 * Review fix B1 — the stage and name filters are also applied by Nexus to what Meta answers, so a filter Meta ignored (a
 * spelling it does not take: the guide writes lower case, the SDK upper case — LIVE-PROBES RC-002) never looks applied.
 * A name matches the account read's type (lower case; a versioned type such as fragmentation_v3 matches fragmentation)
 * or the portfolio read's name.
 */
function nexusFilter<T extends { stage: string | null; type: string | null; name: string | null }>(items: T[], stage: RecommendationStage | null | undefined, names: string[] | null) {
  const keep = items.filter((i) => {
    if (stage && i.stage && i.stage !== STAGE_ANSWERED[stage]) return false
    if (names) {
      const own = (i.name ?? i.type ?? '').toLowerCase()
      if (!names.some((n) => own === n || own.startsWith(`${n}_v`))) return false
    }
    return true
  })
  const left = items.length - keep.length
  return { items: keep, leftOutByNexus: left, ...(left ? { filterNote: `Meta answered ${left} recommendation${left === 1 ? '' : 's'} outside the filter asked (it may not take that spelling); Nexus left ${left === 1 ? 'it' : 'them'} out.` } : {}) }
}

const RECOMMENDATION_NOTE = 'Meta may list fewer recommendations than Ads Manager shows. A recommendation cannot be dismissed by API (only in Ads Manager), and its signature goes stale: read again right before applying.'

export interface RecommendationInput {
  connectionId?: string | null
  view: RecommendationView
  stage?: RecommendationStage | null
  names?: string[] | null
  locale?: string | null
  from?: string | null
  to?: string | null
  reasons?: boolean
}

export async function metaRecommendations(input: RecommendationInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId, currency } = account
  const base = { account: accountHeader(account) }
  const names = input.names?.length ? input.names : null

  const score = async () => {
    const read = await metaReadOne({ connectionId }, { operation: 'recommendations.score', path: act(adAccountId), query: { fields: 'opportunity_score' } })
    return num((read.body as Row).opportunity_score)
  }
  const accountList = async () => {
    const read = await metaReadOne({ connectionId }, {
      operation: 'recommendations.account', path: `${act(adAccountId)}/recommendations`,
      query: { ...(input.stage ? { recommendation_stages: [ACCOUNT_STAGE[input.stage]] } : {}), ...(names ? { recommendation_names: names } : {}) },
    })
    const raw = recommendationsOf(rowsOf(read.body))
    const known = await knownObjects(account, raw.flatMap((r) => idsOf(r.object_ids)))
    return nexusFilter(raw.map((r) => mapRecommendation(r, known)), input.stage, names)
  }

  switch (input.view) {
    case 'score': return { ...base, opportunityScore: await score(), note: 'Meta\'s opportunity score now (0–100); it moves during the day as campaigns change. view history shows it day by day.' }
    case 'list': {
      const listed = await accountList()
      return { ...base, ...listed, byApi: listed.items.filter((i) => i.howToAct.byApi).length, note: RECOMMENDATION_NOTE }
    }
    case 'overview': {
      // IN-105 — like Meta's own ads_get_opportunity_score: the score with the recommendations, in one answer.
      const [s, l] = await Promise.all([part(score), part(accountList)])
      return {
        ...base, opportunityScore: s.value, scoreNotRead: s.notRead, ...(l.value ?? { items: [] }), itemsNotRead: l.notRead,
        totalScoreLift: (l.value?.items ?? []).reduce((sum, i) => sum + (i.opportunityScoreLift ?? 0), 0), note: RECOMMENDATION_NOTE,
      }
    }
    case 'portfolio': {
      // RC-003 — the portfolio read, asked about the chosen ad account ONLY (each other account may be another business's).
      const businessId = account.businessId
      if (!businessId) throw new MetaLiveRefusal('The chosen ad account belongs to no business portfolio Meta named, so there is no portfolio read: view list reads the account\'s own recommendations.')
      const portfolioRead = async (withContent: boolean) => rowsOf((await metaReadOne({ connectionId }, {
        operation: 'recommendations.portfolio', path: `${businessId}/recommendations`,
        query: {
          ad_account_ids: adAccountId, ...(withContent ? { fields: 'recommendation_content' } : {}),
          ...(input.stage ? { recommendation_stages: [PORTFOLIO_STAGE[input.stage]] } : {}), ...(names ? { recommendation_names: names } : {}),
          ...(input.locale ? { locale: input.locale } : {}),
        },
      })).body)
      // Review fix B2 — `fields=recommendation_content` may leave Meta's own fields out (LIVE-PROBES RC-003): when no row
      // names an ad account, read once more without it; never answer "no recommendations" from rows that name none.
      let rows = await portfolioRead(true)
      let withContent = true
      if (!rows.some((r) => metaAdAccountId(r.ad_account_id))) {
        rows = await portfolioRead(false)
        withContent = false
      }
      if (!rows.some((r) => metaAdAccountId(r.ad_account_id))) {
        return {
          ...base, businessId, opportunityScore: null, items: [], accountNamed: false,
          sentence: `Meta's portfolio answer ${rows.length ? `has ${rows.length} row${rows.length === 1 ? '' : 's'} but none names an ad account` : 'has no row naming the chosen ad account'}, so Nexus cannot tell which are this business's and shows none — that is not "no recommendations". view list reads the account's own.`,
        }
      }
      const mine = rows.filter((r) => metaAdAccountId(r.ad_account_id) === adAccountId)
      const raw = recommendationsOf(mine)
      const known = await knownObjects(account, raw.flatMap((r) => idsOf(r.object_ids)))
      return {
        ...base, businessId, accountNamed: true,
        opportunityScore: mine.length ? num(mine[0].opportunity_score) : null,
        ...nexusFilter(raw.map((r) => mapRecommendation(r, known)), input.stage, names),
        otherAccountsLeftOut: rows.length - mine.length,
        ...(withContent ? {} : { contentNote: 'Meta answered no account with the texts asked, so this read is without them (liftEstimate and body are empty).' }),
        note: `${RECOMMENDATION_NOTE} The portfolio read names each recommendation by name and level (not by type); view list gives the type and whether Meta applies it by API.`,
      }
    }
    case 'history': {
      const tz = account.timeZone ?? 'UTC'
      const today = accountToday(tz)
      // Review fix B3 — Meta states a two-day latency: the default ends two days back; a 5014023 ("to_date … violates one-day
      // data latency") is asked once more one day earlier.
      let to = input.to ?? addDays(today, -2)
      if (to >= today) throw new MetaLiveRefusal(`to must be before today (${today}, the account's time zone): Meta has the score up to yesterday at most, and the last two days may still be missing.`)
      const from = input.from ?? addDays(to, -14)
      if (from > to) throw new MetaLiveRefusal('from is after to.')
      if (from < addDays(to, -45)) throw new MetaLiveRefusal(`Meta reads at most 45 days back from to (from ${addDays(to, -45)} at the earliest); ask again in pieces.`)
      const reasons = input.reasons !== false
      const ask = (until: string) => metaReadOne({ connectionId }, {
        operation: 'recommendations.history', path: `${act(adAccountId)}/opportunity_score_history`,
        query: { from_date: from, to_date: until, get_reason: reasons },
      })
      let read: Awaited<ReturnType<typeof ask>>
      let movedBack = false
      try {
        read = await ask(to)
      } catch (err) {
        if (!(err instanceof MetaReadError) || err.failure.code !== '100/5014023' || addDays(to, -1) < from) throw err
        to = addDays(to, -1)
        movedBack = true
        read = await ask(to)
      }
      const days = rowsOf(read.body).map((d) => ({
        date: text(d.date),
        opportunityScore: num(d.opportunity_score),
        changes: arr(d.changelog).map(obj).filter((c): c is Row => !!c).map((c) => ({
          campaignId: idText(c.campaign_id),
          scoreChange: num(c.score_change),
          objects: (Array.isArray(c.campaign_details) ? c.campaign_details : [c]).map(obj).filter((x): x is Row => !!x && x.ad_object_id !== undefined).map((x) => ({
            objectId: idText(x.ad_object_id), objectType: text(x.ad_object_type),
            budgetThenCents: metaBudgetCents(x.budget_then, currency), budgetNowCents: metaBudgetCents(x.budget_now, currency),
            eligibleThen: arr(x.eligible_recommendation_types_then), eligibleNow: arr(x.eligible_recommendation_types_now),
            appliedThen: arr(x.applied_recommendation_types_then), appliedNow: arr(x.applied_recommendation_types_now),
          })),
        })),
      }))
      return {
        ...base, from, to, reasons, days,
        ...(movedBack ? { toNote: `Meta had no score for the day asked yet, so the history ends one day earlier (${to}).` } : {}),
        note: 'Meta\'s daily snapshot of the score (it can differ from the score now, which moves during the day). The last two days may be missing (Meta\'s latency). Budgets in minor units of the account currency.',
      }
    }
  }
}

// ── meta-experiments ─────────────────────────────────────────────────────────────────────────────────────────────

export const EXPERIMENT_VIEWS = ['list', 'portfolio', 'study', 'results', 'sharing', 'object', 'brand-lift', 'private-lift', 'page-video-tests', 'page-video-test'] as const
export type ExperimentView = typeof EXPERIMENT_VIEWS[number]
/** The study types Meta names (reference/ad-study `type` enum, split-testing for SPLIT_TEST_V2, the Ads CLI's study list). */
export const STUDY_TYPES = ['SPLIT_TEST', 'SPLIT_TEST_V2', 'LIFT', 'GEO_LIFT', 'CONTINUOUS_LIFT_CONFIG', 'BACKEND_AB_TESTING', 'CREATIVE_SPEND_ENFORCEMENT', 'PORTFOLIO_OPTIMIZER', 'VERSION_CONTROL'] as const
export const STUDY_STATES = ['planned', 'running', 'measuring', 'finished', 'cancelled'] as const
export type StudyState = typeof STUDY_STATES[number]
export const RESULT_BREAKDOWNS = ['cell_id', 'age', 'gender', 'country'] as const
export const OBJECT_KINDS = ['campaign', 'adset', 'ad'] as const

const STUDY_TYPE_WORDS: Record<string, string> = {
  SPLIT_TEST: 'A/B test (split test)', SPLIT_TEST_V2: 'creative test', LIFT: 'conversion lift study', GEO_LIFT: 'geo lift study',
  CONTINUOUS_LIFT_CONFIG: 'continuous lift (run by Meta)', BACKEND_AB_TESTING: 'Meta\'s own back-end test',
  CREATIVE_SPEND_ENFORCEMENT: 'creative spend enforcement (Meta)', PORTFOLIO_OPTIMIZER: 'portfolio optimiser (Meta)', VERSION_CONTROL: 'version control (Meta)',
}
const STATE_WORDS: Record<StudyState, string> = {
  planned: 'not started yet', running: 'running', measuring: 'ended; Meta still counts conversions until the observation end',
  finished: 'finished', cancelled: 'cancelled',
}

/** The AdStudy fields the reference lists (people and the owning business by id only). */
const STUDY_FIELDS = 'id,name,description,type,start_time,end_time,cooldown_start_time,observation_end_time,results_first_available_date,canceled_time,created_time,updated_time,business{id},created_by{id},updated_by{id}'
/** The cell fields the study reference reads, and the SDK's extra ones (asked first, dropped when Meta refuses them). */
const CELL_FIELDS = 'id,name,treatment_percentage,adaccounts.limit(100),campaigns.limit(100),adsets.limit(100)'
const CELL_EXTRA_FIELDS = 'control_percentage,ad_ids,ad_entities_count'
const OBJECTIVE_FIELDS = 'id,name,type,is_primary,last_updated_results'

/** A study's state from its times (Meta has no status field): cancelled, planned, running, measuring or finished. */
export function studyState(s: { startTime: string | null; endTime: string | null; observationEndTime: string | null; canceledTime: string | null }, now: Date = new Date()): StudyState | null {
  if (s.canceledTime) return 'cancelled'
  const at = now.getTime()
  const start = s.startTime ? Date.parse(s.startTime) : NaN
  const end = s.endTime ? Date.parse(s.endTime) : NaN
  const observe = s.observationEndTime ? Date.parse(s.observationEndTime) : NaN
  if (Number.isFinite(start) && at < start) return 'planned'
  if (Number.isFinite(end) && at <= end) return Number.isFinite(start) ? 'running' : null
  if (Number.isFinite(observe) && at <= observe) return 'measuring'
  return Number.isFinite(end) ? 'finished' : null
}

function mapStudy(raw: Row, account: MetaChosenAccount, now: Date = new Date()) {
  const times = { startTime: metaTime(raw.start_time), endTime: metaTime(raw.end_time), observationEndTime: metaTime(raw.observation_end_time), canceledTime: metaTime(raw.canceled_time) }
  const state = studyState(times, now)
  const type = text(raw.type)
  return {
    studyId: idText(raw.id), name: text(raw.name), description: text(raw.description), type, typeText: type ? STUDY_TYPE_WORDS[type] ?? type : null,
    state, stateText: state ? STATE_WORDS[state] : null, ...times,
    cooldownStartTime: metaTime(raw.cooldown_start_time), resultsFirstAvailableDate: text(raw.results_first_available_date),
    createdTime: metaTime(raw.created_time), updatedTime: metaTime(raw.updated_time),
    ownerBusinessId: idText(obj(raw.business)?.id ?? null), createdBy: person(raw.created_by, account), updatedBy: person(raw.updated_by, account),
  }
}

const STUDY_NOTE = 'A study cannot be deleted (Meta has no delete for it); a running one can only be extended or given more objects. Making, changing and ending tests (create-meta-experiment, set-meta-experiment, end-meta-experiment) come with a later Nexus step (step 28). Changing an ad set, ad or campaign that is in a running test can spoil the test.'
const LIFT_NOTE = 'Conversion lift needs Meta\'s own grant ("Conversion Lift Measurement is currently limited", Meta\'s lift guide): when Meta refuses, the business asks its Meta representative. Study objectives and results also need the Meta app above development access (Meta\'s error 270).'

/** The studies Meta says touch the chosen ad account (impacting_ad_studies), as Meta gives them. */
async function impactingStudies(account: MetaChosenAccount, fields: string, maxRows: number) {
  return list(account.connectionId, 'experiments.impacting', `${act(account.adAccountId)}/impacting_ad_studies`, { fields }, maxRows)
}

/** A study id from a caller, read only when Meta's list of studies that touch the chosen account names it. */
async function ownStudy(account: MetaChosenAccount, studyId: string): Promise<{ studyId: string; type: string | null; startTime: string | null }> {
  const id = metaObjectId(studyId)
  if (!id) throw new MetaLiveRefusal(`"${studyId}" is not a Meta study id (digits).`)
  const read = await impactingStudies(account, 'id,type,start_time', 1000)
  const row = read.rows.find((r) => idText(r.id) === id)
  if (!row) throw new MetaLiveRefusal('That study does not touch the ad account this business chose (Meta\'s list of the studies that impact it does not name it), so it is not read.')
  return { studyId: id, type: text(row.type), startTime: metaTime(row.start_time) }
}

/** The ad accounts of a list, each another business in Nexus uses as its id and the flag only. */
async function accountsMasked(ids: string[], account: MetaChosenAccount, names: Map<string, string | null> = new Map()) {
  const clean = [...new Set(ids.map((id) => metaAdAccountId(id)).filter((id): id is string => !!id))]
  const taken = await takenIds('AD_ACCOUNT', clean)
  return clean.map((id) => (taken.has(id) && id !== account.adAccountId
    ? { adAccountId: id, takenByAnotherBusiness: true }
    : { adAccountId: id, ...(names.has(id) ? { name: names.get(id) ?? null } : {}), chosenHere: id === account.adAccountId, takenByAnotherBusiness: false }))
}

async function mapCells(rows: Row[], account: MetaChosenAccount) {
  const objectIds = rows.flatMap((c) => [...idsOf(c.campaigns), ...idsOf(c.adsets), ...idsOf(c.ad_ids)])
  const known = await knownObjects(account, objectIds)
  const named = (ids: string[], key: 'campaignId' | 'adSetId' | 'adId') => ids.map((id) => ({ [key]: id, name: known.get(id)?.name ?? null, inNexus: known.has(id) }))
  return Promise.all(rows.map(async (c) => ({
    cellId: idText(c.id), name: text(c.name),
    treatmentPercentage: num(c.treatment_percentage), controlPercentage: num(c.control_percentage),
    adAccounts: await accountsMasked(idsOf(c.adaccounts), account),
    campaigns: named(idsOf(c.campaigns), 'campaignId'), adSets: named(idsOf(c.adsets), 'adSetId'), ads: named(idsOf(c.ad_ids), 'adId'),
    adEntitiesCount: num(c.ad_entities_count),
  })))
}

const mapObjective = (o: Row) => ({ objectiveId: idText(o.id), name: text(o.name), type: text(o.type), isPrimary: bool(o.is_primary), lastUpdatedResults: text(o.last_updated_results) })

/**
 * Review fix A3 — an ALLOW-list of the lift metrics that are not money (Meta's lift guide answer: populations,
 * impressions, conversions and buyers counted, scaled, incremental with its bounds and share, confidence, rank, p-value),
 * each only as a plain number. Every other key (spend, cost per incremental conversion or buyer, any sales or value
 * metric, anything nested or new) goes to `moneyAsMeta`, restricted to the ad-spend money permission.
 */
const LIFT_PLAIN_METRIC = /^(population_(test|control|reached)|impressions|reach|(conversions|buyers)_(test|exposed|notexposed|control_scaled|control_raw_scaled|incremental|incremental_lower|incremental_upper|incremental_share|confidence|multicell_confidence|multicell_rank|raw_pvalue|frequentist_pvalue))$/i
const CREATIVE_TEST_KEYS = new Set(['high_performer_ids', 'confidence_by_ad_object_id', 'winner_ad_object_id', 'winner_confidence'])
const plainNumber = (v: unknown) => v === null || (typeof v === 'number' && Number.isFinite(v)) || (typeof v === 'string' && /^-?\d+(\.\d+)?(e-?\d+)?$/i.test(v))
/** A map of ids to plain numbers (a creative test's confidence by ad), else null (then it is restricted). */
const numberMap = (v: unknown): Row | null => {
  const o = obj(v)
  return o && Object.values(o).every(plainNumber) ? o : null
}

/**
 * An objective's results as Meta gives them (a list of JSON strings, or of objects): per breakdown row the plain numbers
 * Nexus knows, every other metric under `moneyAsMeta` (restricted; Meta's own units), and a creative test's outcome.
 */
export function mapResults(results: unknown) {
  const rows = arr(results).map((r) => {
    if (typeof r !== 'string') return obj(r)
    try { return obj(JSON.parse(r)) } catch { return null }
  })
  const unreadable = rows.filter((r) => r === null).length
  return {
    rows: rows.filter((r): r is Row => !!r).map((r) => {
      const numbers: Row = {}
      const moneyAsMeta: Row = {}
      const creative: Row = {}
      for (const [key, value] of Object.entries(r)) {
        if (['cell_id', 'age', 'gender', 'country'].includes(key)) continue
        if (CREATIVE_TEST_KEYS.has(key)) creative[key] = value
        else if (LIFT_PLAIN_METRIC.test(key) && plainNumber(value)) numbers[key] = value
        else moneyAsMeta[key] = value
      }
      const confidence = creative.confidence_by_ad_object_id === undefined ? null : numberMap(creative.confidence_by_ad_object_id)
      if (creative.confidence_by_ad_object_id !== undefined && !confidence) moneyAsMeta.confidence_by_ad_object_id = creative.confidence_by_ad_object_id
      return {
        cellId: idText(r.cell_id), age: text(r.age), gender: text(r.gender), country: text(r.country), numbers, moneyAsMeta,
        ...(Object.keys(creative).length ? {
          creativeTest: {
            highPerformerAdIds: idsOf(creative.high_performer_ids), confidenceByAdId: confidence,
            note: 'For a creative test Meta names the high performers (its winner fields are always empty for creative tests).',
          },
        } : {}),
      }
    }),
    unreadable,
  }
}

async function objectiveResults(account: MetaChosenAccount, objectiveId: string, breakdowns: string[], ds: string | null) {
  const read = await metaReadOne({ connectionId: account.connectionId }, {
    operation: 'experiments.results', path: objectiveId,
    query: { fields: `${OBJECTIVE_FIELDS},results`, ...(breakdowns.length ? { breakdowns } : {}), ...(ds ? { ds } : {}) },
  })
  const body = read.body as Row
  const results = mapResults(body.results)
  return {
    ...mapObjective(body), breakdowns, asOfDay: ds, results: results.rows,
    ...(results.unreadable ? { unreadableRows: results.unreadable } : {}),
    ...(results.rows.length ? {} : { noResults: 'No results yet: Meta shows them once the study has them (resultsFirstAvailableDate), and a breakdown only when it holds at least 100 conversions (test and control together).' }),
  }
}

/**
 * The video A/B test fields: the guide's answer and the SDK agree on these; the result fields differ (see the header).
 * Review fix B4 — the GUIDE's result fields are asked first (RECHECK EX-903), the SDK's only after Meta refuses them.
 */
const VIDEO_TEST_CORE = 'id,name,description,optimization_goal,control_video_id,experiment_video_ids,publish_status,creation_time,updated_time,scheduled_experiment_timestamp'
const VIDEO_TEST_GUIDE = 'test_insights,declared_winning_video'
const VIDEO_TEST_SDK = 'publish_time,declared_winning_video_id,declared_winning_time,insight_snapshots'
const VIDEO_TEST_LIST_GUIDE = 'declared_winning_video'
const VIDEO_TEST_LIST_SDK = 'publish_time,declared_winning_video_id,declared_winning_time'

/**
 * Review fix A3 — the per-video numbers Meta's guide lists that are not money, each only as a plain number (the retention
 * graph: a map of seconds to shares). Every other key — in-stream ad earnings, anything nested or new — goes to the
 * restricted `moneyAsMeta`.
 */
const VIDEO_PLAIN_METRICS = new Set([
  'plays', 'impressions', 'fan_impressions', 'link_clicks', 'comments', 'shares', 'reactions', 'video_views', 'video_views_3s',
  'video_views_15s', 'video_views_60s', 'avg_video_views', 'avg_time_watched',
])
function videoMetrics(metrics: unknown) {
  const numbers: Row = {}
  const moneyAsMeta: Row = {}
  for (const [key, value] of Object.entries(obj(graphSafe(metrics)) ?? {})) {
    if (VIDEO_PLAIN_METRICS.has(key) && plainNumber(value)) numbers[key] = value
    else if (key === 'video_retention_graph' && numberMap(value)) numbers[key] = value
    else moneyAsMeta[key] = value
  }
  return { numbers, moneyAsMeta }
}

function mapVideoTest(raw: Row) {
  const insights = obj(raw.test_insights)
  const videos = obj(insights?.videos)
  return {
    testId: idText(raw.id), name: text(raw.name), description: text(raw.description), optimizationGoal: text(raw.optimization_goal),
    controlVideoId: idText(raw.control_video_id), videoIds: idsOf(raw.experiment_video_ids), publishStatus: text(raw.publish_status),
    publishTime: metaTime(raw.publish_time), scheduledTime: metaTime(raw.scheduled_experiment_timestamp),
    createdTime: metaTime(raw.creation_time), updatedTime: metaTime(raw.updated_time),
    declaredWinnerVideoId: idText(raw.declared_winning_video_id ?? raw.declared_winning_video), declaredWinnerTime: metaTime(raw.declared_winning_time),
    ...(videos ? {
      insightsTime: metaTime(insights?.timestamp),
      videos: Object.entries(videos).map(([videoId, metrics]) => ({ videoId, ...videoMetrics(metrics) })),
    } : {}),
    // The SDK's snapshots have no documented shape: all of it is restricted (snapshotsAsMeta).
    ...(raw.insight_snapshots !== undefined ? { snapshotsAsMeta: graphSafe(raw.insight_snapshots) } : {}),
  }
}

const NO_PAGE = 'No Facebook Page is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'
const VIDEO_TEST_NOTE = 'Meta\'s Video A/B Testing API for the chosen Page (2–4 unpublished reels or videos per test, up to 50 tests at once). Meta\'s guide asks for a Page access token: Nexus reads the Page with the business\'s system-user token, so when Meta\'s words ask for a Page token or permission, the read comes with a later Nexus step.'

/** A day (YYYY-MM-DD) as epoch seconds at 00:00 UTC (the video test list's since); `until` is the end of its own day. */
const epochOf = (day: string) => Math.floor(Date.parse(`${day}T00:00:00Z`) / 1000)
const endOfDayEpoch = (day: string) => epochOf(addDays(day, 1)) - 1

export interface ExperimentInput {
  connectionId?: string | null
  view: ExperimentView
  studyId?: string | null
  objectiveId?: string | null
  objectKind?: typeof OBJECT_KINDS[number] | null
  objectId?: string | null
  campaignId?: string | null
  type?: typeof STUDY_TYPES[number] | null
  state?: StudyState | null
  nameContains?: string | null
  breakdowns?: Array<typeof RESULT_BREAKDOWNS[number]> | null
  /** Results as of this day (Meta's ds; within the last 30 days). */
  ds?: string | null
  withResults?: boolean
  testId?: string | null
  since?: string | null
  until?: string | null
  maxRows?: number
}

export async function metaExperiments(input: ExperimentInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const base = { account: accountHeader(account) }
  const maxRows = clampRows(input.maxRows, 200)
  const breakdowns = input.breakdowns?.length ? [...new Set(input.breakdowns)] : ['cell_id']
  if (breakdowns.includes('country') && !breakdowns.includes('cell_id')) throw new MetaLiveRefusal('Meta breaks results down by country only together with cell_id.')
  // Review fix B5 — Meta's results "as of a day in the last 30 days" (lift guide, master EX-007): checked before any call.
  const ds = input.ds ?? null
  if (ds) {
    const today = accountToday(account.timeZone ?? 'UTC')
    if (ds > today || ds < addDays(today, -30)) throw new MetaLiveRefusal(`ds is a day in the last 30 days (${addDays(today, -30)} to ${today}, the account's time zone).`)
  }

  switch (input.view) {
    case 'list': {
      // EX-001 (+ the Ads CLI's filters, EX-904): Meta's list documents no parameter, so Nexus filters what it answers.
      const word = input.nameContains?.trim().toLowerCase() || null
      const read = await readMatching(connectionId, 'experiments.impacting', `${act(adAccountId)}/impacting_ad_studies`, { fields: STUDY_FIELDS }, (r) => mapStudy(r, account),
        (s) => (!input.type || s.type === input.type) && (!input.state || s.state === input.state) && (!word || (s.name ?? '').toLowerCase().includes(word)), maxRows)
      return {
        ...base, items: read.items, matching: read.items.length, read: read.all.length, more: read.more, capNote: read.capNote,
        running: read.all.filter((s) => s.state === 'running').length,
        note: `Studies that touch the chosen ad account or anything in it (Meta's impacting_ad_studies); type, state and name are filtered by Nexus. ${STUDY_NOTE}`,
      }
    }
    case 'portfolio': {
      // EX-002 — the portfolio's own studies; one that does not touch the chosen ad account is its id only.
      const businessId = account.businessId
      if (!businessId) throw new MetaLiveRefusal('The chosen ad account belongs to no business portfolio Meta named: view list reads the studies that touch the account.')
      const [owned, touching] = await Promise.all([
        list(connectionId, 'experiments.portfolio', `${businessId}/ad_studies`, { fields: STUDY_FIELDS }, maxRows),
        impactingStudies(account, 'id', 1000),
      ])
      const mine = new Set(touching.rows.map((r) => idText(r.id)).filter(Boolean))
      return {
        ...base, businessId,
        items: owned.rows.map((r) => (mine.has(idText(r.id)) ? { ...mapStudy(r, account), touchesThisAdAccount: true } : { studyId: idText(r.id), touchesThisAdAccount: false })),
        more: owned.more,
        note: 'The business portfolio\'s own studies. One that does not touch the chosen ad account is shown by its id only: it may belong to another business.',
      }
    }
    case 'study': {
      // EX-004 / 005 / 006 (+ 007 when withResults): like Meta's own get-test tools — details, state, groups, goals, results.
      if (!input.studyId) throw new MetaLiveRefusal('Name the study (studyId, from view list).')
      const own = await ownStudy(account, input.studyId)
      const study = mapStudy((await metaReadOne({ connectionId }, { operation: 'experiments.study', path: own.studyId, query: { fields: STUDY_FIELDS } })).body as Row, account)
      const [cells, objectives] = await Promise.all([
        part(async () => {
          const read = await listWithFallback(connectionId, 'experiments.cells', `${own.studyId}/cells`, CELL_FIELDS, CELL_EXTRA_FIELDS, {}, 150)
          return { items: await mapCells(read.rows, account), note: read.note }
        }),
        part(async () => (await list(connectionId, 'experiments.objectives', `${own.studyId}/objectives`, { fields: OBJECTIVE_FIELDS }, 50)).rows.map(mapObjective)),
      ])
      const results = input.withResults === false || !objectives.value?.length ? [] : await Promise.all(objectives.value.slice(0, 10).map(async (o) => {
        const r = await part(() => objectiveResults(account, o.objectiveId!, breakdowns, ds))
        return r.value ?? { ...o, notRead: r.notRead }
      }))
      return {
        ...base, study, cells: cells.value?.items ?? null, cellsNote: cells.value?.note ?? null, cellsNotRead: cells.notRead,
        objectives: objectives.value, objectivesNotRead: objectives.notRead, results,
        note: `${STUDY_NOTE} ${study.type === 'LIFT' || study.type === 'GEO_LIFT' ? LIFT_NOTE : ''}`.trim(),
      }
    }
    case 'results': {
      // EX-007 / EX-008 — one objective's results (or every objective of the study), with Meta's breakdowns.
      if (!input.studyId) throw new MetaLiveRefusal('Name the study (studyId, from view list); objectiveId is optional.')
      const own = await ownStudy(account, input.studyId)
      const objectives = (await list(connectionId, 'experiments.objectives', `${own.studyId}/objectives`, { fields: 'id' }, 50)).rows.map((o) => idText(o.id)).filter((id): id is string => !!id)
      if (input.objectiveId && !objectives.includes(input.objectiveId)) throw new MetaLiveRefusal('That objective is not one of this study\'s (view study lists them), so it is not read.')
      const ids = input.objectiveId ? [input.objectiveId] : objectives.slice(0, 10)
      const old = own.startTime && own.startTime < '2021-07-13'
      return {
        ...base, studyId: own.studyId, type: own.type,
        objectives: await Promise.all(ids.map((id) => objectiveResults(account, id, breakdowns, ds))),
        note: `${old ? '' : 'Studies started after 2021-07-13 have no "buyers" metrics and no age, gender or country breakdowns. '}Metric names are Meta's (its Lift Metrics Glossary); moneyAsMeta holds spend, cost and value metrics and any metric Nexus does not know, in Meta's own units. ${own.type === 'LIFT' || own.type === 'GEO_LIFT' ? LIFT_NOTE : ''}`.trim(),
      }
    }
    case 'sharing': {
      // EX-009 — who may see the study (people: ids only) and which ad accounts can use it (another business's: id only).
      if (!input.studyId) throw new MetaLiveRefusal('Name the study (studyId, from view list).')
      const own = await ownStudy(account, input.studyId)
      const [viewers, related] = await Promise.all([
        part(async () => (await list(connectionId, 'experiments.viewers', `${own.studyId}/viewers`, { fields: 'id' }, 200)).rows.map((r) => person(r, account)).filter(Boolean)),
        part(async () => {
          const rows = (await list(connectionId, 'experiments.relatedAccounts', `${own.studyId}/related_ad_accounts`, { fields: 'account_id,name' }, 200)).rows
          const names = new Map(rows.map((r) => [metaAdAccountId(r.account_id ?? r.id) ?? '', text(r.name)]))
          return accountsMasked(rows.map((r) => String(r.account_id ?? r.id ?? '')), account, names)
        }),
      ])
      return { ...base, studyId: own.studyId, viewers: viewers.value, viewersNotRead: viewers.notRead, adAccounts: related.value, adAccountsNotRead: related.notRead, note: 'People are Meta ids only (their names stay on Meta\'s side). Sharing a study (set-meta-experiment) comes with a later Nexus step (step 28).' }
    }
    case 'object': {
      // AD-019 / EX-003 — is this campaign, ad set or ad in a test (before changing it)?
      if (!input.objectId || !input.objectKind) throw new MetaLiveRefusal('Name the object: objectKind (campaign, adset or ad) and objectId.')
      const id = await objectInAccount(account, input.objectId, input.objectKind, 'experiments.ownerCheck')
      const read = await list(connectionId, `experiments.${input.objectKind}Studies`, `${id}/ad_studies`, { fields: STUDY_FIELDS }, maxRows)
      const items = read.rows.map((r) => mapStudy(r, account))
      const live = items.filter((s) => s.state === 'running' || s.state === 'planned' || s.state === 'measuring')
      return {
        ...base, objectKind: input.objectKind, objectId: id, items, more: read.more, inATestNow: live.length > 0,
        sentence: live.length
          ? `This ${input.objectKind === 'adset' ? 'ad set' : input.objectKind} is in ${live.length} test${live.length === 1 ? '' : 's'} not finished yet: changing it can spoil the test.`
          : `This ${input.objectKind === 'adset' ? 'ad set' : input.objectKind} is in no test that is still running or planned.`,
      }
    }
    case 'brand-lift': {
      // EX-012 — can the account (and a campaign) have a brand lift study, and which brand lift studies a campaign has.
      const accountRead = await part(async () => bool(((await metaReadOne({ connectionId }, { operation: 'experiments.brandLiftAccount', path: act(adAccountId), query: { fields: 'can_create_brand_lift_study' } })).body as Row).can_create_brand_lift_study))
      let campaign: Row | null = null
      if (input.campaignId) {
        const id = await objectInAccount(account, input.campaignId, 'campaign', 'experiments.ownerCheck')
        const body = (await metaReadOne({ connectionId }, { operation: 'experiments.brandLiftCampaign', path: id, query: { fields: 'can_create_brand_lift_study,brand_lift_studies{id,name,type,start_time,end_time,observation_end_time,canceled_time}' } })).body as Row
        campaign = { campaignId: id, canCreateBrandLiftStudy: bool(body.can_create_brand_lift_study), studies: (Array.isArray(body.brand_lift_studies) ? body.brand_lift_studies : rowsOf(body.brand_lift_studies)).map(obj).filter((s): s is Row => !!s).map((s) => mapStudy(s, account)) }
      }
      return { ...base, canCreateBrandLiftStudy: accountRead.value, accountNotRead: accountRead.notRead, campaign, note: 'Brand lift studies are Meta\'s "Automated Brand Lift V2" studies; making one (create-meta-experiment, where Meta allows it) comes with a later Nexus step (step 28).' }
    }
    case 'private-lift': {
      // EX-010 — Meta-run private lift computations and continuous lift configs (only where a study of that kind exists).
      if (!input.studyId) throw new MetaLiveRefusal('Name the study (studyId, from view list).')
      const own = await ownStudy(account, input.studyId)
      const [instances, configs] = await Promise.all([
        part(async () => (await list(connectionId, 'experiments.instances', `${own.studyId}/instances`, { fields: 'id,status,created_time,latest_status_update_time,breakdown_key,run_id,tier,feature_list' }, 100)).rows.map((r) => ({
          instanceId: idText(r.id), status: text(r.status), createdTime: metaTime(r.created_time), lastStatusTime: metaTime(r.latest_status_update_time),
          breakdownKey: text(r.breakdown_key), runId: idText(r.run_id), tier: text(r.tier), features: arr(r.feature_list),
        }))),
        part(async () => (await list(connectionId, 'experiments.continuousLift', `${own.studyId}/continuous_lift_config`, { fields: STUDY_FIELDS }, 100)).rows.map((r) => mapStudy(r, account))),
      ])
      return { ...base, studyId: own.studyId, type: own.type, privateLiftInstances: instances.value, instancesNotRead: instances.notRead, continuousLiftConfigs: configs.value, configsNotRead: configs.notRead, note: 'Private and continuous lift are run by Meta (Meta\'s grant); most studies have neither, and Meta answers an empty list or refuses.' }
    }
    case 'page-video-tests': {
      // EX-900 — the chosen Page's organic video A/B tests.
      if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE)
      if (input.since && input.until && input.until < input.since) throw new MetaLiveRefusal('until is before since.')
      const read = await listWithFallback(connectionId, 'experiments.pageVideoTests', `${account.pageId}/ab_tests`, VIDEO_TEST_CORE, [VIDEO_TEST_LIST_GUIDE, VIDEO_TEST_LIST_SDK], {
        ...(input.since ? { since: epochOf(input.since) } : {}), ...(input.until ? { until: endOfDayEpoch(input.until) } : {}),
      }, maxRows)
      return { ...base, pageId: account.pageId, items: read.rows.map(mapVideoTest), more: read.more, fieldsNote: read.note, note: VIDEO_TEST_NOTE }
    }
    case 'page-video-test': {
      // EX-903 — one Page video test with its per-video numbers and the declared winner (GET /<test id>, RECHECK EX-903).
      if (!account.pageId) throw new MetaLiveRefusal(NO_PAGE)
      const testId = input.testId ? metaObjectId(input.testId) : null
      if (!testId) throw new MetaLiveRefusal('Name the test (testId, digits, from view page-video-tests).')
      const tests = await list(connectionId, 'experiments.pageVideoTestCheck', `${account.pageId}/ab_tests`, { fields: 'id' }, 500)
      if (!tests.rows.some((r) => idText(r.id) === testId)) throw new MetaLiveRefusal('That test is not one of the chosen Page\'s video tests, so it is not read.')
      const read = await oneWithFallbacks(connectionId, 'experiments.pageVideoTest', testId, VIDEO_TEST_CORE, [VIDEO_TEST_GUIDE, VIDEO_TEST_SDK])
      return { ...base, pageId: account.pageId, test: mapVideoTest(read.body), fieldsNote: read.note, note: `${VIDEO_TEST_NOTE} moneyAsMeta holds the in-stream ad earnings and any metric Nexus does not know, in Meta's own units.` }
    }
  }
}

// ── meta-ad-rules ────────────────────────────────────────────────────────────────────────────────────────────────

export const RULE_VIEWS = ['list', 'rule', 'history', 'account-history', 'preview'] as const
export type RuleView = typeof RULE_VIEWS[number]
export const RULE_STATUSES = ['ENABLED', 'DISABLED', 'HAS_ISSUES', 'DELETED'] as const
export const RULE_EVALUATION_TYPES = ['SCHEDULE', 'TRIGGER'] as const
/** The history actions Meta names (SDK adrulehistory.py Action). */
export const RULE_HISTORY_ACTIONS = [
  'BUDGET_NOT_REDISTRIBUTED', 'CHANGED_BID', 'CHANGED_BUDGET', 'CONSOLIDATE_ASC_FRAGMENTATION', 'CONSOLIDATE_FRAGMENTATION', 'CONVERT_ASC_CP_SINGLE_INSTANCE',
  'EMAIL', 'ENABLE_ADVANTAGE_CAMPAIGN_BUDGET', 'ENABLE_ADVANTAGE_PLUS_AUDIENCE', 'ENABLE_ADVANTAGE_PLUS_CREATIVE', 'ENABLE_ADVANTAGE_PLUS_PLACEMENTS',
  'ENABLE_AUTOFLOW', 'ENABLE_GEN_UNCROP', 'ENABLE_LANDING_PAGE_VIEWS', 'ENABLE_MUSIC', 'ENABLE_PIXELLESS_LPV_OPTIMIZATION_GOAL',
  'ENABLE_PRODUCT_SET_BOOSTING', 'ENABLE_REELS_PLACEMENTS', 'ENABLE_SEMANTIC_BASED_AUDIENCE_EXPANSION', 'ENABLE_SHOPS_ADS', 'ENABLE_SHOPS_ADS_SAOFF',
  'ENABLE_WTWA_UPSELL_IN_DUPLICATION', 'ENDPOINT_PINGED', 'ERROR', 'FACEBOOK_NOTIFICATION_SENT', 'MESSAGE_SENT', 'NOT_CHANGED', 'PAUSED', 'UNPAUSED',
] as const

const RULE_FIELDS = 'id,account_id,name,status,evaluation_spec,execution_spec,schedule_spec,created_by{id},created_time,updated_time,disable_error_code'
const HISTORY_FIELDS = 'timestamp,is_manual,results,evaluation_spec,execution_spec,schedule_spec,exception_code,exception_message'

const STATUS_WORDS: Record<string, string> = {
  ENABLED: 'on', DISABLED: 'off', DELETED: 'deleted',
  HAS_ISSUES: 'stopped by Meta because it has issues (disable_error_code is Meta\'s reason; Meta does not document the codes)',
}
const EXECUTION_WORDS: Record<string, string> = {
  PAUSE: 'pauses the matching objects', UNPAUSE: 'switches the matching objects on (they can spend)', CHANGE_BUDGET: 'changes ad set budgets',
  CHANGE_CAMPAIGN_BUDGET: 'changes campaign budgets', CHANGE_BID: 'changes ad set bids', NOTIFICATION: 'notifies people',
  PING_ENDPOINT: 'calls the app\'s webhook', ROTATE: 'rotates the ads of an ad set', REBALANCE_BUDGET: 'moves budget between ad sets',
}
const TRIGGER_WORDS: Record<string, string> = {
  METADATA_CREATION: 'when an object is created', METADATA_UPDATE: 'when a setting changes', STATS_MILESTONE: 'each time a number reaches a milestone',
  STATS_CHANGE: 'when a number crosses its threshold', DELIVERY_INSIGHTS_CHANGE: 'when delivery insights change (Meta beta)',
}
const SCHEDULE_WORDS: Record<string, string> = {
  DAILY: 'once a day, just after midnight in the account\'s time zone', HOURLY: 'every hour', SEMI_HOURLY: 'every 30 minutes', CUSTOM: 'at the set times',
}
const HISTORY_ACTION_WORDS: Record<string, string> = {
  CHANGED_BID: 'changed the bid', CHANGED_BUDGET: 'changed the budget', PAUSED: 'paused it', UNPAUSED: 'switched it on', NOT_CHANGED: 'changed nothing',
  EMAIL: 'sent an e-mail', FACEBOOK_NOTIFICATION_SENT: 'sent a Facebook notification', MESSAGE_SENT: 'sent a message', ENDPOINT_PINGED: 'called the webhook',
  ERROR: 'failed', BUDGET_NOT_REDISTRIBUTED: 'did not move budget',
}

/**
 * Is a rule field money (the base unit of the account currency)? Spend, budgets, spend caps, bids and every cost metric
 * (evaluation-spec: metadata daily_budget, lifetime_budget, spend_cap, bid_amount with an adset. / campaign. prefix;
 * insights spent, today_spent, …, cpc, cpm, cpa, cpp, cost_per_…; an advanced field "level.window:field" too).
 */
export function isMoneyRuleField(field: string | null): boolean {
  if (!field) return false
  const base = field.split(':').pop()!.split('.').pop()!.toLowerCase()
  return /^(spent|today_spent|yesterday_spent|lifetime_spent|daily_budget|lifetime_budget|spend_cap|bid_amount|cpc|cpm|cpa|cpp|cost_per|cost_per_[a-z0-9_]+)$/.test(base)
}

/** One filter or trigger: its value, or (money) its amount in minor units under `valueCents`. */
function condition(raw: Row, currency: string | null) {
  const field = text(raw.field)
  return {
    field, operator: text(raw.operator),
    ...(isMoneyRuleField(field) ? { valueCents: centsOrRange(raw.value, currency) } : { value: graphSafe(raw.value) }),
  }
}

/** A JSON value Meta may give as a string ('{"amount":…}'), read as an object. */
const objOrJson = (v: unknown): Row | null => {
  if (typeof v === 'string') { try { return obj(JSON.parse(v)) } catch { return null } }
  return obj(v)
}

function executionOption(raw: Row, account: MetaChosenAccount) {
  const field = text(raw.field)
  const value = raw.value
  if (field === 'change_spec') {
    const spec = objOrJson(value) ?? {}
    const unit = text(spec.unit)
    const target = text(spec.target_field)
    const amount = target
      ? (isMoneyRuleField(target) ? { targetValueCents: metaBudgetCents(spec.amount, account.currency) } : { targetValue: num(spec.amount) })
      : unit === 'PERCENTAGE' ? { amountPercent: num(spec.amount) } : { amountCents: metaBudgetCents(spec.amount, account.currency) }
    return { option: 'change_spec', unit, targetField: target, ...amount, ...(spec.limit !== undefined && spec.limit !== null ? { limitCents: centsOrRange(spec.limit, account.currency) } : {}) }
  }
  if (field === 'user_ids') return { option: 'user_ids', people: idsOf(Array.isArray(value) ? value : [value]).map((id) => person(id, account)) }
  if (field === 'execution_count_limit' || field === 'action_frequency') return { option: field, value: num(value) }
  return { option: field, operator: text(raw.operator), value: graphSafe(value) }
}

/** Could this rule raise spend when it runs (switch on, a budget or bid raise, or a change towards a target)? */
function canRaiseSpend(type: string | null, options: Array<Record<string, unknown>>): boolean {
  if (type === 'UNPAUSE') return true
  if (type !== 'CHANGE_BUDGET' && type !== 'CHANGE_CAMPAIGN_BUDGET' && type !== 'CHANGE_BID' && type !== 'REBALANCE_BUDGET') return false
  if (type === 'REBALANCE_BUDGET') return true
  const spec = options.find((o) => o.option === 'change_spec')
  if (!spec) return true
  if (spec.targetField) return true
  const amount = (spec.amountCents ?? spec.amountPercent) as number | null | undefined
  return amount === null || amount === undefined || amount > 0
}

export function mapRule(raw: Row, account: MetaChosenAccount) {
  const evaluation = obj(raw.evaluation_spec) ?? {}
  const execution = obj(raw.execution_spec) ?? {}
  const schedule = obj(raw.schedule_spec)
  const evaluationType = text(evaluation.evaluation_type)
  const trigger = obj(evaluation.trigger)
  const filters = arr(evaluation.filters).map(obj).filter((f): f is Row => !!f).map((f) => condition(f, account.currency))
  const executionType = text(execution.execution_type)
  const options = arr(execution.execution_options).map(obj).filter((o): o is Row => !!o).map((o) => executionOption(o, account))
  const status = text(raw.status)
  const entity = filters.find((f) => f.field === 'entity_type')
  return {
    ruleId: idText(raw.id), name: text(raw.name), status, statusText: status ? STATUS_WORDS[status] ?? status : null,
    hasIssues: status === 'HAS_ISSUES', disableErrorCode: num(raw.disable_error_code),
    evaluationType,
    // RU-001 trap — a trigger rule is API-only: Ads Manager never shows it, so Nexus lists it here.
    visibleInAdsManager: evaluationType !== 'TRIGGER',
    appliesTo: entity && 'value' in entity ? entity.value : null,
    filters,
    trigger: trigger ? { type: text(trigger.type), typeText: TRIGGER_WORDS[text(trigger.type) ?? ''] ?? null, ...condition(trigger, account.currency) } : null,
    action: { type: executionType, text: executionType ? EXECUTION_WORDS[executionType] ?? executionType : null, isOnceOff: bool(execution.is_once_off), options },
    canRaiseSpend: canRaiseSpend(executionType, options),
    schedule: schedule ? {
      type: text(schedule.schedule_type), text: SCHEDULE_WORDS[text(schedule.schedule_type) ?? ''] ?? null,
      times: arr(schedule.schedule).map(obj).filter((s): s is Row => !!s).map((s) => ({ days: arr(s.days).map(num), startMinute: num(s.start_minute), endMinute: num(s.end_minute) })),
    } : evaluationType === 'TRIGGER' ? { type: null, text: 'runs when its trigger fires (seconds to about 7.5 minutes after the change)', times: [] } : null,
    createdBy: person(raw.created_by, account), createdTime: metaTime(raw.created_time), updatedTime: metaTime(raw.updated_time),
  }
}

function mapHistory(raw: Row, account: MetaChosenAccount) {
  const evaluation = obj(raw.evaluation_spec) ?? {}
  const execution = obj(raw.execution_spec) ?? {}
  const results = arr(raw.results).map(obj).filter((r): r is Row => !!r).map((r) => ({
    objectId: idText(r.object_id), objectType: text(r.object_type),
    actions: arr(r.actions).map(obj).filter((a): a is Row => !!a).map((a) => {
      const field = text(a.field)
      const action = text(a.action)
      return {
        action, actionText: action ? HISTORY_ACTION_WORDS[action] ?? action : null, field,
        ...(isMoneyRuleField(field)
          ? { oldValueCents: metaBudgetCents(a.old_value, account.currency), newValueCents: metaBudgetCents(a.new_value, account.currency) }
          : { oldValue: graphSafe(a.old_value ?? null), newValue: graphSafe(a.new_value ?? null) }),
      }
    }),
  }))
  // The account history's rule_id is an int in Meta's SDK: a JSON number past 2^53 cannot be read exactly, so it is not
  // guessed (each rule's own history, view history, names its runs).
  const unsafeRuleId = typeof raw.rule_id === 'number' && !Number.isSafeInteger(raw.rule_id)
  return {
    ...(raw.rule_id !== undefined ? { ruleId: unsafeRuleId ? null : idText(raw.rule_id) } : {}),
    ...(unsafeRuleId ? { ruleIdNote: 'Meta sent this rule id as a number too long to read exactly; view history of each rule (ruleId from view list) shows its runs.' } : {}),
    time: metaTime(raw.timestamp), manual: bool(raw.is_manual),
    error: raw.exception_code !== undefined || raw.exception_message !== undefined ? { code: num(raw.exception_code), message: text(raw.exception_message) } : null,
    ruleAtRun: { evaluationType: text(evaluation.evaluation_type), action: text(execution.execution_type) },
    results,
    changedSomething: results.some((r) => r.actions.some((a) => a.action && a.action !== 'NOT_CHANGED')),
  }
}

/**
 * RU-031 — why the rule preview is not here (the header has the proof): Meta's preview is a POST, the gateway's reads are
 * GET only, and Meta documents no GET form.
 */
export const RULE_PREVIEW_SENTENCE = 'Meta\'s preview of a rule (which objects a schedule rule would hit now) is a POST request (POST /<rule id>/preview, Meta\'s Ad Rules guide), and Meta documents no read (GET) form of it. Nexus\'s reads never send a POST, so the preview comes with set-meta-ad-rule (step 29), next to running a rule now. Until then: view rule says the rule\'s conditions in plain words, view history what it did at each run, and meta-ads-live shows the objects as they are now.'

export interface RuleInput {
  connectionId?: string | null
  view: RuleView
  ruleId?: string | null
  status?: typeof RULE_STATUSES[number] | null
  evaluationType?: typeof RULE_EVALUATION_TYPES[number] | null
  objectId?: string | null
  action?: typeof RULE_HISTORY_ACTIONS[number] | null
  hideNoChanges?: boolean
  maxRows?: number
}

/**
 * A rule id from a caller (review fix A5): its account_id ALONE is read first and must be the chosen ad account; only then
 * is anything of the rule read (`fields`, which name a field only a rule has, so another node of the account — a campaign
 * — is refused by Meta, #100, and never read on).
 */
async function ownRule(account: MetaChosenAccount, ruleId: string, fields: string): Promise<{ id: string; body: Row }> {
  const id = metaObjectId(ruleId)
  if (!id) throw new MetaLiveRefusal(`"${ruleId}" is not a Meta rule id (digits).`)
  const notARule = () => new MetaLiveRefusal('That is not a rule of the ad account this business chose (Meta does not show it as one), so it is not read.')
  const read = async (operation: string, asked: string) => {
    try {
      return (await metaReadOne({ connectionId: account.connectionId }, { operation, path: id, query: { fields: asked } })).body as Row
    } catch (err) {
      if (err instanceof MetaReadError && (err.failure.notFound || err.failure.permissionDenied || fieldRefused(err))) throw notARule()
      throw err
    }
  }
  const owner = await read('rules.ownerCheck', 'account_id')
  if (metaAdAccountId(owner.account_id) !== account.adAccountId) throw new MetaLiveRefusal('That rule belongs to another ad account than the one this business chose, so it is not read.')
  const body = await read('rules.read', fields)
  if (body.evaluation_spec === undefined || body.evaluation_spec === null) throw notARule()
  return { id, body }
}

export async function metaAdRules(input: RuleInput) {
  if (input.view === 'preview') return { sentence: RULE_PREVIEW_SENTENCE }
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const base = { account: accountHeader(account) }
  const maxRows = clampRows(input.maxRows, 200)
  const filters = {
    ...(input.objectId ? { object_id: input.objectId } : {}), ...(input.action ? { action: input.action } : {}),
    ...(input.hideNoChanges ? { hide_no_changes: true } : {}),
  }
  const money = 'Money in conditions, actions and history in minor units (cents) of the account currency.'

  switch (input.view) {
    case 'list': {
      // RU-001 / RU-034 — every rule, trigger rules too (Ads Manager does not show those), with the ones Meta stopped.
      const read = await readMatching(connectionId, 'rules.library', `${act(adAccountId)}/adrules_library`, { fields: RULE_FIELDS }, (r) => mapRule(r, account),
        (r) => (!input.status || r.status === input.status) && (!input.evaluationType || r.evaluationType === input.evaluationType), maxRows)
      const all = read.all
      return {
        ...base, items: read.items, more: read.more, capNote: read.capNote,
        // Of the rules read (all of them unless capNote says the cap stopped the read).
        counts: { all: all.length, on: all.filter((r) => r.status === 'ENABLED').length, withIssues: all.filter((r) => r.hasIssues).length, triggerRules: all.filter((r) => !r.visibleInAdsManager).length, canRaiseSpend: all.filter((r) => r.canRaiseSpend && r.status === 'ENABLED').length },
        note: `Trigger rules (evaluationType TRIGGER) run on Meta but Ads Manager never shows them: this list does. A rule with issues was stopped by Meta (disableErrorCode; Meta does not document the codes). ${money}`,
      }
    }
    case 'rule': {
      if (!input.ruleId) throw new MetaLiveRefusal('Name the rule (ruleId, from view list).')
      const { body } = await ownRule(account, input.ruleId, RULE_FIELDS)
      return { ...base, rule: mapRule(body, account), note: money }
    }
    case 'history': {
      // RU-029 — one rule's runs: what it did to which object, with the rule as it was at each run.
      if (!input.ruleId) throw new MetaLiveRefusal('Name the rule (ruleId, from view list); view account-history reads every rule\'s runs.')
      // evaluation_spec only a rule has: another node of the account (a campaign) is refused by Meta (#100), never read on.
      const { id } = await ownRule(account, input.ruleId, 'id,evaluation_spec')
      const read = await list(connectionId, 'rules.history', `${id}/history`, { fields: HISTORY_FIELDS, ...filters }, maxRows)
      return { ...base, ruleId: id, runs: read.rows.map((r) => mapHistory(r, account)), more: read.more, note: `Newest first as Meta gives them; the rule's own state at each run shows its edits. ${money}` }
    }
    case 'account-history': {
      // RU-030 — every rule's runs on the account, newest first, each with its rule id.
      // The evaluation type is filtered by Nexus (Meta's evaluation_type parameter here is SDK only, never sent).
      const read = await readMatching(connectionId, 'rules.accountHistory', `${act(adAccountId)}/adrules_history`, { fields: `${HISTORY_FIELDS},rule_id`, ...filters }, (r) => mapHistory(r, account),
        (r) => !input.evaluationType || r.ruleAtRun.evaluationType === input.evaluationType, maxRows)
      return { ...base, runs: read.items, more: read.more, capNote: read.capNote, note: `Every rule's runs, newest first. ${money}` }
    }
  }
}

