import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { baseQuantityOf, defaultUnitPrice, estimatedHidesOf, inUnit, LEATHER_KIND, LINE_SEQ_STEP, lineAmount, lineProblems, MAX_LINES, type LineFields } from '@nexus/factory-domain/purchasing/orders'
import { PURCHASING_MANAGE } from '@nexus/factory-domain/purchasing/permissions'
import { priceIn, sourceFor } from '@nexus/factory-domain/purchasing/sources/sources'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTools } from '../../core/command'
import { assertDraft, detailInCommand, onOrder, refreshTotal, reopenPlanLines } from './orders'
import { actorIdOf, dayOf, dayValue, decimal, ITEM_COLUMNS, LINE_COLUMNS, officeOrder, quantityText, unitsOf, type ItemRow, type LineRow, type OrderRow } from './store'
import { activeSourcesOf } from './supplier-items/store'
import type { OrderDetail } from './views'

/**
 * The lines of a draft purchase order (B-W1-30; SCM-050, SCM-075; A2 SCR-059 "Lines"): what we buy, in which colour, how
 * much in which unit (any unit the material converts: ft² or m² for leather, metres, pieces …) and in the base unit, at
 * which price (a cost: the material's standard purchase price in the line's unit by default), needed by when; for leather
 * the grade and thickness (the material's by default), one dye batch (on by default), the area tolerance and about how
 * many hides the area is; the Cr VI flag copied from the material. Each write is a command on the order (its version
 * guards it), keeps the order's total current, and only while the order is a draft (the triggers too).
 *
 * A line drafted from the plan names the plan line it buys (MaterialRequirement.purchaseOrderLineId): its material and
 * colour stay; removing it opens the plan line again (planning's hook) when that plan is the latest. A line named by an
 * older plan cannot be removed: a superseded plan never changes and keeps naming it (change it, or cancel the order).
 */

export interface LineInput extends LineFields {
  readonly itemColourId?: string | null | undefined
  readonly description?: string | null | undefined
  readonly supplierArticleCode?: string | null | undefined
  readonly supplierColourCode?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface AddLineInput extends LineInput {
  readonly version: number
  readonly itemId: string
  readonly quantity: string
  readonly needDate: string
}

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** The material, if the order's company may buy it (its own or a tenant-wide one). */
export async function itemFor(tools: CommandTools, order: Pick<OrderRow, 'companyId'>, itemId: string): Promise<ItemRow> {
  const item = isUuid(itemId) ? await tools.tx.item.findUnique({ where: { id: itemId }, select: ITEM_COLUMNS }) : null
  if (!item || (item.companyId !== null && item.companyId !== order.companyId)) throw new NotFoundError('Material not found.')
  return item
}

async function colourFor(tools: CommandTools, item: ItemRow, colourId: string | null | undefined) {
  if (!colourId) return null
  const colour = isUuid(colourId) ? await tools.tx.itemColour.findUnique({ where: { id: colourId }, select: { id: true, itemId: true, status: true, supplierColourCode: true } }) : null
  if (!colour || colour.itemId !== item.id) throw new ValidationError('Not a colour of this material.', [{ path: 'body/itemColourId', message: 'Choose one of the material’s colours.' }])
  if (colour.status !== 'ACTIVE') throw new ValidationError('The colour is archived.', [{ path: 'body/itemColourId', message: 'Choose an active colour.' }])
  return colour
}

const leatherDefaults = (item: ItemRow) =>
  item.kind === LEATHER_KIND
    ? { grade: item.grade, thicknessMinMm: decimal(item.thicknessMinMm), thicknessMaxMm: decimal(item.thicknessMaxMm), oneDyeBatch: true, areaTolerancePct: null }
    : { grade: null, thicknessMinMm: null, thicknessMaxMm: null, oneDyeBatch: false, areaTolerancePct: null }

/** The stored numbers of a line from its fields: base quantity, amount, hides; a ValidationError when a field is wrong. */
function computed(order: Pick<OrderRow, 'currency'>, item: ItemRow, line: Required<Pick<LineFields, 'quantity' | 'uom' | 'needDate'>> & LineFields & { readonly unitPrice: string }) {
  const problems = lineProblems(line, { kind: item.kind, status: item.status, units: unitsOf(item) })
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const baseQuantity = baseQuantityOf(line.quantity, line.uom, unitsOf(item))!
  let netAmount: number
  try {
    netAmount = lineAmount(line.quantity, line.unitPrice, order.currency)
  } catch {
    throw new ValidationError('The line is worth more than one order line can hold: split it.', [{ path: 'body/quantity', message: 'Quantity × price is too large.' }])
  }
  return { baseQuantity, netAmount, estimatedHides: estimatedHidesOf(item.kind, baseQuantity, unitsOf(item)) }
}

/**
 * Inside a command on a DRAFT order: a new line (the caller checked the order). Defaults come from the order's supplier's
 * approved source of the material (B-W2a-52, the B-W2a-10 note: its unit, its price in the line's unit, its article and
 * colour codes; purchasing/sources sourceFor + priceIn), else from the material, its colour and its default supplier; the
 * line takes the next place (10, 20 …).
 */
export async function insertLine(tools: CommandTools, order: OrderRow, item: ItemRow, input: LineInput & { readonly quantity: string; readonly needDate: string }): Promise<LineRow> {
  const { tx } = tools
  const count = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } })
  if (count >= MAX_LINES) throw new ConflictError(`An order holds at most ${MAX_LINES} lines: start another one.`)
  const colour = await colourFor(tools, item, input.itemColourId)
  const source = sourceFor(await activeSourcesOf(tx, [item.id]), { companyId: order.companyId, itemId: item.id, itemColourId: colour?.id ?? null }, order.partyId)
  const own = source && source.partyId === order.partyId ? source : null
  const uom = (input.uom ?? own?.purchaseUom ?? item.purchaseUom) as Uom
  const priced =
    input.unitPrice ??
    (own ? priceIn(own, uom, unitsOf(item), order.currency) : null) ??
    defaultUnitPrice({ standardCost: decimal(item.standardCost), currency: item.currency, units: unitsOf(item) }, uom, order.currency) ??
    '0'
  const leather = leatherDefaults(item)
  const fields = {
    ...leather,
    ...Object.fromEntries((['grade', 'thicknessMinMm', 'thicknessMaxMm', 'oneDyeBatch', 'areaTolerancePct'] as const).filter((key) => input[key] !== undefined).map((key) => [key, input[key]])),
    quantity: input.quantity,
    uom,
    unitPrice: priced,
    needDate: input.needDate,
  } as Required<Pick<LineFields, 'quantity' | 'uom' | 'needDate'>> & LineFields & { unitPrice: string }
  const numbers = computed(order, item, fields)
  const last = await tx.purchaseOrderLine.findFirst({ where: { purchaseOrderId: order.id }, orderBy: { seq: 'desc' }, select: { seq: true } })
  const id = newId()
  await tx.purchaseOrderLine.create({
    data: {
      id,
      purchaseOrderId: order.id,
      partyId: order.partyId,
      siteId: order.siteId,
      seq: (last?.seq ?? 0) + LINE_SEQ_STEP,
      itemId: item.id,
      itemColourId: colour?.id ?? null,
      description: blankToNull(input.description),
      supplierArticleCode: input.supplierArticleCode === undefined ? (own?.supplierArticleCode ?? (item.defaultSupplierId === order.partyId ? item.supplierArticleCode : null)) : blankToNull(input.supplierArticleCode),
      supplierColourCode: input.supplierColourCode === undefined ? (own?.supplierColourCode ?? colour?.supplierColourCode ?? null) : blankToNull(input.supplierColourCode),
      quantity: fields.quantity,
      uom,
      baseQuantity: numbers.baseQuantity,
      unitPrice: priced,
      netAmount: numbers.netAmount,
      needDate: dayValue(fields.needDate),
      grade: blankToNull(fields.grade),
      thicknessMinMm: fields.thicknessMinMm ?? null,
      thicknessMaxMm: fields.thicknessMaxMm ?? null,
      oneDyeBatch: fields.oneDyeBatch ?? false,
      areaTolerancePct: fields.areaTolerancePct ?? null,
      estimatedHides: numbers.estimatedHides,
      requiresCrViTest: item.requiresCrViTest,
      note: blankToNull(input.note),
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  return tx.purchaseOrderLine.findUniqueOrThrow({ where: { id }, select: LINE_COLUMNS })
}

/** What the audit keeps of a line (the price and amount marked as costs). */
export const lineAudit = (line: LineRow) => ({
  seq: line.seq,
  itemId: line.itemId,
  itemColourId: line.itemColourId,
  quantity: quantityText(line.quantity),
  uom: line.uom,
  baseQuantity: quantityText(line.baseQuantity),
  unitPrice: markMoney('cost', line.unitPrice.toFixed(6)),
  netAmount: markMoney('cost', line.netAmount),
  needDate: dayOf(line.needDate),
  oneDyeBatch: line.oneDyeBatch,
  estimatedHides: line.estimatedHides,
  requiresCrViTest: line.requiresCrViTest,
})

/** After a line write: the order's total, the audit row of the order and purchase_order.lines_changed. */
export async function linesChanged(tools: CommandTools, order: OrderRow, change: { readonly added?: number; readonly changed?: number; readonly removed?: number }, audit: { readonly action: string; readonly before?: unknown; readonly after?: unknown }): Promise<void> {
  const netAmount = await refreshTotal(tools, order.id)
  const lines = await tools.tx.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } })
  tools.audit({ action: audit.action, recordType: 'PurchaseOrder', recordId: order.id, companyId: order.companyId, siteId: order.siteId, before: audit.before, after: { ...(audit.after as object), orderAmount: markMoney('cost', netAmount), lines } })
  tools.emit({ type: 'purchase_order.lines_changed', subject: order.id, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: order.id, number: order.number, added: change.added ?? 0, changed: change.changed ?? 0, removed: change.removed ?? 0, lines } })
}

// ---- add ----------------------------------------------------------------------------------------------------------------

/** purchasing.manage: a line on a draft. */
export async function addLine(caller: CommandCaller, orderId: string, body: AddLineInput, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  const { version, itemId, ...input } = body
  return onOrder(caller, order, { name: 'purchasing.lines.add', idempotencyKey, input: { orderId, ...body }, version }, async (tools, current) => {
    assertDraft(current)
    const line = await insertLine(tools, current, await itemFor(tools, current, itemId), input)
    await linesChanged(tools, current, { added: 1 }, { action: 'purchasing.lines.add', after: { lineId: line.id, line: lineAudit(line) } })
    return detailInCommand(tools, current.id)
  })
}

// ---- edit ---------------------------------------------------------------------------------------------------------------

export interface EditLineInput extends LineInput {
  readonly version: number
}

/** purchasing.manage: a draft line's colour, quantity and unit, price, need date, codes, leather specs and note. */
export async function editLine(caller: CommandCaller, orderId: string, lineId: string, body: EditLineInput, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  const { version, ...input } = body
  return onOrder(caller, order, { name: 'purchasing.lines.edit', idempotencyKey, input: { orderId, lineId, ...body }, version }, async (tools, current) => {
    assertDraft(current)
    const { tx } = tools
    const line = isUuid(lineId) ? await tx.purchaseOrderLine.findUnique({ where: { id: lineId }, select: LINE_COLUMNS }) : null
    if (!line || line.purchaseOrderId !== current.id) throw new NotFoundError('Line not found.')
    if (Object.values(input).every((value) => value === undefined)) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one field.' }])
    const item = await itemFor(tools, current, line.itemId)
    if (input.itemColourId !== undefined && input.itemColourId !== line.itemColourId && (await tx.materialRequirement.count({ where: { purchaseOrderLineId: line.id } })) > 0) {
      throw new ConflictError('The line buys a line of the plan in its colour: remove it and add the other colour instead.')
    }
    const colour = input.itemColourId === undefined ? undefined : await colourFor(tools, item, input.itemColourId)
    // Another unit without a new quantity or price: the same goods at the same price per base unit, in that unit.
    const uom = (input.uom ?? line.uom) as Uom
    const moved = uom !== line.uom ? inUnit({ quantity: line.quantity.toString(), unitPrice: line.unitPrice.toString() }, line.uom, uom, unitsOf(item)) : null
    const merged = {
      quantity: input.quantity ?? moved?.quantity ?? line.quantity.toString(),
      uom,
      unitPrice: input.unitPrice ?? moved?.unitPrice ?? line.unitPrice.toString(),
      needDate: input.needDate ?? dayOf(line.needDate)!,
      grade: input.grade === undefined ? line.grade : input.grade,
      thicknessMinMm: input.thicknessMinMm === undefined ? decimal(line.thicknessMinMm) : input.thicknessMinMm,
      thicknessMaxMm: input.thicknessMaxMm === undefined ? decimal(line.thicknessMaxMm) : input.thicknessMaxMm,
      oneDyeBatch: input.oneDyeBatch ?? line.oneDyeBatch,
      areaTolerancePct: input.areaTolerancePct === undefined ? decimal(line.areaTolerancePct) : input.areaTolerancePct,
    }
    const numbers = computed(current, item, merged)
    const data: Prisma.PurchaseOrderLineUncheckedUpdateInput = {
      quantity: merged.quantity,
      uom: merged.uom,
      baseQuantity: numbers.baseQuantity,
      unitPrice: merged.unitPrice,
      netAmount: numbers.netAmount,
      needDate: dayValue(merged.needDate),
      grade: blankToNull(merged.grade),
      thicknessMinMm: merged.thicknessMinMm ?? null,
      thicknessMaxMm: merged.thicknessMaxMm ?? null,
      oneDyeBatch: merged.oneDyeBatch,
      areaTolerancePct: merged.areaTolerancePct ?? null,
      estimatedHides: numbers.estimatedHides,
      version: { increment: 1 },
    }
    if (colour !== undefined) {
      data.itemColourId = colour?.id ?? null
      if (input.supplierColourCode === undefined) data.supplierColourCode = colour?.supplierColourCode ?? null
    }
    for (const key of ['description', 'supplierArticleCode', 'supplierColourCode', 'note'] as const) if (input[key] !== undefined) data[key] = blankToNull(input[key])
    await tx.purchaseOrderLine.update({ where: { id: line.id }, data, select: { id: true } })
    const after = await tx.purchaseOrderLine.findUniqueOrThrow({ where: { id: line.id }, select: LINE_COLUMNS })
    await linesChanged(tools, current, { changed: 1 }, { action: 'purchasing.lines.edit', before: { lineId: line.id, line: lineAudit(line) }, after: { lineId: line.id, line: lineAudit(after) } })
    return detailInCommand(tools, current.id)
  })
}

// ---- remove -------------------------------------------------------------------------------------------------------------

/**
 * Inside a command on a DRAFT order: removes these lines of it. The plan line each one buys is opened again when its plan
 * is the latest (planning's hook, BEFORE the delete: the requirement's reference to the line is Restrict); a line named by
 * an older (superseded) plan stays, with a 409 that says what to do instead.
 */
export async function removeLines(tools: CommandTools, order: OrderRow, lineIds: readonly string[]): Promise<{ removed: LineRow[]; reopened: string[] }> {
  const { tx } = tools
  const lines = await tx.purchaseOrderLine.findMany({ where: { id: { in: [...lineIds] }, purchaseOrderId: order.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  if (lines.length !== new Set(lineIds).size) throw new NotFoundError('Line not found.')
  const older = await tx.materialRequirement.findMany({ where: { purchaseOrderLineId: { in: lines.map((line) => line.id) }, run: { status: { not: 'DONE' } } }, select: { purchaseOrderLineId: true } })
  if (older.length > 0) {
    const seqs = [...new Set(older.map((row) => lines.find((line) => line.id === row.purchaseOrderLineId)!.seq))].sort((a, b) => a - b)
    throw new ConflictError(
      `A newer plan replaced the plan line ${seqs.join(', ')} was drafted from; an older plan never changes, so the line stays on the order. Change its quantity, or cancel the order.`,
    )
  }
  const reopened = await reopenPlanLines(tools, order.id, lines.map((line) => line.id))
  await tx.purchaseOrderLine.deleteMany({ where: { id: { in: lines.map((line) => line.id) }, purchaseOrderId: order.id } })
  return { removed: lines, reopened }
}

/** purchasing.manage: removes a draft's line (the plan line it bought is open again). */
export async function removeLine(caller: CommandCaller, orderId: string, lineId: string, query: { version: number }, idempotencyKey?: string): Promise<{ order: OrderDetail }> {
  const order = await officeOrder(caller, orderId, PURCHASING_MANAGE)
  return onOrder(caller, order, { name: 'purchasing.lines.remove', idempotencyKey, input: { orderId, lineId, ...query }, version: query.version }, async (tools, current) => {
    assertDraft(current)
    if (!isUuid(lineId)) throw new NotFoundError('Line not found.')
    const { removed, reopened } = await removeLines(tools, current, [lineId])
    await linesChanged(tools, current, { removed: 1 }, { action: 'purchasing.lines.remove', before: { lineId, line: lineAudit(removed[0]!) }, after: { reopenedRequirementIds: reopened } })
    return detailInCommand(tools, current.id)
  })
}
