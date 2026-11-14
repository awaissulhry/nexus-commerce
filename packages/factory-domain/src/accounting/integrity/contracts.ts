import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { INTEGRITY_CHECK_CODES, INTEGRITY_FAILURE_CODES, INTEGRITY_RESULTS } from './checks'

/**
 * The contracts of the integrity checks (B-W2b-408; FIN-157; design finance.accounting "2 · Checks"): the last run of
 * each named check of a company with its failures (the records that fail it, to open), a few runs before, and a run now.
 * No money: codes, counts and records.
 */

const companyRef = output({ id: id(), code: z.string(), name: z.string() })

export const integrityQuery = input({ companyId: id() })
export const integrityRunBody = input({ companyId: id() })

export const integrityFailureView = output({
  recordType: z.string(),
  recordId: z.string(),
  code: z.enum(INTEGRITY_FAILURE_CODES).nullable(),
  /** The record's number, when it has one (an invoice's, a payment's reference …). */
  number: z.string().nullable(),
})

export const integrityCheckView = output({
  code: z.enum(INTEGRITY_CHECK_CODES),
  title: z.string(),
  /** The last run's result; null: never run. */
  result: z.enum(INTEGRITY_RESULTS).nullable(),
  ranAt: instant().nullable(),
  /** null: the nightly run; else the person who ran it now. */
  ranBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  failureCount: z.number().int(),
  failures: z.array(integrityFailureView),
  errorWords: z.string().nullable(),
  words: z.string(),
  /** The runs before it, newest first (at most 6). */
  history: z.array(output({ ranAt: instant(), result: z.enum(INTEGRITY_RESULTS), failureCount: z.number().int() })),
})

export const integrityAnswer = output({
  company: companyRef,
  /** The months the checks read: from this day to today. */
  window: output({ from: businessDate(), to: businessDate() }),
  lastRunAt: instant().nullable(),
  failing: z.number().int(),
  checks: z.array(integrityCheckView),
  can: output({ run: z.boolean() }),
  words: z.string(),
})
export type IntegrityAnswer = z.infer<typeof integrityAnswer>
