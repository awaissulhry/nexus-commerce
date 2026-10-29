import type { CommandTools } from '../../../core/command'
import type { LotDocumentKind } from '@nexus/factory-domain/quality/lab/rules'
import type { Reader } from './store'

/**
 * THE SEAM for a lot's supplier documents (B-W1-34; QHS-030). The lab step attaches and reads them only through
 * `processLotDocuments()`, so the store is one file to swap.
 *
 * INTERIM (lead 10-29): there is no LotDocument table yet. The document's file is a CERTIFICATE StoredFile of the Lot
 * (module-owned: platform/files/owned.ts); what it is (kind, validTo) is ONE audit row on the Lot (action
 * `quality.lotDocumentAttached`, `after.lotDocument` = the row below), written in the attaching command. The schema step
 * (approved: `LotDocument` with kind, fileId, validTo, status ACTIVE | ARCHIVED; the floor reads only) replaces
 * `AUDIT_LOT_DOCUMENTS`. NOT to be merged as it is.
 */

export interface LotDocumentRow {
  readonly id: string
  readonly lotId: string
  readonly companyId: string
  readonly siteId: string
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
  /** Inside the attaching command. */
  attach(tools: Pick<CommandTools, 'audit'>, row: LotDocumentRow): Promise<void>
  /** A lot's documents, newest first. */
  list(client: Reader, lotId: string): Promise<LotDocumentRow[]>
}

export const LOT_DOCUMENT_ACTION = 'quality.lotDocumentAttached'

const rowOf = (after: unknown): LotDocumentRow | null => {
  const value = (after as { lotDocument?: LotDocumentRow } | null)?.lotDocument
  return value && typeof value === 'object' && typeof value.id === 'string' ? value : null
}

/** Interim: one audit row per attached document (see above). */
export const AUDIT_LOT_DOCUMENTS: LotDocumentStore = Object.freeze({
  attach: async (tools: Pick<CommandTools, 'audit'>, row: LotDocumentRow) => {
    tools.audit({ action: LOT_DOCUMENT_ACTION, recordType: 'Lot', recordId: row.lotId, companyId: row.companyId, siteId: row.siteId, after: { lotDocument: row } })
  },
  list: async (client: Reader, lotId: string) =>
    (await client.auditLog.findMany({ where: { recordType: 'Lot', recordId: lotId, action: LOT_DOCUMENT_ACTION }, select: { after: true }, orderBy: [{ at: 'desc' }, { id: 'desc' }] }))
      .map((entry) => rowOf(entry.after))
      .filter((row): row is LotDocumentRow => row !== null),
})

let configured: LotDocumentStore | undefined

/** Tests (and the schema step) swap the store; `undefined` puts the default back. */
export function useLotDocuments(store: LotDocumentStore | undefined): void {
  configured = store
}

export function processLotDocuments(): LotDocumentStore {
  return configured ?? AUDIT_LOT_DOCUMENTS
}
