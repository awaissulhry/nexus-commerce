import { DomainError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { SALES_MEASUREMENTS_VIEW } from '@nexus/factory-domain/sales/measure-link/permissions'
import type { MtmLineBody, MtmLineEditBody, OutOfChartBody } from '@nexus/factory-domain/sales/mtm/contracts'
import { notStartedProblem } from '@nexus/factory-domain/sales/mtm/rules'
import { QUOTES_MANAGE, QUOTES_VIEW } from '@nexus/factory-domain/sales/quotes/permissions'
import { isIssueList, MAX_QUOTE_LINES, resolvePrice } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { checkUnit } from '../mtm/check'
import { latestOf, profileOf, type ProfileRow } from '../mtm/store'
import { defaultLineDescription, lineTarget } from './lines'
import { chainForQuote, keepListVersion, listPriceOf } from './list-price'
import { refreshVersion } from './pricing'
import { assertDraft, assertQuotable, detailInCommand, onQuote } from './quotes'
import { decimal, officeContextOf, officeQuote, quotePartyOf, readCurrentVersion, readLineRecords, type LineRecord, type QuoteRow, type Reader, type VersionRow } from './store'
import type { QuoteDetail } from './views'

/**
 * A quote's made-to-measure units (B-W2b-358; SAL-276, SAL-300; follow-up MM1:01 "Quotes and orders take a MADE_TO_MEASURE line
 * where the company has started made-to-measure and the style is flagged"; W1's `madeToMeasureLater` lifted here). One unit per
 * line (quantity 1, no size rows: the database's QuoteLine_guard), made to a rider's measurement profile revision of the quote's
 * customer, graded from a base size of the style's range:
 *
 *   POST  /sales/quotes/:quoteId/lines/made-to-measure          quotes.manage (and sales.measurements.view over the customer): a
 *                                                               unit on the DRAFT (W1's POST …/lines with kind MADE_TO_MEASURE
 *                                                               comes here too, without a base size)
 *   PATCH /sales/quotes/:quoteId/lines/:lineId/made-to-measure  quotes.manage: a DRAFT unit's revision (the rider's newest), base
 *                                                               size, colourway, style revision, price, description, note (W1's
 *                                                               PATCH …/lines/:lineId on a unit comes here too)
 *   POST  /sales/quotes/:quoteId/lines/:lineId/out-of-chart     quotes.manage: SAL-276, a size the customer asked that the style's
 *                                                               range does not have becomes a unit after the size-grid line it
 *                                                               was asked on (its style, colourway, revision and price)
 *   GET   /sales/quotes/:quoteId/made-to-measure                quotes.view: the current version's units, each checked (./mtm/check)
 *
 * A unit is refused in words before anything is written (409): made-to-measure not started for the style (factory-domain sales/mtm
 * notStartedProblem: Style.mtmAllowed, the style's template and its rules ON — GATE-MTM, switched off per template; the database's
 * QuoteLine_mtm_style refuses an unflagged style too), a revision that is not the rider's newest, another customer's profile. The
 * base size: the one typed (a size of the style's range), else the one the measures point to (B-W2b-248's base size rule). The
 * price: as W1's size-grid line (the customer's list price unless one is typed). Cost: the base size's cell of the cost sheet
 * (./pricing.ts). Outside the certified range is not refused here: the line rule (modules/sales/mtm/line-check) holds the send and
 * the order. Each write is one command on the Quote: audit, quote.lines_changed.
 */

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The made-to-measure unit cannot be saved.', issues)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The profile named, readable by the caller, of the quote's customer (else refused in words). */
async function profileFor(caller: CommandCaller, quote: QuoteRow, profileId: string, at: string): Promise<ProfileRow> {
  const context = officeContextOf(caller)
  const profile = await caller.withClient((db) => profileOf(db, profileId))
  if (!profile || !can(actorOf(context), SALES_MEASUREMENTS_VIEW, { partyId: profile.partyId })) throw new NotFoundError('Measurement profile not found.')
  if (profile.partyId !== quote.partyId) throw invalid([{ path: at, message: "A measurement profile of the quote's customer (or a rider of its team recorded under it)." }])
  return profile
}

/** The unit's facts checked in the command: made-to-measure started, the newest revision, the base size (typed or suggested). */
async function unitFacts(tx: CommandTx, input: { readonly styleId: string; readonly colourwayId: string; readonly profile: ProfileRow; readonly baseSize: string | null | undefined; readonly seq: number }, at: string) {
  const style = await tx.style.findUnique({ where: { id: input.styleId }, select: { id: true, code: true, mtmAllowed: true, measurementTemplateId: true, sizes: true } })
  if (!style) throw new NotFoundError('Style not found.')
  const template = style.measurementTemplateId ? await tx.measurementTemplate.findUnique({ where: { id: style.measurementTemplateId }, select: { code: true, rulesOn: true } }) : null
  const notStarted = notStartedProblem({ style, template, garmentType: input.profile.garmentType })
  if (notStarted) throw new DomainError('conflict', notStarted, [{ path: `${at}/styleId`, message: notStarted }])
  const latest = (await latestOf(tx, input.profile))!
  if (latest.id !== input.profile.id) {
    const message = `Revision ${input.profile.revision} of ${input.profile.riderName}'s ${input.profile.garmentType} measures is not the newest (revision ${latest.revision} is): use the newest.`
    throw new DomainError('conflict', message, [{ path: `${at}/measurementProfileId`, message }])
  }
  if (input.baseSize && !style.sizes.includes(input.baseSize)) throw invalid([{ path: `${at}/baseSize`, message: `${input.baseSize} is not a size of ${style.code}'s range (${style.sizes.join(', ') || 'none'}).` }])
  let baseSize = input.baseSize ?? null
  if (!baseSize) {
    const answer = await checkUnit(tx, { kind: 'QUOTE', seq: input.seq, styleId: style.id, colourwayId: input.colourwayId, profileId: input.profile.id, baseSize: null, now: serverClock.now() })
    baseSize = answer?.check.baseSize.size ?? null
  }
  return { style, baseSize }
}

const unitAudit = (line: { seq: number; styleId: string; colourwayId: string; styleRevisionId: string | null; measurementProfileId: string; baseSize: string | null; description: string | null; note: string | null; unitPrice: string; listUnitPrice: string | null }) => ({
  kind: 'MADE_TO_MEASURE',
  ...line,
  unitPrice: markMoney('price', line.unitPrice),
  listUnitPrice: markMoney('price', line.listUnitPrice),
})

interface NewUnit {
  readonly styleId: string
  readonly colourwayId: string
  readonly styleRevisionId?: string | null | undefined
  readonly profile: ProfileRow
  readonly baseSize?: string | null | undefined
  readonly unitPrice?: string | null | undefined
  readonly listUnitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
  /** Where it goes: after this seq (the size-grid line of an out-of-chart size); default: the end. */
  readonly after?: number | undefined
  readonly at: string
  readonly audit?: Readonly<Record<string, unknown>> | undefined
}

/** A unit written inside the quote's command (the caller checked the quote and the profile). Returns the new line's id. */
export async function addUnitInCommand(tools: CommandTools, current: QuoteRow, version: VersionRow, unit: NewUnit): Promise<string> {
  const { tx, now } = tools
  assertDraft(version)
  const party = await quotePartyOf(tx, current.partyId, businessDate(now), now)
  if (!party) throw new NotFoundError('Customer not found.')
  assertQuotable(party, 'party')
  const lines = await tx.quoteLine.findMany({ where: { versionId: version.id }, select: { seq: true } })
  if (lines.length >= MAX_QUOTE_LINES) throw invalid([{ path: unit.at, message: `A quote holds at most ${MAX_QUOTE_LINES} lines.` }])
  const taken = new Set(lines.map((line) => line.seq))
  const free = unit.after === undefined ? undefined : [1, 2, 3, 4, 5, 6, 7, 8, 9].map((step) => unit.after! + step).find((seq) => !taken.has(seq))
  const seq = free ?? Math.max(0, ...lines.map((line) => line.seq)) + 10
  const target = await lineTarget(tx, current.companyId, { styleId: unit.styleId, colourwayId: unit.colourwayId, styleRevisionId: unit.styleRevisionId }, null, unit.at)
  const facts = await unitFacts(tx, { styleId: target.style.id, colourwayId: target.colourway.id, profile: unit.profile, baseSize: unit.baseSize, seq }, unit.at)
  const chain = await chainForQuote(tx, current, version, party, now, [target.style.id])
  const listed = listPriceOf(chain, version.taxMode, party, target.style.id, target.colourway.id)
  const fromList = unit.listUnitPrice === undefined && listed !== null
  const price = resolvePrice(
    fromList ? { ...unit, listUnitPrice: listed.onBasis, unitPrice: unit.unitPrice ?? (unit.discountPct === undefined || unit.discountPct === null ? listed.onBasis : undefined) } : unit,
    null,
    unit.at,
  )
  if (isIssueList(price)) throw invalid(price)
  const id = newId()
  const description = blankToNull(unit.description) ?? `${defaultLineDescription(target.style, target.colourway)}, made to measure`
  const note = blankToNull(unit.note)
  await tx.quoteLine.create({
    data: {
      id,
      versionId: version.id,
      partyId: current.partyId,
      seq,
      kind: 'MADE_TO_MEASURE',
      styleId: target.style.id,
      styleRevisionId: target.revisionId,
      colourwayId: target.colourway.id,
      measurementProfileId: unit.profile.id,
      baseSize: facts.baseSize,
      description,
      note,
      quantity: 1,
      listUnitPrice: price.listUnitPrice,
      unitPrice: price.unitPrice,
      netAmount: 0,
      vatRatePct: '0',
      vatAmount: 0,
      createdById: actorIdOf(tools),
    },
    select: { id: true },
  })
  if (fromList) await keepListVersion(tools, version, chain)
  await refreshVersion(tools, current, version, new Set([id]))
  tools.audit({
    action: 'quotes.addLine',
    recordType: 'Quote',
    recordId: current.id,
    companyId: current.companyId,
    after: { lineId: id, ...unitAudit({ seq, styleId: target.style.id, colourwayId: target.colourway.id, styleRevisionId: target.revisionId, measurementProfileId: unit.profile.id, baseSize: facts.baseSize, description, note, ...price }), revision: unit.profile.revision, listVersionId: fromList ? listed.versionId : null, ...(unit.audit ?? {}) },
  })
  tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'added', lineId: id } })
  return id
}

/** POST /sales/quotes/:quoteId/lines/made-to-measure (and W1's POST …/lines with kind MADE_TO_MEASURE). */
export async function addMadeToMeasureLine(caller: CommandCaller, quoteId: string, body: MtmLineBody, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const profile = await profileFor(caller, quote, body.measurementProfileId, 'body/measurementProfileId')
  return onQuote(caller, quote, { name: 'quotes.addMtmLine', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    await addUnitInCommand(tools, current, version, { ...body, profile, at: 'body' })
    return detailInCommand(tools, current.id)
  })
}

async function lineOf(tx: CommandTx, versionId: string, lineId: string): Promise<LineRecord> {
  const line = isUuid(lineId) ? (await readLineRecords(tx, versionId)).find((entry) => entry.id === lineId) : undefined
  if (!line) throw new NotFoundError('Quote line not found.')
  return line
}

/** PATCH /sales/quotes/:quoteId/lines/:lineId/made-to-measure (and W1's PATCH …/lines/:lineId on a unit). */
export async function editMadeToMeasureLine(caller: CommandCaller, quoteId: string, lineId: string, body: MtmLineEditBody, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const profile = body.measurementProfileId ? await profileFor(caller, quote, body.measurementProfileId, 'body/measurementProfileId') : null
  return onQuote(caller, quote, { name: 'quotes.editMtmLine', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const line = await lineOf(tx, version.id, lineId)
    if (line.kind !== 'MADE_TO_MEASURE' || !line.measurementProfileId) throw new InvalidStateError('This line is not a made-to-measure unit: change it as a size-grid line.')
    const was = (await profileOf(tx, line.measurementProfileId))!
    const next = profile ?? was
    if (profile && (profile.riderName !== was.riderName || profile.garmentType !== was.garmentType)) throw invalid([{ path: 'body/measurementProfileId', message: `A revision of ${was.riderName}'s ${was.garmentType} measures: another rider or garment is another unit.` }])
    const target = await lineTarget(tx, current.companyId, { styleId: line.styleId, colourwayId: body.colourwayId ?? line.colourwayId, styleRevisionId: body.styleRevisionId }, line.styleRevisionId, 'body')
    const baseWanted = body.baseSize === undefined ? (profile && profile.id !== was.id ? undefined : line.baseSize) : body.baseSize
    const facts = await unitFacts(tx, { styleId: line.styleId, colourwayId: target.colourway.id, profile: next, baseSize: baseWanted, seq: line.seq }, 'body')
    const before = { unitPrice: decimal(line.unitPrice)!, listUnitPrice: decimal(line.listUnitPrice) }
    const price = resolvePrice(body, before, 'body')
    if (isIssueList(price)) throw invalid(price)
    const description = body.description === undefined ? line.description : (blankToNull(body.description) ?? `${defaultLineDescription(target.style, target.colourway)}, made to measure`)
    const note = body.note === undefined ? line.note : blankToNull(body.note)
    const recost = target.colourway.id !== line.colourwayId || target.revisionId !== line.styleRevisionId || facts.baseSize !== line.baseSize
    await tx.quoteLine.update({
      where: { id: line.id },
      data: { colourwayId: target.colourway.id, styleRevisionId: target.revisionId, measurementProfileId: next.id, baseSize: facts.baseSize, description, note, unitPrice: price.unitPrice, listUnitPrice: price.listUnitPrice, version: { increment: 1 } },
      select: { id: true },
    })
    await refreshVersion(tools, current, version, recost ? new Set([line.id]) : new Set())
    tools.audit({
      action: 'quotes.editLine',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { lineId: line.id, ...unitAudit({ seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: line.styleRevisionId, measurementProfileId: was.id, baseSize: line.baseSize, description: line.description, note: line.note, ...before }) },
      after: { lineId: line.id, ...unitAudit({ seq: line.seq, styleId: line.styleId, colourwayId: target.colourway.id, styleRevisionId: target.revisionId, measurementProfileId: next.id, baseSize: facts.baseSize, description, note, ...price }), revision: next.revision },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
    return detailInCommand(tools, current.id)
  })
}

/** POST /sales/quotes/:quoteId/lines/:lineId/out-of-chart (SAL-276). */
export async function outOfChart(caller: CommandCaller, quoteId: string, lineId: string, body: OutOfChartBody, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const profile = await profileFor(caller, quote, body.measurementProfileId, 'body/measurementProfileId')
  return onQuote(caller, quote, { name: 'quotes.outOfChart', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const line = await lineOf(tx, version.id, lineId)
    if (line.kind !== 'SIZE_GRID') throw new InvalidStateError('An out-of-chart size is asked on a size-grid line.')
    const style = await tx.style.findUnique({ where: { id: line.styleId }, select: { code: true, sizes: true } })
    if (style?.sizes.includes(body.size)) {
      const message = `Size ${body.size} is in ${style.code}'s chart (${style.sizes.join(', ')}): add it to the size grid.`
      throw new DomainError('conflict', message, [{ path: 'body/size', message }])
    }
    await addUnitInCommand(tools, current, version, {
      styleId: line.styleId,
      colourwayId: line.colourwayId,
      styleRevisionId: line.styleRevisionId,
      profile,
      baseSize: body.baseSize,
      unitPrice: decimal(line.unitPrice),
      listUnitPrice: decimal(line.listUnitPrice),
      description: `${line.description ?? style?.code ?? ''} - size ${body.size} out of the chart, made to measure`.trim(),
      note: line.note,
      after: line.seq,
      at: 'body',
      audit: { outOfChart: { size: body.size, fromLineId: line.id, fromSeq: line.seq } },
    })
    return detailInCommand(tools, current.id)
  })
}

/** A line's cost target (./pricing.ts refreshVersion): a unit is costed as one piece of its base size (none: incomplete). */
export const mtmCostTarget = (line: LineRecord): LineRecord =>
  line.kind === 'MADE_TO_MEASURE' ? { ...line, sizes: line.baseSize ? [{ size: line.baseSize, quantity: 1, unitPrice: null }] : [] } : line

/** GET /sales/quotes/:quoteId/made-to-measure */
export async function quoteUnits(caller: CommandCaller, quoteId: string) {
  const quote = await officeQuote(caller, quoteId, QUOTES_VIEW)
  return caller.withClient(async (db) => {
    const version = await readCurrentVersion(db, quote)
    const lines = await db.quoteLine.findMany({ where: { versionId: version.id, kind: 'MADE_TO_MEASURE' }, select: { id: true, seq: true, styleId: true, colourwayId: true, measurementProfileId: true, baseSize: true }, orderBy: [{ seq: 'asc' }, { id: 'asc' }] })
    return { made: { kind: 'QUOTE' as const, id: quote.id, number: version.revision > 1 ? `${quote.number} rev ${version.revision}` : quote.number, status: version.status as string, waitsForReview: false, units: await unitViews(db, 'QUOTE', lines) } }
  })
}

/** The units of a quote version or an order, each checked (the documents' made-to-measure read). */
export async function unitViews(db: Reader, kind: 'QUOTE' | 'ORDER', lines: readonly { id: string; seq: number; styleId: string; colourwayId: string; measurementProfileId: string | null; baseSize: string | null }[]) {
  const out = []
  for (const line of lines) {
    if (!line.measurementProfileId) continue
    const answer = await checkUnit(db, { kind, seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, profileId: line.measurementProfileId, baseSize: line.baseSize, now: serverClock.now() })
    if (!answer) continue
    out.push({
      lineId: line.id,
      seq: line.seq,
      style: { id: answer.style.id, code: answer.style.code },
      colourway: { id: line.colourwayId, code: answer.colourwayCode },
      baseSize: line.baseSize,
      profile: { id: answer.profile.id, riderName: answer.profile.riderName, garmentType: answer.profile.garmentType, revision: answer.profile.revision, latestRevision: answer.profile.latestRevision, review: answer.profile.reviewStatus, takenAt: answer.profile.takenAt.toISOString() },
      verdict: answer.check.verdict,
      suggestedBaseSize: answer.check.baseSize.size,
      insideCertifiedRange: answer.check.insideCertifiedRange,
      findings: answer.findings,
    })
  }
  return out
}
