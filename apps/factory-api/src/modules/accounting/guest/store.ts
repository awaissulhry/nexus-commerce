import type { FactoryClient } from '@nexus/factory-db'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import type { LockLevel } from '@nexus/factory-domain/accounting/packages'

/**
 * The accountant's reads (B-W2b-201), in the tenant's SYSTEM scope: the portal's partner role reads none of the accounting
 * tables, an invoice is the buyer's party's record and a supplier invoice the supplier's (the party wall cannot say "every
 * invoice of a company"). So these run only after the guest grant named the company (the session's) and the period (its
 * handed-over months): access.ts and portal.ts call them with exactly those. They select what names a file and never an
 * amount: number, day, the other party's name, the state, and the file's own columns.
 */

type Reader = Pick<FactoryClient, 'accountingExport' | 'periodLock' | 'invoice' | 'supplierInvoice' | 'storedFile' | 'party' | 'user' | 'invitation' | 'company'>

export const FILE_SELECT = { id: true, originalName: true, contentType: true, sizeBytes: true, sha256: true, status: true, storeAccountId: true, storageKey: true, companyId: true } as const
export interface StoredFileRow {
  readonly id: string
  readonly originalName: string
  readonly contentType: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly status: string
  readonly storeAccountId: string
  readonly storageKey: string
  readonly companyId: string | null
}

/** A Europe/Rome day as the database's `@db.Date` takes it. */
export const dayValue = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
export const dayOf = (value: Date): string => value.toISOString().slice(0, 10)

export interface BatchRow {
  readonly id: string
  readonly number: string
  readonly periodStart: string
  readonly periodEnd: string
  readonly supersedesId: string | null
  readonly exportedAt: Date
  readonly packages: readonly AccountingPackage[]
  readonly files: readonly { readonly seq: number; readonly package: AccountingPackage; readonly format: string; readonly rowCount: number; readonly file: StoredFileRow }[]
}

/** The company's EXPORTED batches (the hand-overs), oldest period first, each with its files. */
export async function exportedBatches(client: Reader, companyId: string): Promise<BatchRow[]> {
  const rows = await client.accountingExport.findMany({
    where: { companyId, status: 'EXPORTED', number: { not: null }, exportedAt: { not: null } },
    orderBy: [{ periodStart: 'asc' }, { exportedAt: 'asc' }, { id: 'asc' }],
    take: 2000,
    select: {
      id: true,
      number: true,
      periodStart: true,
      periodEnd: true,
      supersedesId: true,
      exportedAt: true,
      packages: true,
      files: { orderBy: { seq: 'asc' }, select: { seq: true, package: true, format: true, rowCount: true, file: { select: FILE_SELECT } } },
    },
  })
  return rows.map((row) => ({
    id: row.id,
    number: row.number!,
    periodStart: dayOf(row.periodStart),
    periodEnd: dayOf(row.periodEnd),
    supersedesId: row.supersedesId,
    exportedAt: row.exportedAt!,
    packages: row.packages as AccountingPackage[],
    files: row.files.map((entry) => ({ seq: entry.seq, package: entry.package as AccountingPackage, format: entry.format, rowCount: entry.rowCount, file: entry.file })),
  }))
}

export interface LockRow {
  readonly periodStart: string
  readonly periodEnd: string
  readonly level: LockLevel
  readonly lockedAt: Date
}

/** The company's live period locks. */
export async function liveLocks(client: Reader, companyId: string): Promise<LockRow[]> {
  const rows = await client.periodLock.findMany({ where: { companyId, status: 'LOCKED' }, orderBy: { periodStart: 'asc' }, take: 500, select: { periodStart: true, periodEnd: true, level: true, lockedAt: true } })
  return rows.map((row) => ({ periodStart: dayOf(row.periodStart), periodEnd: dayOf(row.periodEnd), level: row.level as LockLevel, lockedAt: row.lockedAt }))
}

/** The lock over a month (its first day inside a live lock), or null. */
export function lockOver(locks: readonly LockRow[], month: string): LockRow | null {
  const first = `${month}-01`
  return locks.find((lock) => lock.periodStart <= first && first <= lock.periodEnd) ?? null
}

const partyName = (party: { legalName: string; tradeName: string | null } | null): string => party?.tradeName?.trim() || party?.legalName || '—'

export interface InvoiceRow {
  readonly id: string
  readonly side: 'SALES' | 'PURCHASE'
  readonly docType: string | null
  readonly kind: string | null
  readonly number: string
  readonly date: string
  readonly party: string
  readonly state: string
  readonly xml: StoredFileRow | null
  readonly pdf: StoredFileRow | null
}

/**
 * The sales invoices issued in these days (numbered, not a draft; a rejected one too: its state says so) and the supplier
 * invoices received in them (not voided), each with its XML and PDF file rows. Oldest first, sales before purchases.
 */
export async function invoicesBetween(client: Reader, companyId: string, start: string, end: string): Promise<InvoiceRow[]> {
  const between = { gte: dayValue(start), lte: dayValue(end) }
  const [sales, purchases] = await Promise.all([
    client.invoice.findMany({
      where: { companyId, status: { not: 'DRAFT' }, number: { not: null }, issueDate: between },
      orderBy: [{ issueDate: 'asc' }, { number: 'asc' }],
      take: 5000,
      select: { id: true, docType: true, number: true, issueDate: true, status: true, buyer: { select: { legalName: true, tradeName: true } }, xmlFile: { select: FILE_SELECT }, pdfFile: { select: FILE_SELECT } },
    }),
    client.supplierInvoice.findMany({
      where: { companyId, status: { not: 'VOIDED' }, receivedOn: between },
      orderBy: [{ receivedOn: 'asc' }, { number: 'asc' }],
      take: 5000,
      select: { id: true, docType: true, kind: true, number: true, receivedOn: true, source: true, party: { select: { legalName: true, tradeName: true } }, xmlFile: { select: FILE_SELECT }, pdfFile: { select: FILE_SELECT } },
    }),
  ])
  return [
    ...sales.map((row) => ({ id: row.id, side: 'SALES' as const, docType: row.docType, kind: null, number: row.number!, date: dayOf(row.issueDate!), party: partyName(row.buyer), state: row.status, xml: row.xmlFile, pdf: row.pdfFile })),
    ...purchases.map((row) => ({ id: row.id, side: 'PURCHASE' as const, docType: row.docType, kind: row.kind, number: row.number, date: dayOf(row.receivedOn), party: partyName(row.party), state: row.source, xml: row.xmlFile, pdf: row.pdfFile })),
  ]
}

/** The adviser party of a portal session: its name, roles and company. */
export async function firmOf(client: Reader, partyId: string) {
  return client.party.findUnique({ where: { id: partyId }, select: { id: true, code: true, legalName: true, tradeName: true, roles: true, companyId: true, status: true } })
}

/** Who gave the person access: the office person of their newest PARTNER invitation, as a name. */
export async function givenByOf(client: Reader, userId: string): Promise<string | null> {
  const invitation = await client.invitation.findFirst({ where: { userId, audience: 'PARTNER', invitedById: { not: null } }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { invitedById: true } })
  if (!invitation?.invitedById) return null
  const person = await client.user.findUnique({ where: { id: invitation.invitedById }, select: { displayName: true, audience: true } })
  return person && person.audience === 'OFFICE' ? person.displayName : null
}

export const firmName = partyName
