/**
 * MCP full control P9 — the import's "before" record (Owner, choice A, 2026-10-02).
 *
 * An import used to keep no record of what it replaced, so it could not be undone ("Unversioned rollback is
 * unavailable", import-wizard.service.ts). Now each record an import applies keeps, in its own import row
 * (`ImportJobRow.beforeState`, the column the schema names for it), the cells it changed: what each held and what the
 * import wrote. It is written in the same transaction as the record itself, after the apply verified that the record
 * still read exactly as reviewed — so `before` is what the catalog held when the import wrote.
 *
 * Nothing reads it inside the wizard: its checks, matching and messages are unchanged (catalog-import-golden.vitest.test.ts).
 * The undo reads it (rollback-bulk-operation): it re-imports the `before` values through the same wizard, and is refused
 * when a value no longer reads as the import wrote it.
 */
import type { TransferCell, TransferEntity, TransferRow } from '@nexus/shared/catalog-transfer'
import type { TransferTarget } from './catalog-transfer-plan.js'

export const TRANSFER_BEFORE_KIND = 'catalog-transfer-before-v1'

type Coordinate = Pick<TransferRow, 'sku' | 'channel' | 'accountId' | 'marketplace' | 'aliasKey'>

/** One changed cell: where it is, what it held and what the import wrote. */
export interface TransferBeforeCell extends Coordinate {
  entity: TransferEntity
  locale: string
  field: string
  before: unknown
  beforeState: TransferCell['beforeState']
  after: unknown
  afterState: TransferCell['afterState']
  /** A value read from a channel's own file (a delete, a record-only price): an import cannot put it back. */
  origin?: 'channel-file'
}

export interface TransferBeforeRecord {
  kind: typeof TRANSFER_BEFORE_KIND
  /** The import created this product or listing: undo can put back values, never delete it. */
  created: boolean
  identity: Coordinate & { entity: TransferEntity }
  cells: TransferBeforeCell[]
}

const coordinate = (row: Coordinate) => ({ sku: row.sku, channel: row.channel, accountId: row.accountId, marketplace: row.marketplace, aliasKey: row.aliasKey })

/** The record of one reviewed target the import is writing; null when it writes nothing. */
export function transferBeforeRecord(target: TransferTarget): TransferBeforeRecord | null {
  const changed = target.cells.filter(cell => cell.verdict === 'changed')
  if (!target.create && !changed.length) return null
  return {
    kind: TRANSFER_BEFORE_KIND,
    created: target.create,
    // A listing target is named by its first row, an Overrides or a Listings cell: it is a listing either way.
    identity: { entity: target.identity.entity === 'Products' ? 'Products' : 'Listings', ...coordinate(target.identity) },
    cells: changed.map(cell => ({
      entity: cell.entity, ...coordinate(cell), locale: cell.locale, field: cell.field,
      before: cell.before ?? null, beforeState: cell.beforeState, after: cell.after ?? null, afterState: cell.afterState,
      ...(cell.origin === 'channel-file' ? { origin: 'channel-file' as const } : {}),
    })),
  }
}

/** A stored `beforeState`, when it is this record (older imports and the legacy wizard kept none, or another shape). */
export function readTransferBeforeRecord(value: unknown): TransferBeforeRecord | null {
  const record = value as TransferBeforeRecord | null
  return record?.kind === TRANSFER_BEFORE_KIND && Array.isArray(record.cells) ? record : null
}
