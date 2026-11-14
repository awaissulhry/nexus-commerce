import { createHash } from 'node:crypto'
import { parseEcbFile } from '@nexus/factory-domain/money/currency/ecb'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { EcbAdapter, EcbAnswer } from './port'

/**
 * The real ECB file (LIVE and SANDBOX accounts): the euro foreign exchange reference rates the ECB publishes each TARGET
 * working day at about 16:00 CET, a free public XML file with no key. Runs only inside a gateway call (call.signal ends it
 * at the account's timeout); a 5xx or a 429 may pass later (the gateway retries it), anything else unreadable does not.
 * The transport is `fetch`, replaceable for tests (./ecb.vitest.test.ts): no test reaches the network.
 */

export const ECB_DAILY_URL = 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml'

/** At most this much of an answer is read (the daily file is about 2 KB). */
const MAX_BODY = 256 * 1024

export interface EcbHttpOptions {
  /** The HTTP transport; default the global fetch. */
  readonly fetch?: typeof fetch
  readonly url?: string
}

export function ecbHttpAdapter(options: EcbHttpOptions = {}): EcbAdapter {
  const send = options.fetch ?? ((input, init) => fetch(input, init))
  const url = options.url ?? ECB_DAILY_URL
  return Object.freeze({
    async daily(call: GatewayCall): Promise<EcbAnswer> {
      if (call.account.mode === 'FAKE') throw new ProviderError('A FAKE account uses the fake ECB file, never the real one.', { retryable: false })
      const response = await send(url, { method: 'GET', headers: { accept: 'application/xml, text/xml' }, signal: call.signal })
      const body = (await response.text()).slice(0, MAX_BODY)
      const responseSha256 = createHash('sha256').update(body).digest('hex')
      if (!response.ok) {
        call.answer({ httpStatus: response.status })
        throw new ProviderError(`The ECB answered HTTP ${response.status}.`, { httpStatus: response.status })
      }
      const parsed = parseEcbFile(body)
      if (!parsed.ok) {
        call.answer({ httpStatus: response.status, response: { problem: parsed.problem } })
        throw new ProviderError(parsed.problem, { httpStatus: response.status, retryable: false })
      }
      call.answer({ httpStatus: response.status, response: { days: parsed.days.map((day) => ({ day: day.day, rates: day.rates.length })) } })
      return { days: parsed.days, responseSha256 }
    },
  } satisfies EcbAdapter)
}
