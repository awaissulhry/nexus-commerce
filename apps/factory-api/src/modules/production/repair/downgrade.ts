import type { Prisma } from '@nexus/factory-db'
import type { PeriodLockOverride } from '@nexus/factory-domain/accounting/contracts'
import { ConflictError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayStart, toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCTION_DOWNGRADE } from '@nexus/factory-domain/production/repair/permissions'
import {
  DOWNGRADE_REASONS,
  downgradedFrom,
  downgradeLeft,
  downgradeMoveKey,
  downgradeRefusal,
  withdrawMoveKey,
  withdrawRefusal,
  type DowngradeFacts,
  type DowngradeRefusal,
  type DowngradeTarget,
} from '@nexus/factory-domain/production/repair/rules'
import { PRODUCTION_SCRAP_VIEW } from '@nexus/factory-domain/production/scrap/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { finishedItemFor, finishedPlaces, readSkus, skuKey, standardCostFor } from '../../inventory/finished/post'
import { InsufficientStockError, postMoves, type MoveDraft } from '../../inventory/ledger/post-moves'
import { lockWorkOrderIssues } from '../../inventory/issue/store'
import { lockReservations } from '../../inventory/reservations/store'
import { scrapPostingHeld } from '../scrap/over-limit'
import { assertMay, bodyIssue, may, officeOf, refuse } from './access'
import { DOWNGRADE_COLUMNS, downgradesOfSource, lockDowngrade, readDowngrade, readOrder, type DowngradeRow, type Reader } from './store'
// B-W2b-219: the second-quality move by the row's moveId.
import { movesOfDowngrades, originalAmong, originalMoveOf } from './downgrade-move'
import { inWords } from '../settings/cutting-rules'

/**
 * Second quality instead of scrap (B-W2b-126; MES-133; design production.scrap pop:sc-downgrade "Downgrade to second quality":
 * "reason; the garment goes to second-quality stock instead of scrap (ESPR: no destruction of unsold apparel for large
 * companies from 19 Jul 2026)", sec:sc-metrics "Downgraded to second quality"). Office only.
 *
 *   GET  /production/downgrades/options?sourceScanId|reworkOrderId   production.scrap.view: what the dialog needs for one scrap
 *                                     row — the garments it scrapped, sent to second quality already and left; the cell's
 *                                     SKU; the second-quality items (FINISHED, no SKU of their own, in pieces); the site's
 *                                     places (finished-goods ones marked); whether the style is protective clothing; the
 *                                     reasons; and why it is held, in words, before anything is typed.
 *   POST /production/downgrades       production.downgrade: ONE command — the work order's issue lock, the source again (a
 *                                     standing scan's scrap or a finished rework's), the rules (factory-domain repair
 *                                     downgradeRefusal) → the item (the cell's SKU's FINISHED item, made now when it has
 *                                     none, as a production receipt does; or the second-quality item) → the GarmentDowngrade
 *                                     row → ONE ADJUSTMENT into the place through postMoves (the work order named, the note
 *                                     in words, key `production.downgrade:<id>:1`, valued at the item's frozen standard as a
 *                                     finished garment is) → audit, production.garments_downgraded.
 *   POST /production/downgrades/:id/withdraw   production.downgrade: ONE command — the row FOR UPDATE at its version, not
 *                                     withdrawn → the move's mirror out of its place (a 409 in words when the place no longer
 *                                     holds them), key `production.downgrade:<id>:withdraw` → withdrawn (when, by whom, why)
 *                                     → audit, production.downgrade_withdrawn.
 *   GET  /production/downgrades       production.scrap.view: the downgrades of the caller's sites, newest first, with the
 *                                     place they went to and the garments (today, the period); Scrap & rework lists them as
 *                                     "Second quality" rows.
 *
 * No GarmentDowngrade column names its stock move (B-W2b-85's gap): the move is found by its key. Per work order, cell and
 * bundle: never a person; who made a row is an office user (createdById) shown nowhere in a list. No money in an answer (the
 * move's value is the stock ledger's, cost grain).
 */

export interface DowngradeSource {
  readonly sourceScanId?: string | undefined
  readonly reworkOrderId?: string | undefined
}

export interface DowngradeBody extends DowngradeSource {
  readonly quantity: number
  readonly reasonCode: string
  readonly note?: string | undefined
  readonly target: DowngradeTarget
  /** ITEM: the second-quality item. */
  readonly itemId?: string | undefined
  readonly toLocationId: string
  /** A protective garment: the person confirms the fault does not touch its protection. */
  readonly ppeConfirmed?: boolean | undefined
  readonly periodLockOverride?: PeriodLockOverride | undefined
}

const SCOPE = { company: 'companyId', site: 'siteId' } as const

/** The source row of a downgrade: what it scrapped, its work order, cell and bundle. */
async function sourceOf(db: Reader, source: DowngradeSource) {
  if (source.sourceScanId && source.reworkOrderId) throw bodyIssue('sourceScanId', 'Name the scan or the rework whose scrap goes to second quality, not both.')
  if (source.sourceScanId) {
    const scan = await db.operationScan.findUnique({ where: { id: source.sourceScanId }, select: { id: true, workOrderId: true, bundleId: true, kind: true, scrapQuantity: true } })
    if (!scan || (scan.kind !== 'REPORT' && scan.kind !== 'CORRECTION')) return null
    const voided = (await db.operationScan.count({ where: { correctsId: scan.id } })) > 0
    const bundle = await db.bundle.findUnique({ where: { id: scan.bundleId }, select: { id: true, code: true, part: true, workOrderSizeId: true } })
    if (!bundle) return null
    return { type: 'SCAN' as const, id: scan.id, workOrderId: scan.workOrderId, cellId: bundle.workOrderSizeId, bundle, scrapped: voided ? 0 : scan.scrapQuantity, sourceScanId: scan.id, reworkOrderId: null }
  }
  if (source.reworkOrderId) {
    const rework = await db.reworkOrder.findUnique({ where: { id: source.reworkOrderId }, select: { id: true, workOrderId: true, workOrderSizeId: true, bundleId: true, status: true, scrapQuantity: true } })
    if (!rework) return null
    const bundle = rework.bundleId ? await db.bundle.findUnique({ where: { id: rework.bundleId }, select: { id: true, code: true, part: true, workOrderSizeId: true } }) : null
    return { type: 'REWORK' as const, id: rework.id, workOrderId: rework.workOrderId, cellId: rework.workOrderSizeId, bundle, scrapped: rework.status === 'DONE' ? rework.scrapQuantity : 0, sourceScanId: null, reworkOrderId: rework.id }
  }
  throw bodyIssue('sourceScanId', 'Name the scan or the rework whose scrap goes to second quality.')
}
type Source = NonNullable<Awaited<ReturnType<typeof sourceOf>>>

/** Is a place finished-goods stock (a FINISHED_GOODS location or a place inside one)? */
async function finishedGoodsIds(db: Reader, siteId: string): Promise<Set<string>> {
  return new Set((await finishedPlaces(db, siteId)).map((place) => place.id))
}

/** The facts the rules need for one source (inside or outside the command). */
async function factsOf(db: Reader, source: Source) {
  const workOrder = (await readOrder(db, source.workOrderId))!
  const style = await db.style.findUnique({ where: { id: workOrder.styleId }, select: { id: true, code: true, name: true, companyId: true, garmentTracking: true, ppeCategory: true } })
  const cell = await db.workOrderSize.findUnique({ where: { id: source.cellId }, select: { id: true, colourwayId: true, size: true } })
  const colourway = cell ? await db.colourway.findUnique({ where: { id: cell.colourwayId }, select: { code: true, name: true } }) : null
  const skus = cell && style ? await readSkus(db, style.id, [{ colourwayId: cell.colourwayId, size: cell.size }]) : new Map()
  const sku = cell ? (skus.get(skuKey(cell.colourwayId, cell.size)) ?? null) : null
  const downgraded = downgradedFrom(await downgradesOfSource(db, source), source)
  const held = source.sourceScanId ? await scrapPostingHeld(db as Prisma.TransactionClient, source.sourceScanId) : null
  return { workOrder, style, cell, colourway, sku, downgraded, approval: held?.state ?? null }
}

/** GET /production/downgrades/options. */
export async function downgradeOptions(caller: CommandCaller, query: DowngradeSource) {
  const context = officeOf(caller)
  return caller.withClient(async (db) => {
    const source = await sourceOf(db, query)
    const order = source ? await readOrder(db, source.workOrderId) : null
    assertMay(context, PRODUCTION_SCRAP_VIEW, order, 'Scrap')
    const facts = await factsOf(db, source!)
    const places = await db.location.findMany({ where: { siteId: order!.siteId, status: 'ACTIVE', kind: { not: 'SUBCONTRACTOR' } }, select: { id: true, code: true, name: true, kind: true }, orderBy: { code: 'asc' } })
    const finished = await finishedGoodsIds(db, order!.siteId)
    const items = await db.item.findMany({ where: { kind: 'FINISHED', variantId: null, baseUom: 'PCS', OR: [{ companyId: null }, { companyId: order!.companyId }] }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' }, take: 200 })
    const left = downgradeLeft({ scrapped: source!.scrapped, downgraded: facts.downgraded })
    const general = downgradeRefusal(generalFacts(source!, facts, Math.max(1, left)))
    return {
      source: { type: source!.type, id: source!.id },
      workOrder: { id: order!.id, number: order!.number, status: order!.status },
      cell: { id: source!.cellId, colourwayCode: facts.colourway?.code ?? '', size: facts.cell?.size ?? '' },
      bundle: source!.bundle ? { id: source!.bundle.id, code: source!.bundle.code, part: source!.bundle.part } : null,
      scrapped: source!.scrapped,
      downgraded: facts.downgraded,
      left,
      approval: facts.approval,
      ppe: facts.style ? facts.style.ppeCategory !== 'NOT_PPE' : false,
      sku: facts.sku ? { variantId: facts.sku.variantId, sku: facts.sku.sku } : null,
      items,
      places: places.map((place) => ({ ...place, finishedGoods: finished.has(place.id) })),
      reasons: [...DOWNGRADE_REASONS],
      // Why nothing can go now (the work order, nothing scrapped or left, a cut piece, the scrap's approval), else null.
      held: general && general.code !== 'REASON_WORDS' && general.code !== 'NOT_A_REASON' && general.code !== 'PPE_CONFIRM' ? { code: general.code, message: general.message } : null,
      may: may(context, PRODUCTION_DOWNGRADE, order!),
    }
  })
}

/** The rules' facts before anything is chosen (the dialog's held reason): a valid reason, the SKU, a place outside finished goods. */
function generalFacts(source: Source, facts: Awaited<ReturnType<typeof factsOf>>, quantity: number): DowngradeFacts {
  return {
    workOrder: facts.workOrder,
    scrapped: source.scrapped,
    downgraded: facts.downgraded,
    quantity,
    part: source.bundle?.part ?? null,
    reasonCode: 'OTHER',
    note: 'held check',
    approval: facts.approval,
    ppe: false,
    ppeConfirmed: true,
    target: 'ITEM',
    skuKnown: true,
    placeInFinishedGoods: false,
    itemFits: true,
  }
}

/** POST /production/downgrades. */
export async function downgrade(caller: CommandCaller, body: DowngradeBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient(async (db) => {
    const source = await sourceOf(db, body)
    return source ? { source, order: await readOrder(db, source.workOrderId) } : null
  })
  if (!known?.order || !may(context, PRODUCTION_SCRAP_VIEW, known.order)) throw new NotFoundError('Scrap not found.')
  assertMay(context, PRODUCTION_DOWNGRADE, known.order, 'Scrap')
  if (body.target === 'ITEM' && !body.itemId) throw bodyIssue('itemId', 'Name the second-quality item the garments are kept as.')
  const { result, replayed } = await inWords(() => command(caller, { name: 'production.downgrade', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    // The work order's issue lock (a scan takes it shared): its scrap does not change under the downgrade.
    await lockWorkOrderIssues(tx, context.tenantId, known.order!.id)
    const source = (await sourceOf(tx, body))!
    const facts = await factsOf(tx, source)
    const place = await tx.location.findUnique({ where: { id: body.toLocationId }, select: { id: true, code: true, siteId: true, status: true, kind: true } })
    if (!place || place.siteId !== facts.workOrder.siteId || place.status !== 'ACTIVE' || place.kind === 'SUBCONTRACTOR') throw bodyIssue('toLocationId', 'Name a place of the site the garments go to (not a subcontractor’s).')
    const finished = await finishedGoodsIds(tx, facts.workOrder.siteId)
    const item = body.target === 'ITEM' ? await tx.item.findUnique({ where: { id: body.itemId! }, select: { id: true, kind: true, variantId: true, baseUom: true, companyId: true } }) : null
    const refusal: DowngradeRefusal | null = downgradeRefusal({
      workOrder: facts.workOrder,
      scrapped: source.scrapped,
      downgraded: facts.downgraded,
      quantity: body.quantity,
      part: source.bundle?.part ?? null,
      reasonCode: body.reasonCode,
      note: body.note,
      approval: facts.approval,
      ppe: facts.style ? facts.style.ppeCategory !== 'NOT_PPE' : false,
      ppeConfirmed: body.ppeConfirmed === true,
      target: body.target,
      skuKnown: facts.sku !== null,
      placeInFinishedGoods: finished.has(place.id),
      itemFits: body.target === 'ITEM' ? Boolean(item && item.kind === 'FINISHED' && item.variantId === null && item.baseUom === 'PCS' && (item.companyId === null || item.companyId === facts.workOrder.companyId)) : true,
    })
    if (refusal) refuse(refusal)

    const itemId =
      body.target === 'SKU'
        ? await finishedItemFor(tools as CommandTools, facts.sku!, { styleName: facts.style!.name, colourwayName: facts.colourway?.name ?? facts.sku!.sku, garmentTracking: facts.style!.garmentTracking, companyId: facts.style!.companyId })
        : item!.id
    const id = newId()
    const note = body.note?.trim() || null
    const data: Prisma.GarmentDowngradeUncheckedCreateInput = {
      id,
      companyId: facts.workOrder.companyId,
      siteId: facts.workOrder.siteId,
      workOrderId: facts.workOrder.id,
      workOrderSizeId: source.cellId,
      bundleId: source.bundle?.id ?? null,
      reworkOrderId: source.reworkOrderId,
      sourceScanId: source.sourceScanId,
      quantity: body.quantity,
      reasonCode: body.reasonCode,
      note,
      secondQualityItemId: body.target === 'ITEM' ? itemId : null,
      variantId: body.target === 'SKU' ? facts.sku!.variantId : null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: context.actorId,
    }
    // The garments into the place: one ADJUSTMENT naming the work order, valued as a finished garment is (its frozen standard),
    // posted before the row (B-W2b-219: the row names it).
    await lockReservations(tx, context.tenantId, [{ siteId: facts.workOrder.siteId, itemId, itemColourId: null }])
    const cost = await standardCostFor(tx, facts.workOrder.companyId, itemId, businessDate(tools.now))
    const draft: MoveDraft = {
      siteId: facts.workOrder.siteId,
      reason: 'ADJUSTMENT',
      itemId,
      itemColourId: null,
      lotId: null,
      hideId: null,
      fromLocationId: null,
      toLocationId: place.id,
      quantity: String(body.quantity),
      uom: 'PCS',
      workOrderId: facts.workOrder.id,
      reference: facts.workOrder.number,
      reasonCode: body.reasonCode,
      note: `Second quality instead of scrap (${body.reasonCode}): ${body.quantity} of work order ${facts.workOrder.number}${note ? `: ${note}` : ''}.`,
      idempotencyKey: downgradeMoveKey(id),
      ...(cost ? { cost } : {}),
    }
    const [move] = await postMoves(tools, [draft], { issuePath: () => 'body', periodLockOverride: body.periodLockOverride })
    // B-W2b-219: the row names its second-quality move (posted first, under the key the id chosen before gives it).
    await tx.garmentDowngrade.create({ data: { ...data, moveId: move!.id }, select: { id: true } })
    const scope = { companyId: facts.workOrder.companyId, siteId: facts.workOrder.siteId }
    tools.audit({ action: 'production.downgrade', recordType: 'GarmentDowngrade', recordId: id, ...scope, after: { ...data, createdAt: undefined, updatedAt: undefined, moveId: move!.id, toLocationId: place.id, itemId } })
    tools.audit({ action: 'production.downgrade', recordType: 'WorkOrder', recordId: facts.workOrder.id, ...scope, after: { downgradeId: id, quantity: body.quantity, reasonCode: body.reasonCode, moveId: move!.id } })
    tools.emit({
      type: 'production.garments_downgraded',
      subject: facts.workOrder.id,
      ...scope,
      payload: {
        workOrderId: facts.workOrder.id,
        number: facts.workOrder.number,
        downgradeId: id,
        workOrderSizeId: source.cellId,
        bundleId: source.bundle?.id ?? null,
        reworkOrderId: source.reworkOrderId,
        sourceScanId: source.sourceScanId,
        quantity: body.quantity,
        reasonCode: body.reasonCode,
        target: body.target,
        itemId,
        variantId: data.variantId ?? null,
        moveId: move!.id,
        toLocationId: place.id,
      },
    })
    const [view] = await downgradeViews(tx, [(await readDowngrade(tx, id))!])
    return { downgrade: view! }
  }))
  return { ...result, replayed }
}

/** The withdrawal's move, or the garments-moved refusal in words (they left the place: moved, shipped or counted out). */
async function postMovesOrRefuse(tools: CommandTools, drafts: MoveDraft[], options: Parameters<typeof postMoves>[2]) {
  try {
    return await postMoves(tools, drafts, options)
  } catch (error) {
    if (error instanceof InsufficientStockError) {
      return refuse({ code: 'GARMENTS_MOVED', message: `The garments of this downgrade are no longer all in their place: ${error.message}`, fix: 'Move them back to that place first, or correct the stock there.' })
    }
    throw error
  }
}

/** POST /production/downgrades/:id/withdraw. */
export async function withdrawDowngrade(caller: CommandCaller, downgradeId: string, body: { readonly version: number; readonly reason: string; readonly periodLockOverride?: PeriodLockOverride | undefined }, idempotencyKey?: string) {
  const context = officeOf(caller)
  const known = await caller.withClient((db) => readDowngrade(db, downgradeId))
  if (!known || !may(context, PRODUCTION_SCRAP_VIEW, known)) throw new NotFoundError('Downgrade not found.')
  assertMay(context, PRODUCTION_DOWNGRADE, known, 'Downgrade')
  const { result, replayed } = await inWords(() => command(caller, { name: 'production.withdrawDowngrade', idempotencyKey, input: { downgradeId, ...body } }, async (tools) => {
    const { tx } = tools
    const row = (await lockDowngrade(tx, downgradeId))!
    if (row.version !== body.version) throw new ConflictError(`This downgrade changed since you read it (version ${row.version}, not ${body.version}): read it again.`)
    const refusal = withdrawRefusal(row)
    if (refusal) refuse(refusal)
    const order = (await readOrder(tx, row.workOrderId))!
    // B-W2b-219: the move the row names (rows before the column: by its key).
    const original = await originalMoveOf(tx, row)
    let mirror: { id: string } | null = null
    if (original) {
      await lockReservations(tx, context.tenantId, [{ siteId: original.siteId, itemId: original.itemId, itemColourId: original.itemColourId }])
      const [posted] = await postMovesOrRefuse(
        tools,
        [
          {
            siteId: original.siteId,
            reason: 'ADJUSTMENT',
            itemId: original.itemId,
            itemColourId: original.itemColourId,
            lotId: original.lotId,
            hideId: original.hideId,
            fromLocationId: original.toLocationId,
            toLocationId: null,
            quantity: original.quantity.toString(),
            uom: original.uom,
            baseQuantity: original.baseQuantity.toString(),
            workOrderId: original.workOrderId,
            reference: original.reference,
            note: `Downgrade withdrawn: ${body.reason.trim()}`,
            reversalOfId: original.id,
            idempotencyKey: withdrawMoveKey(row.id),
          },
        ],
        { issuePath: () => 'body', periodLockOverride: body.periodLockOverride },
      )
      mirror = posted ? { id: posted.id } : null
    }
    await tx.garmentDowngrade.update({ where: { id: row.id }, data: { voidedAt: tools.now, voidedById: context.actorId, voidReason: body.reason.trim(), version: { increment: 1 }, updatedAt: tools.now }, select: { id: true } })
    const scope = { companyId: row.companyId, siteId: row.siteId }
    tools.audit({ action: 'production.withdrawDowngrade', recordType: 'GarmentDowngrade', recordId: row.id, ...scope, before: { voidedAt: null }, after: { voidedAt: toUtcIso(tools.now), moveId: mirror?.id ?? null }, reason: body.reason.trim() })
    tools.emit({ type: 'production.downgrade_withdrawn', subject: row.workOrderId, ...scope, payload: { workOrderId: row.workOrderId, number: order.number, downgradeId: row.id, quantity: row.quantity, moveId: mirror?.id ?? null } })
    const [view] = await downgradeViews(tx, [(await readDowngrade(tx, row.id))!])
    return { downgrade: view! }
  }))
  return { ...result, replayed }
}

export interface DowngradeQuery {
  readonly siteId?: string | undefined
  readonly workOrderId?: string | undefined
  readonly from?: Date | undefined
  readonly to?: Date | undefined
  readonly limit: number
}

/** GET /production/downgrades: newest first, with the garments of the same scope (today's garments, the period's). */
export async function listDowngrades(caller: CommandCaller, query: DowngradeQuery) {
  const context = officeOf(caller)
  const scope = scopeWhere(actorOf(context), PRODUCTION_SCRAP_VIEW, SCOPE) as Prisma.GarmentDowngradeWhereInput
  const where: Prisma.GarmentDowngradeWhereInput = {
    AND: [scope, query.siteId ? { siteId: query.siteId } : {}, query.workOrderId ? { workOrderId: query.workOrderId } : {}, query.from ? { createdAt: { gte: query.from } } : {}, query.to ? { createdAt: { lt: query.to } } : {}],
  }
  return caller.withClient(async (db) => {
    const rows = await db.garmentDowngrade.findMany({ where, select: DOWNGRADE_COLUMNS, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], take: query.limit })
    const since = businessDayStart(businessDate(serverClock.now()))
    const standing = (extra: Prisma.GarmentDowngradeWhereInput) => db.garmentDowngrade.aggregate({ where: { AND: [where, { voidedAt: null }, extra] }, _sum: { quantity: true } })
    return {
      downgrades: await downgradeViews(db, rows),
      garments: { today: (await standing({ createdAt: { gte: since } }))._sum.quantity ?? 0, period: (await standing({}))._sum.quantity ?? 0 },
    }
  })
}

const unique = (values: readonly (string | null | undefined)[]) => [...new Set(values.filter((value): value is string => typeof value === 'string'))]

/** The views of downgrade rows: work order and style, cell, bundle, the item or SKU, the place and the move by its key. */
export async function downgradeViews(db: Reader, rows: readonly DowngradeRow[]) {
  if (rows.length === 0) return []
  const orders = new Map((await db.workOrder.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderId)) } }, select: { id: true, number: true, status: true, styleId: true } })).map((row) => [row.id, row]))
  const styles = new Map((await db.style.findMany({ where: { id: { in: unique([...orders.values()].map((order) => order.styleId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const cells = await db.workOrderSize.findMany({ where: { id: { in: unique(rows.map((row) => row.workOrderSizeId)) } }, select: { id: true, colourwayId: true, size: true } })
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: unique(cells.map((cell) => cell.colourwayId)) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const cellOf = new Map(cells.map((cell) => [cell.id, { id: cell.id, colourwayCode: colourways.get(cell.colourwayId) ?? '', size: cell.size }]))
  const bundles = new Map((await db.bundle.findMany({ where: { id: { in: unique(rows.map((row) => row.bundleId)) } }, select: { id: true, code: true, part: true } })).map((row) => [row.id, row]))
  const items = new Map((await db.item.findMany({ where: { id: { in: unique(rows.map((row) => row.secondQualityItemId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const variants = new Map((await db.variant.findMany({ where: { id: { in: unique(rows.map((row) => row.variantId)) } }, select: { id: true, sku: true } })).map((row) => [row.id, row]))
  // B-W2b-219: the moves by key and the ones the rows name.
  const moves = await movesOfDowngrades(db, rows)
  const places = new Map((await db.location.findMany({ where: { id: { in: unique(moves.map((move) => move.toLocationId)) } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return rows.map((row) => {
    const order = orders.get(row.workOrderId)
    const move = originalAmong(moves, row)
    const back = moves.find((entry) => entry.idempotencyKey === withdrawMoveKey(row.id)) ?? null
    const bundle = row.bundleId ? bundles.get(row.bundleId) : undefined
    const item = row.secondQualityItemId ? items.get(row.secondQualityItemId) : undefined
    const variant = row.variantId ? variants.get(row.variantId) : undefined
    const place = move?.toLocationId ? places.get(move.toLocationId) : undefined
    return {
      id: row.id,
      companyId: row.companyId,
      siteId: row.siteId,
      workOrder: { id: row.workOrderId, number: order?.number ?? '', status: order?.status ?? 'RELEASED', style: order ? (styles.get(order.styleId) ?? null) : null },
      cell: cellOf.get(row.workOrderSizeId) ?? { id: row.workOrderSizeId, colourwayCode: '', size: '' },
      bundle: bundle ? { id: bundle.id, code: bundle.code, part: bundle.part } : null,
      source: row.sourceScanId ? { type: 'SCAN' as const, id: row.sourceScanId } : row.reworkOrderId ? { type: 'REWORK' as const, id: row.reworkOrderId } : null,
      quantity: row.quantity,
      reasonCode: row.reasonCode,
      note: row.note,
      target: row.variantId ? ('SKU' as const) : ('ITEM' as const),
      item: item ? { id: item.id, code: item.code, name: item.name } : null,
      sku: variant ? { id: variant.id, sku: variant.sku } : null,
      place: place ? { id: place.id, code: place.code, name: place.name } : null,
      moveId: move?.id ?? null,
      withdrawnMoveId: back?.id ?? null,
      withdrawn: row.voidedAt ? { at: toUtcIso(row.voidedAt), reason: row.voidReason ?? '' } : null,
      version: row.version,
      createdAt: toUtcIso(row.createdAt),
    }
  })
}
