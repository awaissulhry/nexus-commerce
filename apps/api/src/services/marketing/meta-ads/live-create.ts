/**
 * Meta step 19 — the live state a create, a copy or the undo of one stands on, read from Meta now (GET through the gateway):
 * the ad account's saved EU payer and beneficiary, the business's chosen Facebook Page, what a copy copies (its status,
 * its ads, its ad sets' EU payer and beneficiary), and for an undo each object the change made — whether it is still there,
 * what hangs under it and what it spent. Built on step 6's reads (live-objects.ts readGroups, listPaged) and step 18's
 * (live-settings.ts liveCampaign, targetsEu) — never a copy. Nothing here stores anything; nothing here reads another
 * business's objects: an id is read with the fields only its kind has (services/meta/meta-kinds.ts) and refused when Meta
 * places it in another ad account.
 *
 * Checked 2026-10-21 (developers.facebook.com/documentation/ads-commerce/marketing-api/…): reference/ad-account.md
 * (default_dsa_payor, default_dsa_beneficiary — read fields; "both or neither"); reference/ad-campaign.md (dsa_payor,
 * dsa_beneficiary, targeting.geo_locations); best-practices/manage-your-ad-object-status.md (a DELETED object is read by
 * its own id, never through an edge — edges are filtered by the statuses Meta lets a list take); insights field expansion
 * `insights.date_preset(maximum){spend}` on one object (graph-api field expansion; the `maximum` preset is on the copies
 * reference's date_preset enum).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { META_KIND_FIELDS } from '../../meta/meta-kinds.js'
import { MetaReadError } from './errors.js'
import { metaChosenAccount, MetaLiveRefusal } from './live.js'
import { AD_LIST_STATUSES, ADSET_LIST_STATUSES, fieldRefused, listPaged } from './live-objects.js'
import { metaReadOne } from './read-client.js'
import { EU_COUNTRIES, type MetaSettingsTarget } from './live-settings.js'

type Row = Record<string, unknown>
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const strings = (v: unknown): string[] | null => (Array.isArray(v) ? v.map((x) => text(x)).filter((x): x is string => !!x) : null)

export type MadeKind = 'campaign' | 'adset' | 'ad'
const WORD: Readonly<Record<MadeKind, string>> = { campaign: 'campaign', adset: 'ad set', ad: 'ad' }

/** The EU payer and beneficiary the ad account saved (Meta fills them into an EU ad set that names none); null when it has none or Meta did not answer them. */
export interface DsaDefaults { payor: string; beneficiary: string }

/** The account's saved EU payer and beneficiary: both, or null (none saved, or Meta refused the fields). */
export async function liveDsaDefaults(target: MetaSettingsTarget): Promise<DsaDefaults | null> {
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'create.read.account.dsa', path: `act_${target.adAccountId}`, query: { fields: 'default_dsa_payor,default_dsa_beneficiary' } })
    const body = read.body as Row
    const payor = text(body.default_dsa_payor)
    const beneficiary = text(body.default_dsa_beneficiary)
    return payor && beneficiary ? { payor, beneficiary } : null
  } catch (err) {
    if (fieldRefused(err)) return null
    throw err
  }
}

/** The Facebook Page this business chose through its Meta connection (a promoted page_id names only it), or null. */
export async function liveChosenPage(target: MetaSettingsTarget): Promise<string | null> {
  try {
    return (await metaChosenAccount(target.connectionId)).pageId
  } catch (err) {
    if (err instanceof MetaLiveRefusal) return null
    throw err
  }
}

/**
 * Where Meta asks an ad set for its EU payer and beneficiary (DSA): the EU countries and the EU's outermost regions Meta
 * targets by codes of their own (Réunion RE, Guadeloupe GP, Martinique MQ, French Guiana GF, Mayotte YT, Saint-Martin MF —
 * facts F1 X7: "the EU, associated territories").
 */
export const DSA_COUNTRIES: ReadonlySet<string> = new Set([...EU_COUNTRIES, 'RE', 'GP', 'MQ', 'GF', 'YT', 'MF'])
/** Where Meta lets no ad reach people under 18: the EU (with its outermost regions), the EEA (NO, IS, LI) and CH (facts F1 M6). */
export const NO_YOUTH_COUNTRIES: ReadonlySet<string> = new Set([...DSA_COUNTRIES, 'NO', 'IS', 'LI', 'CH'])

/** The countries an ad set's targeting names (geo_locations.countries); null when it names regions or cities only, or none. */
function countriesOf(targeting: unknown): string[] | null {
  const geo = obj(obj(targeting)?.geo_locations)
  if (!geo) return null
  const countries = strings(geo.countries)
  const other = ['regions', 'cities', 'zips', 'places', 'custom_locations', 'geo_markets', 'country_groups'].some((k) => Array.isArray(geo[k]) && (geo[k] as unknown[]).length)
  return countries?.length && !other ? countries : null
}

/** One ad set's EU facts for a copy: its countries (null: not only countries) and its own payer / beneficiary. */
export interface CopyAdSetFacts { id: string; name: string | null; countries: string[] | null; dsaPayor: string | null; dsaBeneficiary: string | null }

/** What a copy copies, as Meta sent it now. */
export interface CopySource {
  kind: MadeKind
  id: string
  name: string | null
  status: string | null
  effectiveStatus: string | null
  /** An ad set's or ad's campaign; an ad's ad set. */
  campaignId: string | null
  adSetId: string | null
  /** The campaign's own status (the source's, or its parent's). */
  campaignStatus: string | null
  /** The ad set's own status (an ad's parent). */
  adSetStatus: string | null
  objective: string | null
  specialAdCategories: string[] | null
  smartPromotionType: string | null
  /** Ads a deep copy would copy (Meta: at most 3 in one request, 51 asynchronously); null: not counted (an ad). */
  adCount: number | null
  /** The ad sets whose EU payer and beneficiary a copy needs (a campaign's, an ad set itself, an ad's ad set). */
  adSets: CopyAdSetFacts[]
  adSetsMore: boolean
}

const FIELDS: Readonly<Record<MadeKind, string>> = {
  campaign: `id,account_id,name,status,effective_status,${META_KIND_FIELDS.campaign.join(',')},special_ad_categories,smart_promotion_type`,
  adset: `id,account_id,name,status,effective_status,campaign_id,${META_KIND_FIELDS.adset.join(',')},dsa_payor,dsa_beneficiary,targeting{geo_locations}`,
  ad: `id,account_id,name,status,effective_status,campaign_id,${META_KIND_FIELDS.ad.join(',')}`,
}

/** One object of the chosen account, of this kind (its own fields answered), or a refusal in words. */
async function ownObject(target: MetaSettingsTarget, kind: MadeKind, objectId: string, operation: string): Promise<Row> {
  const id = metaObjectId(objectId)
  if (!id) throw new MetaLiveRefusal(`"${objectId}" is not a Meta ${WORD[kind]} id (digits).`)
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: target.connectionId }, { operation, path: id, query: { fields: FIELDS[kind] } })).body as Row
  } catch (err) {
    if (err instanceof MetaReadError) {
      if (/nonexisting field/i.test(err.message)) throw new MetaLiveRefusal(`${id} is not ${kind === 'ad' ? 'an' : 'a'} ${WORD[kind]} (Meta: ${err.message}); meta-ads-live shows the ids.`)
      throw new MetaLiveRefusal(`Nexus could not read ${WORD[kind]} ${id} from Meta: ${err.message}`)
    }
    throw err
  }
  if (metaAdAccountId(body.account_id) !== target.adAccountId) throw new MetaLiveRefusal(`${WORD[kind][0].toUpperCase()}${WORD[kind].slice(1)} ${id} is not of the Meta ad account this business chose: Nexus copies nothing of another account.`)
  if (META_KIND_FIELDS[kind].some((f) => body[f] === undefined || body[f] === null)) throw new MetaLiveRefusal(`${id} is not ${kind === 'ad' ? 'an' : 'a'} ${WORD[kind]} of this ad account.`)
  return body
}

const adSetFacts = (r: Row): CopyAdSetFacts => ({ id: text(r.id)!, name: text(r.name), countries: countriesOf(r.targeting), dsaPayor: text(r.dsa_payor), dsaBeneficiary: text(r.dsa_beneficiary) })

/** How many ads (not deleted) hang under a campaign or an ad set — a deep copy copies them. */
async function adCountOf(target: MetaSettingsTarget, id: string): Promise<number> {
  const read = await listPaged(target.connectionId, 'create.read.copy.ads', `${id}/ads`, { fields: 'id', effective_status: [...AD_LIST_STATUSES] }, 60, true)
  return Math.max(read.totalCount ?? 0, read.rows.length + (read.more ? 1 : 0))
}

/** What a copy copies: the object, its parents' statuses, the ads a deep copy takes and the ad sets whose EU facts it needs. */
export async function liveCopySource(target: MetaSettingsTarget, kind: MadeKind, objectId: string, deep: boolean): Promise<CopySource> {
  const body = await ownObject(target, kind, objectId, `create.read.copy.${kind}`)
  const id = text(body.id) ?? objectId
  const base = { kind, id, name: text(body.name), status: text(body.status), effectiveStatus: text(body.effective_status), adCount: null as number | null, adSets: [] as CopyAdSetFacts[], adSetsMore: false }
  if (kind === 'campaign') {
    const adSets = deep ? await listPaged(target.connectionId, 'create.read.copy.campaign.adsets', `${id}/adsets`, { fields: 'id,name,dsa_payor,dsa_beneficiary,targeting{geo_locations}', effective_status: [...ADSET_LIST_STATUSES] }, 200) : null
    return {
      ...base, campaignId: id, adSetId: null, campaignStatus: base.status, adSetStatus: null, objective: text(body.objective), specialAdCategories: strings(body.special_ad_categories),
      smartPromotionType: text(body.smart_promotion_type), adCount: deep ? await adCountOf(target, id) : null,
      adSets: adSets?.rows.map(adSetFacts).filter((a) => !!a.id) ?? [], adSetsMore: adSets?.more ?? false,
    }
  }
  const campaignId = text(body.campaign_id)
  const campaign = campaignId ? await ownObject(target, 'campaign', campaignId, 'create.read.copy.parent') : null
  const parentFacts = { campaignId, campaignStatus: text(campaign?.status), objective: text(campaign?.objective), specialAdCategories: strings(campaign?.special_ad_categories), smartPromotionType: text(campaign?.smart_promotion_type) }
  if (kind === 'adset') {
    return { ...base, ...parentFacts, adSetId: id, adSetStatus: base.status, adCount: deep ? await adCountOf(target, id) : null, adSets: [adSetFacts(body)] }
  }
  const adSetId = text(body.adset_id)
  const adSet = adSetId ? await ownObject(target, 'adset', adSetId, 'create.read.copy.parent') : null
  return { ...base, ...parentFacts, adSetId, adSetStatus: text(adSet?.status), adSets: adSet ? [adSetFacts(adSet)] : [] }
}

/** The ad set a copy of an ad lands in (another ad set of the chosen account): its status, its campaign's, its EU facts. */
export async function liveCopyTargetAdSet(target: MetaSettingsTarget, adSetId: string): Promise<{ facts: CopyAdSetFacts; status: string | null; campaignId: string | null; campaignStatus: string | null }> {
  const body = await ownObject(target, 'adset', adSetId, 'create.read.copy.target')
  const campaignId = text(body.campaign_id)
  const campaign = campaignId ? await ownObject(target, 'campaign', campaignId, 'create.read.copy.target.campaign') : null
  return { facts: adSetFacts(body), status: text(body.status), campaignId, campaignStatus: text(campaign?.status) }
}

// ── undo of a create or a copy: is what it made still only what it made, and has it spent nothing? ──────────────────

/** One object a change made, as Meta has it now: there or gone, its status, what hangs under it, what it spent. */
export interface MadeNow {
  kind: MadeKind
  id: string
  /** false: Meta no longer has it (deleted, or not found). */
  there: boolean
  status: string | null
  effectiveStatus: string | null
  /** Ad sets and ads under it now (not deleted), by id. */
  children: string[]
  childrenMore: boolean
  /** Children that deliver now (effective_status ACTIVE), by id. */
  childrenOn: string[]
  /** What it spent over its whole life, in Meta's insights unit (a decimal of the currency); null when Meta did not say. */
  spend: number | null
  /** An ad Meta refuses to delete: one in an ad set with an ad sequence, or a dynamic creative ad (in words); null: none. */
  undeletable: string | null
}

/**
 * One object a change made, now: one read of its own (its account, status and effective status, its kind's fields, its
 * whole-life spend as an insights expansion — an ad also its ad set's sequence and dynamic creative flag), then its
 * children with their effective status. Graph leaves an empty connection out of an expansion, so when `insights` is not in
 * the answer its spend is read once more on the insights edge, from the day before it was made to today in the AD
 * ACCOUNT's time zone (Meta's insights dates); a read that fails leaves the spend unknown (null), and undo then keeps the
 * object. Spend is reported late, so undo also keeps whatever delivers now (removalDraft). A DELETED object is read by its
 * own id (Meta keeps it readable); one Meta does not find is gone. Another account or another kind: refused.
 */
export async function liveMadeObject(target: MetaSettingsTarget, kind: MadeKind, objectId: string, madeAt: string, timeZone: string | null = null): Promise<MadeNow> {
  const id = metaObjectId(objectId)
  if (!id) throw new MetaLiveRefusal(`"${objectId}" is not a Meta id.`)
  const gone = (status: string | null): MadeNow => ({ kind, id, there: false, status, effectiveStatus: null, children: [], childrenMore: false, childrenOn: [], spend: null, undeletable: null })
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: target.connectionId }, {
      operation: `create.read.made.${kind}`, path: id,
      query: { fields: `id,account_id,status,effective_status,${META_KIND_FIELDS[kind].join(',')},insights.date_preset(maximum){spend}${kind === 'ad' ? ',adset{id,creative_sequence,is_dynamic_creative}' : ''}` },
    })).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && err.failure.notFound) return gone(null)
    if (err instanceof MetaReadError) throw new MetaLiveRefusal(`Nexus could not read ${WORD[kind]} ${id} from Meta: ${err.message}`)
    throw err
  }
  if (metaAdAccountId(body.account_id) !== target.adAccountId) throw new MetaLiveRefusal(`${WORD[kind]} ${id} is not of the Meta ad account this business chose.`)
  const status = text(body.status)
  if (status === 'DELETED') return gone(status)
  const insights = obj(body.insights)
  const sum = (rows: Row[]) => rows.reduce((n, r) => n + (Number(text(r.spend) ?? 0) || 0), 0)
  let spend: number | null = insights ? sum(Array.isArray(insights.data) ? insights.data as Row[] : []) : null
  if (spend === null) spend = await spendSince(target, id, madeAt, timeZone)
  let undeletable: string | null = null
  if (kind === 'ad') {
    const adSet = obj(body.adset)
    const sequence = strings(obj(adSet?.creative_sequence)?.data ?? adSet?.creative_sequence) ?? []
    // best-practices/manage-your-ad-object-status.md: ads in a creative_sequence cannot be deleted; reference/adgroup.md
    // (1340029): a dynamic creative ad is deleted with its ad set only.
    if (sequence.includes(id)) undeletable = `Meta refuses to delete an ad that is part of its ad set's ad sequence (pause the ad set with set-meta-status instead).`
    else if (adSet?.is_dynamic_creative === true || adSet?.is_dynamic_creative === 'true') undeletable = `Meta refuses to delete a dynamic creative ad on its own (only its ad set can be deleted).`
  }
  const children: string[] = []
  const childrenOn: string[] = []
  let childrenMore = false
  const edges: Array<{ edge: string; statuses: readonly string[] }> = kind === 'campaign'
    ? [{ edge: 'adsets', statuses: ADSET_LIST_STATUSES }, { edge: 'ads', statuses: AD_LIST_STATUSES }]
    : kind === 'adset' ? [{ edge: 'ads', statuses: AD_LIST_STATUSES }] : []
  for (const e of edges) {
    const read = await listPaged(target.connectionId, `create.read.made.${kind}.${e.edge}`, `${id}/${e.edge}`, { fields: 'id,effective_status', effective_status: [...e.statuses] }, 200)
    for (const r of read.rows) {
      const child = text(r.id)
      if (!child) continue
      children.push(child)
      if (text(r.effective_status) === 'ACTIVE') childrenOn.push(child)
    }
    childrenMore ||= read.more
  }
  return { kind, id, there: true, status, effectiveStatus: text(body.effective_status), children, childrenMore, childrenOn, spend, undeletable }
}

/** A day (YYYY-MM-DD) in a time zone (the ad account's; UTC when unknown or not one Intl knows). */
export function dayIn(ms: number, timeZone: string | null): string {
  try {
    if (timeZone) return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(ms))
  } catch { /* an unknown zone: UTC below */ }
  return new Date(ms).toISOString().slice(0, 10)
}

/** What an object spent from the day before `madeAt` to today (the ad account's dates), or null when Meta did not answer. */
async function spendSince(target: MetaSettingsTarget, id: string, madeAt: string, timeZone: string | null): Promise<number | null> {
  const made = Date.parse(madeAt)
  if (!Number.isFinite(made)) return null
  try {
    const read = await listPaged(target.connectionId, 'create.read.made.spend', `${id}/insights`, { fields: 'spend', time_range: { since: dayIn(made - 86_400_000, timeZone), until: dayIn(Date.now(), timeZone) } }, 10)
    return read.rows.reduce((n, r) => n + (Number(text(r.spend) ?? 0) || 0), 0)
  } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
}

// ── WhatsApp marketing messages (a silent placement of Advantage+ placements) ──────────────────────────────────────

/**
 * Whether the ad account is onboarded to WhatsApp marketing messages (marketing-api/marketing-messages.md: "With Advantage+
 * placements, marketing messages are added automatically for eligible campaigns"): Meta's whatsapp_activation_status
 * (MARKETING_MESSAGE_ONBOARDED, _NOT_ONBOARDED, _INELIGIBLE), or `unread` with Meta's words when it could not be read.
 */
export async function liveWhatsAppMarketing(target: MetaSettingsTarget): Promise<{ status: string | null } | { unread: string }> {
  try {
    const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'create.read.account.marketingMessages', path: `act_${target.adAccountId}`, query: { fields: 'marketing_messages_settings{whatsapp_activation_status}' } })
    return { status: text(obj((read.body as Row).marketing_messages_settings)?.whatsapp_activation_status) }
  } catch (err) {
    if (err instanceof MetaReadError) return { unread: err.message }
    throw err
  }
}
