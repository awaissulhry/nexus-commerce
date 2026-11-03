import type { Issue } from '@nexus/factory-domain/core/errors'
import { ConflictError, InvalidStateError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { parseInstant } from '@nexus/factory-domain/core/time'
import type { DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { answerHeld, answerProblems, askHeld, askProblems, CONCESSION_LIMITS, CONCESSION_RECORD, type ConcessionAnswer } from '@nexus/factory-domain/quality/ncr/concession'
import { QUALITY_NCR_MANAGE } from '@nexus/factory-domain/quality/ncr/permissions'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { answerOf, emitChanged, refuse, visibleNcr } from './ncr'
import { CONCESSION_COLUMNS, lockNcr, NCR_RECORD, readConcessions, readNcr, type ConcessionRow, type NcrRow } from './store'

/**
 * Concessions asked of the customer (B-W2b-113; QHS-085; plan §12: the link page is links.approve, W2b-3 — until then the
 * office records the customer's written answer with its file). quality.ncr.manage at the NCR's site; nothing reaches the
 * customer from here (the office asks them by its own mail or the record's thread; the link comes with W2b-3).
 *
 *   POST /quality/ncr/:ncrId/concessions                          ask: the customer (a CUSTOMER or BRAND of the NCR's company),
 *                                                                 the person asked (one of its active contacts), the deviation and
 *                                                                 what we propose; refused on a CRITICAL NCR (never sold under a
 *                                                                 concession) and once the NCR is closed or cancelled
 *   PATCH /quality/ncr/:ncrId/concessions/:concessionId           its words or contact while ASKED (its own version)
 *   POST  /quality/ncr/:ncrId/concessions/:concessionId/answer    the customer's answer recorded: ACCEPTED | REFUSED, when, who
 *                                                                 answered for them, their words (required when refused), their
 *                                                                 written answer (a file of the concession: POST /files with
 *                                                                 recordType NcrConcession first); once; also after the NCR closed
 *
 * Each write is ONE command: the NCR's row locked first (FOR UPDATE, its version not moved: the concession has its own),
 * the concession at its version, the audit on the NCR, ncr.changed {fields: ['concessions']}. NcrConcession_guard holds the
 * same rules for every login.
 */

/** Inside the command: the NCR's row FOR UPDATE (no version bump); `open`: neither closed nor cancelled. */
async function lockForConcession(tools: CommandTools, ncrId: string, open: boolean): Promise<NcrRow> {
  const locked = await lockNcr(tools.tx, ncrId)
  if (!locked) throw new NotFoundError('NCR not found.')
  if (open && (locked.stage === 'CLOSED' || locked.stage === 'CANCELLED')) throw new InvalidStateError(`The NCR is ${locked.stage === 'CLOSED' ? 'closed' : 'cancelled'}: its concessions change no more (an answer may still be recorded).`)
  return (await readNcr(tools.tx, ncrId))!
}

/** The customer and the person asked: a CUSTOMER or BRAND of the NCR's company, an active contact of theirs. */
async function partyProblems(tools: CommandTools, ncr: NcrRow, partyId: string, contactId: string | null | undefined): Promise<Issue[]> {
  const problems: Issue[] = []
  const party = isUuid(partyId) ? await tools.tx.party.findUnique({ where: { id: partyId }, select: { companyId: true, roles: true, status: true } }) : null
  if (!party || (party.companyId !== null && party.companyId !== ncr.companyId)) problems.push({ path: 'partyId', message: "Not a customer of the NCR's company." })
  else if (!party.roles.includes('CUSTOMER') && !party.roles.includes('BRAND')) problems.push({ path: 'partyId', message: 'A concession is asked of a customer or a brand.' })
  if (contactId) {
    const contact = isUuid(contactId) ? await tools.tx.partyContact.findUnique({ where: { id: contactId }, select: { partyId: true, status: true } }) : null
    if (!contact || contact.partyId !== partyId || contact.status !== 'ACTIVE') problems.push({ path: 'contactId', message: 'An active contact of the customer asked.' })
  }
  return problems
}

async function concessionAt(tools: CommandTools, ncrId: string, concessionId: string, expectedVersion: number): Promise<ConcessionRow> {
  const row = isUuid(concessionId) ? await tools.tx.ncrConcession.findUnique({ where: { id: concessionId }, select: CONCESSION_COLUMNS }) : null
  if (!row || row.ncrId !== ncrId) throw new NotFoundError('Concession not found.')
  if (row.version !== expectedVersion) throw new StaleVersionError(CONCESSION_RECORD, concessionId, row.version, expectedVersion)
  return row
}

export interface AskBody {
  readonly partyId: string
  readonly contactId?: string | null | undefined
  readonly ask: string
  readonly proposal: string
}

/** POST /quality/ncr/:ncrId/concessions: a concession asked of the customer. */
export async function askConcession(caller: CommandCaller, ncrId: string, body: AskBody, idempotencyKey?: string) {
  const { context, row } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const before = askHeld({ stage: row.stage, severity: row.severity as DefectClass })
  if (before) throw new ConflictError(before)
  const { result } = await command(caller, { name: 'quality.askNcrConcession', idempotencyKey, input: { ncrId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockForConcession(tools, ncrId, true)
    const held = askHeld({ stage: ncr.stage, severity: ncr.severity as DefectClass })
    if (held) throw new ConflictError(held)
    const problems = [...askProblems(body, true), ...(await partyProblems(tools, ncr, body.partyId, body.contactId))]
    if (problems.length > 0) refuse(problems, 'The concession is not complete.')
    const existing = await readConcessions(tx, ncrId)
    if (existing.length >= CONCESSION_LIMITS.perNcr) throw new ConflictError(`An NCR asks at most ${CONCESSION_LIMITS.perNcr} concessions.`)
    const id = newId()
    const seq = Math.max(0, ...existing.map((entry) => entry.seq)) + 1
    await tx.ncrConcession.create({
      data: { id, siteId: ncr.siteId, ncrId, seq, partyId: body.partyId, contactId: body.contactId ?? null, ask: body.ask.trim(), proposal: body.proposal.trim(), status: 'ASKED', askedAt: now, askedById: context.actorId, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: { id: true },
    })
    // The customer's words are named, never copied into the audit row.
    tools.audit({ action: 'quality.askNcrConcession', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { concessionId: id, seq, partyId: body.partyId, contactId: body.contactId ?? null, status: 'ASKED' } })
    emitChanged(tools, ncr, ['concessions'])
    return answerOf(tools, ncrId)
  })
  return result
}

/** PATCH /quality/ncr/:ncrId/concessions/:concessionId: its words or contact while ASKED. */
export async function editConcession(caller: CommandCaller, ncrId: string, concessionId: string, body: { readonly version: number; readonly contactId?: string | null | undefined; readonly ask?: string | undefined; readonly proposal?: string | undefined }, idempotencyKey?: string) {
  await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const { result } = await command(caller, { name: 'quality.editNcrConcession', idempotencyKey, input: { ncrId, concessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const ncr = await lockForConcession(tools, ncrId, true)
    const concession = await concessionAt(tools, ncrId, concessionId, body.version)
    const held = answerHeld(concession.status as 'ASKED' | 'ACCEPTED' | 'REFUSED')
    if (held) throw new InvalidStateError(held.replace('an answer is recorded once', 'it changes no more'))
    const problems = [...askProblems(body, false), ...(body.contactId !== undefined ? await partyProblems(tools, ncr, concession.partyId, body.contactId) : [])]
    if (problems.length > 0) refuse(problems, 'The change is not valid.')
    const data = {
      ...(body.ask !== undefined && body.ask.trim() !== concession.ask ? { ask: body.ask.trim() } : {}),
      ...(body.proposal !== undefined && body.proposal.trim() !== concession.proposal ? { proposal: body.proposal.trim() } : {}),
      ...(body.contactId !== undefined && (body.contactId ?? null) !== concession.contactId ? { contactId: body.contactId ?? null } : {}),
    }
    if (Object.keys(data).length === 0) {
      tools.audit({ action: 'quality.editNcrConcession', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { concessionId, unchanged: true } })
      return answerOf(tools, ncrId)
    }
    await tx.ncrConcession.update({ where: { id: concessionId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    tools.audit({ action: 'quality.editNcrConcession', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, after: { concessionId, fields: Object.keys(data) } })
    emitChanged(tools, ncr, ['concessions'])
    return answerOf(tools, ncrId)
  })
  return result
}

export interface AnswerBody {
  readonly version: number
  readonly status: ConcessionAnswer
  readonly answer?: string | null | undefined
  readonly answeredBy: string
  readonly answeredAt: string
  readonly answerFileId?: string | null | undefined
}

/** POST /quality/ncr/:ncrId/concessions/:concessionId/answer: the customer's written answer, recorded once. */
export async function answerConcession(caller: CommandCaller, ncrId: string, concessionId: string, body: AnswerBody, idempotencyKey?: string) {
  const { context } = await visibleNcr(caller, ncrId, QUALITY_NCR_MANAGE)
  const { result } = await command(caller, { name: 'quality.answerNcrConcession', idempotencyKey, input: { ncrId, concessionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    // The answer may come after the NCR closed: no stage check here.
    const ncr = await lockForConcession(tools, ncrId, false)
    const concession = await concessionAt(tools, ncrId, concessionId, body.version)
    const held = answerHeld(concession.status as 'ASKED' | 'ACCEPTED' | 'REFUSED')
    if (held) throw new ConflictError(held)
    const answeredAt = parseInstant(body.answeredAt)
    const problems = answeredAt ? answerProblems({ status: body.status, answer: body.answer, answeredBy: body.answeredBy, answeredAt }, concession.askedAt, now) : [{ path: 'answeredAt', message: 'When the customer answered.' }]
    if (body.answerFileId) {
      const file = isUuid(body.answerFileId) ? await tx.storedFile.findUnique({ where: { id: body.answerFileId }, select: { recordType: true, recordId: true, status: true } }) : null
      if (!file || file.recordType !== CONCESSION_RECORD || file.recordId !== concessionId) problems.push({ path: 'answerFileId', message: 'Their written answer is a file of this concession: upload it to the concession first.' })
      else if (file.status !== 'AVAILABLE') problems.push({ path: 'answerFileId', message: `The file is ${file.status.toLowerCase()}: wait until it is available.` })
    }
    if (problems.length > 0) refuse(problems, 'The answer is not complete.')
    await tx.ncrConcession.update({
      where: { id: concessionId },
      data: { status: body.status, answer: body.answer?.trim() || null, answeredAt, answeredBy: body.answeredBy.trim(), answerFileId: body.answerFileId ?? null, recordedById: context.actorId, version: { increment: 1 }, updatedAt: now },
      select: { id: true },
    })
    tools.audit({ action: 'quality.answerNcrConcession', recordType: NCR_RECORD, recordId: ncrId, companyId: ncr.companyId, siteId: ncr.siteId, before: { concessionId, status: concession.status }, after: { concessionId, status: body.status, answerFileId: body.answerFileId ?? null } })
    emitChanged(tools, ncr, ['concessions'])
    return answerOf(tools, ncrId)
  })
  return result
}
