import { newId } from '@nexus/factory-domain/core/ids'
import type { RowIssue } from '@nexus/factory-domain/imports/importer'
import { breaksOf as breaksOfCell, surchargesOf, surchargesRecordValues, versionRecordValues, type PriceRecordValues, type SurchargeText } from '@nexus/factory-domain/sales/pricing-depth/importer'
import { breakProblems, sizeCodeOf, surchargeProblems } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { listPriceText } from '@nexus/factory-domain/sales/pricelists/pricelists'
import type { CommandTools, CommandTx } from '../../../core/command'
import { BREAK_COLUMNS, SURCHARGE_COLUMNS, type BreakRecord, type SurchargeRecord } from '../pricing-depth/store'
import { priceOf } from './store'

/**
 * The price import's version-wide parts (B-W2b-380, XF6:04; SAL-183 with SAL-166 and SAL-180): what B-W2b-325's file left
 * out. The importer (factory-domain sales/pricing-depth/importer) gives a version two more kinds of row besides a price:
 *
 *   the version's own row   style `*`, colourway `*`, first day `-` (record: the draft version): its breaks of every price
 *                           (discounts) and its size surcharges of every style, each cell the whole set
 *   a style's surcharges    the `size surcharges` cell of the style's row with colourway `*` and first day `-`: the draft's
 *                           surcharges of that style as a whole set; when the draft has no such price, a row of only them
 *                           (record: the style)
 *
 * The adapter (pricing-depth/importer.ts) loads, checks and writes them with these helpers in its own command and locks
 * (the list's row first); the export writes the same rows, so a version exported, edited and imported changes exactly what
 * was edited. A set written that changes nothing writes nothing.
 */

export interface VersionParts {
  /** The drafts' breaks of every price (entryId null). */
  readonly wide: readonly BreakRecord[]
  /** The drafts' size surcharges (every style: styleId null; or one style). */
  readonly surcharges: readonly SurchargeRecord[]
}

/** The version-wide breaks and the size surcharges of these versions. */
export async function versionPartsOf(client: CommandTx, versionIds: readonly string[]): Promise<VersionParts> {
  if (versionIds.length === 0) return { wide: [], surcharges: [] }
  const [wide, surcharges] = [
    await client.priceBreak.findMany({ where: { versionId: { in: [...versionIds] }, entryId: null }, select: BREAK_COLUMNS }),
    await client.sizeSurcharge.findMany({ where: { versionId: { in: [...versionIds] } }, select: SURCHARGE_COLUMNS }),
  ]
  return { wide, surcharges }
}

const breakText = (row: BreakRecord) => ({ minQuantity: row.minQuantity, unitPrice: row.unitPrice === null ? null : priceOf(row.unitPrice), discountPct: row.discountPct === null ? null : row.discountPct.toString() })
const surchargeText = (row: SurchargeRecord): SurchargeText => ({ size: row.size, amount: row.surchargeAmount === null ? null : priceOf(row.surchargeAmount), pct: row.surchargePct === null ? null : row.surchargePct.toString() })

/** The version's surcharges of one style (null: of every style), as the file writes them. */
export const styleSurchargesOf = (parts: VersionParts, versionId: string, styleId: string | null): SurchargeText[] =>
  parts.surcharges.filter((row) => row.versionId === versionId && row.styleId === styleId).map(surchargeText)

/** The styles the version's surcharges name one by one. */
export const surchargedStyleIds = (parts: VersionParts, versionId: string): string[] => [...new Set(parts.surcharges.flatMap((row) => (row.versionId === versionId && row.styleId !== null ? [row.styleId] : [])))]

/** The version's own row as the export writes it and the load reads it. */
export const versionRowValues = (listCode: string, versionId: string, parts: VersionParts): PriceRecordValues =>
  versionRecordValues(listCode, parts.wide.filter((row) => row.versionId === versionId).map(breakText), styleSurchargesOf(parts, versionId, null))

/** A style's row of only its surcharges. */
export const surchargesRowValues = (listCode: string, styleCode: string, versionId: string, styleId: string, parts: VersionParts): PriceRecordValues =>
  surchargesRecordValues(listCode, styleCode, styleSurchargesOf(parts, versionId, styleId))

/** The version's own row's problems: its breaks are discounts (each once, from 2 pieces), its surcharges valid. */
export function versionRowIssues(values: Readonly<Record<string, unknown>>): RowIssue[] {
  const issues: RowIssue[] = []
  if (typeof values.breaks === 'string') {
    const rows = breaksOfCell(values.breaks).map((row) => ({ ...row, entryId: null }))
    if (rows.length > 0) for (const issue of breakProblems(rows, new Map())) issues.push({ column: 'breaks', message: issue.message })
  }
  if (typeof values.sizeSurcharges === 'string') issues.push(...surchargeIssues(values.sizeSurcharges, null))
  return issues
}

/** A surcharges cell's problems; `sizes`: the style's range (a size it does not have is refused), null for every style. */
export function surchargeIssues(text: string, style: { readonly code: string; readonly sizes: readonly string[] } | null): RowIssue[] {
  const rows = surchargesOf(text).map((row) => ({ styleId: style ? 'style' : null, size: row.size, amount: row.amount, pct: row.pct }))
  if (rows.length === 0) return []
  const issues: RowIssue[] = surchargeProblems(rows, false).map((issue) => ({ column: 'sizeSurcharges', message: issue.message }))
  if (style && style.sizes.length > 0) {
    const other = rows.map((row) => sizeCodeOf(row.size)).filter((size) => !style.sizes.includes(size))
    if (other.length > 0) issues.push({ column: 'sizeSurcharges', message: `${other.join(', ')} ${other.length === 1 ? 'is not a size' : 'are not sizes'} of ${style.code} (${style.sizes.join(', ')}).` })
  }
  return issues
}

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The draft's breaks of every price replaced by the cell's set; answers how many rows moved (0: the same set). */
export async function writeWideBreaks(tools: CommandTools, versionId: string, text: string): Promise<number> {
  const { tx, now } = tools
  const before = (await tx.priceBreak.findMany({ where: { versionId, entryId: null }, select: BREAK_COLUMNS })).map(breakText)
  const after = breaksOfCell(text)
  const same = (a: (typeof before)[number], b: (typeof after)[number]) => a.minQuantity === b.minQuantity && (a.discountPct === null ? b.discountPct === null : b.discountPct !== null && Number(a.discountPct) === Number(b.discountPct)) && (a.unitPrice === null ? b.unitPrice === null : b.unitPrice !== null && Number(a.unitPrice) === Number(b.unitPrice))
  if (before.length === after.length && before.every((row) => after.some((next) => same(row, next)))) return 0
  await tx.priceBreak.deleteMany({ where: { versionId, entryId: null } })
  if (after.length > 0) await tx.priceBreak.createMany({ data: after.map((row) => ({ id: newId(), versionId, entryId: null, minQuantity: row.minQuantity, unitPrice: row.unitPrice, discountPct: row.discountPct, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) })) })
  return Math.max(before.length, after.length)
}

/** The draft's surcharges of one style (null: of every style) replaced by the cell's set; answers how many rows moved. */
export async function writeStyleSurcharges(tools: CommandTools, scope: { readonly versionId: string; readonly currency: string; readonly styleId: string | null }, text: string): Promise<number> {
  const { tx, now } = tools
  const existing = await tx.sizeSurcharge.findMany({ where: { versionId: scope.versionId, styleId: scope.styleId }, select: SURCHARGE_COLUMNS })
  const wanted = surchargesOf(text).map((row) => ({ size: sizeCodeOf(row.size), amount: row.amount === null ? null : listPriceText(row.amount), pct: row.pct }))
  let moved = 0
  for (const row of existing) {
    if (wanted.some((next) => next.size === row.size)) continue
    await tx.sizeSurcharge.delete({ where: { id: row.id }, select: { id: true } })
    moved += 1
  }
  for (const next of wanted) {
    const current = existing.find((row) => row.size === next.size)
    const currency = next.amount === null ? null : scope.currency
    if (current) {
      const amount = current.surchargeAmount === null ? null : priceOf(current.surchargeAmount)
      const samePct = current.surchargePct === null ? next.pct === null : next.pct !== null && current.surchargePct.equals(next.pct)
      if (amount === next.amount && current.currency === currency && samePct) continue
      await tx.sizeSurcharge.update({ where: { id: current.id }, data: { surchargeAmount: next.amount, currency, surchargePct: next.pct, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    } else {
      await tx.sizeSurcharge.create({ data: { id: newId(), versionId: scope.versionId, styleId: scope.styleId, size: next.size, surchargeAmount: next.amount, currency, surchargePct: next.pct, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
    }
    moved += 1
  }
  return moved
}
