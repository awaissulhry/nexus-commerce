import type { Prisma } from '@nexus/factory-db'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LotDocumentKind } from '@nexus/factory-domain/quality/lab/rules'
import type { CommandTools } from '../../../core/command'
import { dayOf, type Reader } from './store'

/**
 * THE SEAM for a lot's supplier documents (B-W1-34; QHS-030): the lab step attaches and reads them only through
 * `processLotDocuments()`. The default is the table (factory-db quality.prisma `LotDocument`: its kind, its file (a
 * CERTIFICATE file of the lot, module-owned: platform/files/owned.ts), the last day it is valid, ACTIVE | ARCHIVED; the
 * …_quality_lab_guards trigger keeps it fixed but for its status). Tests may swap the store with `useLotDocuments`.
 */

export interface LotDocumentRow {
  readonly id: string
  readonly lotId: string
  readonly companyId: string
  readonly siteId: string
  readonly itemId: string
  readonly kind: LotDocumentKind
  readonly fileId: string
  /** The last day it is valid; null: no end. */
  readonly validTo: string | null
  readonly status: 'ACTIVE' | 'ARCHIVED'
  readonly note: string | null
  readonly createdAt: string
  readonly createdById: string | null
}

export interface LotDocumentStore {
  /** Inside the attaching command (its audit row too). */
  attach(tools: Pick<CommandTools, 'tx' | 'audit'>, row: LotDocumentRow): Promise<void>
  /** A lot's documents, newest first. */
  list(client: Reader, lotId: string): Promise<LotDocumentRow[]>
}

const COLUMNS = { id: true, lotId: true, companyId: true, siteId: true, itemId: true, kind: true, fileId: true, validTo: true, status: true, note: true, createdAt: true, createdById: true } as const satisfies Prisma.LotDocumentSelect
type Row = Prisma.LotDocumentGetPayload<{ select: typeof COLUMNS }>

const rowOf = (row: Row): LotDocumentRow => ({ ...row, validTo: row.validTo ? dayOf(row.validTo) : null, createdAt: toUtcIso(row.createdAt) })

/** The table. */
export const TABLE_LOT_DOCUMENTS: LotDocumentStore = Object.freeze({
  attach: async (tools: Pick<CommandTools, 'tx' | 'audit'>, row: LotDocumentRow) => {
    const at = new Date(row.createdAt)
    await tools.tx.lotDocument.create({
      data: { ...row, validTo: row.validTo === null ? null : new Date(`${row.validTo}T00:00:00.000Z`), createdAt: at, updatedAt: at },
      select: { id: true },
    })
    tools.audit({ action: 'quality.lotDocumentAttached', recordType: 'LotDocument', recordId: row.id, companyId: row.companyId, siteId: row.siteId, after: { lotId: row.lotId, kind: row.kind, fileId: row.fileId, validTo: row.validTo, status: row.status, note: row.note } })
  },
  list: async (client: Reader, lotId: string) => (await client.lotDocument.findMany({ where: { lotId }, select: COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }] })).map(rowOf),
})

let configured: LotDocumentStore | undefined

/** Tests may swap the store; `undefined` puts the table back. */
export function useLotDocuments(store: LotDocumentStore | undefined): void {
  configured = store
}

export function processLotDocuments(): LotDocumentStore {
  return configured ?? TABLE_LOT_DOCUMENTS
}
