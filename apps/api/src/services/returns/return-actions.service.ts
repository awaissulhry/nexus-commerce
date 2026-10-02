/**
 * MCP full control 07 O12 — the return writes, moved out of routes/returns.routes.ts so the Returns page and Claude's
 * return tools (create-return, update-return, dispose-return-items) run the same code. Each answers as the route did
 * (RouteAnswer: the status and body the route sent), proven by routes/return-actions-parity.vitest.test.ts.
 *
 * One change of behaviour (07 O12, RED first): a return of an order Amazon ships — an FBA return, or an order the
 * fail-closed test of amazon-fulfilled-order.ts says Amazon fulfils — is NOT restocked: Amazon keeps those units, so
 * putting them into Nexus's own warehouse would overstate its stock (409 AMAZON_FULFILLED; nothing moves). The Returns
 * page never offered it (its actions are hidden for FBA returns); the route did not refuse it.
 *
 * Everything runs in the caller's business (the request's, or the tool's).
 */

import { workspaceKey } from '@nexus/database/workspace-context'
import prisma from '../../db.js'
import { applyStockMovement } from '../stock-movement.service.js'
import { auditLogService } from '../audit-log.service.js'
import { AMAZON_FULFILLED_CODE, amazonFulfilledRefusal, isAmazonFulfilledOrder } from '../fulfillment/amazon-fulfilled-order.js'
import { AnswerReply, RouteAnswer, answered, type RouteLog } from '../../lib/route-answer.js'

/** Who made the change, for the AuditLog (the route: the x-user-id header and the IP; a tool: its user). */
export interface ReturnWho {
  userId: string | null
  ip: string | null
}

function generateRmaNumber(): string {
  const d = new Date()
  const yymmdd = `${String(d.getFullYear()).slice(2)}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
  const rand = Math.random().toString(36).slice(2, 6).toUpperCase()
  return `RMA-${yymmdd}-${rand}`
}

export const RETURN_TYPES = ['STANDARD', 'WARRANTY', 'DEFECT'] as const
export const CONDITION_GRADES = ['NEW', 'LIKE_NEW', 'GOOD', 'DAMAGED', 'UNUSABLE'] as const
export const DISPOSITIONS = ['SELLABLE', 'SECOND_QUALITY', 'REFURBISH', 'QUARANTINE', 'SCRAP'] as const
/** Grades whose units are never put back in stock (restock skips them; scrap-after-restock writes off the others). */
export const UNSELLABLE_GRADES = ['DAMAGED', 'UNUSABLE'] as const

export interface CreateReturnBody {
  orderId?: string
  channel: string
  marketplace?: string
  reason?: string
  isFbaReturn?: boolean
  returnType?: string // STANDARD | WARRANTY | DEFECT (RX.6b)
  items?: Array<{ orderItemId?: string; productId?: string; sku: string; quantity: number }>
}

/**
 * B7 — Idempotency. Operators on flaky mobile networks were double-tapping "Create" on the new-return modal and getting
 * two RMAs for the same physical return. Pattern: client sends an Idempotency-Key header (UUID); we look up
 * Return.idempotencyKey first; if found, return the existing row (HTTP 200) and skip the create. Otherwise create with
 * the key persisted, so a subsequent retry with the same key short-circuits. The return takes its order's currency
 * (2026-10-02: it was EUR whatever the order, so a GBP order's refund went out in EUR); EUR without an order.
 */
export async function createReturn(
  body: CreateReturnBody,
  idemKey: string | null,
  who: ReturnWho,
  log: RouteLog,
): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    if (!body.channel) return reply.code(400).send({ error: 'channel required' })
    const items = Array.isArray(body.items) ? body.items : []

    if (idemKey) {
      const existing = await prisma.return.findUnique({
        where: { workspace_idempotencyKey: workspaceKey({ idempotencyKey: idemKey }) },
        include: { items: true },
      })
      if (existing) {
        return reply
          .header('Idempotent-Replay', 'true')
          .send(existing)
      }
    }

    const orderCurrency = body.orderId
      ? (await prisma.order.findFirst({ where: { id: body.orderId }, select: { currencyCode: true } }))?.currencyCode ?? null
      : null
    const ret = await prisma.return.create({
      data: {
        orderId: body.orderId ?? null,
        channel: body.channel,
        marketplace: body.marketplace ?? null,
        rmaNumber: generateRmaNumber(),
        status: 'REQUESTED',
        reason: body.reason ?? null,
        isFbaReturn: !!body.isFbaReturn,
        // RX.6b — warranty/defect returns start a diagnosis track.
        returnType: body.returnType ?? 'STANDARD',
        warrantyStatus: body.returnType === 'WARRANTY' || body.returnType === 'DEFECT' ? 'PENDING_DIAGNOSIS' : null,
        defectReportedAt: body.returnType === 'WARRANTY' || body.returnType === 'DEFECT' ? new Date() : null,
        idempotencyKey: idemKey,
        ...(orderCurrency ? { currencyCode: orderCurrency } : {}),
        items: {
          create: items.map((it) => ({
            orderItemId: it.orderItemId ?? null,
            productId: it.productId ?? null,
            sku: it.sku,
            quantity: it.quantity,
          })),
        },
      },
      include: { items: true },
    })

    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: ret.id,
      action: 'create',
      after: {
        rmaNumber: ret.rmaNumber,
        channel: ret.channel,
        status: ret.status,
        itemCount: ret.items.length,
      },
      metadata: idemKey ? { idempotencyKey: idemKey } : undefined,
    })

    return answered(ret)
  } catch (error: any) {
    // P2002 = unique-constraint violation on idempotencyKey, which means a concurrent retry won the race. Treat as
    // idempotent hit: re-look-up and return the existing row.
    if (error?.code === 'P2002') {
      if (idemKey) {
        const existing = await prisma.return.findUnique({
          where: { workspace_idempotencyKey: workspaceKey({ idempotencyKey: idemKey }) },
          include: { items: true },
        })
        if (existing) {
          return reply
            .header('Idempotent-Replay', 'race')
            .send(existing)
        }
      }
    }
    log.error({ err: error }, '[POST /fulfillment/returns] failed')
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}

/**
 * B2 — Receive emits no stock change (the units aren't in our inventory yet — they're customer property until
 * inspection + restock decides their fate); it logs the transition + receivedAt. F1.3 — also records a per-item
 * RETURN_RECEIVED StockMovement (change=0, audit-only) so the movement ledger shows when the units arrived. A missing
 * return throws (the route answered Fastify's 500 for it, and still does).
 */
export async function receiveReturn(id: string, body: { warehouseId?: string }, who: ReturnWho, log: RouteLog): Promise<RouteAnswer> {
  const before = await prisma.return.findUnique({
    where: { id },
    select: { status: true },
  })
  const retDetail = await prisma.return.findUnique({
    where: { id },
    include: { items: { select: { id: true, productId: true, sku: true, quantity: true } } },
  })

  const updated = await prisma.return.update({
    where: { id },
    data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } },
  })

  // F1.3 — RETURN_RECEIVED audit-only movements (change=0) per item with productId, at the receiving warehouse's
  // StockLocation. Failures don't roll back the receive (best-effort audit, the L.11 inbound pattern).
  if (retDetail?.items?.length) {
    try {
      const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id
      const stockLocation = warehouseId
        ? await prisma.stockLocation.findFirst({ where: { warehouseId }, select: { id: true } })
        : null

      if (stockLocation) {
        for (const it of retDetail.items) {
          if (!it.productId) continue
          const sl = await prisma.stockLevel.findFirst({
            where: { productId: it.productId, locationId: stockLocation.id },
            select: { quantity: true },
          })
          const balance = sl?.quantity ?? 0
          await prisma.stockMovement.create({
            data: {
              productId: it.productId,
              locationId: stockLocation.id,
              change: 0,
              balanceAfter: balance,
              quantityBefore: balance,
              reason: 'RETURN_RECEIVED',
              referenceType: 'Return',
              referenceId: id,
              returnId: id,
              notes: `Return ${retDetail.rmaNumber ?? id.slice(0, 8)} arrived at warehouse — awaiting inspection`,
              actor: 'return-receive',
            },
          })
        }
      }
    } catch (err) {
      log.warn({ err }, '[returns/:id/receive] RETURN_RECEIVED audit-row write failed')
    }
  }

  void auditLogService.write({
    ...who,
    entityType: 'Return',
    entityId: id,
    action: 'receive',
    before: { status: before?.status ?? null },
    after: { status: updated.status, receivedAt: updated.receivedAt, itemsTouched: retDetail?.items.length ?? 0 },
  })
  return answered(updated)
}

export interface InspectBody {
  items: Array<{ itemId: string; conditionGrade: string; notes?: string; disposition?: string; scrapReason?: string }>
  overallCondition?: string
}

/**
 * R3.2 — per-item grade and disposition + scrapReason. Auto-derives the disposition from the grade when it is omitted
 * (NEW/LIKE_NEW/GOOD → SELLABLE; DAMAGED/UNUSABLE → SCRAP).
 */
export async function inspectReturn(id: string, body: InspectBody, who: ReturnWho): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const VALID_DISPOSITIONS = new Set<string>(DISPOSITIONS)
    const inferDisposition = (grade: string): string => {
      if (grade === 'NEW' || grade === 'LIKE_NEW' || grade === 'GOOD') return 'SELLABLE'
      return 'SCRAP'
    }
    for (const it of body.items ?? []) {
      const disposition = it.disposition && VALID_DISPOSITIONS.has(it.disposition)
        ? it.disposition
        : inferDisposition(it.conditionGrade)
      await prisma.returnItem.update({
        where: { id: it.itemId },
        data: {
          conditionGrade: it.conditionGrade as any,
          notes: it.notes ?? null,
          disposition,
          scrapReason: disposition === 'SCRAP' ? (it.scrapReason ?? null) : null,
        },
      })
    }
    const updated = await prisma.return.update({
      where: { id },
      data: {
        status: 'INSPECTING',
        conditionGrade: (body.overallCondition as any) ?? null,
        inspectedAt: new Date(),
        version: { increment: 1 },
      },
      include: { items: true },
    })
    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: id,
      action: 'inspect',
      after: {
        status: updated.status,
        overallCondition: updated.conditionGrade,
        itemGrades: (body.items ?? []).map((it) => ({
          itemId: it.itemId,
          grade: it.conditionGrade,
          disposition: it.disposition ?? inferDisposition(it.conditionGrade),
        })),
      },
    })
    return answered(updated)
  } catch (error: any) {
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}

/** The refusal of a return whose units Amazon keeps (07 O12), or null. Fail closed: an Amazon return without its order is Amazon's. */
export async function amazonKeepsReturn(ret: { isFbaReturn: boolean; orderId: string | null; channel: string }): Promise<{ code: typeof AMAZON_FULFILLED_CODE; error: string } | null> {
  const refusal = { code: AMAZON_FULFILLED_CODE, error: 'Amazon keeps the units of a return of an order it ships (FBA or Multi-Channel Fulfilment): Nexus does not put them into its own stock.' }
  if (ret.isFbaReturn) return refusal
  const order = ret.orderId ? await prisma.order.findFirst({ where: { id: ret.orderId }, select: { id: true, channel: true, fulfillmentMethod: true } }) : null
  if (order) return (await amazonFulfilledRefusal(prisma, order)) ? refusal : null
  return isAmazonFulfilledOrder({ channel: ret.channel, fulfillmentMethod: null }) ? refusal : null
}

/**
 * Restock: each item graded NEW/LIKE_NEW/GOOD (or not graded) goes back into stock — to the shared stock it came from
 * (shared stock step 4), else to the warehouse named or the default one; DAMAGED/UNUSABLE items and items with no
 * product are skipped. 07 O12: refused for a return Amazon keeps (see the file header).
 */
export async function restockReturn(id: string, body: { warehouseId?: string }, who: ReturnWho, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const ret = await prisma.return.findUnique({ where: { id }, include: { items: true } })
    if (!ret) return reply.code(404).send({ error: 'Return not found' })
    const amazon = await amazonKeepsReturn(ret)
    if (amazon) return reply.code(409).send(amazon)

    const warehouseId = body.warehouseId ?? (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id

    const restocked: Array<{ sku: string; productId: string; qty: number; grade: string | null; to?: 'shared-stock' }> = []
    const skipped: Array<{ sku: string; reason: string }> = []
    const { putBackForOrder } = await import('../stock-pool/order-routing.js')
    const poolRouteOf = new Map<string, string>()
    for (const item of ret.items) {
      if (!item.productId) {
        skipped.push({ sku: item.sku, reason: 'no-productId' })
        continue
      }
      // Only restock items graded NEW/LIKE_NEW/GOOD; DAMAGED and UNUSABLE go to write-off.
      const grade = item.conditionGrade
      if (grade === 'DAMAGED' || grade === 'UNUSABLE') {
        skipped.push({ sku: item.sku, reason: `grade-${grade}` })
        continue
      }
      // Shared stock step 4 — a unit its order took from a pool goes back to the pool (door 5: to the lent warehouse
      // the order took the most from; once per return; never more than the order took). Decided once per product,
      // for all of the return's restockable items of that product together.
      if (ret.orderId) {
        let route = poolRouteOf.get(item.productId)
        if (!route) {
          const quantity = ret.items
            .filter((other) => other.productId === item.productId && other.conditionGrade !== 'DAMAGED' && other.conditionGrade !== 'UNUSABLE')
            .reduce((sum, other) => sum + other.quantity, 0)
          const pooled = await putBackForOrder({
            productId: item.productId, quantity, orderId: ret.orderId, putBackRef: ret.id,
            reason: 'RETURN_RESTOCKED', actor: 'return-restock',
          })
          route = pooled.via === 'none' ? `shared-stock: ${pooled.refusal.code}` : pooled.via
          poolRouteOf.set(item.productId, route)
        }
        if (route === 'pool') {
          restocked.push({ sku: item.sku, productId: item.productId, qty: item.quantity, grade, to: 'shared-stock' })
          continue
        }
        if (route !== 'own') {
          skipped.push({ sku: item.sku, reason: route })
          continue
        }
      }
      await applyStockMovement({
        productId: item.productId,
        warehouseId,
        change: item.quantity,
        reason: 'RETURN_RESTOCKED',
        referenceType: 'Return',
        referenceId: ret.id,
        actor: 'return-restock',
      })
      restocked.push({ sku: item.sku, productId: item.productId, qty: item.quantity, grade })
    }
    const updated = await prisma.return.update({
      where: { id },
      data: { status: 'RESTOCKED', restockedAt: new Date(), version: { increment: 1 } },
    })
    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: id,
      action: 'restock',
      after: {
        status: updated.status,
        warehouseId,
        restockedItems: restocked,
        skippedItems: skipped,
      },
    })
    return answered(updated)
  } catch (error: any) {
    log.error({ err: error }, '[returns/:id/restock] failed')
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}

/**
 * B1 — Scrap. The common path (REQUESTED/INSPECTING → SCRAPPED) moves no stock: the items never entered it. When the
 * return was already RESTOCKED, one WRITE_OFF movement per restockable item removes the units again.
 */
export async function scrapReturn(id: string, who: ReturnWho, log: RouteLog): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const ret = await prisma.return.findUnique({
      where: { id },
      include: { items: true },
    })
    if (!ret) return reply.code(404).send({ error: 'Return not found' })

    const writeOffs: Array<{ sku: string; qty: number }> = []
    if (ret.status === 'RESTOCKED') {
      const warehouseId =
        ret.restockWarehouseId ??
        (await prisma.warehouse.findFirst({ where: { isDefault: true } }))?.id
      for (const item of ret.items) {
        if (!item.productId) continue
        const grade = item.conditionGrade
        if (grade === 'DAMAGED' || grade === 'UNUSABLE') continue
        await applyStockMovement({
          productId: item.productId,
          warehouseId,
          change: -item.quantity,
          reason: 'WRITE_OFF',
          referenceType: 'Return',
          referenceId: ret.id,
          actor: 'return-scrap-after-restock',
          notes: 'Scrapped after prior restock — removing from stock',
        })
        writeOffs.push({ sku: item.sku, qty: item.quantity })
      }
    }

    const updated = await prisma.return.update({
      where: { id },
      data: { status: 'SCRAPPED', version: { increment: 1 } },
    })
    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: id,
      action: 'scrap',
      before: { status: ret.status },
      after: {
        status: updated.status,
        writeOffs,
        itemCount: ret.items.length,
      },
    })
    return answered(updated)
  } catch (error: any) {
    log.error({ err: error }, '[returns/:id/scrap] failed')
    return reply.code(500).send({ error: error?.message ?? String(error) })
  }
}

export interface WarrantyBody {
  warrantyStatus?: string | null
  warrantyResolution?: string | null
  manufacturerRef?: string | null
  defectReportedAt?: string | null
}
export const WARRANTY_STATUSES = ['PENDING_DIAGNOSIS', 'DIAGNOSED', 'REPAIR', 'REPLACE', 'REFUND', 'REJECTED'] as const
export const WARRANTY_RESOLUTIONS = ['REPAIR', 'REPLACE', 'REFUND', 'REJECTED'] as const

/**
 * RX.6b — the warranty track's fields (diagnosis → repair/replace/refund/reject). Records the decision only: a refund
 * still goes through the refund path.
 */
export async function updateReturnWarranty(id: string, body: WarrantyBody, who: ReturnWho): Promise<RouteAnswer> {
  const reply = new AnswerReply()
  try {
    const data: Record<string, unknown> = {}
    if ('warrantyStatus' in body) data.warrantyStatus = body.warrantyStatus
    if ('warrantyResolution' in body) data.warrantyResolution = body.warrantyResolution
    if ('manufacturerRef' in body) data.manufacturerRef = body.manufacturerRef
    if ('defectReportedAt' in body) {
      data.defectReportedAt = body.defectReportedAt ? new Date(body.defectReportedAt) : null
    }
    if (Object.keys(data).length === 0) {
      return reply.code(400).send({ error: 'No warranty fields to update' })
    }
    data.version = { increment: 1 }
    const updated = await prisma.return.update({ where: { id }, data })
    void auditLogService.write({
      ...who,
      entityType: 'Return',
      entityId: id,
      action: 'warranty-update',
      after: {
        warrantyStatus: updated.warrantyStatus,
        warrantyResolution: updated.warrantyResolution,
        manufacturerRef: updated.manufacturerRef,
      },
    })
    return answered(updated)
  } catch (error: any) {
    const msg = error instanceof Error ? error.message : String(error)
    if (msg.includes('Record to update not found')) return reply.code(404).send({ error: 'Return not found' })
    return reply.code(500).send({ error: msg })
  }
}

type Applied = { ok: true } | { ok: false; error: string }

/** Authorize a REQUESTED return (compare-and-swap on the status: one of two racing calls wins). */
export async function authorizeRequestedReturn(id: string): Promise<Applied> {
  const r = await prisma.return.updateMany({
    where: { id, status: 'REQUESTED' },
    data: { status: 'AUTHORIZED', version: { increment: 1 } },
  })
  return r.count > 0 ? { ok: true } : { ok: false, error: 'Not in REQUESTED state' }
}

/** Reject a REQUESTED return (compare-and-swap on the status). */
export async function rejectRequestedReturn(id: string): Promise<Applied> {
  const r = await prisma.return.updateMany({
    where: { id, status: 'REQUESTED' },
    data: { status: 'REJECTED', version: { increment: 1 } },
  })
  return r.count > 0 ? { ok: true } : { ok: false, error: 'Not in REQUESTED state' }
}

/** The list page's bulk receive: status only, no audit movements (compare-and-swap on the status). */
export async function bulkReceiveReturn(id: string): Promise<Applied> {
  const r = await prisma.return.updateMany({
    where: { id, status: { in: ['REQUESTED', 'AUTHORIZED', 'IN_TRANSIT'] } },
    data: { status: 'RECEIVED', receivedAt: new Date(), version: { increment: 1 } },
  })
  return r.count > 0 ? { ok: true } : { ok: false, error: 'Already received or not authorized' }
}
