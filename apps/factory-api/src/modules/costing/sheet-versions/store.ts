import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import type { ComponentLine, MissingComponent } from '@nexus/factory-domain/costing/sheet-components/components'
import { splitBySize, type SizeSplit, type SplitLine } from '@nexus/factory-domain/costing/sheet-components/split'
import type { VersionRow } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { pickWeights, weightedCost, type WeightSource } from '@nexus/factory-domain/costing/size-weights/rules'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/bom/store'

/**
 * The cost sheet versions' reads (B-W2b-420): the sheet as the caller may see it, its lines as the components' shape, the
 * version rows of a list (with their base size's and weighted cost, who approved them and the request for their yes), the
 * next version number of a series under its lock, and the size weights a version uses.
 */

export type Reader = FactoryClient | CommandTx

export const SHEET_COLUMNS = {
  id: true,
  key: true,
  sheetVersion: true,
  state: true,
  companyId: true,
  styleId: true,
  revisionId: true,
  seasonId: true,
  basedOnId: true,
  currency: true,
  baseSize: true,
  targetPrice: true,
  targetMarginPct: true,
  sizeCurveId: true,
  sizeWeights: true,
  inputs: true,
  note: true,
  approvalTaskId: true,
  approvedAt: true,
  approvedById: true,
  frozenAt: true,
  frozenById: true,
  frozenReason: true,
  createdAt: true,
  createdById: true,
  version: true,
} as const satisfies Prisma.CostSheetSelect
export type SheetRow = Prisma.CostSheetGetPayload<{ select: typeof SHEET_COLUMNS }>

export const LINE_COLUMNS = { id: true, seq: true, category: true, source: true, sourceRecordType: true, sourceRecordId: true, itemId: true, workCentreKind: true, label: true, size: true, quantity: true, uom: true, unitCost: true, cost: true, pct: true, note: true } as const satisfies Prisma.CostSheetLineSelect
type LineRow = Prisma.CostSheetLineGetPayload<{ select: typeof LINE_COLUMNS }>
export type StoredLine = ComponentLine & { readonly seq: number; readonly id: string }

const text = (value: { toString(): string }): string => decimalText(value.toString())
export const textOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : text(value))

export const storedLine = (row: LineRow): StoredLine => ({
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

/** A line as the routes answer it (the components' shape, with its id). */
export const lineView = (line: StoredLine) => ({
  id: line.id,
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
  unitCost: asMoney('cost', line.unitCost),
  cost: asMoney('cost', line.cost),
  pct: asMoney('cost', line.pct),
  note: line.note,
})

export const splitView = (split: readonly SizeSplit[]) =>
  split.map((size) => ({
    size: size.size,
    categories: size.categories.map((entry) => ({ category: entry.category, amount: asMoney('cost', entry.amount) })),
    knownTotal: asMoney('cost', size.knownTotal),
    total: asMoney('cost', size.total),
    complete: size.complete,
  }))

/** The object at a key of a sheet's inputs, or null. */
export function inputsPart(inputs: Prisma.JsonValue | null, key: string): Record<string, unknown> | null {
  const part = inputs && typeof inputs === 'object' && !Array.isArray(inputs) ? (inputs as Record<string, unknown>)[key] : null
  return part && typeof part === 'object' && !Array.isArray(part) ? (part as Record<string, unknown>) : null
}

/** What the components left out when the version was written (B-W2b-418 keeps it in inputs.components.leftOut). */
export const leftOutOf = (inputs: Prisma.JsonValue | null): MissingComponent[] => {
  const leftOut = inputsPart(inputs, 'components')?.leftOut
  return Array.isArray(leftOut) ? (leftOut as MissingComponent[]) : []
}

/** Whether the version's typed lines were said to cover what was left out (kept in inputs.approval). */
export const coveredByTypedOf = (inputs: Prisma.JsonValue | null): boolean => inputsPart(inputs, 'approval')?.coveredByTyped === true

/** The weights a version keeps (size → weight), or null. */
export function weightsOf(json: Prisma.JsonValue | null): Record<string, string> | null {
  if (!json || typeof json !== 'object' || Array.isArray(json)) return null
  const entries = Object.entries(json as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === 'string')
  return entries.length > 0 ? Object.fromEntries(entries) : null
}

/** Where the version's weights came from (inputs.weights.source), or null. */
export function weightSourceOf(inputs: Prisma.JsonValue | null): WeightSource | null {
  const source = inputsPart(inputs, 'weights')?.source
  return source === 'SEASON' || source === 'EVERY_SEASON' || source === 'SIZE_CURVE' || source === 'NONE' ? source : null
}

/** The sheet as the caller may see it (costing.view over its company), else not found. */
export async function readSheetFor(caller: CommandCaller, sheetId: string): Promise<SheetRow> {
  const context = contextOf(caller)
  const row = isUuid(sheetId) ? await caller.withClient((db) => db.costSheet.findUnique({ where: { id: sheetId }, select: SHEET_COLUMNS })) : null
  if (!row || !can(actorOf(context), COSTING_VIEW, { companyId: row.companyId })) throw new NotFoundError('Cost sheet not found.')
  return row
}

export async function linesOf(db: Reader, sheetId: string): Promise<StoredLine[]> {
  return (await db.costSheetLine.findMany({ where: { costSheetId: sheetId }, select: LINE_COLUMNS, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })).map(storedLine)
}

/** A version's split by size and its costs: the base size's and the weighted cost of the mix it keeps. */
export function costsOf(sheet: Pick<SheetRow, 'baseSize' | 'sizeWeights' | 'inputs'>, lines: readonly SplitLine[], sizes: readonly string[]) {
  const split = splitBySize(lines, sizes, leftOutOf(sheet.inputs))
  const weights = weightsOf(sheet.sizeWeights)
  const weighted = weightedCost(split, weights)
  const base = split.find((entry) => entry.size === sheet.baseSize)?.total ?? null
  return { split, weights, weighted, baseCost: base }
}

/** The next version of a series, under the series' lock (the database refuses only a duplicate number). */
export async function nextVersionOf(tx: CommandTx, tenantId: string, key: string): Promise<number> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cost-sheet-series', ${tenantId}::text, ${key}::text), 0))`
  const last = await tx.costSheet.aggregate({ where: { key }, _max: { sheetVersion: true } })
  return (last._max.sheetVersion ?? 0) + 1
}

/** The series' lock alone (an approval and a freeze of the series wait for each other). */
export async function lockSeries(tx: CommandTx, tenantId: string, key: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.cost-sheet-series', ${tenantId}::text, ${key}::text), 0))`
}

/** The size weights a version of a style uses: the style's own for the season, else for every season, else the curve named. */
export async function weightsFor(db: Reader, style: { readonly id: string; readonly sizes: readonly string[] }, seasonId: string | null, sizeCurveId: string | null) {
  const rows = await db.sizeWeight.findMany({ where: { styleId: style.id, OR: [{ seasonId: null }, ...(seasonId ? [{ seasonId }] : [])] }, select: { seasonId: true, size: true, weight: true } })
  const of = (season: string | null) => {
    const mine = rows.filter((row) => row.seasonId === season)
    return mine.length === 0 ? null : Object.fromEntries(mine.map((row) => [row.size, text(row.weight)]))
  }
  const curve = sizeCurveId ? await db.sizeCurve.findUnique({ where: { id: sizeCurveId }, select: { shares: true } }) : null
  const shares = curve?.shares && typeof curve.shares === 'object' && !Array.isArray(curve.shares) ? (curve.shares as Record<string, string>) : null
  return pickWeights({ season: seasonId ? of(seasonId) : null, everySeason: of(null), curve: shares }, style.sizes)
}

/** The version rows of a list: revision, season, who approved, the request for its yes, the base size's and weighted cost. */
export async function versionRowsOf(db: Reader, sheets: readonly SheetRow[]): Promise<VersionRow[]> {
  if (sheets.length === 0) return []
  const ids = sheets.map((sheet) => sheet.id)
  const [revisions, seasons, styles, lines, tasks] = await Promise.all([
    db.styleRevision.findMany({ where: { id: { in: [...new Set(sheets.map((sheet) => sheet.revisionId))] } }, select: { id: true, revision: true } }),
    db.season.findMany({ where: { id: { in: [...new Set(sheets.flatMap((sheet) => (sheet.seasonId ? [sheet.seasonId] : [])))] } }, select: { id: true, code: true, status: true } }),
    db.style.findMany({ where: { id: { in: [...new Set(sheets.map((sheet) => sheet.styleId))] } }, select: { id: true, sizes: true } }),
    db.costSheetLine.findMany({ where: { costSheetId: { in: ids } }, select: { ...LINE_COLUMNS, costSheetId: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] }),
    db.approvalTask.findMany({ where: { kind: 'COST_SHEET', recordType: 'CostSheet', recordId: { in: ids } }, select: { id: true, recordId: true, status: true, version: true, requestedAt: true }, orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }] }),
  ])
  const approverIds = [...new Set(sheets.flatMap((sheet) => (sheet.approvedById ? [sheet.approvedById] : [])))]
  const users = approverIds.length === 0 ? [] : await db.user.findMany({ where: { id: { in: approverIds } }, select: { id: true, displayName: true } })
  return sheets.map((sheet) => {
    const sizes = styles.find((style) => style.id === sheet.styleId)?.sizes ?? []
    const mine = lines.filter((line) => line.costSheetId === sheet.id).map(storedLine)
    const { weighted, baseCost } = costsOf(sheet, mine, sizes)
    const revision = revisions.find((row) => row.id === sheet.revisionId)
    const season = sheet.seasonId ? (seasons.find((row) => row.id === sheet.seasonId) ?? null) : null
    const task = sheet.approvalTaskId ? (tasks.find((row) => row.id === sheet.approvalTaskId) ?? null) : (tasks.find((row) => row.recordId === sheet.id && row.status === 'PENDING') ?? null)
    const approver = sheet.approvedById ? users.find((user) => user.id === sheet.approvedById) : undefined
    return {
      id: sheet.id,
      key: sheet.key,
      sheetVersion: sheet.sheetVersion,
      state: sheet.state,
      companyId: sheet.companyId,
      styleId: sheet.styleId,
      revision: { id: sheet.revisionId, revision: revision?.revision ?? 0 },
      season: season ? { id: season.id, code: season.code, status: season.status } : null,
      basedOnId: sheet.basedOnId,
      currency: sheet.currency,
      baseSize: sheet.baseSize,
      baseCost: asMoney('cost', baseCost),
      weightedCost: asMoney('cost', weighted.weighted),
      targetPrice: asMoney('price', textOrNull(sheet.targetPrice)),
      targetMarginPct: asMoney('margin', textOrNull(sheet.targetMarginPct)),
      approvedAt: sheet.approvedAt ? toUtcIso(sheet.approvedAt) : null,
      approvedBy: sheet.approvedById ? { id: sheet.approvedById, name: approver?.displayName ?? '' } : null,
      frozenAt: sheet.frozenAt ? toUtcIso(sheet.frozenAt) : null,
      frozenReason: sheet.frozenReason,
      approval: task ? { taskId: task.id, status: task.status, version: task.version } : null,
      createdAt: toUtcIso(sheet.createdAt),
      version: sheet.version,
    }
  })
}
