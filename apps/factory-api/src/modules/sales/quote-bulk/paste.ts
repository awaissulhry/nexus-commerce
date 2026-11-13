import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { parsePastedSheet, pastedPriceProblem, piecesOfCell, type PastedRow } from '@nexus/factory-domain/sales/quote-bulk/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { MAX_QUOTE_LINES, piecesOf, priceText, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { serverClock } from '../../../core/time'
import { defaultLineDescription } from '../quotes/lines'
import { chainForQuote, keepListVersion, listPriceOf } from '../quotes/list-price'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, assertQuotable, detailInCommand, onQuote } from '../quotes/quotes'
import { officeQuote, quotePartyOf, readLineRecords, type LineRecord, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { gridFactsOf, labelsOf, planGrid, previewTarget, schedulesOf, sizesRecord, writeGrid, type PlannedGrid } from './grid'
// B-W2b-374 (XF3:01): a pasted new line's options.
import type { LinePick } from '@nexus/factory-domain/sales/configurator/rules'
import { checkStyleOptions } from '../../product/options/check'
import { pastedPicks, writePastedPicks } from '../quotes/copy-options'

/**
 * Paste lines from a sheet (B-W2b-302; SAL-160; design quote.lines.composer "Paste lines (W2b)", quote.lines.blocks "paste a
 * block from a spreadsheet (what could not land is counted and said)"): POST /sales/quotes/:quoteId/lines/paste — quotes.manage.
 * The cells copied from a spreadsheet (`text`: a first row naming Style, Colourway, an optional Price and the size codes; tab or
 * ';' between cells), or the same rows already split (`rows`). Each row is a style (its code, of the quote's company or of every
 * company, not archived) in a colourway (its code or name, ACTIVE):
 *
 *   CHANGE  a size-grid line of that style and colourway is on the quote: the pasted sizes take the pasted pieces (0 takes the
 *           size off), its other sizes stay; its price stays (a pasted price is not written on it: prices change with Target
 *           price or Price & margin, so the line's waterfall stays)
 *   ADD     otherwise a new line, as W1's add-line makes one: the pasted pieces, the pasted price or else the customer's list
 *           price (the version keeps the list version), costed from today's sheet
 *   SKIP    nothing of the row can land (an unknown style or colourway, the same style and colourway twice, no valid cell, the
 *           quote full, a delivery schedule a change would break)
 *
 * What cannot land is left out and said, cell by cell (a size the colourway does not offer, a cell that is not whole pieces):
 * the rest of the row lands. `preview: true` answers each row and the counts and writes nothing; without it the same plan is
 * written in ONE command (what lands; 409 in words when nothing does), the lines costed, the version's money refreshed.
 */

export interface PasteRowInput {
  readonly style: string
  readonly colourway: string
  /** Size code → pieces. */
  readonly sizes: Readonly<Record<string, number>>
  readonly unitPrice?: string | null | undefined
  /** B-W2b-374 (XF3:01): a new line's options ("LINER:YES, NAME:NAME=BIANCHI"). */
  readonly options?: string | null | undefined
}

export interface PasteInput {
  readonly version: number
  readonly text?: string | undefined
  readonly rows?: readonly PasteRowInput[] | undefined
  readonly preview?: boolean | undefined
}

interface LeftOut {
  readonly size: string | null
  readonly message: string
}

interface PlannedRow {
  readonly row: number
  readonly style: string
  readonly colourway: string
  readonly action: 'ADD' | 'CHANGE' | 'SKIP'
  readonly line: LineRecord | null
  readonly grid: PlannedGrid | null
  readonly add: { styleId: string; colourwayId: string; revisionId: string | null; styleCode: string; styleName: string; colourwayName: string; rows: SizeRow[]; unitPrice: string | null; /** B-W2b-374 */ picks: LinePick[] } | null
  readonly landed: Record<string, number>
  readonly leftOut: LeftOut[]
  readonly priceFrom: 'TYPED' | 'LIST' | 'NONE' | 'KEPT' | null
}

/** The rows of the paste: parsed from the text (its shape refused in words), or as sent. */
function rowsOf(body: PasteInput): PastedRow[] {
  if ((body.text === undefined) === (body.rows === undefined)) throw new ValidationError('Paste the cells (text) or send the rows, one of the two.', [{ path: 'body/text', message: 'Send text or rows.' }])
  if (body.rows) return body.rows.map((row, index) => ({ row: index + 1, style: row.style.trim(), colourway: row.colourway.trim(), cells: Object.fromEntries(Object.entries(row.sizes).map(([size, pieces]) => [size.trim(), String(pieces)])), unitPrice: row.unitPrice ?? null, options: row.options ?? null }))
  const sheet = parsePastedSheet(body.text!)
  if (sheet.problems.length > 0) throw new ValidationError(sheet.problems[0]!.message, sheet.problems)
  return sheet.rows
}

async function planPaste(db: Reader, current: QuoteRow, version: VersionRow, rows: readonly PastedRow[], now: Date) {
  assertDraft(version)
  const lines = await readLineRecords(db, version.id)
  const codes = [...new Set(rows.map((row) => row.style).filter(Boolean))]
  const styles = codes.length === 0 ? [] : await db.style.findMany({ where: { code: { in: codes } }, select: { id: true, code: true, name: true, companyId: true, status: true } })
  const colourways = styles.length === 0 ? [] : await db.colourway.findMany({ where: { styleId: { in: styles.map((style) => style.id) } }, select: { id: true, styleId: true, code: true, name: true, status: true } })
  const party = await quotePartyOf(db, current.partyId, businessDate(now), now)
  if (!party) throw new NotFoundError('Customer not found.')
  assertQuotable(party, 'party')
  const chain = await chainForQuote(db, current, version, party, now, styles.map((style) => style.id))
  const labels = await labelsOf(db, lines)
  const schedules = await schedulesOf(db, lines.map((line) => line.id))
  let room = MAX_QUOTE_LINES - lines.length
  const taken = new Map<string, number>()
  const planned: PlannedRow[] = []

  for (const row of rows) {
    const skip = (message: string): void => {
      planned.push({ row: row.row, style: row.style, colourway: row.colourway, action: 'SKIP', line: null, grid: null, add: null, landed: {}, leftOut: [{ size: null, message: `Row ${row.row}: ${message}` }], priceFrom: null })
    }
    const style = styles.find((entry) => entry.code === row.style)
    if (!row.style || !style || (style.companyId !== null && style.companyId !== current.companyId)) {
      skip(row.style ? `${row.style} is not a style this company sells.` : 'no style code.')
      continue
    }
    if (style.status === 'ARCHIVED') {
      skip(`${style.code} is archived: it is not quoted.`)
      continue
    }
    const wanted = row.colourway.toLowerCase()
    const colourway = colourways.find((entry) => entry.styleId === style.id && (entry.code.toLowerCase() === wanted || entry.name.toLowerCase() === wanted))
    if (!colourway || colourway.status !== 'ACTIVE') {
      skip(row.colourway ? `${row.colourway} is not an active colourway of ${style.code}.` : `no colourway for ${style.code}.`)
      continue
    }
    const key = `${style.id}:${colourway.id}`
    if (taken.has(key)) {
      skip(`${style.code} ${colourway.code} is pasted already in row ${taken.get(key)}.`)
      continue
    }
    taken.set(key, row.row)

    // The cells: whole pieces of a size the line can take; the rest left out and said.
    const existing = lines.find((line) => line.kind === 'SIZE_GRID' && line.styleId === style.id && line.colourwayId === colourway.id) ?? null
    const facts = await gridFactsOf(db, current.companyId, existing ?? ({ id: '', seq: 0, styleId: style.id, colourwayId: colourway.id, styleRevisionId: null, sizes: [] } as unknown as LineRecord))
    if ('problem' in facts) {
      skip(facts.problem)
      continue
    }
    const leftOut: LeftOut[] = []
    const cells: { size: string; quantity: number }[] = []
    for (const [size, cell] of Object.entries(row.cells)) {
      const pieces = piecesOfCell(cell)
      if (pieces === null) leftOut.push({ size, message: `Row ${row.row}, size ${size}: "${cell}" is not whole pieces.` })
      else if (!facts.range.includes(size)) leftOut.push({ size, message: `Row ${row.row}: ${size} is not a size of ${style.code} (${facts.range.join(', ')}).` })
      else if (!facts.offeredSet.has(size)) leftOut.push({ size, message: `Row ${row.row}: size ${size} is not offered in ${colourway.code}.` })
      else cells.push({ size, quantity: pieces })
    }

    if (existing) {
      const merged = sizesRecord(existing.sizes)
      for (const cell of cells) merged[cell.size] = cell.quantity
      const grid = planGrid(existing, labels.get(existing.id)!, facts, Object.entries(merged).map(([size, quantity]) => ({ size, quantity })), schedules.get(existing.id) ?? [], `rows/${row.row}`)
      if (cells.length === 0 || grid.problems.length > 0) {
        planned.push({ row: row.row, style: style.code, colourway: colourway.code, action: 'SKIP', line: existing, grid: null, add: null, landed: {}, leftOut: [...leftOut, ...(cells.length === 0 ? [{ size: null, message: `Row ${row.row}: no cell can land.` }] : grid.problems.map((problem) => ({ size: null, message: problem.message })))], priceFrom: null })
        continue
      }
      if (row.unitPrice !== null) leftOut.push({ size: null, message: `Row ${row.row}: the price is not written on a line already on the quote: change it with Target price or Price & margin.` })
      // B-W2b-374: a line already on the quote keeps its options (they change in its Options).
      if (row.options) leftOut.push({ size: null, message: `Row ${row.row}: the options are not written on a line already on the quote: change them in the line's Options.` })
      planned.push({ row: row.row, style: style.code, colourway: colourway.code, action: 'CHANGE', line: existing, grid, add: null, landed: sizesRecord(cells), leftOut, priceFrom: 'KEPT' })
      continue
    }

    const rowsToAdd = cells.filter((cell) => cell.quantity > 0)
    if (rowsToAdd.length === 0) {
      planned.push({ row: row.row, style: style.code, colourway: colourway.code, action: 'SKIP', line: null, grid: null, add: null, landed: {}, leftOut: [...leftOut, { size: null, message: `Row ${row.row}: no piece can land.` }], priceFrom: null })
      continue
    }
    if (room <= 0) {
      skip(`the quote holds at most ${MAX_QUOTE_LINES} lines.`)
      continue
    }
    const priceProblem = pastedPriceProblem(row.unitPrice)
    if (priceProblem) leftOut.push({ size: null, message: `Row ${row.row}: ${priceProblem} The list price is taken instead.` })
    const typed = priceProblem ? null : row.unitPrice
    const listed = listPriceOf(chain, version.taxMode, party, style.id, colourway.id)
    room--
    // B-W2b-374 (XF3:01): the Options cell read as the style's values and checked by its rules (what cannot be read is said).
    const pasted = await pastedPicks(db, style.id, row.row, row.options ?? null)
    for (const message of pasted.problems) leftOut.push({ size: null, message })
    let picks = pasted.picks
    if (picks.length > 0) {
      const check = await checkStyleOptions(db, style.id, picks, { useDefaults: true })
      if (!check.check.ok) {
        leftOut.push({ size: null, message: `Row ${row.row}: the options were left out (${check.check.blocks[0]!.message.en.replace(/\.$/, '')}): choose them in the line's Options.` })
        picks = []
      }
    }
    const revision = await db.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, select: { id: true } })
    const revisionId = revision?.id ?? (await db.styleRevision.findFirst({ where: { styleId: style.id, status: 'DRAFT' }, orderBy: { revision: 'desc' }, select: { id: true } }))?.id ?? null
    planned.push({
      row: row.row,
      style: style.code,
      colourway: colourway.code,
      action: 'ADD',
      line: null,
      grid: null,
      add: { styleId: style.id, colourwayId: colourway.id, revisionId, styleCode: style.code, styleName: style.name, colourwayName: colourway.name, rows: rowsToAdd.sort((a, b) => facts.range.indexOf(a.size) - facts.range.indexOf(b.size)).map((cell) => ({ ...cell, unitPrice: null })), unitPrice: typed, picks },
      landed: sizesRecord(rowsToAdd),
      leftOut,
      priceFrom: typed !== null ? 'TYPED' : listed ? 'LIST' : 'NONE',
    })
  }
  return { planned, chain, party, lines }
}

function answerOf(planned: readonly PlannedRow[], preview: boolean) {
  const count = (action: PlannedRow['action']) => planned.filter((row) => row.action === action).length
  const landed = planned.reduce((total, row) => total + Object.keys(row.landed).length, 0)
  const leftCells = planned.reduce((total, row) => total + row.leftOut.filter((entry) => entry.size !== null).length, 0)
  const parts = [`${count('ADD')} line(s) ${preview ? 'to add' : 'added'}`, `${count('CHANGE')} ${preview ? 'to change' : 'changed'}`, count('SKIP') > 0 ? `${count('SKIP')} row(s) left out` : null, leftCells > 0 ? `${leftCells} cell(s) could not land` : null].filter((part): part is string => part !== null)
  return {
    preview,
    rows: planned.map((row) => ({
      row: row.row,
      style: row.style,
      colourway: row.colourway,
      action: row.action,
      lineId: row.line?.id ?? null,
      sizes: row.landed,
      before: row.grid ? row.grid.before : null,
      after: row.grid ? row.grid.after : row.add ? row.landed : null,
      priceFrom: row.priceFrom,
      // B-W2b-374: the options a new line takes.
      options: row.add?.picks.length ?? 0,
      leftOut: row.leftOut,
      words: row.leftOut.length > 0 ? row.leftOut.map((entry) => entry.message).join(' ') : row.action === 'ADD' ? 'a new line' : 'the line takes the pasted sizes',
    })),
    counts: { rows: planned.length, added: count('ADD'), changed: count('CHANGE'), skipped: count('SKIP'), cellsLanded: landed, cellsLeftOut: leftCells },
    words: parts.join(' · '),
  }
}

/** POST /sales/quotes/:quoteId/lines/paste (quotes.manage): see the module comment. */
export async function pasteLines(caller: CommandCaller, quoteId: string, body: PasteInput, idempotencyKey?: string) {
  const rows = rowsOf(body)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  if (body.preview) {
    return caller.withClient(async (client) => {
      const { current, version } = await previewTarget(client, quote, body.version)
      return answerOf((await planPaste(client, current, version, rows, serverClock.now())).planned, true)
    })
  }
  return onQuote(caller, quote, { name: 'quotes.pasteLines', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const { planned, chain, party, lines } = await planPaste(tools.tx, current, version, rows, tools.now)
    const landing = planned.filter((row) => row.action !== 'SKIP')
    if (landing.length === 0) throw new DomainError('conflict', `Nothing in the paste can land: ${planned.flatMap((row) => row.leftOut.map((entry) => entry.message)).slice(0, 5).join(' ')}`, planned.flatMap((row) => row.leftOut.map((entry) => ({ path: `rows/${row.row}`, message: entry.message }))))
    const recost = new Set<string>()
    let seq = Math.max(0, ...lines.map((line) => line.seq))
    let fromList = false
    // B-W2b-374: the new lines whose pasted options are written once the version keeps its list.
    const withOptions: { row: PlannedRow; lineId: string }[] = []
    for (const row of landing) {
      if (row.action === 'CHANGE') {
        await writeGrid(tools, row.line!, current.partyId, row.grid!.rows)
        recost.add(row.line!.id)
        continue
      }
      const add = row.add!
      const listed = listPriceOf(chain, version.taxMode, party, add.styleId, add.colourwayId)
      fromList ||= listed !== null
      seq += 10
      const id = newId()
      await addLine(tools, current, version, id, seq, add, listed?.onBasis ?? null)
      recost.add(id)
      if (add.picks.length > 0) withOptions.push({ row, lineId: id })
    }
    if (fromList) await keepListVersion(tools, version, chain)
    // B-W2b-374 (XF3:01): each new line's options, written and priced as its configurator would (what fails is said, the line stays).
    for (const entry of withOptions) {
      const problem = await writePastedPicks(tools, current.id, entry.lineId, entry.row.row, entry.row.add!.picks)
      if (problem) {
        entry.row.leftOut.push({ size: null, message: problem })
        entry.row.add!.picks.length = 0
      }
    }
    await refreshVersion(tools, current, version, recost)
    tools.audit({
      action: 'quotes.pasteLines',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      after: { rows: planned.map((row) => ({ row: row.row, style: row.style, colourway: row.colourway, action: row.action, sizes: row.landed, leftOut: row.leftOut.length })) },
    })
    for (const row of landing) if (row.action === 'CHANGE') tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: row.line!.id } })
    for (const id of recost) if (!landing.some((row) => row.line?.id === id)) tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'added', lineId: id } })
    return { ...answerOf(planned, false), ...(await detailInCommand(tools, current.id)) }
  })
}

/** A new line as W1's add-line writes it: the pasted price (the list price beside it), else the list price, else 0 until priced. */
async function addLine(tools: CommandTools, current: QuoteRow, version: VersionRow, id: string, seq: number, add: NonNullable<PlannedRow['add']>, listPrice: string | null): Promise<void> {
  const { tx } = tools
  const actorId = tools.context.audience === 'office' ? tools.context.actorId : null
  await tx.quoteLine.create({
    data: {
      id,
      versionId: version.id,
      partyId: current.partyId,
      seq,
      kind: 'SIZE_GRID',
      styleId: add.styleId,
      styleRevisionId: add.revisionId,
      colourwayId: add.colourwayId,
      description: defaultLineDescription({ code: add.styleCode, name: add.styleName }, { name: add.colourwayName }),
      quantity: piecesOf(add.rows),
      listUnitPrice: listPrice === null ? null : priceText(listPrice),
      unitPrice: priceText(add.unitPrice ?? listPrice ?? '0'),
      netAmount: 0,
      vatRatePct: '0',
      vatAmount: 0,
      createdById: actorId,
    },
    select: { id: true },
  })
  await tx.quoteLineSize.createMany({ data: add.rows.map((row) => ({ id: newId(), lineId: id, partyId: current.partyId, size: row.size, quantity: row.quantity, unitPrice: null, createdById: actorId })) })
}
