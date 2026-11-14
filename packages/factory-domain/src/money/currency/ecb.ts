import { isCurrencyCode } from '../../core/money'
import type { BusinessDate } from '../../core/time'
import { EURO } from './currencies'
import { normalRate } from './rates'

/**
 * The ECB's euro foreign exchange reference rates (B-W2b-389; PLT-133): the free public file the ECB publishes on each
 * TARGET working day at about 16:00 CET (https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml; the last 90 days:
 * eurofxref-hist-90d.xml), read through the gateway by apps/factory-api's ECB adapter. Pure: the file's text in, the days
 * and their rates out.
 *
 *   <gesmes:Envelope …><Cube><Cube time="2026-11-13"><Cube currency="USD" rate="1.0850"/>…</Cube></Cube></gesmes:Envelope>
 *
 * Each rate is 1 EUR = rate units of the currency. A day with no rate, a currency code that is not ISO 4217, a rate that is
 * not a plain decimal above 0 or a day written twice makes the file unreadable (nothing is kept from it).
 */

export const ECB_DAILY_OPERATION = Object.freeze({ name: 'ecb.daily_rates', idempotent: true })

export interface EcbDay {
  readonly day: BusinessDate
  readonly rates: readonly { readonly currency: string; readonly rate: string }[]
}

export type EcbFile = { readonly ok: true; readonly days: readonly EcbDay[] } | { readonly ok: false; readonly problem: string }

const DAY = /<Cube\s+time=['"](\d{4}-\d{2}-\d{2})['"]\s*>([\s\S]*?)<\/Cube>/g
const RATE = /<Cube\s+currency=['"]([A-Za-z]{3})['"]\s+rate=['"]([^'"]*)['"]\s*\/>/g

/** Reads the ECB's file (daily or 90 days): its days, newest first, each with its rates (eight decimals). */
export function parseEcbFile(xml: string): EcbFile {
  const days: EcbDay[] = []
  for (const block of xml.matchAll(DAY)) {
    const day = block[1]!
    if (Number.isNaN(Date.parse(`${day}T00:00:00.000Z`))) return { ok: false, problem: `The ECB file names a day that is not a date (${day}).` }
    if (days.some((entry) => entry.day === day)) return { ok: false, problem: `The ECB file lists ${day} twice.` }
    const rates: { currency: string; rate: string }[] = []
    for (const match of block[2]!.matchAll(RATE)) {
      const currency = match[1]!
      const rate = normalRate(match[2]!)
      if (!isCurrencyCode(currency) || currency === EURO) return { ok: false, problem: `The ECB file has a currency that is not an ISO 4217 code (${currency}).` }
      if (rate === null) return { ok: false, problem: `The ECB file's rate of ${currency} on ${day} is not a decimal above 0.` }
      if (rates.some((entry) => entry.currency === currency)) return { ok: false, problem: `The ECB file lists ${currency} twice on ${day}.` }
      rates.push({ currency, rate })
    }
    if (rates.length === 0) return { ok: false, problem: `The ECB file has no rate on ${day}.` }
    days.push({ day, rates })
  }
  if (days.length === 0) return { ok: false, problem: 'The ECB file has no day of rates.' }
  return { ok: true, days: days.sort((a, b) => b.day.localeCompare(a.day)) }
}

/** The ECB file of one day, as the ECB writes it (the fake adapter and the tests). */
export function ecbFileOf(days: readonly EcbDay[]): string {
  const cubes = days.map((entry) => `<Cube time='${entry.day}'>${entry.rates.map((rate) => `<Cube currency='${rate.currency}' rate='${rate.rate}'/>`).join('')}</Cube>`).join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<gesmes:Envelope xmlns:gesmes="http://www.gesmes.org/xml/2002-08-01" xmlns="http://www.ecb.int/vocabulary/2002-08-01/eurofxref">' +
    '<gesmes:subject>Reference rates</gesmes:subject><gesmes:Sender><gesmes:name>European Central Bank</gesmes:name></gesmes:Sender>' +
    `<Cube>${cubes}</Cube></gesmes:Envelope>`
  )
}
