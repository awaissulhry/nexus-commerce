/**
 * Shopify marketing consent → Nexus (2026-10-26; Owner decision D8, follow-up (a) of the Meta ads build, the Owner's
 * picks: buyers only — at least one Shopify order, any date —, e-mail only, a customers/redact notice deletes the row).
 *
 * Why: a Meta customer list may hold only buyers who said yes to the business's e-mail marketing (D8), and until now
 * Nexus held no buyer consent at all. This copies Shopify's state into ShopifyMarketingConsent. NOTHING here sends
 * anything to Meta or changes the shop; a later step reads the table for its uploads.
 *
 * Privacy: the e-mail is hashed the moment it is read (lib/customer-email-hash.ts: trim, lower case, SHA-256 — the
 * normalisation a Meta customer list needs) and only the hash is stored in this table; no plain address is logged or
 * answered, and a person reads counts only. The inbound ledger keeps each consent delivery as Shopify sent it (with
 * the plain address) only until it is handled: finishing it as done clears its body (cx/ingress/claims.ts
 * CLEAR_BODY_WHEN_DONE), so after that no plain address of anyone is kept, buyer or not.
 *
 * Own accounts only: a Shopify account another business shares with this one is never read or written here (its
 * customers' consent belongs to the business that owns the shop); the backfill refuses it, the webhook and the order
 * read ignore it, and the foreign key's reference guard refuses a row that names another business's account. A reader
 * of this table (PR 2's uploads) must take only the rows of active Shopify accounts this business owns: the rows of an
 * account that was disconnected or uninstalled stay until a person decides (no purge on app/uninstalled yet).
 *
 * Three writers, one rule (`writeConsent`): the row of one Shopify customer of one Shopify account is created, or
 * changed only by a write whose consent time is not older than the stored one (Shopify does not deliver webhooks in
 * order, and a backfill page may be read while a webhook lands); a "no" without a time still replaces a "yes" (the
 * safe direction). Rows exist for buyers only:
 *   1. the backfill a person runs (`backfillShopifyMarketingConsent`): every Shopify customer, page by page through the
 *      read-only admin reader (the channel gateway), paced by Shopify's cost bucket; a customer with no order is skipped
 *      in memory and nothing of it is kept. Resumable: a run cut short answers `resumeAfter`, the next run starts there;
 *      running it again from the start is safe (the same rows, the same rule);
 *   2. the webhook customers_email_marketing_consent/update (`handleEmailConsentWebhook`): it changes the row of a
 *      customer Nexus has, or makes one for a buyer Nexus knows (a Shopify order in Nexus with that e-mail); anyone else
 *      is ignored and gets no row (their delivery's stored body is cleared once handled, as every one of this topic) —
 *      their consent is read at their first order. A customer whose customers/redact this account already received
 *      never gets a row again from a late or replayed delivery;
 *   3. a buyer's first Shopify order (`captureBuyerConsentAtOrder`, after orders/create): when the customer has no row
 *      yet, Nexus reads that ONE customer's consent from Shopify. This covers the buyer whose consent webhook came before
 *      the order (ignored then), and the earlier newsletter subscriber who buys later (no consent change, so no webhook).
 * customers/redact deletes the customer's row (`redactShopifyMarketingConsent`).
 */
import prisma from '../../db.js'
import { emailSha256, normalisedEmail } from '../../lib/customer-email-hash.js'
import { logger } from '../../utils/logger.js'
import { isOwnConnection, NoConnectionError, resolveConnection } from '../connection-resolver.service.js'
import { shopifyAdminReader } from './admin-client.js'

/** Shopify's e-mail marketing states (CustomerEmailAddressMarketingState; webhooks send them in lower case). */
export const EMAIL_MARKETING_STATES = ['SUBSCRIBED', 'NOT_SUBSCRIBED', 'PENDING', 'UNSUBSCRIBED', 'INVALID', 'REDACTED'] as const
export type ConsentSource = 'backfill' | 'webhook' | 'order'

/** The Shopify scope every read here needs (the consent webhook topic needs it too). */
export const CONSENT_SCOPE = 'read_customers'
/** Shopify lists only write_x when both are granted (write_x implies read_x, as cx/catalog.ts scopeDriftOf reads it). */
export const CONSENT_SCOPES_ACCEPTED = ['read_customers', 'write_customers'] as const
/** Shopify's largest page; a page of these fields costs about 2 + 250 × 2, under Shopify's 1,000 per query. */
export const CONSENT_PAGE_SIZE = 250
const DEFAULT_MAX_PAGES = 20
const DEFAULT_MAX_WAIT_MS = 60_000

/** A refusal or failure with the HTTP status the route answers with. */
export class MarketingConsentError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message)
    this.name = 'MarketingConsentError'
  }
}

// ── reading Shopify's values ────────────────────────────────────────────────────────────────────────────────────────

/**
 * Shopify's customer id as digits: a number (a webhook body), digits, or a Customer GID (GraphQL). Null for anything
 * else, and for a number past 2^53 — JSON has already rounded it, and a rounded id would name another customer.
 */
export function shopifyCustomerIdOf(raw: unknown): string | null {
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? String(raw) : null
  if (typeof raw !== 'string') return null
  const digits = /^gid:\/\/shopify\/Customer\/(\d{1,20})$/.exec(raw)?.[1] ?? (/^\d{1,20}$/.test(raw) ? raw : null)
  return digits && !/^0+$/.test(digits) ? digits : null
}

const upperOf = <T extends string>(raw: unknown, allowed: readonly T[]): T | null => {
  if (typeof raw !== 'string') return null
  const value = raw.trim().toUpperCase()
  return (allowed as readonly string[]).includes(value) ? (value as T) : null
}
export const consentStateOf = (raw: unknown) => upperOf(raw, EMAIL_MARKETING_STATES)

/** An ISO time Shopify sent, or null (none, or not a time). */
export function consentTimeOf(raw: unknown): Date | null {
  if (typeof raw !== 'string' || !raw.trim()) return null
  const at = Date.parse(raw)
  return Number.isFinite(at) ? new Date(at) : null
}

// ── the one write rule ──────────────────────────────────────────────────────────────────────────────────────────────

export interface ConsentWrite {
  connectionId: string
  shopifyCustomerId: string
  emailSha256: string
  emailState: (typeof EMAIL_MARKETING_STATES)[number]
  emailConsentAt: Date | null
  source: ConsentSource
}

export type ConsentWriteOutcome = 'created' | 'updated' | 'kept'

/**
 * Create the customer's row, or change it unless the stored consent is newer than this write's. A write without a
 * consent time (Shopify gives none for a consent that never changed) changes a row that has none either; and, the safe
 * direction, a "no" without a time (any state but SUBSCRIBED) also replaces a "yes" — it keeps the row's time, so a
 * later replay of an older "yes" still cannot come back over it. `kept`: the row holds a newer consent, nothing changed.
 */
export async function writeConsent(write: ConsentWrite): Promise<ConsentWriteOutcome> {
  const key = { connectionId: write.connectionId, shopifyCustomerId: write.shopifyCustomerId }
  const notNewer = write.emailConsentAt
    ? { OR: [{ emailConsentAt: null }, { emailConsentAt: { lte: write.emailConsentAt } }] }
    : write.emailState === 'SUBSCRIBED'
      ? { emailConsentAt: null }
      : { OR: [{ emailConsentAt: null }, { emailState: 'SUBSCRIBED' }] }
  const data = {
    emailSha256: write.emailSha256, emailState: write.emailState, source: write.source,
    ...(write.emailConsentAt ? { emailConsentAt: write.emailConsentAt } : {}),
  }
  // Twice at most: a row another writer created between this update and this create is judged once more.
  for (let attempt = 0; attempt < 2; attempt++) {
    const updated = await prisma.shopifyMarketingConsent.updateMany({ where: { ...key, ...notNewer }, data })
    if (updated.count > 0) return 'updated'
    const created = await prisma.shopifyMarketingConsent.createMany({ data: [{ ...key, ...data, emailConsentAt: write.emailConsentAt }], skipDuplicates: true })
    if (created.count > 0) return 'created'
  }
  return 'kept'
}

/**
 * Whether a connection is a Shopify account THIS business owns — not one another business shares with it (row-level
 * security lets a guest business read a shared account). Inactive accounts count: a "no" must still land.
 */
async function ownShopifyConnection(connectionId: string): Promise<boolean> {
  const row = await prisma.channelConnection.findUnique({ where: { id: connectionId }, select: { channelType: true, workspaceId: true } })
  return row !== null && row.channelType === 'SHOPIFY' && isOwnConnection(row)
}

/**
 * Whether this account already received a customers/redact notice for this customer: the notice is in the inbound
 * ledger (Shopify's own body, HMAC-verified, routed to this account). A late or replayed consent delivery must not bring
 * a redacted customer back. Nothing new is stored for this: the notice itself is the marker, for as long as the ledger
 * keeps its body (the privacy policy's webhookEvents days); a consent delivery that old is no longer replayed.
 */
async function redactedOnThisAccount(connectionId: string, shopifyCustomerId: string): Promise<boolean> {
  const asNumber = Number(shopifyCustomerId)
  const notice = await prisma.webhookEvent.findFirst({
    where: {
      channel: 'SHOPIFY', eventType: 'customers/redact', connectionId, signatureOk: true,
      OR: [
        ...(Number.isSafeInteger(asNumber) ? [{ payload: { path: ['customer', 'id'], equals: asNumber } }] : []),
        { payload: { path: ['customer', 'id'], equals: shopifyCustomerId } },
      ],
    },
    select: { id: true },
  })
  return notice !== null
}

/** Whether this customer of this Shopify account already has a row. */
async function hasConsentRow(connectionId: string, shopifyCustomerId: string): Promise<boolean> {
  return (await prisma.shopifyMarketingConsent.count({ where: { connectionId, shopifyCustomerId } })) > 0
}

/** A buyer Nexus knows: a Nexus customer with this e-mail who has a Shopify order in Nexus. */
async function knownShopifyBuyer(email: string): Promise<boolean> {
  const customer = await prisma.customer.findFirst({
    where: { email, orders: { some: { channel: 'SHOPIFY', deletedAt: null } } },
    select: { id: true },
  })
  return customer !== null
}

// ── 2. the webhook customers_email_marketing_consent/update ─────────────────────────────────────────────────────────

export type ConsentWebhookResult = { written: ConsentWriteOutcome } | { ignored: string }

/**
 * One customers_email_marketing_consent/update delivery (HMAC-verified by the receiver, routed to its Shopify account).
 * Body: `customer_id`, `email_address`, `email_marketing_consent {state, opt_in_level, consent_updated_at}` (the opt-in
 * level is not kept: nothing reads it).
 */
export async function handleEmailConsentWebhook(payload: unknown, context?: { connectionId?: string | null }): Promise<ConsentWebhookResult> {
  const connectionId = context?.connectionId ?? null
  if (!connectionId) return { ignored: 'no_account' }
  const body = (payload ?? {}) as { customer_id?: unknown; email_address?: unknown; email_marketing_consent?: { state?: unknown; opt_in_level?: unknown; consent_updated_at?: unknown } | null }
  const shopifyCustomerId = shopifyCustomerIdOf(body.customer_id)
  const email = normalisedEmail(body.email_address)
  const state = consentStateOf(body.email_marketing_consent?.state)
  if (!shopifyCustomerId || !email || !state) {
    logger.warn('[ShopifyConsent] e-mail consent webhook acknowledged, nothing written: it names no usable customer id, e-mail or state', {
      connectionId, hasCustomerId: !!shopifyCustomerId, hasEmail: !!email, hasState: !!state,
    })
    return { ignored: 'unreadable' }
  }
  // The receiver routes a delivery to the business that owns the shop; this holds it there for any other path too.
  if (!(await ownShopifyConnection(connectionId))) return { ignored: 'not_own_account' }
  if (await redactedOnThisAccount(connectionId, shopifyCustomerId)) return { ignored: 'redacted' }
  if (!(await hasConsentRow(connectionId, shopifyCustomerId)) && !(await knownShopifyBuyer(email))) {
    // Not a buyer Nexus knows (yet): they get no row. Should they buy, their first order reads their consent.
    return { ignored: 'not_a_known_buyer' }
  }
  const written = await writeConsent({
    connectionId, shopifyCustomerId, emailSha256: emailSha256(email)!, emailState: state,
    emailConsentAt: consentTimeOf(body.email_marketing_consent?.consent_updated_at), source: 'webhook',
  })
  return { written }
}

// ── 3. a buyer's first Shopify order ────────────────────────────────────────────────────────────────────────────────

/** The one customer read at an order: its default e-mail's consent. Nothing else of the customer is asked. */
export const BUYER_CONSENT_QUERY = `query NexusBuyerConsent($id: ID!) {
  customer(id: $id) { id defaultEmailAddress { emailAddress marketingState marketingUpdatedAt } }
}`

interface ShopifyEmailAddress { emailAddress?: unknown; marketingState?: unknown; marketingUpdatedAt?: unknown }

/** The row a Shopify customer node gives, or why it gives none. */
function consentFromNode(connectionId: string, node: { id?: unknown; defaultEmailAddress?: ShopifyEmailAddress | null } | null | undefined, source: ConsentSource): ConsentWrite | 'unreadable' | 'no_email' {
  const shopifyCustomerId = shopifyCustomerIdOf(node?.id)
  if (!shopifyCustomerId) return 'unreadable'
  const hash = emailSha256(node?.defaultEmailAddress?.emailAddress)
  if (!hash) return 'no_email'
  const state = consentStateOf(node?.defaultEmailAddress?.marketingState)
  if (!state) return 'unreadable'
  return {
    connectionId, shopifyCustomerId, emailSha256: hash, emailState: state,
    emailConsentAt: consentTimeOf(node?.defaultEmailAddress?.marketingUpdatedAt), source,
  }
}

export type BuyerConsentResult = 'no_customer' | 'not_own_account' | 'already_known' | 'no_email' | 'unreadable' | ConsentWriteOutcome

/**
 * After a Shopify order is written: if its customer has no consent row yet, read that customer's consent from Shopify
 * (the read-only admin reader, through the channel gateway) and write it. Called after the order work, never in its
 * way: the caller logs a failure and carries on (a later order, or a run of the backfill, fills the row).
 */
export async function captureBuyerConsentAtOrder(connectionId: string | null | undefined, order: unknown): Promise<BuyerConsentResult> {
  const shopifyCustomerId = shopifyCustomerIdOf((order as { customer?: { id?: unknown } } | null)?.customer?.id)
  if (!connectionId || !shopifyCustomerId) return 'no_customer'
  if (!(await ownShopifyConnection(connectionId))) return 'not_own_account'
  if (await hasConsentRow(connectionId, shopifyCustomerId)) return 'already_known'
  const { read } = await shopifyAdminReader(connectionId)
  const result = await read<{ customer: { id?: unknown; defaultEmailAddress?: ShopifyEmailAddress | null } | null }>(BUYER_CONSENT_QUERY, { id: `gid://shopify/Customer/${shopifyCustomerId}` })
  if (result.errors.length > 0) throw new Error(`Shopify refused the customer consent read: ${result.errors.map((e) => e.message).join('; ').slice(0, 300)}`)
  const write = consentFromNode(connectionId, result.data?.customer, 'order')
  return typeof write === 'string' ? write : writeConsent(write)
}

// ── customers/redact ────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A customers/redact notice (Shopify's privacy topic, HMAC-verified): delete the customer's consent row of this Shopify
 * account — by its Shopify id, and by its e-mail's hash should the row name another id. Returns how many rows went.
 * Without an account (the shop no longer routes to a business) nothing can be reached, and nothing is deleted.
 */
export async function redactShopifyMarketingConsent(payload: unknown, context?: { connectionId?: string | null }): Promise<number> {
  const connectionId = context?.connectionId ?? null
  if (!connectionId) return 0
  const customer = ((payload ?? {}) as { customer?: { id?: unknown; email?: unknown } | null }).customer
  const shopifyCustomerId = shopifyCustomerIdOf(customer?.id)
  const hash = emailSha256(customer?.email)
  const matches = [...(shopifyCustomerId ? [{ shopifyCustomerId }] : []), ...(hash ? [{ emailSha256: hash }] : [])]
  if (!matches.length) return 0
  const { count } = await prisma.shopifyMarketingConsent.deleteMany({ where: { connectionId, OR: matches } })
  return count
}

// ── 1. the backfill a person runs ───────────────────────────────────────────────────────────────────────────────────

/**
 * The only document the backfill sends: each customer's id, its order count (to keep buyers only) and its default
 * e-mail's consent. No name, phone, address, note, tag or order.
 */
export const CONSENT_CUSTOMERS_QUERY = `query NexusMarketingConsent($first: Int!, $after: String) {
  customers(first: $first, after: $after, sortKey: ID) {
    pageInfo { hasNextPage endCursor }
    nodes { id numberOfOrders defaultEmailAddress { emailAddress marketingState marketingUpdatedAt } }
  }
}`

export type BackfillStop = 'complete' | 'max_pages' | 'throttled'

export interface ConsentBackfillResult {
  accountId: string
  /** Shopify customers read in this run. */
  customersRead: number
  created: number
  updated: number
  /** Rows that already held a newer consent (a webhook came in meanwhile): unchanged. */
  keptNewer: number
  /** Customers with no Shopify order: nothing of them is kept. */
  skippedNotBuyers: number
  /** Buyers with no e-mail address. */
  skippedNoEmail: number
  /** Customers whose id or consent state Nexus could not read. */
  skippedUnreadable: number
  pages: number
  stoppedBecause: BackfillStop
  complete: boolean
  /** Where the next run starts (`after`) when this one stopped early; null when complete. */
  resumeAfter: string | null
  throttleWaits: number
  waitedMs: number
}

const SIGN_IN_NEEDED = new Set(['disconnected', 'revoked', 'needs_reauth'])

/**
 * The account's ChannelConnection id, once it is shown to be a signed-in Shopify account this business OWNS. A shared
 * account (another business's shop, readable here through its grant) is refused: its customers' consent belongs to the
 * business that owns the shop, and a customers/redact of the shop would never reach a copy kept here.
 */
async function ownSignedInShopifyAccount(accountId: string): Promise<string> {
  let connection: Awaited<ReturnType<typeof resolveConnection>>
  try {
    connection = await resolveConnection({ accountId })
  } catch (error) {
    if (error instanceof NoConnectionError) throw new MarketingConsentError('ACCOUNT_NOT_FOUND', 'No active account with this id in this business.', 404)
    throw error
  }
  if (connection.channelType !== 'SHOPIFY') throw new MarketingConsentError('NOT_SHOPIFY', 'The selected account is not a Shopify account.', 400)
  if (!isOwnConnection(connection)) {
    throw new MarketingConsentError('ACCOUNT_NOT_OWNED', 'This Shopify account belongs to another business that shares it with this one. Consent belongs to the business that owns the shop. Nothing was read.', 403)
  }
  if (SIGN_IN_NEEDED.has(String(connection.authStatus))) {
    throw new MarketingConsentError('ACCOUNT_NEEDS_SIGNIN', 'This Shopify account must be signed in again before its consent can be read. Nothing was read.', 409)
  }
  return connection.id
}

type ConsentPage = {
  customers: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null }
    nodes: Array<{ id?: unknown; numberOfOrders?: unknown; defaultEmailAddress?: ShopifyEmailAddress | null }>
  } | null
}

/** Shopify's numberOfOrders (an UnsignedInt64, sent as a string) as a number, or null. */
function orderCountOf(raw: unknown): number | null {
  const n = typeof raw === 'number' ? raw : typeof raw === 'string' && /^\d{1,20}$/.test(raw) ? Number(raw) : Number.NaN
  return Number.isFinite(n) ? n : null
}

/**
 * Copy the consent of every Shopify buyer of this account into Nexus. Reads Shopify only (no Shopify or Meta write).
 * `after`: the `resumeAfter` of an earlier run. Paced by Shopify's cost bucket: when the bucket cannot pay for the next
 * page it waits for the refill, and stops as `throttled` once the waits would pass `maxWaitMs`.
 */
export async function backfillShopifyMarketingConsent(
  accountId: string,
  opts: { after?: string | null; maxPages?: number; maxWaitMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<ConsentBackfillResult> {
  if (opts.after != null && (typeof opts.after !== 'string' || !opts.after.trim() || opts.after.length > 1000)) {
    throw new MarketingConsentError('BAD_CURSOR', '`after` is the resumeAfter value an earlier run answered.', 400)
  }
  const connectionId = await ownSignedInShopifyAccount(accountId)
  const { read, grantedScopes } = await shopifyAdminReader(connectionId)
  if (grantedScopes.length > 0 && !CONSENT_SCOPES_ACCEPTED.some((scope) => grantedScopes.includes(scope))) {
    throw new MarketingConsentError('SCOPE_MISSING', `This Shopify account has not granted ${CONSENT_SCOPE}, so Nexus cannot read its customers' consent. Nothing was read.`, 409)
  }
  const maxPages = opts.maxPages ?? DEFAULT_MAX_PAGES
  const maxWaitMs = opts.maxWaitMs ?? DEFAULT_MAX_WAIT_MS
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)))
  const out: ConsentBackfillResult = {
    accountId, customersRead: 0, created: 0, updated: 0, keptNewer: 0, skippedNotBuyers: 0, skippedNoEmail: 0, skippedUnreadable: 0,
    pages: 0, stoppedBecause: 'complete', complete: false, resumeAfter: null, throttleWaits: 0, waitedMs: 0,
  }
  const stop = (why: BackfillStop, resumeAfter: string | null): ConsentBackfillResult => ({ ...out, stoppedBecause: why, complete: why === 'complete', resumeAfter })
  let after: string | null = opts.after ?? null

  for (;;) {
    const result = await read<ConsentPage>(CONSENT_CUSTOMERS_QUERY, { first: CONSENT_PAGE_SIZE, after })
    if (result.errors.some((e) => e.extensions?.code === 'THROTTLED')) {
      if (out.pages === 0) throw new MarketingConsentError('SHOPIFY_THROTTLED', 'Shopify is rate-limiting this account right now; nothing was read. Try again in a minute.', 429)
      return stop('throttled', after)
    }
    if (result.errors.some((e) => e.extensions?.code === 'ACCESS_DENIED')) {
      throw new MarketingConsentError('SHOPIFY_ACCESS_DENIED', `Shopify refused to show this account's customers (it needs ${CONSENT_SCOPE} and access to customer e-mail). ${out.pages ? 'The pages before were kept.' : 'Nothing was read.'}`, 403)
    }
    if (result.errors.length > 0 || !result.data?.customers) {
      const messages = result.errors.map((e) => e.message).join('; ').slice(0, 300)
      throw new MarketingConsentError('SHOPIFY_QUERY_FAILED', `Shopify refused the customer read${messages ? `: ${messages}` : ' (no customers field)'}.`, 502)
    }
    const connection = result.data.customers
    out.pages++
    for (const node of connection.nodes ?? []) {
      out.customersRead++
      const orders = orderCountOf(node?.numberOfOrders)
      if (orders === null) { out.skippedUnreadable++; continue }
      if (orders < 1) { out.skippedNotBuyers++; continue }
      const write = consentFromNode(connectionId, node, 'backfill')
      if (write === 'no_email') { out.skippedNoEmail++; continue }
      if (write === 'unreadable') { out.skippedUnreadable++; continue }
      const outcome = await writeConsent(write)
      if (outcome === 'created') out.created++
      else if (outcome === 'updated') out.updated++
      else out.keptNewer++
    }
    if (!connection.pageInfo?.hasNextPage || !connection.pageInfo.endCursor) return stop('complete', null)
    after = connection.pageInfo.endCursor
    // The bound is checked before any wait: never wait for a page that will not be read.
    if (out.pages >= maxPages) return stop('max_pages', after)

    const bucket = result.cost?.throttleStatus
    const needed = result.cost?.requestedQueryCost ?? null
    if (bucket && needed !== null && bucket.currentlyAvailable < needed) {
      const waitMs = Math.ceil(((needed - bucket.currentlyAvailable) / Math.max(bucket.restoreRate, 1)) * 1000)
      if (out.waitedMs + waitMs > maxWaitMs) return stop('throttled', after)
      await sleep(waitMs)
      out.throttleWaits++
      out.waitedMs += waitMs
    }
  }
}

/** For the order path: run the capture, log a failure in words, never throw (the order is already written). */
export async function captureBuyerConsentQuietly(connectionId: string | null | undefined, order: unknown): Promise<void> {
  try {
    await captureBuyerConsentAtOrder(connectionId, order)
  } catch (error) {
    logger.warn('[ShopifyConsent] the buyer\'s consent was not read at this order; a later order or a run of the backfill fills it', {
      connectionId: connectionId ?? null, error: error instanceof Error ? error.message.slice(0, 300) : String(error),
    })
  }
}
