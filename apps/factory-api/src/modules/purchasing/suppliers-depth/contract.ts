import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { LIMITS, REASON_MAX, SUPPLIER_KINDS, SUPPLIER_STATUSES } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import { CONTACT_RECEIVES } from '@nexus/factory-domain/purchasing/suppliers-depth/routing'

/**
 * Suppliers in depth (B-W2b-311; design purchasing.suppliers: the list's kinds and status, the record's Overview "Roles",
 * "Closures", "Origin" and "Now", Contacts "Contacts and what they receive"). Office only. Each write names the `version`
 * it read: the party's for its profile and status, the contact's for what it receives (COL-078). No money here.
 */

const version = z.number().int().min(1)
const country = z.string().trim().length(2)

const closedSpan = output({ from: businessDate(), to: businessDate(), kind: z.string(), name: z.string(), days: z.number().int(), words: z.string() })

const statusView = output({
  /** What the list shows: W1's BLOCKED or ARCHIVED over the supplier status; none set: W1's status read as one. */
  status: z.enum(SUPPLIER_STATUSES),
  source: z.enum(['PARTY', 'SUPPLIER']),
  /** The supplier status itself; null: not set yet (W1's party status alone). */
  supplierStatus: z.enum(SUPPLIER_STATUSES).nullable(),
  reason: z.string().nullable(),
  changedAt: instant().nullable(),
  changedBy: z.string().nullable(),
})

const routingView = output({
  kind: z.enum(CONTACT_RECEIVES),
  by: z.enum(['RECEIVES', 'ROLE', 'NONE']),
  contactIds: z.array(id()),
  sentence: z.string(),
})

const contactView = output({
  id: id(),
  name: z.string(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
  roles: z.array(z.string()),
  receives: z.array(z.enum(CONTACT_RECEIVES)),
  language: z.string().nullable(),
  status: z.string(),
  version: z.number().int(),
})

const supplierView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  legalName: z.string(),
  roles: z.array(z.string()),
  partyStatus: z.string(),
  kinds: z.array(z.enum(SUPPLIER_KINDS)),
  standing: statusView,
  /** Why no new purchase order goes to it now, in words; null: it may get one. */
  newOrderProblem: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  origin: output({
    country: z.string().nullable(),
    region: z.string().nullable(),
    note: z.string().nullable(),
    hideCountries: z.array(z.string()),
    tannages: z.array(z.enum(TANNAGES)),
  }),
  closures: output({
    /** Its calendar (Purchasing › Supplier closures, platform/calendars); null: none, so no dated closed days. */
    calendarId: id().nullable(),
    weeklyDaysOff: z.array(z.number().int()),
    /** Its dated closed days of the next year, as spans. */
    ahead: z.array(closedSpan),
    /** An order placed today with its default lead time (null without one): when it arrives, the closures walked past. */
    orderedToday: output({ orderDate: businessDate(), leadTimeDays: z.number().int(), arrives: businessDate(), skipped: z.array(closedSpan.omit({ words: true })), capped: z.boolean(), words: z.string() }).nullable(),
  }),
  contacts: z.array(contactView),
  routing: z.array(routingView),
  version: z.number().int(),
})

const partyParams = input({ partyId: id() })

export const getProfileContract = defineContract({ params: partyParams, response: { 200: output({ supplier: supplierView }) } })

export const updateProfileContract = defineContract({
  params: partyParams,
  body: input({
    version,
    /** Replaces the list (each once); [] removes every kind. */
    kinds: z.array(z.enum(SUPPLIER_KINDS)).max(SUPPLIER_KINDS.length).optional(),
    /** The default lead time in calendar days; null clears it. */
    leadTimeDays: z.number().int().min(0).max(LIMITS.leadTimeDays).nullable().optional(),
    originCountry: country.nullable().optional(),
    originRegion: z.string().max(LIMITS.region).nullable().optional(),
    originNote: z.string().max(LIMITS.note).nullable().optional(),
    /** A tannery's: where its raw hides come from (replaces the list). */
    hideOriginCountries: z.array(country).max(LIMITS.hideCountries).optional(),
    /** A tannery's (replaces the list). */
    tannages: z.array(z.enum(TANNAGES)).max(TANNAGES.length).optional(),
  }),
  response: { 200: output({ supplier: supplierView }) },
})

export const setStatusContract = defineContract({
  params: partyParams,
  body: input({
    version,
    status: z.enum(SUPPLIER_STATUSES),
    /** Needed for CONDITIONAL, ON_HOLD and BLOCKED; one line. The same status with a new reason corrects the reason. */
    reason: z.string().max(REASON_MAX).nullable().optional(),
  }),
  response: { 200: output({ supplier: supplierView }) },
})

const reachView = output({
  status: z.enum(SUPPLIER_STATUSES),
  /** Draft (or waiting for a yes) orders that would be held at their send. */
  draftsHeld: z.number().int(),
  /** Sent orders still open: they run on unchanged. */
  openUnchanged: z.number().int(),
  sentence: z.string(),
})

export const statusReachContract = defineContract({
  params: partyParams,
  querystring: input({ status: z.enum(SUPPLIER_STATUSES) }),
  response: { 200: output({ reach: reachView }) },
})

export const setReceivesContract = defineContract({
  params: input({ partyId: id(), contactId: id() }),
  body: input({ version, receives: z.array(z.enum(CONTACT_RECEIVES)).max(CONTACT_RECEIVES.length) }),
  response: { 200: output({ supplier: supplierView }) },
})

const rowView = output({
  id: id(),
  companyId: id().nullable(),
  code: z.string(),
  name: z.string(),
  roles: z.array(z.string()),
  kinds: z.array(z.enum(SUPPLIER_KINDS)),
  status: z.enum(SUPPLIER_STATUSES),
  source: z.enum(['PARTY', 'SUPPLIER']),
  since: instant().nullable(),
  country: z.string(),
  originCountry: z.string().nullable(),
  leadTimeDays: z.number().int().nullable(),
  version: z.number().int(),
})

export const listSuppliersContract = defineContract({
  querystring: input({
    /** Rows ▾ Tanneries, Subcontractors …: suppliers with this kind. */
    kind: z.enum(SUPPLIER_KINDS).optional(),
    /** The status the list shows (W1's party status read as one where none is set). */
    status: z.enum(SUPPLIER_STATUSES).optional(),
    /** The suppliers that hold for this company (its own and every company's). */
    companyId: id().optional(),
    /** The code or a name, case-insensitive. */
    q: z.string().trim().min(1).max(80).optional(),
    cursor: id().optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  }),
  response: { 200: output({ suppliers: z.array(rowView), nextCursor: id().nullable() }) },
})

export const supplierCountsContract = defineContract({
  querystring: input({ companyId: id().optional() }),
  response: { 200: output({ counts: output(Object.fromEntries(SUPPLIER_STATUSES.map((status) => [status, z.number().int()])) as Record<(typeof SUPPLIER_STATUSES)[number], z.ZodNumber>), suppliers: z.number().int() }) },
})
