import { ValidationError } from '@nexus/factory-domain/core/errors'
import { sizeChangeProblems, type SizeChange } from '@nexus/factory-domain/sales/quote-bulk/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import type { CommandCaller, CommandTools } from '../../../core/command'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { officeQuote, readLineRecords, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { gridAnswer, gridFactsOf, labelsOf, namedLines, planChange, previewTarget, refuseProblems, schedulesOf, writeGrid, type PlannedGrid } from './grid'

/**
 * A size run changed in bulk (B-W2b-302; SAL-160; design quote.lines.table "changes to many lines at once … through
 * ReviewChangesModal"): POST /sales/quotes/:quoteId/lines/sizes — quotes.manage. The chosen lines (default: every size-grid
 * line), optionally only some sizes, each size changed by a percent (whole pieces, half up), a fixed number of pieces (never
 * below 0), set to a number, or the empty sizes filled. `preview: true` answers each line's sizes before → after (one review)
 * and writes nothing; without it the same plan is written in ONE command, all or none (409 with every problem in words: a size
 * the colourway does not offer, a line left without a piece, a delivery schedule that would no longer fit — change the schedule
 * first), each line costed again, the version's money refreshed. No price is written (a line's waterfall stays).
 */

export interface BulkSizesInput {
  readonly version: number
  readonly lineIds?: readonly string[] | undefined
  readonly sizes?: readonly string[] | undefined
  readonly change: SizeChange
  readonly preview?: boolean | undefined
}

async function planBulk(db: Reader, current: QuoteRow, version: VersionRow, body: BulkSizesInput): Promise<PlannedGrid[]> {
  assertDraft(version)
  const lines = namedLines(await readLineRecords(db, version.id), body.lineIds)
  const labels = await labelsOf(db, lines)
  const schedules = await schedulesOf(db, lines.map((line) => line.id))
  const planned: PlannedGrid[] = []
  for (const line of lines) {
    const facts = await gridFactsOf(db, current.companyId, line)
    planned.push(planChange(line, labels.get(line.id)!, facts, body.change, body.sizes ?? null, schedules.get(line.id) ?? [], `lines/${line.id}`))
  }
  return planned
}

const answerOf = (planned: readonly PlannedGrid[], preview: boolean) => {
  const changing = planned.filter((entry) => entry.moves.length > 0)
  const held = planned.filter((entry) => entry.problems.length > 0)
  return {
    preview,
    lines: planned.map(gridAnswer),
    counts: { lines: planned.length, changing: changing.length, unchanged: planned.length - changing.length, problems: held.length },
    words: held.length > 0 ? `${held.length} line(s) cannot take the change: nothing is written until each is fixed.` : changing.length === 0 ? 'Nothing changes.' : `${changing.length} line(s) ${preview ? 'would change' : 'changed'}.`,
  }
}

/** POST /sales/quotes/:quoteId/lines/sizes (quotes.manage): see the module comment. */
export async function bulkSizes(caller: CommandCaller, quoteId: string, body: BulkSizesInput, idempotencyKey?: string) {
  const problems = sizeChangeProblems(body.change)
  if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  if (body.preview) {
    return caller.withClient(async (client) => {
      const { current, version } = await previewTarget(client, quote, body.version)
      return answerOf(await planBulk(client, current, version, body), true)
    })
  }
  return onQuote(caller, quote, { name: 'quotes.bulkSizes', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const planned = await planBulk(tools.tx, current, version, body)
    refuseProblems(planned)
    await writePlanned(tools, current, version, planned, 'quotes.bulkSizes', { change: body.change, sizes: body.sizes ?? null })
    return { ...answerOf(planned, false), ...(await detailInCommand(tools, current.id)) }
  })
}

/** The planned grids that change written, costed again, the version's money refreshed, one audit row, an event per line. */
export async function writePlanned(tools: CommandTools, current: QuoteRow, version: VersionRow, planned: readonly PlannedGrid[], action: string, what: Record<string, unknown>): Promise<void> {
  const changing = planned.filter((entry) => entry.moves.length > 0)
  for (const entry of changing) await writeGrid(tools, entry.line, current.partyId, entry.rows)
  if (changing.length > 0) await refreshVersion(tools, current, version, new Set(changing.map((entry) => entry.line.id)))
  tools.audit({
    action,
    recordType: 'Quote',
    recordId: current.id,
    companyId: current.companyId,
    after: { ...what, lines: changing.map((entry) => ({ lineId: entry.line.id, seq: entry.line.seq, before: entry.before, after: entry.after })) },
  })
  for (const entry of changing) tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: entry.line.id } })
}
