import type { DefectClass as DbDefectClass, Prisma, QualityStage as DbStage } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { DefectLibraryChange } from '@nexus/factory-domain/quality/holds/changes'
import {
  appliesAt,
  DEFECT_LIMITS,
  defectDraftProblems,
  GARMENT_ZONES,
  mergedLabels,
  QUALITY_STAGES,
  retireWords,
  sortedStages,
  type DefectClass,
  type DefectDraft,
  type QualityStage,
} from '@nexus/factory-domain/quality/defects/rules'
import { missingStarter } from '@nexus/factory-domain/quality/defects/standard'
import { command, StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { assertManage, mayManage, officeOf, officeOrFloorOf } from './access'
import type { DefectView } from './contract'

/**
 * The defect library (B-W2a-26; QHS-001; design quality.defects df-library, df-drawer, df-retire): one library for the
 * whole group, two levels (a category and its defects). Reads:
 *
 *   GET /quality/defects           quality.defects.view: the tree, category by category in library order, with how often
 *                                  each code is used (inspection defects and NCRs; a category: its defects), the garment
 *                                  zones, the stages, the starter codes missing and whether the caller may keep it.
 *   GET /quality/defects/picker    any office or floor session: the ACTIVE defects (not categories) of a stage (none: all)
 *                                  in tile order, for the bench's and the floor's pickers.
 *
 * Writes (quality.defects.manage over every company; each one command() on the code with the version read, an
 * Idempotency-Key, audit rows with companyId null and one `quality.defects_changed`):
 *
 *   POST   /quality/defects                 a category (no parentId) or a defect of a category (its class required).
 *   PATCH  /quality/defects/:defectId       words, icon, colour, picture (a file of this code: StoredFile recordType
 *                                           "DefectCode", AVAILABLE, an image), class, zone, stages, note asked, order,
 *                                           active (retire / make active again). A code and its category never change.
 *   DELETE /quality/defects/:defectId       only a code nothing names (no inspection defect, NCR or defect under it);
 *                                           otherwise 409 in words: retire it.
 *   POST   /quality/defects/starter         the leather-apparel starter set's missing categories and defects.
 *
 * The database's DefectCode_guard holds the same rules for every login.
 */

const COLUMNS = {
  id: true,
  parentId: true,
  code: true,
  labelIt: true,
  labelEn: true,
  labelI18n: true,
  icon: true,
  colour: true,
  pictureFileId: true,
  severity: true,
  zone: true,
  stages: true,
  needsDetail: true,
  sortOrder: true,
  active: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.DefectCodeSelect
type Row = Prisma.DefectCodeGetPayload<{ select: typeof COLUMNS }>
type Reader = Pick<CommandTx, 'defectCode' | 'inspectionDefect' | 'nonconformance'>

const wordsOf = (value: Prisma.JsonValue): Record<string, string> =>
  value && typeof value === 'object' && !Array.isArray(value) ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) : {}

const viewOf = (row: Row, usedCount: number): DefectView => ({
  id: row.id,
  parentId: row.parentId,
  code: row.code,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  pictureFileId: row.pictureFileId,
  severity: row.severity,
  zone: row.zone,
  stages: sortedStages(row.stages),
  needsDetail: row.needsDetail,
  sortOrder: row.sortOrder,
  active: row.active,
  usedCount,
  version: row.version,
  createdAt: toUtcIso(row.createdAt),
  updatedAt: toUtcIso(row.updatedAt),
})

const byOrder = (a: Row, b: Row): number => a.sortOrder - b.sortOrder || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0)

/** How often each code is named (inspection defects and NCRs); a category counts its defects. */
async function usage(db: Reader, rows: readonly Row[]): Promise<Map<string, number>> {
  const used = new Map<string, number>()
  const add = (id: string | null, count: number) => {
    if (id) used.set(id, (used.get(id) ?? 0) + count)
  }
  for (const row of await db.inspectionDefect.groupBy({ by: ['defectCodeId'], where: { defectCodeId: { not: null } }, _count: { _all: true } })) add(row.defectCodeId, row._count._all)
  for (const row of await db.nonconformance.groupBy({ by: ['defectCodeId'], where: { defectCodeId: { not: null } }, _count: { _all: true } })) add(row.defectCodeId, row._count._all)
  for (const row of rows) if (row.parentId) add(row.parentId, 1)
  return used
}

/** Uses of one code (what refuses a delete): inspection defects, NCRs and, for a category, its defects. */
async function usesOf(db: Reader, row: Row): Promise<number> {
  // One after the other: a transaction client runs one statement at a time.
  const inspections = await db.inspectionDefect.count({ where: { defectCodeId: row.id } })
  const ncrs = await db.nonconformance.count({ where: { defectCodeId: row.id } })
  const children = row.parentId === null ? await db.defectCode.count({ where: { parentId: row.id } }) : 0
  return inspections + ncrs + children
}

// ---- reads ----------------------------------------------------------------------------------------------------------

export async function readLibrary(caller: CommandCaller, query: { readonly active?: 'true' | 'false' | undefined }) {
  const context = officeOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.defectCode.findMany({ select: COLUMNS })
    const used = await usage(client, rows)
    const keep = (row: Row) => query.active === undefined || row.active === (query.active === 'true')
    const categories = rows.filter((row) => row.parentId === null).sort(byOrder)
    const tree = categories.map((category) => ({
      ...viewOf(category, used.get(category.id) ?? 0),
      defects: rows
        .filter((row) => row.parentId === category.id && keep(row))
        .sort(byOrder)
        .map((row) => viewOf(row, used.get(row.id) ?? 0)),
    }))
    const missing = missingStarter(new Set(rows.map((row) => row.code)))
    return {
      // A category shows when it matches the filter itself or holds a defect that does.
      categories: tree.filter((category) => query.active === undefined || category.active === (query.active === 'true') || category.defects.length > 0),
      zones: GARMENT_ZONES.map((zone) => ({ ...zone })),
      stages: [...QUALITY_STAGES],
      starterMissing: [...missing.categories.map((category) => category.code), ...missing.defects.map((entry) => entry.defect.code)],
      canManage: mayManage(context),
    }
  })
}

/** The pickers' read: active defects of active categories, for a stage (none: every stage), in tile order. */
export async function readPicker(caller: CommandCaller, query: { readonly stage?: QualityStage | undefined }) {
  officeOrFloorOf(caller)
  return caller.withClient(async (client) => {
    const rows = await client.defectCode.findMany({ where: { active: true }, select: COLUMNS })
    const categories = new Map(rows.filter((row) => row.parentId === null).map((row) => [row.id, row]))
    const defects = rows
      .filter((row) => row.parentId !== null && categories.has(row.parentId) && (query.stage === undefined || appliesAt(row.stages, query.stage)))
      .sort((a, b) => byOrder(categories.get(a.parentId!)!, categories.get(b.parentId!)!) || byOrder(a, b))
    return {
      defects: defects.map((row) => {
        const category = categories.get(row.parentId!)!
        return {
          id: row.id,
          code: row.code,
          category: { id: category.id, code: category.code, labelIt: category.labelIt, labelEn: category.labelEn },
          labelIt: row.labelIt,
          labelEn: row.labelEn,
          labelI18n: wordsOf(row.labelI18n),
          icon: row.icon,
          colour: row.colour,
          pictureFileId: row.pictureFileId,
          severity: row.severity as DefectClass,
          zone: row.zone,
          needsDetail: row.needsDetail,
        }
      }),
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------

const refuse = (problems: Issue[], words: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

function changed(tools: Pick<CommandTools, 'emit'>, change: DefectLibraryChange, codes: readonly string[]): void {
  if (codes.length > 0) tools.emit({ type: 'quality.defects_changed', subject: 'defect-library', companyId: null, siteId: null, payload: { change, codes: [...codes] } })
}

const audited = (row: Row) => ({
  code: row.code,
  parentId: row.parentId,
  labelIt: row.labelIt,
  labelEn: row.labelEn,
  labelI18n: wordsOf(row.labelI18n),
  icon: row.icon,
  colour: row.colour,
  pictureFileId: row.pictureFileId,
  severity: row.severity,
  zone: row.zone,
  stages: row.stages,
  needsDetail: row.needsDetail,
  sortOrder: row.sortOrder,
  active: row.active,
})

async function readRow(db: Reader, id: string): Promise<Row | null> {
  return isUuid(id) ? db.defectCode.findUnique({ where: { id }, select: COLUMNS }) : null
}

/** The next place in the library: after the category's last defect (a category: after the last category). */
async function nextOrder(db: Reader, parentId: string | null): Promise<number> {
  const last = await db.defectCode.aggregate({ where: { parentId }, _max: { sortOrder: true } })
  const parent = parentId ? await db.defectCode.findUnique({ where: { id: parentId }, select: { sortOrder: true } }) : null
  const base = Math.max(last._max.sortOrder ?? 0, parent?.sortOrder ?? 0)
  return parentId ? base + 1 : Math.floor(base / 100) * 100 + 100
}

export interface CreateDefectBody extends DefectDraft {
  readonly code: string
  readonly labelIt: string
  readonly labelEn: string
}

/** POST /quality/defects. */
export async function createDefect(caller: CommandCaller, body: CreateDefectBody, idempotencyKey?: string): Promise<{ defect: DefectView }> {
  const context = officeOf(caller)
  assertManage(context)
  const code = body.code.trim().toUpperCase()
  const parentId = body.parentId ?? null
  const draft: DefectDraft = { ...body, code }
  const parent = parentId ? await caller.withClient((client) => readRow(client, parentId)) : undefined
  const problems = defectDraftProblems(draft, { isCategory: parentId === null, creating: true, parent: parent === undefined ? undefined : parent ? { isCategory: parent.parentId === null } : null })
  if (problems.length > 0) refuse(problems, 'The code is not valid.')
  const id = newId()
  const { result } = await command(caller, { name: 'quality.createDefect', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const count = await tx.defectCode.count()
    if (count >= DEFECT_LIMITS.perTenant) throw new ConflictError(`The library holds at most ${DEFECT_LIMITS.perTenant} codes: retire or delete some first.`)
    const taken = await tx.defectCode.findFirst({ where: { code }, select: { active: true } })
    if (taken) throw new ConflictError(`Code ${code} is taken${taken.active ? '' : ' by a retired code'}.`)
    if (parentId) {
      // The category, locked: a delete of it waits, and its defects are counted after.
      const [locked] = await tx.$queryRaw<{ id: string; parentId: string | null; active: boolean }[]>`SELECT "id", "parentId", "active" FROM "DefectCode" WHERE "id" = ${parentId}::uuid FOR UPDATE`
      if (!locked) throw new ValidationError('File the defect under a category of the library.', [{ path: 'body/parentId', message: 'Not a category of the library.' }])
      if (locked.parentId !== null) throw new ValidationError('The library has two levels: file the defect under a category.', [{ path: 'body/parentId', message: 'A defect, not a category.' }])
    }
    const row = await tx.defectCode.create({
      data: {
        id,
        parentId,
        code,
        labelIt: body.labelIt.trim(),
        labelEn: body.labelEn.trim(),
        labelI18n: mergedLabels({}, body.labelI18n),
        icon: body.icon ?? null,
        colour: body.colour?.toLowerCase() ?? null,
        severity: parentId ? ((body.severity ?? null) as DbDefectClass | null) : null,
        zone: parentId ? (body.zone ?? null) : null,
        stages: sortedStages(body.stages ?? []) as DbStage[],
        needsDetail: parentId ? (body.needsDetail ?? false) : false,
        sortOrder: body.sortOrder ?? (await nextOrder(tx, parentId)),
        createdAt: now,
        updatedAt: now,
        createdById: context.actorId,
      },
      select: COLUMNS,
    })
    tools.audit({ recordType: 'DefectCode', recordId: id, companyId: null, after: audited(row) })
    changed(tools, 'CREATED', [code])
    return { defect: viewOf(row, 0) }
  })
  return result
}

export interface EditDefectBody extends Omit<DefectDraft, 'code' | 'parentId'> {
  readonly version: number
  readonly pictureFileId?: string | null | undefined
  readonly active?: boolean | undefined
}

/** PATCH /quality/defects/:defectId. */
export async function editDefect(caller: CommandCaller, defectId: string, body: EditDefectBody, idempotencyKey?: string): Promise<{ defect: DefectView; retireWords: string | null }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => readRow(client, defectId))
  if (!before) throw new NotFoundError('Defect code not found.')
  const problems = defectDraftProblems(body, { isCategory: before.parentId === null, creating: false })
  if (problems.length > 0) refuse(problems, 'The change is not valid.')
  const { result } = await command(
    caller,
    { name: 'quality.editDefect', idempotencyKey, input: { defectId, ...body }, record: { type: 'DefectCode', id: before.id, expectedVersion: body.version } },
    async (tools) => {
      const { tx, now } = tools
      const current = (await readRow(tx, before.id))!
      if (body.pictureFileId) {
        const file = await tx.storedFile.findUnique({ where: { id: body.pictureFileId }, select: { recordType: true, recordId: true, status: true, contentType: true } })
        if (!file || file.recordType !== 'DefectCode' || file.recordId !== current.id) {
          throw new ValidationError('The picture is a file of this code.', [{ path: 'body/pictureFileId', message: 'Upload the picture to this code first (POST /files with recordType DefectCode and its id).' }])
        }
        if (file.status !== 'AVAILABLE') throw new ValidationError('The picture is not uploaded yet.', [{ path: 'body/pictureFileId', message: 'Confirm the upload first.' }])
        if (!file.contentType.startsWith('image/')) throw new ValidationError('The picture is an image.', [{ path: 'body/pictureFileId', message: 'A JPEG, PNG or WebP picture.' }])
      }
      const data: Prisma.DefectCodeUncheckedUpdateInput = { updatedAt: now }
      if (body.labelIt !== undefined) data.labelIt = body.labelIt.trim()
      if (body.labelEn !== undefined) data.labelEn = body.labelEn.trim()
      if (body.labelI18n !== undefined) data.labelI18n = mergedLabels(wordsOf(current.labelI18n), body.labelI18n)
      if (body.icon !== undefined) data.icon = body.icon
      if (body.colour !== undefined) data.colour = body.colour?.toLowerCase() ?? null
      if (body.pictureFileId !== undefined) data.pictureFileId = body.pictureFileId
      if (body.severity !== undefined) data.severity = body.severity as DbDefectClass | null
      if (body.zone !== undefined) data.zone = body.zone
      if (body.stages !== undefined) data.stages = sortedStages(body.stages) as DbStage[]
      if (body.needsDetail !== undefined) data.needsDetail = body.needsDetail
      if (body.sortOrder !== undefined) data.sortOrder = body.sortOrder
      if (body.active !== undefined) data.active = body.active
      const row = await tx.defectCode.update({ where: { id: current.id }, data, select: COLUMNS })
      tools.audit({ recordType: 'DefectCode', recordId: row.id, companyId: null, before: audited(current), after: audited(row) })
      const change: DefectLibraryChange = body.active === false && current.active ? 'RETIRED' : body.active === true && !current.active ? 'REACTIVATED' : 'EDITED'
      changed(tools, change, [row.code])
      const used = await usesOf(tx, row)
      return { defect: viewOf(row, used), retireWords: change === 'RETIRED' ? retireWords(row.code, used) : null }
    },
  )
  return result
}

/** DELETE /quality/defects/:defectId?version=: only a code nothing names. */
export async function deleteDefect(caller: CommandCaller, defectId: string, query: { readonly version: number }, idempotencyKey?: string): Promise<{ deleted: string; code: string }> {
  const context = officeOf(caller)
  assertManage(context)
  const before = await caller.withClient((client) => readRow(client, defectId))
  if (!before) throw new NotFoundError('Defect code not found.')
  const { result } = await command(caller, { name: 'quality.deleteDefect', idempotencyKey, input: { defectId, ...query } }, async (tools) => {
    const { tx } = tools
    const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "DefectCode" WHERE "id" = ${before.id}::uuid FOR UPDATE`
    if (!locked) throw new NotFoundError('Defect code not found.')
    if (locked.version !== query.version) throw new StaleVersionError('DefectCode', before.id, locked.version, query.version)
    const current = (await readRow(tx, before.id))!
    const uses = await usesOf(tx, current)
    if (uses > 0) {
      throw new ConflictError(
        current.parentId === null && (await tx.defectCode.count({ where: { parentId: current.id } })) > 0
          ? `Category ${current.code} has defects: delete or move them first, or retire it.`
          : `${current.code} is used on ${uses} ${uses === 1 ? 'record' : 'records'}: retire it instead (it stays on them and leaves the pickers).`,
      )
    }
    await tx.defectCode.delete({ where: { id: current.id }, select: { id: true } })
    tools.audit({ recordType: 'DefectCode', recordId: current.id, companyId: null, before: audited(current) })
    changed(tools, 'DELETED', [current.code])
    return { deleted: current.id, code: current.code }
  })
  return result
}

/** POST /quality/defects/starter: the starter set's categories and defects the library does not have yet. */
export async function addStarter(caller: CommandCaller, idempotencyKey?: string): Promise<{ added: string[] }> {
  const context = officeOf(caller)
  assertManage(context)
  const { result } = await command(caller, { name: 'quality.addStarterDefects', idempotencyKey, input: {} }, async (tools) => {
    const { tx, now } = tools
    // One starter run at a time per tenant (the codes are read and written under it).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.defect-library', current_setting('factory.tenant_id', true)), 0))`
    const rows = await tx.defectCode.findMany({ select: { id: true, code: true, parentId: true, sortOrder: true } })
    const byCode = new Map(rows.map((row) => [row.code, row]))
    const missing = missingStarter(new Set(byCode.keys()))
    const added: string[] = []
    let categoryOrder = Math.floor(Math.max(0, ...rows.filter((row) => row.parentId === null).map((row) => row.sortOrder)) / 100) * 100
    for (const category of missing.categories) {
      categoryOrder += 100
      const id = newId()
      const row = await tx.defectCode.create({
        data: { id, code: category.code, labelIt: category.labelIt, labelEn: category.labelEn, icon: category.icon, colour: category.colour, sortOrder: categoryOrder, createdAt: now, updatedAt: now, createdById: context.actorId },
        select: COLUMNS,
      })
      byCode.set(row.code, { id, code: row.code, parentId: null, sortOrder: row.sortOrder })
      tools.audit({ recordType: 'DefectCode', recordId: id, companyId: null, after: audited(row) })
      added.push(row.code)
    }
    for (const { category, defect } of missing.defects) {
      const parent = byCode.get(category)
      // A code of the starter set kept as a defect elsewhere, or a category the tenant made a defect: left alone.
      if (!parent || parent.parentId !== null) continue
      const id = newId()
      const siblings = [...byCode.values()].filter((row) => row.parentId === parent.id).map((row) => row.sortOrder)
      const row = await tx.defectCode.create({
        data: {
          id,
          parentId: parent.id,
          code: defect.code,
          labelIt: defect.labelIt,
          labelEn: defect.labelEn,
          severity: defect.severity as DbDefectClass,
          zone: defect.zone,
          stages: [...defect.stages] as DbStage[],
          needsDetail: defect.needsDetail ?? false,
          sortOrder: Math.max(parent.sortOrder, ...siblings) + 1,
          createdAt: now,
          updatedAt: now,
          createdById: context.actorId,
        },
        select: COLUMNS,
      })
      byCode.set(row.code, { id, code: row.code, parentId: parent.id, sortOrder: row.sortOrder })
      tools.audit({ recordType: 'DefectCode', recordId: id, companyId: null, after: audited(row) })
      added.push(row.code)
    }
    if (added.length === 0) tools.audit({ recordType: 'Tenant', recordId: context.tenantId, companyId: null, after: { starterDefects: 'nothing missing' } })
    changed(tools, 'STARTER_ADDED', added)
    return { added }
  })
  return result
}
