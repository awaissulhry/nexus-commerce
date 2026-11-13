import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { curveFill, curveWords, packFill, sharesOf, storedShares, type FillResult } from '@nexus/factory-domain/sales/size-curves/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { prepackViewOf, PREPACK_COLUMNS, readColourways, readLines, SCALE_COLUMNS, scaleSizes } from '../../product/prepacks/store'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { officeContextOf, officeQuote, readLineRecords, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { CURVE_COLUMNS } from '../size-curves/curves'
import { gridAnswer, gridFactsOf, labelsOf, namedLines, planGrid, previewTarget, refuseProblems, schedulesOf, type PlannedGrid } from './grid'
import { writePlanned } from './sizes'

/**
 * Fill by curve or by prepack (B-W2b-302; SAL-269; follow-up QT2:01; design quote.lines.blocks "Fill by curve (W2b): pick a
 * saved curve, type the total, sizes stay editable; a curve must total 100 %"): POST /sales/quotes/:quoteId/lines/fill —
 * quotes.manage. One curve (or one prepack) for the lines named (a style block's colour lines), each line its own pieces (or
 * packs). The line's whole grid becomes the fill:
 *
 *   curve    an ACTIVE size curve the caller reads, of the line's style's size scale: whole pieces per size, what rounding
 *            leaves on the style's base size (else the size with the largest share); the curve's sizes the line cannot take
 *            are left out and said, the rest share the pieces
 *   prepack  a USABLE prepack of the line's style (B-W2b-233: ACTIVE, every size in the style's range; the style's own or its
 *            scale's): the pack's pieces per size × the packs; a pack by colourway gives each line its own colourway's pieces
 *            (and the pieces without a colourway); an archived pack is never taken
 *
 * `preview: true` answers each line's sizes before → after and the words of the fill; without it the same plan is written in
 * ONE command, all or none (409 in words, each problem at `lines/<lineId>`): the checks of W1's line edit and B-W2b-294's
 * delivery schedule (a fill that lowers a scheduled size is refused: change the schedule first). No price is written.
 */

export interface FillInput {
  readonly version: number
  readonly curveId?: string | null | undefined
  readonly prepackId?: string | null | undefined
  readonly lines: readonly { readonly lineId: string; readonly pieces?: number | null | undefined; readonly packs?: number | null | undefined }[]
  readonly preview?: boolean | undefined
}

type Source =
  | { readonly kind: 'CURVE'; readonly id: string; readonly name: string; readonly sizeScaleId: string; readonly shares: Record<string, string>; readonly words: string }
  | { readonly kind: 'PREPACK'; readonly id: string; readonly code: string; readonly name: string; readonly sizeScaleId: string; readonly styleId: string | null; readonly status: string; readonly lines: { size: string; colourwayId: string | null; quantity: number }[]; readonly ratio: string }

/** The curve or prepack named, as the caller may read it (404 otherwise; an archived one is refused in words). */
async function sourceOf(db: Reader, caller: CommandCaller, body: FillInput): Promise<Source> {
  if (body.curveId) {
    const row = isUuid(body.curveId) ? await db.sizeCurve.findUnique({ where: { id: body.curveId }, select: CURVE_COLUMNS }) : null
    if (!row || !can(actorOf(officeContextOf(caller)), QUOTES_VIEW, row.companyId ? { companyId: row.companyId } : {})) throw new NotFoundError('Size curve not found.')
    if (row.status !== 'ACTIVE') throw new DomainError('conflict', `The size curve "${row.name}" is archived: restore it, or choose another one.`, [{ path: 'body/curveId', message: 'Archived.' }])
    const sizes = await scaleSizes(db, row.sizeScaleId)
    const shares = sharesOf(storedShares(row.shares), sizes)
    return { kind: 'CURVE', id: row.id, name: row.name, sizeScaleId: row.sizeScaleId, shares, words: curveWords(shares) }
  }
  const row = isUuid(body.prepackId ?? '') ? await db.prepack.findUnique({ where: { id: body.prepackId! }, select: PREPACK_COLUMNS }) : null
  if (!row) throw new NotFoundError('Prepack not found.')
  const scale = await db.sizeScale.findUniqueOrThrow({ where: { id: row.sizeScaleId }, select: SCALE_COLUMNS })
  const order = await scaleSizes(db, scale.id)
  const lines = await readLines(db, [row.id])
  const view = prepackViewOf(row, lines, scale, order, await readColourways(db, row.styleId ? [row.styleId] : []), order)
  if (row.status !== 'ACTIVE') throw new DomainError('conflict', `The prepack ${row.code} is archived: an archived pack is never taken.`, [{ path: 'body/prepackId', message: 'Archived.' }])
  return { kind: 'PREPACK', id: row.id, code: row.code, name: row.name, sizeScaleId: row.sizeScaleId, styleId: row.styleId, status: row.status, lines: view.lines.map((line) => ({ size: line.size, colourwayId: line.colourwayId, quantity: line.quantity })), ratio: view.ratio }
}

async function planFill(db: Reader, caller: CommandCaller, current: QuoteRow, version: VersionRow, body: FillInput): Promise<{ source: Source; planned: (PlannedGrid & { fill: FillResult | null })[] }> {
  assertDraft(version)
  const source = await sourceOf(db, caller, body)
  const all = await readLineRecords(db, version.id)
  const lines = namedLines(all, body.lines.map((entry) => entry.lineId), 'body/lines')
  const labels = await labelsOf(db, lines)
  const schedules = await schedulesOf(db, lines.map((line) => line.id))
  const planned: (PlannedGrid & { fill: FillResult | null })[] = []
  for (const [index, line] of lines.entries()) {
    const entry = body.lines[index]!
    const path = `lines/${line.id}`
    const label = labels.get(line.id)!
    const facts = await gridFactsOf(db, current.companyId, line)
    const refuse = (message: string) => planned.push({ ...planGrid(line, label, facts, line.sizes, [], path), problems: [{ code: 'GRID', path, message: `Line ${line.seq}: ${message}` }], fill: null })
    if ('problem' in facts) {
      planned.push({ ...planGrid(line, label, facts, line.sizes, [], path), fill: null })
      continue
    }
    if (facts.sizeScaleId !== source.sizeScaleId) {
      refuse(`its style is sized on another scale than the ${source.kind === 'CURVE' ? `curve "${source.name}"` : `prepack ${source.code}`}.`)
      continue
    }
    let fill: FillResult | Issue[]
    if (source.kind === 'CURVE') {
      if (entry.pieces === undefined || entry.pieces === null) {
        refuse('type the pieces the curve shares out.')
        continue
      }
      fill = curveFill({ shares: source.shares, total: entry.pieces, offered: facts.offered, baseSize: facts.baseSize }, path)
    } else {
      if (source.styleId !== null && source.styleId !== line.styleId) {
        refuse(`the prepack ${source.code} is another style's.`)
        continue
      }
      if (entry.packs === undefined || entry.packs === null) {
        refuse('type how many packs.')
        continue
      }
      fill = packFill({ lines: source.lines, packs: entry.packs, colourwayId: line.colourwayId, offered: facts.offered }, path)
    }
    if (Array.isArray(fill)) {
      refuse(fill.map((issue) => issue.message).join(' '))
      continue
    }
    planned.push({ ...planGrid(line, label, facts, fill.sizes, schedules.get(line.id) ?? [], path), fill })
  }
  return { source, planned }
}

function answerOf(source: Source, planned: readonly (PlannedGrid & { fill: FillResult | null })[], preview: boolean) {
  const held = planned.filter((entry) => entry.problems.length > 0)
  return {
    preview,
    source: source.kind === 'CURVE' ? { kind: source.kind, id: source.id, name: source.name, words: source.words } : { kind: source.kind, id: source.id, name: `${source.code} ${source.name}`, words: source.ratio },
    lines: planned.map((entry) => ({ ...gridAnswer(entry), fill: entry.fill ? { leftOut: entry.fill.leftOut, remainder: entry.fill.remainder, words: entry.fill.words } : null })),
    counts: { lines: planned.length, changing: planned.filter((entry) => entry.moves.length > 0).length, problems: held.length },
    words: held.length > 0 ? `${held.length} line(s) cannot take the fill: nothing is written until each is fixed.` : `${planned.length} line(s) ${preview ? 'would be filled' : 'filled'} from the ${source.kind === 'CURVE' ? `curve "${source.name}"` : `prepack ${source.code}`}.`,
  }
}

/** POST /sales/quotes/:quoteId/lines/fill (quotes.manage): see the module comment. */
export async function fillLines(caller: CommandCaller, quoteId: string, body: FillInput, idempotencyKey?: string) {
  if (Boolean(body.curveId) === Boolean(body.prepackId)) throw new ValidationError('Fill from one size curve or one prepack.', [{ path: 'body/curveId', message: 'Send curveId or prepackId.' }])
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  if (body.preview) {
    return caller.withClient(async (client) => {
      const { current, version } = await previewTarget(client, quote, body.version)
      const { source, planned } = await planFill(client, caller, current, version, body)
      return answerOf(source, planned, true)
    })
  }
  return onQuote(caller, quote, { name: 'quotes.fillLines', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const { source, planned } = await planFill(tools.tx, caller, current, version, body)
    refuseProblems(planned)
    await writePlanned(tools, current, version, planned, 'quotes.fillLines', { source: source.kind, sourceId: source.id })
    return { ...answerOf(source, planned, false), ...(await detailInCommand(tools, current.id)) }
  })
}
