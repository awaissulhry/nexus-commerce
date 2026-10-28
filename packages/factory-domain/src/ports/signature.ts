/**
 * Webhook signature verification (plan A1 §4 "Inbound webhooks: verify the signature → InboundEvent → claim → handler
 * → done"; feature PLT-194). One verifier per provider (SNS for SES, Stripe, Sendcloud, the SDI intermediary) and one
 * for the factory's own fakes; apps/factory-api/src/platform/inbound runs it on the RAW body before anything is stored
 * as verified, then stores the receipt (deduplicated by `dedupeKey`), answers, and processes it later.
 *
 * A verifier never throws for a bad delivery: it answers `{ ok: false, reason }`, and the receipt is kept as REJECTED.
 * It may be async (SNS checks a certificate it fetches, through the gateway).
 *
 * Pure types: no I/O.
 */

export interface VerifyInput {
  /** The body exactly as it arrived. */
  readonly rawBody: Uint8Array
  /** Request headers, names in lower case. */
  readonly headers: Readonly<Record<string, string | undefined>>
  /** The account's webhook signing secret, opened from its SecretValue; null when it has none. */
  readonly secret: string | null
  /** The server time, for timestamp tolerance. */
  readonly now: Date
}

export type VerifyResult =
  | {
      readonly ok: true
      /** The provider's id of this event: one receipt per provider and key, so a repeat is stored once. */
      readonly dedupeKey: string
      /** The provider's id of the object the event is about, when it names one. */
      readonly externalId?: string
      /** The provider's event type. */
      readonly eventType?: string
    }
  | {
      readonly ok: false
      /** A short code, kept on the rejected receipt: `missing_signature`, `signature_mismatch`, `stale_timestamp` … */
      readonly reason: string
    }

export interface SignatureVerifier {
  verify(input: VerifyInput): VerifyResult | Promise<VerifyResult>
}
