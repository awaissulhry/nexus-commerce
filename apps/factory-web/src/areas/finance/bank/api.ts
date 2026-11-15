import { z } from 'zod'
import { figuresAnswer, figuresListAnswer, type FiguresAnswer } from '@nexus/factory-domain/receivables-figures/contracts'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Finance › Bank (B-W2b-406 on B-W2b-393's API; design finance.bank, SCR-152): every call of the page, each answer checked
 * with zod. The lists of codes mirror factory-domain's (payments/{bank-formats,bank,matching,write-offs}: those modules read
 * files with node:crypto, so the browser cannot import them; `bank.vitest.test.ts` holds the lists equal). A customer's
 * own figures use factory-domain's receivables-figures contracts. Amounts are minor units and come only with the price grain
 * (absent otherwise); the API's English words are never drawn.
 */

export const LINE_VIEWS = ['TO_MATCH', 'SURE', 'OLD', 'MATCHED', 'ALL'] as const
export type LineView = (typeof LINE_VIEWS)[number]
export const MATCH_CONFIDENCES = ['HIGH', 'MEDIUM', 'LOW'] as const
export type MatchConfidence = (typeof MATCH_CONFIDENCES)[number]
export const MATCH_REASONS = ['AMOUNT_EQUAL', 'AMOUNT_WITHIN_TOLERANCE', 'NUMBER_IN_REFERENCE', 'IBAN_KNOWN', 'NAME_MATCHES', 'CHOSEN_BY_PERSON'] as const
export type MatchReason = (typeof MATCH_REASONS)[number]
export const WRITE_OFF_KINDS = ['UNDERPAYMENT', 'OVERPAYMENT'] as const
export const WRITE_OFF_REASONS = ['ROUNDING', 'BANK_CHARGES', 'OTHER'] as const
export type WriteOffReason = (typeof WRITE_OFF_REASONS)[number]
export const WRITE_OFF_REFUSALS = ['NO_TOLERANCE', 'OVER_TOLERANCE', 'NOTHING_LEFT', 'SHORT_ON_SEVERAL', 'SHORT_ON_DEPOSIT', 'NOTE_NEEDED', 'NOT_RECEIVED', 'NOT_AN_INVOICE_ALLOCATION', 'REVERSED_ALREADY', 'A_REVERSAL'] as const
export const BANK_FORMATS = ['CAMT053', 'CSV', 'XLSX', 'OFX'] as const
export type BankFormat = (typeof BANK_FORMATS)[number]
export const LINE_VERDICTS = ['NEW', 'DUPLICATE', 'ERROR'] as const
export const BANK_LINE_PROBLEMS = ['NO_DATE', 'BAD_DATE', 'FUTURE_DATE', 'NO_AMOUNT', 'BAD_AMOUNT', 'ZERO_AMOUNT', 'TOO_MANY_DECIMALS', 'OTHER_CURRENCY', 'BOTH_SIDES', 'REFERENCE_TOO_LONG'] as const
export const IMPORT_REFUSALS = ['FORMAT_UNKNOWN', 'FILE_NOT_READY', 'NOT_A_STATEMENT_FILE', 'FILE_USED', 'ACCOUNT_NEEDED', 'ACCOUNT_UNKNOWN', 'ACCOUNT_DIFFERS', 'ACCOUNT_OFF', 'CURRENCY_DIFFERS', 'MAPPING_INCOMPLETE', 'NOTHING_NEW', 'LINES_UNREADABLE', 'CHANGED_SINCE_DRY_RUN'] as const
export const STATEMENT_REFUSALS = ['UNREADABLE', 'NOT_THIS_FORMAT', 'NO_LINES', 'TOO_MANY_LINES', 'SEVERAL_ACCOUNTS'] as const
/** The statement's columns a CSV or Excel header may be mapped to (the dry run's `mapping`). */
export const STATEMENT_COLUMNS = ['bookedOn', 'valueOn', 'amount', 'moneyIn', 'moneyOut', 'currency', 'bankReference', 'referenceText', 'counterpartyName', 'counterpartyIban'] as const
export type StatementColumn = (typeof STATEMENT_COLUMNS)[number]
export const NUMBER_FORMATS = ['it', 'en'] as const
export type NumberFormat = (typeof NUMBER_FORMATS)[number]
/** The file name endings of each format (factory-domain payments/bank/import STATEMENT_FILES). */
export const FORMAT_EXTENSIONS: Readonly<Record<BankFormat, readonly string[]>> = { CAMT053: ['.xml', '.camt', '.053'], CSV: ['.csv', '.txt'], XLSX: ['.xlsx'], OFX: ['.ofx', '.qfx'] }
/** The largest statement file (the API's limit). */
export const MAX_STATEMENT_BYTES = 10 * 1_048_576

const amount = () => z.number().int().optional()

export const matchSchema = z.object({
  id: z.string(),
  version: z.number().int(),
  partyId: z.string(),
  party: z.object({ code: z.string(), legalName: z.string() }),
  confidence: z.enum(MATCH_CONFIDENCES),
  reasons: z.array(z.object({ code: z.enum(MATCH_REASONS) })),
  chosenByPerson: z.boolean(),
  items: z.array(z.object({ kind: z.enum(['INVOICE', 'DEPOSIT_REQUEST']), id: z.string(), number: z.string().nullable(), docType: z.string().nullable(), openAmount: amount() })),
  paymentId: z.string().nullable(),
  payment: z.object({ externalRef: z.string(), receivedOn: z.string(), status: z.string() }).nullable(),
  supplierInvoiceId: z.string().nullable(),
  supplierInvoice: z.object({ number: z.string(), status: z.string() }).nullable(),
  difference: z.object({ kind: z.enum(WRITE_OFF_KINDS), amount: amount(), writable: z.boolean(), refusal: z.object({ code: z.enum(WRITE_OFF_REFUSALS) }).nullable() }).nullable(),
  stale: z.boolean(),
  acceptedAt: z.string().nullable(),
  acceptedById: z.string().nullable(),
  reversedAt: z.string().nullable(),
  reversedById: z.string().nullable(),
  reverseReason: z.string().nullable(),
})
export type BankMatch = z.infer<typeof matchSchema>

export const lineSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  bankAccountId: z.string(),
  statementId: z.string(),
  bookedOn: z.string(),
  valueOn: z.string().nullable(),
  amount: amount(),
  currency: z.string(),
  direction: z.enum(['IN', 'OUT']),
  bankReference: z.string().nullable(),
  referenceText: z.string().nullable(),
  counterpartyName: z.string().nullable(),
  counterpartyIban: z.string().nullable(),
  state: z.enum(['TO_MATCH', 'MATCHED']),
  ageDays: z.number().int(),
  accepted: matchSchema.nullable(),
  suggestions: z.array(matchSchema),
  reversed: z.array(matchSchema),
})
export type BankLine = z.infer<typeof lineSchema>

const countsSchema = z.object({ companyId: z.string(), today: z.string(), oldAfterDays: z.number().int(), toMatch: z.number().int(), sureMatches: z.number().int(), unmatchedOverDays: z.number().int(), lastStatementOn: z.string().nullable() })
export type LineCounts = z.infer<typeof countsSchema>

const linesPage = z.object({ view: z.enum(LINE_VIEWS), lines: z.array(lineSchema), nextCursor: z.string().nullable() })
export type LinesPage = z.infer<typeof linesPage>

const accountSchema = z.object({ id: z.string(), holder: z.string(), iban: z.string(), bic: z.string().nullable(), bankName: z.string().nullable(), currency: z.string(), active: z.boolean(), version: z.number().int(), lastStatementOn: z.string().nullable(), statements: z.number().int() })
export type BankAccount = z.infer<typeof accountSchema>

const statementSchema = z.object({
  statement: z.object({ id: z.string(), companyId: z.string(), bankAccountId: z.string(), fileId: z.string(), fileName: z.string(), format: z.enum(BANK_FORMATS), periodStart: z.string(), periodEnd: z.string(), importedById: z.string(), importedBy: z.string().nullable(), importedAt: z.string() }),
  lines: z.array(lineSchema),
})
export type BankStatement = z.infer<typeof statementSchema>

export const planSchema = z.object({
  fileId: z.string(),
  statementId: z.string(),
  companyId: z.string(),
  format: z.enum(BANK_FORMATS),
  account: z.object({ id: z.string(), iban: z.string(), currency: z.string() }),
  fileIban: z.string().nullable(),
  ready: z.boolean(),
  period: z.object({ start: z.string(), end: z.string() }).nullable(),
  counts: z.object({ new: z.number().int(), duplicate: z.number().int(), error: z.number().int() }),
  totals: z.object({ moneyIn: amount(), moneyOut: amount() }),
  mapping: z
    .object({
      headers: z.array(z.string()),
      columns: z.array(z.object({ index: z.number().int(), header: z.string(), column: z.string() })),
      ignored: z.array(z.object({ index: z.number().int(), header: z.string() })),
      issues: z.array(z.object({ path: z.string() })),
    })
    .nullable(),
  sheet: z.object({ name: z.string().nullable(), names: z.array(z.string()), encoding: z.string().nullable(), delimiter: z.string().nullable() }).nullable(),
  lines: z.array(
    z.object({
      row: z.number().int(),
      verdict: z.enum(LINE_VERDICTS),
      bookedOn: z.string().nullable(),
      valueOn: z.string().nullable(),
      amount: z.number().int().nullable().optional(),
      currency: z.string().nullable(),
      bankReference: z.string().nullable(),
      referenceText: z.string().nullable(),
      counterpartyName: z.string().nullable(),
      counterpartyIban: z.string().nullable(),
      problems: z.array(z.object({ code: z.enum(BANK_LINE_PROBLEMS) })),
    }),
  ),
})
export type ImportPlan = z.infer<typeof planSchema>
const importedSchema = planSchema.extend({ lineIds: z.array(z.string()), suggested: z.number().int() })
export type Imported = z.infer<typeof importedSchema>

const acceptedSchema = z.object({ matchId: z.string(), bankLineId: z.string(), paymentId: z.string().nullable(), recorded: z.boolean() })
export type Accepted = z.infer<typeof acceptedSchema>

const key = () => newIdempotencyKey()

// ---- reads ---------------------------------------------------------------------------------------------------------------------

export const lineCounts = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<LineCounts> => api.get('/payments/bank/lines/counts', { query: { companyId }, schema: countsSchema, signal })

export const listLines = (api: ApiClient, query: { companyId: string; view: LineView; cursor?: string | null }, signal?: AbortSignal): Promise<LinesPage> =>
  api.get('/payments/bank/lines', { query: { companyId: query.companyId, view: query.view, cursor: query.cursor ?? undefined, limit: 50 }, schema: linesPage, signal })

export const getLine = (api: ApiClient, lineId: string, signal?: AbortSignal): Promise<BankLine> => api.get(`/payments/bank/lines/${encodeURIComponent(lineId)}`, { schema: z.object({ line: lineSchema }), signal }).then((answer) => answer.line)

export const listAccounts = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<BankAccount[]> =>
  api.get('/payments/bank/accounts', { query: { companyId }, schema: z.object({ accounts: z.array(accountSchema) }), signal }).then((answer) => answer.accounts)

export const getStatement = (api: ApiClient, statementId: string, signal?: AbortSignal): Promise<BankStatement> => api.get(`/payments/bank/statements/${encodeURIComponent(statementId)}`, { schema: statementSchema, signal })

// ---- matching ------------------------------------------------------------------------------------------------------------------

export interface WriteOffAsk {
  reason: WriteOffReason
  note?: string | null
}
export interface PeriodLockOverride {
  reason: string
}

export const acceptMatch = (api: ApiClient, match: Pick<BankMatch, 'id' | 'version'>, extra: { writeOff?: WriteOffAsk; periodLockOverride?: PeriodLockOverride } = {}): Promise<Accepted> =>
  api.post(`/payments/bank/matches/${encodeURIComponent(match.id)}/accept`, { body: { version: match.version, ...extra }, schema: acceptedSchema, idempotencyKey: key() })

export interface ChooseBody {
  partyId: string
  items?: Array<{ invoiceId?: string; depositRequestId?: string; amount?: number }>
  paymentId?: string
  writeOff?: WriteOffAsk
  periodLockOverride?: PeriodLockOverride
}
export const chooseMatch = (api: ApiClient, lineId: string, body: ChooseBody): Promise<Accepted> =>
  api.post(`/payments/bank/lines/${encodeURIComponent(lineId)}/match`, { body, schema: acceptedSchema, idempotencyKey: key() })

export const acceptMany = (api: ApiClient, companyId: string, matches: ReadonlyArray<Pick<BankMatch, 'id' | 'version'>>, writeOff?: WriteOffAsk): Promise<Accepted[]> =>
  api
    .post('/payments/bank/matches/accept', { body: { companyId, matches: matches.map((match) => ({ matchId: match.id, version: match.version })), ...(writeOff ? { writeOff } : {}) }, schema: z.object({ companyId: z.string(), accepted: z.array(acceptedSchema) }), idempotencyKey: key() })
    .then((answer) => answer.accepted)

export const reverseMatch = (api: ApiClient, match: Pick<BankMatch, 'id' | 'version'>, reason: string, periodLockOverride?: PeriodLockOverride) =>
  api.post(`/payments/bank/matches/${encodeURIComponent(match.id)}/reverse`, {
    body: { version: match.version, reason, ...(periodLockOverride ? { periodLockOverride } : {}) },
    schema: z.object({ matchId: z.string(), bankLineId: z.string(), paymentId: z.string().nullable(), voided: z.boolean() }),
    idempotencyKey: key(),
  })

export const refreshSuggestions = (api: ApiClient, companyId: string): Promise<number> =>
  api.post('/payments/bank/suggestions/refresh', { body: { companyId }, schema: z.object({ companyId: z.string(), changed: z.number().int() }), idempotencyKey: key() }).then((answer) => answer.changed)

// ---- importing a statement -----------------------------------------------------------------------------------------------------

/** The statement file announced, PUT to the store and confirmed: the file's id (a scanner may still hold it). */
export async function uploadStatement(api: ApiClient, companyId: string, file: File, format: BankFormat | null): Promise<{ fileId: string; format: BankFormat; ready: boolean }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post('/payments/bank/statements/uploads', {
    body: { companyId, originalName: file.name, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes), ...(format ? { format } : {}) },
    schema: z.object({ statementId: z.string(), format: z.enum(BANK_FORMATS), file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: key(),
  })
  await putToStore(announced.upload, bytes)
  const done = await api.post(`/files/${encodeURIComponent(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: key() })
  return { fileId: announced.file.id, format: announced.format, ready: done.file.status === 'AVAILABLE' }
}

export interface ReadAsk {
  fileId: string
  format?: BankFormat
  bankAccountId?: string | null
  mapping?: Record<string, StatementColumn | null>
  numberFormat?: NumberFormat
  sheetName?: string | null
}

export const dryRun = (api: ApiClient, ask: ReadAsk): Promise<ImportPlan> => api.post('/payments/bank/statements/dry-run', { body: ask, schema: planSchema, idempotencyKey: key() })

export const importStatement = (api: ApiClient, ask: ReadAsk & { skipErrors?: boolean; expectNew?: number }, idempotencyKey: string): Promise<Imported> =>
  api.post('/payments/bank/statements', { body: ask, schema: importedSchema, idempotencyKey })

// ---- a customer's own figures (FIN-135) ----------------------------------------------------------------------------------------

export type FiguresPage = z.infer<typeof figuresListAnswer>
export type FiguresRow = FiguresPage['figures'][number]

export const listFigures = (api: ApiClient, companyId: string, signal?: AbortSignal): Promise<FiguresRow[]> =>
  api.get('/receivables/their-figures', { query: { companyId, limit: 50 }, schema: figuresListAnswer, signal }).then((answer) => answer.figures)

export const getFigures = (api: ApiClient, figuresId: string, signal?: AbortSignal): Promise<FiguresAnswer> => api.get(`/receivables/their-figures/${encodeURIComponent(figuresId)}`, { schema: figuresAnswer, signal })

/** What a person typed (minor units), as the API takes it. */
export interface FiguresEntries {
  orders: Array<{ reference: string; amount: number }>
  payments: Array<{ reference: string; date: string; amount: number }>
  balance: number
}
export interface RecordFigures {
  companyId: string
  partyId: string
  asOf: string
  figures: FiguresEntries
  note?: string | null
  fileId?: string | null
}
export interface CorrectFigures {
  version: number
  asOf?: string
  figures?: FiguresEntries
  note?: string | null
}

export const recordFigures = (api: ApiClient, body: RecordFigures, idempotencyKey: string): Promise<FiguresAnswer> => api.post('/receivables/their-figures', { body, schema: figuresAnswer, idempotencyKey })

export const correctFigures = (api: ApiClient, figuresId: string, body: CorrectFigures, idempotencyKey: string): Promise<FiguresAnswer> =>
  api.request('PATCH', `/receivables/their-figures/${encodeURIComponent(figuresId)}`, { body, schema: figuresAnswer, idempotencyKey })

/** The customer's statement as received: a file announced for the figures it will be kept with (its record id = theirs). */
export async function uploadFiguresFile(api: ApiClient, companyId: string, figuresId: string, file: File): Promise<{ fileId: string; ready: boolean }> {
  const bytes = await file.arrayBuffer()
  const announced = await api.post('/files', {
    body: { companyId, recordType: 'CustomerStatementFigures', recordId: figuresId, kind: 'DOCUMENT', originalName: file.name, contentType: file.type || 'application/octet-stream', sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) },
    schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }),
    idempotencyKey: key(),
  })
  await putToStore(announced.upload, bytes)
  const done = await api.post(`/files/${encodeURIComponent(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }) }), idempotencyKey: key() })
  return { fileId: announced.file.id, ready: done.file.status === 'AVAILABLE' }
}
