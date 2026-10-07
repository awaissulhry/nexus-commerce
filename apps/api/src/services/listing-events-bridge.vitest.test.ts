// EV.3 — the stock bridge.
//
// /products/next subscribes to a `stock.adjusted` invalidation that NOTHING
// server-side had ever raised: every emitter was client-side, so a sale by
// webhook, a cron sync or another operator's edit never moved the column.
//
// inventory.stock_changed is raised on the DURABLE lane from applyStockMovement.
// The claim under test is that it reaches the SSE bus with no second publish —
// because the relay XADDs to the same stream the listing bus reads, so
// declaring the type on the bus is the entire server-side bridge.
//
// That is a claim about two components agreeing, which is exactly the kind that
// is comfortable to assert and wrong to assume.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { EventEnvelope } from '@nexus/events'
import { InMemoryBroker } from '../lib/events/broker.js'
import { setBroker, closeBroker } from '../lib/events/index.js'
import {
  publishListingEvent, subscribeListingEvents, getListenerCount,
  startListingEventIntake, stopListingEventIntake,
} from './listing-events.service.js'

const envelope = (type: string, payload: Record<string, unknown>): EventEnvelope => ({
  id: randomUUID(), type, version: 1, occurredAt: new Date().toISOString(),
  accountId: null, subject: String(payload.productId ?? 's'), correlationId: randomUUID(),
  causationId: null, source: 'relay', payload,
})

const stockPayload = {
  productId: 'p-1', locationId: 'loc-1', movementId: 'm-1', change: -1,
  quantityBefore: 10, quantityAfter: 9, available: 9, poolTotal: 9,
  reason: 'ORDER_PLACED', orderId: 'o-1',
}

describe('inventory.stock_changed reaches the listing SSE bus', () => {
  let broker: InMemoryBroker

  beforeEach(async () => {
    await stopListingEventIntake()
    await closeBroker()
    broker = new InMemoryBroker()
    setBroker(broker)
    await startListingEventIntake()
  })

  it('delivers a relayed stock event to SSE subscribers', async () => {
    // The durable lane's event, arriving the way the relay puts it on the
    // stream — not re-published by the bus itself.
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))

    await broker.publish([envelope('inventory.stock_changed', stockPayload)])

    expect(seen).toHaveLength(1)
    expect(seen[0].type).toBe('inventory.stock_changed')
    expect(seen[0].productId).toBe('p-1')
    off()
  })

  it('carries the payload an SSE client needs to act on', async () => {
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))
    await broker.publish([envelope('inventory.stock_changed', stockPayload)])
    expect(seen[0]).toMatchObject({ productId: 'p-1', available: 9, poolTotal: 9, reason: 'ORDER_PLACED' })
    // ts is restored from the envelope's domain time, not the delivery time.
    expect(typeof seen[0].ts).toBe('number')
    off()
  })

  it('does NOT deliver an event belonging to another bus', async () => {
    // The guard against an SSE client subscribed to listings receiving
    // purchase orders because both share one stream.
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))
    await broker.publish([envelope('po.created', { poId: 'po-1', poNumber: 'PO-1' })])
    expect(seen).toEqual([])
    off()
  })

  it('still delivers a locally published listing event synchronously', async () => {
    // The pre-existing behaviour must survive the migration to the factory.
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))
    publishListingEvent({ type: 'product.updated', productId: 'p-2', ts: Date.now() })
    expect(seen).toHaveLength(1)   // synchronous, same tick
    expect(seen[0].productId).toBe('p-2')
    off()
  })

  // Step 3 (cases) — a sealed count or a case pack change is raised on the durable lane by stock-cases.service.ts;
  // declaring the type on the bus is again the whole bridge to an open stock editor or Matrix.
  it('delivers a relayed inventory.cases_changed (a count, and a case-pack change) with its payload', async () => {
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))
    await broker.publish([
      envelope('inventory.cases_changed', { productId: 'p-3', locationId: 'loc-1', casesBefore: 4, casesAfter: 3, unitsPerCase: 12, reason: 'count' }),
      envelope('inventory.cases_changed', { productId: 'p-4', locationId: null, casesBefore: null, casesAfter: null, unitsPerCase: null, reason: 'case-pack' }),
    ])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ type: 'inventory.cases_changed', productId: 'p-3', locationId: 'loc-1', casesBefore: 4, casesAfter: 3, unitsPerCase: 12, reason: 'count' })
    expect(seen[1]).toMatchObject({ type: 'inventory.cases_changed', productId: 'p-4', locationId: null, unitsPerCase: null, reason: 'case-pack' })
    expect(typeof seen[0].ts).toBe('number')
    off()
  })

  // Step 4 (Send to FBA) — a plan's move is raised on the durable lane in the transaction that moves it; declaring the
  // type on the bus is the whole bridge to an open Matrix ("Inbound +N") and the plans drawer.
  it('delivers a relayed fba.plan_changed with its payload (the plan, its status and step, its SKUs)', async () => {
    const seen: any[] = []
    const off = subscribeListingEvents((e) => seen.push(e))
    await broker.publish([
      { ...envelope('fba.plan_changed', { planId: 'plan-1', status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', productIds: ['p-5', 'p-6'] }), subject: 'plan-1' },
      { ...envelope('fba.plan_changed', { planId: 'plan-2', status: 'CANCELLED', step: null, productIds: [] }), subject: 'plan-2' },
    ])
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatchObject({ type: 'fba.plan_changed', planId: 'plan-1', status: 'WAITING_FOR_CHOICE', step: 'CONFIRM', productIds: ['p-5', 'p-6'] })
    expect(seen[1]).toMatchObject({ type: 'fba.plan_changed', planId: 'plan-2', status: 'CANCELLED', step: null, productIds: [] })
    expect(typeof seen[0].ts).toBe('number')
    off()
  })

  it('unsubscribes cleanly', async () => {
    const before = getListenerCount()
    const off = subscribeListingEvents(() => {})
    expect(getListenerCount()).toBe(before + 1)
    off()
    expect(getListenerCount()).toBe(before)
  })
})
