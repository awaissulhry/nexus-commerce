/**
 * Switch Shopify order import on for one Shopify account, from now on.
 *
 * `startShopifyOrderImport` is the ONE writer of the account's start date (T0, order-ingest-switch.ts): it records the
 * database clock's whole second the first time it runs for the account, then registers the order webhooks
 * (webhook-registration.service.ts: the order topics, app/uninstalled and the e-mail marketing consent topic). Running it
 * again keeps the first start date and person and only re-registers what is missing, so a registration that failed half
 * way, or a topic added later, is finished by running it again. Orders Shopify created before the start date are never
 * imported.
 *
 * It needs the server switch NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1 (refused before anything is read or written while it is
 * off) and an active, signed-in Shopify account of this business. Nothing here changes stock, orders, listings or
 * products; the only Shopify writes are the subscriptions the registration creates.
 */
import { NoConnectionError, resolveConnection } from '../connection-resolver.service.js'
import { recordShopifyOrderIngestStart, SHOPIFY_ORDER_INGEST_FLAG, SHOPIFY_WEBHOOKS_OFF_CODE, shopifyOrderIngestEnabled, shopifyOrderIngestStart } from './order-ingest-switch.js'
import { ensureShopifyWebhookSubscriptions, type ShopifyRegistrationResult } from './webhook-registration.service.js'

/** A refusal with the HTTP status the route answers with. */
export class ShopifyOrderImportError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode: number) {
    super(message)
    this.name = 'ShopifyOrderImportError'
  }
}

export interface ShopifyOrderImportStatus {
  accountId: string
  /** The server switch (NEXUS_ENABLE_SHOPIFY_ORDER_INGEST=1). */
  switchOn: boolean
  /** The start date (ISO), or null when order import was never started for this account. */
  since: string | null
  by: string | null
}

export interface ShopifyOrderImportStart extends ShopifyOrderImportStatus {
  since: string
  /** False when the account already had its start date: it is kept, never moved. */
  newlyStarted: boolean
  registration: ShopifyRegistrationResult
}

const SIGN_IN_NEEDED = new Set(['disconnected', 'revoked', 'needs_reauth'])

async function shopifyAccount(accountId: string): Promise<void> {
  let connection: Awaited<ReturnType<typeof resolveConnection>>
  try {
    connection = await resolveConnection({ accountId })
  } catch (error) {
    if (error instanceof NoConnectionError) throw new ShopifyOrderImportError('ACCOUNT_NOT_FOUND', 'No active account with this id in this business.', 404)
    throw error
  }
  if (connection.channelType !== 'SHOPIFY') throw new ShopifyOrderImportError('NOT_SHOPIFY', 'The selected account is not a Shopify account.', 400)
  if (SIGN_IN_NEEDED.has(String(connection.authStatus))) {
    throw new ShopifyOrderImportError('ACCOUNT_NEEDS_SIGNIN', 'This Shopify account must be signed in again before order import can start. Nothing was recorded.', 409)
  }
}

/** Read-only: the switch and the account's start date. */
export async function shopifyOrderImportStatus(accountId: string): Promise<ShopifyOrderImportStatus> {
  await shopifyAccount(accountId)
  const start = await shopifyOrderIngestStart(accountId)
  return { accountId, switchOn: shopifyOrderIngestEnabled(), since: start ? start.since.toISOString() : null, by: start?.by ?? null }
}

/** Record the start date once (kept on every later run) and register the order webhooks. */
export async function startShopifyOrderImport(accountId: string, by: string | null): Promise<ShopifyOrderImportStart> {
  if (!shopifyOrderIngestEnabled()) {
    throw new ShopifyOrderImportError(SHOPIFY_WEBHOOKS_OFF_CODE, `Shopify order import is switched off on this server (${SHOPIFY_ORDER_INGEST_FLAG} is not 1). Nothing was recorded and nothing was registered with Shopify.`, 409)
  }
  await shopifyAccount(accountId)
  const start = await recordShopifyOrderIngestStart(accountId, by)
  const registration = await ensureShopifyWebhookSubscriptions(accountId)
  return { accountId, switchOn: true, since: start.since.toISOString(), by: start.by, newlyStarted: start.newlyStarted, registration }
}
