import type { Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { colourListProblems, normaliseColour } from '@nexus/factory-domain/product/materials/colours'
import type { CreateMaterialBody, MaterialRow, MaterialView, StandardCostBody, UpdateMaterialBody } from '@nexus/factory-domain/product/materials/contracts'
import { PRODUCT_MATERIALS_COST, PRODUCT_MATERIALS_MANAGE, PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { changeMaterial, materialMachine, newMaterial, standardCostProblems, type MaterialFields, type MaterialInput, type MaterialPatch, type MaterialStatus } from '@nexus/factory-domain/product/materials/rules'
import { carriedCost, decimalText, unconvertibleUnits, type Uom } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import type { ListMaterialsFilters } from './contract'
import {
  assertMayWrite,
  auditedFields,
  contextOf,
  fieldsOf,
  insertMaterial,
  isUniqueViolation,
  libraryColourProblems,
  MATERIAL_SCOPE,
  materialColumns,
  materialRowView,
  materialViewOf,
  readColours,
  readMaterial,
  seesCost,
  supplierProblems,
  viewInTx,
  writeFields,
  type MaterialRowData,
} from './store'

/**
 * The material library (plan A1 §2.4 B; A2 SCR-047, SCR-048; features PRD-024, PRD-025, PRD-028, PRD-030, PRD-032,
 * GAP-006): the list, one material, and its writes, each through command() with its audit rows and its event. The
 * domain (factory-domain product/materials, product/units) decides what a material may be; this file adds what only
 * the database knows: the code is free, the supplier is a supplier, the base unit is not on a BOM line yet, the units of
 * its BOM lines stay convertible, and the standard cost follows a base unit that moves.
 */

const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The material is not valid.', issues)

// ---- reads -------------------------------------------------------------------------------------------------------------

interface Cursor {
  readonly code: string
  readonly id: string
}

const encodeCursor = (cursor: Cursor): string => Buffer.from(JSON.stringify([cursor.code, cursor.id]), 'utf8').toString('base64url')

function decodeCursor(value: string | undefined): Cursor | null {
  if (value === undefined || value === '') return null
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as unknown
    if (Array.isArray(parsed) && parsed.length === 2 && typeof parsed[0] === 'string' && typeof parsed[1] === 'string') return { code: parsed[0], id: parsed[1] }
  } catch {
    // falls through to the refusal
  }
  throw new ValidationError('The cursor is not valid.', [{ path: 'querystring/cursor', message: 'Send back nextCursor as it came.' }])
}

/** The materials the caller may see, by code, one page at a time (SCR-047). */
export async function listMaterials(caller: CommandCaller, query: ListMaterialsFilters): Promise<{ materials: MaterialRow[]; nextCursor: string | null; count: number }> {
  const context = contextOf(caller)
  // Which materials lack a price is itself cost information: only for a holder of the cost grain.
  if (query.missingCost !== undefined && !seesCost(context)) throw new ForbiddenError('Filtering by the standard cost needs the cost grain (money.cost).')
  const search = query.q?.trim()
  const filters: Prisma.ItemWhereInput[] = [
    scopeWhere(actorOf(context), PRODUCT_MATERIALS_VIEW, MATERIAL_SCOPE) as Prisma.ItemWhereInput,
    // W2a wave 5: a finished garment's item (kind FINISHED) is stock, not a material of the library.
    { kind: { not: 'FINISHED' } },
    query.status === 'ALL' ? {} : { status: query.status },
    search
      ? {
          OR: [
            { code: { contains: search, mode: 'insensitive' } },
            { name: { contains: search, mode: 'insensitive' } },
            { supplierArticleCode: { contains: search, mode: 'insensitive' } },
          ],
        }
      : {},
    query.kind ? { kind: { in: query.kind } } : {},
    query.sourcing ? { sourcing: query.sourcing } : {},
    query.tracking ? { tracking: query.tracking } : {},
    query.supplierId ? { defaultSupplierId: query.supplierId } : {},
    query.requiresCrViTest === undefined ? {} : { requiresCrViTest: query.requiresCrViTest },
    query.ppeComponent === undefined ? {} : { isPpeComponent: query.ppeComponent },
    query.missingCost === undefined ? {} : query.missingCost ? { standardCost: null } : { standardCost: { not: null } },
    query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
  ]
  const cursor = decodeCursor(query.cursor)
  const after: Prisma.ItemWhereInput = cursor ? { OR: [{ code: { gt: cursor.code } }, { code: cursor.code, id: { gt: cursor.id } }] } : {}
  const [rows, count] = await caller.withClient((client) =>
    Promise.all([
      client.item.findMany({ where: { AND: [...filters, after] }, select: materialColumns(context), orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1 }),
      client.item.count({ where: { AND: filters } }),
    ]),
  )
  const page = (rows as MaterialRowData[]).slice(0, query.limit)
  const last = page.at(-1)
  return { materials: page.map(materialRowView), nextCursor: rows.length > query.limit && last ? encodeCursor(last) : null, count }
}

/** One material with its colours (SCR-048). */
export async function getMaterial(caller: CommandCaller, materialId: string): Promise<MaterialView> {
  const row = await readMaterial(caller, materialId)
  return materialViewOf(row, await caller.withClient((client) => readColours(client, materialId)))
}

// ---- create ------------------------------------------------------------------------------------------------------------

async function codeTaken(tx: CommandTx, code: string, except?: string): Promise<boolean> {
  return (await tx.item.findFirst({ where: { code, ...(except ? { id: { not: except } } : {}) }, select: { id: true } })) !== null
}
const codeConflict = (code: string) => new ConflictError(`The material code ${code} is taken.`)

/** The material fields of a create body (the company, cost and colours are not fields). */
function materialInputOf(body: CreateMaterialBody): MaterialInput {
  const { companyId: _company, standardCost: _cost, currency: _currency, colours: _colours, ...fields } = body
  return fields
}

/** product.materials.create: a material with its colours (and, for a person who may set it, its standard cost). */
export async function createMaterial(caller: CommandCaller, body: CreateMaterialBody, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, companyId)
  const standardCost = body.standardCost === undefined ? null : body.standardCost
  if (body.standardCost !== undefined) assertMayWrite(context, PRODUCT_MATERIALS_COST, companyId)

  const outcome = newMaterial(materialInputOf(body))
  const colours = (body.colours ?? []).map((colour) => ({ ...normaliseColour(colour), colourId: colour.colourId ?? null }))
  const currency = body.currency ?? 'EUR'
  const issues = [
    ...(outcome.ok ? [] : prefixed(outcome.issues)),
    ...prefixed(colourListProblems(colours)),
    ...prefixed(standardCostProblems(standardCost, currency)),
  ]
  if (issues.length > 0 || !outcome.ok) throw invalid(issues)
  const material = outcome.material

  const { result } = await command(caller, { name: 'product.materials.create', idempotencyKey, input: body }, async (tools) => {
    const { tx } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) {
      throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    }
    const problems = [
      ...(await supplierProblems(tx, material.defaultSupplierId, companyId)),
      ...(await Promise.all(colours.map((colour, index) => libraryColourProblems(tx, colour.colourId, companyId, `body/colours/${index}/colourId`)))).flat(),
    ]
    if (problems.length > 0) throw invalid(problems)
    if (await codeTaken(tx, material.code)) throw codeConflict(material.code)
    const id = await insertMaterial(tools, { companyId, fields: material, standardCost, currency, colours })
    return viewInTx(tx, tools.context, id)
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw codeConflict(material.code)
    throw error
  })
  return result
}

// ---- update ------------------------------------------------------------------------------------------------------------

function activeOnly(status: MaterialStatus): void {
  if (status !== 'ACTIVE') throw new InvalidStateError('This material is archived: reactivate it before changing it.')
}

/** The units its BOM lines use (any revision): a BOM line keeps its own unit, so the material must still convert it. */
async function bomUnits(tx: CommandTx, materialId: string): Promise<Uom[]> {
  const lines = await tx.bomLine.findMany({ where: { itemId: materialId }, select: { uom: true }, distinct: ['uom'] })
  return lines.map((line) => line.uom)
}

/**
 * product.materials.update: the fields sent (versioned, COL-078). A new base unit is refused while a BOM line uses the
 * material; its standard cost follows it when both units share a dimension (2.40 €/ft² → 25.833385 €/m²), and the move
 * is refused otherwise while a standard cost is set (the cost holder clears or changes it first).
 */
export async function updateMaterial(caller: CommandCaller, materialId: string, body: UpdateMaterialBody, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, seen.companyId)
  activeOnly(seen.status)
  const { version, ...patch } = body
  // Checked here first, so a refusal answers before any lock; checked again on the row the command locks.
  const preview = changeMaterial(fieldsOf(seen), patch as MaterialPatch)
  if (!preview.ok) throw invalid(prefixed(preview.issues))
  if (preview.changed.length === 0) return getMaterial(caller, materialId)

  const { result } = await command(
    caller,
    { name: 'product.materials.update', idempotencyKey, input: { materialId, ...body }, record: { type: 'Item', id: materialId, expectedVersion: version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { ...materialColumns(context), standardCost: true } })
      activeOnly(row.status)
      const current = fieldsOf(row)
      const change = changeMaterial(current, patch as MaterialPatch)
      if (!change.ok) throw invalid(prefixed(change.issues))
      const next = change.material
      const changed = change.changed
      const problems: Issue[] = []
      if (changed.includes('defaultSupplierId')) problems.push(...(await supplierProblems(tx, next.defaultSupplierId, row.companyId)))
      if (problems.length > 0) throw invalid(problems)
      if (changed.includes('code') && (await codeTaken(tx, next.code, materialId))) throw codeConflict(next.code)

      let costChange: { before: string | null; after: string | null } | null = null
      const unitsMoved = changed.some((field) => field === 'baseUom' || field === 'purchaseUom' || field === 'purchaseFactor' || field === 'consumptionUom' || field === 'consumptionFactor')
      if (unitsMoved) {
        const used = await bomUnits(tx, materialId)
        if (changed.includes('baseUom') && used.length > 0) {
          throw new ConflictError(`This material is on BOM lines, so its base unit stays ${current.baseUom}.`)
        }
        const lost = unconvertibleUnits(used, next)
        if (lost.length > 0) throw new ConflictError(`BOM lines use this material in ${lost.join(', ')}, which it would no longer convert.`)
      }
      const cost = row.standardCost === null ? null : decimalText(row.standardCost.toString())
      if (changed.includes('baseUom') && cost !== null) {
        const carried = carriedCost(cost, current.baseUom, next.baseUom)
        if (carried === null) {
          throw new ConflictError(`The standard cost is per ${current.baseUom}; it cannot follow the base unit to ${next.baseUom}. Remove or change the standard cost first.`)
        }
        costChange = { before: cost, after: carried }
      }

      const changes = Object.fromEntries(changed.map((field) => [field, next[field]])) as Partial<MaterialFields>
      await writeFields(tx, materialId, changes, costChange ? { standardCost: costChange.after } : {})
      const before = Object.fromEntries(changed.map((field) => [field, current[field]])) as Partial<MaterialFields>
      tools.audit({
        recordType: 'Item',
        recordId: materialId,
        companyId: row.companyId,
        before: { ...auditedFields(before), ...(costChange ? { standardCost: markMoney('cost', costChange.before) } : {}) },
        after: { ...auditedFields(changes), ...(costChange ? { standardCost: markMoney('cost', costChange.after) } : {}) },
      })
      if (changed.length > 0) tools.emit({ type: 'material.updated', subject: materialId, companyId: row.companyId, payload: { itemId: materialId, code: next.code, fields: [...changed] } })
      if (costChange) tools.emit({ type: 'material.standard_cost_changed', subject: materialId, companyId: row.companyId, payload: { itemId: materialId, code: next.code } })
      return viewInTx(tx, context, materialId)
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The material code is taken.')
    throw error
  })
  return result
}

// ---- archive, reactivate -----------------------------------------------------------------------------------------------

/** product.materials.archive / reactivate: out of new use and back (PRD-022: a material in use is never deleted). */
export async function moveMaterial(caller: CommandCaller, materialId: string, to: MaterialStatus, body: { version: number; reason?: string | undefined }, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_MANAGE, seen.companyId)
  const name = to === 'ARCHIVED' ? 'product.materials.archive' : 'product.materials.reactivate'
  const { result } = await command(
    caller,
    { name, idempotencyKey, input: { materialId, ...body }, record: { type: 'Item', id: materialId, expectedVersion: body.version, transition: { machine: materialMachine, to } } },
    async (tools) => {
      const { tx, record } = tools
      tools.audit({ recordType: 'Item', recordId: materialId, companyId: seen.companyId, before: { status: record!.from }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'material.status_changed', subject: materialId, companyId: seen.companyId, payload: { itemId: materialId, code: seen.code, status: to } })
      return viewInTx(tx, context, materialId)
    },
  )
  return result
}

// ---- the standard purchase price (GAP-006) -----------------------------------------------------------------------------

/**
 * product.materials.setStandardCost: the standard purchase price per base unit, and its currency, by a person who may
 * set it (product.materials.cost) and sees it (the cost grain; the grain filter refuses the body otherwise). The audit
 * row keeps the price before and after, marked with the cost grain, and the reason.
 */
export async function setStandardCost(caller: CommandCaller, materialId: string, body: StandardCostBody, idempotencyKey?: string): Promise<MaterialView> {
  const context = contextOf(caller)
  const seen = await readMaterial(caller, materialId)
  assertMayWrite(context, PRODUCT_MATERIALS_COST, seen.companyId)
  activeOnly(seen.status)
  if (body.standardCost === undefined) throw invalid([{ path: 'body/standardCost', message: 'Send the standard cost per base unit, or null to remove it.' }])
  const standardCost = body.standardCost === null ? null : decimalText(body.standardCost)
  const currency = body.currency ?? seen.currency
  const problems = standardCostProblems(standardCost, currency)
  if (problems.length > 0) throw invalid(prefixed(problems))
  if (!('standardCost' in seen)) throw new ForbiddenError()

  const { result } = await command(
    caller,
    { name: 'product.materials.setStandardCost', idempotencyKey, input: { materialId, ...body }, record: { type: 'Item', id: materialId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: { status: true, standardCost: true, currency: true, companyId: true, code: true } })
      activeOnly(row.status)
      const before = row.standardCost === null ? null : decimalText(row.standardCost.toString())
      await tx.item.update({ where: { id: materialId }, data: { standardCost, currency }, select: { id: true } })
      tools.audit({
        recordType: 'Item',
        recordId: materialId,
        companyId: row.companyId,
        before: { standardCost: markMoney('cost', before), currency: row.currency },
        after: { standardCost: markMoney('cost', standardCost), currency },
        ...(body.reason ? { reason: body.reason } : {}),
      })
      tools.emit({ type: 'material.standard_cost_changed', subject: materialId, companyId: row.companyId, payload: { itemId: materialId, code: row.code } })
      return viewInTx(tx, context, materialId)
    },
  )
  return result
}

