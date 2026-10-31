import { readdirSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { seedUuid, type SeedContext } from '../../../../../packages/factory-db/src/seeding'
import { callerFor, type CommandCaller } from '../../core/command'
import { systemContext } from '../outbox/system'
import type { SearchIndexer } from './indexer'
import { indexEvent, rebuildIndex, searchHandlers } from './indexing'
import { loadIndexers } from './registry'

/**
 * B-W2a-69 (follow-up of #976): the purchase-order indexer follows B-W2a-52's changes after the send, so the palette shows an
 * order's CURRENT state — a revision makes it a draft again, closed-short (or cancelled) lines complete it, a moved
 * confirm-by is indexed too. On a throwaway PostgreSQL 17 database from the migrations with the base seeds; the worker's
 * index work runs in the tenant's system scope as the handler would. Run with
 * `node scripts/factory/run-pg-tests.mjs platform/search/po-changes`.
 */

const NAMESPACE = 'search-po-changes'
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed/', import.meta.url))
const id = (key: string): string => seedUuid(NAMESPACE, key)
const tenantId = id('tenant')

let db: MigratedDatabase
let database: FactoryDatabase
let indexers: readonly SearchIndexer[]
let system: CommandCaller
let orderId: string

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const entry = async (recordId: string): Promise<Json> => (await admin('SELECT * FROM "SearchEntry" WHERE "recordType" = \'PurchaseOrder\' AND "recordId" = $1', [recordId]))[0]!
/** Moves test data past its own guards (the admin's session only), then back: the state a module command would have written. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const statusIs = (status: string) => force('UPDATE "PurchaseOrder" SET status = $2 WHERE id = $1', [orderId, status])

function envelope(type: string, payload: Record<string, unknown>): EventEnvelope {
  return { eventId: newId(), type, version: 1, context: 'purchasing', tenantId, companyId: null, siteId: null, subject: orderId, correlationId: `po-changes-${newId()}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload }
}

beforeAll(async () => {
  db = await migratedDatabase('search_po_changes')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 4 } })
  const context: SeedContext = { db: database, namespace: NAMESPACE }
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(`${SEED_DIR}${file}`).href)) as { seed: (context: SeedContext) => Promise<unknown> }
    await module.seed(context)
  }
  await admin('DELETE FROM "SearchEntry"')
  indexers = await loadIndexers(fileURLToPath(new URL('../..', import.meta.url)))
  system = callerFor(database, systemContext(tenantId, 'search-po-changes-test'))
  orderId = (await admin<{ id: string }>(`SELECT id FROM "PurchaseOrder" WHERE "tenantId" = $1 AND number = 'SEED-PO-0001'`, [tenantId]))[0]!.id
  await statusIs('SENT')
  await rebuildIndex(system, indexers, { recordTypes: ['PurchaseOrder'], key: `search-rebuild-${newId()}` })
}, 180_000)

afterAll(async () => {
  await database?.close()
  await db?.close()
})

describe('the purchase-order indexer follows the changes after the send (B-W2a-52)', () => {
  it('the worker hands the index the five order changes that move what the palette shows', () => {
    const events = searchHandlers(indexers)[0]!.events
    expect(events).toEqual(expect.arrayContaining(['purchase_order.revision_started', 'purchase_order.lines_cancelled', 'purchase_order.lines_closed_short', 'purchase_order.confirm_by_moved', 'purchase_order.cancelled']))
  })

  it('a revision makes the order a draft in the palette; closing its lines short makes it received', async () => {
    expect(await entry(orderId)).toMatchObject({ number: 'SEED-PO-0001', status: 'SENT' })
    // Change → revision 2: the order is a draft again.
    await statusIs('DRAFT')
    const revision = await indexEvent(system, indexers, envelope('purchase_order.revision_started', { purchaseOrderId: orderId, number: 'SEED-PO-0001', revision: 2, from: 'SENT', counterProposal: false, revokedLinkIds: [] }))
    expect(revision).toMatchObject({ replayed: false })
    expect((await entry(orderId)).status).toBe('DRAFT')
    // Sent again, part received, the rest closed short: received in full.
    await statusIs('PARTLY_RECEIVED')
    await indexEvent(system, indexers, envelope('purchase_order.sent', { purchaseOrderId: orderId }))
    expect((await entry(orderId)).status).toBe('PARTLY_RECEIVED')
    await statusIs('RECEIVED')
    await indexEvent(system, indexers, envelope('purchase_order.lines_closed_short', { purchaseOrderId: orderId, number: 'SEED-PO-0001', lineIds: [], from: 'PARTLY_RECEIVED', to: 'RECEIVED', reopenedRequirementIds: [], outboundId: null }))
    expect((await entry(orderId)).status).toBe('RECEIVED')
  })

  it('cancelled lines and a moved confirm-by are indexed as well (the record read again)', async () => {
    await statusIs('CANCELLED')
    await indexEvent(system, indexers, envelope('purchase_order.lines_cancelled', { purchaseOrderId: orderId, number: 'SEED-PO-0001', lineIds: [], from: 'SENT', to: 'SENT', reopenedRequirementIds: [], outboundId: null }))
    expect((await entry(orderId)).status).toBe('CANCELLED')
    const moved = envelope('purchase_order.confirm_by_moved', { purchaseOrderId: orderId, number: 'SEED-PO-0001', confirmBy: new Date().toISOString() })
    await indexEvent(system, indexers, moved)
    // The index work ran for it (one audit row naming the event and the purchase orders): nothing else changed.
    const audit = await admin(`SELECT after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'search.index' AND "recordId" = $2`, [tenantId, moved.eventId])
    expect(audit.map((row) => row.after)).toEqual([expect.objectContaining({ eventType: 'purchase_order.confirm_by_moved', recordTypes: ['PurchaseOrder'] })])
  })
})
