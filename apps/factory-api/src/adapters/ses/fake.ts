import { createHash, randomUUID } from 'node:crypto'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { IdentityState, MailAdapter, OutgoingMail, SentMail } from '../../platform/email-out/port'

/**
 * The FAKE mail provider (plan A1 §4 "MailPort … Fake behaviour"; §5.1: local mail is fake): the mailbox of SES accounts
 * in FAKE mode, local and test only (platform/email-out/service.ts makes none in staging or production, where the
 * gateway refuses FAKE accounts anyway). Nothing leaves the process: a sent mail is kept IN MEMORY (the newest
 * MAX_KEPT), never in a table or a file, so a sign-in link it carries is stored nowhere. An identity verifies at once.
 * Tests read the mails (`mails`, `last`, `textOf`) and script a failure (`failNext`).
 */

export interface FakeMail {
  readonly sesMessageId: string
  readonly accountId: string
  readonly tenantId: string
  readonly outboundId: string
  readonly templateKey: string
  readonly from: string
  readonly to: readonly string[]
  readonly cc: readonly string[]
  readonly bcc: readonly string[]
  readonly raw: string
}

const MAX_KEPT = 500

/** The decoded text/plain part of a mail built by factory-domain email/mime.ts. */
export function textOf(raw: string): string {
  const part = /Content-Type: text\/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/.exec(raw)?.[1] ?? ''
  return Buffer.from(part.replace(/\r\n/g, ''), 'base64').toString('utf8')
}

/** The value of one header of a raw mail (its first line). */
export function headerOf(raw: string, name: string): string | null {
  const head = raw.split('\r\n\r\n', 1)[0] ?? ''
  const line = head.split('\r\n').find((entry) => entry.toLowerCase().startsWith(`${name.toLowerCase()}:`))
  return line ? line.slice(name.length + 1).trim() : null
}

export class FakeSes implements MailAdapter {
  readonly mails: FakeMail[] = []
  /** The next send fails with this answer (a provider failure). */
  failNext: { readonly httpStatus: number; readonly message: string } | null = null

  async send(call: GatewayCall, mail: OutgoingMail): Promise<SentMail> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake mailbox.', { retryable: false })
    const failure = this.failNext
    this.failNext = null
    if (failure) {
      call.answer({ httpStatus: failure.httpStatus })
      throw new ProviderError(`SES SendEmail: ${failure.message}`, { httpStatus: failure.httpStatus })
    }
    const sesMessageId = `fake-${randomUUID()}`
    this.mails.push(
      Object.freeze({
        sesMessageId,
        accountId: call.account.id,
        tenantId: call.account.tenantId,
        outboundId: mail.outboundId,
        templateKey: mail.templateKey,
        from: mail.from,
        to: [...mail.to],
        cc: [...mail.cc],
        bcc: [...mail.bcc],
        raw: mail.raw,
      }),
    )
    if (this.mails.length > MAX_KEPT) this.mails.splice(0, this.mails.length - MAX_KEPT)
    call.answer({ httpStatus: 200, response: { messageId: sesMessageId } })
    return { sesMessageId }
  }

  async createIdentity(call: GatewayCall, domain: string): Promise<IdentityState> {
    return this.getIdentity(call, domain)
  }

  async getIdentity(call: GatewayCall, domain: string): Promise<IdentityState> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake mailbox.', { retryable: false })
    const hash = createHash('sha256').update(`fake dkim ${domain}`).digest('hex')
    call.answer({ httpStatus: 200, response: { verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS' } })
    return {
      arn: `arn:aws:ses:eu-south-1:000000000000:identity/${domain}`,
      verificationStatus: 'SUCCESS',
      dkimStatus: 'SUCCESS',
      dkimTokens: [hash.slice(0, 32), hash.slice(32, 64), createHash('sha256').update(hash).digest('hex').slice(0, 32)],
    }
  }

  /** The newest mail with this address among its recipients (to, cc or bcc). */
  last(address: string): FakeMail | undefined {
    return this.mails.filter((mail) => [...mail.to, ...mail.cc, ...mail.bcc].includes(address)).at(-1)
  }
}
