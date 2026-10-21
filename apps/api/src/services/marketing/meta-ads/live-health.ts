/**
 * Meta ads step 5 (2026-10-21) — the chosen ad account's HEALTH and its CHANGE HISTORY (meta-account-health,
 * meta-activity-log). GET only, through the gateway; nothing here stores anything. Built on what the merged steps read:
 *   - step 1 / 2: the connection's state (sign-in, token, permissions, the daily read, AUTH_LOST — meta-accounts.service.ts),
 *     the live token check and usage headers (meta-connection-live.ts liveConnectionCheck);
 *   - step 3: the activity log's fields and days (live-account.ts ACTIVITY_FIELDS, unixOf), the payment set-up and the
 *     billing events (billingView);
 *   - step 6: the delivery sweep (live-objects.ts deliveryProblems: the account's state and failed checks, campaigns and
 *     ad sets WITH_ISSUES, ads rejected / waiting for billing / in review with their review feedback, the Page ad limits);
 *   - step 10: the chosen Page (live-media.ts pageOf, onPage: a Page read Meta answers only to a Page token says so);
 *   - the platform watchdog's Meta check (platform-health/checks/meta.checks.ts): view summary answers its facts.
 *
 * ONLY the business's chosen assets: the chosen ad account (metaChosenAccount), its own campaigns, ad sets and ads (an id a
 * caller names is checked by live.ts objectInAccount BEFORE the call), its custom conversions and pixels (a pixel owned by a
 * portfolio another business in Nexus uses is its id and a flag), the chosen Page. Fields and query keys are FIXED lists
 * (gateway/meta-calls.ts ROUTE_KEYS holds every key on its own route).
 *
 * PEOPLE (decision, step 5): the activity log names WHO made each change (actor_name). Nexus names its OWN system user (and
 * the chosen Page) only; anyone else is Meta's id and "someone else" — meta-account-access view people names the people
 * on the account, for whoever may read it. Role changes (a person added to or removed from the account) and business-
 * information changes keep no name and no details. So the history is not people's data, needs no customers.view and
 * stays on both doors (step 14's rule is for leads and comments: people's own words and contact details).
 *
 * Checked 2026-10-21 (curl ≥ 3 s apart: developers.facebook.com/documentation/ads-commerce/marketing-api/reference/<page>.md,
 * pages-api/integrity-webhook.md, marketing-api/overview/rate-limiting.md, docs/graph-api/overview/rate-limiting; Meta's
 * Python Business SDK main, facebook_business/adobjects/<node>.py):
 *   - ad-account/activities: "This endpoint doesn't have any parameters" on v26; SDK adaccount.py get_activities: since,
 *     until (datetime), category, uid (int), oid (string), add_children (bool), extra_oids, business_id, data_source, limit,
 *     after. Nexus sends since, until, category, uid, oid, add_children — SDK only (LIVE-PROBES LG-001, LG-001b); when Meta
 *     refuses the object filter, the account's log of those days is read once and filtered by Nexus (answeredBy says so)
 *   - ad-campaign/activities (an AD SET's own edge, v26): after, business_id ("required once the ad account is associated
 *     with any business account"), category ACCOUNT | AD | AD_KEYWORDS | AD_SET | AUDIENCE | BID | BUDGET | CAMPAIGN |
 *     DATE | STATUS | TARGETING, limit, since ("Default is 7 days prior"), uid, until; SDK adset.py the same. Campaigns and
 *     ads have no activities edge (SDK campaign.py, ad.py): their history is the account's log with oid
 *   - ad-activity: actor_id, actor_name, application_id, application_name, date_time_in_timezone, event_time, event_type
 *     (the v26 enum; SDK AdActivity.EventType), extra_data ("JSON encoded extra information"), object_id, object_name,
 *     object_type, translated_event_type; "returns one week's data by default" — Nexus always sends the days
 *   - ad-account: account_status 1, 2, 3, 7, 8, 9, 100, 101 (201 / 202 are filters); disable_reason 0–15;
 *     failed_delivery_checks list<DeliveryCheck> (check_name, summary, description; extra_info {adgroup_ids, campaign_ids,
 *     countries} SDK deliverycheck.py / deliverycheckextrainfo.py only: asked in a read of its own, LIVE-PROBES LG-007)
 *   - ad-account/customconversions and custom-conversion: is_unavailable ("will return true to signal if your custom
 *     conversions have been flagged"), is_archived, last_fired_time, custom_event_type; ad-account/adspixels and
 *     ads-pixel: is_unavailable, last_fired_time, owner_business
 *   - ad-creative status (ACTIVE, IN_PROCESS, WITH_ISSUES, DELETED) and campaign / ad set effective_status IN_PROCESS
 *     (marketing-api/using-the-api/post-processing, master ACC-034)
 *   - pages-api/integrity-webhook: GET /{page-id}/page_status → id, timestamp, status ok | warning | restricted |
 *     suspended, violations {type, description, url}, restrictions {feature page_publish | page_read_only |
 *     page_messaging | page_messaging_api, description, status, applied_time, expiration_time, violation_type},
 *     recommended_actions {action_type LEARN_MORE | FILE_APPEAL | SUPPORT_TICKET | ID_VERIFICATION, url, violation_type},
 *     actions_events {type, status OPEN | PENDING | CLOSED, created_time, updated_time}; "A Page access token" and
 *     pages_manage_metadata — Nexus reads with the system-user token (LIVE-PROBES EN-062)
 *   - rate limiting: 17/2446079 and 613/1487742 (account score), 613/5044001 (100 changes a second), 613/4841018 (one edit
 *     per object per 30 s), 4/1504022 and 4/1504039 (insights), 4 (app), 80000 / 80003 / 80004 / 80014 and the Graph BUC
 *     codes 80001, 80002, 80005, 80006, 80008, 80009, 17/1885172 (spend cap 10 a day), 613/1487632 (ad set budget 4 an
 *     hour), 613/1487225 (new ads against the daily spend limit), 613 without subcode (abuse protection), 32 (Page)
 */
import prisma from '../../../db.js'
import { AD_ACCOUNT_STATUS_WORDS, metaObjectId } from '../../cx/connectors/meta/discovery.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { META_ACTIVITY_CATEGORIES } from '../../gateway/meta-calls.js'
import { metaGraphApiVersion } from '../../meta/api-version.js'
import { liveConnectionCheck } from '../../meta/meta-connection-live.js'
import { listMetaConnections } from '../../meta/meta-accounts.service.js'
import { gatherMetaHealthFacts, judgeMetaHealth, LOCAL_HOLD, META_ACCOUNT_STATUS_MEANING, META_DISABLE_REASON_STEP, META_RUNNING_STATUSES, META_TOKEN_WARN_DAYS, NEXUS_ADVICE } from '../../platform-health/checks/meta.checks.js'
import { metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { graphSafe, metaChosenAccount, MetaLiveRefusal, objectInAccount, type MetaChosenAccount } from './live.js'
import { deliveryProblems, listPaged, MAX_ROWS, STATUS_WORDS } from './live-objects.js'
import { onPage, pageOf } from './live-media.js'
import { ACTIVITY_FIELDS, billingView, DISABLE_REASON_WORDS, unixOf } from './live-account.js'
import { fieldsRefused } from './live-partners.js'
import { takenIds } from './taken.js'

type Row = Record<string, unknown>

const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const idText = (v: unknown): string | null => ((typeof v === 'string' || typeof v === 'number') && /^\d{1,25}$/.test(String(v).trim()) ? String(v).trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN; return Number.isFinite(n) ? n : null }
const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null)
const obj = (v: unknown): Row | null => (v && typeof v === 'object' && !Array.isArray(v) ? v as Row : null)
const rowsOf = (v: unknown): Row[] => {
  const list = Array.isArray(v) ? v : Array.isArray(obj(v)?.data) ? (obj(v)!.data as unknown[]) : []
  return list.filter((r): r is Row => !!r && typeof r === 'object' && !Array.isArray(r))
}
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.map((s) => (typeof s === 'string' || typeof s === 'number' ? String(s) : null)).filter((s): s is string => !!s) : [])
/** Meta's Unix seconds (or an ISO string) → ISO. */
const timeOf = (v: unknown): string | null => {
  const n = num(v)
  if (n !== null && n > 0) return new Date(n * 1000).toISOString()
  const s = text(v)
  return s && !Number.isNaN(Date.parse(s)) ? new Date(s).toISOString() : null
}
const statusText = (status: number | null) => (status === null ? null : AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}`)
const NOT_CONNECTED = 'Meta is not connected for this business. A person connects it in Settings › Channels › Meta.'

/**
 * A part of an answer read on its own: what Meta refused is said (Meta's words) and never hides the other parts. A lost
 * token, a throttle or the gateway's hold ends the whole answer (every part would say the same).
 */
async function piece<T>(work: () => Promise<T>): Promise<{ value: T | null; notRead: string | null }> {
  try {
    return { value: await work(), notRead: null }
  } catch (err) {
    if (err instanceof MetaReadError && (err.failure.authLost || err.failure.throttled)) throw err
    if (err instanceof MetaReadError || err instanceof MetaLiveRefusal) return { value: null, notRead: err.message }
    throw err
  }
}

// ── account status and disable reason in words (LG-006) ─────────────────────────────────────────────────────────────

/** The account's state as a person reads it: status, reason, whether ads can run, what to do. Pure. */
function accountStateOf(status: number | null, reason: number | null) {
  return {
    status, statusText: statusText(status),
    statusMeaning: status === null ? null : META_ACCOUNT_STATUS_MEANING[status] ?? `Meta gives status ${status}, which its reference does not list.`,
    adsCanRun: status === null ? null : META_RUNNING_STATUSES.has(status),
    disableReason: reason, disableReasonText: reason === null ? null : DISABLE_REASON_WORDS[reason] ?? `Reason ${reason}`,
    // Review B7 — Meta's reference names each reason only (0–15); what to do about it is Nexus's advice, and says so.
    whatToDo: reason !== null && reason !== 0 ? META_DISABLE_REASON_STEP[reason] ?? 'Meta does not document this reason: read Account Quality in Meta Business Suite.' : null,
    ...(reason !== null && reason !== 0 ? { whatToDoIs: NEXUS_ADVICE } : {}),
    // Master LG-006: reason 15 — Meta thinks the account was compromised: no change should go to it.
    ...(reason === 15 ? { stopChanges: 'Meta thinks this ad account was compromised: make no Meta change through Nexus until Meta restores it.' } : {}),
  }
}

/** failed_delivery_checks (DeliveryCheck): words, and the ads, campaigns and countries Meta names (SDK extra_info). Pure. */
function deliveryChecksOf(v: unknown) {
  return rowsOf(v).map((c) => {
    const extra = obj(c.extra_info)
    return {
      checkName: text(c.check_name), summary: text(c.summary), description: text(c.description),
      ...(extra ? { adIds: strings(extra.adgroup_ids).slice(0, 100), campaignIds: strings(extra.campaign_ids).slice(0, 100), countries: strings(extra.countries).slice(0, 100) } : {}),
    }
  })
}

// ── throttles in words (ACC-021) ────────────────────────────────────────────────────────────────────────────────────

/** Meta's throttle codes (code or code/subcode, as the gateway's ledger keeps them): what each is and what Nexus does. */
const META_THROTTLE_WORDS: Readonly<Record<string, { what: string; nexus: string }>> = {
  '17/2446079': { what: 'The ad account\'s call score was used up (Meta scores a read 1 and a change 3; 60 points on the Limited tier, 9,000 on Full; then up to 5 minutes blocked).', nexus: 'The read stops and runs again at the next run; Nexus holds calls back from 75 % of the score.' },
  '613/1487742': { what: 'Too many calls from this ad account (the account\'s call score).', nexus: 'The read stops and runs again at the next run; Nexus holds calls back from 75 % of the score.' },
  '613/5044001': { what: 'More than 100 changes a second for this app and ad account.', nexus: 'Nexus sends changes one by one; spread big change plans out.' },
  '613/4841018': { what: 'The same object was changed more than once in 30 seconds.', nexus: 'Nexus waits at least 30 seconds between two changes of one object, and longer after each refusal.' },
  '4/1504022': { what: 'The app reached Meta\'s insights limit (all insights calls of the app wait).', nexus: 'The read stops and runs again at the next run.' },
  '4/1504039': { what: 'The app reached Meta\'s insights limit (all insights calls of the app wait).', nexus: 'The read stops and runs again at the next run.' },
  '4': { what: 'The app reached its own call limit (every call of the app waits).', nexus: 'The read stops and runs again at the next run.' },
  '17/1885172': { what: 'The account\'s spending limit was changed 10 times today: Meta allows no more changes to it today.', nexus: 'Try again tomorrow.' },
  '613/1487632': { what: 'An ad set\'s budget changed 4 times in the last hour: its budget changes are blocked for an hour (its other changes still go).', nexus: 'Nexus does not send that ad set\'s budget again within the hour.' },
  '613/1487225': { what: 'Too many new ads for the account\'s daily spending limit.', nexus: 'Make fewer new ads, or raise the daily spending limit.' },
  '613': { what: 'Meta cut the calls without naming a limit (its abuse protection).', nexus: 'Find what calls so often; if it goes on, ask Meta support.' },
  '17': { what: 'The system user\'s call limit was reached.', nexus: 'The read stops and runs again at the next run.' },
  '32': { what: 'The Page\'s call limit was reached.', nexus: 'Page reads wait until Meta lifts it.' },
  '341': { what: 'The app reached a temporary limit.', nexus: 'The read stops and runs again at the next run.' },
  '80000': { what: 'The ad account\'s Business Use Case limit for insights was reached (per hour).', nexus: 'The read stops and runs again at the next run.' },
  '80001': { what: 'The Page\'s Business Use Case limit (calls with a Page or system-user token) was reached.', nexus: 'Page reads wait until Meta lifts it.' },
  '80002': { what: 'The Instagram Business Use Case limit was reached.', nexus: 'Instagram reads wait until Meta lifts it.' },
  '80003': { what: 'The ad account\'s Business Use Case limit for custom audiences was reached (per hour).', nexus: 'Audience calls wait until Meta lifts it.' },
  '80004': { what: 'The ad account\'s Business Use Case limit for ads management was reached (per hour).', nexus: 'The read stops and runs again at the next run.' },
  '80005': { what: 'The lead ads Business Use Case limit was reached.', nexus: 'Lead reads wait until Meta lifts it.' },
  '80006': { what: 'The Messenger Business Use Case limit was reached.', nexus: 'Messenger calls wait until Meta lifts it.' },
  '80008': { what: 'The WhatsApp Business Management Business Use Case limit was reached.', nexus: 'WhatsApp calls wait until Meta lifts it.' },
  '80009': { what: 'The catalog management Business Use Case limit was reached.', nexus: 'Catalog calls wait until Meta lifts it.' },
  '80014': { what: 'The catalog batch Business Use Case limit was reached.', nexus: 'Catalog batches wait until Meta lifts it.' },
  [LOCAL_HOLD]: { what: 'Nexus held the call back itself: Meta\'s usage headers said 75 % or more of a limit was used, or Meta asked for a pause.', nexus: 'Nothing was sent; the call goes once there is room again.' },
}

/** A code's words: the exact code, else its code without the subcode. Pure. */
export function throttleWords(code: string): { what: string; nexus: string } {
  return META_THROTTLE_WORDS[code] ?? META_THROTTLE_WORDS[code.split('/')[0]] ?? { what: `Meta throttled the call (${code}).`, nexus: 'The read stops and runs again at the next run.' }
}

/** Meta's throttles of one connection in the call ledger (Nexus's own record; no Meta call). */
async function ledgerThrottles(connectionId: string, hours: number, now: Date) {
  const since = new Date(now.getTime() - hours * 3_600_000)
  const [rows, calls] = await Promise.all([
    prisma.outboundApiCallLog.groupBy({
      by: ['errorCode'],
      where: { channel: 'META', connectionId, createdAt: { gte: since }, OR: [{ errorClass: 'rate_limited' }, { errorCode: LOCAL_HOLD }] },
      _count: { _all: true }, _max: { createdAt: true },
    }),
    prisma.outboundApiCallLog.count({ where: { channel: 'META', connectionId, createdAt: { gte: since } } }),
  ])
  return {
    hours, calls,
    throttles: rows.map((r) => ({ code: r.errorCode ?? 'unknown', calls: r._count._all, lastAt: r._max.createdAt?.toISOString() ?? null, byNexus: r.errorCode === LOCAL_HOLD, ...throttleWords(r.errorCode ?? 'unknown') }))
      .sort((a, b) => b.calls - a.calls),
  }
}

// ── meta-account-health ─────────────────────────────────────────────────────────────────────────────────────────────

export const HEALTH_VIEWS = ['summary', 'account', 'problems', 'payment', 'signals', 'page', 'connection'] as const
export type HealthView = typeof HEALTH_VIEWS[number]

interface HealthInput {
  connectionId?: string | null
  view: HealthView
  includePausedByParent?: boolean
  hours?: number
  days?: number
  maxRows?: number
}

/** The statuses the summary counts from Nexus's stored rows (as of the last read). */
const STORED_PROBLEM_STATUSES = ['WITH_ISSUES', 'IN_PROCESS', 'DISAPPROVED', 'PENDING_BILLING_INFO', 'PENDING_REVIEW'] as const

/** Nexus's own records: the watchdog's Meta facts and verdict, and what the last read kept of the account. No Meta call. */
async function healthSummary(input: HealthInput) {
  const now = new Date()
  const facts = await gatherMetaHealthFacts(now)
  if (!facts.connections.length) return { connected: false, status: 'ok', sentence: NOT_CONNECTED, source: 'Nexus\'s own records; no Meta call was made.' }
  const c = input.connectionId ? facts.connections.find((x) => x.connectionId === input.connectionId) : facts.connections[0]
  if (!c) throw new MetaLiveRefusal('No Meta connection of this business has that id.')
  const verdict = judgeMetaHealth({ ...facts, connections: [c], throttles: facts.throttles.filter((t) => t.connectionId === c.connectionId) }, now)
  const adAccountId = c.adAccountId
  const [stored, ...counts] = adAccountId ? await Promise.all([
    prisma.metaAdAccount.findFirst({ where: { adAccountId }, select: { accountStatus: true, disableReason: true, settings: true, settingsReadAt: true, lastSyncAt: true } }),
    prisma.metaAdsCampaign.groupBy({ by: ['effectiveStatus'], where: { adAccountId, effectiveStatus: { in: [...STORED_PROBLEM_STATUSES] } }, _count: { _all: true } }),
    prisma.metaAdsAdSet.groupBy({ by: ['effectiveStatus'], where: { adAccountId, effectiveStatus: { in: [...STORED_PROBLEM_STATUSES] } }, _count: { _all: true } }),
    prisma.metaAdsAd.groupBy({ by: ['effectiveStatus'], where: { adAccountId, effectiveStatus: { in: [...STORED_PROBLEM_STATUSES] } }, _count: { _all: true } }),
  ]) : [null]
  const tally = (rows: unknown) => Object.fromEntries((rows as Array<{ effectiveStatus: string | null; _count: { _all: number } }> | undefined ?? []).map((r) => [r.effectiveStatus ?? 'unknown', r._count._all]))
  const settings = obj(stored?.settings)
  const volume = rowsOf(settings?.adsVolume)[0] ?? null
  const ledger = await ledgerThrottles(c.connectionId, 24, now)
  return {
    source: 'Nexus\'s own records — the last daily read, the token\'s last check and the call ledger; no Meta call was made. The live views (account, problems, payment, signals, page, connection) read Meta now.',
    status: verdict.status, message: verdict.message, nextStep: verdict.nextStep,
    connection: { connectionId: c.connectionId, label: c.label, state: c.state, stateText: c.stateText, token: c.token, read: c.read, others: facts.connections.length - 1 },
    account: adAccountId ? {
      adAccountId, asOf: stored?.lastSyncAt?.toISOString() ?? null,
      ...accountStateOf(stored?.accountStatus ?? null, stored?.disableReason ?? null),
      failedDeliveryChecks: settings?.failed_delivery_checks === undefined ? null : deliveryChecksOf(settings.failed_delivery_checks),
      checksAsOf: stored?.settingsReadAt?.toISOString() ?? null,
    } : null,
    objectsAsOfLastRead: adAccountId ? { campaigns: tally(counts[0]), adSets: tally(counts[1]), ads: tally(counts[2]) } : null,
    // Review B5 — the daily read asks ads_volume without a field list: the count only, never the Page's limit.
    adsVolumeAsOfLastRead: volume ? { adsRunningOrInReview: num(volume.ads_running_or_in_review_count), limit: 'not read daily: view problems reads each Page\'s limit (pagesNearAdLimit)' } : null,
    callsLast24h: ledger.calls, throttlesLast24h: ledger.throttles,
    apiVersion: metaGraphApiVersion(), versionNoticesLast30Days: facts.versionNotices,
    notes: [
      'platform-health-checks check meta-ads judges the same facts every day at 06:20 UTC and raises an alert when one fails.',
      'objectsAsOfLastRead counts Nexus\'s stored campaigns, ad sets and ads by Meta\'s delivery status at the last daily read; view problems reads them live with Meta\'s reasons.',
    ],
  }
}

/** LG-006, LG-007 — the account's status, disable reason and failed delivery checks, live. */
async function healthAccount(account: MetaChosenAccount) {
  const { connectionId, adAccountId } = account
  // Reading failed_delivery_checks RUNS Meta's checks (step 6): an empty answer means every check passed.
  const core = (await metaReadOne({ connectionId }, { operation: 'health.account', path: act(adAccountId), query: { fields: 'account_status,disable_reason,failed_delivery_checks' } })).body as Row
  let checks = deliveryChecksOf(core.failed_delivery_checks)
  const missing: Array<{ part: string; sentence: string }> = []
  if (checks.length && !rowsOf(core.failed_delivery_checks).some((c) => obj(c.extra_info))) {
    // extra_info (the ads, campaigns and countries a check names) is in Meta's SDK only: its own read, so a refusal never
    // costs the checks (LIVE-PROBES LG-007).
    try {
      const more = (await metaReadOne({ connectionId }, { operation: 'health.account.checkDetails', path: act(adAccountId), query: { fields: 'failed_delivery_checks{check_name,summary,description,extra_info{adgroup_ids,campaign_ids,countries}}' } })).body as Row
      const detailed = deliveryChecksOf(more.failed_delivery_checks)
      if (detailed.length) checks = detailed
    } catch (err) {
      if (!fieldsRefused(err)) throw err
      missing.push({ part: 'checkDetails', sentence: `Meta did not answer which ads, campaigns and countries each check is about (${err.failure.sentence}).` })
    }
  }
  const status = num(core.account_status)
  const reason = num(core.disable_reason)
  return {
    adAccountId, ...accountStateOf(status, reason),
    failedDeliveryChecks: checks, everyCheckPassed: checks.length === 0,
    missing,
    notes: [
      'Meta delivers ads only in status 1 (active), 8 (pending settlement) and 9 (grace period).',
      'failedDeliveryChecks: Meta runs its delivery checks when this field is read; none means every check passed. view problems lists the campaigns, ad sets and ads that do not deliver, with Meta\'s reasons.',
      'Appeals and Account Quality are in Meta Business Suite (no API).',
    ],
  }
}

/** A creative's status while Meta processes it or after it found an issue (post-processing guide and SDK spellings). */
const CREATIVE_PROCESSING: ReadonlySet<string> = new Set(['IN_PROCESS', 'IN-PROCESS', 'WITH_ISSUES', 'WITH-ISSUES'])

/** LG-010, ACC-034, LG-019 — one sweep: step 6's delivery problems, what Meta is still processing, Pages near their ad limit. */
async function healthProblems(account: MetaChosenAccount, input: HealthInput) {
  const { connectionId, adAccountId } = account
  const maxRows = Math.min(MAX_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 200)))
  const sweep = await deliveryProblems({ connectionId, includePausedByParent: input.includePausedByParent === true, maxRows })
  // Step 6 reads campaigns and ad sets WITH_ISSUES; what Meta is still processing (IN_PROCESS, master ACC-034) is read here,
  // and creatives by their own status (no status filter on that edge: the first 100 Meta lists, filtered here).
  const [campaigns, adSets, creatives] = await Promise.all([
    piece(() => listPaged(connectionId, 'health.processing.campaigns', `${act(adAccountId)}/campaigns`, { fields: 'id,name,effective_status,issues_info', effective_status: ['IN_PROCESS'] }, maxRows)),
    piece(() => listPaged(connectionId, 'health.processing.adsets', `${act(adAccountId)}/adsets`, { fields: 'id,name,campaign_id,effective_status,issues_info', effective_status: ['IN_PROCESS'] }, maxRows)),
    piece(() => listPaged(connectionId, 'health.processing.creatives', `${act(adAccountId)}/adcreatives`, { fields: 'id,name,status' }, 100)),
  ])
  const row = (level: string) => (r: Row) => ({ level, id: idText(r.id), name: text(r.name), campaignId: idText(r.campaign_id), effectiveStatus: text(r.effective_status ?? r.status), statusText: STATUS_WORDS[(text(r.effective_status ?? r.status) ?? '').replace(/-/g, '_')] ?? text(r.effective_status ?? r.status) })
  const processing = [
    ...(campaigns.value?.rows ?? []).map(row('campaign')), ...(adSets.value?.rows ?? []).map(row('adset')),
    // Review B4 — Meta's post-processing guide writes IN-PROCESS, its SDK IN_PROCESS: both are read as one.
    ...(creatives.value?.rows ?? []).filter((r) => CREATIVE_PROCESSING.has(text(r.status) ?? '')).map(row('creative')),
  ]
  // LG-019 — a Page at its ad limit publishes no new ad.
  const pages = Array.isArray(sweep.adsVolume) ? sweep.adsVolume as Row[] : []
  const pageLimits = pages.filter((p) => p.takenByAnotherBusiness !== true && num(p.limit) !== null && num(p.adsRunningOrInReview) !== null)
    .map((p) => ({ pageId: text(p.pageId), adsRunningOrInReview: num(p.adsRunningOrInReview)!, limit: num(p.limit)!, share: num(p.adsRunningOrInReview)! / Math.max(1, num(p.limit)!) }))
    .filter((p) => p.share >= 0.9)
    .map((p) => ({ ...p, sentence: p.adsRunningOrInReview >= p.limit ? `The Page ${p.pageId} is at its limit of ${p.limit} ads running or in review: new ads do not publish until some stop.` : `The Page ${p.pageId} has ${p.adsRunningOrInReview} of its ${p.limit} ads running or in review.` }))
  const missing = [
    ...(sweep.missing ?? []),
    ...([['processingCampaigns', campaigns], ['processingAdSets', adSets], ['creatives', creatives]] as const).filter(([, p]) => p.notRead).map(([part, p]) => ({ part, sentence: p.notRead! })),
  ]
  return {
    ...sweep, processing, pagesNearAdLimit: pageLimits, missing,
    more: sweep.more || !!campaigns.value?.more || !!adSets.value?.more,
    creativesChecked: creatives.value ? Math.min(100, creatives.value.rows.length) : null,
    notes: [
      ...sweep.notes,
      'processing: campaigns and ad sets Meta is still processing after a create or a change (they may still change), and creatives IN_PROCESS or WITH_ISSUES among the first 100 Meta lists. A change made while an object is processing is allowed; a new object is not done until it leaves IN_PROCESS.',
      'pagesNearAdLimit: a Page with 90 % or more of its ads-running-or-in-review limit; at the limit new ads do not publish and existing ones can only be paused or archived.',
    ],
  }
}

/** A payment method as meta-account-health shows it: its kind only (step 3's fundingOf also has the masked text and coupons). */
function paymentKindOf(v: unknown): { type: number | null; typeText: string | null } | null {
  const m = obj(v)
  return m ? { type: num(m.type), typeText: text(m.typeText) } : null
}

/** The billing events that mean trouble (step 3's BILLING_EVENT_TYPES, read through billingView). */
const PAYMENT_TROUBLE_EVENTS: ReadonlySet<string> = new Set(['ad_account_billing_charge_failed', 'ad_account_billing_decline', 'ad_account_billing_chargeback', 'remove_funding_source'])

/** LG-011 — payment trouble before the ads stop: status, reason, payment set-up, ads waiting for billing, failed charges. */
async function healthPayment(account: MetaChosenAccount, input: HealthInput) {
  const { connectionId, adAccountId } = account
  const days = Math.min(90, Math.max(1, Math.trunc(input.days ?? 30)))
  const to = new Date().toISOString().slice(0, 10)
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10)
  const state = (await metaReadOne({ connectionId }, { operation: 'health.payment.account', path: act(adAccountId), query: { fields: 'account_status,disable_reason' } })).body as Row
  const [setup, waiting, events] = await Promise.all([
    piece(() => billingView({ connectionId, view: 'payment' })),
    piece(() => listPaged(connectionId, 'health.payment.waitingAds', `${act(adAccountId)}/ads`, { fields: 'id,name,adset_id,effective_status', effective_status: ['PENDING_BILLING_INFO'] }, 200)),
    piece(() => billingView({ connectionId, view: 'events', from, to, maxRows: 200 })),
  ])
  const status = num(state.account_status)
  const reason = num(state.disable_reason)
  const pay = setup.value as unknown as Row | null
  // Only the kind and time of a troubling event: never who made it or its amounts (meta-billing view events has them).
  const trouble = rowsOf((events.value as unknown as Row | null)?.events).filter((e) => PAYMENT_TROUBLE_EVENTS.has(text(e.type) ?? '')).map((e) => ({ time: text(e.time), type: text(e.type), typeText: text(e.typeText) }))
  const waitingAds = (waiting.value?.rows ?? []).map((r) => ({ adId: idText(r.id), name: text(r.name), adSetId: idText(r.adset_id) }))
  const problems: string[] = []
  if (status === 3) problems.push('The account is unsettled: a payment is due and no ad runs until it is paid.')
  if (status === 9) problems.push('The account is in its grace period: ads still run, but the open balance must be paid before it ends.')
  if (status === 8) problems.push('A payment is being settled; ads still run.')
  if (reason === 3) problems.push('Meta disabled the account for a payment risk.')
  if (pay && pay.hasPaymentMethod === false) problems.push('The account has no payment method: ads can be made but do not deliver.')
  if (waitingAds.length) problems.push(`${waitingAds.length} ad${waitingAds.length === 1 ? ' waits' : 's wait'} for billing information (PENDING_BILLING_INFO).`)
  if (trouble.length) problems.push(`${trouble.length} failed or declined charge${trouble.length === 1 ? '' : 's'}, chargebacks or removed payment methods in the last ${days} days.`)
  const missing = ([['paymentSetup', setup], ['adsWaitingForBilling', waiting], ['billingEvents', events]] as const).filter(([, p]) => p.notRead).map(([part, p]) => ({ part, sentence: p.notRead! }))
  return {
    adAccountId, from, to,
    trouble: problems.length > 0, problems,
    account: accountStateOf(status, reason),
    // Review A1 — the kind of payment method only: never Meta's masked text, its id or a coupon's amounts (meta-billing view
    // payment shows them to a person who may see ad spend).
    paymentSetup: pay ? {
      hasPaymentMethod: bool(pay.hasPaymentMethod), prepaid: bool(pay.prepaid),
      paymentMethod: paymentKindOf(pay.paymentMethod), expiredPaymentMethod: pay.expiredPaymentMethod === undefined ? null : !!obj(pay.expiredPaymentMethod),
    } : null,
    adsWaitingForBilling: waitingAds, troubleEvents: trouble, missing,
    notes: [
      'Fixing a payment is a person\'s, in Ads Manager › Billing and payments (Meta has no API for payment methods, funds or paying a balance).',
      'troubleEvents are the account\'s activity-log billing events of these days (meta-billing view events shows them all, with amounts, to a person who may see ad spend).',
    ],
  }
}

/** LG-013 — custom conversions Meta flagged and pixels it marks unavailable. */
async function healthSignals(account: MetaChosenAccount, input: HealthInput) {
  const { connectionId, adAccountId } = account
  const maxRows = Math.min(MAX_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 200)))
  const [conversions, pixels] = await Promise.all([
    piece(() => listPaged(connectionId, 'health.signals.customConversions', `${act(adAccountId)}/customconversions`, { fields: 'id,name,custom_event_type,is_archived,is_unavailable,last_fired_time' }, maxRows)),
    piece(() => listPaged(connectionId, 'health.signals.pixels', `${act(adAccountId)}/adspixels`, { fields: 'id,name,is_unavailable,last_fired_time,owner_business{id}' }, 100)),
  ])
  // A pixel the account can use that a portfolio another business in Nexus uses owns: its id and the flag only.
  const owners = (pixels.value?.rows ?? []).map((p) => idText(obj(p.owner_business)?.id)).filter((id): id is string => !!id && id !== account.businessId)
  const taken = await takenIds('PORTFOLIO', owners)
  const conversionRows = (conversions.value?.rows ?? []).map((c) => ({
    customConversionId: idText(c.id), name: text(c.name), eventType: text(c.custom_event_type), archived: bool(c.is_archived), flagged: c.is_unavailable === true, lastFiredTime: text(c.last_fired_time),
  }))
  const pixelRows = (pixels.value?.rows ?? []).map((p) => {
    const owner = idText(obj(p.owner_business)?.id)
    if (owner && taken.has(owner)) return { pixelId: idText(p.id), takenByAnotherBusiness: true as const }
    return { pixelId: idText(p.id), name: text(p.name), unavailable: p.is_unavailable === true, lastFiredTime: text(p.last_fired_time), takenByAnotherBusiness: false as const }
  })
  const missing = ([['customConversions', conversions], ['pixels', pixels]] as const).filter(([, p]) => p.notRead).map(([part, p]) => ({ part, sentence: p.notRead! }))
  return {
    adAccountId,
    flaggedCustomConversions: conversionRows.filter((c) => c.flagged), unavailablePixels: pixelRows.filter((p) => 'unavailable' in p && p.unavailable),
    customConversions: conversionRows, pixels: pixelRows, missing,
    more: !!conversions.value?.more,
    notes: [
      'A flagged custom conversion (or one an ad set optimises for) stops counting: Meta lifts the flag only after an appeal in Events Manager (no API). Since 2025-09-02 an ad set using one shows a soft error (issues_info 2460004; a flagged custom audience 2460003) — view problems.',
      'An unavailable pixel cannot be used; Events Manager says why. Flagged custom audiences are in the audiences reads.',
    ],
  }
}

/** Page integrity (pages-api/integrity-webhook): status words, the restricted features, Meta's next steps. */
const PAGE_STATUS_WORDS: Readonly<Record<string, string>> = {
  ok: 'OK: no active violation or restriction', warning: 'Warning: not restricted yet, but Meta may restrict it soon',
  restricted: 'Restricted because of one or more violations', suspended: 'Suspended for severe violations',
}
const PAGE_FEATURE_WORDS: Readonly<Record<string, string>> = {
  page_publish: 'The Page is unpublished from Meta\'s apps', page_read_only: 'The Page cannot post or change anything for a while',
  page_messaging: 'The Page cannot message people in Messenger', page_messaging_api: 'The Page cannot send messages through the Messenger Platform API',
}
const PAGE_ACTION_WORDS: Readonly<Record<string, string>> = {
  LEARN_MORE: 'Read Meta\'s article', FILE_APPEAL: 'Appeal on Page Status or Business Support Home', SUPPORT_TICKET: 'Open a support ticket', ID_VERIFICATION: 'Verify identity in Business Support Home',
}
/** Only Meta's own help, appeal and support pages are passed on. */
const META_LINK = /^https:\/\/([a-z0-9-]+\.)*(facebook|meta|fb|instagram)\.com(\/|$)/i
const metaLink = (v: unknown): string | null => { const s = text(v); return s && META_LINK.test(s) ? s : null }
const violationTypes = (v: unknown) => strings(v).slice(0, 20)

const PAGE_INTEGRITY_NOTE = 'Meta answers a Page\'s integrity (page_status) to a Page access token with the pages_manage_metadata permission (pages-api/integrity-webhook): the token needs pages_manage_metadata ticked, and the Page assigned to the system user.'

async function healthPage(account: MetaChosenAccount) {
  const pageId = pageOf(account)
  let body: Row
  try {
    body = (await onPage(() => metaReadOne({ connectionId: account.connectionId }, { operation: 'health.pageStatus', path: `${pageId}/page_status`, query: {} }))).body as Row
  } catch (err) {
    // Review B3 — Meta's integrity guide asks a Page access token AND pages_manage_metadata: name both.
    if (err instanceof MetaLiveRefusal) throw new MetaLiveRefusal(`${err.message} ${PAGE_INTEGRITY_NOTE}`)
    throw err
  }
  const status = text(body.status)
  return {
    pageId, checkedAt: timeOf(body.timestamp),
    status, statusText: status ? PAGE_STATUS_WORDS[status] ?? status : null,
    violations: rowsOf(body.violations).slice(0, 50).map((v) => ({ type: text(v.type), description: text(v.description), link: metaLink(v.url ?? v.link) })),
    restrictions: rowsOf(body.restrictions).slice(0, 50).map((r) => ({
      feature: text(r.feature), featureText: PAGE_FEATURE_WORDS[text(r.feature) ?? ''] ?? text(r.feature), description: text(r.description), status: text(r.status),
      appliedAt: timeOf(r.applied_time), expiresAt: timeOf(r.expiration_time), violationTypes: violationTypes(r.violation_type),
    })),
    recommendedActions: rowsOf(body.recommended_actions).slice(0, 20).map((a) => ({ action: text(a.action_type), actionText: PAGE_ACTION_WORDS[text(a.action_type) ?? ''] ?? text(a.action_type), link: metaLink(a.url), violationTypes: violationTypes(a.violation_type) })),
    actionEvents: rowsOf(body.actions_events ?? body.action_events).slice(0, 20).map((e) => ({ type: text(e.type), status: text(e.status), createdAt: timeOf(e.created_time), updatedAt: timeOf(e.updated_time), violationTypes: violationTypes(e.violation_type) })),
    notes: [
      'Appeals, support tickets and identity checks are on Meta\'s own pages (Page Status, Business Support Home): links to Meta\'s pages only are passed on.',
      'Meta also pushes these changes (Page webhook business_integrity) once Nexus subscribes to it.',
    ],
  }
}

/** ACC-042, LG-023, ACC-021, ACC-016 — the token, usage, version and throttles in one place. */
async function healthConnection(input: HealthInput) {
  // Not metaConnectionFor: a token Meta refused is exactly what this view is for (debug_token goes with the app token).
  const connections = await listMetaConnections()
  const connection = input.connectionId ? connections.find((c) => c.connectionId === input.connectionId) : connections[0]
  if (!connection) throw new MetaLiveRefusal(input.connectionId ? 'No Meta connection of this business has that id.' : NOT_CONNECTED)
  const hours = Math.min(168, Math.max(1, Math.trunc(input.hours ?? 24)))
  const now = new Date()
  const [live, ledger] = await Promise.all([
    liveConnectionCheck(connection.connectionId, connection.adAccount?.adAccountId ?? null),
    ledgerThrottles(connection.connectionId, hours, now),
  ])
  const problems: string[] = []
  const token = live.token
  if (live.tokenError) problems.push(`Nexus could not check the token with Meta now: ${live.tokenError}`)
  if (token && !token.isValid) problems.push(`Meta says the token is not valid${token.problem ? `: ${token.problem}` : '.'} Make a new system-user token and enter it in Settings › Channels › Meta.`)
  if (token && !token.appMatches) problems.push('The token belongs to another Meta app than the one entered for this business.')
  const left = token?.expiresAt ? Math.floor((Date.parse(token.expiresAt) - now.getTime()) / 86_400_000) : null
  if (token?.isValid && left !== null && left < META_TOKEN_WARN_DAYS) problems.push(`The token expires in ${left} days and Nexus has not renewed it (it renews from 30 days before).`)
  const required = (token?.missing ?? []).filter((m) => m.required)
  if (required.length) problems.push(`The token does not carry ${required.map((m) => m.scope).join(', ')}.`)
  const usage = live.usage
  const highest = usage ? Math.max(0, ...usage.businessUseCase.flatMap((b) => [b.callCountPct ?? 0, b.cpuTimePct ?? 0, b.totalTimePct ?? 0]), usage.adAccount?.usedPct ?? 0, usage.insights?.accountPct ?? 0, usage.insights?.appPct ?? 0) : null
  if (highest !== null && highest >= 75) problems.push(`Meta reports ${highest} % of a rate limit used: Nexus holds calls back from 75 % until it falls.`)
  if (usage?.versionWarning) problems.push(`Meta upgraded the call from an expired API version (${usage.versionWarning}): the pinned version has to move.`)
  const metaThrottles = ledger.throttles.filter((t) => !t.byNexus).reduce((n, t) => n + t.calls, 0)
  if (metaThrottles) problems.push(`Meta throttled ${metaThrottles} call${metaThrottles === 1 ? '' : 's'} in the last ${hours} hours.`)
  return {
    connectionId: connection.connectionId, source: 'The token and usage read live from Meta now (debug_token with the app token, and one cheap read); throttles from Nexus\'s call ledger.',
    healthy: problems.length === 0, problems,
    state: connection.state, stateText: connection.stateText, read: connection.read,
    tokenNow: token, tokenAsKept: connection.token, usage, usageReadOn: live.usageReadOn, usageError: live.usageError,
    apiVersion: live.apiVersion, ledger,
    notes: [
      'Nexus checks the token every 12 hours and renews a 60-day token 30 days before it ends; alerts go out at 14, 7 and 1 days left if it cannot.',
      'Usage: Meta\'s own percentages per limit (Business Use Case, the ad account, insights, the app); Nexus backs off from 75 %.',
      'ledger.throttles: every Meta throttle code of the window, what it is and what Nexus does about it (byNexus: Nexus held the call itself before Meta\'s limit).',
    ],
  }
}

/** One view of the chosen ad account's health. */
export async function healthView(input: HealthInput) {
  switch (input.view) {
    case 'summary': return healthSummary(input)
    case 'connection': return healthConnection(input)
    default: break
  }
  const account = await metaChosenAccount(input.connectionId)
  switch (input.view) {
    case 'account': return healthAccount(account)
    case 'problems': return healthProblems(account, input)
    case 'payment': return healthPayment(account, input)
    case 'signals': return healthSignals(account, input)
    case 'page': return healthPage(account)
  }
  throw new MetaLiveRefusal(`Unknown view "${input.view}".`)
}

// ── meta-activity-log ───────────────────────────────────────────────────────────────────────────────────────────────

export const ACTIVITY_SCOPES = ['account', 'campaign', 'adset', 'ad'] as const
type ActivityScope = typeof ACTIVITY_SCOPES[number]
/** AdActivity Category (SDK adactivity.py; the ad set edge's `category` on v26): the gateway's own list, the one source. */
export const ACTIVITY_CATEGORIES = META_ACTIVITY_CATEGORIES
export const ACTIVITY_TOPICS = ['all', 'account', 'review'] as const
export const ACTIVITY_MADE_BY = ['anyone', 'nexus', 'others'] as const
/** AdActivity event_type (v26 reference/ad-activity and SDK AdActivity.EventType). */
export const ACTIVITY_EVENT_TYPES = [
  'accept_custom_audience_appeal', 'account_spending_limit_reached', 'ad_account_add_user_to_role', 'ad_account_billing_charge', 'ad_account_billing_charge_failed',
  'ad_account_billing_chargeback', 'ad_account_billing_chargeback_reversal', 'ad_account_billing_decline', 'ad_account_billing_refund', 'ad_account_remove_spend_limit',
  'ad_account_remove_user_from_role', 'ad_account_reset_spend_limit', 'ad_account_set_business_information', 'ad_account_update_audience_type_url_parameter',
  'ad_account_update_spend_limit', 'ad_account_update_status', 'ad_review_approved', 'ad_review_declined', 'adaccount_update_audience_segment', 'add_funding_source',
  'add_images', 'apply_restrictions_custom_audience', 'billing_event', 'campaign_ended', 'campaign_spending_limit_reached', 'conversion_event_updated', 'create_ad',
  'create_ad_set', 'create_adaccount_agency_fee', 'create_audience', 'create_campaign_group', 'create_campaign_group_agency_fee', 'create_campaign_legacy',
  'create_custom_audience_appeal', 'delete_audience', 'delete_images', 'di_ad_set_learning_stage_exit', 'edit_and_update_ad_creative', 'edit_images',
  'first_delivery_event', 'funding_event_initiated', 'funding_event_successful', 'lifetime_budget_spent', 'merge_campaigns', 'receive_audience',
  'reject_custom_audience_appeal', 'remove_funding_source', 'remove_shared_audience', 'share_audience', 'unknown', 'unshare_audience', 'update_ad_audience_persona',
  'update_ad_bid_info', 'update_ad_bid_type', 'update_ad_creative', 'update_ad_friendly_name', 'update_ad_labels', 'update_ad_run_status',
  'update_ad_run_status_to_be_set_after_review', 'update_ad_set_ad_keywords', 'update_ad_set_bid_adjustments', 'update_ad_set_bid_strategy', 'update_ad_set_bidding',
  'update_ad_set_budget', 'update_ad_set_budget_scaling_cost_target', 'update_ad_set_budget_scaling_extra_budget', 'update_ad_set_budget_scaling_status',
  'update_ad_set_cost_bidding_mode', 'update_ad_set_duration', 'update_ad_set_learning_stage_status', 'update_ad_set_min_spend_target', 'update_ad_set_name',
  'update_ad_set_optimization_goal', 'update_ad_set_run_status', 'update_ad_set_spend_cap', 'update_ad_set_target_spec', 'update_ad_set_value_rules',
  'update_ad_targets_spec', 'update_adaccount_agency_fee', 'update_adaccount_agency_fee_status', 'update_adgroup_stop_delivery', 'update_audience',
  'update_budget_flex_toggle_status', 'update_campaign_ad_scheduling', 'update_campaign_budget', 'update_campaign_budget_optimization_toggling_status',
  'update_campaign_budget_scheduling_state', 'update_campaign_budget_split', 'update_campaign_conversion_goal', 'update_campaign_delivery_destination',
  'update_campaign_delivery_type', 'update_campaign_duration', 'update_campaign_group_ad_scheduling', 'update_campaign_group_agency_fee',
  'update_campaign_group_budget_scaling_cost_target', 'update_campaign_group_budget_scaling_extra_budget', 'update_campaign_group_budget_scaling_status',
  'update_campaign_group_budget_scheduling_state', 'update_campaign_group_delivery_type', 'update_campaign_group_high_demand_periods',
  'update_campaign_group_spend_cap', 'update_campaign_high_demand_periods', 'update_campaign_name', 'update_campaign_run_status', 'update_campaign_schedule',
  'update_campaign_value_adjustment_rule', 'update_delivery_type_cross_level_shift',
] as const
/** LG-004 — the account's own events: status, people, spending limits and their hits, business information. */
const ACCOUNT_TOPIC_EVENTS: ReadonlySet<string> = new Set([
  'ad_account_update_status', 'ad_account_add_user_to_role', 'ad_account_remove_user_from_role', 'ad_account_update_spend_limit', 'ad_account_reset_spend_limit',
  'ad_account_remove_spend_limit', 'ad_account_set_business_information', 'account_spending_limit_reached', 'campaign_spending_limit_reached', 'lifetime_budget_spent',
])
/** LG-005 — review and policy events, and the delivery and learning milestones Meta logs with them. */
const REVIEW_TOPIC_EVENTS: ReadonlySet<string> = new Set([
  'ad_review_approved', 'ad_review_declined', 'update_ad_run_status_to_be_set_after_review', 'create_custom_audience_appeal', 'accept_custom_audience_appeal',
  'reject_custom_audience_appeal', 'apply_restrictions_custom_audience', 'first_delivery_event', 'di_ad_set_learning_stage_exit', 'update_ad_set_learning_stage_status',
])
/** A person's own data: these keep no object name and no details (a person added or removed; the business's address). */
const PERSONAL_EVENTS: ReadonlySet<string> = new Set(['ad_account_add_user_to_role', 'ad_account_remove_user_from_role', 'ad_account_set_business_information'])
/**
 * The events whose details are plain facts (a status, a name, a schedule, targeting, review): shown to everyone who may
 * read the ads. Every OTHER event's details (budgets, bids, spending limits, billing, fees, value rules — or a kind Nexus
 * does not know) are under `metaRaw`, which only a person who may see ad spend gets.
 */
const PLAIN_DETAIL_EVENTS: ReadonlySet<string> = new Set([
  'ad_account_update_status', 'ad_review_approved', 'ad_review_declined', 'update_ad_run_status_to_be_set_after_review', 'create_campaign_group',
  'create_campaign_legacy', 'create_ad_set', 'create_ad', 'update_campaign_name', 'update_ad_set_name', 'update_ad_friendly_name', 'update_campaign_run_status',
  'update_ad_set_run_status', 'update_ad_run_status', 'update_ad_creative', 'edit_and_update_ad_creative', 'update_ad_set_target_spec', 'update_ad_targets_spec',
  'update_ad_set_duration', 'update_campaign_duration', 'update_campaign_schedule', 'update_campaign_ad_scheduling', 'update_campaign_group_ad_scheduling',
  'update_ad_set_optimization_goal', 'update_campaign_conversion_goal', 'update_campaign_delivery_destination', 'update_ad_set_learning_stage_status',
  'di_ad_set_learning_stage_exit', 'first_delivery_event', 'campaign_ended', 'update_ad_labels', 'create_audience', 'update_audience', 'delete_audience',
  'share_audience', 'receive_audience', 'unshare_audience', 'remove_shared_audience', 'update_adgroup_stop_delivery', 'create_custom_audience_appeal',
  'accept_custom_audience_appeal', 'reject_custom_audience_appeal', 'apply_restrictions_custom_audience', 'add_images', 'edit_images', 'delete_images',
  'conversion_event_updated', 'update_ad_set_ad_keywords', 'merge_campaigns',
])
/** LG-004 — the events that explain "why did my ads stop", in words. */
const STOP_WORDS: Readonly<Record<string, string>> = {
  account_spending_limit_reached: 'The account\'s spending limit was reached: every ad stopped until the limit is raised, reset or removed.',
  campaign_spending_limit_reached: 'A campaign\'s spending limit was reached: its ads stopped.',
  lifetime_budget_spent: 'A lifetime budget was spent: its ads stopped.',
  campaign_ended: 'A campaign reached its end date.',
  ad_account_update_status: 'The ad account\'s status changed (meta-account-health view account says what it is now).',
  ad_review_declined: 'Meta rejected an ad in review (meta-ad-details view ad shows the review feedback).',
}
/** extra_data keys Nexus passes on (Meta documents the field only as "JSON encoded extra information"); the rest are named. */
const ACTIVITY_DETAIL_KEYS: ReadonlySet<string> = new Set(['old_value', 'new_value', 'value', 'type', 'reason', 'status', 'currency', 'amount', 'field', 'old_status', 'new_status'])
const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/
const KEY_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
/**
 * The object types whose names are the chosen account's own ad objects (never a person's): other names are left out. An ad
 * account's name only for the chosen one; a Page, pixel or catalog (which another business in Nexus may use) never by
 * name here — the chosen Page's name is Nexus's own.
 */
const AD_OBJECT_TYPE = /^(campaign(_?group)?|ad_?campaign(_?group)?|ad_?set|ad(_?group)?|ad_?creative|creative|(custom_?)?audience|ad_?image|image|ad_?video|video|ad_?label|label|ad_?rule|rule)$/i

const plain = (v: unknown): v is string | number | boolean => (typeof v === 'string' ? !EMAIL_LIKE.test(v) && v.length <= 500 : typeof v === 'number' || typeof v === 'boolean')

/** An event's details: the plain values of the keys Nexus knows, one level deep; what is left out is counted and named. Pure. */
export function activityDetailsOf(raw: unknown): { kept: Record<string, unknown> | null; leftOut: number; leftOutKeys: string[] } {
  let extra: unknown = raw ?? null
  if (typeof extra === 'string') { try { extra = JSON.parse(extra) } catch { return { kept: null, leftOut: 1, leftOutKeys: [] } } }
  const o = obj(extra)
  if (!o) return { kept: null, leftOut: extra === null ? 0 : 1, leftOutKeys: [] }
  const kept: Record<string, unknown> = {}
  const leftOutKeys: string[] = []
  let leftOut = 0
  const drop = (key: string) => { leftOut++; if (KEY_NAME.test(key) && !leftOutKeys.includes(key) && leftOutKeys.length < 30) leftOutKeys.push(key) }
  for (const [key, value] of Object.entries(o)) {
    if (!ACTIVITY_DETAIL_KEYS.has(key)) { drop(key); continue }
    if (plain(value)) { kept[key] = typeof value === 'string' ? graphSafe(value) : value; continue }
    const inner = obj(value)
    if (inner) {
      const sub: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(inner)) {
        if (ACTIVITY_DETAIL_KEYS.has(k) && plain(v)) sub[k] = typeof v === 'string' ? graphSafe(v) : v
        else drop(`${key}.${k}`.replace(/[^A-Za-z0-9_]/g, '_'))
      }
      if (Object.keys(sub).length) kept[key] = sub
      continue
    }
    if (Array.isArray(value) && value.length <= 20 && value.every(plain)) { kept[key] = value.map((v) => (typeof v === 'string' ? graphSafe(v) : v)); continue }
    drop(key)
  }
  return { kept: Object.keys(kept).length ? kept : null, leftOut, leftOutKeys }
}

/** Keys that carry an amount: never in `change` (alone or inside a sub-object). */
const MONEY_DETAIL_KEYS: ReadonlySet<string> = new Set(['amount', 'currency', 'value'])
/** Details split into plain facts and the parts that carry an amount. Pure. */
function splitMoney(kept: Record<string, unknown> | null): { plain: Record<string, unknown> | null; money: Record<string, unknown> | null } {
  if (!kept) return { plain: null, money: null }
  const plain: Record<string, unknown> = {}
  const money: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(kept)) {
    const inner = obj(value)
    if (MONEY_DETAIL_KEYS.has(key) || (inner && Object.keys(inner).some((k) => MONEY_DETAIL_KEYS.has(k)))) money[key] = value
    else plain[key] = value
  }
  return { plain: Object.keys(plain).length ? plain : null, money: Object.keys(money).length ? money : null }
}

export interface ActivityInput {
  connectionId?: string | null
  scope: ActivityScope
  id?: string | null
  from?: string | null
  to?: string | null
  category?: string | null
  topic?: typeof ACTIVITY_TOPICS[number] | null
  eventTypes?: string[] | null
  madeBy?: typeof ACTIVITY_MADE_BY[number] | null
  actorId?: string | null
  withChildren?: boolean | null
  maxRows?: number
}

const isDay = (d: string) => /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d
const addUtcDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

/** One activity-log row as the tools answer it: who (Nexus by name, anyone else by id), what, on which object. */
function activityRow(r: Row, account: MetaChosenAccount, ownIds: ReadonlySet<string>) {
  const type = text(r.event_type)
  const actorId = idText(r.actor_id)
  const appId = idText(r.application_id)
  const systemUserId = account.connection.systemUser?.id ?? null
  const nexusApp = !!appId && appId === account.connection.appId
  const bySystemUser = !!actorId && actorId === systemUserId
  const byPage = !!actorId && actorId === account.pageId
  const objectId = idText(r.object_id) ?? text(r.object_id)
  const objectType = text(r.object_type)
  const personal = PERSONAL_EVENTS.has(type ?? '')
  const nameShown = !personal && ((!!objectId && ownIds.has(objectId)) || (!!objectType && AD_OBJECT_TYPE.test(objectType)))
  const details = personal ? { kept: null, leftOut: 0, leftOutKeys: [] } : activityDetailsOf(r.extra_data)
  // Review A3 — a plain event's amounts (a new ad set's budget, a merge's value) are money all the same: under metaRaw.
  const split = PLAIN_DETAIL_EVENTS.has(type ?? '') ? splitMoney(details.kept) : { plain: null, money: details.kept }
  return {
    time: timeOf(r.event_time), timeInAccountZone: text(r.date_time_in_timezone), type, typeText: text(r.translated_event_type),
    object: { id: objectId, type: objectType, ...(nameShown ? { name: text(r.object_name) } : r.object_name ? { nameLeftOut: true } : {}) },
    by: {
      madeByNexus: bySystemUser || nexusApp,
      who: bySystemUser ? 'Nexus\'s own system user' : byPage ? 'the chosen Facebook Page' : actorId ? 'someone else (a person, an agency or Meta)' : null,
      actorId, ...(bySystemUser || byPage ? { actorName: text(r.actor_name) } : {}),
      app: appId ? { appId, name: text(r.application_name), nexusApp } : null,
    },
    ...(split.plain ? { change: split.plain } : {}),
    ...(split.money ? { metaRaw: split.money } : {}),
    ...(details.leftOut ? { detailsLeftOut: details.leftOut, leftOutKeys: details.leftOutKeys } : {}),
    ...(personal ? { personal: 'A person\'s own data: no name and no details (meta-account-access view people shows the people on the account).' } : {}),
  }
}

/** LG-001, LG-002, LG-004, LG-005 — the change history of the chosen account, or of one of its campaigns, ad sets or ads. */
export async function activityLog(input: ActivityInput) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId } = account
  const today = new Date().toISOString().slice(0, 10)
  const to = input.to ?? today
  const from = input.from ?? addUtcDays(to, -6)
  if (!isDay(from) || !isDay(to)) throw new MetaLiveRefusal('from and to are calendar days (YYYY-MM-DD, UTC).')
  if (from > to) throw new MetaLiveRefusal('from is after to.')
  if (to > today) throw new MetaLiveRefusal('to is in the future: the activity log ends today.')
  const maxRows = Math.min(MAX_ROWS, Math.max(1, Math.trunc(input.maxRows ?? 100)))
  const category = input.category ? input.category.trim().toUpperCase() : null
  if (category && !(ACTIVITY_CATEGORIES as readonly string[]).includes(category)) throw new MetaLiveRefusal(`category is one of ${ACTIVITY_CATEGORIES.join(', ')}.`)
  const eventTypes = new Set((input.eventTypes ?? []).map((t) => t.trim()))
  const unknownTypes = [...eventTypes].filter((t) => !(ACTIVITY_EVENT_TYPES as readonly string[]).includes(t))
  if (unknownTypes.length) throw new MetaLiveRefusal(`${unknownTypes.slice(0, 5).join(', ')} is not an activity event type Meta documents.`)
  const actorId = input.actorId ? metaObjectId(input.actorId) : null
  if (input.actorId && !actorId) throw new MetaLiveRefusal('actorId is a Meta id (digits), from an earlier answer\'s by.actorId.')
  const topic = input.topic ?? 'all'
  const madeBy = input.madeBy ?? 'anyone'
  const localFilter = topic !== 'all' || eventTypes.size > 0 || madeBy !== 'anyone'
  // Meta's own filters, each key on its route (gateway ROUTE_KEYS): the days always ("one week by default" otherwise).
  const since = unixOf(from)
  const until = unixOf(to) + 86_400
  const query: Record<string, MetaQueryValue> = { fields: ACTIVITY_FIELDS, since, until, ...(category ? { category } : {}), ...(actorId ? { uid: actorId } : {}) }
  const scan = localFilter ? MAX_ROWS : maxRows
  let path = `${act(adAccountId)}/activities`
  let objectId: string | null = null
  let answeredBy = 'Meta'
  let objectFilterRefused: string | null = null
  // ownIds: whose names are shown (the account, the chosen Page, the object and its children); objectIds: the object and its children.
  const ownIds = new Set<string>([adAccountId, ...(account.pageId ? [account.pageId] : [])])
  const objectIds = new Set<string>()
  let children = false
  let read: Awaited<ReturnType<typeof listPaged>>
  if (input.scope === 'account') {
    if (input.id) throw new MetaLiveRefusal('scope account reads the whole account: leave id out, or name scope campaign, adset or ad with its id.')
    read = await listPaged(connectionId, 'activity.account', path, query, scan)
  } else {
    if (!input.id) throw new MetaLiveRefusal(`Name the ${input.scope === 'adset' ? 'ad set' : input.scope} (id), one of the chosen ad account's.`)
    // Checked to be the chosen account's own, and that kind, BEFORE any history is read (live.ts objectInAccount).
    objectId = await objectInAccount(account, input.id, input.scope)
    objectIds.add(objectId)
    if (input.scope === 'adset') {
      // The ad set's own edge (v26 ad-campaign/activities): business_id is required once the account is in a portfolio.
      path = `${objectId}/activities`
      read = await listPaged(connectionId, 'activity.adset', path, { ...query, ...(account.businessId ? { business_id: account.businessId } : {}) }, scan)
    } else {
      // Campaigns and ads have no edge of their own: the account's log with Meta's object filter (oid; add_children for a
      // campaign's ad sets and ads — SDK only, LIVE-PROBES LG-001b).
      children = input.scope === 'campaign' && input.withChildren !== false
      if (children) {
        const [adSets, ads] = await Promise.all([
          prisma.metaAdsAdSet.findMany({ where: { adAccountId, campaignId: objectId }, select: { adSetId: true }, take: 2000 }),
          prisma.metaAdsAd.findMany({ where: { adAccountId, campaignId: objectId }, select: { adId: true }, take: 2000 }),
        ])
        for (const s of adSets) objectIds.add(s.adSetId)
        for (const a of ads) objectIds.add(a.adId)
      }
      try {
        read = await listPaged(connectionId, `activity.${input.scope}`, path, { ...query, oid: objectId, ...(children ? { add_children: true } : {}) }, scan)
      } catch (err) {
        if (!fieldsRefused(err)) throw err
        objectFilterRefused = err.failure.sentence
        // Meta refused the object filter: the account's log of these days, once, kept to this object (and its children
        // Nexus has read) here.
        const all = await listPaged(connectionId, `activity.${input.scope}.filtered`, path, query, MAX_ROWS)
        read = { ...all, rows: all.rows.filter((r) => objectIds.has(idText(r.object_id) ?? '')) }
        answeredBy = 'the account\'s log of these days, kept to this object by Nexus'
      }
    }
  }
  for (const id of objectIds) ownIds.add(id)
  // Review A2 — the account log's filters are in Meta's SDK only (v26: "This endpoint doesn't have any parameters"), and
  // Graph may IGNORE a key it does not know: every answer is checked here. The days and the actor on every entry; the
  // object for an ad, or a campaign without its children; with its children, an entry about an object Nexus does not
  // know under the campaign is kept and flagged. Meta's category cannot be checked from the answer: said so.
  const check = { outsideDays: 0, otherActors: 0, otherObjects: 0, outsideKnownObjects: 0 }
  const flagged = new WeakSet<Row>()
  const accountLog = path === `${act(adAccountId)}/activities`
  const exactObject = accountLog && !!objectId && !children
  const verified = read.rows.filter((r) => {
    const at = Date.parse(text(r.event_time) ?? '') / 1000
    if (!Number.isFinite(at) || at < since || at >= until) { check.outsideDays++; return false }
    if (actorId && idText(r.actor_id) !== actorId) { check.otherActors++; return false }
    const rowObject = idText(r.object_id) ?? text(r.object_id)
    if (exactObject && rowObject !== objectId) { check.otherObjects++; return false }
    if (accountLog && children && (!rowObject || !objectIds.has(rowObject))) { check.outsideKnownObjects++; flagged.add(r) }
    return true
  })
  const filterCheck = {
    checked: ['days', ...(actorId ? ['actor'] : []), ...(exactObject ? ['object'] : children && accountLog ? ['object (known ad sets and ads)'] : [])],
    ...check,
    sentences: [
      ...(check.outsideDays ? [`Meta returned ${check.outsideDays} entr${check.outsideDays === 1 ? 'y' : 'ies'} outside these days: it may have ignored since / until; Nexus left them out.`] : []),
      ...(check.otherActors ? [`Meta returned ${check.otherActors} entr${check.otherActors === 1 ? 'y' : 'ies'} of other actors: it may have ignored the actor filter (uid); Nexus left them out.`] : []),
      ...(check.otherObjects ? [`Meta returned ${check.otherObjects} entr${check.otherObjects === 1 ? 'y' : 'ies'} about other objects: it may have ignored the object filter (oid); Nexus left them out.`] : []),
      ...(check.outsideKnownObjects ? [`${check.outsideKnownObjects} entr${check.outsideKnownObjects === 1 ? 'y names objects' : 'ies name objects'} Nexus does not know under this campaign (outsideKnownObjects): Meta may have ignored the object filter, or they are new (Nexus learns new ones at the next daily read).`] : []),
      ...(category && accountLog ? [`Meta's category filter cannot be checked from its answer (the account's log documents no parameter): entries of another category mean Meta ignored it (LIVE-PROBES LG-001).`] : []),
    ],
  }
  const systemUserId = account.connection.systemUser?.id ?? null
  const rows = verified.filter((r) => {
    const type = text(r.event_type) ?? ''
    if (topic === 'account' && !ACCOUNT_TOPIC_EVENTS.has(type)) return false
    if (topic === 'review' && !REVIEW_TOPIC_EVENTS.has(type)) return false
    if (eventTypes.size && !eventTypes.has(type)) return false
    if (madeBy !== 'anyone') {
      const nexus = (!!systemUserId && idText(r.actor_id) === systemUserId) || (!!account.connection.appId && idText(r.application_id) === account.connection.appId)
      if ((madeBy === 'nexus') !== nexus) return false
    }
    return true
  })
  const events = rows.slice(0, maxRows).map((r) => ({ ...activityRow(r, account, ownIds), ...(flagged.has(r) ? { outsideKnownObjects: true } : {}) }))
  const whyItStopped = events.filter((e) => e.type && STOP_WORDS[e.type]).slice(0, 20).map((e) => ({ time: e.time, type: e.type, objectId: e.object.id, sentence: STOP_WORDS[e.type!] }))
  return {
    adAccountId, scope: input.scope, objectId, from, to,
    filters: { category, topic, eventTypes: [...eventTypes], madeBy, actorId, ...(input.scope === 'campaign' ? { withChildren: input.withChildren !== false } : {}) },
    answeredBy, ...(objectFilterRefused ? { objectFilterRefused } : {}), filterCheck,
    events, scanned: read.rows.length,
    more: read.more || rows.length > maxRows ? `Nexus read ${read.rows.length} entries of these days${localFilter ? ' and kept the ones asked for' : ''}; narrow the days or the filters to see the rest.` : null,
    whyItStopped,
    notes: [
      'from and to are UTC days; timeInAccountZone is the same moment in the ad account\'s time zone.',
      'by: Nexus\'s own changes (its system user or its app) are named; anyone else is Meta\'s id only — meta-account-access view people names the people on the account. A person added or removed and the business\'s address keep no name or details.',
      'change: the plain details Meta gives (an old and a new status, name, schedule …); metaRaw: the details of budget, bid, spending-limit and billing events, in Meta\'s own units (for most currencies the smallest unit, e.g. cents), only for a person who may see ad spend. detailsLeftOut / leftOutKeys count and name what Nexus did not pass on (never the values).',
      'Meta keeps the history of its own automated changes too (rules, Advantage+, learning): they show their app or Meta\'s id.',
    ],
  }
}
