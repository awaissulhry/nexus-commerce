import { THREADS_READ } from '@nexus/factory-domain/auth/permissions/catalogue'
import type { Actor } from '@nexus/factory-domain/core/permissions'
import { brandSupervisorChanged } from '@nexus/factory-domain/production-brand/events'
import { effectiveSupervisor, SUPERVISED_ORDER_STATES } from '@nexus/factory-domain/production-brand/supervisor'
import { customerDefaultsOf, orderSupervisorsOf } from '../../../modules/production/supervisor/resolver'
import { mayOnThread } from '../../threads/records'
import type { Draft, FanOutRule, RuleContext } from '../fan-out'

/**
 * B-PR-42b — the production supervisor is told (production plan §1, §3 "Supervisor"; lead pick L22; review fixes R-43, R-51,
 * R-60): ONE bell item ASSIGNMENT per `brand_production.supervisor_changed` and person — never one per order (one event is one
 * command's share of ONE customer: B-PR-42a, R-48):
 *
 *   ORDER   the person who supervises the named orders now (the one set, or — set back — the customer's default): "You are the
 *           production supervisor of order SO-0042" for one order, "… of 9 orders of <customer>" for several
 *   BRAND   the customer's new default, when he is a new one: "You are the production supervisor of 9 orders of <customer>" (the
 *           open orders that follow the default), "… of <customer>" when it has none open; the backup, when newly named, "You
 *           are the production backup of <customer>" (R-60: the backup is told too)
 *
 * THE WALL (PW-14): counted and told only over the records the person reads by his live roles NOW (threads.read over each
 * order's company and customer), re-checked per order; nothing when he reads none of them. Who made the change (the actor of
 * the command's audit row, found by the event's batch) is never told about it himself. Office only: the customer is never told
 * who supervises (R-41).
 */

const ORDER_SEARCH = 20

/** The command that emitted the event, by its batch: who made the change (an office person) and, for BRAND, the pair before. */
async function changeOf(context: RuleContext, payload: { readonly partyId: string; readonly scope: string; readonly batchId: string }) {
  const rows = await context.tx.auditLog.findMany({
    where: { recordType: payload.scope === 'BRAND' ? 'PortalSettings' : 'Party', recordId: payload.partyId },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
    take: ORDER_SEARCH,
    select: { actorId: true, audience: true, before: true, after: true },
  })
  const row = rows.find((entry) => entry.after && typeof entry.after === 'object' && (entry.after as Record<string, unknown>).batchId === payload.batchId)
  const before = row?.before && typeof row.before === 'object' ? (row.before as Record<string, unknown>) : null
  return {
    actorId: row && row.audience === 'OFFICE' ? row.actorId : null,
    found: row !== undefined,
    supervisorBefore: typeof before?.productionSupervisorId === 'string' ? before.productionSupervisorId : null,
    backupBefore: typeof before?.productionBackupId === 'string' ? before.productionBackupId : null,
  }
}

const reads = (actor: Actor, order: { readonly companyId: string; readonly partyId: string }): boolean => mayOnThread(actor, THREADS_READ, 'SalesOrder', { companyId: order.companyId, siteId: null, partyId: order.partyId })

/** He reads the customer's orders at every company it works with (its own, else every ACTIVE one: a default moves them all). */
async function readsCustomer(context: RuleContext, actor: Actor, party: { readonly id: string; readonly companyId: string | null }): Promise<boolean> {
  const companies = party.companyId !== null ? [party.companyId] : (await context.tx.company.findMany({ where: { status: 'ACTIVE' }, select: { id: true } })).map((row) => row.id)
  return companies.length > 0 && companies.every((companyId) => reads(actor, { companyId, partyId: party.id }))
}

export const PRODUCTION_SUPERVISOR_RULES: readonly FanOutRule[] = Object.freeze([
  {
    name: 'production.supervisorAssigned',
    events: ['brand_production.supervisor_changed'],
    async drafts(context: RuleContext, raw: unknown): Promise<Draft[]> {
      const payload = brandSupervisorChanged.payload.parse(raw)
      const party = await context.tx.party.findUnique({ where: { id: payload.partyId }, select: { id: true, companyId: true, legalName: true, tradeName: true } })
      if (!party) return []
      const change = await changeOf(context, payload)
      const customer = { type: 'Party', id: party.id, label: party.tradeName ?? party.legalName }
      const drafts: Draft[] = []
      const tell = (userId: string, draft: Pick<Draft, 'record' | 'companyId' | 'messageKey' | 'params'>) =>
        drafts.push({ userId, category: 'ASSIGNMENT', anchor: null, actorId: change.actorId, batchId: payload.batchId, ...draft, params: { actorId: change.actorId, ...draft.params } })

      // The orders the person supervises now among those the command moved (ORDER: the named ones; BRAND: those on the default).
      const defaults = await customerDefaultsOf(context.tx, [party.id])
      const customerDefault = defaults.get(party.id)?.supervisorId ?? null
      const target = payload.scope === 'ORDER' ? (payload.supervisorId ?? customerDefault) : payload.supervisorId
      const isNew = payload.scope === 'ORDER' || !change.found || change.supervisorBefore !== payload.supervisorId
      const reader = target !== null && isNew ? await context.reader(target) : null
      if (reader && target !== null) {
        const open = await context.tx.salesOrder.findMany({
          where: { partyId: party.id, status: { in: [...SUPERVISED_ORDER_STATES] }, ...(payload.scope === 'ORDER' ? { id: { in: payload.orderIds } } : {}) },
          select: { id: true, number: true, companyId: true, partyId: true },
          orderBy: [{ number: 'asc' }, { id: 'asc' }],
        })
        const own = await orderSupervisorsOf(context.tx, open.map((order) => order.id))
        const ownOf = (orderId: string): string | null => own.get(orderId) ?? null
        const his = open.filter((order) => effectiveSupervisor(ownOf(order.id), customerDefault).userId === target && (payload.scope === 'ORDER' || ownOf(order.id) === null) && reads(reader.actor, order))
        if (his.length === 1) tell(target, { record: { type: 'SalesOrder', id: his[0]!.id, label: his[0]!.number }, companyId: his[0]!.companyId, messageKey: 'notifications.production.supervisorOfOrder', params: {} })
        else if (his.length > 1) tell(target, { record: customer, companyId: his[0]!.companyId, messageKey: 'notifications.production.supervisorOfOrders', params: { count: his.length } })
        // The customer's default with no open order on it: told when he reads the customer's orders at every company it works with.
        else if (payload.scope === 'BRAND' && (await readsCustomer(context, reader.actor, party))) tell(target, { record: customer, companyId: party.companyId, messageKey: 'notifications.production.supervisorOfCustomer', params: {} })
      }

      // R-60: the backup, when newly named beside the supervisor (BRAND only: an order has no backup of its own).
      if (payload.scope === 'BRAND' && payload.backupId !== null && payload.backupId !== target && (change.found ? change.backupBefore !== payload.backupId : !payload.previousIds.includes(payload.backupId))) {
        const backup = await context.reader(payload.backupId)
        if (backup && (await readsCustomer(context, backup.actor, party))) tell(payload.backupId, { record: customer, companyId: party.companyId, messageKey: 'notifications.production.backupOfCustomer', params: {} })
      }
      return drafts
    },
  },
])
