import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import type { Issue } from '@nexus/factory-domain/core/errors'
import type { CellValue } from '@nexus/factory-domain/imports/cells'
import { markValues } from '@nexus/factory-domain/imports/importer'
import { coloursOf, importRecordValues, materialImporter, materialInputOf, patchOfRow } from '@nexus/factory-domain/product/materials/importer'
import { PRODUCT_MATERIALS_COST, PRODUCT_MATERIALS_MANAGE, PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { changeMaterial, newMaterial, type MaterialFields } from '@nexus/factory-domain/product/materials/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { ApiError } from '../../../core/errors'
// Types only: platform/imports/registry.ts lists this adapter, so a value import back from it would be a cycle.
import type { ImportAdapter } from '../../../platform/imports/registry'
import { COLOUR_COLUMNS, fieldsOf, insertMaterial, MATERIAL_COLUMNS_WITH_COST, mayWrite, upsertColours, writeFields } from './store'

/**
 * The material import's adapter (platform/imports; features PLT-176, PRD-040): factory-domain's `materialImporter`
 * decides what each row does in the dry run; this loads the materials the codes find and writes one planned row inside
 * the batch's command. Writing needs product.materials.manage, seeing the plans product.materials.view (the engine
 * checks both against the job's company), and a sheet that maps the standard cost column needs the cost grain.
 * `authorize` adds the routes' own rules, at the start, in the dry run and at the apply: a job for every company (no
 * company) needs product.materials.manage over every company; a sheet that maps the standard cost needs
 * product.materials.cost and the cost grain over the job's company (every company for a tenant-wide job).
 *
 * Load finds a code in the whole tenant: a code of another company's material is a row error of the plan, never a
 * duplicate insert. Write checks the material again as it is now and refuses (a failed batch, applied again later)
 * a row the dry run would now refuse; the routes' rules on suppliers and BOM lines do not arise, as an import sets no
 * supplier and never moves the base unit.
 */

const ACTION = 'product.materials.import'

/** Stops the batch: the material changed since the dry run in a way the row no longer fits. */
class ImportRowRefused extends ApiError {
  constructor(code: string, detail: string) {
    super('conflict', `The import row for ${code} no longer fits the material: ${detail}. Run the dry run again.`)
  }
}

export const materialsImportAdapter = Object.freeze({
  importer: materialImporter,
  permission: PRODUCT_MATERIALS_MANAGE,
  viewPermission: PRODUCT_MATERIALS_VIEW,

  authorize(actor, job, columns) {
    const issues: Issue[] = []
    const reach = job.companyId === null ? 'over every company' : "for the import's company"
    if (job.companyId === null && !mayWrite(actor, PRODUCT_MATERIALS_MANAGE, null)) {
      issues.push({ path: 'companyId', message: 'A materials import for every company needs product.materials.manage over every company; import for one company instead.' })
    }
    if (columns.includes('standardCost')) {
      if (!mayWrite(actor, PRODUCT_MATERIALS_COST, job.companyId)) issues.push({ path: 'column/standardCost', message: `Importing the standard cost needs product.materials.cost ${reach}.` })
      // Without the grain at all, the engine already says so; here, a grain held for other companies only.
      if (heldGrains(actor).has('cost') && !mayWrite(actor, 'money.cost', job.companyId)) issues.push({ path: 'column/standardCost', message: `Importing the standard cost needs the cost grain ${reach}.` })
    }
    return issues
  },

  async load(client, keys, scope) {
    const codes = keys.map((key) => String(key.code))
    const rows = await client.item.findMany({ where: { code: { in: codes } }, select: { ...MATERIAL_COLUMNS_WITH_COST, colours: { select: COLOUR_COLUMNS } } })
    return rows.map((row) => ({
      id: row.id,
      values: importRecordValues({
        fields: fieldsOf(row),
        status: row.status,
        foreign: row.companyId !== scope.companyId,
        colours: row.colours.filter((colour) => colour.status === 'ACTIVE').map((colour) => ({ code: colour.code, name: colour.name, supplierColourCode: colour.supplierColourCode })),
        standardCost: row.standardCost === null ? null : decimalText(row.standardCost.toString()),
      }),
    }))
  },

  async write(tools, row, scope) {
    const values = row.values
    const code = String(row.key.code)
    const cost = typeof values.standardCost === 'string' ? decimalText(values.standardCost) : undefined
    if (row.action === 'CREATE') {
      const outcome = newMaterial(materialInputOf(values))
      if (!outcome.ok) throw new ImportRowRefused(code, outcome.issues.map((issue) => issue.message).join(' '))
      const recordId = await insertMaterial(
        tools,
        { companyId: scope.companyId, fields: outcome.material, standardCost: cost ?? null, currency: 'EUR', colours: coloursOf(values) },
        ACTION,
      )
      return { recordId }
    }

    const { tx } = tools
    const recordId = row.recordId!
    const current = await tx.item.findUniqueOrThrow({ where: { id: recordId }, select: { ...MATERIAL_COLUMNS_WITH_COST } })
    if (current.status !== 'ACTIVE' || current.companyId !== scope.companyId) throw new ImportRowRefused(code, 'it was archived or moved')
    const before = fieldsOf(current)
    const change = changeMaterial(before, patchOfRow(values))
    if (!change.ok) throw new ImportRowRefused(code, change.issues.map((issue) => issue.message).join(' '))
    const changed = change.changed
    const changes = Object.fromEntries(changed.map((field) => [field, change.material[field]])) as Partial<MaterialFields>
    // command() bumps only the record it guards (the import job): the material's version moves here, so an open edit
    // of it sees the import as a newer version.
    await writeFields(tx, recordId, changes, { version: { increment: 1 }, ...(cost === undefined ? {} : { standardCost: cost }) })
    if (changed.length > 0 || cost !== undefined) {
      tools.audit({
        action: ACTION,
        recordType: 'Item',
        recordId,
        companyId: current.companyId,
        before: markValues(materialImporter, row.before),
        after: markValues(materialImporter, { ...Object.fromEntries(changed.map((field) => [field, change.material[field] as CellValue | null])), ...(cost === undefined ? {} : { standardCost: cost }) }),
      })
    }
    if (changed.length > 0) tools.emit({ type: 'material.updated', subject: recordId, companyId: current.companyId, payload: { itemId: recordId, code: change.material.code, fields: [...changed] } })
    if (cost !== undefined) tools.emit({ type: 'material.standard_cost_changed', subject: recordId, companyId: current.companyId, payload: { itemId: recordId, code: change.material.code } })

    const colours = coloursOf(values)
    if (colours.length > 0) {
      const touched = await upsertColours(tools, { id: recordId, companyId: current.companyId }, colours, ACTION)
      if (touched.length > 0) tools.emit({ type: 'material.colours_changed', subject: recordId, companyId: current.companyId, payload: { itemId: recordId, code: change.material.code, itemColourIds: touched } })
    }
    return { recordId }
  },
} satisfies ImportAdapter)
