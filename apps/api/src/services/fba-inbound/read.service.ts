/**
 * Step 4 Send to FBA (Owner 2026-10-07) — the reads: the plans the Matrix drawer shows (`readPlans`, `readPlan`), the
 * units already in open plans (the dialog's IN_OPEN_PLAN warning), and the two raw reads the retired wizard's GET routes
 * keep (`wizardPlanRows`, `wizardPlanRow`). Reads only: nothing here writes, calls Amazon or touches stock.
 *
 * A Send-to-FBA plan has `source` 'matrix' | 'claude'. Older wizard plans (`source` null) carry the old status words,
 * which do not fit `FbaPlanStatus`: they are never listed here and `readPlan` answers null for them.
 */
import type { Prisma } from '@prisma/client'
import {
  FBA_CLOSED_STATUSES, fbaPlanCan, isFbaPlanOpen, isFbaPlanStatus, isFbaPlanStep,
  type FbaAmazonProblem, type FbaChoiceRequest, type FbaMixedBox, type FbaPlanLineView, type FbaPlanOptions,
  type FbaPlanStepEntry, type FbaPlanView, type FbaShipmentBox, type FbaShipmentTracking, type FbaShipmentTransport,
  type FbaShipmentView,
} from '@nexus/shared/fba-send'
import prisma from '../../db.js'
import type { FbaPlansQuery } from './contract.js'

type Db = Prisma.TransactionClient | typeof prisma

/** The most plans one list answers (newest first). */
export const FBA_PLANS_LIST_LIMIT = 50

export const PLAN_VIEW_SELECT = {
  id: true, name: true, status: true, currentStep: true, source: true, planId: true, marketplaceId: true, sourceLocationId: true,
  readyToShipOn: true, mixedBox: true, options: true, choice: true, steps: true, lastError: true, nextCheckAt: true,
  createdAt: true, createdBy: true, confirmedAt: true, confirmedBy: true, cancelledAt: true,
  lines: {
    select: {
      productId: true, msku: true, quantity: true, cases: true, unitsPerCase: true, looseUnits: true, prepOwner: true,
      labelOwner: true, shippedQuantity: true, reservationId: true, createdAt: true, product: { select: { sku: true } },
    },
    orderBy: [{ createdAt: 'asc' as const }, { id: 'asc' as const }],
  },
} satisfies Prisma.FbaInboundPlanV2Select
export type PlanViewRow = Prisma.FbaInboundPlanV2GetPayload<{ select: typeof PLAN_VIEW_SELECT }>

const iso = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null)
const day = (value: Date | null | undefined): string | null => (value ? value.toISOString().slice(0, 10) : null)
const list = <T>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : [])
const object = <T>(value: unknown): T | null => (value && typeof value === 'object' && !Array.isArray(value) ? (value as T) : null)

/** Amazon's problems of the latest FAILED step entry (shown verbatim while the plan is FAILED). */
function failedProblems(steps: FbaPlanStepEntry[]): FbaAmazonProblem[] {
  for (let i = steps.length - 1; i >= 0; i--) if (steps[i].result === 'FAILED') return list<FbaAmazonProblem>(steps[i].problems)
  return []
}

/** Full views for these plan rows, in their order: one query each for locations, markets and shipments. */
export async function planViews(db: Db, rows: PlanViewRow[], now: Date = new Date()): Promise<FbaPlanView[]> {
  const known = rows.filter((row) => row.source !== null && isFbaPlanStatus(row.status))
  if (known.length === 0) return []
  const locationIds = [...new Set(known.map((row) => row.sourceLocationId).filter((id): id is string => !!id))]
  const marketplaceIds = [...new Set(known.map((row) => row.marketplaceId).filter((id): id is string => !!id))]
  const [locations, markets, shipments] = await Promise.all([
    db.stockLocation.findMany({ where: { id: { in: locationIds } }, select: { id: true, code: true, name: true } }),
    db.marketplace.findMany({ where: { channel: 'AMAZON', marketplaceId: { in: marketplaceIds } }, select: { code: true, marketplaceId: true } }),
    db.fBAShipment.findMany({
      where: { planRowId: { in: known.map((row) => row.id) } },
      select: {
        id: true, planRowId: true, amazonShipmentId: true, shipmentId: true, destinationFC: true, status: true, boxes: true,
        transport: true, tracking: true, shippedAt: true, shippedBy: true, createdAt: true, items: { select: { quantitySent: true } },
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    }),
  ])
  const locationOf = new Map(locations.map((location) => [location.id, location]))
  const marketOf = new Map(markets.map((market) => [market.marketplaceId, market.code]))
  const nowIso = now.toISOString()

  return known.map((row) => {
    const own = shipments.filter((shipment) => shipment.planRowId === row.id)
    const shipmentViews: FbaShipmentView[] = own.map((shipment) => ({
      id: shipment.id,
      amazonShipmentId: shipment.amazonShipmentId,
      shipmentConfirmationId: shipment.shipmentId,
      destinationFc: shipment.destinationFC,
      status: String(shipment.status),
      units: shipment.items.reduce((sum, item) => sum + item.quantitySent, 0),
      boxes: list<FbaShipmentBox>(shipment.boxes),
      transport: object<FbaShipmentTransport>(shipment.transport),
      tracking: object<FbaShipmentTracking>(shipment.tracking),
      shippedAt: iso(shipment.shippedAt),
      shippedBy: shipment.shippedBy,
    }))
    const steps = list<FbaPlanStepEntry>(row.steps)
    const options = object<FbaPlanOptions>(row.options)
    const location = row.sourceLocationId ? locationOf.get(row.sourceLocationId) : undefined
    const lines: FbaPlanLineView[] = row.lines.map((line) => ({
      productId: line.productId,
      sku: line.product.sku,
      msku: line.msku,
      quantity: line.quantity,
      cases: line.cases,
      unitsPerCase: line.unitsPerCase,
      looseUnits: line.looseUnits,
      prepOwner: line.prepOwner,
      labelOwner: line.labelOwner,
      shippedQuantity: line.shippedQuantity,
      held: line.reservationId !== null,
    }))
    const status = row.status as FbaPlanView['status']
    return {
      id: row.id,
      name: row.name ?? '',
      status,
      step: isFbaPlanStep(row.currentStep) ? row.currentStep : null,
      source: row.source === 'matrix' || row.source === 'claude' ? row.source : null,
      amazonPlanId: row.planId,
      market: row.marketplaceId ? marketOf.get(row.marketplaceId) ?? null : null,
      marketplaceId: row.marketplaceId,
      from: location ? { locationId: location.id, code: location.code, name: location.name } : null,
      readyToShipOn: day(row.readyToShipOn),
      mixedBox: object<FbaMixedBox>(row.mixedBox),
      skus: lines.length,
      units: lines.reduce((sum, line) => sum + line.quantity, 0),
      shippedUnits: lines.reduce((sum, line) => sum + line.shippedQuantity, 0),
      lines,
      steps,
      options,
      choice: object<FbaChoiceRequest>(row.choice),
      shipments: shipmentViews,
      problems: status === 'FAILED' ? failedProblems(steps) : [],
      message: status === 'FAILED' || status === 'HELD' ? row.lastError : null,
      nextCheckAt: iso(row.nextCheckAt),
      createdAt: row.createdAt.toISOString(),
      createdBy: row.createdBy,
      confirmedAt: iso(row.confirmedAt),
      confirmedBy: row.confirmedBy,
      cancelledAt: iso(row.cancelledAt),
      can: fbaPlanCan({ status, shippedShipments: own.filter((shipment) => shipment.shippedAt !== null).length, optionsExpireAt: options?.expiresAt ?? null, now: nowIso }),
    }
  })
}

/** One plan's view in the caller's database handle (a transaction sees its own writes). */
export async function planViewIn(db: Db, planId: string): Promise<FbaPlanView | null> {
  const row = await db.fbaInboundPlanV2.findUnique({ where: { id: planId }, select: PLAN_VIEW_SELECT })
  if (!row) return null
  return (await planViews(db, [row]))[0] ?? null
}

/** The products a plan view or a filter names: the product itself and, for a family root, its variations. */
async function familyOf(db: Db, productId: string): Promise<string[]> {
  const children = await db.product.findMany({ where: { parentId: productId }, select: { id: true } })
  return [productId, ...children.map((child) => child.id)]
}

/**
 * Send-to-FBA plans, newest first (at most FBA_PLANS_LIST_LIMIT). `productId` = a SKU or a family root (its variations
 * count); `open` = only open plans (not CLOSED / CANCELLED).
 */
export async function readPlans(query: FbaPlansQuery): Promise<FbaPlanView[]> {
  const where: Prisma.FbaInboundPlanV2WhereInput = { source: { not: null } }
  if (query.productId) where.lines = { some: { productId: { in: await familyOf(prisma, query.productId) } } }
  if (query.open) where.status = { notIn: [...FBA_CLOSED_STATUSES] }
  const rows = await prisma.fbaInboundPlanV2.findMany({ where, select: PLAN_VIEW_SELECT, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: FBA_PLANS_LIST_LIMIT })
  const views = await planViews(prisma, rows)
  return query.open ? views.filter((view) => isFbaPlanOpen(view.status)) : views
}

/** One Send-to-FBA plan with its lines, steps, options, choice and shipments; null when absent or an older wizard plan. */
export async function readPlan(planId: string): Promise<FbaPlanView | null> {
  if (typeof planId !== 'string' || planId.trim() === '') return null
  return planViewIn(prisma, planId)
}

/** Units of each product in OPEN Send-to-FBA plans, not shipped yet (Σ quantity − shippedQuantity). */
export async function openPlanUnits(db: Db, productIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (productIds.length === 0) return out
  const lines = await db.fbaInboundPlanLine.findMany({
    where: { productId: { in: [...productIds] }, plan: { source: { not: null }, status: { notIn: [...FBA_CLOSED_STATUSES] } } },
    select: { productId: true, quantity: true, shippedQuantity: true, plan: { select: { status: true } } },
  })
  for (const line of lines) {
    if (!isFbaPlanOpen(line.plan.status)) continue
    out.set(line.productId, (out.get(line.productId) ?? 0) + Math.max(0, line.quantity - line.shippedQuantity))
  }
  return out
}

/* ── the retired wizard's GET routes (routes/fba-inbound-v2.routes.ts): the raw rows, as they always answered ─────── */

/** GET /api/fba/inbound/v2 — every plan row (wizard and Send to FBA), newest first. */
export async function wizardPlanRows(query: { limit?: number; status?: string | null; inboundShipmentId?: string | null }) {
  const limit = Math.min(Math.max(Number.isFinite(query.limit) ? Number(query.limit) : 50, 1), 200)
  const where: Prisma.FbaInboundPlanV2WhereInput = {}
  if (query.status) where.status = query.status
  if (query.inboundShipmentId) where.inboundShipmentId = query.inboundShipmentId
  return prisma.fbaInboundPlanV2.findMany({ where, orderBy: { createdAt: 'desc' }, take: limit })
}

/** GET /api/fba/inbound/v2/:id — one plan row with its inbound shipment; null when absent. */
export async function wizardPlanRow(id: string) {
  return prisma.fbaInboundPlanV2.findUnique({ where: { id }, include: { inboundShipment: true } })
}
