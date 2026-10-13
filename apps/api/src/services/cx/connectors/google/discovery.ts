/**
 * Google: which Google Ads accounts, Merchant Center accounts and Analytics properties one Google sign-in
 * reaches. Runs at connect and on demand (the account picker), never on the 15-minute heartbeat: every
 * Google Ads read spends operations from a scarce daily budget (`discoverOnHeartbeat: false`).
 *
 * Every call goes through the channel gateway (`googleCall`, read-only). Each product is read on its own:
 * one that fails (a permission not ticked, the API not switched on, a Merchant Center account that has not
 * registered the Nexus project, Google not answering) is recorded in words and the others still answer.
 *
 * Google Ads, per sign-in:
 *   1. `customers:listAccessibleCustomers` — the accounts the login can open DIRECTLY (1 call);
 *   2. `customer` for the first 20 of them — name, currency, time zone, test or live, manager or not;
 *   3. `customer_client` (level ≤ 1) for the first 5 direct MANAGER accounts, with `login-customer-id`
 *      — the accounts reached through a manager.
 * A manager account is never offered as the Ads account itself (it has no campaigns of its own); it
 * appears only as the path to the accounts under it.
 *
 * Every Google Ads call spends one operation of the daily allowance Nexus shares with the daily reads
 * (`marketing/google-ads/ops-budget.ts`, global: no account is chosen yet). A discovery reserves the most it can
 * spend BEFORE its first Google Ads call and gives back what it did not spend; a refused reservation means no Google
 * Ads call at all, and the Ads section says why in words (Merchant Center and Analytics are not counted there). When
 * Google itself answers that the day's allowance is used up (RESOURCE_EXHAUSTED), discovery holds every reservation for
 * the next hour (`markQuotaExhausted`, as the daily read does) and asks Google Ads nothing more this time.
 */
import type { Prisma } from '@prisma/client'
import prisma from '../../../../db.js'
import { logger } from '../../../../utils/logger.js'
import { googleCall } from '../../../gateway/google.js'
import { GatewayNoAnswer, GatewayRefusal } from '../../../gateway/gateway.js'
import { classifyChannelAnswer } from '../../../gateway/vocabulary.js'
import { GOOGLE_ADS_API_BASE } from '../../../google/api-version.js'
import { parseGoogleAdsFailure } from '../../../marketing/google-ads/errors.js'
import { markQuotaExhausted, QUOTA_EXHAUSTED_HOLD_MS, releaseOps, reserveOps, type OpsReservation } from '../../../marketing/google-ads/ops-budget.js'
import type { ConnectionHandle, ScopeInput } from '../../catalog.js'
import { GOOGLE_SCOPE, missingGoogleProducts, type GoogleProduct } from './scopes.js'

export type { GoogleProduct } from './scopes.js'

export type GoogleChoiceErrorCode = 'permission_missing' | 'no_access' | 'app_not_approved' | 'not_registered' | 'google_unavailable'
export interface GoogleChoiceError { code: GoogleChoiceErrorCode; message: string }
export interface GoogleManagerRef { customerId: string; name: string | null }
export interface GoogleAdsCustomerChoice {
  customerId: string
  /** Null when Nexus did not read the account's details (more than 20 direct accounts). */
  name: string | null
  currency: string | null
  timeZone: string | null
  isTest: boolean
  /** The login can open this account itself (no manager needed). */
  direct: boolean
  /** The manager accounts (read so far) this account can also be reached through. */
  managers: GoogleManagerRef[]
}
export interface GoogleMerchantAccountChoice { id: string; name: string | null }
export interface GoogleAnalyticsPropertyChoice { propertyId: string; name: string | null; accountName: string | null }
export interface GoogleChoices {
  missingProducts: GoogleProduct[]
  ads: { customers: GoogleAdsCustomerChoice[]; error: GoogleChoiceError | null }
  merchantCenter: { accounts: GoogleMerchantAccountChoice[]; error: GoogleChoiceError | null }
  analytics: { properties: GoogleAnalyticsPropertyChoice[]; error: GoogleChoiceError | null }
}
interface GoogleManagerClients {
  manager: GoogleManagerRef
  /** Ads accounts directly under the manager (level 1), enabled, not managers themselves. */
  customers: GoogleAdsCustomerChoice[]
  error: GoogleChoiceError | null
}

/** Caps: Google Ads operations are the scarce resource (bucket of 30 per account in rate.ts). */
export const MAX_DIRECT_DETAILS = 20
export const MAX_MANAGERS_AT_DISCOVERY = 5
/** The most Google Ads operations one discovery spends: the list, the capped account details, the capped managers. */
export const DISCOVERY_ADS_OPS = 1 + MAX_DIRECT_DETAILS + MAX_MANAGERS_AT_DISCOVERY
const MAX_PAGES = 5
const CONCURRENCY = 4
const TIMEOUT_MS = 30_000

const MERCHANT_ACCOUNTS_URL = 'https://merchantapi.googleapis.com/accounts/v1/accounts'
const GA4_ACCOUNT_SUMMARIES_URL = 'https://analyticsadmin.googleapis.com/v1beta/accountSummaries'

const CUSTOMER_QUERY = 'SELECT customer.id, customer.descriptive_name, customer.currency_code, customer.time_zone, customer.manager, customer.test_account, customer.status FROM customer LIMIT 1'
const CUSTOMER_CLIENT_QUERY = 'SELECT customer_client.id, customer_client.descriptive_name, customer_client.currency_code, customer_client.time_zone, customer_client.manager, customer_client.test_account, customer_client.status, customer_client.level FROM customer_client WHERE customer_client.level <= 1'

const PRODUCT_NAME: Record<GoogleProduct, string> = { ads: 'Google Ads', merchant_center: 'Merchant Center', analytics: 'Google Analytics' }
const API_NAME: Record<GoogleProduct, string> = { ads: 'Google Ads API', merchant_center: 'Merchant API', analytics: 'Google Analytics Admin API' }

export class GoogleConnectionNotFound extends Error {
  constructor(connectionId: string) {
    super(`No Google connection ${connectionId} in this business.`)
    this.name = 'GoogleConnectionNotFound'
  }
}

/** A Google Ads customer id as digits (`123-456-7890` → `1234567890`), or null when it is not one. */
export function googleCustomerId(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const digits = String(value).trim().replace(/^customers\//, '').replace(/-/g, '')
  return /^\d{1,20}$/.test(digits) ? digits : null
}

/** A Merchant Center account or Analytics property id (`accounts/123`, `properties/456` → digits), or null. */
function digitsId(value: unknown, prefix: RegExp): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null
  const digits = String(value).trim().replace(prefix, '')
  return /^\d{1,20}$/.test(digits) ? digits : null
}

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)

type Answer = { ok: true; body: any } | { ok: false; error: GoogleChoiceError; channelCode: string | null }

/** Google's refusal, in words the Owner can act on. */
function choiceErrorOf(product: GoogleProduct, status: number, body: string): { error: GoogleChoiceError; channelCode: string | null } {
  const verdict = classifyChannelAnswer('GOOGLE', status, body)
  const code = verdict.channelCode
  const said = verdict.channelMessage ? ` Google said: "${verdict.channelMessage}"` : ''
  const make = (c: GoogleChoiceErrorCode, message: string) => ({ error: { code: c, message }, channelCode: code })
  if (code === 'CLOUD_PROJECT_NOT_APPROVED_FOR_PRODUCTION' || /^DEVELOPER_TOKEN_/.test(code ?? '')) {
    return make('app_not_approved', `Google has not yet approved the Nexus app for live ${PRODUCT_NAME[product]} accounts (it has test access only). The Owner applies for a higher access level on the Google Ads API page of the Nexus Google Cloud project.`)
  }
  if (code === 'SERVICE_DISABLED' || code === 'API_DISABLED') {
    return make('app_not_approved', `The ${API_NAME[product]} is not switched on in the Nexus Google Cloud project. The Owner switches it on in Google Cloud → APIs & Services.`)
  }
  if (product === 'merchant_center' && status === 401 && /not registered/i.test(verdict.channelMessage ?? '')) {
    return make('not_registered', 'Merchant Center has not registered the Nexus Google Cloud project yet, so Google does not let Nexus read it. Registration is a one-time step an admin of the Merchant Center account takes; Nexus does not do it in this version.')
  }
  if (code === 'ACCESS_TOKEN_SCOPE_INSUFFICIENT') {
    return make('permission_missing', `Nexus was not given permission to read ${PRODUCT_NAME[product]}. Reconnect Google and tick the ${PRODUCT_NAME[product]} box.`)
  }
  if (code === 'NOT_ADS_USER') return make('no_access', 'This Google login has no Google Ads account.')
  if (verdict.errorClass === 'auth_expired' || verdict.errorClass === 'auth_revoked') {
    return make('permission_missing', `Google did not accept this sign-in for ${PRODUCT_NAME[product]}. Reconnect Google.${said}`)
  }
  if (verdict.errorClass === 'forbidden') return make('no_access', `This Google login cannot open ${PRODUCT_NAME[product]}.${said}`)
  if (verdict.errorClass === 'configuration') return make('app_not_approved', `The Nexus Google app is not set up for ${PRODUCT_NAME[product]}.${said}`)
  if (verdict.retryable) return make('google_unavailable', `Google did not answer for ${PRODUCT_NAME[product]} just now. Try again in a few minutes.`)
  return make('google_unavailable', `Google refused to list ${PRODUCT_NAME[product]} (${status}).${said}`)
}

/**
 * Google Ads operations one discovery sent (a call that reached Google, answered or not, counts), and Google's own "the
 * day's allowance is used up" once it said so: every later Google Ads call of this discovery is not sent.
 */
interface Spent { ops: number; quotaExhausted?: GoogleChoiceError }

/** Google answered RESOURCE_EXHAUSTED: the day's Google Ads allowance is used up. */
function quotaExhaustedError(now: Date): GoogleChoiceError {
  return { code: 'google_unavailable', message: `Google said Nexus has used up its daily Google Ads allowance. Try again after ${utcTime(new Date(now.getTime() + QUOTA_EXHAUSTED_HOLD_MS))}.` }
}

async function ask(product: GoogleProduct, connectionId: string, request: { operation: string; method: 'GET' | 'POST'; url: string; body?: unknown; loginCustomerId?: string | null }, spent?: Spent): Promise<Answer> {
  if (spent?.quotaExhausted) return { ok: false, channelCode: 'RESOURCE_EXHAUSTED', error: spent.quotaExhausted }
  let res: Response
  try {
    // Google Ads: no gateway retry of a 429. A used-up day (RESOURCE_EXHAUSTED) is seen at once and never asked again
    // (each ask spends an operation); a short slow-down is said in words, and the person tries again.
    res = await googleCall({ connectionId, timeoutMs: TIMEOUT_MS, ...(product === 'ads' ? { max429Retries: 0 } : {}), ...request })
    if (spent) spent.ops += 1
  } catch (err) {
    if (spent && err instanceof GatewayNoAnswer) spent.ops += 1
    if (err instanceof GatewayRefusal) {
      if (err.outcome === 'held') return { ok: false, channelCode: err.code, error: { code: 'permission_missing', message: 'Google needs you to sign in again before Nexus can read it. Reconnect Google.' } }
      if (err.code === 'RATE_LIMITED_LOCAL') return { ok: false, channelCode: err.code, error: { code: 'google_unavailable', message: `Nexus has used its ${PRODUCT_NAME[product]} allowance for the moment. Try again in a minute.` } }
      return { ok: false, channelCode: err.code, error: { code: 'google_unavailable', message: err.message } }
    }
    if (err instanceof GatewayNoAnswer) return { ok: false, channelCode: err.errorClass, error: { code: 'google_unavailable', message: `Google did not answer for ${PRODUCT_NAME[product]} just now. Try again in a few minutes.` } }
    logger.warn('[google-discovery] call failed', { product, operation: request.operation, error: err instanceof Error ? err.message : String(err) })
    return { ok: false, channelCode: null, error: { code: 'google_unavailable', message: `Nexus could not ask Google about ${PRODUCT_NAME[product]}. Try again in a few minutes.` } }
  }
  const raw = await res.text()
  if (!res.ok && product === 'ads' && parseGoogleAdsFailure(res.status, raw, res.headers).quotaExhausted) {
    // As the daily read does: no reservation is granted for the next hour, and this discovery asks nothing more.
    await markQuotaExhausted()
    const error = quotaExhaustedError(new Date())
    if (spent) spent.quotaExhausted = error
    return { ok: false, channelCode: 'RESOURCE_EXHAUSTED', error }
  }
  if (!res.ok) return { ok: false, ...choiceErrorOf(product, res.status, raw) }
  try {
    return { ok: true, body: raw ? JSON.parse(raw) : {} }
  } catch {
    return { ok: false, channelCode: null, error: { code: 'google_unavailable', message: `Google answered for ${PRODUCT_NAME[product]} in a form Nexus could not read.` } }
  }
}

const notGranted = (product: GoogleProduct): GoogleChoiceError => ({
  code: 'permission_missing',
  message: `Nexus was not given permission to read ${PRODUCT_NAME[product]}. Reconnect Google and tick the ${PRODUCT_NAME[product]} box.`,
})

const utcTime = (at: Date): string =>
  `${at.toISOString().slice(11, 16)} UTC on ${at.getUTCDate()} ${at.toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })}`

/** A refused reservation, in words: nothing was asked of Google Ads. */
function allowanceError(reservation: OpsReservation, ops: number): GoogleChoiceError {
  const when = reservation.retryAt ? `Try again after ${utcTime(reservation.retryAt)}.` : 'Try again later.'
  if (reservation.reason === 'quota_exhausted') {
    return { code: 'google_unavailable', message: `Nexus did not ask Google Ads: Google said Nexus has used up its daily Google allowance. ${when}` }
  }
  if (reservation.reason === 'global_cap' || reservation.reason === 'account_cap') {
    const used = reservation.usedGlobal === null
      ? ''
      : ` (${reservation.usedGlobal} of ${reservation.capGlobal} Google Ads operations in the last 24 hours; this can take up to ${ops})`
    return { code: 'google_unavailable', message: `Nexus did not ask Google Ads: its daily Google allowance is used up${used}. ${when}` }
  }
  return { code: 'google_unavailable', message: 'Nexus did not ask Google Ads: it cannot count its daily Google Ads allowance right now. Try again in a few minutes.' }
}

/**
 * Reserve `ops` Google Ads operations (global allowance) before the first Google Ads call; give back what `read` did
 * not spend. Refused: `read` never runs, so nothing is sent to Google Ads.
 */
async function withAdsAllowance<T>(ops: number, refused: (error: GoogleChoiceError) => T, read: (spent: Spent) => Promise<T>): Promise<T> {
  const reservation = await reserveOps(null, ops)
  if (!reservation.ok) return refused(allowanceError(reservation, ops))
  const spent: Spent = { ops: 0 }
  try {
    return await read(spent)
  } finally {
    if (reservation.ops > spent.ops) await releaseOps(null, reservation.ops - spent.ops, reservation.reservedAt)
  }
}

async function mapLimit<T, R>(items: T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0
  const worker = async () => {
    while (next < items.length) {
      const index = next++
      out[index] = await run(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return out
}

interface AdsAccountRow {
  customerId: string
  name: string | null
  currency: string | null
  timeZone: string | null
  isTest: boolean
  manager: boolean
  status: string | null
}

function adsAccountOf(row: any): AdsAccountRow | null {
  const customerId = googleCustomerId(row?.id)
  if (!customerId) return null
  return {
    customerId,
    name: text(row?.descriptiveName),
    currency: text(row?.currencyCode),
    timeZone: text(row?.timeZone),
    isTest: row?.testAccount === true,
    manager: row?.manager === true,
    status: text(row?.status),
  }
}

const search = (customerId: string, query: string, loginCustomerId?: string | null) => ({
  operation: 'ads.search',
  method: 'POST' as const,
  url: `${GOOGLE_ADS_API_BASE}/customers/${customerId}/googleAds:search`,
  body: { query },
  loginCustomerId: loginCustomerId ?? null,
})

/** The accounts directly under one manager account (level 1), read with the manager as login customer. */
async function readManagerClients(connectionId: string, managerCustomerId: string, spent: Spent): Promise<GoogleManagerClients> {
  const answer = await ask('ads', connectionId, search(managerCustomerId, CUSTOMER_CLIENT_QUERY, managerCustomerId), spent)
  const manager: GoogleManagerRef = { customerId: managerCustomerId, name: null }
  if (answer.ok === false) return { manager, customers: [], error: answer.error }
  const customers: GoogleAdsCustomerChoice[] = []
  for (const result of Array.isArray(answer.body?.results) ? answer.body.results : []) {
    const row = result?.customerClient
    const account = adsAccountOf(row)
    if (!account) continue
    const level = Number(row?.level)
    if (level === 0 || account.customerId === managerCustomerId) { manager.name = account.name; continue }
    if (level !== 1 || (account.status && account.status !== 'ENABLED')) continue
    if (account.manager) continue // a manager under the manager holds no campaigns of its own
    customers.push({ customerId: account.customerId, name: account.name, currency: account.currency, timeZone: account.timeZone, isTest: account.isTest, direct: false, managers: [] })
  }
  for (const customer of customers) customer.managers = [{ ...manager }]
  return { manager, customers, error: null }
}

const byName = <T extends { name: string | null }>(key: (item: T) => string) => (a: T, b: T) =>
  (a.name === null ? 1 : 0) - (b.name === null ? 1 : 0) || (a.name ?? '').localeCompare(b.name ?? '') || key(a).localeCompare(key(b))

function readAds(connectionId: string): Promise<GoogleChoices['ads']> {
  return withAdsAllowance(DISCOVERY_ADS_OPS, (error) => ({ customers: [], error }), (spent) => readAdsWithin(connectionId, spent))
}

async function readAdsWithin(connectionId: string, spent: Spent): Promise<GoogleChoices['ads']> {
  const listed = await ask('ads', connectionId, { operation: 'ads.listAccessibleCustomers', method: 'GET', url: `${GOOGLE_ADS_API_BASE}/customers:listAccessibleCustomers` }, spent)
  if (listed.ok === false) return { customers: [], error: listed.error }
  const directIds = [...new Set((Array.isArray(listed.body?.resourceNames) ? listed.body.resourceNames : []).map(googleCustomerId).filter((id: string | null): id is string => !!id))] as string[]
  const detailed = directIds.slice(0, MAX_DIRECT_DETAILS)
  const answers = await mapLimit(detailed, CONCURRENCY, (id) => ask('ads', connectionId, search(id, CUSTOMER_QUERY), spent))

  const customers = new Map<string, GoogleAdsCustomerChoice>()
  const managers: GoogleManagerRef[] = []
  let sectionError: GoogleChoiceError | null = null
  let firstError: GoogleChoiceError | null = null
  let unreadable = 0
  answers.forEach((answer, index) => {
    if (answer.ok === false) {
      unreadable++
      firstError = firstError ?? answer.error
      // An app-level refusal (test access, API off) is the section's problem, not this account's: say it.
      if (!sectionError && (answer.error.code === 'app_not_approved' || answer.error.code === 'google_unavailable')) sectionError = answer.error
      return
    }
    const account = adsAccountOf(answer.body?.results?.[0]?.customer)
    if (!account || account.customerId !== detailed[index]) { unreadable++; return }
    if (account.status && account.status !== 'ENABLED') return // cancelled, suspended or closed: nothing to read
    if (account.manager) { managers.push({ customerId: account.customerId, name: account.name }); return }
    customers.set(account.customerId, { customerId: account.customerId, name: account.name, currency: account.currency, timeZone: account.timeZone, isTest: account.isTest, direct: true, managers: [] })
  })
  // Direct accounts past the cap: listed by id only (their details are read when one is chosen).
  for (const id of directIds.slice(MAX_DIRECT_DETAILS)) {
    customers.set(id, { customerId: id, name: null, currency: null, timeZone: null, isTest: false, direct: true, managers: [] })
  }
  const managerReads = await mapLimit(managers.slice(0, MAX_MANAGERS_AT_DISCOVERY), CONCURRENCY, (m) => readManagerClients(connectionId, m.customerId, spent))
  for (const read of managerReads) {
    const ref: GoogleManagerRef = { customerId: read.manager.customerId, name: read.manager.name ?? managers.find((m) => m.customerId === read.manager.customerId)?.name ?? null }
    if (read.error) {
      // One manager that cannot be read does not hide the accounts that were: say which one.
      const which = ref.name ? `the manager account “${ref.name}”` : 'a manager account'
      if (!sectionError) sectionError = { code: read.error.code, message: `The accounts under ${which} could not be listed. ${read.error.message}` }
      continue
    }
    for (const child of read.customers) {
      const existing = customers.get(child.customerId)
      if (existing) {
        if (!existing.managers.some((m) => m.customerId === ref.customerId)) existing.managers.push(ref)
        existing.name = existing.name ?? child.name
        existing.currency = existing.currency ?? child.currency
        existing.timeZone = existing.timeZone ?? child.timeZone
      } else {
        customers.set(child.customerId, { ...child, managers: [ref] })
      }
    }
  }
  if (!sectionError && unreadable > 0 && customers.size === 0) {
    sectionError = firstError ?? { code: 'no_access', message: 'Google lists Google Ads accounts for this login, but none of them could be opened.' }
  }
  return { customers: [...customers.values()].sort(byName((c) => c.customerId)), error: sectionError }
}

async function readMerchant(connectionId: string): Promise<GoogleChoices['merchantCenter']> {
  const accounts: GoogleMerchantAccountChoice[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = pageToken ? `${MERCHANT_ACCOUNTS_URL}?pageToken=${encodeURIComponent(pageToken)}` : MERCHANT_ACCOUNTS_URL
    const answer = await ask('merchant_center', connectionId, { operation: 'merchant.accounts.list', method: 'GET', url })
    if (answer.ok === false) return { accounts: [], error: answer.error }
    for (const row of Array.isArray(answer.body?.accounts) ? answer.body.accounts : []) {
      const id = digitsId(row?.accountId, /^accounts\//) ?? digitsId(row?.name, /^accounts\//)
      if (id && !accounts.some((a) => a.id === id)) accounts.push({ id, name: text(row?.accountName) })
    }
    pageToken = text(answer.body?.nextPageToken)
    if (!pageToken) break
  }
  return { accounts: accounts.sort(byName((a) => a.id)), error: null }
}

async function readAnalytics(connectionId: string): Promise<GoogleChoices['analytics']> {
  const properties: GoogleAnalyticsPropertyChoice[] = []
  let pageToken: string | null = null
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${GA4_ACCOUNT_SUMMARIES_URL}?pageSize=200${pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : ''}`
    const answer = await ask('analytics', connectionId, { operation: 'analytics.accountSummaries.list', method: 'GET', url })
    if (answer.ok === false) return { properties: [], error: answer.error }
    for (const summary of Array.isArray(answer.body?.accountSummaries) ? answer.body.accountSummaries : []) {
      for (const property of Array.isArray(summary?.propertySummaries) ? summary.propertySummaries : []) {
        const propertyId = digitsId(property?.property, /^properties\//)
        if (propertyId && !properties.some((p) => p.propertyId === propertyId)) {
          properties.push({ propertyId, name: text(property?.displayName), accountName: text(summary?.displayName) })
        }
      }
    }
    pageToken = text(answer.body?.nextPageToken)
    if (!pageToken) break
  }
  return { properties: properties.sort(byName((p) => p.propertyId)), error: null }
}

async function googleConnection(connectionId: string): Promise<{ grantedScopes: string[]; connectionMetadata: unknown }> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { channelType: true, grantedScopes: true, connectionMetadata: true } })
  if (!row || row.channelType !== 'GOOGLE') throw new GoogleConnectionNotFound(connectionId)
  return { grantedScopes: row.grantedScopes ?? [], connectionMetadata: row.connectionMetadata }
}

/** What the last discovery found, per product, on `connectionMetadata.googleDiscovery` (counts and errors only). */
async function recordDiscovery(connectionId: string, previous: unknown, choices: GoogleChoices): Promise<void> {
  const base = previous && typeof previous === 'object' && !Array.isArray(previous) ? (previous as Record<string, unknown>) : {}
  const googleDiscovery = {
    at: new Date().toISOString(),
    missingProducts: choices.missingProducts,
    ads: { count: choices.ads.customers.length, error: choices.ads.error },
    merchantCenter: { count: choices.merchantCenter.accounts.length, error: choices.merchantCenter.error },
    analytics: { count: choices.analytics.properties.length, error: choices.analytics.error },
  }
  try {
    await prisma.channelConnection.update({ where: { id: connectionId }, data: { connectionMetadata: { ...base, googleDiscovery } as unknown as Prisma.InputJsonValue } })
  } catch (err) {
    logger.warn('[google-discovery] result not recorded', { connectionId, error: err instanceof Error ? err.message : String(err) })
  }
}

/**
 * Everything one Google connection can be linked to, product by product (the account picker's choices).
 * Each product fails on its own, in words. Throws `GoogleConnectionNotFound` for an id that is not a
 * Google connection of this business.
 */
export async function discoverGoogleChoices(connectionId: string): Promise<GoogleChoices> {
  const connection = await googleConnection(connectionId)
  const missingProducts = missingGoogleProducts(connection.grantedScopes)
  const missing = new Set(missingProducts)
  const [ads, merchantCenter, analytics] = await Promise.all([
    missing.has('ads') ? { customers: [], error: notGranted('ads') } : readAds(connectionId),
    missing.has('merchant_center') ? { accounts: [], error: notGranted('merchant_center') } : readMerchant(connectionId),
    missing.has('analytics') ? { properties: [], error: notGranted('analytics') } : readAnalytics(connectionId),
  ])
  const choices: GoogleChoices = { missingProducts, ads, merchantCenter, analytics }
  await recordDiscovery(connectionId, connection.connectionMetadata, choices)
  return choices
}

/** The catalogue's `discoverScopes`: the choices as ConnectionScope rows (problems stay on the connection). */
export async function discoverGoogleScopes(handle: ConnectionHandle): Promise<ScopeInput[]> {
  const choices = await discoverGoogleChoices(handle.id)
  return [
    ...choices.ads.customers.map((c): ScopeInput => ({
      kind: 'google_ads_customer',
      externalId: c.customerId,
      label: c.name ?? undefined,
      metadata: { currency: c.currency, timeZone: c.timeZone, isTest: c.isTest, direct: c.direct, managers: c.managers },
    })),
    ...choices.merchantCenter.accounts.map((a): ScopeInput => ({ kind: 'google_merchant_account', externalId: a.id, label: a.name ?? undefined, metadata: {} })),
    ...choices.analytics.properties.map((p): ScopeInput => ({ kind: 'google_ga4_property', externalId: p.propertyId, label: p.name ?? undefined, metadata: { accountName: p.accountName } })),
  ]
}

export { GOOGLE_SCOPE }
