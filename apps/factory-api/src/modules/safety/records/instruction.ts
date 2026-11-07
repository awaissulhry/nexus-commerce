import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { SAFETY_VIEW } from '@nexus/factory-domain/safety/organisation/permissions'
import { SAFETY_INSTRUCTION_RECORD } from '@nexus/factory-domain/safety/records/permissions'
import { INSTRUCTION_LAW, INSTRUCTION_STATEMENT, instructionProblems, LANGUAGE_LAW, languageOf, RECORD_LIMITS, RECORDS_REFUSALS, type InstructionDraft } from '@nexus/factory-domain/safety/records/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorIdOf, assertMayAt, assertMayWriteAt, assertVersion, dateOf, officeOf, problemsError, refuse, siteScope, todayOf } from '../organisation/access'
import { fullName, INSTRUCTION_SELECT, instructionViews, placeOf, readInstruction, RECORD_INSTRUCTION, type InstructionRow } from './store'
import { recordRights } from './records'

/**
 * The hands-on instruction register (B-W2b-139; QHS-246, QHS-247; design people.skills "Instruction register": "Date · person
 * · task or machine · instructor · minutes · signed on the floor (PIN) · language used", "Add entry (modal)", SignBlock (PIN
 * variant); D.Lgs. 81/2008 art. 37 c.5), office only, safety.instruction.record over the person's company and site to write:
 *
 *   GET  /safety/training/instruction[?companyId&siteId&employeeId&machineClassId&view&from&to&q]   the register (names:
 *        a register the safety readers keep); view all | unsigned | signed | voided
 *   POST /safety/training/instruction             an entry (who, the task, the type of machine or a machine of the site,
 *                                                 the instructor — a person of the company, never the one instructed — or
 *                                                 a name, minutes, the language and whether it was understood); the person
 *                                                 signs it on the floor with badge and PIN (./floor.ts), or `paper: true`
 *                                                 records the paper they signed (its scan: POST /files recordType
 *                                                 InstructionRecord)
 *   POST /safety/training/instruction/:id/paper   the signed paper of an unsigned entry
 *   POST /safety/training/instruction/:id/void    a wrong entry with the reason (signed or not); never deleted
 */

const WORDS = 'The instruction register is kept by a role that keeps it (safety.instruction.record).'
const LAW = { instruction: INSTRUCTION_LAW, language: LANGUAGE_LAW }

export interface ListQuery {
  readonly companyId?: string | undefined
  readonly siteId?: string | undefined
  readonly employeeId?: string | undefined
  readonly machineClassId?: string | undefined
  readonly view?: 'all' | 'unsigned' | 'signed' | 'voided' | undefined
  readonly from?: BusinessDate | undefined
  readonly to?: BusinessDate | undefined
  readonly q?: string | undefined
}

/** GET /safety/training/instruction. */
export async function listInstruction(caller: CommandCaller, query: ListQuery, now: Date = new Date()) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const view = query.view ?? 'all'
    const words = query.q?.trim()
    const rows = (await client.instructionRecord.findMany({
      where: {
        AND: [
          siteScope(context, SAFETY_VIEW) as Prisma.InstructionRecordWhereInput,
          ...(query.companyId ? [{ companyId: query.companyId }] : []),
          ...(query.siteId ? [{ siteId: query.siteId }] : []),
          ...(query.employeeId ? [{ employeeId: query.employeeId }] : []),
          ...(query.machineClassId ? [{ machineClassId: query.machineClassId }] : []),
          ...(view === 'unsigned' ? [{ signedAt: null, voidedAt: null }] : view === 'signed' ? [{ signedAt: { not: null }, voidedAt: null }] : view === 'voided' ? [{ voidedAt: { not: null } }] : []),
          ...(query.from ? [{ instructedOn: { gte: dateOf(query.from) } }] : []),
          ...(query.to ? [{ instructedOn: { lte: dateOf(query.to) } }] : []),
          ...(words
            ? [{ OR: [{ task: { contains: words, mode: 'insensitive' as const } }, { instructorName: { contains: words, mode: 'insensitive' as const } }, { employee: { OR: [{ firstName: { contains: words, mode: 'insensitive' as const } }, { lastName: { contains: words, mode: 'insensitive' as const } }] } }] }]
            : []),
        ],
      },
      orderBy: [{ instructedOn: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: RECORD_LIMITS.list + 1,
      select: INSTRUCTION_SELECT,
    })) as InstructionRow[]
    const shown = rows.slice(0, RECORD_LIMITS.list)
    return {
      entries: await instructionViews(client, context, shown),
      complete: rows.length <= RECORD_LIMITS.list,
      canAdd: recordRights(context).canInstruct,
      statement: { ...INSTRUCTION_STATEMENT },
      law: LAW,
      today: todayOf(now),
    }
  })
}

export interface AddBody {
  readonly employeeId: string
  readonly siteId?: string | undefined
  readonly instructedOn?: BusinessDate | undefined
  readonly task: string
  readonly machineClassId?: string | null | undefined
  readonly machineId?: string | null | undefined
  readonly instructorEmployeeId?: string | null | undefined
  readonly instructorName?: string | null | undefined
  readonly minutes: number
  readonly language: string
  readonly languageChecked?: boolean | undefined
  readonly note?: string | null | undefined
  /** The person signed a paper: record it signed (PAPER); its scan is a file of the entry. */
  readonly paper?: boolean | undefined
}

const clean = (value: string | null | undefined): string | null => (value?.trim() ? value.trim() : null)

function emitEntry(tools: CommandTools, row: InstructionRow, change: 'ADDED' | 'PAPER' | 'VOIDED') {
  tools.emit({ type: 'instruction.changed', subject: row.id, companyId: row.companyId, siteId: row.siteId, payload: { instructionId: row.id, employeeId: row.employeeId, change, via: 'OFFICE' } })
}

/** POST /safety/training/instruction. */
export async function addInstruction(caller: CommandCaller, body: AddBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  const person = isUuid(body.employeeId) ? await caller.withClient((client) => client.employee.findUnique({ where: { id: body.employeeId }, select: { id: true, companyId: true, siteId: true, status: true } })) : null
  if (!person) throw new NotFoundError('Employee not found.')
  const siteId = body.siteId ?? person.siteId
  assertMayAt(context, SAFETY_VIEW, { companyId: person.companyId, siteId: person.siteId }, 'Employee')
  assertMayWriteAt(context, SAFETY_INSTRUCTION_RECORD, { companyId: person.companyId, siteId }, WORDS)
  const { result, replayed } = await command(caller, { name: 'safety.addInstruction', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const today = todayOf(now)
    const draft: InstructionDraft = {
      instructedOn: body.instructedOn ?? today,
      task: body.task,
      minutes: body.minutes,
      language: body.language,
      instructorName: clean(body.instructorName),
      instructorEmployeeId: body.instructorEmployeeId ?? null,
      note: clean(body.note),
    }
    const problems = instructionProblems(draft, person.id, today)
    if (problems.length > 0) throw problemsError(problems, 'The entry is not complete.')
    if (person.status !== 'ACTIVE') refuse('PERSON_NOT_ACTIVE', RECORDS_REFUSALS.PERSON_NOT_ACTIVE, 'employeeId')
    const site = await tx.site.findUnique({ where: { id: siteId }, select: { id: true, companyId: true } })
    if (!site) throw new NotFoundError('Site not found.')
    if (site.companyId !== person.companyId) refuse('PERSON_OTHER_COMPANY', RECORDS_REFUSALS.PERSON_OTHER_COMPANY, 'siteId')
    let instructorName = draft.instructorName
    if (draft.instructorEmployeeId) {
      const instructor = isUuid(draft.instructorEmployeeId) ? await tx.employee.findUnique({ where: { id: draft.instructorEmployeeId }, select: { id: true, companyId: true, status: true, firstName: true, lastName: true } }) : null
      if (!instructor || instructor.companyId !== person.companyId || instructor.status !== 'ACTIVE') refuse('TRAINER_NOT_AVAILABLE', RECORDS_REFUSALS.TRAINER_NOT_AVAILABLE, 'instructorEmployeeId')
      instructorName = instructorName ?? fullName(instructor!)
    }
    let machineClassId = body.machineClassId ?? null
    if (machineClassId && !(isUuid(machineClassId) && (await tx.machineClass.findUnique({ where: { id: machineClassId }, select: { id: true } })))) throw new NotFoundError('Machine class not found.')
    const machineId = body.machineId ?? null
    if (machineId) {
      const machine = isUuid(machineId) ? await tx.machine.findUnique({ where: { id: machineId }, select: { id: true, siteId: true, classId: true } }) : null
      if (!machine || machine.siteId !== siteId) throw new NotFoundError('Machine not found at this site.')
      if (machineClassId && machine.classId !== machineClassId) refuse('MACHINE_NOT_OF_CLASS', RECORDS_REFUSALS.MACHINE_NOT_OF_CLASS, 'machineId')
      machineClassId = machine.classId
    }
    const id = newId()
    await tx.instructionRecord.create({
      data: {
        id,
        companyId: person.companyId,
        siteId,
        employeeId: person.id,
        instructedOn: dateOf(draft.instructedOn),
        task: draft.task.trim(),
        machineClassId,
        machineId,
        instructorEmployeeId: draft.instructorEmployeeId,
        instructorName: instructorName!,
        minutes: draft.minutes,
        language: languageOf(draft.language),
        languageChecked: body.languageChecked ?? false,
        ...(body.paper ? { signedAt: now, signMethod: 'PAPER' as const } : {}),
        note: draft.note,
        createdAt: now,
        updatedAt: now,
        createdById: actorIdOf(tools.context),
      },
      select: { id: true },
    })
    const row = (await readInstruction(tx, id))!
    tools.audit({
      action: 'safety.addInstruction',
      recordType: RECORD_INSTRUCTION,
      recordId: id,
      companyId: row.companyId,
      siteId: row.siteId,
      after: { employeeId: row.employeeId, instructedOn: draft.instructedOn, task: row.task, machineClassId, machineId, instructorEmployeeId: row.instructorEmployeeId, instructorName: row.instructorName, minutes: row.minutes, language: row.language, languageChecked: row.languageChecked, paper: body.paper === true },
    })
    emitEntry(tools, row, body.paper ? 'PAPER' : 'ADDED')
    const [view] = await instructionViews(tx, context, [row])
    return { entry: view!, scan: { recordType: RECORD_INSTRUCTION, recordId: id, companyId: row.companyId } }
  })
  return { ...result, replayed }
}

async function writableEntry(caller: CommandCaller, instructionId: string) {
  const context = officeOf(caller)
  const row = await caller.withClient((client) => readInstruction(client, instructionId))
  if (!row) throw new NotFoundError('Instruction entry not found.')
  assertMayAt(context, SAFETY_VIEW, placeOf(row), 'Instruction entry')
  assertMayWriteAt(context, SAFETY_INSTRUCTION_RECORD, placeOf(row), WORDS)
  return context
}

async function lockEntry(tools: CommandTools, instructionId: string, version: number): Promise<InstructionRow> {
  await tools.tx.$queryRaw`SELECT "id" FROM "InstructionRecord" WHERE "id" = ${instructionId}::uuid FOR UPDATE`
  const row = (await readInstruction(tools.tx, instructionId))!
  assertVersion('entry', row.version, version)
  if (row.voidedAt) refuse('ENTRY_VOIDED', RECORDS_REFUSALS.ENTRY_VOIDED)
  return row
}

/** POST /safety/training/instruction/:instructionId/paper. */
export async function paperInstruction(caller: CommandCaller, instructionId: string, body: { readonly version: number }, idempotencyKey?: string) {
  const context = await writableEntry(caller, instructionId)
  const { result } = await command(caller, { name: 'safety.paperInstruction', idempotencyKey, input: { instructionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockEntry(tools, instructionId, body.version)
    if (row.signedAt) refuse('ENTRY_SIGNED', RECORDS_REFUSALS.ENTRY_SIGNED)
    await tx.instructionRecord.update({ where: { id: row.id }, data: { signedAt: now, signMethod: 'PAPER', version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readInstruction(tx, row.id))!
    tools.audit({ action: 'safety.paperInstruction', recordType: RECORD_INSTRUCTION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { signed: false }, after: { signed: true, method: 'PAPER' } })
    emitEntry(tools, after, 'PAPER')
    const [view] = await instructionViews(tx, context, [after])
    return { entry: view!, scan: { recordType: RECORD_INSTRUCTION, recordId: row.id, companyId: row.companyId } }
  })
  return result
}

/** POST /safety/training/instruction/:instructionId/void. */
export async function voidInstruction(caller: CommandCaller, instructionId: string, body: { readonly version: number; readonly reason: string }, idempotencyKey?: string) {
  const context = await writableEntry(caller, instructionId)
  const { result } = await command(caller, { name: 'safety.voidInstruction', idempotencyKey, input: { instructionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const row = await lockEntry(tools, instructionId, body.version)
    const reason = body.reason.trim()
    await tx.instructionRecord.update({ where: { id: row.id }, data: { voidedAt: now, voidedById: actorIdOf(tools.context), voidReason: reason, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    const after = (await readInstruction(tx, row.id))!
    tools.audit({ action: 'safety.voidInstruction', recordType: RECORD_INSTRUCTION, recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: { voided: false }, after: { voided: true }, reason })
    emitEntry(tools, after, 'VOIDED')
    const [view] = await instructionViews(tx, context, [after])
    return { entry: view! }
  })
  return result
}
