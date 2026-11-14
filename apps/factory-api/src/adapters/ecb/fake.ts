import { createHash } from 'node:crypto'
import { businessDate, type Clock } from '@nexus/factory-domain/core/time'
import { ECB_CURRENCIES } from '@nexus/factory-domain/money/currency/currencies'
import { ecbFileOf, parseEcbFile, type EcbDay } from '@nexus/factory-domain/money/currency/ecb'
import { addDays } from '@nexus/factory-domain/money/currency/rates'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import type { EcbAdapter, EcbAnswer } from './port'

/**
 * The FAKE ECB file (local and test only: platform/currency/feed.ts makes no FAKE account in staging or production, where
 * the gateway refuses FAKE accounts anyway). Nothing leaves the process. It answers the file of the last weekday on or
 * before today (Europe/Rome; Saturday and Sunday have no rate, as at the ECB) with MADE-UP rates for every ECB currency:
 * a fixed made-up figure per currency moved by a small step per day, so two days differ and the same day always reads the
 * same. Never a real rate: the TEST MODE badge shows while the account is FAKE.
 *
 * Tests script the next answers (`answerNext`: the days of a file) or a failure (`failNext`: an HTTP status, 503 by
 * default, which the gateway retries) and read how many files were asked (`reads`).
 */

/** The made-up figure per currency, before the day's step (not the ECB's: invented for the fake only). */
const MADE_UP: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(ECB_CURRENCIES.map((code, index) => [code, new Dec(1).plus(new Dec(index).times('0.37')).toFixed(4)])))

/** The last Monday-to-Friday on or before the day. */
export function lastWeekday(day: string): string {
  let at = day
  for (;;) {
    const weekday = new Date(`${at}T00:00:00.000Z`).getUTCDay()
    if (weekday !== 0 && weekday !== 6) return at
    at = addDays(at, -1)
  }
}

/** The fake's rates of a day: each currency's made-up figure × (1 + day of the month ÷ 1000). */
export function fakeDay(day: string): EcbDay {
  const step = new Dec(1).plus(new Dec(Number.parseInt(day.slice(8, 10), 10)).dividedBy(1000))
  return { day, rates: ECB_CURRENCIES.map((currency) => ({ currency, rate: new Dec(MADE_UP[currency]!).times(step).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4) })) }
}

export class FakeEcb implements EcbAdapter {
  reads = 0
  private readonly scripted: (readonly EcbDay[] | number)[] = []

  constructor(private readonly clock: Clock = { now: () => new Date() }) {}

  /** The next file answers these days (newest first or not: the parser sorts them). */
  answerNext(days: readonly EcbDay[]): void {
    this.scripted.push(days)
  }

  /** The next `count` reads fail with this HTTP status. */
  failNext(count = 1, httpStatus = 503): void {
    for (let index = 0; index < count; index++) this.scripted.push(httpStatus)
  }

  async daily(call: GatewayCall): Promise<EcbAnswer> {
    if (call.account.mode !== 'FAKE') throw new ProviderError('Only a FAKE account uses the fake ECB file.', { retryable: false })
    this.reads += 1
    const next = this.scripted.shift()
    if (typeof next === 'number') {
      call.answer({ httpStatus: next })
      throw new ProviderError(`The fake ECB answered HTTP ${next}.`, { httpStatus: next })
    }
    const body = ecbFileOf(next ?? [fakeDay(lastWeekday(businessDate(this.clock.now())))])
    const parsed = parseEcbFile(body)
    if (!parsed.ok) throw new ProviderError(parsed.problem, { retryable: false })
    call.answer({ httpStatus: 200, response: { fake: true, days: parsed.days.map((day) => ({ day: day.day, rates: day.rates.length })) } })
    return { days: parsed.days, responseSha256: createHash('sha256').update(body).digest('hex') }
  }
}
