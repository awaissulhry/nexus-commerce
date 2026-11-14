import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CSV_ENCODINGS } from '@nexus/factory-domain/imports/job'
import { NUMBER_FORMATS } from '@nexus/factory-domain/imports/cells'
import { money, notMoney } from '@nexus/factory-domain/money/marked'
import { BANK_FORMATS, BANK_LINE_PROBLEMS } from '@nexus/factory-domain/payments/bank-formats/statement'
import { LINE_VERDICTS } from '@nexus/factory-domain/payments/bank/import'
import { MATCH_CONFIDENCES, MATCH_REASONS } from '@nexus/factory-domain/payments/matching/match'
import { WRITE_OFF_KINDS, WRITE_OFF_REFUSALS } from '@nexus/factory-domain/payments/write-offs/write-offs'
import { LINE_VIEWS } from './reads'

/**
 * The bank routes' contracts (B-W2b-393; FIN-130, FIN-132; design finance.bank). Every amount is marked money.price;
 * reasons, confidence, verdicts and problems are codes with their words.
 */

const format = z.enum(BANK_FORMATS)
const cursorLimit = { cursor: z.string().max(200).optional(), limit: z.coerce.number().int().min(1).max(200).default(50) }

export const matchViewSchema = output({
  id: id(),
  version: z.number().int(),
  partyId: id(),
  party: output({ code: z.string(), legalName: z.string() }),
  confidence: z.enum(MATCH_CONFIDENCES),
  confidenceWords: z.string(),
  reasons: z.array(output({ code: z.enum(MATCH_REASONS), words: z.string() })),
  chosenByPerson: z.boolean(),
  items: z.array(output({ kind: z.enum(['INVOICE', 'DEPOSIT_REQUEST']), id: id(), number: z.string().nullable(), docType: z.string().nullable(), openAmount: money.price(z.number().int()) })),
  paymentId: id().nullable(),
  payment: output({ externalRef: z.string(), receivedOn: z.string(), status: z.string() }).nullable(),
  supplierInvoiceId: id().nullable(),
  supplierInvoice: output({ number: z.string(), status: z.string() }).nullable(),
  /** What accepting this suggestion now leaves: the leftover (OVERPAYMENT) or the invoice left short (UNDERPAYMENT). */
  difference: output({ kind: z.enum(WRITE_OFF_KINDS), amount: money.price(z.number().int()), writable: z.boolean(), refusal: output({ code: z.enum(WRITE_OFF_REFUSALS), words: z.string() }).nullable() }).nullable(),
  /** An item it names has nothing left to pay (paid meanwhile): it cannot be accepted; the next look removes it. */
  stale: z.boolean(),
  acceptedAt: instant().nullable(),
  acceptedById: id().nullable(),
  reversedAt: instant().nullable(),
  reversedById: id().nullable(),
  reverseReason: z.string().nullable(),
})

export const lineViewSchema = output({
  id: id(),
  companyId: id(),
  bankAccountId: id(),
  statementId: id(),
  bookedOn: z.string(),
  valueOn: z.string().nullable(),
  amount: money.price(z.number().int()),
  currency: z.string(),
  direction: z.enum(['IN', 'OUT']),
  bankReference: z.string().nullable(),
  referenceText: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  counterpartyIban: z.string().nullable(),
  state: z.enum(['TO_MATCH', 'MATCHED']),
  ageDays: z.number().int(),
  accepted: matchViewSchema.nullable(),
  suggestions: z.array(matchViewSchema),
  reversed: z.array(matchViewSchema),
})

const companyQuery = input({ companyId: id() })

export const listAccountsContract = defineContract({
  querystring: companyQuery,
  response: {
    200: output({
      accounts: z.array(output({ id: id(), holder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable(), currency: z.string(), active: z.boolean(), version: z.number().int(), lastStatementOn: z.string().nullable(), statements: z.number().int() })),
    }),
  },
})

export const listStatementsContract = defineContract({
  querystring: input({ companyId: id(), bankAccountId: id().optional(), ...cursorLimit }),
  response: {
    200: output({
      statements: z.array(output({ id: id(), bankAccountId: id(), fileId: id(), fileName: z.string(), format, periodStart: z.string(), periodEnd: z.string(), lines: z.number().int(), importedById: id(), importedAt: instant() })),
      nextCursor: z.string().nullable(),
    }),
  },
})

export const getStatementContract = defineContract({
  params: input({ statementId: z.string() }),
  response: {
    200: output({
      statement: output({ id: id(), companyId: id(), bankAccountId: id(), fileId: id(), fileName: z.string(), format, periodStart: z.string(), periodEnd: z.string(), importedById: id(), importedBy: z.string().nullable(), importedAt: instant() }),
      lines: z.array(lineViewSchema),
    }),
  },
})

export const listLinesContract = defineContract({
  querystring: input({ companyId: id(), view: z.enum(LINE_VIEWS).optional(), bankAccountId: id().optional(), direction: z.enum(['IN', 'OUT']).optional(), ...cursorLimit }),
  response: { 200: output({ view: z.enum(LINE_VIEWS), lines: z.array(lineViewSchema), nextCursor: z.string().nullable() }) },
})

export const lineCountsContract = defineContract({
  querystring: companyQuery,
  response: {
    200: output({ companyId: id(), today: z.string(), oldAfterDays: z.number().int(), toMatch: z.number().int(), sureMatches: z.number().int(), unmatchedOverDays: z.number().int(), lastStatementOn: z.string().nullable() }),
  },
})

export const getLineContract = defineContract({
  params: input({ lineId: z.string() }),
  response: { 200: output({ line: lineViewSchema }) },
})

export const paymentBankLineContract = defineContract({
  params: input({ paymentId: z.string() }),
  response: {
    200: output({
      paymentId: id(),
      /** No bank line: the payment was typed by hand. */
      recordedByHand: z.boolean(),
      /** Null when typed by hand, or when the reader may not see the company's bank (payments.bank.view). */
      line: output({ id: id(), statementId: id(), bank: z.string().nullable(), accountIban: z.string().nullable(), bookedOn: z.string(), valueOn: z.string().nullable(), referenceText: z.string().nullable(), counterpartyName: z.string().nullable(), counterpartyIban: z.string().nullable(), match: matchViewSchema }).nullable(),
    }),
  },
})

export const announceStatementContract = defineContract({
  body: input({
    companyId: id(),
    originalName: z.string().trim().min(1).max(255),
    sizeBytes: z.number().int().min(1).max(10 * 1_048_576),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
    format: format.optional(),
  }),
  response: {
    201: output({
      statementId: id(),
      format,
      file: output({ id: id(), status: z.string(), originalName: z.string(), contentType: z.string(), kind: z.string() }),
      upload: output({ method: z.string(), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: instant() }),
    }),
  },
})

const readBody = {
  fileId: id(),
  format: format.optional(),
  bankAccountId: id().nullish(),
  /** A CSV or Excel sheet's headers → the statement's columns (null: leave the header out). */
  mapping: z.record(z.string().max(200), z.enum(['bookedOn', 'valueOn', 'amount', 'moneyIn', 'moneyOut', 'currency', 'bankReference', 'referenceText', 'counterpartyName', 'counterpartyIban']).nullable()).optional(),
  numberFormat: z.enum(NUMBER_FORMATS).optional(),
  sheetName: z.string().max(200).nullish(),
  encoding: z.enum(CSV_ENCODINGS).nullish(),
}

const planSchema = output({
  fileId: id(),
  statementId: id(),
  companyId: id(),
  format,
  account: output({ id: id(), iban: z.string(), currency: z.string() }),
  fileIban: z.string().nullable(),
  ready: z.boolean(),
  period: output({ start: businessDate(), end: businessDate() }).nullable(),
  counts: output({ new: z.number().int(), duplicate: z.number().int(), error: z.number().int() }),
  totals: notMoney(output({ moneyIn: money.price(z.number().int()), moneyOut: money.price(z.number().int()) })),
  mapping: output({
    headers: z.array(z.string()),
    columns: z.array(output({ index: z.number().int(), header: z.string(), column: z.string() })),
    ignored: z.array(output({ index: z.number().int(), header: z.string(), reason: z.string() })),
    issues: z.array(output({ path: z.string(), message: z.string() })),
  }).nullable(),
  sheet: output({ name: z.string().nullable(), names: z.array(z.string()), encoding: z.string().nullable(), delimiter: z.string().nullable() }).nullable(),
  lines: z.array(
    output({
      row: z.number().int(),
      verdict: z.enum(LINE_VERDICTS),
      bookedOn: z.string().nullable(),
      valueOn: z.string().nullable(),
      amount: money.price(z.number().int().nullable()),
      currency: z.string().nullable(),
      bankReference: z.string().nullable(),
      referenceText: z.string().nullable(),
      counterpartyName: z.string().nullable(),
      counterpartyIban: z.string().nullable(),
      problems: z.array(output({ code: z.enum(BANK_LINE_PROBLEMS), words: z.string() })),
    }),
  ),
})

export const dryRunStatementContract = defineContract({
  body: input(readBody),
  response: { 200: planSchema },
})

export const importStatementContract = defineContract({
  body: input({ ...readBody, skipErrors: z.boolean().optional(), expectNew: z.number().int().min(0).optional() }),
  response: { 201: planSchema.extend({ lineIds: z.array(id()), suggested: z.number().int() }) },
})
