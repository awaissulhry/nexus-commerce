import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { componentsOf, numbered, SHEET_CATEGORIES, type ComponentLine, type MissingComponent, type WarningComponent } from '@nexus/factory-domain/costing/sheet-components/components'
import type { ComponentsQuery, ComponentsView, WriteComponentsBody } from '@nexus/factory-domain/costing/sheet-components/contracts'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import { COMPONENT_REFUSAL_WORDS, COMPONENTS_UNVERIFIED, incompleteWords, pieceRateWords } from '@nexus/factory-domain/costing/sheet-components/rules'
import { ledgerGroupOf, MARGIN_PART_OF, splitBySize, workOrderSplit, type PlannedCell, type SplitLine } from '@nexus/factory-domain/costing/sheet-components/split'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import type { ItemKind } from '@nexus/factory-domain/product/materials/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { contextOf, findRevision } from '../../product/bom/store'
import { companyFor, readStyleFor, STYLE_COLUMNS, type CostingStyleRow } from '../store'
import { componentRefusalOf, refused } from './refusals'
import { loadComponentFacts, type ComponentOptions } from './store'

/**
 * The cost sheet's components (B-W2b-418; FIN-003, FIN-006, FIN-008, FIN-009, FIN-011, FIN-020; design products.styles ›
 * Cost "Cost sheet" with its Subcontract, Packaging and Freight and duties steps, "Cost by size"): a revision's components
 * computed now as cost sheet lines; a DRAFT sheet's lines written from them (its typed lines kept); a written sheet's split by
 * size and category; and a work order's split from the sheet through its cost ledger to the margin part each category feeds.
 * Reads check costing.view over the style's company (a tenant-wide style: over the company asked for) or the work order's
 * company and site; the write checks costing.sheets.manage over the sheet's company. Figures are money.cost.
 */

const text = (value: { toString(): string }): string => decimalText(value.toString())
const today = (): string => businessDate(serverClock.now())

/** Every category with the ledger kind and margin part it goes to (FIN-020); packaging twice: the BOM's and the master's. */
const LEDGER_MAP = SHEET_CATEGORIES.flatMap((category) =>
  (category === 'PACKAGING' ? (['BOM_LINE', 'PACKAGING'] as const) : [null]).map((source) => {
    const group = ledgerGroupOf(category, source ?? 'TYPED')
    return { category, source, ledgerGroup: group, marginPart: MARGIN_PART_OF[group] }
  }),
)

const lineView = (line: ComponentLine & { readonly seq?: number }) => ({
  seq: line.seq ?? null,
  category: line.category,
  source: line.source,
  sourceRecordType: line.sourceRecordType,
  sourceRecordId: line.sourceRecordId,
  itemId: line.itemId,
  workCentreKind: line.workCentreKind,
  label: line.label,
  size: line.size,
  quantity: line.quantity,
  uom: line.uom,
  unitCost: asMoney('cost', line.unitCost),
  cost: asMoney('cost', line.cost),
  pct: asMoney('cost', line.pct),
  note: line.note,
})

/** A written line: with its id. */
const writtenView = (line: ComponentLine & { readonly seq: number; readonly id: string }) => ({ id: line.id, ...lineView(line) })

const splitView = (lines: readonly SplitLine[], sizes: readonly string[], missing: readonly { readonly size: string | null }[]) =>
  splitBySize(lines, sizes, missing).map((size) => ({
    size: size.size,
    categories: size.categories.map((entry) => ({ category: entry.category, amount: asMoney('cost', entry.amount) })),
    knownTotal: asMoney('cost', size.knownTotal),
    total: asMoney('cost', size.total),
    complete: size.complete,
  }))

const styleRef = (style: CostingStyleRow) => ({ id: style.id, code: style.code, name: style.name, companyId: style.companyId, baseSize: style.baseSize })

/** GET /costing/styles/:styleId/revisions/:revisionId/components — the components computed now, for one company and colourway. */
export async function revisionComponents(caller: CommandCaller, styleId: string, revisionId: string, query: ComponentsQuery): Promise<ComponentsView> {
  const style = await readStyleFor(caller, styleId)
  const company = await companyFor(caller, style, query.companyId, 'querystring/companyId')
  if (company.id === null) throw new ValidationError(COMPONENT_REFUSAL_WORDS.NO_COMPANY, [{ path: 'querystring/companyId', message: COMPONENT_REFUSAL_WORDS.NO_COMPANY }])
  const now = serverClock.now()
  const on = businessDate(now)
  return caller.withClient(async (db) => {
    const revision = await findRevision(db, styleId, revisionId)
    const loaded = await loadComponentFacts(db, style, revision, { id: company.id!, currency: company.currency }, on, query)
    const { lines, missing, warnings } = componentsOf(loaded.facts)
    return {
      style: styleRef(style),
      revision: { id: revision.id, revision: revision.revision, status: revision.status },
      companyId: company.id!,
      currency: company.currency,
      on,
      colourway: loaded.colourway,
      sizes: [...style.sizes],
      pieceRate: { on: loaded.pieceRate.on, siteId: loaded.pieceRate.siteId, words: pieceRateWords(loaded.pieceRate.on, loaded.pieceRate.payingSites) },
      piecesPerCarton: query.piecesPerCarton ?? null,
      lines: lines.map((line) => lineView(line)),
      split: splitView(lines, style.sizes, missing),
      complete: missing.length === 0 && lines.length > 0,
      missing,
      warnings,
      ledger: LEDGER_MAP,
      unverified: COMPONENTS_UNVERIFIED,
      computedAt: toUtcIso(now),
    }
  })
}

const SHEET_COLUMNS = { id: true, key: true, sheetVersion: true, state: true, companyId: true, styleId: true, revisionId: true, seasonId: true, currency: true, baseSize: true, inputs: true, version: true } as const satisfies Prisma.CostSheetSelect
type SheetRow = Prisma.CostSheetGetPayload<{ select: typeof SHEET_COLUMNS }>
const LINE_COLUMNS = { id: true, seq: true, category: true, source: true, sourceRecordType: true, sourceRecordId: true, itemId: true, workCentreKind: true, label: true, size: true, quantity: true, uom: true, unitCost: true, cost: true, pct: true, note: true } as const satisfies Prisma.CostSheetLineSelect
type LineRow = Prisma.CostSheetLineGetPayload<{ select: typeof LINE_COLUMNS }>

const sheetRef = (row: SheetRow) => ({ id: row.id, key: row.key, sheetVersion: row.sheetVersion, state: row.state, companyId: row.companyId, styleId: row.styleId, revisionId: row.revisionId, seasonId: row.seasonId, currency: row.currency, baseSize: row.baseSize, version: row.version })
const storedLine = (row: LineRow): ComponentLine & { seq: number; id: string } => ({
  id: row.id,
  seq: row.seq,
  category: row.category,
  source: row.source,
  sourceRecordType: row.sourceRecordType,
  sourceRecordId: row.sourceRecordId,
  itemId: row.itemId,
  workCentreKind: row.workCentreKind,
  label: row.label,
  size: row.size,
  quantity: text(row.quantity),
  uom: row.uom,
  unitCost: text(row.unitCost),
  cost: text(row.cost),
  pct: row.pct === null ? null : text(row.pct),
  note: row.note,
})

/** What the components left out when the sheet was written (kept in its inputs). */
const leftOutOf = (inputs: Prisma.JsonValue | null): MissingComponent[] => {
  const components = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>).components : null
  const leftOut = components && typeof components === 'object' && !Array.isArray(components) ? (components as Record<string, unknown>).leftOut : null
  return Array.isArray(leftOut) ? (leftOut as MissingComponent[]) : []
}

/** The sheet as the caller may see it (costing.view over its company), else not found. */
async function readSheetFor(caller: CommandCaller, sheetId: string): Promise<SheetRow> {
  const context = contextOf(caller)
  const row = isUuid(sheetId) ? await caller.withClient((db) => db.costSheet.findUnique({ where: { id: sheetId }, select: SHEET_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Cost sheet not found.')
  return row
}

/** GET /costing/cost-sheets/:sheetId/split — a written sheet's lines and its split by size and category (FIN-020). */
export async function sheetSplit(caller: CommandCaller, sheetId: string) {
  const sheet = await readSheetFor(caller, sheetId)
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
    const lines = (await db.costSheetLine.findMany({ where: { costSheetId: sheet.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })).map(storedLine)
    const leftOut = leftOutOf(sheet.inputs)
    return { sheet: sheetRef(sheet), sizes: [...style.sizes], lines: lines.map(writtenView), split: splitView(lines, style.sizes, leftOut), ledger: LEDGER_MAP, leftOut }
  })
}

/**
 * costing.writeSheetComponents — POST /costing/cost-sheets/:sheetId/components: a DRAFT sheet's lines written again from its
 * revision's components now (for its company, the colourway and site named), its TYPED lines kept where they are; the
 * inputs it was computed from kept on the sheet. Missing inputs refuse the write in words (INCOMPLETE) unless the person
 * asks to leave them out, which the sheet then records.
 */
export async function writeSheetComponents(caller: CommandCaller, sheetId: string, body: WriteComponentsBody, idempotencyKey?: string) {
  const context = contextOf(caller)
  const seen = await readSheetFor(caller, sheetId)
  if (!can(actorOf(context), COSTING_SHEETS_MANAGE, { companyId: seen.companyId })) throw new ForbiddenError()
  if (seen.state !== 'DRAFT') throw refused('NOT_DRAFT', COMPONENT_REFUSAL_WORDS.NOT_DRAFT)
  const options: ComponentOptions = { colourwayId: body.colourwayId, siteId: body.siteId, piecesPerCarton: body.piecesPerCarton }
  const { result } = await command(caller, { name: 'costing.writeSheetComponents', idempotencyKey, input: { sheetId, ...body }, record: { type: 'CostSheet', id: sheetId, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const sheet = await tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    if (sheet.state !== 'DRAFT') throw refused('NOT_DRAFT', COMPONENT_REFUSAL_WORDS.NOT_DRAFT)
    const style = await tx.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: STYLE_COLUMNS })
    const revision = await findRevision(tx, sheet.styleId, sheet.revisionId)
    const on = businessDate(now)
    const loaded = await loadComponentFacts(tx, style, revision, { id: sheet.companyId, currency: costingCurrency(sheet.currency) }, on, options)
    const { lines, missing, warnings } = componentsOf(loaded.facts)
    if (missing.length > 0 && !body.leaveOutMissing) {
      const words = incompleteWords(missing.length)
      throw refused('INCOMPLETE', words, missing.map((entry) => ({ path: `missing/${entry.code}`, message: entry.message })))
    }
    const before = await tx.costSheetLine.findMany({ where: { costSheetId: sheetId }, select: { id: true, seq: true, source: true } })
    const typed = before.filter((line) => line.source === 'TYPED')
    await tx.costSheetLine.deleteMany({ where: { costSheetId: sheetId, source: { not: 'TYPED' } } })
    const placed = numbered(lines, new Set(typed.map((line) => line.seq))).map((line) => ({ ...line, id: newId() }))
    const createdById = tools.context.audience === 'office' ? tools.context.actorId : null
    if (placed.length > 0) {
      await tx.costSheetLine.createMany({
        data: placed.map((line) => ({
          id: line.id,
          costSheetId: sheetId,
          seq: line.seq,
          category: line.category,
          source: line.source,
          sourceRecordType: line.sourceRecordType,
          sourceRecordId: line.sourceRecordId,
          itemId: line.itemId,
          workCentreKind: line.workCentreKind,
          label: line.label,
          size: line.size,
          quantity: line.quantity,
          uom: line.uom,
          unitCost: line.unitCost,
          cost: line.cost,
          pct: line.pct,
          note: line.note,
          createdAt: now,
          updatedAt: now,
          createdById,
        })),
      })
    }
    const kept = sheet.inputs && typeof sheet.inputs === 'object' && !Array.isArray(sheet.inputs) ? (sheet.inputs as Record<string, unknown>) : {}
    const components = { writtenAt: toUtcIso(now), on, colourwayId: loaded.colourway.id, siteId: loaded.pieceRate.siteId, piecesPerCarton: body.piecesPerCarton ?? null, leftOut: missing, warnings: warnings.map((warning: WarningComponent) => warning.code) }
    const updated = await tx.costSheet.update({ where: { id: sheetId }, data: { inputs: { ...kept, components } as unknown as Prisma.InputJsonValue, updatedAt: now }, select: SHEET_COLUMNS })
    tools.audit({
      recordType: 'CostSheet',
      recordId: sheetId,
      companyId: sheet.companyId,
      before: { lines: before.length },
      after: { lines: placed.length + typed.length, written: placed.length, keptTyped: typed.length, colourwayId: loaded.colourway.id, leftOut: missing.map((entry) => entry.code), total: markMoney('cost', placed.map((line) => line.cost)) },
    })
    tools.emit({ type: 'cost_sheet.components_written', subject: sheetId, companyId: sheet.companyId, payload: { sheetId, styleId: sheet.styleId, revisionId: sheet.revisionId, lines: placed.length, leftOut: missing.length } })
    return {
      sheet: sheetRef(updated),
      lines: placed.map(writtenView),
      split: splitView(lines, style.sizes, missing),
      missing,
      warnings,
      keptTyped: typed.length,
      unverified: COMPONENTS_UNVERIFIED,
    }
  }).catch((error: unknown) => {
    throw componentRefusalOf(error)
  })
  return result
}

const ACTUAL_KINDS = ['MATERIAL', 'SCRAP', 'LABOUR', 'SUBCONTRACT', 'OVERHEAD', 'ADJUSTMENT'] as const

/**
 * GET /costing/work-orders/:workOrderId/cost-split — the work order's planned cost by category (the approved cost sheet of its
 * revision and company, the newest approval; else the components computed now, per colourway), its actual from the cost
 * ledger by kind, the difference, and the margin part each feeds (FIN-020).
 */
export async function workOrderCostSplit(caller: CommandCaller, workOrderId: string) {
  const context = contextOf(caller)
  return caller.withClient(async (db) => {
    const workOrder = isUuid(workOrderId)
      ? await db.workOrder.findUnique({ where: { id: workOrderId }, select: { id: true, number: true, companyId: true, siteId: true, styleId: true, styleRevisionId: true, status: true } })
      : null
    if (!workOrder || workOrder.status === 'DRAFT' || !can(actorOf(context), COSTING_VIEW, { companyId: workOrder.companyId, siteId: workOrder.siteId })) throw new NotFoundError('Work order not found.')
    const company = await db.company.findUniqueOrThrow({ where: { id: workOrder.companyId }, select: { currency: true } })
    const currency = costingCurrency(company.currency)
    const cells = await db.workOrderSize.findMany({ where: { workOrderId }, select: { colourwayId: true, size: true, quantity: true } })
    const garments = cells.reduce((sum, cell) => sum + cell.quantity, 0)

    const approved = workOrder.styleRevisionId
      ? await db.costSheet.findFirst({ where: { companyId: workOrder.companyId, revisionId: workOrder.styleRevisionId, state: 'APPROVED' }, select: { id: true, sheetVersion: true, inputs: true }, orderBy: [{ approvedAt: 'desc' }, { id: 'asc' }] })
      : null
    let planned: PlannedCell[]
    let missing: MissingComponent[] = []
    let plan: { source: 'APPROVED_SHEET' | 'COMPONENTS'; costSheetId: string | null; sheetVersion: number | null; complete: boolean; words: string }
    if (approved) {
      const lines = (await db.costSheetLine.findMany({ where: { costSheetId: approved.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })).map(storedLine)
      missing = leftOutOf(approved.inputs)
      planned = cells.map((cell) => ({ size: cell.size, quantity: cell.quantity, lines }))
      plan = { source: 'APPROVED_SHEET', costSheetId: approved.id, sheetVersion: approved.sheetVersion, complete: missing.length === 0, words: `Planned at version ${approved.sheetVersion} of the approved cost sheet, for every colourway.` }
    } else if (workOrder.styleRevisionId) {
      const style = await db.style.findUniqueOrThrow({ where: { id: workOrder.styleId }, select: STYLE_COLUMNS })
      const revision = await findRevision(db, workOrder.styleId, workOrder.styleRevisionId)
      const byColourway = new Map<string, ComponentLine[]>()
      const found = new Map<string, MissingComponent>()
      for (const colourwayId of [...new Set(cells.map((cell) => cell.colourwayId))]) {
        const loaded = await loadComponentFacts(db, style, revision, { id: workOrder.companyId, currency }, today(), { colourwayId })
        const computed = componentsOf(loaded.facts)
        byColourway.set(colourwayId, computed.lines)
        for (const entry of computed.missing) found.set(entry.key, entry)
      }
      missing = [...found.values()]
      planned = cells.map((cell) => ({ size: cell.size, quantity: cell.quantity, lines: byColourway.get(cell.colourwayId) ?? [] }))
      plan = { source: 'COMPONENTS', costSheetId: null, sheetVersion: null, complete: missing.length === 0, words: 'No approved cost sheet for this revision and company: planned at the components computed today, per colourway.' }
    } else {
      planned = []
      plan = { source: 'COMPONENTS', costSheetId: null, sheetVersion: null, complete: false, words: 'The work order names no style revision: nothing to plan it at.' }
    }

    const entries = await db.workOrderCostEntry.findMany({ where: { workOrderId, kind: { in: [...ACTUAL_KINDS] } }, select: { kind: true, amount: true, itemId: true, currency: true } })
    const itemIds = [...new Set(entries.flatMap((entry) => (entry.itemId ? [entry.itemId] : [])))]
    const kinds = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind]))
    const split = workOrderSplit(
      planned,
      entries.filter((entry) => entry.currency === currency).map((entry) => ({ kind: entry.kind, amount: entry.amount, itemKind: entry.itemId ? ((kinds.get(entry.itemId) ?? null) as ItemKind | null) : null })),
      currency,
    )
    const cost = (value: number) => asMoney('cost', value)
    return {
      workOrder: { id: workOrder.id, number: workOrder.number, companyId: workOrder.companyId, styleId: workOrder.styleId, revisionId: workOrder.styleRevisionId, garments },
      currency,
      plan,
      rows: split.rows.map((row) => ({ ...row, planned: cost(row.planned) })),
      groups: split.groups.map((group) => ({ ...group, planned: cost(group.planned), actual: cost(group.actual), difference: cost(group.difference) })),
      materialActual: { leather: cost(split.materialActual.leather), material: cost(split.materialActual.material), packaging: cost(split.materialActual.packaging) },
      planned: cost(split.planned),
      actual: cost(split.actual),
      difference: cost(split.difference),
      notOnLedger: cost(split.notOnLedger),
      missing,
    }
  })
}
