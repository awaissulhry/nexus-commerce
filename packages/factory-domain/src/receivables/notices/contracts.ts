import { z } from 'zod'
import { id, input, output } from '../../core/contracts'
import { MAX_TRUSTED_LEVEL } from './notices'

/**
 * The contracts of the trusted reminder levels and the Owner's collections switches (B-W2b-402; FIN-113, FIN-126, FIN-128).
 * No money here. Words are English; the screens draw them from the codes.
 */

const words = output({ en: z.string(), it: z.string() })

export const trustParams = input({ partyId: id() })

export const trustBody = input({
  /** The customer's version (Party.version): a trusted level is the customer's own. */
  version: z.number().int().min(1),
  /** 1 to 10: e-mail reminders up to that level go without a person; null: every reminder waits for a person. */
  level: z.number().int().min(1).max(MAX_TRUSTED_LEVEL).nullable(),
})
export type TrustBody = z.infer<typeof trustBody>

export const trustAnswer = output({
  customer: output({ id: id(), code: z.string(), name: z.string(), version: z.number().int() }),
  level: z.number().int().nullable(),
  words,
  /** Per company the customer owes: whether its reminders are switched on, so the trusted ones go now, and which steps. */
  companies: z.array(output({ id: id(), code: z.string(), remindersEnabled: z.boolean(), steps: z.array(output({ level: z.number().int(), offsetDays: z.number().int(), action: z.string() })) })),
  mayChange: z.boolean(),
})

export const collectionsQuery = input({ companyId: id().optional() })

export const collectionsBody = input({
  /** null: the tenant-wide row (a grant over every company). */
  companyId: id().nullable(),
  /** The receivables settings row's version; absent when the company has no row of its own yet. */
  version: z.number().int().min(1).optional(),
  ribaOn: z.boolean().optional(),
  paymentNoticeToCustomerOn: z.boolean().optional(),
})
export type CollectionsBody = z.infer<typeof collectionsBody>

export const collectionsAnswer = output({
  companyId: id().nullable(),
  /** Which row holds: the company's own, the tenant's, or none (both off). */
  source: z.enum(['COMPANY', 'TENANT', 'NONE']),
  settingsId: id().nullable(),
  version: z.number().int().nullable(),
  ribaOn: z.boolean(),
  paymentNoticeToCustomerOn: z.boolean(),
  words: output({ riba: z.string(), notice: z.string(), wording: z.string() }),
  mayChange: z.boolean(),
})
