import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { GRADE_LIMITS, gradeDraftProblems, HIDE_DEFECT_CATEGORY, HIDE_STAGES, isHideDefect, missingGrades, usableShareText, type GradeDraft } from '@nexus/factory-domain/quality/defects/grades'
import { mergedLabels, sortedStages, type DefectClass } from '@nexus/factory-domain/quality/defects/rules'
import { missingLanguages } from '@nexus/factory-domain/quality/defects/vocabulary'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertManage, mayManage, officeOf } from './access'
import type { GradeView } from './vocabulary-contract'
import { floorLanguages, retiredWords, vocabularyChanged, wordsOf } from './vocabulary'

/**
 * Leather grades and hide defects (B-W2b-90; QHS-006; design quality.defects df-grades "Grades A-D; hide defect types
 * with icons. Autosave per cell"): the shared vocabulary of incoming and cutting. The grades are one list for the whole
 * group; the hide defects are the defects of the library's hide category (LEATHER) that apply at incoming or cutting,
 * kept with the library's own routes (PATCH /quality/defects/:defectId) and gathered here. Reads with
 * quality.defects.view; every write quality.defects.manage over every company (403 in words), one command() each with an
 * Idempotency-Key, audit rows with companyId null and one `quality.vocabulary_changed` (list GRADES).
 *
 *   GET   /quality/grades                the grades in tile order with their usable share, how often hides, grade rules,
 *                                        hide marks, remnants and incoming hide results name each, the floor languages
 *                                        each has no words in; the hide category and its hide defects; the starter
 *                                        grades missing.
 *   POST  /quality/grades                a grade: its code is fixed from now on.
 *   PATCH /quality/grades/:gradeId       words, usable share, order, active (retire / make active again), at the version
 *                                        read. A grade is never deleted (the database refuses it): retire it.
 *   POST  /quality/grades/starter        grades A-D the tenant does not have yet.
 *
 * The database's LeatherGrade_guard holds the code, the words and the share for every login; a retired grade is taken by
 * no new hide, grade rule or mark (their own triggers). A usable share changed here is the default of every article that
 * has no grade rule of its own (B-W2b-94 reads it): it changes no stock and no figure already recorded.
 */

const COLUMNS = {
  id: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  usableShare: true,
  sortOrder: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.LeatherGradeSelect
type Row = Prisma.LeatherGradeGetPayload<{ select: typeof COLUMNS }>
type Reader = Pick<CommandTx, 'leatherGrade' | 'hide' | 'itemGradeRule' | 'hideMark' | 'remnant' | 'incomingHideResult'>

const viewOf = (row: Row, usedCount: number, languages: readonly string[]): GradeView => {
  const labelI18n = wordsOf(row.labelI18n)
  return {
    id: row.id,
    code: row.code,
    labelIt: row.labelIt,
    labelEn: row.labelEn,
    labelI18n,
    usableShare: row.usableShare.toFixed(2),
    sortOrder: row.sortOrder,
    active: row.active,
    usedCount,
    missingLanguages: missingLanguages({ labelI18n }, languages),
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const audited = (row: Row) => ({ code: row.code, labelIt: row.labelIt, labelEn: row.labelEn, labelI18n: wordsOf(row.labelI18n), usableShare: row.usableShare.toFixed(2), sortOrder: row.sortOrder, active: row.active })
const byOrder = (a: { sortOrder: number; code: string }, b: { sortOrder: number; code: string }): number => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

/** How often each grade is named: hides, grade rules, hide marks (a zone's grade), remnants, incoming hide results. */
async function usage(db: Reader): Promise<Map<string, number>> {
  const used = new Map<string, number>()
  const add = (id: string | null, count: number) => {
    if (id) used.set(id, (used.get(id) ?? 0) + count)
  }
  // One after the other: a scoped client runs one statement at a time.
  for (const row of await db.hide.groupBy({ by: ['gradeId'], where: { gradeId: { not: null } }, _count: { _all: true } })) add(row.gradeId, row._count._all)
  for (const row of await db.itemGradeRule.groupBy({ by: ['gradeId'], _count: { _all: true } })) add(row.gradeId, row._count._all)
  for (const row of await db.hideMark.groupBy({ by: ['zoneGradeId'], where: { zoneGradeId: { not: null } }, _count: { _all: true } })) add(row.zoneGradeId, row._count._all)
  for (const row of await db.remnant.groupBy({ by: ['gradeId'], where: { gradeId: { not: null } }, _count: { _all: true } })) add(row.gradeId, row._count._all)
  for (const row of await db.incomingHideResult.groupBy({ by: ['gradeRecordId'], where: { gradeRecordType: 'LeatherGrade', gradeRecordId: { not: null } }, _count: { _all: true } })) add(row.gradeRecordId, row._count._all)
  return used
}

async function readRow(db: Pick<CommandTx, 'leatherGrade'>, id: string): Promise<Row | null> {
  return isUuid(id) ? db.leatherGrade.findUnique({ where: { id }, select: COLUMNS }) : null
}

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

const LOCK_GRADES = (tx: CommandTx) => tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.leather-grades', current_setting('factory.tenant_id', true)), 0))`

// ---- reads ----------------------------------------------------------------------------------------------------------

/** GET /quality/grades. */
export async function readGrades(caller: CommandCaller, query: { readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.leatherGrade.findMany({ select: COLUMNS })
    const used = await usage(client)
    const languages = await floorLanguages(client)
    const library = await client.defectCode.findMany({
      select: { id: true, parentId: true, code: true, labelIt: true, labelEn: true, labelI18n: true, icon: true, colour: true, pictureFileId: true, severity: true, stages: true, sortOrder: true, active: true, version: true },
    })
    const category = library.find((row) => row.parentId === null && row.code === HIDE_DEFECT_CATEGORY) ?? null
    const hideDefects = category
      ? library
          .filter((row) => row.parentId === category.id && isHideDefect(row, category.code) && (query.active === undefined || row.active === (query.active === 'true')))
          .sort(byOrder)
          .map((row) => {
            const labelI18n = wordsOf(row.labelI18n)
            return {
              id: row.id,
              code: row.code,
              labelIt: row.labelIt,
              labelEn: row.labelEn,
              labelI18n,
              icon: row.icon ?? category.icon,
              colour: row.colour ?? category.colour,
              pictureFileId: row.pictureFileId,
              severity: row.severity as DefectClass,
              stages: sortedStages(row.stages),
              active: row.active,
              missingLanguages: missingLanguages({ labelI18n }, languages),
              version: row.version,
            }
          })
      : []
    return {
      grades: rows
        .filter((row) => query.active === undefined || row.active === (query.active === 'true'))
        .sort(byOrder)
        .map((row) => viewOf(row, used.get(row.id) ?? 0, languages)),
      hideCategory: category ? { id: category.id, code: category.code, labelIt: category.labelIt, labelEn: category.labelEn, icon: category.icon, colour: category.colour, active: category.active } : null,
      hideDefects,
      hideStages: [...HIDE_STAGES],
      languages,
      starterMissing: missingGrades(new Set(rows.map((row) => row.code))).map((grade) => grade.code),
      canManage: mayManage(context),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

export interface CreateGradeBody extends GradeDraft {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
  readonly usableShare: string
}

/** POST /quality/grades. */
export async function createGrade(caller: CommandCaller, body: CreateGradeBody, idempotencyKey?: string): Promise<{ grade: GradeView }> {
  const context = officeOf(caller)
  assertManage(context)
  const code = body.code.trim().toUpperCase()
  const problems = gradeDraftProblems({ ...body, code }, true)
  if (problems.length > 0) refuse(problems, 'The grade is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'quality.createGrade', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    await LOCK_GRADES(tx)
    if ((await tx.leatherGrade.count()) >= GRADE_LIMITS.perTenant) throw new ConflictError(`The grade list holds at most ${GRADE_LIMITS.perTenant} grades.`)
    const taken = await tx.leatherGrade.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Grade ${code} is taken${taken.active ? '' : ' by a retired grade'}.`)
    const last = await tx.leatherGrade.aggregate({ _max: { sortOrder: true } })
    const row = await tx.leatherGrade.create({
      data: {
        id,
        code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedLabels({}, body.labelI18n),
        usableShare: usableShareText(body.usableShare),
        sortOrder: body.sortOrder ?? (last._max.sortOrder ?? 0) + 1,
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'LeatherGrade', recordId: id, companyId: null, after: audited(row) })
    vocabularyChanged(tools, 'GRADES', 'CREATED', [code])
    return { grade: viewOf(row, 0, await floorLanguages(tx)) }
  })
  return result
}

export interface EditGradeBody extends Omit<GradeDraft, 'code'> {
  readonly version: number
  readonly active?: boolean | undefined
}

/** PATCH /quality/grades/:gradeId. */
export async function editGrade(caller: CommandCaller, gradeId: string, body: EditGradeBody, idempotencyKey?: string): Promise<{ grade: GradeView; retireWords: string | null }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => readRow(client, gradeId))
  if (!before) throw new NotFoundError('Leather grade not found.')
  const problems = gradeDraftProblems(body, false)
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'quality.editGrade', idempotencyKey, input: { gradeId, ...body }, record: { type: 'LeatherGrade', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await readRow(tx, before.id))!
      const data: Prisma.LeatherGradeUncheckedUpdateInput = { updatedAt: now }
      if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
      if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
      if (body.labelI18n !== undefined) data.labelI18n = mergedLabels(wordsOf(current.labelI18n), body.labelI18n)
      if (body.usableShare !== undefined) data.usableShare = usableShareText(body.usableShare)
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
      if (body.active !== undefined) data.active = body.active
      const row = await tx.leatherGrade.update({ where: { id: current.id }, data, select: COLUMNS })
      tools.audit({ recordType: 'LeatherGrade', recordId: row.id, companyId: null, before: audited(current), after: audited(row) })
      const change = body.active === false && current.active ? 'RETIRED' : body.active === true && !current.active ? 'REACTIVATED' : 'EDITED'
      vocabularyChanged(tools, 'GRADES', change, [row.code])
      const used = (await usage(tx)).get(row.id) ?? 0
      return { grade: viewOf(row, used, await floorLanguages(tx)), retireWords: change === 'RETIRED' ? retiredWords('Grade', row.code, used) : null }
    },
  )
  return result
}

/** POST /quality/grades/starter: grades A-D the tenant does not have yet, after its last grade. */
export async function addStarterGrades(caller: CommandCaller, idempotencyKey?: string): Promise<{ added: string[] }> {
  const context = officeOf(caller)
  assertManage(context)
  const { result } = await command(caller, { name: 'quality.addStarterGrades', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    await LOCK_GRADES(tx)
    const rows = await tx.leatherGrade.findMany({ select: { code: true, sortOrder: true } })
    let order = Math.max(0, ...rows.map((row) => row.sortOrder))
    const added: string[] = []
    for (const grade of missingGrades(new Set(rows.map((row) => row.code)))) {
      order += 1
      const id = newId()
      const row = await tx.leatherGrade.create({
        data: { id, code: grade.code, labelIt: grade.labelIt, labelEn: grade.labelEn, usableShare: grade.usableShare, sortOrder: order, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: COLUMNS,
      })
      tools.audit({ recordType: 'LeatherGrade', recordId: id, companyId: null, after: audited(row) })
      added.push(row.code)
    }
    if (added.length === 0) tools.audit({ recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { starterGrades: 'nothing missing' } })
    vocabularyChanged(tools, 'GRADES', 'STARTER_ADDED', added)
    return { added }
  })
  return result
}
