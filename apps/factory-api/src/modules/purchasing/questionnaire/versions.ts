import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUESTIONNAIRE_MANAGE, QUESTIONNAIRE_VIEW } from '@nexus/factory-domain/purchasing/questionnaire/permissions'
import { questionProblems, questionsOf } from '@nexus/factory-domain/purchasing/questionnaire/questions'
import { STARTER_QUESTIONS, STARTER_TITLE } from '@nexus/factory-domain/purchasing/questionnaire/starter'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { VERSION_COLUMNS, VERSION_RECORD, versionsOf, versionView } from './store'

/**
 * The company's questionnaire versions (B-W2b-172; SCM-023 "questions as data; a starter set for due diligence"): the
 * screen's company (`x-factory-company`) keeps an ordered list of versions; one draft at a time is changed and published;
 * a published version is fixed (the database holds it) and the links sent from then on ask the newest published one.
 *
 *   GET   /purchasing/questionnaires                        purchasing.questionnaire.view over the company
 *   POST  /purchasing/questionnaires {from | questions}     a draft: the starter set, a copy of the newest version, or the
 *                                                           questions given (checked: factory-domain questionProblems)
 *   PATCH /purchasing/questionnaires/:id {title, questions, version}   the draft changed (never a published one)
 *   POST  /purchasing/questionnaires/:id/publish {version}  published: fixed from now on; event supplier_questionnaire.published
 *
 * Writes need purchasing.questionnaire.manage over the company; ONE command each, the version's row compare-and-set on the
 * version the screen read.
 */

function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** The screen's company, which the caller may read (or, `write`, manage) the questionnaire of. */
function companyOf(caller: CommandCaller, write: boolean): { context: OfficeContext; companyId: string } {
  const context = officeOf(caller)
  const companyId = context.companyId
  if (!companyId) throw new ValidationError('Choose the company first.', [{ path: 'headers/x-factory-company', message: 'The company the questionnaire belongs to.' }])
  if (!can(actorOf(context), write ? QUESTIONNAIRE_MANAGE : QUESTIONNAIRE_VIEW, { companyId })) throw new ForbiddenError(write ? 'You may read the questionnaire, not change it.' : undefined)
  return { context, companyId }
}

/** GET /purchasing/questionnaires. */
export async function listVersions(caller: CommandCaller) {
  const { context, companyId } = companyOf(caller, false)
  const rows = await caller.withClient((client) => versionsOf(client, companyId))
  return { companyId, versions: rows.map(versionView), may: { manage: can(actorOf(context), QUESTIONNAIRE_MANAGE, { companyId }) } }
}

function checked(questions: unknown): Prisma.InputJsonValue {
  const problems = questionProblems(questions)
  if (problems.length > 0) throw new ValidationError('The questions are not valid.', problems)
  return questions as Prisma.InputJsonValue
}

/** POST /purchasing/questionnaires. */
export async function createVersion(caller: CommandCaller, body: { readonly from?: 'STARTER' | 'LATEST' | undefined; readonly title?: string | undefined; readonly questions?: readonly unknown[] | undefined }, idempotencyKey?: string) {
  const { context, companyId } = companyOf(caller, true)
  if (body.questions !== undefined && body.from !== undefined) throw new ValidationError('Give the questions, or say where they come from: not both.', [{ path: 'body/from', message: 'Leave it out with questions.' }])
  const { result } = await command(caller, { name: 'purchasing.questionnaire.create', idempotencyKey, input: { from: body.from ?? null, title: body.title ?? null, questions: body.questions?.length ?? null } }, async (tools) => {
    const { tx, now } = tools
    // One draft at a time: the company's versions locked in order (their revision numbers are unique).
    await tx.$queryRaw`SELECT id FROM "SupplierQuestionnaire" WHERE "companyId" = ${companyId}::uuid FOR UPDATE`
    const versions = await versionsOf(tx, companyId)
    const draft = versions.find((row) => row.publishedAt === null)
    if (draft) throw new ConflictError(`Version ${draft.revision} is a draft still: change it or publish it first.`)
    const latest = versions[0] ?? null
    const questions =
      body.questions !== undefined ? checked(body.questions) : body.from === 'LATEST' && latest ? (latest.questions as Prisma.InputJsonValue) : (STARTER_QUESTIONS as unknown as Prisma.InputJsonValue)
    const id = newId()
    const row = await tx.supplierQuestionnaire.create({
      data: { id, companyId, revision: (latest?.revision ?? 0) + 1, title: body.title ?? latest?.title ?? STARTER_TITLE, questions, createdAt: now, updatedAt: now, createdById: context.actorId },
      select: VERSION_COLUMNS,
    })
    tools.audit({ recordType: VERSION_RECORD, recordId: id, companyId, after: { revision: row.revision, title: row.title, questions: questionsOf(row.questions).length, from: body.questions !== undefined ? 'GIVEN' : (body.from ?? 'STARTER') } })
    return { version: versionView(row) }
  })
  return result
}

async function draftOf(caller: CommandCaller, id: string, companyId: string) {
  const row = isUuid(id) ? await caller.withClient((client) => client.supplierQuestionnaire.findFirst({ where: { id, companyId }, select: VERSION_COLUMNS })) : null
  if (!row) throw new NotFoundError('Questionnaire version not found.')
  if (row.publishedAt !== null) throw new InvalidStateError(`Version ${row.revision} is published: it is fixed. Make a new version to change it.`)
  return row
}

/** PATCH /purchasing/questionnaires/:id. */
export async function updateVersion(caller: CommandCaller, id: string, body: { readonly title?: string | undefined; readonly questions?: readonly unknown[] | undefined; readonly version: number }, idempotencyKey?: string) {
  const { companyId } = companyOf(caller, true)
  await draftOf(caller, id, companyId)
  const questions = body.questions === undefined ? undefined : checked(body.questions)
  const { result } = await command(caller, { name: 'purchasing.questionnaire.update', idempotencyKey, input: { id, title: body.title ?? null, questions: body.questions?.length ?? null }, record: { type: 'SupplierQuestionnaire', id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const before = await tx.supplierQuestionnaire.findUniqueOrThrow({ where: { id }, select: VERSION_COLUMNS })
    if (before.publishedAt !== null) throw new InvalidStateError(`Version ${before.revision} is published: it is fixed.`)
    const row = await tx.supplierQuestionnaire.update({ where: { id }, data: { ...(body.title !== undefined ? { title: body.title } : {}), ...(questions !== undefined ? { questions } : {}), updatedAt: now }, select: VERSION_COLUMNS })
    tools.audit({ recordType: VERSION_RECORD, recordId: id, companyId, before: { title: before.title, questions: questionsOf(before.questions).length }, after: { title: row.title, questions: questionsOf(row.questions).length } })
    return { version: versionView(row) }
  })
  return result
}

/** POST /purchasing/questionnaires/:id/publish. */
export async function publishVersion(caller: CommandCaller, id: string, body: { readonly version: number }, idempotencyKey?: string) {
  const { context, companyId } = companyOf(caller, true)
  const draft = await draftOf(caller, id, companyId)
  const problems = questionProblems(draft.questions)
  if (problems.length > 0) throw new ValidationError('The questions are not valid: change them before publishing.', problems)
  const { result } = await command(caller, { name: 'purchasing.questionnaire.publish', idempotencyKey, input: { id, version: body.version }, record: { type: 'SupplierQuestionnaire', id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.supplierQuestionnaire.update({ where: { id }, data: { publishedAt: now, publishedById: context.actorId, updatedAt: now }, select: VERSION_COLUMNS })
    const questions = questionsOf(row.questions).length
    tools.audit({ action: 'purchasing.questionnaire.publish', recordType: VERSION_RECORD, recordId: id, companyId, before: { published: false }, after: { published: true, revision: row.revision, questions } })
    tools.emit({ type: 'supplier_questionnaire.published', subject: id, companyId, payload: { questionnaireId: id, revision: row.revision, questions } })
    return { version: versionView(row) }
  })
  return result
}
