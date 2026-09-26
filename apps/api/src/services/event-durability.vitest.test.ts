import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EventEnvelope } from '@nexus/events'
import { formulaDatabase } from '../test-support/formula-database.js'
import { concurrentDatabase, concurrentDatabaseUrl } from '../test-support/concurrent-database.js'
import { withWorkspace } from '../lib/workspace-context.js'
import { withCorrelation } from '../lib/events/correlation.js'

let database: Pick<Awaited<ReturnType<typeof formulaDatabase>>, 'client' | 'close'>
const diagnostics = vi.hoisted(() => ({ warn: vi.fn() }))
vi.mock('../utils/logger.js', () => ({ logger: { warn: diagnostics.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }),
}))
// Keep the real fulfillment resolver while preventing its import graph from
// opening queues. All domain writes below use the disposable database.
vi.mock('../lib/queue.js', () => ({
  outboundSyncQueue: {}, addJobSafely: vi.fn(), redis: { connection: {} },
  resolveRedisTarget: () => ({ kind: 'host-port', host: 'localhost', port: 6379, options: {} }),
}))

const WORKSPACE = 'nexus_legacy_workspace'
const inWorkspace = <T>(work: () => Promise<T>) => withWorkspace({
  workspaceId: WORKSPACE, actorUserId: null, membershipId: null, roleKeys: [],
}, work)

describe('domain state and durable events', () => {
  let stockouts: typeof import('./stockout-detector.service.js')
  let watchdog: typeof import('./inventory-oversell-watchdog.service.js')

  beforeAll(async () => {
    const fixture = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
    database = fixture
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_ENABLE_STOCKOUT_DETECTOR', '1')
    // Fail at the database boundary, after the domain mutation but before its
    // event can persist. This exercises actual rollback, not a mock call order.
    const rejectOutbox = `CREATE FUNCTION reject_fixture_stockout_event() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.type IN ('inventory.stockout', 'inventory.stockout_cleared')
          AND NEW.payload->>'sku' LIKE 'FAIL-STOCKOUT-%' THEN
          RAISE EXCEPTION 'fixture rejects stockout outbox write';
        END IF;
        RETURN NEW;
      END;
    $$;
    CREATE TRIGGER reject_fixture_stockout_event BEFORE INSERT ON "EventOutbox"
      FOR EACH ROW EXECUTE FUNCTION reject_fixture_stockout_event();`
    if ('pool' in fixture) await fixture.pool.query(rejectOutbox)
    else await fixture.db.exec(rejectOutbox)
    stockouts = await import('./stockout-detector.service.js')
    watchdog = await import('./inventory-oversell-watchdog.service.js')
  }, 120_000)

  afterAll(async () => {
    vi.unstubAllEnvs()
    await database?.close()
  }, 30_000)

  beforeEach(() => vi.clearAllMocks())

  async function productFixture(stock: number, failOutbox = false) {
    return inWorkspace(async () => {
      const suffix = randomUUID()
      const product = await database.client.product.create({ data: {
        sku: `${failOutbox ? 'FAIL-STOCKOUT' : 'DURABILITY'}-${suffix}`,
        name: 'Event durability fixture', basePrice: 10, costPrice: 5,
        totalStock: stock, fulfillmentMethod: 'FBM',
      } })
      const location = await database.client.stockLocation.create({ data: {
        code: `WAREHOUSE-${suffix}`, name: 'Fixture warehouse', type: 'WAREHOUSE',
      } })
      await database.client.stockLevel.create({ data: {
        productId: product.id, locationId: location.id, quantity: stock, available: stock,
      } })
      return { product, location }
    })
  }

  it('rolls back opening a stockout when its outbox event cannot persist', async () => {
    const { product, location } = await productFixture(0, true)
    await inWorkspace(() => stockouts.handleMovementStockoutTransition({
      productId: product.id, sku: product.sku, locationId: location.id,
      prevAvailable: 1, nextAvailable: 0,
    }))

    expect(diagnostics.warn).toHaveBeenCalledWith('stockout-detector: movement hook failed', expect.objectContaining({
      error: expect.stringContaining('fixture rejects stockout outbox write'),
    }))
    expect(await inWorkspace(() => database.client.stockoutEvent.count({ where: { productId: product.id } }))).toBe(0)
    expect(await inWorkspace(() => database.client.eventOutbox.count({ where: { subject: product.id } }))).toBe(0)
  })

  it('rolls back closing a stockout when its cleared event cannot persist', async () => {
    const { product, location } = await productFixture(5, true)
    const opened = await inWorkspace(() => database.client.stockoutEvent.create({ data: {
      productId: product.id, sku: product.sku, locationId: location.id,
      detectedBy: 'movement', velocityAtStart: 1,
    } }))
    await inWorkspace(() => stockouts.handleMovementStockoutTransition({
      productId: product.id, sku: product.sku, locationId: location.id,
      prevAvailable: 0, nextAvailable: 5,
    }))

    expect(diagnostics.warn).toHaveBeenCalledWith('stockout-detector: movement hook failed', expect.objectContaining({
      error: expect.stringContaining('fixture rejects stockout outbox write'),
    }))
    const persisted = await inWorkspace(() => database.client.stockoutEvent.findUniqueOrThrow({ where: { id: opened.id } }))
    expect(persisted.endedAt).toBeNull()
    expect(persisted.closedBy).toBeNull()
    expect(await inWorkspace(() => database.client.eventOutbox.count({ where: { subject: product.id } }))).toBe(0)
  })

  it('persists one opened stockout and one event when the transition is delivered again', async () => {
    const { product, location } = await productFixture(0)
    const movement = { productId: product.id, sku: product.sku, locationId: location.id, prevAvailable: 1, nextAvailable: 0 }
    await inWorkspace(() => stockouts.handleMovementStockoutTransition(movement))
    await inWorkspace(() => stockouts.handleMovementStockoutTransition(movement))

    expect(await inWorkspace(() => database.client.stockoutEvent.count({ where: { productId: product.id, endedAt: null } }))).toBe(1)
    const events = await inWorkspace(() => database.client.eventOutbox.findMany({ where: { subject: product.id, type: 'inventory.stockout' } }))
    expect(events).toHaveLength(1)
    expect(events[0].payload).toMatchObject({ productId: product.id, locationId: location.id, availableNow: 0 })
  })

  async function oversellFixture(stock: number) {
    const { product, location } = await productFixture(stock)
    await inWorkspace(() => database.client.channelListing.create({ data: {
      productId: product.id, channelMarket: 'EBAY_IT', channel: 'EBAY', region: 'IT', marketplace: 'IT',
      fulfillmentMethod: 'FBM', listingStatus: 'ACTIVE', quantity: 9,
    } }))
    const envelope: EventEnvelope = {
      id: randomUUID(), type: 'inventory.stock_changed', version: 1,
      occurredAt: '2026-09-25T12:00:00.000Z', accountId: null, workspaceId: WORKSPACE,
      subject: product.id, correlationId: randomUUID(), causationId: null, source: 'test',
      payload: { productId: product.id, locationId: location.id, movementId: randomUUID(),
        change: -8, quantityBefore: 9, quantityAfter: 1, available: 1, poolTotal: 1, reason: 'fixture' },
    }
    const deliver = () => inWorkspace(() => withCorrelation({ correlationId: envelope.correlationId, causationId: envelope.id }, () => watchdog.handleStockChanged(envelope)))
    return { product, envelope, deliver }
  }

  it('publishes one risk event for simultaneous duplicate deliveries', async () => {
    const { product, envelope, deliver } = await oversellFixture(1)
    await Promise.all(Array.from({ length: 8 }, deliver))

    const events = await inWorkspace(() => database.client.eventOutbox.findMany({ where: {
      subject: product.id, type: 'inventory.oversell_risk_detected',
    } }))
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ causationId: envelope.id, correlationId: envelope.correlationId })
    expect(events[0].payload).toMatchObject({ poolAvailable: 1, maxChannelCommitment: 9, excessUnits: 8 })
  })

  it('does not report a stale decrease after current warehouse stock has recovered', async () => {
    const { product, deliver } = await oversellFixture(20)
    await deliver()

    expect(await inWorkspace(() => database.client.eventOutbox.count({ where: {
      subject: product.id, type: 'inventory.oversell_risk_detected',
    } }))).toBe(0)
  })
})
