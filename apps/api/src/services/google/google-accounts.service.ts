/**
 * Google Ads step 1a — which Google accounts a business reads through its Google sign-in (PLAN.md L6, contract C1–C3;
 * plan-1 Part C). Read-only towards Google: the only Google calls are the discovery reads (cx/connectors/google/discovery.ts).
 *
 *   listGoogleAccounts()   C1 — this business's Google sign-ins, each with what it reads and how the read is doing
 *   getChoices()           C2 — what the sign-in can see, product by product; read from Google at most once per
 *                          5 minutes per sign-in (unless forced), the answer kept in between
 *   saveSelection()        C3 — the choice: only ids Google offered THIS business's sign-in, a manager only when it is a
 *                          discovered path to the account; one Google Ads account, one Merchant Center account and one
 *                          Analytics property per business (GoogleAccountLink); recorded in the connection ledger
 *                          (`accounts_linked`); the account row the read writes into is prepared and the first read queued
 *
 * Merchant Center and Analytics are chosen, never read, in step 1.
 */
import type { GoogleAccountLink, GoogleAdsCustomer, Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { workspaceContext, workspaceIdForQuery, workspaceKey } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { connectionLabel } from '../connection-label.js'
import { CONNECTION_PUBLIC_SELECT, isOwnConnection, listManagedConnections, type ConnectionRow } from '../connection-resolver.service.js'
import { discoverGoogleChoices, googleCustomerId, GoogleConnectionNotFound, type GoogleChoices } from '../cx/connectors/google/discovery.js'
import { missingGoogleProducts, type GoogleProduct } from '../cx/connectors/google/scopes.js'
import { recordConnectionEventInTx } from '../cx/events.service.js'
import { enqueueGoogleAdsSync } from '../marketing/google-ads/enqueue.js'
import { ensureGoogleAdsCustomer, googleAdsCustomersById } from '../marketing/google-ads/store.js'
import { googleAdsSyncSwitchedOff, nextGoogleAdsReadAt } from '../marketing/google-ads/sync-switch.js'

export { GoogleConnectionNotFound } from '../cx/connectors/google/discovery.js'

// ── the contract (apps/web/src/lib/google-ads/contract.ts is the web's copy) ─────────────────────────────────────

export type GoogleAccountState = 'sign_in_needed' | 'permission_missing' | 'choose_account' | 'first_read_pending' | 'read_failed' | 'ok'

export interface GoogleAccount {
  connectionId: string
  /** A person's name for this sign-in. Never a customer id. */
  label: string
  state: GoogleAccountState
  stateText: string
  authStatus: string
  missingProducts: GoogleProduct[]
  ads: { customerId: string; name: string | null; currency: string; timeZone: string; isTest: boolean } | null
  manager: { customerId: string; name: string | null } | null
  merchantCenter: { id: string; name: string | null } | null
  analytics: { propertyId: string; name: string | null } | null
  read: { lastReadAt: string | null; lastDataDay: string | null; nextReadAt: string | null; lastError: string | null }
}

export interface GoogleSelectionInput {
  adsCustomerId: string
  managerCustomerId: string | null
  merchantCenterId: string | null
  analyticsPropertyId: string | null
}

/**
 * A choice refused: 400 (not a valid choice), 404 (no such Google sign-in here), 409 (`not_offered`, `customer_taken`,
 * `taken_by_other_business` with the `product` another business already picked).
 */
export class GoogleSelectionError extends Error {
  constructor(
    readonly statusCode: 400 | 404 | 409,
    readonly code: 'invalid' | 'not_found' | 'not_offered' | 'customer_taken' | 'taken_by_other_business',
    message: string,
    readonly product: GoogleProduct | null = null,
  ) {
    super(message)
    this.name = 'GoogleSelectionError'
  }
}

/** GoogleAccountLink.product values. */
const PRODUCT = { ads: 'ADS', merchant: 'MERCHANT', analytics: 'GA4' } as const

const SIGNED_OUT = new Set(['needs_reauth', 'revoked', 'disconnected'])
const DIGITS = /^\d{1,20}$/

const text = (value: unknown): string | null => (typeof value === 'string' && value.trim() ? value.trim() : null)
const record = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {})
const day = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)

// ── C1 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

type CustomerState = Pick<GoogleAdsCustomer, 'lastSyncAt' | 'lastSuccessAt' | 'lastSyncStatus' | 'lastSyncError' | 'metricsReadThrough'>

/** The state and its sentence, from the sign-in, its permissions, the choice and the read. Pure. */
export function googleAccountState(input: {
  isActive: boolean
  authStatus: string
  missingProducts: GoogleProduct[]
  adsLinked: boolean
  accountName: string | null
  customer: CustomerState | null
  readingOn: boolean
}): { state: GoogleAccountState; stateText: string } {
  const name = input.accountName ? `“${input.accountName}”` : 'this Google Ads account'
  const status = input.customer?.lastSyncStatus ?? null
  const error = input.customer?.lastSyncError ?? null
  if (!input.isActive || input.authStatus === 'disconnected') {
    return { state: 'sign_in_needed', stateText: 'This Google sign-in is not connected. Connect Google again to read your accounts.' }
  }
  if (SIGNED_OUT.has(input.authStatus)) {
    return { state: 'sign_in_needed', stateText: 'Google needs you to sign in again before Nexus can read it. Reconnect Google.' }
  }
  if (input.missingProducts.includes('ads')) {
    return { state: 'permission_missing', stateText: 'Nexus was not given permission to read Google Ads. Reconnect Google and tick the Google Ads box.' }
  }
  if (!input.adsLinked) return { state: 'choose_account', stateText: 'Choose a Google Ads account for Nexus to read.' }
  if (status === 'AUTH_LOST') {
    return { state: 'sign_in_needed', stateText: error ?? 'The Google sign-in no longer works. Reconnect Google.' }
  }
  const everRead = !!input.customer?.metricsReadThrough
  if (!everRead) {
    if (status === 'FAILED' || status === 'MANAGER' || status === 'PARTIAL') {
      return { state: 'read_failed', stateText: `Nexus could not read ${name}. ${error ?? 'Google did not say why.'}` }
    }
    if (!input.readingOn) return { state: 'first_read_pending', stateText: `Nexus has not read ${name} yet: reading Google Ads is switched off on the server for now.` }
    const waiting = status === 'SKIPPED_BUDGET' && error ? ` ${error}` : ''
    return { state: 'first_read_pending', stateText: `Nexus has not finished reading ${name} yet. Campaigns appear when it does.${waiting}` }
  }
  if (status === 'FAILED' || status === 'MANAGER') {
    return { state: 'read_failed', stateText: `The last read of ${name} failed. ${error ?? 'Google did not say why.'} The numbers shown are from an earlier read.` }
  }
  if (status === 'PARTIAL') return { state: 'ok', stateText: `The last read of ${name} was not complete. ${error ?? ''}`.trim() }
  if (status === 'SKIPPED_BUDGET') return { state: 'ok', stateText: `Nexus skipped the last read of ${name}. ${error ?? ''}`.trim() }
  return {
    state: 'ok',
    stateText: input.readingOn ? `Nexus reads ${name} once a day.` : `Nexus has read ${name}; reading is switched off on the server for now.`,
  }
}

function accountOf(row: ConnectionRow, links: GoogleAccountLink[], customers: Map<string, GoogleAdsCustomer>, now: Date): GoogleAccount {
  const missingProducts = missingGoogleProducts(row.grantedScopes ?? [])
  const adsLink = links.find((link) => link.product === PRODUCT.ads) ?? null
  const merchantLink = links.find((link) => link.product === PRODUCT.merchant) ?? null
  const analyticsLink = links.find((link) => link.product === PRODUCT.analytics) ?? null
  const customer = adsLink ? customers.get(adsLink.externalId) ?? null : null
  const adsMeta = record(adsLink?.metadata)
  const ads = adsLink
    ? {
        customerId: adsLink.externalId,
        name: text(customer?.descriptiveName) ?? text(adsMeta.name),
        currency: text(customer?.currencyCode) ?? text(adsMeta.currency) ?? '',
        timeZone: text(customer?.timeZone) ?? text(adsMeta.timeZone) ?? '',
        isTest: customer ? customer.testAccount : adsMeta.isTest === true,
      }
    : null
  const readingOn = !googleAdsSyncSwitchedOff()
  const { state, stateText } = googleAccountState({
    isActive: row.isActive,
    authStatus: row.authStatus,
    missingProducts,
    adsLinked: !!adsLink,
    accountName: ads?.name ?? null,
    customer,
    readingOn,
  })
  const lastPartial = customer?.lastSyncStatus === 'PARTIAL' && customer.lastSyncAt && (!customer.lastSuccessAt || customer.lastSyncAt > customer.lastSuccessAt)
  const reads = !!adsLink && (state === 'ok' || state === 'first_read_pending' || state === 'read_failed')
  return {
    connectionId: row.id,
    label: connectionLabel(row).label,
    state,
    stateText,
    authStatus: row.authStatus,
    missingProducts,
    ads,
    manager: adsLink?.loginCustomerId ? { customerId: adsLink.loginCustomerId, name: text(adsMeta.managerName) } : null,
    merchantCenter: merchantLink ? { id: merchantLink.externalId, name: text(record(merchantLink.metadata).name) } : null,
    analytics: analyticsLink ? { propertyId: analyticsLink.externalId, name: text(record(analyticsLink.metadata).name) } : null,
    read: {
      lastReadAt: iso(lastPartial ? customer!.lastSyncAt : customer?.lastSuccessAt ?? null),
      lastDataDay: day(customer?.metricsReadThrough),
      nextReadAt: reads ? iso(nextGoogleAdsReadAt(now)) : null,
      lastError: customer && customer.lastSyncStatus && customer.lastSyncStatus !== 'SUCCESS' ? customer.lastSyncError ?? null : null,
    },
  }
}

/**
 * C1 — this business's Google sign-ins (active ones), each with its choice and the state of its read. 0 or 1 in step 1
 * (one Google login per business); the sign-in that holds the Google Ads choice comes first.
 */
export async function listGoogleAccounts(now: Date = new Date()): Promise<GoogleAccount[]> {
  // Every live sign-in of the business (the resolver's own list; none is picked for the caller), Google's only.
  const rows = (await listManagedConnections(false)).filter((row) => row.channelType === 'GOOGLE' && isOwnConnection(row))
  if (rows.length === 0) return []
  const links = await prisma.googleAccountLink.findMany({ where: { connectionId: { in: rows.map((row) => row.id) } } })
  const customers = await googleAdsCustomersById(links.filter((link) => link.product === PRODUCT.ads).map((link) => link.externalId))
  const accounts = rows.map((row) => accountOf(row, links.filter((link) => link.connectionId === row.id), customers, now))
  return accounts.sort((a, b) => Number(!!b.ads) - Number(!!a.ads))
}

// ── C2 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Google is asked again at most this often per sign-in (each discovery spends Google Ads operations). */
export const CHOICES_TTL_MS = 5 * 60_000

const choicesCache = new Map<string, { at: number; choices: GoogleChoices }>()
const choicesInFlight = new Map<string, Promise<GoogleChoices>>()

/** Tests: forget the kept answers. */
export function __clearGoogleChoicesCache(): void {
  choicesCache.clear()
  choicesInFlight.clear()
}

/**
 * C2 — what this Google sign-in can see, product by product (each one fails on its own, in words). Read from Google
 * at most once per 5 minutes per sign-in in this business; `force` reads again now. Throws GoogleConnectionNotFound
 * for an id that is not a Google sign-in of this business.
 */
export async function getChoices(connectionId: string, options: { force?: boolean; now?: number } = {}): Promise<GoogleChoices> {
  const key = `${workspaceIdForQuery()}:${connectionId}`
  const now = options.now ?? Date.now()
  const kept = choicesCache.get(key)
  if (!options.force && kept && now - kept.at < CHOICES_TTL_MS) return kept.choices
  const running = choicesInFlight.get(key)
  if (running) return running
  const read = discoverGoogleChoices(connectionId)
    .then((choices) => {
      choicesCache.set(key, { at: Date.now(), choices })
      return choices
    })
    .finally(() => choicesInFlight.delete(key))
  choicesInFlight.set(key, read)
  return read
}

/**
 * C2 as the API answers it (the web's `GoogleChoices`): an account Nexus listed by id only (past the first 20 the
 * sign-in reaches) has no currency or time zone yet — sent as empty text, never invented.
 */
export function choicesAnswer(choices: GoogleChoices) {
  return {
    missingProducts: choices.missingProducts,
    ads: {
      customers: choices.ads.customers.map((c) => ({ ...c, currency: c.currency ?? '', timeZone: c.timeZone ?? '' })),
      error: choices.ads.error,
    },
    merchantCenter: choices.merchantCenter,
    analytics: choices.analytics,
  }
}

// ── C3 ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The body as the route received it, checked: digits only, Google Ads ids with or without hyphens. */
export function parseSelection(body: unknown): GoogleSelectionInput {
  const input = record(body)
  const adsCustomerId = googleCustomerId(input.adsCustomerId)
  if (!adsCustomerId) throw new GoogleSelectionError(400, 'invalid', 'Choose the Google Ads account Nexus reads.')
  const optional = (value: unknown, what: string, normalise: (v: unknown) => string | null): string | null => {
    if (value === null || value === undefined || value === '') return null
    const id = normalise(value)
    if (!id) throw new GoogleSelectionError(400, 'invalid', `The ${what} is not one Google offered. Reload the choices and pick again.`)
    return id
  }
  const plainDigits = (v: unknown) => (typeof v === 'string' || typeof v === 'number') && DIGITS.test(String(v).trim()) ? String(v).trim() : null
  return {
    adsCustomerId,
    managerCustomerId: optional(input.managerCustomerId, 'manager account', googleCustomerId),
    merchantCenterId: optional(input.merchantCenterId, 'Merchant Center account', plainDigits),
    analyticsPropertyId: optional(input.analyticsPropertyId, 'Google Analytics property', plainDigits),
  }
}

const NOT_OFFERED_ADS = 'Google does not offer this Google Ads account to this sign-in. Reload the list and choose again.'

/**
 * One Google login may be connected in many businesses, but each Google Ads account, Merchant Center account and GA4
 * property is picked by ONE business (Owner 2026-10-13). The global unique index on (product, externalId) refuses the
 * second business (another business's rows are invisible here); this says so without naming that business.
 */
const TAKEN: Record<string, { product: GoogleProduct; message: string }> = {
  ADS: { product: 'ads', message: 'Another business in Nexus already reads this Google Ads account. A Google Ads account can belong to one business only. Choose another account, or disconnect Google in the other business first.' },
  MERCHANT: { product: 'merchant_center', message: 'Another business in Nexus already uses this Merchant Center account. A Merchant Center account can belong to one business only. Choose another account, or disconnect Google in the other business first.' },
  GA4: { product: 'analytics', message: 'Another business in Nexus already uses this Google Analytics property. A property can belong to one business only. Choose another property, or disconnect Google in the other business first.' },
}

async function linkRow(tx: Prisma.TransactionClient, product: string, data: {
  connectionId: string; externalId: string; loginCustomerId: string | null; label: string; metadata: Prisma.InputJsonObject; selectedByUserId: string
}) {
  try {
    return await tx.googleAccountLink.upsert({
      where: { google_link_product: workspaceKey({ product }) },
      create: { product, ...data },
      update: data,
    })
  } catch (err) {
    // The index name travels in `meta.target` (Prisma's own engine) or in `meta.driverAdapterError.cause.constraint`
    // (the pg driver adapter); the other unique key, (workspaceId, product), names no externalId.
    const e = err as { code?: string; meta?: unknown }
    const taken = TAKEN[product]
    if (taken && e?.code === 'P2002' && JSON.stringify(e.meta ?? null).includes('externalId')) {
      throw new GoogleSelectionError(409, 'taken_by_other_business', taken.message, taken.product)
    }
    throw err
  }
}

/**
 * C3 — save which Google Ads account (and, optionally, which Merchant Center account and Analytics property) this
 * business reads through this sign-in. Idempotent: the same choice again changes nothing and records nothing. Returns
 * the account as C1 shows it. The first read of an account never read is queued at once.
 */
export async function saveSelection(connectionId: string, body: unknown, actor: { userId?: string | null } = {}): Promise<{ account: GoogleAccount }> {
  const selection = parseSelection(body)
  const connection = await prisma.channelConnection.findFirst({ where: { id: connectionId, channelType: 'GOOGLE' }, select: CONNECTION_PUBLIC_SELECT })
  if (!connection || !isOwnConnection(connection)) throw new GoogleSelectionError(404, 'not_found', 'This Google sign-in is not connected to this business.')
  if (!connection.isActive || SIGNED_OUT.has(connection.authStatus)) {
    throw new GoogleSelectionError(409, 'not_offered', 'This Google sign-in needs to be connected again before you choose its accounts.')
  }

  let choices: GoogleChoices
  try {
    choices = await getChoices(connectionId)
  } catch (err) {
    if (err instanceof GoogleConnectionNotFound) throw new GoogleSelectionError(404, 'not_found', 'This Google sign-in is not connected to this business.')
    throw err
  }
  const customer = choices.ads.customers.find((c) => c.customerId === selection.adsCustomerId)
  if (!customer) throw new GoogleSelectionError(409, 'not_offered', NOT_OFFERED_ADS)
  const manager = selection.managerCustomerId ? customer.managers.find((m) => m.customerId === selection.managerCustomerId) : null
  if (selection.managerCustomerId && !manager) {
    throw new GoogleSelectionError(409, 'not_offered', 'This Google Ads account is not reached through that manager account. Choose the manager again.')
  }
  if (!selection.managerCustomerId && !customer.direct) {
    throw new GoogleSelectionError(409, 'not_offered', 'This sign-in reaches this Google Ads account only through a manager account. Choose the manager account too.')
  }
  const merchant = selection.merchantCenterId ? choices.merchantCenter.accounts.find((a) => a.id === selection.merchantCenterId) : null
  if (selection.merchantCenterId && !merchant) {
    throw new GoogleSelectionError(409, 'not_offered', 'Google does not offer this Merchant Center account to this sign-in. Reload the list and choose again.')
  }
  const property = selection.analyticsPropertyId ? choices.analytics.properties.find((p) => p.propertyId === selection.analyticsPropertyId) : null
  if (selection.analyticsPropertyId && !property) {
    throw new GoogleSelectionError(409, 'not_offered', 'Google does not offer this Google Analytics property to this sign-in. Reload the list and choose again.')
  }

  // One Google Ads account per business (L6): a business whose other, still connected, Google sign-in holds the choice
  // changes it there (or disconnects that sign-in) first. Never names anything of another business.
  const existing = await prisma.googleAccountLink.findMany({ include: { connection: { select: { isActive: true } } } })
  const heldElsewhere = existing.find((link) => link.product === PRODUCT.ads && link.connectionId !== connectionId && link.connection.isActive)
  if (heldElsewhere) {
    throw new GoogleSelectionError(409, 'customer_taken', 'This business already reads a Google Ads account through another Google sign-in. Change the choice there, or disconnect that sign-in first.')
  }

  const before = new Map(existing.map((link) => [link.product, link]))
  const same = (product: string, externalId: string | null, loginCustomerId: string | null = null) => {
    const link = before.get(product)
    if (!externalId) return !link
    return !!link && link.connectionId === connectionId && link.externalId === externalId && (link.loginCustomerId ?? null) === loginCustomerId
  }
  const unchanged = same(PRODUCT.ads, customer.customerId, manager?.customerId ?? null)
    && same(PRODUCT.merchant, merchant?.id ?? null)
    && same(PRODUCT.analytics, property?.propertyId ?? null)

  const userId = actor.userId ?? workspaceContext()?.actorUserId ?? 'system'
  if (!unchanged) {
    await prisma.$transaction(async (tx) => {
      await linkRow(tx, PRODUCT.ads, {
        connectionId,
        externalId: customer.customerId,
        loginCustomerId: manager?.customerId ?? null,
        label: customer.name ?? 'Unnamed Google Ads account',
        metadata: { name: customer.name, currency: customer.currency, timeZone: customer.timeZone, isTest: customer.isTest, managerName: manager?.name ?? null },
        selectedByUserId: userId,
      })
      if (merchant) {
        await linkRow(tx, PRODUCT.merchant, { connectionId, externalId: merchant.id, loginCustomerId: null, label: merchant.name ?? 'Unnamed Merchant Center account', metadata: { name: merchant.name }, selectedByUserId: userId })
      } else {
        await tx.googleAccountLink.deleteMany({ where: { product: PRODUCT.merchant } })
      }
      if (property) {
        await linkRow(tx, PRODUCT.analytics, {
          connectionId, externalId: property.propertyId, loginCustomerId: null, label: property.name ?? 'Unnamed Google Analytics property',
          metadata: { name: property.name, accountName: property.accountName }, selectedByUserId: userId,
        })
      } else {
        await tx.googleAccountLink.deleteMany({ where: { product: PRODUCT.analytics } })
      }
      await ensureGoogleAdsCustomer({
        connectionId, customerId: customer.customerId, loginCustomerId: manager?.customerId ?? null,
        descriptiveName: customer.name, currencyCode: customer.currency, timeZone: customer.timeZone, testAccount: customer.isTest,
      }, tx)
      await recordConnectionEventInTx(tx, {
        connectionId,
        channelKey: 'GOOGLE',
        type: 'accounts_linked',
        actor: { kind: 'operator', userId: actor.userId ?? workspaceContext()?.actorUserId ?? null },
        detail: {
          googleAds: customer.name ?? 'Unnamed Google Ads account',
          adsCustomerId: customer.customerId,
          throughManager: manager ? manager.name ?? 'a manager account' : 'no (direct access)',
          managerCustomerId: manager?.customerId ?? null,
          merchantCenter: merchant ? merchant.name ?? 'Unnamed Merchant Center account' : 'none',
          merchantCenterId: merchant?.id ?? null,
          analytics: property ? property.name ?? 'Unnamed Google Analytics property' : 'none',
          analyticsPropertyId: property?.propertyId ?? null,
          previousAdsCustomerId: before.get(PRODUCT.ads)?.externalId ?? null,
        },
      })
    })
  }

  // The first read of an account Nexus has never read is queued now (a second save in the same hour adds nothing).
  const read = (await googleAdsCustomersById([customer.customerId])).get(customer.customerId)
  if (!read?.backfillCompletedAt) {
    const queued = await enqueueGoogleAdsSync({ customerId: customer.customerId, kind: 'BACKFILL' })
    if (!queued.queued) logger.info('[google-accounts] first read not queued', { connectionId, reason: queued.reason })
  }

  const account = (await listGoogleAccounts()).find((a) => a.connectionId === connectionId)
  if (!account) throw new GoogleSelectionError(404, 'not_found', 'This Google sign-in is not connected to this business.')
  return { account }
}

// ── /api/accounts health ─────────────────────────────────────────────────────────────────────────────────────────

/** The Settings › Channels health of each Google sign-in of this business, from its C1 state. */
export async function googleConnectionHealth(): Promise<Map<string, { health: 'ok' | 'warn' | 'error' | 'unknown'; healthReason: string | null }>> {
  const out = new Map<string, { health: 'ok' | 'warn' | 'error' | 'unknown'; healthReason: string | null }>()
  for (const account of await listGoogleAccounts()) {
    switch (account.state) {
      case 'choose_account': out.set(account.connectionId, { health: 'warn', healthReason: 'Choose a Google Ads account' }); break
      case 'permission_missing': out.set(account.connectionId, { health: 'warn', healthReason: account.stateText }); break
      case 'first_read_pending': out.set(account.connectionId, { health: 'unknown', healthReason: account.stateText }); break
      case 'read_failed':
      case 'sign_in_needed': out.set(account.connectionId, { health: 'error', healthReason: account.stateText }); break
      case 'ok': out.set(account.connectionId, account.read.lastError ? { health: 'warn', healthReason: account.stateText } : { health: 'ok', healthReason: null }); break
    }
  }
  return out
}
