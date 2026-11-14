import { GONE_FINGERPRINT, handedOverFingerprint } from '@nexus/factory-domain/accounting/integrity/checks'
import type { ManifestEntry } from '@nexus/factory-domain/accounting/manifest'
import type { AccountingPackage } from '@nexus/factory-domain/accounting/packages'
import { newId } from '@nexus/factory-domain/core/ids'
import type { CommandTools } from '../../../core/command'
import type { Reader } from '../store'

/**
 * The documents an accounting export hands over (B-W2b-408; FIN-154; factory-db bank.prisma ExportedDocument, B-W2b-370):
 * "each export numbered, exported documents marked, a re-export never duplicates, a later change is flagged".
 *
 *   marked     the export's draft command writes one row per document it carries (whatever the packages: an invoice in
 *              the sales journal and the VAT registers is ONE document), with its number and the fingerprint of what the
 *              packages write of it (integrity/checks.ts handedOverFingerprint); NEW the first time the company hands it
 *              over, CHANGED when an earlier EXPORTED batch did (a re-export). A document that left the period (REMOVED in
 *              the manifest) hands nothing over: the manifest and the file say it.
 *   never twice  the database refuses, when the batch is EXPORTED, a document twice in one batch, a NEW one another batch
 *              handed over and a CHANGED one nobody did (AccountingExport_documents_once).
 *   flagged    the nightly integrity check compares each document's latest handing-over with what the packages write of
 *              it now and flags a change once (integrity/run.ts).
 * The year-end valuation (recordType StockValuation: a list computed at the year end, keyed by the company) is not a
 * record: it stays in the manifest only.
 */

/** Documents that are not records, kept in the manifest only. */
const NOT_RECORDS = new Set(['StockValuation'])

export interface HandedOver {
  readonly recordType: string
  readonly recordId: string
  readonly number: string | null
  readonly parts: readonly { readonly package: AccountingPackage; readonly hash: string }[]
}

/** The manifest's documents, each once with the packages that carry it (REMOVED entries and non-records left out). */
export function handedOverOf(manifest: readonly ManifestEntry[]): HandedOver[] {
  const byDocument = new Map<string, { recordType: string; recordId: string; number: string | null; parts: { package: AccountingPackage; hash: string }[] }>()
  for (const entry of manifest) {
    if (entry.change === 'REMOVED' || NOT_RECORDS.has(entry.recordType)) continue
    const id = `${entry.recordType}|${entry.recordId}`
    const found = byDocument.get(id) ?? { recordType: entry.recordType, recordId: entry.recordId, number: entry.number, parts: [] }
    found.parts.push({ package: entry.package, hash: entry.hash })
    byDocument.set(id, found)
  }
  return [...byDocument.values()]
}

/** The latest EXPORTED handing-over of each of these documents by the company (none: never handed over). */
export async function latestHandedOver(db: Reader, companyId: string, recordIds: readonly string[]) {
  if (recordIds.length === 0) return new Map<string, { exportId: string; number: string | null; fingerprint: string }>()
  const rows = await db.exportedDocument.findMany({
    where: { companyId, recordId: { in: [...new Set(recordIds)] }, export: { status: 'EXPORTED' } },
    select: { recordType: true, recordId: true, exportId: true, fingerprint: true, export: { select: { number: true, exportedAt: true } } },
  })
  const latest = new Map<string, { exportId: string; number: string | null; fingerprint: string; at: number }>()
  for (const row of rows) {
    const id = `${row.recordType}|${row.recordId}`
    const at = row.export.exportedAt?.getTime() ?? 0
    const found = latest.get(id)
    // The batch exported last (its time, then its id, as store.ts exportedInOrder).
    if (!found || at > found.at || (at === found.at && row.exportId > found.exportId)) latest.set(id, { exportId: row.exportId, number: row.export.number, fingerprint: row.fingerprint, at })
  }
  return new Map([...latest.entries()].map(([id, value]) => [id, { exportId: value.exportId, number: value.number, fingerprint: value.fingerprint }]))
}

/** The number as the row keeps it: one line, at most 40 characters. */
const numberOf = (number: string | null): string | null => {
  const line = number?.replace(/\s+/g, ' ').trim().slice(0, 40).trim() ?? ''
  return line === '' ? null : line
}

/**
 * Writes the draft's handed-over documents (inside the draft's command). Returns the documents a first export would hand
 * over again (handed over by another month's batch): the caller refuses them in words before the database would.
 */
export async function writeHandedOver(tools: CommandTools, input: { readonly companyId: string; readonly exportId: string; readonly reExport: boolean; readonly manifest: readonly ManifestEntry[] }): Promise<{ readonly written: number; readonly elsewhere: readonly { readonly number: string | null; readonly batch: string | null }[] }> {
  const documents = handedOverOf(input.manifest)
  const earlier = await latestHandedOver(tools.tx, input.companyId, documents.map((document) => document.recordId))
  const elsewhere = input.reExport ? [] : documents.flatMap((document) => {
    const before = earlier.get(`${document.recordType}|${document.recordId}`)
    return before ? [{ number: document.number, batch: before.number }] : []
  })
  if (elsewhere.length > 0) return { written: 0, elsewhere }
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  if (documents.length > 0) {
    await tools.tx.exportedDocument.createMany({
      data: documents.map((document) => ({
        id: newId(),
        companyId: input.companyId,
        exportId: input.exportId,
        recordType: document.recordType,
        recordId: document.recordId,
        number: numberOf(document.number),
        fingerprint: handedOverFingerprint(document.parts),
        change: earlier.has(`${document.recordType}|${document.recordId}`) ? ('CHANGED' as const) : ('NEW' as const),
        createdAt: tools.now,
        createdById,
      })),
    })
  }
  return { written: documents.length, elsewhere: [] }
}

/** The fingerprint a handed-over document has now, from the packages it was carried in (none of them: gone). */
export function fingerprintNow(parts: readonly AccountingPackage[], now: ReadonlyMap<string, string>, recordType: string, recordId: string): string {
  const found = parts.flatMap((pkg) => {
    const hash = now.get(`${pkg}|${recordType}|${recordId}`)
    return hash === undefined ? [] : [{ package: pkg, hash }]
  })
  return found.length === 0 ? GONE_FINGERPRINT : handedOverFingerprint(found)
}
