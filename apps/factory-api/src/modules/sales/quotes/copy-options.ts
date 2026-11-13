import { DomainError, ValidationError } from '@nexus/factory-domain/core/errors'
import type { LinePick } from '@nexus/factory-domain/sales/configurator/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { CommandTools } from '../../../core/command'
import { applyQuoteLinePicks } from '../configurator/line'
import { readCurrentVersion, readLineRecords, readQuote, type Reader } from './store'

/**
 * The line options travel with every copy (B-W2b-374; XF3:01; B-W2b-340's gap: revise and make-order carried them, the
 * copies did not). A new quote line made from another line takes its options AGAIN, as a person saving the same choice in
 * the line's configurator would (configurator/line.ts applyQuoteLinePicks): checked by the style's rules today, the colours
 * and materials still active and of the kind their group takes, the line priced again through B-W2b-330's waterfall (a line
 * copied at its list price starts LIST with the options, each surcharge frozen at today's prices; a price kept as sold is not
 * priced again: it already holds them, and each value keeps the surcharge it was sold with). What no longer passes is left
 * out of the copy, said in words; the line itself is copied.
 *
 *   carryOptionsToCopies   W1's Duplicate (a quote's version → a new quote) and "Copy as new quote" (an order's lines): the
 *                          source lines' options (QuoteLineOption / SalesOrderLineOption) onto the new lines
 *   pastedPicks            B-W2b-302's paste: the Options column of a pasted row ("LINER:YES, NAME:NAME=BIANCHI") read as
 *                          picks of the style's offered values (codes, any letter case); what cannot be read is said
 *
 * A quote template keeps no options (QuoteTemplateLine has no place for them: a schema need, named in the step's notes), so a
 * quote started from a template takes none: its lines show the style's defaults in their configurator, as a new line does.
 */

/** A line of the copy and the line it was made from. */
export interface LineCopy {
  readonly from: { readonly kind: 'QUOTE' | 'ORDER'; readonly lineId: string }
  readonly toLineId: string
  /** The source line's place, as the words say it. */
  readonly seq: number
}

const PICK_COLUMNS = { lineId: true, valueId: true, freeText: true, colourId: true, itemId: true, itemColourId: true, surchargeAmount: true, surchargePct: true } as const
const text = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))

const picksOf = (row: { readonly valueId: string; readonly freeText: string | null; readonly colourId: string | null; readonly itemId: string | null; readonly itemColourId: string | null }): LinePick => ({
  valueId: row.valueId,
  text: row.freeText,
  colourId: row.colourId,
  itemId: row.itemId,
  itemColourId: row.itemColourId,
})

/** The source line's picks and the surcharges they were frozen with. */
interface SourceChoice {
  readonly picks: LinePick[]
  readonly kept: { valueId: string; amount: string | null; pct: string | null }[]
}

async function sourcePicks(db: Reader, copies: readonly LineCopy[]): Promise<Map<string, SourceChoice>> {
  const ofKind = (kind: LineCopy['from']['kind']) => copies.filter((copy) => copy.from.kind === kind).map((copy) => copy.from.lineId)
  const quoteIds = ofKind('QUOTE')
  const orderIds = ofKind('ORDER')
  const order = [{ createdAt: 'asc' as const }, { id: 'asc' as const }]
  const rows = [
    ...(quoteIds.length === 0 ? [] : await db.quoteLineOption.findMany({ where: { lineId: { in: quoteIds } }, select: PICK_COLUMNS, orderBy: order })),
    ...(orderIds.length === 0 ? [] : await db.salesOrderLineOption.findMany({ where: { lineId: { in: orderIds } }, select: PICK_COLUMNS, orderBy: order })),
  ]
  const out = new Map<string, SourceChoice>()
  for (const row of rows) {
    const entry = out.get(row.lineId) ?? { picks: [], kept: [] }
    entry.picks.push(picksOf(row))
    entry.kept.push({ valueId: row.valueId, amount: text(row.surchargeAmount), pct: text(row.surchargePct) })
    out.set(row.lineId, entry)
  }
  return out
}

/** A choice written on a line of the new quote, or why it was left out (English; the quote and the line are written). */
async function applyOrSay(tools: CommandTools, quoteId: string, lineId: string, picks: readonly LinePick[], at: string, kept?: SourceChoice['kept']): Promise<{ readonly written: number } | { readonly problem: string }> {
  const current = (await readQuote(tools.tx, quoteId))!
  const version = await readCurrentVersion(tools.tx, current)
  const line = (await readLineRecords(tools.tx, version.id)).find((entry) => entry.id === lineId)
  if (!line) return { problem: 'the line is not on the quote' }
  try {
    const { rows } = await applyQuoteLinePicks(tools, current, version, line, picks, at, kept)
    return { written: rows.length }
  } catch (error) {
    // Every refusal of applyQuoteLinePicks comes before its first write: the transaction goes on.
    if (error instanceof DomainError || error instanceof ValidationError) return { problem: error.message.replace(/\.$/, '') }
    throw error
  }
}

/**
 * The source lines' options onto the copy's lines (inside the copy's command, after its lines are written, before its money is
 * refreshed). Returns the options written and the lines whose options were left out, in words.
 */
export async function carryOptionsToCopies(tools: CommandTools, quoteId: string, copies: readonly LineCopy[]): Promise<{ readonly options: number; readonly leftOut: readonly { readonly seq: number; readonly reason: string }[] }> {
  if (copies.length === 0) return { options: 0, leftOut: [] }
  const picks = await sourcePicks(tools.tx, copies)
  let options = 0
  const leftOut: { seq: number; reason: string }[] = []
  for (const copy of copies) {
    const chosen = picks.get(copy.from.lineId)
    if (!chosen || chosen.picks.length === 0) continue
    const outcome = await applyOrSay(tools, quoteId, copy.toLineId, chosen.picks, `lines/${copy.seq}/options`, chosen.kept)
    if ('written' in outcome) options += outcome.written
    else leftOut.push({ seq: copy.seq, reason: `Its options were not copied (${outcome.problem}): choose them again in the line's Options.` })
  }
  return { options, leftOut }
}

/** The options of a pasted new line written (paste.ts, inside its command), or why they were left out (words). */
export async function writePastedPicks(tools: CommandTools, quoteId: string, lineId: string, row: number, picks: readonly LinePick[]): Promise<string | null> {
  if (picks.length === 0) return null
  const outcome = await applyOrSay(tools, quoteId, lineId, picks, `rows/${row}/options`)
  return 'written' in outcome ? null : `Row ${row}: the options were left out (${outcome.problem}): choose them in the line's Options.`
}

// ---- the paste's Options column ------------------------------------------------------------------------------------------

/** One option of a pasted cell: a group code (or none: a value code the style offers once), a value code, a typed text. */
export interface PastedOption {
  readonly group: string | null
  readonly value: string
  readonly text: string | null
}

/** "LINER:YES, PERF:FRONT, NAME:NAME=BIANCHI" (or "YES" when the style offers that value code once) → the options, in order. */
export function pastedOptionsOf(cell: string | null): PastedOption[] {
  if (cell === null || cell.trim() === '') return []
  return cell
    .split(/[,|]/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const at = part.indexOf('=')
      const head = (at < 0 ? part : part.slice(0, at)).trim()
      const text = at < 0 ? null : part.slice(at + 1).trim() || null
      const colon = head.indexOf(':')
      return colon < 0 ? { group: null, value: head, text } : { group: head.slice(0, colon).trim() || null, value: head.slice(colon + 1).trim(), text }
    })
}

/**
 * The picks of a pasted Options cell for a style: each option found among the values of the groups the style offers (ACTIVE
 * offers and values; codes in any letter case). What cannot be read is said (English, by row).
 */
export async function pastedPicks(db: Reader, styleId: string, row: number, cell: string | null): Promise<{ readonly picks: LinePick[]; readonly problems: string[] }> {
  const wanted = pastedOptionsOf(cell)
  if (wanted.length === 0) return { picks: [], problems: [] }
  const offers = await db.styleOptionGroup.findMany({ where: { styleId, status: 'ACTIVE' }, select: { groupId: true } })
  const groups = offers.length === 0 ? [] : await db.optionGroup.findMany({ where: { id: { in: offers.map((offer) => offer.groupId) }, status: 'ACTIVE' }, select: { id: true, code: true } })
  const values = groups.length === 0 ? [] : await db.optionValue.findMany({ where: { groupId: { in: groups.map((group) => group.id) }, status: 'ACTIVE' }, select: { id: true, groupId: true, code: true } })
  const codeOf = new Map(groups.map((group) => [group.id, group.code.toLowerCase()]))
  const picks: LinePick[] = []
  const problems: string[] = []
  for (const option of wanted) {
    const named = `${option.group ? `${option.group}:` : ''}${option.value}`
    const found = values.filter((value) => value.code.toLowerCase() === option.value.toLowerCase() && (option.group === null || codeOf.get(value.groupId) === option.group.toLowerCase()))
    if (found.length === 0) problems.push(`Row ${row}: option ${named} is not one the style offers.`)
    else if (found.length > 1) problems.push(`Row ${row}: option ${named} is in more than one group: write it as GROUP:VALUE.`)
    else if (picks.some((pick) => pick.valueId === found[0]!.id)) problems.push(`Row ${row}: option ${named} is written twice.`)
    else picks.push({ valueId: found[0]!.id, text: option.text })
  }
  return { picks, problems }
}
