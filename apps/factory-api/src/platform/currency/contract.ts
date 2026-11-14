import { z } from 'zod'
import { businessDate, currency, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'

/**
 * Currencies and exchange rates' contracts (B-W2b-389; PLT-132, PLT-133; design finance.settings "Currencies & rates"). No
 * money: currency codes and rates only (a rate is a plain decimal string, eight decimals, never a JSON number).
 */

const version = z.number().int().min(1)
const rate = z.string().trim().min(1).max(30)
const source = z.enum(['ECB', 'MANUAL'])

const dayRateView = output({
  base: z.string(),
  quote: z.string(),
  rate: z.string(),
  rateDate: z.string(),
  source,
  how: z.enum(['STORED', 'INVERSE', 'CROSS']),
  words: z.string(),
})

const feedView = output({
  on: z.boolean(),
  status: z.enum(['NONE', 'ACTIVE', 'PAUSED', 'DISABLED']),
  mode: z.enum(['LIVE', 'SANDBOX', 'FAKE']).nullable(),
  accountId: id().nullable(),
  lastOkAt: instant().nullable(),
  lastErrorAt: instant().nullable(),
  lastError: z.string().nullable(),
  lastEcbDay: z.string().nullable(),
})

const currencyView = output({
  id: id().nullable(),
  companyId: id(),
  code: z.string(),
  minorUnits: z.number().int(),
  active: z.boolean(),
  base: z.boolean(),
  version: z.number().int().nullable(),
  rate: dayRateView.nullable(),
  waits: z.string().nullable(),
  updatedAt: instant().nullable(),
})

const rateDayView = output({
  key: z.string(),
  base: z.string(),
  quote: z.string(),
  day: z.string(),
  ecb: output({ id: id(), rate: z.string() }).nullable(),
  manual: output({ id: id(), rate: z.string(), version: z.number().int(), overriddenBy: output({ id: id(), name: z.string() }).nullable(), updatedAt: instant() }).nullable(),
  rate: z.string(),
  source,
  words: z.string(),
  farFromEcb: z.boolean(),
})

export const currenciesContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      company: output({ id: id(), code: z.string(), legalName: z.string(), base: z.string() }),
      today: z.string(),
      currencies: z.array(currencyView),
      offered: z.array(z.string()),
      feed: feedView,
      can: output({ manage: z.boolean(), manageRates: z.boolean() }),
    }),
  },
})
export const addCurrencyContract = defineContract({ body: input({ companyId: id(), code: z.string().trim().min(1).max(3) }), response: { 201: output({ currency: currencyView }) } })
export const switchCurrencyContract = defineContract({ params: input({ currencyId: id() }), body: input({ version, active: z.boolean() }), response: { 200: output({ currency: currencyView }) } })

export const listRatesContract = defineContract({
  querystring: input({ quote: currency().optional(), source: source.optional(), from: businessDate().optional(), to: businessDate().optional() }),
  response: { 200: output({ days: z.array(rateDayView), from: z.string(), to: z.string(), today: z.string(), truncated: z.boolean(), canManage: z.boolean() }) },
})
export const rateOfDayContract = defineContract({
  querystring: input({ base: currency().optional(), quote: currency(), day: businessDate().optional() }),
  response: { 200: output({ rate: dayRateView.nullable(), waits: z.string().nullable(), day: z.string() }) },
})
export const setManualRateContract = defineContract({
  body: input({ base: z.string().trim().length(3).optional(), quote: z.string().trim().length(3), day: z.string().trim().max(10), rate, version: version.optional() }),
  response: { 200: output({ day: rateDayView }) },
})
export const removeManualRateContract = defineContract({
  params: input({ rateId: id() }),
  querystring: input({ version: z.coerce.number().int().min(1) }),
  response: { 200: output({ day: rateDayView.nullable() }) },
})
export const switchFeedContract = defineContract({ body: input({ on: z.boolean() }), response: { 200: output({ feed: feedView }) } })
export const readEcbContract = defineContract({
  body: input({}).optional(),
  response: { 200: output({ fileDays: z.array(z.string()), addedDays: z.array(z.string()), rows: z.number().int(), feed: feedView }) },
})
