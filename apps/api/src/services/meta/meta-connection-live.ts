/**
 * Meta ads, step 1 — what meta-connection reads LIVE from Meta (GET only, through the gateway), beside what Nexus keeps.
 * Nothing here stores anything: a live token check is answered, never kept (the heartbeat and "Check now" keep theirs).
 *
 * Checked 2026-10-20 (developers.facebook.com and Meta's Python Business SDK v26.0.2, facebook_business/adobjects):
 *   - GET /debug_token (graph-api/reference/debug_token) — with the app token
 *   - GET /me/permissions (graph-api/reference/user/permissions): data[] { permission, status granted|declined }
 *   - GET /{app_id}/roles (SDK application.py get_roles): data[] { user, role } — with the app token
 *   - GET /{app_id}/authorized_adaccounts?business= (SDK application.py get_authorized_ad_accounts; not on a doc page
 *     today: VERIFIED-SDK only) — live-probe fix ACC-038 (2026-10-26): with the business's SYSTEM-USER token, not the app
 *     token (Meta answered the app token (#102) "A user access token is required to request this resource"); an ad
 *     account another business in Nexus uses is its id and the flag only
 *   - the app's connected client businesses are NOT read: Meta's v26 reference for application/connected_client_businesses
 *     says of Reading "You can't perform this operation on this endpoint" (checked 2026-10-26, docs/graph-api/reference/
 *     application/connected_client_businesses), although SDK v26.0.2 application.py has get_connected_client_businesses
 *     (GET /connected_client_businesses); Meta refused that read live to the APP token (#3 "Application does not have the
 *     granular permission to make this API call", ACC-038) — the system-user token is untried (LIVE-PROBES ACC-038b):
 *     the answer says so in words (CLIENT_BUSINESSES_NOT_READ)
 *   (GET /{user_id}/assigned_applications needs manage_app_solution, which a system user cannot hold: not read here.)
 *   - the usage headers of an ordinary answer (cx/rate-readings.ts metaUsageOf)
 */
import { metaCall, type MetaQueryValue } from '../gateway/meta.js'
import { GatewayNoAnswer, GatewayRefusal, type GatewayResponse } from '../gateway/gateway.js'
import { metaUsageOf, type MetaUsage } from '../cx/rate-readings.js'
import { checkMetaToken, MetaTokenCheckError, type MetaTokenHealth } from '../cx/connectors/meta/token-check.js'
import { getAccessToken, metaAppIdOf } from '../cx/token.service.js'
import { metaGraphApiVersion } from './api-version.js'
import { takenIds } from '../marketing/meta-ads/taken.js'

export class MetaLiveError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MetaLiveError'
  }
}

/** One live GET; its body, or a sentence. */
async function read(connectionId: string, operation: string, path: string, query: Record<string, MetaQueryValue>, auth: 'account' | 'app' = 'account'): Promise<{ body: Record<string, unknown>; answer: GatewayResponse }> {
  let answer: GatewayResponse
  try {
    answer = await metaCall({ connectionId, operation, path, query, auth, timeoutMs: 30_000 })
  } catch (err) {
    if (err instanceof GatewayRefusal || err instanceof GatewayNoAnswer) throw new MetaLiveError(err.message)
    throw err
  }
  if (answer.status === 0) throw new MetaLiveError('Meta did not answer.')
  if (!answer.ok) throw new MetaLiveError(`Meta refused (${answer.verdict?.channelCode ?? answer.status})${answer.verdict?.channelMessage ? `: ${answer.verdict.channelMessage}` : '.'}`)
  return { body: answer.json<Record<string, unknown>>() ?? {}, answer }
}

const list = (body: Record<string, unknown>): Record<string, unknown>[] => (Array.isArray(body.data) ? body.data.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object') : [])

export interface MetaLiveCheck {
  token: MetaTokenHealth | null
  tokenError: string | null
  /** The usage Meta reported on a cheap read made just now, and what it was. */
  usage: MetaUsage | null
  usageReadOn: string | null
  usageError: string | null
  apiVersion: string
}

/** The token as Meta sees it now, and the usage headers of one cheap read (the chosen ad account, else `me`). */
export async function liveConnectionCheck(connectionId: string, adAccountId: string | null): Promise<MetaLiveCheck> {
  let token: MetaTokenHealth | null = null
  let tokenError: string | null = null
  try {
    token = await checkMetaToken({ token: await getAccessToken(connectionId), connectionId, expectedAppId: await metaAppIdOf(connectionId) })
  } catch (err) {
    tokenError = err instanceof MetaTokenCheckError || err instanceof Error ? err.message : String(err)
  }
  let usage: MetaUsage | null = null
  let usageError: string | null = null
  const probe = adAccountId ? { path: `act_${adAccountId}`, query: { fields: 'account_id' }, what: 'the chosen ad account' } : { path: 'me', query: { fields: 'id' }, what: 'the system user' }
  try {
    const { answer } = await read(connectionId, 'connection.usage', probe.path, probe.query)
    usage = metaUsageOf(answer.headers)
  } catch (err) {
    usageError = err instanceof Error ? err.message : String(err)
  }
  return { token, tokenError, usage, usageReadOn: probe.what, usageError, apiVersion: metaGraphApiVersion() }
}

/** The permissions the token holds, granted or declined (/me/permissions). */
export async function livePermissions(connectionId: string) {
  const { body } = await read(connectionId, 'connection.permissions', 'me/permissions', { limit: 100 })
  return list(body).map((p) => ({ permission: String(p.permission ?? ''), status: String(p.status ?? '') })).filter((p) => p.permission)
}

/** ACC-038 — why the app's connected client businesses are not read (Meta's v26 reference and Meta's own refusal). */
export const CLIENT_BUSINESSES_NOT_READ = 'Nexus does not read the app\'s connected client businesses: Meta\'s v26 reference offers no read of them (application/connected_client_businesses: "You can\'t perform this operation on this endpoint"), although Meta\'s Python SDK v26 has a getter for it (get_connected_client_businesses); Meta refused that read to the app\'s own token (#3: "Application does not have the granular permission to make this API call"), and it has not been tried with the business\'s system-user token. The businesses an app serves as a tech provider show in the App Dashboard (a person).'

/** The app: its roles, the ad accounts it is authorised for in the business, and why its client businesses are not read. */
export async function liveApp(connectionId: string, businessId: string | null) {
  const appId = await metaAppIdOf(connectionId)
  if (!appId) throw new MetaLiveError('No Meta app id is stored for this connection.')
  const part = async <T>(work: () => Promise<T>): Promise<{ items: T | null; error: string | null }> => {
    try { return { items: await work(), error: null } } catch (err) { return { items: null, error: err instanceof Error ? err.message : String(err) } }
  }
  const roles = await part(async () => list((await read(connectionId, 'app.roles', `${appId}/roles`, { limit: 100 }, 'app')).body)
    .map((r) => ({ userId: r.user == null ? null : String(r.user), role: typeof r.role === 'string' ? r.role : null })))
  // ACC-038 — the business's system-user token ('account'): Meta answers this edge to a user token only (#102 to the app's).
  const authorizedAdAccounts = businessId
    ? await part(async () => {
      const rows = list((await read(connectionId, 'app.authorizedAdAccounts', `${appId}/authorized_adaccounts`, { business: businessId, fields: 'account_id,name', limit: 100 })).body)
        .map((a) => ({ adAccountId: String(a.account_id ?? a.id ?? '').replace(/^act_/, ''), name: typeof a.name === 'string' ? a.name : null }))
        .filter((a) => /^\d{1,25}$/.test(a.adAccountId))
      // An ad account another business in Nexus uses is its id and the flag only (never its name).
      const taken = await takenIds('AD_ACCOUNT', rows.map((a) => a.adAccountId))
      return rows.map((a) => (taken.has(a.adAccountId) ? { adAccountId: a.adAccountId, takenByAnotherBusiness: true } : { ...a, takenByAnotherBusiness: false }))
    })
    : { items: null, error: 'The chosen ad account names no business portfolio, so this list cannot be asked for.' }
  const clientBusinesses = { items: null, error: CLIENT_BUSINESSES_NOT_READ }
  return { appId, roles, authorizedAdAccounts, clientBusinesses }
}
