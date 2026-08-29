/**
 * CX.1 — one-shot credential backfill (docs/2026-08-29-cx1-connection-core.md §9).
 *
 * Encrypts every connection that still holds plaintext tokens into the v2
 * envelope and nulls the plaintext columns in the same UPDATE — after a verified
 * round-trip decrypt. Idempotent: rows that already have `credentialsEnc` are
 * skipped. Triggered from the cron registry (`cx1-credentials-backfill`), never
 * scheduled. `cx1-credentials-restore` is the rollback counterpart.
 */

import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { encryptLegacyRow, restorePlaintextRow } from '../services/cx/token.service.js'
import { recordConnectionEvent } from '../services/cx/events.service.js'

export async function runCredentialsBackfill(): Promise<string> {
  return recordCronRun('cx1-credentials-backfill', async () => {
    const rows = await prisma.channelConnection.findMany({
      where: {
        credentialsEnc: null,
        OR: [{ accessToken: { not: null } }, { ebayAccessToken: { not: null } }, { refreshToken: { not: null } }, { ebayRefreshToken: { not: null } }],
      },
      select: { id: true, channelType: true },
    })
    let encrypted = 0
    let skipped = 0
    let noTokens = 0
    let failed = 0
    for (const r of rows) {
      try {
        const outcome = await encryptLegacyRow(r.id)
        if (outcome === 'encrypted') {
          encrypted++
          await recordConnectionEvent({ connectionId: r.id, channelKey: r.channelType, type: 'status_change', detail: { credentials: 'encrypted', plaintextNulled: true } })
        } else if (outcome === 'no_tokens') noTokens++
        else skipped++
      } catch (err) {
        failed++
        logger.error('[cx1-backfill] row failed; plaintext left in place', { connectionId: r.id, error: err instanceof Error ? err.message : String(err) })
      }
    }
    const summary = `candidates=${rows.length} encrypted=${encrypted} skipped=${skipped} noTokens=${noTokens} failed=${failed}`
    logger.info('[cx1-backfill] complete', { summary })
    return summary
  }, { triggeredBy: 'manual' })
}

export async function runCredentialsRestore(): Promise<string> {
  return recordCronRun('cx1-credentials-restore', async () => {
    const rows = await prisma.channelConnection.findMany({ where: { credentialsEnc: { not: null } }, select: { id: true } })
    let restored = 0
    for (const r of rows) if (await restorePlaintextRow(r.id)) restored++
    return `rows=${rows.length} restored=${restored}`
  }, { triggeredBy: 'manual' })
}
