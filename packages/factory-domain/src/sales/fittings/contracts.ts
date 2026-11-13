import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { APPOINTMENT_MAILS } from '../../fittings/events'
import { APPOINTMENT_KINDS, APPOINTMENT_STATUSES, CLOSE_OUTCOMES, FITTING_LIMITS, FITTING_VERDICTS, POINT_UNITS, REMAKE_OUTCOMES } from './rules'

/**
 * Fittings, alterations and remakes (B-W2b-360): what apps/factory-api's modules/sales/fittings accepts and answers. No money:
 * a remake order is at no price and answers its number only. Point changes travel as signed decimal strings in the point's unit
 * ("+2.0"); body data and the rider's appointments are office reads (sales.measurements.view).
 */

const text = (max: number) => z.string().trim().min(1).max(max)
const oneLine = (max: number) => text(max).refine((value) => !/[\r\n]/.test(value), { message: 'One line.' })
const language = z.enum(['it', 'en'])
const named = output({ id: id(), name: z.string() })

// ---- appointments (SAL-054) -------------------------------------------------------------------------------------------------

export const appointmentsQuery = input({
  /** Starting at or after (default: the beginning of today), before `to`. */
  from: instant().optional(),
  to: instant().optional(),
  kind: z.enum(APPOINTMENT_KINDS).optional(),
  status: z.enum(APPOINTMENT_STATUSES).optional(),
  partyId: id().optional(),
  /** The appointments of this revision's rider and garment type (every revision). */
  profileId: id().optional(),
  limit: z.coerce.number().int().min(1).max(FITTING_LIMITS.list).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
})
export type AppointmentsQuery = z.output<typeof appointmentsQuery>

/** POST /sales/fittings/appointments: a fitting, a showroom visit or a measuring session, booked (and the invite mailed). */
export const bookBody = input({
  companyId: id(),
  partyId: id(),
  kind: z.enum(APPOINTMENT_KINDS),
  /** A FITTING's rider profile revision (required); a showroom visit or a measuring session may name one. */
  measurementProfileId: id().nullish(),
  /** Without a profile: the measurement template's code it is for (made-to-measure started per template, GATE-MTM). */
  garmentType: z.string().trim().min(1).max(60).nullish(),
  /** The rider: a contact of the customer, and/or the name as told (default: the profile's). */
  contactId: id().nullish(),
  riderName: oneLine(FITTING_LIMITS.name).nullish(),
  startsAt: instant(),
  endsAt: instant(),
  place: oneLine(FITTING_LIMITS.place),
  /** The fitter: an office person of ours, and/or someone outside by name (a dealer's fitter). */
  withUserId: id().nullish(),
  withName: oneLine(FITTING_LIMITS.name).nullish(),
  notes: text(FITTING_LIMITS.notes).nullish(),
  /** Mail the invite (.ics) to the rider now (default true; FAKE locally). */
  invite: z.boolean().default(true),
  /** The mail's language (default: the rider's contact's, else Italian). */
  language: language.optional(),
})
export type BookBody = z.output<typeof bookBody>

/** PATCH /sales/fittings/appointments/:id: a booked one moved (only its notes once closed). */
export const moveBody = input({
  version: z.number().int().min(1),
  startsAt: instant().optional(),
  endsAt: instant().optional(),
  place: oneLine(FITTING_LIMITS.place).optional(),
  measurementProfileId: id().nullish(),
  contactId: id().nullish(),
  riderName: oneLine(FITTING_LIMITS.name).nullish(),
  withUserId: id().nullish(),
  withName: oneLine(FITTING_LIMITS.name).nullish(),
  notes: text(FITTING_LIMITS.notes).nullish(),
  /** Mail the update (.ics) when the time, the place or who changed and an invite went before (default true). */
  invite: z.boolean().default(true),
  language: language.optional(),
})
export type MoveBody = z.output<typeof moveBody>

/** POST …/close: it took place (DONE, saying who was there) or the rider did not come (MISSED). */
export const closeBody = input({
  version: z.number().int().min(1),
  status: z.enum(CLOSE_OUTCOMES),
  /** When (default now; not before it started). */
  closedAt: instant().optional(),
  withUserId: id().nullish(),
  withName: oneLine(FITTING_LIMITS.name).nullish(),
  notes: text(FITTING_LIMITS.notes).nullish(),
})
export type CloseBody = z.output<typeof closeBody>

/** POST …/cancel: cancelled with why (the office's words; the rider's mail never says them). */
export const cancelBody = input({
  version: z.number().int().min(1),
  reason: text(FITTING_LIMITS.cancelReason),
  /** Mail the cancellation (.ics CANCEL) when an invite went before (default true). */
  notify: z.boolean().default(true),
  language: language.optional(),
})
export type CancelBody = z.output<typeof cancelBody>

/** POST …/invite: the invite (.ics) mailed again. */
export const inviteBody = input({ version: z.number().int().min(1), language: language.optional() })
export type InviteBody = z.output<typeof inviteBody>

/** POST …/led-to: a done showroom visit or measuring session names the profile revision it led to, once. */
export const ledToBody = input({ version: z.number().int().min(1), profileId: id() })
export type LedToBody = z.output<typeof ledToBody>

const mailView = output({ id: id(), mail: z.enum(APPOINTMENT_MAILS), status: z.string(), queuedAt: z.string(), sentAt: z.string().nullable() })

export const appointmentRowView = output({
  id: id(),
  companyId: id(),
  partyId: id(),
  customer: output({ code: z.string(), name: z.string() }),
  kind: z.enum(APPOINTMENT_KINDS),
  status: z.enum(APPOINTMENT_STATUSES),
  rider: output({ contactId: id().nullable(), name: z.string().nullable() }),
  profile: output({ id: id(), revision: z.number().int(), garmentType: z.string() }).nullable(),
  /** The profile's garment type, else the one it was booked for. */
  garmentType: z.string().nullable(),
  startsAt: z.string(),
  endsAt: z.string(),
  place: z.string(),
  with: output({ userId: id().nullable(), name: z.string().nullable() }),
  inviteSentAt: z.string().nullable(),
  reminderSentAt: z.string().nullable(),
  results: z.number().int(),
  version: z.number().int(),
})

export const appointmentsView = output({ rows: z.array(appointmentRowView), matching: z.number().int(), asOf: z.string() })

const resultRowView = output({ id: id(), verdict: z.enum(FITTING_VERDICTS), fittedAt: z.string(), salesOrderLineId: id().nullable() })

export const appointmentView = output({
  ...appointmentRowView.shape,
  closedAt: z.string().nullable(),
  closedBy: named.nullable(),
  cancelReason: z.string().nullable(),
  notes: z.string().nullable(),
  /** The rider has an address the invite can go to. */
  mailTo: z.boolean(),
  mails: z.array(mailView),
  resultList: z.array(resultRowView),
  createdAt: z.string(),
  createdBy: named.nullable(),
  may: output({ move: z.boolean(), close: z.boolean(), cancel: z.boolean(), invite: z.boolean(), ledTo: z.boolean(), result: z.boolean(), notes: z.boolean() }),
  /** Why the booked actions are not offered (closed, made-to-measure off, no right), or null. */
  why: z.string().nullable(),
})

const warning = output({ path: z.string(), message: z.string() })

export const bookedView = output({ appointment: appointmentView, mailed: z.boolean(), delivery: z.string().nullable(), warnings: z.array(warning) })

// ---- fitting results (SAL-297) ------------------------------------------------------------------------------------------------

const pointChangeBody = input({
  change: z.string().trim().min(1).max(8),
  unit: z.enum(POINT_UNITS).optional(),
  note: z.string().max(FITTING_LIMITS.pointNote).optional(),
})

/** POST /sales/fittings/results: what a fitting found (of a FITTING appointment and/or a made-to-measure order line). */
export const resultBody = input({
  appointmentId: id().nullish(),
  salesOrderLineId: id().nullish(),
  /** The revision fitted (default: the order line's, else the appointment's). */
  measurementProfileId: id().nullish(),
  /** When (default now; not before the appointment started, not before the rider was measured). */
  fittedAt: instant().optional(),
  verdict: z.enum(FITTING_VERDICTS),
  /** Per point of the revision's measures: the change asked, in its unit ("+2.0"). */
  pointChanges: z.record(z.string().max(60), pointChangeBody).default({}),
  notes: text(FITTING_LIMITS.notes).nullish(),
  /** ALTER: the days the alteration adds to the unit's date. */
  alterationDays: z.number().int().nullish(),
})
export type ResultBody = z.output<typeof resultBody>

/** POST /sales/fittings/results/:id/alteration: the alteration it opens (W2a's repair command, kind ALTERATION). */
export const alterationBody = input({
  version: z.number().int().min(1),
  /** The work asked (default: the point changes and the words, in words). */
  workWanted: text(2000).optional(),
  /** The site that alters it (default: the company's only plant). */
  siteId: id().optional(),
  /** The garment came with the rider: received now (or at `at`); else the alteration waits for it. */
  received: input({ at: instant().optional() }).optional(),
  internalNote: text(2000).optional(),
  /** Move the unit's promise by the alteration's days (the order line's date; default true). */
  movePromise: z.boolean().default(true),
})
export type AlterationBody = z.output<typeof alterationBody>

/** POST /sales/fittings/results/:id/revision: the new measurement revision it led to (recorded first by the office). */
export const revisionBody = input({ version: z.number().int().min(1), profileId: id() })
export type RevisionBody = z.output<typeof revisionBody>

export const resultView = output({
  id: id(),
  companyId: id(),
  partyId: id(),
  appointment: output({ id: id(), startsAt: z.string(), place: z.string(), status: z.enum(APPOINTMENT_STATUSES) }).nullable(),
  orderLine: output({ id: id(), orderId: id(), orderNumber: z.string(), seq: z.number().int(), style: z.string(), colourway: z.string(), baseSize: z.string().nullable() }).nullable(),
  profile: output({ id: id(), revision: z.number().int(), riderName: z.string(), garmentType: z.string() }),
  fittedAt: z.string(),
  verdict: z.enum(FITTING_VERDICTS),
  pointChanges: z.array(output({ code: z.string(), name: z.string(), change: z.string(), unit: z.string(), note: z.string().nullable() })),
  notes: z.string().nullable(),
  alterationDays: z.number().int().nullable(),
  alteration: output({ id: id(), number: z.string(), stage: z.string() }).nullable(),
  newProfile: output({ id: id(), revision: z.number().int(), review: z.string() }).nullable(),
  /** The order line's promise now (its own date, else the order's), when there is an order line. */
  promise: output({ current: businessDate().nullable(), byAlteration: businessDate().nullable() }).nullable(),
  /** What comes next, in words (null: nothing). */
  next: z.string().nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  createdBy: named.nullable(),
  may: output({ alteration: z.boolean(), revision: z.boolean() }),
})

export const recordedResultView = output({ result: resultView, appointmentClosed: z.boolean() })

export const alteredView = output({
  result: resultView,
  repair: output({ id: id(), number: z.string(), stage: z.string() }),
  /** The unit's date moved by the alteration's days, or why not. */
  promise: output({ moved: z.boolean(), from: businessDate().nullable(), to: businessDate().nullable(), why: z.string().nullable() }),
  warnings: z.array(warning),
})

/** GET /sales/mtm/profiles/:profileId/fittings: the rider profile's Fittings tab. */
export const fittingsTabView = output({
  profileId: id(),
  riderName: z.string(),
  garmentType: z.string(),
  appointments: z.array(appointmentRowView),
  results: z.array(resultView),
  nextFittingAt: z.string().nullable(),
  /** Made-to-measure has started for the garment type's template (GATE-MTM): nothing is booked or recorded while off. */
  started: z.boolean(),
  may: output({ book: z.boolean(), record: z.boolean() }),
})

// ---- the remake order (SAL-353) ------------------------------------------------------------------------------------------------

/** POST /sales/returns/:id/remake-order: the units decided REMAKE (default every one not yet remade), each to a revision. */
export const remakeOrderBody = input({
  version: z.number().int().min(1),
  lines: z.array(input({ lineId: id(), /** Default: the rider's newest revision. */ profileId: id().optional() })).min(1).max(100).optional(),
  promiseDate: businessDate().nullish(),
  customerRef: z.string().trim().max(60).nullish(),
  internalNote: z.string().trim().max(2000).nullish(),
})
export type RemakeOrderBody = z.output<typeof remakeOrderBody>

const unitView = output({
  orderLineId: id(),
  orderId: id(),
  orderNumber: z.string(),
  seq: z.number().int(),
  style: z.string(),
  colourway: z.string(),
  baseSize: z.string().nullable(),
  madeTo: output({ id: id(), revision: z.number().int(), review: z.string() }),
  newest: output({ id: id(), revision: z.number().int(), review: z.string() }),
  /** Made-to-measure has started for the unit's template (GATE-MTM). */
  started: z.boolean(),
})

export const remakeView = output({
  returnId: id(),
  number: z.string(),
  status: z.string(),
  version: z.number().int(),
  lines: z.array(
    output({
      lineId: id(),
      seq: z.number().int(),
      description: z.string(),
      disposition: z.string().nullable(),
      goodsOutcome: z.string().nullable(),
      unit: unitView.nullable(),
      remakeOrder: output({ orderId: id(), number: z.string(), orderLineId: id(), profileId: id(), status: z.string() }).nullable(),
      /** Why this line cannot be remade now (null: it can, or it is). */
      held: z.string().nullable(),
    }),
  ),
  outcomes: z.array(z.enum(REMAKE_OUTCOMES)),
  may: output({ order: z.boolean() }),
  why: z.string().nullable(),
})

export const remadeView = output({ remake: remakeView, order: output({ id: id(), number: z.string(), status: z.string() }) })
