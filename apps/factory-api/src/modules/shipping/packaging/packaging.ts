import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { defaultScopeProblems, markTemplateProblems, packagingTypeProblems, type PackagingKind, type PackagingTypeValues, type PalletKind, type ShippingMarkField } from '@nexus/factory-domain/shipping/packaging/rules'
import { SHIPPING_PACKAGING_MANAGE } from '@nexus/factory-domain/shipping/packaging/permissions'
import { SHIPPING_VIEW } from '@nexus/factory-domain/shipping/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { assertMay, officeContextOf } from '../access'

/**
 * Packaging and carton marks (B-W2b-384; LOG-008, LOG-013; design warehouse.shipping "Packaging"): a company's packaging
 * types, its default packaging per style or size run, and its carton shipping-mark templates (per customer, and the
 * company's default). Office only: read with shipping.view, kept with shipping.packaging.manage (over the company; a
 * customer's template: the company and that customer). The cost per unit is money.cost (the grain wall drops it for a reader
 * without the grain and refuses it from a writer without it). Nothing is deleted: a type, a default or a template is
 * switched off (the database keeps one live default per company, kind and scope, and one live template per company and
 * customer). The floor reads the types through the packing bench (modules/shipping/cartons), never their cost.
 */

const TYPE_SELECT = {
  id: true,
  companyId: true,
  kind: true,
  name: true,
  innerLengthCm: true,
  innerWidthCm: true,
  innerHeightCm: true,
  tareKg: true,
  maxWeightKg: true,
  palletKind: true,
  costPerUnit: true,
  costCurrency: true,
  active: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.PackagingTypeSelect
type TypeRow = Prisma.PackagingTypeGetPayload<{ select: typeof TYPE_SELECT }>

const DEFAULT_SELECT = {
  id: true,
  companyId: true,
  kind: true,
  packagingTypeId: true,
  styleId: true,
  sizeScaleId: true,
  fromSize: true,
  toSize: true,
  active: true,
  version: true,
  updatedAt: true,
  packagingType: { select: { name: true } },
  style: { select: { code: true, name: true } },
  sizeScale: { select: { code: true, name: true } },
} as const satisfies Prisma.PackagingDefaultSelect
type DefaultRow = Prisma.PackagingDefaultGetPayload<{ select: typeof DEFAULT_SELECT }>

const TEMPLATE_SELECT = { id: true, companyId: true, partyId: true, fields: true, language: true, active: true, version: true, updatedAt: true, party: { select: { code: true, legalName: true } } } as const satisfies Prisma.ShippingMarkTemplateSelect
type TemplateRow = Prisma.ShippingMarkTemplateGetPayload<{ select: typeof TEMPLATE_SELECT }>

const decimal = (value: Prisma.Decimal | null, places: number): string | null => (value === null ? null : value.toFixed(places))

const typeValues = (row: TypeRow): PackagingTypeValues => ({
  name: row.name,
  innerLengthCm: decimal(row.innerLengthCm, 2),
  innerWidthCm: decimal(row.innerWidthCm, 2),
  innerHeightCm: decimal(row.innerHeightCm, 2),
  tareKg: decimal(row.tareKg, 4),
  maxWeightKg: decimal(row.maxWeightKg, 4),
  palletKind: row.palletKind,
  costPerUnit: decimal(row.costPerUnit, 6),
  costCurrency: row.costCurrency,
})

const typeView = (row: TypeRow) => {
  const { costPerUnit, costCurrency, ...values } = typeValues(row)
  return {
    id: row.id,
    companyId: row.companyId,
    kind: row.kind,
    ...values,
    cost: asMoney('cost', costPerUnit !== null && costCurrency !== null ? { perUnit: costPerUnit, currency: costCurrency } : null),
    active: row.active,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

const defaultView = (row: DefaultRow) => ({
  id: row.id,
  companyId: row.companyId,
  kind: row.kind,
  packagingTypeId: row.packagingTypeId,
  packagingTypeName: row.packagingType.name,
  styleId: row.styleId,
  style: row.style,
  sizeScaleId: row.sizeScaleId,
  sizeScale: row.sizeScale,
  fromSize: row.fromSize,
  toSize: row.toSize,
  active: row.active,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

const templateView = (row: TemplateRow) => ({
  id: row.id,
  companyId: row.companyId,
  partyId: row.partyId,
  party: row.party,
  fields: row.fields,
  language: row.language,
  active: row.active,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
})

const invalid = (problems: Issue[], what: string): never => {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : `The ${what} is not valid.`, problems)
}

/** The live-one keys (one live default per company, kind and scope; one live template per company and customer) and the type's name. */
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002' || (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === '23505'

async function unique<T>(work: () => Promise<T>, message: string): Promise<T> {
  try {
    return await work()
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictError(message)
    throw error
  }
}

/** The company of a write: one the caller keeps packaging for. */
function assertCompany(caller: CommandCaller, companyId: string, partyId?: string | null): void {
  const context = officeContextOf(caller)
  assertMay(context, SHIPPING_VIEW, SHIPPING_PACKAGING_MANAGE, { companyId, ...(partyId ? { partyId } : {}) }, 'Company')
}

// ---- packaging types ----------------------------------------------------------------------------------------------

export async function listTypes(caller: CommandCaller, query: { companyId?: string | undefined; kind?: PackagingKind | undefined; active?: boolean | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.PackagingTypeWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId' }) as Prisma.PackagingTypeWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.kind ? { kind: query.kind } : {},
      query.active === undefined ? {} : { active: query.active },
    ],
  }
  const rows = await caller.withClient((client) => client.packagingType.findMany({ where, select: TYPE_SELECT, orderBy: [{ companyId: 'asc' }, { kind: 'asc' }, { name: 'asc' }], take: 500 }))
  return { types: rows.map(typeView) }
}

export interface TypeInput {
  readonly version?: number | undefined
  readonly name?: string | undefined
  readonly innerLengthCm?: string | null | undefined
  readonly innerWidthCm?: string | null | undefined
  readonly innerHeightCm?: string | null | undefined
  readonly tareKg?: string | null | undefined
  readonly maxWeightKg?: string | null | undefined
  readonly palletKind?: PalletKind | null | undefined
  readonly cost?: { readonly perUnit: string; readonly currency: string } | null | undefined
  readonly active?: boolean | undefined
}

/** The values after the input over what is there (a field left out stays, null clears it). */
function merged(before: PackagingTypeValues, body: TypeInput): PackagingTypeValues {
  const pick = <K extends keyof PackagingTypeValues>(key: K, value: PackagingTypeValues[K] | undefined): PackagingTypeValues[K] => (value === undefined ? before[key] : value)
  return {
    name: body.name === undefined ? before.name : body.name.trim(),
    innerLengthCm: pick('innerLengthCm', body.innerLengthCm),
    innerWidthCm: pick('innerWidthCm', body.innerWidthCm),
    innerHeightCm: pick('innerHeightCm', body.innerHeightCm),
    tareKg: pick('tareKg', body.tareKg),
    maxWeightKg: pick('maxWeightKg', body.maxWeightKg),
    palletKind: pick('palletKind', body.palletKind),
    costPerUnit: body.cost === undefined ? before.costPerUnit : (body.cost?.perUnit ?? null),
    costCurrency: body.cost === undefined ? before.costCurrency : (body.cost?.currency ?? null),
  }
}

const EMPTY: PackagingTypeValues = { name: '', innerLengthCm: null, innerWidthCm: null, innerHeightCm: null, tareKg: null, maxWeightKg: null, palletKind: null, costPerUnit: null, costCurrency: null }

const typeData = (values: PackagingTypeValues) => ({ ...values })

/** shipping.packaging.manage: a new packaging type of the company. */
export async function createType(caller: CommandCaller, body: TypeInput & { companyId: string; kind: PackagingKind; name: string }, idempotencyKey?: string) {
  assertCompany(caller, body.companyId)
  const values = merged(EMPTY, body)
  const problems = packagingTypeProblems(body.kind, values)
  if (problems.length > 0) invalid(problems, 'packaging type')
  const id = newId()
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.createPackagingType', idempotencyKey, input: body }, async (tools) => {
        const company = await tools.tx.company.findUnique({ where: { id: body.companyId }, select: { id: true } })
        if (!company) throw new NotFoundError('Company not found.')
        const row = await tools.tx.packagingType.create({ data: { id, companyId: body.companyId, kind: body.kind, ...typeData(values), active: body.active ?? true, createdById: officeContextOf(caller).actorId }, select: TYPE_SELECT })
        tools.audit({ action: 'shipping.createPackagingType', recordType: 'PackagingType', recordId: id, companyId: body.companyId, after: { kind: body.kind, ...values, active: row.active } })
        return { type: typeView(row) }
      }),
    `The company has a packaging type named "${values.name}" already.`,
  )
  return result
}

/** shipping.packaging.manage: changes a type (its kind and company never change), or switches it off or on. */
export async function changeType(caller: CommandCaller, typeId: string, body: TypeInput, idempotencyKey?: string) {
  const before = isUuid(typeId) ? await caller.withClient((client) => client.packagingType.findUnique({ where: { id: typeId }, select: TYPE_SELECT })) : null
  if (!before) throw new NotFoundError('Packaging type not found.')
  assertCompany(caller, before.companyId)
  const values = merged(typeValues(before), body)
  const problems = packagingTypeProblems(before.kind, values)
  if (problems.length > 0) invalid(problems, 'packaging type')
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.changePackagingType', idempotencyKey, input: { typeId, ...body }, record: { type: 'PackagingType', id: before.id, expectedVersion: body.version } }, async (tools) => {
        const row = await tools.tx.packagingType.update({ where: { id: before.id }, data: { ...typeData(values), ...(body.active === undefined ? {} : { active: body.active }) }, select: TYPE_SELECT })
        tools.audit({ action: 'shipping.changePackagingType', recordType: 'PackagingType', recordId: before.id, companyId: before.companyId, before: { ...typeValues(before), active: before.active }, after: { ...values, active: row.active } })
        return { type: typeView(row) }
      }),
    `The company has a packaging type named "${values.name}" already.`,
  )
  return result
}

// ---- defaults per style or size run --------------------------------------------------------------------------------

export async function listDefaults(caller: CommandCaller, query: { companyId?: string | undefined; styleId?: string | undefined; active?: boolean | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.PackagingDefaultWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId' }) as Prisma.PackagingDefaultWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.styleId ? { styleId: query.styleId } : {},
      query.active === undefined ? {} : { active: query.active },
    ],
  }
  const rows = await caller.withClient((client) => client.packagingDefault.findMany({ where, select: DEFAULT_SELECT, orderBy: [{ companyId: 'asc' }, { kind: 'asc' }, { id: 'asc' }], take: 500 }))
  return { defaults: rows.map(defaultView) }
}

/** The type a default names: of its company, in use (its kind is the default's). */
async function liveTypeOf(tx: CommandTx, companyId: string, typeId: string): Promise<{ id: string; kind: PackagingKind }> {
  const type = isUuid(typeId) ? await tx.packagingType.findUnique({ where: { id: typeId }, select: { id: true, companyId: true, kind: true, active: true } }) : null
  if (!type || type.companyId !== companyId) throw new ValidationError('Not a packaging type of this company.', [{ path: 'body/packagingTypeId', message: 'Choose a packaging type of the company.' }])
  if (!type.active) throw new ValidationError('That packaging type is switched off.', [{ path: 'body/packagingTypeId', message: 'Choose a packaging type in use.' }])
  return type
}

/** The scope's records: a style of the company (or tenant-wide) not archived, its own scale; the sizes of the scale. */
async function scopeProblems(tx: CommandTx, companyId: string, scope: { styleId: string | null; sizeScaleId: string | null; fromSize: string | null; toSize: string | null }): Promise<Issue[]> {
  const problems: Issue[] = []
  const scaleId = scope.sizeScaleId
  if (scope.styleId !== null) {
    const style = isUuid(scope.styleId) ? await tx.style.findUnique({ where: { id: scope.styleId }, select: { companyId: true, status: true, sizeScaleId: true } }) : null
    if (!style || (style.companyId !== null && style.companyId !== companyId) || style.status === 'ARCHIVED') problems.push({ path: 'body/styleId', message: 'Choose a style of the company that is not archived.' })
    else if (scaleId !== null && scaleId !== style.sizeScaleId) problems.push({ path: 'body/sizeScaleId', message: "A style's size run runs over the style's own size scale." })
  }
  if (scaleId !== null) {
    const scale = isUuid(scaleId) ? await tx.sizeScale.findUnique({ where: { id: scaleId }, select: { companyId: true } }) : null
    if (!scale || (scale.companyId !== null && scale.companyId !== companyId)) problems.push({ path: 'body/sizeScaleId', message: 'Choose a size scale of the company.' })
    else if (scope.fromSize !== null && scope.toSize !== null) {
      const sizes = await tx.size.findMany({ where: { scaleId, code: { in: [scope.fromSize, scope.toSize] } }, select: { code: true, seq: true } })
      const from = sizes.find((size) => size.code === scope.fromSize)
      const to = sizes.find((size) => size.code === scope.toSize)
      if (!from || !to) problems.push({ path: 'body/fromSize', message: 'Choose sizes of the size scale.' })
      else if (from.seq > to.seq) problems.push({ path: 'body/toSize', message: 'The run goes from a size to one not before it.' })
    }
  }
  return problems
}

export interface DefaultInput {
  readonly companyId: string
  readonly packagingTypeId: string
  readonly styleId?: string | null | undefined
  readonly sizeScaleId?: string | null | undefined
  readonly fromSize?: string | null | undefined
  readonly toSize?: string | null | undefined
}

/** shipping.packaging.manage: a new default (its kind is its type's); one live per company, kind and scope. */
export async function createDefault(caller: CommandCaller, body: DefaultInput, idempotencyKey?: string) {
  assertCompany(caller, body.companyId)
  const scope = { styleId: body.styleId ?? null, sizeScaleId: body.sizeScaleId ?? null, fromSize: body.fromSize?.trim() || null, toSize: body.toSize?.trim() || null }
  const shape = defaultScopeProblems(scope)
  if (shape.length > 0) invalid(shape, 'default')
  const id = newId()
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.createPackagingDefault', idempotencyKey, input: body }, async (tools) => {
        const type = await liveTypeOf(tools.tx, body.companyId, body.packagingTypeId)
        const problems = await scopeProblems(tools.tx, body.companyId, scope)
        if (problems.length > 0) invalid(problems, 'default')
        const row = await tools.tx.packagingDefault.create({ data: { id, companyId: body.companyId, packagingTypeId: type.id, kind: type.kind, ...scope, createdById: officeContextOf(caller).actorId }, select: DEFAULT_SELECT })
        tools.audit({ action: 'shipping.createPackagingDefault', recordType: 'PackagingDefault', recordId: id, companyId: body.companyId, after: { packagingTypeId: type.id, kind: type.kind, ...scope } })
        return { default: defaultView(row) }
      }),
    'A default of this kind is live for this style or size run already: switch it off first, or change its packaging.',
  )
  return result
}

/** shipping.packaging.manage: another type of the same kind for a default, or switched off or on. */
export async function changeDefault(caller: CommandCaller, defaultId: string, body: { version?: number | undefined; packagingTypeId?: string | undefined; active?: boolean | undefined }, idempotencyKey?: string) {
  const before = isUuid(defaultId) ? await caller.withClient((client) => client.packagingDefault.findUnique({ where: { id: defaultId }, select: DEFAULT_SELECT })) : null
  if (!before) throw new NotFoundError('Packaging default not found.')
  assertCompany(caller, before.companyId)
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.changePackagingDefault', idempotencyKey, input: { defaultId, ...body }, record: { type: 'PackagingDefault', id: before.id, expectedVersion: body.version } }, async (tools) => {
        const typeId = body.packagingTypeId ?? before.packagingTypeId
        const switchingOn = body.active === true && !before.active
        if (body.packagingTypeId !== undefined || switchingOn) {
          const type = await liveTypeOf(tools.tx, before.companyId, typeId)
          if (type.kind !== before.kind) throw new ValidationError('Not a packaging type of this kind.', [{ path: 'body/packagingTypeId', message: `A ${before.kind.toLowerCase()} default gives a ${before.kind.toLowerCase()}.` }])
        }
        const row = await tools.tx.packagingDefault.update({ where: { id: before.id }, data: { packagingTypeId: typeId, ...(body.active === undefined ? {} : { active: body.active }) }, select: DEFAULT_SELECT })
        tools.audit({ action: 'shipping.changePackagingDefault', recordType: 'PackagingDefault', recordId: before.id, companyId: before.companyId, before: { packagingTypeId: before.packagingTypeId, active: before.active }, after: { packagingTypeId: row.packagingTypeId, active: row.active } })
        return { default: defaultView(row) }
      }),
    'A default of this kind is live for this style or size run already: switch it off first.',
  )
  return result
}

// ---- carton shipping-mark templates --------------------------------------------------------------------------------

export async function listTemplates(caller: CommandCaller, query: { companyId?: string | undefined; partyId?: string | undefined; active?: boolean | undefined }) {
  const context = officeContextOf(caller)
  const where: Prisma.ShippingMarkTemplateWhereInput = {
    AND: [
      scopeWhere(actorOf(context), SHIPPING_VIEW, { company: 'companyId' }) as Prisma.ShippingMarkTemplateWhereInput,
      query.companyId ? { companyId: query.companyId } : {},
      query.partyId ? { partyId: query.partyId } : {},
      query.active === undefined ? {} : { active: query.active },
    ],
  }
  const rows = await caller.withClient((client) => client.shippingMarkTemplate.findMany({ where, select: TEMPLATE_SELECT, orderBy: [{ companyId: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }], take: 500 }))
  // A customer's template is shown to who sees that customer (the company's default to every reader of the company).
  const actor = actorOf(context)
  return { templates: rows.filter((row) => row.partyId === null || can(actor, SHIPPING_VIEW, { companyId: row.companyId, partyId: row.partyId })).map(templateView) }
}

/** shipping.packaging.manage: a new template for a customer or brand of the company, or the company's default. */
export async function createTemplate(caller: CommandCaller, body: { companyId: string; partyId?: string | null | undefined; fields: ShippingMarkField[]; language: string }, idempotencyKey?: string) {
  assertCompany(caller, body.companyId, body.partyId ?? null)
  const problems = markTemplateProblems(body)
  if (problems.length > 0) invalid(problems, 'mark template')
  const id = newId()
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.createMarkTemplate', idempotencyKey, input: body }, async (tools) => {
        if (body.partyId) {
          const party = isUuid(body.partyId) ? await tools.tx.party.findUnique({ where: { id: body.partyId }, select: { companyId: true, roles: true, status: true } }) : null
          if (!party || (party.companyId !== null && party.companyId !== body.companyId) || party.status === 'ARCHIVED' || !party.roles.some((role) => role === 'CUSTOMER' || role === 'BRAND')) {
            throw new ValidationError('Not a customer or brand of this company.', [{ path: 'body/partyId', message: 'Choose a customer or brand of the company that is not archived.' }])
          }
        }
        const row = await tools.tx.shippingMarkTemplate.create({ data: { id, companyId: body.companyId, partyId: body.partyId ?? null, fields: body.fields, language: body.language, createdById: officeContextOf(caller).actorId }, select: TEMPLATE_SELECT })
        tools.audit({ action: 'shipping.createMarkTemplate', recordType: 'ShippingMarkTemplate', recordId: id, companyId: body.companyId, after: { partyId: body.partyId ?? null, fields: body.fields, language: body.language } })
        return { template: templateView(row) }
      }),
    body.partyId ? 'This customer has a live mark template already: change it, or switch it off first.' : 'The company has a live default mark template already: change it, or switch it off first.',
  )
  return result
}

/** shipping.packaging.manage: a template's fields and language, or switched off or on (its company and customer never change). */
export async function changeTemplate(caller: CommandCaller, templateId: string, body: { version?: number | undefined; fields?: ShippingMarkField[] | undefined; language?: string | undefined; active?: boolean | undefined }, idempotencyKey?: string) {
  const before = isUuid(templateId) ? await caller.withClient((client) => client.shippingMarkTemplate.findUnique({ where: { id: templateId }, select: TEMPLATE_SELECT })) : null
  if (!before) throw new NotFoundError('Mark template not found.')
  assertCompany(caller, before.companyId, before.partyId)
  const next = { fields: body.fields ?? before.fields, language: body.language ?? before.language }
  const problems = markTemplateProblems(next)
  if (problems.length > 0) invalid(problems, 'mark template')
  const { result } = await unique(
    () =>
      command(caller, { name: 'shipping.changeMarkTemplate', idempotencyKey, input: { templateId, ...body }, record: { type: 'ShippingMarkTemplate', id: before.id, expectedVersion: body.version } }, async (tools) => {
        const row = await tools.tx.shippingMarkTemplate.update({ where: { id: before.id }, data: { ...next, ...(body.active === undefined ? {} : { active: body.active }) }, select: TEMPLATE_SELECT })
        tools.audit({ action: 'shipping.changeMarkTemplate', recordType: 'ShippingMarkTemplate', recordId: before.id, companyId: before.companyId, before: { fields: before.fields, language: before.language, active: before.active }, after: { ...next, active: row.active } })
        return { template: templateView(row) }
      }),
    'This customer has another live mark template already: switch it off first.',
  )
  return result
}
