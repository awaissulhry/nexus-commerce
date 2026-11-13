import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { scheduleFitProblem } from '@nexus/factory-domain/sales/quote-terms/rules'
import { changeSizes, movesWords, type SizeMove } from '@nexus/factory-domain/sales/quote-bulk/rules'
import { isIssueList, piecesOf, sizeGrid, type SizeInput, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import { StaleVersionError, type CommandTools } from '../../../core/command'
import { lineTarget } from '../quotes/lines'
import { day, readCurrentVersion, readQuote, type LineRecord, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'

/**
 * A quote line's size grid changed many at a time (B-W2b-302; SAL-160, SAL-269): the checks W1's PATCH …/lines/:lineId makes on
 * a grid (sizes of the style's range that the colourway offers as ACTIVE SKUs, whole pieces, at least one; B-W1-21 sizeGrid)
 * and B-W2b-294's (the line's delivery schedule still fits: scheduleFitProblem), then the grid written as W1 writes it (the
 * size rows replaced, a size kept keeps its own price, the line's pieces) and the line costed again by the caller's refresh.
 * Price columns are never written here: a line's waterfall (B-W2b-330) stays.
 */

/** A line as the bulk answers name it ("10 · SEED-JKT-01 BLK"). */
export interface LineLabel {
  readonly lineId: string
  readonly seq: number
  readonly label: string
}

export interface GridProblem {
  /** GRID: a size or pieces the line cannot take; SCHEDULE: its delivery schedule would not fit; EMPTY: no piece left; LINE: the line cannot change. */
  readonly code: 'GRID' | 'SCHEDULE' | 'EMPTY' | 'LINE'
  readonly path: string
  readonly message: string
}

export interface PlannedGrid {
  readonly line: LineRecord
  readonly label: LineLabel
  readonly before: Record<string, number>
  readonly after: Record<string, number>
  readonly rows: SizeRow[]
  readonly moves: SizeMove[]
  readonly problems: GridProblem[]
}

export const sizesRecord = (sizes: readonly { readonly size: string; readonly quantity: number }[]): Record<string, number> => Object.fromEntries(sizes.map((row) => [row.size, row.quantity]))

/** The quote and its current version as a preview reads them: the version guard checked (a stale preview is refused). */
export async function previewTarget(db: Reader, quote: QuoteRow, sentVersion: number): Promise<{ current: QuoteRow; version: VersionRow }> {
  const current = (await readQuote(db, quote.id))!
  if (current.version !== sentVersion) throw new StaleVersionError('Quote', current.id, current.version, sentVersion)
  return { current, version: await readCurrentVersion(db, current) }
}

/** The style and colourway codes of lines, for their labels. */
export async function labelsOf(db: Reader, lines: readonly LineRecord[]): Promise<Map<string, LineLabel>> {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const colourways = new Map((await db.colourway.findMany({ where: { id: { in: [...new Set(lines.map((line) => line.colourwayId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return new Map(lines.map((line) => [line.id, { lineId: line.id, seq: line.seq, label: `${line.seq} · ${styles.get(line.styleId) ?? '?'} ${colourways.get(line.colourwayId) ?? '?'}` }]))
}

/** The delivery schedules of lines (B-W2b-294's QuoteLineDelivery), per line. */
export async function schedulesOf(db: Reader, lineIds: readonly string[]): Promise<Map<string, { deliveryDate: string; sizeQuantities: Record<string, number> | null }[]>> {
  const rows = lineIds.length === 0 ? [] : await db.quoteLineDelivery.findMany({ where: { lineId: { in: [...lineIds] } }, select: { lineId: true, deliveryDate: true, sizeQuantities: true }, orderBy: [{ deliveryDate: 'asc' }, { id: 'asc' }] })
  const out = new Map<string, { deliveryDate: string; sizeQuantities: Record<string, number> | null }[]>()
  for (const row of rows) {
    const sizes = row.sizeQuantities && typeof row.sizeQuantities === 'object' && !Array.isArray(row.sizeQuantities) ? Object.fromEntries(Object.entries(row.sizeQuantities as Record<string, unknown>).filter((entry): entry is [string, number] => typeof entry[1] === 'number')) : null
    out.set(row.lineId, [...(out.get(row.lineId) ?? []), { deliveryDate: day(row.deliveryDate)!, sizeQuantities: sizes }])
  }
  return out
}

/** The sizes a line may take now: its style's range that its colourway offers (W1 lineTarget), or why it cannot change. */
export async function gridFactsOf(db: Reader, companyId: string, line: LineRecord): Promise<{ range: readonly string[]; offered: string[]; offeredSet: ReadonlySet<string>; baseSize: string | null; sizeScaleId: string } | { problem: string }> {
  try {
    const target = await lineTarget(db, companyId, { styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: undefined }, line.styleRevisionId, 'body')
    const style = await db.style.findUniqueOrThrow({ where: { id: line.styleId }, select: { baseSize: true, sizeScaleId: true } })
    return { range: target.grid.range, offered: target.grid.range.filter((size) => target.grid.offered.has(size)), offeredSet: target.grid.offered, baseSize: style.baseSize, sizeScaleId: style.sizeScaleId }
  } catch (error) {
    if (error instanceof ValidationError) return { problem: error.message }
    throw error
  }
}

/**
 * A line's next grid checked: `quantities` the pieces per size wanted (a size at 0 leaves), the line's own size prices kept for
 * the sizes that stay; problems as words at `path`.
 */
export function planGrid(line: LineRecord, label: LineLabel, facts: Awaited<ReturnType<typeof gridFactsOf>>, quantities: readonly { readonly size: string; readonly quantity: number }[], deliveries: readonly { deliveryDate: string; sizeQuantities: Record<string, number> | null }[], path: string): PlannedGrid {
  const before = sizesRecord(line.sizes)
  const wanted = sizesRecord(quantities.filter((row) => row.quantity > 0))
  const sizeIds = [...new Set([...Object.keys(before), ...Object.keys(wanted)])]
  const range = 'problem' in facts ? [] : facts.range
  const rank = (size: string) => (range.includes(size) ? range.indexOf(size) : Number.MAX_SAFE_INTEGER)
  const moves = sizeIds.filter((size) => (before[size] ?? 0) !== (wanted[size] ?? 0)).map((size) => ({ size, from: before[size] ?? 0, to: wanted[size] ?? 0 })).sort((a, b) => rank(a.size) - rank(b.size))
  if ('problem' in facts) return { line, label, before, after: wanted, rows: [], moves, problems: [{ code: 'LINE', path, message: `Line ${line.seq}: ${facts.problem}` }] }
  const priceOf = new Map(line.sizes.map((row) => [row.size, row.unitPrice]))
  const input: SizeInput[] = Object.entries(wanted).map(([size, quantity]) => ({ size, quantity, unitPrice: priceOf.get(size) ?? null }))
  if (input.length === 0) return { line, label, before, after: wanted, rows: [], moves, problems: [{ code: 'EMPTY', path, message: `Line ${line.seq}: the change would leave it without a piece: remove the line instead.` }] }
  const grid = sizeGrid(input, { range: facts.range, offered: facts.offeredSet }, path)
  if (isIssueList(grid)) return { line, label, before, after: wanted, rows: [], moves, problems: grid.map((issue: Issue) => ({ code: 'GRID' as const, path: issue.path, message: `Line ${line.seq}: ${issue.message}` })) }
  const schedule = scheduleFitProblem(line, grid, deliveries)
  return { line, label, before, after: sizesRecord(grid), rows: grid, moves, problems: schedule ? [{ code: 'SCHEDULE', path, message: schedule }] : [] }
}

/** A line's sizes after a bulk change (PERCENT, DELTA, SET, FILL_EMPTY) planned and checked. */
export function planChange(line: LineRecord, label: LineLabel, facts: Awaited<ReturnType<typeof gridFactsOf>>, change: Parameters<typeof changeSizes>[2], only: readonly string[] | null, deliveries: Parameters<typeof planGrid>[4], path: string): PlannedGrid {
  const offered = 'problem' in facts ? [] : facts.offered
  const { after } = changeSizes(line.sizes, offered, change, only)
  return planGrid(line, label, facts, after, deliveries, path)
}

/** The answer of a planned line (no money: pieces only). */
export const gridAnswer = (planned: PlannedGrid) => ({
  lineId: planned.line.id,
  seq: planned.line.seq,
  label: planned.label.label,
  before: planned.before,
  after: planned.after,
  moves: planned.moves,
  pieces: { before: piecesOf(planned.line.sizes), after: Object.values(planned.after).reduce((total, pieces) => total + pieces, 0) },
  problems: planned.problems,
  words: planned.problems.length > 0 ? planned.problems.map((problem) => problem.message).join(' ') : movesWords(planned.moves),
})

/** Every problem of the planned lines as one refusal (409 in words, each at `lines/<lineId>/…`), or nothing. */
export function refuseProblems(planned: readonly PlannedGrid[]): void {
  const problems = planned.flatMap((entry) => entry.problems)
  if (problems.length === 0) return
  throw new DomainError('conflict', problems.length === 1 ? problems[0]!.message : `${problems.length} problems: ${problems.map((problem) => problem.message).join(' ')}`, problems.map((problem) => ({ path: problem.path, message: problem.message })))
}

/** A line's grid written as W1 writes it: the size rows replaced, its pieces, its version; costed again by the caller's refresh. */
export async function writeGrid(tools: CommandTools, line: { readonly id: string }, partyId: string, rows: readonly SizeRow[]): Promise<void> {
  const { tx } = tools
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.quoteLineSize.deleteMany({ where: { lineId: line.id } })
  await tx.quoteLineSize.createMany({ data: rows.map((row) => ({ id: newId(), lineId: line.id, partyId, size: row.size, quantity: row.quantity, unitPrice: row.unitPrice, createdById: actorId })) })
  await tx.quoteLine.update({ where: { id: line.id }, data: { quantity: piecesOf(rows), version: { increment: 1 } } satisfies Prisma.QuoteLineUpdateInput, select: { id: true } })
}

/** The lines named (each a size-grid line of the version, once), or every size-grid line; 404 / 400 in words. */
export function namedLines(lines: readonly LineRecord[], lineIds: readonly string[] | undefined, at = 'body/lineIds'): LineRecord[] {
  if (lineIds === undefined) {
    const goods = lines.filter((line) => line.kind === 'SIZE_GRID')
    if (goods.length === 0) throw new DomainError('conflict', 'The quote has no size-grid line yet: add a style first.', [{ path: at, message: 'No size-grid line.' }])
    return goods
  }
  const issues: Issue[] = []
  const out: LineRecord[] = []
  const seen = new Set<string>()
  lineIds.forEach((lineId, index) => {
    const line = lines.find((entry) => entry.id === lineId)
    if (seen.has(lineId)) issues.push({ path: `${at}/${index}`, message: 'This line is named twice.' })
    else if (!line) issues.push({ path: `${at}/${index}`, message: 'Not a line of the current version.' })
    else if (line.kind !== 'SIZE_GRID') issues.push({ path: `${at}/${index}`, message: `Line ${line.seq} has no size grid (${line.kind === 'FEE' ? 'a fee' : 'made to measure'}).` })
    else out.push(line)
    seen.add(lineId)
  })
  if (issues.length > 0) throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'Some lines cannot be changed.', issues)
  if (out.length === 0) throw new NotFoundError('Quote line not found.')
  return out
}
