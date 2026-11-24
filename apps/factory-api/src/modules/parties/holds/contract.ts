import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { HOLD_LIMITS, HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'

/** The hold routes' contracts (B-W2b-290; SAL-023; modules/parties/holds). */

/** F-CT-S4: why an accepted quote's order waits (./stops.ts OrderWait). */
const ORDER_WAITS = ['ACCOUNT_ON_HOLD', 'PO_NUMBER_REQUIRED'] as const

const words = output({ en: z.string(), it: z.string() })
const holdView = output({
  id: id(),
  companyId: id().nullable(),
  company: output({ code: z.string(), name: z.string() }).nullable(),
  reason: z.enum(HOLD_REASONS),
  reasonWords: words,
  words: z.string(),
  inForce: z.boolean(),
  placedAt: instant(),
  placedBy: z.string().nullable(),
  releasedAt: instant().nullable(),
  releasedBy: z.string().nullable(),
  releaseWords: z.string().nullable(),
  version: z.number().int(),
  /** F-CT-S3 (customer terms lane): in force, and the reader may release it; false once released. */
  mayRelease: z.boolean(),
})
const holdsView = output({
  partyId: id(),
  code: z.string(),
  onHold: z.boolean(),
  holds: z.array(holdView),
  /** F-CT-S4: only the quotes the reader may see (quotes.view), at most 50; `waitsFor` in the order make.ts asks (hold, then PO number). */
  ordersWaiting: z.array(
    output({ quoteId: id(), number: z.string(), revision: z.number().int(), quoteVersionId: id(), companyId: id(), customerRef: z.string().nullable(), waitsFor: z.enum(ORDER_WAITS).nullable() }),
  ),
  /** F-CT-S4: every accepted quote without its order, by why it waits (also for a reader without quotes.view). */
  ordersWaitingCount: output({ onHold: z.number().int(), poNumber: z.number().int(), other: z.number().int() }),
  mayPlace: z.boolean(),
  reasons: z.array(output({ reason: z.enum(HOLD_REASONS), words })),
})
const answer = output({ holds: holdsView })

export const getHoldsContract = defineContract({ params: input({ partyId: id() }), response: { 200: answer } })
export const placeHoldContract = defineContract({
  params: input({ partyId: id() }),
  body: input({ companyId: id().nullable(), reason: z.enum(HOLD_REASONS), words: z.string().max(HOLD_LIMITS.words + 200) }),
  response: { 201: answer },
})
export const releaseHoldContract = defineContract({
  params: input({ partyId: id(), holdId: id() }),
  body: input({ version: z.number().int().min(1), words: z.string().max(HOLD_LIMITS.words + 200) }),
  response: { 200: answer },
})
