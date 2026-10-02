/**
 * MCP full control 07 O8 — the return label (O.75), moved out of routes/returns.routes.ts so the Returns page and
 * Claude's buy-shipping-label write one way. The code is the route's own: the route answers exactly as before
 * (routes/shipment-write-parity.vitest.test.ts). A Sendcloud return parcel (is_return): a dry run unless
 * NEXUS_ENABLE_SENDCLOUD_REAL=true. It runs in the caller's business.
 */

import prisma from '../../db.js'
import { AnswerReply, answered, type RouteAnswer, type RouteLog } from '../../lib/route-answer.js'

/** POST /fulfillment/returns/:id/generate-label — a prepaid Sendcloud label for the buyer to send the return back. */
export async function generateReturnLabel(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  return answered(await (async () => {
    const ret = await prisma.return.findUnique({
      where: { id },
      include: {
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
    if (!ret) return reply.code(404).send({ error: 'Return not found' })
    if (!ret.order) {
      return reply.code(400).send({ error: 'Return has no order — cannot generate label' })
    }
    if (ret.returnLabelUrl) {
      return reply.code(409).send({
        error: 'Label already exists — remove the existing label first',
        code: 'LABEL_EXISTS',
      })
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

    const order = ret.order
    const ship = order.shippingAddress as any
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

    // Weight: aggregate from product master if available, else 1.5kg
    // baseline (same fallback as outbound print-label).
    const summedKg = order.items.reduce((acc, it) => {
      const w = it.product?.weightValue ? Number(it.product.weightValue) : 0
      const factor = it.product?.weightUnit === 'g' ? 0.001 : 1
      return acc + w * factor * it.quantity
    }, 0)
    const weightKg = summedKg > 0 ? summedKg : 1.5

    const totalValue = order.items.reduce(
      (acc, it) => acc + Number(it.price) * it.quantity,
      0,
    )

    try {
      const parcel = await sendcloud.createParcel(creds, {
        ...addr,
        weight: weightKg.toFixed(3),
        order_number: ret.rmaNumber ?? ret.id,
        total_order_value: totalValue.toFixed(2),
        total_order_value_currency: ret.currencyCode ?? 'EUR',
        external_reference: `return-${ret.id}`,
        is_return: true,
        // Customs items only matter for international returns;
        // Sendcloud silently ignores them domestically.
        parcel_items: order.items.map((it) => ({
          description: it.product?.sku ?? it.sku,
          quantity: it.quantity,
          weight: '0.100',
          value: Number(it.price).toFixed(2),
          hs_code: it.product?.hsCode ?? undefined,
          origin_country: it.product?.countryOfOrigin ?? undefined,
          sku: it.sku,
        })),
      })

      const labelUrl = parcel.label?.normal_printer?.[0] ?? null
      if (!labelUrl) {
        return reply.code(502).send({
          error: 'Sendcloud accepted parcel but returned no label URL',
          parcelId: parcel.id,
        })
      }

      const updated = await prisma.return.update({
        where: { id },
        data: {
          returnLabelUrl: labelUrl,
          returnLabelCarrier: 'SENDCLOUD',
          returnTrackingNumber: parcel.tracking_number ?? null,
          returnLabelGeneratedAt: new Date(),
          // R0.3 (B3) — persist parcel id so the Sendcloud webhook
          // can resolve incoming carrier-scan events back to this
          // Return when the customer ships the box.
          sendcloudParcelId: parcel.id != null ? String(parcel.id) : null,
        },
      })
      // Audit trail — fail-open writer so a logging failure never
      // wedges the operator workflow.
      try {
        await prisma.auditLog.create({
          data: {
            entityType: 'Return',
            entityId: id,
            action: 'generate-return-label',
            metadata: {
              carrier: 'SENDCLOUD',
              tracking: parcel.tracking_number,
              parcelId: parcel.id,
              dryRun: process.env.NEXUS_ENABLE_SENDCLOUD_REAL !== 'true',
            } as any,
          },
        })
      } catch (e) {
        log.warn({ err: e }, '[returns/generate-label] audit write failed')
      }
      return reply.send({
        success: true,
        return: updated,
        dryRun: process.env.NEXUS_ENABLE_SENDCLOUD_REAL !== 'true',
      })
    } catch (e: any) {
      if (e instanceof sendcloud.SendcloudError) {
        return reply.code(e.status).send({ error: e.message, code: e.code })
      }
      throw e
    }
  })())
}
