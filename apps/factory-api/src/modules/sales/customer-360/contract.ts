import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { HOLD_REASONS } from '@nexus/factory-domain/parties/holds/holds'
import { REQUIREMENT_KINDS, REQUIREMENT_STAGES } from '@nexus/factory-domain/parties/requirements/requirements'
import { PARTY_KINDS, PARTY_ROLES, PARTY_STATUSES } from '@nexus/factory-domain/parties/rules'
import { GLANCE_PARTS } from '@nexus/factory-domain/sales/customer-360/glance'
import { REPAIR_KINDS, REPAIR_STAGES } from '@nexus/factory-domain/sales/repairs/rules'
import { SAMPLE_KINDS, SAMPLE_STAGES } from '@nexus/factory-domain/sales/samples/rules'

/**
 * GET /sales/customer-360/:partyId (B-W2b-324; SAL-019): the customer at a glance for one company (factory-domain
 * sales/customer-360/glance). Credit amounts are the price grain (minor units of `credit.currency`): the grain filter drops
 * them without money.price. A part the reader may not read is null and named in `withheld`. No cost, no margin, no
 * measurement value.
 */

const amount = () => money.price(z.number().int().nullable())
const label = output({ id: id(), code: z.string(), name: z.string() })

const hold = output({
  id: id(),
  reason: z.enum(HOLD_REASONS),
  words: z.string(),
  /** A hold of every company (not only of this one). */
  everyCompany: z.boolean(),
  placedAt: instant(),
  /** null: placed by the system (a credit check). */
  placedBy: z.string().nullable(),
})

const requirement = output({
  id: id(),
  kind: z.enum(REQUIREMENT_KINDS),
  words: z.string(),
  appliesAt: z.array(z.enum(REQUIREMENT_STAGES)),
  everyStyle: z.boolean(),
  everyCompany: z.boolean(),
})

const sample = output({
  id: id(),
  number: z.string(),
  kind: z.enum(SAMPLE_KINDS),
  roundNo: z.number().int(),
  stage: z.enum(SAMPLE_STAGES),
  style: output({ id: id(), code: z.string(), name: z.string() }),
  dueDate: businessDate().nullable(),
  daysLate: z.number().int().nullable(),
})

const profile = output({
  id: id(),
  riderName: z.string(),
  garmentType: z.string(),
  revision: z.number().int(),
  baseSize: z.string().nullable(),
  takenAt: instant(),
})

const rider = output({ id: id(), code: z.string(), name: z.string(), status: z.enum(PARTY_STATUSES), profiles: z.number().int() })

const repair = output({ id: id(), number: z.string(), kind: z.enum(REPAIR_KINDS), stage: z.enum(REPAIR_STAGES), createdAt: instant() })

const part = <Row extends z.ZodType>(row: Row) => output({ count: z.number().int(), rows: z.array(row) }).nullable()

export const glanceContract = defineContract({
  params: input({ partyId: id() }),
  querystring: input({ companyId: id().optional() }),
  response: {
    200: output({
      party: output({ id: id(), code: z.string(), name: z.string(), kind: z.enum(PARTY_KINDS), roles: z.array(z.enum(PARTY_ROLES)), status: z.enum(PARTY_STATUSES) }),
      company: label,
      /** The account holds in force for the company (its own and every company's), the oldest first. */
      hold: output({ onHold: z.boolean(), holds: z.array(hold) }),
      /** The team or dealer a rider is under (null: not a rider, or a team the reader may not see). */
      team: output({ id: id(), code: z.string(), name: z.string(), status: z.enum(PARTY_STATUSES) }).nullable(),
      requirements: output({ count: z.number().int(), rows: z.array(requirement) }),
      promises: output({ open: z.number().int(), late: z.number().int(), noPromise: z.number().int(), next: businessDate().nullable() }).nullable(),
      credit: output({
        state: z.enum(['NONE', 'WITHIN', 'OVER']),
        currency: z.string().nullable(),
        limit: amount(),
        used: amount(),
        available: amount(),
        overLimitBy: amount(),
        overdue: amount(),
        /** The share of the limit used, in whole percent (drawn only beside the amounts). */
        usedPct: notMoney(z.number().int().nullable()),
        onHold: z.boolean(),
      }).nullable(),
      samples: part(sample),
      profiles: part(profile),
      riders: part(rider),
      repairs: part(repair),
      withheld: z.array(z.enum(GLANCE_PARTS)),
      readAt: instant(),
    }),
  },
})
