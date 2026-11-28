import type { FactoryClient } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { PRODUCTION_STRUCTURES_RULES } from '@nexus/factory-domain/production/structures/permissions'
import { STRUCTURE_REFUSALS, structureOf, type StructureFrom } from '@nexus/factory-domain/production/structures/rules'
import { ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { refuse } from '../../people/employees/access'
import { mayOn, officeContextOf } from '../../sales/orders/access'
import { readOrder, type OrderRow } from '../order-teams/read'
import { isOpenStatus, isPrinted, madeLinesOf, namesFor, openOverridesOf, partyNames, readsAt, rulesOfCompany, structuresByIds, userNames } from './facts'

/**
 * One order's structure (owb-ss6 step 6.3; build/briefs/owb-ss6.md § Shape; design § 5zj C structSec, oplanModal): each made line
 * takes its own structure — chosen by hand for the order, else the first rule that fits, else the normal way — and keeps it at the
 * order's FIRST print (OrderLineStructureKept, written by the print command). From then on nothing changes it.
 *
 *   GET    /production/orders/:orderId/structure   each line: structure, rule, from, why, kept; the order's open structure by hand;
 *                                                  read by whoever sees the order (orders.view) or holds production.structures
 *                                                  .rules / .manage over its company and customer
 *   PUT    /production/orders/:orderId/structure   { structureId | null (the normal way), why }: the open one by hand is ended and
 *                                                  the new one written (an ended row never changes)
 *   DELETE /production/orders/:orderId/structure   back to the rules: the open one by hand is ended (none: nothing to do)
 *
 * PUT and DELETE need production.structures.rules over the order's company and customer, and only before the order's FIRST print
 * while it is not started (PENDING_APPROVAL, CONFIRMED). One audit row on the order (recordType SalesOrder). Refusals are 409s
 * with `refusal/<CODE>`: PRINTED, ORDER_STARTED, ORDER_STRUCTURE_NOT_OPEN.
 */

const NOT_FOUND = 'Sales order not found.'
const NOT_CHANGER = 'You may see this order’s structure but not change it: the owner and sales choose it.'

/** Who reads an order's structure. */
const seesOrderStructure = (context: OfficeContext, order: OrderRow): boolean => mayOn(context, ORDERS_VIEW, order) || readsAt(context, order)

/** The words of a line kept at the first print. */
const KEPT_WORDS: Readonly<Record<StructureFrom, string>> = Object.freeze({
  RULE: 'Kept at the first print: a rule gave it.',
  ORDER: 'Kept at the first print: chosen by hand for this order.',
  NORMAL: 'Kept at the first print: the normal way.',
})
const STARTED_WORDS = 'The work on this order started before it kept a structure: the normal way.'

/** The kept snapshot's own name of the structure, when it has one. */
const keptName = (snapshot: unknown): string | null => {
  const name = snapshot !== null && typeof snapshot === 'object' ? (snapshot as { name?: unknown }).name : undefined
  return typeof name === 'string' && name !== '' ? name : null
}

/** The answer of GET (and of PUT and DELETE) for one order the caller sees. */
export async function orderStructureAnswer(client: FactoryClient | CommandTx, context: OfficeContext, order: OrderRow) {
  const printed = await isPrinted(client, order.id)
  const started = printed || !isOpenStatus(order.status)
  const lines = await madeLinesOf(client, [order.id])
  const override = (await openOverridesOf(client, [order.id])).get(order.id) ?? null
  const kept = new Map((await client.orderLineStructureKept.findMany({ where: { salesOrderId: order.id }, select: { salesOrderLineId: true, structureId: true, ruleId: true, keptFrom: true, snapshot: true } })).map((row) => [row.salesOrderLineId, row]))
  const rules = started ? [] : await rulesOfCompany(client, order.companyId)
  const structures = await structuresByIds(client, [...rules.map((rule) => rule.structureId), override?.structureId ?? null, ...[...kept.values()].map((row) => row.structureId)])
  const names = namesFor(context, order.companyId, await partyNames(client, rules.map((rule) => rule.partyId)), structures)
  const by = override?.createdById ? ((await userNames(client, [override.createdById])).get(override.createdById) ?? 'Office') : 'Office'
  const structureOut = (structureId: string | null, name: string | null = null) => (structureId === null ? null : { id: structureId, name: name ?? structures.get(structureId)?.name ?? '' })
  return {
    orderId: order.id,
    printed,
    byHand: override ? { structureId: override.structureId, why: override.why, by, at: override.createdAt.toISOString() } : null,
    lines: lines.map((line) => {
      const keep = kept.get(line.id)
      if (keep) {
        const from = keep.keptFrom as StructureFrom
        return { salesOrderLineId: line.id, label: line.label, structure: structureOut(keep.structureId, keptName(keep.snapshot)), rule: keep.ruleId === null ? null : { id: keep.ruleId }, from, why: KEPT_WORDS[from], kept: true }
      }
      if (started) return { salesOrderLineId: line.id, label: line.label, structure: null, rule: null, from: 'NORMAL' as StructureFrom, why: STARTED_WORDS, kept: false }
      const taken = structureOf({ partyId: order.partyId, category: line.category }, rules, override, names)
      return { salesOrderLineId: line.id, label: line.label, structure: structureOut(taken.structureId), rule: taken.ruleId === null ? null : { id: taken.ruleId }, from: taken.from, why: taken.why, kept: false }
    }),
    may: { change: mayOn(context, PRODUCTION_STRUCTURES_RULES, order) && !started },
  }
}

/** GET /production/orders/:orderId/structure. */
export async function orderStructure(caller: CommandCaller, orderId: string) {
  const context = officeContextOf(caller)
  return caller.withClient(async (client) => {
    const order = await readOrder(client, orderId)
    if (!order || !seesOrderStructure(context, order)) throw new NotFoundError(NOT_FOUND)
    return orderStructureAnswer(client, context, order)
  })
}

/** The order the caller sees (else 404) and may choose the structure of (else 403). */
async function changeableOrder(caller: CommandCaller, context: OfficeContext, orderId: string): Promise<OrderRow> {
  const order = await caller.withClient((client) => readOrder(client, orderId))
  if (!order || !seesOrderStructure(context, order)) throw new NotFoundError(NOT_FOUND)
  if (!mayOn(context, PRODUCTION_STRUCTURES_RULES, order)) throw new ForbiddenError(NOT_CHANGER)
  return order
}

/** Under the order's lock: the order again, refused once printed or started. */
async function stillOpen(tx: CommandTx, orderId: string): Promise<OrderRow> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`factory.order-structure|${orderId}`}::text, 0))`
  const order = (await readOrder(tx, orderId))!
  if (await isPrinted(tx, orderId)) refuse('PRINTED', STRUCTURE_REFUSALS.PRINTED)
  if (!isOpenStatus(order.status)) refuse('ORDER_STARTED', STRUCTURE_REFUSALS.ORDER_STARTED)
  return order
}

/** PUT /production/orders/:orderId/structure. */
export async function putOrderStructure(caller: CommandCaller, orderId: string, body: { readonly structureId: string | null; readonly why: string }, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  await changeableOrder(caller, context, orderId)
  const { result } = await command(caller, { name: 'production.setOrderStructure', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const order = await stillOpen(tx, orderId)
    if (body.structureId !== null) {
      const structure = (await structuresByIds(tx, [body.structureId])).get(body.structureId)
      if (!structure || structure.companyId !== order.companyId || structure.closed) refuse('ORDER_STRUCTURE_NOT_OPEN', STRUCTURE_REFUSALS.ORDER_STRUCTURE_NOT_OPEN, 'structureId')
    }
    const current = (await openOverridesOf(tx, [orderId])).get(orderId) ?? null
    // The open one ends first (one open row per order: OrderStructureOverride_one_open).
    if (current) await tx.orderStructureOverride.update({ where: { id: current.id }, data: { endedAt: now, endedById: context.actorId }, select: { id: true } })
    const why = body.why.trim()
    await tx.orderStructureOverride.create({
      data: { id: newId(), companyId: order.companyId, partyId: order.partyId, salesOrderId: orderId, structureId: body.structureId, normalWay: body.structureId === null, why, createdAt: now, createdById: context.actorId },
      select: { id: true },
    })
    tools.audit({
      action: 'production.setOrderStructure',
      recordType: 'SalesOrder',
      recordId: orderId,
      companyId: order.companyId,
      before: current ? { byHand: { structureId: current.structureId, why: current.why } } : { byHand: null },
      after: { byHand: { structureId: body.structureId, why } },
    })
    return orderStructureAnswer(tx, context, order)
  })
  return result
}

/** DELETE /production/orders/:orderId/structure. */
export async function endOrderStructure(caller: CommandCaller, orderId: string, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const seen = await changeableOrder(caller, context, orderId)
  const open = await caller.withClient((client) => openOverridesOf(client, [orderId]))
  // Nothing by hand: the order follows the rules already.
  if (!open.has(orderId)) return caller.withClient((client) => orderStructureAnswer(client, context, seen))
  const { result } = await command(caller, { name: 'production.endOrderStructure', idempotencyKey, input: { orderId } }, async (tools) => {
    const { tx, now } = tools
    const order = await stillOpen(tx, orderId)
    const current = (await openOverridesOf(tx, [orderId])).get(orderId) ?? null
    if (current) await tx.orderStructureOverride.update({ where: { id: current.id }, data: { endedAt: now, endedById: context.actorId }, select: { id: true } })
    tools.audit({
      action: 'production.endOrderStructure',
      recordType: 'SalesOrder',
      recordId: orderId,
      companyId: order.companyId,
      before: { byHand: current ? { structureId: current.structureId, why: current.why } : null },
      after: { byHand: null, backToTheRules: true },
    })
    return orderStructureAnswer(tx, context, order)
  })
  return result
}
