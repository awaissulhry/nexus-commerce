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
 *     when Meta refuses it, the view says so and lists without numbers
 */
import { FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { listMetaConnections, type MetaConnection } from '../../meta/meta-accounts.service.js'
import { metaAdAccountId, metaObjectId, AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import { metaReadAll, metaReadOne } from './read-client.js'
import { MetaReadError } from './errors.js'
import { ACCOUNT_CORE_FIELDS, ACCOUNT_MONEY_FIELDS, ACCOUNT_SETTINGS_FIELDS, AD_FIELDS, AD_STATUSES_READ, ADSET_FIELDS, ADSET_STATUSES_READ, CAMPAIGN_FIELDS, CAMPAIGN_STATUSES_READ, insightFields, mapAd, mapAdSet, mapCampaign, purchasesOf } from './mappers.js'
import { decimalToMicros, metaUnitsToMicros, minorOf } from './money.js'
import type { MetaQueryValue } from '../../gateway/meta.js'
import { metaQueryKeyAllowed } from '../../gateway/meta-calls.js'

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
async function takenAdAccounts(ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set()
  const rows = await prisma.$queryRaw<Array<{ id: string }>>`SELECT t.id FROM nexus_meta_links_taken('AD_ACCOUNT', ${ids}::text[]) AS t(id)`
  return new Set(rows.map((r) => r.id))
}

/**
 * The ad accounts of one list of a business portfolio the system user's ad accounts belong to, live: its own, its
 * clients', and the claims still pending (the chosen account's portfolio, unless `portfolioId` names another one this
 * system user reaches) — needs business_management.
 */
export async function liveAdAccounts(input: { connectionId?: string | null; list: AdAccountList; portfolioId?: string | null; maxRows?: number }) {
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
  const items: Array<NonNullable<ReturnType<typeof adAccountRow>> & { edge: string }> = []
  let more = false
  for (const edge of edges[input.list]) {
    const read = await list(connection.connectionId, `adAccounts.${edge}`, `${businessId}/${edge}`, { fields: AD_ACCOUNT_FIELDS }, maxRows)
    const taken = await takenAdAccounts(read.rows.map((r) => metaAdAccountId(r.account_id ?? r.id)).filter((id): id is string => !!id))
    for (const r of read.rows) { const row = adAccountRow(r, taken, chosen); if (row) items.push({ ...row, edge }) }
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

/** One live view of the chosen ad account. */
export async function liveView(input: { connectionId?: string | null; view: LiveView; campaignId?: string | null; adSetId?: string | null; numbers?: string | null; from?: string | null; to?: string | null; level?: string | null; daily?: boolean; maxRows?: number }) {
  const account = await metaChosenAccount(input.connectionId)
  const { connectionId, adAccountId, currency } = account
  const maxRows = Math.min(500, Math.max(1, input.maxRows ?? 200))
  const ctx = { adAccountId, currencyCode: currency ?? '' }
  const preset = input.numbers && (INLINE_PRESETS as readonly string[]).includes(input.numbers) ? input.numbers : null
  const filterOf = (key: string, id: string | null | undefined) => (id ? { filtering: [{ field: key, operator: 'EQUAL', value: id }] } : {})
  const base = { account: { adAccountId, name: account.name, currency, timeZone: account.timeZone } }
  switch (input.view) {
    case 'account': {
      const core = await metaReadOne({ connectionId }, { operation: 'live.account', path: act(adAccountId), query: { fields: `${ACCOUNT_CORE_FIELDS},${ACCOUNT_MONEY_FIELDS.replace(',funding_source_details', '')},${ACCOUNT_SETTINGS_FIELDS}` } })
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
      const read = await list(connectionId, 'live.campaigns', `${act(adAccountId)}/campaigns`, { fields: CAMPAIGN_FIELDS + inlineField(preset), effective_status: CAMPAIGN_STATUSES_READ }, maxRows)
      return { ...base, numbers: preset, items: read.rows.map((r) => withNumbers(money(mapCampaign(r, ctx), currency), r, preset, currency)).filter((r) => r.campaignId), more: read.more }
    }
    case 'adsets': {
      const read = await list(connectionId, 'live.adsets', `${act(adAccountId)}/adsets`, { fields: ADSET_FIELDS + inlineField(preset), effective_status: ADSET_STATUSES_READ, ...filterOf('campaign.id', input.campaignId) }, maxRows)
      return { ...base, numbers: preset, items: read.rows.map((r) => withNumbers(money(mapAdSet(r, ctx), currency), r, preset, currency)).filter((r) => r.adSetId), more: read.more }
    }
    case 'ads': {
      const read = await list(connectionId, 'live.ads', `${act(adAccountId)}/ads`, { fields: AD_FIELDS + inlineField(preset), effective_status: AD_STATUSES_READ, ...filterOf('adset.id', input.adSetId), ...filterOf('campaign.id', input.adSetId ? null : input.campaignId) }, maxRows)
      return { ...base, numbers: preset, items: read.rows.map((r) => ({ ...(mapAd(r, { adAccountId }) ?? {}), ...(preset ? { numbers: inlineNumbers(r, currency) } : {}) })).filter((r) => (r as { adId?: string }).adId), more: read.more }
    }
    case 'insights': {
      const level = input.level && (INSIGHT_LEVELS as readonly string[]).includes(input.level) ? input.level : 'campaign'
      if (!input.from || !input.to) throw new MetaLiveRefusal('Name the days (from and to, YYYY-MM-DD, the account\'s time zone); today is allowed.')
      const grain = level === 'adset' ? 'ADSET' : level === 'ad' ? 'AD' : 'CAMPAIGN'
      const fields = level === 'account' ? 'impressions,reach,clicks,inline_link_clicks,spend,frequency,actions,action_values' : insightFields(grain)
      const read = await list(connectionId, `live.insights.${level}`, `${act(adAccountId)}/insights`, {
        level, time_range: { since: input.from, until: input.to }, time_increment: input.daily ? 1 : 'all_days', fields,
        ...filterOf('campaign.id', level !== 'account' ? input.campaignId : null),
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
      return { ...base, items: read.rows.map((r) => ({ pageId: text(r.id), name: text(r.name), chosenHere: text(r.id) === account.pageId })), more: read.more }
    }
    case 'instagram': {
      const read = await list(connectionId, 'live.instagramAccounts', `${act(adAccountId)}/instagram_accounts`, { fields: 'id,username' }, maxRows)
      return { ...base, items: read.rows.map((r) => ({ instagramId: text(r.id), username: text(r.username), chosenHere: text(r.id) === account.instagramId })), more: read.more }
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

/** Edges that list people: they need the users permission. */
export const PEOPLE_EDGES = new Set(['users', 'assigned_users', 'agencies', 'leads', 'comments', 'conversations', 'messages'])
/** Fields a graph read never asks for: the payment method's details live in Meta's billing screen (meta-billing reads them). */
const REFUSED_FIELDS = /(^|[,{])\s*funding_source_details\b/
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

/** Does this Meta object belong to the chosen ad account? Nexus's own rows first, else one live read of its account_id. */
async function objectInAccount(account: MetaChosenAccount, objectId: string): Promise<boolean> {
  if (objectId === account.pageId || objectId === account.instagramId) return true
  const where = { adAccountId: account.adAccountId }
  const known = await Promise.all([
    prisma.metaAdsCampaign.findFirst({ where: { ...where, campaignId: objectId }, select: { id: true } }),
    prisma.metaAdsAdSet.findFirst({ where: { ...where, adSetId: objectId }, select: { id: true } }),
    prisma.metaAdsAd.findFirst({ where: { ...where, adId: objectId }, select: { id: true } }),
  ])
  if (known.some(Boolean)) return true
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
  canSeePeople: boolean
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
  if (edge && PEOPLE_EDGES.has(edge) && !input.canSeePeople) throw new MetaLiveRefusal(`The edge "${edge}" lists people; it needs the users permission.`)
  if (/^act_/.test(node)) {
    if (metaAdAccountId(node) !== account.adAccountId) throw new MetaLiveRefusal('Only the ad account this business chose may be read (another account is refused, never read).')
  } else {
    const id = metaObjectId(node)
    if (!id) throw new MetaLiveRefusal(`"${node}" is not a Meta object id (digits) or act_<the chosen account>.`)
    if (!(await objectInAccount(account, id))) throw new MetaLiveRefusal('That object does not belong to the ad account this business chose, so it is not read.')
  }
  // One object with no fields names id,name: Meta's default answer of a Page node can carry its token, so the gateway
  // refuses an object read without fields.
  const fields = input.fields?.trim() || (!edge && !/^act_/.test(node) ? 'id,name' : '')
  if (fields && !/^[a-z0-9_.,{}()\s]{1,800}$/i.test(fields)) throw new MetaLiveRefusal('fields holds characters a Graph field list never has.')
  if (REFUSED_FIELDS.test(fields)) throw new MetaLiveRefusal('funding_source_details (the payment method) is not read here; it is shown on Meta\'s billing screen.')
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
