/**
 * Google Ads step 1a — the reads behind the Google Ads tab (R1–R4), its "Read now" (S), and Claude's `ads-overview` /
 * `ad-campaigns` with channel google (PLAN.md "API contract", plan-3 §4). Read only: every answer comes from the
 * GoogleAds* tables the daily read fills. Nothing here calls Google; S only asks the read queue for a run.
 *
 * The rules each answer keeps:
 *   - a day counts as zero only when Nexus read it: inside the account's [metricsReadFrom, metricsReadThrough]. Any
 *     other day is `read: false` with no numbers — never a 0, never part of a total
 *   - money is in MINOR units of the account's own currency (its ISO 4217 exponent: EUR 2, JPY 0, KWD 3), never
 *     converted; Google's micros are summed first and turned into minor units once
 *   - ratios are Nexus's, computed from the sums, null when the denominator is 0
 *   - `to` is clamped to the account's yesterday in its time zone (today is still moving); `provisionalFrom` is the
 *     first day of the daily re-read (the last 14 days, which Google can still restate with late conversions)
 *   - `previous` (the window of the same length right before) only when Nexus read every day of it
 *   - Google's change history keeps the person who made a change (user_email): it is never selected here
 *
 * A campaign Google removed before Nexus first read the account has numbers but no settings row (the settings read
 * skips removed campaigns). It is still listed — its spend is part of the account's totals — under the id
 * `<customerId>~<googleCampaignId>`, which R3 and R4 take like any other. Its status is REMOVED only when a settings
 * read succeeded after its last day with numbers ended (it existed then, and that read did not return it). A campaign
 * added after the last settings read that succeeded (or while one failed) has numbers and no row too: its status is
 * null — not read yet — never REMOVED.
 */
import prisma from '../../../db.js'
import { workspaceIdForQuery } from '../../../lib/workspace-context.js'
import { cursorScope, decodeCursor, encodeCursor, type CursorPosition } from '../../../lib/pagination/cursor.js'
import { listGoogleAccounts } from '../../google/google-accounts.service.js'
import { CHANGE_HISTORY_DAYS, DAILY_WINDOW_DAYS, accountYesterday, addDays, dateToDay, dayCount, dayToDate, daysOf, zonedToUtc, type DayWindow } from './dates.js'
import { enqueueGoogleAdsSync } from './enqueue.js'
import { campaignTypeText, changeSourceOf, customerIdDigits } from './mappers.js'

/** One Google sign-in of the business as the connection routes describe it (C1). */
export type GoogleAccount = Awaited<ReturnType<typeof listGoogleAccounts>>[number]

/** A refusal a route answers with its status and sentence. */
export class GoogleAdsReadError extends Error {
  constructor(readonly status: 400 | 404, message: string) {
    super(message)
    this.name = 'GoogleAdsReadError'
  }
}

export const DEFAULT_WINDOW_DAYS = 30
/** The longest window one read answers (two years and a bit; the first read reaches 400 days back). */
export const MAX_WINDOW_DAYS = 800
export const DEFAULT_CAMPAIGN_PAGE = 100
export const MAX_CAMPAIGN_PAGE = 500
/** The most change-history rows one campaign's R4 answer carries. */
export const MAX_CHANGES = 500
export const CAMPAIGN_STATUSES = ['ENABLED', 'PAUSED', 'REMOVED'] as const

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const MS_PER_DAY = 86_400_000
const iso = (at: Date | null | undefined) => (at ? at.toISOString() : null)

// ── Money ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The currency's own number of decimals (ISO 4217, as Intl knows it — the web uses the same rule): EUR 2, JPY 0. */
export function currencyExponent(currency: string | null | undefined): number {
  if (!currency) return 2
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
  } catch {
    return 2
  }
}

/** Micros of a currency → its minor units, rounded half away from zero: 12,345,000 EUR micros → 1235 cents. */
export function microsToMinor(micros: bigint, exponent: number): number {
  const per = 10n ** BigInt(Math.max(0, 6 - exponent))
  const half = per / 2n
  return Number(micros >= 0n ? (micros + half) / per : -((-micros + half) / per))
}

// ── Sums and metrics ───────────────────────────────────────────────────────────────────────────────────────────────

interface Sums {
  impressions: number
  clicks: number
  costMicros: bigint
  /** Conversions in ten-thousandths (the column is Decimal(14,4)), so sums never drift. */
  conversions4: bigint
  valueMicros: bigint
}
const ZERO: Sums = { impressions: 0, clicks: 0, costMicros: 0n, conversions4: 0n, valueMicros: 0n }

const SUM_FIELDS = { impressions: true, clicks: true, costMicros: true, conversions: true, conversionsValueMicros: true } as const

interface SumRow {
  impressions: number | null
  clicks: number | null
  costMicros: bigint | null
  conversions: unknown
  conversionsValueMicros: bigint | null
}

function toSums(row: SumRow | null | undefined): Sums {
  if (!row) return ZERO
  const conversions = Number(row.conversions == null ? 0 : String(row.conversions))
  return {
    impressions: row.impressions ?? 0,
    clicks: row.clicks ?? 0,
    costMicros: row.costMicros ?? 0n,
    conversions4: BigInt(Math.round((Number.isFinite(conversions) ? conversions : 0) * 10_000)),
    valueMicros: row.conversionsValueMicros ?? 0n,
  }
}

function addSums(a: Sums, b: Sums): Sums {
  return {
    impressions: a.impressions + b.impressions,
    clicks: a.clicks + b.clicks,
    costMicros: a.costMicros + b.costMicros,
    conversions4: a.conversions4 + b.conversions4,
    valueMicros: a.valueMicros + b.valueMicros,
  }
}

/** The numbers of one window, day or campaign. Money in minor units; ratios from the sums, null over a zero. */
export interface GoogleAdsMetrics {
  impressions: number
  clicks: number
  spendCents: number
  /** Google's conversions: fractional under data-driven attribution. */
  conversions: number
  conversionValueCents: number
  ctr: number | null
  avgCpcCents: number | null
  roas: number | null
  costPerConversionCents: number | null
}

function metricsOf(s: Sums, exponent: number): GoogleAdsMetrics {
  const microsPerMinor = 10 ** Math.max(0, 6 - exponent)
  const cost = Number(s.costMicros)
  const conversions = Number(s.conversions4) / 10_000
  return {
    impressions: s.impressions,
    clicks: s.clicks,
    spendCents: microsToMinor(s.costMicros, exponent),
    conversions,
    conversionValueCents: microsToMinor(s.valueMicros, exponent),
    ctr: s.impressions > 0 ? s.clicks / s.impressions : null,
    avgCpcCents: s.clicks > 0 ? Math.round(cost / s.clicks / microsPerMinor) : null,
    roas: cost > 0 ? Number(s.valueMicros) / cost : null,
    costPerConversionCents: s.conversions4 > 0n ? Math.round(cost / conversions / microsPerMinor) : null,
  }
}

const UNREAD = {
  impressions: null, clicks: null, spendCents: null, conversions: null, conversionValueCents: null,
  ctr: null, avgCpcCents: null, roas: null, costPerConversionCents: null,
} as const

/** One day. Not read → no numbers at all (never 0). */
export type GoogleAdsDay =
  | ({ date: string; provisional: boolean; read: true } & GoogleAdsMetrics)
  | ({ date: string; provisional: boolean; read: false } & typeof UNREAD)

// ── The account ────────────────────────────────────────────────────────────────────────────────────────────────────

const CUSTOMER_SELECT = {
  customerId: true, connectionId: true, descriptiveName: true, currencyCode: true, timeZone: true,
  metricsReadFrom: true, metricsReadThrough: true, lastSuccessAt: true, changesSyncedThrough: true, structureSyncedAt: true,
} as const

interface CustomerRow {
  customerId: string
  connectionId: string
  descriptiveName: string | null
  currencyCode: string
  timeZone: string
  metricsReadFrom: Date | null
  metricsReadThrough: Date | null
  lastSuccessAt: Date | null
  changesSyncedThrough: Date | null
  structureSyncedAt: Date | null
}

const customerOf = (customerId: string): Promise<CustomerRow | null> =>
  prisma.googleAdsCustomer.findFirst({ where: { customerId }, select: CUSTOMER_SELECT })

/** The account a read is about, with what Nexus holds of it. */
export interface GoogleAdsAccountContext {
  accounts: GoogleAccount[]
  account: GoogleAccount | null
  /** The Google Ads account the read is about (digits), when one is chosen. */
  customerId: string | null
  customer: CustomerRow | null
  currency: string | null
  timeZone: string | null
}

/**
 * The business's Google sign-ins and the one asked for (`connectionId`), else the first with a Google Ads account
 * chosen, else the first. A connection id the business does not hold is "not found".
 */
export async function googleAdsAccount(connectionId?: string | null): Promise<GoogleAdsAccountContext> {
  const accounts = await listGoogleAccounts()
  const wanted = typeof connectionId === 'string' && connectionId.trim() ? connectionId.trim() : null
  const account = wanted
    ? (accounts.find((a) => a.connectionId === wanted) ?? null)
    : (accounts.find((a) => a.ads) ?? accounts[0] ?? null)
  if (wanted && !account) throw new GoogleAdsReadError(404, 'Google account not found')
  const customerId = account?.ads ? customerIdDigits(account.ads.customerId) : null
  const customer = customerId ? await customerOf(customerId) : null
  return {
    accounts,
    account,
    customerId,
    customer,
    currency: customer?.currencyCode || account?.ads?.currency || null,
    timeZone: customer?.timeZone || account?.ads?.timeZone || null,
  }
}

// ── Windows and coverage ───────────────────────────────────────────────────────────────────────────────────────────

export interface WindowInput {
  from?: string | null
  to?: string | null
  /** When `from` is absent: the last N days ending `to` (default 30). */
  days?: number | null
}

export interface GoogleAdsWindow {
  from: string
  to: string
  provisionalFrom: string | null
}

export interface GoogleAdsCoverage {
  daysInWindow: number
  daysRead: number
  missingDays: string[]
}

function askedDay(value: unknown, name: string): string | null {
  if (value == null || value === '') return null
  const day = String(value).trim()
  if (!DAY_RE.test(day) || dateToDay(dayToDate(day)) !== day) throw new GoogleAdsReadError(400, `${name} must be a day written YYYY-MM-DD.`)
  return day
}

function yesterdayIn(timeZone: string | null, now: Date): string {
  if (timeZone) {
    try {
      return accountYesterday(timeZone, now)
    } catch {
      // An unknown zone: fall back to UTC rather than fail the read.
    }
  }
  return accountYesterday('UTC', now)
}

/**
 * The window a read answers: `to` at most the account's yesterday, `from` at most `to`, at most MAX_WINDOW_DAYS long.
 * `live` = an account is chosen, so the last days are still re-read (provisionalFrom); otherwise there is none.
 */
export function resolveWindow(input: WindowInput, timeZone: string | null, live: boolean, now: Date = new Date()): GoogleAdsWindow {
  const yesterday = yesterdayIn(timeZone, now)
  const askedTo = askedDay(input.to, 'to')
  const askedFrom = askedDay(input.from, 'from')
  const to = askedTo && askedTo < yesterday ? askedTo : yesterday
  const length = Math.min(MAX_WINDOW_DAYS, Math.max(1, Math.trunc(Number(input.days)) || DEFAULT_WINDOW_DAYS))
  let from = askedFrom ?? addDays(to, -(length - 1))
  if (from > to) from = to
  if (dayCount({ from, to }) > MAX_WINDOW_DAYS) from = addDays(to, -(MAX_WINDOW_DAYS - 1))
  const rereadFrom = addDays(yesterday, -(DAILY_WINDOW_DAYS - 1))
  const provisionalFrom = live && rereadFrom <= to ? (rereadFrom > from ? rereadFrom : from) : null
  return { from, to, provisionalFrom }
}

/** The contiguous days Nexus read for the account, or null when it read none. */
function readRangeOf(customer: CustomerRow | null): DayWindow | null {
  if (!customer?.metricsReadFrom || !customer.metricsReadThrough) return null
  const from = dateToDay(customer.metricsReadFrom)
  const to = dateToDay(customer.metricsReadThrough)
  return from <= to ? { from, to } : null
}

function overlap(window: DayWindow, range: DayWindow | null): DayWindow | null {
  if (!range) return null
  const from = window.from > range.from ? window.from : range.from
  const to = window.to < range.to ? window.to : range.to
  return from <= to ? { from, to } : null
}

const isRead = (day: string, range: DayWindow | null) => !!range && day >= range.from && day <= range.to

function coverageOf(window: DayWindow, range: DayWindow | null): GoogleAdsCoverage {
  const days = daysOf(window)
  const missingDays = days.filter((day) => !isRead(day, range))
  return { daysInWindow: days.length, daysRead: days.length - missingDays.length, missingDays }
}

// ── The numbers ────────────────────────────────────────────────────────────────────────────────────────────────────

function metricWhere(customerId: string, range: DayWindow, campaignId?: string) {
  return {
    customerId,
    entityType: 'CAMPAIGN',
    ...(campaignId ? { campaignId } : {}),
    date: { gte: dayToDate(range.from), lte: dayToDate(range.to) },
  }
}

async function sumsByDay(customerId: string, range: DayWindow, campaignId?: string): Promise<Map<string, Sums>> {
  const rows = await prisma.googleAdsDailyMetric.groupBy({ by: ['date'], where: metricWhere(customerId, range, campaignId), _sum: SUM_FIELDS })
  return new Map(rows.map((row) => [dateToDay(row.date), toSums(row._sum)]))
}

async function sumsByCampaign(customerId: string, range: DayWindow): Promise<Map<string, Sums>> {
  const rows = await prisma.googleAdsDailyMetric.groupBy({ by: ['campaignId'], where: metricWhere(customerId, range), _sum: SUM_FIELDS })
  return new Map(rows.map((row) => [row.campaignId, toSums(row._sum)]))
}

async function sumOver(customerId: string, range: DayWindow): Promise<Sums> {
  const row = await prisma.googleAdsDailyMetric.aggregate({ where: metricWhere(customerId, range), _sum: SUM_FIELDS })
  return toSums(row._sum)
}

const total = (sums: Iterable<Sums>) => [...sums].reduce(addSums, ZERO)

function daySeries(window: GoogleAdsWindow, range: DayWindow | null, sums: Map<string, Sums>, exponent: number): GoogleAdsDay[] {
  return daysOf(window).map((date): GoogleAdsDay => {
    const provisional = window.provisionalFrom != null && date >= window.provisionalFrom
    return isRead(date, range)
      ? { date, provisional, read: true, ...metricsOf(sums.get(date) ?? ZERO, exponent) }
      : { date, provisional, read: false, ...UNREAD }
  })
}

// ── R1 — the account overview ──────────────────────────────────────────────────────────────────────────────────────

export interface GoogleAdsOverview {
  accounts: GoogleAccount[]
  account: GoogleAccount | null
  window: GoogleAdsWindow
  currency: string | null
  timeZone: string | null
  /** When Nexus last read the account from Google with success. */
  dataAsOf: string | null
  coverage: GoogleAdsCoverage
  totals: GoogleAdsMetrics | null
  previous: (GoogleAdsMetrics & { from: string; to: string }) | null
  days: GoogleAdsDay[]
}

export async function googleAdsOverview(input: { connectionId?: string | null } & WindowInput, now: Date = new Date()): Promise<GoogleAdsOverview> {
  const ctx = await googleAdsAccount(input.connectionId)
  const window = resolveWindow(input, ctx.timeZone, !!ctx.customerId, now)
  const range = readRangeOf(ctx.customer)
  const inWindow = overlap(window, range)
  const exponent = currencyExponent(ctx.currency)
  const coverage = coverageOf(window, range)
  const sums = ctx.customer && inWindow ? await sumsByDay(ctx.customer.customerId, inWindow) : new Map<string, Sums>()

  // The window before, of the same length — compared only when Nexus read every day of it.
  const length = dayCount(window)
  const before = { from: addDays(window.from, -length), to: addDays(window.from, -1) }
  const previous = ctx.customer && range && before.from >= range.from && before.to <= range.to
    ? { from: before.from, to: before.to, ...metricsOf(await sumOver(ctx.customer.customerId, before), exponent) }
    : null

  return {
    accounts: ctx.accounts,
    account: ctx.account,
    window,
    currency: ctx.currency,
    timeZone: ctx.timeZone,
    dataAsOf: iso(ctx.customer?.lastSuccessAt),
    coverage,
    totals: coverage.daysRead > 0 ? metricsOf(total(sums.values()), exponent) : null,
    previous,
    days: daySeries(window, range, sums, exponent),
  }
}

// ── R2 — the campaigns ─────────────────────────────────────────────────────────────────────────────────────────────

const CAMPAIGN_SELECT = {
  id: true, customerId: true, campaignId: true, name: true, status: true, servingStatus: true, primaryStatus: true,
  channelType: true, biddingStrategyType: true, budgetAmountMicros: true, budgetShared: true, startDate: true, endDate: true,
  currencyCode: true, lastSeenAt: true, removedAt: true,
} as const

interface CampaignRow {
  id: string
  customerId: string
  campaignId: string
  name: string
  status: string
  servingStatus: string | null
  primaryStatus: string | null
  channelType: string
  biddingStrategyType: string | null
  budgetAmountMicros: bigint | null
  budgetShared: boolean
  startDate: Date | null
  endDate: Date | null
  currencyCode: string
  lastSeenAt: Date
  removedAt: Date | null
}

export interface GoogleAdsCampaign {
  /** Nexus's id (what R3 and R4 take). */
  campaignId: string
  /** Google's campaign id. */
  externalCampaignId: string
  name: string
  /**
   * ENABLED | PAUSED | REMOVED (removed at Google, or no longer returned by a full read); null when Nexus has the
   * campaign's numbers but has not read its settings yet (added after the last settings read that succeeded).
   */
  status: string | null
  servingStatus: string | null
  primaryStatus: string | null
  /** Google's advertising_channel_type (SEARCH, PERFORMANCE_MAX, SHOPPING, …; UNKNOWN when Nexus never read it). */
  type: string
  biddingStrategy: string | null
  dailyBudgetCents: number | null
  budgetShared: boolean
  startDate: string | null
  endDate: string | null
  /** When a read last saw this campaign's settings. */
  settingsReadAt: string
  /** Null when Nexus read no day of the window. */
  metrics: GoogleAdsMetrics | null
}

/** The id of a campaign that has numbers but no settings row (removed before Nexus first read the account). */
const unseenId = (customerId: string, googleCampaignId: string) => `${customerId}~${googleCampaignId}`
const UNSEEN_ID = /^(\d{1,20})~(\d{1,20})$/

function campaignOf(row: CampaignRow, exponent: number, metrics: GoogleAdsMetrics | null): GoogleAdsCampaign {
  return {
    campaignId: row.id,
    externalCampaignId: row.campaignId,
    name: row.name,
    status: row.removedAt ? 'REMOVED' : row.status,
    servingStatus: row.servingStatus,
    primaryStatus: row.primaryStatus,
    type: row.channelType,
    biddingStrategy: row.biddingStrategyType,
    dailyBudgetCents: row.budgetAmountMicros == null ? null : microsToMinor(row.budgetAmountMicros, exponent),
    budgetShared: row.budgetShared,
    startDate: row.startDate ? dateToDay(row.startDate) : null,
    endDate: row.endDate ? dateToDay(row.endDate) : null,
    settingsReadAt: row.lastSeenAt.toISOString(),
    metrics,
  }
}

/** When the account's day ends (its time zone); unknown zone: the latest any day ends anywhere (UTC−12). */
function endOfAccountDay(day: string, timeZone: string | null | undefined): Date {
  const next = addDays(day, 1)
  if (timeZone) {
    try { return zonedToUtc(next, timeZone) } catch { /* below */ }
  }
  return new Date(dayToDate(next).getTime() + 12 * 3_600_000)
}

/**
 * Whether Nexus knows that a campaign with numbers but no settings row is removed: a settings read that succeeded
 * after its last day with numbers ended did not return it (the campaign existed on that day; the settings read skips
 * removed campaigns). False when no such read happened yet: a campaign added since is not known, not removed.
 */
export function removedSinceItsNumbers(structureSyncedAt: Date | null, lastDayWithNumbers: string | null | undefined, timeZone: string | null | undefined): boolean {
  if (!structureSyncedAt || !lastDayWithNumbers) return false
  return structureSyncedAt.getTime() >= endOfAccountDay(lastDayWithNumbers, timeZone).getTime()
}

function unseenCampaignOf(
  customer: { customerId: string; structureSyncedAt: Date | null; timeZone?: string | null },
  googleCampaignId: string,
  seen: { label: string | null; pulledAt: Date; lastDay: string } | undefined,
  metrics: GoogleAdsMetrics | null,
): GoogleAdsCampaign {
  return {
    campaignId: unseenId(customer.customerId, googleCampaignId),
    externalCampaignId: googleCampaignId,
    name: seen?.label?.trim() || `Campaign ${googleCampaignId}`,
    status: removedSinceItsNumbers(customer.structureSyncedAt, seen?.lastDay, customer.timeZone) ? 'REMOVED' : null,
    servingStatus: null,
    primaryStatus: null,
    type: 'UNKNOWN',
    biddingStrategy: null,
    dailyBudgetCents: null,
    budgetShared: false,
    startDate: null,
    endDate: null,
    settingsReadAt: (customer.structureSyncedAt ?? seen?.pulledAt ?? new Date(0)).toISOString(),
    metrics,
  }
}

/** The newest name Google gave each campaign in its numbers, and its last day with numbers (the campaigns that have no settings row). */
async function namesInNumbers(customerId: string, googleCampaignIds: string[]): Promise<Map<string, { label: string | null; pulledAt: Date; lastDay: string }>> {
  if (!googleCampaignIds.length) return new Map()
  const rows = await prisma.googleAdsDailyMetric.findMany({
    where: { customerId, entityType: 'CAMPAIGN', campaignId: { in: googleCampaignIds } },
    select: { campaignId: true, label: true, pulledAt: true, date: true },
    orderBy: [{ campaignId: 'asc' }, { date: 'desc' }],
    distinct: ['campaignId'],
  })
  return new Map(rows.map((row) => [row.campaignId, { label: row.label, pulledAt: row.pulledAt, lastDay: dateToDay(row.date) }]))
}

export interface CampaignFilters {
  status?: string | null
  type?: string | null
  search?: string | null
}

function statusFilter(value: unknown): string | null {
  if (value == null || value === '') return null
  const status = String(value).trim().toUpperCase()
  if (!(CAMPAIGN_STATUSES as readonly string[]).includes(status)) throw new GoogleAdsReadError(400, 'status must be ENABLED, PAUSED or REMOVED.')
  return status
}

const compareCampaigns = (a: GoogleAdsCampaign, b: GoogleAdsCampaign) =>
  (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) || (a.campaignId < b.campaignId ? -1 : a.campaignId > b.campaignId ? 1 : 0)

export interface GoogleAdsCampaignList {
  context: GoogleAdsAccountContext
  window: GoogleAdsWindow
  coverage: GoogleAdsCoverage
  /** Every campaign that matches, by name (then id). */
  items: GoogleAdsCampaign[]
}

/** Every campaign of the account that matches the filters, with its numbers over the window. */
export async function googleAdsCampaignList(
  input: { connectionId?: string | null } & WindowInput & CampaignFilters,
  now: Date = new Date(),
): Promise<GoogleAdsCampaignList> {
  const status = statusFilter(input.status)
  const type = typeof input.type === 'string' && input.type.trim() ? input.type.trim().toUpperCase() : null
  const needle = typeof input.search === 'string' && input.search.trim() ? input.search.trim().toLowerCase() : null
  const context = await googleAdsAccount(input.connectionId)
  const window = resolveWindow(input, context.timeZone, !!context.customerId, now)
  const range = readRangeOf(context.customer)
  const coverage = coverageOf(window, range)
  const customerId = context.customerId
  if (!customerId) return { context, window, coverage, items: [] }

  const inWindow = overlap(window, range)
  const exponent = currencyExponent(context.currency)
  const [rows, sums] = await Promise.all([
    prisma.googleAdsCampaign.findMany({ where: { customerId }, select: CAMPAIGN_SELECT }) as Promise<CampaignRow[]>,
    inWindow ? sumsByCampaign(customerId, inWindow) : Promise.resolve(new Map<string, Sums>()),
  ])
  const metricsFor = (googleCampaignId: string) => (coverage.daysRead > 0 ? metricsOf(sums.get(googleCampaignId) ?? ZERO, exponent) : null)
  const known = new Set(rows.map((row) => row.campaignId))
  const unseen = [...sums.keys()].filter((id) => !known.has(id))
  const names = await namesInNumbers(customerId, unseen)
  const all = [
    ...rows.map((row) => campaignOf(row, exponent, metricsFor(row.campaignId))),
    ...unseen.map((id) => unseenCampaignOf(context.customer ?? { customerId, structureSyncedAt: null }, id, names.get(id), metricsFor(id))),
  ]
  const items = all
    .filter((c) => !status || c.status === status)
    .filter((c) => !type || c.type === type || (type === 'OTHER' && campaignTypeText(c.type) === 'Other'))
    .filter((c) => !needle || c.name.toLowerCase().includes(needle))
    .sort(compareCampaigns)
  return { context, window, coverage, items }
}

export interface GoogleAdsCampaignsPage {
  window: GoogleAdsWindow
  currency: string | null
  dataAsOf: string | null
  coverage: GoogleAdsCoverage
  items: GoogleAdsCampaign[]
  nextCursor: string | null
  total: number
}

/** R2 — one page of campaigns (by name), `limit` 1…500 (default 100), `cursor` from the page before. */
export async function googleAdsCampaigns(
  input: { connectionId?: string | null } & WindowInput & CampaignFilters & { limit?: number | string | null; cursor?: string | null },
  now: Date = new Date(),
): Promise<GoogleAdsCampaignsPage> {
  const list = await googleAdsCampaignList(input, now)
  const asked = Math.trunc(Number(input.limit))
  const size = Number.isFinite(asked) && asked > 0 ? Math.min(MAX_CAMPAIGN_PAGE, asked) : DEFAULT_CAMPAIGN_PAGE
  const scope = cursorScope('google-ads-campaigns', {
    business: workspaceIdForQuery(),
    account: list.context.account?.connectionId ?? null,
    from: list.window.from,
    to: list.window.to,
    status: input.status ?? null,
    type: input.type ?? null,
    search: input.search ?? null,
  })
  const positionOf = (c: GoogleAdsCampaign): CursorPosition => ({ values: [c.name], id: c.campaignId })
  const at = decodeCursor(scope, input.cursor)
  const rest = at
    ? list.items.filter((c) => {
        const name = String(at.values[0] ?? '')
        return c.name > name || (c.name === name && c.campaignId > at.id)
      })
    : list.items
  const items = rest.slice(0, size)
  const last = items.at(-1)
  return {
    window: list.window,
    currency: list.context.currency,
    dataAsOf: iso(list.context.customer?.lastSuccessAt),
    coverage: list.coverage,
    items,
    nextCursor: rest.length > size && last ? encodeCursor(scope, positionOf(last)) : null,
    total: list.items.length,
  }
}

// ── R3 / R4 — one campaign ─────────────────────────────────────────────────────────────────────────────────────────

interface CampaignRef {
  customerId: string
  googleCampaignId: string
  customer: CustomerRow | null
  row: CampaignRow | null
  seen?: { label: string | null; pulledAt: Date; lastDay: string }
}

/** A campaign of this business by Nexus's id (or the id of a campaign seen only in the numbers); null = not found. */
async function campaignRef(campaignId: string): Promise<CampaignRef | null> {
  const id = typeof campaignId === 'string' ? campaignId.trim() : ''
  if (!id || id.length > 64) return null
  const unseen = UNSEEN_ID.exec(id)
  if (unseen) {
    const [, customerId, googleCampaignId] = unseen
    const [customer, row, names] = await Promise.all([
      customerOf(customerId),
      prisma.googleAdsCampaign.findFirst({ where: { customerId, campaignId: googleCampaignId }, select: CAMPAIGN_SELECT }) as Promise<CampaignRow | null>,
      namesInNumbers(customerId, [googleCampaignId]),
    ])
    const seen = names.get(googleCampaignId)
    if (!customer || (!row && !seen)) return null
    return { customerId, googleCampaignId, customer, row, seen }
  }
  const row = (await prisma.googleAdsCampaign.findFirst({ where: { id }, select: CAMPAIGN_SELECT })) as CampaignRow | null
  if (!row) return null
  return { customerId: row.customerId, googleCampaignId: row.campaignId, customer: await customerOf(row.customerId), row }
}

export interface GoogleAdsCampaignDays {
  campaign: GoogleAdsCampaign
  currency: string | null
  window: GoogleAdsWindow
  coverage: GoogleAdsCoverage
  days: GoogleAdsDay[]
}

/** R3 — one campaign's days in the window (its account's days, read or not). */
export async function googleCampaignDays(campaignId: string, input: WindowInput, now: Date = new Date()): Promise<GoogleAdsCampaignDays> {
  const ref = await campaignRef(campaignId)
  if (!ref) throw new GoogleAdsReadError(404, 'Campaign not found')
  const currency = ref.customer?.currencyCode || ref.row?.currencyCode || null
  const exponent = currencyExponent(currency)
  const window = resolveWindow(input, ref.customer?.timeZone ?? null, !!ref.customer, now)
  const range = readRangeOf(ref.customer)
  const inWindow = overlap(window, range)
  const coverage = coverageOf(window, range)
  const sums = inWindow ? await sumsByDay(ref.customerId, inWindow, ref.googleCampaignId) : new Map<string, Sums>()
  const metrics = coverage.daysRead > 0 ? metricsOf(total(sums.values()), exponent) : null
  const campaign = ref.row
    ? campaignOf(ref.row, exponent, metrics)
    : unseenCampaignOf(ref.customer ?? { customerId: ref.customerId, structureSyncedAt: null }, ref.googleCampaignId, ref.seen, metrics)
  return { campaign, currency, window, coverage, days: daySeries(window, range, sums, exponent) }
}

export type GoogleAdsChangeSourceKey = ReturnType<typeof changeSourceOf>['source']

export interface GoogleAdsChange {
  changedAt: string
  /** Google's change_resource_type: CAMPAIGN, CAMPAIGN_BUDGET, AD_GROUP, … */
  resourceType: string
  /** CREATE | UPDATE | REMOVE */
  operation: string
  /** snake_case paths of the changed fields. */
  changedFields: string[]
  source: GoogleAdsChangeSourceKey
  sourceText: string
  /** What changed, in plain words, and where it was made. Never a person, never an amount. */
  summary: string
}

export interface GoogleAdsCampaignChanges {
  items: GoogleAdsChange[]
  /** Changes are complete from this instant (30 days back), or null when Nexus has not read the change history. */
  coveredFrom: string | null
}

const RESOURCE_WORDS: Readonly<Record<string, string>> = {
  CAMPAIGN: 'Campaign',
  CAMPAIGN_BUDGET: 'Campaign budget',
  CAMPAIGN_CRITERION: 'Campaign targeting',
  AD_GROUP: 'Ad group',
  AD_GROUP_AD: 'Ad',
  AD: 'Ad',
  AD_GROUP_CRITERION: 'Ad group keyword or targeting',
  AD_GROUP_BID_MODIFIER: 'Ad group bid adjustment',
  ASSET_GROUP: 'Asset group',
  CUSTOMER_ASSET: 'Account asset',
}
const OPERATION_WORDS: Readonly<Record<string, string>> = { CREATE: 'added', UPDATE: 'changed', REMOVE: 'removed' }
const MAX_FIELD_WORDS = 5

/** "AD_GROUP_ASSET" → "Ad group asset". */
const sentenceCase = (value: string) => {
  const words = value.toLowerCase().replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Something'
}

/** "campaign_budget.amount_micros" → "amount"; duplicates once. */
function fieldWords(paths: string[]): string[] {
  const words = paths
    .map((path) => (path.split('.').pop() ?? '').replace(/_micros$/, '').replace(/_/g, ' ').trim())
    .filter(Boolean)
  return [...new Set(words)]
}

export function changeSummary(resourceType: string, operation: string, changedFields: string[], sentence: string): string {
  const what = RESOURCE_WORDS[resourceType] ?? sentenceCase(resourceType)
  const verb = OPERATION_WORDS[operation] ?? 'changed'
  const words = operation === 'UPDATE' ? fieldWords(changedFields) : []
  const shown = words.slice(0, MAX_FIELD_WORDS).join(', ')
  const more = words.length > MAX_FIELD_WORDS ? ` and ${words.length - MAX_FIELD_WORDS} more` : ''
  return `${what} ${verb}${shown ? `: ${shown}${more}` : ''}. ${sentence}`
}

/** R4 — Google's change history for one campaign over the last 30 days, newest first. Never a person's e-mail. */
export async function googleCampaignChanges(campaignId: string, now: Date = new Date()): Promise<GoogleAdsCampaignChanges> {
  const ref = await campaignRef(campaignId)
  if (!ref) throw new GoogleAdsReadError(404, 'Campaign not found')
  const since = new Date(now.getTime() - CHANGE_HISTORY_DAYS * MS_PER_DAY)
  const rows = await prisma.googleAdsChangeEvent.findMany({
    where: { customerId: ref.customerId, campaignId: ref.googleCampaignId, changedAt: { gte: since } },
    // userEmail is deliberately not selected: it is stored for the table only.
    select: { changedAt: true, resourceType: true, operation: true, changedFields: true, clientType: true },
    orderBy: [{ changedAt: 'desc' }, { resourceName: 'desc' }],
    take: MAX_CHANGES,
  })
  const readThrough = ref.customer?.changesSyncedThrough ?? null
  return {
    items: rows.map((row) => {
      const { source, sourceText, sentence } = changeSourceOf(row.clientType)
      return {
        changedAt: row.changedAt.toISOString(),
        resourceType: row.resourceType,
        operation: row.operation,
        changedFields: row.changedFields,
        source,
        sourceText,
        summary: changeSummary(row.resourceType, row.operation, row.changedFields, sentence),
      }
    }),
    coveredFrom: readThrough && readThrough > since ? since.toISOString() : null,
  }
}

// ── S — read now ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface GoogleAdsReadRequest {
  queued: boolean
  reason: string | null
}

/** S — ask for a read of the chosen Google Ads account now (the read queue allows one an hour per account). */
export async function requestGoogleAdsRead(input: { connectionId?: string | null }): Promise<GoogleAdsReadRequest> {
  const accounts = await listGoogleAccounts()
  const wanted = typeof input.connectionId === 'string' && input.connectionId.trim() ? input.connectionId.trim() : null
  const account = wanted ? accounts.find((a) => a.connectionId === wanted) : (accounts.find((a) => a.ads) ?? accounts[0])
  if (wanted && !account) throw new GoogleAdsReadError(404, 'Google account not found')
  if (!account) return { queued: false, reason: 'Google is not connected for this business.' }
  const customerId = account.ads ? customerIdDigits(account.ads.customerId) : null
  if (!customerId) return { queued: false, reason: 'No Google Ads account is chosen yet. Choose one in Settings › Channels › Google.' }
  const answer = await enqueueGoogleAdsSync({ customerId, kind: 'MANUAL' })
  return { queued: answer.queued === true, reason: answer.reason ?? null }
}
