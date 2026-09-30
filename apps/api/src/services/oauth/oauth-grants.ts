/**
 * MCP.6 — Connected apps: the Claude connections (OAuthGrant) a person can see and end.
 *
 *   mine       the person's own live connections, in every business they still belong to. A
 *              business they left or that was archived is not shown: a token cannot reach it.
 *   business   every live connection in one business, with the person who made it, for whoever
 *              may manage its sessions (sessions.manage). People who have left are shown too,
 *              marked, so an admin can still end what they connected.
 *   revoke     the person ends their own; an admin ends any in their business. A connection the
 *              caller may not see answers "not found", never "forbidden": its existence stays private.
 *
 * Revoking goes through revokeGrant: the connection and all its tokens end in one transaction,
 * verifyAccessToken refuses them on the very next call (it keeps no cache), and WorkspaceAudit
 * records who did it. The OAuth tables have no row-level policy, so every query here names its
 * person or business itself. Nothing here depends on NEXUS_MCP_ENABLED: ending access must work
 * while MCP is switched off.
 */

import type { Prisma } from '@prisma/client'
import prisma from '../../db.js'
import { FEATURES } from '@nexus/shared/permissions'
import { hasPermission, type ResolvedPermissions } from '../../lib/auth/rbac.js'
import { MCP_SCOPES, mcpEnabled, mcpWorkspaceAllowList, type McpScope } from './oauth-config.js'
import { revokeGrant } from './oauth-server.js'

export class ConnectedAppError extends Error {
  constructor(
    readonly code: 'not_found' | 'forbidden',
    message: string,
    readonly statusCode: number,
  ) {
    super(message)
    this.name = 'ConnectedAppError'
  }
}

const notFound = () => new ConnectedAppError('not_found', 'This connection does not exist or has already ended.', 404)

/** One connection as the web shows it. No token, code, redirect URI or client document leaves here. */
export interface ConnectedApp {
  id: string
  /** The name the app registered with. */
  appName: string
  /** Where the app returns after sign-in (claude.ai, localhost…): tells apps of one name apart. */
  appHosts: string[]
  businessId: string
  businessName: string
  scopes: McpScope[]
  createdAt: Date
  lastUsedAt: Date | null
  /** The business view only: who connected it, and whether they are still an active member. */
  person?: { name: string | null; email: string; active: boolean }
}

/** A caller the verified workspace hook (or the legacy resolver) placed in one business. */
export interface BusinessAdmin {
  userId: string
  workspaceId: string
  permissions: ResolvedPermissions
}

const grantSelect = {
  id: true,
  userId: true,
  workspaceId: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  client: { select: { clientName: true, redirectUris: true } },
  workspace: { select: { name: true } },
} satisfies Prisma.OAuthGrantSelect

type GrantRow = Prisma.OAuthGrantGetPayload<{ select: typeof grantSelect }>

function hostsOf(redirectUris: string[]): string[] {
  const hosts = new Set<string>()
  for (const uri of redirectUris) {
    try {
      hosts.add(new URL(uri).hostname)
    } catch {
      // A registered URI always parses (oauth-clients.ts checks it); skip rather than fail a list.
    }
  }
  return [...hosts]
}

function toConnectedApp(row: GrantRow): ConnectedApp {
  return {
    id: row.id,
    appName: row.client.clientName,
    appHosts: hostsOf(row.client.redirectUris),
    businessId: row.workspaceId,
    businessName: row.workspace.name,
    scopes: row.scopes.filter((scope): scope is McpScope => (MCP_SCOPES as readonly string[]).includes(scope)),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }
}

/** A live connection of this person, in a business they are still an active member of. */
const mineWhere = (userId: string): Prisma.OAuthGrantWhereInput => ({
  userId,
  revokedAt: null,
  workspace: { status: 'active', memberships: { some: { userId, status: 'active' } } },
})

function assertCanManage(admin: BusinessAdmin): void {
  if (!hasPermission(admin.permissions, FEATURES.sessionsManage)) {
    throw new ConnectedAppError('forbidden', 'Managing connected apps needs the sessions.manage permission in this business.', 403)
  }
}

/** The person's own live connections, newest first. */
export async function listMyConnectedApps(userId: string): Promise<ConnectedApp[]> {
  const rows = await prisma.oAuthGrant.findMany({
    where: mineWhere(userId),
    select: grantSelect,
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  })
  return rows.map(toConnectedApp)
}

/** Every live connection in the admin's business, with the person who made it. */
export async function listBusinessConnectedApps(admin: BusinessAdmin): Promise<ConnectedApp[]> {
  assertCanManage(admin)
  const rows = await prisma.oAuthGrant.findMany({
    where: { workspaceId: admin.workspaceId, revokedAt: null },
    select: {
      ...grantSelect,
      user: {
        select: {
          displayName: true,
          email: true,
          status: true,
          workspaceMemberships: { where: { workspaceId: admin.workspaceId }, select: { status: true } },
        },
      },
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
  })
  return rows.map((row) => ({
    ...toConnectedApp(row),
    person: {
      name: row.user.displayName.trim() || null,
      email: row.user.email,
      active: row.user.status === 'active' && row.user.workspaceMemberships.some((m) => m.status === 'active'),
    },
  }))
}

/**
 * MCP.12 — whether Claude can put a request in this business's Approvals page, and how many live connections could:
 * the Approvals page's "nothing is waiting" line names it beside the scheduled checks, read rather than asserted.
 * `enabled` is MCP switched on and this business allowed by the rollout list. Counts only; no person is named.
 */
export async function claudeConnectionState(workspaceId: string): Promise<{ enabled: boolean; connections: number }> {
  const allow = mcpWorkspaceAllowList()
  const enabled = mcpEnabled() && (allow === null || allow.has(workspaceId))
  const connections = await prisma.oAuthGrant.count({ where: { workspaceId, revokedAt: null } })
  return { enabled, connections }
}

/** The person ends one of their own connections. */
export async function revokeMyConnectedApp(userId: string, grantId: string): Promise<void> {
  const grant = await prisma.oAuthGrant.findFirst({ where: { id: grantId, ...mineWhere(userId) }, select: { id: true } })
  if (!grant) throw notFound()
  // False = it ended between the read and now (another tab, an admin): gone either way.
  if (!(await revokeGrant(grant.id, 'person', userId))) throw notFound()
}

/** An admin ends a connection in their business; their own counts as the person's. */
export async function revokeBusinessConnectedApp(admin: BusinessAdmin, grantId: string): Promise<void> {
  assertCanManage(admin)
  const grant = await prisma.oAuthGrant.findFirst({
    where: { id: grantId, workspaceId: admin.workspaceId, revokedAt: null },
    select: { id: true, userId: true },
  })
  if (!grant) throw notFound()
  const reason = grant.userId === admin.userId ? 'person' : 'admin'
  if (!(await revokeGrant(grant.id, reason, admin.userId))) throw notFound()
}
