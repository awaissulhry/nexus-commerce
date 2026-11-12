import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PRODUCT_SETTINGS_MANAGE } from '@nexus/factory-domain/product/lifecycle/permissions'
import { PRODUCT_STYLES_MANAGE, PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import type { ProductType } from '@nexus/factory-domain/product/styles/rules'
import type { CreateTypeBody, ListTypesQuery, SetStyleTypeBody, StyleTypeView, TypeStatusBody, TypeView, UpdateTypeBody } from '@nexus/factory-domain/product/types/contracts'
import {
  effectiveType,
  inheritedPpeProblems,
  missingAttributes,
  parentCircle,
  REQUIRABLE_ATTRIBUTES,
  styleDefaultsOf,
  TYPE_LIMITS,
  typeProblems,
  type StyleDefaults,
  type TypeRow,
} from '@nexus/factory-domain/product/types/rules'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { requireEditRule } from '../lifecycle/edit-rule'
import { assertMayWrite, contextOf, isUniqueViolation, readStyle } from '../styles/store'
// B-W2b-283 (FU1:04): who changed the type last ("Changed by" without audit.read).
import { changedByOf, updatedByOf } from '../settings/changed-by'

/**
 * Product types (B-W2b-221; PRD-008; design products.settings psettings.types; factory-db ProductTypeProfile; rules in
 * factory-domain product/types): a kind of garment refined, with what its styles must have and the defaults a new style of it
 * starts with; a child inherits its parent's (walked up here, `chainOf`).
 *
 *   GET   /product/types[?productType&status&companyId]   product.styles.view: every type the caller may see, each with its own
 *                                                          values and what it gives after inheritance
 *   GET   /product/types/:typeId                          product.styles.view
 *   POST  /product/types                                  product.settings.manage over its company (a tenant-wide type: over
 *                                                          every company)
 *   PATCH /product/types/:typeId                          the same, at its version
 *   POST  /product/types/:typeId/archive | restore        the same: archived, never deleted (its styles keep it)
 *   GET   /product/styles/:styleId/type                   product.styles.view: the style's type, what it still misses of
 *                                                          the type's required attributes (B-W2b-231's release check), where
 *                                                          it differs from the type's defaults
 *   PUT   /product/styles/:styleId/type                   product.styles.manage: {version, typeId | null}; a change of the
 *                                                          style's spec, so its edit rule applies
 *
 * A new style takes its type's defaults in W1's create (styles/styles.ts reads `typeDefaultsForNewStyle`). Every refusal of
 * the database's ProductTypeProfile_check and Style_w2b4_depth is said here first, in words. Each write is ONE command:
 * audit row, product_type.changed (a style's type: style.updated).
 */

const TYPE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }
const MAX_DEPTH = TYPE_LIMITS.depth

const TYPE_SELECT = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  nameI18n: true,
  productType: true,
  parentId: true,
  requiredAttributes: true,
  defaultSizeScaleId: true,
  labelTemplateId: true,
  measurementTemplateId: true,
  defaultPpeCategory: true,
  defaultPpeStandard: true,
  defaultPpeClass: true,
  status: true,
  version: true,
  updatedAt: true,
  // B-W2b-283 (FU1:04).
  updatedById: true,
} as const satisfies Prisma.ProductTypeProfileSelect
type Row = Prisma.ProductTypeProfileGetPayload<{ select: typeof TYPE_SELECT }>

type Reader = FactoryClient | CommandTx

const fits = (rowCompany: string | null, ownerCompany: string | null): boolean => rowCompany === null || rowCompany === ownerCompany
const invalid = (issues: readonly Issue[]): ValidationError => new ValidationError('The product type is not valid.', issues)

/** The type and its parents, the type first (at most MAX_DEPTH; a circle the database refuses stops the walk). */
export async function chainOf(db: Reader, first: Row): Promise<Row[]> {
  const chain = [first]
  let parentId = first.parentId
  while (parentId !== null && chain.length < MAX_DEPTH && !chain.some((row) => row.id === parentId)) {
    const parent = await db.productTypeProfile.findUnique({ where: { id: parentId }, select: TYPE_SELECT })
    if (!parent) break
    chain.push(parent)
    parentId = parent.parentId
  }
  return chain
}

const asTypeRow = (row: Row): TypeRow => row

/** One type as the caller reads it: own values, what it gives after inheritance, its references, children and styles. */
async function typeViewOf(db: Reader, row: Row): Promise<TypeView> {
  const chain = await chainOf(db, row)
  const effective = effectiveType(chain.map(asTypeRow))
  const parent = row.parentId === null ? null : (chain[1] ?? null)
  const scaleId = effective.defaults.defaultSizeScaleId.value
  const labelId = effective.defaults.labelTemplateId.value
  const templateId = effective.defaults.measurementTemplateId.value
  const sizeScale = scaleId === null ? null : await db.sizeScale.findUnique({ where: { id: scaleId }, select: { id: true, code: true, name: true } })
  const labelTemplate = labelId === null ? null : await db.labelTemplate.findUnique({ where: { id: labelId }, select: { id: true, code: true, name: true, revision: true } })
  const measurementTemplate = templateId === null ? null : await db.measurementTemplate.findUnique({ where: { id: templateId }, select: { id: true, code: true, name: true } })
  const children = await db.productTypeProfile.findMany({ where: { parentId: row.id }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }] })
  const styles = await db.style.count({ where: { productTypeProfileId: row.id } })
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n ?? null) as Record<string, string> | null,
    companyId: row.companyId,
    productType: row.productType,
    parent: parent ? { id: parent.id, code: parent.code, name: parent.name } : null,
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    // B-W2b-283 (FU1:04): the person who changed it last (null: nobody recorded since the column came).
    changedBy: await changedByOf(db, row.updatedById),
    own: {
      requiredAttributes: [...row.requiredAttributes],
      defaultSizeScaleId: row.defaultSizeScaleId,
      labelTemplateId: row.labelTemplateId,
      measurementTemplateId: row.measurementTemplateId,
      defaultPpeCategory: row.defaultPpeCategory,
      defaultPpeStandard: row.defaultPpeStandard,
      defaultPpeClass: row.defaultPpeClass,
    },
    effective: { requiredAttributes: effective.requiredAttributes.map((entry) => ({ ...entry })), defaults: effective.defaults as TypeView['effective']['defaults'] },
    refs: { sizeScale: sizeScale ? { ...sizeScale } : null, labelTemplate: labelTemplate ? { ...labelTemplate } : null, measurementTemplate: measurementTemplate ? { ...measurementTemplate } : null },
    children: children.map((child) => ({ ...child })),
    styles,
  }
}

/** The type as the caller may see it (else 404). */
async function readType(caller: CommandCaller, typeId: string): Promise<Row> {
  const context = contextOf(caller)
  const row = await caller.withClient((client) => client.productTypeProfile.findUnique({ where: { id: typeId }, select: TYPE_SELECT }))
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Product type not found.')
  return row
}

/** GET /product/types */
export async function listTypes(caller: CommandCaller, query: ListTypesQuery): Promise<TypeView[]> {
  const context = contextOf(caller)
  const where: Prisma.ProductTypeProfileWhereInput = {
    AND: [
      scopeWhere(actorOf(context), PRODUCT_STYLES_VIEW, TYPE_SCOPE) as Prisma.ProductTypeProfileWhereInput,
      query.status === 'ALL' ? {} : { status: query.status },
      query.productType ? { productType: query.productType } : {},
      query.companyId ? { OR: [{ companyId: query.companyId }, { companyId: null }] } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.productTypeProfile.findMany({ where, select: TYPE_SELECT, orderBy: [{ productType: 'asc' }, { code: 'asc' }, { id: 'asc' }] })
    const views: TypeView[] = []
    for (const row of rows) views.push(await typeViewOf(client, row))
    return views
  })
}

/** GET /product/types/:typeId */
export async function getType(caller: CommandCaller, typeId: string): Promise<TypeView> {
  const row = await readType(caller, typeId)
  return caller.withClient((client) => typeViewOf(client, row))
}

// ---- checks against other records -----------------------------------------------------------------------------------------

/** The type's fields after the change, as the checks read them. */
interface TypeDraft {
  readonly id: string
  readonly companyId: string | null
  readonly code: string
  readonly name: string
  readonly productType: ProductType
  readonly parentId: string | null
  readonly requiredAttributes: readonly string[]
  readonly defaultSizeScaleId: string | null
  readonly labelTemplateId: string | null
  readonly measurementTemplateId: string | null
  readonly defaultPpeCategory: Row['defaultPpeCategory']
  readonly defaultPpeStandard: string | null
  readonly defaultPpeClass: string | null
}

/** Every rule of the database's ProductTypeProfile_check, in words, for the fields set or changed (`changed`). */
async function draftProblems(tx: CommandTx, draft: TypeDraft, changed: ReadonlySet<string>): Promise<Issue[]> {
  const issues: Issue[] = typeProblems(draft).map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
  const owner = draft.companyId
  const whose = owner === null ? 'every company' : "the type's company"
  if (changed.has('code') && (await tx.productTypeProfile.findFirst({ where: { code: draft.code, id: { not: draft.id } }, select: { id: true } }))) {
    issues.push({ path: 'body/code', message: `The product type code ${draft.code} is taken.` })
  }
  let parentChain: Row[] = []
  if (draft.parentId !== null) {
    const parent = await tx.productTypeProfile.findUnique({ where: { id: draft.parentId }, select: TYPE_SELECT })
    const at = 'body/parentId'
    if (!parent) issues.push({ path: at, message: 'No such product type.' })
    else {
      parentChain = await chainOf(tx, parent)
      if (parent.id === draft.id || parentCircle(draft.id, parentChain)) issues.push({ path: at, message: `${parent.code} is this type or one of its children: no circle of types.` })
      else if (parent.productType !== draft.productType) issues.push({ path: at, message: `${parent.code} is a type of ${parent.productType.toLowerCase()}, not ${draft.productType.toLowerCase()}.` })
      else if (!fits(parent.companyId, owner)) issues.push({ path: at, message: `${parent.code} is not a type of ${whose}.` })
      else if (changed.has('parentId') && parent.status === 'ARCHIVED') issues.push({ path: at, message: `${parent.code} is archived.` })
    }
  }
  if (changed.has('defaultSizeScaleId') && draft.defaultSizeScaleId !== null) {
    const scale = await tx.sizeScale.findUnique({ where: { id: draft.defaultSizeScaleId }, select: { code: true, status: true, companyId: true } })
    const at = 'body/defaultSizeScaleId'
    if (!scale) issues.push({ path: at, message: 'No such size scale.' })
    else if (scale.status !== 'ACTIVE') issues.push({ path: at, message: `Size scale ${scale.code} is archived.` })
    else if (!fits(scale.companyId, owner)) issues.push({ path: at, message: `Size scale ${scale.code} is not of ${whose}.` })
  }
  if (changed.has('labelTemplateId') && draft.labelTemplateId !== null) {
    const label = await tx.labelTemplate.findUnique({ where: { id: draft.labelTemplateId }, select: { code: true, status: true, companyId: true } })
    const at = 'body/labelTemplateId'
    if (!label) issues.push({ path: at, message: 'No such label template.' })
    else if (label.status === 'RETIRED') issues.push({ path: at, message: `Label template ${label.code} is retired.` })
    else if (!fits(label.companyId, owner)) issues.push({ path: at, message: `Label template ${label.code} is not of ${whose}.` })
  }
  if ((changed.has('measurementTemplateId') || changed.has('productType')) && draft.measurementTemplateId !== null) {
    const template = await tx.measurementTemplate.findUnique({ where: { id: draft.measurementTemplateId }, select: { code: true, status: true, companyId: true, productType: true } })
    const at = 'body/measurementTemplateId'
    if (!template) issues.push({ path: at, message: 'No such measurement template.' })
    else if (changed.has('measurementTemplateId') && template.status !== 'ACTIVE') issues.push({ path: at, message: `Measurement template ${template.code} is archived.` })
    else if (template.productType !== draft.productType) issues.push({ path: at, message: `Measurement template ${template.code} is for ${template.productType.toLowerCase()}, not ${draft.productType.toLowerCase()}.` })
    else if (!fits(template.companyId, owner)) issues.push({ path: at, message: `Measurement template ${template.code} is not of ${whose}.` })
  }
  // The PPE defaults a style of the type would take, after inheritance, against W1's rules.
  const self: TypeRow = { ...draft }
  issues.push(...inheritedPpeProblems(draft.productType, effectiveType([self, ...parentChain.map(asTypeRow)])).map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  return issues
}

// ---- writes ------------------------------------------------------------------------------------------------------------------

/** POST /product/types */
export async function createType(caller: CommandCaller, body: CreateTypeBody, idempotencyKey?: string): Promise<TypeView> {
  const context = contextOf(caller)
  const companyId = body.companyId ?? null
  assertMayWrite(context, PRODUCT_SETTINGS_MANAGE, companyId)
  const { result } = await command(caller, { name: 'product.types.create', idempotencyKey, input: body }, async (tools) => {
    const { tx, now } = tools
    if (companyId !== null && !(await tx.company.findUnique({ where: { id: companyId }, select: { id: true } }))) throw invalid([{ path: 'body/companyId', message: 'No such company.' }])
    const id = newId()
    const draft: TypeDraft = {
      id,
      companyId,
      code: body.code,
      name: body.name,
      productType: body.productType,
      parentId: body.parentId ?? null,
      requiredAttributes: body.requiredAttributes ?? [],
      defaultSizeScaleId: body.defaultSizeScaleId ?? null,
      labelTemplateId: body.labelTemplateId ?? null,
      measurementTemplateId: body.measurementTemplateId ?? null,
      defaultPpeCategory: body.defaultPpeCategory ?? null,
      defaultPpeStandard: body.defaultPpeStandard ?? null,
      defaultPpeClass: body.defaultPpeClass ?? null,
    }
    const problems = await draftProblems(tx, draft, new Set(Object.keys(draft)))
    if (problems.length > 0) throw invalid(problems)
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    await tx.productTypeProfile.create({
      data: { ...draft, requiredAttributes: [...draft.requiredAttributes], nameI18n: body.nameI18n ?? undefined, createdAt: now, updatedAt: now, createdById, updatedById: updatedByOf(tools) /* B-W2b-283 */ },
      select: { id: true },
    })
    tools.audit({ action: 'product.types.create', recordType: 'ProductTypeProfile', recordId: id, companyId, after: { ...draft, nameI18n: body.nameI18n ?? null } })
    tools.emit({ type: 'product_type.changed', subject: id, companyId, payload: { productTypeId: id, code: draft.code, change: 'CREATED' } })
    return typeViewOf(tx, (await tx.productTypeProfile.findUniqueOrThrow({ where: { id }, select: TYPE_SELECT })))
  }).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError(`The product type code ${body.code} is taken.`)
    throw error
  })
  return result
}

const FIELDS = [
  'code',
  'name',
  'nameI18n',
  'productType',
  'parentId',
  'requiredAttributes',
  'defaultSizeScaleId',
  'labelTemplateId',
  'measurementTemplateId',
  'defaultPpeCategory',
  'defaultPpeStandard',
  'defaultPpeClass',
] as const

const same = (left: unknown, right: unknown): boolean => JSON.stringify(left ?? null) === JSON.stringify(right ?? null)

/** PATCH /product/types/:typeId */
export async function updateType(caller: CommandCaller, typeId: string, body: UpdateTypeBody, idempotencyKey?: string): Promise<TypeView> {
  const context = contextOf(caller)
  const seen = await readType(caller, typeId)
  assertMayWrite(context, PRODUCT_SETTINGS_MANAGE, seen.companyId)
  // The same values again change nothing (like W1's PATCH with no change): no command, no version bump.
  if (FIELDS.every((field) => body[field] === undefined || same(body[field], seen[field]))) return getType(caller, typeId)
  const { result } = await command(
    caller,
    { name: 'product.types.update', idempotencyKey, input: { typeId, ...body }, record: { type: 'ProductTypeProfile', id: typeId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.productTypeProfile.findUniqueOrThrow({ where: { id: typeId }, select: TYPE_SELECT })
      if (row.status === 'ARCHIVED') throw new InvalidStateError(`Product type ${row.code} is archived: restore it before changing it.`)
      const changed = FIELDS.filter((field) => body[field] !== undefined && !same(body[field], row[field]))
      if (changed.length === 0) {
        tools.audit({ action: 'product.types.update', recordType: 'ProductTypeProfile', recordId: typeId, companyId: row.companyId, before: {}, after: {} })
        return typeViewOf(tx, row)
      }
      const next = Object.fromEntries(FIELDS.map((field) => [field, changed.includes(field) ? (body[field] ?? null) : row[field]])) as unknown as Omit<TypeDraft, 'id' | 'companyId'> & { nameI18n: unknown }
      if (changed.includes('productType')) {
        const styles = await tx.style.count({ where: { productTypeProfileId: typeId } })
        const children = await tx.productTypeProfile.count({ where: { parentId: typeId } })
        if (styles > 0 || children > 0) {
          throw new ConflictError(`Product type ${row.code} has ${styles} style(s) and ${children} child type(s) of ${row.productType.toLowerCase()}: its kind of garment stays (another kind is a new type).`)
        }
      }
      const problems = await draftProblems(tx, { ...next, id: typeId, companyId: row.companyId, requiredAttributes: next.requiredAttributes ?? [] }, new Set(changed))
      if (problems.length > 0) throw invalid(problems)
      const data = Object.fromEntries(changed.map((field) => [field, field === 'nameI18n' ? (next.nameI18n ?? undefined) : next[field as keyof typeof next]]))
      if (changed.includes('nameI18n') && next.nameI18n === null) await tx.$executeRaw`UPDATE "ProductTypeProfile" SET "nameI18n" = NULL WHERE "id" = ${typeId}::uuid`
      await tx.productTypeProfile.update({ where: { id: typeId }, data: { ...(data as Prisma.ProductTypeProfileUncheckedUpdateInput), updatedById: updatedByOf(tools) /* B-W2b-283 */ }, select: { id: true } })
      tools.audit({
        action: 'product.types.update',
        recordType: 'ProductTypeProfile',
        recordId: typeId,
        companyId: row.companyId,
        before: Object.fromEntries(changed.map((field) => [field, row[field] ?? null])),
        after: Object.fromEntries(changed.map((field) => [field, next[field as keyof typeof next] ?? null])),
      })
      tools.emit({ type: 'product_type.changed', subject: typeId, companyId: row.companyId, payload: { productTypeId: typeId, code: (next.code as string) ?? row.code, change: 'UPDATED' } })
      return typeViewOf(tx, await tx.productTypeProfile.findUniqueOrThrow({ where: { id: typeId }, select: TYPE_SELECT }))
    },
  ).catch((error: unknown) => {
    if (isUniqueViolation(error)) throw new ConflictError('The product type code is taken.')
    throw error
  })
  return result
}

/** POST /product/types/:typeId/archive | restore: out of new use (its styles and children keep it), and back. */
export async function moveType(caller: CommandCaller, typeId: string, direction: 'archive' | 'restore', body: TypeStatusBody, idempotencyKey?: string): Promise<TypeView> {
  const context = contextOf(caller)
  const seen = await readType(caller, typeId)
  assertMayWrite(context, PRODUCT_SETTINGS_MANAGE, seen.companyId)
  const to = direction === 'archive' ? 'ARCHIVED' : 'ACTIVE'
  const { result } = await command(
    caller,
    { name: `product.types.${direction}`, idempotencyKey, input: { typeId, ...body }, record: { type: 'ProductTypeProfile', id: typeId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const row = await tx.productTypeProfile.findUniqueOrThrow({ where: { id: typeId }, select: TYPE_SELECT })
      if (row.status === to) throw new InvalidStateError(`Product type ${row.code} is already ${to.toLowerCase()}.`)
      if (to === 'ACTIVE' && row.parentId !== null) {
        const parent = await tx.productTypeProfile.findUnique({ where: { id: row.parentId }, select: { code: true, status: true } })
        if (parent?.status === 'ARCHIVED') throw new InvalidStateError(`Its parent type ${parent.code} is archived: restore it first.`)
      }
      await tx.productTypeProfile.update({ where: { id: typeId }, data: { status: to, updatedById: updatedByOf(tools) /* B-W2b-283 */ }, select: { id: true } })
      tools.audit({ action: `product.types.${direction}`, recordType: 'ProductTypeProfile', recordId: typeId, companyId: row.companyId, before: { status: row.status }, after: { status: to }, ...(body.reason ? { reason: body.reason } : {}) })
      tools.emit({ type: 'product_type.changed', subject: typeId, companyId: row.companyId, payload: { productTypeId: typeId, code: row.code, change: direction === 'archive' ? 'ARCHIVED' : 'RESTORED' } })
      return typeViewOf(tx, await tx.productTypeProfile.findUniqueOrThrow({ where: { id: typeId }, select: TYPE_SELECT }))
    },
  )
  return result
}

// ---- a style's type --------------------------------------------------------------------------------------------------------

/**
 * The defaults a NEW style of the type takes (W1's create, styles/styles.ts), or the refusal in words (400, `body/<field>`):
 * the type exists for the caller, is active, of the style's kind of garment and of the style's company or tenant-wide (a
 * tenant-wide style takes a tenant-wide type). The same checks as the database's Style_w2b4_depth.
 */
export async function typeDefaultsForNewStyle(db: Reader, typeId: string, style: { readonly productType: ProductType; readonly companyId: string | null }): Promise<StyleDefaults> {
  const at = 'body/productTypeProfileId'
  const row = await db.productTypeProfile.findUnique({ where: { id: typeId }, select: TYPE_SELECT })
  const problem = typeForStyleProblem(row, style)
  if (problem) throw invalid([{ path: at, message: problem }])
  return styleDefaultsOf(effectiveType((await chainOf(db, row!)).map(asTypeRow)))
}

function typeForStyleProblem(row: Row | null, style: { readonly productType: ProductType; readonly companyId: string | null }): string | null {
  if (!row) return 'No such product type.'
  if (row.status === 'ARCHIVED') return `Product type ${row.code} is archived.`
  if (row.productType !== style.productType) return `Product type ${row.code} is a type of ${row.productType.toLowerCase()}, not ${style.productType.toLowerCase()}.`
  if (!fits(row.companyId, style.companyId)) return `Product type ${row.code} belongs to another company than the style's.`
  return null
}

const STYLE_VALUES = Object.fromEntries(REQUIRABLE_ATTRIBUTES.map((field) => [field, true])) as { [Field in (typeof REQUIRABLE_ATTRIBUTES)[number]]: true }

async function styleTypeViewOf(db: Reader, styleId: string): Promise<StyleTypeView> {
  const style = await db.style.findUniqueOrThrow({
    where: { id: styleId },
    select: { id: true, code: true, version: true, productTypeProfileId: true, sizeScaleId: true, ppeCategory: true, mtmAllowed: true, ...STYLE_VALUES },
  })
  if (style.productTypeProfileId === null) return { style: { id: style.id, code: style.code, version: style.version }, type: null, missing: [], differs: [] }
  const row = await db.productTypeProfile.findUniqueOrThrow({ where: { id: style.productTypeProfileId }, select: TYPE_SELECT })
  const type = await typeViewOf(db, row)
  const values = { ...style, netMassKg: style.netMassKg === null ? null : style.netMassKg.toString() }
  const defaults = styleDefaultsOf(effectiveType((await chainOf(db, row)).map(asTypeRow)))
  // A measurement template is a default only for a style that may be made to measure (W1's rule, `fillFromType`).
  const pairs: [string, string | null, string | null][] = [
    ['sizeScaleId', style.sizeScaleId, defaults.sizeScaleId],
    ...(style.mtmAllowed ? [['measurementTemplateId', style.measurementTemplateId, defaults.measurementTemplateId] as [string, string | null, string | null]] : []),
    ['ppeCategory', style.ppeCategory, defaults.ppeCategory],
    ['ppeStandard', style.ppeStandard, defaults.ppeStandard],
    ['ppeClass', style.ppeClass, defaults.ppeClass],
  ]
  return {
    style: { id: style.id, code: style.code, version: style.version },
    type,
    missing: missingAttributes(values, type.effective.requiredAttributes),
    differs: pairs.filter(([, mine, given]) => given !== null && mine !== given).map(([field, mine, given]) => ({ field, style: mine, type: given })),
  }
}

/** GET /product/styles/:styleId/type */
export async function readStyleType(caller: CommandCaller, styleId: string): Promise<StyleTypeView> {
  await readStyle(caller, styleId)
  return caller.withClient((client) => styleTypeViewOf(client, styleId))
}

/** PUT /product/styles/:styleId/type: the style's type (null: none). Its edit rule applies (a change of its spec). */
export async function setStyleType(caller: CommandCaller, styleId: string, body: SetStyleTypeBody, idempotencyKey?: string): Promise<StyleTypeView> {
  const context = contextOf(caller)
  const seen = await readStyle(caller, styleId)
  assertMayWrite(context, PRODUCT_STYLES_MANAGE, seen.companyId)
  const { result } = await command(
    caller,
    { name: 'product.styles.setType', idempotencyKey, input: { styleId, ...body }, record: { type: 'Style', id: styleId, expectedVersion: body.version } },
    async (tools) => {
      const { tx } = tools
      const style = await tx.style.findUniqueOrThrow({ where: { id: styleId }, select: { code: true, status: true, companyId: true, productType: true, productTypeProfileId: true } })
      if (style.status === 'ARCHIVED') throw new InvalidStateError('This style is archived: reactivate it before changing it.')
      if (style.productTypeProfileId !== body.typeId) {
        await requireEditRule(tx, styleId, 'SPEC')
        if (body.typeId !== null) {
          const problem = typeForStyleProblem(await tx.productTypeProfile.findUnique({ where: { id: body.typeId }, select: TYPE_SELECT }), style)
          if (problem) throw invalid([{ path: 'body/typeId', message: problem }])
        }
        await tx.style.update({ where: { id: styleId }, data: { productTypeProfileId: body.typeId }, select: { id: true } })
        tools.emit({ type: 'style.updated', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, fields: ['productTypeProfileId'] } })
      }
      tools.audit({ action: 'product.styles.setType', recordType: 'Style', recordId: styleId, companyId: style.companyId, before: { productTypeProfileId: style.productTypeProfileId }, after: { productTypeProfileId: body.typeId } })
      return styleTypeViewOf(tx, styleId)
    },
  )
  return result
}
