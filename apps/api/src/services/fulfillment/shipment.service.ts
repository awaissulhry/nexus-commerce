/**
 * MCP full control 07 O8 — the Outbound page's shipment writes, moved out of routes/fulfillment.routes.ts so the page
 * and Claude's shipping tools write one way: create (one, bulk), print (buy) the label, hold, release, carrier/service,
 * void the label. The code is the routes' own, moved unchanged: the routes answer exactly as before
 * (routes/shipment-write-parity.vitest.test.ts, snapshots written by the route code before the move). Each function
 * answers what its route answered: a status code and a body (RouteAnswer).
 *
 * Every write runs in the caller's business (row-level security). An order Amazon ships never gets a shipment or a
 * label (07 O1, amazon-fulfilled-order.ts). Labels cost money: Sendcloud is a dry run unless
 * NEXUS_ENABLE_SENDCLOUD_REAL=true, Amazon Buy Shipping unless NEXUS_ENABLE_AMAZON_BUY_SHIPPING is set.
 */

import prisma from '../../db.js'
import { amazonFulfilledRefusal } from './amazon-fulfilled-order.js'
import { resolveWarehouseForOrder } from '../order-routing.service.js'
import { enqueueTrackingUpload } from './tracking-upload.service.js'
import { AnswerReply, answered, RouteAnswer, type RouteLog } from '../../lib/route-answer.js'

/** POST /fulfillment/shipments — one DRAFT shipment for an order (07 O1: never for an order Amazon ships). */
export async function createShipmentForOrder(body: { orderId: string; warehouseId?: string; carrierCode?: string }, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    if (!body.orderId) return reply.code(400).send({ error: 'orderId is required' })

    const order = await prisma.order.findUnique({
      where: { id: body.orderId },
      include: { items: true },
    })
    if (!order) return reply.code(404).send({ error: 'Order not found' })
    // 07 O1 — never a parcel for an order Amazon ships (FBA, MCF; fail closed).
    const amazonShips = await amazonFulfilledRefusal(prisma, order)
    if (amazonShips) return reply.code(400).send(amazonShips)

    // Shared stock step 4 — an order whose units came from a pool ships from this business's copy of
    // the lender's warehouse address (unless the operator chose a warehouse).
    const { sharedWarehouseForOrder } = await import('../stock-pool/shared-warehouses.js')
    const warehouseId = body.warehouseId
      ?? (await sharedWarehouseForOrder(order.id))
      ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

    const shipment = await prisma.shipment.create({
      data: {
        orderId: order.id,
        warehouseId,
        carrierCode: (body.carrierCode as any) ?? 'SENDCLOUD',
        status: 'DRAFT',
        items: {
          create: order.items.map((it) => ({
            orderItemId: it.id,
            productId: it.productId,
            sku: it.sku,
            quantity: it.quantity,
          })),
        },
      },
      include: { items: true },
    })
    return shipment
  })())
}

/** POST /fulfillment/shipments/:id/print-label — buys the label (MANUAL: none; Sendcloud; Amazon Buy Shipping). Money. */
export async function printShipmentLabel(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const shipment = await prisma.shipment.findUnique({
      where: { id },
      include: {
        warehouse: true,
        order: {
          include: {
            items: {
              include: {
                product: {
                  select: {
                    sku: true,
                    hsCode: true,
                    countryOfOrigin: true,
                    weightValue: true,
                    weightUnit: true,
                  },
                },
              },
            },
          },
        },
      },
    })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    if (!shipment.order) {
      return reply.code(400).send({ error: 'Shipment has no order; cannot print label.' })
    }

    const order = shipment.order
    // 07 O1 — no carrier label for an order Amazon ships (FBA, MCF; fail closed), before any carrier call.
    const amazonShips = await amazonFulfilledRefusal(prisma, order)
    if (amazonShips) return reply.code(400).send(amazonShips)

    // CR.4: shared inputs that every carrier branch needs. Pulled
    // out of the Sendcloud-specific path so AMAZON_BUY_SHIPPING +
    // MANUAL can reuse the address normalization + weight resolver
    // + customs item map without duplication.

    // O.17: address preflight. Errors block (any carrier rejects on
    // bad address); warnings logged but don't block.
    {
      const { validateAddress, extractAddressFromOrder } = await import('../address-validation/index.js')
      const validation = validateAddress(extractAddressFromOrder(order))
      const errors = validation.issues.filter((i) => i.severity === 'error')
      if (errors.length > 0) {
        return reply.code(400).send({
          error: 'Address validation failed',
          code: 'ADDRESS_INVALID',
          issues: validation.issues,
        })
      }
      const warnings = validation.issues.filter((i) => i.severity === 'warning')
      if (warnings.length > 0) {
        log.warn({ shipmentId: id, warnings }, '[print-label] address warnings')
      }
    }

    const ship = order.shippingAddress as any
    // The address blob arrives in two shapes — Amazon-PascalCase
    // (AddressLine1, City, ...) and generic camelCase (addressLine1,
    // city, ...). Normalize once for all carriers.
    const addr = {
      name: order.customerName || 'Customer',
      address: ship?.AddressLine1 ?? ship?.addressLine1 ?? ship?.street ?? '',
      address_2: ship?.AddressLine2 ?? ship?.addressLine2 ?? undefined,
      city: ship?.City ?? ship?.city ?? '',
      postal_code: ship?.PostalCode ?? ship?.postalCode ?? '',
      country: ship?.CountryCode ?? ship?.countryCode ?? ship?.country ?? 'IT',
      country_state: ship?.StateOrRegion ?? ship?.stateOrProvince ?? ship?.state ?? undefined,
      telephone: ship?.Phone ?? ship?.phone ?? undefined,
      email: order.customerEmail || undefined,
    }

    // Weight: prefer operator-entered shipment.weightGrams (from the
    // pack station — O.13), else aggregate from product weights, else
    // default 1.5 kg as a reasonable motorcycle-gear baseline.
    let weightKg: number
    if (shipment.weightGrams && shipment.weightGrams > 0) {
      weightKg = shipment.weightGrams / 1000
    } else {
      const summed = order.items.reduce((acc, it) => {
        const w = it.product?.weightValue ? Number(it.product.weightValue) : 0
        const factor = it.product?.weightUnit === 'g' ? 0.001 : 1 // assume kg otherwise
        return acc + w * factor * it.quantity
      }, 0)
      weightKg = summed > 0 ? summed : 1.5
    }

    // CR.4 — branch on carrierCode. Default fall-through is SENDCLOUD
    // for backward compat with the O.8 contract.
    const carrierCode = shipment.carrierCode ?? 'SENDCLOUD'

    // ── MANUAL ──────────────────────────────────────────────────
    // No live carrier integration; operator pastes a tracking number
    // separately. Mark LABEL_PRINTED so the rest of the pipeline
    // (pack/ship transitions, channel pushback once a tracking
    // number is set manually) treats this shipment as ready to ship.
    // No Sendcloud / Amazon round-trip; no labelUrl set.
    if (carrierCode === 'MANUAL') {
      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'LABEL_PRINTED',
          labelPrintedAt: new Date(),
          version: { increment: 1 },
        },
      })
      await prisma.trackingEvent.create({
        data: {
          shipmentId: id,
          occurredAt: new Date(),
          code: 'ANNOUNCED',
          description: 'Manual carrier — operator will paste tracking number',
          source: 'MANUAL',
        },
      })
      return {
        ...updated,
        _hint: 'No label generated. Open the shipment drawer and paste the carrier-issued tracking number to push it to the channel.',
      }
    }

    // ── AMAZON_BUY_SHIPPING ────────────────────────────────────
    // Only valid for AMAZON-channel orders. Pulls the operator's
    // ship-from address from the bound Warehouse (was hardcoded
    // Riccione before CR.4 — broken for any other warehouse).
    // amazonOrderId from order.channelOrderId; itemList from the
    // order items, mapping our internal id → Amazon's OrderItemId
    // which lives in amazonMetadata.OrderItemId.
    if (carrierCode === 'AMAZON_BUY_SHIPPING') {
      if (order.channel !== 'AMAZON') {
        return reply.code(400).send({
          error: 'Amazon Buy Shipping is only valid for Amazon-channel orders.',
          code: 'BUY_SHIPPING_WRONG_CHANNEL',
        })
      }
      const wh = shipment.warehouse
      if (!wh || !wh.addressLine1 || !wh.city || !wh.postalCode || !wh.country) {
        return reply.code(400).send({
          error: 'Bound warehouse has no address. Set ship-from in /fulfillment/stock.',
          code: 'WAREHOUSE_ADDRESS_MISSING',
        })
      }

      const itemList = order.items.map((it) => {
        const meta = it.amazonMetadata as any
        // Prefer Amazon's OrderItemId from the metadata; fall back to
        // our internal id only if missing (rare — pre-O.x rows).
        return {
          orderItemId: meta?.OrderItemId ?? meta?.orderItemId ?? it.id,
          quantity: it.quantity,
        }
      })

      const buyShipping = await import('../amazon-pushback/buy-shipping.js')
      let purchased
      try {
        // For Buy Shipping we go straight to createShipment with the
        // cheapest-eligible service. Caller-driven service selection
        // (rate-compare → bind via PATCH /service → print-label) is
        // wired in CR.13; today the rules engine sets carrierCode +
        // serviceCode upfront, and we honor serviceCode if present.
        const eligibility = await buyShipping.getEligibleShippingServices({
          amazonOrderId: order.channelOrderId,
          itemList,
          shipFromAddress: {
            name: wh.name,
            addressLine1: wh.addressLine1,
            addressLine2: wh.addressLine2 ?? undefined,
            city: wh.city,
            postalCode: wh.postalCode,
            countryCode: wh.country,
          },
          weightGrams: Math.round(weightKg * 1000),
        })
        if (eligibility.length === 0) {
          return reply.code(400).send({
            error: 'No eligible Amazon Buy Shipping services for this order.',
            code: 'NO_ELIGIBLE_SERVICES',
          })
        }
        // Honor pre-bound serviceCode if present, else cheapest.
        const chosen = shipment.serviceCode
          ? eligibility.find((s) => s.shippingServiceOfferId === shipment.serviceCode) ?? eligibility[0]
          : eligibility.reduce((a, b) => (a.rate.amount <= b.rate.amount ? a : b))
        purchased = await buyShipping.createShipment(
          {
            amazonOrderId: order.channelOrderId,
            itemList,
            shipFromAddress: {
              name: wh.name,
              addressLine1: wh.addressLine1,
              addressLine2: wh.addressLine2 ?? undefined,
              city: wh.city,
              postalCode: wh.postalCode,
              countryCode: wh.country,
            },
            weightGrams: Math.round(weightKg * 1000),
          },
          chosen.shippingServiceOfferId,
        )
      } catch (e: any) {
        log.warn({ err: e, shipmentId: id }, '[print-label] Buy Shipping rejected')
        return reply.code(502).send({
          error: `Amazon Buy Shipping: ${e?.message ?? String(e)}`,
          code: 'BUY_SHIPPING_FAILED',
        })
      }

      const updated = await prisma.shipment.update({
        where: { id },
        data: {
          status: 'LABEL_PRINTED',
          trackingNumber: purchased.trackingId,
          // Amazon doesn't expose a public tracking URL for Buy
          // Shipping pre-pickup; the tracking page on Seller Central
          // requires auth. Leave trackingUrl null until carrier
          // status returns a public deeplink.
          trackingUrl: null,
          // Buy Shipping returns base64 PDF, not a hosted URL. We
          // store a data: URL so the existing print flow can stream
          // it; CR.16 will move this to S3 with a presigned URL.
          labelUrl: purchased.labelData
            ? `data:application/pdf;base64,${purchased.labelData}`
            : null,
          serviceCode: purchased.shippingServiceId,
          serviceName: purchased.carrierName,
          costCents: Math.round(purchased.rate.amount * 100),
          currencyCode: purchased.rate.currencyCode,
          labelPrintedAt: new Date(),
          version: { increment: 1 },
        },
      })

      await prisma.trackingEvent.create({
        data: {
          shipmentId: id,
          occurredAt: new Date(),
          code: 'ANNOUNCED',
          description: `Buy Shipping label purchased (${purchased.carrierName})`,
          source: 'AMAZON_BUY_SHIPPING',
        },
      })

      const { auditLogService } = await import('../audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'print-label',
        before: { status: shipment.status },
        after: {
          status: 'LABEL_PRINTED',
          trackingNumber: purchased.trackingId,
          carrierCode: 'AMAZON_BUY_SHIPPING',
        },
        metadata: {
          dryRun: purchased.dryRun ?? false,
          carrier: purchased.carrierName,
          costCents: Math.round(purchased.rate.amount * 100),
          weightKg,
          country: addr.country,
        },
      })

      return updated
    }

    // ── SENDCLOUD (default) ─────────────────────────────────────
    // O.8: real Sendcloud call (replaces the B.4 stub). The
    // sendcloud module returns mock data when
    // NEXUS_ENABLE_SENDCLOUD_REAL=false (the default), so this path
    // works end-to-end in dryRun mode without ever touching
    // Sendcloud. resolveCredentials() throws SendcloudError with a
    // clean 400 message if the carrier isn't connected.
    // CR.10: pass the shipment's warehouseId so the resolver picks
    // up the warehouse-bound CarrierAccount when set; null/undefined
    // falls through to the primary Carrier credentials.
    const sendcloud = await import('../sendcloud/index.js')
    let creds
    try {
      creds = await sendcloud.resolveCredentials(shipment.warehouseId)
    } catch (e: any) {
      if (e instanceof sendcloud.SendcloudError) {
        return reply.code(e.status).send({ error: e.message, code: e.code })
      }
      throw e
    }

    // Parcel items for customs declaration. Sendcloud uses these for
    // international shipments + ignores for domestic. HS code +
    // country-of-origin live on Product (per schema comment 1746).
    const parcelItems = order.items.map((it) => ({
      description: it.product?.sku ?? it.sku,
      quantity: it.quantity,
      weight: '0.100', // per-line weight rarely matters for our use
      value: Number(it.price).toFixed(2),
      hs_code: it.product?.hsCode ?? undefined,
      origin_country: it.product?.countryOfOrigin ?? undefined,
      sku: it.sku,
    }))

    // Service map lookup: which Sendcloud shipping_method to use for
    // this (channel, marketplace). Returns null when no rule maps —
    // Sendcloud auto-picks based on dimensions + destination.
    // CR.22: pass destinationCountry so resolveServiceMap can
    // auto-fallback to a tier-matched service (DOMESTIC/EU →
    // STANDARD, INTL → EXPRESS) when no exact mapping exists.
    const serviceId = await sendcloud.resolveServiceMap(
      order.channel,
      order.marketplace,
      shipment.warehouseId,
      addr.country,
    )

    // CR.11: sender_address from the bound Warehouse. Sendcloud
    // uses the integration default when omitted; passing an explicit
    // ID lets multi-warehouse operators ship from the right origin.
    const senderId = shipment.warehouse?.sendcloudSenderId ?? undefined

    const input = {
      ...addr,
      weight: weightKg.toFixed(3),
      order_number: order.channelOrderId,
      total_order_value: Number(order.totalPrice).toFixed(2),
      total_order_value_currency: order.currencyCode ?? 'EUR',
      shipment: serviceId ? { id: serviceId } : undefined,
      sender_address: senderId,
      parcel_items: parcelItems.length > 0 ? parcelItems : undefined,
      external_reference: shipment.id,
      request_label: true,
    }

    let parcel
    try {
      parcel = await sendcloud.createParcel(creds, input)
    } catch (e: any) {
      if (e instanceof sendcloud.SendcloudError) {
        log.warn({ err: e, shipmentId: id }, '[print-label] Sendcloud rejected')
        return reply.code(502).send({
          error: `Sendcloud: ${e.message}`,
          code: e.code,
        })
      }
      throw e
    }

    const labelUrl = parcel.label?.normal_printer?.[0] ?? null

    const updated = await prisma.shipment.update({
      where: { id },
      data: {
        status: 'LABEL_PRINTED',
        sendcloudParcelId: String(parcel.id),
        trackingNumber: parcel.tracking_number,
        trackingUrl: parcel.tracking_url,
        labelUrl,
        serviceCode: parcel.shipment?.name ?? null,
        serviceName: parcel.shipment?.name ?? null,
        labelPrintedAt: new Date(),
        version: { increment: 1 },
      },
    })

    // CR.3: bump Carrier.lastUsedAt so the marketplace UI's "active"
    // sort surfaces recently-used carriers first. Fire-and-forget;
    // a counter blip shouldn't fail label-print.
    void prisma.carrier
      .updateMany({
        where: { code: 'SENDCLOUD' },
        data: { lastUsedAt: new Date() },
      })
      .catch(() => { /* */ })

    // Seed the timeline with the initial ANNOUNCED event so the
    // drawer / branded tracking page have something to render before
    // the first carrier scan webhook arrives.
    await prisma.trackingEvent.create({
      data: {
        shipmentId: id,
        occurredAt: new Date(),
        code: 'ANNOUNCED',
        description: 'Label generated, awaiting carrier pickup',
        source: 'SENDCLOUD',
        carrierRawCode: String(parcel.status?.id ?? ''),
      },
    })

    // O.39: audit. Includes mode (real vs dryRun) so post-incident
    // forensics can distinguish "we sent this to Sendcloud" from
    // "we mocked this in dryRun".
    const { auditLogService } = await import('../audit-log.service.js')
    const mode = sendcloud.getSendcloudMode()
    void auditLogService.write({
      entityType: 'Shipment',
      entityId: id,
      action: 'print-label',
      before: { status: shipment.status },
      after: {
        status: 'LABEL_PRINTED',
        sendcloudParcelId: String(parcel.id),
        trackingNumber: parcel.tracking_number,
      },
      metadata: { dryRun: mode.dryRun, env: mode.env, weightKg, country: addr.country, carrierCode: 'SENDCLOUD' },
    })

    return updated
  })())
}

/** POST /fulfillment/shipments/:id/release — ON_HOLD back to DRAFT. */
export async function releaseShipment(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    if (shipment.status !== ('ON_HOLD' as any)) {
      return reply.code(400).send({ error: `Shipment is not on hold (status: ${shipment.status})` })
    }
    const updated = await prisma.shipment.update({
      where: { id },
      data: {
        status: 'DRAFT',
        heldAt: null,
        heldReason: null,
        version: { increment: 1 },
      },
    })
    const { publishOutboundEvent } = await import('../outbound-events.service.js')
    publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: 'DRAFT', ts: Date.now() })
    // O.39: audit log — fail-open per the service contract.
    const { auditLogService } = await import('../audit-log.service.js')
    void auditLogService.write({
      entityType: 'Shipment',
      entityId: id,
      action: 'release',
      before: { status: 'ON_HOLD', heldReason: shipment.heldReason },
      after: { status: 'DRAFT' },
    })
    return updated
  })())
}

/** POST /fulfillment/shipments/:id/hold — a shipment without a label goes ON_HOLD with a reason. */
export async function holdShipment(id: string, body: { reason?: string }, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    if (['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(shipment.status)) {
      return reply.code(400).send({
        error: `Cannot hold a shipment in status ${shipment.status}. Void the label first if needed.`,
      })
    }
    const heldReason = body.reason?.trim() || 'Manually held by operator'
    const updated = await prisma.shipment.update({
      where: { id },
      data: {
        status: 'ON_HOLD' as any,
        heldAt: new Date(),
        heldReason,
        version: { increment: 1 },
      },
    })
    const { publishOutboundEvent } = await import('../outbound-events.service.js')
    publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: 'ON_HOLD', ts: Date.now() })
    const { auditLogService } = await import('../audit-log.service.js')
    void auditLogService.write({
      entityType: 'Shipment',
      entityId: id,
      action: 'hold',
      before: { status: shipment.status },
      after: { status: 'ON_HOLD', heldReason },
    })
    return updated
  })())
}

/** PATCH /fulfillment/shipments/:id/service — the carrier and service, before a label. */
export async function setShipmentService(id: string, body: { carrierCode?: string; serviceCode?: string; serviceName?: string }, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    if (['LABEL_PRINTED', 'SHIPPED', 'IN_TRANSIT', 'DELIVERED'].includes(shipment.status)) {
      return reply.code(400).send({
        error: 'Cannot change service after label printed. Void the label first.',
      })
    }
    const updated = await prisma.shipment.update({
      where: { id },
      data: {
        ...(body.carrierCode ? { carrierCode: body.carrierCode as any } : {}),
        ...(body.serviceCode != null ? { serviceCode: body.serviceCode } : {}),
        ...(body.serviceName != null ? { serviceName: body.serviceName } : {}),
        version: { increment: 1 },
      },
    })
    return updated
  })())
}

/** POST /fulfillment/shipments/:id/void-label — cancels the Sendcloud parcel, back to PACKED or DRAFT. */
export async function voidShipmentLabel(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const shipment = await prisma.shipment.findUnique({ where: { id } })
    if (!shipment) return reply.code(404).send({ error: 'Shipment not found' })
    if (!['LABEL_PRINTED'].includes(shipment.status)) {
      return reply.code(400).send({
        error: `Cannot void from status ${shipment.status}. Only LABEL_PRINTED labels can be voided.`,
      })
    }
    if (!shipment.sendcloudParcelId) {
      return reply.code(400).send({ error: 'No Sendcloud parcel to void.' })
    }

    const sendcloud = await import('../sendcloud/index.js')
    let creds
    try {
      creds = await sendcloud.resolveCredentials()
    } catch (e: any) {
      if (e instanceof sendcloud.SendcloudError) {
        return reply.code(e.status).send({ error: e.message, code: e.code })
      }
      throw e
    }

    const result = await sendcloud.voidParcel(creds, Number(shipment.sendcloudParcelId))
    if (result.ok === false) {
      const reason = (result as { ok: false; reason: string }).reason
      // Audit the failed attempt — operator may want to see the
      // history of "we tried to void, Sendcloud said no".
      const { auditLogService } = await import('../audit-log.service.js')
      void auditLogService.write({
        entityType: 'Shipment',
        entityId: id,
        action: 'void-label-failed',
        metadata: { reason },
      })
      return reply.code(502).send({ error: `Sendcloud refused: ${reason}` })
    }

    // Reset shipment for a fresh print. Keep the order link, items,
    // weight + dimensions; clear the parcel-specific fields.
    const updated = await prisma.shipment.update({
      where: { id },
      data: {
        status: shipment.weightGrams ? 'PACKED' : 'DRAFT',
        sendcloudParcelId: null,
        trackingNumber: null,
        trackingUrl: null,
        labelUrl: null,
        labelPrintedAt: null,
        serviceCode: null,
        serviceName: null,
        version: { increment: 1 },
      },
    })

    const { publishOutboundEvent } = await import('../outbound-events.service.js')
    publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: updated.status, ts: Date.now() })
    const { auditLogService } = await import('../audit-log.service.js')
    void auditLogService.write({
      entityType: 'Shipment',
      entityId: id,
      action: 'void-label',
      before: {
        status: 'LABEL_PRINTED',
        sendcloudParcelId: shipment.sendcloudParcelId,
        trackingNumber: shipment.trackingNumber,
      },
      after: { status: updated.status },
    })

    return updated
  })())
}

/** POST /fulfillment/shipments/bulk-create — one shipment per order, by the routing and shipping rules. */
export async function bulkCreateShipments(body: { orderIds?: string[]; warehouseId?: string; carrierCode?: string }, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const orderIds = Array.isArray(body.orderIds) ? body.orderIds : []
    if (orderIds.length === 0) return reply.code(400).send({ error: 'orderIds[] required' })
    if (orderIds.length > 200) return reply.code(400).send({ error: 'Max 200 orders per bulk create' })

    // Caller-supplied warehouse wins; otherwise the routing engine
    // (OrderRoutingRule rules) decides per-order.
    const explicitWarehouseId = body.warehouseId ?? null

    let created = 0
    const errors: Array<{ orderId: string; reason: string }> = []
    const routingByOrder: Record<string, { warehouseId: string | null; source: string; ruleName: string | null }> = {}
    for (const oid of orderIds) {
      try {
        const existing = await prisma.shipment.findFirst({ where: { orderId: oid, status: { not: 'CANCELLED' } } })
        if (existing) { errors.push({ orderId: oid, reason: 'shipment already exists' }); continue }
        const order = await prisma.order.findUnique({ where: { id: oid }, include: { items: true } })
        if (!order) { errors.push({ orderId: oid, reason: 'order not found' }); continue }
        // 07 O1 — skip an order Amazon ships (FBA, MCF; fail closed).
        const amazonShips = await amazonFulfilledRefusal(prisma, order)
        if (amazonShips) { errors.push({ orderId: oid, reason: amazonShips.error }); continue }

        // Per-order routing: explicit override > rule match > default.
        let resolvedWarehouseId: string | null = explicitWarehouseId
        let routingSource = 'EXPLICIT_OVERRIDE'
        let routingRuleName: string | null = null
        if (!explicitWarehouseId) {
          const shippingCountry =
            (order.shippingAddress as any)?.country ?? null
          const routing = await resolveWarehouseForOrder({
            channel: order.channel,
            marketplace: order.marketplace,
            shippingCountry,
            orderId: order.id, // shared stock step 4: pool units ship from the lender's address
          })
          resolvedWarehouseId = routing.warehouseId
          routingSource = routing.source
          routingRuleName = routing.ruleName
        }
        routingByOrder[oid] = {
          warehouseId: resolvedWarehouseId,
          source: routingSource,
          ruleName: routingRuleName,
        }

        // O.16: shipping rules — decide carrier + service from
        // operator-defined rules. Caller-supplied carrierCode wins
        // (explicit override); otherwise the rules engine picks;
        // otherwise fall back to SENDCLOUD as the original default.
        let resolvedCarrier = (body.carrierCode as any) ?? null
        let resolvedService: string | null = null
        // O.36: hold-for-review state. Set when the matching rule's
        // actions.holdForReview = true.
        let holdForReview = false
        let holdReason: string | null = null
        if (!body.carrierCode) {
          const { applyShippingRules } = await import('../shipping-rules/applier.js')
          const dest = (order.shippingAddress as any)?.country
            ?? (order.shippingAddress as any)?.CountryCode
            ?? null
          const applied = await applyShippingRules({
            channel: order.channel,
            marketplace: order.marketplace,
            destinationCountry: typeof dest === 'string' ? dest : null,
            weightGrams: null, // unknown until pack station
            orderTotalCents: Math.round(Number(order.totalPrice) * 100),
            itemCount: order.items.length,
            isPrime: order.isPrime ?? null,
            hasHazmat: false,
            skus: order.items.map((it) => it.sku),
          })
          if (applied?.actions.preferCarrierCode) {
            resolvedCarrier = applied.actions.preferCarrierCode as any
            resolvedService = applied.actions.preferServiceCode ?? null
          }
          if (applied?.actions.holdForReview) {
            holdForReview = true
            holdReason = `Auto-held by rule "${applied.ruleName}"`
          }
        }
        await prisma.shipment.create({
          data: {
            orderId: oid,
            warehouseId: resolvedWarehouseId,
            carrierCode: resolvedCarrier ?? 'SENDCLOUD',
            serviceCode: resolvedService,
            status: holdForReview ? ('ON_HOLD' as any) : 'DRAFT',
            heldAt: holdForReview ? new Date() : null,
            heldReason: holdReason,
            items: {
              create: order.items.map((it) => ({
                orderItemId: it.id, productId: it.productId, sku: it.sku, quantity: it.quantity,
              })),
            },
          },
        })
        created++
      } catch (e: any) {
        errors.push({ orderId: oid, reason: e?.message ?? String(e) })
      }
    }
    return { created, errors, routing: routingByOrder }
  })())
}

/** Shipment states before a label: the ones a shipment can be held, cancelled or re-routed in. */
export const UNLABELLED_STATUSES = ['DRAFT', 'READY_TO_PICK', 'PICKED', 'PACKED', 'ON_HOLD'] as const

/**
 * 07 O8 — cancel a shipment that has no label yet (status CANCELLED, cancelledAt now): what undoing a created shipment
 * does. Refused once a label exists (void it first) or after it left. The order goes back to the ship queue.
 */
export async function cancelUnlabelledShipment(id: string): Promise<RouteAnswer> {
  const shipment = await prisma.shipment.findFirst({ where: { id, deletedAt: null } })
  if (!shipment) return new RouteAnswer(404, { error: 'Shipment not found' })
  if (!(UNLABELLED_STATUSES as readonly string[]).includes(shipment.status) || shipment.labelUrl || shipment.sendcloudParcelId) {
    return new RouteAnswer(400, { error: `Cannot cancel a shipment in status ${shipment.status} or with a label. Void the label first.` })
  }
  const updated = await prisma.shipment.update({
    where: { id },
    data: { status: 'CANCELLED', cancelledAt: new Date(), version: { increment: 1 } },
  })
  const { publishOutboundEvent } = await import('../outbound-events.service.js')
  publishOutboundEvent({ type: 'shipment.updated', shipmentId: id, status: 'CANCELLED', ts: Date.now() })
  return new RouteAnswer(200, updated)
}

/**
 * 07 O8 — set a shipment's carrier and service exactly (null included), before a label. The route's PATCH cannot set a
 * service back to none; undoing a service change must.
 */
export async function restoreShipmentService(id: string, service: { carrierCode: string; serviceCode: string | null; serviceName: string | null }): Promise<RouteAnswer> {
  const shipment = await prisma.shipment.findFirst({ where: { id, deletedAt: null } })
  if (!shipment) return new RouteAnswer(404, { error: 'Shipment not found' })
  if (!(UNLABELLED_STATUSES as readonly string[]).includes(shipment.status)) {
    return new RouteAnswer(400, { error: 'Cannot change service after label printed. Void the label first.' })
  }
  const updated = await prisma.shipment.update({
    where: { id },
    data: { carrierCode: service.carrierCode as any, serviceCode: service.serviceCode, serviceName: service.serviceName, version: { increment: 1 } },
  })
  return new RouteAnswer(200, updated)
}

/**
 * POST /fulfillment/shipments/:id/mark-shipped — the operator marks a shipment shipped; for a MANUAL carrier this also
 * queues its tracking upload (07 O9).
 */
export async function markShipmentShipped(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const before = await prisma.shipment.findUnique({
      where: { id },
      select: { status: true, trackingNumber: true, orderId: true },
    })
    if (!before) return reply.code(404).send({ error: 'Shipment not found' })
    const shippedAt = new Date()
    const updated = await prisma.shipment.update({
      where: { id },
      data: { status: 'SHIPPED', shippedAt, version: { increment: 1 } },
    })
    // O.4: project Shipment.shippedAt onto the parent Order when
    // Order.shippedAt is still null. Multi-shipment orders keep the
    // first ship-out (SLA milestone) — updateMany with the null
    // guard makes this a no-op for later shipments.
    if (before.orderId) {
      await prisma.order.updateMany({
        where: { id: before.orderId, shippedAt: null },
        data: { shippedAt },
      })
    }
    // O.39: audit.
    const { auditLogService } = await import('../audit-log.service.js')
    void auditLogService.write({
      entityType: 'Shipment',
      entityId: id,
      action: 'mark-shipped',
      before: { status: before.status },
      after: { status: 'SHIPPED', shippedAt: updated.shippedAt },
    })
    // Channel pushback for a Sendcloud parcel fires from the O.7 webhook when the carrier scans it. A MANUAL-carrier
    // shipment gets no webhook: its tracking upload is queued here (07 O9; one per shipment, never for an order
    // Amazon ships, only with a tracking number).
    if (updated.carrierCode === 'MANUAL') {
      await enqueueTrackingUpload(id, { shippedAt, trackingNumber: updated.trackingNumber, trackingUrl: updated.trackingUrl, carrierCode: 'MANUAL' }, { explicit: true })
    }
    return updated
  })())
}

/**
 * 07 O9 — the tracking number of a MANUAL-carrier shipment, before it ships (a carrier label has its own). Trimmed;
 * an empty one is refused. `carrierName` (which carrier it travels with) goes in the service name.
 */
export async function setManualTrackingNumber(id: string, body: { trackingNumber?: string; trackingUrl?: string; carrierName?: string }): Promise<RouteAnswer> {
  const trackingNumber = typeof body.trackingNumber === 'string' ? body.trackingNumber.trim() : ''
  if (!trackingNumber) return new RouteAnswer(400, { error: 'trackingNumber required' })
  const shipment = await prisma.shipment.findFirst({ where: { id, deletedAt: null } })
  if (!shipment) return new RouteAnswer(404, { error: 'Shipment not found' })
  if (shipment.carrierCode !== 'MANUAL') return new RouteAnswer(400, { error: `A ${shipment.carrierCode} label carries its own tracking number.` })
  if (!['DRAFT', 'READY_TO_PICK', 'PICKED', 'PACKED', 'LABEL_PRINTED', 'ON_HOLD'].includes(shipment.status)) {
    return new RouteAnswer(400, { error: `The shipment is ${shipment.status}: its tracking number is set before it ships.` })
  }
  const updated = await prisma.shipment.update({
    where: { id },
    data: {
      trackingNumber,
      ...(typeof body.trackingUrl === 'string' && body.trackingUrl.trim() ? { trackingUrl: body.trackingUrl.trim() } : {}),
      ...(typeof body.carrierName === 'string' && body.carrierName.trim() ? { serviceName: body.carrierName.trim() } : {}),
      version: { increment: 1 },
    },
  })
  return new RouteAnswer(200, updated)
}
