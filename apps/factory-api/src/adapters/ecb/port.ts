import type { EcbDay } from '@nexus/factory-domain/money/currency/ecb'
import type { GatewayCall } from '../../platform/gateway/gateway'

/**
 * The ECB adapters' shape (B-W2b-389; PLT-133; the file's rules: @nexus/factory-domain/money/currency/ecb). Each read runs
 * INSIDE one gateway call (platform/currency/feed.ts, operation `ecb.daily_rates`, idempotent: a read): the adapter gets
 * the call (its account, attempt, abort signal) and answers the days of the file with their rates, or throws a
 * ProviderError (the gateway retries one that may pass later: a 5xx, a timeout).
 *
 *   ./http.ts   LIVE and SANDBOX accounts: the ECB's public daily file over HTTPS (no key, no cost; the ECB has no test
 *               system, so SANDBOX reads the same public file)
 *   ./fake.ts   FAKE accounts (local and test only; the gateway refuses FAKE in production): made-up rates, no network
 */
export interface EcbAdapter {
  daily(call: GatewayCall): Promise<EcbAnswer>
}

export interface EcbAnswer {
  /** The days of the file, newest first, each with its rates (1 EUR = rate). */
  readonly days: readonly EcbDay[]
  /** SHA-256 (hex) of the body as received. */
  readonly responseSha256: string
}
