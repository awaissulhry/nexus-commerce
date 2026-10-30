import type { Prisma } from '@nexus/factory-db'
import { REGISTER_LIMITS, type RegisterRisk } from '@nexus/factory-domain/compliance/register/rules'
import { REGISTER_MANAGE } from '@nexus/factory-domain/compliance/register/permissions'
import { ForbiddenError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, parseInstant, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { QUALITY_COMPLAINTS_ACKNOWLEDGE, QUALITY_COMPLAINTS_LOG, QUALITY_COMPLAINTS_MANAGE, QUALITY_COMPLAINTS_VIEW } from '@nexus/factory-domain/quality/complaints/permissions'
import {
  acknowledgeHeld,
  closeHeld,
  closeReasonProblems,
  COMPLAINT_LIMITS,
  COMPLAINT_RECORD,
  factProblems,
  moveHeld,
  registerHeld,
  triageProblems,
  type ChangedField,
  type ComplaintCategory,
  type ComplaintChannel,
  type ComplaintSeverity,
  type ComplaintStatus,
  type StatusMove,
} from '@nexus/factory-domain/quality/complaints/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { followInCommand } from '../../../platform/threads/followers'
import { sessionGrants } from '@nexus/factory-domain/auth/roles/roles'
import { openRegisterEntryFor, type OpenedEntry } from '../../compliance/register/hook'
import { readEntryBySource } from '../../compliance/register/store'
import { held, mayOn, officeComplaint } from './access'
import { blank, planAbout, recordOf, refuse } from './log'
import { asDay, dayOf, lockComplaint, touchComplaint, type ComplaintRow, type ComplaintView } from './store'

/**
 * A complaint's record and its steps (B-W2a-65; design quality.complaints "Record: Complaint", cmp-triage): read it,
 * change its facts, triage it (QHS-113), raise and acknowledge its safety alert (QHS-115), start the investigation, mark
 * it answered, add it to the PPE register, close it. Every write is ONE command(): the complaint's row locked first (FOR
 * UPDATE, at the version the screen read; a closed one is refused in words, since its guard refuses any change), the
 * refusals in words before the …_sales_w2a_guards trigger would refuse the same, the version moved on by every change,
 * an audit row with before and after, and its events.
 *
 *   triage       category, severity, owner (an ACTIVE office person who may see the complaint), answer due (on or after
 *                the day it came in). NEW → TRIAGED; a re-triage keeps the status. The first SAFETY raises the alert in
 *                the same command: safetyRaisedAt (once; kept when the category changes later), the PPE register entry
 *                opened through W1's openRegisterEntryFor (kind COMPLAINT, source the complaint, the garment's style,
 *                batch, serial and shipment, risk being assessed or YES), complaint.safety_raised (platform/notifications
 *                tells the owner and quality). The owner follows it as its ASSIGNEE.
 *   acknowledge  the owner (quality.complaints.acknowledge) acknowledges a raised alert: once, when and by whom.
 *   status       TRIAGED → INVESTIGATING | ANSWERED, INVESTIGATING → ANSWERED, ANSWERED → INVESTIGATING (answeredAt cleared).
 *   close        with a reason, from any open status; a safety complaint only once acknowledged and in the register.
 *   register     a complaint that raised no alert, added to the PPE register by hand (also compliance.register.manage).
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

function noteOf(value: string | null | undefined): string | null {
  const note = blank(value)
  if (note && note.length > COMPLAINT_LIMITS.note) refuse([{ path: 'body/note', message: `At most ${COMPLAINT_LIMITS.note} characters.` }], 'The note is too long.')
  return note
}

const auditOf = (row: ComplaintRow) => ({
  status: row.status,
  category: row.category,
  severity: row.severity,
  ownerId: row.ownerId,
  answerDueOn: row.answerDueOn ? dayOf(row.answerDueOn) : null,
  safetyRaisedAt: row.safetyRaisedAt ? toUtcIso(row.safetyRaisedAt) : null,
  safetyAcknowledgedAt: row.safetyAcknowledgedAt ? toUtcIso(row.safetyAcknowledgedAt) : null,
  version: row.version,
})

/** GET /quality/complaints/:complaintId */
export async function getComplaint(caller: CommandCaller, complaintId: string): Promise<{ complaint: ComplaintView }> {
  const { complaint } = await officeComplaint(caller, complaintId)
  return { complaint: await recordOf(caller, complaint.id) }
}

// ---- change the facts ---------------------------------------------------------------------------------------------------

export interface ChangeBody {
  readonly version: number
  readonly contactId?: string | null | undefined
  readonly customerRef?: string | null | undefined
  readonly channel?: ComplaintChannel | undefined
  readonly receivedAt?: string | undefined
  readonly description?: string | undefined
  readonly salesOrderId?: string | null | undefined
  readonly shipmentId?: string | null | undefined
  readonly returnId?: string | null | undefined
  readonly styleId?: string | null | undefined
  readonly size?: string | null | undefined
  readonly serial?: string | null | undefined
  readonly batchNumber?: string | null | undefined
  readonly internalNote?: string | null | undefined
}

const TEXT_FIELDS = ['customerRef', 'size', 'serial', 'batchNumber', 'internalNote'] as const
const ID_FIELDS = ['contactId', 'salesOrderId', 'shipmentId', 'returnId', 'styleId'] as const

/** PATCH /quality/complaints/:complaintId: while new with `log`, once triaged with `manage`. */
export async function changeComplaint(caller: CommandCaller, complaintId: string, body: ChangeBody, idempotencyKey?: string): Promise<{ complaint: ComplaintView; warnings: Issue[] }> {
  const { context, complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_LOG)
  const { result } = await command(caller, { name: 'complaints.change', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    if (row.status !== 'NEW' && !mayOn(context, QUALITY_COMPLAINTS_MANAGE, row)) throw new ForbiddenError('Once triaged, a complaint is changed by quality (quality.complaints.manage).')
    const receivedAt = body.receivedAt !== undefined ? parseInstant(body.receivedAt) : undefined
    const problems: Issue[] = factProblems({ ...body, receivedAt: receivedAt ?? undefined }, now, false)
    const data: Prisma.ComplaintUncheckedUpdateInput = {}
    const fields: ChangedField[] = []
    const next = { ...row }
    for (const field of TEXT_FIELDS) {
      if (body[field] === undefined) continue
      const value = blank(body[field])
      if (value !== row[field]) {
        data[field] = value
        ;(next as Record<string, unknown>)[field] = value
        fields.push(field)
      }
    }
    for (const field of ID_FIELDS) {
      if (body[field] === undefined) continue
      const value = body[field] ?? null
      if (value !== row[field]) {
        data[field] = value
        ;(next as Record<string, unknown>)[field] = value
        fields.push(field)
      }
    }
    if (body.description !== undefined && body.description.trim() !== row.description) {
      data.description = body.description.trim()
      fields.push('description')
    }
    if (body.channel !== undefined && body.channel !== row.channel) {
      data.channel = body.channel
      fields.push('channel')
    }
    if (receivedAt && receivedAt.getTime() !== row.receivedAt.getTime()) {
      if (row.answerDueOn && businessDate(receivedAt) > dayOf(row.answerDueOn)) problems.push({ path: 'body/receivedAt', message: `The answer is due on ${dayOf(row.answerDueOn)}: the complaint came in on or before that day.` })
      data.receivedAt = receivedAt
      fields.push('receivedAt')
    }
    const warnings: Issue[] = []
    // What it is about stays the company's and the customer's (only what changed is checked again).
    const aboutChanged = fields.some((field) => (ID_FIELDS as readonly string[]).includes(field) || field === 'serial')
    if (aboutChanged) {
      await planAbout(
        tx,
        {
          companyId: row.companyId,
          partyId: row.partyId,
          contactId: fields.includes('contactId') ? next.contactId : null,
          salesOrderId: fields.includes('salesOrderId') ? next.salesOrderId : null,
          shipmentId: fields.includes('shipmentId') ? next.shipmentId : null,
          returnId: fields.includes('returnId') ? next.returnId : null,
          styleId: fields.includes('styleId') ? next.styleId : null,
          size: next.size,
          serial: fields.includes('serial') ? next.serial : null,
          batchNumber: next.batchNumber,
        },
        problems,
        warnings,
      )
    }
    if (problems.length > 0) refuse(problems, 'The complaint cannot be changed like this.')
    if (fields.length === 0) return { complaintId: row.id, warnings }
    const after = await touchComplaint(tools, row, data)
    const before: Record<string, unknown> = {}
    const changed: Record<string, unknown> = {}
    for (const field of fields) {
      const value = (field: keyof ComplaintRow, of: ComplaintRow) => {
        const raw = of[field]
        return raw instanceof Date ? toUtcIso(raw) : raw
      }
      // The customer's words and the note are named, never copied into the audit row's values.
      if (field === 'description' || field === 'internalNote') continue
      before[field] = value(field as keyof ComplaintRow, row)
      changed[field] = value(field as keyof ComplaintRow, after)
    }
    tools.audit({ recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { ...before, version: row.version }, after: { ...changed, fields, version: after.version } })
    tools.emit({ type: 'complaint.changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, fields } })
    return { complaintId: row.id, warnings }
  })
  return { complaint: await recordOf(caller, result.complaintId), warnings: result.warnings }
}

// ---- triage and the safety escalation -------------------------------------------------------------------------------------

export interface TriageBody {
  readonly version: number
  readonly category: ComplaintCategory
  readonly severity: ComplaintSeverity
  readonly ownerId: string
  readonly answerDueOn: BusinessDate
  readonly styleId?: string | null | undefined
  readonly risk?: 'ASSESSING' | 'YES' | undefined
  readonly note?: string | null | undefined
}

/** The owner must be an ACTIVE office person whose live roles let them see this complaint. */
async function ownerProblems(tools: Pick<CommandTools, 'tx' | 'now' | 'context'>, ownerId: string, row: ComplaintRow): Promise<Issue[]> {
  const owner = isUuid(ownerId) ? await tools.tx.user.findUnique({ where: { id: ownerId }, select: { status: true } }) : null
  if (!owner || owner.status !== 'ACTIVE') return [{ path: 'body/ownerId', message: 'An active person of the office.' }]
  const tenantId = 'tenantId' in tools.context ? tools.context.tenantId : ''
  const actor = { audience: 'office' as const, tenantId, grants: sessionGrants({ requireMfa: false }, await heldRoles(tools.tx, ownerId, tools.now), true) }
  return can(actor, QUALITY_COMPLAINTS_VIEW, { companyId: row.companyId, partyId: row.partyId }) ? [] : [{ path: 'body/ownerId', message: "Their roles do not show them this customer's complaints." }]
}

/** The register entry a safety complaint opens, inside the triage's command (W1's hook: one entry per complaint). */
async function openEntryOf(tools: CommandTools, row: ComplaintRow, styleId: string, risk: RegisterRisk): Promise<OpenedEntry> {
  const fits = (value: string | null): value is string => value !== null && value.length <= REGISTER_LIMITS.code
  const words = `Customer complaint ${row.number}: ${row.description}`
  return openRegisterEntryFor(tools, {
    companyId: row.companyId,
    kind: 'COMPLAINT',
    styleId,
    // Kept as reported: a serial or batch the register cannot hold is left in the complaint's own words.
    batchNumbers: fits(row.batchNumber) ? [row.batchNumber] : [],
    serials: fits(row.serial) ? [row.serial] : [],
    shipmentIds: row.shipmentId ? [row.shipmentId] : [],
    description: words.length > REGISTER_LIMITS.description ? `${words.slice(0, REGISTER_LIMITS.description - 1)}…` : words,
    risk,
    reportedAt: row.receivedAt.getTime() > tools.now.getTime() ? tools.now : row.receivedAt,
    source: { type: COMPLAINT_RECORD, id: row.id },
    partyId: row.partyId,
  })
}

/** POST /quality/complaints/:complaintId/triage */
export async function triageComplaint(caller: CommandCaller, complaintId: string, body: TriageBody, idempotencyKey?: string) {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  const { result } = await command(caller, { name: 'complaints.triage', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    const note = noteOf(body.note)
    const styleId = body.styleId ?? row.styleId
    const problems: Issue[] = [...triageProblems({ category: body.category, severity: body.severity, answerDueOn: body.answerDueOn, styleId }, businessDate(row.receivedAt)), ...(await ownerProblems(tools, body.ownerId, row))]
    if (body.styleId && body.styleId !== row.styleId) {
      const style = isUuid(body.styleId) ? await tx.style.findUnique({ where: { id: body.styleId }, select: { id: true } }) : null
      if (!style) problems.push({ path: 'body/styleId', message: 'Not a style of the tenant.' })
    }
    if (problems.length > 0) refuse(problems, 'The triage cannot be saved like this.')
    const raising = body.category === 'SAFETY' && row.safetyRaisedAt === null
    const from = row.status as ComplaintStatus
    const to: ComplaintStatus = from === 'NEW' ? 'TRIAGED' : from
    const after = await touchComplaint(tools, row, {
      category: body.category,
      severity: body.severity,
      ownerId: body.ownerId,
      answerDueOn: asDay(body.answerDueOn),
      styleId,
      status: to,
      triagedAt: now,
      triagedById: actorIdOf(tools),
      ...(raising ? { safetyRaisedAt: now } : {}),
    })
    tools.audit({ recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: auditOf(row), after: { ...auditOf(after), styleId }, ...(note ? { reason: note } : {}) })
    tools.emit({
      type: 'complaint.triaged',
      subject: row.id,
      companyId: row.companyId,
      payload: { complaintId: row.id, number: row.number, category: body.category, severity: body.severity, ownerId: body.ownerId, answerDueOn: body.answerDueOn, from, to },
    })
    // A safety complaint reaches the register: on the first SAFETY, and again if its entry is somehow missing.
    let register: { entryId: string; reference: string; opened: boolean } | null = null
    if (after.safetyRaisedAt !== null && styleId) {
      const entry = await openEntryOf(tools, after, styleId, body.risk ?? 'ASSESSING')
      register = { entryId: entry.entryId, reference: entry.reference, opened: entry.opened }
    }
    if (raising) {
      tools.emit({ type: 'complaint.safety_raised', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, styleId, registerEntryId: register?.entryId ?? null, raisedById: actorIdOf(tools) } })
    }
    await followInCommand(tools, { type: COMPLAINT_RECORD, id: row.id, companyId: row.companyId, siteId: null }, body.ownerId, 'ASSIGNEE', actorIdOf(tools))
    return { complaintId: row.id, safetyRaised: raising, register }
  })
  return { complaint: await recordOf(caller, result.complaintId), safetyRaised: result.safetyRaised, register: result.register }
}

/** POST /quality/complaints/:complaintId/acknowledge: the owner acknowledges the safety alert (once). */
export async function acknowledgeComplaint(caller: CommandCaller, complaintId: string, body: { readonly version: number; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ complaint: ComplaintView }> {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_ACKNOWLEDGE)
  await command(caller, { name: 'complaints.acknowledge', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    const code = acknowledgeHeld(row)
    if (code) throw held(code, code === 'ACKNOWLEDGED' ? `The owner acknowledged complaint ${row.number}'s safety alert already.` : `Complaint ${row.number} raised no safety alert: there is nothing to acknowledge.`)
    const note = noteOf(body.note)
    const by = actorIdOf(tools)!
    const after = await touchComplaint(tools, row, { safetyAcknowledgedAt: now, safetyAcknowledgedById: by })
    tools.audit({ recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: auditOf(row), after: auditOf(after), ...(note ? { reason: note } : {}) })
    tools.emit({ type: 'complaint.safety_acknowledged', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, acknowledgedById: by } })
    return { complaintId: row.id }
  })
  return { complaint: await recordOf(caller, seen.id) }
}

// ---- the status moves and the close ---------------------------------------------------------------------------------------

const MOVE_WORDS: Readonly<Record<string, string>> = Object.freeze({
  NOT_TRIAGED: 'is new: triage it first.',
  ALREADY_INVESTIGATING: 'is being investigated already.',
  ALREADY_ANSWERED: 'is answered already: take it back to investigating if the customer came back.',
  NOT_ANSWERED: 'is not answered: only an answered complaint goes back to investigating.',
})

/** POST /quality/complaints/:complaintId/status {to: INVESTIGATING | ANSWERED} */
export async function moveComplaint(caller: CommandCaller, complaintId: string, body: { readonly version: number; readonly to: StatusMove; readonly note?: string | null | undefined }, idempotencyKey?: string): Promise<{ complaint: ComplaintView }> {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  await command(caller, { name: 'complaints.move', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    const from = row.status as ComplaintStatus
    const code = moveHeld(from, body.to)
    if (code) throw held(code, `Complaint ${row.number} ${MOVE_WORDS[code] ?? 'cannot move like this.'}`)
    const note = noteOf(body.note)
    const after = await touchComplaint(tools, row, { status: body.to, answeredAt: body.to === 'ANSWERED' ? now : null })
    tools.audit({ recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { status: from, answeredAt: row.answeredAt ? toUtcIso(row.answeredAt) : null, version: row.version }, after: { status: body.to, answeredAt: after.answeredAt ? toUtcIso(after.answeredAt) : null, version: after.version }, ...(note ? { reason: note } : {}) })
    tools.emit({ type: 'complaint.status_changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, from, to: body.to } })
    return { complaintId: row.id }
  })
  return { complaint: await recordOf(caller, seen.id) }
}

/** POST /quality/complaints/:complaintId/close {reason} */
export async function closeComplaint(caller: CommandCaller, complaintId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string): Promise<{ complaint: ComplaintView }> {
  const { complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  await command(caller, { name: 'complaints.close', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockComplaint(tools, seen.id, body.version)
    const problems = closeReasonProblems(body.reason)
    if (problems.length > 0) refuse(problems, problems[0]!.message)
    const inRegister = (await readEntryBySource(tx, COMPLAINT_RECORD, row.id)) !== null
    const code = closeHeld({ status: row.status as ComplaintStatus, safetyRaisedAt: row.safetyRaisedAt, safetyAcknowledgedAt: row.safetyAcknowledgedAt, inRegister })
    if (code === 'SAFETY_NOT_ACKNOWLEDGED') throw held(code, `Complaint ${row.number} is about safety: it closes once the owner acknowledged its alert.`)
    if (code === 'NOT_IN_REGISTER') throw held(code, `Complaint ${row.number} is about safety: it closes once it is in the PPE register (Reg. (EU) 2016/425 art. 8(4)).`)
    const from = row.status as ComplaintStatus
    const reason = body.reason.trim()
    const after = await touchComplaint(tools, row, { status: 'CLOSED', closedAt: now, closeReason: reason })
    tools.audit({ recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { status: from, version: row.version }, after: { status: 'CLOSED', closedAt: toUtcIso(now), version: after.version }, reason })
    tools.emit({ type: 'complaint.status_changed', subject: row.id, companyId: row.companyId, payload: { complaintId: row.id, number: row.number, from, to: 'CLOSED' } })
    return { complaintId: row.id }
  })
  return { complaint: await recordOf(caller, seen.id) }
}

// ---- add to the PPE register ----------------------------------------------------------------------------------------------

/** POST /quality/complaints/:complaintId/register: a complaint that raised no alert, added to the register by hand. */
export async function registerComplaint(caller: CommandCaller, complaintId: string, body: { readonly version: number; readonly risk?: RegisterRisk | undefined }, idempotencyKey?: string) {
  const { context, complaint: seen } = await officeComplaint(caller, complaintId, QUALITY_COMPLAINTS_MANAGE)
  if (!can(actorOf(context), REGISTER_MANAGE, { companyId: seen.companyId, partyId: seen.partyId })) throw new ForbiddenError('Adding to the PPE register also needs compliance.register.manage.')
  const { result } = await command(caller, { name: 'complaints.register', idempotencyKey, input: { complaintId, ...body } }, async (tools) => {
    const row = await lockComplaint(tools, seen.id, body.version)
    const inRegister = (await readEntryBySource(tools.tx, COMPLAINT_RECORD, row.id)) !== null
    const code = registerHeld({ status: row.status as ComplaintStatus, styleId: row.styleId, inRegister })
    if (code === 'IN_REGISTER') throw held(code, `Complaint ${row.number} is in the PPE register already.`)
    if (code === 'NO_STYLE') throw held(code, `The PPE register keeps an entry per style: name the style of complaint ${row.number}'s garment first.`)
    const entry = await openEntryOf(tools, row, row.styleId!, body.risk ?? 'ASSESSING')
    // The entry's own rows and event come from the hook; the complaint's version moves on so the screens read it again.
    const after = await touchComplaint(tools, row)
    tools.audit({ action: 'complaints.register', recordType: COMPLAINT_RECORD, recordId: row.id, companyId: row.companyId, before: { version: row.version }, after: { registerEntryId: entry.entryId, reference: entry.reference, version: after.version } })
    return { complaintId: row.id, register: { entryId: entry.entryId, reference: entry.reference, opened: entry.opened } }
  })
  return { complaint: await recordOf(caller, result.complaintId), register: result.register }
}
