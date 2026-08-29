/**
 * CX.1 — the ConnectionEvent ledger.
 *
 * Every grant, re-consent, adopt, refresh, refresh failure, revoke, disconnect,
 * heartbeat, scope drift and status change is a row here, with who did it.
 * Before CX.1 none of those wrote an audit row (audit S22; prod AuditLog had no
 * connect/oauth action ever). `detail` is passed through the logger's redactor
 * so token material can never land in the ledger by accident.
 *
 * Archive-never-delete (decision 9): rows older than 90 days keep their row and
 * lose only `detail`, which moves to the object-store archive with a pointer in
 * `archivedRef`. Until the bucket exists the archiver is a no-op that logs.
 */

import prisma from '../../db.js'
import { logger, redact } from '../../utils/logger.js'

export type ConnectionEventType =
  | 'grant'
  | 'reconsent'
  | 'adopt'
  | 'refresh'
  | 'refresh_failed'
  | 'revoke'
  | 'disconnect'
  | 'heartbeat_ok'
  | 'heartbeat_failed'
  | 'scope_drift'
  | 'status_change'
  | 'secret_rotated'
  | 'signing_key_created'
  | 'kms_fallback'

export interface Actor {
  userId?: string | null
  /** 'operator' (a signed-in user), 'cron', 'channel' (a channel-side signal), 'system' */
  kind: 'operator' | 'cron' | 'channel' | 'system'
}

export const SYSTEM_ACTOR: Actor = { kind: 'system' }
export const CRON_ACTOR: Actor = { kind: 'cron' }

export async function recordConnectionEvent(input: {
  connectionId?: string | null
  channelKey: string
  type: ConnectionEventType
  actor?: Actor
  detail?: Record<string, unknown>
}): Promise<void> {
  const detail = {
    ...(input.detail ? (redact(input.detail) as Record<string, unknown>) : {}),
    actorKind: input.actor?.kind ?? 'system',
  }
  try {
    await prisma.connectionEvent.create({
      data: {
        connectionId: input.connectionId ?? null,
        channelKey: input.channelKey,
        type: input.type,
        actorUserId: input.actor?.userId ?? null,
        detail,
      },
    })
  } catch (err) {
    // The ledger must never take the operation down with it.
    logger.error('[cx-events] failed to write ConnectionEvent', {
      type: input.type,
      connectionId: input.connectionId ?? null,
      error: err instanceof Error ? err.message : String(err),
    })
  }
}

/** Latest N events for a connection, for the Diagnostics tab. */
export async function listConnectionEvents(connectionId: string, take = 50) {
  return prisma.connectionEvent.findMany({
    where: { connectionId },
    orderBy: { createdAt: 'desc' },
    take,
    select: { id: true, type: true, actorUserId: true, detail: true, createdAt: true },
  })
}
