/**
 * P4.5e — the credentials a disconnect does not reach.
 *
 * `token.service.revoke()` nulls every token column **on `ChannelConnection`**. For
 * Amazon Ads that is not where the working secret lives: `AmazonAdsConnection` carries
 * its own `credentialsEncrypted` blob — `{ clientId, clientSecret, refreshToken }` —
 * and `ads-api-client.resolveCredentials` falls back to it whenever the core has no
 * usable grant.
 *
 * 🔴 **After a disconnect, that fallback is exactly the state that fires.** The revoke
 * sets `isActive: false` on the connection, so
 * `resolveConnection({ channel: 'AMAZON_ADS', primary: true })` throws
 * `NoConnectionError`, `credentialsFromCore()` returns null, and the client reads the
 * legacy row's intact refresh token. **Amazon Ads calls continue after the operator
 * disconnects the account** — the plan records it at
 * `services/advertising/ads-api-client.ts:463-491`, and the fallback is doing precisely
 * what it was written to do.
 *
 * Amazon Ads is the only channel with this shape: a census of `credentialsEncrypted` in
 * the schema finds three columns, and the other two (`Carrier`, `CarrierAccount`) are
 * shipping carriers, not channels.
 *
 * ## Why this clears the secret but does NOT deactivate the row
 *
 * With the blob gone and `isActive` left alone, `resolveCredentials` reaches
 * `if (!conn?.credentialsEncrypted) throw` and every ads call **refuses, loudly, naming
 * the profile**. That is the behaviour a disconnect should produce.
 *
 * Deactivating as well would be quieter, and it would make a disconnect irreversible
 * from the connect flow: P4.5b deliberately stopped the reconnect callback reasserting
 * `isActive`, because that is the operator's switch and a reconnect is a credential
 * event. Telling the two apart would need a marker on the row recording *which* actor
 * switched it off — machinery for no gain, when the refusal already stops the calls.
 * A reconnect re-fills `credentialsEncrypted` on its `update` branch, so the round trip
 * works.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface LegacyCredentialSweep {
  table: string
  cleared: number
}

/**
 * Clear the channel-specific credential stores a `ChannelConnection` revoke cannot see.
 *
 * Best-effort ON PURPOSE, and this is the one place that rule is uncomfortable: a
 * failure here leaves a live secret behind. So it is **logged as an error**, not a
 * warning, and the disconnect still completes — an operator who has decided to
 * disconnect must not be told it failed and left with a connected account as well.
 */
export async function clearLegacyChannelCredentials(channelKey: string): Promise<LegacyCredentialSweep[]> {
  if (channelKey !== 'AMAZON_ADS') return []
  try {
    const { count } = await prisma.amazonAdsConnection.updateMany({
      where: { credentialsEncrypted: { not: null } },
      data: {
        credentialsEncrypted: null,
        lastError: 'Account disconnected by the operator — the stored Ads credentials were removed.',
        lastErrorAt: new Date(),
      },
    })
    if (count > 0) {
      logger.info('[cx-legacy-creds] removed the Amazon Ads credentials a disconnect used to leave behind', { cleared: count })
    }
    return [{ table: 'AmazonAdsConnection', cleared: count }]
  } catch (err) {
    logger.error('[cx-legacy-creds] FAILED to clear the legacy Amazon Ads credentials — a live secret may remain', {
      error: err instanceof Error ? err.message : String(err),
    })
    return []
  }
}
