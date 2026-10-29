import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission, type ScopeColumns } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { LocalisedNames } from '@nexus/factory-domain/product/materials/rules'
import { scaleOrder, type BodyMeasures, type MasterStatus } from '@nexus/factory-domain/product/sizes/rules'
import type { ColourwayView, MatrixView, RevisionView, SkuView, StyleRow, StyleView } from '@nexus/factory-domain/product/styles/contracts'
import { isOffered, missingCells, type MatrixOffer } from '@nexus/factory-domain/product/styles/matrix'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { revisionState, type RevisionSummary } from '@nexus/factory-domain/product/styles/revisions'
import { garmentTracking, styleWarnings, type StyleFields } from '@nexus/factory-domain/product/styles/rules'
import { StaleVersionError, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { contextOf, mayWrite } from '../materials/store'

/**
 * The style library's rows (factory-db `Style`, `Colourway`, `Variant`, `StyleRevision`, and the `SizeScale` and `Size`
 * they pick from): the columns every read names, how a row becomes the domain's StyleFields and the contracts' views,
 * who may see and write which style, and the row locks the writes take.
 *
 * Lock order, so two writes never wait on each other in a circle: the style row first (`lockStyle`, or command()'s
 * record guard on the style), then its colourways, then its SKUs; a scale row before its sizes (`lockScale`), and a
 * style before its scale. A colourway, SKU or size change takes the parent's lock first and then compares and sets its
 * own version (`bumpVersion`), never command()'s record guard, which would lock the child first.
 */

export { contextOf }

export const STYLE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }
export const SCALE_SCOPE: ScopeColumns = { company: { field: 'companyId', nullable: true } }

const FIELD_COLUMNS = {
  code: true,
  name: true,
  nameI18n: true,
  description: true,
  productType: true,
  season: true,
  brandPartyId: true,
  sizeScaleId: true,
  sizes: true,
  baseSize: true,
  ppeCategory: true,
  ppeStandard: true,
  ppeClass: true,
  mtmAllowed: true,
  measurementTemplateId: true,
} as const satisfies Prisma.StyleSelect

/**
 * The style's own columns. Its brand, scale and template are read by `withRefs`, one query each: a select of several
 * relations makes Prisma send its queries at once on a transaction's one connection.
 */
export const STYLE_COLUMNS = {
  id: true,
  companyId: true,
  ...FIELD_COLUMNS,
  garmentTracking: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  _count: { select: { colourways: { where: { status: 'ACTIVE' } } } },
} as const satisfies Prisma.StyleSelect
type StyleBaseRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

interface Ref {
  readonly id: string
  readonly code: string
  readonly name: string
}

/** A style row with its brand, size scale and measurement template. */
export type StyleRowData = StyleBaseRow & {
  readonly brandParty: { readonly id: string; readonly code: string; readonly legalName: string; readonly tradeName: string | null } | null
  readonly sizeScale: Ref
  readonly measurementTemplate: Ref | null
}

/** The rows with their brand, scale and template (one query per kind, one after another). */
export async function withRefs(client: FactoryClient | CommandTx, rows: readonly StyleBaseRow[]): Promise<StyleRowData[]> {
  const ids = (pick: (row: StyleBaseRow) => string | null) => [...new Set(rows.map(pick).filter((id): id is string => id !== null))]
  const parties = await client.party.findMany({ where: { id: { in: ids((row) => row.brandPartyId) } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const scales = await client.sizeScale.findMany({ where: { id: { in: ids((row) => row.sizeScaleId) } }, select: { id: true, code: true, name: true } })
  const templates = await client.measurementTemplate.findMany({ where: { id: { in: ids((row) => row.measurementTemplateId) } }, select: { id: true, code: true, name: true } })
  const byId = <Row extends { id: string }>(list: readonly Row[]) => new Map(list.map((entry) => [entry.id, entry]))
  const party = byId(parties)
  const scale = byId(scales)
  const template = byId(templates)
  return rows.map((row) => ({
    ...row,
    brandParty: row.brandPartyId === null ? null : (party.get(row.brandPartyId) ?? null),
    sizeScale: scale.get(row.sizeScaleId) ?? { id: row.sizeScaleId, code: '', name: '' },
    measurementTemplate: row.measurementTemplateId === null ? null : (template.get(row.measurementTemplateId) ?? null),
  }))
}

/** One style row with its references, or null. */
export async function findStyleRow(client: FactoryClient | CommandTx, styleId: string): Promise<StyleRowData | null> {
  const row = await client.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  return row ? ((await withRefs(client, [row]))[0] ?? null) : null
}

export const COLOURWAY_COLUMNS = {
  id: true,
  styleId: true,
  code: true,
  name: true,
  colourId: true,
  description: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  colour: { select: { id: true, code: true, name: true, hex: true } },
} as const satisfies Prisma.ColourwaySelect
export type ColourwayRowData = Prisma.ColourwayGetPayload<{ select: typeof COLOURWAY_COLUMNS }>

export const VARIANT_COLUMNS = {
  id: true,
  styleId: true,
  colourwayId: true,
  size: true,
  sku: true,
  gtin: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.VariantSelect
export type VariantRowData = Prisma.VariantGetPayload<{ select: typeof VARIANT_COLUMNS }>

export const REVISION_COLUMNS = {
  id: true,
  styleId: true,
  revision: true,
  status: true,
  changeNote: true,
  labelTemplateId: true,
  releasedAt: true,
  releasedById: true,
  version: true,
  createdAt: true,
  createdById: true,
  updatedAt: true,
} as const satisfies Prisma.StyleRevisionSelect
export type RevisionRowData = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }>

export const SIZE_COLUMNS = { id: true, scaleId: true, code: true, label: true, seq: true, bodyMeasures: true, status: true, version: true } as const satisfies Prisma.SizeSelect
export type SizeRowData = Prisma.SizeGetPayload<{ select: typeof SIZE_COLUMNS }>

export const SCALE_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SizeScaleSelect
export type ScaleRowData = Prisma.SizeScaleGetPayload<{ select: typeof SCALE_COLUMNS }>

/** A style row as the domain's fields. */
export function fieldsOf(row: Prisma.StyleGetPayload<{ select: typeof FIELD_COLUMNS }>): StyleFields {
  return {
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    description: row.description,
    productType: row.productType,
    season: row.season,
    brandPartyId: row.brandPartyId,
    sizeScaleId: row.sizeScaleId,
    sizes: [...row.sizes],
    baseSize: row.baseSize,
    ppeCategory: row.ppeCategory,
    ppeStandard: row.ppeStandard,
    ppeClass: row.ppeClass,
    mtmAllowed: row.mtmAllowed,
    measurementTemplateId: row.measurementTemplateId,
  }
}

/** A JSON column set to the database's NULL (factory-db exports Prisma's types, not its runtime DbNull). */
export async function clearStyleNames(tx: CommandTx, styleId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "Style" SET "nameI18n" = NULL WHERE "id" = ${styleId}::uuid`
}
export async function clearBodyMeasures(tx: CommandTx, sizeId: string): Promise<void> {
  await tx.$executeRaw`UPDATE "Size" SET "bodyMeasures" = NULL WHERE "id" = ${sizeId}::uuid`
}

// ---- views --------------------------------------------------------------------------------------------------------------

const brandOf = (row: StyleRowData) => (row.brandParty ? { id: row.brandParty.id, code: row.brandParty.code, name: row.brandParty.tradeName ?? row.brandParty.legalName } : null)

/** What the list shows besides the row: the style's SKUs ON and its revisions. */
export interface RowFacts {
  readonly skuCount: number
  readonly revisions: readonly RevisionSummary[]
}

/** A row of the style list (SCR-040). */
export function styleRowView(row: StyleRowData, facts: RowFacts): StyleRow {
  const state = revisionState(facts.revisions)
  const colourwayCount = row._count.colourways
  return {
    id: row.id,
    companyId: row.companyId,
    code: row.code,
    name: row.name,
    nameI18n: (row.nameI18n as LocalisedNames | null) ?? null,
    productType: row.productType,
    season: row.season,
    brand: brandOf(row),
    sizeScale: { ...row.sizeScale },
    sizes: [...row.sizes],
    baseSize: row.baseSize,
    ppeCategory: row.ppeCategory,
    ppeStandard: row.ppeStandard,
    ppeClass: row.ppeClass,
    mtmAllowed: row.mtmAllowed,
    status: row.status,
    version: row.version,
    updatedAt: toUtcIso(row.updatedAt),
    colourwayCount,
    skuCount: facts.skuCount,
    revisionState: state,
    releasedRevision: facts.revisions.find((entry) => entry.status === 'RELEASED')?.revision ?? null,
    draftRevision: facts.revisions.find((entry) => entry.status === 'DRAFT')?.revision ?? null,
    completeness: {
      colourways: colourwayCount > 0,
      sizeRange: row.sizes.length > 0,
      baseSize: row.baseSize !== null,
      skus: facts.skuCount > 0,
      releasedRevision: state === 'RELEASED',
    },
  }
}

/** Everything the style record shows besides the style row. */
export interface StyleParts {
  readonly scaleSizes: readonly SizeRowData[]
  readonly colourways: readonly ColourwayRowData[]
  readonly variants: readonly VariantRowData[]
  readonly revisions: readonly RevisionRowData[]
  /** Colourways something names (SKUs, BOM colours, order lines, coverage). */
  readonly colourwaysInUse: ReadonlySet<string>
}

export const offerOf = (sizes: readonly string[], colourways: readonly Pick<ColourwayRowData, 'id' | 'code' | 'status'>[]): MatrixOffer => ({
  colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })),
  sizes: [...sizes],
})

export function revisionViewOf(row: RevisionRowData): RevisionView {
  return {
    id: row.id,
    revision: row.revision,
    status: row.status,
    changeNote: row.changeNote,
    labelTemplateId: row.labelTemplateId,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    releasedById: row.releasedById,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** The style record (SCR-041): identity, range, colourways, the colour x size grid, every SKU and the revisions. */
export function styleViewOf(row: StyleRowData, parts: StyleParts): StyleView {
  const fields = fieldsOf(row)
  const offer = offerOf(fields.sizes, parts.colourways)
  const sizeByCode = new Map(parts.scaleSizes.map((size) => [size.code, size]))
  const order = new Map(scaleOrder(parts.scaleSizes).map((code, index) => [code, index]))
  const colourwayOrder = new Map(parts.colourways.map((colourway, index) => [colourway.id, index]))
  const variantOf = new Map(parts.variants.map((variant) => [`${variant.colourwayId}\u0000${variant.size}`, variant]))
  const codeOf = new Map(parts.colourways.map((colourway) => [colourway.id, colourway.code]))
  const active = parts.variants.filter((variant) => variant.status === 'ACTIVE')

  const colourways: ColourwayView[] = parts.colourways.map((colourway) => ({
    id: colourway.id,
    code: colourway.code,
    name: colourway.name,
    colour: colourway.colour ? { ...colourway.colour } : null,
    description: colourway.description,
    status: colourway.status,
    version: colourway.version,
    offeredSizes: fields.sizes.filter((size) => variantOf.get(`${colourway.id}\u0000${size}`)?.status === 'ACTIVE'),
    inUse: parts.colourwaysInUse.has(colourway.id),
    createdAt: toUtcIso(colourway.createdAt),
    updatedAt: toUtcIso(colourway.updatedAt),
  }))

  const matrix: MatrixView = {
    sizes: fields.sizes.map((code) => ({ code, label: sizeByCode.get(code)?.label ?? code })),
    rows: parts.colourways.map((colourway) => ({
      colourwayId: colourway.id,
      code: colourway.code,
      name: colourway.name,
      status: colourway.status,
      cells: fields.sizes.map((size) => {
        const variant = variantOf.get(`${colourway.id}\u0000${size}`)
        return {
          size,
          offered: colourway.status === 'ACTIVE',
          sku: variant ? { id: variant.id, sku: variant.sku, gtin: variant.gtin, status: variant.status, version: variant.version } : null,
        }
      }),
    })),
    generated: parts.variants.length > 0,
    missing: missingCells(offer, parts.variants).length,
  }

  const skus: SkuView[] = [...parts.variants]
    .sort((a, b) => (colourwayOrder.get(a.colourwayId) ?? 0) - (colourwayOrder.get(b.colourwayId) ?? 0) || (order.get(a.size) ?? 0) - (order.get(b.size) ?? 0))
    .map((variant) => ({
      id: variant.id,
      colourwayId: variant.colourwayId,
      colourwayCode: codeOf.get(variant.colourwayId) ?? '',
      size: variant.size,
      sku: variant.sku,
      gtin: variant.gtin,
      status: variant.status,
      version: variant.version,
      offered: isOffered(offer, variant),
      createdAt: toUtcIso(variant.createdAt),
      updatedAt: toUtcIso(variant.updatedAt),
    }))

  const revisions = [...parts.revisions].sort((a, b) => b.revision - a.revision)
  return {
    ...styleRowView(row, { skuCount: active.length, revisions }),
    description: row.description,
    measurementTemplate: row.measurementTemplate ? { ...row.measurementTemplate } : null,
    tracking: garmentTracking(fields),
    garmentTracking: row.garmentTracking,
    range: fields.sizes.map((code) => {
      const size = sizeByCode.get(code)
      return { code, label: size?.label ?? null, status: (size?.status ?? 'ARCHIVED') as MasterStatus, bodyMeasures: (size?.bodyMeasures as BodyMeasures | null | undefined) ?? null }
    }),
    colourways,
    matrix,
    skus,
    revisions: revisions.map(revisionViewOf),
    warnings: styleWarnings(fields, { activeColourways: parts.colourways.filter((colourway) => colourway.status === 'ACTIVE').length, missingCells: matrix.missing }),
    createdAt: toUtcIso(row.createdAt),
    createdById: row.createdById,
  }
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** The colourways something names: SKUs, BOM lines and colour cells, quote and order lines, certificate coverage. */
export async function colourwaysInUse(client: FactoryClient | CommandTx, styleId: string): Promise<Set<string>> {
  // One after another: a transaction client runs one query at a time anyway.
  const variants = await client.variant.findMany({ where: { styleId }, select: { colourwayId: true }, distinct: ['colourwayId'] })
  const lines = await client.bomLine.findMany({ where: { styleId, colourwayId: { not: null } }, select: { colourwayId: true }, distinct: ['colourwayId'] })
  const cells = await client.bomLineColour.findMany({ where: { styleId }, select: { colourwayId: true }, distinct: ['colourwayId'] })
  const quoteLines = await client.quoteLine.findMany({ where: { styleId }, select: { colourwayId: true }, distinct: ['colourwayId'] })
  const orderLines = await client.salesOrderLine.findMany({ where: { styleId }, select: { colourwayId: true }, distinct: ['colourwayId'] })
  const coverage = await client.certificateCoverage.findMany({ where: { styleId }, select: { colourwayIds: true } })
  const used = new Set<string>()
  for (const row of [...variants, ...lines, ...cells, ...quoteLines, ...orderLines]) if (row.colourwayId) used.add(row.colourwayId)
  for (const row of coverage) for (const id of row.colourwayIds) used.add(id)
  return used
}

/** The style's parts, read with one client (a request's, or a command's transaction for its answer). */
export async function readParts(client: FactoryClient | CommandTx, row: Pick<StyleRowData, 'id' | 'sizeScaleId'>): Promise<StyleParts> {
  const scaleSizes = await client.size.findMany({ where: { scaleId: row.sizeScaleId }, select: SIZE_COLUMNS })
  const colourways = await client.colourway.findMany({ where: { styleId: row.id }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })
  const variants = await client.variant.findMany({ where: { styleId: row.id }, select: VARIANT_COLUMNS })
  const revisions = await client.styleRevision.findMany({ where: { styleId: row.id }, select: REVISION_COLUMNS, orderBy: { revision: 'desc' } })
  return { scaleSizes, colourways, variants, revisions, colourwaysInUse: await colourwaysInUse(client, row.id) }
}

/** The style as the caller may see it; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readStyle(caller: CommandCaller, styleId: string): Promise<StyleRowData> {
  const context = contextOf(caller)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const row = await caller.withClient((client) => findStyleRow(client, styleId))
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Style not found.')
  return row
}

/** The style and its parts as the command left them (its answer). */
export async function styleViewInTx(tx: CommandTx, styleId: string): Promise<StyleView> {
  const row = await findStyleRow(tx, styleId)
  if (!row) throw new NotFoundError('Style not found.')
  return styleViewOf(row, await readParts(tx, row))
}

/** The scale as the caller may see it. */
export async function readScale(caller: CommandCaller, scaleId: string): Promise<ScaleRowData> {
  const context = contextOf(caller)
  if (!isUuid(scaleId)) throw new NotFoundError('Size scale not found.')
  const row = await caller.withClient((client) => client.sizeScale.findUnique({ where: { id: scaleId }, select: SCALE_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_STYLES_VIEW, { companyId: row.companyId })) throw new NotFoundError('Size scale not found.')
  return row
}

// ---- who may write ------------------------------------------------------------------------------------------------------

export function assertMayWrite(context: RequestContext, permission: Permission, companyId: string | null, what: 'style' | 'size scale' = 'style'): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? `A ${what} for every company is changed only by a role over every company.` : undefined)
  }
}

// ---- locks and versions -------------------------------------------------------------------------------------------------

/** Locks the style row for the rest of the transaction (matrix changes wait for each other); answers its status. */
export async function lockStyle(tx: CommandTx, styleId: string): Promise<{ status: StyleRowData['status']; code: string; companyId: string | null }> {
  const rows = await tx.$queryRaw<{ status: StyleRowData['status']; code: string; companyId: string | null }[]>`
    SELECT "status"::text AS "status", "code", "companyId"::text AS "companyId" FROM "Style" WHERE "id" = ${styleId}::uuid FOR UPDATE`
  const row = rows[0]
  if (!row) throw new NotFoundError('Style not found.')
  return row
}

/** Locks the scale row: FOR UPDATE before its sizes change, FOR SHARE while a style picks sizes of it. */
export async function lockScale(tx: CommandTx, scaleId: string, mode: 'update' | 'share'): Promise<{ status: ScaleRowData['status']; code: string; companyId: string | null } | null> {
  const rows =
    mode === 'update'
      ? await tx.$queryRaw<{ status: ScaleRowData['status']; code: string; companyId: string | null }[]>`
          SELECT "status"::text AS "status", "code", "companyId"::text AS "companyId" FROM "SizeScale" WHERE "id" = ${scaleId}::uuid FOR UPDATE`
      : await tx.$queryRaw<{ status: ScaleRowData['status']; code: string; companyId: string | null }[]>`
          SELECT "status"::text AS "status", "code", "companyId"::text AS "companyId" FROM "SizeScale" WHERE "id" = ${scaleId}::uuid FOR SHARE`
  return rows[0] ?? null
}

type Versioned = 'colourway' | 'variant' | 'size'
const TYPE_NAME: Readonly<Record<Versioned, string>> = { colourway: 'Colourway', variant: 'Variant', size: 'Size' }

/** Compare-and-set of a child row's version, after its parent's lock (COL-078): a stale version is a 409. */
export async function bumpVersion(tx: CommandTx, model: Versioned, id: string, expected: number): Promise<number> {
  const where = { id, version: expected }
  const data = { version: expected + 1 }
  const { count } =
    model === 'colourway' ? await tx.colourway.updateMany({ where, data }) : model === 'variant' ? await tx.variant.updateMany({ where, data }) : await tx.size.updateMany({ where, data })
  if (count === 1) return expected + 1
  const current =
    model === 'colourway'
      ? await tx.colourway.findUnique({ where: { id }, select: { version: true } })
      : model === 'variant'
        ? await tx.variant.findUnique({ where: { id }, select: { version: true } })
        : await tx.size.findUnique({ where: { id }, select: { version: true } })
  if (!current) throw new NotFoundError(`${TYPE_NAME[model]} not found.`)
  throw new StaleVersionError(TYPE_NAME[model], id, current.version, expected)
}

// ---- checks against other records ---------------------------------------------------------------------------------------

const fits = (rowCompany: string | null, companyId: string | null): boolean => rowCompany === null || rowCompany === companyId

/** The style's scale: of the tenant, of the style's company or every company, ACTIVE when newly chosen. */
export async function scaleProblems(tx: CommandTx, scaleId: string, companyId: string | null, newlyChosen: boolean): Promise<Issue[]> {
  const scale = await lockScale(tx, scaleId, 'share')
  const at = 'body/sizeScaleId'
  if (!scale) return [{ path: at, message: 'No such size scale.' }]
  if (newlyChosen && scale.status !== 'ACTIVE') return [{ path: at, message: 'This size scale is archived.' }]
  if (!fits(scale.companyId, companyId)) return [{ path: at, message: "This size scale belongs to another company than the style's." }]
  return []
}

/** The brand a style is made for: a party with the BRAND role, not blocked or archived, of the style's company or every company. */
export async function brandProblems(client: FactoryClient | CommandTx, brandPartyId: string | null, companyId: string | null): Promise<Issue[]> {
  if (brandPartyId === null) return []
  const party = await client.party.findUnique({ where: { id: brandPartyId }, select: { roles: true, status: true, companyId: true } })
  const at = 'body/brandPartyId'
  if (!party) return [{ path: at, message: 'No such brand.' }]
  if (!party.roles.includes('BRAND')) return [{ path: at, message: 'This party is not a brand (give it the BRAND role first).' }]
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') return [{ path: at, message: `This brand is ${party.status.toLowerCase()}.` }]
  if (!fits(party.companyId, companyId)) return [{ path: at, message: "This brand belongs to another company than the style's." }]
  return []
}

/** A made-to-measure template: active, of the style's product type, of its company or every company. */
export async function templateProblems(client: FactoryClient | CommandTx, templateId: string | null, style: Pick<StyleFields, 'productType'>, companyId: string | null): Promise<Issue[]> {
  if (templateId === null) return []
  const template = await client.measurementTemplate.findUnique({ where: { id: templateId }, select: { status: true, productType: true, companyId: true } })
  const at = 'body/measurementTemplateId'
  if (!template) return [{ path: at, message: 'No such measurement template.' }]
  if (template.status !== 'ACTIVE') return [{ path: at, message: 'This measurement template is archived.' }]
  if (template.productType !== style.productType) return [{ path: at, message: `This measurement template is for ${template.productType.toLowerCase()}, not ${style.productType.toLowerCase()}.` }]
  if (!fits(template.companyId, companyId)) return [{ path: at, message: "This measurement template belongs to another company than the style's." }]
  return []
}

/** A colourway's library colour: active, of the style's company or every company. */
export async function colourProblems(client: FactoryClient | CommandTx, colourId: string | null | undefined, companyId: string | null, at: string): Promise<Issue[]> {
  if (colourId === null || colourId === undefined) return []
  const colour = await client.colour.findUnique({ where: { id: colourId }, select: { status: true, companyId: true } })
  if (!colour) return [{ path: at, message: 'No such library colour.' }]
  if (colour.status !== 'ACTIVE') return [{ path: at, message: 'This library colour is archived.' }]
  if (!fits(colour.companyId, companyId)) return [{ path: at, message: "This library colour belongs to another company than the style's." }]
  return []
}

export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[], what = 'style'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
