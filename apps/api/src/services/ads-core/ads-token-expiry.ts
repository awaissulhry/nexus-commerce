/**
 * P4.5g — when an Amazon Ads refresh token actually expires, and when it does not.
 *
 * ## Amazon's rule (CONFIRMED, P0.8, from Amazon's Ads release note of 2026-05-26)
 *
 * Refresh tokens issued **on or after 2026-07-30** expire 365 days after consent.
 * Tokens issued **before** that date are **not affected** — they have no 365-day
 * expiry at all.
 *
 * ## What we measured (development database, 2026-09-21)
 *
 * All nine `AmazonAdsConnection` rows carry `tokenIssuedAt = 2026-05-17T02:45:45Z`
 * (sub-second apart, the backfill) with `tokenIssuedAtIsEstimate: true`.
 *
 * 🟢 **The estimate's direction supports the conclusion rather than weakening it.** The
 * schema records that the backfill used `createdAt` as a *conservative floor*: consent
 * happened at or before the row was created. So the true consent date is **≤
 * 2026-05-17**, which is **before 2026-07-30** whichever way the estimate is wrong.
 *
 * 🔴 **This inverts the plan row.** *"Reconnect once for a true expiry date"* would not
 * reveal an expiry — it would **create** one, converting a token with no expiry into a
 * token that dies 365 days after the reconnect. P0.8 caught this and wrote it down;
 * this file is where the code finally acts on it.
 *
 * ## And the "measured" expiry on the connection is not a measurement
 *
 * `ChannelConnection.refreshTokenExpiresAt` reads **2027-09-08T09:00:02.920Z**, exactly
 * 365 days after `lastRefreshAt`. It is not Amazon's answer:
 * `token.service.storeGrant` computes
 * `grant.refreshExpiresInSec ?? spec.auth.refreshTokenLifetimeSec`, the Ads connect
 * flow sets no `refreshExpiresInSec`, and the spec's constant is `365 * 86_400` —
 * **our own number**. LWA does not return `refresh_token_expires_in` at all; that field
 * is eBay's.
 *
 * The Advertising connections screen called that value `measuredExpiry` and set
 * `isEstimate: false` from it, over a comment reading *"The grant reported a real
 * refresh-token lifetime"*. It did not. A derived number wearing a measurement's badge
 * is the banked trap `reference_a_banked_rule_can_go_false` names, and the 🔴 result
 * was a screen showing a confident expiry date for a token that has none.
 */

/** Amazon's cut-off. Tokens issued from this date carry a 365-day life; earlier ones do not. */
export const ADS_365_DAY_RULE_FROM = new Date('2026-07-30T00:00:00.000Z')

export const ADS_REFRESH_LIFETIME_DAYS = 365

export type AdsExpiryProvenance =
  /** Amazon told us, in a token response. Nothing produces this today. */
  | 'channel'
  /** We computed it from the consent date and Amazon's published rule. */
  | 'derived'
  /** Amazon's rule says this grant has no expiry. */
  | 'none'
  /** The consent date is unknown, so nothing can be said. */
  | 'unknown'

export interface AdsExpiry {
  expiresAt: Date | null
  /** True whenever the date is not something a channel reported. */
  isEstimate: boolean
  provenance: AdsExpiryProvenance
  /** A sentence for the operator. Never a guess dressed as a fact. */
  note: string
}

export interface AdsExpiryInput {
  /** When consent was given, as far as we know. */
  consentAt: Date | null
  /** Whether `consentAt` was inferred. The backfill's inference is a conservative FLOOR. */
  consentIsEstimate: boolean
  /** What is stored today, used only when the consent date cannot decide. */
  storedExpiresAt: Date | null
  /** A lifetime a channel actually reported, in seconds. Null for Amazon Ads today. */
  channelReportedLifetimeSec?: number | null
}

/**
 * The honest expiry for one Ads grant.
 *
 * Order matters: a lifetime the CHANNEL reported beats our rule, our rule beats the
 * stored number, and "we do not know" is a distinct answer from "there is none". P3.6's
 * lesson — `no_data` is never a pass — applied to a date.
 */
export function adsRefreshExpiry(input: AdsExpiryInput): AdsExpiry {
  if (input.channelReportedLifetimeSec && input.consentAt) {
    return {
      expiresAt: new Date(input.consentAt.getTime() + input.channelReportedLifetimeSec * 1000),
      isEstimate: false,
      provenance: 'channel',
      note: 'Amazon reported this refresh token’s lifetime.',
    }
  }

  if (!input.consentAt) {
    return {
      expiresAt: input.storedExpiresAt,
      isEstimate: true,
      provenance: 'unknown',
      note: 'The consent date is unknown, so this expiry cannot be checked against Amazon’s 365-day rule.',
    }
  }

  if (input.consentAt.getTime() < ADS_365_DAY_RULE_FROM.getTime()) {
    // Safe under an estimated consent date BECAUSE the estimate is a floor: the true
    // consent is at or before it, so it is earlier than the cut-off either way.
    return {
      expiresAt: null,
      isEstimate: false,
      provenance: 'none',
      note:
        'This grant was given before 2026-07-30, so Amazon’s 365-day refresh-token rule does not apply to it ' +
        'and it has no expiry date. Reconnecting would START a 365-day clock.',
    }
  }

  return {
    expiresAt: new Date(input.consentAt.getTime() + ADS_REFRESH_LIFETIME_DAYS * 86_400_000),
    isEstimate: input.consentIsEstimate,
    provenance: 'derived',
    note: input.consentIsEstimate
      ? 'Computed from an estimated consent date and Amazon’s 365-day rule — approximate.'
      : 'Computed from the recorded consent date and Amazon’s 365-day rule.',
  }
}
