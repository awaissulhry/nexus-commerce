/**
 * MCP full control 07 O17 — carrier pickups, moved out of routes/fulfillment.routes.ts (CR.16) so the Carriers page and
 * Claude's `schedule-pickup` run the same code. Each answers as the route did (RouteAnswer), proven by
 * routes/pickup-parity.vitest.test.ts.
 *
 * A PickupSchedule row per request. A one-time SENDCLOUD pickup is asked of Sendcloud at once (the warehouse's sender
 * address, else the account's default; a dry run while NEXUS_ENABLE_SENDCLOUD_REAL is off); a failure stays on the row
 * as lastDispatchErr. Other carriers' pickups and recurring ones are recorded only.
 */

import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { AnswerReply, RouteAnswer, answered, type RouteLog } from '../../lib/route-answer.js'

export interface PickupBody {
  warehouseId?: string | null
  isRecurring?: boolean
  daysOfWeek?: number | null
  scheduledFor?: string | null
  windowStart?: string | null
  windowEnd?: string | null
  contactName?: string | null
  contactPhone?: string | null
  notes?: string | null
}

/** POST /fulfillment/carriers/:code/pickups. */
export async function schedulePickup(code: string, body: PickupBody, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const carrier = await prisma.carrier.findUnique({ where: { workspace_code: workspaceKey({ code: code as any }) } })
    if (!carrier) return reply.code(404).send({ error: 'Carrier not connected' })

    const isRecurring = !!body.isRecurring
    if (!isRecurring && !body.scheduledFor) {
      return reply.code(400).send({ error: 'scheduledFor required for one-time pickup' })
    }
    if (isRecurring && (!body.daysOfWeek || body.daysOfWeek <= 0)) {
      return reply.code(400).send({ error: 'daysOfWeek bitmap required for recurring pickup' })
    }

    const row = await prisma.pickupSchedule.create({
      data: {
        carrierId: carrier.id,
        warehouseId: body.warehouseId ?? null,
        isRecurring,
        daysOfWeek: body.daysOfWeek ?? null,
        scheduledFor: body.scheduledFor ? new Date(body.scheduledFor) : null,
        windowStart: body.windowStart ?? null,
        windowEnd: body.windowEnd ?? null,
        contactName: body.contactName ?? null,
        contactPhone: body.contactPhone ?? null,
        notes: body.notes ?? null,
        status: 'ACTIVE',
      },
    })

    // One-time SENDCLOUD pickups dispatch immediately so the operator sees confirmation. Failures persist as
    // lastDispatchErr.
    if (!isRecurring && code === 'SENDCLOUD') {
      try {
        const sendcloud = await import('../sendcloud/index.js')
        const creds = await sendcloud.resolveCredentials()
        let senderAddressId: number | null = null
        if (body.warehouseId) {
          const wh = await prisma.warehouse.findUnique({
            where: { id: body.warehouseId },
            select: { sendcloudSenderId: true },
          })
          senderAddressId = wh?.sendcloudSenderId ?? null
        }
        if (!senderAddressId) {
          const senders = await sendcloud.listSenderAddresses(creds)
          senderAddressId = senders.find((s) => s.isDefault)?.id ?? senders[0]?.id ?? null
        }
        if (!senderAddressId) {
          throw new Error('No Sendcloud sender address available')
        }
        const result = await sendcloud.requestPickup(creds, {
          senderAddressId,
          pickupDate: body.scheduledFor!.slice(0, 10),
          notes: body.notes ?? undefined,
        })
        if (result.ok === true) {
          await prisma.pickupSchedule.update({
            where: { id: row.id },
            data: { externalRef: result.externalRef, lastDispatchAt: new Date() },
          })
        } else {
          await prisma.pickupSchedule.update({
            where: { id: row.id },
            data: { lastDispatchErr: result.reason },
          })
        }
      } catch (err: any) {
        await prisma.pickupSchedule.update({
          where: { id: row.id },
          data: { lastDispatchErr: err?.message ?? String(err) },
        }).catch(() => { /* */ })
      }
    }

    const fresh = await prisma.pickupSchedule.findUnique({ where: { id: row.id } })
    return answered({ ok: true, pickup: fresh })
  } catch (error: any) {
    log.error({ err: error }, '[carriers/:code/pickups POST] failed')
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}

/** POST /fulfillment/carriers/:code/pickups/:id/cancel — in Nexus (the carrier is not told). */
export async function cancelPickup(id: string, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    await prisma.pickupSchedule.update({
      where: { id },
      data: { status: 'CANCELLED' },
    })
    return answered({ ok: true })
  } catch (error: any) {
    log.error({ err: error }, '[carriers/:code/pickups cancel] failed')
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}
