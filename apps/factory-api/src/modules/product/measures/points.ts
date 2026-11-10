import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { CreatePomBody, ListPomsQuery, PomRow, PomStatusBody, PomView, UpdatePomBody } from '@nexus/factory-domain/product/measures/contracts'
import { kindChangeRefusal, normalisePom, patchedPom, pomChanges, pomProblems, useWords, type BodyPointFacts, type PomFields, type PomKind, type PomStatus, type PomUom } from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { afterCursor, decodeCursor, encodeCursor } from '../styles/cursor'
import { assertMayWrite, bodyPointsOf, contextOf, invalid, isUniqueViolation, POM_COLUMNS, POM_SCOPE, pomFieldsOf, pomRowOf, pomUses, prefixed, readPomFor, type PomRowData } from './store'

/**
 * The point of measure library (B-W2b-224; PRD-062, PRD-069; design products.sizes "Points of measure": code, name, how
 * to measure with its picture, unit, default tolerance; inline edit with autosave; the list's selection archived or
 * restored). Office only, product.styles.view | manage over the point's company, as the size scales. Every write is one
 * command on the point (command()'s record guard: its version), audited, with `point_of_measure.changed`. A code is
 * unique in the tenant whatever its letter case (the final inspection matches it so); the kind and unit stay once
 * anything names the point; a garment point may name its body point (PRD-069).
 */

const NOUN = 'point of measure'

const codeTaken = (code: string) => new ConflictError(`The point of measure code ${code} is taken (whatever the letter case).`)

/** Another point with this code, whatever the case (the unique key is exact; the inspection matches without case). */
async function codeClash(tx: CommandTx, code: string, exceptId: string | null): Promise<boolean> {
  const rows = await tx.pointOfMeasure.findMany({ where: { code: { equals: code, mode: 'insensitive' }, ...(exceptId ? { id: { not: exceptId } } : {}) }, select: { id: true }, take: 1 })
  return rows.length > 0
}

/** The body point a garment point names, as the rules read it (null: none such in the tenant). */
async function bodyPointFacts(tx: CommandTx, id: string | null): Promise<BodyPointFacts | null | undefined> {
  if (id === null) return undefined
  const row = await tx.pointOfMeasure.findUnique({ where: { id }, select: { id: true, code: true, kind: true, uom: true, status: true } })
  return row ? { id: row.id, code: row.code, kind: row.kind as PomKind, uom: row.uom as PomUom, status: row.status as PomStatus } : null
}

const audited = (fields: PomFields): Record<string, unknown> => ({ ...fields })

function changed(tools: CommandTools, row: { id: string; code: string; companyId: string | null }, change: 'CREATED' | 'UPDATED' | 'ARCHIVED' | 'RESTORED' | 'PICTURE'): void {
  tools.emit({ type: 'point_of_measure.changed', subject: row.id, companyId: row.companyId, payload: { pointOfMeasureId: row.id, code: row.code, change } })
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** The points the caller may see, by code (design sizes.poms). */
export async function listPoms(caller: CommandCaller, query: ListPomsQuery): Promise<{ points: PomRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  const search = query.q?.trim()
  const filters: Prisma.PointOfMeasureWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, POM_SCOPE) as Prisma.PointOfMeasureWhereInput,
    query.status === 'ALL' ? {} : { status: query.status },
    query.kind ? { kind: query.kind } : {},
    query.zone ? { bodyZone: query.zone } : {},
    search ? { OR: [{ code: { contains: search, mode: 'insensitive' } }, { name: { contains: search, mode: 'insensitive' } }] } : {},
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCursor(query.cursor)
  return caller.withClient(async (client) => {
    const rows = await client.pointOfMeasure.findMany({ where: { AND: [...filters, afterCursor(cursor)] }, select: POM_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 })
    const count = await client.pointOfMeasure.count({ where: { AND: filters } })
    const page = rows.slice(0, query.limit)
    const bodyPoints = await bodyPointsOf(client, page)
    const last = page.at(-1)
    return { points: page.map((row) => pomRowOf(row, bodyPoints)), nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null, count }
  })
}

async function pomViewWith(client: CommandTx | Parameters<Parameters<CommandCaller['withClient']>[0]>[0], row: PomRowData): Promise<PomView> {
  const bodyPoints = await bodyPointsOf(client, [row])
  const use = (await pomUses(client, [row.id])).get(row.id)!
  const garmentPoints = await client.pointOfMeasure.findMany({ where: { bodyPointId: row.id }, select: { id: true, code: true, name: true }, orderBy: { code: 'asc' } })
  const picture = row.pictureFileId ? await client.storedFile.findUnique({ where: { id: row.pictureFileId }, select: { id: true, status: true, originalName: true } }) : null
  return {
    ...pomRowOf(row, bodyPoints),
    use: { specValues: use.specValues, specs: use.specs, gradeSteps: use.gradeSteps, gradeRules: use.gradeRules, templatePoints: use.templatePoints, garmentPoints, words: useWords(use) },
    picture: picture ? { fileId: picture.id, status: String(picture.status), originalName: picture.originalName } : null,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}

/** One point with what names it and its picture. */
export async function getPom(caller: CommandCaller, pomId: string): Promise<PomView> {
  const row = await readPomFor(caller, pomId)
  return caller.withClient((client) => pomViewWith(client, row))
}

export async function pomViewInTx(tx: CommandTx, pomId: string): Promise<PomView> {
  return pomViewWith(tx, await tx.pointOfMeasure.findUniqueOrThrow({ where: { id: pomId }, select: POM_COLUMNS }))
}

// ---- writes -------------------------------------------------------------------------------------------------------------

/** product.measures.createPoint: a point of the library. */
export async function createPom(caller: CommandCaller, body: CreatePomBody, idempotencyKey?: string): Promise<PomView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, companyId, NOUN)
  const fields = normalisePom({
    code: body.code,
    name: body.name,
    nameI18n: body.nameI18n ?? null,
    description: body.description ?? null,
    howTo: body.howTo ?? null,
    howToI18n: body.howToI18n ?? null,
    kind: body.kind,
    bodyZone: body.bodyZone,
    uom: body.uom,
    defaultTolerance: body.defaultTolerance ?? null,
    bodyPointId: body.bodyPointId ?? null,
  })
  const early = prefixed(pomProblems(fields))
  if (early.length > 0) throw invalid(early, NOUN)

  const { result } = await command(caller, { name: 'product.measures.createPoint', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }], NOUN)
    const problems = prefixed(pomProblems(fields, { id: null, bodyPoint: await bodyPointFacts(tx, fields.bodyPointId) }))
    if (problems.length > 0) throw invalid(problems, NOUN)
    if (await codeClash(tx, fields.code, null)) throw codeTaken(fields.code)
    const id = newId()
    await tx.pointOfMeasure.create({
      data: {
        id,
        companyId,
        ...fields,
        nameI18n: fields.nameI18n ?? undefined,
        howToI18n: fields.howToI18n ?? undefined,
        createdAt: now,
        updatedAt: now,
        createdById: tools.context.audience === 'office' ? tools.context.actorId : null,
      },
      select: { id: true },
    })
    tools.audit({ recordType: 'PointOfMeasure', recordId: id, companyId, after: { companyId, ...audited(fields), status: 'ACTIVE' } })
    changed(tools, { id, code: fields.code, companyId }, 'CREATED')
    return pomViewInTx(tx, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeTaken(fields.code)
    throw error
  })
  return result
}

/** A words column cleared: factory-db exports Prisma's types, not its runtime DbNull, so a JSON column is cleared in SQL. */
async function clearWords(tx: CommandTx, pomId: string, field: 'nameI18n' | 'howToI18n'): Promise<void> {
  if (field === 'nameI18n') await tx.$executeRaw`UPDATE "PointOfMeasure" SET "nameI18n" = NULL WHERE "id" = ${pomId}::uuid`
  else await tx.$executeRaw`UPDATE "PointOfMeasure" SET "howToI18n" = NULL WHERE "id" = ${pomId}::uuid`
}

/**
 * product.measures.updatePoint: the fields sent (a cell of the list); `status` archives or restores. The kind and unit
 * stay once anything names the point (said in words before the database refuses).
 */
export async function updatePom(caller: CommandCaller, pomId: string, body: UpdatePomBody, idempotencyKey?: string): Promise<PomView> {
  const context = contextOf(caller)
  const seen = await readPomFor(caller, pomId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId, NOUN)
  const { version, status, ...patch } = body

  const { result } = await command(
    caller,
    { name: 'product.measures.updatePoint', idempotencyKey, input: { pomId, ...body }, record: { type: 'PointOfMeasure', id: pomId, expectedVersion: version } },
    async (tools) => {
      const { tx, now } = tools
      const row = await tx.pointOfMeasure.findUniqueOrThrow({ where: { id: pomId }, select: POM_COLUMNS })
      const before = pomFieldsOf(row)
      const next = patchedPom(before, patch)
      const fields = pomChanges(before, next)
      const move = status !== undefined && status !== row.status ? status : undefined
      if (fields.length === 0 && !move) throw invalid([{ path: 'body', message: 'Nothing changes: name a field with a new value.' }], NOUN)
      if (fields.length > 0 && row.status !== 'ACTIVE' && move !== 'ACTIVE') throw new InvalidStateError(`Point of measure ${row.code} is archived: restore it before changing it.`)
      const problems = prefixed(pomProblems(next, { id: pomId, bodyPoint: fields.includes('bodyPointId') ? await bodyPointFacts(tx, next.bodyPointId) : undefined }))
      if (problems.length > 0) throw invalid(problems, NOUN)
      const use = (await pomUses(tx, [pomId])).get(pomId)!
      const refusal = kindChangeRefusal(row.code, fields, use)
      if (refusal) throw new ConflictError(refusal)
      if (fields.includes('kind') && next.kind === 'BODY' && use.garmentPoints > 0) throw new ConflictError(`Garment points answer to ${row.code}: it stays a body point.`)
      if (fields.includes('code') && (await codeClash(tx, next.code, pomId))) throw codeTaken(next.code)
      const data: Prisma.PointOfMeasureUncheckedUpdateInput = { updatedAt: now }
      const cleared: ('nameI18n' | 'howToI18n')[] = []
      for (const field of fields) {
        if (field === 'nameI18n' || field === 'howToI18n') {
          const words = next[field]
          if (words === null) cleared.push(field)
          else data[field] = words as Prisma.InputJsonValue
        } else (data as Record<string, unknown>)[field] = next[field]
      }
      if (move) data.status = move
      await tx.pointOfMeasure.update({ where: { id: pomId }, data, select: { id: true } })
      for (const field of cleared) await clearWords(tx, pomId, field)
      const was = audited(before)
      const is = audited(next)
      tools.audit({
        recordType: 'PointOfMeasure',
        recordId: pomId,
        companyId: row.companyId,
        before: { ...Object.fromEntries(fields.map((field) => [field, was[field]])), ...(move ? { status: row.status } : {}) },
        after: { ...Object.fromEntries(fields.map((field) => [field, is[field]])), ...(move ? { status: move } : {}) },
      })
      changed(tools, { id: pomId, code: next.code, companyId: row.companyId }, move === 'ARCHIVED' ? 'ARCHIVED' : move === 'ACTIVE' ? 'RESTORED' : 'UPDATED')
      return pomViewInTx(tx, pomId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeTaken(body.code ?? seen.code)
    throw error
  })
  return result
}

/**
 * product.measures.pointsStatus: the list's selection archived or restored in one write (all or none: a point at another
 * version than read, or another company's, is named). An archived point stays in the specs and rules that name it.
 */
export async function setPomStatus(caller: CommandCaller, body: PomStatusBody, idempotencyKey?: string): Promise<{ points: PomRow[] }> {
  const context = contextOf(caller)
  const ids = body.points.map((point) => point.id)
  if (new Set(ids).size !== ids.length) throw invalid([{ path: 'body/points', message: 'Each point once.' }], NOUN)
  const seen = await Promise.all(ids.map((id) => readPomFor(caller, id)))
  for (const row of seen) assertMayWrite(context, PRODUCT_STYLES_MANAGE, row.companyId, NOUN)

  const { result } = await command(caller, { name: 'product.measures.pointsStatus', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    const sorted = [...body.points].sort((a, b) => (a.id < b.id ? -1 : 1))
    const issues: Issue[] = []
    const moved: PomRowData[] = []
    for (const asked of sorted) {
      const [locked] = await tx.$queryRaw<{ version: number }[]>`SELECT "version" FROM "PointOfMeasure" WHERE "id" = ${asked.id}::uuid FOR UPDATE`
      if (!locked) throw new NotFoundError('Point of measure not found.')
      const row = seen.find((entry) => entry.id === asked.id)!
      if (locked.version !== asked.version) issues.push({ path: `body/points/${asked.id}/version`, message: `${row.code} changed since it was read: load the list again.` })
      else if (row.status !== body.status) moved.push(row)
    }
    if (issues.length > 0) throw new ConflictError(issues.map((issue) => issue.message).join(' '))
    for (const row of moved) {
      await tx.pointOfMeasure.update({ where: { id: row.id }, data: { status: body.status, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ recordType: 'PointOfMeasure', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: body.status } })
      changed(tools, row, body.status === 'ARCHIVED' ? 'ARCHIVED' : 'RESTORED')
    }
    if (moved.length === 0) tools.audit({ recordType: 'PointOfMeasure', recordId: sorted[0]!.id, after: { status: body.status, unchanged: ids } })
    const rows = await tx.pointOfMeasure.findMany({ where: { id: { in: ids } }, select: POM_COLUMNS, orderBy: { code: 'asc' } })
    const bodyPoints = await bodyPointsOf(tx, rows)
    return { points: rows.map((row) => pomRowOf(row, bodyPoints)) }
  })
  return result
}
