/**
 * Meta step 28 — the live state step 28's changes stand on, read from Meta now (GET through the gateway; nothing stored):
 *   - one recommendation of the chosen ad account by its signature (`act_<id>/recommendations`, step 8's read) and the
 *     campaigns, ad sets and ads it is about — each the chosen account's own and of its kind (services/meta/meta-kinds.ts),
 *     with what an apply can move (budgets, goal, billing, destination, Advantage+ audience, placements, creative);
 *   - the copies an apply made (ad sets in the same campaigns, ads in the same ad sets, created since the apply started);
 *   - one study that touches the chosen account (step 8's own rule: Meta's impacting_ad_studies names it), with its cells,
 *     objectives and viewers; the studies an object is in (a test can be spoiled by another); how many run now;
 *   - the chosen Page's videos and video A/B tests.
 * Built on step 8's reads (live-optimize.ts) and step 6's helpers (live-objects.ts) — never a copy of their rules.
 *
 * Amounts are kept AS META SENT THEM (Meta's offset unit, as strings): the drafts convert them once (settings-units.ts).
 */
import { metaAdAccountId, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import { META_KIND_FIELDS } from '../../meta/meta-kinds.js'
import { MetaReadError } from './errors.js'
import { MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { fieldRefused, listPaged } from './live-objects.js'
import { metaTime, ownStudy, recommendationsOf, studyState, type StudyState } from './live-optimize.js'
import { metaReadOne } from './read-client.js'

type Row = Record<string, unknown>
export interface MetaOptimizeTarget { connectionId: string; adAccountId: string }

const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : typeof v === 'number' ? String(v) : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v)) ? String(v) : null)
const rowsOf = (v: unknown): Row[] => (Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]).filter((r): r is Row => !!obj(r)) : [])
const idsOf = (v: unknown): string[] => (Array.isArray(v) ? v : rowsOf(v)).map((x) => idText(obj(x)?.id ?? x)).filter((x): x is string => !!x)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(v); return v === null || v === undefined || v === '' || typeof v === 'boolean' || !Number.isFinite(n) ? null : n }
/** A Meta amount as sent (offset units, a string); 0 is Meta's "none" for a budget. */
const amount = (v: unknown): string | null => { const t = text(v); return t && /^\d{1,16}$/.test(t) && !/^0+$/.test(t) ? t : null }
const unixOf = (v: unknown): number | null => { const iso = metaTime(v); return iso ? Math.floor(Date.parse(iso) / 1000) : null }

// ── recommendations ────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveRecommendation {
  signature: string
  type: string | null
  stage: string | null
  objectIds: string[]
  adsManagerUrl: string | null
  time: string | null
}

/** One recommendation of the chosen ad account by its signature, as Meta lists it now (null: Meta no longer lists it). */
export async function liveRecommendation(target: MetaOptimizeTarget, signature: string): Promise<LiveRecommendation | null> {
  const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'optimizeChange.recommendations', path: `act_${target.adAccountId}/recommendations` })
  for (const raw of recommendationsOf(rowsOf(read.body))) {
    const sig = text(raw.recommendation_signature)
    if (sig !== signature) continue
    return { signature: sig, type: text(raw.type), stage: text(raw.recommendation_stage), objectIds: idsOf(raw.object_ids), adsManagerUrl: text(raw.url), time: metaTime(raw.recommendation_time) }
  }
  return null
}

/** What an apply can move, per object, as Meta sends it now. */
export interface ApplyTarget {
  kind: 'campaign' | 'adset' | 'ad'
  id: string
  name: string | null
  status: string | null
  effectiveStatus: string | null
  /** campaign / ad set: Meta's offset-unit amounts as strings (null: none). */
  dailyBudget: string | null
  lifetimeBudget: string | null
  /** ad set: its campaign, and whether that campaign holds the budget (Advantage campaign budget). */
  campaignId: string | null
  campaignStatus: string | null
  campaignHasBudget: boolean | null
  optimizationGoal: string | null
  billingEvent: string | null
  destinationType: string | null
  /** ad set: Advantage+ audience (targeting_automation.advantage_audience: 1 on, 0 off, null not set). */
  advantageAudience: number | null
  /** ad set: its placement keys as Meta sends them ({} = Advantage+ placements: Meta picks). */
  placements: Row | null
  /** ad: its ad set and creative. */
  adSetId: string | null
  adSetStatus: string | null
  creativeId: string | null
}

/** The placement keys of a targeting spec (none of them = Advantage+ placements). */
export const PLACEMENT_KEYS = ['publisher_platforms', 'facebook_positions', 'instagram_positions', 'audience_network_positions', 'messenger_positions', 'threads_positions', 'device_platforms'] as const

const ADSET_FIELDS = 'id,account_id,name,status,effective_status,campaign_id,daily_budget,lifetime_budget,optimization_goal,billing_event,destination_type,targeting,campaign{id,status,daily_budget,lifetime_budget}'
const CAMPAIGN_FIELDS = 'id,account_id,name,objective,status,effective_status,daily_budget,lifetime_budget'
const AD_FIELDS = 'id,account_id,name,status,effective_status,adset_id,creative{id},adset{id,status}'
const FIELDS_OF = { adset: ADSET_FIELDS, campaign: CAMPAIGN_FIELDS, ad: AD_FIELDS } as const
const WORD = { adset: 'ad set', campaign: 'campaign', ad: 'ad' } as const

function targetOf(kind: ApplyTarget['kind'], body: Row): ApplyTarget {
  const targeting = obj(body.targeting)
  const automation = obj(targeting?.targeting_automation)
  const campaign = obj(body.campaign)
  const placements = targeting ? Object.fromEntries(PLACEMENT_KEYS.filter((k) => k in targeting).map((k) => [k, targeting[k]])) : null
  return {
    kind, id: text(body.id)!, name: text(body.name), status: text(body.status), effectiveStatus: text(body.effective_status),
    dailyBudget: amount(body.daily_budget), lifetimeBudget: amount(body.lifetime_budget),
    campaignId: text(body.campaign_id) ?? text(campaign?.id), campaignStatus: text(campaign?.status),
    campaignHasBudget: campaign ? !!(amount(campaign.daily_budget) || amount(campaign.lifetime_budget)) : null,
    optimizationGoal: text(body.optimization_goal), billingEvent: text(body.billing_event), destinationType: text(body.destination_type),
    advantageAudience: automation ? num(automation.advantage_audience) : null, placements,
    adSetId: text(body.adset_id), adSetStatus: text(obj(body.adset)?.status), creativeId: text(obj(body.creative)?.id),
  }
}

/** One object of the chosen account read as `kind`, or why not (another account, another kind, not readable). */
async function readTarget(target: MetaOptimizeTarget, id: string, kind: ApplyTarget['kind']): Promise<ApplyTarget | { refusal: string; otherKind?: true }> {
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: target.connectionId }, { operation: `optimizeChange.read.${kind}`, path: id, query: { fields: FIELDS_OF[kind] } })).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && /nonexisting field/i.test(err.message)) return { refusal: `${id} is not ${kind === 'campaign' ? 'a' : 'an'} ${WORD[kind]}.`, otherKind: true }
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { refusal: `Nexus could not read ${WORD[kind]} ${id} from Meta: ${err.message}` }
    throw err
  }
  if (metaAdAccountId(body.account_id) !== target.adAccountId) return { refusal: `${WORD[kind]} ${id} is not of the Meta ad account this business chose: Nexus changes nothing in another account.` }
  if (META_KIND_FIELDS[kind].some((f) => body[f] === undefined || body[f] === null || body[f] === '')) return { refusal: `${id} is not ${kind === 'campaign' ? 'a' : 'an'} ${WORD[kind]} of this ad account.`, otherKind: true }
  return targetOf(kind, body)
}

/**
 * The objects a recommendation names, read now: each as the kind its type works on (`adset-or-campaign`: a budget raise
 * names either). One that is not the chosen account's own, or not of that kind, refuses the whole apply (its sentence).
 */
export async function liveApplyTargets(target: MetaOptimizeTarget, ids: string[], level: 'adset' | 'ad' | 'campaign' | 'adset-or-campaign'): Promise<ApplyTarget[] | { refusal: string }> {
  const out: ApplyTarget[] = []
  for (const raw of ids) {
    const id = metaObjectId(raw)
    if (!id) return { refusal: `"${raw}" is not a Meta id (digits).` }
    let read = await readTarget(target, id, level === 'adset-or-campaign' ? 'adset' : level)
    if ('refusal' in read && read.otherKind && level === 'adset-or-campaign') read = await readTarget(target, id, 'campaign')
    if ('refusal' in read) return { refusal: read.refusal }
    out.push(read)
  }
  return out
}

/**
 * The copies an apply made: ad sets in the given campaigns, or ads in the given ad sets, created at or after `since`
 * (Unix seconds) and not among the objects Nexus already knew there. Best effort: null when a list could not be read.
 */
export async function liveNewCopies(target: MetaOptimizeTarget, parents: Array<{ kind: 'campaign' | 'adset'; id: string }>, since: number, known: Set<string>): Promise<Array<{ kind: 'adset' | 'ad'; id: string; name: string | null; status: string | null }> | null> {
  const out: Array<{ kind: 'adset' | 'ad'; id: string; name: string | null; status: string | null }> = []
  try {
    for (const parent of parents) {
      const edge = parent.kind === 'campaign' ? 'adsets' : 'ads'
      const read = await listPaged(target.connectionId, `optimizeChange.copies.${edge}`, `${parent.id}/${edge}`, { fields: 'id,name,status,created_time' }, 200)
      for (const row of read.rows) {
        const id = text(row.id)
        const created = unixOf(row.created_time)
        if (id && !known.has(id) && created !== null && created >= since) out.push({ kind: parent.kind === 'campaign' ? 'adset' : 'ad', id, name: text(row.name), status: text(row.status) })
      }
    }
  } catch (err) {
    if (err instanceof MetaReadError) return null
    throw err
  }
  return out
}

// ── studies ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface LiveCell {
  id: string
  name: string | null
  treatment: number | null
  control: number | null
  adAccounts: string[]
  campaigns: string[]
  adSets: string[]
  ads: string[]
}

export interface LiveObjective { id: string; name: string | null; type: string | null; isPrimary: boolean | null }

export interface LiveStudy {
  id: string
  name: string | null
  description: string | null
  type: string | null
  businessId: string | null
  /** UTC Unix seconds (null: not set). */
  startTime: number | null
  endTime: number | null
  observationEndTime: number | null
  cooldownStartTime: number | null
  canceled: boolean
  state: StudyState | null
  cells: LiveCell[] | null
  /** Why the cells were not (fully) read, in Meta's words. */
  cellsNote: string | null
  objectives: LiveObjective[] | null
  viewers: string[] | null
}

const STUDY_FIELDS = 'id,name,description,type,start_time,end_time,cooldown_start_time,observation_end_time,canceled_time,business{id}'
const CELL_CORE = 'id,name,treatment_percentage,adaccounts.limit(100),campaigns.limit(100),adsets.limit(100)'
const CELL_EXTRA = 'control_percentage,ad_ids'

const cellOf = (r: Row): LiveCell => ({
  id: text(r.id)!, name: text(r.name), treatment: num(r.treatment_percentage), control: num(r.control_percentage),
  adAccounts: idsOf(r.adaccounts).map((a) => metaAdAccountId(a) ?? a), campaigns: idsOf(r.campaigns), adSets: idsOf(r.adsets), ads: idsOf(r.ad_ids),
})

/** One study of the chosen account (Meta's list of the studies that impact it names it), with its cells, objectives and viewers. */
export async function liveStudy(account: MetaChosenAccount, studyId: string, now: Date = new Date()): Promise<LiveStudy> {
  const own = await ownStudy(account, studyId)
  const { connectionId } = account
  const body = (await metaReadOne({ connectionId }, { operation: 'optimizeChange.study', path: own.studyId, query: { fields: STUDY_FIELDS } })).body as Row
  const times = { startTime: metaTime(body.start_time), endTime: metaTime(body.end_time), observationEndTime: metaTime(body.observation_end_time), canceledTime: metaTime(body.canceled_time) }
  let cells: LiveCell[] | null = null
  let cellsNote: string | null = null
  try {
    let rows: Row[]
    try {
      rows = (await listPaged(connectionId, 'optimizeChange.study.cells', `${own.studyId}/cells`, { fields: `${CELL_CORE},${CELL_EXTRA}` }, 150)).rows
    } catch (err) {
      if (!fieldRefused(err)) throw err
      rows = (await listPaged(connectionId, 'optimizeChange.study.cells', `${own.studyId}/cells`, { fields: CELL_CORE }, 150)).rows
      cellsNote = `Meta refused the holdout and ad fields of the cells (${err.failure.sentence}): they are read without them.`
    }
    cells = rows.filter((r) => text(r.id)).map(cellOf)
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled) throw err
    cellsNote = `Meta did not answer the study's cells: ${err.failure.sentence}`
  }
  const objectives = await listPaged(connectionId, 'optimizeChange.study.objectives', `${own.studyId}/objectives`, { fields: 'id,name,type,is_primary' }, 50)
    .then((r) => r.rows.filter((o) => text(o.id)).map((o) => ({ id: text(o.id)!, name: text(o.name), type: text(o.type), isPrimary: typeof o.is_primary === 'boolean' ? o.is_primary : null })))
    .catch((err) => { if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null; throw err })
  const viewers = await listPaged(connectionId, 'optimizeChange.study.viewers', `${own.studyId}/viewers`, { fields: 'id' }, 200)
    .then((r) => r.rows.map((v) => text(v.id)).filter((v): v is string => !!v))
    .catch((err) => { if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null; throw err })
  return {
    id: own.studyId, name: text(body.name), description: text(body.description), type: text(body.type), businessId: idText(obj(body.business)?.id),
    startTime: unixOf(body.start_time), endTime: unixOf(body.end_time), observationEndTime: unixOf(body.observation_end_time), cooldownStartTime: unixOf(body.cooldown_start_time),
    canceled: !!times.canceledTime, state: studyState(times, now), cells, cellsNote, objectives, viewers,
  }
}

/** The studies of the chosen account that are not over yet (planned, running or measuring), for Meta's 100-at-once limit. */
export async function liveOpenStudies(account: MetaChosenAccount, now: Date = new Date()): Promise<{ open: number; read: number; more: boolean }> {
  const read = await listPaged(account.connectionId, 'optimizeChange.studies', `act_${account.adAccountId}/impacting_ad_studies`, { fields: 'id,start_time,end_time,observation_end_time,canceled_time' }, 1000)
  const open = read.rows.filter((r) => {
    const s = studyState({ startTime: metaTime(r.start_time), endTime: metaTime(r.end_time), observationEndTime: metaTime(r.observation_end_time), canceledTime: metaTime(r.canceled_time) }, now)
    return s === 'planned' || s === 'running'
  }).length
  return { open, read: read.rows.length, more: read.more }
}

/** The studies a campaign, ad set or ad is in that are not over (planned or running), with their windows. */
export async function liveObjectStudies(account: MetaChosenAccount, kind: 'campaign' | 'adset' | 'ad', id: string, now: Date = new Date()): Promise<Array<{ studyId: string; name: string | null; state: StudyState | null; startTime: number | null; endTime: number | null }>> {
  const read = await listPaged(account.connectionId, `optimizeChange.${kind}Studies`, `${id}/ad_studies`, { fields: 'id,name,start_time,end_time,observation_end_time,canceled_time' }, 100)
  return read.rows.map((r) => ({
    studyId: text(r.id) ?? '', name: text(r.name),
    state: studyState({ startTime: metaTime(r.start_time), endTime: metaTime(r.end_time), observationEndTime: metaTime(r.observation_end_time), canceledTime: metaTime(r.canceled_time) }, now),
    startTime: unixOf(r.start_time), endTime: unixOf(r.end_time),
  })).filter((s) => s.studyId && (s.state === 'planned' || s.state === 'running'))
}

/** The chosen ad account's business portfolio, read now (studies are made on it). */
export async function liveAccountBusiness(target: MetaOptimizeTarget): Promise<string | null> {
  const read = await metaReadOne({ connectionId: target.connectionId }, { operation: 'optimizeChange.business', path: `act_${target.adAccountId}`, query: { fields: 'business{id}' } })
  return idText(obj((read.body as Row).business)?.id)
}

/** The chosen ad account's own custom conversions (Meta allows at most 100 per account). */
export async function liveAccountCustomConversions(target: MetaOptimizeTarget): Promise<Set<string>> {
  const read = await listPaged(target.connectionId, 'optimizeChange.customConversions', `act_${target.adAccountId}/customconversions`, { fields: 'id' }, 100)
  return new Set(read.rows.map((r) => text(r.id)).filter((x): x is string => !!x))
}

// ── the chosen Page's video A/B tests ─────────────────────────────────────────────────────────────────────────────

/** A video of the chosen Page, as a video A/B test needs it: whose it is and whether it is published already. */
export async function livePageVideo(target: MetaOptimizeTarget, pageId: string, videoId: string): Promise<{ id: string; title: string | null; published: boolean | null } | { refusal: string }> {
  const id = metaObjectId(videoId)
  if (!id) return { refusal: `"${videoId}" is not a Meta video id (digits).` }
  let body: Row
  try {
    body = (await metaReadOne({ connectionId: target.connectionId }, { operation: 'optimizeChange.pageVideo', path: id, query: { fields: 'id,title,published,from{id}' } })).body as Row
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return { refusal: `Nexus could not read video ${id} from Meta: ${err.message}` }
    throw err
  }
  if (idText(obj(body.from)?.id) !== pageId) return { refusal: `Video ${id} is not one the chosen Facebook Page posted.` }
  return { id, title: text(body.title), published: typeof body.published === 'boolean' ? body.published : null }
}

/** One video A/B test of the chosen Page (its control video is the Page's), with what deleting it needs. */
export async function livePageVideoTest(target: MetaOptimizeTarget, pageId: string, testId: string): Promise<{ id: string; name: string | null; publishStatus: string | null; controlVideoId: string | null; videoIds: string[]; concluded: boolean | null }> {
  const id = metaObjectId(testId)
  if (!id) throw new MetaLiveRefusal(`"${testId}" is not a Meta video test id (digits).`)
  const listed = await listPaged(target.connectionId, 'optimizeChange.pageVideoTests', `${pageId}/ab_tests`, { fields: 'id' }, 500)
  if (!listed.rows.some((r) => text(r.id) === id)) throw new MetaLiveRefusal('That test is not one of the chosen Page\'s video tests (meta-experiments view page-video-tests lists them).')
  // The fields Meta's guide and its SDK agree on (step 8 reads the result fields; their names differ between the two).
  const body = (await metaReadOne({ connectionId: target.connectionId }, { operation: 'optimizeChange.pageVideoTest', path: id, query: { fields: 'id,name,publish_status,control_video_id,experiment_video_ids' } })).body as Row
  const status = text(body.publish_status)
  return {
    id, name: text(body.name), publishStatus: status, controlVideoId: idText(body.control_video_id), videoIds: idsOf(body.experiment_video_ids),
    // Meta: "You can delete an A/B test once it has concluded"; the guide names no "concluded" status, so only one that
    // still runs (LIVE in the guide's example) is known not to be.
    concluded: status && /^(LIVE|SCHEDULED|RUNNING)$/i.test(status) ? false : null,
  }
}

/** The people with a role on the chosen ad account in its portfolio (a study is shared only with them), or null when Meta does not answer. */
export async function liveAccountPeople(target: MetaOptimizeTarget, businessId: string): Promise<Set<string> | null> {
  try {
    const read = await listPaged(target.connectionId, 'optimizeChange.people', `act_${target.adAccountId}/assigned_users`, { fields: 'id', business: businessId }, 500)
    return new Set(read.rows.map((r) => text(r.id)).filter((x): x is string => !!x))
  } catch (err) {
    if (err instanceof MetaReadError && !err.failure.authLost && !err.failure.throttled) return null
    throw err
  }
}

/** The most objects of a study Nexus confirms one by one before changing it (Meta's Limited access tier: ~60 reads per 5 minutes). */
export const MAX_STUDY_OBJECTS_CONFIRMED = 30

/**
 * Defence in depth for a change of an existing study (the gateway checks the study touches the chosen account): every
 * object in its cells is the chosen ad account's — its ad accounts the chosen one, its campaigns, ad sets and ads of it
 * (Nexus's rows, else one read each). Another account's object anywhere in it: refused, the other account never named.
 */
export async function studyForeignProblem(account: MetaChosenAccount, study: LiveStudy): Promise<string | null> {
  if (!study.cells) return `Nexus could not read the cells of study ${study.id}${study.cellsNote ? ` (${study.cellsNote})` : ''}, so it cannot confirm everything in it is the chosen ad account's: it changes nothing.`
  if (study.type === 'SPLIT_TEST_V2' && study.cellsNote) return `Nexus could not read which ads creative test ${study.id} holds (${study.cellsNote}), so it cannot confirm they are the chosen ad account's: it changes nothing.`
  if (study.cells.some((c) => c.adAccounts.some((a) => a !== account.adAccountId))) return `Study ${study.id} also measures another ad account: Nexus changes a study only when everything in it is the chosen ad account's (Ads Manager, or the business that shares it).`
  const objects = study.cells.flatMap((c) => [...c.campaigns.map((id) => ({ id, kind: 'campaign' as const })), ...c.adSets.map((id) => ({ id, kind: 'adset' as const })), ...c.ads.map((id) => ({ id, kind: 'ad' as const }))])
  if (objects.length > MAX_STUDY_OBJECTS_CONFIRMED) return `Study ${study.id} holds ${objects.length} objects; Nexus confirms at most ${MAX_STUDY_OBJECTS_CONFIRMED} before a change (Meta's rate limits): change it in Ads Manager.`
  for (const o of objects) {
    try {
      await objectInAccount(account, o.id, o.kind, 'optimizeChange.study.ownerCheck')
    } catch (err) {
      if (err instanceof MetaLiveRefusal) return `Study ${study.id} holds an object Nexus cannot confirm as the chosen ad account's (${o.kind} ${o.id}: ${err.message}): it changes nothing in it.`
      throw err
    }
  }
  return null
}
