/**
 * Meta step 27 (2026-10-21) — create-meta-ad and set-meta-ad as drafts (master rows of step 27: AD-023 … AD-044, CR-211,
 * CR-218, CR-401, CR-404, CR-425 … CR-436, CR-464, CR-471; facts F1 M6-01 … M6-05, M6-09, M5-15, M5-16, M5-20, M5-21). Each
 * draft is built from the request and what Meta holds NOW (reads only, through the gateway); the requests carry their own
 * senders (write client → gateway: the write allow-list in gateway/meta-ad-rules.ts, which judges every key and checks every
 * id inside the body).
 *
 *   create   ONE ad of the chosen ad account (POST /act_<id>/ads), in an ad set of it, from an existing creative of it
 *            (creative_id) or an inline creative built by step 25's ONE builder (buildCreative: every silent feature OFF
 *            unless asked, the chosen Page and Instagram account filled in) — born PAUSED unless `activate` (then it can
 *            spend: the preview says whether its ad set AND campaign are on now). Meta's check first: validate_only WITH
 *            synchronous_ad_review (Meta's integrity checks of the text and images; "does not represent the final decision"),
 *            and Meta's recommendations as read-only words when asked (AD-026 … AD-028). Read first: the ad set (its status,
 *            Dynamic Creative, an ad sequence, its end, its EU targeting and EU payer / beneficiary), its campaign (status,
 *            objective, special ad categories), the ads already in it (Meta: 50 per ad set; ONE in a Dynamic Creative ad set),
 *            the account's EU defaults when the ad set has none, the existing creative (its features generated with AI, its
 *            political class, its links) and the account's pixels named for tracking.
 *   undo     DELETE /<ad id> of an ad an earlier create-meta-ad of this business made (its record says so), that has never
 *            run (no spend, no impression since it was made — insights read first), is not ACTIVE, not Dynamic Creative and
 *            not in an ad set with an ad sequence (Meta deletes neither) — then the inline creative it made NEW, when no other ad
 *            uses it and the ad is gone. An ad that has run stays: Meta keeps its numbers; archive it with set-meta-status.
 *   set      POST /<ad id>: its name, the creative it shows (a swap to another creative of the account: the ad goes back to
 *            Meta's review), its label list, its own start / end time (sales and app-promotion campaigns only) or clearing
 *            them; POST /<ad id>/adlabels: labels added. Undo puts back what it wrote, after reading the ad LIVE (a later
 *            change is never overwritten).
 *
 * Answered in words (no request): an inline ad set (AD-025: Meta documents no shape), many ads at once in the background
 * (AD-035, POST /act_<id>/asyncadrequestsets — the gateway refuses every batch: Nexus sends one request per ad), catalog and
 * product-set parts (CR-211, CR-464, CR-471: step 25's judge refuses them until step 18's catalog rule, C2-REBASE-18).
 */
import prisma from '../../../db.js'
import {
  AD_STATUSES_BUT_DELETED, AD_TOOL, buildCreative, cleanCreativeJson, createdSentence, creativeWarnings, madeNode, type CreativeRequest,
} from './change-creatives.js'
import {
  aiFeaturesOn, judgeAdCreative, META_AD_CHECK, META_AD_CHECK_WITH_RECOMMENDATIONS, META_AD_NAME_MAX, META_CONVERSION_DOMAIN, trackingPixels,
} from '../../gateway/meta-ad-rules.js'
import { judgeAdPersona, judgeAssetGroups, META_AI_GENERATED_FEATURES, META_CREATIVE_TEXT, metaCreativeTextProblem } from '../../gateway/meta-creative-rules.js'
import { changeLines, type MetaChangeDraft, type MetaChangeRequest } from './change-draft.js'
import type { MetaChangeAccount } from './change-account.js'
import { metaSendChange, MetaWriteError, META_UNKNOWN_OUTCOME, type MetaChangeResult, type MetaWriteTarget } from './write-client.js'
import { localFailure } from './errors.js'
import { metaReadOne } from './read-client.js'
import { metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { pageOf } from './live-media.js'
import { listPaged } from './live-objects.js'

export { AD_TOOL }
export const SET_AD_TOOL = 'set-meta-ad'
/** Meta: 50 non-deleted ads per ad set (reference/adgroup; the ad set page says non-archived — Nexus counts archived ones too). */
export const META_ADS_PER_AD_SET = 50
/** At most this many ads taken back per request. */
export const MAX_AD_UNDO = 10
/** How many of the account's ads the undo reads to see no other ad uses the creative (fail closed past them). */
const ADS_READ_MAX = 500
/** The campaign objectives Meta takes an ad's own schedule (AD-031) and the flexible ad format (CR-430) on. */
export const SALES_AND_APP_OBJECTIVES = ['OUTCOME_SALES', 'OUTCOME_APP_PROMOTION'] as const
/** The channels of a website ad's "message us" footer (CR-218). */
export const MESSAGE_FOOTERS = ['whatsapp', 'messenger', 'instagram_message'] as const

/**
 * The EU and its outermost regions Meta's DSA rule covers ("the EU, associated territories"): an ad under an ad set that
 * targets any of them needs a payer and a beneficiary (F1 X7; errors 3858079 / 3858081 / 3858152).
 */
export const DSA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'GF', 'GP', 'MQ', 'RE', 'YT', 'MF', 'AX',
])

// ── small pieces ────────────────────────────────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>
const isObject = (v: unknown): v is Row => !!v && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idOf = (value: unknown): string | null => (typeof value === 'string' || typeof value === 'number') && /^\d{1,25}$/.test(String(value)) ? String(value) : null
const nowSec = () => Math.floor(Date.now() / 1000)
/** A time a caller gives (ISO 8601 with its offset) as UTC Unix seconds, or null. */
export const unixOf = (iso: string): number | null => { const t = Date.parse(iso); return Number.isFinite(t) ? Math.floor(t / 1000) : null }
/** A time Meta reads back (ISO 8601, `+0000`) or Nexus sends (Unix seconds), as ONE ISO spelling — or null. */
export function isoOf(value: unknown): string | null {
  if (value === null || value === undefined || value === '') return null
  const text = String(value)
  const ms = /^\d{9,11}$/.test(text) ? Number(text) * 1000 : Date.parse(text.replace(/([+-]\d{2})(\d{2})$/, '$1:$2'))
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null
}
/** A day as Meta's insights count it (the ad account's time zone; UTC when Nexus does not know it). */
function dayIn(ms: number, timeZone: string | null): string {
  try {
    return new Intl.DateTimeFormat('en-CA', { timeZone: timeZone ?? 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch {
    return new Date(ms).toISOString().slice(0, 10)
  }
}
const statusWords = (status: string | null, effective: string | null) => `${status ?? 'status unknown'}${effective && effective !== status ? ` (${effective})` : ''}`

/** Every https link a creative names at any depth (link, website_url, product_link, url, carousel_see_more_url). */
function creativeLinks(value: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 14 || !value || typeof value !== 'object') return out
  if (Array.isArray(value)) { for (const v of value) creativeLinks(v, out, depth + 1); return out }
  for (const [k, v] of Object.entries(value as Row)) {
    if (typeof v === 'string' && ['link', 'website_url', 'product_link', 'url', 'carousel_see_more_url'].includes(k) && v.startsWith('https://')) out.push(v)
    else creativeLinks(v, out, depth + 1)
  }
  return out
}
/** Master AD-030 — the conversion domain is the domain of a link the creative names (a plain text check). */
function domainOfLinks(domain: string, links: string[]): boolean {
  return links.some((link) => {
    try {
      const host = new URL(link).hostname.toLowerCase()
      return host === domain || host.endsWith(`.${domain}`)
    } catch { return false }
  })
}

/**
 * Does an ad set's targeting reach the EU (DSA)? Fail-safe: unreadable targeting, a country group, a custom location or a
 * region / city / zip / place without its country counts as yes.
 */
export function targetsDsaArea(targeting: unknown): boolean {
  const geo = isObject(targeting) && isObject(targeting.geo_locations) ? targeting.geo_locations : null
  if (!geo) return true
  for (const [key, value] of Object.entries(geo)) {
    if (key === 'countries') { if (!Array.isArray(value) || value.some((c) => typeof c !== 'string' || DSA_COUNTRIES.has(c.toUpperCase()))) return true; continue }
    if (key === 'location_types' || key === 'location_cluster_ids') continue
    if (['regions', 'cities', 'zips', 'places', 'geo_markets', 'electoral_districts', 'medium_geo_areas', 'small_geo_areas', 'large_geo_areas', 'neighborhoods', 'subcities', 'subneighborhoods', 'metro_areas'].includes(key)) {
      if (!Array.isArray(value)) return true
      for (const entry of value) {
        const country = isObject(entry) ? text(entry.country) ?? text(entry.country_code) : null
        if (!country || DSA_COUNTRIES.has(country.toUpperCase())) return true
      }
      continue
    }
    // country_groups (worldwide, europe, …), custom_locations and anything else: Nexus cannot rule the EU out.
    return true
  }
  return false
}

/** Meta's recommendations in its check's answer (AdRecommendation, SDK adrecommendation.py): read-only words for the preview. */
export function recommendationWords(answer: Row | null): string[] {
  const list = Array.isArray(answer?.recommendations) ? (answer!.recommendations as unknown[]) : isObject(answer?.recommendations) && Array.isArray((answer!.recommendations as Row).data) ? ((answer!.recommendations as Row).data as unknown[]) : []
  const cut = (v: unknown, n: number) => { const t = text(v); return t ? (t.length > n ? `${t.slice(0, n - 1)}…` : t) : null }
  return list.filter(isObject).slice(0, 5).map((r) => {
    const words = [cut(r.title, 120), cut(r.message, 300)].filter(Boolean).join(': ')
    const meta = [text(r.importance) ? `importance ${text(r.importance)}` : null, text(r.blame_field) ? `field ${text(r.blame_field)}` : null].filter(Boolean).join(', ')
    return `Meta recommends (read only — nothing is changed by it): ${words || 'a recommendation without words'}${meta ? ` (${meta})` : ''}.`
  })
}

// ── the request ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AdTracking { pixelId: string; action?: 'offsite_conversion' | 'leadgen_quality_conversion' }
export interface AdPersona { ageMin?: number | null; ageMax?: number | null; genders?: number[] | null }
export interface AdRequest {
  action: 'create' | 'undo'
  name?: string | null
  adSetId?: string | null
  /** An existing creative of the chosen ad account (create-meta-creative / create-meta-boost made it). */
  creativeId?: string | null
  /** Or a new creative made inline with the ad: step 25's request (create-meta-creative's arguments). */
  creative?: CreativeRequest | null
  /** CR-218 — a "message us" footer on a website ad (inline creative only). */
  messageFooter?: typeof MESSAGE_FOOTERS[number] | null
  /** Created ACTIVE (SPENDS MONEY once its ad set and campaign are on and Meta approves it); default PAUSED. */
  activate?: boolean | null
  labels?: string[] | null
  tracking?: AdTracking[] | null
  conversionDomain?: string | null
  scheduleStart?: string | null
  scheduleEnd?: string | null
  engagementAudience?: boolean | null
  displaySequence?: number | null
  priority?: number | null
  /** CR-430 — the flexible ad format's groups, in Meta's shape (images [{hash}], videos [{video_id}], texts, call_to_action). */
  flexibleGroups?: Array<Record<string, unknown>> | null
  persona?: AdPersona | null
  /** AD-028 — ask Meta's recommendations with its check (read-only words in the preview). */
  recommendations?: boolean | null
  /** undo: the ads an earlier create-meta-ad made. */
  ads?: string[]
}

export interface AdDraft extends MetaChangeDraft {
  ad: { action: 'create' | 'undo' | 'set'; name?: string; inline?: boolean; aiFeatures?: string[]; dynamicCreative?: boolean }
}

/** What an ad set and its campaign are now (the reads a new ad stands on). */
interface Parents {
  adSet: { id: string; name: string | null; status: string | null; effective: string | null; dynamicCreative: boolean; sequence: boolean; endTime: string | null; eu: boolean; payor: string | null; beneficiary: string | null }
  campaign: { id: string; name: string | null; status: string | null; effective: string | null; objective: string | null; categories: string[] }
}

async function readParents(chosen: MetaChosenAccount, adSetId: string): Promise<Parents> {
  const set = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.adSetRead', path: adSetId, query: { fields: 'id,name,campaign_id,status,effective_status,is_dynamic_creative,creative_sequence,end_time,dsa_payor,dsa_beneficiary,targeting{geo_locations}' } })).body
  const campaignId = idOf(set.campaign_id)
  if (!campaignId) throw new MetaLiveRefusal(`Meta did not name the campaign of ad set ${adSetId}, so Nexus cannot say whether the ad would spend: nothing was asked of Meta.`)
  const camp = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.campaignRead', path: campaignId, query: { fields: 'id,name,status,effective_status,objective,special_ad_categories' } })).body
  return {
    adSet: {
      id: adSetId, name: text(set.name), status: text(set.status), effective: text(set.effective_status), dynamicCreative: set.is_dynamic_creative === true,
      sequence: Array.isArray(set.creative_sequence) ? set.creative_sequence.length > 0 : !!set.creative_sequence, endTime: text(set.end_time),
      eu: targetsDsaArea(set.targeting), payor: text(set.dsa_payor), beneficiary: text(set.dsa_beneficiary),
    },
    campaign: {
      id: campaignId, name: text(camp.name), status: text(camp.status), effective: text(camp.effective_status), objective: text(camp.objective),
      categories: Array.isArray(camp.special_ad_categories) ? camp.special_ad_categories.map(String) : [],
    },
  }
}

/** The spend sentence of a new ad created ACTIVE: it spends only when its ad set AND campaign are on (read now). */
function activeSentence(parents: Parents, extra = ''): string {
  const setOn = parents.adSet.status === 'ACTIVE'
  const campaignOn = parents.campaign.status === 'ACTIVE'
  const where = `its ad set "${parents.adSet.name ?? parents.adSet.id}" is ${statusWords(parents.adSet.status, parents.adSet.effective)} and its campaign "${parents.campaign.name ?? parents.campaign.id}" is ${statusWords(parents.campaign.status, parents.campaign.effective)}`
  return setOn && campaignOn
    ? `The ad is created ACTIVE and ${where} now: it starts spending as soon as Meta approves it (its review)${extra}.`
    : `The ad is created ACTIVE; ${where} now, so nothing spends until ${!setOn && !campaignOn ? 'both are' : !setOn ? 'the ad set is' : 'the campaign is'} switched on too — then it spends once Meta approves it${extra}.`
}

// ── create ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What the run reads back of a new ad. */
export const AD_READ_BACK = 'id,name,status,effective_status,adset_id,campaign_id,creative{id}'

async function readAd(target: MetaWriteTarget, adId: string, operation: string, fields = AD_READ_BACK): Promise<Row | null> {
  try {
    const read = await metaReadOne<Row>({ connectionId: target.connectionId }, { operation, path: adId, query: { fields } })
    return isObject(read.body) ? read.body : null
  } catch {
    return null
  }
}

interface InlineMade { name: string; asked: string[]; fromExistingPost: boolean }

/** The sender of ONE new ad: sent, read back, and — for an inline creative — "was it new?" and what Meta kept (step 25's madeNode). */
function sendAd(act: string, params: Record<string, string>, inline: InlineMade | null) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'ad.create'
    const sentAt = nowSec()
    const result = await metaSendChange(target, { objectId: act, kind: 'adaccount', params, operation, edge: 'ads', readBackFields: AD_READ_BACK, timeoutMs: 120_000 })
    const adId = idOf(result.node?.id)
    if (!adId) throw new MetaWriteError(localFailure(`Meta answered the new ad without an id, so Nexus cannot say what it made. ${META_UNKNOWN_OUTCOME}`, 'NO_AD_ID'), operation, 'unknown')
    let node = result.node
    // Meta answers {id, success} on a create: the ad is read back by its id when that answer holds no status or creative.
    if (!node || typeof node.status !== 'string' || !isObject(node.creative)) node = (await readAd(target, adId, `${operation}.readBack`)) ?? node
    const shown = node?.creative
    const creativeId = idOf(isObject(shown) ? shown.id : null)
    const made = inline && creativeId ? await madeNode(target, creativeId, null, sentAt, inline.asked, { name: inline.name, fromExistingPost: inline.fromExistingPost }) : null
    return {
      node: { ...(node ?? {}), id: adId, adId, creativeId, ...(made ? { inlineCreative: made } : {}) },
      readBack: node === result.node ? result.readBack : node ? 'second-read' : 'none',
      waitedMs: result.waitedMs,
    }
  }
}

/** The step's sentence once Meta made the ad. */
export function adMadeSentence(label: string, node: Row | null, paused: boolean): string {
  const n = (node ?? {}) as { adId?: string; status?: string; effective_status?: string; creativeId?: string | null; inlineCreative?: Row }
  return [
    `${label}: Meta made ad ${n.adId ?? '?'}${n.status ? ` (${statusWords(n.status, n.effective_status ?? null)})` : ''}${n.creativeId ? ` showing creative ${n.creativeId}` : ''}.`,
    n.inlineCreative ? createdSentence('Its inline creative', n.inlineCreative) : '',
    paused
      ? `It is PAUSED: see it first (meta-ad-preview view ad adId ${n.adId ?? '?'}; Claude only, links public for 24 h), then switch it on with set-meta-status (SPENDS MONEY).`
      : 'It goes to Meta\'s review first and runs once approved while its ad set and campaign are on.',
  ].filter(Boolean).join(' ')
}

async function createAdDraft(account: MetaChangeAccount, request: AdRequest): Promise<AdDraft | { refusal: string }> {
  const name = request.name?.trim() ?? ''
  const nameProblem = metaCreativeTextProblem(name, META_AD_NAME_MAX, 'name')
  if (nameProblem) return { refusal: `Nothing was asked of Meta: ${nameProblem}.` }
  if (!request.adSetId) return { refusal: 'Name the ad set the ad goes in (adSetId; build one first with create-meta-ad-set: Meta documents no shape for an ad set made inside an ad, master AD-025).' }
  if (!!request.creativeId === !!request.creative) return { refusal: 'Give the ad ONE creative: creativeId (an existing creative of the ad account) or creative (a new one made with the ad).' }
  if (request.messageFooter && !request.creative) return { refusal: 'A "message us" footer is made only with an inline creative (creative), never on an existing one: Meta takes message_extensions only inline on a new ad.' }
  const chosen = await metaChosenAccount(account.accountId)
  const act = `act_${account.adAccountId}`
  const adSetId = await objectInAccount(chosen, request.adSetId, 'adset', 'ad.ownerCheck')
  const parents = await readParents(chosen, adSetId)
  const { adSet, campaign } = parents
  const warnings: string[] = []
  const activate = request.activate === true

  // EU: no political or social-issue ad (banned since 2025-10-06, TTPA).
  if (campaign.categories.includes('ISSUES_ELECTIONS_POLITICS')) return { refusal: `Nothing was asked of Meta: campaign ${campaign.id} declares a political or social-issue category, and such ads are banned in the EU (Nexus's markets) since 2025-10-06.` }
  if (adSet.endTime && Date.parse(adSet.endTime) <= Date.now()) return { refusal: `Nothing was asked of Meta: ad set ${adSetId} ended at ${adSet.endTime} (Meta answers 1487007 for a new ad in it). Extend it first with set-meta-ad-set.` }
  // Limits: 50 ads per ad set; ONE in a Dynamic Creative ad set (it must be empty).
  const ads = await listPaged(chosen.connectionId, 'ad.adsInSet', `${adSetId}/ads`, { fields: 'id', effective_status: AD_STATUSES_BUT_DELETED }, META_ADS_PER_AD_SET + 1, true)
  const inSet = Math.max(ads.totalCount ?? 0, ads.rows.length)
  if (adSet.dynamicCreative && inSet > 0) return { refusal: `Nothing was asked of Meta: ad set ${adSetId} is Dynamic Creative, and Meta takes ONE ad in such an ad set, made while it is empty ("You can only create one ad per ad set"): it already has ${inSet}.` }
  if (inSet >= META_ADS_PER_AD_SET) return { refusal: `Nothing was asked of Meta: ad set ${adSetId} already has ${inSet} ads that are not deleted, and Meta takes at most ${META_ADS_PER_AD_SET} per ad set (archived ones count on Meta's ad page). Use another ad set.` }

  // EU / DSA: an ad under an ad set that targets the EU needs a payer and a beneficiary (the ad set's, else the account's default).
  let dsaFrom: 'adset' | 'account' | 'mixed' | 'not-needed' = 'not-needed'
  if (adSet.eu) {
    let defaults: Row = {}
    if (!adSet.payor || !adSet.beneficiary) defaults = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.dsaDefaultsRead', path: act, query: { fields: 'default_dsa_payor,default_dsa_beneficiary' } })).body
    const payor = adSet.payor ?? text(defaults.default_dsa_payor)
    const beneficiary = adSet.beneficiary ?? text(defaults.default_dsa_beneficiary)
    if (!payor || !beneficiary) {
      return { refusal: `Nothing was asked of Meta: ad set ${adSetId} reaches the EU, and an ad there needs who pays for it and who it is for (the EU's DSA): the ad set names ${!adSet.payor && !adSet.beneficiary ? 'neither' : !adSet.payor ? 'no payer' : 'no beneficiary'}, and the ad account has no default for ${!payor && !beneficiary ? 'either' : !payor ? 'the payer' : 'the beneficiary'}. Meta would refuse it (3858079 / 3858081 / 3858152). Set them on the ad set (set-meta-ad-set) or as the account's defaults first.` }
    }
    dsaFrom = adSet.payor && adSet.beneficiary ? 'adset' : !adSet.payor && !adSet.beneficiary ? 'account' : 'mixed'
    warnings.push(`EU (DSA): the ad set reaches the EU; Meta shows the payer and beneficiary ${dsaFrom === 'adset' ? 'of the ad set' : dsaFrom === 'account' ? 'of the ad account\'s defaults (Meta fills them in when the ad is made)' : 'of the ad set and, where it names none, of the account\'s defaults'}.`)
  }

  // The creative: an existing one of the account, or a new one built by step 25's builder.
  let creativeParam: string
  let aiOn: string[] = []
  let links: string[] = []
  let inline: InlineMade | null = null
  let creativeLabel: string
  let creativeStands: unknown
  if (request.creativeId) {
    const creativeId = await objectInAccount(chosen, request.creativeId, 'creative', 'ad.creativeOwnerCheck')
    const c = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.creativeRead', path: creativeId, query: { fields: 'id,name,status,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,effective_authorization_category' } })).body
    if (text(c.status) === 'DELETED') return { refusal: `Nothing was asked of Meta: creative ${creativeId} is deleted.` }
    const auth = text(c.effective_authorization_category)
    if (auth && auth !== 'NONE') return { refusal: `Nothing was asked of Meta: Meta classes creative ${creativeId} as ${auth} (a political or social-issue ad), and such ads are banned in the EU since 2025-10-06.` }
    aiOn = aiFeaturesOn(c)
    links = creativeLinks({ object_story_spec: c.object_story_spec, asset_feed_spec: c.asset_feed_spec })
    creativeParam = JSON.stringify({ creative_id: creativeId })
    creativeLabel = `creative ${creativeId}${text(c.name) ? ` "${text(c.name)}"` : ''}`
    creativeStands = { creativeId, aiOn }
    if (adSet.dynamicCreative) warnings.push('A Dynamic Creative ad set takes a creative with an asset feed (asset_feed_spec): Meta\'s check answers when this one is not.')
    warnings.push(`The ad shows ${creativeLabel} as Meta holds it: a creative cannot change once made.`)
  } else {
    const feed = { ...(request.creative!.assetFeed ?? {}), ...(request.messageFooter ? { message_extensions: [{ type: request.messageFooter }] } : {}) }
    const built = buildCreative({ ...request.creative!, action: 'create', assetFeed: Object.keys(feed).length ? feed : null, inlineOnAd: true }, { pageId: pageOf(chosen), instagramId: chosen.instagramId })
    if ('refusal' in built) return built
    creativeParam = JSON.stringify(built.creative)
    // What the gateway will judge is exactly this (step 25's judge on the inline form): a preview never promises what it refuses.
    const judged = judgeAdCreative(creativeParam, true)
    if ('problem' in judged) return { refusal: `Nothing was asked of Meta: ${judged.problem}.` }
    aiOn = built.featuresOn.filter((f) => META_AI_GENERATED_FEATURES.has(f)).sort()
    links = creativeLinks(built.creative)
    inline = { name: String(built.creative.name), asked: built.featuresOn, fromExistingPost: !!request.creative!.postId }
    creativeLabel = `a new creative "${String(built.creative.name)}" made with it`
    creativeStands = { inline: true, pageId: chosen.pageId, instagramId: chosen.instagramId }
    const instagram = !!(built.creative.object_story_spec as { instagram_user_id?: unknown } | undefined)?.instagram_user_id || !!built.creative.instagram_user_id
    warnings.push(...creativeWarnings(built, request.creative!, { instagram }).filter((w) => !w.startsWith('A creative spends nothing')))
    if (request.messageFooter) warnings.push(`A "message us" footer (${request.messageFooter}): Meta opens the website in its in-app browser with a button to message the business; the ad set must send to a website (destination WEBSITE or UNDEFINED — Meta's check answers otherwise).`)
  }
  // CR-404 / F1 M5-23 — an ad with a feature generated with AI is created PAUSED, previewed, then switched on: never ACTIVE at once.
  if (aiOn.length && activate) {
    return { refusal: `Nothing was asked of Meta: the creative switches on ${aiOn.join(', ')} (generated with AI), and Meta's rule is to create such an ad PAUSED, preview each feature (meta-ad-preview view ad, creativeFeature) and only then switch it on (set-meta-status, SPENDS MONEY). Ask again without activate.` }
  }

  const params: Record<string, string> = { name, adset_id: adSetId, creative: creativeParam, status: activate ? 'ACTIVE' : 'PAUSED' }
  const lines: Array<[string, unknown, unknown]> = [
    [`Ad "${name}"`, 'not in the ad account', `made in ad set ${adSetId}, ${activate ? 'ACTIVE (after Meta\'s review)' : 'PAUSED'}`],
    ['Creative', '—', creativeLabel],
  ]
  if (request.labels?.length) {
    const labels = request.labels.map((l) => l.trim())
    for (const l of labels) { const p = metaCreativeTextProblem(l, META_CREATIVE_TEXT.label, `label "${l.slice(0, 40)}"`); if (p) return { refusal: `Nothing was asked of Meta: ${p}.` } }
    if (new Set(labels).size !== labels.length) return { refusal: 'Nothing was asked of Meta: name each label once.' }
    params.adlabels = JSON.stringify(labels.map((n) => ({ name: n })))
    lines.push(['Labels', '—', labels.join(', ')])
  }
  // AD-029 — tracking: pixels of the chosen account only (read now).
  let pixels: string[] = []
  if (request.tracking?.length) {
    const specs = request.tracking.map((t) => ({ 'action.type': [t.action ?? 'offsite_conversion'], fb_pixel: [t.pixelId] }))
    const judged = trackingPixels(JSON.stringify(specs))
    if ('problem' in judged) return { refusal: `Nothing was asked of Meta: ${judged.problem}.` }
    const own = await listPaged(chosen.connectionId, 'ad.pixelsRead', `${act}/adspixels`, { fields: 'id' }, 100)
    const owned = new Set(own.rows.map((r) => idOf(r.id)).filter(Boolean))
    const foreign = judged.pixels.filter((p) => !owned.has(p))
    if (foreign.length) return { refusal: `Nothing was asked of Meta: pixel ${foreign.join(', ')} is not one of the chosen ad account's own pixels${own.more ? ` (Nexus reads its first 100)` : ''}.` }
    pixels = judged.pixels
    params.tracking_specs = JSON.stringify(specs)
    lines.push(['Tracking', '—', request.tracking.map((t) => `${t.action ?? 'offsite_conversion'} on pixel ${t.pixelId}`).join('; ')])
    warnings.push('Tracking: Meta keeps its own default tracking for the objective and adds these (except App installs and Engagement, where Meta replaces its defaults); the pixel of the ad set\'s promoted object is tracked anyway.')
  }
  if (request.conversionDomain) {
    const domain = request.conversionDomain.trim().toLowerCase()
    if (!META_CONVERSION_DOMAIN.test(domain)) return { refusal: 'Nothing was asked of Meta: conversionDomain is a domain as Meta wants it — the first and second level only, e.g. example.com (no https://, path or www.).' }
    if (!domainOfLinks(domain, links)) return { refusal: `Nothing was asked of Meta: the creative names no website link on ${domain}, and the conversion domain is where the ad's conversions happen (master AD-030: the domain of the creative's link).` }
    params.conversion_domain = domain
    lines.push(['Conversion domain', '—', domain])
  }
  // AD-031 — the ad's own schedule: sales and app-promotion campaigns only.
  const start = request.scheduleStart ? unixOf(request.scheduleStart) : null
  const end = request.scheduleEnd ? unixOf(request.scheduleEnd) : null
  if (request.scheduleStart || request.scheduleEnd) {
    if (!(SALES_AND_APP_OBJECTIVES as readonly string[]).includes(campaign.objective ?? '')) return { refusal: `Nothing was asked of Meta: an ad's own start and end time is "only available for sales and app promotion campaigns", and campaign ${campaign.id} is ${campaign.objective ?? 'of an unknown objective'}. Without them the ad follows the campaign's schedule.` }
    if ((request.scheduleStart && start === null) || (request.scheduleEnd && end === null)) return { refusal: 'Nothing was asked of Meta: scheduleStart and scheduleEnd are times with their offset (2026-11-02T08:00:00+01:00).' }
    if (end !== null && end <= nowSec()) return { refusal: 'Nothing was asked of Meta: scheduleEnd is in the past.' }
    if (start !== null && end !== null && end <= start) return { refusal: 'Nothing was asked of Meta: scheduleEnd is after scheduleStart.' }
    if (start !== null) params.ad_schedule_start_time = String(start)
    if (end !== null) params.ad_schedule_end_time = String(end)
    lines.push(['Own schedule', 'the campaign\'s', `${start !== null ? new Date(start * 1000).toISOString() : 'now'} → ${end !== null ? new Date(end * 1000).toISOString() : 'the campaign\'s end'}`])
  }
  if (request.engagementAudience) {
    params.engagement_audience = 'true'
    warnings.push('Engagement audience: Meta also makes a custom audience of the people who engage with this ad (it needs the Custom Audience terms accepted in Ads Manager). It stays when the ad is taken back: delete it with the audience tools.')
  }
  // AD-034 (RECHECK STILL-UNVERIFIED) — passed through only when asked; Meta explains no effect.
  for (const [key, value] of [['display_sequence', request.displaySequence], ['priority', request.priority]] as const) {
    if (typeof value === 'number') {
      params[key] = String(value)
      warnings.push(`${key} ${value}: Meta's reference names it ("${key === 'display_sequence' ? 'The sequence of the ad within the same campaign' : 'Priority'}") but explains no effect on delivery — Nexus passes it on as asked.`)
    }
  }
  if (request.flexibleGroups?.length) {
    if (!(SALES_AND_APP_OBJECTIVES as readonly string[]).includes(campaign.objective ?? '')) return { refusal: `Nothing was asked of Meta: the flexible ad format runs only in sales and app-promotion campaigns (Meta's guide), and campaign ${campaign.id} is ${campaign.objective ?? 'of an unknown objective'}.` }
    const value = JSON.stringify({ groups: cleanCreativeJson(request.flexibleGroups) })
    const judged = judgeAssetGroups(value)
    if ('problem' in judged) return { refusal: `Nothing was asked of Meta: ${judged.problem}.` }
    params.creative_asset_groups_spec = value
    lines.push(['Flexible format', '—', `${request.flexibleGroups.length} group${request.flexibleGroups.length === 1 ? '' : 's'}: Meta picks the format per person`])
    warnings.push('Flexible ad format: Meta chooses which images, videos and texts of each group to show and in which format — the person reads them in the groups, not one fixed ad.')
  }
  if (request.persona) {
    const p = { ...(typeof request.persona.ageMin === 'number' ? { age_min: request.persona.ageMin } : {}), ...(typeof request.persona.ageMax === 'number' ? { age_max: request.persona.ageMax } : {}), ...(request.persona.genders?.length ? { genders: request.persona.genders } : {}) }
    const value = JSON.stringify(p)
    const judged = judgeAdPersona(value)
    if ('problem' in judged) return { refusal: `Nothing was asked of Meta: ${judged.problem}.` }
    params.creative_audience_pairing_persona = value
    lines.push(['Persona', '—', value])
    warnings.push('Persona (creative audience pairing): it takes effect only when the ad set has creative audience pairing switched on (targeting_automation.creative_audience_pairing 1); a persona set on one image or video wins over this one.')
  }

  const label = `Create ad "${name}" in ad set ${adSetId}${activate ? ' (ACTIVE)' : ' (PAUSED)'}`
  const request1: MetaChangeRequest = {
    step: 1, label, kind: 'adaccount', objectId: act, params,
    // Meta documents validate_only + synchronous_ad_review on POST /act_<id>/ads (reference/ad-account/ads.md).
    check: 'meta', checkOptions: request.recommendations ? META_AD_CHECK_WITH_RECOMMENDATIONS : META_AD_CHECK,
    checkWords: (answer) => [
      'Meta\'s integrity review (synchronous_ad_review: its text and image checks) found nothing to refuse; Meta\'s full review after the ad is made may still decide otherwise.',
      ...(request.recommendations ? (recommendationWords(answer).length ? recommendationWords(answer) : ['Meta had no recommendation for this ad.']) : []),
    ],
    raisesSpend: activate, readBackInPost: false, budget: false, undoable: false,
    operation: 'ad.create', edge: 'ads',
    send: sendAd(act, params, inline),
    doneSentence: (result) => adMadeSentence(label, result.node, !activate),
  }
  const spendsMoney = activate ? [activeSentence(parents, start !== null ? ` — and only from its own start time ${new Date(start * 1000).toISOString()}` : '')] : []
  return {
    summary: `Meta: create ad "${name}" in ad set ${adSetId} of ad account ${act}, ${activate ? 'ACTIVE (SPENDS MONEY once approved while its ad set and campaign are on)' : 'PAUSED (it spends nothing until switched on)'}.`,
    changes: changeLines(lines).changes,
    totals: { ads: 1, requests: 1, ...(inline ? { creatives: 1 } : {}) },
    warnings: [
      activate ? 'Meta reviews every new ad first (PENDING_REVIEW); it runs once approved.' : 'The ad is created PAUSED: it spends nothing until a person switches it on (set-meta-status, SPENDS MONEY). Meta reviews it first; a paused ad stays paused after review.',
      ...(aiOn.length ? [`The creative uses ${aiOn.join(', ')} (generated with AI): Meta's rule — keep the ad PAUSED, see each feature in the preview (meta-ad-preview view ad, creativeFeature) before switching it on.`] : []),
      ...(adSet.dynamicCreative ? ['A Dynamic Creative ad cannot be deleted or archived once made (Meta: delete or archive its ad set instead), so its undo cannot take it back.'] : []),
      ...(adSet.sequence ? ['Its ad set has an ad sequence: Meta lets none of its ads be paused, archived or deleted, so this ad cannot be taken back.'] : []),
      ...warnings,
      'Changing the ad later: rename, labels, its own schedule or another creative (set-meta-ad); a creative swap sends an ACTIVE ad back to Meta\'s review.',
    ],
    spendsMoney, skipped: [], requests: [request1],
    stands: {
      action: 'create', adAccountId: account.adAccountId, adSet: { id: adSet.id, status: adSet.status, effective: adSet.effective, dynamicCreative: adSet.dynamicCreative, sequence: adSet.sequence, eu: adSet.eu, dsa: dsaFrom },
      campaign: { id: campaign.id, status: campaign.status, effective: campaign.effective, objective: campaign.objective }, adsInSet: inSet, creative: creativeStands, pixels,
    },
    before: { kind: 'create', items: [] },
    after: { kind: 'create', items: [{ kind: 'ad', name, adSetId }] },
    ad: { action: 'create', name, inline: !!inline, aiFeatures: aiOn, dynamicCreative: adSet.dynamicCreative },
  }
}

// ── undo: take back an ad a create made ─────────────────────────────────────────────────────────────────────────────

/** The change record of THIS business that made this ad in this ad account (not undone): its inline creative, if new. */
async function adRecordOf(adId: string, adAccountId: string): Promise<{ id: string; creativeId: string | null } | null> {
  const rows = await prisma.agentChange.findMany({
    where: { toolName: AD_TOOL, undoneAt: null, after: { path: ['items'], array_contains: [{ adId }] } },
    select: { id: true, after: true },
    take: 20,
  })
  const row = rows.find((r) => (r.after as { adAccountId?: unknown } | null)?.adAccountId === adAccountId)
  if (!row) return null
  const items = ((row.after as { items?: Array<Record<string, unknown>> }).items ?? [])
  const creative = items.find((i) => i.kind === 'creative' && i.adId === adId && i.new === true && typeof i.creativeId === 'string')
  return { id: row.id, creativeId: creative ? String(creative.creativeId) : null }
}

/** The ad's numbers since it was made (spend, impressions) — null when they could not be read (then nothing is deleted). */
async function everRan(chosen: MetaChosenAccount, adId: string, createdTime: string | null): Promise<{ spend: number; impressions: number } | null> {
  const created = createdTime ? Date.parse(createdTime.replace(/([+-]\d{2})(\d{2})$/, '$1:$2')) : NaN
  if (!Number.isFinite(created)) return null
  try {
    const read = await metaReadOne<{ data?: Array<{ spend?: unknown; impressions?: unknown }> }>({ connectionId: chosen.connectionId }, {
      operation: 'ad.spendRead', path: `${adId}/insights`,
      query: { fields: 'spend,impressions', time_range: { since: dayIn(created - 86_400_000, chosen.timeZone), until: dayIn(Date.now(), chosen.timeZone) } },
    })
    const rows = Array.isArray(read.body.data) ? read.body.data : []
    return rows.reduce<{ spend: number; impressions: number }>((sum, r) => ({ spend: sum.spend + (Number(r.spend) || 0), impressions: sum.impressions + (Number(r.impressions) || 0) }), { spend: 0, impressions: 0 })
  } catch {
    return null
  }
}

/** The creative of an ad being taken back goes only once that ad reads DELETED (else the creative stays: nothing is sent). */
function sendCreativeRemoval(adId: string, creativeId: string) {
  return async (target: MetaWriteTarget): Promise<MetaChangeResult> => {
    const operation = 'creative.remove'
    const ad = await readAd(target, adId, 'ad.removedCheck', 'id,status')
    if (text(ad?.status) !== 'DELETED') {
      throw new MetaWriteError(localFailure(`Not sent: ad ${adId} does not read as deleted, so its creative ${creativeId} stays (an ad still showing it would break).`, 'AD_NOT_DELETED'), operation, 'not_sent')
    }
    return metaSendChange(target, { objectId: creativeId, kind: 'creative', params: {}, operation, method: 'DELETE' })
  }
}

export async function adUndoDraft(account: MetaChangeAccount, ids: string[]): Promise<AdDraft | { refusal: string }> {
  if (!ids.length) return { refusal: 'Name the ads to take back (ads: their ids).' }
  if (ids.length > MAX_AD_UNDO) return { refusal: `At most ${MAX_AD_UNDO} ads per request.` }
  if (new Set(ids).size !== ids.length) return { refusal: 'Name each ad once.' }
  const chosen = await metaChosenAccount(account.accountId)
  const act = `act_${account.adAccountId}`
  const records = new Map<string, { creativeId: string | null }>()
  const refusals: string[] = []
  for (const id of ids) {
    const record = await adRecordOf(id, account.adAccountId)
    if (!record) refusals.push(`ad ${id} is not one a create-meta-ad of this business made in ad account ${act} (Nexus deletes only that).`)
    else records.set(id, record)
  }
  if (refusals.length) return { refusal: `Nothing was asked of Meta: ${refusals.join(' ')}` }
  const skipped: string[] = []
  const going: Array<{ adId: string; creativeId: string | null }> = []
  const states: Array<Record<string, unknown>> = []
  for (const id of ids) {
    await objectInAccount(chosen, id, 'ad', 'ad.ownerCheck')
    const ad = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.undoRead', path: id, query: { fields: 'id,status,effective_status,adset_id,created_time,creative{id}' } })).body
    const status = text(ad.status)
    states.push({ adId: id, status, effective: text(ad.effective_status) })
    if (status === 'DELETED') { skipped.push(`Ad ${id} is already deleted.`); continue }
    if (status === 'ACTIVE') { skipped.push(`Ad ${id} stays: it is ACTIVE — Nexus takes back only an ad that is not running (pause it first with set-meta-status).`); continue }
    const adSetId = idOf(ad.adset_id)
    const set = adSetId ? (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.undoAdSetRead', path: adSetId, query: { fields: 'id,is_dynamic_creative,creative_sequence' } })).body : null
    if (!set) { skipped.push(`Ad ${id} stays: Meta did not name its ad set, so Nexus cannot rule out a Dynamic Creative ad or an ad sequence (Meta deletes neither).`); continue }
    if (set.is_dynamic_creative === true) { skipped.push(`Ad ${id} stays: it is a Dynamic Creative ad, which Meta never lets be deleted or archived (error 1340029) — delete or archive its ad set instead.`); continue }
    if (Array.isArray(set.creative_sequence) ? set.creative_sequence.length > 0 : !!set.creative_sequence) { skipped.push(`Ad ${id} stays: its ad set has an ad sequence, and Meta deletes no ad of it.`); continue }
    const ran = await everRan(chosen, id, text(ad.created_time))
    if (!ran) { skipped.push(`Ad ${id} stays: Nexus could not read its numbers, so it cannot confirm the ad never ran.`); continue }
    if (ran.spend > 0 || ran.impressions > 0) { skipped.push(`Ad ${id} stays: it has run (${ran.impressions} impressions, spend ${ran.spend}) and Meta keeps its numbers only while it exists — archive it with set-meta-status (status ARCHIVED) instead.`); continue }
    const recordCreative = records.get(id)!.creativeId
    const shows = idOf(isObject(ad.creative) ? ad.creative.id : null)
    going.push({ adId: id, creativeId: recordCreative && recordCreative === shows ? recordCreative : null })
  }
  if (!going.length) return { refusal: `Nothing to take back: ${skipped.join(' ')}` }
  // The inline creatives it made NEW go too — when no other ad of the account uses them (F1 M5-32: Nexus never tries a used one).
  const creatives = going.filter((g) => g.creativeId)
  let others: Row[] = []
  let more = false
  if (creatives.length) {
    const list = await listPaged(chosen.connectionId, 'ad.undoAdsRead', `${act}/ads`, { fields: 'id,creative{id}', effective_status: AD_STATUSES_BUT_DELETED }, ADS_READ_MAX)
    others = list.rows
    more = list.more
  }
  const requests: MetaChangeRequest[] = []
  const after: Array<Record<string, unknown>> = []
  for (const g of going) {
    const label = `Delete ad ${g.adId} (made by Nexus, never run) from ad account ${act}`
    requests.push({ step: requests.length + 1, label, kind: 'ad', objectId: g.adId, params: {}, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'ad.remove', method: 'DELETE', doneSentence: () => `${label}: Meta deleted it.` })
    after.push({ kind: 'ad', adId: g.adId, deleted: true })
    if (!g.creativeId) continue
    const users = others.filter((r) => idOf(isObject(r.creative) ? r.creative.id : null) === g.creativeId && idOf(r.id) !== g.adId).map((r) => String(r.id))
    if (users.length) { skipped.push(`Its creative ${g.creativeId} stays: ad${users.length === 1 ? '' : 's'} ${users.slice(0, 5).join(', ')} use${users.length === 1 ? 's' : ''} it too.`); continue }
    if (more) { skipped.push(`Its creative ${g.creativeId} stays: the ad account has more than ${ADS_READ_MAX} ads, so Nexus cannot confirm no other ad uses it.`); continue }
    const creativeLabel = `Delete creative ${g.creativeId} (made new with ad ${g.adId}) once that ad is deleted`
    requests.push({ step: requests.length + 1, label: creativeLabel, kind: 'creative', objectId: g.creativeId, params: {}, check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: false, operation: 'creative.remove', method: 'DELETE', send: sendCreativeRemoval(g.adId, g.creativeId), doneSentence: () => `${creativeLabel}: Meta deleted it.` })
    after.push({ kind: 'creative', creativeId: g.creativeId, adId: g.adId, deleted: true })
  }
  return {
    summary: `Meta: delete ${going.length} ad${going.length === 1 ? '' : 's'} Nexus made and that never ran, in ad account ${act}.`,
    changes: changeLines(after.map((a) => [a.kind === 'ad' ? `Ad ${a.adId}` : `Creative ${a.creativeId}`, a.kind === 'ad' ? 'in the ad account, paused, never run' : 'made with the ad, used by no other ad', 'deleted'])).changes,
    totals: { delete: requests.length, requests: requests.length, ...(skipped.length ? { stays: skipped.length } : {}) },
    warnings: [
      'Meta has no check for a delete (DELETE /<ad id> lists no validate_only), and a deleted ad is final: Nexus cannot bring it back (make it again with create-meta-ad).',
      'An ad that has run stays (Meta keeps its numbers only while it exists): archive it with set-meta-status instead. A delete spends nothing.',
    ],
    spendsMoney: [], skipped, requests,
    stands: { action: 'undo', adAccountId: account.adAccountId, states, going },
    before: { kind: 'undo', items: after.map(({ deleted: _deleted, ...a }) => ({ ...a, present: true })) },
    after: { kind: 'undo', items: after },
    ad: { action: 'undo' },
  }
}

/** The draft of one create-meta-ad request, from what Meta holds now (reads only). */
export async function adDraft(account: MetaChangeAccount, request: AdRequest): Promise<AdDraft | { refusal: string }> {
  try {
    return request.action === 'undo' ? await adUndoDraft(account, request.ads ?? []) : await createAdDraft(account, request)
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

// ── set-meta-ad ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SetAdRequest {
  adId: string
  name?: string | null
  /** AD-042 — swap the creative it shows for another of the ad account (a new look: create-meta-creative first, CR-436). */
  creativeId?: string | null
  labels?: string[] | null
  addLabels?: string[] | null
  scheduleStart?: string | null
  scheduleEnd?: string | null
  /** AD-044 — clear the ad's own start or end time (it then follows its campaign's schedule). */
  clearSchedule?: Array<'start' | 'end'> | null
}
export interface AdState { adId: string; name: string | null; status: string | null; creativeId: string | null; labels: string[]; scheduleStart: string | null; scheduleEnd: string | null }

/** The fields set-meta-ad reads of an ad (and its undo reads again). */
export const AD_SET_FIELDS = 'id,name,status,effective_status,adset_id,campaign_id,creative{id},adlabels{name},ad_schedule_start_time,ad_schedule_end_time'

export function adStateOf(adId: string, body: Row): AdState {
  const rows = Array.isArray(body.adlabels) ? body.adlabels : isObject(body.adlabels) && Array.isArray(body.adlabels.data) ? body.adlabels.data : []
  return {
    adId, name: text(body.name), status: text(body.status), creativeId: idOf(isObject(body.creative) ? body.creative.id : null),
    labels: (rows as unknown[]).map((l) => (isObject(l) ? text(l.name) : null)).filter((l): l is string => !!l),
    scheduleStart: isoOf(body.ad_schedule_start_time), scheduleEnd: isoOf(body.ad_schedule_end_time),
  }
}

export async function setAdDraft(account: MetaChangeAccount, request: SetAdRequest): Promise<AdDraft | { refusal: string }> {
  try {
    const chosen = await metaChosenAccount(account.accountId)
    const id = await objectInAccount(chosen, request.adId, 'ad', 'ad.ownerCheck')
    const read = await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.read', path: id, query: { fields: AD_SET_FIELDS } })
    const now = adStateOf(id, read.body)
    const effective = text(read.body.effective_status)
    if (now.status === 'DELETED') return { refusal: `Ad ${id} is deleted: Meta lets only its name change, and Nexus changes nothing on it.` }
    const archived = now.status === 'ARCHIVED'
    const asked = { creative: !!request.creativeId, labels: !!(request.labels || request.addLabels), schedule: !!(request.scheduleStart || request.scheduleEnd || request.clearSchedule?.length) }
    if (archived && (asked.creative || asked.labels || asked.schedule)) return { refusal: `Ad ${id} is archived: Meta lets only its name (and a delete) change on it.` }
    const params: Record<string, string> = {}
    const expect: Record<string, string> = {}
    const skipped: string[] = []
    const warnings: string[] = ['Meta has no check for an ad\'s update (POST /<ad id> has no update parameter table, so no validate_only): the preview is built from the ad as it is now, and the run reads it again first.']
    const spendsMoney: string[] = []
    const lines: Array<[string, unknown, unknown]> = []
    const name = request.name?.trim() || null
    if (name) {
      const p = metaCreativeTextProblem(name, META_AD_NAME_MAX, 'name')
      if (p) return { refusal: `Nothing was asked of Meta: ${p}.` }
      if (name !== now.name) { params.name = name; expect.name = name; lines.push([`Ad ${id} name`, now.name, name]) } else skipped.push(`Ad ${id} is already named "${name}".`)
    }
    let swap = false
    if (request.creativeId) {
      const creativeId = await objectInAccount(chosen, request.creativeId, 'creative', 'ad.creativeOwnerCheck')
      if (creativeId === now.creativeId) skipped.push(`Ad ${id} already shows creative ${creativeId}.`)
      else {
        const c = (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.creativeRead', path: creativeId, query: { fields: 'id,name,status,degrees_of_freedom_spec,effective_authorization_category' } })).body
        if (text(c.status) === 'DELETED') return { refusal: `Nothing was asked of Meta: creative ${creativeId} is deleted.` }
        const auth = text(c.effective_authorization_category)
        if (auth && auth !== 'NONE') return { refusal: `Nothing was asked of Meta: Meta classes creative ${creativeId} as ${auth} (a political or social-issue ad), banned in the EU since 2025-10-06.` }
        const ai = aiFeaturesOn(c)
        if (ai.length && now.status === 'ACTIVE') return { refusal: `Nothing was asked of Meta: creative ${creativeId} switches on ${ai.join(', ')} (generated with AI), and Meta's rule is that an ad with such features is PAUSED and previewed before it runs. Pause ad ${id} first (set-meta-status), swap, see the preview, then switch it on.` }
        params.creative = JSON.stringify({ creative_id: creativeId })
        expect.creative_id = creativeId
        swap = true
        lines.push([`Ad ${id} creative`, now.creativeId, creativeId])
        warnings.push(`A creative swap sends the ad back to Meta's review (F1 X8): ${now.status === 'ACTIVE' ? 'this ad is ACTIVE, so it may not deliver until Meta approves the new creative' : 'it is not running now, so it simply waits for review'}. Its undo swaps the old creative back (a review again).`)
        if (ai.length) warnings.push(`The new creative uses ${ai.join(', ')} (generated with AI): see each feature in the preview (meta-ad-preview view ad, creativeFeature) before switching the ad on.`)
      }
    }
    const labels = request.labels ? request.labels.map((l) => l.trim()) : null
    const adds = request.addLabels ? request.addLabels.map((l) => l.trim()) : null
    if (labels && adds) return { refusal: 'Give labels (the whole list, replacing) or addLabels (added), not both.' }
    for (const l of labels ?? adds ?? []) { const p = metaCreativeTextProblem(l, META_CREATIVE_TEXT.label, `label "${l.slice(0, 40)}"`); if (p) return { refusal: `Nothing was asked of Meta: ${p}.` } }
    if (new Set(labels ?? adds ?? []).size !== (labels ?? adds ?? []).length) return { refusal: 'Nothing was asked of Meta: name each label once.' }
    const sameList = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i])
    if (labels && !sameList(labels, now.labels)) params.adlabels = JSON.stringify(labels.map((n) => ({ name: n })))
    else if (labels) skipped.push(`Ad ${id} already has exactly these labels.`)
    const newAdds = (adds ?? []).filter((l) => !now.labels.includes(l))
    if (adds && !newAdds.length) skipped.push(`Ad ${id} already has ${adds.length === 1 ? 'that label' : 'those labels'}.`)
    const finalLabels = labels ?? [...now.labels, ...newAdds]
    if (params.adlabels || newAdds.length) lines.push([`Ad ${id} labels`, now.labels.join(', ') || 'none', finalLabels.join(', ') || 'none'])
    // AD-031 / AD-044 — the ad's own schedule (sales and app-promotion campaigns only), set or cleared.
    let scheduleChanged = false
    const clear = new Set(request.clearSchedule ?? [])
    if (asked.schedule) {
      if ((request.scheduleStart && clear.has('start')) || (request.scheduleEnd && clear.has('end'))) return { refusal: 'Set a time or clear it, not both.' }
      const campaignId = idOf(read.body.campaign_id)
      const camp = campaignId ? (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.campaignRead', path: campaignId, query: { fields: 'id,objective' } })).body : {}
      if (!(SALES_AND_APP_OBJECTIVES as readonly string[]).includes(text(camp.objective) ?? '')) return { refusal: `Nothing was asked of Meta: an ad's own start and end time is "only available for sales and app promotion campaigns", and this ad's campaign is ${text(camp.objective) ?? 'of an unknown objective'}.` }
      const start = request.scheduleStart ? unixOf(request.scheduleStart) : null
      const end = request.scheduleEnd ? unixOf(request.scheduleEnd) : null
      if ((request.scheduleStart && start === null) || (request.scheduleEnd && end === null)) return { refusal: 'Nothing was asked of Meta: scheduleStart and scheduleEnd are times with their offset (2026-11-02T08:00:00+01:00).' }
      const nextStart = clear.has('start') ? null : start !== null ? new Date(start * 1000).toISOString() : now.scheduleStart
      const nextEnd = clear.has('end') ? null : end !== null ? new Date(end * 1000).toISOString() : now.scheduleEnd
      if (end !== null && end <= nowSec()) return { refusal: 'Nothing was asked of Meta: scheduleEnd is in the past.' }
      if (nextStart && nextEnd && Date.parse(nextEnd) <= Date.parse(nextStart)) return { refusal: 'Nothing was asked of Meta: the end is after the start.' }
      for (const [key, next, old, value] of [['ad_schedule_start_time', nextStart, now.scheduleStart, start], ['ad_schedule_end_time', nextEnd, now.scheduleEnd, end]] as const) {
        if (next === old) continue
        params[key] = next === null ? '' : String(value)
        if (next !== null) expect[key] = String(value)
        scheduleChanged = true
        lines.push([`Ad ${id} own ${key === 'ad_schedule_start_time' ? 'start' : 'end'}`, old ?? 'the campaign\'s', next ?? 'cleared (the campaign\'s)'])
      }
      if (!scheduleChanged) skipped.push(`Ad ${id} already has that schedule.`)
      else {
        warnings.push('Meta lets an ad\'s fields change only when they "were used during ad creation": an ad made without its own schedule may refuse one now (Meta\'s words then say so).')
        if (now.status === 'ACTIVE') {
          const set = idOf(read.body.adset_id)
          const s = set ? (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.adSetRead', path: set, query: { fields: 'id,name,status,effective_status' } })).body : {}
          const c = campaignId ? (await metaReadOne<Row>({ connectionId: chosen.connectionId }, { operation: 'ad.campaignStatusRead', path: campaignId, query: { fields: 'id,name,status,effective_status' } })).body : {}
          spendsMoney.push(`Ad ${id} is ACTIVE (${statusWords(now.status, effective)}): its own schedule changes, so it may spend at times it did not before — its ad set is ${statusWords(text(s.status), text(s.effective_status))} and its campaign ${statusWords(text(c.status), text(c.effective_status))} now${text(s.status) === 'ACTIVE' && text(c.status) === 'ACTIVE' ? '' : ' (nothing spends while either is off)'}.`)
        }
      }
    }
    const requests: MetaChangeRequest[] = []
    const label = `ad ${id}${now.name ? ` "${now.name}"` : ''}`
    if (Object.keys(params).length) {
      const sendExpect = Object.fromEntries(Object.entries(expect).filter(([k]) => k !== 'creative_id'))
      requests.push({
        step: requests.length + 1, label: `Change ${label}: ${Object.keys(params).map((k) => ({ adlabels: 'labels', ad_schedule_start_time: 'own start', ad_schedule_end_time: 'own end' } as Record<string, string>)[k] ?? k).join(', ')}`,
        kind: 'ad', objectId: id, params, check: 'none', raisesSpend: scheduleChanged && now.status === 'ACTIVE', readBackInPost: false, budget: false, undoable: true,
        operation: 'ad.update', ...(Object.keys(expect).length ? { expect } : {}), readBackFields: 'id,name,status,effective_status,creative{id},ad_schedule_start_time,ad_schedule_end_time',
        // The creative reads back as {id}: the run judges it as creative_id (expect), what Meta now shows.
        send: async (target) => {
          const r = await metaSendChange(target, { objectId: id, kind: 'ad', params, operation: 'ad.update', ...(Object.keys(sendExpect).length ? { expect: sendExpect } : {}), readBackFields: 'id,name,status,effective_status,creative{id},ad_schedule_start_time,ad_schedule_end_time' })
          const creative = r.node?.creative
          const shows = idOf(isObject(creative) ? creative.id : null)
          return { ...r, node: r.node ? { ...r.node, ...(shows ? { creative_id: shows } : {}) } : r.node }
        },
      })
    }
    if (newAdds.length) {
      requests.push({
        step: requests.length + 1, label: `Add label${newAdds.length === 1 ? '' : 's'} ${newAdds.map((l) => `"${l}"`).join(', ')} to ${label}`, kind: 'ad', objectId: id,
        params: { adlabels: JSON.stringify(newAdds.map((n) => ({ name: n }))) },
        check: 'none', raisesSpend: false, readBackInPost: false, budget: false, undoable: true,
        operation: 'ad.addLabels', edge: 'adlabels',
        doneSentence: () => `Add label${newAdds.length === 1 ? '' : 's'} to ${label}: Meta took ${newAdds.length === 1 ? 'it' : 'them'}.`,
      })
    }
    if (newAdds.length) warnings.push('A label that does not exist yet is made in the ad account by its name. Meta lists validate_only on an ad\'s labels edge, but Nexus asks Meta\'s check only of a new ad.')
    return {
      summary: `Meta: change ${label} (${[name && params.name ? 'name' : null, swap ? 'creative' : null, params.adlabels || newAdds.length ? 'labels' : null, scheduleChanged ? 'own schedule' : null].filter(Boolean).join(', ') || 'nothing'}).`,
      changes: changeLines(lines).changes,
      totals: { ads: requests.length ? 1 : 0, requests: requests.length },
      warnings, spendsMoney, skipped, requests,
      stands: { action: 'set', ...now, effective },
      before: { kind: 'set', ...now },
      after: {
        kind: 'set', adId: id, ...(params.name ? { name: params.name } : {}), ...(swap ? { creativeId: expect.creative_id } : {}), ...(params.adlabels || newAdds.length ? { labels: [...finalLabels].sort() } : {}),
        ...('ad_schedule_start_time' in params ? { scheduleStart: params.ad_schedule_start_time ? isoOf(params.ad_schedule_start_time) : null } : {}),
        ...('ad_schedule_end_time' in params ? { scheduleEnd: params.ad_schedule_end_time ? isoOf(params.ad_schedule_end_time) : null } : {}),
      },
      ad: { action: 'set' },
    }
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return { refusal: err.message }
    throw err
  }
}

