import { localInstant } from '@nexus/factory-domain/calendars/dates'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Actor, Permission } from '@nexus/factory-domain/core/permissions'
import { BUSINESS_TIME_ZONE, businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PLANNING_MILESTONES_MANAGE, PLANNING_MILESTONES_OVERRIDE } from '@nexus/factory-domain/planning/milestones/permissions'
import {
  editRefusal,
  existsRefusal,
  GATE_LIMITS,
  gateStateOf,
  orderClosedRefusal,
  passesGate,
  passRefusal,
  reasonOf,
  removeRefusal,
  shapeRefusal,
  startBeforeRefusal,
  type GateFacts,
  type GateKind,
  type GateRefusal,
  type PassVia,
} from '@nexus/factory-domain/planning/milestones/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { officeContextOf } from '../access'
import type { GateView } from './contract'
import {
  databaseRefusal,
  GATE_COLUMNS,
  gateFacts,
  GateRefusedError,
  mayOn,
  mayOwn,
  officeGate,
  officeOrder,
  ORDER_COLUMNS,
  ownersOf,
  refuse,
  ROUND_COLUMNS,
  SYSTEM_PASSER,
  type GateRow,
  type OrderRow,
  type OrderScope,
  type Reader,
  type RoundRow,
} from './store'
import { readGateView, type WorldContext } from './world'

/**
 * A sales order's pre-production gates (B-W2b-263; PLN-186; design planning.milestones: "Mark done (date) and the gate it
 * opens", pop:gate-override "Start before the gate?"): add, change, remove, mark done (one or many in one command), start
 * before the gate with a reason. Each write is ONE command (its audit rows and `order_gate.changed`), at the version the
 * caller read; the database's guard (B-W2b-212's `factory_order_gate_guard`) holds the same rules and its words come back
 * as a 409, never a 500.
 *
 *   POST  /planning/milestones/gates                    planning.milestones.manage: a gate on an open order; a sample gate may
 *                                                       name a round of the order's styles for its customer (or internal); one
 *                                                       per kind and order (Other: many); a named round already approved passes
 *                                                       it at once (by its round)
 *   PATCH /planning/milestones/gates/:gateId            planning.milestones.manage: words, target date, round, planner — not once
 *                                                       passed
 *   POST  /planning/milestones/gates/:gateId/remove     planning.milestones.manage: only while neither passed nor started before
 *   POST  /planning/milestones/gates/pass               planning.milestones.manage: mark done on a day (today or before); a gate
 *                                                       that names a round only once the round is approved
 *   POST  /planning/milestones/gates/:gateId/start-before   planning.milestones.override: someone who is neither the gate's
 *                                                       planner nor its maker, with a reason (3 to 1000 characters)
 */

function requireOn(actor: Actor, permission: Permission, order: OrderScope, message: string): void {
  if (!mayOn(actor, permission, order)) throw new ForbiddenError(message)
}

const labelOf = (value: string | null | undefined): string | null => {
  const text = (value ?? '').replace(/\s+/g, ' ').trim()
  return text === '' ? null : text
}

const day = (value: Date | null): BusinessDate | null => (value ? value.toISOString().slice(0, 10) : null)
const dateOf = (value: BusinessDate | null): Date | null => (value ? new Date(`${value}T00:00:00.000Z`) : null)

/** The round a sample gate may name: of the order's company, its customer or internal, one of the order's styles, not cancelled. */
async function roundForOrder(db: Reader, order: OrderRow, roundId: string): Promise<RoundRow> {
  const round = await db.sampleRound.findUnique({ where: { id: roundId }, select: ROUND_COLUMNS })
  const styles = round ? await db.salesOrderLine.count({ where: { orderId: order.id, styleId: round.styleId } }) : 0
  if (!round || round.companyId !== order.companyId || (round.partyId !== null && round.partyId !== order.partyId) || styles === 0 || round.stage === 'CANCELLED') {
    throw new GateRefusedError({ code: 'ROUND_NOT_OF_ORDER', message: `That sample round is not one of order ${order.number}'s styles for its customer (or internal), or it was cancelled.` }, [{ path: 'body/sampleRoundId', message: 'Pick a round of the order.' }])
  }
  return round
}

async function ownerAllowed(db: Reader, tenantId: string, actorId: string, ownerId: string | null, order: OrderScope, now: Date): Promise<void> {
  if (ownerId === null || ownerId === actorId) return
  if (!(await mayOwn(db, tenantId, ownerId, order, now, PLANNING_MILESTONES_MANAGE))) {
    throw new GateRefusedError({ code: 'OWNER_NOT_ALLOWED', message: "The gate's planner must be an active person who may keep this order's gates." }, [{ path: 'body/ownerId', message: 'Pick a planner of this order.' }])
  }
}

function gateAudit(gate: Pick<GateRow, 'kind' | 'label' | 'targetDate' | 'sampleRoundId' | 'ownerId' | 'passedAt' | 'passedById' | 'overriddenAt' | 'overriddenById'>) {
  return {
    kind: gate.kind,
    label: gate.label,
    targetDate: day(gate.targetDate),
    sampleRoundId: gate.sampleRoundId,
    ownerId: gate.ownerId,
    passedAt: gate.passedAt ? toUtcIso(gate.passedAt) : null,
    passedById: gate.passedById,
    startedBeforeAt: gate.overriddenAt ? toUtcIso(gate.overriddenAt) : null,
    startedBeforeById: gate.overriddenById,
  }
}

type Change = 'ADDED' | 'EDITED' | 'REMOVED' | 'PASSED' | 'STARTED_BEFORE'

/** `order_gate.changed` for one gate (ids, codes and states only). */
export function emitGateChange(tools: CommandTools, order: Pick<OrderRow, 'id' | 'number' | 'companyId' | 'partyId'>, gate: { id: string; kind: string; passed: boolean; startedBefore: boolean }, change: Change, via: PassVia | null): void {
  tools.emit({
    type: 'order_gate.changed',
    subject: gate.id,
    companyId: order.companyId,
    payload: { gateId: gate.id, salesOrderId: order.id, number: order.number, partyId: order.partyId, kind: gate.kind as GateKind, change, via, passed: gate.passed, startedBefore: gate.startedBefore },
  })
}

function worldOf(caller: CommandCaller): WorldContext {
  const context = officeContextOf(caller)
  return { actor: actorOf(context), actorId: context.actorId, now: serverClock.now() }
}

const gateAnswer = async (caller: CommandCaller, gateId: string): Promise<{ gate: GateView }> => {
  const world = worldOf(caller)
  return { gate: await caller.withClient((db) => readGateView(db, world, gateId)) }
}

/** POST /planning/milestones/gates */
export async function addGate(
  caller: CommandCaller,
  body: { readonly salesOrderId: string; readonly kind: GateKind; readonly label?: string | null | undefined; readonly targetDate?: string | null | undefined; readonly sampleRoundId?: string | null | undefined; readonly ownerId?: string | null | undefined },
  idempotencyKey?: string,
): Promise<{ gate: GateView }> {
  const { context, actor, order } = await officeOrder(caller, body.salesOrderId)
  requireOn(actor, PLANNING_MILESTONES_MANAGE, order, "Your role does not keep the gates of this order's company or customer.")
  refuse(orderClosedRefusal({ number: order.number, orderStatus: order.status }))
  const label = labelOf(body.label)
  const now = serverClock.now()
  const round = body.sampleRoundId ? await caller.withClient((db) => roundForOrder(db, order, body.sampleRoundId!)) : null
  refuse(shapeRefusal(body.kind, label, round ? { number: round.number, decision: round.decision, kind: round.kind } : null))
  const ownerId = body.ownerId ?? null
  await caller.withClient((db) => ownerAllowed(db, context.tenantId, context.actorId, ownerId, order, now))
  const facts = { number: order.number, kind: body.kind }
  const { result } = await command(caller, { name: 'planning.milestones.addGate', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const current = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_COLUMNS })
    refuse(orderClosedRefusal({ number: current.number, orderStatus: current.status }))
    if (body.kind !== 'OTHER' && (await tx.orderGate.count({ where: { salesOrderId: order.id, kind: body.kind } })) > 0) refuse(existsRefusal(order.number, body.kind))
    const passedNow = round !== null && passesGate(round.decision)
    const id = newId()
    const data = {
      id,
      companyId: order.companyId,
      partyId: order.partyId,
      salesOrderId: order.id,
      kind: body.kind,
      label,
      targetDate: dateOf(body.targetDate ?? null),
      sampleRoundId: round?.id ?? null,
      ownerId,
      passedAt: passedNow ? tools.now : null,
      passedById: passedNow ? SYSTEM_PASSER : null,
      createdAt: tools.now,
      updatedAt: tools.now,
      createdById: context.actorId,
    }
    await tx.orderGate.create({ data, select: { id: true } })
    tools.audit({ action: 'planning.milestones.addGate', recordType: 'OrderGate', recordId: id, companyId: order.companyId, before: null, after: { salesOrderId: order.id, ...gateAudit({ ...data, overriddenAt: null, overriddenById: null }), ...(passedNow ? { passedBy: 'SAMPLE', round: round!.number } : {}) } })
    emitGateChange(tools, order, { id, kind: body.kind, passed: passedNow, startedBefore: false }, 'ADDED', passedNow ? 'SAMPLE' : null)
    return { id }
  }).catch((error) => databaseRefusal(error, facts))
  return gateAnswer(caller, result.id)
}

/** PATCH /planning/milestones/gates/:gateId */
export async function editGate(
  caller: CommandCaller,
  gateId: string,
  body: { readonly version: number; readonly label?: string | null | undefined; readonly targetDate?: string | null | undefined; readonly sampleRoundId?: string | null | undefined; readonly ownerId?: string | null | undefined },
  idempotencyKey?: string,
): Promise<{ gate: GateView }> {
  const { context, actor, gate, order } = await officeGate(caller, gateId)
  requireOn(actor, PLANNING_MILESTONES_MANAGE, order, "Your role does not keep the gates of this order's company or customer.")
  const now = serverClock.now()
  const facts = await caller.withClient((db) => gateFacts(db, gate, order))
  refuse(editRefusal(facts))
  const kind = gate.kind as GateKind
  const label = body.label !== undefined ? labelOf(body.label) : gate.label
  const roundId = body.sampleRoundId !== undefined ? body.sampleRoundId : gate.sampleRoundId
  const round = roundId ? (roundId === gate.sampleRoundId && body.sampleRoundId === undefined ? await caller.withClient((db) => db.sampleRound.findUniqueOrThrow({ where: { id: roundId }, select: ROUND_COLUMNS })) : await caller.withClient((db) => roundForOrder(db, order, roundId))) : null
  refuse(shapeRefusal(kind, label, round ? { number: round.number, decision: round.decision, kind: round.kind } : null))
  const ownerId = body.ownerId !== undefined ? body.ownerId : gate.ownerId
  if (body.ownerId !== undefined && body.ownerId !== gate.ownerId) await caller.withClient((db) => ownerAllowed(db, context.tenantId, context.actorId, ownerId, order, now))
  await command(caller, { name: 'planning.milestones.editGate', idempotencyKey, input: { gateId, ...body }, record: { type: 'OrderGate', id: gateId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const before = await tx.orderGate.findUniqueOrThrow({ where: { id: gateId }, select: GATE_COLUMNS })
    const current = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_COLUMNS })
    refuse(editRefusal(await gateFacts(tx, before, current)))
    const passedNow = before.passedAt === null && round !== null && passesGate(round.decision)
    const data = {
      label,
      targetDate: body.targetDate !== undefined ? dateOf(body.targetDate) : before.targetDate,
      sampleRoundId: round?.id ?? null,
      ownerId,
      ...(passedNow ? { passedAt: tools.now, passedById: SYSTEM_PASSER } : {}),
      updatedAt: tools.now,
    }
    await tx.orderGate.update({ where: { id: gateId }, data, select: { id: true } })
    const after = { ...before, ...data }
    tools.audit({ action: 'planning.milestones.editGate', recordType: 'OrderGate', recordId: gateId, companyId: order.companyId, before: gateAudit(before), after: { ...gateAudit(after), ...(passedNow ? { passedBy: 'SAMPLE', round: round!.number } : {}) } })
    emitGateChange(tools, order, { id: gateId, kind, passed: after.passedAt !== null, startedBefore: after.overriddenAt !== null }, passedNow ? 'PASSED' : 'EDITED', passedNow ? 'SAMPLE' : null)
    return null
  }).catch((error) => databaseRefusal(error))
  return gateAnswer(caller, gateId)
}

/** POST /planning/milestones/gates/:gateId/remove */
export async function removeGate(caller: CommandCaller, gateId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<{ removed: string }> {
  const { actor, gate, order } = await officeGate(caller, gateId)
  requireOn(actor, PLANNING_MILESTONES_MANAGE, order, "Your role does not keep the gates of this order's company or customer.")
  refuse(removeRefusal(await caller.withClient((db) => gateFacts(db, gate, order))))
  await command(caller, { name: 'planning.milestones.removeGate', idempotencyKey, input: { gateId, ...body }, record: { type: 'OrderGate', id: gateId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const before = await tx.orderGate.findUniqueOrThrow({ where: { id: gateId }, select: GATE_COLUMNS })
    const current = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_COLUMNS })
    refuse(removeRefusal(await gateFacts(tx, before, current)))
    await tx.orderGate.delete({ where: { id: gateId }, select: { id: true } })
    tools.audit({ action: 'planning.milestones.removeGate', recordType: 'OrderGate', recordId: gateId, companyId: order.companyId, before: { salesOrderId: order.id, ...gateAudit(before) }, after: null })
    emitGateChange(tools, order, { id: gateId, kind: before.kind, passed: false, startedBefore: false }, 'REMOVED', null)
    return null
  }).catch((error) => databaseRefusal(error))
  return { removed: gateId }
}

/** When a gate passed on `day` (today: now; a day before: its midday in the business zone). */
const passedInstant = (on: BusinessDate, today: BusinessDate, now: Date): Date => (on === today ? now : localInstant(on, 12 * 60, BUSINESS_TIME_ZONE))

/** POST /planning/milestones/gates/pass: mark one or many gates done in ONE command (all, or none with each refusal named). */
export async function passGates(caller: CommandCaller, body: { readonly gates: readonly { readonly id: string; readonly version: number }[]; readonly on?: string | undefined }, idempotencyKey?: string): Promise<{ passed: { id: string; version: number }[] }> {
  const context = officeContextOf(caller)
  const actor = actorOf(context)
  const ids = body.gates.map((entry) => entry.id)
  if (new Set(ids).size !== ids.length) throw new ValidationError('A gate is named twice.', [{ path: 'body/gates', message: 'Name each gate once.' }])
  const today = businessDate(serverClock.now())
  const on = body.on ?? today
  const check = async (db: Reader): Promise<Map<string, { gate: GateRow; order: OrderRow }>> => {
    const gates = await db.orderGate.findMany({ where: { id: { in: ids } }, select: GATE_COLUMNS })
    const orders = new Map((await db.salesOrder.findMany({ where: { id: { in: [...new Set(gates.map((gate) => gate.salesOrderId))] } }, select: ORDER_COLUMNS })).map((row) => [row.id, row]))
    const found = new Map(gates.flatMap((gate) => (orders.has(gate.salesOrderId) ? [[gate.id, { gate, order: orders.get(gate.salesOrderId)! }] as const] : [])))
    const refused: Issue[] = []
    let first: GateRefusal | null = null
    for (const [index, entry] of body.gates.entries()) {
      const row = found.get(entry.id)
      if (!row || !mayOn(actor, 'planning.view', row.order)) throw new NotFoundError('Gate not found.')
      if (!mayOn(actor, PLANNING_MILESTONES_MANAGE, row.order)) throw new ForbiddenError("Your role does not keep the gates of this order's company or customer.")
      if (row.gate.version !== entry.version) throw new ConflictError(`The gate of order ${row.order.number} changed since you read it (now version ${row.gate.version}): read it again.`)
      const refusal = passRefusal(await gateFacts(db, row.gate, row.order), on, today)
      if (refusal) {
        first ??= refusal
        refused.push({ path: `gates/${index}/${refusal.code}`, message: refusal.message })
      }
    }
    if (first) throw new GateRefusedError(first, refused)
    return found
  }
  await caller.withClient(check)
  const { result } = await command(caller, { name: 'planning.milestones.passGates', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    const found = await check(tx)
    const passedAt = passedInstant(on, today, tools.now)
    const passed: { id: string; version: number }[] = []
    for (const entry of body.gates) {
      const { gate, order } = found.get(entry.id)!
      const { count } = await tx.orderGate.updateMany({ where: { id: gate.id, version: entry.version }, data: { passedAt, passedById: context.actorId, version: entry.version + 1, updatedAt: tools.now } })
      if (count !== 1) throw new ConflictError(`The gate of order ${order.number} changed meanwhile: read it again.`)
      tools.audit({ action: 'planning.milestones.passGate', recordType: 'OrderGate', recordId: gate.id, companyId: order.companyId, before: { passedAt: null }, after: { passedAt: toUtcIso(passedAt), passedById: context.actorId, passedOn: on } })
      emitGateChange(tools, order, { id: gate.id, kind: gate.kind, passed: true, startedBefore: gate.overriddenAt !== null }, 'PASSED', 'OFFICE')
      passed.push({ id: gate.id, version: entry.version + 1 })
    }
    return { passed }
  }).catch((error) => databaseRefusal(error))
  return result
}

/** POST /planning/milestones/gates/:gateId/start-before: the order's work may start before this gate, with a reason. */
export async function startBefore(caller: CommandCaller, gateId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ gate: GateView }> {
  const { context, actor, gate, order } = await officeGate(caller, gateId)
  requireOn(actor, PLANNING_MILESTONES_OVERRIDE, order, "Starting before a gate is for a role that may let this order's work start early (a production manager).")
  const reason = reasonOf(body.reason)
  if (reason === null) throw new ValidationError(`Say why the work starts before the gate (${GATE_LIMITS.reasonMin} to ${GATE_LIMITS.reason} characters).`, [{ path: 'body/reason', message: 'Say why it starts before the gate.' }])
  refuse(startBeforeRefusal(await caller.withClient((db) => gateFacts(db, gate, order)), context.actorId))
  await command(caller, { name: 'planning.milestones.startBefore', idempotencyKey, input: { gateId, ...body }, record: { type: 'OrderGate', id: gateId, expectedVersion: body.version } }, async (tools) => {
    const { tx } = tools
    const before = await tx.orderGate.findUniqueOrThrow({ where: { id: gateId }, select: GATE_COLUMNS })
    const current = await tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: ORDER_COLUMNS })
    refuse(startBeforeRefusal(await gateFacts(tx, before, current), context.actorId))
    await tx.orderGate.update({ where: { id: gateId }, data: { overriddenAt: tools.now, overriddenById: context.actorId, overrideReason: reason, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'planning.milestones.startBefore', recordType: 'OrderGate', recordId: gateId, companyId: order.companyId, before: { state: gateStateOf(before) }, after: { state: 'STARTED_BEFORE', startedBeforeAt: toUtcIso(tools.now), startedBeforeById: context.actorId, kind: before.kind, salesOrderId: order.id }, reason })
    emitGateChange(tools, order, { id: gateId, kind: before.kind, passed: false, startedBefore: true }, 'STARTED_BEFORE', null)
    return null
  }).catch((error) => databaseRefusal(error))
  return gateAnswer(caller, gateId)
}

/** GET /planning/milestones/orders/:salesOrderId/choices: what the Add gate / Change gate dialog offers for this order. */
export async function gateChoices(caller: CommandCaller, salesOrderId: string) {
  const { context, order } = await officeOrder(caller, salesOrderId)
  const now = serverClock.now()
  return caller.withClient(async (db) => {
    const [kinds, styles] = await Promise.all([
      db.orderGate.findMany({ where: { salesOrderId }, select: { kind: true } }),
      db.salesOrderLine.findMany({ where: { orderId: salesOrderId }, select: { styleId: true }, distinct: ['styleId'] }),
    ])
    const styleIds = styles.map((row) => row.styleId)
    const rounds = styleIds.length
      ? await db.sampleRound.findMany({
          where: { companyId: order.companyId, styleId: { in: styleIds }, OR: [{ partyId: order.partyId }, { partyId: null }], stage: { not: 'CANCELLED' } },
          select: { ...ROUND_COLUMNS, style: { select: { id: true, code: true } } },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 100,
        })
      : []
    const owners = await ownersOf(db, context.tenantId, order, now, PLANNING_MILESTONES_MANAGE)
    return {
      order: { id: order.id, number: order.number, kinds: [...new Set(kinds.map((row) => row.kind as GateKind))] },
      rounds: rounds.map((row) => ({ id: row.id, number: row.number, kind: row.kind, roundNo: row.roundNo, decision: row.decision, stage: row.stage, style: row.style })),
      owners: owners.map((person) => ({ ...person, me: person.id === context.actorId })),
    }
  })
}

// ---- passed by their events (the worker's handlers, ./follow.ts) ---------------------------------------------------------

/** Inside a system command: passes these WAITING gates by their event (the system as the one who passed), each audited. */
export async function passBySystemInCommand(tools: CommandTools, gateIds: readonly string[], via: 'SAMPLE' | 'LOT', cause: Record<string, string>): Promise<string[]> {
  const { tx } = tools
  const passed: string[] = []
  for (const gateId of gateIds) {
    const gate = await tx.orderGate.findUnique({ where: { id: gateId }, select: GATE_COLUMNS })
    if (!gate || gate.passedAt !== null) continue
    const order = await tx.salesOrder.findUnique({ where: { id: gate.salesOrderId }, select: ORDER_COLUMNS })
    if (!order) continue
    const facts: GateFacts = await gateFacts(tx, gate, order)
    if (passRefusal(facts, businessDate(tools.now), businessDate(tools.now))) continue
    const { count } = await tx.orderGate.updateMany({ where: { id: gate.id, version: gate.version, passedAt: null }, data: { passedAt: tools.now, passedById: SYSTEM_PASSER, version: gate.version + 1, updatedAt: tools.now } })
    if (count !== 1) continue
    tools.audit({ action: 'planning.milestones.passGate', recordType: 'OrderGate', recordId: gate.id, companyId: order.companyId, before: { passedAt: null }, after: { passedAt: toUtcIso(tools.now), passedBy: via, ...cause }, reason: `Passed by its event: ${via === 'SAMPLE' ? `sample round ${facts.round?.number ?? ''} approved` : 'every leather lot reserved for the order released'}.` })
    emitGateChange(tools, order, { id: gate.id, kind: gate.kind, passed: true, startedBefore: gate.overriddenAt !== null }, 'PASSED', via)
    passed.push(gate.id)
  }
  return passed
}

