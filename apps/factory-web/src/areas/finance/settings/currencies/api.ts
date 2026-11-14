import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Currencies and exchange rates (B-W2b-389 on its own API, apps/factory-api platform/currency; design finance.settings
 * sec:currencies "Currencies & rates": base currency; daily ECB rates; manual override per date). No money: currency codes
 * and rates only (a rate is a plain decimal string). A company's currencies are its own; the rates are the tenant's (one
 * table for every company), written only by a role over every company.
 */

const source = z.enum(['ECB', 'MANUAL'])

export const dayRateSchema = z.object({
  base: z.string(),
  quote: z.string(),
  rate: z.string(),
  rateDate: z.string(),
  source,
  how: z.enum(['STORED', 'INVERSE', 'CROSS']),
  words: z.string(),
})
export type DayRate = z.infer<typeof dayRateSchema>

export const feedSchema = z.object({
  on: z.boolean(),
  status: z.enum(['NONE', 'ACTIVE', 'PAUSED', 'DISABLED']),
  mode: z.enum(['LIVE', 'SANDBOX', 'FAKE']).nullable(),
  accountId: z.string().nullable(),
  lastOkAt: z.string().nullable(),
  lastErrorAt: z.string().nullable(),
  lastError: z.string().nullable(),
  lastEcbDay: z.string().nullable(),
})
export type Feed = z.infer<typeof feedSchema>

export const currencySchema = z.object({
  id: z.string().nullable(),
  companyId: z.string(),
  code: z.string(),
  minorUnits: z.number(),
  active: z.boolean(),
  base: z.boolean(),
  version: z.number().nullable(),
  rate: dayRateSchema.nullable(),
  waits: z.string().nullable(),
  updatedAt: z.string().nullable(),
})
export type Currency = z.infer<typeof currencySchema>

export const currenciesSchema = z.object({
  company: z.object({ id: z.string(), code: z.string(), legalName: z.string(), base: z.string() }),
  today: z.string(),
  currencies: z.array(currencySchema),
  offered: z.array(z.string()),
  feed: feedSchema,
  can: z.object({ manage: z.boolean(), manageRates: z.boolean() }),
})
export type Currencies = z.infer<typeof currenciesSchema>

export const rateDaySchema = z.object({
  key: z.string(),
  base: z.string(),
  quote: z.string(),
  day: z.string(),
  ecb: z.object({ id: z.string(), rate: z.string() }).nullable(),
  manual: z.object({ id: z.string(), rate: z.string(), version: z.number(), overriddenBy: z.object({ id: z.string(), name: z.string() }).nullable(), updatedAt: z.string() }).nullable(),
  rate: z.string(),
  source,
  words: z.string(),
  farFromEcb: z.boolean(),
})
export type RateDay = z.infer<typeof rateDaySchema>

export const ratesSchema = z.object({ days: z.array(rateDaySchema), from: z.string(), to: z.string(), today: z.string(), truncated: z.boolean(), canManage: z.boolean() })
export type Rates = z.infer<typeof ratesSchema>

/** The company's base and document currencies, today's rates and the daily ECB switch (currencies.view). */
export async function getCurrencies(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<Currencies> {
  return api.get('/currencies', { query: { companyId }, schema: currenciesSchema, signal })
}

/** A document currency added, or one switched off before switched on again (currencies.manage). */
export async function addCurrency(api: ApiClient, companyId: string, code: string, idempotencyKey: string): Promise<Currency> {
  return (await api.post('/currencies', { body: { companyId, code }, schema: z.object({ currency: currencySchema }), idempotencyKey })).currency
}

/** A document currency switched off or on again (currencies.manage; never the base currency). */
export async function switchCurrency(api: ApiClient, currency: Pick<Currency, 'id' | 'version'>, active: boolean, idempotencyKey: string): Promise<Currency> {
  return (await api.post(`/currencies/${encodeURIComponent(currency.id ?? '')}/switch`, { body: { version: currency.version, active }, schema: z.object({ currency: currencySchema }), idempotencyKey })).currency
}

/** The rates table of the days from `from` to `to`, one currency or all (currencies.view). */
export async function listRates(api: ApiClient, query: { quote?: string | null; from?: string; to?: string }, signal?: AbortSignal): Promise<Rates> {
  return api.get('/exchange-rates', { query: { quote: query.quote ?? undefined, from: query.from, to: query.to }, schema: ratesSchema, signal })
}

/** The manual rate of a day kept, or corrected (with its version) (currencies.manage over every company). */
export async function setManualRate(api: ApiClient, body: { base?: string; quote: string; day: string; rate: string; version?: number }, idempotencyKey: string): Promise<RateDay> {
  return (await api.request('PUT', '/exchange-rates/manual', { body, schema: z.object({ day: rateDaySchema }), idempotencyKey })).day
}

/** A manual rate removed: the day falls back to the ECB's (currencies.manage over every company). */
export async function removeManualRate(api: ApiClient, manual: { id: string; version: number }, idempotencyKey: string): Promise<RateDay | null> {
  return (await api.request('DELETE', `/exchange-rates/manual/${encodeURIComponent(manual.id)}`, { query: { version: manual.version }, schema: z.object({ day: rateDaySchema.nullable() }), idempotencyKey })).day
}

/** The daily ECB rates switched on or off (currencies.manage over every company). */
export async function switchFeed(api: ApiClient, on: boolean, idempotencyKey: string): Promise<Feed> {
  return (await api.request('PUT', '/exchange-rates/feed', { body: { on }, schema: z.object({ feed: feedSchema }), idempotencyKey })).feed
}

/** The ECB's file read now (the switch on) (currencies.manage over every company). */
export async function readEcbNow(api: ApiClient, idempotencyKey: string): Promise<{ fileDays: string[]; addedDays: string[]; rows: number; feed: Feed }> {
  return api.post('/exchange-rates/fetch', { body: {}, schema: z.object({ fileDays: z.array(z.string()), addedDays: z.array(z.string()), rows: z.number(), feed: feedSchema }), idempotencyKey })
}
