import { Decimal } from 'decimal.js'
import { minorPlaces, type CurrencyCode } from '@nexus/factory-domain/core/money'
import { marginPctOf } from '@nexus/factory-domain/costing/sheet-versions/rules'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import type { Reader } from './store'

/**
 * The approved version prices are released from (B-W2b-420; Rule 1; follow-up KS3:01 "The suggested price of a line reads the
 * approved cost sheet's target price where one exists (the revision's cost otherwise)"), for the quote lines' pricing
 * (modules/sales/price-waterfall/quote-price.ts): per line, the APPROVED version of the line's style and revision for the
 * quote's company — its season's series first, else the one without a season — that has a target price; null when there is
 * none (the price is then suggested from the revision's cost, as before).
 */

export interface ReleasedTarget {
  readonly sheetId: string
  readonly sheetVersion: number
  /** The target price per garment, in `currency`. */
  readonly targetPrice: string
  readonly targetMarginPct: string | null
  readonly currency: string
}

const text = (value: { toString(): string }): string => decimalText(value.toString())

/** Each line's released target (by line id), for a quote version of a company. */
export async function releasedTargetsFor(db: Reader, input: { readonly companyId: string; readonly versionId: string; readonly lines: readonly { readonly id: string; readonly styleId: string | null; readonly styleRevisionId: string | null }[] }): Promise<Map<string, ReleasedTarget>> {
  const priced = input.lines.filter((line) => line.styleId !== null && line.styleRevisionId !== null)
  if (priced.length === 0) return new Map()
  const version = await db.quoteVersion.findUnique({ where: { id: input.versionId }, select: { seasonId: true } })
  const seasonId = version?.seasonId ?? null
  const sheets = await db.costSheet.findMany({
    where: { companyId: input.companyId, state: 'APPROVED', targetPrice: { not: null }, styleId: { in: [...new Set(priced.map((line) => line.styleId!))] }, OR: [{ seasonId: null }, ...(seasonId ? [{ seasonId }] : [])] },
    select: { id: true, sheetVersion: true, styleId: true, revisionId: true, seasonId: true, targetPrice: true, targetMarginPct: true, currency: true, approvedAt: true },
    orderBy: [{ approvedAt: 'desc' }, { id: 'asc' }],
  })
  const out = new Map<string, ReleasedTarget>()
  for (const line of priced) {
    const mine = sheets.filter((sheet) => sheet.styleId === line.styleId && sheet.revisionId === line.styleRevisionId)
    const sheet = mine.find((row) => seasonId !== null && row.seasonId === seasonId) ?? mine.find((row) => row.seasonId === null)
    if (!sheet || sheet.targetPrice === null) continue
    out.set(line.id, { sheetId: sheet.id, sheetVersion: sheet.sheetVersion, targetPrice: text(sheet.targetPrice), targetMarginPct: sheet.targetMarginPct === null ? null : text(sheet.targetMarginPct), currency: sheet.currency })
  }
  return out
}

/**
 * The suggested price from a released target, in the document's currency (null: another currency, no exchange rate on the
 * sheet): the net at the currency's minor unit (half up), on the document's basis; the margin it earns on the line's cost
 * (else the version's target margin).
 */
export function suggestedFromTarget(target: ReleasedTarget, input: { readonly currency: CurrencyCode; readonly unitCost: string | null; readonly onBasis: (net: string) => string }): { readonly unitPrice: string; readonly netUnitPrice: string; readonly marginPct: string | null } | null {
  if (target.currency !== input.currency) return null
  const net = decimalText(new Decimal(target.targetPrice).toDecimalPlaces(minorPlaces(input.currency), Decimal.ROUND_HALF_UP))
  return { unitPrice: input.onBasis(net), netUnitPrice: net, marginPct: input.unitCost === null ? target.targetMarginPct : marginPctOf(net, input.unitCost) }
}
