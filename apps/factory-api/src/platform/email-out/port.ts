import type { VerificationStatus } from '@nexus/factory-domain/email/rules'
import type { GatewayCall } from '../gateway/gateway'

/**
 * The mail port (plan A1 §4 "MailPort"): what a mail provider does for email out. Two adapters implement it, chosen by
 * the SES account's mode: `adapters/ses/ses.ts` (LIVE, SANDBOX: Amazon SES v2 in eu-south-1, by API only) and
 * `adapters/ses/fake.ts` (FAKE: an in-memory mailbox, local and test only, nothing leaves the process). Each operation
 * runs inside ONE gateway call (store.ts): the account is re-read, the call is rate limited and recorded as one
 * IntegrationCall row, and the adapter gets the account's settings and credentials from `call`.
 */

/** One mail as the provider sends it. */
export interface OutgoingMail {
  /** The mail's id (EmailOutbound.id): tagged on the SES mail, so its notifications name it too. */
  readonly outboundId: string
  readonly templateKey: string
  /** The envelope sender (the From address). */
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  /** Never in the MIME headers: the provider gets them as destinations only. */
  readonly bcc: readonly string[]
  /** The whole MIME message (headers and body), CRLF lines. */
  readonly raw: string
}

/** The provider accepted the mail. */
export interface SentMail {
  readonly sesMessageId: string
}

/** A sending identity (a domain) as SES knows it. */
export interface IdentityState {
  readonly arn: string | null
  readonly verificationStatus: VerificationStatus
  readonly dkimStatus: VerificationStatus
  /** The DKIM CNAME tokens to publish under `<token>._domainkey.<domain>`. */
  readonly dkimTokens: readonly string[]
}

export interface MailAdapter {
  /** SendEmail with raw content. Not idempotent: the gateway tries it once; the job retries a failure. */
  send(call: GatewayCall, mail: OutgoingMail): Promise<SentMail>
  /** CreateEmailIdentity for a domain (Easy DKIM); an identity SES already has is read instead. */
  createIdentity(call: GatewayCall, domain: string): Promise<IdentityState>
  /** GetEmailIdentity: its verification and DKIM state now. */
  getIdentity(call: GatewayCall, domain: string): Promise<IdentityState>
}
