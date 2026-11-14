import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { abiCabOfIban } from '@nexus/factory-domain/receivables/cbi/riba'
import { RIBA_METHOD, RIBA_REFUSALS, ribaInstalmentsDue, termInstalmentsOf, type RibaRefusal, type TermInstalment } from '@nexus/factory-domain/receivables/riba/riba'
import type { CommandTx } from '../../../core/command'
import { openInvoices, type OpenInvoiceRow, type Reader } from '../store'

/**
 * Ri.Ba. reads and seams (B-W2b-402; FIN-126; factory-db bank.prisma RibaBatch, RibaItem): the batch and its items, the
 * company's lock, the candidates of a window (the MP12 instalments still open and in no live batch), and where the
 * customer's bank comes from (given when the file is made, else the invoice's MP12 instalment IBAN, else the last IBAN a
 * matched bank line of the customer came from).
 */

export const day = (value: Date): BusinessDate => businessDate(value, 'UTC')
export const dateValue = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

export const refusedRiba = (code: RibaRefusal, path = `riba/${code}`, words: string = RIBA_REFUSALS[code]): DomainError => new DomainError('conflict', words, [{ path, message: words }])

/** One writer of a company's Ri.Ba. batches at a time (the database takes its own 'riba' money lock on issue). */
export async function lockRiba(tx: CommandTx, tenantId: string, companyId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.riba', ${tenantId}::uuid::text, ${companyId}::uuid::text), 0))`
}

export const BATCH_COLUMNS = {
  id: true,
  companyId: true,
  bankAccountId: true,
  dueFrom: true,
  dueTo: true,
  status: true,
  fileId: true,
  issuedAt: true,
  issuedById: true,
  cancelledAt: true,
  cancelReason: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.RibaBatchSelect
export type BatchRow = Prisma.RibaBatchGetPayload<{ select: typeof BATCH_COLUMNS }>

export const ITEM_COLUMNS = {
  id: true,
  companyId: true,
  batchId: true,
  partyId: true,
  invoiceId: true,
  instalment: true,
  dueDate: true,
  amount: true,
  status: true,
  settledOn: true,
  unpaidFee: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.RibaItemSelect
export type ItemRow = Prisma.RibaItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export async function readBatch(db: Reader, batchId: string): Promise<BatchRow | null> {
  if (!isUuid(batchId)) return null
  return db.ribaBatch.findUnique({ where: { id: batchId }, select: BATCH_COLUMNS })
}

export async function itemsOf(db: Reader, batchId: string): Promise<ItemRow[]> {
  return db.ribaItem.findMany({ where: { batchId }, orderBy: [{ dueDate: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], select: ITEM_COLUMNS })
}

/** The batch locked for the command, at the version the caller read (409 when it moved on). */
export async function lockBatch(tx: CommandTx, batchId: string, expectedVersion: number): Promise<BatchRow> {
  await tx.$queryRaw`SELECT id FROM "RibaBatch" WHERE id = ${batchId}::uuid FOR UPDATE`
  const row = await tx.ribaBatch.findUnique({ where: { id: batchId }, select: BATCH_COLUMNS })
  if (!row) throw new NotFoundError('Ri.Ba. batch not found.')
  if (row.version !== expectedVersion) {
    throw new DomainError('conflict', `This batch changed since it was read (version ${expectedVersion}); it is now at version ${row.version}. Reload it and try again.`, [{ path: 'body/version', message: `The current version is ${row.version}.` }])
  }
  return row
}

/** The company's live accounts that may collect (an Italian IBAN is checked when the file is made). */
export async function liveAccountsOf(db: Reader, companyId: string) {
  return db.bankAccount.findMany({ where: { companyId, active: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true, iban: true, bankName: true, active: true, currency: true, holder: true } })
}

// ---- candidates ---------------------------------------------------------------------------------------------------------------

export interface Candidate {
  readonly invoice: OpenInvoiceRow
  readonly term: TermInstalment
  /** What the receipt collects: what is open on the instalment. */
  readonly amount: number
  /** The live batch that collects it already (null: none). */
  readonly inBatchId: string | null
}

/**
 * The live items of these invoices: those of a DRAFT batch, and those of an ISSUED batch that did not come back UNPAID
 * (an unpaid return is open again: a later batch may present it).
 */
export async function liveItemsOf(db: Reader, invoiceIds: readonly string[]): Promise<Array<{ id: string; batchId: string; invoiceId: string; instalment: number }>> {
  if (invoiceIds.length === 0) return []
  return db.ribaItem.findMany({
    where: { invoiceId: { in: [...invoiceIds] }, OR: [{ batch: { status: 'DRAFT' } }, { batch: { status: 'ISSUED' }, status: { in: ['ISSUED', 'PAID'] } }] },
    select: { id: true, batchId: true, invoiceId: true, instalment: true },
  })
}

/** The paymentTerms of the invoices, by id (the open invoices read leaves them out). */
async function termsOf(db: Reader, invoiceIds: readonly string[]): Promise<Map<string, unknown>> {
  if (invoiceIds.length === 0) return new Map()
  const rows = await db.invoice.findMany({ where: { id: { in: [...invoiceIds] } }, select: { id: true, paymentTerms: true } })
  return new Map(rows.map((row) => [row.id, row.paymentTerms]))
}

/** Every open MP12 instalment of the company's issued invoices due in the window, with the live batch that holds it. */
export async function candidatesOf(db: Reader, companyId: string, window: { readonly dueFrom: BusinessDate; readonly dueTo: BusinessDate }, asOf: BusinessDate): Promise<Candidate[]> {
  const open = await openInvoices(db, { companyId, asOf })
  const terms = await termsOf(db, open.map((invoice) => invoice.id))
  const found: { invoice: OpenInvoiceRow; term: TermInstalment }[] = []
  for (const invoice of open) for (const term of ribaInstalmentsDue(termInstalmentsOf(terms.get(invoice.id), invoice.settled), window)) found.push({ invoice, term })
  const live = await liveItemsOf(db, [...new Set(found.map((entry) => entry.invoice.id))])
  const holder = new Map(live.map((item) => [`${item.invoiceId}|${item.instalment}`, item.batchId]))
  return found
    .map((entry) => ({ invoice: entry.invoice, term: entry.term, amount: entry.term.open, inBatchId: holder.get(`${entry.invoice.id}|${entry.term.instalment}`) ?? null }))
    .sort((a, b) => a.term.dueDate.localeCompare(b.term.dueDate) || a.invoice.number.localeCompare(b.invoice.number) || a.term.instalment - b.term.instalment)
}

/** One instalment of one invoice as a candidate now, or why it is not one. */
export async function candidateFor(db: Reader, companyId: string, pick: { readonly invoiceId: string; readonly instalment: number }, window: { readonly dueFrom: BusinessDate; readonly dueTo: BusinessDate }, asOf: BusinessDate, ownBatchId: string | null): Promise<Candidate | RibaRefusal> {
  const [invoice] = await openInvoices(db, { companyId, invoiceIds: [pick.invoiceId], asOf })
  if (!invoice) return 'NOT_RIBA'
  const terms = await termsOf(db, [invoice.id])
  const term = termInstalmentsOf(terms.get(invoice.id), invoice.settled).find((entry) => entry.instalment === pick.instalment)
  if (!term || term.method !== RIBA_METHOD) return 'NOT_RIBA'
  if (invoice.currency !== 'EUR') return 'CURRENCY'
  if (term.open <= 0) return 'NOT_OPEN'
  if (term.dueDate < window.dueFrom || term.dueDate > window.dueTo) return 'OUTSIDE_WINDOW'
  const live = (await liveItemsOf(db, [invoice.id])).filter((item) => item.instalment === term.instalment && item.batchId !== ownBatchId)
  if (live.length > 0) return 'IN_ANOTHER_BATCH'
  return { invoice, term, amount: term.open, inBatchId: null }
}

// ---- the customer's bank --------------------------------------------------------------------------------------------------------

export interface DebtorBank {
  readonly abi: string
  readonly cab: string
  readonly name: string | null
  readonly source: 'GIVEN' | 'INVOICE' | 'BANK_LINE'
}

/**
 * The customers' banks as the factory knows them: the IBAN an invoice's MP12 instalment names (the customer's bank on a
 * Ri.Ba. invoice), else the last Italian IBAN an accepted bank line of the customer came from (B-W2b-393 learns them).
 * Keyed by invoice id (an invoice's own) and by party id (the bank lines').
 */
export async function knownBanksOf(db: Reader, invoiceIds: readonly string[], partyIds: readonly string[]): Promise<{ readonly byInvoice: Map<string, DebtorBank>; readonly byParty: Map<string, DebtorBank> }> {
  const byInvoice = new Map<string, DebtorBank>()
  const terms = await termsOf(db, invoiceIds)
  for (const [invoiceId, value] of terms) {
    const raw = value && typeof value === 'object' ? (value as { installments?: unknown }).installments : null
    if (!Array.isArray(raw)) continue
    for (const entry of raw) {
      const row = entry && typeof entry === 'object' ? (entry as { method?: unknown; iban?: unknown }) : {}
      const bank = row.method === RIBA_METHOD && typeof row.iban === 'string' ? abiCabOfIban(row.iban) : null
      if (bank) {
        byInvoice.set(invoiceId, { abi: bank.abi, cab: bank.cab, name: null, source: 'INVOICE' })
        break
      }
    }
  }
  const byParty = new Map<string, DebtorBank>()
  const parties = [...new Set(partyIds)]
  if (parties.length > 0) {
    const matches = await db.bankMatch.findMany({
      where: { partyId: { in: parties }, acceptedAt: { not: null }, reversedAt: null, bankLine: { counterpartyIban: { startsWith: 'IT' } } },
      orderBy: [{ acceptedAt: 'desc' }, { id: 'desc' }],
      take: 2000,
      select: { partyId: true, bankLine: { select: { counterpartyIban: true } } },
    })
    for (const match of matches) {
      if (byParty.has(match.partyId)) continue
      const bank = abiCabOfIban(match.bankLine.counterpartyIban)
      if (bank) byParty.set(match.partyId, { abi: bank.abi, cab: bank.cab, name: null, source: 'BANK_LINE' })
    }
  }
  return { byInvoice, byParty }
}

/** The bank one item's receipt goes to: given for its customer, else its invoice's, else its customer's bank lines'. */
export const bankFor = (known: Awaited<ReturnType<typeof knownBanksOf>>, given: ReadonlyMap<string, DebtorBank>, item: { readonly invoiceId: string; readonly partyId: string }): DebtorBank | null =>
  given.get(item.partyId) ?? known.byInvoice.get(item.invoiceId) ?? known.byParty.get(item.partyId) ?? null

/** What is still open on each invoice now (gross − credited − allocated − written off; 0 when nothing is). */
export async function openNowOf(db: Reader, invoiceIds: readonly string[], asOf: BusinessDate): Promise<Map<string, number>> {
  const ids = [...new Set(invoiceIds)]
  if (ids.length === 0) return new Map()
  const open = await openInvoices(db, { invoiceIds: ids, asOf })
  return new Map(ids.map((id) => {
    const row = open.find((invoice) => invoice.id === id)
    return [id, row ? row.gross - row.settled : 0]
  }))
}
