import { DomainError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { isIssueList, MAX_QUOTE_LINES, piecesOf, resolvePrice, sizeGrid, type SizeInput, type SizeRow } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { refreshVersion } from './pricing'
import { assertDraft, assertQuotable, detailInCommand, onQuote } from './quotes'
import { decimal, officeQuote, quotePartyOf, readLineRecords, type LineRecord } from './store'
import type { QuoteDetail } from './views'

/**
 * A draft quote's lines (B-W1-21; SAL-203, SAL-268; A2 SCR-034 "Style blocks", SCR-035 "Quote line"): a style in one
 * colourway as a size grid (whole pieces per size of the style's range that the colourway offers as an ACTIVE SKU; a
 * size may have its own price), its unit price (or a list price and a discount), its description and note. A line is
 * costed from its style revision's cost sheet when it is added and whenever its colourway, revision or sizes change;
 * any change brings the version's money up to date (pricing.ts refreshVersion). A made-to-measure line is refused for now
 * (Owner Q9: made-to-measure comes later). Each write is one command on the Quote.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** Made-to-measure is deferred (Owner Q9): a 409 that says so. */
export const madeToMeasureLater = (): DomainError =>
  new DomainError('conflict', 'Made-to-measure comes later: quote a size-grid line for now (one style in one colourway with pieces per size).', [{ path: 'body/kind', message: 'MADE_TO_MEASURE is not available yet.' }])

const invalid = (issues: Issue[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The line cannot be saved.', issues)

/** The style, colourway and revision a line names, checked against the quote's company, and the sizes offered. */
async function lineTarget(tx: CommandTx, companyId: string, wanted: { styleId: string; colourwayId: string; styleRevisionId: string | null | undefined }, currentRevisionId: string | null, at: string) {
  const style = isUuid(wanted.styleId) ? await tx.style.findUnique({ where: { id: wanted.styleId }, select: { id: true, code: true, name: true, companyId: true, status: true, sizes: true } }) : null
  if (!style || (style.companyId !== null && style.companyId !== companyId)) throw invalid([{ path: `${at}/styleId`, message: 'Not a style this company sells.' }])
  if (style.status === 'ARCHIVED') throw invalid([{ path: `${at}/styleId`, message: `${style.code} is archived: it is not quoted.` }])
  const colourway = isUuid(wanted.colourwayId) ? await tx.colourway.findFirst({ where: { id: wanted.colourwayId, styleId: style.id }, select: { id: true, name: true, status: true } }) : null
  if (!colourway || colourway.status !== 'ACTIVE') throw invalid([{ path: `${at}/colourwayId`, message: 'Not an active colourway of this style.' }])

  let revisionId: string | null
  if (wanted.styleRevisionId) {
    const revision = isUuid(wanted.styleRevisionId) ? await tx.styleRevision.findUnique({ where: { id: wanted.styleRevisionId }, select: { id: true, styleId: true, status: true } }) : null
    if (!revision || revision.styleId !== style.id) throw invalid([{ path: `${at}/styleRevisionId`, message: 'Not a revision of this style.' }])
    if (revision.status === 'OBSOLETE') throw invalid([{ path: `${at}/styleRevisionId`, message: 'An obsolete revision is not quoted: choose the released one.' }])
    revisionId = revision.id
  } else if (wanted.styleRevisionId === undefined && currentRevisionId !== null) {
    revisionId = currentRevisionId
  } else {
    // The RELEASED revision, else the newest DRAFT (an estimate); none: the line has no cost until the style has one.
    const released = await tx.styleRevision.findFirst({ where: { styleId: style.id, status: 'RELEASED' }, select: { id: true } })
    revisionId = released?.id ?? (await tx.styleRevision.findFirst({ where: { styleId: style.id, status: 'DRAFT' }, orderBy: { revision: 'desc' }, select: { id: true } }))?.id ?? null
  }
  const variants = await tx.variant.findMany({ where: { styleId: style.id, colourwayId: colourway.id, status: 'ACTIVE' }, select: { size: true } })
  return { style, colourway, revisionId, grid: { range: style.sizes, offered: new Set(variants.map((variant) => variant.size)) } }
}

async function lineOf(tx: CommandTx, versionId: string, lineId: string): Promise<LineRecord> {
  const line = (await readLineRecords(tx, versionId)).find((entry) => entry.id === lineId)
  if (!line) throw new NotFoundError('Quote line not found.')
  return line
}

async function writeSizes(tx: CommandTx, line: { id: string; partyId: string }, sizes: readonly SizeRow[], actorId: string | null): Promise<void> {
  await tx.quoteLineSize.deleteMany({ where: { lineId: line.id } })
  await tx.quoteLineSize.createMany({ data: sizes.map((row) => ({ id: newId(), lineId: line.id, partyId: line.partyId, size: row.size, quantity: row.quantity, unitPrice: row.unitPrice, createdById: actorId })) })
}

const lineAudit = (line: { seq: number; styleId: string; colourwayId: string; styleRevisionId: string | null; description: string | null; note: string | null; unitPrice: string; listUnitPrice: string | null; sizes: readonly SizeRow[] }) => ({
  seq: line.seq,
  styleId: line.styleId,
  colourwayId: line.colourwayId,
  styleRevisionId: line.styleRevisionId,
  description: line.description,
  note: line.note,
  unitPrice: markMoney('price', line.unitPrice),
  listUnitPrice: markMoney('price', line.listUnitPrice),
  sizes: markMoney('price', line.sizes.map((row) => ({ ...row }))),
})

export interface LineFields {
  readonly colourwayId?: string | undefined
  readonly styleRevisionId?: string | null | undefined
  readonly sizes?: readonly SizeInput[] | undefined
  readonly unitPrice?: string | null | undefined
  readonly listUnitPrice?: string | null | undefined
  readonly discountPct?: string | null | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

export interface AddLineInput extends LineFields {
  readonly version: number
  readonly kind?: 'SIZE_GRID' | 'MADE_TO_MEASURE' | undefined
  readonly measurementProfileId?: string | null | undefined
  readonly styleId: string
  readonly colourwayId: string
  readonly sizes: readonly SizeInput[]
}

/** quotes.manage: a size-grid line on the DRAFT version, costed and priced; the version's money follows. */
export async function addLine(caller: CommandCaller, quoteId: string, body: AddLineInput, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  if (body.kind === 'MADE_TO_MEASURE' || (body.measurementProfileId !== undefined && body.measurementProfileId !== null)) throw madeToMeasureLater()
  return onQuote(caller, quote, { name: 'quotes.addLine', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx, now } = tools
    assertDraft(version)
    const party = await quotePartyOf(tx, current.partyId, businessDate(now), now)
    if (!party) throw new NotFoundError('Customer not found.')
    assertQuotable(party, 'party')
    const lines = await tx.quoteLine.findMany({ where: { versionId: version.id }, select: { seq: true } })
    if (lines.length >= MAX_QUOTE_LINES) throw invalid([{ path: 'body', message: `A quote holds at most ${MAX_QUOTE_LINES} lines.` }])
    const target = await lineTarget(tx, current.companyId, { styleId: body.styleId, colourwayId: body.colourwayId, styleRevisionId: body.styleRevisionId }, null, 'body')
    const sizes = sizeGrid(body.sizes, target.grid, 'body/sizes')
    const price = resolvePrice(body, null, 'body')
    const issues = [...(isIssueList(sizes) ? sizes : []), ...(isIssueList(price) ? price : [])]
    if (issues.length > 0) throw invalid(issues)
    const grid = sizes as SizeRow[]
    const priced = price as Exclude<typeof price, Issue[]>
    const id = newId()
    const seq = Math.max(0, ...lines.map((line) => line.seq)) + 10
    const description = blankToNull(body.description) ?? `${target.style.code} ${target.style.name} — ${target.colourway.name}`
    const actorId = actorIdOf(tools)
    await tx.quoteLine.create({
      data: {
        id,
        versionId: version.id,
        partyId: current.partyId,
        seq,
        kind: 'SIZE_GRID',
        styleId: target.style.id,
        styleRevisionId: target.revisionId,
        colourwayId: target.colourway.id,
        description,
        note: blankToNull(body.note),
        quantity: piecesOf(grid),
        listUnitPrice: priced.listUnitPrice,
        unitPrice: priced.unitPrice,
        netAmount: 0,
        vatRatePct: '0',
        vatAmount: 0,
        createdById: actorId,
      },
      select: { id: true },
    })
    await writeSizes(tx, { id, partyId: current.partyId }, grid, actorId)
    await refreshVersion(tools, current, version, new Set([id]))
    tools.audit({
      action: 'quotes.addLine',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      after: { lineId: id, ...lineAudit({ seq, styleId: target.style.id, colourwayId: target.colourway.id, styleRevisionId: target.revisionId, description, note: blankToNull(body.note), ...priced, sizes: grid }) },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'added', lineId: id } })
    return detailInCommand(tools, current.id)
  })
}

/**
 * quotes.manage: a DRAFT line's colourway, revision, size grid (the whole grid, as typed: a size at 0 leaves it out),
 * prices, description or note. A new colourway, revision or grid costs the line again.
 */
export async function editLine(caller: CommandCaller, quoteId: string, lineId: string, body: LineFields & { version: number }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.editLine', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const line = await lineOf(tx, version.id, lineId)
    const target = await lineTarget(tx, current.companyId, { styleId: line.styleId, colourwayId: body.colourwayId ?? line.colourwayId, styleRevisionId: body.styleRevisionId }, line.styleRevisionId, 'body')
    const sizes = sizeGrid(body.sizes ?? line.sizes, target.grid, 'body/sizes')
    const before = { unitPrice: decimal(line.unitPrice)!, listUnitPrice: decimal(line.listUnitPrice) }
    const price = resolvePrice(body, before, 'body')
    const issues = [...(isIssueList(sizes) ? sizes : []), ...(isIssueList(price) ? price : [])]
    if (issues.length > 0) throw invalid(issues)
    const grid = sizes as SizeRow[]
    const priced = price as Exclude<typeof price, Issue[]>
    const gridKey = (rows: readonly SizeRow[]) => JSON.stringify([...rows].sort((a, b) => (a.size < b.size ? -1 : a.size > b.size ? 1 : 0)))
    const sameGrid = gridKey(grid) === gridKey(line.sizes)
    const recost = target.colourway.id !== line.colourwayId || target.revisionId !== line.styleRevisionId || !sameGrid
    const description = body.description === undefined ? line.description : (blankToNull(body.description) ?? `${target.style.code} ${target.style.name} — ${target.colourway.name}`)
    const note = body.note === undefined ? line.note : blankToNull(body.note)
    await tx.quoteLine.update({
      where: { id: line.id },
      data: { colourwayId: target.colourway.id, styleRevisionId: target.revisionId, description, note, quantity: piecesOf(grid), unitPrice: priced.unitPrice, listUnitPrice: priced.listUnitPrice, version: { increment: 1 } },
      select: { id: true },
    })
    if (!sameGrid) await writeSizes(tx, { id: line.id, partyId: current.partyId }, grid, actorIdOf(tools))
    await refreshVersion(tools, current, version, recost ? new Set([line.id]) : new Set())
    tools.audit({
      action: 'quotes.editLine',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { lineId: line.id, ...lineAudit({ ...line, ...before }) },
      after: { lineId: line.id, ...lineAudit({ seq: line.seq, styleId: line.styleId, colourwayId: target.colourway.id, styleRevisionId: target.revisionId, description, note, ...priced, sizes: grid }) },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
    return detailInCommand(tools, current.id)
  })
}

/** quotes.manage: removes a DRAFT line and its size grid; the version's money follows. */
export async function removeLine(caller: CommandCaller, quoteId: string, lineId: string, query: { version: number }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.removeLine', idempotencyKey, input: { quoteId, lineId, ...query }, version: query.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const line = await lineOf(tx, version.id, lineId)
    await tx.quoteLineSize.deleteMany({ where: { lineId: line.id } })
    await tx.quoteLine.delete({ where: { id: line.id }, select: { id: true } })
    await refreshVersion(tools, current, version, new Set())
    tools.audit({ action: 'quotes.removeLine', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { lineId: line.id, ...lineAudit({ ...line, unitPrice: decimal(line.unitPrice)!, listUnitPrice: decimal(line.listUnitPrice) }) } })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'removed', lineId: line.id } })
    return detailInCommand(tools, current.id)
  })
}

/**
 * quotes.manage: every line of the DRAFT costed again from today's cost sheets, the VAT decided again from the customer
 * as it is now (its identity, the VIES proof), the totals and the rules checked again.
 */
export async function recompute(caller: CommandCaller, quoteId: string, body: { version: number }, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.recompute', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    assertDraft(version)
    const { priced } = await refreshVersion(tools, current, version, 'all')
    tools.audit({
      action: 'quotes.recompute',
      recordType: 'Quote',
      recordId: current.id,
      companyId: current.companyId,
      before: { netAmount: markMoney('price', version.netAmount), costAmount: markMoney('cost', version.costAmount), marginPct: markMoney('margin', decimal(version.marginPct)) },
      after: { netAmount: markMoney('price', priced.netAmount), costAmount: markMoney('cost', priced.costAmount), marginPct: markMoney('margin', priced.marginPct) },
    })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'recomputed', lineId: null } })
    return detailInCommand(tools, current.id)
  })
}
