/**
 * Meta ads, step 1 (2026-10-20) — meta-connection: the business's Meta connection, read only.
 *
 *   view summary (default)  what Nexus keeps, no Meta call: the system user, the app id (never the secret), the token's
 *                           health from the last check (valid, expiry and when Nexus renews it, permissions, type), the
 *                           chosen ad account / Page / Instagram account, the pinned API version (master rows ACC-013,
 *                           ACC-015)
 *   view check              LIVE: debug_token now (ACC-007, ACC-008: with the app token) and the usage Meta reports on
 *                           one cheap read — Business Use Case, ad account and app usage, the access tier, a version
 *                           warning (ACC-016, ACC-018, ACC-019). Nothing is kept
 *   view permissions        LIVE: the permissions the token holds, granted or declined (ACC-011)
 *   view app                LIVE: the app's roles, the ad accounts it is authorised for in the business, its connected
 *                           client businesses (ACC-037, ACC-038, ACC-903; app token)
 * (ACC-900, the apps a user is assigned to, needs manage_app_solution — not a system-user permission: not offered.)
 *
 * Connecting Meta, replacing its credentials and choosing its assets are a person's, in Settings › Channels › Meta: an
 * app secret or a token never travels through a tool (Owner rule). Making, renewing and revoking a token in Meta are
 * the Owner's in Meta Business settings; Nexus renews a 60-day token on its own (token.service.ts renewMetaToken).
 */
import { z } from 'zod'
import { FEATURES as F } from '@nexus/shared/permissions'
import type { AgentTool, ToolResult } from '../tool-types.js'
import { listMetaConnections, type MetaConnection } from '../../meta/meta-accounts.service.js'
import { liveApp, liveConnectionCheck, livePermissions, MetaLiveError } from '../../meta/meta-connection-live.js'
import { metaGraphApiVersion } from '../../meta/api-version.js'

export const META_CONNECTION_VIEWS = ['summary', 'check', 'permissions', 'app'] as const
type View = typeof META_CONNECTION_VIEWS[number]

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : v)

const NOT_CONNECTED = 'Meta is not connected for this business. A person connects it in Settings › Channels › Meta (the Meta app id, app secret and a system-user token); Claude never takes those.'

/** The connection a call is about: the one named, else the one with an ad account chosen, else the first. */
function pick(connections: MetaConnection[], connectionId: string | undefined): MetaConnection | null {
  if (connectionId) return connections.find((c) => c.connectionId === connectionId) ?? null
  return connections[0] ?? null
}

const metaConnection: AgentTool = {
  name: 'meta-connection',
  title: 'Meta connection',
  category: 'settings',
  riskTier: 'low',
  readOnly: true,
  // Views check, permissions and app read Meta live.
  openWorld: true,
  requires: [F.adsView],
  input: z.object({
    view: z.preprocess(lower, z.enum(META_CONNECTION_VIEWS)).default('summary')
      .describe('what to read: summary (what Nexus keeps, no Meta call) | check (token and usage, live) | permissions (live) | app (live)'),
    connectionId: z.string().trim().min(1).max(64).optional().describe('the Meta connection (from a previous answer); default: this business\'s one'),
  }),
  description:
    'The business\'s Meta (Facebook + Instagram ads) connection, read only. view summary (default, no Meta call): the '
    + 'system user, the Meta app id (never the secret), the token\'s health from the last check — valid, expiry and when '
    + 'Nexus renews it, the permissions it carries and those it lacks with what each is for, the token type ("not '
    + 'reported" when Meta does not say) — the chosen ad account, Facebook Page and Instagram account, and the pinned Meta '
    + 'API version. check: debug_token now and the usage Meta reports on one cheap read (Business Use Case, ad account '
    + 'and app usage in percent, the access tier, a version warning). permissions: granted and declined permissions. app: '
    + 'the app\'s roles, the ad accounts it is authorised for in the business portfolio, its connected client businesses. '
    + 'Connecting Meta, replacing its credentials and choosing '
    + 'its assets are a person\'s in Settings › Channels › Meta; Claude never takes an app secret or a token. Nexus only '
    + 'reads Meta for now.',
  async handler(args): Promise<ToolResult> {
    const view = (args.view ?? 'summary') as View
    const connections = await listMetaConnections()
    const connection = pick(connections, typeof args.connectionId === 'string' ? args.connectionId : undefined)
    if (!connection) {
      return args.connectionId
        ? { ok: false, error: 'No Meta connection of this business has that id. Read view summary for the right one.' }
        : { ok: true, data: { connected: false, sentence: NOT_CONNECTED, apiVersion: metaGraphApiVersion() } }
    }
    if (view === 'summary') return { ok: true, data: { connected: true, apiVersion: metaGraphApiVersion(), connection, others: connections.length - 1 } }
    try {
      if (view === 'check') {
        const live = await liveConnectionCheck(connection.connectionId, connection.adAccount?.adAccountId ?? null)
        return { ok: true, data: { source: 'Read live from Meta now; nothing was kept.', connectionId: connection.connectionId, ...live } }
      }
      if (view === 'permissions') {
        const permissions = await livePermissions(connection.connectionId)
        return { ok: true, data: { source: 'Read live from Meta now.', connectionId: connection.connectionId, granted: permissions.filter((p) => p.status === 'granted').map((p) => p.permission), declined: permissions.filter((p) => p.status !== 'granted') } }
      }
      if (view === 'app') {
        return { ok: true, data: { source: 'Read live from Meta now, with the app\'s own token.', connectionId: connection.connectionId, ...(await liveApp(connection.connectionId, connection.adAccount?.businessId ?? null)) } }
      }
      return { ok: false, error: 'Unknown view.' }
    } catch (err) {
      if (err instanceof MetaLiveError) return { ok: false, error: err.message }
      throw err
    }
  },
}

export const META_ADS_CONNECTION_TOOLS: AgentTool[] = [metaConnection]
