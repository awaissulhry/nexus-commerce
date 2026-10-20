/**
 * Meta ads, step 2 — what the read tools read LIVE from Meta (GET only, through the gateway): the business portfolio's
 * own, client and pending ad accounts (meta-ad-accounts; the system user's own are meta-connection view choices); the chosen ad account as it
 * is this minute (meta-ads-live); and one guarded Graph GET on the chosen ad account's own objects (meta-ads-graph-read).
 * Nothing here stores anything.
 *
 * Checked 2026-10-20 (developers.facebook.com/documentation/ads-commerce/marketing-api/reference and Meta's Python
 * Business SDK v26.0.2, facebook_business/adobjects):
 *   - /{business_id}/owned_ad_accounts, client_ad_accounts,
 *     pending_owned_ad_accounts, pending_client_ad_accounts (reference/business, "Edges")
 *   - ad-account fields and edges (minimum_budgets, promote_pages, instagram_accounts; ads_volume: SDK adaccount.py
 *     get_ads_volume), campaigns / adsets / ads edges with `effective_status`, insights params (level, time_range,
 *     time_increment; Meta reports each ad set's own attribution: since 2025-06-10 it ignores
 *     use_unified_attribution_setting and action_report_time, so neither is sent — facts F2 T1)
 *   - numbers inline in a list (`insights.date_preset(last_7d){…}` field expansion, master row IN-006): the Graph field
 *     expansion syntax is documented (graph-api/guides/field-expansion); this exact use on ads lists is UNVERIFIED —
 *     when Meta refuses it, the list is read again without numbers and says so (listWithNumbers; LIVE-PROBES)
 */
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { listMetaConnections, type MetaConnection } from '../../meta/meta-accounts.service.js'
import { metaAdAccountId, metaObjectId, AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { ACCOUNT_CORE_FIELDS, ACCOUNT_MONEY_FIELDS, ACCOUNT_SETTINGS_FIELDS, AD_FIELDS, AD_STATUSES_READ, ADSET_FIELDS, ADSET_STATUSES_READ, CAMPAIGN_FIELDS, CAMPAIGN_STATUSES_READ, insightFields, insightStatusFilter, mapAd, mapAdSet, mapCampaign, purchasesOf } from './mappers.js'
import { decimalToMicros, metaUnitsToMicros, minorOf } from './money.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaQueryKeyAllowed } from '../../gateway/meta-calls.js'
import { maskTakenRows, takenIds } from './taken.js'
import { ACCOUNT_EDGES, GRAPH_DEFAULT_FIELDS, graphFieldsProblem, OBJECT_EDGES, OBJECT_NODE, type GraphNode, type GraphObjectKind } from './graph-allow.js'

/** A refusal in words (no Meta call was made, or Meta's answer was not usable). */
export class MetaLiveRefusal extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetaLiveRefusal'
  }
}

export interface MetaChosenAccount {
  connection: MetaConnection
  connectionId: string
  adAccountId: string
  name: string | null
  currency: string | null
  timeZone: string | null
  businessId: string | null
  pageId: string | null
  instagramId: string | null
}

const NOT_CONNECTED = 'Meta is not connected for this business. A person connects it in Settings › Channels › Meta.'
const NO_ACCOUNT = 'No Meta ad account is chosen for this business yet. A person chooses it in Settings › Channels › Meta, or Claude asks for it with set-meta-connection (a person approves it).'

/** The business's Meta connection (the one named, else the first) — refused in words when there is none. */
export async function metaConnectionFor(connectionId?: string | null): Promise<MetaConnection> {
  const connections = await listMetaConnections()
  const connection = connectionId ? connections.find((c) => c.connectionId === connectionId) : connections[0]
  if (!connection) throw new MetaLiveRefusal(connectionId ? 'No Meta connection of this business has that id.' : NOT_CONNECTED)
  if (connection.state === 'sign_in_needed' || connection.state === 'token_problem') throw new MetaLiveRefusal(connection.stateText)
  return connection
}

/** The ad account this business chose — the ONE account the live reads may touch. */
export async function metaChosenAccount(connectionId?: string | null): Promise<MetaChosenAccount> {
  const connection = await metaConnectionFor(connectionId)
  if (!connection.adAccount) throw new MetaLiveRefusal(NO_ACCOUNT)
  return {
    connection,
    connectionId: connection.connectionId,
    adAccountId: connection.adAccount.adAccountId,
    name: connection.adAccount.name,
    currency: connection.adAccount.currency,
    timeZone: connection.adAccount.timeZone,
    businessId: connection.adAccount.businessId,
    pageId: connection.page?.pageId ?? null,
    instagramId: connection.instagram?.instagramId ?? null,
  }
}

const act = (id: string) => `act_${id}`
const text = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null)
const num = (v: unknown): number | null => { const n = typeof v === 'number' ? v : Number(v); return v === null || v === undefined || v === '' || !Number.isFinite(n) ? null : n }

async function list(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, maxRows: number) {
  const rows: Record<string, unknown>[] = []
  const read = await metaReadAll({ connectionId }, { operation, path, query: { limit: Math.min(100, maxRows), ...query }, maxPages: Math.ceil(maxRows / Math.min(100, maxRows)) }, (page) => { rows.push(...page) })
  return { rows: rows.slice(0, maxRows), more: read.truncated || rows.length > maxRows }
}

// ── meta-ad-accounts ─────────────────────────────────────────────────────────────────────────────────────────────

// The ad accounts the system user itself reaches are meta-connection view choices (one list, one permission).
export const AD_ACCOUNT_LISTS = ['owned', 'client', 'pending'] as const
export type AdAccountList = typeof AD_ACCOUNT_LISTS[number]

const AD_ACCOUNT_FIELDS = 'account_id,name,currency,timezone_name,account_status,business{id,name}'
/**
 * Review B2 — pending_owned_ad_accounts / pending_client_ad_accounts answer BusinessAdAccountRequest nodes, `{ id,
 * ad_account }`: the account is asked inside `ad_account{…}` and read from there (the request's own id is kept apart).
 */
const PENDING_FIELDS = `id,ad_account{${AD_ACCOUNT_FIELDS}}`
const PENDING_EDGES = new Set(['pending_owned_ad_accounts', 'pending_client_ad_accounts'])

/** One ad account as answered; one another business uses is its id only (its details are that business's). */
function adAccountRow(row: Record<string, unknown>, taken: Set<string>, chosen: string | null) {
  const id = metaAdAccountId(row.account_id ?? row.id)
  if (id && taken.has(id)) return { adAccountId: id, chosenHere: false, takenByAnotherBusiness: true }
  const status = num(row.account_status)
  const business = row.business && typeof row.business === 'object' ? row.business as Record<string, unknown> : null
  return id ? {
    adAccountId: id,
    name: text(row.name),
    currency: text(row.currency),
    timeZone: text(row.timezone_name),
    statusText: status === null ? null : AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}`,
    businessId: business?.id == null ? null : String(business.id),
    businessName: text(business?.name),
    chosenHere: id === chosen,
    takenByAnotherBusiness: false,
  } : null
}

/** Which ids another business already picked (never which business). */
const takenAdAccounts = (ids: string[]) => takenIds('AD_ACCOUNT', ids)

/** The account row of a list row: itself, or a pending request's `ad_account`. */
function accountOfRow(row: Record<string, unknown>, edge: string): Record<string, unknown> | null {
  if (!PENDING_EDGES.has(edge)) return row
  const account = row.ad_account
  return account && typeof account === 'object' ? account as Record<string, unknown> : null
}

/**
 * The ad accounts of one list of a business portfolio the system user's ad accounts belong to, live: its own, its
 * clients', and the claims still pending (the chosen account's portfolio, unless `portfolioId` names another one this
 * system user reaches) — needs business_management.
 */
export async function liveAdAccounts(input: { connectionId?: string | null; list: AdAccountList; portfolioId?: string | null; search?: string | null; maxRows?: number }) {
  const connection = await metaConnectionFor(input.connectionId)
  const chosen = connection.adAccount?.adAccountId ?? null
  const maxRows = Math.min(500, Math.max(1, input.maxRows ?? 200))
  const businessId = input.portfolioId ? metaObjectId(input.portfolioId) : connection.adAccount?.businessId ?? null
  if (!businessId) throw new MetaLiveRefusal('Name the business portfolio (portfolioId: an ad account\'s businessId in meta-connection view choices), or choose an ad account that belongs to one.')
  if (input.portfolioId && businessId !== connection.adAccount?.businessId) {
    // Only a portfolio the system user's own ad accounts belong to: never an id from elsewhere.
    const reach = await list(connection.connectionId, 'adAccounts.portfolioCheck', 'me/adaccounts', { fields: 'account_id,business{id}' }, 500)
    const known = new Set(reach.rows.map((r) => (r.business as { id?: unknown } | undefined)?.id).filter(Boolean).map(String))
    if (!known.has(businessId)) throw new MetaLiveRefusal('That business portfolio is not one this system user\'s ad accounts belong to.')
  }
  const edges: Record<AdAccountList, string[]> = {
    owned: ['owned_ad_accounts'], client: ['client_ad_accounts'], pending: ['pending_owned_ad_accounts', 'pending_client_ad_accounts'],
  }
  // AA-002 — owned_ad_accounts and client_ad_accounts take search_query (what it matches is not documented); the
  // pending lists document no parameter.
  const search = input.search?.trim() || null
  if (search && input.list === 'pending') throw new MetaLiveRefusal('Meta documents no search for the pending lists; search the owned or client list.')
  const items: Array<NonNullable<ReturnType<typeof adAccountRow>> & { edge: string; requestId?: string | null }> = []
  let more = false
  for (const edge of edges[input.list]) {
    const pending = PENDING_EDGES.has(edge)
    const read = await list(connection.connectionId, `adAccounts.${edge}`, `${businessId}/${edge}`, { fields: pending ? PENDING_FIELDS : AD_ACCOUNT_FIELDS, ...(search ? { search_query: search } : {}) }, maxRows)
    const accounts = read.rows.map((r) => ({ request: r, account: accountOfRow(r, edge) }))
    const taken = await takenAdAccounts(accounts.map(({ account }) => metaAdAccountId(account?.account_id ?? account?.id)).filter((id): id is string => !!id))
    for (const { request, account } of accounts) {
      const row = account ? adAccountRow(account, taken, chosen) : null
      if (row) items.push({ ...row, edge, ...(pending ? { requestId: text(request.id) } : {}) })
    }
    more = more || read.more
  }
  return { list: input.list, businessId, items, more }
}

// ── meta-ads-live ────────────────────────────────────────────────────────────────────────────────────────────────

export const LIVE_VIEWS = ['account', 'campaigns', 'adsets', 'ads', 'insights', 'pages', 'instagram', 'minimum-budgets', 'ads-volume'] as const
export type LiveView = typeof LIVE_VIEWS[number]
export const INLINE_PRESETS = ['today', 'yesterday', 'last_7d', 'last_14d', 'last_30d', 'this_month', 'last_month'] as const
export const INSIGHT_LEVELS = ['account', 'campaign', 'adset', 'ad'] as const

/** Numbers of one inline insights block (`insights{data[0]}`), money in minor units. */
function inlineNumbers(row: Record<string, unknown>, currency: string | null) {
  const insights = row.insights && typeof row.insights === 'object' ? row.insights as { data?: unknown[] } : null
  const first = Array.isArray(insights?.data) ? insights!.data[0] as Record<string, unknown> | undefined : undefined
  if (!first) return null
  const purchases = purchasesOf(first.actions, first.action_values)
  return {
    impressions: num(first.impressions) ?? 0,
    clicks: num(first.clicks) ?? 0,
    spendCents: minorOf(decimalToMicros(first.spend) ?? 0n, currency),
    purchases: Number(purchases.count),
    purchaseValueCents: minorOf(purchases.valueMicros, currency),
  }
}

const inlineField = (preset: string | null) => (preset ? `,insights.date_preset(${preset}){impressions,clicks,spend,actions,action_values}` : '')

/**
 * A list with its numbers inline (master IN-006: the insights field expansion on a list, UNVERIFIED on v26). When Meta
 * refuses the expansion, the list is read again without numbers and says so (review A4); a lost token, a throttle or a
 * gateway refusal is not retried.
 */
async function listWithNumbers(connectionId: string, operation: string, path: string, fields: string, query: Record<string, MetaQueryValue>, preset: string | null, maxRows: number) {
  if (!preset) return { read: await list(connectionId, operation, path, { fields, ...query }, maxRows), numbers: null, numbersNote: null }
  try {
    return { read: await list(connectionId, operation, path, { fields: fields + inlineField(preset), ...query }, maxRows), numbers: preset, numbersNote: null }
  } catch (err) {
    if (!(err instanceof MetaReadError) || err.failure.authLost || err.failure.throttled || err.failure.origin !== 'meta') throw err
    return {
      read: await list(connectionId, operation, path, { fields, ...query }, maxRows),
      numbers: null,
      numbersNote: `Meta refused the numbers inside the list (${err.failure.sentence}); this list has no numbers. view insights reads them.`,
    }
  }
}

/** A campaign or ad set id from a caller, read only when it is the chosen account's own (else refused in words). */
async function ownObject(account: MetaChosenAccount, id: string, what: 'campaign' | 'ad set'): Promise<string> {
  const objectId = metaObjectId(id)
  if (!objectId) throw new MetaLiveRefusal(`"${id}" is not a Meta ${what} id (digits).`)
  const kind = await objectKindOf(account, objectId)
  if (kind && kind !== (what === 'campaign' ? 'campaign' : 'adset')) throw new MetaLiveRefusal(`That id is a ${kind} of this ad account, not a ${what}.`)
  if (!kind && !(await objectInAccount(account, objectId))) throw new MetaLiveRefusal(`That ${what} does not belong to the ad account this business chose, so it is not read.`)
  return objectId
}

/** One live view of the chosen ad account. */
export async function liveView(input: { connectionId?: string | null; view: LiveView; campaignId?: string | null; adSetId?: string | null; numbers?: string | null; from?: string | null; to?: string | null; level?: string | null; daily?: boolean; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId, currency } = account
  const maxRows = Math.min(500, Math.max(1, input.maxRows ?? 200))
  const ctx = { adAccountId, currencyCode: currency ?? '' }
  const preset = input.numbers && (INLINE_PRESETS as readonly string[]).includes(input.numbers) ? input.numbers : null
  const base = { account: { adAccountId, name: account.name, currency, timeZone: account.timeZone } }
  switch (input.view) {
    case 'account': {
      // The payment method (funding_source_details, MANAGE) is not asked here (review A7): it would null the money.
      const core = await metaReadOne({ connectionId }, { operation: 'live.account', path: act(adAccountId), query: { fields: `${ACCOUNT_CORE_FIELDS},${ACCOUNT_MONEY_FIELDS},${ACCOUNT_SETTINGS_FIELDS}` } })
      const b = core.body as Record<string, unknown>
      const status = num(b.account_status)
      return {
        ...base,
        statusText: status === null ? null : AD_ACCOUNT_STATUS_WORDS[status] ?? `Status ${status}`,
        disableReason: num(b.disable_reason),
        amountSpentCents: minorOf(metaUnitsToMicros(b.amount_spent, currency), currency),
        spendCapCents: (() => { const v = metaUnitsToMicros(b.spend_cap, currency); return v === null || v === 0n ? null : minorOf(v, currency) })(),
        balanceCents: minorOf(metaUnitsToMicros(b.balance, currency), currency),
        minDailyBudgetCents: minorOf(metaUnitsToMicros(b.min_daily_budget, currency), currency),
        isPrepayAccount: typeof b.is_prepay_account === 'boolean' ? b.is_prepay_account : null,
        capabilities: Array.isArray(b.capabilities) ? b.capabilities : null,
        tosAccepted: b.tos_accepted ?? null,
        failedDeliveryChecks: b.failed_delivery_checks ?? null,
        brandSafetyContentFilterLevels: b.brand_safety_content_filter_levels ?? null,
        opportunityScore: num(b.opportunity_score),
        createdTime: text(b.created_time),
      }
    }
    case 'campaigns': {
      const { read, numbers, numbersNote } = await listWithNumbers(connectionId, 'live.campaigns', `${act(adAccountId)}/campaigns`, CAMPAIGN_FIELDS, { effective_status: CAMPAIGN_STATUSES_READ }, preset, maxRows)
      return { ...base, numbers, numbersNote, items: read.rows.map((r) => withNumbers(money(mapCampaign(r, ctx), currency), r, numbers, currency)).filter((r) => r.campaignId), more: read.more }
    }
    case 'adsets': {
      // Review B5 — one campaign's ad sets through Meta's documented edge (/{campaign_id}/adsets), after checking the
      // campaign is the chosen account's; never `filtering` on act_<id>/adsets (not documented on v26).
      const path = input.campaignId ? `${await ownObject(account, input.campaignId, 'campaign')}/adsets` : `${act(adAccountId)}/adsets`
      const { read, numbers, numbersNote } = await listWithNumbers(connectionId, 'live.adsets', path, ADSET_FIELDS, { effective_status: ADSET_STATUSES_READ }, preset, maxRows)
      return { ...base, numbers, numbersNote, items: read.rows.map((r) => withNumbers(money(mapAdSet(r, ctx), currency), r, numbers, currency)).filter((r) => r.adSetId), more: read.more }
    }
    case 'ads': {
      // Review B5 — /{adset_id}/ads or /{campaign_id}/ads (documented), each checked against the chosen account first.
      const path = input.adSetId ? `${await ownObject(account, input.adSetId, 'ad set')}/ads` : input.campaignId ? `${await ownObject(account, input.campaignId, 'campaign')}/ads` : `${act(adAccountId)}/ads`
      const { read, numbers, numbersNote } = await listWithNumbers(connectionId, 'live.ads', path, AD_FIELDS, { effective_status: AD_STATUSES_READ }, preset, maxRows)
      return { ...base, numbers, numbersNote, items: read.rows.map((r) => ({ ...(mapAd(r, { adAccountId }) ?? {}), ...(numbers ? { numbers: inlineNumbers(r, currency) } : {}) })).filter((r) => (r as { adId?: string }).adId), more: read.more }
    }
    case 'insights': {
      const level = input.level && (INSIGHT_LEVELS as readonly string[]).includes(input.level) ? input.level : 'campaign'
      if (!input.from || !input.to) throw new MetaLiveRefusal('Name the days (from and to, YYYY-MM-DD, the account\'s time zone); today is allowed.')
      const grain = level === 'adset' ? 'ADSET' : level === 'ad' ? 'AD' : 'CAMPAIGN'
      const fields = level === 'account' ? 'impressions,reach,clicks,inline_link_clicks,spend,frequency,actions,action_values' : insightFields(grain)
      // Review B1 — archived and deleted objects too (Meta leaves them out of level=… without this filter).
      const filtering = level === 'account' ? [] : [...insightStatusFilter(grain), ...(input.campaignId ? [{ field: 'campaign.id', operator: 'EQUAL', value: input.campaignId }] : [])]
      const read = await list(connectionId, `live.insights.${level}`, `${act(adAccountId)}/insights`, {
        level, time_range: { since: input.from, until: input.to }, time_increment: input.daily ? 1 : 'all_days', fields,
        ...(filtering.length ? { filtering } : {}),
      }, maxRows)
      return {
        ...base, level, from: input.from, to: input.to, daily: !!input.daily,
        note: 'Meta\'s own numbers, with each ad set\'s own attribution setting (as Ads Manager; Meta uses no other since 2025-06-10). Recent days still change as late purchases are attributed.',
        items: read.rows.map((r) => {
          const purchases = purchasesOf(r.actions, r.action_values)
          return {
            dateStart: text(r.date_start), dateStop: text(r.date_stop), campaignId: text(r.campaign_id), adSetId: text(r.adset_id), adId: text(r.ad_id),
            name: text(r.ad_name ?? r.adset_name ?? r.campaign_name), impressions: num(r.impressions) ?? 0, reach: num(r.reach), clicks: num(r.clicks) ?? 0,
            linkClicks: num(r.inline_link_clicks), spendCents: minorOf(decimalToMicros(r.spend) ?? 0n, currency), frequency: num(r.frequency),
            purchases: Number(purchases.count), purchaseValueCents: minorOf(purchases.valueMicros, currency), purchaseActionType: purchases.type,
          }
        }),
        more: read.more,
      }
    }
    case 'pages': {
      const read = await list(connectionId, 'live.promotePages', `${act(adAccountId)}/promote_pages`, { fields: 'id,name' }, maxRows)
      // Review A1 — a Page another business in Nexus uses is its id and the flag only.
      const rows = await maskTakenRows('PAGE', read.rows) as Array<Record<string, unknown>>
      return { ...base, items: rows.map((r) => (r.takenByAnotherBusiness === true ? { pageId: text(r.id), takenByAnotherBusiness: true } : { pageId: text(r.id), name: text(r.name), chosenHere: text(r.id) === account.pageId, takenByAnotherBusiness: false })), more: read.more }
    }
    case 'instagram': {
      const read = await list(connectionId, 'live.instagramAccounts', `${act(adAccountId)}/instagram_accounts`, { fields: 'id,username' }, maxRows)
      // Review A1 — an Instagram account another business in Nexus uses is its id and the flag only.
      const rows = await maskTakenRows('INSTAGRAM', read.rows) as Array<Record<string, unknown>>
      return { ...base, items: rows.map((r) => (r.takenByAnotherBusiness === true ? { instagramId: text(r.id), takenByAnotherBusiness: true } : { instagramId: text(r.id), username: text(r.username), chosenHere: text(r.id) === account.instagramId, takenByAnotherBusiness: false })), more: read.more }
    }
    case 'minimum-budgets': {
      const read = await list(connectionId, 'live.minimumBudgets', `${act(adAccountId)}/minimum_budgets`, {}, maxRows)
      return { ...base, note: 'Meta\'s minimum daily budgets by currency, in Meta\'s own units of each currency (cents for most).', items: read.rows, more: read.more }
    }
    case 'ads-volume': {
      const read = await list(connectionId, 'live.adsVolume', `${act(adAccountId)}/ads_volume`, {}, maxRows)
      return { ...base, note: 'Ads running or in review against the Page\'s ad limit (Meta\'s numbers).', items: read.rows, more: read.more }
    }
  }
}

/** A mapped campaign or ad set with its micros as minor units (the tools' money keys). */
function money(row: object | null, currency: string | null): Record<string, unknown> {
  if (!row) return {}
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(row as Record<string, unknown>)) {
    if (key.endsWith('Micros')) out[key.replace(/Micros$/, 'Cents')] = typeof value === 'bigint' ? minorOf(value, currency) : null
    else if (value instanceof Date) out[key] = value.toISOString()
    else if (key !== 'adAccountId' && key !== 'currencyCode') out[key] = value
  }
  return out
}

/** A live row with its inline numbers, when a preset asked for them. */
function withNumbers(row: Record<string, unknown>, raw: Record<string, unknown>, preset: string | null, currency: string | null): Record<string, unknown> {
  return preset ? { ...row, numbers: inlineNumbers(raw, currency) } : row
}

// ── meta-ads-graph-read ──────────────────────────────────────────────────────────────────────────────────────────

// Review 2 (lead decision): graph-read is an ALLOW-LIST — graph-allow.ts names every path, field and modifier it reads.
export { graphFieldsProblem } from './graph-allow.js'

const GATEWAY_KEYS = /^(access_token|appsecret_proof|appsecret_time|_?method|batch|fields|limit|after)$/i
export const MAX_GRAPH_ROWS = 500
const MAX_ANSWER_BYTES = 200_000

/** Strip what must never travel back to a caller: paging links (they carry the token) and any token in a string. */
export function graphSafe(value: unknown, depth = 0): unknown {
  if (depth > 12) return '[too deep]'
  if (typeof value === 'string') return value.replace(/(access_token|appsecret_proof|input_token)=[^&\s"]*/gi, '$1=[redacted]')
  if (Array.isArray(value)) return value.map((v) => graphSafe(v, depth + 1))
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (k === 'next' || k === 'previous') continue
      out[k] = graphSafe(v, depth + 1)
    }
    return out
  }
  return value
}

/** Which of the chosen account's objects this id is, from Nexus's own read (null: Nexus has not read it for this account). */
export async function objectKindOf(account: MetaChosenAccount, objectId: string): Promise<GraphObjectKind | null> {
  const where = { adAccountId: account.adAccountId }
  const [campaign, adSet, ad, creative] = await Promise.all([
    prisma.metaAdsCampaign.findFirst({ where: { ...where, campaignId: objectId }, select: { id: true } }),
    prisma.metaAdsAdSet.findFirst({ where: { ...where, adSetId: objectId }, select: { id: true } }),
    prisma.metaAdsAd.findFirst({ where: { ...where, adId: objectId }, select: { id: true } }),
    prisma.metaAdsAd.findFirst({ where: { ...where, creativeId: objectId }, select: { id: true } }),
  ])
  return campaign ? 'campaign' : adSet ? 'adset' : ad ? 'ad' : creative ? 'creative' : null
}

/**
 * Does this campaign or ad set belong to the chosen ad account? Nexus's own rows first, else one live read of its
 * account_id (a campaign made since the last daily read). Never a Page or another account's object.
 */
async function objectInAccount(account: MetaChosenAccount, objectId: string): Promise<boolean> {
  if (await objectKindOf(account, objectId)) return true
  try {
    const read = await metaReadOne({ connectionId: account.connectionId }, { operation: 'graph.ownerCheck', path: objectId, query: { fields: 'account_id' } })
    return metaAdAccountId((read.body as { account_id?: unknown }).account_id) === account.adAccountId
  } catch (err) {
    if (err instanceof MetaReadError) return false
    throw err
  }
}

export interface GraphReadInput {
  connectionId?: string | null
  path: string
  fields?: string | null
  params?: Record<string, string | number | boolean>
  limit?: number
  after?: string | null
}

/**
 * One GET on the chosen ad account's own objects: `act_<chosen>`, `act_<chosen>/<edge>`, `<object id>` or
 * `<object id>/<edge>` where the object is a campaign, ad set, ad, creative or other object whose account_id is the chosen
 * account (or the chosen Page / Instagram account). Anything else is refused before a call; the gateway refuses anything
 * but a GET anyway.
 */
export async function graphRead(input: GraphReadInput) {
  const account = await metaChosenAccount(input.connectionId)
  const segments = input.path.trim().replace(/^\/+|\/+$/g, '').split('/')
  if (segments.length < 1 || segments.length > 2 || segments.some((s) => !s)) throw new MetaLiveRefusal('The path is an object and at most one edge: act_<the chosen account>[/edge] or <object id>[/edge].')
  const [node, edge] = segments
  if (edge !== undefined && !/^[a-z][a-z0-9_]{0,60}$/.test(edge)) throw new MetaLiveRefusal(`"${edge}" is not an edge name (lower case letters, digits and _).`)
  // Review 2 — allow-list only: the chosen account and its own read edges, or one of its objects Nexus has read and that
  // object's own edges. A Page, an Instagram account, a Business, people, pixels, audiences, lead forms: never here.
  let type: GraphNode
  if (/^act_/.test(node)) {
    if (metaAdAccountId(node) !== account.adAccountId) throw new MetaLiveRefusal('Only the ad account this business chose may be read (another account is refused, never read).')
    if (edge !== undefined && !ACCOUNT_EDGES[edge]) {
      throw new MetaLiveRefusal(`meta-ads-graph-read does not read "${edge}" of the ad account; it reads ${Object.keys(ACCOUNT_EDGES).join(', ')} (Pages and Instagram accounts: meta-ads-live).`)
    }
    type = edge === undefined ? 'AdAccount' : ACCOUNT_EDGES[edge]
  } else {
    const id = metaObjectId(node)
    if (!id) throw new MetaLiveRefusal(`"${node}" is not a Meta object id (digits) or act_<the chosen account>.`)
    const kind = await objectKindOf(account, id)
    if (!kind) throw new MetaLiveRefusal('meta-ads-graph-read reads only a campaign, ad set, ad or creative Nexus has read for the ad account this business chose; this id is none of them (a new one appears after the next daily read).')
    if (edge !== undefined && !OBJECT_EDGES[kind][edge]) {
      const edges = Object.keys(OBJECT_EDGES[kind])
      throw new MetaLiveRefusal(`meta-ads-graph-read does not read "${edge}" of a ${kind}${edges.length ? `; it reads ${edges.join(', ')}` : ''}.`)
    }
    type = edge === undefined ? OBJECT_NODE[kind] : OBJECT_EDGES[kind][edge]
  }
  const fields = input.fields?.trim() || GRAPH_DEFAULT_FIELDS[type]
  if (!/^[a-z0-9_.,{}()'":\s-]{1,800}$/i.test(fields)) throw new MetaLiveRefusal('fields holds characters a Graph field list never has.')
  const fieldProblem = graphFieldsProblem(fields, type)
  if (fieldProblem) throw new MetaLiveRefusal(fieldProblem)
  const params: Record<string, MetaQueryValue> = {}
  for (const [key, value] of Object.entries(input.params ?? {})) {
    if (!/^[a-z][a-z0-9_]{0,40}$/.test(key) || GATEWAY_KEYS.test(key)) throw new MetaLiveRefusal(`The parameter "${key}" is not one a read may set here.`)
    // The gateway reads only the query keys on its allow-list for this path (meta-calls.ts): say so before any call.
    if (!metaQueryKeyAllowed(segments.join('/').toLowerCase(), key)) {
      throw new MetaLiveRefusal(`Nexus does not send the parameter "${key}" on ${segments.join('/')}: Nexus reads Meta only with the parameters each of its reads needs.`)
    }
    params[key] = value
  }
  const limit = Math.min(MAX_GRAPH_ROWS, Math.max(1, Math.trunc(input.limit ?? 100)))
  const read = await metaReadOne({ connectionId: account.connectionId }, {
    operation: `graph.read${edge ? `.${edge}` : ''}`, path: segments.join('/'), query: { ...params, ...(fields ? { fields } : {}), ...(edge ? { limit } : {}), ...(input.after ? { after: input.after } : {}) },
  })
  const body = read.body as Record<string, unknown>
  const paging = body.paging as { cursors?: { after?: unknown }; next?: unknown } | undefined
  const safe = graphSafe(body) as Record<string, unknown>
  let json = JSON.stringify(safe)
  let cut = false
  if (json.length > MAX_ANSWER_BYTES && Array.isArray(safe.data)) {
    const rows = safe.data as unknown[]
    while (rows.length > 1 && JSON.stringify(safe).length > MAX_ANSWER_BYTES) rows.pop()
    cut = true
    json = JSON.stringify(safe)
  }
  return {
    adAccountId: account.adAccountId,
    path: segments.join('/'),
    answer: safe,
    nextAfter: !cut && paging?.next && typeof paging.cursors?.after === 'string' ? paging.cursors.after : null,
    cut: cut ? 'The answer was cut to fit; ask for fewer fields or a smaller limit.' : null,
    note: 'Meta\'s raw answer: money is in Meta\'s own units (budgets in the currency\'s smallest unit for most currencies; insights spend as a decimal of the currency).',
  }
}

export const LIVE_MONEY_PERMISSION = FIELDS.financialsAdspendView
