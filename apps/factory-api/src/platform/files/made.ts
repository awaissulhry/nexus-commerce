import type { FactoryClient } from '@nexus/factory-db'
import { isDocumentType, pricedDocument } from '@nexus/factory-domain/documents/model'
import type { CommandTx } from '../../core/command'

/**
 * B-OF-001 / B-OF-012 (order files tab; 13-backend §3): the papers Nexus made itself — a generated document (an order confirmation, a
 * proforma, a packing list, a commercial invoice … platform/documents, GeneratedDocument.fileId), an invoice's XML or PDF
 * (Invoice.xmlFileId / pdfFileId), a shipment's proof of delivery (Shipment.podFileId) and a return label (ReturnLabel.labelFileId).
 * A made paper is never deleted (it is replaced by a new version) and never renamed; one that shows our prices by its kind (a priced
 * DocumentType, documents/model PRICED_DOCUMENT_TYPES, or an invoice's file) is born priced and never loses the mark (B-CP-015).
 * One query per source, for the asked ids only (never one per file). Read with the caller's client: the office reads these tables.
 */

export const MADE_PAPERS = ['GENERATED', 'INVOICE', 'POD', 'RETURN_LABEL'] as const
export type MadePaper = (typeof MADE_PAPERS)[number]

export interface MadeFact {
  readonly made: MadePaper
  /** It shows our prices by its kind: its mark stays. */
  readonly bornPriced: boolean
}

/** The words of a refusal for a made paper (409). */
export const MADE_WORDS = Object.freeze({
  delete: 'A paper Nexus made is replaced by a new version, never removed.',
  rename: 'A paper Nexus made keeps its name.',
  unmark: 'This document shows our prices by its kind: the mark stays.',
})

type Reader = Pick<FactoryClient | CommandTx, 'generatedDocument' | 'invoice' | 'shipment' | 'returnLabel'>

/** Which of `fileIds` are papers Nexus made, and whether each was born priced. */
export async function madePapersOf(db: Reader, fileIds: readonly string[]): Promise<Map<string, MadeFact>> {
  const out = new Map<string, MadeFact>()
  const ids = [...new Set(fileIds)]
  if (ids.length === 0) return out
  for (const row of await db.generatedDocument.findMany({ where: { fileId: { in: ids } }, select: { fileId: true, kind: true } })) {
    out.set(row.fileId, { made: 'GENERATED', bornPriced: isDocumentType(row.kind) && pricedDocument(row.kind) })
  }
  for (const row of await db.invoice.findMany({ where: { OR: [{ xmlFileId: { in: ids } }, { pdfFileId: { in: ids } }] }, select: { xmlFileId: true, pdfFileId: true } })) {
    for (const fileId of [row.xmlFileId, row.pdfFileId]) if (fileId && ids.includes(fileId)) out.set(fileId, { made: 'INVOICE', bornPriced: true })
  }
  for (const row of await db.shipment.findMany({ where: { podFileId: { in: ids } }, select: { podFileId: true } })) if (row.podFileId && !out.has(row.podFileId)) out.set(row.podFileId, { made: 'POD', bornPriced: false })
  for (const row of await db.returnLabel.findMany({ where: { labelFileId: { in: ids } }, select: { labelFileId: true } })) if (row.labelFileId && !out.has(row.labelFileId)) out.set(row.labelFileId, { made: 'RETURN_LABEL', bornPriced: false })
  return out
}
