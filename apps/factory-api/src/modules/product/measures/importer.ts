import type { Prisma } from '@nexus/factory-db'
import { newId } from '@nexus/factory-domain/core/ids'
import { fieldsFromRow, importRecordValues, pointsOfMeasureImporter } from '@nexus/factory-domain/product/measures/importer'
import { kindChangeRefusal, pomChanges, pomProblems, type PomKind, type PomStatus } from '@nexus/factory-domain/product/measures/rules'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { CommandTx } from '../../../core/command'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { ImportAdapter } from '../../../platform/imports/registry'
import { mayWrite } from '../materials/store'
import { isUniqueViolation, POM_COLUMNS, pomFieldsOf, pomUses } from './store'

/**
 * The point of measure library's import adapter (platform/imports; B-W2b-224, PRD-062; design products.sizes "Import
 * (W2b)"): factory-domain's `pointsOfMeasureImporter` decides what each row does in the dry run; this loads the points
 * the codes find (whatever the letter case: the library keeps a code once), checks the body point a row names by code
 * (a BODY point, active), and writes one planned row inside the batch's command, audited, with
 * `point_of_measure.changed`, as the library's routes do. Writing needs product.styles.manage, seeing the plans
 * product.styles.view; a job for every company needs product.styles.manage over every company.
 */

const ACTION = 'product.measures.import'

class ImportRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits the point of measure: ${detail}. Run the dry run again.`)
  }
}

async function bodyPointByCode(tx: CommandTx, code: string): Promise<{ id: string; code: string; kind: PomKind; status: PomStatus } | null> {
  const row = await tx.pointOfMeasure.findFirst({ where: { code: { equals: code, mode: 'insensitive' } }, select: { id: true, code: true, kind: true, status: true } })
  return row ? { id: row.id, code: row.code, kind: row.kind as PomKind, status: row.status as PomStatus } : null
}

export const pointsOfMeasureImportAdapter = Object.freeze({
  importer: pointsOfMeasureImporter,
  permission: PRODUCT_STYLES_MANAGE,
  viewPermission: PRODUCT_STYLES_VIEW,

  authorize(actor, job) {
    if (job.companyId === null && !mayWrite(actor, PRODUCT_STYLES_MANAGE, null)) {
      return [{ path: 'companyId', message: 'A points of measure import for every company needs product.styles.manage over every company; import for one company instead.' }]
    }
    return []
  },

  async check(client, rows) {
    const out: { column?: string; message: string }[][] = []
    for (const row of rows) {
      const issues: { column?: string; message: string }[] = []
      const named = row.values.bodyPoint
      if (typeof named === 'string') {
        const body = await bodyPointByCode(client, named)
        if (!body) issues.push({ column: 'bodyPoint', message: `No point of measure ${named}.` })
        else if (body.kind !== 'BODY') issues.push({ column: 'bodyPoint', message: `${body.code} is a garment point: name a body point.` })
        else if (body.status !== 'ACTIVE') issues.push({ column: 'bodyPoint', message: `${body.code} is archived.` })
      }
      out.push(issues)
    }
    return out
  },

  async load(client, keys, scope) {
    const codes = keys.map((key) => String(key.code))
    const rows = await client.pointOfMeasure.findMany({ where: { OR: codes.map((code) => ({ code: { equals: code, mode: 'insensitive' as const } })) }, select: POM_COLUMNS })
    const uses = await pomUses(
      client,
      rows.map((row) => row.id),
    )
    const bodies = new Map(
      (await client.pointOfMeasure.findMany({ where: { id: { in: rows.flatMap((row) => (row.bodyPointId ? [row.bodyPointId] : [])) } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]),
    )
    // The engine finds a record by its key as the sheet wrote it: a code is matched whatever its letter case.
    return codes.flatMap((asked) => {
      const row = rows.find((entry) => entry.code.toUpperCase() === asked.toUpperCase())
      return row ? [{ row, asked }] : []
    }).map(({ row, asked }) => ({
      id: row.id,
      values: importRecordValues({
        fields: { ...pomFieldsOf(row), code: asked },
        bodyPointCode: row.bodyPointId ? (bodies.get(row.bodyPointId) ?? null) : null,
        status: row.status as PomStatus,
        foreign: row.companyId !== scope.companyId,
        use: uses.get(row.id)!,
      }),
    }))
  },

  async write(tools, row, scope) {
    const { tx, now } = tools
    const code = String(row.key.code)
    const named = row.values.bodyPoint
    const body = typeof named === 'string' ? await bodyPointByCode(tx, named) : undefined
    if (body === null || (body && (body.kind !== 'BODY' || body.status !== 'ACTIVE'))) throw new ImportRowRefused(code, `body point ${String(named)} is no active body point`)

    if (row.action === 'CREATE') {
      const fields = { ...fieldsFromRow(row.values, null), bodyPointId: body?.id ?? null }
      const problems = pomProblems(fields, { id: null, bodyPoint: body ? { ...body, uom: 'CM' } : undefined })
      if (problems.length > 0) throw new ImportRowRefused(code, problems.map((issue) => issue.message).join(' '))
      if (await tx.pointOfMeasure.findFirst({ where: { code: { equals: fields.code, mode: 'insensitive' } }, select: { id: true } })) throw new ImportRowRefused(code, 'the code was taken since (whatever the letter case)')
      const id = newId()
      await tx.pointOfMeasure
        .create({
          data: { id, companyId: scope.companyId, ...fields, nameI18n: fields.nameI18n ?? undefined, howToI18n: fields.howToI18n ?? undefined, createdAt: now, updatedAt: now, createdById: tools.context.audience === 'office' ? tools.context.actorId : null },
          select: { id: true },
        })
        // B-W2b-283 (FU1:05): the database's one code whatever the letter case (PointOfMeasure_tenantId_lower_code_key), in words.
        .catch((error: unknown) => {
          if (isUniqueViolation(error)) throw new ImportRowRefused(code, 'the code was taken since (whatever the letter case)')
          throw error
        })
      tools.audit({ action: ACTION, recordType: 'PointOfMeasure', recordId: id, companyId: scope.companyId, after: { companyId: scope.companyId, ...fields, status: 'ACTIVE' } })
      tools.emit({ type: 'point_of_measure.changed', subject: id, companyId: scope.companyId, payload: { pointOfMeasureId: id, code: fields.code, change: 'CREATED' } })
      return { recordId: id }
    }

    const recordId = row.recordId!
    // The row FOR UPDATE: the library's own writes compare and set its version under the same lock.
    await tx.$queryRaw`SELECT "id" FROM "PointOfMeasure" WHERE "id" = ${recordId}::uuid FOR UPDATE`
    const current = await tx.pointOfMeasure.findUniqueOrThrow({ where: { id: recordId }, select: POM_COLUMNS })
    if (current.status !== 'ACTIVE' || current.companyId !== scope.companyId) throw new ImportRowRefused(code, 'it was archived or moved')
    const before = pomFieldsOf(current)
    const next = { ...fieldsFromRow(row.values, before), bodyPointId: body ? body.id : before.bodyPointId }
    const problems = pomProblems(next, { id: recordId, bodyPoint: body ? { ...body, uom: 'CM' } : undefined })
    if (problems.length > 0) throw new ImportRowRefused(code, problems.map((issue) => issue.message).join(' '))
    const changed = pomChanges(before, next)
    const refusal = kindChangeRefusal(current.code, changed, (await pomUses(tx, [recordId])).get(recordId)!)
    if (refusal) throw new ImportRowRefused(code, refusal)
    if (changed.length > 0) {
      const data = Object.fromEntries(changed.map((field) => [field, next[field] ?? undefined])) as Prisma.PointOfMeasureUncheckedUpdateInput
      await tx.pointOfMeasure.update({ where: { id: recordId }, data: { ...data, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({
        action: ACTION,
        recordType: 'PointOfMeasure',
        recordId,
        companyId: current.companyId,
        before: Object.fromEntries(changed.map((field) => [field, before[field]])),
        after: Object.fromEntries(changed.map((field) => [field, next[field]])),
      })
      tools.emit({ type: 'point_of_measure.changed', subject: recordId, companyId: current.companyId, payload: { pointOfMeasureId: recordId, code: next.code, change: 'UPDATED' } })
    }
    return { recordId }
  },
} satisfies ImportAdapter)
