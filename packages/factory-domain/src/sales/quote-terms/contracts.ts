import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import { QUOTE_VERSION_STATUSES, SALES_LINE_KINDS } from '../quotes/quotes'
import { ACCEPTANCE_MODES, DELIVERY_NOTE_MAX, INCOTERMS, MAX_DELIVERIES, PLACE_MAX, STORED_ACCEPTANCE_MODES, VALIDITY_STATES } from './rules'

/**
 * A quote's delivery terms, delivery schedule and validity (B-W2b-294; SAL-145, SAL-151, SAL-162): what apps/factory-api's
 * modules/sales/quote-terms accepts and answers. Every write names the quote's `version` (W1's edit-conflict guard) and
 * changes the current DRAFT version only. No money here.
 */

const version = () => z.number().int().min(1)

export const quoteParams = input({ quoteId: id() })
export const lineParams = input({ quoteId: id(), lineId: id() })

export const termsBody = input({
  version: version(),
  /** An Incoterms 2020 rule; null: none (then no place). */
  incoterm: z.string().trim().toUpperCase().max(3).nullish(),
  incotermPlace: z.string().trim().max(PLACE_MAX).nullish(),
  /** true: ship complete; false: ship as ready. */
  shipComplete: z.boolean().optional(),
  acceptanceMode: z.enum(ACCEPTANCE_MODES).optional(),
})
export type TermsBody = z.output<typeof termsBody>

export const deliveryBody = input({
  deliveryDate: businessDate(),
  /** Pieces per size of the line ({ "50": 1, "52": 2 }); none for a made-to-measure unit. */
  sizes: z.record(z.string().trim().min(1).max(40), z.number().int().min(0).max(100_000)).nullish(),
  note: z.string().trim().max(DELIVERY_NOTE_MAX).nullish(),
})

export const scheduleBody = input({
  version: version(),
  /** The line's whole schedule (none: no schedule, every piece at the promise date). */
  deliveries: z.array(deliveryBody).max(MAX_DELIVERIES),
})
export type ScheduleBody = z.output<typeof scheduleBody>

export const deliveryView = output({
  id: id(),
  deliveryDate: businessDate(),
  sizes: z.record(z.string(), z.number().int()).nullable(),
  quantity: z.number().int(),
  note: z.string().nullable(),
})

export const lineScheduleView = output({
  lineId: id(),
  seq: z.number().int(),
  kind: z.enum(SALES_LINE_KINDS),
  label: z.string(),
  quantity: z.number().int(),
  deliveries: z.array(deliveryView),
  /** What goes at the promise date, per size (empty: everything is scheduled). */
  atPromiseDate: z.record(z.string(), z.number().int()),
})

export const validityView = output({
  validUntil: businessDate().nullable(),
  firmOffer: z.boolean(),
  state: z.enum(VALIDITY_STATES),
  daysLeft: z.number().int().nullable(),
  /** The day the reminder goes to the customer (null: none will). */
  reminderOn: businessDate().nullable(),
  reminderSentAt: instant().nullable(),
  /** B-W2b-F38: the quote reminder switch of the quote's company (Sales settings; off by default): false, no reminder goes. */
  remindersEnabled: z.boolean(),
  /** When it reached EXPIRED (its closedAt). */
  expiredAt: instant().nullable(),
})

export const termsView = output({
  quoteId: id(),
  versionId: id(),
  revision: z.number().int(),
  status: z.enum(QUOTE_VERSION_STATUSES),
  /** The terms change only while the version is a DRAFT. */
  editable: z.boolean(),
  language: z.enum(['it', 'en']),
  incoterm: z.string().nullable(),
  incotermPlace: z.string().nullable(),
  /** "EXW Seedville (Ex Works)", in the document's language. */
  incotermWords: z.string().nullable(),
  shipComplete: z.boolean(),
  shipWords: z.string(),
  acceptanceMode: z.enum(STORED_ACCEPTANCE_MODES),
  depositPct: z.string().nullable(),
  promiseDate: businessDate().nullable(),
  /** The customer's own Incoterm (its record), offered when the quote has none. */
  customerIncoterm: z.string().nullable(),
  validity: validityView,
  lines: z.array(lineScheduleView),
  quoteVersion: z.number().int(),
  incoterms: z.array(output({ code: z.enum(INCOTERMS), words: z.string(), seaOnly: z.boolean() })),
})
export type TermsView = z.infer<typeof termsView>
