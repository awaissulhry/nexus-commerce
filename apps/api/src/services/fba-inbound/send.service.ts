/**
 * Step 4 Send to FBA (Owner 2026-10-07) — the dialog's facts, "Create plan", the Owner's choice, cancel and "Try again".
 * Signatures and rules: `contract.ts` (Part C). Wire shapes, words and the box rule: `@nexus/shared/fba-send`.
 *
 * Owner decisions kept here:
 *  - Units are HELD at the From warehouse at "Create plan" (StockReservation FBA_SEND, HARD, 45 days) and released AT
 *    THE CLICK on cancel. A hold lowers `available`, so following FBM listings advertise the lower number at once
 *    (recascade after the commit, as the stock page's holds do).
 *  - Prep / label owner is asked once in the dialog when a SKU has it "not set" and remembered (`setFbaOwnersIfUnset`).
 *  - Confirming at Amazon is final: `confirmChoice` is the ONLY door to CONFIRMING, and only a person passes it
 *    (`who.userId`, recorded as `confirmedBy`). Claude's tools never call it.
 *  - The ship-from address is the From warehouse + the company's name and phone (address.ts); a gap refuses the plan.
 *
 * Nothing here calls Amazon: the job (Part B, through `dispatchFbaPlan`) does. Nexus never writes an FBA quantity: the
 * holds are at the From WAREHOUSE; the units leave it only at "Mark shipped" (ship.service.ts).
 * Every move of a plan publishes `fba.plan_changed` in its own transaction.
 */
import type { Prisma } from '@prisma/client'
import {
  FBA_SEND_COPY, FBA_SEND_HOLD, FBA_SEND_MAX_SKUS, FBA_STEP_STATUS, FBA_EVENT_MAX_PRODUCTS,
  MIXED_BOX_DEFAULT, effectiveOwners, fbaAmazonPlanName, fbaPlanCan, isFbaPlanStep, lengthCm, lineUnits, nextWorkingDay,
  sendProblems, unitWeightKg,
  type FbaChoiceRequest, type FbaCreateAnswer, type FbaCreateRequest, type FbaMixedBox, type FbaPlanOptions,
  type FbaPlanStatus, type FbaPlanStep, type FbaPlanStepEntry, type FbaPlanView, type FbaSendDraft, type FbaSendLine,
  type FbaSendLocation, type FbaSendMarket, type FbaSendOwners, type FbaSendSku,
} from '@nexus/shared/fba-send'
import { caseSplit, isCaseOwner } from '@nexus/shared/stock-cases'
import prisma from '../../db.js'
import { publishEvent } from '../../lib/events/publish.js'
import { logger } from '../../utils/logger.js'
import { auditLogService, type AuditWriteInput } from '../audit-log.service.js'
import { defaultStockLocation } from '../default-stock-location.js'
import { amazonAccountIdFor, amazonSkusInMarket } from '../listings/reported-sku.js'
import { lockProductStock } from '../stock-lock.js'
import { releaseReservationInTx, reserveStockInTx, StockLevelMissingError } from '../stock-level.service.js'
import { InsufficientStockError } from '../stock-movement.service.js'
import { sealedByLevel, setFbaOwnersIfUnset } from '../stock/stock-cases.service.js'
import { requireShipFromAddress, shipFromAddress, type WarehouseAddress } from './address.js'
import { openPlanUnits, planViewIn } from './read.service.js'
import { FbaSendError, type FbaActor, type FbaPerson, type FbaPlanSource, type FbaSendDraftQuery } from './contract.js'

type Tx = Prisma.TransactionClient

/** The plan's hold lifetime: FBA_SEND_HOLD.days. */
export const FBA_SEND_HOLD_TTL_MS = FBA_SEND_HOLD.days * 24 * 60 * 60 * 1000
const TX_OPTIONS = { isolationLevel: 'ReadCommitted' as const, maxWait: 5_000, timeout: 30_000 }

/* ── small helpers shared with ship.service.ts ────────────────────────────────────────────────── */

/** Today in Italy (YYYY-MM-DD): the day the dialog's checks use. */
export function romeToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

/** Run the job soon (Part B's `dispatchFbaPlan`, through the contract). A failure never undoes the person's click:
 *  the plan waits with `nextCheckAt` null and the resume cron picks it up. */
export async function dispatchSoon(planId: string): Promise<void> {
  try {
    const { dispatchFbaPlan } = await import('./contract.js')
    await dispatchFbaPlan(planId)
  } catch (error) {
    logger.warn('[fba-send] dispatch failed; the resume cron runs the plan', { planId, error: error instanceof Error ? error.message : String(error) })
  }
}

/** Follow the hold: listings that follow the warehouse advertise the new available number at once. */
export function recascadeSoon(productIds: readonly string[], planId: string, actor: string): void {
  if (productIds.length === 0) return
  void (async () => {
    const { recascadeProduct } = await import('../stock-movement.service.js')
    for (const productId of productIds) {
      try {
        await recascadeProduct(productId, { reason: 'MANUAL_ADJUSTMENT', referenceType: 'FbaInboundPlan', referenceId: planId, actor })
      } catch (error) {
        logger.warn('[fba-send] recascade after a hold failed (non-fatal)', { productId, planId, error: error instanceof Error ? error.message : String(error) })
      }
    }
  })()
}

/** `fba.plan_changed` inside the transaction that moved the plan. */
export async function publishPlanChanged(tx: Tx, planId: string, status: FbaPlanStatus, step: FbaPlanStep | null, productIds: readonly string[]): Promise<void> {
  await publishEvent(tx, 'fba.plan_changed', { planId, status, step, productIds: [...new Set(productIds)].slice(0, FBA_EVENT_MAX_PRODUCTS) })
}

/** Lock the plan row for this transaction (cancel, choice, retry and Shipped serialize on it), then read it. */
export async function lockPlan(tx: Tx, planId: string) {
  await tx.$queryRaw`SELECT id FROM "FbaInboundPlanV2" WHERE id = ${planId} FOR UPDATE`
  const row = await tx.fbaInboundPlanV2.findUnique({
    where: { id: planId },
    select: {
      id: true, name: true, status: true, currentStep: true, source: true, planId: true, steps: true, options: true,
      nextCheckAt: true, sourceLocationId: true,
      lines: { select: { id: true, productId: true, msku: true, quantity: true, cases: true, unitsPerCase: true, shippedQuantity: true, reservationId: true } },
    },
  })
  if (!row || row.source === null) throw new FbaSendError('NOT_FOUND', 'FBA plan not found')
  return row
}

const words = (status: string) => (FBA_SEND_COPY.status as Record<string, string>)[status] ?? status

/* ── readSendDraft ────────────────────────────────────────────────────────────────────────────── */

const PRODUCT_SELECT = {
  id: true, sku: true, name: true, isParent: true, parentId: true,
  weightValue: true, weightUnit: true, dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
} satisfies Prisma.ProductSelect
type DraftProduct = Prisma.ProductGetPayload<{ select: typeof PRODUCT_SELECT }>

/** Ticked rows → the SKUs that are sent: a parent is never sent, it stands for its variations (by SKU). */
async function sendableProducts(productIds: readonly string[]): Promise<DraftProduct[]> {
  const [found, children] = await Promise.all([
    prisma.product.findMany({ where: { id: { in: [...productIds] }, deletedAt: null }, select: PRODUCT_SELECT }),
    prisma.product.findMany({ where: { parentId: { in: [...productIds] }, deletedAt: null }, select: PRODUCT_SELECT, orderBy: [{ sku: 'asc' }, { id: 'asc' }] }),
  ])
  const byId = new Map(found.map((product) => [product.id, product]))
  const out: DraftProduct[] = []
  const seen = new Set<string>()
  const push = (product: DraftProduct) => { if (!seen.has(product.id)) { seen.add(product.id); out.push(product) } }
  for (const id of productIds) {
    const own = children.filter((child) => child.parentId === id)
    if (own.length > 0) { own.forEach(push); continue }
    const product = byId.get(id)
    if (product && !product.isParent) push(product)
  }
  return out
}

interface DraftFacts {
  draft: FbaSendDraft
  /** The From warehouse's address (null without a From or a Warehouse row). */
  warehouse: WarehouseAddress | null
}

async function draftFacts(query: FbaSendDraftQuery): Promise<DraftFacts> {
  const asked = [...new Set((Array.isArray(query.productIds) ? query.productIds : []).filter((id): id is string => typeof id === 'string').map((id) => id.trim()).filter(Boolean))]
  if (asked.length === 0) throw new FbaSendError('NOT_FOUND', 'Choose the SKUs to send')
  const products = await sendableProducts(asked)
  if (products.length === 0) throw new FbaSendError('NOT_FOUND', 'Product not found')
  if (products.length > FBA_SEND_MAX_SKUS) {
    throw new FbaSendError('REFUSED', FBA_SEND_COPY.problem.tooManySkus, [{ code: 'TOO_MANY_SKUS', message: FBA_SEND_COPY.problem.tooManySkus, productId: null, blocking: true }])
  }

  // From: the business's active warehouses; the asked code, else the default warehouse.
  const rows = await prisma.stockLocation.findMany({
    where: { type: 'WAREHOUSE', isActive: true },
    select: { id: true, code: true, name: true, warehouse: { select: { addressLine1: true, addressLine2: true, city: true, postalCode: true, country: true } } },
    orderBy: [{ code: 'asc' }, { id: 'asc' }],
  })
  const defaultId = await defaultStockLocation().then((location) => location?.id ?? null, () => null)
  const locations: FbaSendLocation[] = rows.map((row) => ({
    id: row.id, code: row.code, name: row.name, town: row.warehouse?.city ?? null, country: row.warehouse?.country ?? null, isDefault: row.id === defaultId,
  }))
  const askedFrom = typeof query.from === 'string' ? query.from.trim() : ''
  const from = askedFrom ? locations.find((location) => location.code === askedFrom) ?? null : locations.find((location) => location.id === defaultId) ?? null
  const fromRow = from ? rows.find((row) => row.id === from.id) : undefined
  const warehouse: WarehouseAddress | null = fromRow?.warehouse ?? null

  // To: the Amazon markets of the business's Amazon account.
  const accountId = await amazonAccountIdFor()
  const marketRows = accountId
    ? await prisma.marketplace.findMany({ where: { channel: 'AMAZON', isActive: true, marketplaceId: { not: null } }, select: { code: true, marketplaceId: true, name: true }, orderBy: { code: 'asc' } })
    : []
  const markets: FbaSendMarket[] = marketRows.map((row) => ({ code: row.code, marketplaceId: row.marketplaceId!, name: row.name, accountId: accountId! }))
  const askedMarket = typeof query.market === 'string' ? query.market.trim().toUpperCase() : ''
  const fromCountry = (from?.country ?? '').trim().toUpperCase()
  const market = askedMarket || (markets.some((m) => m.code === fromCountry) ? fromCountry : 'IT')

  const today = romeToday()
  const { check } = await shipFromAddress(warehouse)

  // Per SKU at From: units, holds, sealed cases, the case pack, unit weight and size, owners, the Amazon SKU, open plans.
  const ids = products.map((product) => product.id)
  const [levels, packs, inPlans, amazon] = await Promise.all([
    prisma.stockLevel.findMany({ where: { locationId: from?.id ?? '', productId: { in: from ? ids : [] }, variationId: null }, select: { id: true, productId: true, quantity: true, reserved: true, available: true } }),
    prisma.productPackage.findMany({
      where: { productId: { in: ids } },
      select: { productId: true, unitsPerCase: true, caseLengthCm: true, caseWidthCm: true, caseHeightCm: true, caseWeightKg: true, fbaPrepOwner: true, fbaLabelOwner: true },
    }),
    openPlanUnits(prisma, ids),
    markets.some((m) => m.code === market)
      ? amazonSkusInMarket(prisma as unknown as Tx, { accountId, marketplace: market, products: products.map((product) => ({ id: product.id, sku: product.sku })) })
      : Promise.resolve(new Map()),
  ])
  const sealed = await sealedByLevel(prisma, levels)
  const levelOf = new Map(levels.map((level) => [level.productId, level]))
  const packOf = new Map(packs.map((pack) => [pack.productId, pack]))

  const skus: FbaSendSku[] = products.map((product) => {
    const level = levelOf.get(product.id)
    const pack = packOf.get(product.id)
    const unitsPerCase = pack?.unitsPerCase ?? null
    const split = caseSplit({ quantity: level?.quantity ?? 0, reserved: level?.reserved ?? 0, cases: level ? sealed.get(level.id) ?? 0 : 0, unitsPerCase })
    const caseDims = pack && pack.caseLengthCm !== null && pack.caseWidthCm !== null && pack.caseHeightCm !== null && pack.caseWeightKg !== null
      ? { lengthCm: Number(pack.caseLengthCm), widthCm: Number(pack.caseWidthCm), heightCm: Number(pack.caseHeightCm), weightKg: Number(pack.caseWeightKg) }
      : null
    const sides = [product.dimLength, product.dimWidth, product.dimHeight].map((value) => lengthCm(value?.toString() ?? null, product.dimUnit))
    const listing = (amazon as Map<string, { ok: boolean; sku?: string }>).get(product.id)
    return {
      productId: product.id,
      sku: product.sku,
      name: product.name,
      msku: listing && listing.ok ? listing.sku ?? null : null,
      unitsPerCase,
      case: caseDims,
      unitWeightKg: unitWeightKg(product.weightValue?.toString() ?? null, product.weightUnit),
      unit: sides.every((side): side is number => side !== null) ? { lengthCm: sides[0], widthCm: sides[1], heightCm: sides[2] } : null,
      onHand: level?.quantity ?? 0,
      free: Math.max(0, level?.available ?? 0),
      freeSealed: split.freeSealed,
      freeLoose: split.freeLoose,
      prepOwner: pack && isCaseOwner(pack.fbaPrepOwner) ? pack.fbaPrepOwner : null,
      labelOwner: pack && isCaseOwner(pack.fbaLabelOwner) ? pack.fbaLabelOwner : null,
      openPlanUnits: inPlans.get(product.id) ?? 0,
    }
  })

  return {
    draft: { from, locations, market, markets, readyToShipOn: nextWorkingDay(today), today, address: check, mixedBox: { ...MIXED_BOX_DEFAULT }, skus },
    warehouse,
  }
}

/** The dialog's facts for the ticked SKUs (contract.ts). Reads only. */
export async function readSendDraft(query: FbaSendDraftQuery): Promise<FbaSendDraft> {
  return (await draftFacts(query)).draft
}

/* ── createSendPlan ───────────────────────────────────────────────────────────────────────────── */

const whole = (value: unknown): value is number => typeof value === 'number' && Number.isInteger(value) && value >= 0

/** The request's shape (the route parsed JSON; Claude's tool built it). Malformed → REFUSED, nothing read. */
function parseCreate(req: FbaCreateRequest): { lines: FbaSendLine[]; mixedBox: FbaMixedBox | null; owners: FbaSendOwners | null } {
  const bad = (message: string) => new FbaSendError('REFUSED', message)
  if (!req || typeof req !== 'object') throw bad('Send the plan: from, market, readyToShipOn and lines')
  if (typeof req.from !== 'string' || !req.from.trim()) throw bad('`from` must name one of your warehouses (its code)')
  if (typeof req.market !== 'string' || !req.market.trim()) throw bad('`market` must name an Amazon market, e.g. IT')
  if (typeof req.readyToShipOn !== 'string') throw bad('`readyToShipOn` must be a day, YYYY-MM-DD')
  if (!Array.isArray(req.lines) || req.lines.length === 0) throw bad(FBA_SEND_COPY.problem.noUnits)
  if (req.lines.length > FBA_SEND_MAX_SKUS) throw new FbaSendError('REFUSED', FBA_SEND_COPY.problem.tooManySkus, [{ code: 'TOO_MANY_SKUS', message: FBA_SEND_COPY.problem.tooManySkus, productId: null, blocking: true }])
  const lines: FbaSendLine[] = req.lines.map((line) => {
    if (!line || typeof line !== 'object' || typeof line.productId !== 'string' || !line.productId.trim()) throw bad('Every line names a productId')
    return { productId: line.productId.trim(), cases: line.cases ?? 0, looseUnits: line.looseUnits ?? 0 }
  })
  let mixedBox: FbaMixedBox | null = null
  if (req.mixedBox != null) {
    const box = req.mixedBox
    const keys = ['lengthCm', 'widthCm', 'heightCm', 'emptyKg', 'maxKg'] as const
    if (typeof box !== 'object' || keys.some((key) => typeof box[key] !== 'number')) throw bad('`mixedBox` needs lengthCm, widthCm, heightCm, emptyKg and maxKg as numbers')
    mixedBox = { lengthCm: box.lengthCm, widthCm: box.widthCm, heightCm: box.heightCm, emptyKg: box.emptyKg, maxKg: box.maxKg }
  }
  let owners: FbaSendOwners | null = null
  if (req.owners != null) {
    if (typeof req.owners !== 'object' || !isCaseOwner(req.owners.prepOwner) || !isCaseOwner(req.owners.labelOwner)) throw bad('Prep by and Labels by must be AMAZON or SELLER')
    owners = { prepOwner: req.owners.prepOwner, labelOwner: req.owners.labelOwner }
  }
  return { lines, mixedBox, owners }
}

/** "Create plan" (contract.ts): re-checks everything with the shared rule, then ONE transaction (owners, plan, lines,
 *  holds, event), then the job is dispatched. Never calls Amazon. */
export async function createSendPlan(req: FbaCreateRequest, who: FbaActor, source: FbaPlanSource): Promise<FbaCreateAnswer> {
  if (source !== 'matrix' && source !== 'claude') throw new FbaSendError('REFUSED', 'Unknown plan source')
  const parsed = parseCreate(req)
  const { draft, warehouse } = await draftFacts({ productIds: parsed.lines.map((line) => line.productId), from: req.from, market: req.market })
  const choice = { lines: parsed.lines, readyToShipOn: req.readyToShipOn, mixedBox: parsed.mixedBox, owners: parsed.owners }
  const blocking = sendProblems(draft, choice).filter((problem) => problem.blocking)
  if (blocking.length > 0) throw new FbaSendError('REFUSED', blocking[0].message, blocking)

  let sourceAddress
  try {
    sourceAddress = await requireShipFromAddress(warehouse)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new FbaSendError('REFUSED', message, [{ code: 'NO_ADDRESS', message, productId: null, blocking: true }])
  }

  const from = draft.from!
  const market = draft.markets.find((m) => m.code === draft.market)!
  const mixedBox = parsed.mixedBox ?? draft.mixedBox
  const skuOf = new Map(draft.skus.map((sku) => [sku.productId, sku]))
  const sending = parsed.lines
    .filter((line) => line.cases > 0 || line.looseUnits > 0)
    .map((line) => {
      const sku = skuOf.get(line.productId)!
      return { line, sku, owners: effectiveOwners(sku, parsed.owners)!, quantity: lineUnits(line, sku.unitsPerCase) }
    })
  const productIds = sending.map((s) => s.sku.productId)
  const ownersToSave = parsed.owners ? sending.filter((s) => s.sku.prepOwner === null || s.sku.labelOwner === null).map((s) => s.sku.productId) : []

  let outcome: { planId: string; owners: Awaited<ReturnType<typeof setFbaOwnersIfUnset>> }
  try {
    outcome = await prisma.$transaction(async (tx) => {
      await lockProductStock(tx, productIds)
      const owners = parsed.owners && ownersToSave.length > 0
        ? await setFbaOwnersIfUnset(tx, { productIds: ownersToSave, prepOwner: parsed.owners.prepOwner, labelOwner: parsed.owners.labelOwner, actor: who.actor })
        : []
      const plan = await tx.fbaInboundPlanV2.create({
        data: {
          status: 'QUEUED', currentStep: 'CREATE', source, createdBy: who.actor,
          channelConnectionId: market.accountId, marketplaceId: market.marketplaceId, sourceLocationId: from.id,
          sourceAddress: sourceAddress as unknown as Prisma.InputJsonValue, readyToShipOn: new Date(`${req.readyToShipOn}T00:00:00.000Z`),
          mixedBox: mixedBox as unknown as Prisma.InputJsonValue, steps: [] as unknown as Prisma.InputJsonValue,
        },
        select: { id: true },
      })
      // The plan's name at Amazon (FROZEN: a crashed create finds its plan again by it). Needs the row id.
      await tx.fbaInboundPlanV2.update({ where: { id: plan.id }, data: { name: fbaAmazonPlanName(draft.market, draft.today, plan.id) } })
      for (const s of sending) {
        const hold = await reserveStockInTx(tx, {
          productId: s.sku.productId, locationId: from.id, quantity: s.quantity, reason: 'FBA_SEND', kind: 'HARD',
          ttlMs: FBA_SEND_HOLD_TTL_MS, actor: who.actor,
        })
        await tx.fbaInboundPlanLine.create({
          data: {
            planRowId: plan.id, productId: s.sku.productId, msku: s.sku.msku!, quantity: s.quantity, cases: s.line.cases,
            unitsPerCase: s.sku.unitsPerCase, looseUnits: s.line.looseUnits, prepOwner: s.owners.prepOwner, labelOwner: s.owners.labelOwner,
            reservationId: hold.id,
          },
        })
      }
      await publishPlanChanged(tx, plan.id, 'QUEUED', 'CREATE', productIds)
      return { planId: plan.id, owners }
    }, TX_OPTIONS)
  } catch (error) {
    if (error instanceof InsufficientStockError || error instanceof StockLevelMissingError) {
      const sku = skuOf.get(error.productId)
      const asked = sending.find((s) => s.sku.productId === error.productId)?.quantity ?? 0
      const free = error instanceof InsufficientStockError ? Math.max(0, error.have) : 0
      const message = FBA_SEND_COPY.problem.overFree(sku?.sku ?? error.productId, asked, free, from.code)
      throw new FbaSendError('REFUSED', message, [{ code: 'OVER_FREE', message, productId: error.productId, blocking: true }])
    }
    throw error
  }

  if (outcome.owners.length > 0) {
    const audit: AuditWriteInput[] = outcome.owners.map((changed) => ({
      userId: who.userId, entityType: 'ProductPackage', entityId: changed.productId, action: 'update',
      before: changed.before, after: changed.after, metadata: { actor: who.actor, via: 'fba-send', planId: outcome.planId },
    }))
    await auditLogService.writeMany(audit)
  }
  recascadeSoon(productIds, outcome.planId, who.actor)
  await dispatchSoon(outcome.planId)
  return { planId: outcome.planId }
}

/* ── confirmChoice ────────────────────────────────────────────────────────────────────────────── */

/** The Owner's pick checked against Amazon's offer: every shipment of the option once, its transport and window. */
function choiceProblem(choice: FbaChoiceRequest, options: FbaPlanOptions | null): string | null {
  if (!choice || typeof choice !== 'object' || typeof choice.placementOptionId !== 'string' || !Array.isArray(choice.shipments)) {
    return 'Choose one placement option and a transport for each of its shipments'
  }
  const placement = options?.placements?.find((p) => p.placementOptionId === choice.placementOptionId)
  if (!placement) return 'This placement option is not one Amazon offered for the plan'
  const named = choice.shipments.map((s) => s?.shipmentId)
  if (new Set(named).size !== named.length || named.length !== placement.shipments.length || placement.shipments.some((s) => !named.includes(s.shipmentId))) {
    return 'Choose a transport for every shipment of this placement option, once each'
  }
  for (const pick of choice.shipments) {
    const shipment = placement.shipments.find((s) => s.shipmentId === pick.shipmentId)!
    const transport = shipment.transport.find((t) => t.transportationOptionId === pick.transportationOptionId)
    if (!transport) return `Shipment ${pick.shipmentId}: this transport is not one Amazon offered`
    const window = pick.deliveryWindowOptionId ?? null
    if (window !== null && !shipment.deliveryWindows.some((w) => w.deliveryWindowOptionId === window)) {
      return `Shipment ${pick.shipmentId}: this delivery window is not one Amazon offered`
    }
    if (window === null && transport.shippingSolution !== 'AMAZON_PARTNERED_CARRIER' && shipment.deliveryWindows.length > 0) {
      return `Shipment ${pick.shipmentId}: choose a delivery window for your own carrier`
    }
  }
  return null
}

function optionsExpired(choice: FbaChoiceRequest, options: FbaPlanOptions | null, now: Date): boolean {
  const placement = options?.placements?.find((p) => p.placementOptionId === choice.placementOptionId)
  const dates = [options?.expiresAt ?? null, placement?.expiresAt ?? null].filter((d): d is string => typeof d === 'string')
  return placement?.status === 'EXPIRED' || dates.some((d) => Date.parse(d) <= now.getTime())
}

/** The Owner's pick → CONFIRMING (contract.ts). The one door to Amazon's final confirms: a person's click only. */
export async function confirmChoice(planId: string, choice: FbaChoiceRequest, who: FbaPerson): Promise<FbaPlanView> {
  if (!who || typeof who.userId !== 'string' || who.userId.trim() === '') {
    throw new FbaSendError('NEEDS_PERSON', 'Confirming with Amazon is final: a person confirms it in Nexus.')
  }
  const view = await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, planId)
    if (plan.status !== 'WAITING_FOR_CHOICE') {
      throw new FbaSendError('WRONG_STATE', `The plan is "${words(plan.status)}": there is nothing to choose now.`)
    }
    const options = (plan.options && typeof plan.options === 'object' ? plan.options : null) as unknown as FbaPlanOptions | null
    const problem = choiceProblem(choice, options)
    if (problem) throw new FbaSendError('OPTION_UNKNOWN', problem)
    const now = new Date()
    if (optionsExpired(choice, options, now)) throw new FbaSendError('OPTIONS_EXPIRED', FBA_SEND_COPY.optionsExpired)
    const stored: FbaChoiceRequest = {
      placementOptionId: choice.placementOptionId,
      shipments: choice.shipments.map((s) => ({ shipmentId: s.shipmentId, transportationOptionId: s.transportationOptionId, deliveryWindowOptionId: s.deliveryWindowOptionId ?? null })),
    }
    const moved = await tx.fbaInboundPlanV2.updateMany({
      where: { id: planId, status: 'WAITING_FOR_CHOICE' },
      data: {
        status: 'CONFIRMING', currentStep: 'CONFIRM', choice: stored as unknown as Prisma.InputJsonValue,
        confirmedBy: who.userId, confirmedAt: now, nextCheckAt: null, lastError: null, lastErrorAt: null,
      },
    })
    if (moved.count !== 1) throw new FbaSendError('WRONG_STATE', 'The plan changed meanwhile: read it again.')
    await publishPlanChanged(tx, planId, 'CONFIRMING', 'CONFIRM', plan.lines.map((line) => line.productId))
    return planViewIn(tx, planId)
  }, TX_OPTIONS)
  await dispatchSoon(planId)
  return view!
}

/* ── cancelPlan ───────────────────────────────────────────────────────────────────────────────── */

/** Cancel (contract.ts): the holds are released AT THE CLICK; Amazon's cancel (when Amazon has the plan) is the job's. */
export async function cancelPlan(planId: string, who: FbaActor): Promise<FbaPlanView> {
  const outcome = await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, planId)
    const shipped = await tx.fBAShipment.count({ where: { planRowId: planId, shippedAt: { not: null } } })
    const now = new Date()
    if (!fbaPlanCan({ status: plan.status, shippedShipments: shipped, now: now.toISOString() }).cancel) {
      throw new FbaSendError('WRONG_STATE', shipped > 0
        ? 'A shipment of this plan is marked Shipped: the plan can no longer be cancelled.'
        : `The plan is "${words(plan.status)}": it cannot be cancelled now.`)
    }
    // Amazon may hold the plan (or a create may be in flight under a runner's lease): the job sends Amazon's cancel.
    const steps = Array.isArray(plan.steps) ? (plan.steps as unknown as FbaPlanStepEntry[]) : []
    const leased = !!plan.nextCheckAt && plan.nextCheckAt.getTime() > now.getTime()
    const atAmazon = !!plan.planId || plan.status === 'CREATING' || leased || steps.some((step) => step.call === 'createInboundPlan')

    const held = plan.lines.filter((line) => line.reservationId)
    await lockProductStock(tx, plan.lines.map((line) => line.productId))
    for (const line of held) {
      await releaseReservationInTx(tx, line.reservationId!, { actor: who.actor, reason: `FBA plan ${plan.name ?? plan.id} cancelled` })
      await tx.fbaInboundPlanLine.update({ where: { id: line.id }, data: { reservationId: null } })
    }
    const status: FbaPlanStatus = atAmazon ? 'CANCELLING' : 'CANCELLED'
    await tx.fbaInboundPlanV2.update({
      where: { id: planId },
      // CANCELLING keeps nextCheckAt: a runner holding the lease finishes its call, sees CANCELLING and cancels.
      data: atAmazon ? { status, currentStep: 'CANCEL', cancelledAt: now } : { status, currentStep: 'CANCEL', cancelledAt: now, nextCheckAt: null },
    })
    await publishPlanChanged(tx, planId, status, 'CANCEL', plan.lines.map((line) => line.productId))
    return { view: await planViewIn(tx, planId), status, released: held.map((line) => line.productId) }
  }, TX_OPTIONS)
  recascadeSoon(outcome.released, planId, who.actor)
  if (outcome.status === 'CANCELLING') await dispatchSoon(planId)
  return outcome.view!
}

/* ── retryPlan ────────────────────────────────────────────────────────────────────────────────── */

/** "Try again" / "Get new options" (contract.ts). */
export async function retryPlan(planId: string, _who: FbaActor): Promise<FbaPlanView> {
  const view = await prisma.$transaction(async (tx) => {
    const plan = await lockPlan(tx, planId)
    const now = new Date()
    let status: FbaPlanStatus
    let step: FbaPlanStep
    if (plan.status === 'FAILED') {
      const failed = plan.currentStep
      if (failed === 'TRACKING') {
        const unshipped = await tx.fBAShipment.count({ where: { planRowId: planId, shippedAt: null } })
        status = unshipped === 0 ? 'SHIPPED' : 'READY_TO_SHIP'
        step = 'TRACKING'
      } else if (isFbaPlanStep(failed)) {
        status = FBA_STEP_STATUS[failed]
        step = failed
      } else {
        throw new FbaSendError('WRONG_STATE', 'The failed step is not known: cancel the plan and make a new one.')
      }
    } else if (plan.status === 'WAITING_FOR_CHOICE') {
      const options = (plan.options && typeof plan.options === 'object' ? plan.options : null) as unknown as FbaPlanOptions | null
      if (!fbaPlanCan({ status: plan.status, shippedShipments: 0, optionsExpireAt: options?.expiresAt ?? null, now: now.toISOString() }).newOptions) {
        throw new FbaSendError('WRONG_STATE', 'Amazon\'s options are still valid: choose one.')
      }
      status = 'PLACING'
      step = 'PLACE'
    } else {
      throw new FbaSendError('WRONG_STATE', `The plan is "${words(plan.status)}": there is nothing to try again.`)
    }
    const moved = await tx.fbaInboundPlanV2.updateMany({
      where: { id: planId, status: plan.status },
      data: { status, currentStep: step, lastError: null, lastErrorAt: null, nextCheckAt: null },
    })
    if (moved.count !== 1) throw new FbaSendError('WRONG_STATE', 'The plan changed meanwhile: read it again.')
    await publishPlanChanged(tx, planId, status, step, plan.lines.map((line) => line.productId))
    return planViewIn(tx, planId)
  }, TX_OPTIONS)
  await dispatchSoon(planId)
  return view!
}
