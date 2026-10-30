import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { DomainError, ForbiddenError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { BomLineView, BomRevisionView, BomView } from '@nexus/factory-domain/product/bom/contracts'
import { PRODUCT_BOM_VIEW } from '@nexus/factory-domain/product/bom/permissions'
import { lineBySize, requirements } from '@nexus/factory-domain/product/bom/requirements'
import { bomIssues, editRefusal, inRangeOrder, type BomIssue, type BomIssueCode, type BomLineData, type BomLineFields, type BomMaterial, type BomStyle } from '@nexus/factory-domain/product/bom/rules'
import { ROUTING_ISSUE_CODES, routingIssues, type LibraryOperation, type RoutingIssue, type RoutingIssueCode, type StepData } from '@nexus/factory-domain/product/routing/rules'
import { decimalText, QUANTITY_SCALE, type RoundTo } from '@nexus/factory-domain/product/units/units'
import { StaleVersionError, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { ApiError } from '../../../core/errors'
import { contextOf, mayWrite } from '../materials/store'
import { readOperations, readSteps, type OperationFacts, type StepRecord } from '../routing/read'
import { lockStyle } from '../styles/store'

/**
 * The BOM's rows (factory-db `StyleRevision`, `BomLine`, `BomLineSize`, `BomLineColour`) and what they name (`Style`,
 * `Colourway`, `Item`, `ItemColour`, `Party`): the columns every read names (no relation selects: inside a transaction
 * Prisma would send them at once on its one connection), how they become the domain's lines and the BOM view, who may
 * see and write a style's BOM, and the locks its writes take.
 *
 * Lock order (the styles store's, extended): the style row first (`lockStyle`, FOR UPDATE), then the revision row by
 * compare-and-set of its version (`lockDraft`; the …_product_guards part trigger then takes it FOR SHARE, which this
 * transaction already holds), then the materials a line names (FOR SHARE, by id), then the parts. Two writes to one
 * revision wait for each other on the style row and the second then fails on the version (409): never a deadlock.
 * A draft's parts are removed with DELETE: the runtime role holds it on BomLine, BomLineSize, BomLineColour and
 * RoutingOperation (ownership/product.json), and the …_product_guards trigger allows it only while the revision is DRAFT.
 */

export { contextOf }

/** Each figure of a screen is rounded half up to the quantity scale (4 decimals), once. */
export const ROUND: RoundTo = { scale: QUANTITY_SCALE, rounding: 'HALF_UP' }

export const STYLE_COLUMNS = { id: true, code: true, name: true, companyId: true, status: true, sizes: true, baseSize: true, sizeScaleId: true } as const satisfies Prisma.StyleSelect
export type BomStyleRow = Prisma.StyleGetPayload<{ select: typeof STYLE_COLUMNS }>

export const REVISION_COLUMNS = {
  id: true,
  styleId: true,
  revision: true,
  status: true,
  changeNote: true,
  plannedHideYieldPct: true,
  labelTemplateId: true,
  releasedAt: true,
  releasedById: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.StyleRevisionSelect
export type RevisionRow = Prisma.StyleRevisionGetPayload<{ select: typeof REVISION_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  seq: true,
  itemId: true,
  placement: true,
  qty: true,
  uom: true,
  wastagePct: true,
  sizeDependent: true,
  colourDependent: true,
  itemColourId: true,
  colourwayId: true,
  supplierId: true,
  note: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.BomLineSelect
type LineRow = Prisma.BomLineGetPayload<{ select: typeof LINE_COLUMNS }>

const MATERIAL_COLUMNS = {
  id: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  companyId: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
} as const satisfies Prisma.ItemSelect
type MaterialRow = Prisma.ItemGetPayload<{ select: typeof MATERIAL_COLUMNS }>
const ITEM_COLOUR_COLUMNS = { id: true, itemId: true, code: true, name: true, status: true } as const satisfies Prisma.ItemColourSelect
type ItemColourRow = Prisma.ItemColourGetPayload<{ select: typeof ITEM_COLOUR_COLUMNS }>
const COLOURWAY_COLUMNS = { id: true, code: true, name: true, status: true } as const satisfies Prisma.ColourwaySelect
type ColourwayRow = Prisma.ColourwayGetPayload<{ select: typeof COLOURWAY_COLUMNS }>

const text = (value: { toString(): string }): string => decimalText(value.toString())
const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))

/** A stored line, as the domain reads it, with its row's version and times. */
export interface LineRecord extends BomLineData {
  readonly version: number
  readonly createdAt: Date
  readonly updatedAt: Date
}

/** A material, as the rules read it and the view shows it. */
export interface MaterialFacts extends BomMaterial {
  readonly name: string
  readonly companyId: string | null
}

function materialOf(row: MaterialRow, colours: readonly ItemColourRow[]): MaterialFacts {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    // W2a wave 5: never FINISHED here (a finished garment's item is no material, and no BOM line names one: …_production_w2a_guards).
    kind: row.kind as BomMaterial['kind'],
    status: row.status,
    companyId: row.companyId,
    units: { baseUom: row.baseUom, purchaseUom: row.purchaseUom, purchaseFactor: text(row.purchaseFactor), consumptionUom: row.consumptionUom, consumptionFactor: text(row.consumptionFactor) },
    colours: colours.filter((colour) => colour.itemId === row.id).map((colour) => ({ id: colour.id, code: colour.code, status: colour.status })),
  }
}

// ---- who may see and write ----------------------------------------------------------------------------------------------

/** The style as the caller may see its BOM; another company's (outside the caller's grants) or another tenant's is not found. */
export async function readStyleFor(caller: CommandCaller, styleId: string): Promise<BomStyleRow> {
  const context = contextOf(caller)
  if (!isUuid(styleId)) throw new NotFoundError('Style not found.')
  const row = await caller.withClient((client) => client.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS }))
  if (!row || !can(actorOf(context), PRODUCT_BOM_VIEW, { companyId: row.companyId })) throw new NotFoundError('Style not found.')
  return row
}

/** A revision of this style (another style's is not found). */
export async function findRevision(client: FactoryClient | CommandTx, styleId: string, revisionId: string): Promise<RevisionRow> {
  const row = isUuid(revisionId) ? await client.styleRevision.findUnique({ where: { id: revisionId }, select: REVISION_COLUMNS }) : null
  if (!row || row.styleId !== styleId) throw new NotFoundError('Revision not found.')
  return row
}

export async function readRevisionFor(caller: CommandCaller, styleId: string, revisionId: string): Promise<{ style: BomStyleRow; revision: RevisionRow }> {
  const style = await readStyleFor(caller, styleId)
  return { style, revision: await caller.withClient((client) => findRevision(client, styleId, revisionId)) }
}

export function assertMayWrite(context: RequestContext, permission: Permission, companyId: string | null): void {
  if (!mayWrite(actorOf(context), permission, companyId)) {
    throw new ForbiddenError(companyId === null ? 'The BOM of a style for every company is changed only by a role over every company.' : undefined)
  }
}

// ---- reads --------------------------------------------------------------------------------------------------------------

/** The style's order for a line's parts: the range's sizes and the colourways, as the style lists them. */
export interface PartsOrder {
  readonly sizes: readonly string[]
  readonly colourwayIds: readonly string[]
}

/** The lines of one revision with their size quantities and grid cells, in BOM order (the parts in the style's order when given). */
export async function readLines(client: FactoryClient | CommandTx, revisionId: string, order?: PartsOrder): Promise<LineRecord[]> {
  // One after another: a transaction client runs one query at a time anyway.
  const rows = await client.bomLine.findMany({ where: { revisionId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const sizes = await client.bomLineSize.findMany({ where: { revisionId }, select: { bomLineId: true, size: true, qty: true } })
  const cells = await client.bomLineColour.findMany({ where: { revisionId }, select: { bomLineId: true, colourwayId: true, itemColourId: true }, orderBy: { createdAt: 'asc' } })
  const colourwayIndex = new Map((order?.colourwayIds ?? []).map((id, index) => [id, index]))
  const sizesOf = (lineId: string) => {
    const rowsOfLine = sizes.filter((entry) => entry.bomLineId === lineId).map((entry) => ({ size: entry.size, qty: text(entry.qty) }))
    return order ? inRangeOrder(rowsOfLine, order.sizes) : rowsOfLine
  }
  const cellsOf = (lineId: string) =>
    cells
      .filter((cell) => cell.bomLineId === lineId)
      .map((cell) => ({ colourwayId: cell.colourwayId, itemColourId: cell.itemColourId }))
      .sort((a, b) => (colourwayIndex.get(a.colourwayId) ?? 0) - (colourwayIndex.get(b.colourwayId) ?? 0))
  return rows.map((row: LineRow) => ({
    id: row.id,
    seq: row.seq,
    itemId: row.itemId,
    placement: row.placement,
    qty: text(row.qty),
    uom: row.uom,
    wastagePct: text(row.wastagePct),
    sizeDependent: row.sizeDependent,
    colourDependent: row.colourDependent,
    itemColourId: row.itemColourId,
    colourwayId: row.colourwayId,
    supplierId: row.supplierId,
    note: row.note,
    sizes: sizesOf(row.id),
    colours: cellsOf(row.id),
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }))
}

/** The materials these lines name (with every colour of each), by id. */
export async function readMaterials(client: FactoryClient | CommandTx, itemIds: readonly string[]): Promise<{ materials: Map<string, MaterialFacts>; colours: Map<string, ItemColourRow> }> {
  const ids = [...new Set(itemIds)]
  const rows = ids.length === 0 ? [] : await client.item.findMany({ where: { id: { in: ids } }, select: MATERIAL_COLUMNS })
  const colourRows = ids.length === 0 ? [] : await client.itemColour.findMany({ where: { itemId: { in: ids } }, select: ITEM_COLOUR_COLUMNS, orderBy: { code: 'asc' } })
  return { materials: new Map(rows.map((row) => [row.id, materialOf(row, colourRows)])), colours: new Map(colourRows.map((row) => [row.id, row])) }
}

/** The style's colourways in its order (as the style record lists them). */
export const readColourways = (client: FactoryClient | CommandTx, styleId: string): Promise<ColourwayRow[]> =>
  client.colourway.findMany({ where: { styleId }, select: COLOURWAY_COLUMNS, orderBy: [{ createdAt: 'asc' }, { code: 'asc' }] })

export const bomStyleOf = (style: Pick<BomStyleRow, 'sizes' | 'baseSize'>, colourways: readonly ColourwayRow[]): BomStyle => ({
  sizes: [...style.sizes],
  baseSize: style.baseSize,
  colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, status: colourway.status })),
})

/** Everything the BOM view shows, read with one client. */
export interface LoadedBom {
  /** The revision's routing (B-W1-14), for the release check. */
  readonly steps: readonly StepRecord[]
  readonly routingOperations: ReadonlyMap<string, OperationFacts>
  readonly style: BomStyleRow
  readonly revision: RevisionRow
  readonly lines: readonly LineRecord[]
  readonly materials: ReadonlyMap<string, MaterialFacts>
  readonly itemColours: ReadonlyMap<string, ItemColourRow>
  readonly colourways: readonly ColourwayRow[]
  readonly sizeLabels: ReadonlyMap<string, string | null>
  readonly suppliers: ReadonlyMap<string, { id: string; code: string; name: string }>
}

export async function loadBom(client: FactoryClient | CommandTx, style: BomStyleRow, revision: RevisionRow): Promise<LoadedBom> {
  const colourways = await readColourways(client, style.id)
  const lines = await readLines(client, revision.id, { sizes: style.sizes, colourwayIds: colourways.map((colourway) => colourway.id) })
  const { materials, colours } = await readMaterials(client, lines.map((line) => line.itemId))
  const sizes = await client.size.findMany({ where: { scaleId: style.sizeScaleId, code: { in: style.sizes } }, select: { code: true, label: true } })
  const supplierIds = [...new Set(lines.map((line) => line.supplierId).filter((id): id is string => id !== null))]
  const parties = supplierIds.length === 0 ? [] : await client.party.findMany({ where: { id: { in: supplierIds } }, select: { id: true, code: true, legalName: true, tradeName: true } })
  const steps = await readSteps(client, revision.id)
  const routingOperations = await readOperations(client, steps.map((step) => step.operationId))
  return {
    style,
    revision,
    lines,
    steps,
    routingOperations,
    materials,
    itemColours: colours,
    colourways,
    sizeLabels: new Map(sizes.map((size) => [size.code, size.label])),
    suppliers: new Map(parties.map((party) => [party.id, { id: party.id, code: party.code, name: party.tradeName ?? party.legalName }])),
  }
}

// ---- the view -----------------------------------------------------------------------------------------------------------

export function revisionViewOf(row: RevisionRow): BomRevisionView {
  return {
    id: row.id,
    styleId: row.styleId,
    revision: row.revision,
    status: row.status,
    changeNote: row.changeNote,
    plannedHideYieldPct: textOrNull(row.plannedHideYieldPct),
    labelTemplateId: row.labelTemplateId,
    releasedAt: row.releasedAt ? toUtcIso(row.releasedAt) : null,
    releasedById: row.releasedById,
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

// ---- the release check ------------------------------------------------------------------------------------------------

/** A release-check finding: of the BOM (a line, a size, a colourway) or of the revision's routing (a step). */
export interface ReleaseIssue {
  readonly code: BomIssueCode | RoutingIssueCode
  readonly lineId: string | null
  readonly size: string | null
  readonly colourwayId: string | null
  readonly stepId: string | null
  readonly message: string
}

/** What the release check reads: the draft's BOM against its style and materials, and its routing against the library. */
export interface ReleaseFacts {
  readonly lines: readonly BomLineData[]
  readonly style: BomStyle
  readonly materials: ReadonlyMap<string, BomMaterial>
  readonly plannedHideYieldPct: string | null
  readonly steps: readonly StepData[]
  readonly operations: ReadonlyMap<string, Pick<LibraryOperation, 'code' | 'status'>>
}

/**
 * THE release check, one function for the release (./revisions releaseRevision refuses its blockers) and the BOM view
 * (its `issues`, `warnings` and `releasable`), so the screen never says a release would pass that is refused: the BOM's
 * findings (factory-domain product/bom `bomIssues`) and the routing's (product/routing `routingIssues`: a work order is
 * released with one operation per routing step, and the floor reports at the scanned ones).
 */
export function releaseCheck(facts: ReleaseFacts): { readonly blockers: ReleaseIssue[]; readonly warnings: ReleaseIssue[] } {
  const bom = bomIssues(facts.lines, facts.style, facts.materials, { plannedHideYieldPct: facts.plannedHideYieldPct })
  const routing = routingIssues(facts.steps, facts.operations)
  const fromBom = (issue: BomIssue): ReleaseIssue => ({ ...issue, stepId: null })
  const fromRouting = (issue: RoutingIssue): ReleaseIssue => ({ code: issue.code, lineId: null, size: null, colourwayId: null, stepId: issue.stepId, message: issue.message })
  return { blockers: [...bom.blockers.map(fromBom), ...routing.blockers.map(fromRouting)], warnings: [...bom.warnings.map(fromBom), ...routing.warnings.map(fromRouting)] }
}

const isRoutingIssue = (issue: ReleaseIssue): boolean => (ROUTING_ISSUE_CODES as readonly string[]).includes(issue.code)

/** The release's refusal (409) with every blocker of the BOM and the routing, each pointing at what to fix. */
export function releaseBlocked(blockers: readonly ReleaseIssue[]): DomainError {
  const issues = blockers.map((issue) => ({
    path: isRoutingIssue(issue)
      ? issue.stepId === null
        ? `routing/${issue.code}`
        : `routing/steps/${issue.stepId}`
      : issue.lineId === null
        ? `bom/${issue.code}`
        : `lines/${issue.lineId}${issue.size === null ? '' : `/sizes/${issue.size}`}${issue.colourwayId === null ? '' : `/colours/${issue.colourwayId}`}`,
    message: issue.message,
  }))
  const routing = blockers.filter(isRoutingIssue).length
  const what = routing === 0 ? 'The BOM is' : routing === blockers.length ? 'The routing is' : 'The BOM and the routing are'
  return new DomainError('invalid_state', `${what} not ready to release: ${blockers.length} problem(s) to fix first.`, issues)
}

const issueView = (issue: ReleaseIssue) => ({ ...issue })

/** The BOM of one revision (SCR-042), its figures per size and colourway, and what still blocks its release. */
export function bomViewOf(loaded: LoadedBom): BomView {
  const { style, revision, lines, materials, itemColours, colourways } = loaded
  const bomStyle = bomStyleOf(style, colourways)
  const draft = revision.status === 'DRAFT'
  const check = draft
    ? releaseCheck({ lines, style: bomStyle, materials, plannedHideYieldPct: textOrNull(revision.plannedHideYieldPct), steps: loaded.steps, operations: loaded.routingOperations })
    : { blockers: [], warnings: [] }
  const colourwayOf = new Map(colourways.map((colourway) => [colourway.id, colourway]))
  const colourRef = (id: string) => {
    const colour = itemColours.get(id)
    return colour ? { id: colour.id, code: colour.code, name: colour.name, status: colour.status } : { id, code: '', name: '', status: 'ARCHIVED' as const }
  }
  const material = (itemId: string): MaterialFacts => {
    const found = materials.get(itemId)
    if (!found) throw new ApiError('internal_error', `BOM line material ${itemId} was not read.`)
    return found
  }

  const lineViews: BomLineView[] = lines.map((line) => {
    const item = material(line.itemId)
    const colourway = line.colourwayId === null ? undefined : colourwayOf.get(line.colourwayId)
    return {
      id: line.id,
      seq: line.seq,
      item: { id: item.id, code: item.code, name: item.name, kind: item.kind, status: item.status, baseUom: item.units.baseUom },
      placement: line.placement,
      qty: line.qty,
      uom: line.uom,
      wastagePct: line.wastagePct,
      sizeDependent: line.sizeDependent,
      colourDependent: line.colourDependent,
      itemColour: line.itemColourId === null ? null : colourRef(line.itemColourId),
      colourway: colourway ? { id: colourway.id, code: colourway.code, name: colourway.name } : null,
      supplier: line.supplierId === null ? null : (loaded.suppliers.get(line.supplierId) ?? null),
      note: line.note,
      sizes: line.sizeDependent ? line.sizes.map((row) => ({ size: row.size, qty: row.qty })) : [],
      colours: line.colourDependent ? line.colours.map((cell) => ({ colourwayId: cell.colourwayId, itemColour: colourRef(cell.itemColourId) })) : [],
      bySize: lineBySize(line, style.sizes, item.units, ROUND),
      version: line.version,
      createdAt: toUtcIso(line.createdAt),
      updatedAt: toUtcIso(line.updatedAt),
    }
  })

  const active = colourways.filter((colourway) => colourway.status === 'ACTIVE')
  const rows = requirements(lines, { sizes: style.sizes, colourwayIds: active.map((colourway) => colourway.id) }, (itemId) => materials.get(itemId)?.units, ROUND)
  const requirementViews = active.map((colourway) => {
    const groups = new Map<string, { itemId: string; code: string; itemColourId: string | null; itemColourCode: string | null; uom: (typeof rows)[number]['uom']; bySize: { size: string; qty: string }[] }>()
    for (const row of rows.filter((entry) => entry.colourwayId === colourway.id)) {
      const key = `${row.itemId}\u0000${row.itemColourId ?? ''}`
      let group = groups.get(key)
      if (!group) {
        group = { itemId: row.itemId, code: material(row.itemId).code, itemColourId: row.itemColourId, itemColourCode: row.itemColourId === null ? null : (itemColours.get(row.itemColourId)?.code ?? null), uom: row.uom, bySize: [] }
        groups.set(key, group)
      }
      group.bySize.push({ size: row.size, qty: row.quantity })
    }
    return { colourwayId: colourway.id, code: colourway.code, materials: [...groups.values()] }
  })

  return {
    revision: revisionViewOf(revision),
    style: { id: style.id, code: style.code, name: style.name, companyId: style.companyId, status: style.status, baseSize: style.baseSize },
    sizes: style.sizes.map((code) => ({ code, label: loaded.sizeLabels.get(code) ?? code })),
    colourways: colourways.map((colourway) => ({ id: colourway.id, code: colourway.code, name: colourway.name, status: colourway.status })),
    lines: lineViews,
    requirements: requirementViews,
    issues: check.blockers.map(issueView),
    warnings: check.warnings.map(issueView),
    releasable: draft && style.status !== 'ARCHIVED' && check.blockers.length === 0,
  }
}

/** The BOM as the command left it (its answer). */
export async function bomViewInTx(tx: CommandTx, styleId: string, revisionId: string): Promise<BomView> {
  const style = await tx.style.findUnique({ where: { id: styleId }, select: STYLE_COLUMNS })
  if (!style) throw new NotFoundError('Style not found.')
  return bomViewOf(await loadBom(tx, style, await findRevision(tx, styleId, revisionId)))
}

// ---- locks and versions -------------------------------------------------------------------------------------------------

export interface LockedStyle {
  readonly id: string
  readonly code: string
  readonly companyId: string | null
  readonly status: BomStyleRow['status']
}

export interface LockedDraft {
  readonly style: LockedStyle
  readonly revisionId: string
  readonly revision: number
  /** The revision's version after this write. */
  readonly version: number
}

/** The style row, FOR UPDATE (the first lock of every BOM write). */
export async function lockStyleRow(tx: CommandTx, styleId: string): Promise<LockedStyle> {
  const locked = await lockStyle(tx, styleId)
  return { id: styleId, code: locked.code, companyId: locked.companyId, status: locked.status }
}

/** Compare-and-set of the revision's version (COL-078), after the style's lock: a stale version is a 409. */
export async function bumpRevision(tx: CommandTx, revisionId: string, expected: number, now: Date, data: Prisma.StyleRevisionUpdateManyMutationInput = {}): Promise<number> {
  const { count } = await tx.styleRevision.updateMany({ where: { id: revisionId, version: expected }, data: { ...data, version: expected + 1, updatedAt: now } })
  if (count === 1) return expected + 1
  const current = await tx.styleRevision.findUnique({ where: { id: revisionId }, select: { version: true } })
  if (!current) throw new NotFoundError('Revision not found.')
  throw new StaleVersionError('StyleRevision', revisionId, current.version, expected)
}

/**
 * The first step of every change to a draft's BOM: the style row locked, the revision checked (a DRAFT of this style,
 * the style not archived: a clear 409 before the database's own refusal) and its version compared and set.
 */
export async function lockDraft(tools: CommandTools, styleId: string, revisionId: string, expectedVersion: number): Promise<LockedDraft> {
  const { tx, now } = tools
  const style = await lockStyleRow(tx, styleId)
  const row = await findRevision(tx, styleId, revisionId)
  const refusal = editRefusal(row, style.status)
  if (refusal) throw new InvalidStateError(refusal)
  const version = await bumpRevision(tx, revisionId, expectedVersion, now)
  return { style, revisionId, revision: row.revision, version }
}

/** The materials' rows FOR SHARE, in id order: a material is not archived, nor its units changed, under a write that names it. */
export async function lockMaterials(tx: CommandTx, itemIds: readonly string[]): Promise<void> {
  const ids = [...new Set(itemIds)].sort()
  if (ids.length === 0) return
  await tx.$queryRaw`SELECT "id" FROM "Item" WHERE "id" = ANY(${ids}::uuid[]) ORDER BY "id" FOR SHARE`
}

// ---- checks against other records ---------------------------------------------------------------------------------------

const fits = (rowCompany: string | null, companyId: string | null): boolean => rowCompany === null || rowCompany === companyId

/** A line's material, locked FOR SHARE: of the tenant, of the style's company or every company. */
export async function materialFor(tx: CommandTx, itemId: string, companyId: string | null): Promise<MaterialFacts> {
  await lockMaterials(tx, [itemId])
  const { materials } = await readMaterials(tx, [itemId])
  const material = materials.get(itemId)
  if (!material) throw invalid([{ path: 'body/itemId', message: 'No such material.' }])
  if (!fits(material.companyId, companyId)) throw invalid([{ path: 'body/itemId', message: "This material belongs to another company than the style's." }])
  return material
}

/** A line's supplier: a party with the SUPPLIER role, not blocked or archived, of the style's company or every company. */
export async function supplierProblems(tx: CommandTx, supplierId: string | null, companyId: string | null): Promise<Issue[]> {
  if (supplierId === null) return []
  const party = await tx.party.findUnique({ where: { id: supplierId }, select: { roles: true, status: true, companyId: true } })
  const at = 'body/supplierId'
  if (!party) return [{ path: at, message: 'No such supplier.' }]
  if (!party.roles.includes('SUPPLIER')) return [{ path: at, message: 'This party is not a supplier.' }]
  if (party.status === 'BLOCKED' || party.status === 'ARCHIVED') return [{ path: at, message: `This supplier is ${party.status.toLowerCase()}.` }]
  if (!fits(party.companyId, companyId)) return [{ path: at, message: "This supplier belongs to another company than the style's." }]
  return []
}

export const prefixed = (issues: readonly Issue[], at = 'body'): Issue[] => issues.map((issue) => ({ path: `${at}/${issue.path}`, message: issue.message }))
export const invalid = (issues: readonly Issue[], what = 'BOM line'): ValidationError => new ValidationError(`The ${what} is not valid.`, issues)
export const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

// ---- writes -------------------------------------------------------------------------------------------------------------

/** A line's fields as the audit row keeps them (sizes and grid as maps). */
export function auditedLine(line: BomLineFields): Record<string, unknown> {
  return {
    seq: line.seq,
    itemId: line.itemId,
    placement: line.placement,
    qty: line.qty,
    uom: line.uom,
    wastagePct: line.wastagePct,
    sizeDependent: line.sizeDependent,
    colourDependent: line.colourDependent,
    itemColourId: line.itemColourId,
    colourwayId: line.colourwayId,
    supplierId: line.supplierId,
    note: line.note,
    sizes: line.sizeDependent ? Object.fromEntries(line.sizes.map((row) => [row.size, row.qty])) : {},
    colours: line.colourDependent ? Object.fromEntries(line.colours.map((cell) => [cell.colourwayId, cell.itemColourId])) : {},
  }
}

const removed = (count: number, expected: number, what: string): void => {
  // Row-level security without a DELETE policy removes nothing and says nothing: never let that pass as done.
  if (count !== expected) throw new ApiError('internal_error', `The database removed ${count} of ${expected} ${what}.`)
}

interface PartsTarget {
  readonly styleId: string
  readonly revisionId: string
  readonly lineId: string
}

/**
 * Writes one line and its parts so the stored rows are exactly `line` (a new line when `before` is null): the size rows
 * and grid cells it no longer has are removed, changed ones updated, new ones inserted. Grid cells name the line's
 * material, so a material change removes them before the line changes.
 */
export async function writeLine(tools: CommandTools, target: PartsTarget, line: BomLineFields, before: LineRecord | null): Promise<void> {
  const { tx, now } = tools
  const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
  const { styleId, revisionId, lineId } = target
  const fields = {
    seq: line.seq,
    itemId: line.itemId,
    placement: line.placement,
    qty: line.qty,
    uom: line.uom,
    wastagePct: line.wastagePct,
    sizeDependent: line.sizeDependent,
    colourDependent: line.colourDependent,
    itemColourId: line.itemColourId,
    colourwayId: line.colourwayId,
    supplierId: line.supplierId,
    note: line.note,
  }
  let storedCells = before ? [...before.colours] : []
  if (before && before.itemId !== line.itemId && storedCells.length > 0) {
    const { count } = await tx.bomLineColour.deleteMany({ where: { bomLineId: lineId } })
    removed(count, storedCells.length, 'grid cells')
    storedCells = []
  }
  if (before) await tx.bomLine.update({ where: { id: lineId }, data: { ...fields, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  else await tx.bomLine.create({ data: { id: lineId, styleId, revisionId, ...fields, createdAt: now, updatedAt: now, createdById }, select: { id: true } })

  // Size quantities.
  const wantSizes = new Map((line.sizeDependent ? line.sizes : []).map((row) => [row.size, row.qty]))
  const haveSizes = new Map((before?.sizes ?? []).map((row) => [row.size, row.qty]))
  const goneSizes = [...haveSizes.keys()].filter((size) => !wantSizes.has(size))
  if (goneSizes.length > 0) removed((await tx.bomLineSize.deleteMany({ where: { bomLineId: lineId, size: { in: goneSizes } } })).count, goneSizes.length, 'size quantities')
  for (const [size, qty] of wantSizes) {
    const had = haveSizes.get(size)
    if (had === qty) continue
    if (had !== undefined) await tx.bomLineSize.updateMany({ where: { bomLineId: lineId, size }, data: { qty, version: { increment: 1 }, updatedAt: now } })
  }
  const newSizes = [...wantSizes].filter(([size]) => !haveSizes.has(size))
  if (newSizes.length > 0) {
    await tx.bomLineSize.createMany({ data: newSizes.map(([size, qty]) => ({ id: newId(), revisionId, bomLineId: lineId, size, qty, createdAt: now, updatedAt: now, createdById })) })
  }

  // Grid cells.
  const wantCells = new Map((line.colourDependent ? line.colours : []).map((cell) => [cell.colourwayId, cell.itemColourId]))
  const haveCells = new Map(storedCells.map((cell) => [cell.colourwayId, cell.itemColourId]))
  const goneCells = [...haveCells.keys()].filter((colourwayId) => !wantCells.has(colourwayId))
  if (goneCells.length > 0) removed((await tx.bomLineColour.deleteMany({ where: { bomLineId: lineId, colourwayId: { in: goneCells } } })).count, goneCells.length, 'grid cells')
  for (const [colourwayId, itemColourId] of wantCells) {
    const had = haveCells.get(colourwayId)
    if (had !== undefined && had !== itemColourId) await tx.bomLineColour.updateMany({ where: { bomLineId: lineId, colourwayId }, data: { itemColourId, version: { increment: 1 }, updatedAt: now } })
  }
  const newCells = [...wantCells].filter(([colourwayId]) => !haveCells.has(colourwayId))
  if (newCells.length > 0) {
    await tx.bomLineColour.createMany({
      data: newCells.map(([colourwayId, itemColourId]) => ({ id: newId(), styleId, revisionId, bomLineId: lineId, itemId: line.itemId, colourwayId, itemColourId, createdAt: now, updatedAt: now, createdById })),
    })
  }
}

/** Removes a draft's line with its size quantities and grid cells. */
export async function deleteLine(tools: CommandTools, line: LineRecord): Promise<void> {
  const { tx } = tools
  if (line.colours.length > 0) removed((await tx.bomLineColour.deleteMany({ where: { bomLineId: line.id } })).count, line.colours.length, 'grid cells')
  if (line.sizes.length > 0) removed((await tx.bomLineSize.deleteMany({ where: { bomLineId: line.id } })).count, line.sizes.length, 'size quantities')
  removed((await tx.bomLine.deleteMany({ where: { id: line.id } })).count, 1, 'BOM line')
}
