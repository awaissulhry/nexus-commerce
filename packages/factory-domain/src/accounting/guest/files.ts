import type { AccountingPackage } from '../packages'

/**
 * The accountant's files (B-W2b-201; design portal.guest.accountant › exports, einvoices, registers, tab:file). Pure.
 *
 *   exports     the numbered batches' journal files (sales, purchases, payments; cost of sales with W2b-6): every EXPORTED
 *               batch of a handed-over month, each FINAL or AMENDED BY the re-export that followed it (a re-export
 *               carries only the changes, so both are kept)
 *   e-invoices  every sales invoice issued in a handed-over month (numbered, not a draft; its SDI state shown, a rejected
 *               one too) and every supplier invoice received in one (not voided): its FatturaPA XML and PDF, when kept
 *   registers   what the batches hold besides the journals: the VAT registers (sales, purchases and their totals, the
 *               month's VAT summary; B-W2b-408/426), the Intrastat file and the year-end stock pack; each CURRENT, or
 *               REPLACED BY the batch that carried the whole file again.
 *
 * Downloads: one file (a 60-second link), or a zip the API writes on the fly (never stored): the whole period, the
 * period's XML only, or the files chosen. Each download is one audit row. No amount is ever on screen: the amounts live
 * in the files, which are what the access is for.
 */

/** The packages listed under "Accounting exports" (the journals). */
export const JOURNAL_PACKAGES = ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES'] as const satisfies readonly AccountingPackage[]
/** The packages listed under "VAT and registers". */
export const REGISTER_PACKAGES = ['VAT_REGISTERS', 'INTRASTAT', 'YEAR_END_STOCK'] as const satisfies readonly AccountingPackage[]

export const isJournal = (pkg: AccountingPackage): boolean => (JOURNAL_PACKAGES as readonly string[]).includes(pkg)

export const INVOICE_SIDES = ['SALES', 'PURCHASE'] as const
export type InvoiceSide = (typeof INVOICE_SIDES)[number]
export const INVOICE_KINDS = ['INVOICE', 'DEPOSIT', 'CREDIT_NOTE'] as const
export type GuestInvoiceKind = (typeof INVOICE_KINDS)[number]

/** A sales invoice's kind from its FatturaPA document type. */
export function salesKindOf(docType: string): GuestInvoiceKind {
  if (docType === 'TD04') return 'CREDIT_NOTE'
  if (docType === 'TD02') return 'DEPOSIT'
  return 'INVOICE'
}

/** A supplier invoice's kind (its own kind; a TD04 typed as an invoice is still a credit note). */
export function purchaseKindOf(kind: string, docType: string | null): GuestInvoiceKind {
  if (kind === 'CREDIT_NOTE' || docType === 'TD04') return 'CREDIT_NOTE'
  if (docType === 'TD02') return 'DEPOSIT'
  return 'INVOICE'
}

/** A sales invoice's SDI states the accountant sees (DRAFT is never listed). */
export const SALES_SDI_STATES = ['ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'] as const
/** How a supplier invoice came in: through SDI (an e-invoice), by e-mail or typed in (no FatturaPA). */
export const PURCHASE_SOURCES = ['SDI', 'EMAIL', 'MANUAL'] as const

/** The zip's limits: the store reads each file whole, so a zip stays small enough for one request. */
export const GUEST_ZIP = Object.freeze({ maxFiles: 400, maxBytes: 100 * 1024 * 1024, fileBytes: 25 * 1024 * 1024, chosenMax: 400 })
export const GUEST_ZIP_WHAT = ['PERIOD', 'XML', 'FILES'] as const
export type GuestZipWhat = (typeof GUEST_ZIP_WHAT)[number]

/** The zip's folders: what kind of file each is. */
export const ZIP_FOLDERS = { EXPORTS: 'exports', SALES: 'e-invoices/sales', PURCHASE: 'e-invoices/purchases', REGISTERS: 'registers' } as const
export type ZipFolder = keyof typeof ZIP_FOLDERS

/** Refusals of the accountant's routes (`problem/<CODE>`), English; the screen says them by code. */
export const GUEST_REFUSALS = Object.freeze({
  NOT_ACCOUNTANT: "This page is the accountant's: your access does not open it.",
  PERIOD_NOT_SHARED: 'Finance has not handed this period over to you yet (it has no accounting export). Ask finance.',
  FILE_NOT_IN_PERIOD: 'This file is not one of the files of the period you chose.',
  TOO_MANY_FILES: `A zip holds at most ${GUEST_ZIP.maxFiles} files: choose a shorter period or fewer files.`,
  TOO_LARGE: `A zip holds at most ${Math.round(GUEST_ZIP.maxBytes / (1024 * 1024))} MB: choose a shorter period or fewer files.`,
  NOTHING_TO_ZIP: 'There is no file to put in the zip for this period.',
  FILE_UNAVAILABLE: 'This file cannot be downloaded right now; try again later or ask finance.',
})
export type GuestRefusal = keyof typeof GUEST_REFUSALS
export const GUEST_PROBLEM = (code: GuestRefusal): string => `problem/${code}`

/** A file name safe inside a zip (no folder, no control or reserved character), at most 120 characters. */
export function zipSafeName(name: string): string {
  const cleaned = name
    .normalize('NFC')
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f]/g, '_')
    .replace(/^\.+/, '_')
    .trim()
  const shortened = cleaned.length > 120 ? `${cleaned.slice(0, 80)}…${cleaned.slice(-39)}` : cleaned
  return shortened === '' ? 'file' : shortened
}

/** Each entry's path in the zip: `<folder>/<name>`, a repeated name numbered (`name (2).xml`). */
export function zipPaths(entries: readonly { readonly folder: ZipFolder; readonly name: string }[]): string[] {
  const taken = new Set<string>()
  return entries.map((entry) => {
    const name = zipSafeName(entry.name)
    const dot = name.lastIndexOf('.')
    const stem = dot > 0 ? name.slice(0, dot) : name
    const ext = dot > 0 ? name.slice(dot) : ''
    let path = `${ZIP_FOLDERS[entry.folder]}/${name}`
    for (let n = 2; taken.has(path.toLowerCase()); n++) path = `${ZIP_FOLDERS[entry.folder]}/${stem} (${n})${ext}`
    taken.add(path.toLowerCase())
    return path
  })
}

/** The zip's own name: `<company code>_<period>_<what>.zip`. */
export function zipNameOf(companyCode: string, periodKey: string, what: GuestZipWhat): string {
  const slug = what === 'PERIOD' ? 'all' : what === 'XML' ? 'xml' : 'files'
  return zipSafeName(`${companyCode}_${periodKey}_${slug}.zip`)
}

/** Is the zip within its limits? Null, or the refusal. */
export function zipProblem(files: readonly { readonly sizeBytes: number }[]): GuestRefusal | null {
  if (files.length === 0) return 'NOTHING_TO_ZIP'
  if (files.length > GUEST_ZIP.maxFiles) return 'TOO_MANY_FILES'
  const total = files.reduce((sum, file) => sum + file.sizeBytes, 0)
  if (total > GUEST_ZIP.maxBytes || files.some((file) => file.sizeBytes > GUEST_ZIP.fileBytes)) return 'TOO_LARGE'
  return null
}

export interface BatchFacts {
  readonly id: string
  readonly number: string
  readonly supersedesId: string | null
  readonly exportedAt: string
  readonly packages: readonly AccountingPackage[]
}

/** Per EXPORTED batch: the batch it amends (its number) and the later batch that amended it (its number), else null. */
export function batchStanding(batches: readonly BatchFacts[]): Map<string, { readonly amends: string | null; readonly amendedBy: string | null }> {
  const byId = new Map(batches.map((batch) => [batch.id, batch]))
  const standing = new Map<string, { amends: string | null; amendedBy: string | null }>()
  for (const batch of batches) standing.set(batch.id, { amends: batch.supersedesId ? (byId.get(batch.supersedesId)?.number ?? null) : null, amendedBy: null })
  const ordered = [...batches].sort((a, b) => a.exportedAt.localeCompare(b.exportedAt) || a.number.localeCompare(b.number))
  for (const batch of ordered) {
    if (!batch.supersedesId) continue
    const before = standing.get(batch.supersedesId)
    // The first re-export of a batch names it; a later one names the re-export it amends.
    if (before && before.amendedBy === null) standing.set(batch.supersedesId, { ...before, amendedBy: batch.number })
  }
  return standing
}

/**
 * Per register file of a month: the newest batch carrying that package is CURRENT (a whole file is replaced whole); an
 * older one is REPLACED BY that batch's number.
 */
export function registerStanding<Row extends { readonly month: string; readonly package: AccountingPackage; readonly exportNumber: string; readonly exportedAt: string }>(rows: readonly Row[]): (Row & { readonly current: boolean; readonly replacedBy: string | null })[] {
  const newest = new Map<string, Row>()
  for (const row of rows) {
    const key = `${row.month}|${row.package}`
    const seen = newest.get(key)
    if (!seen || seen.exportedAt < row.exportedAt || (seen.exportedAt === row.exportedAt && seen.exportNumber < row.exportNumber)) newest.set(key, row)
  }
  return rows.map((row) => {
    const top = newest.get(`${row.month}|${row.package}`)!
    const current = top.exportNumber === row.exportNumber
    return { ...row, current, replacedBy: current ? null : top.exportNumber }
  })
}
