import type { Prisma } from '@nexus/factory-db'
import { Decimal } from 'decimal.js'
import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can } from '@nexus/factory-domain/core/permissions'
import { numbered, type ComponentLine } from '@nexus/factory-domain/costing/sheet-components/components'
import { six } from '@nexus/factory-domain/costing/sheet-components/rules'
import { COSTING_SHEETS_MANAGE } from '@nexus/factory-domain/costing/sheet-components/permissions'
import { compareLines, compareSplits, type CompareCell, type SizeCompare } from '@nexus/factory-domain/costing/sheet-versions/compare'
import type { SaveWhatIfBody, WhatIfBody } from '@nexus/factory-domain/costing/sheet-versions/contracts'
import { VERSION_REFUSAL_WORDS } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { whatIf, whatIfNote, whatIfPctProblem, type WhatIfChange, type WhatIfResultLine } from '@nexus/factory-domain/costing/sheet-versions/what-if'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { contextOf } from '../../product/bom/store'
import { refused, versionRefusalOf } from './refusals'
import { costsOf, linesOf, readSheetFor, SHEET_COLUMNS, textOrNull, versionRowsOf, type Reader, type SheetRow, type StoredLine } from './store'
import { insertVersion, versionRowOf } from './versions'

/**
 * Two versions compared and what-if (B-W2b-420; FIN-014; design style.cost.versions "Compare two versions", "What-if"):
 * reads (costing.view over each version's company), and a what-if saved as a new DRAFT version of the series
 * (costing.sheets.manage; the copied lines with the changes, the version it came from named).
 */

const cellView = (cell: CompareCell) => ({ a: asMoney('cost', cell.a), b: asMoney('cost', cell.b), difference: asMoney('cost', cell.difference) })
const sizesView = (rows: readonly SizeCompare[]) => rows.map((row) => ({ size: row.size, total: cellView(row.total), categories: row.categories.map((entry) => ({ category: entry.category, ...cellView(entry) })) }))
const weightedCell = (a: string | null, b: string | null): CompareCell => ({ a, b, difference: a === null || b === null ? null : six(new Decimal(b).minus(a)) })

/** A what-if line as a new version's line. */
const asLine = (line: WhatIfResultLine): ComponentLine => ({
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
})

/** GET /costing/cost-sheets/compare?a&b — two versions of one style side by side, line by line and per size. */
export async function compareVersions(caller: CommandCaller, query: { readonly a: string; readonly b: string }) {
  if (query.a === query.b) throw refused('SAME_SHEET')
  const a = await readSheetFor(caller, query.a)
  const b = await readSheetFor(caller, query.b)
  if (a.styleId !== b.styleId) throw refused('OTHER_STYLE')
  return caller.withClient(async (db) => {
    const style = await db.style.findUniqueOrThrow({ where: { id: a.styleId }, select: { sizes: true } })
    const [linesA, linesB] = await Promise.all([linesOf(db, a.id), linesOf(db, b.id)])
    const [rowA, rowB] = await versionRowsOf(db, [a, b])
    const costsA = costsOf(a, linesA, style.sizes)
    const costsB = costsOf(b, linesB, style.sizes)
    const comparable = a.currency === b.currency
    const lines = compareLines(linesA, linesB).map((row) => ({
      key: row.key,
      category: row.category,
      label: row.label,
      size: row.size,
      a: row.a ? { ...row.a, unitCost: asMoney('cost', row.a.unitCost), cost: asMoney('cost', row.a.cost), pct: asMoney('cost', row.a.pct) } : null,
      b: row.b ? { ...row.b, unitCost: asMoney('cost', row.b.unitCost), cost: asMoney('cost', row.b.cost), pct: asMoney('cost', row.b.pct) } : null,
      difference: asMoney('cost', comparable ? row.difference : '0'),
      change: row.change,
    }))
    const changed = lines.filter((line) => line.change !== 'SAME').length
    return {
      a: rowA!,
      b: rowB!,
      sizes: [...style.sizes],
      comparable,
      sizesCompared: comparable ? sizesView(compareSplits(costsA.split, costsB.split, style.sizes)) : [],
      lines,
      weighted: cellView(comparable ? weightedCell(costsA.weighted.weighted, costsB.weighted.weighted) : { a: null, b: null, difference: null }),
      words: comparable ? `Version ${b.sheetVersion} against version ${a.sheetVersion}: ${changed === 0 ? 'no line differs' : changed === 1 ? '1 line differs' : `${changed} lines differ`}.` : VERSION_REFUSAL_WORDS.OTHER_CURRENCY,
    }
  })
}

/** The changes checked: each names what it moves (400 in words). */
function checkedChanges(changes: WhatIfBody['changes']): WhatIfChange[] {
  const issues: Issue[] = []
  changes.forEach((change, index) => {
    const at = `body/changes/${index}`
    const problem = whatIfPctProblem(change.pct)
    if (problem) issues.push({ path: `${at}/pct`, message: problem })
    if (change.target === 'CATEGORY' && !change.category) issues.push({ path: `${at}/category`, message: 'Say which category.' })
    if (change.target === 'ITEM' && !change.itemId) issues.push({ path: `${at}/itemId`, message: 'Say which material.' })
    if (change.target === 'LINE' && !change.lineId) issues.push({ path: `${at}/lineId`, message: 'Say which line.' })
  })
  if (issues.length > 0) throw new ValidationError(issues[0]!.message, issues)
  return changes.map((change) => ({ target: change.target, category: change.category ?? null, itemId: change.itemId ?? null, lineId: change.lineId ?? null, pct: change.pct }))
}

/**
 * The materials a freight or duty uplift covers when its line names none (a kind's uplift over several materials): the
 * version's materials of the uplift's kind that have no uplift of their own on the version.
 */
async function coversOf(db: Reader, lines: readonly StoredLine[]): Promise<Map<string, Set<string>>> {
  const upliftLines = lines.filter((line) => line.pct !== null && (line.source === 'UPLIFT' || line.source === 'LANDED_COST') && line.sourceRecordId !== null)
  const open = upliftLines.filter((line) => line.itemId === null)
  if (open.length === 0) return new Map()
  const uplifts = await db.materialCostUplift.findMany({ where: { id: { in: [...new Set(upliftLines.map((line) => line.sourceRecordId!))] } }, select: { id: true, target: true, itemKind: true } })
  const itemIds = [...new Set(lines.flatMap((line) => (line.itemId ? [line.itemId] : [])))]
  const kinds = new Map((itemIds.length === 0 ? [] : await db.item.findMany({ where: { id: { in: itemIds } }, select: { id: true, kind: true } })).map((row) => [row.id, row.kind as string]))
  const ownUplift = new Set(upliftLines.filter((line) => line.itemId !== null && uplifts.find((uplift) => uplift.id === line.sourceRecordId)?.target === 'MATERIAL').map((line) => line.itemId!))
  const covers = new Map<string, Set<string>>()
  for (const line of open) {
    const uplift = uplifts.find((row) => row.id === line.sourceRecordId)
    if (!uplift || uplift.itemKind === null) continue
    covers.set(uplift.id, new Set(itemIds.filter((itemId) => kinds.get(itemId) === uplift.itemKind && !ownUplift.has(itemId))))
  }
  return covers
}

async function whatIfOf(db: Reader, sheet: SheetRow, changes: readonly WhatIfChange[]) {
  const style = await db.style.findUniqueOrThrow({ where: { id: sheet.styleId }, select: { sizes: true } })
  const lines = await linesOf(db, sheet.id)
  const result = whatIf({ lines, sizes: style.sizes, covers: await coversOf(db, lines) }, changes)
  return { style, lines, result }
}

/** POST /costing/cost-sheets/:sheetId/what-if — the version with some costs moved, beside the version (nothing written). */
export async function whatIfPreview(caller: CommandCaller, sheetId: string, body: WhatIfBody) {
  const sheet = await readSheetFor(caller, sheetId)
  const changes = checkedChanges(body.changes)
  return caller.withClient(async (db) => {
    const { style, lines, result } = await whatIfOf(db, sheet, changes)
    const before = costsOf(sheet, lines, style.sizes)
    const after = costsOf(sheet, result.lines, style.sizes)
    const row = (await versionRowsOf(db, [sheet]))[0]!
    const weighted = weightedCell(before.weighted.weighted, after.weighted.weighted)
    const base = compareSplits(before.split, after.split, style.sizes).find((entry) => entry.size === sheet.baseSize)
    return {
      sheet: row,
      sizes: [...style.sizes],
      lines: result.lines.map((line) => ({
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
        fromId: line.fromId,
        before: { unitCost: asMoney('cost', line.before.unitCost), cost: asMoney('cost', line.before.cost), pct: asMoney('cost', line.before.pct) },
        changed: line.changed,
      })),
      sizesCompared: sizesView(compareSplits(before.split, after.split, style.sizes)),
      weighted: cellView(weighted),
      changed: result.changed,
      kept: [...result.kept],
      unmatched: [...result.unmatched],
      words: `${result.changed === 1 ? '1 line moves' : `${result.changed} lines move`}${base?.total.difference ? `; the base size ${sheet.baseSize} by ${base.total.difference}` : ''}. Nothing is saved: save it as a new draft version to keep it.`,
    }
  })
}

/** costing.saveCostSheetWhatIf — POST /costing/cost-sheets/:sheetId/what-if/save: the what-if as a new DRAFT version of the series. */
export async function saveWhatIf(caller: CommandCaller, sheetId: string, body: SaveWhatIfBody, idempotencyKey?: string) {
  const seen = await readSheetFor(caller, sheetId)
  if (!can(actorOf(contextOf(caller)), COSTING_SHEETS_MANAGE, { companyId: seen.companyId })) throw new ForbiddenError()
  const changes = checkedChanges(body.changes)
  if (seen.seasonId) {
    const season = await caller.withClient((db) => db.season.findUnique({ where: { id: seen.seasonId! }, select: { status: true } }))
    if (season?.status !== 'OPEN') throw refused('SEASON_CLOSED')
  }
  const { result } = await command(caller, { name: 'costing.saveCostSheetWhatIf', idempotencyKey, input: { sheetId, ...body } }, async (tools) => {
    const sheet = await tools.tx.costSheet.findUniqueOrThrow({ where: { id: sheetId }, select: SHEET_COLUMNS })
    const { lines, result: moved } = await whatIfOf(tools.tx, sheet, changes)
    const labelOf = (change: WhatIfChange): string =>
      change.target === 'CATEGORY' ? (change.category ?? '').toLowerCase() : (lines.find((line) => (change.target === 'ITEM' ? line.itemId === change.itemId : line.id === change.lineId))?.label ?? change.target.toLowerCase())
    const kept = sheet.inputs && typeof sheet.inputs === 'object' && !Array.isArray(sheet.inputs) ? (sheet.inputs as Record<string, unknown>) : {}
    const id = await insertVersion(
      tools,
      {
        from: sheet,
        companyId: sheet.companyId,
        currency: sheet.currency,
        styleId: sheet.styleId,
        revisionId: sheet.revisionId,
        seasonId: sheet.seasonId,
        baseSize: sheet.baseSize,
        targetPrice: textOrNull(sheet.targetPrice),
        targetMarginPct: textOrNull(sheet.targetMarginPct),
        sizeCurveId: sheet.sizeCurveId,
        note: body.note ?? whatIfNote(changes, labelOf),
        inputs: { ...kept, whatIf: { from: sheet.id, changes: changes as unknown as Prisma.InputJsonArray } },
        lines: numbered(moved.lines.map(asLine)),
      },
      { action: 'costing.saveCostSheetWhatIf', how: 'WHAT_IF' },
    )
    return { sheet: await versionRowOf(tools.tx, id) }
  }).catch((error: unknown) => {
    throw versionRefusalOf(error)
  })
  return result
}
