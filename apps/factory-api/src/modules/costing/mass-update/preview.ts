import { createHash } from 'node:crypto'
import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import { can, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import type { MassPreviewView } from '@nexus/factory-domain/costing/mass-update/contracts'
import { changesProblems, entryEffect, MASS_LIMITS, MASS_REFUSAL_WORDS, orderLineEffect, priceChangePct, SERIES_WORDS, stableJson, type MassChange, type MassRefusal, type SeriesState } from '@nexus/factory-domain/costing/mass-update/rules'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { componentsOf, type Components } from '@nexus/factory-domain/costing/sheet-components/components'
import { six } from '@nexus/factory-domain/costing/sheet-components/rules'
import { splitBySize } from '@nexus/factory-domain/costing/sheet-components/split'
import { weightedCost } from '@nexus/factory-domain/costing/size-weights/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { MAX_BOM_LEVELS } from '@nexus/factory-domain/product/bom-structure/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTx } from '../../../core/command'
import { findRevision } from '../../product/bom/store'
import { costsOf, inputsPart, linesOf, SHEET_COLUMNS, weightsOf, type SheetRow } from '../sheet-versions/store'
import { loadComponentFacts, type ComponentOptions } from '../sheet-components/store'
import { STYLE_COLUMNS, type CostingStyleRow } from '../store'

/**
 * The mass cost update's preview (B-W2b-423; FIN-022; design finance.costing › "Mass cost update"): what new standard prices of
 * some materials do, computed now and written nowhere — the materials, each affected cost sheet series (its newest version
 * that is not frozen, whose revision takes a changed material at any level of its BOM) with its components at today's prices
 * and with the new ones, the active price list entries of the affected styles and the lines of open orders, each margin before
 * and after. `previewOf` answers the route and is computed again inside the apply's command: its hash (every material, version,
 * entry, line and figure it read) must be the one the person saw. Reads with one client, one query after another.
 */

type Reader = FactoryClient | CommandTx

export const OPEN_ORDER_STATES = ['PENDING_APPROVAL', 'CONFIRMED', 'IN_PRODUCTION', 'READY', 'PARTLY_SHIPPED'] as const

export const massRefused = (code: MassRefusal, more: readonly { path: string; message: string }[] = []): DomainError =>
  new DomainError('conflict', MASS_REFUSAL_WORDS[code], [{ path: `refusal/${code}`, message: MASS_REFUSAL_WORDS[code] }, ...more])

const text = (value: { toString(): string }): string => decimalText(value.toString())

export interface MaterialRow {
  readonly id: string
  readonly code: string
  readonly name: string
  readonly companyId: string | null
  readonly baseUom: string
  readonly currency: string
  readonly standardCost: string | null
  readonly version: number
}

/** One affected series as the apply writes it. */
export interface SeriesPlan {
  readonly sheet: SheetRow
  readonly style: CostingStyleRow
  readonly state: SeriesState
  readonly options: ComponentOptions
  readonly missing: readonly string[]
}

export interface Preview {
  readonly view: MassPreviewView
  readonly materials: readonly MaterialRow[]
  readonly series: readonly SeriesPlan[]
}

/** Every revision that takes one of these materials, at any level (a sub-assembly's parents up to MAX_BOM_LEVELS). */
async function affectedRevisions(db: Reader, itemIds: readonly string[]): Promise<Set<string>> {
  const found = new Set((await db.bomLine.findMany({ where: { itemId: { in: [...itemIds] } }, select: { revisionId: true }, distinct: ['revisionId'] })).map((row) => row.revisionId))
  let frontier = [...found]
  for (let level = 1; level <= MAX_BOM_LEVELS && frontier.length > 0; level += 1) {
    const parents = (await db.bomLine.findMany({ where: { subAssemblyRevisionId: { in: frontier } }, select: { revisionId: true }, distinct: ['revisionId'] })).map((row) => row.revisionId).filter((id) => !found.has(id))
    for (const id of parents) found.add(id)
    frontier = parents
  }
  return found
}

/** The components of a version's revision now, for its company, colourway, site and garments per carton (null: they cannot be read). */
async function componentsNow(db: Reader, sheet: SheetRow, style: CostingStyleRow, on: string, options: ComponentOptions): Promise<{ components: Components } | { problem: string }> {
  try {
    const revision = await findRevision(db, style.id, sheet.revisionId)
    const loaded = await loadComponentFacts(db, style, revision, { id: sheet.companyId, currency: costingCurrency(sheet.currency) }, on, options)
    return { components: componentsOf(loaded.facts) }
  } catch (error) {
    if (error instanceof DomainError) return { problem: error.message }
    throw error
  }
}

const sizeTotals = (components: Components, sizes: readonly string[]) => splitBySize(components.lines, sizes, components.missing).map((split) => ({ size: split.size, total: split.total }))

export async function previewOf(db: Reader, actor: Actor, changes: readonly MassChange[], now: Date): Promise<Preview> {
  const problems = changesProblems(changes)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
  const on = businessDate(now)
  const ids = changes.map((change) => change.itemId)
  const rows = await db.item.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true, companyId: true, kind: true, status: true, baseUom: true, currency: true, standardCost: true, version: true } })
  const issues = changes.flatMap((change, index) => {
    const row = rows.find((entry) => entry.id === change.itemId)
    if (!row || !can(actor, COSTING_VIEW, { companyId: row.companyId })) return [{ path: `body/changes/${index}/itemId`, message: 'No such material.' }]
    if (row.kind === 'FINISHED') return [{ path: `body/changes/${index}/itemId`, message: `${row.code} is a finished garment, not a material.` }]
    if (row.status !== 'ACTIVE') return [{ path: `body/changes/${index}/itemId`, message: `${row.code} is archived.` }]
    return []
  })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  const materials: MaterialRow[] = changes.map((change) => {
    const row = rows.find((entry) => entry.id === change.itemId)!
    return { id: row.id, code: row.code, name: row.name, companyId: row.companyId, baseUom: row.baseUom, currency: row.currency, standardCost: row.standardCost === null ? null : text(row.standardCost), version: row.version }
  })
  if (materials.every((material, index) => material.standardCost !== null && new Decimal(material.standardCost).equals(changes[index]!.newPrice))) throw massRefused('NOTHING_CHANGES')
  const overrides = new Map(changes.map((change) => [change.itemId, decimalText(change.newPrice)]))

  // The series: the newest version that is not frozen of each series the caller sees whose revision takes a changed material.
  const revisions = await affectedRevisions(db, ids)
  const visible = scopeWhere(actor, COSTING_VIEW, { company: 'companyId' }) as Prisma.CostSheetWhereInput
  const touched = await db.costSheet.findMany({ where: { AND: [visible, { revisionId: { in: [...revisions] }, state: { in: ['DRAFT', 'APPROVED'] } }] }, select: { key: true }, distinct: ['key'] })
  const newest = new Map<string, SheetRow>()
  if (touched.length > 0) {
    const versions = await db.costSheet.findMany({ where: { AND: [visible, { key: { in: touched.map((row) => row.key) }, state: { in: ['DRAFT', 'APPROVED'] } }] }, select: SHEET_COLUMNS, orderBy: [{ key: 'asc' }, { sheetVersion: 'desc' }] })
    for (const version of versions) if (!newest.has(version.key)) newest.set(version.key, version)
  }
  const sheets = [...newest.values()].filter((sheet) => revisions.has(sheet.revisionId))
  if (sheets.length > MASS_LIMITS.series) throw massRefused('TOO_MANY')
  const costed = new Set((await db.costSheet.findMany({ where: { revisionId: { in: [...revisions] } }, select: { revisionId: true }, distinct: ['revisionId'] })).map((row) => row.revisionId))
  const bare = [...revisions].filter((id) => !costed.has(id))
  const bareRows = bare.length === 0 ? [] : await db.styleRevision.findMany({ where: { id: { in: bare } }, select: { id: true, revision: true, styleId: true } })
  const bareStyles = new Map((bareRows.length === 0 ? [] : await db.style.findMany({ where: { id: { in: bareRows.map((row) => row.styleId) } }, select: { id: true, code: true, companyId: true } })).map((style) => [style.id, style]))
  // Revisions of finished garments only (a sub-assembly without a sheet of its own is costed inside its parent's).
  const parentsOnly = new Set((await db.bomLine.findMany({ where: { subAssemblyRevisionId: { in: bare } }, select: { subAssemblyRevisionId: true }, distinct: ['subAssemblyRevisionId'] })).map((row) => row.subAssemblyRevisionId))
  const withoutSheet = bareRows
    .filter((row) => !parentsOnly.has(row.id) && bareStyles.has(row.styleId) && can(actor, COSTING_VIEW, { companyId: bareStyles.get(row.styleId)!.companyId }))
    .map((row) => ({ styleId: row.styleId, code: bareStyles.get(row.styleId)!.code, revisionId: row.id, revision: row.revision }))
    .sort((a, b) => (a.code < b.code ? -1 : a.code > b.code ? 1 : a.revision - b.revision))
  if (sheets.length === 0 && withoutSheet.length === 0) throw massRefused('NOTHING_AFFECTED')

  const series: SeriesPlan[] = []
  const seriesViews: MassPreviewView['series'] = []
  const deltas = new Map<string, { sheet: SheetRow; style: CostingStyleRow; bySize: Map<string, string | null>; before: string | null; after: string | null }>()
  for (const sheet of sheets.sort((a, b) => (a.key < b.key ? -1 : 1))) {
    const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: STYLE_COLUMNS })
    const components = inputsPart(sheet.inputs, 'components')
    const options: ComponentOptions = {
      colourwayId: typeof components?.colourwayId === 'string' ? components.colourwayId : undefined,
      siteId: typeof components?.siteId === 'string' ? components.siteId : undefined,
      piecesPerCarton: typeof components?.piecesPerCarton === 'number' ? components.piecesPerCarton : undefined,
    }
    const season = sheet.seasonId ? await db.season.findUnique({ where: { id: sheet.seasonId }, select: { status: true } }) : null
    const before = await componentsNow(db, sheet, style, on, options)
    const after = await componentsNow(db, sheet, style, on, { ...options, priceOverrides: overrides })
    const stored = costsOf(sheet, await linesOf(db, sheet.id), style.sizes)
    const missing = 'problem' in after ? [after.problem] : [...new Set(after.components.missing.map((entry) => entry.message))]
    const state: SeriesState = sheet.seasonId !== null && season?.status !== 'OPEN' ? 'SEASON_CLOSED' : missing.length > 0 ? 'INCOMPLETE' : 'RECOMPUTED'
    const beforeTotals = 'components' in before ? sizeTotals(before.components, style.sizes) : style.sizes.map((size) => ({ size, total: null }))
    const afterTotals = 'components' in after ? sizeTotals(after.components, style.sizes) : style.sizes.map((size) => ({ size, total: null }))
    const sizes = style.sizes.map((size, index) => {
      const b = beforeTotals[index]!.total
      const a = afterTotals[index]!.total
      return { size, before: b, after: a, move: b === null || a === null ? null : six(new Decimal(a).minus(b)) }
    })
    const weights = weightsOf(sheet.sizeWeights)
    const weightedBefore = weightedCost(beforeTotals, weights).weighted
    const weightedAfter = weightedCost(afterTotals, weights).weighted
    const base = sizes.find((entry) => entry.size === sheet.baseSize) ?? { size: sheet.baseSize, before: null, after: null, move: null }
    series.push({ sheet, style, state, options, missing })
    deltas.set(sheet.key, {
      sheet,
      style,
      bySize: new Map(sizes.map((entry) => [entry.size, entry.move])),
      before: weights ? weightedBefore : base.before,
      after: weights ? weightedAfter : base.after,
    })
    const money = (entry: { size: string; before: string | null; after: string | null; move: string | null }) => ({ size: entry.size, before: asMoney('cost', entry.before), after: asMoney('cost', entry.after), move: asMoney('cost', entry.move) })
    seriesViews.push({
      key: sheet.key,
      style: { id: style.id, code: style.code, name: style.name },
      companyId: sheet.companyId,
      seasonId: sheet.seasonId,
      sheet: { id: sheet.id, sheetVersion: sheet.sheetVersion, state: sheet.state as 'DRAFT' | 'APPROVED', revisionId: sheet.revisionId, baseSize: sheet.baseSize, version: sheet.version },
      state,
      words: SERIES_WORDS[state],
      stored: asMoney('cost', stored.baseCost),
      sizes: sizes.map(money),
      baseSize: money(base),
      weighted: { before: asMoney('cost', weightedBefore), after: asMoney('cost', weightedAfter) },
      missing,
    })
  }

  // Open price lists: the active entries of the affected styles, against the cost before and after.
  const styleIds = [...new Set(sheets.map((sheet) => sheet.styleId))]
  const today = new Date(`${on}T00:00:00.000Z`)
  const entries =
    styleIds.length === 0
      ? []
      : await db.priceListEntry.findMany({
          where: {
            styleId: { in: styleIds },
            AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: today } }] }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }],
            listVersion: { status: 'ACTIVE', AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: today } }] }, { OR: [{ validTo: null }, { validTo: { gte: today } }] }], list: { status: 'ACTIVE' } },
          },
          select: { id: true, styleId: true, colourwayId: true, unitPrice: true, version: true, listVersion: { select: { id: true, revision: true, list: { select: { id: true, code: true, name: true, companyId: true, currency: true } } } }, style: { select: { code: true } } },
          orderBy: [{ id: 'asc' }],
          take: MASS_LIMITS.documents + 1,
        })
  const priceLists: MassPreviewView['priceLists'] = []
  for (const entry of entries.slice(0, MASS_LIMITS.documents)) {
    const list = entry.listVersion.list
    if (list.companyId !== null && !can(actor, COSTING_VIEW, { companyId: list.companyId })) continue
    const match = [...deltas.values()].find((delta) => delta.sheet.styleId === entry.styleId && (list.companyId === null ? delta.sheet.currency === list.currency : delta.sheet.companyId === list.companyId))
    if (!match) continue
    const comparable = match.sheet.currency === list.currency
    const price = text(entry.unitPrice)
    const effect = comparable ? entryEffect(price, match.before, match.before === null || match.after === null ? null : six(new Decimal(match.after).minus(match.before))) : null
    priceLists.push({
      listId: list.id,
      code: list.code,
      name: list.name,
      versionId: entry.listVersion.id,
      revision: entry.listVersion.revision,
      currency: list.currency,
      styleId: entry.styleId,
      styleCode: entry.style.code,
      colourwayId: entry.colourwayId,
      price: asMoney('price', price),
      costBefore: asMoney('cost', effect?.costBefore ?? null),
      costAfter: asMoney('cost', effect?.costAfter ?? null),
      marginBefore: asMoney('margin', effect?.marginBefore ?? null),
      marginAfter: asMoney('margin', effect?.marginAfter ?? null),
      marginMove: asMoney('margin', effect?.marginMove ?? null),
      comparable,
    })
  }

  // Open orders: the lines of the affected styles on orders not yet shipped, closed or cancelled; each order keeps its own cost.
  const orders: MassPreviewView['orders'] = []
  let orderTruncated = false
  if (sheets.length > 0) {
    const pairs = [...new Map(sheets.map((sheet) => [`${sheet.companyId}:${sheet.styleId}`, { companyId: sheet.companyId, styleId: sheet.styleId }])).values()]
    const lines = await db.salesOrderLine.findMany({
      where: { kind: { not: 'FEE' }, OR: pairs.map((pair) => ({ styleId: pair.styleId, order: { companyId: pair.companyId, status: { in: [...OPEN_ORDER_STATES] } } })) },
      select: { id: true, seq: true, styleId: true, quantity: true, netAmount: true, costAmount: true, baseSize: true, order: { select: { id: true, number: true, status: true, companyId: true, currency: true, party: { select: { legalName: true, tradeName: true } } } }, style: { select: { code: true } } },
      orderBy: [{ orderId: 'asc' }, { seq: 'asc' }],
      take: MASS_LIMITS.documents + 1,
    })
    orderTruncated = lines.length > MASS_LIMITS.documents
    const shown = lines.slice(0, MASS_LIMITS.documents)
    const sizeRows = shown.length === 0 ? [] : await db.salesOrderLineSize.findMany({ where: { lineId: { in: shown.map((line) => line.id) } }, select: { lineId: true, size: true, quantity: true } })
    for (const line of shown) {
      const delta = [...deltas.values()].find((entry) => entry.sheet.styleId === line.styleId && entry.sheet.companyId === line.order.companyId)
      if (!delta) continue
      const sized = sizeRows.filter((row) => row.lineId === line.id)
      const pieces = sized.length > 0 ? sized.map((row) => ({ size: row.size, quantity: row.quantity })) : [{ size: line.baseSize ?? delta.sheet.baseSize, quantity: line.quantity }]
      const currency = line.order.currency
      const comparable = currency === delta.sheet.currency
      const effect = orderLineEffect({ currency: currency as Parameters<typeof orderLineEffect>[0]['currency'], net: line.netAmount, cost: comparable ? line.costAmount : null, pieces, delta: delta.bySize })
      orders.push({
        orderId: line.order.id,
        number: line.order.number,
        status: line.order.status,
        customer: line.order.party.tradeName ?? line.order.party.legalName,
        lineId: line.id,
        seq: line.seq,
        styleId: line.styleId,
        styleCode: line.style.code,
        pieces: pieces.reduce((sum, piece) => sum + piece.quantity, 0),
        currency,
        net: asMoney('price', line.netAmount),
        costBefore: asMoney('cost', line.costAmount),
        costAfter: asMoney('cost', comparable ? effect.costAfter : null),
        marginBefore: asMoney('margin', effect.marginBefore),
        marginAfter: asMoney('margin', comparable ? effect.marginAfter : null),
        marginMove: asMoney('margin', comparable ? effect.marginMove : null),
      })
    }
  }

  const materialViews = materials.map((material, index) => ({
    itemId: material.id,
    code: material.code,
    name: material.name,
    baseUom: material.baseUom,
    currency: material.currency,
    priceNow: asMoney('cost', material.standardCost),
    newPrice: asMoney('cost', decimalText(changes[index]!.newPrice)),
    changePct: asMoney('cost', priceChangePct(material.standardCost, changes[index]!.newPrice)),
    version: material.version,
  }))
  const counts = {
    series: seriesViews.length,
    recomputed: series.filter((entry) => entry.state === 'RECOMPUTED').length,
    incomplete: series.filter((entry) => entry.state === 'INCOMPLETE').length,
    seasonClosed: series.filter((entry) => entry.state === 'SEASON_CLOSED').length,
    listEntries: priceLists.length,
    orderLines: orders.length,
  }
  // The hash: what the person saw, figures included (every grain: the same hash for every viewer of the same facts).
  const hash = createHash('sha256')
    .update(
      stableJson({
        changes: changes.map((change) => ({ itemId: change.itemId, newPrice: decimalText(change.newPrice) })),
        materials: materials.map((material) => ({ id: material.id, version: material.version, price: material.standardCost })),
        series: series.map((entry) => ({ sheetId: entry.sheet.id, version: entry.sheet.version, state: entry.state, sizes: [...(deltas.get(entry.sheet.key)?.bySize ?? new Map())] })),
        priceLists: entries.map((entry) => ({ id: entry.id, version: entry.version, price: text(entry.unitPrice) })),
        orders: orders.map((line) => ({ lineId: line.lineId, cost: line.costBefore, net: line.net })),
      }),
    )
    .digest('hex')
  const recompute = counts.recomputed + counts.incomplete
  return {
    materials,
    series,
    view: {
      on,
      materials: materialViews,
      series: seriesViews,
      withoutSheet,
      priceLists,
      orders,
      counts,
      truncated: entries.length > MASS_LIMITS.documents || orderTruncated,
      previewHash: hash,
      words: `Applying sets ${materials.length} new standard price${materials.length === 1 ? '' : 's'} and makes a new draft version of ${recompute} cost sheet series (approved and frozen versions and posted costs do not change; each draft is sent for its yes as usual).`,
      computedAt: toUtcIso(now),
    },
  }
}
