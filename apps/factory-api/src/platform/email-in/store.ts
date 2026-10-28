import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { CommandCaller } from '../../core/command'
import { gatewayAccount, ProviderError, type Gateway } from '../gateway/gateway'
import type { RawMailAdapter, RawMailLocation } from './port'

/**
 * The raw-mail store behind the gateway (plan A1 §4; Commerce hard rule 4 for the factory; apps/factory-api CLAUDE.md
 * "fetching the raw mail from S3 must be its OWN job through the gateway, never inside a processor's command"): each read
 * is ONE gateway call `mail.fetch_inbound` for the SES account the mail came through — re-read and checked (mode,
 * PAUSED kill switch, circuit, rate limit), recorded as one IntegrationCall row — and inside it the adapter of the
 * account's mode: FAKE → the in-memory bucket (local and test only), LIVE and SANDBOX → S3. The caller is a tenant's
 * system context (the worker) or an office session.
 *
 * The ledger keeps the bucket, the object key (SES's id of the mail) and the size cap, never an address or a text.
 */

export interface RawMailAdapters {
  readonly s3: RawMailAdapter
  /** The fake bucket (FACTORY_ENV local or test), else null: a FAKE account then has no bucket. */
  readonly fake: RawMailAdapter | null
}

export interface RawMailStorage {
  fetch(caller: CommandCaller, accountId: string, location: RawMailLocation, maxBytes: number): Promise<Buffer | null>
}

export function rawMailStorage(gateway: Gateway, adapters: RawMailAdapters): RawMailStorage {
  function adapterFor(account: AdapterAccount): RawMailAdapter {
    if (account.provider !== 'SES') throw new ProviderError('This account is not a mail account (provider SES).', { retryable: false })
    if (account.mode !== 'FAKE') return adapters.s3
    if (!adapters.fake) throw new ProviderError('A FAKE mail account needs the fake receiving bucket, which this environment does not have.', { retryable: false })
    return adapters.fake
  }

  return Object.freeze({
    fetch: (caller, accountId, location, maxBytes) =>
      gateway.call(
        gatewayAccount(caller, accountId),
        { name: 'mail.fetch_inbound', idempotent: true, request: { bucket: location.bucket, key: location.key, maxBytes } },
        (call) => adapterFor(call.account).fetch(call, location, maxBytes),
      ),
  } satisfies RawMailStorage)
}
