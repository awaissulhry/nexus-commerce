import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, type Issue } from '@nexus/factory-domain/core/errors'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { SALES_SERVICE_DECIDE, SALES_SERVICE_MANAGE } from '@nexus/factory-domain/sales/service/permissions'
import {
  buyerOfParty,
  coverProblems,
  coverWarnings,
  factProblems,
  legalGuaranteeEndOf,
  moveHeld,
  moveProblems,
  SERVICE_CASE_RECORD,
  type CaseKind,
  type CasePriority,
  type CaseStatus,
  type CaseWish,
  type Cover,
  type CoverDecision,
  type MoveTarget,
} from '@nexus/factory-domain/sales/service/rules'
import { command, type CommandCaller } from '../../../core/command'
import { followInCommand } from '../../../platform/threads/followers'
import { held, officeCase } from './access'
import { tellCustomerInCommand, type Notified } from './notify'
import { blank, othersOf, ownerProblems, planGarment, planParty, refuse } from './open'
import { asDay, checkOfRow, dayOrNull, lockCase, partyOf, touchCase, type CaseRow } from './store'
import { caseRecordOf, type CaseView } from './view'

/**
 * A service case's record and its steps (B-W2b-345; design "Service case": Case, Warranty check, Actions): read it, change
 * its facts, decide the cover of its claim (SAL-368), move it and tell the customer (SAL-436). Every write is ONE command():
 * the case's row locked first (FOR UPDATE, at the version the screen read; a closed one is refused in words, since its guard
 * refuses any change but the internal note), the refusals in words before the …_service_safety_w2b_guards trigger would
 * refuse the same, the version moved on, an audit row with before and after (never the customer's words or the internal
 * note: their names only), and its events.
 *
 *   change   PATCH: the kind, the customer (only while nothing is linked) and contact, the garment (a new serial or batch
 *            fills what it gives again), the problem, what the customer wants, the priority, the owner (an ACTIVE person who
 *            may follow it up; they follow it), the warranty days (a consumer's legal guarantee follows a new delivery day
 *            unless typed), whether the customer is told at each status change (only with a contact that has an e-mail),
 *            the internal note (also on a CLOSED case: the only thing that may still change).
 *   cover    the decision, ONE update (cover + decision + why + when + who): COVERED or PARTLY under the legal guarantee
 *            (its last day known) or the factory's (its last day known), NOT_COVERED out of cover; decided again replaces it
 *            (the audit keeps the earlier one). Warnings when the check says otherwise (ended, not a consumer).
 *   status   NEW → OPEN | CLOSED; OPEN → waiting | RESOLVED | CLOSED; waiting → OPEN | the other waiting | RESOLVED | CLOSED;
 *            RESOLVED → OPEN (the resolution cleared) | CLOSED. RESOLVED with what was done (a warranty claim only once its
 *            cover is decided); CLOSED by whom, without a resolution with the reason. With `notifyCustomer` the status mail
 *            goes in the same command (./notify.ts), with the move's `message` for the customer when given.
 */

/** GET /sales/service/cases/:caseId */
export async function getCase(caller: CommandCaller, caseId: string): Promise<{ case: CaseView }> {
  const { row } = await officeCase(caller, caseId)
  return { case: await caseRecordOf(caller, row.id) }
}

export interface ChangeBody {
  readonly version: number
  readonly kind?: CaseKind | undefined
  readonly partyId?: string | null | undefined
  readonly contactId?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly colourwayId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly problem?: string | undefined
  readonly customerWants?: CaseWish | null | undefined
  readonly priority?: CasePriority | undefined
  readonly ownerId?: string | null | undefined
  readonly deliveredOn?: BusinessDate | null | undefined
  readonly legalGuaranteeEndsOn?: BusinessDate | null | undefined
  readonly factoryGuaranteeEndsOn?: BusinessDate | null | undefined
  readonly notifyCustomer?: boolean | undefined
  readonly internalNote?: string | null | undefined
}

/** The fields an audit row names without their values (the customer's words, the office's note). */
const WORDS_FIELDS = new Set(['problem', 'internalNote'])
const shown = (field: string, value: unknown): unknown => (WORDS_FIELDS.has(field) ? (value === null ? null : 'set') : value instanceof Date ? dayOrNull(value) : value)

/** PATCH /sales/service/cases/:caseId */
export async function changeCase(caller: CommandCaller, caseId: string, body: ChangeBody, idempotencyKey?: string): Promise<{ case: CaseView; warnings: Issue[] }> {
  const { context, row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  const { result } = await command(caller, { name: 'serviceCases.change', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const today = businessDate(now)
    const row = await lockCase(tools, seen.id, body.version, { closedToo: true })
    const asked = Object.entries(body).filter(([field, value]) => field !== 'version' && value !== undefined).map(([field]) => field)
    if (row.status === 'CLOSED' && asked.some((field) => field !== 'internalNote')) throw new InvalidStateError(`Case ${row.number} is closed: only its internal note may still change.`)
    const problems: Issue[] = [...factProblems({ problem: body.problem, serial: body.serial, batchNumber: body.batchNumber, size: body.size, internalNote: body.internalNote }, today, false)]
    const warnings: Issue[] = []
    const data: Prisma.ServiceCaseUncheckedUpdateInput = {}
    if (row.status === 'CLOSED') {
      // The guard keeps a closed case as it is but its internal note.
      if (problems.length > 0) refuse(problems, problems[0]!.message)
      const internalNote = blank(body.internalNote)
      if (internalNote === row.internalNote) return { caseId: row.id, warnings }
      const after = await touchCase(tools, row, { internalNote })
      tools.audit({ recordType: SERVICE_CASE_RECORD, recordId: row.id, companyId: row.companyId, before: { internalNote: shown('internalNote', row.internalNote), version: row.version }, after: { internalNote: shown('internalNote', internalNote), version: after.version } })
      return { caseId: row.id, warnings }
    }

    // The customer and the contact (checked when they change; the current contact read for the status mails).
    const partyChanged = body.partyId !== undefined && blank(body.partyId) !== row.partyId
    if (partyChanged && (await tx.serviceCaseLink.count({ where: { caseId: row.id } })) > 0) throw new ConflictError(`Case ${row.number} has linked records of its customer: unlink them before naming another customer.`)
    const partyId = body.partyId === undefined ? row.partyId : blank(body.partyId)
    const contactId = body.contactId !== undefined ? blank(body.contactId) : partyChanged ? null : row.contactId
    const contactChanged = partyChanged || contactId !== row.contactId
    const planned = contactChanged ? await planParty(tx, row.companyId, partyId, contactId, problems) : null
    const party = planned ? planned.party : await partyOf(tx, partyId)
    const contact = planned ? planned.contact : await activeContactOf(tx, contactId)
    if (partyChanged) data.partyId = partyId
    if (contactId !== row.contactId) data.contactId = contactId

    // The garment: a new serial or batch gives its style, colourway and size again (what the body names wins).
    const garmentChanged = (body.serial !== undefined && blank(body.serial) !== row.serial) || (body.batchNumber !== undefined && blank(body.batchNumber) !== row.batchNumber)
    if (garmentChanged || ['styleId', 'colourwayId', 'size'].some((field) => body[field as keyof ChangeBody] !== undefined)) {
      const plan = await planGarment(
        tx,
        {
          serial: body.serial !== undefined ? blank(body.serial) : row.serial,
          batchNumber: body.batchNumber !== undefined ? blank(body.batchNumber) : body.serial !== undefined ? null : row.batchNumber,
          styleId: body.styleId !== undefined ? blank(body.styleId) : garmentChanged ? null : row.styleId,
          colourwayId: body.colourwayId !== undefined ? blank(body.colourwayId) : garmentChanged || body.styleId !== undefined ? null : row.colourwayId,
          size: body.size !== undefined ? blank(body.size) : garmentChanged ? null : row.size,
        },
        { companyId: row.companyId, partyId },
        problems,
        warnings,
      )
      Object.assign(data, { serial: plan.serial, garmentSerial: plan.garmentSerial, batchNumber: plan.batchNumber, garmentBatch: plan.garmentBatch, styleId: plan.styleId, colourwayId: plan.colourwayId, size: plan.size })
      for (const other of await othersOf(tx, plan, row.id)) warnings.push({ path: 'body/serial', message: `Case ${other.number} is open for this ${plan.garmentSerial ? 'garment' : 'batch'} too.` })
    }

    // The warranty days: typed; a consumer's legal guarantee follows a new delivery day or customer unless typed.
    const deliveredOn = body.deliveredOn !== undefined ? body.deliveredOn : dayOrNull(row.deliveredOn)
    let legalEnd = body.legalGuaranteeEndsOn !== undefined ? body.legalGuaranteeEndsOn : dayOrNull(row.legalGuaranteeEndsOn)
    if (body.legalGuaranteeEndsOn === undefined && (body.deliveredOn !== undefined || partyChanged)) legalEnd = legalGuaranteeEndOf(buyerOfParty(party), deliveredOn ?? null)
    const factoryEnd = body.factoryGuaranteeEndsOn !== undefined ? body.factoryGuaranteeEndsOn : dayOrNull(row.factoryGuaranteeEndsOn)
    problems.push(...factProblems({ deliveredOn, legalGuaranteeEndsOn: legalEnd, factoryGuaranteeEndsOn: factoryEnd }, today, false).filter((issue) => !problems.some((seen) => seen.path === issue.path)))
    if (row.cover === 'LEGAL_GUARANTEE' && !legalEnd) problems.push({ path: 'body/legalGuaranteeEndsOn', message: 'The cover was decided under the legal guarantee: its last day stays.' })
    if (row.cover === 'FACTORY_GUARANTEE' && !factoryEnd) problems.push({ path: 'body/factoryGuaranteeEndsOn', message: 'The cover was decided under the factory guarantee: its last day stays.' })
    if (deliveredOn !== dayOrNull(row.deliveredOn)) data.deliveredOn = deliveredOn ? asDay(deliveredOn) : null
    if (legalEnd !== dayOrNull(row.legalGuaranteeEndsOn)) data.legalGuaranteeEndsOn = legalEnd ? asDay(legalEnd) : null
    if (factoryEnd !== dayOrNull(row.factoryGuaranteeEndsOn)) data.factoryGuaranteeEndsOn = factoryEnd ? asDay(factoryEnd) : null
    if (row.coverDecision && ('deliveredOn' in data || 'legalGuaranteeEndsOn' in data || 'factoryGuaranteeEndsOn' in data)) warnings.push({ path: 'body/deliveredOn', message: `The cover of case ${row.number} was decided on the earlier days: decide it again if this changes it.` })

    // Whether the customer is told at each status change: only with an active contact that has an e-mail.
    const notify = body.notifyCustomer ?? row.notifyCustomer
    if (notify && !contact?.email) problems.push({ path: body.notifyCustomer !== undefined ? 'body/notifyCustomer' : 'body/contactId', message: "The customer is told at each status change by e-mail to the case's contact: name a contact with an e-mail." })
    if (body.notifyCustomer !== undefined && body.notifyCustomer !== row.notifyCustomer) data.notifyCustomer = body.notifyCustomer

    // The owner.
    if (body.ownerId !== undefined && blank(body.ownerId) !== row.ownerId) {
      problems.push(...(await ownerProblems(tx, context, blank(body.ownerId), { companyId: row.companyId, partyId }, now)))
      data.ownerId = blank(body.ownerId)
    }
    if (body.kind !== undefined && body.kind !== row.kind) data.kind = body.kind
    if (body.problem !== undefined && body.problem.trim() !== row.problem) data.problem = body.problem.trim()
    if (body.customerWants !== undefined && body.customerWants !== row.customerWants) data.customerWants = body.customerWants
    if (body.priority !== undefined && body.priority !== row.priority) data.priority = body.priority
    if (body.internalNote !== undefined && blank(body.internalNote) !== row.internalNote) data.internalNote = blank(body.internalNote)
    if (problems.length > 0) refuse(problems, 'The case cannot be changed like this.')

    const fields = Object.keys(data).filter((field) => (data as Record<string, unknown>)[field] !== (row as Record<string, unknown>)[field])
    if (fields.length === 0) return { caseId: row.id, warnings }
    const after = await touchCase(tools, row, data)
    tools.audit({
      recordType: SERVICE_CASE_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: Object.fromEntries([...fields.map((field) => [field, shown(field, (row as Record<string, unknown>)[field])]), ['version', row.version]]),
      after: Object.fromEntries([...fields.map((field) => [field, shown(field, (after as Record<string, unknown>)[field])]), ['version', after.version]]),
    })
    if (typeof data.ownerId === 'string') await followInCommand(tools, { type: SERVICE_CASE_RECORD, id: row.id, companyId: row.companyId, siteId: null }, data.ownerId, 'ASSIGNEE', context.actorId)
    // The internal note alone is the office's: no event (it never leaves the record).
    const told = fields.filter((field) => field !== 'internalNote')
    if (told.length > 0) tools.emit({ type: 'service_case.changed', subject: row.id, companyId: row.companyId, payload: { caseId: row.id, number: row.number, fields: told } })
    return { caseId: row.id, warnings }
  })
  return { case: await caseRecordOf(caller, seen.id), warnings: result.warnings }
}

/** POST /sales/service/cases/:caseId/cover {version, cover, decision, note} */
export async function decideCover(caller: CommandCaller, caseId: string, body: { readonly version: number; readonly cover: Cover; readonly decision: CoverDecision; readonly note: string }, idempotencyKey?: string): Promise<{ case: CaseView; warnings: Issue[] }> {
  const { row: seen } = await officeCase(caller, caseId, SALES_SERVICE_DECIDE)
  const { result } = await command(caller, { name: 'serviceCases.decideCover', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const { tx, now, context } = tools
    const row = await lockCase(tools, seen.id, body.version)
    const legalEnd = dayOrNull(row.legalGuaranteeEndsOn)
    const factoryEnd = dayOrNull(row.factoryGuaranteeEndsOn)
    const problems = coverProblems({ cover: body.cover, decision: body.decision, note: body.note, legalGuaranteeEndsOn: legalEnd, factoryGuaranteeEndsOn: factoryEnd })
    if (problems.length > 0) refuse(problems, 'The cover cannot be decided like this.')
    const check = checkOfRow(row, buyerOfParty(await partyOf(tx, row.partyId)), businessDate(now))
    const warnings = coverWarnings({ cover: body.cover, decision: body.decision, check })
    const note = body.note.trim()
    const decidedById = context.audience === 'office' ? context.actorId : null
    const after = await touchCase(tools, row, { cover: body.cover, coverDecision: body.decision, coverNote: note, coverDecidedAt: now, coverDecidedById: decidedById })
    tools.audit({
      recordType: SERVICE_CASE_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { cover: row.cover, coverDecision: row.coverDecision, coverNote: row.coverNote, coverDecidedAt: row.coverDecidedAt ? toUtcIso(row.coverDecidedAt) : null, coverDecidedById: row.coverDecidedById, version: row.version },
      after: { cover: body.cover, coverDecision: body.decision, coverNote: note, coverDecidedAt: toUtcIso(now), coverDecidedById: decidedById, suggested: check.suggested, version: after.version },
    })
    tools.emit({ type: 'service_case.cover_decided', subject: row.id, companyId: row.companyId, payload: { caseId: row.id, number: row.number, cover: body.cover, decision: body.decision } })
    return { caseId: row.id, warnings }
  })
  return { case: await caseRecordOf(caller, seen.id), warnings: result.warnings }
}

export interface MoveBody {
  readonly version: number
  readonly to: MoveTarget
  /** RESOLVED: what was done (the office's words; the customer's mail never carries them). */
  readonly resolution?: string | null | undefined
  /** CLOSED without a resolution: why. */
  readonly reason?: string | null | undefined
  /** Words for the customer, added to this move's status mail (with `notifyCustomer` only). */
  readonly message?: string | null | undefined
}

/** POST /sales/service/cases/:caseId/status */
export async function moveCase(caller: CommandCaller, caseId: string, body: MoveBody, idempotencyKey?: string): Promise<{ case: CaseView; notified: Notified | null; warnings: Issue[] }> {
  const { row: seen } = await officeCase(caller, caseId, SALES_SERVICE_MANAGE)
  const { result } = await command(caller, { name: 'serviceCases.move', idempotencyKey, input: { caseId, ...body } }, async (tools) => {
    const { tx, now, context } = tools
    const row = await lockCase(tools, seen.id, body.version)
    const from = row.status as CaseStatus
    const code = moveHeld({ from, to: body.to, kind: row.kind as CaseKind, coverDecided: row.coverDecision !== null })
    if (code) throw held(code, row.number)
    const problems = moveProblems({ from, to: body.to, resolution: body.resolution, reason: body.reason, message: body.message })
    if (body.message && body.message.trim() && !row.notifyCustomer) problems.push({ path: 'body/message', message: 'The customer is not told of this case’s moves: switch the status mails on first, or leave the words out.' })
    if (problems.length > 0) refuse(problems, 'The case cannot move like this.')
    const data: Prisma.ServiceCaseUncheckedUpdateInput = { status: body.to }
    if (body.to === 'RESOLVED') Object.assign(data, { resolvedAt: now, resolution: body.resolution!.trim() })
    // Back from resolved: it came back; the resolution goes (the audit keeps it).
    if (from === 'RESOLVED' && body.to === 'OPEN') Object.assign(data, { resolvedAt: null, resolution: null })
    if (body.to === 'CLOSED') Object.assign(data, { closedAt: now, closedById: context.audience === 'office' ? context.actorId : null, closeReason: blank(body.reason) })
    const after = await touchCase(tools, row, data)
    const warnings: Issue[] = []
    if (body.to === 'CLOSED') {
      const open = await openLinkedOf(tx, row)
      if (open.length > 0) warnings.push({ path: 'links', message: `Closed with ${open.join(', ')} still open: they go on on their own.` })
    }
    const notified = row.notifyCustomer ? await tellCustomerInCommand(tools, after, { from, to: body.to, message: body.message }) : null
    if (notified && !notified.sent) warnings.push({ path: 'notified', message: notified.words })
    tools.audit({
      recordType: SERVICE_CASE_RECORD,
      recordId: row.id,
      companyId: row.companyId,
      before: { status: from, resolvedAt: row.resolvedAt ? toUtcIso(row.resolvedAt) : null, resolution: row.resolution === null ? null : 'set', version: row.version },
      after: {
        status: body.to,
        resolvedAt: after.resolvedAt ? toUtcIso(after.resolvedAt) : null,
        resolution: after.resolution === null ? null : 'set',
        closedAt: after.closedAt ? toUtcIso(after.closedAt) : null,
        notified: notified === null ? null : notified.sent ? { emailId: notified.emailId } : { notSent: notified.reason },
        version: after.version,
      },
      ...(blank(body.reason) ? { reason: blank(body.reason)! } : {}),
    })
    tools.emit({ type: 'service_case.status_changed', subject: row.id, companyId: row.companyId, payload: { caseId: row.id, number: row.number, from, to: body.to, notified: notified?.sent === true } })
    return { caseId: row.id, notified, warnings }
  })
  return { case: await caseRecordOf(caller, seen.id), notified: result.notified, warnings: result.warnings }
}

/** The case's contact while it may still get mail (ACTIVE, not erased), with its e-mail. */
async function activeContactOf(tx: Parameters<typeof partyOf>[0], contactId: string | null): Promise<{ id: string; email: string | null } | null> {
  if (!contactId) return null
  const row = await tx.partyContact.findUnique({ where: { id: contactId }, select: { id: true, email: true, status: true, erasedAt: true } })
  return row && row.status === 'ACTIVE' && row.erasedAt === null ? { id: row.id, email: row.email } : null
}

/** The repairs and returns linked to the case that are still open (a close warns of them). */
async function openLinkedOf(tx: Parameters<typeof partyOf>[0], row: Pick<CaseRow, 'id'>): Promise<string[]> {
  const links = await tx.serviceCaseLink.findMany({ where: { caseId: row.id, recordType: { in: ['RepairOrder', 'ReturnAuthorisation'] } }, select: { recordType: true, recordId: true } })
  const repairs = links.filter((link) => link.recordType === 'RepairOrder').map((link) => link.recordId)
  const returns = links.filter((link) => link.recordType === 'ReturnAuthorisation').map((link) => link.recordId)
  const open = [
    ...(repairs.length ? await tx.repairOrder.findMany({ where: { id: { in: repairs }, stage: { notIn: ['SHIPPED', 'CANCELLED'] } }, select: { number: true } }) : []),
    ...(returns.length ? await tx.returnAuthorisation.findMany({ where: { id: { in: returns }, status: { notIn: ['CLOSED', 'CANCELLED'] } }, select: { number: true } }) : []),
  ]
  return open.map((record) => record.number).sort()
}
