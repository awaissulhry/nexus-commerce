/**
 * P6.2 — keep the eBay signing key's expiry date known.
 *
 * ## What was measured (2026-09-21)
 *
 * | fact | state |
 * |---|---|
 * | `ChannelApp` EBAY/production signing key | **exists** (`signingKeyEnc` + `signingKeyId` set) |
 * | its expiry | **unknown** — no column existed |
 * | `createEbaySigningKey` → `expirationTime` | read, put in an event detail, **dropped** |
 * | `getEbaySigningKey` (a READ that returns it) | exists, tested, **zero callers** |
 * | `ChannelApp.secretExpiresAt` / `rotatedAt`, all 5 rows | **NULL** — nothing has ever rotated |
 *
 * 🔴 So the key that signs eBay refunds (P0.3) and finances calls **will expire on a
 * date nothing records**, and the first symptom is every signed call failing with a
 * 215xxx signature error — which `EbayApiError.isSignatureError` already recognises,
 * and which nothing anticipates.
 *
 * ## The rule this follows
 *
 * A **read**, cheap, and not repeated for no reason. The expiry of a key does not move,
 * so asking on every 15-minute heartbeat would be 96 identical calls a day. It asks
 * when the date is missing, and re-checks on a slow cadence so a key replaced by
 * another process is noticed.
 *
 * `signingKeyCheckedAt` is the discriminator: *"eBay named no expiry"* and *"we have
 * never asked"* both leave `signingKeyExpiresAt` null and are different facts. P3.6's
 * rule — `no_data` is never a pass — applied to a date.
 */
import { logger } from '../../utils/logger.js'
import { getChannelApp } from './apps.service.js'

/** How long a recorded answer is trusted before asking again. */
export const SIGNING_KEY_RECHECK_MS = 24 * 60 * 60 * 1000

export interface SigningKeyExpiryCheck {
  /** 'asked' — a call was made; 'fresh' — a recent answer was reused; 'absent' — no key. */
  outcome: 'asked' | 'fresh' | 'absent'
  expiresAt: string | null
  error?: string
}

/** Pure: should we spend a call on this app right now? */
export function shouldAskForSigningKeyExpiry(
  app: { signingKeyId: string | null; signingKeyExpiresAt: Date | null; signingKeyCheckedAt: Date | null },
  now = Date.now(),
): boolean {
  if (!app.signingKeyId) return false
  // Never asked — the case every existing key is in.
  if (!app.signingKeyCheckedAt) return true
  // Asked recently enough. Note this is keyed on when we ASKED, not on whether we got
  // a date: a key eBay reports no expiry for must not be re-asked every sweep.
  return now - app.signingKeyCheckedAt.getTime() >= SIGNING_KEY_RECHECK_MS
}

/**
 * Ask eBay, at most once a day, and record the answer.
 *
 * Never throws: a key-metadata read failing is not a reason to fail a heartbeat, and
 * the caller logs. The outcome distinguishes the three real cases so a quiet run and a
 * broken one do not look alike.
 */
export async function refreshEbaySigningKeyExpiry(
  environment: 'production' | 'sandbox' = 'production',
  now = Date.now(),
): Promise<SigningKeyExpiryCheck> {
  let app
  try {
    app = await getChannelApp('EBAY', environment)
  } catch {
    // No eBay app configured at all — nothing to check, and not an error worth raising.
    return { outcome: 'absent', expiresAt: null }
  }

  if (!shouldAskForSigningKeyExpiry(app, now)) {
    return app.signingKeyId
      ? { outcome: 'fresh', expiresAt: app.signingKeyExpiresAt?.toISOString() ?? null }
      : { outcome: 'absent', expiresAt: null }
  }

  const { recoverEbaySigningKeyExpiry } = await import('./connectors/ebay/client.js')
  const result = await recoverEbaySigningKeyExpiry(environment)
  if (!result.checked) {
    logger.warn('[cx-signing-key] could not record the eBay signing key expiry', { error: result.error })
    return { outcome: 'asked', expiresAt: null, error: result.error }
  }
  return { outcome: 'asked', expiresAt: result.expiresAt }
}
