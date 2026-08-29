/**
 * CX.3a — one-shot: adopt the Amazon Ads grant into the connection core (§2, §8).
 *
 * Nine `AmazonAdsConnection` rows carry ONE identical encrypted credential (measured
 * on prod 2026-08-29: 9 rows, 1 distinct blob). This reads that one credential, proves
 * it works with a real Amazon call, and stores it once on the `AMAZON_ADS`
 * `ChannelConnection` as a v2 envelope.
 *
 * It does NOT touch `AmazonAdsConnection`: the nine rows and their blobs stay exactly
 * as they are, because they are the rollback for the credential switch
 * (`NEXUS_CX_ADS_CREDENTIALS=0`). CX.3b nulls them once the core path has a day of
 * green heartbeats behind it.
 *
 * Idempotent: a connection that already holds `credentialsEnc` is skipped. Triggered
 * from the cron registry (`cx3a-ads-credentials`), never scheduled.
 */
import prisma from '../db.js'
import { logger } from '../utils/logger.js'
import { recordCronRun } from '../utils/cron-observability.js'
import { storeGrant } from '../services/cx/token.service.js'
import { getChannelApp } from '../services/cx/apps.service.js'
import { SYSTEM_ACTOR } from '../services/cx/events.service.js'
import { amazonAdsSpec, ADS_REGION_HOSTS } from '../services/cx/connectors/amazon-ads/spec.js'

interface AdsSecret {
  clientId: string
  clientSecret: string
  refreshToken: string
}

/** The one credential the nine rows share. */
async function readLegacyCredential(): Promise<AdsSecret | null> {
  const row = await prisma.amazonAdsConnection.findFirst({
    where: { credentialsEncrypted: { not: null } },
    orderBy: { updatedAt: 'desc' },
    select: { credentialsEncrypted: true },
  })
  if (!row?.credentialsEncrypted) return null
  const { decryptSecret } = await import('../lib/crypto.js')
  try {
    const parsed = JSON.parse(decryptSecret(row.credentialsEncrypted)) as Partial<AdsSecret>
    if (!parsed.clientId || !parsed.clientSecret || !parsed.refreshToken) return null
    return parsed as AdsSecret
  } catch (err) {
    logger.error('[cx3a] the legacy Ads credential could not be decrypted', {
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

/** Prove the credential before storing it — an adopted secret that does not work is worse than none. */
async function exchange(secret: AdsSecret): Promise<{ accessToken: string; expiresInSec: number } | null> {
  const res = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: secret.refreshToken,
      client_id: secret.clientId,
      client_secret: secret.clientSecret,
    }),
  })
  if (!res.ok) {
    logger.error('[cx3a] LWA refused the legacy Ads refresh token', { status: res.status })
    return null
  }
  const body = (await res.json()) as { access_token?: string; expires_in?: number }
  if (!body.access_token) return null
  return { accessToken: body.access_token, expiresInSec: body.expires_in ?? 3600 }
}

export async function runAdsCredentialAdopt(): Promise<string> {
  return recordCronRun('cx3a-ads-credentials', async () => {
    const conn = await prisma.channelConnection.findFirst({
      where: { channelType: 'AMAZON_ADS' },
      select: { id: true, credentialsEnc: true, region: true },
    })
    if (!conn) return 'no AMAZON_ADS connection — run the CX.3a migration first'
    if (conn.credentialsEnc) return 'already adopted — the connection holds an envelope'

    const secret = await readLegacyCredential()
    if (!secret) return 'no usable legacy Ads credential found'

    // The app-level pair belongs to ChannelApp, not to the grant. Seeded at boot from
    // env; if it is absent the adopt still proceeds (the Ads client falls back), but
    // say so, because the core path needs it.
    const app = await getChannelApp('AMAZON_ADS', 'production').catch(() => null)
    if (!app?.clientId) logger.warn('[cx3a] ChannelApp AMAZON_ADS has no clientId — the core credential path will fall back to the row')

    const token = await exchange(secret)
    if (!token) return 'the legacy Ads credential did not exchange — nothing stored'

    // Identity comes from the channel itself, through the spec, so what we record is
    // what Amazon says rather than what a label guessed.
    let identity = null
    try {
      identity = await amazonAdsSpec.identity({
        id: conn.id,
        channelKey: 'AMAZON_ADS',
        channelType: 'AMAZON_ADS',
        region: conn.region ?? 'EU',
        grantedScopes: [],
        identity: null,
        token: async () => token.accessToken,
      })
    } catch (err) {
      logger.warn('[cx3a] identity lookup failed — adopting without it', {
        error: err instanceof Error ? err.message : String(err),
      })
    }

    await storeGrant(
      conn.id,
      {
        accessToken: token.accessToken,
        refreshToken: secret.refreshToken,
        expiresInSec: token.expiresInSec,
        refreshExpiresInSec: 365 * 86_400,
        grantedScopes: amazonAdsSpec.auth.requiredScopes,
        identity,
        region: conn.region ?? 'EU',
      },
      SYSTEM_ACTOR,
      'adopt',
    )

    const regions = Object.keys(ADS_REGION_HOSTS).join(',')
    return `adopted=1 identity=${identity ? 'yes' : 'no'} appClientId=${app?.clientId ? 'yes' : 'no'} regions=${regions}`
  })
}
