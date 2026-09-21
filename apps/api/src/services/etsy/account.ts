/**
 * P4.6b — the one place that turns an account id into "which Etsy shop, and with what headers".
 *
 * Both the reader (`read-client.ts`) and the writer (`write-client.ts`) go through here. That is
 * deliberate: the banked lesson from the two column builders is that **two builders of the same
 * thing drift, and the drift is silent**. Etsy already has three spellings of one header in this
 * repo, and one of them is wrong (see `etsyApiKey` below), so a fourth was not an option.
 */
import { resolveConnection } from '../connection-resolver.service.js'
import { getChannelApp } from '../cx/apps.service.js'

export interface EtsyAccount {
  /** The Nexus ChannelConnection id. Every call names it; no Etsy call falls back to "the primary". */
  accountId: string
  /** Etsy's numeric shop id, verified as a positive integer before it can reach a URL. */
  shopId: string
  /** The `x-api-key` header value for this app. */
  apiKey: string
}

/**
 * Etsy's `x-api-key` — **`keystring:shared_secret`**, not the keystring alone.
 *
 * Verified against Etsy's own documentation (2026-09-21, developer.etsy.com → Essentials →
 * Requests): *"Every request to a v3 endpoint must include an `x-api-key` header containing your
 * keystring and shared secret separated by a colon"*, with the example
 * `x-api-key: 1aa2bb33c44d55eeeeee6fff:a1b2c3d4e5`.
 *
 * 🔴 It was worth checking, because this repo holds **three** spellings of this header and they do
 * not agree:
 *
 * | site | value | verdict |
 * |---|---|---|
 * | `etsy/read-client.ts` | `clientId:clientSecret` | ✅ correct |
 * | `cx/connectors/etsy/spec.ts` | `clientId:clientSecret` | ✅ correct |
 * | `marketplaces/etsy.service.ts:273` | **`this.accessToken`** | ❌ the OAuth token in the API-key header |
 *
 * The third is the legacy env-credential service. Every call it makes would be refused by Etsy on
 * the header alone — which is a second reason, beside the missing env token, that its "it works,
 * it is just inert" reading was never tested. It is a P7a deletion candidate; this note is here so
 * the next reader does not copy it.
 */
function etsyApiKey(app: { clientId: string; clientSecret: string }): string {
  return `${app.clientId}:${app.clientSecret}`
}

/**
 * Resolve the account, prove it is Etsy, and prove it has a shop identity.
 *
 * The shop id goes into a URL path, so it is checked as a positive integer rather than trusted:
 * a blank or non-numeric identity would otherwise build `/shops//listings` or worse.
 */
export async function etsyAccount(accountId: string, environment: 'production' | 'sandbox' = 'production'): Promise<EtsyAccount> {
  const connection = await resolveConnection({ accountId })
  if (connection.channelType !== 'ETSY') throw new Error('The selected account is not Etsy.')
  const identity = connection.identity as { extra?: { shopId?: string } } | null
  const shopId = String(identity?.extra?.shopId ?? '')
  if (!/^[1-9]\d*$/.test(shopId)) throw new Error('The Etsy account has no verified shop identity.')
  const app = await getChannelApp('ETSY', environment)
  return { accountId, shopId, apiKey: etsyApiKey(app) }
}

/**
 * A resource path, checked before it becomes a URL. Etsy paths are built from ids that come from
 * our own database, but "our own database" is where a bad id gets stored, not where it stops.
 */
export function assertEtsyPath(path: string): void {
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('://')) {
    throw new Error('Invalid Etsy resource path.')
  }
}

/** The ledger's operation name: the path with its ids replaced, so one row per operation, not per id. */
export function etsyOperation(method: string, path: string): string {
  return `${method} ${path.split('?')[0].replace(/\/\d+(?=\/|$)/g, '/:id')}`
}
