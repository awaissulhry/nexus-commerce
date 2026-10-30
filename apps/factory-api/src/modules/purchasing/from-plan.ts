import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { can } from '@nexus/factory-domain/core/permissions'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { STATUS_WORDS, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { orderRequirement } from '../planning/hooks'
import { lineAudit, linesChanged, insertLine, itemFor, removeLines } from './lines'
import { assertBuyable, insertDraft } from './orders'
import { requestIdOf, type RequestHoldCode } from '@nexus/factory-domain/purchasing/requests/requests'
import { buildRequests, planRaws, type Built } from './requests/build'
import { assertMay, officeContextOf, ORDER_COLUMNS, PARTY_COLUMNS, readOrder, type OrderRow, type Reader } from './store'

/**
 * "Draft PO" from What to buy & make (B-W1-30; design 02: the Requirements grid's one-click Draft PO, the band's "Draft POs
 * for all open Buy lines", the Draft purchase orders pop-up; SCR-055): ONE command turns plan lines to buy into purchase
 * order lines, one line per plan line, grouped per supplier (and delivery site): into the supplier's open DRAFT for that
 * site (or the draft the caller names, or a new one), each plan line marked ORDERED with the line that buys it through
 * planning's hook in the same command. The supplier is the one the caller names, else the plan line's (the material's
 * default), else the request queue's choice (a firm planned order's, the site's, the best approved source). The quantity,
 * unit, price and codes are the request queue's for that supplier (./requests/build, B-W2a-10): a firm planned order as
 * the planner fixed it; with an approved source of the supplier its unit, minimum, steps, price and article codes; else
 * the plan's suggestion (the material's terms) at the material's standard purchase price. A supplier that is not one of
 * the material's approved sources (once it has some) is refused, as is a blocked one.
 *
 * Its Undo removes those lines again (each plan line opens again through the hook) and cancels the drafts the call made
 * when they are left without a line. A line named by an older (superseded) plan cannot be removed (409: the plan never
 * changes; the line is changed or the order cancelled).
 *
 * Two buyers drafting for one supplier and site wait for each other (an advisory lock per supplier and site), so they
 * share one open draft; each order touched is locked by its version. `draftLines` is the one way lines go into supplier
 * drafts: the request queue's bulk conversion (./requests/convert) uses it too.
 */

export interface DraftFromPlanInput {
  readonly lines: readonly { readonly id: string; readonly version: number; readonly supplierId?: string | undefined }[]
  /** Per supplier: the draft to add to, or null for a new one. Default: its open draft at the site, else a new one. */
  readonly into?: readonly { readonly supplierId: string; readonly purchaseOrderId: string | null }[] | undefined
}

/** One purchase order line to draft into a supplier's draft. */
export interface DraftLine {
  /** What the answer names the line by (the requirement id, or the request id). */
  readonly key: string
  readonly companyId: string
  readonly siteId: string
  readonly supplierId: string
  readonly itemId: string
  readonly itemColourId: string | null
  readonly quantity: string
  readonly uom: Uom
  readonly needDate: string
  /** Per `uom`, in the supplier's currency; null: the material's standard purchase price (insertLine's default). */
  readonly unitPrice: string | null
  readonly supplierArticleCode: string | null
  readonly supplierColourCode: string | null
  /** The plan line it buys: ORDERED with the new line (planning's hook), compared with this version. */
  readonly requirement: { readonly id: string; readonly version: number; readonly runId: string } | null
  /** What the line's audit row keeps besides the line. */
  readonly audit: Record<string, unknown>
}

/** Per supplier (and delivery site, when named): the draft to add to, or null for a new one. */
export interface DraftInto {
  readonly supplierId: string
  readonly siteId?: string | undefined
  readonly purchaseOrderId: string | null
}

export interface DraftedOrder {
  readonly id: string
  readonly number: string
  readonly created: boolean
  readonly companyId: string
  readonly siteId: string
  readonly supplierId: string
  readonly lineIds: string[]
  readonly keys: string[]
  readonly lineCount: number
}

/** Locks one order's row for this command (its version moves): only a draft takes lines. */
async function lockDraft(tools: CommandTools, order: OrderRow): Promise<void> {
  const { count } = await tools.tx.purchaseOrder.updateMany({ where: { id: order.id, status: 'DRAFT' }, data: { version: { increment: 1 } } })
  if (count !== 1) {
    const now = await tools.tx.purchaseOrder.findUnique({ where: { id: order.id }, select: { status: true } })
    throw new InvalidStateError(`${order.number} is ${STATUS_WORDS[(now?.status ?? 'CANCELLED') as PurchaseOrderStatus]}: only a draft takes lines.`)
  }
}

/** The supplier's open draft at the site the caller would add to (its newest, in the supplier's currency), or null. */
export const openDraftOf = (db: Reader, scope: { readonly companyId: string; readonly siteId: string; readonly partyId: string; readonly currency: string }) =>
  db.purchaseOrder.findFirst({ where: { ...scope, status: 'DRAFT' }, orderBy: { id: 'desc' }, select: ORDER_COLUMNS })

/**
 * Inside a command (the caller checked purchasing.manage over each line's company, site and supplier): the lines into
 * their suppliers' drafts, one draft per company, site and supplier, groups in a fixed order (the advisory locks are
 * taken in it). Each line is audited with `action`; each order touched gets purchasing's lines_changed.
 */
export async function draftLines(tools: CommandTools, context: OfficeContext, lines: readonly DraftLine[], into: readonly DraftInto[], action: 'purchasing.draftFromPlan' | 'purchasing.convertRequests') {
  const { tx } = tools
  const groups = new Map<string, DraftLine[]>()
  for (const line of lines) {
    const key = `${line.companyId}|${line.siteId}|${line.supplierId}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  const orders: DraftedOrder[] = []
  const made: { key: string; purchaseOrderId: string; purchaseOrderLineId: string }[] = []
  for (const key of [...groups.keys()].sort()) {
    const entries = groups.get(key)!
    const { companyId, siteId, supplierId } = entries[0]!
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.purchase-draft', ${context.tenantId}::uuid, ${siteId}::uuid, ${supplierId}::uuid), 0))`
    const party = await tx.party.findUnique({ where: { id: supplierId }, select: PARTY_COLUMNS })
    if (!party || (party.companyId !== null && party.companyId !== companyId)) throw new NotFoundError('Supplier not found.')
    assertBuyable(party, 'body/lines')

    const named = into.find((entry) => entry.supplierId === supplierId && (entry.siteId === undefined || entry.siteId === siteId))
    let order: OrderRow | null = null
    let created = false
    if (named?.purchaseOrderId) {
      order = await readOrder(tx, named.purchaseOrderId)
      if (!order || order.companyId !== companyId || order.siteId !== siteId || order.partyId !== supplierId) {
        throw new ValidationError(`The draft named for ${party.legalName} is not one of its orders for this site.`, [{ path: 'body/into', message: 'Name a draft of this supplier for the site.' }])
      }
    } else if (named === undefined) {
      order = await openDraftOf(tx, { companyId, siteId, partyId: supplierId, currency: party.currency })
    }
    if (order) await lockDraft(tools, order)
    else {
      const draft = await insertDraft(tools, { companyId, siteId, party, header: {}, source: 'PLAN' })
      order = (await readOrder(tx, draft.id))!
      created = true
    }

    const lineIds: string[] = []
    for (const entry of entries) {
      const item = await itemFor(tools, order, entry.itemId)
      const line = await insertLine(tools, order, item, {
        itemColourId: entry.itemColourId,
        quantity: entry.quantity,
        uom: entry.uom,
        needDate: entry.needDate,
        ...(entry.unitPrice === null ? {} : { unitPrice: entry.unitPrice }),
        supplierArticleCode: entry.supplierArticleCode,
        supplierColourCode: entry.supplierColourCode,
      })
      if (entry.requirement) await orderRequirement(tools, { requirementId: entry.requirement.id, purchaseOrderLineId: line.id, expectedVersion: entry.requirement.version })
      lineIds.push(line.id)
      made.push({ key: entry.key, purchaseOrderId: order.id, purchaseOrderLineId: line.id })
      tools.audit({ action, recordType: 'PurchaseOrderLine', recordId: line.id, companyId, siteId, after: { purchaseOrderId: order.id, ...entry.audit, line: lineAudit(line) } })
    }
    const keys = entries.map((entry) => entry.key)
    await linesChanged(tools, order, { added: lineIds.length }, { action, after: { created, lineIds, ...(action === 'purchasing.draftFromPlan' ? { requirementIds: keys } : { requestIds: keys }) } })
    orders.push({ id: order.id, number: order.number, created, companyId, siteId, supplierId, lineIds, keys, lineCount: await tx.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } }) })
  }
  return { orders, made }
}

/**
 * A request as a line to draft; a held one is refused in words (the caller's path names it). `passing` lets holds through
 * that `draftLines` refuses itself (a supplier that cannot take an order: assertBuyable's words, as W1's Draft PO).
 */
export function draftLineOf(built: Built, path: string, audit: Record<string, unknown>, passing: readonly RequestHoldCode[] = []): DraftLine {
  if (built.hold && !passing.includes(built.hold.code)) {
    const wrongSupplier = built.hold.code === 'NO_SUPPLIER' || built.hold.code === 'NOT_A_SUPPLIER' || built.hold.code === 'NOT_APPROVED'
    if (wrongSupplier) throw new ValidationError(built.hold.message, [{ path: `${path}/supplierId`, message: built.hold.message }])
    throw new ConflictError(built.hold.message)
  }
  return {
    key: built.id,
    companyId: built.companyId,
    siteId: built.siteId,
    supplierId: built.supplier!.id,
    itemId: built.item.id,
    itemColourId: built.colour?.id ?? null,
    quantity: built.quantity,
    uom: built.uom,
    needDate: built.needDate,
    unitPrice: built.unitPrice,
    supplierArticleCode: built.supplierArticleCode,
    supplierColourCode: built.supplierColourCode,
    requirement: built.plan ? { id: built.refId, version: built.version, runId: built.plan.runId } : null,
    audit,
  }
}

/**
 * The holds a Draft PO from the plan leaves to W1's own refusals, in W1's words: a supplier that cannot take an order
 * (draftLines' assertBuyable) and a line that is not open (planning's hook: "ordered already", "set aside").
 */
const PLAN_PASSING: readonly RequestHoldCode[] = ['NOT_A_SUPPLIER', 'SUPPLIER_BLOCKED', 'SUPPLIER_ARCHIVED', 'NOT_OPEN']

/** purchasing.manage over each plan line's company, site and supplier. */
export async function draftFromPlan(caller: CommandCaller, body: DraftFromPlanInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const ids = body.lines.map((line) => line.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A plan line is listed twice.', [{ path: 'body/lines', message: 'Each line once.' }])
  const { result } = await command(caller, { name: 'purchasing.draftFromPlan', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const raws = await planRaws(tx, null, { id: { in: ids.filter(isUuid) } })
    const rawOf = new Map(raws.map((raw) => [raw.row.id, raw]))
    for (const line of body.lines) {
      const raw = rawOf.get(line.id)
      if (!raw) throw new NotFoundError('Requirement not found.')
      if (raw.row.action !== 'BUY') throw new ConflictError('A part we make is not bought: it has no purchase line.')
      if (!raw.row.suggestedQuantity.gt(0) && raw.row.firmQuantity === null) throw new ConflictError('Nothing is short on this line: there is nothing to buy.')
      if (!can(actorOf(context), PURCHASING_VIEW, { companyId: raw.run.companyId, siteId: raw.row.siteId })) throw new NotFoundError('Plan line not found.')
    }
    // The supplier: the caller's, else the plan line's (the material's default), else the queue's choice.
    const choices = new Map(body.lines.map((line) => [requestIdOf('PLAN', line.id), { supplierId: line.supplierId ?? rawOf.get(line.id)!.row.supplierId }]))
    const built = new Map((await buildRequests(tx, raws, { today: businessDate(tools.now), choices, triggeredOnly: false })).map((entry) => [entry.refId, entry]))
    const drafts = body.lines.map((line, index) => {
      const request = built.get(line.id)!
      if (!request.supplier) {
        throw new ValidationError(`Pick a supplier first: ${request.item.code} has none.`, [{ path: `body/lines/${index}/supplierId`, message: 'Required: the material has no default supplier.' }])
      }
      assertMay(context, PURCHASING_MANAGE, { companyId: request.companyId, siteId: request.siteId, partyId: request.supplier.id }, 'Plan line')
      if (request.plan!.runStatus !== 'DONE') throw new ConflictError('A newer plan replaced this one: draft the lines of the latest plan.')
      const audit = { requirementId: request.refId, runId: request.plan!.runId, quantityFrom: request.quantityFrom, sourceId: request.source?.id ?? null }
      return { ...draftLineOf({ ...request, version: line.version }, `body/lines/${index}`, audit, PLAN_PASSING), key: request.refId }
    })
    const { orders, made } = await draftLines(tools, context, drafts, body.into ?? [], 'purchasing.draftFromPlan')
    return {
      orders: orders.map((order) => ({ id: order.id, number: order.number, created: order.created, lineIds: order.lineIds, lineCount: order.lineCount })),
      lines: made.map((entry) => ({ requirementId: entry.key, purchaseOrderId: entry.purchaseOrderId, purchaseOrderLineId: entry.purchaseOrderLineId })),
    }
  })
  return result
}

// ---- undo -------------------------------------------------------------------------------------------------------------

export interface UndoDraftInput {
  /** The lines the draft made (its answer's `lines[].purchaseOrderLineId`). */
  readonly lines: readonly string[]
  /** The drafts the call made (its answer's orders with `created`): cancelled when the undo leaves them without a line. */
  readonly cancelOrderIds?: readonly string[] | undefined
}

/** purchasing.manage: the Undo of a "Draft PO" (see the module comment). */
export async function undoDraftFromPlan(caller: CommandCaller, body: UndoDraftInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  if (new Set(body.lines).size !== body.lines.length || body.lines.some((id) => !isUuid(id))) throw new ValidationError('A line is listed twice or is not an id.', [{ path: 'body/lines', message: 'Each line once.' }])
  const { result } = await command(caller, { name: 'purchasing.undoDraftFromPlan', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const lines = await tx.purchaseOrderLine.findMany({ where: { id: { in: [...body.lines] } }, select: { id: true, purchaseOrderId: true } })
    if (lines.length !== body.lines.length) throw new NotFoundError('Line not found.')
    const orderIds = [...new Set(lines.map((line) => line.purchaseOrderId))].sort()
    const out: { id: string; number: string; lineCount: number; cancelled: boolean }[] = []
    const reopened: string[] = []
    for (const orderId of orderIds) {
      const order = (await readOrder(tx, orderId))!
      assertMay(context, PURCHASING_MANAGE, order, 'Line')
      await lockDraft(tools, order)
      const own = lines.filter((line) => line.purchaseOrderId === orderId).map((line) => line.id)
      const removed = await removeLines(tools, order, own)
      reopened.push(...removed.reopened)
      await linesChanged(tools, order, { removed: own.length }, { action: 'purchasing.undoDraftFromPlan', before: { lines: removed.removed.map((line) => ({ lineId: line.id, line: lineAudit(line) })) }, after: { reopenedRequirementIds: removed.reopened } })
      const left = await tx.purchaseOrderLine.count({ where: { purchaseOrderId: orderId } })
      const cancel = left === 0 && (body.cancelOrderIds ?? []).includes(orderId)
      if (cancel) {
        const reason = 'Undo of a draft made from the plan: no line left.'
        await tx.purchaseOrder.update({ where: { id: orderId }, data: { status: 'CANCELLED', cancelledAt: now, cancelReason: reason }, select: { id: true } })
        tools.audit({ action: 'purchasing.cancel', recordType: 'PurchaseOrder', recordId: orderId, companyId: order.companyId, siteId: order.siteId, reason, before: { status: 'DRAFT' }, after: { status: 'CANCELLED', revokedLinkIds: [], reopenedRequirementIds: [], outboundId: null } })
        tools.emit({ type: 'purchase_order.cancelled', subject: orderId, companyId: order.companyId, siteId: order.siteId, payload: { purchaseOrderId: orderId, number: order.number, from: 'DRAFT', revokedLinkIds: [], outboundId: null } })
      }
      out.push({ id: orderId, number: order.number, lineCount: left, cancelled: cancel })
    }
    return { orders: out, reopenedRequirementIds: reopened }
  })
  return result
}
