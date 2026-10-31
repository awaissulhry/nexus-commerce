import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * My numbers on Today (design home.today `key-numbers`; B-W2a-79): GET /home/numbers, its shape checked. Mirrors apps/
 * factory-api modules/insights/reports/contract.ts numbersContract; the enum lists mirror factory-domain
 * insights/reports/numbers (numbers.vitest.test.ts holds them equal). A money or margin value arrives only with its grain.
 */

export const NUMBER_UNITS = ['COUNT', 'PERCENT', 'MONEY'] as const
export const TARGET_WORDS = ['ON_TARGET', 'ABOVE_TARGET', 'BELOW_TARGET'] as const
export type TargetWord = (typeof TARGET_WORDS)[number]
export const NUMBER_PROBLEMS = ['UNAVAILABLE', 'MIXED_CURRENCIES', 'NO_DATA'] as const

export const keyNumberSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.enum(NUMBER_UNITS),
  grain: z.enum(['price', 'cost', 'margin', 'wages']).nullable(),
  value: z.number().nullable().optional(),
  currency: z.string().nullable(),
  target: z.object({ value: z.number(), direction: z.enum(['AT_MOST', 'AT_LEAST']) }).nullable(),
  targetWord: z.enum(TARGET_WORDS).nullable(),
  history: z.boolean(),
  spark: z.array(z.number().nullable()).nullable().optional(),
  complete: z.boolean(),
  problem: z.enum(NUMBER_PROBLEMS).nullable(),
  list: z.object({ api: z.string(), query: z.record(z.string(), z.string()) }).nullable(),
  report: z.object({ key: z.string(), filters: z.record(z.string(), z.string()) }).nullable(),
  explain: z.object({ definition: z.string(), formula: z.string(), sources: z.string(), period: z.string(), cutOff: z.string(), setBy: z.string().nullable() }),
})
export type KeyNumber = z.infer<typeof keyNumberSchema>

export const numbersSchema = z.object({
  asOf: z.string(),
  today: z.string(),
  lenses: z.array(z.object({ lens: z.string(), numbers: z.array(keyNumberSchema) })),
})
export type KeyNumbers = z.infer<typeof numbersSchema>

export function fetchNumbers(api: ApiClient, signal?: AbortSignal): Promise<KeyNumbers> {
  return api.get('/home/numbers', { schema: numbersSchema, signal })
}
