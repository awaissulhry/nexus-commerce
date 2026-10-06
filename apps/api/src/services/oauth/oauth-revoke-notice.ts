/**
 * ADS AUTONOMY W4-2 — a Claude connection ended because a refresh token was presented twice (refresh_reuse,
 * oauth-server.ts `revokeForReuse`) is said at once to the person whose connection it was: one danger notice in their
 * bell and one e-mail (claude-alerts.service.ts). Without it a scheduled Claude run (a claude.ai routine) just stops
 * reaching Nexus, and nobody knows until the watchdog misses the day's report.
 *
 * Called after the revoking transaction commits, never inside it, and only when that transaction ended the connection
 * (a second reuse of an already ended one says nothing again). Runs inside the connection's own business (the notice
 * is row-level secured to it). Never throws: the token answer goes out whatever happens here.
 */

import prisma from '../../db.js'
import { withWorkspace } from '../../lib/workspace-context.js'
import { logger } from '../../utils/logger.js'
import { alertPerson } from '../agents/claude-alerts.service.js'

export const CONNECTION_REVOKED_NOTICE_TYPE = 'claude-connection-revoked'

export async function noticeConnectionRevoked(
  grant: { id: string; workspaceId: string; userId: string; client?: { clientName?: string | null } | null },
  detail: { endedByRetry?: boolean } = {},
): Promise<void> {
  try {
    await withWorkspace({ workspaceId: grant.workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
      const business = await prisma.workspace.findUnique({ where: { id: grant.workspaceId }, select: { name: true } }).catch(() => null)
      const app = grant.client?.clientName?.trim() || 'Claude'
      const where = business?.name ? ` for ${business.name}` : ''
      await alertPerson(grant.userId, {
        type: CONNECTION_REVOKED_NOTICE_TYPE,
        title: `Nexus ended your Claude connection${where}`,
        body: `The connection "${app}" presented a sign-in key (a refresh token) that had already been used, so Nexus ended it: a copy of the key may exist. Nothing reaches Nexus through it any more.\n`
          + 'If a scheduled Claude run uses it, reconnect it (claude.ai, Settings, Connectors) and approve with your authenticator code. Connected apps: Settings, Security in Nexus.',
        href: '/settings/security',
        meta: { grantId: grant.id, reason: 'refresh_reuse', ...(detail.endedByRetry ? { endedByRetry: true } : {}) },
      })
    })
  } catch (error) {
    logger.warn('[oauth] could not tell the person their connection was ended', { grantId: grant.id, error: String(error).slice(0, 140) })
  }
}
