import type { GatewayCall } from '../gateway/gateway'

/**
 * The raw-mail port of email in (plan A1 §3.7 "Receiving": SES's receipt rule stores the raw mail in S3 in Milan, with
 * a 30-day lifecycle; A1 §4 "MailPort … inbound mail"): reading one received mail's bytes. Two adapters implement it,
 * chosen by the SES account's mode: `adapters/ses-inbound/s3.ts` (LIVE, SANDBOX: S3 GetObject in the account's region,
 * from its receiving bucket only) and `adapters/ses-inbound/fake.ts` (FAKE: an in-memory bucket, local and test only).
 * Each read is ONE gateway call (store.ts): the account is re-read, the call is rate limited and recorded as one
 * IntegrationCall row, and the adapter gets the account's settings and credentials from `call`.
 */

/** Where SES stored a received mail. */
export interface RawMailLocation {
  readonly bucket: string
  readonly key: string
}

export interface RawMailAdapter {
  /**
   * The raw mail (RFC 5322 bytes); null when the bucket has no such object (its lifecycle removed it). An object larger
   * than `maxBytes` is refused without reading it all: a ProviderError that is not retryable (the gateway would retry any
   * other error, and reading it again cannot help).
   */
  fetch(call: GatewayCall, location: RawMailLocation, maxBytes: number): Promise<Buffer | null>
}
