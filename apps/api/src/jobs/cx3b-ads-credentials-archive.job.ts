/**
 * CX.3b step C — remove the eight redundant copies of a live secret.
 *
 * Measured on prod 2026-08-29: nine `AmazonAdsConnection` rows carried **one** distinct
 * encrypted `{clientId, clientSecret, refreshToken}` between them. That is the security
 * finding this whole phase started from. CX.3a put the same credential once on the
 * `AMAZON_ADS` connection as a v2 envelope; this empties the nine columns.
 *
 * ── Why this is "move", not "delete" ─────────────────────────────────────────
 * The credential is not destroyed: the identical refresh token is in the connection's
 * envelope, which every Ads call has been reading since CX.3a. And the inverse job
 * (`cx3b-ads-credentials-restore`) writes the rows back from that envelope, so the
 * `NEXUS_CX_ADS_CREDENTIALS=0` rollback can be made whole again in one trigger.
 *
 * ── What it refuses to do ────────────────────────────────────────────────────
 * It empties a row ONLY after proving that row's own blob decrypts to exactly the
 * credential the envelope holds. A row that disagrees is left alone and reported: a
 * mismatch means one of the two is a credential we did not know about, and deleting an
 * unknown credential is how you lose access to an account.
 *
 * Registry-triggered (`cx3b-ads-credentials-archive` / `-restore`), never scheduled.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { recordConnectionEvent, SYSTEM_ACTOR } from '../services/cx/events.service.js'

interface AdsSecret {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** The credential the connection core holds — the one that stays. */
async function coreCredential(): Promise<{ connectionId: string; secret: AdsSecret } | null> {
  const { tryResolveConnection } = await import('../services/connection-resolver.service.js')
  const conn = await tryResolveConnection({ channel: 'AMAZON_ADS', primary: true })
  if (!conn) return null
  const { readRefreshToken } = await import('../services/cx/token.service.js')
  const { getChannelApp } = await import('../services/cx/apps.service.js')
  const refreshToken = await readRefreshToken(conn.id)
  const app = await getChannelApp('AMAZON_ADS', 'production').catch(() => null)
  if (!refreshToken || !app?.clientId || !app?.clientSecret) return null
  return { connectionId: conn.id, secret: { clientId: app.clientId, clientSecret: app.clientSecret, refreshToken } }
}

function sameSecret(a: AdsSecret, b: AdsSecret): boolean {
  return a.clientId === b.clientId && a.clientSecret === b.clientSecret && a.refreshToken === b.refreshToken
}

export async function runAdsCredentialsArchive(): Promise<string> {
  return recordCronRun('cx3b-ads-credentials-archive', async () => {
    const core = await coreCredential()
    if (!core) return 'the connection core holds no usable Ads credential — refusing to empty any row'

    const rows = await prisma.amazonAdsConnection.findMany({
      where: { credentialsEncrypted: { not: null } },
      select: { profileId: true, credentialsEncrypted: true },
    })
    if (rows.length === 0) return 'already archived — no row holds a credential'

    const { decryptSecret } = await import('../lib/crypto.js')
    let archived = 0
    let mismatched = 0
    let unreadable = 0

    for (const row of rows) {
      let rowSecret: AdsSecret | null = null
      try {
        rowSecret = JSON.parse(decryptSecret(row.credentialsEncrypted!)) as AdsSecret
      } catch {
        unreadable++
        continue
      }
      if (!rowSecret || !sameSecret(rowSecret, core.secret)) {
        // Not ours to remove. A row holding a DIFFERENT credential is a credential the
        // core does not have, and emptying it would lose it.
        mismatched++
        logger.warn('[cx3b] a row holds a credential the core does not — left in place', { profileId: row.profileId })
        continue
      }
      await prisma.amazonAdsConnection.update({
        where: { profileId: row.profileId },
        data: { credentialsEncrypted: null },
      })
      archived++
    }

    if (archived > 0) {
      await recordConnectionEvent({
        connectionId: core.connectionId,
        channelKey: 'AMAZON_ADS',
        type: 'credentials_archived',
        actor: SYSTEM_ACTOR,
        detail: { archived, mismatched, unreadable, note: 'duplicate row copies emptied; the envelope is unchanged' },
      })
    }
    return `rows=${rows.length} archived=${archived} mismatched=${mismatched} unreadable=${unreadable}`
  })
}

/** The inverse: write the rows back from the envelope, restoring the legacy fallback. */
export async function runAdsCredentialsRestore(): Promise<string> {
  return recordCronRun('cx3b-ads-credentials-restore', async () => {
    const core = await coreCredential()
    if (!core) return 'the connection core holds no Ads credential — nothing to restore from'

    const rows = await prisma.amazonAdsConnection.findMany({
      where: { credentialsEncrypted: null },
      select: { profileId: true },
    })
    if (rows.length === 0) return 'every row already holds a credential'

    const { encryptSecret } = await import('../lib/crypto.js')
    const blob = encryptSecret(JSON.stringify(core.secret))
    for (const row of rows) {
      await prisma.amazonAdsConnection.update({
        where: { profileId: row.profileId },
        data: { credentialsEncrypted: blob },
      })
    }
    await recordConnectionEvent({
      connectionId: core.connectionId,
      channelKey: 'AMAZON_ADS',
      type: 'credentials_restored',
      actor: SYSTEM_ACTOR,
      detail: { restored: rows.length },
    })
    return `restored=${rows.length}`
  })
}
