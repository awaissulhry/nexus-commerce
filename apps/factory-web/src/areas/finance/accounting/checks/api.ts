import { z } from 'zod'
import type { ApiClient } from '../../../../lib/api/client'
import { newIdempotencyKey } from '../../../../lib/api/client'

/**
 * B-W2b-426 — the integrity checks' calls (FIN-157; B-W2b-408's GET /accounting/integrity and POST …/run; design
 * finance.accounting "2 · Checks": totals equal row sums, placements never exceed payments): each named check's last run
 * (nightly, or by a person now) with the records that fail it, a few runs before, and a run now (accounting.export). The
 * shapes mirror factory-domain accounting/integrity/contracts.ts (checks.vitest.test.ts holds the lists equal). No money:
 * codes, counts and records. The API's English (`title`, `words`, `errorWords`) is never drawn.
 */

export const INTEGRITY_CHECK_CODES = ['INVOICE_TOTALS_EQUAL_LINES', 'SUPPLIER_INVOICE_TOTALS_EQUAL_LINES', 'ALLOCATIONS_WITHIN_PAYMENTS', 'PAYMENTS_PLACED', 'LEDGER_BALANCES', 'EXPORTED_DOCUMENTS_UNCHANGED'] as const
export type IntegrityCheckCode = (typeof INTEGRITY_CHECK_CODES)[number]
export const INTEGRITY_FAILURE_CODES = ['SUMMARY', 'LINES', 'PAYMENT', 'INVOICE', 'NOT_PLACED', 'UNBALANCED', 'CHANGED_AFTER_EXPORT'] as const
export const INTEGRITY_RESULTS = ['PASSED', 'FAILED', 'ERROR'] as const
export type IntegrityResult = (typeof INTEGRITY_RESULTS)[number]

export const integrityFailureSchema = z.object({ recordType: z.string(), recordId: z.string(), code: z.enum(INTEGRITY_FAILURE_CODES).nullable(), number: z.string().nullable() })
export type IntegrityFailure = z.infer<typeof integrityFailureSchema>

export const integrityCheckSchema = z.object({
  code: z.enum(INTEGRITY_CHECK_CODES),
  /** The last run's result; null: never run. */
  result: z.enum(INTEGRITY_RESULTS).nullable(),
  ranAt: z.string().nullable(),
  /** null: the nightly run; else the person who ran it now. */
  ranBy: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  failureCount: z.number(),
  failures: z.array(integrityFailureSchema),
  history: z.array(z.object({ ranAt: z.string(), result: z.enum(INTEGRITY_RESULTS), failureCount: z.number() })),
})
export type IntegrityCheck = z.infer<typeof integrityCheckSchema>

export const integrityAnswerSchema = z.object({
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }),
  /** The months the checks read: from this day to today. */
  window: z.object({ from: z.string(), to: z.string() }),
  lastRunAt: z.string().nullable(),
  failing: z.number(),
  checks: z.array(integrityCheckSchema),
  can: z.object({ run: z.boolean() }),
})
export type IntegrityAnswer = z.infer<typeof integrityAnswerSchema>

/** GET /accounting/integrity?companyId: each check as its last run left it (accounting.view). */
export function getIntegrity(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<IntegrityAnswer> {
  return api.get('/accounting/integrity', { query: { companyId }, schema: integrityAnswerSchema, signal })
}

/** POST /accounting/integrity/run: the checks run now, kept like the nightly run (accounting.export); the same answer. */
export function runIntegrity(api: ApiClient, companyId: string, idempotencyKey = newIdempotencyKey()): Promise<IntegrityAnswer> {
  return api.post('/accounting/integrity/run', { body: { companyId }, schema: integrityAnswerSchema, idempotencyKey })
}
