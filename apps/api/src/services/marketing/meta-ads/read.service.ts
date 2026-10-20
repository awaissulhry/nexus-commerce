/**
 * Meta ads, step 2 — the reads behind Ads › Meta and Claude's meta-ads-overview: every answer comes from the MetaAds*
 * tables the daily read fills. Nothing here calls Meta; "Read now" only asks the read queue for a run.
 *
 * The rules each answer keeps (the same as Google's):
 *   - a day counts as zero only when Nexus read it: inside the grain's range of days read (campaign days on
 *     MetaAdAccount, ad set and ad days in MetaAdsReadState). Any other day is `read: false` with no numbers — never a 0,
 *     never part of a total
 *   - money is in MINOR units of the account's own currency (its ISO 4217 exponent: EUR 2, JPY 0), never converted;
 *     micros are summed first and turned into minor units once
 *   - ratios are Nexus's, computed from the sums, null when the denominator is 0; reach is never summed over days (a
 *     person reached on two days is one person): it is shown per day only
 *   - `to` is at most the account's yesterday in its time zone; `provisionalFrom` is the first day of the daily re-read
 *     (the last 28 days, which Meta can still restate as late purchases are attributed)
 *   - `previous` (the window of the same length right before) only when Nexus read every day of it AND of the window
 *   - purchases are Meta's own count with the ad set's attribution setting (Ads Manager's), never Nexus's orders
 */
import type { MetaAdsAd, MetaAdsAdSet, MetaAdsCampaign } from '@prisma/client'
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { cursorScope, decodeCursor, encodeCursor } from '../../../lib/pagination/cursor.js'
import { listMetaConnections, type MetaConnection } from '../../meta/meta-accounts.service.js'
import { AD_ACCOUNT_STATUS_WORDS } from '../../cx/connectors/meta/discovery.js'
import { accountYesterday, addDays, dateToDay, dayCount, dayToDate, daysOf, META_DAILY_WINDOW_DAYS, type DayWindow } from './dates.js'
import { enqueueMetaAdsSync } from './enqueue.js'
import { currencyExponent, microsToMinor, minorOf } from './money.js'
import type { MetaAdsEntityType } from './types.js'

export class MetaAdsReadError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'MetaAdsReadError'
  }
}

export const DEFAULT_WINDOW_DAYS = 30
export const MAX_WINDOW_DAYS = 400
export const DEFAULT_PAGE = 100
export const MAX_PAGE = 500
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

// ── sums and metrics ─────────────────────────────────────────────────────────────────────────────────────────────

interface Sums { impressions: number; clicks: number; linkClicks: number; spendMicros: bigint; purchases4: bigint; valueMicros: bigint }
const ZERO: Sums = { impressions: 0, clicks: 0, linkClicks: 0, spendMicros: 0n, purchases4: 0n, valueMicros: 0n }
const SUM_FIELDS = { impressions: true, clicks: true, linkClicks: true, spendMicros: true, purchases: true, purchaseValueMicros: true } as const

function toSums(row: { impressions: number | null; clicks: number | null; linkClicks: number | null; spendMicros: bigint | null; purchases: unknown; purchaseValueMicros: bigint | null } | null | undefined): Sums {
  if (!row) return ZERO
  const purchases = Number(row.purchases == null ? 0 : String(row.purchases))
  return {
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    linkClicks: row.linkClicks ?? 0,
    spendMicros: row.spendMicros ?? 0n,
    purchases4: BigInt(Math.round((Number.isFinite(purchases) ? purchases : 0) * 10_000)),
    valueMicros: row.purchaseValueMicros ?? 0n,
  }
}
const addSums = (a: Sums, b: Sums): Sums => ({
  impressions: a.impressions + b.impressions, clicks: a.clicks + b.clicks, linkClicks: a.linkClicks + b.linkClicks,
  spendMicros: a.spendMicros + b.spendMicros, purchases4: a.purchases4 + b.purchases4, valueMicros: a.valueMicros + b.valueMicros,
})

/** The numbers of one window, day, campaign, ad set or ad. Money in minor units; ratios from the sums, null over a zero. */
export interface MetaAdsMetrics {
  impressions: number
  clicks: number
  linkClicks: number
  spendCents: number
  /** Meta's purchases (fractional never; kept as a number). */
  purchases: number
  purchaseValueCents: number
  ctr: number | null
  cpcCents: number | null
  cpmCents: number | null
  roas: number | null
  costPerPurchaseCents: number | null
}

function metricsOf(s: Sums, exponent: number): MetaAdsMetrics {
  const microsPerMinor = 10 ** Math.max(0, 6 - exponent)
  const spend = Number(s.spendMicros)
  const purchases = Number(s.purchases4) / 10_000
  return {
    impressions: s.impressions,
    clicks: s.clicks,
    linkClicks: s.linkClicks,
    spendCents: microsToMinor(s.spendMicros, exponent),
    purchases,
    purchaseValueCents: microsToMinor(s.valueMicros, exponent),
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    cpcCents: s.clicks > 0 ? Math.round(spend / s.clicks / microsPerMinor) : null,
    cpmCents: s.impressions > 0 ? Math.round((spend * 1000) / s.impressions / microsPerMinor) : null,
    roas: spend > 0 ? Number(s.valueMicros) / spend : null,
    costPerPurchaseCents: s.purchases4 > 0n ? Math.round(spend / purchases / microsPerMinor) : null,
  }
}

const UNREAD = {
  impressions: null, clicks: null, linkClicks: null, spendCents: null, purchases: null, purchaseValueCents: null,
  ctr: null, cpcCents: null, cpmCents: null, roas: null, costPerPurchaseCents: null, reach: null,
} as const

export type MetaAdsDay =
  | ({ date: string; provisional: boolean; read: true; reach: number | null } & MetaAdsMetrics)
  | ({ date: string; provisional: boolean; read: false } & typeof UNREAD)

// ── the account and the window ───────────────────────────────────────────────────────────────────────────────────

export interface MetaAdsAccountContext {
  connections: MetaConnection[]
  connection: MetaConnection | null
  adAccountId: string | null
  account: Awaited<ReturnType<typeof prisma.metaAdAccount.findFirst>>
  currency: string | null
  timeZone: string | null
}

/** The business's Meta connections and the one asked for, else the first with an ad account chosen. */
export async function metaAdsAccount(connectionId?: string | null): Promise<MetaAdsAccountContext> {
  const connections = await listMetaConnections()
  const wanted = typeof connectionId === 'string' && connectionId.trim() ? connectionId.trim() : null
  const connection = wanted ? connections.find((c) => c.connectionId === wanted) ?? null : connections.find((c) => c.adAccount) ?? connections[0] ?? null
  if (wanted && !connection) throw new MetaAdsReadError(404, 'Meta connection not found')
  const adAccountId = connection?.adAccount?.adAccountId ?? null
  const account = adAccountId ? await prisma.metaAdAccount.findFirst({ where: { adAccountId } }) : null
  return {
    connections,
    connection,
    adAccountId,
    account,
    currency: account?.currencyCode || connection?.adAccount?.currency || null,
    timeZone: account?.timeZone || connection?.adAccount?.timeZone || null,
  }
}

export interface WindowInput { from?: string | null; to?: string | null; days?: number | null }
export interface MetaAdsWindow { from: string; to: string; provisionalFrom: string | null }
export interface MetaAdsCoverage { daysInWindow: number; daysRead: number; missingDays: string[] }

function askedDay(value: unknown, name: string): string | null {
  if (value == null || value === '') return null
  const day = String(value).trim()
  if (!DAY_RE.test(day) || dateToDay(dayToDate(day)) !== day) throw new MetaAdsReadError(400, `${name} must be a day written YYYY-MM-DD.`)
  return day
}

function yesterdayIn(timeZone: string | null, now: Date): string {
  if (timeZone) {
    try { return accountYesterday(timeZone, now) } catch { /* an unknown zone: UTC below */ }
  }
  return accountYesterday('UTC', now)
}

export function resolveWindow(input: WindowInput, timeZone: string | null, live: boolean, now: Date = new Date()): MetaAdsWindow {
  const yesterday = yesterdayIn(timeZone, now)
  const askedTo = askedDay(input.to, 'to')
  const askedFrom = askedDay(input.from, 'from')
  const to = askedTo && askedTo < yesterday ? askedTo : yesterday
  const length = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(Number(input.days)) || DEFAULT_WINDOW_DAYS))
  let from = askedFrom ?? addDays(to, -(length - 1))
  if (from > to) from = to
  if (dayCount({ from, to }) > MAX_WINDOW_DAYS) from = addDays(to, -(MAX_WINDOW_DAYS - 1))
  const rereadFrom = addDays(yesterday, -(META_DAILY_WINDOW_DAYS - 1))
  const provisionalFrom = live && rereadFrom <= to ? (rereadFrom > from ? rereadFrom : from) : null
  return { from, to, provisionalFrom }
}

const range = (from: Date | null | undefined, to: Date | null | undefined): DayWindow | null => {
  if (!from || !to) return null
  const a = dateToDay(from)
  const b = dateToDay(to)
  return a <= b ? { from: a, to: b } : null
}

/** The range of days read for a grain of the account. */
async function readRangeOf(ctx: MetaAdsAccountContext, grain: MetaAdsEntityType): Promise<DayWindow | null> {
  if (!ctx.adAccountId) return null
  if (grain === 'CAMPAIGN') return range(ctx.account?.metricsReadFrom, ctx.account?.metricsReadThrough)
  const resource = grain === 'ACCOUNT' ? 'ACCOUNT_DAYS' : grain === 'ADSET' ? 'ADSET_DAYS' : 'AD_DAYS'
  const state = await prisma.metaAdsReadState.findFirst({ where: { adAccountId: ctx.adAccountId, resource }, select: { readFrom: true, readThrough: true } })
  return range(state?.readFrom, state?.readThrough)
}

function overlap(window: DayWindow, r: DayWindow | null): DayWindow | null {
  if (!r) return null
  const from = window.from > r.from ? window.from : r.from
  const to = window.to < r.to ? window.to : r.to
  return from <= to ? { from, to } : null
}
const isRead = (day: string, r: DayWindow | null) => !!r && day >= r.from && day <= r.to
function coverageOf(window: DayWindow, r: DayWindow | null): MetaAdsCoverage {
  const days = daysOf(window)
  const missingDays = days.filter((day) => !isRead(day, r))
  return { daysInWindow: days.length, daysRead: days.length - missingDays.length, missingDays }
}

const where = (adAccountId: string, grain: MetaAdsEntityType, r: DayWindow, filter: Record<string, string> = {}) => ({
  adAccountId, entityType: grain, ...filter, date: { gte: dayToDate(r.from), lte: dayToDate(r.to) },
})

async function sumsByDay(adAccountId: string, grain: MetaAdsEntityType, r: DayWindow, filter: Record<string, string> = {}) {
  const rows = await prisma.metaAdsDailyMetric.groupBy({ by: ['date'], where: where(adAccountId, grain, r, filter), _sum: { ...SUM_FIELDS, reach: true } })
  return new Map(rows.map((row) => [dateToDay(row.date), { sums: toSums(row._sum), reach: row._sum.reach ?? null }]))
}

async function sumsByEntity(adAccountId: string, grain: MetaAdsEntityType, r: DayWindow, filter: Record<string, string> = {}) {
  const rows = await prisma.metaAdsDailyMetric.groupBy({ by: ['entityId'], where: where(adAccountId, grain, r, filter), _sum: SUM_FIELDS })
  return new Map(rows.map((row) => [row.entityId, toSums(row._sum)]))
}

async function sumOver(adAccountId: string, grain: MetaAdsEntityType, r: DayWindow): Promise<Sums> {
  const row = await prisma.metaAdsDailyMetric.aggregate({ where: where(adAccountId, grain, r), _sum: SUM_FIELDS })
  return toSums(row._sum)
}

function daySeries(window: MetaAdsWindow, r: DayWindow | null, sums: Map<string, { sums: Sums; reach: number | null }>, exponent: number): MetaAdsDay[] {
  return daysOf(window).map((date): MetaAdsDay => {
    const provisional = window.provisionalFrom != null && date >= window.provisionalFrom
    const day = sums.get(date)
    return isRead(date, r)
      ? { date, provisional, read: true, reach: day?.reach ?? 0, ...metricsOf(day?.sums ?? ZERO, exponent) }
      : { date, provisional, read: false, ...UNREAD }
  })
}

// ── the overview ─────────────────────────────────────────────────────────────────────────────────────────────────

export interface MetaAdsAccountSummary {
  adAccountId: string
  name: string | null
  /** account_status in words (Active, Disabled, Unsettled …); null = not read yet. */
  statusText: string | null
  accountStatus: number | null
  disableReason: number | null
  amountSpentCents: number | null
  /** null = no account spending limit (Meta's 0). */
  spendCapCents: number | null
  balanceCents: number | null
  settingsReadAt: string | null
  lastReadAt: string | null
  lastSyncStatus: string | null
  lastSyncError: string | null
}

export interface MetaAdsOverview {
  connections: MetaConnection[]
  connection: MetaConnection | null
  account: MetaAdsAccountSummary | null
  window: MetaAdsWindow
  currency: string | null
  timeZone: string | null
  dataAsOf: string | null
  coverage: MetaAdsCoverage
  totals: MetaAdsMetrics | null
  previous: (MetaAdsMetrics & { from: string; to: string }) | null
  days: MetaAdsDay[]
}

function accountSummary(ctx: MetaAdsAccountContext): MetaAdsAccountSummary | null {
  if (!ctx.adAccountId) return null
  const a = ctx.account
  const spendCap = a?.spendCapMicros ?? null
  return {
    adAccountId: ctx.adAccountId,
    name: a?.name ?? ctx.connection?.adAccount?.name ?? null,
    statusText: a?.accountStatus == null ? null : AD_ACCOUNT_STATUS_WORDS[a.accountStatus] ?? `Status ${a.accountStatus}`,
    accountStatus: a?.accountStatus ?? null,
    disableReason: a?.disableReason ?? null,
    amountSpentCents: minorOf(a?.amountSpentMicros, ctx.currency),
    spendCapCents: spendCap === null || spendCap === 0n ? null : minorOf(spendCap, ctx.currency),
    balanceCents: minorOf(a?.balanceMicros, ctx.currency),
    settingsReadAt: iso(a?.settingsReadAt),
    lastReadAt: iso(a?.lastSyncAt),
    lastSyncStatus: a?.lastSyncStatus ?? null,
    lastSyncError: a?.lastSyncError ?? null,
  }
}

export async function metaAdsOverview(input: { connectionId?: string | null } & WindowInput, now: Date = new Date()): Promise<MetaAdsOverview> {
  const ctx = await metaAdsAccount(input.connectionId)
  const window = resolveWindow(input, ctx.timeZone, !!ctx.adAccountId, now)
  // Review B1 — the account's own days (level=account): every child included, archived and deleted ones too, and Meta's
  // own daily reach — never a sum of campaigns, which leaves out the objects Meta drops and counts a person twice.
  const r = await readRangeOf(ctx, 'ACCOUNT')
  const inWindow = overlap(window, r)
  const exponent = currencyExponent(ctx.currency)
  const coverage = coverageOf(window, r)
  const sums = ctx.adAccountId && inWindow ? await sumsByDay(ctx.adAccountId, 'ACCOUNT', inWindow) : new Map<string, { sums: Sums; reach: number | null }>()
  const length = dayCount(window)
  const before = { from: addDays(window.from, -length), to: addDays(window.from, -1) }
  const bothRead = coverage.daysRead === coverage.daysInWindow && !!r && before.from >= r.from && before.to <= r.to
  const previous = ctx.adAccountId && bothRead ? { from: before.from, to: before.to, ...metricsOf(await sumOver(ctx.adAccountId, 'ACCOUNT', before), exponent) } : null
  const total = [...sums.values()].map((d) => d.sums).reduce(addSums, ZERO)
  return {
    connections: ctx.connections,
    connection: ctx.connection,
    account: accountSummary(ctx),
    window,
    currency: ctx.currency,
    timeZone: ctx.timeZone,
    dataAsOf: iso(ctx.account?.lastSuccessAt),
    coverage,
    totals: coverage.daysRead > 0 ? metricsOf(total, exponent) : null,
    previous,
    days: daySeries(window, r, sums, exponent),
  }
}

// ── campaigns, ad sets, ads ──────────────────────────────────────────────────────────────────────────────────────

export interface MetaAdsCampaignRow {
  /** Nexus's id (what the days read takes). */
  campaignId: string
  /** Meta's campaign id. */
  metaCampaignId: string
  name: string
  /** ACTIVE | PAUSED | ARCHIVED | DELETED (gone from Meta's answer: removed); null = numbers but never read. */
  status: string | null
  effectiveStatus: string | null
  objective: string | null
  bidStrategy: string | null
  /** The campaign budget (Advantage+ campaign budget); null = budgets on the ad sets. */
  dailyBudgetCents: number | null
  lifetimeBudgetCents: number | null
  startTime: string | null
  stopTime: string | null
  settingsReadAt: string | null
  metrics: MetaAdsMetrics | null
}

function campaignOf(row: MetaAdsCampaign, currency: string | null, metrics: MetaAdsMetrics | null): MetaAdsCampaignRow {
  return {
    campaignId: row.id,
    metaCampaignId: row.campaignId,
    name: row.name,
    status: row.removedAt ? 'DELETED' : row.status,
    effectiveStatus: row.removedAt ? null : row.effectiveStatus,
    objective: row.objective,
    bidStrategy: row.bidStrategy,
    dailyBudgetCents: minorOf(row.dailyBudgetMicros, currency),
    lifetimeBudgetCents: minorOf(row.lifetimeBudgetMicros, currency),
    startTime: iso(row.startTime),
    stopTime: iso(row.stopTime),
    settingsReadAt: row.lastSeenAt.toISOString(),
    metrics,
  }
}

export interface MetaAdsPage<T> {
  window: MetaAdsWindow
  currency: string | null
  dataAsOf: string | null
  coverage: MetaAdsCoverage
  items: T[]
  nextCursor: string | null
  total: number
}

function page<T extends { name: string }>(kind: string, items: T[], idOf: (t: T) => string, input: { limit?: unknown; cursor?: string | null }, scope: Record<string, unknown>) {
  const asked = Math.trunc(Number(input.limit))
  const size = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_PAGE, asked) : DEFAULT_PAGE
  const cursor = cursorScope(kind, { business: workspaceIdForQuery(), ...scope })
  const at = decodeCursor(cursor, input.cursor ?? null)
  const rest = at ? items.filter((t) => t.name > String(at.values[0] ?? '') || (t.name === String(at.values[0] ?? '') && idOf(t) > at.id)) : items
  const shown = rest.slice(0, size)
  const last = shown.at(-1)
  return { items: shown, nextCursor: rest.length > size && last ? encodeCursor(cursor, { values: [last.name], id: idOf(last) }) : null, total: items.length }
}

const byName = <T extends { name: string }>(idOf: (t: T) => string) => (a: T, b: T) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (idOf(a) < idOf(b) ? -1 : 1)

/** Every campaign of the chosen account with its numbers over the window (by name), one page. */
export async function metaAdsCampaigns(input: { connectionId?: string | null; status?: string | null; search?: string | null; limit?: unknown; cursor?: string | null } & WindowInput, now: Date = new Date()): Promise<MetaAdsPage<MetaAdsCampaignRow>> {
  const ctx = await metaAdsAccount(input.connectionId)
  const window = resolveWindow(input, ctx.timeZone, !!ctx.adAccountId, now)
  const r = await readRangeOf(ctx, 'CAMPAIGN')
  const coverage = coverageOf(window, r)
  if (!ctx.adAccountId) return { window, currency: ctx.currency, dataAsOf: null, coverage, items: [], nextCursor: null, total: 0 }
  const inWindow = overlap(window, r)
  const exponent = currencyExponent(ctx.currency)
  const [rows, sums] = await Promise.all([
    prisma.metaAdsCampaign.findMany({ where: { adAccountId: ctx.adAccountId } }),
    inWindow ? sumsByEntity(ctx.adAccountId, 'CAMPAIGN', inWindow) : Promise.resolve(new Map<string, Sums>()),
  ])
  const status = typeof input.status === 'string' && input.status.trim() ? input.status.trim().toUpperCase() : null
  const needle = typeof input.search === 'string' && input.search.trim() ? input.search.trim().toLowerCase() : null
  const items = rows
    .map((row) => campaignOf(row, ctx.currency, coverage.daysRead > 0 ? metricsOf(sums.get(row.campaignId) ?? ZERO, exponent) : null))
    .filter((c) => !status || c.status === status || c.effectiveStatus === status)
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))
    .sort(byName((c: MetaAdsCampaignRow) => c.campaignId))
  const shown = page('meta-ads-campaigns', items, (c) => c.campaignId, input, { account: ctx.adAccountId, from: window.from, to: window.to, status, search: needle })
  return { window, currency: ctx.currency, dataAsOf: iso(ctx.account?.lastSuccessAt), coverage, ...shown }
}

export interface MetaAdsCampaignDays {
  campaign: MetaAdsCampaignRow
  currency: string | null
  window: MetaAdsWindow
  coverage: MetaAdsCoverage
  days: MetaAdsDay[]
}

/** One campaign's days in the window (its account's days, read or not). */
export async function metaCampaignDays(campaignId: string, input: WindowInput, now: Date = new Date()): Promise<MetaAdsCampaignDays> {
  const row = typeof campaignId === 'string' && campaignId.length <= 64 ? await prisma.metaAdsCampaign.findFirst({ where: { id: campaignId } }) : null
  if (!row) throw new MetaAdsReadError(404, 'Campaign not found')
  const ctx = await metaAdsAccount(null)
  if (ctx.adAccountId !== row.adAccountId) throw new MetaAdsReadError(404, 'Campaign not found')
  const window = resolveWindow(input, ctx.timeZone, true, now)
  const r = await readRangeOf(ctx, 'CAMPAIGN')
  const inWindow = overlap(window, r)
  const coverage = coverageOf(window, r)
  const exponent = currencyExponent(ctx.currency)
  const sums = inWindow ? await sumsByDay(row.adAccountId, 'CAMPAIGN', inWindow, { entityId: row.campaignId }) : new Map<string, { sums: Sums; reach: number | null }>()
  const total = [...sums.values()].map((d) => d.sums).reduce(addSums, ZERO)
  return { campaign: campaignOf(row, ctx.currency, coverage.daysRead > 0 ? metricsOf(total, exponent) : null), currency: ctx.currency, window, coverage, days: daySeries(window, r, sums, exponent) }
}

export interface MetaAdsAdSetRow {
  adSetId: string
  metaAdSetId: string
  metaCampaignId: string
  name: string
  status: string
  effectiveStatus: string | null
  optimizationGoal: string | null
  billingEvent: string | null
  bidStrategy: string | null
  bidAmountCents: number | null
  dailyBudgetCents: number | null
  lifetimeBudgetCents: number | null
  startTime: string | null
  endTime: string | null
  metrics: MetaAdsMetrics | null
}

function adSetOf(row: MetaAdsAdSet, currency: string | null, metrics: MetaAdsMetrics | null): MetaAdsAdSetRow {
  return {
    adSetId: row.id, metaAdSetId: row.adSetId, metaCampaignId: row.campaignId, name: row.name,
    status: row.removedAt ? 'DELETED' : row.status, effectiveStatus: row.removedAt ? null : row.effectiveStatus,
    optimizationGoal: row.optimizationGoal, billingEvent: row.billingEvent, bidStrategy: row.bidStrategy,
    bidAmountCents: minorOf(row.bidAmountMicros, currency), dailyBudgetCents: minorOf(row.dailyBudgetMicros, currency),
    lifetimeBudgetCents: minorOf(row.lifetimeBudgetMicros, currency), startTime: iso(row.startTime), endTime: iso(row.endTime), metrics,
  }
}

/** The ad sets of the chosen account (of one Meta campaign when named), with their numbers. */
export async function metaAdsAdSets(input: { connectionId?: string | null; metaCampaignId?: string | null; limit?: unknown; cursor?: string | null } & WindowInput, now: Date = new Date()): Promise<MetaAdsPage<MetaAdsAdSetRow>> {
  const ctx = await metaAdsAccount(input.connectionId)
  const window = resolveWindow(input, ctx.timeZone, !!ctx.adAccountId, now)
  const r = await readRangeOf(ctx, 'ADSET')
  const coverage = coverageOf(window, r)
  if (!ctx.adAccountId) return { window, currency: ctx.currency, dataAsOf: null, coverage, items: [], nextCursor: null, total: 0 }
  const inWindow = overlap(window, r)
  const exponent = currencyExponent(ctx.currency)
  const campaign = input.metaCampaignId ? String(input.metaCampaignId) : null
  const [rows, sums] = await Promise.all([
    prisma.metaAdsAdSet.findMany({ where: { adAccountId: ctx.adAccountId, ...(campaign ? { campaignId: campaign } : {}) } }),
    inWindow ? sumsByEntity(ctx.adAccountId, 'ADSET', inWindow, campaign ? { campaignId: campaign } : {}) : Promise.resolve(new Map<string, Sums>()),
  ])
  const items = rows.map((row) => adSetOf(row, ctx.currency, coverage.daysRead > 0 ? metricsOf(sums.get(row.adSetId) ?? ZERO, exponent) : null)).sort(byName((a: MetaAdsAdSetRow) => a.adSetId))
  return { window, currency: ctx.currency, dataAsOf: iso(ctx.account?.lastSuccessAt), coverage, ...page('meta-ads-adsets', items, (a) => a.adSetId, input, { account: ctx.adAccountId, campaign, from: window.from, to: window.to }) }
}

export interface MetaAdsAdRow {
  adId: string
  metaAdId: string
  metaAdSetId: string
  metaCampaignId: string
  name: string
  status: string
  effectiveStatus: string | null
  creative: { name: string | null; title: string | null; body: string | null; objectType: string | null; thumbnailUrl: string | null } | null
  issues: unknown
  metrics: MetaAdsMetrics | null
}

function adOf(row: MetaAdsAd, metrics: MetaAdsMetrics | null): MetaAdsAdRow {
  const creative = row.creative as MetaAdsAdRow['creative'] | null
  return {
    adId: row.id, metaAdId: row.adId, metaAdSetId: row.adSetId, metaCampaignId: row.campaignId, name: row.name,
    status: row.removedAt ? 'DELETED' : row.status, effectiveStatus: row.removedAt ? null : row.effectiveStatus,
    creative: creative ?? null, issues: row.issues ?? null, metrics,
  }
}

/** The ads of the chosen account (of one Meta ad set when named), with their numbers. */
export async function metaAdsAds(input: { connectionId?: string | null; metaAdSetId?: string | null; limit?: unknown; cursor?: string | null } & WindowInput, now: Date = new Date()): Promise<MetaAdsPage<MetaAdsAdRow>> {
  const ctx = await metaAdsAccount(input.connectionId)
  const window = resolveWindow(input, ctx.timeZone, !!ctx.adAccountId, now)
  const r = await readRangeOf(ctx, 'AD')
  const coverage = coverageOf(window, r)
  if (!ctx.adAccountId) return { window, currency: ctx.currency, dataAsOf: null, coverage, items: [], nextCursor: null, total: 0 }
  const inWindow = overlap(window, r)
  const exponent = currencyExponent(ctx.currency)
  const adSet = input.metaAdSetId ? String(input.metaAdSetId) : null
  const [rows, sums] = await Promise.all([
    prisma.metaAdsAd.findMany({ where: { adAccountId: ctx.adAccountId, ...(adSet ? { adSetId: adSet } : {}) } }),
    inWindow ? sumsByEntity(ctx.adAccountId, 'AD', inWindow, adSet ? { adSetId: adSet } : {}) : Promise.resolve(new Map<string, Sums>()),
  ])
  const items = rows.map((row) => adOf(row, coverage.daysRead > 0 ? metricsOf(sums.get(row.adId) ?? ZERO, exponent) : null)).sort(byName((a: MetaAdsAdRow) => a.adId))
  return { window, currency: ctx.currency, dataAsOf: iso(ctx.account?.lastSuccessAt), coverage, ...page('meta-ads-ads', items, (a) => a.adId, input, { account: ctx.adAccountId, adSet, from: window.from, to: window.to }) }
}

// ── read now ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Ask for a read of the chosen ad account now (the read queue allows one an hour per account). */
export async function requestMetaAdsRead(input: { connectionId?: string | null }): Promise<{ queued: boolean; reason: string | null }> {
  const ctx = await metaAdsAccount(input.connectionId)
  if (!ctx.connection) return { queued: false, reason: 'Meta is not connected for this business.' }
  if (!ctx.adAccountId) return { queued: false, reason: 'No Meta ad account is chosen yet. Choose one in Settings › Channels › Meta.' }
  const answer = await enqueueMetaAdsSync({ adAccountId: ctx.adAccountId, kind: 'MANUAL' })
  return { queued: answer.queued === true, reason: answer.reason ?? null }
}
