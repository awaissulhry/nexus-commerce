import { z } from 'zod'
import { ORDER_WARNING_KINDS, type OrderWarningKind } from '@nexus/factory-domain/sales/warnings/kinds'
import type { ApiClient } from '../../../../../../lib/api/client'

/**
 * owb-ss3 (S3 web A; design plan § 5n + § 7 "Shipping: three ways", the word table "At our warehouse") — the calls of "to our
 * warehouse first" (server Shape: build/briefs/owb-ss1.md § Shape, FIXED): the legs of an order, the company's own warehouses with
 * what sits there and what is on the way, and the two acts — **It arrived at the warehouse** and **Send on to the customer**. Every
 * answer is checked (zod; unknown fields are dropped). Sending on answers 409 WARNINGS (the base helper's shape: code `conflict`,
 * issues `warning/<KIND>`) while a payment due before shipping is open: the window says it in words and "Send it anyway" sends the
 * same act again with `overrides`.
 */

const enc = encodeURIComponent

export const LEG_STATES = ['ON_THE_WAY', 'AT_OUR_WAREHOUSE', 'SENT_ON'] as const
export type LegState = (typeof LEG_STATES)[number]

export const legSchema = z.object({
  shipmentId: z.string(),
  version: z.number(),
  warehouse: z.object({ siteId: z.string(), name: z.string(), city: z.string().nullable() }),
  /** SHIPPED and not arrived · arrived and not sent on · sent on. */
  state: z.enum(LEG_STATES),
  arrivedAt: z.string().nullable(),
  forwardedAt: z.string().nullable(),
  forwardedWithoutLabel: z.boolean(),
  label: z.object({ sentAt: z.string(), byCustomer: z.boolean(), fileId: z.string() }).nullable(),
  /** arrived / sendOn: shipping.manage · label: shipping.plan OR shipping.manage (the server's own answer per row). */
  may: z.object({ arrived: z.boolean(), sendOn: z.boolean(), label: z.boolean() }),
})
export type Leg = z.infer<typeof legSchema>

/** The legs of an order's shipments that go to our warehouse first (shipping.view). */
export function warehouseLegs(api: ApiClient, salesOrderId: string, signal?: AbortSignal): Promise<Leg[]> {
  return api.get('/shipping/warehouse-legs', { query: { salesOrderId }, schema: z.object({ legs: z.array(legSchema) }), signal }).then((answer) => answer.legs)
}

const customerSchema = z.object({ partyId: z.string(), code: z.string(), name: z.string() })

export const ourWarehouseSchema = z.object({
  siteId: z.string(),
  code: z.string(),
  name: z.string(),
  city: z.string().nullable(),
  country: z.string(),
  atWarehouse: z.array(
    z.object({
      shipmentId: z.string(),
      number: z.string(),
      customer: customerSchema,
      salesOrders: z.array(z.object({ id: z.string(), number: z.string() })),
      pieces: z.number(),
      arrivedAt: z.string(),
      labelSentAt: z.string().nullable(),
    }),
  ),
  onTheWay: z.array(z.object({ shipmentId: z.string(), number: z.string(), customer: customerSchema, pieces: z.number(), shippedAt: z.string() })),
})
export type OurWarehouse = z.infer<typeof ourWarehouseSchema>
export type AtWarehouseRow = OurWarehouse['atWarehouse'][number]
export type OnTheWayRow = OurWarehouse['onTheWay'][number]

/** The company's own warehouses (sites of kind WAREHOUSE), each with what sits there and what is on its way (shipping.view). */
export function ourWarehouses(api: ApiClient, signal?: AbortSignal): Promise<OurWarehouse[]> {
  return api.get('/shipping/our-warehouses', { schema: z.object({ warehouses: z.array(ourWarehouseSchema) }), signal }).then((answer) => answer.warehouses)
}

/** It arrived at the warehouse (shipping.manage): once, while SHIPPED. */
export function markArrived(api: ApiClient, shipmentId: string, version: number): Promise<{ shipmentId: string; arrivedAt: string; version: number }> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/arrived`, { body: { version }, schema: z.object({ shipmentId: z.string(), arrivedAt: z.string(), version: z.number() }) })
}

export interface ForwardBody {
  readonly version: number
  readonly carrier: string | null
  readonly trackingNumber: string | null
  /** The warnings the person saw and goes on with (none: the first warning answers 409). */
  readonly overrides?: readonly OrderWarningKind[]
}

/** Send on to the customer (shipping.manage): after it arrived, once; without the customer's label it goes on with a logged warning. */
export function forwardShipment(api: ApiClient, shipmentId: string, body: ForwardBody): Promise<{ shipmentId: string; forwardedAt: string; forwardedWithoutLabel: boolean; version: number }> {
  return api.post(`/shipping/shipments/${enc(shipmentId)}/forward`, {
    body: { version: body.version, carrier: body.carrier, trackingNumber: body.trackingNumber, ...(body.overrides && body.overrides.length > 0 ? { overrides: [...body.overrides] } : {}) },
    schema: z.object({ shipmentId: z.string(), forwardedAt: z.string(), forwardedWithoutLabel: z.boolean(), version: z.number() }),
  })
}

/** The kinds of warning the web knows (the domain's list). */
export const WARNING_KINDS: readonly OrderWarningKind[] = ORDER_WARNING_KINDS
