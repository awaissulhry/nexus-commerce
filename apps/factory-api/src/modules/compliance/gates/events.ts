import type { FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { CERTIFICATES_VIEW } from '@nexus/factory-domain/compliance/certificates/permissions'
import { overrideRefusal } from '@nexus/factory-domain/compliance/gates/override'
import { GATES_OVERRIDE } from '@nexus/factory-domain/compliance/requirements/permissions'
import { COMPLIANCE_GATES, GATE_WORDS, type ComplianceGate } from '@nexus/factory-domain/compliance/requirements/rules'
import { DomainError, ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { COMMAND_SETTINGS, runCommand, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { namesFor, officeOf, rulesClock, rulesGuarded, type Reader } from '../register-of-rules/common'
import { overridesFor, readGateStyle } from './facts'
import { decideGate, shipmentTargets } from './gate'
import { workOrderGate } from './at-steps'

/**
 * Gate refusals and overrides (B-W2b-254; PRD-272; design compliance.status › cs-gates "Gate refusals" and cs-override
 * "Override a gate"; B-W2b-216's GateEvent, append-only):
 *
 *   GET  /compliance/gates/events                   the feed: every refusal and override of the last days, newest first,
 *                                                   with where (the work order or shipment, its site), what (style,
 *                                                   colour, size, market), the reason sentence, cleared / still blocked /
 *                                                   overridden, and whether the reader may override it
 *   POST /compliance/gates/events/:eventId/override  a person whose role the requirement names lifts one refusal for its
 *                                                   subject until a time (at most the requirement's days), with a reason
 *                                                   and a fresh step-up; never at a gate the law locks
 *   GET  /compliance/gates/check                    the gate's answer now for a work order or a shipment, line by line
 *                                                   (the GateExplainer), without recording anything
 *
 * A refusal row names no person (a floor worker's name stays inside the work order's own record, W1); an override names
 * its office person and the role that allowed it. No figure per person anywhere.
 */

const DAY_MS = 24 * 60 * 60 * 1000
const EVENT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  gate: true,
  subjectType: true,
  subjectId: true,
  outcome: true,
  requirementId: true,
  styleId: true,
  marketCode: true,
  reason: true,
  explanation: true,
  refusedEventId: true,
  overrideUntil: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.GateEventSelect
type EventRow = Prisma.GateEventGetPayload<{ select: typeof EVENT_SELECT }>

const asObject = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {})

/** The live role keys of a person over a company (any of the person's office assignments that reaches it). */
async function rolesOver(db: Reader, userId: string, companyId: string, now: Date): Promise<string[]> {
  const held = await heldRoles(db, userId, now)
  return [...new Set(held.filter((assignment) => assignment.scope.allCompanies || assignment.scope.companyIds.includes(companyId)).map((assignment) => assignment.roleKey))].sort()
}

/** Has the subject passed this gate since the refusal (released, labelled, released by quality, shipped)? */
async function passedSince(db: Reader, row: Pick<EventRow, 'gate' | 'subjectType' | 'subjectId' | 'createdAt'>): Promise<boolean> {
  switch (row.gate as ComplianceGate) {
    case 'WORK_ORDER_RELEASE': {
      const workOrder = await db.workOrder.findUnique({ where: { id: row.subjectId }, select: { releasedAt: true } })
      return !!workOrder?.releasedAt && workOrder.releasedAt.getTime() >= row.createdAt.getTime()
    }
    case 'LABEL_PRINT':
      return (await db.garmentLabelPrint.count({ where: { workOrderId: row.subjectId, createdAt: { gte: row.createdAt } } })) > 0
    case 'FINAL_RELEASE':
      return (await db.qualityRelease.count({ where: { workOrderId: row.subjectId, releasedAt: { gte: row.createdAt } } })) > 0
    case 'SHIPMENT': {
      const shipment = await db.shipment.findUnique({ where: { id: row.subjectId }, select: { status: true, shippedAt: true } })
      return !!shipment && (shipment.status === 'SHIPPED' || shipment.status === 'DELIVERED') && !!shipment.shippedAt && shipment.shippedAt.getTime() >= row.createdAt.getTime()
    }
  }
}

export interface FeedQuery {
  readonly days?: number | undefined
  readonly gate?: ComplianceGate | undefined
  readonly outcome?: 'REFUSED' | 'OVERRIDDEN' | undefined
  readonly subjectType?: 'WorkOrder' | 'Shipment' | undefined
  readonly subjectId?: string | undefined
  readonly limit?: number | undefined
}

/** GET /compliance/gates/events — the Gate refusals feed (7 days by default, at most 90; at most 200 rows). */
export async function gateFeed(request: FastifyRequest, query: FeedQuery) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const now = rulesClock().now()
  const days = Math.min(Math.max(query.days ?? 7, 1), 90)
  const limit = Math.min(Math.max(query.limit ?? 100, 1), 200)
  return request.withClient(async (db) => {
    const rows = await db.gateEvent.findMany({
      where: {
        AND: [
          scopeWhere(actor, CERTIFICATES_VIEW, { company: 'companyId' }) as Prisma.GateEventWhereInput,
          { createdAt: { gte: new Date(now.getTime() - days * DAY_MS) } },
          query.gate ? { gate: query.gate } : {},
          query.outcome ? { outcome: query.outcome } : {},
          query.subjectType ? { subjectType: query.subjectType } : {},
          query.subjectId ? { subjectId: query.subjectId } : {},
        ],
      },
      select: EVENT_SELECT,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    })
    const requirementIds = [...new Set(rows.map((row) => row.requirementId))]
    const requirements = new Map(
      (requirementIds.length > 0
        ? await db.complianceRequirement.findMany({ where: { id: { in: requirementIds } }, select: { id: true, code: true, name: true, legalReference: true, lockedBlocks: true, blocks: true, overrideRoleKeys: true, overrideMaxDays: true, status: true, switchedOn: true } })
        : []
      ).map((entry) => [entry.id, entry]),
    )
    const workOrderIds = [...new Set(rows.filter((row) => row.subjectType === 'WorkOrder').map((row) => row.subjectId))]
    const shipmentIds = [...new Set(rows.filter((row) => row.subjectType === 'Shipment').map((row) => row.subjectId))]
    const workOrders = new Map((workOrderIds.length > 0 ? await db.workOrder.findMany({ where: { id: { in: workOrderIds } }, select: { id: true, number: true, status: true } }) : []).map((entry) => [entry.id, entry]))
    const shipments = new Map((shipmentIds.length > 0 ? await db.shipment.findMany({ where: { id: { in: shipmentIds } }, select: { id: true, number: true, status: true } }) : []).map((entry) => [entry.id, entry]))
    const siteIds = [...new Set(rows.flatMap((row) => (row.siteId ? [row.siteId] : [])))]
    const sites = new Map((siteIds.length > 0 ? await db.site.findMany({ where: { id: { in: siteIds } }, select: { id: true, code: true } }) : []).map((entry) => [entry.id, entry.code]))
    const styleIds = [...new Set(rows.flatMap((row) => (row.styleId ? [row.styleId] : [])))]
    const styles = new Map((styleIds.length > 0 ? await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } }) : []).map((entry) => [entry.id, entry.code]))
    // Overrides of these refusals (any age: an override of an older refusal still says it was lifted).
    const refusalIds = rows.filter((row) => row.outcome === 'REFUSED').map((row) => row.id)
    const overrides = refusalIds.length > 0 ? await db.gateEvent.findMany({ where: { refusedEventId: { in: refusalIds }, outcome: 'OVERRIDDEN' }, select: EVENT_SELECT, orderBy: [{ createdAt: 'desc' }] }) : []
    const overrideRows = rows.filter((row) => row.outcome === 'OVERRIDDEN')
    const person = await namesFor(db, [...overrides, ...overrideRows].map((row) => row.createdById))
    const mayOverrideAny = can(actor, GATES_OVERRIDE)
    const myRoles = new Map<string, string[]>()
    const rolesFor = async (companyId: string) => {
      if (!myRoles.has(companyId)) myRoles.set(companyId, await rolesOver(db, context.actorId, companyId, now))
      return myRoles.get(companyId)!
    }
    const out = []
    for (const row of rows) {
      const requirement = requirements.get(row.requirementId)
      const subject = row.subjectType === 'WorkOrder' ? workOrders.get(row.subjectId) : row.subjectType === 'Shipment' ? shipments.get(row.subjectId) : undefined
      const explanation = asObject(row.explanation)
      const ofThis = overrides.filter((entry) => entry.refusedEventId === row.id)
      const inForce = ofThis.find((entry) => entry.overrideUntil && entry.overrideUntil.getTime() > now.getTime()) ?? null
      const locked = !!requirement && requirement.lockedBlocks.includes(row.gate)
      let state: 'BLOCKED' | 'CLEARED' | 'OVERRIDDEN' | 'OVERRIDE' = 'OVERRIDE'
      if (row.outcome === 'REFUSED') state = inForce ? 'OVERRIDDEN' : (await passedSince(db, row)) ? 'CLEARED' : 'BLOCKED'
      const roles = row.outcome === 'REFUSED' && state === 'BLOCKED' && mayOverrideAny ? await rolesFor(row.companyId) : []
      const mayOverride =
        state === 'BLOCKED' &&
        !!requirement &&
        !locked &&
        requirement.status === 'ACTIVE' &&
        requirement.switchedOn &&
        requirement.blocks.includes(row.gate) &&
        can(actor, GATES_OVERRIDE, { companyId: row.companyId }) &&
        roles.some((role) => requirement.overrideRoleKeys.includes(role))
      out.push({
        id: row.id,
        at: toUtcIso(row.createdAt),
        gate: row.gate as ComplianceGate,
        place: GATE_WORDS[row.gate as ComplianceGate].place,
        outcome: row.outcome as 'REFUSED' | 'OVERRIDDEN',
        subject: { type: row.subjectType, id: row.subjectId, number: subject?.number ?? null, status: subject?.status ?? null },
        site: row.siteId ? { id: row.siteId, code: sites.get(row.siteId) ?? null } : null,
        style: row.styleId ? { id: row.styleId, code: styles.get(row.styleId) ?? null } : null,
        colourway: typeof explanation.colourway === 'string' ? explanation.colourway : null,
        size: typeof explanation.size === 'string' ? explanation.size : null,
        marketCode: row.marketCode,
        requirement: requirement
          ? { id: requirement.id, code: requirement.code, name: requirement.name, legalReference: requirement.legalReference, locked, overrideRoleKeys: requirement.overrideRoleKeys, overrideMaxDays: requirement.overrideMaxDays }
          : { id: row.requirementId, code: '?', name: '?', legalReference: '', locked, overrideRoleKeys: [], overrideMaxDays: 0 },
        reason: row.reason,
        explanation,
        state,
        refusedEventId: row.refusedEventId,
        overrideUntil: row.overrideUntil ? toUtcIso(row.overrideUntil) : null,
        // An override names its office person; a refusal names nobody (a floor worker stays inside the work order's record).
        by: row.outcome === 'OVERRIDDEN' ? person(row.createdById) : null,
        overrides: ofThis.map((entry) => ({ id: entry.id, at: toUtcIso(entry.createdAt), until: entry.overrideUntil ? toUtcIso(entry.overrideUntil) : null, reason: entry.reason, by: person(entry.createdById), inForce: entry === inForce })),
        mayOverride,
      })
    }
    return { events: out, days, asOf: toUtcIso(now) }
  })
}

export interface OverrideBody {
  readonly reason: string
  readonly until: string
}

/**
 * POST /compliance/gates/events/:eventId/override (compliance.gates.override + a role the requirement names; step-up
 * first: `stepUp` throws 403 `stepUp` without a fresh one; `stepUpAt` is the session's). One command: the OVERRIDDEN
 * event naming the refusal, the audit row on the subject (its reason), `compliance_gates.overridden`. A database refusal
 * (a locked gate, the floor, a step-up older than 15 minutes) answers 409 in words, never 500.
 */
export async function overrideRefusalOf(caller: CommandCaller, eventId: string, body: OverrideBody, options: { readonly stepUp: () => void; readonly stepUpAt: () => Date | null; readonly idempotencyKey?: string | undefined }) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const known = await caller.withClient((db) => db.gateEvent.findUnique({ where: { id: eventId }, select: EVENT_SELECT }))
  if (!known || !can(actor, CERTIFICATES_VIEW, { companyId: known.companyId })) throw new NotFoundError('Gate event not found.')
  if (!can(actor, GATES_OVERRIDE, { companyId: known.companyId })) throw new ForbiddenError()
  const until = new Date(body.until)
  if (Number.isNaN(until.getTime())) throw new DomainError('validation_failed', 'The override ends at a time (ISO 8601).', [{ path: 'body/until', message: 'A time.' }])
  const now = rulesClock().now()
  const check = await caller.withClient(async (db) => {
    const requirement = await db.complianceRequirement.findUnique({ where: { id: known.requirementId }, select: { code: true, blocks: true, lockedBlocks: true, overrideRoleKeys: true, overrideMaxDays: true, status: true, switchedOn: true } })
    const roles = await rolesOver(db, context.actorId, known.companyId, now)
    const inForce = (await overridesFor(db, known.gate as ComplianceGate, known.subjectType, known.subjectId, now)).find((entry) => entry.requirementId === known.requirementId) ?? null
    return { requirement, roles, inForce }
  })
  if (!check.requirement) throw new NotFoundError('Requirement not found.')
  const ask = (at: Date, inForceUntil: Date | null) =>
    overrideRefusal({
      requirement: { ...check.requirement!, blocks: check.requirement!.blocks as ComplianceGate[], lockedBlocks: check.requirement!.lockedBlocks as ComplianceGate[], status: check.requirement!.status as 'ACTIVE' | 'ARCHIVED' },
      refusal: { id: known.id, outcome: known.outcome as 'REFUSED' | 'OVERRIDDEN', gate: known.gate as ComplianceGate, subjectType: known.subjectType, subjectId: known.subjectId, requirementId: known.requirementId },
      roles: check.roles,
      reason: body.reason,
      until,
      now: at,
      inForceUntil,
    })
  const first = ask(now, check.inForce?.until ?? null)
  if (first) throw new DomainError(first.code === 'REASON' || first.code === 'UNTIL' ? 'validation_failed' : first.code === 'NOT_YOUR_ROLE' ? 'forbidden' : 'conflict', first.message, first.issues)
  options.stepUp()
  const stepUpAt = options.stepUpAt()
  if (!stepUpAt) throw new DomainError('forbidden', 'Confirm with a fresh code from your authenticator app first (step-up).', [{ path: 'stepUp', message: 'Required.' }])
  const { result } = await rulesGuarded(() =>
    runCommand(
      caller,
      { name: 'compliance.gates.override', idempotencyKey: options.idempotencyKey, input: { eventId, ...body } },
      async (tools) => {
        const { tx } = tools
        // Again on the rows as they are now: another override, a switch, a locked gate.
        const inForce = (await overridesFor(tx, known.gate as ComplianceGate, known.subjectType, known.subjectId, tools.now)).find((entry) => entry.requirementId === known.requirementId) ?? null
        const again = ask(tools.now, inForce?.until ?? null)
        if (again) throw new DomainError('conflict', again.message, again.issues)
        const id = newId()
        await tx.gateEvent.create({
          data: {
            id,
            companyId: known.companyId,
            siteId: known.siteId,
            gate: known.gate,
            subjectType: known.subjectType,
            subjectId: known.subjectId,
            outcome: 'OVERRIDDEN',
            requirementId: known.requirementId,
            styleId: known.styleId,
            marketCode: known.marketCode,
            reason: body.reason.trim(),
            explanation: { refusal: known.reason.slice(0, 1000), roles: check.roles.filter((role) => check.requirement!.overrideRoleKeys.includes(role)) } as Prisma.InputJsonValue,
            refusedEventId: known.id,
            stepUpAt,
            overrideUntil: until,
            createdAt: tools.now,
            createdById: context.actorId,
          },
          select: { id: true },
        })
        tools.audit({
          recordType: known.subjectType,
          recordId: known.subjectId,
          companyId: known.companyId,
          siteId: known.siteId,
          after: { gate: known.gate, outcome: 'OVERRIDDEN', requirement: check.requirement!.code, gateEventId: id, refusedEventId: known.id, overrideUntil: toUtcIso(until) },
          reason: body.reason.trim(),
        })
        tools.emit({
          type: 'compliance_gates.overridden',
          subject: known.subjectId,
          companyId: known.companyId,
          siteId: known.siteId,
          payload: { gateEventId: id, refusedEventId: known.id, gate: known.gate, subjectType: known.subjectType, subjectId: known.subjectId, requirementId: known.requirementId, requirementCode: check.requirement!.code, overrideUntil: toUtcIso(until) },
        })
        return { override: { id, refusedEventId: known.id, gate: known.gate as ComplianceGate, subjectType: known.subjectType, subjectId: known.subjectId, requirementCode: check.requirement!.code, until: toUtcIso(until), reason: body.reason.trim() } }
      },
      { ...COMMAND_SETTINGS, clock: rulesClock() },
    ),
  )
  return result
}

/** GET /compliance/gates/check — the gate's answer now, line by line, for a work order (its cells) or a shipment (per style). */
export async function checkGateNow(request: FastifyRequest, query: { readonly gate: ComplianceGate; readonly subjectType: 'WorkOrder' | 'Shipment'; readonly subjectId: string }) {
  const context = officeOf(request)
  const actor = actorOf(context)
  const now = rulesClock().now()
  return request.withClient(async (db) => {
    const answers = []
    if (query.subjectType === 'WorkOrder') {
      const workOrder = await db.workOrder.findUnique({ where: { id: query.subjectId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true, labelTemplateId: true, styleRevisionId: true } })
      if (!workOrder || !can(actor, CERTIFICATES_VIEW, { companyId: workOrder.companyId })) throw new NotFoundError('Work order not found.')
      const labelTemplateId = workOrder.labelTemplateId ?? (workOrder.styleRevisionId ? ((await db.styleRevision.findUnique({ where: { id: workOrder.styleRevisionId }, select: { labelTemplateId: true } }))?.labelTemplateId ?? null) : null)
      answers.push(await workOrderGate(db, query.gate, { ...workOrder, labelTemplateId }, now))
    } else {
      const facts = await shipmentTargets(db, query.subjectId)
      if (!facts || !can(actor, CERTIFICATES_VIEW, { companyId: facts.companyId })) throw new NotFoundError('Shipment not found.')
      for (const [styleId, targets] of facts.styles) {
        answers.push(await decideGate(db, { gate: query.gate, subjectType: 'Shipment', subjectId: query.subjectId, subjectWords: `Shipment ${facts.number}`, companyId: facts.companyId, siteId: facts.siteId, styleId, targets, day: businessDate(now), now }))
      }
    }
    const styles = new Map<string, string>()
    for (const answer of answers) styles.set(answer.ask.styleId, (await readGateStyle(db, answer.ask.styleId))?.row.code ?? '?')
    return {
      gate: query.gate,
      allowed: answers.every((answer) => answer.decision.allowed),
      decisions: answers.map((answer) => ({
        style: { id: answer.ask.styleId, code: styles.get(answer.ask.styleId) ?? '?' },
        allowed: answer.decision.allowed,
        refusal: answer.decision.refusal ? { requirementCode: answer.decision.refusal.line.requirement.code, target: answer.decision.refusal.line.target.label, words: answer.decision.refusal.words } : null,
        lines: answer.decision.lines.map((line) => ({
          requirement: { id: line.requirement.id, code: line.requirement.code, name: line.requirement.name, legalReference: line.requirement.legalReference },
          check: line.check,
          target: { key: line.target.key, label: line.target.label, marketCode: line.target.market?.code ?? null, destination: line.target.destination },
          state: line.state,
          message: line.message,
          fix: line.fix,
          blocks: line.blocks,
          locked: line.locked,
          who: line.who,
          fixPlace: line.fixPlace,
          evidence: line.evidence,
          override: line.override ? { eventId: line.override.eventId, until: toUtcIso(line.override.until) } : null,
        })),
      })),
      asOf: toUtcIso(now),
    }
  })
}

export const GATES = COMPLIANCE_GATES
