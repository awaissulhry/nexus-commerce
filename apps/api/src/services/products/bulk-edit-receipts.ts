import { activeDatabaseTransaction } from '../../lib/database-context.js'
import { auditLogService, type AuditWriteInput } from '../audit-log.service.js'
import { productEventService, type ProductEventInput } from '../product-event.service.js'
import { PRIMARY_CONTENT_LOCALE } from '../pim/content-locale.js'

export interface BulkReceiptChange { id: string; field: string; value: unknown; cascade?: boolean; target?: 'master' | 'channel' }
export interface BulkReceiptScope { channel: string; marketplace: string; locale?: string; aliasKey?: string }

/** Both row and set writers emit the same field history and scoped activity receipts. */
export async function writeBulkEditReceipts(operations: Array<{ operationId: string; changes: BulkReceiptChange[] }>, options: {
  userId: string | null; ip?: string | null; capturePrevious: boolean;
  priorById: Map<string, Record<string, unknown>>; contexts: BulkReceiptScope[]; accounts: Map<string, string>;
}) {
  const { userId: auditActor, priorById, capturePrevious, contexts: effectiveContexts, accounts: connFor } = options
  const context = { ip: options.ip }
  const allAuditRows: AuditWriteInput[] = []
  const allEvents: ProductEventInput[] = []
  for (const operation of operations) {
    const auditRows = operation.changes.map(c => {
      const prior = priorById.get(c.id)
      // `attr_x` writes into categoryAttributes; a bare key is a column. This
      // mirrors how the change itself is applied, so the recorded `before` is
      // the value the write actually replaced.
      const previous = c.target === 'channel' || !capturePrevious || !prior
        ? undefined
        : typeof c.field === 'string' && c.field.startsWith('attr_')
          ? (prior.categoryAttributes as Record<string, unknown> | null)?.[c.field.slice(5)]
          : prior[c.field]
      return {
        userId: auditActor,
        ip: context.ip ?? null,
        entityType: 'Product',
        entityId: c.id,
        action: 'update',
        // Written ONLY when actually captured. A `before` of `{ value: null }`
        // means "it was empty"; omitting the key means "we did not record it".
        // Collapsing those two into one shape is what makes a history panel lie.
        ...(previous !== undefined ? { before: { field: c.field, value: previous ?? null } } : {}),
        after: { field: c.field, value: c.value },
        metadata: {
          bulkOperationId: operation.operationId,
          cascade: !!c.cascade,
          source: 'bulk-patch',
          language: effectiveContexts[0]?.locale ?? PRIMARY_CONTENT_LOCALE,
          // `effectiveContexts`, NOT the raw body field: that one is optional,
          // and this tsconfig is not strict, so `.length` on an absent array
          // would compile clean and then crash the autosave at runtime
          // (reference_api_tsconfig_not_strict).
          //
          // PES.5 / #169 — the layer is now the change's OWN target, not
          // merely "a context was supplied". A master-targeted change sent
          // alongside channel contexts still lands on the product, and the
          // history pane must say which it was.
          layer: c.target === 'channel' ? 'channel' : 'master',
          channel: c.target === 'channel' ? effectiveContexts[0]?.channel ?? null : null,
          marketplace: c.target === 'channel' ? effectiveContexts[0]?.marketplace ?? null : null,
          aliasKey: c.target === 'channel' ? (effectiveContexts[0] as { aliasKey?: string })?.aliasKey ?? '' : null,
          accountId: c.target === 'channel' && effectiveContexts.length === 1 ? connFor.get(effectiveContexts[0].channel) ?? null : null,
        },
      }
    })
    allAuditRows.push(...auditRows)

    // Activity consumes the same scoped receipts as field history. Mixed shared/channel
    // requests must never put another destination's fields in a scoped event.
    const eventGroups = new Map<string, typeof auditRows>()
    for (const row of auditRows) {
      const key = JSON.stringify([row.entityId, row.metadata.layer, row.metadata.channel, row.metadata.marketplace, row.metadata.accountId, row.metadata.aliasKey])
      eventGroups.set(key, [...(eventGroups.get(key) ?? []), row])
    }
    const activityEvents = [...eventGroups.values()].map(rows => ({
      aggregateId: rows[0].entityId,
      aggregateType: 'Product' as const,
      eventType: 'BULK_OP_APPLIED' as const,
      data: { fields: rows.map(row => row.after), bulkOperationId: operation.operationId },
      metadata: { ...rows[0].metadata, source: 'OPERATOR' as const, userId: auditActor },
    }))
    allEvents.push(...activityEvents)
  }
  await auditLogService.writeMany(allAuditRows)
  const activeTx = activeDatabaseTransaction()
  if (activeTx) await productEventService.emitManyTx(activeTx, allEvents)
  else await productEventService.emitMany(allEvents)
}
