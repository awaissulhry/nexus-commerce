import type { Issue } from '@nexus/factory-domain/core/errors'
import { isGoodsLine } from '@nexus/factory-domain/sales/quotes/quotes'
import type { SendCheck } from '@nexus/factory-domain/sales/quotes/send'
import { chainForQuote } from '../quotes/list-price'
import { quotePartyOf, type QuoteParty, type QuoteRow, type Reader, type VersionRow } from '../quotes/store'
import { businessDate } from '@nexus/factory-domain/core/time'
import { runLineChecks, type LineCheckDocument, type LineCheckLine, type LineFinding } from './index'

/**
 * The line rules as quotes and orders run them (./index.ts): a quote version and an order as one LineCheckDocument
 * (company, the price list that prices it, goods lines with their options' materials), and the findings as each caller
 * speaks: the send checks of a quote (BELOW_MINIMUM), the problems of an office order, the screens' read.
 */

interface LineFacts {
  readonly id: string
  readonly seq: number
  readonly kind: string
  readonly styleId: string
  readonly colourwayId: string
  readonly styleRevisionId: string | null
  readonly quantity: number
}

const goods = (lines: readonly LineFacts[], options: ReadonlyMap<string, string[]>): LineCheckLine[] =>
  lines
    .filter((line) => isGoodsLine(line))
    .map((line) => ({ id: line.id, seq: line.seq, styleId: line.styleId, colourwayId: line.colourwayId, styleRevisionId: line.styleRevisionId, quantity: line.quantity, optionItemIds: options.get(line.id) ?? [] }))

/** The list a price list version belongs to, or null. */
const listOfVersion = async (db: Reader, versionId: string | null): Promise<string | null> => (versionId === null ? null : ((await db.priceListVersion.findUnique({ where: { id: versionId }, select: { listId: true } }))?.listId ?? null))

/** A quote version as the rules read it: the list it keeps, else its customer's chain's first list. */
export async function quoteDocumentOf(db: Reader, quote: Pick<QuoteRow, 'companyId'>, version: Pick<VersionRow, 'id' | 'currency' | 'priceListVersionId' | 'createdAt'>, lines: readonly LineFacts[], party: QuoteParty | null, now: Date): Promise<LineCheckDocument> {
  const options = new Map<string, string[]>()
  const chosen = lines.length === 0 ? [] : await db.quoteLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.id) }, itemId: { not: null } }, select: { lineId: true, itemId: true } })
  for (const row of chosen) options.set(row.lineId, [...(options.get(row.lineId) ?? []), row.itemId!])
  let priceListId = await listOfVersion(db, version.priceListVersionId)
  if (priceListId === null && party) priceListId = (await chainForQuote(db, quote, version, party, now)).lists[0]?.id ?? null
  return { kind: 'QUOTE', companyId: quote.companyId, priceListId, currency: version.currency, lines: goods(lines, options) }
}

/** quotes/send.ts: the findings as send checks (code BELOW_MINIMUM; a BLOCKS one stops the send). */
export async function quoteLineChecks(db: Reader, quote: Pick<QuoteRow, 'companyId'>, version: Pick<VersionRow, 'id' | 'currency' | 'priceListVersionId' | 'createdAt'>, lines: readonly LineFacts[], party: QuoteParty | null, now: Date): Promise<SendCheck[]> {
  const findings = await runLineChecks(db, await quoteDocumentOf(db, quote, version, lines, party, now))
  return findings.map((finding) => ({ code: 'BELOW_MINIMUM', severity: finding.severity, path: finding.lineIds[0] ? `lines/${finding.lineIds[0]}` : 'lines', message: finding.message, lineId: finding.lineIds[0] ?? null, size: null }))
}

/** The send checks with the line rules' findings: a BLOCKS one makes the quote not ready; BLOCKS stay first. */
export function withLineChecks(checks: { readonly ready: boolean; readonly checks: SendCheck[] }, extra: readonly SendCheck[]): { ready: boolean; checks: SendCheck[] } {
  if (extra.length === 0) return checks
  const all = [...checks.checks, ...extra]
  return { ready: checks.ready && !extra.some((check) => check.severity === 'BLOCKS'), checks: [...all.filter((check) => check.severity === 'BLOCKS'), ...all.filter((check) => check.severity !== 'BLOCKS')] }
}

/** An order as the rules read it: its quote version's list, else its customer's chain's first list (read today). */
export async function orderDocumentOf(db: Reader, order: { readonly id: string; readonly companyId: string; readonly partyId: string; readonly currency: string; readonly quoteVersionId: string | null }, lines: readonly LineFacts[], now: Date): Promise<LineCheckDocument> {
  const options = new Map<string, string[]>()
  const chosen = lines.length === 0 ? [] : await db.salesOrderLineOption.findMany({ where: { lineId: { in: lines.map((line) => line.id) }, itemId: { not: null } }, select: { lineId: true, itemId: true } })
  for (const row of chosen) options.set(row.lineId, [...(options.get(row.lineId) ?? []), row.itemId!])
  const kept = order.quoteVersionId ? ((await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { priceListVersionId: true } }))?.priceListVersionId ?? null) : null
  let priceListId = await listOfVersion(db, kept)
  if (priceListId === null) {
    const party = await quotePartyOf(db, order.partyId, businessDate(now), now)
    if (party) priceListId = (await chainForQuote(db, { companyId: order.companyId }, { currency: order.currency, priceListVersionId: null }, party, now)).lists[0]?.id ?? null
  }
  return { kind: 'ORDER', companyId: order.companyId, priceListId, currency: order.currency, lines: goods(lines, options) }
}

/**
 * orders/manual.ts: an order typed by the office is refused, in words, below a BLOCK minimum (its lines are drafts:
 * no ids, no options yet). WARNING findings are not problems.
 */
export async function orderLineProblems(db: Reader, document: Omit<LineCheckDocument, 'kind'>): Promise<Issue[]> {
  const findings = await runLineChecks(db, { ...document, kind: 'ORDER' })
  return findings.filter((finding) => finding.severity === 'BLOCKS').map((finding) => ({ path: 'body/lines', message: finding.message }))
}

/** The findings as the screens read them (GET …/line-checks). */
export const findingViewOf = (finding: LineFinding) => ({ check: finding.check, code: finding.code, severity: finding.severity, lineIds: [...finding.lineIds], seqs: [...finding.seqs], message: finding.message, details: finding.details })
