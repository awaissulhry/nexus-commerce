import { ConflictError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { PURCHASING_MANAGE, PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { STATUS_WORDS, type PurchaseOrderStatus } from '@nexus/factory-domain/purchasing/orders'
import { command, type CommandCaller, type CommandTools } from '../../core/command'
import { actorOf } from '../../core/context'
import { orderRequirement, proposalFor, type PurchaseProposal } from '../planning/hooks'
import { lineAudit, linesChanged, insertLine, itemFor, removeLines } from './lines'
import { assertBuyable, insertDraft } from './orders'
import { assertMay, officeContextOf, ORDER_COLUMNS, PARTY_COLUMNS, readOrder, type OrderRow } from './store'

/**
 * "Draft PO" from What to buy & make (B-W1-30; design 02: the Requirements grid's one-click Draft PO, the band's "Draft POs
 * for all open Buy lines", the Draft purchase orders pop-up; SCR-055): ONE command turns plan lines to buy into purchase
 * order lines, one line per plan line, grouped per supplier (and delivery site): into the supplier's open DRAFT for that
 * site (or the draft the caller names, or a new one), each plan line marked ORDERED with the line that buys it through
 * planning's hook in the same command. The quantity is the plan's suggestion in the purchase unit, already rounded to whole
 * units, the supplier's minimum and its steps (planning/buy, from the item's terms); the need date is the plan's; the price
 * the material's standard purchase price.
 *
 * Its Undo removes those lines again (each plan line opens again through the hook) and cancels the drafts the call made
 * when they are left without a line. A line named by an older (superseded) plan cannot be removed (409: the plan never
 * changes; the line is changed or the order cancelled).
 *
 * Two buyers drafting for one supplier and site wait for each other (an advisory lock per supplier and site), so they
 * share one open draft; each order touched is locked by its version.
 */

export interface DraftFromPlanInput {
  readonly lines: readonly { readonly id: string; readonly version: number; readonly supplierId?: string | undefined }[]
  /** Per supplier: the draft to add to, or null for a new one. Default: its open draft at the site, else a new one. */
  readonly into?: readonly { readonly supplierId: string; readonly purchaseOrderId: string | null }[] | undefined
}

interface Planned {
  readonly proposal: PurchaseProposal
  readonly version: number
  readonly companyId: string
  readonly supplierId: string
}

/** Locks one order's row for this command (its version moves): only a draft takes lines. */
async function lockDraft(tools: CommandTools, order: OrderRow): Promise<void> {
  const { count } = await tools.tx.purchaseOrder.updateMany({ where: { id: order.id, status: 'DRAFT' }, data: { version: { increment: 1 } } })
  if (count !== 1) {
    const now = await tools.tx.purchaseOrder.findUnique({ where: { id: order.id }, select: { status: true } })
    throw new InvalidStateError(`${order.number} is ${STATUS_WORDS[(now?.status ?? 'CANCELLED') as PurchaseOrderStatus]}: only a draft takes lines.`)
  }
}

/** purchasing.manage over each plan line's company, site and supplier. */
export async function draftFromPlan(caller: CommandCaller, body: DraftFromPlanInput, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const ids = body.lines.map((line) => line.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A plan line is listed twice.', [{ path: 'body/lines', message: 'Each line once.' }])
  const { result } = await command(caller, { name: 'purchasing.draftFromPlan', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const planned: Planned[] = []
    for (const [index, line] of body.lines.entries()) {
      const proposal = await proposalFor(tx, line.id)
      const run = await tx.planningRun.findUniqueOrThrow({ where: { id: proposal.runId }, select: { companyId: true, status: true } })
      const supplierId = line.supplierId ?? proposal.supplierId
      if (!can(actorOf(context), PURCHASING_VIEW, { companyId: run.companyId, siteId: proposal.siteId })) throw new NotFoundError('Plan line not found.')
      if (!supplierId) {
        const item = await tx.item.findUniqueOrThrow({ where: { id: proposal.itemId }, select: { code: true } })
        throw new ValidationError(`Pick a supplier first: ${item.code} has none.`, [{ path: `body/lines/${index}/supplierId`, message: 'Required: the material has no default supplier.' }])
      }
      assertMay(context, PURCHASING_MANAGE, { companyId: run.companyId, siteId: proposal.siteId, partyId: supplierId }, 'Plan line')
      if (run.status !== 'DONE') throw new ConflictError('A newer plan replaced this one: draft the lines of the latest plan.')
      planned.push({ proposal, version: line.version, companyId: run.companyId, supplierId })
    }

    // One group per company, site and supplier, in a fixed order (the advisory locks are taken in it).
    const groups = new Map<string, Planned[]>()
    for (const entry of planned) {
      const key = `${entry.companyId}|${entry.proposal.siteId}|${entry.supplierId}`
      groups.set(key, [...(groups.get(key) ?? []), entry])
    }
    const orders: { id: string; number: string; created: boolean; lineIds: string[]; lineCount: number }[] = []
    const made: { requirementId: string; purchaseOrderId: string; purchaseOrderLineId: string }[] = []
    for (const key of [...groups.keys()].sort()) {
      const entries = groups.get(key)!
      const { companyId, supplierId } = entries[0]!
      const siteId = entries[0]!.proposal.siteId
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.purchase-draft', ${context.tenantId}::uuid, ${siteId}::uuid, ${supplierId}::uuid), 0))`
      const party = await tx.party.findUnique({ where: { id: supplierId }, select: PARTY_COLUMNS })
      if (!party || (party.companyId !== null && party.companyId !== companyId)) throw new NotFoundError('Supplier not found.')
      assertBuyable(party, 'body/lines')

      const named = body.into?.find((entry) => entry.supplierId === supplierId)
      let order: OrderRow | null = null
      let created = false
      if (named?.purchaseOrderId) {
        order = await readOrder(tx, named.purchaseOrderId)
        if (!order || order.companyId !== companyId || order.siteId !== siteId || order.partyId !== supplierId) {
          throw new ValidationError(`The draft named for ${party.legalName} is not one of its orders for this site.`, [{ path: 'body/into', message: 'Name a draft of this supplier for the plan’s site.' }])
        }
      } else if (named === undefined) {
        order = await tx.purchaseOrder.findFirst({ where: { companyId, siteId, partyId: supplierId, status: 'DRAFT', currency: party.currency }, orderBy: { id: 'desc' }, select: ORDER_COLUMNS })
      }
      if (order) await lockDraft(tools, order)
      else {
        const draft = await insertDraft(tools, { companyId, siteId, party, header: {}, source: 'PLAN' })
        order = (await readOrder(tx, draft.id))!
        created = true
      }

      const lineIds: string[] = []
      for (const entry of entries) {
        const { proposal } = entry
        const item = await itemFor(tools, order, proposal.itemId)
        const line = await insertLine(tools, order, item, { itemColourId: proposal.itemColourId, quantity: proposal.quantity, uom: proposal.uom as Uom, needDate: proposal.needDate })
        await orderRequirement(tools, { requirementId: proposal.requirementId, purchaseOrderLineId: line.id, expectedVersion: entry.version })
        lineIds.push(line.id)
        made.push({ requirementId: proposal.requirementId, purchaseOrderId: order.id, purchaseOrderLineId: line.id })
        tools.audit({ action: 'purchasing.draftFromPlan', recordType: 'PurchaseOrderLine', recordId: line.id, companyId, siteId, after: { purchaseOrderId: order.id, requirementId: proposal.requirementId, runId: proposal.runId, line: lineAudit(line) } })
      }
      await linesChanged(tools, order, { added: lineIds.length }, { action: 'purchasing.draftFromPlan', after: { created, lineIds, requirementIds: entries.map((entry) => entry.proposal.requirementId) } })
      orders.push({ id: order.id, number: order.number, created, lineIds, lineCount: await tx.purchaseOrderLine.count({ where: { purchaseOrderId: order.id } }) })
    }
    return { orders, lines: made }
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
