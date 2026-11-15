import { z } from 'zod'
import { amountMinor, businessDate, currency, id, input, instant, output } from '../core/contracts'
import { money } from '../money/marked'
import { LINE_STATES, MAX_FIGURE_ENTRIES, MAX_FIGURES_NOTE, PAYMENT_FOUND_BY } from './figures'

/**
 * The contracts of a customer's own figures (B-W2b-406; FIN-135; apps/factory-api modules/receivables/their-figures; design
 * finance.bank sec:customer-figures). Every amount is a price (money.price): without the grain it is not sent, and a body
 * that types one is refused. Words are the screens' (from the states); the API sends none.
 */

const ref = output({ id: id(), code: z.string(), name: z.string() })

export const FIGURES_STATES = ['AGREES', 'DIFFERS'] as const
export type FiguresState = (typeof FIGURES_STATES)[number]

const figuresBody = input({
  orders: z.array(input({ reference: z.string().max(200), amount: money.price(amountMinor()) })).max(MAX_FIGURE_ENTRIES),
  payments: z.array(input({ reference: z.string().max(200), date: businessDate(), amount: money.price(amountMinor()) })).max(MAX_FIGURE_ENTRIES),
  balance: money.price(amountMinor()),
})

export const figuresParams = input({ figuresId: id() })

export const figuresListQuery = input({
  companyId: id(),
  partyId: id().optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
})

/** POST: a customer's figures as of a day; `fileId` = the statement as received (a file announced for these figures). */
export const recordFiguresBody = input({
  companyId: id(),
  partyId: id(),
  asOf: businessDate(),
  /** Default: the company's currency. */
  currency: currency().optional(),
  figures: figuresBody,
  note: z.string().max(MAX_FIGURES_NOTE).nullish(),
  fileId: id().nullish(),
})
export type RecordFiguresBody = z.infer<typeof recordFiguresBody>

/** PATCH: a typing mistake corrected at the version read (the company and the customer never change). */
export const correctFiguresBody = input({
  version: z.number().int().min(1),
  asOf: businessDate().optional(),
  figures: figuresBody.optional(),
  note: z.string().max(MAX_FIGURES_NOTE).nullish(),
})
export type CorrectFiguresBody = z.infer<typeof correctFiguresBody>

const summary = output({
  /** Our balance as of their day. */
  ours: money.price(z.number().int()),
  /** Their balance − ours. */
  difference: money.price(z.number().int()),
  /** Lines (and the balance) that do not agree. */
  differences: z.number().int(),
  state: z.enum(FIGURES_STATES),
})

export const figuresRowView = output({
  id: id(),
  company: ref,
  customer: ref,
  asOf: businessDate(),
  currency: z.string(),
  theirs: output({ orders: z.number().int(), payments: z.number().int(), balance: money.price(z.number().int()) }),
  summary,
  file: output({ id: id(), name: z.string() }).nullable(),
  note: z.string().nullable(),
  createdAt: instant(),
  createdBy: output({ id: id(), name: z.string().nullable() }).nullable(),
  updatedAt: instant(),
  can: output({ correct: z.boolean() }),
  version: z.number().int(),
})
export type FiguresRowView = z.infer<typeof figuresRowView>

const ourDocument = output({
  kind: z.enum(['INVOICE', 'ORDER']),
  id: id(),
  number: z.string(),
  invoices: z.array(output({ id: id(), number: z.string(), open: money.price(z.number().int()) })),
  open: money.price(z.number().int()),
})

export const comparisonView = output({
  balance: output({ theirs: money.price(z.number().int()), ours: money.price(z.number().int()), difference: money.price(z.number().int()), state: z.enum(['SAME', 'DIFFERS']) }),
  orders: z.array(
    output({
      /** Their entry's place in what they listed (null: only ours). */
      index: z.number().int().nullable(),
      reference: z.string().nullable(),
      theirs: money.price(z.number().int()),
      ours: ourDocument.nullable(),
      state: z.enum(LINE_STATES),
      difference: money.price(z.number().int()),
    }),
  ),
  payments: z.array(
    output({
      index: z.number().int().nullable(),
      reference: z.string().nullable(),
      date: businessDate().nullable(),
      theirs: money.price(z.number().int()),
      ours: output({ id: id(), reference: z.string(), receivedOn: businessDate(), amount: money.price(z.number().int()) }).nullable(),
      foundBy: z.enum(PAYMENT_FOUND_BY).nullable(),
      state: z.enum(LINE_STATES),
      difference: money.price(z.number().int()),
    }),
  ),
  paymentsFrom: businessDate().nullable(),
  differences: z.number().int(),
})
export type ComparisonView = z.infer<typeof comparisonView>

export const figuresListAnswer = output({ companyId: id(), figures: z.array(figuresRowView) })
export const figuresAnswer = output({ figures: figuresRowView, comparison: comparisonView })
export type FiguresAnswer = z.infer<typeof figuresAnswer>
