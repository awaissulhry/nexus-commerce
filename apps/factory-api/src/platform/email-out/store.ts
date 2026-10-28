import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { CommandCaller } from '../../core/command'
import { gatewayAccount, ProviderError, type Gateway } from '../gateway/gateway'
import type { IdentityState, MailAdapter, OutgoingMail, SentMail } from './port'

/**
 * The mail store behind the gateway (plan A1 §4; Commerce hard rule 4 for the factory): each operation is ONE gateway
 * call for the identity's SES account — re-read and checked (mode, PAUSED kill switch, circuit, rate limit), recorded
 * as one IntegrationCall row — and inside it the adapter of the account's mode: FAKE → the in-memory mailbox (local and
 * test only), LIVE and SANDBOX → SES. The caller is an office session or a tenant's system context.
 *
 *   mail.send   mail.create_identity   mail.get_identity
 *
 * The ledger keeps the mail's id, template, number of recipients and size, never an address, a subject or a text.
 */

export interface MailAdapters {
  readonly ses: MailAdapter
  /** The fake mailbox (FACTORY_ENV local or test), else null: a FAKE account then has no mailbox. */
  readonly fake: MailAdapter | null
}

export interface MailStorage {
  send(caller: CommandCaller, accountId: string, mail: OutgoingMail): Promise<SentMail>
  createIdentity(caller: CommandCaller, accountId: string, domain: string): Promise<IdentityState>
  getIdentity(caller: CommandCaller, accountId: string, domain: string): Promise<IdentityState>
}

export function mailStorage(gateway: Gateway, adapters: MailAdapters): MailStorage {
  function adapterFor(account: AdapterAccount): MailAdapter {
    if (account.provider !== 'SES') throw new ProviderError('This account is not a mail account (provider SES).', { retryable: false })
    if (account.mode !== 'FAKE') return adapters.ses
    if (!adapters.fake) throw new ProviderError('A FAKE mail account needs the fake mailbox, which this environment does not have.', { retryable: false })
    return adapters.fake
  }

  return Object.freeze({
    send: (caller, accountId, mail) =>
      gateway.call(
        gatewayAccount(caller, accountId),
        {
          name: 'mail.send',
          idempotent: false,
          request: { outboundId: mail.outboundId, template: mail.templateKey, recipients: mail.to.length + mail.cc.length + mail.bcc.length, bytes: Buffer.byteLength(mail.raw, 'utf8') },
        },
        (call) => adapterFor(call.account).send(call, mail),
      ),
    createIdentity: (caller, accountId, domain) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'mail.create_identity', idempotent: true, request: { domain } }, (call) => adapterFor(call.account).createIdentity(call, domain)),
    getIdentity: (caller, accountId, domain) =>
      gateway.call(gatewayAccount(caller, accountId), { name: 'mail.get_identity', idempotent: true, request: { domain } }, (call) => adapterFor(call.account).getIdentity(call, domain)),
  } satisfies MailStorage)
}
