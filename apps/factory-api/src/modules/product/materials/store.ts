import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Actor, type Permission, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { ColourFields } from '@nexus/factory-domain/product/materials/colours'
import type { ColourView, MaterialRow, MaterialView } from '@nexus/factory-domain/product/materials/contracts'
import { PRODUCT_MATERIALS_VIEW } from '@nexus/factory-domain/product/materials/permissions'
import { materialWarnings, type FibreShare, type LocalisedNames, type MaterialFields, type MaterialStatus } from '@nexus/factory-domain/product/materials/rules'
import { COST_SCALE, decimalText, fixedRatio, unitCostIn } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'

/**
 * The material library's rows (factory-db `Item`, `ItemColour`): the columns every read names (never a bare select:
 * a role without a grant on a column, the floor's on standardCost, fails the whole query), how a row becomes the
 * domain's MaterialFields and the contracts' views, who may see and write which material, and the writes shared by the
 * routes and the importer (always inside a command()).
 *
 * The standard cost (`@grain cost`) is selected only for a caller who holds the cost grain, and its audit values are
 * marked with markMoney('cost', …): a person without the grain sees it in no answer and no audit history.
 */

export const MATERIAL_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

const FIELD_COLUMNS = {
  code: true,
  name: true,
  nameI18n: true,
  kind: true,
  sourcing: true,
  tracking: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  defaultSupplierId: true,
  supplierArticleCode: true,
  animalSpecies: true,
  tannage: true,
  grade: true,
  finish: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  composition: true,
  animalOrigin: true,
  attributes: true,
  isPpeComponent: true,
  requiresCrViTest: true,
  crViLimitMgKg: true,
} as const satisfies Prisma.ItemSelect

const SUPPLIER = { select: { id: true, code: true, legalName: true, tradeName: true } } as const

/** Every column a person without the cost grain may read. */
export const MATERIAL_COLUMNS = {
  id: true,
  companyId: true,
  ...FIELD_COLUMNS,
  currency: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  defaultSupplier: SUPPLIER,
  _count: { select: { colours: { where: { status: 'ACTIVE' } } } },
} as const satisfies Prisma.ItemSelect
/** …and the standard cost. */
export const MATERIAL_COLUMNS_WITH_COST = { ...MATERIAL_COLUMNS, standardCost: true } as const satisfies Prisma.ItemSelect

export const COLOUR_COLUMNS = {
  id: true,
  itemId: true,
  code: true,
  name: true,
  supplierColourCode: true,
  colourId: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.ItemColourSelect

type CostRow = Prisma.ItemGetPayload<{ select: typeof MATERIAL_COLUMNS_WITH_COST }>
/** A material row as read: with its standard cost only when the reader holds the cost grain. */
export type MaterialRowData = Omit<CostRow, 'standardCost'> & { readonly standardCost?: CostRow['standardCost'] }
export type ColourRowData = Prisma.ItemColourGetPayload<{ select: typeof COLOUR_COLUMNS }>

export function contextOf(caller: CommandCaller): RequestContext {
  if (!caller.factoryContext) throw new ApiError('unauthenticated')
  return caller.factoryContext
}

/** The caller holds the cost grain (money.cost): the standard cost is read and shown. */
export const seesCost = (context: RequestContext): boolean => heldGrains(actorOf(context)).has('cost')

export const materialColumns = (context: RequestContext) => (seesCost(context) ? MATERIAL_COLUMNS_WITH_COST : MATERIAL_COLUMNS)

const text = (value: { toString(): string } | null | undefined): string | null => (value === null || value === undefined ? null : decimalText(value.toString()))

/** A row as the domain's material fields (decimals as plain strings). */
export function fieldsOf(row: Prisma.ItemGetPayload<{ select: typeof FIELD_COLUMNS }>): MaterialFields {
  return {
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    // W2a wave 5: never FINISHED here (a finished garment's item is no material, and no BOM line names one: …_production_w2a_guards).
    kind: row.kind as MaterialFields['kind'],
    sourcing: row.sourcing,
    tracking: row.tracking,
    baseUom: row.baseUom,
    purchaseUom: row.purchaseUom,
    purchaseFactor: text(row.purchaseFactor)!,
    consumptionUom: row.consumptionUom,
    consumptionFactor: text(row.consumptionFactor)!,
    defaultSupplierId: row.defaultSupplierId,
    supplierArticleCode: row.supplierArticleCode,
    animalSpecies: row.animalSpecies,
    tannage: row.tannage,
    grade: row.grade,
    finish: row.finish,
    thicknessMinMm: text(row.thicknessMinMm),
    thicknessMaxMm: text(row.thicknessMaxMm),
    composition: (row.composition as FibreShare[] | null) ?? null,
    animalOrigin: row.animalOrigin,
    attributes: (row.attributes as Record<string, string> | null) ?? null,
    isPpeComponent: row.isPpeComponent,
    requiresCrViTest: row.requiresCrViTest,
    crViLimitMgKg: text(row.crViLimitMgKg),
  }
}

const JSON_FIELDS = ['nameI18n', 'composition', 'attributes'] as const
type JsonField = (typeof JSON_FIELDS)[number]
const isJsonField = (key: string): key is JsonField => (JSON_FIELDS as readonly string[]).includes(key)

/**
 * Clearing a JSON column: @nexus/factory-db exports Prisma's types, not its runtime DbNull, so a JSON column is set to
 * the database's NULL by one fixed statement each.
 */
const CLEAR_JSON: Readonly<Record<JsonField, (tx: CommandTx, id: string) => Promise<number>>> = {
  nameI18n: (tx, id) => tx.$executeRaw`UPDATE "Item" SET "nameI18n" = NULL WHERE "id" = ${id}::uuid`,
  composition: (tx, id) => tx.$executeRaw`UPDATE "Item" SET "composition" = NULL WHERE "id" = ${id}::uuid`,
  attributes: (tx, id) => tx.$executeRaw`UPDATE "Item" SET "attributes" = NULL WHERE "id" = ${id}::uuid`,
}

/** The columns a set of fields writes; a JSON field set to null is left out here (writeFields clears it). */
export function columnsOf(fields: Partial<MaterialFields>): Prisma.ItemUncheckedUpdateInput {
  const data: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || (value === null && isJsonField(key))) continue
    data[key] = value
  }
  return data as Prisma.ItemUncheckedUpdateInput
}

/** Writes changed fields (and other columns) of a material, JSON nulls included. */
export async function writeFields(tx: CommandTx, id: string, fields: Partial<MaterialFields>, other: Prisma.ItemUncheckedUpdateInput = {}): Promise<void> {
  await tx.item.update({ where: { id }, data: { ...columnsOf(fields), ...other }, select: { id: true } })
  for (const key of JSON_FIELDS) if (fields[key] === null) await CLEAR_JSON[key](tx, id)
}

const supplierOf = (row: MaterialRowData) =>
  row.defaultSupplier ? { id: row.defaultSupplier.id, code: row.defaultSupplier.code, name: row.defaultSupplier.tradeName ?? row.defaultSupplier.legalName } : null

/** A row of the material list (SCR-047). */
export function materialRowView(row: MaterialRowData): MaterialRow {
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    // W2a wave 5: never FINISHED here (a finished garment's item is no material, and no BOM line names one: …_production_w2a_guards).
    kind: row.kind as MaterialFields['kind'],
    sourcing: row.sourcing,
    tracking: row.tracking,
    baseUom: row.baseUom,
    purchaseUom: row.purchaseUom,
    consumptionUom: row.consumptionUom,
    defaultSupplier: supplierOf(row),
    supplierArticleCode: row.supplierArticleCode,
    isPpeComponent: row.isPpeComponent,
    requiresCrViTest: row.requiresCrViTest,
    crViLimitMgKg: text(row.crViLimitMgKg),
    ...('standardCost' in row ? { standardCost: asMoney('cost', text(row.standardCost)) } : {}),
    currency: row.currency,
    colourCount: row._count.colours,
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

export function colourViewOf(row: ColourRowData): ColourView {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    supplierColourCode: row.supplierColourCode,
    colourId: row.colourId,
    status: row.status,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The material record (SCR-048): its units with their factors, its colours, what one unit costs, its warnings. */
export function materialViewOf(row: MaterialRowData, colours: readonly ColourRowData[]): MaterialView {
  const fields = fieldsOf(row)
  const unit = (uom: MaterialFields['baseUom'], factor: string) => ({ uom, factor, fixed: fixedRatio(uom, fields.baseUom) !== null })
  const cost = 'standardCost' in row ? text(row.standardCost) : undefined
  const per = (uom: MaterialFields['baseUom']) => (cost === null || cost === undefined ? null : decimalText(unitCostIn(cost, uom, fields, { scale: COST_SCALE, rounding: 'HALF_UP' })))
  return {
    ...materialRowView(row),
    units: { base: unit(fields.baseUom, '1'), purchase: unit(fields.purchaseUom, fields.purchaseFactor), consumption: unit(fields.consumptionUom, fields.consumptionFactor) },
    ...(cost === undefined
      ? {}
      : { standardCostPerPurchaseUnit: asMoney('cost', per(fields.purchaseUom)), standardCostPerConsumptionUnit: asMoney('cost', per(fields.consumptionUom)) }),
    animalSpecies: fields.animalSpecies,
    tannage: fields.tannage,
    grade: fields.grade,
    finish: fields.finish,
    thicknessMinMm: fields.thicknessMinMm,
    thicknessMaxMm: fields.thicknessMaxMm,
    composition: fields.composition ? fields.composition.map((share) => ({ ...share })) : null,
    animalOrigin: fields.animalOrigin,
    attributes: fields.attributes ? { ...fields.attributes } : null,
    colours: [...colours]
      .sort((a, b) => (a.status === b.status ? (a.code < b.code ? -1 : 1) : a.status === 'ACTIVE' ? -1 : 1))
      .map(colourViewOf),
    warnings: materialWarnings(fields),
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}

// ---- who may see and write ----------------------------------------------------------------------------------------------

/**
 * May the actor do `permission` on a material of this company? A tenant-wide material (no company) is shared by every
 * company, so it is written only by a grant that reaches every company; one company's material, by a grant that
 * reaches that company (can()).
 */
export function mayWrite(actor: Actor, permission: Permission, companyId: string | null): boolean {
  if (companyId !== null) return can(actor, permission, { companyId })
  return can(actor, permission, {}) && grantsFor(actor, permission).some((grant) => grant.companies === 'all')
}

export function assertMayWrite(context: RequestContext, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? 'A material for every company is changed only by a role over every company.' : undefined)
  }
}

/** The material as the caller may see it; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readMaterial(caller: CommandCaller, materialId: string): Promise<MaterialRowData> {
  const context = contextOf(caller)
  if (!isUuid(materialId)) throw new NotFoundError('Material not found.')
  const row = (await caller.withClient((client) => client.item.findUnique({ where: { id: materialId }, select: materialColumns(context) }))) as MaterialRowData | null
  // W2a wave 5: a finished garment's item (kind FINISHED) is not a material.
  if (!row || (row.kind as string) === 'FINISHED' || !can(actorOf(context), PRODUCT_MATERIALS_VIEW, { companyId: row.companyId })) throw new NotFoundError('Material not found.')
  return row
}

export async function readColours(client: FactoryClient | CommandTx, materialId: string): Promise<ColourRowData[]> {
  return client.itemColour.findMany({ where: { itemId: materialId }, select: COLOUR_COLUMNS, orderBy: [{ code: 'asc' }] })
}

/** The material and its colours as the caller sees them, read again inside a command (its answer). */
export async function viewInTx(tx: CommandTx, context: RequestContext, materialId: string): Promise<MaterialView> {
  const row = (await tx.item.findUniqueOrThrow({ where: { id: materialId }, select: materialColumns(context) })) as MaterialRowData
  return materialViewOf(row, await readColours(tx, materialId))
}

// ---- checks against other records --------------------------------------------------------------------------------------

/** A default supplier: a party of the tenant with the SUPPLIER role, not blocked or archived, of the material's company or every company. */
export async function supplierProblems(client: FactoryClient | CommandTx, supplierId: string | null, companyId: string | null): Promise<Issue[]> {
  if (supplierId === null) return []
  const party = await client.party.findUnique({ where: { id: supplierId }, select: { roles: true, status: true, companyId: true } })
  const at = 'body/defaultSupplierId'
  if (!party) return [{ path: at, message: 'No such supplier.' }]
  if (!party.roles.includes('SUPPLIER')) return [{ path: at, message: 'This party is not a supplier.' }]
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') return [{ path: at, message: `This supplier is ${party.status.toLowerCase()}.` }]
  if (party.companyId !== null && party.companyId !== companyId) return [{ path: at, message: "This supplier belongs to another company than the material's." }]
  return []
}

/** A library colour a material colour matches: active, of the material's company or every company. */
export async function libraryColourProblems(client: FactoryClient | CommandTx, colourId: string | null | undefined, companyId: string | null, at: string): Promise<Issue[]> {
  if (colourId === null || colourId === undefined) return []
  const colour = await client.colour.findUnique({ where: { id: colourId }, select: { status: true, companyId: true } })
  if (!colour) return [{ path: at, message: 'No such library colour.' }]
  if (colour.status !== 'ACTIVE') return [{ path: at, message: 'This library colour is archived.' }]
  if (colour.companyId !== null && colour.companyId !== companyId) return [{ path: at, message: "This library colour belongs to another company than the material's." }]
  return []
}

export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- audit values ------------------------------------------------------------------------------------------------------

/** Fields as an audit row keeps them; the standard cost marked with its grain. */
export function auditedFields(fields: Partial<MaterialFields>, cost?: { readonly standardCost: string | null; readonly currency: string }): Record<string, unknown> {
  return { ...fields, ...(cost ? { standardCost: markMoney('cost', cost.standardCost), currency: cost.currency } : {}) }
}

const auditedColour = (colour: ColourFields & { readonly colourId?: string | null; readonly status?: MaterialStatus }) => ({ ...colour })

// ---- writes (inside a command) -----------------------------------------------------------------------------------------

export interface NewMaterialRecord {
  readonly companyId: string | null
  readonly fields: MaterialFields
  readonly standardCost: string | null
  readonly currency: string
  readonly colours: readonly (ColourFields & { readonly colourId?: string | null })[]
}

/** Inserts a material and its colours, with its audit rows and the material.created event; answers its id. */
export async function insertMaterial(tools: CommandTools, record: NewMaterialRecord, action?: Permission): Promise<string> {
  const { tx, now, context } = tools
  const id = newId()
  const createdById = context.audience === 'office' ? context.actorId : null
  await tx.item.create({
    data: {
      ...(columnsOf(record.fields) as Prisma.ItemUncheckedCreateInput),
      id,
      companyId: record.companyId,
      standardCost: record.standardCost,
      currency: record.currency,
      createdAt: now,
      updatedAt: now,
      createdById,
    },
    select: { id: true },
  })
  const colourIds: string[] = []
  for (const colour of record.colours) {
    const colourId = newId()
    colourIds.push(colourId)
    await tx.itemColour.create({
      data: { id: colourId, itemId: id, code: colour.code, name: colour.name, supplierColourCode: colour.supplierColourCode, colourId: colour.colourId ?? null, createdAt: now, updatedAt: now, createdById },
      select: { id: true },
    })
  }
  tools.audit({
    ...(action ? { action } : {}),
    recordType: 'Item',
    recordId: id,
    companyId: record.companyId,
    after: { ...auditedFields(record.fields, { standardCost: record.standardCost, currency: record.currency }), colours: record.colours.map(auditedColour) },
  })
  tools.emit({ type: 'material.created', subject: id, companyId: record.companyId, payload: { itemId: id, code: record.fields.code } })
  return id
}

/** Adds colours to a material or renames and restores the ones of the same code (an import's merge); answers the ids. */
export async function upsertColours(tools: CommandTools, material: { readonly id: string; readonly companyId: string | null }, colours: readonly ColourFields[], action?: Permission): Promise<string[]> {
  const { tx, now, context } = tools
  const current = await readColours(tx, material.id)
  const touched: string[] = []
  for (const colour of colours) {
    const found = current.find((entry) => entry.code === colour.code)
    if (!found) {
      const colourId = newId()
      await tx.itemColour.create({
        data: { id: colourId, itemId: material.id, code: colour.code, name: colour.name, supplierColourCode: colour.supplierColourCode, createdAt: now, updatedAt: now, createdById: context.audience === 'office' ? context.actorId : null },
        select: { id: true },
      })
      tools.audit({ ...(action ? { action } : {}), recordType: 'ItemColour', recordId: colourId, companyId: material.companyId, after: auditedColour({ ...colour, status: 'ACTIVE' }) })
      touched.push(colourId)
      continue
    }
    const before = { name: found.name, supplierColourCode: found.supplierColourCode, status: found.status }
    const after = { name: colour.name, supplierColourCode: colour.supplierColourCode ?? found.supplierColourCode, status: 'ACTIVE' as const }
    if (before.name === after.name && before.supplierColourCode === after.supplierColourCode && before.status === after.status) continue
    await tx.itemColour.update({ where: { id: found.id }, data: { ...after, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ ...(action ? { action } : {}), recordType: 'ItemColour', recordId: found.id, companyId: material.companyId, before, after })
    touched.push(found.id)
  }
  return touched
}
