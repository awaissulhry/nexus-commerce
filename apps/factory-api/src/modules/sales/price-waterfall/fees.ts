import { DomainError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { feeDescription, feeProblems, FEE_LIMITS, stepPrice } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { QUOTES_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { MAX_QUOTE_LINES, type SalesFeeKind } from '@nexus/factory-domain/sales/quotes/quotes'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import { refreshVersion } from '../quotes/pricing'
import { assertDraft, detailInCommand, onQuote } from '../quotes/quotes'
import { decimal, officeQuote } from '../quotes/store'
import type { QuoteDetail } from '../quotes/views'

/**
 * Development, sample and tooling fees on a quote (B-W2b-330; SAL-181, SAL-317): a FEE line names the style it is for
 * (a colourway of it: the one a goods line of the style on the quote has, else the style's first ACTIVE one), its kind,
 * how many times it is charged and its price (typed: a fee has no list, no waterfall and no cost sheet — its cost is 0,
 * its margin all of its net). No size rows, no options, no schedule, never made by a work order (the database and W1's
 * readers say so); the version's money and rules follow (W1 refreshVersion). W1's DELETE …/lines/:lineId removes one;
 * W1's make-order copies it to the order, where it is invoiced once with the order's first invoice of shipped goods
 * (./fee-invoicing.ts) and never holds back the shipping or the close.
 */

const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)
const invalid = (issues: { path: string; message: string }[]): ValidationError => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The fee cannot be saved.', issues)

/** The style a fee is for, of the quote's company, not archived; and the colourway its line names. */
// B-W2b-302: exported for a quote started from a template (its fee lines, quote-templates/start.ts).
export async function feeTarget(tx: CommandTx, companyId: string, versionId: string, styleId: string, colourwayId: string | null | undefined) {
  const style = isUuid(styleId) ? await tx.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, status: true } }) : null
  if (!style || (style.companyId !== null && style.companyId !== companyId)) throw invalid([{ path: 'body/styleId', message: 'Not a style this company sells.' }])
  if (style.status === 'ARCHIVED') throw invalid([{ path: 'body/styleId', message: `${style.code} is archived: no fee is charged for it.` }])
  if (colourwayId) {
    const colourway = isUuid(colourwayId) ? await tx.colourway.findFirst({ where: { id: colourwayId, styleId: style.id }, select: { id: true, status: true } }) : null
    if (!colourway || colourway.status !== 'ACTIVE') throw invalid([{ path: 'body/colourwayId', message: 'Not an active colourway of this style.' }])
    return { style, colourwayId: colourway.id }
  }
  const onQuoteLine = await tx.quoteLine.findFirst({ where: { versionId, styleId: style.id, kind: { not: 'FEE' } }, orderBy: { seq: 'asc' }, select: { colourwayId: true } })
  const first = onQuoteLine ?? (await tx.colourway.findFirst({ where: { styleId: style.id, status: 'ACTIVE' }, orderBy: [{ code: 'asc' }, { id: 'asc' }], select: { id: true } }).then((row) => (row ? { colourwayId: row.id } : null)))
  if (!first) throw invalid([{ path: 'body/colourwayId', message: `${style.code} has no active colourway: the fee names one.` }])
  return { style, colourwayId: first.colourwayId }
}

const feeAudit = (fee: { seq: number; feeKind: string; styleId: string; colourwayId: string; quantity: number; unitPrice: string; description: string | null; note: string | null }) => ({ ...fee, unitPrice: markMoney('price', fee.unitPrice) })

export interface AddFeeInput {
  readonly version: number
  readonly feeKind: SalesFeeKind
  readonly styleId: string
  readonly colourwayId?: string | null | undefined
  /** Required (optional in the contract's type: the grain filter may drop it). */
  readonly unitPrice?: string | undefined
  readonly quantity?: number | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

/** POST /sales/quotes/:quoteId/fees (quotes.manage): a FEE line on the DRAFT version; its money follows. */
export async function addFee(caller: CommandCaller, quoteId: string, body: AddFeeInput, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  if (body.unitPrice === undefined) throw invalid([{ path: 'body/unitPrice', message: 'Send the price of the fee.' }])
  const problems = feeProblems({ feeKind: body.feeKind, unitPrice: body.unitPrice, quantity: body.quantity })
  if (problems.length > 0) throw invalid(problems)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.addFee', idempotencyKey, input: { quoteId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const lines = await tx.quoteLine.findMany({ where: { versionId: version.id }, select: { seq: true } })
    if (lines.length >= MAX_QUOTE_LINES) throw invalid([{ path: 'body', message: `A quote holds at most ${MAX_QUOTE_LINES} lines.` }])
    const target = await feeTarget(tx, current.companyId, version.id, body.styleId, body.colourwayId)
    const id = newId()
    const seq = Math.max(0, ...lines.map((line) => line.seq)) + 10
    const description = (blankToNull(body.description) ?? feeDescription(body.feeKind, target.style)).slice(0, FEE_LIMITS.description)
    const note = blankToNull(body.note)?.slice(0, FEE_LIMITS.note) ?? null
    const quantity = body.quantity ?? 1
    const unitPrice = stepPrice(body.unitPrice!)
    await tx.quoteLine.create({
      data: { id, versionId: version.id, partyId: current.partyId, seq, kind: 'FEE', feeKind: body.feeKind, styleId: target.style.id, colourwayId: target.colourwayId, description, note, quantity, unitPrice, netAmount: 0, vatRatePct: '0', vatAmount: 0, createdById: actorIdOf(tools) },
      select: { id: true },
    })
    await refreshVersion(tools, current, version, new Set([id]))
    tools.audit({ action: 'quotes.addFee', recordType: 'Quote', recordId: current.id, companyId: current.companyId, after: { lineId: id, ...feeAudit({ seq, feeKind: body.feeKind, styleId: target.style.id, colourwayId: target.colourwayId, quantity, unitPrice, description, note }) } })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'added', lineId: id } })
    return detailInCommand(tools, current.id)
  })
}

export interface EditFeeInput {
  readonly version: number
  readonly feeKind?: SalesFeeKind | undefined
  readonly unitPrice?: string | undefined
  readonly quantity?: number | undefined
  readonly description?: string | null | undefined
  readonly note?: string | null | undefined
}

/** PATCH /sales/quotes/:quoteId/fees/:lineId (quotes.manage): a DRAFT fee's kind, price, times, description or note. */
export async function editFee(caller: CommandCaller, quoteId: string, lineId: string, body: EditFeeInput, idempotencyKey?: string): Promise<{ quote: QuoteDetail }> {
  const problems = feeProblems({ feeKind: body.feeKind, unitPrice: body.unitPrice, quantity: body.quantity })
  if (problems.length > 0) throw invalid(problems)
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  return onQuote(caller, quote, { name: 'quotes.editFee', idempotencyKey, input: { quoteId, lineId, ...body }, version: body.version }, async (tools, current, version) => {
    const { tx } = tools
    assertDraft(version)
    const line = isUuid(lineId)
      ? await tx.quoteLine.findFirst({ where: { id: lineId, versionId: version.id }, select: { id: true, seq: true, kind: true, feeKind: true, styleId: true, colourwayId: true, quantity: true, unitPrice: true, description: true, note: true } })
      : null
    if (!line) throw new NotFoundError('Quote line not found.')
    if (line.kind !== 'FEE' || line.feeKind === null) throw new DomainError('conflict', 'Not a fee: a line of goods is changed with PATCH …/lines/:lineId, or priced with PUT …/lines/:lineId/price.', [{ path: 'lineId', message: 'Not a FEE line.' }])
    const before = { seq: line.seq, feeKind: line.feeKind, styleId: line.styleId, colourwayId: line.colourwayId, quantity: line.quantity, unitPrice: decimal(line.unitPrice)!, description: line.description, note: line.note }
    const after = {
      ...before,
      feeKind: body.feeKind ?? before.feeKind,
      quantity: body.quantity ?? before.quantity,
      unitPrice: body.unitPrice === undefined ? before.unitPrice : stepPrice(body.unitPrice),
      description: body.description === undefined ? before.description : (blankToNull(body.description) ?? before.description),
      note: body.note === undefined ? before.note : (blankToNull(body.note)?.slice(0, FEE_LIMITS.note) ?? null),
    }
    await tx.quoteLine.update({ where: { id: line.id }, data: { feeKind: after.feeKind, quantity: after.quantity, unitPrice: after.unitPrice, description: after.description, note: after.note, version: { increment: 1 } }, select: { id: true } })
    await refreshVersion(tools, current, version, new Set())
    tools.audit({ action: 'quotes.editFee', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { lineId: line.id, ...feeAudit(before) }, after: { lineId: line.id, ...feeAudit(after) } })
    tools.emit({ type: 'quote.lines_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, change: 'changed', lineId: line.id } })
    return detailInCommand(tools, current.id)
  })
}
