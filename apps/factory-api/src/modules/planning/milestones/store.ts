import type { Prisma } from '@nexus/factory-db'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Actor, type Permission } from '@nexus/factory-domain/core/permissions'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { existsRefusal, type GateFacts, type GateKind, type GateRefusal } from '@nexus/factory-domain/planning/milestones/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf, SYSTEM_ACTOR_ID, type OfficeContext } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { officeContextOf } from '../access'
import type { Reader } from '../store'

/**
 * Time & action's rows (B-W2b-263; factory-db samples.prisma `OrderGate`, B-W2b-212): the refusal every gate write throws in
 * words with its code, the database's own refusals said the same way (never a 500), who may act on an order's gates (can()
 * over the order's company and customer: planning.view to see, the write's permission to act), the columns every read
 * names, and the people who may own a gate.
 */

export type { Reader }

/** A gate write refused in words: 409 `conflict` with the issue `refusal/<CODE>`. */
export class GateRefusedError extends ConflictError {
  override name = 'GateRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: GateRefusal, more: readonly Issue[] = []) {
    super(refusal.message)
    this.issues = [...more, { path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: GateRefusal | null): void => {
  if (refusal) throw new GateRefusedError(refusal)
}

/**
 * The database's refusals of an OrderGate write (its guard raises check_violation with words that start "planning: "; the
 * one-gate-per-kind index raises a unique violation): a 409 in words, never a 500. Anything else is thrown as it is.
 */
export function databaseRefusal(error: unknown, facts?: { readonly number: string; readonly kind: GateKind }): never {
  const original = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if (original?.originalCode === '23514' && typeof original.originalMessage === 'string' && original.originalMessage.startsWith('planning: ')) {
    const words = original.originalMessage.slice('planning: '.length)
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  if ((error as { code?: unknown } | null)?.code === 'P2002' || original?.originalCode === '23505') {
    if (facts) throw new GateRefusedError(existsRefusal(facts.number, facts.kind))
    throw new ConflictError('Someone changed these gates at the same moment: read them again.')
  }
  throw error
}

export const GATE_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  salesOrderId: true,
  kind: true,
  label: true,
  targetDate: true,
  sampleRoundId: true,
  ownerId: true,
  passedAt: true,
  passedById: true,
  overriddenAt: true,
  overriddenById: true,
  overrideReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.OrderGateSelect
export type GateRow = Prisma.OrderGateGetPayload<{ select: typeof GATE_COLUMNS }>

export const ORDER_COLUMNS = { id: true, number: true, companyId: true, partyId: true, status: true, promiseDate: true, customerRef: true } as const satisfies Prisma.SalesOrderSelect
export type OrderRow = Prisma.SalesOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

export const ROUND_COLUMNS = { id: true, number: true, kind: true, decision: true, stage: true, companyId: true, partyId: true, styleId: true, roundNo: true } as const satisfies Prisma.SampleRoundSelect
export type RoundRow = Prisma.SampleRoundGetPayload<{ select: typeof ROUND_COLUMNS }>

/** A gate passed by its event (a sample round's approval, the leather's release) names the system as the one who passed it. */
export const SYSTEM_PASSER = SYSTEM_ACTOR_ID

export type OrderScope = { readonly companyId: string; readonly partyId: string }
const scopeOf = (row: OrderScope) => ({ companyId: row.companyId, partyId: row.partyId })
export const mayOn = (actor: Actor, permission: Permission, row: OrderScope): boolean => can(actor, permission, scopeOf(row))

/** The permission the caller lacks (null: holds it), for an action's `needs`. */
export const lacking = (actor: Actor, permission: Permission, row: OrderScope): Permission | null => (mayOn(actor, permission, row) ? null : permission)

export const action = (needs: Permission | null, refusal: GateRefusal | null) => ({ allowed: needs === null && refusal === null, refusal, needs })

/** The order the office caller plans for (planning.view over its company and customer, else not found). */
export async function officeOrder(caller: CommandCaller, salesOrderId: string): Promise<{ context: OfficeContext; actor: Actor; order: OrderRow }> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const order = isUuid(salesOrderId) ? await caller.withClient((db) => db.salesOrder.findUnique({ where: { id: salesOrderId }, select: ORDER_COLUMNS })) : null
  if (!order || !mayOn(actor, PLANNING_VIEW, order)) throw new NotFoundError('Sales order not found.')
  return { context, actor, order }
}

/** The gate the office caller sees (planning.view over its order's company and customer, else not found), with its order. */
export async function officeGate(caller: CommandCaller, gateId: string): Promise<{ context: OfficeContext; actor: Actor; gate: GateRow; order: OrderRow }> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const found = isUuid(gateId)
    ? await caller.withClient(async (db) => {
        const gate = await db.orderGate.findUnique({ where: { id: gateId }, select: GATE_COLUMNS })
        if (!gate) return null
        const order = await db.salesOrder.findUnique({ where: { id: gate.salesOrderId }, select: ORDER_COLUMNS })
        return order ? { gate, order } : null
      })
    : null
  if (!found || !mayOn(actor, PLANNING_VIEW, found.order)) throw new NotFoundError('Gate not found.')
  return { context, actor, ...found }
}

/** The facts the rules read about one gate (its order's status, its round's decision). */
export async function gateFacts(db: Reader, gate: GateRow, order: Pick<OrderRow, 'number' | 'status'>): Promise<GateFacts> {
  const round = gate.sampleRoundId ? await db.sampleRound.findUnique({ where: { id: gate.sampleRoundId }, select: { number: true, decision: true, kind: true } }) : null
  return {
    number: order.number,
    kind: gate.kind as GateKind,
    orderStatus: order.status,
    passedAt: gate.passedAt,
    overriddenAt: gate.overriddenAt,
    ownerId: gate.ownerId,
    createdById: gate.createdById,
    round: round ? { number: round.number, decision: round.decision, kind: round.kind } : null,
  }
}

/** People by id: display names (inside one gate only). */
export async function namesOf(db: Reader, ids: Iterable<string | null>): Promise<Map<string, string>> {
  const wanted = [...new Set([...ids].filter((value): value is string => value !== null && value !== SYSTEM_ACTOR_ID && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/** The most people the owners' choice reads (by name). */
export const OWNERS_MAX = 500

/** Whether a person may own a gate of this order: ACTIVE, and keeps gates over its company and customer (their live roles). */
export async function mayOwn(db: Reader, tenantId: string, userId: string, row: OrderScope, now: Date, permission: Permission): Promise<boolean> {
  const user = await db.user.findFirst({ where: { id: userId, status: 'ACTIVE' }, select: { id: true } })
  if (!user) return false
  const actor: Actor = { audience: 'office', tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(db, userId, now), true) }
  return mayOn(actor, permission, row)
}

/** The ACTIVE people who may own a gate of this order (by name), at most OWNERS_MAX looked at. */
export async function ownersOf(db: Reader, tenantId: string, row: OrderScope, now: Date, permission: Permission): Promise<{ id: string; name: string }[]> {
  const users = await db.user.findMany({ where: { status: 'ACTIVE' }, orderBy: [{ displayName: 'asc' }, { id: 'asc' }], take: OWNERS_MAX, select: { id: true, displayName: true } })
  const people: { id: string; name: string }[] = []
  for (const user of users) if (await mayOwn(db, tenantId, user.id, row, now, permission)) people.push({ id: user.id, name: user.displayName })
  return people
}
