import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import type { CogsEntryView, CogsWaitingView } from '@nexus/factory-domain/costing/cost-of-sales/contracts'
import { cogsKeys, negated, type CogsRefusal } from '@nexus/factory-domain/costing/cost-of-sales/rules'
import { COSTING_LEDGER_MANAGE, COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { ACCOUNTANT_WAITS } from '@nexus/factory-domain/costing/ppv/settings'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/materials/store'
import type { Reader } from '../actual/store'
import { actualSettingsOf, hardLockWords, refusalOf } from '../ppv/settings'
import { planShipment, writeEntries, type CogsPlan } from './post'
import { cogsViews, ENTRY_COLUMNS } from './reads'

/**
 * The writes of cost of goods sold (B-W2b-407; FIN-043): post a shipment's entries now (the catch-up of what the worker
 * does when it leaves: costing.ledger.manage over its company and customer) and reverse one entry with a reason; and the
 * worker's two moves (./handlers.ts): post a shipment that left, take back a shipment's live entries when the carrier
 * brings it back. Every refusal in words.
 */

const refused = (code: CogsRefusal, message: string): DomainError => new DomainError('conflict', message, [{ path: `refusal/${code}`, message }])

/** Why a plan cannot be written now (the company's switch, the shipment not left, a HARD lock today), or null. */
async function blockOf(db: Reader, plan: CogsPlan, now: Date): Promise<DomainError | null> {
  if (!(await actualSettingsOf(db, plan.companyId)).postingsOn) return refused('WAITS_FOR_ACCOUNTANT', ACCOUNTANT_WAITS)
  if (!plan.ready) return refused('NOT_LEFT', `Shipment ${plan.number} is ${plan.status}: its cost of goods sold posts when it leaves (SHIPPED).`)
  const locked = await hardLockWords(db, plan.companyId, businessDate(now))
  return locked ? refused('LOCKED', locked) : null
}

/** POST /costing/cost-of-sales/post */
export async function postShipment(caller: CommandCaller, shipmentId: string, idempotencyKey?: string): Promise<{ posted: CogsEntryView[]; waiting: CogsWaitingView[]; replayed: boolean }> {
  const actor = actorOf(contextOf(caller))
  const seen = isUuid(shipmentId) ? await caller.withClient((db) => db.shipment.findUnique({ where: { id: shipmentId }, select: { companyId: true, partyId: true } })) : null
  if (!seen || !can(actor, COSTING_VIEW, { companyId: seen.companyId, partyId: seen.partyId })) throw new NotFoundError('Shipment not found.')
  if (!can(actor, COSTING_LEDGER_MANAGE, { companyId: seen.companyId, partyId: seen.partyId })) throw new ForbiddenError()
  const { result, replayed } = await command(caller, { name: 'costing.postCostOfSales', idempotencyKey, input: { shipmentId } }, async (tools) => {
    const plan = (await planShipment(tools.tx, shipmentId, newId, tools.now))!
    const block = await blockOf(tools.tx, plan, tools.now)
    if (block) throw block
    let ids: string[]
    try {
      ids = await writeEntries(tools, plan)
    } catch (error) {
      throw refusalOf(error)
    }
    if (ids.length === 0) tools.audit({ action: 'costing.postCostOfSales', recordType: 'Shipment', recordId: shipmentId, companyId: plan.companyId, after: { posted: 0, waiting: plan.waiting.map((row) => row.code) } })
    const rows = await tools.tx.costOfSalesEntry.findMany({ where: { id: { in: ids } }, select: ENTRY_COLUMNS, orderBy: { id: 'asc' } })
    return { posted: await cogsViews(tools.tx, rows), waiting: plan.waiting }
  })
  return { ...result, replayed }
}

/** The reversal rows of live entries, inside the caller's command (a reversal waits for no switch). */
async function reverseInCommand(tools: CommandTools, ids: readonly string[], reason: string): Promise<string[]> {
  const { tx, now } = tools
  const rows = await tx.costOfSalesEntry.findMany({ where: { id: { in: [...ids] } }, select: { ...ENTRY_COLUMNS, invoiceLineId: true } })
  const taken = new Set((await tx.costOfSalesEntry.findMany({ where: { reversalOfId: { in: [...ids] } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const reversals = rows
    .filter((row) => row.reversalOfId === null && !taken.has(row.id))
    .map((row) => ({
      id: newId(),
      companyId: row.companyId,
      partyId: row.partyId,
      siteId: row.siteId,
      shipmentLineId: row.shipmentLineId,
      invoiceLineId: row.invoiceLineId,
      stockMoveId: row.stockMoveId,
      quantity: row.quantity.negated().toFixed(4),
      ...negated(row),
      currency: row.currency,
      postedAt: now,
      reversalOfId: row.id,
      reason,
      idempotencyKey: cogsKeys.reversal(row.id),
      createdAt: now,
      createdById,
    }))
  if (reversals.length > 0) {
    try {
      await tx.costOfSalesEntry.createMany({ data: reversals })
    } catch (error) {
      throw refusalOf(error)
    }
  }
  return reversals.map((row) => row.id)
}

/** POST /costing/cost-of-sales/:entryId/reverse */
export async function reverseEntry(caller: CommandCaller, entryId: string, reason: string, idempotencyKey?: string): Promise<{ entry: CogsEntryView; reversal: CogsEntryView; replayed: boolean }> {
  const actor = actorOf(contextOf(caller))
  const seen = isUuid(entryId) ? await caller.withClient((db) => db.costOfSalesEntry.findUnique({ where: { id: entryId }, select: { companyId: true, partyId: true } })) : null
  if (!seen || !can(actor, COSTING_VIEW, { companyId: seen.companyId, partyId: seen.partyId })) throw new NotFoundError('Cost of goods sold entry not found.')
  if (!can(actor, COSTING_LEDGER_MANAGE, { companyId: seen.companyId, partyId: seen.partyId })) throw new ForbiddenError()
  const { result, replayed } = await command(caller, { name: 'costing.reverseCostOfSales', idempotencyKey, input: { entryId, reason } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.costOfSalesEntry.findUniqueOrThrow({ where: { id: entryId }, select: ENTRY_COLUMNS })
    if (row.reversalOfId) throw refused('IS_REVERSAL', 'This entry takes back another one: it is not reversed in turn (post the shipment again).')
    const taken = await tx.costOfSalesEntry.findFirst({ where: { reversalOfId: entryId }, select: { postedAt: true, reason: true } })
    if (taken) throw refused('REVERSED_ALREADY', `This entry was taken back on ${businessDate(taken.postedAt)}${taken.reason ? ` (${taken.reason})` : ''}: an entry is reversed once.`)
    const locked = await hardLockWords(tx, row.companyId, businessDate(now))
    if (locked) throw refused('LOCKED', locked)
    const [reversalId] = await reverseInCommand(tools, [entryId], reason)
    const shipmentId = row.shipmentLineId ? (await tx.shipmentLine.findUniqueOrThrow({ where: { id: row.shipmentLineId }, select: { shipmentId: true } })).shipmentId : entryId
    const number = row.shipmentLineId ? ((await tx.shipment.findUnique({ where: { id: shipmentId }, select: { number: true } }))?.number ?? '') : ''
    tools.audit({ action: 'costing.reverseCostOfSales', recordType: 'CostOfSalesEntry', recordId: entryId, companyId: row.companyId, after: { reversalId, amount: markMoney('cost', -row.amount) }, reason })
    tools.emit({ type: 'cost_of_sales.posted', subject: shipmentId, companyId: row.companyId, payload: { shipmentId, number, entryIds: [reversalId!], reversals: 1 } })
    const views = await cogsViews(tx, await tx.costOfSalesEntry.findMany({ where: { id: { in: [entryId, reversalId!] } }, select: ENTRY_COLUMNS }))
    return { entry: views.find((view) => view.id === entryId)!, reversal: views.find((view) => view.id === reversalId)! }
  })
  return { ...result, replayed }
}

/** The worker when a shipment left: its entries, while the company's figures are on (a dry plan first: no empty command). */
export async function postForEvent(caller: CommandCaller, shipmentId: string, eventId: string): Promise<number> {
  const dry = await caller.withClient(async (db) => {
    const plan = await planShipment(db, shipmentId)
    return plan && plan.drafts.length > 0 && !(await blockOf(db, plan, new Date())) ? plan : null
  })
  if (!dry) return 0
  const { result } = await command(caller, { name: 'costing.postCostOfSales', idempotencyKey: `cogs-post:${eventId}`, input: { shipmentId }, causationId: eventId }, async (tools) => {
    const plan = (await planShipment(tools.tx, shipmentId, newId, tools.now))!
    const block = await blockOf(tools.tx, plan, tools.now)
    const written = block ? [] : await writeEntries(tools, plan)
    if (written.length === 0) tools.audit({ action: 'costing.postCostOfSales', recordType: 'Shipment', recordId: shipmentId, companyId: plan.companyId, after: { posted: 0, waits: block?.message ?? null } })
    return written.length
  })
  return result
}

/** The worker when the carrier brought a shipment back (its garments are in finished goods again): its live entries taken back. */
export async function reverseForEvent(caller: CommandCaller, shipmentId: string, eventId: string, reason: string): Promise<number> {
  const live = await caller.withClient(async (db) => {
    const rows = await db.costOfSalesEntry.findMany({ where: { shipmentLine: { shipmentId }, reversalOfId: null }, select: { id: true, companyId: true } })
    const taken = new Set((await db.costOfSalesEntry.findMany({ where: { reversalOfId: { in: rows.map((row) => row.id) } }, select: { reversalOfId: true } })).map((row) => row.reversalOfId!))
    return rows.filter((row) => !taken.has(row.id))
  })
  if (live.length === 0) return 0
  const { result } = await command(caller, { name: 'costing.reverseCostOfSales', idempotencyKey: `cogs-reverse:${eventId}`, input: { shipmentId, reason }, causationId: eventId }, async (tools) => {
    const reversalIds = await reverseInCommand(tools, live.map((row) => row.id), reason)
    const number = (await tools.tx.shipment.findUnique({ where: { id: shipmentId }, select: { number: true } }))?.number ?? ''
    tools.audit({ action: 'costing.reverseCostOfSales', recordType: 'Shipment', recordId: shipmentId, companyId: live[0]!.companyId, after: { reversalIds }, reason })
    if (reversalIds.length > 0) tools.emit({ type: 'cost_of_sales.posted', subject: shipmentId, companyId: live[0]!.companyId, payload: { shipmentId, number, entryIds: reversalIds, reversals: reversalIds.length } })
    return reversalIds.length
  })
  return result
}
