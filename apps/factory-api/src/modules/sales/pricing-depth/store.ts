import type { Prisma } from '@nexus/factory-db'
import { InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import type { ProductType } from '@nexus/factory-domain/product/styles/rules'
import { listPriceText } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { pctText, type BreakRow, type MinimumAction, type MinimumPer, type MinimumRule, type SurchargeRow } from '@nexus/factory-domain/sales/pricing-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { dayText, readListFor, VERSION_COLUMNS, type ListRow, type ListVersionRow } from '../pricelists/store'
import type { Reader } from '../quotes/store'

/**
 * Price lists in depth (B-W2b-325), the reads: a version's quantity breaks and size surcharges, the styles' own size
 * surcharges, the minimum order quantities, and the one question a document asks its price list (show the discount?).
 * The columns every read names; the rows as the domain's rules read them (factory-domain sales/pricing-depth/rules); the
 * views the routes answer (prices with the price grain).
 */

export const BREAK_COLUMNS = { id: true, versionId: true, entryId: true, minQuantity: true, unitPrice: true, discountPct: true, version: true } as const satisfies Prisma.PriceBreakSelect
export type BreakRecord = Prisma.PriceBreakGetPayload<{ select: typeof BREAK_COLUMNS }>

export const SURCHARGE_COLUMNS = { id: true, versionId: true, styleId: true, size: true, surchargeAmount: true, currency: true, surchargePct: true, version: true, updatedAt: true } as const satisfies Prisma.SizeSurchargeSelect
export type SurchargeRecord = Prisma.SizeSurchargeGetPayload<{ select: typeof SURCHARGE_COLUMNS }>

export const MINIMUM_COLUMNS = {
  id: true,
  companyId: true,
  priceListId: true,
  styleId: true,
  productType: true,
  itemId: true,
  minQuantity: true,
  per: true,
  action: true,
  surchargeAmount: true,
  currency: true,
  surchargePct: true,
  note: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.MoqRuleSelect
export type MinimumRecord = Prisma.MoqRuleGetPayload<{ select: typeof MINIMUM_COLUMNS }>

const text = (value: Prisma.Decimal | null): string | null => (value === null ? null : listPriceText(value.toString()))
const pct = (value: Prisma.Decimal | null): string | null => (value === null ? null : pctText(value.toString()))

export const invalid = (issues: readonly Issue[], what: string): ValidationError =>
  new ValidationError(issues.length === 1 ? issues[0]!.message : what, issues.map((issue) => ({ path: issue.path.startsWith('body') ? issue.path : `body/${issue.path}`, message: issue.message })))

export const breakRowOf = (row: BreakRecord): BreakRow => ({ id: row.id, entryId: row.entryId, minQuantity: row.minQuantity, unitPrice: text(row.unitPrice), discountPct: pct(row.discountPct) })
export const surchargeRowOf = (row: SurchargeRecord): SurchargeRow => ({ id: row.id, versionId: row.versionId, styleId: row.styleId, size: row.size, amount: text(row.surchargeAmount), currency: row.currency, pct: pct(row.surchargePct) })
export const minimumRuleOf = (row: MinimumRecord): MinimumRule => ({
  id: row.id,
  companyId: row.companyId,
  priceListId: row.priceListId,
  styleId: row.styleId,
  productType: row.productType as ProductType | null,
  itemId: row.itemId,
  minQuantity: row.minQuantity,
  per: row.per as MinimumPer,
  action: row.action as MinimumAction,
  surchargeAmount: text(row.surchargeAmount),
  currency: row.currency,
  surchargePct: pct(row.surchargePct),
  note: row.note,
  status: row.status as 'ACTIVE' | 'ARCHIVED',
})

/** The breaks of versions. */
export const breaksOf = async (db: Reader, versionIds: readonly string[]): Promise<BreakRecord[]> =>
  versionIds.length === 0 ? [] : db.priceBreak.findMany({ where: { versionId: { in: [...versionIds] } }, select: BREAK_COLUMNS, orderBy: [{ minQuantity: 'asc' }, { id: 'asc' }] })

/** The size surcharges of versions and the own surcharges of styles. */
export async function surchargesOf(db: Reader, versionIds: readonly string[], styleIds: readonly string[]): Promise<SurchargeRecord[]> {
  const or: Prisma.SizeSurchargeWhereInput[] = []
  if (versionIds.length > 0) or.push({ versionId: { in: [...versionIds] } })
  if (styleIds.length > 0) or.push({ versionId: null, styleId: { in: [...styleIds] } })
  return or.length === 0 ? [] : db.sizeSurcharge.findMany({ where: { OR: or }, select: SURCHARGE_COLUMNS, orderBy: [{ size: 'asc' }, { id: 'asc' }] })
}

/** The active minimums of a company (and every company's). */
export const activeMinimumsOf = async (db: Reader, companyId: string): Promise<MinimumRecord[]> =>
  db.moqRule.findMany({ where: { status: 'ACTIVE', OR: [{ companyId }, { companyId: null }] }, select: MINIMUM_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })

/**
 * SAL-170: whether a document priced from a list version shows the list price and the discount (the list's
 * showDiscount); true without a list (W1's way). A version the reader cannot see reads true.
 */
export async function discountShownFor(db: Reader, priceListVersionId: string | null): Promise<boolean> {
  if (priceListVersionId === null) return true
  const version = await db.priceListVersion.findUnique({ where: { id: priceListVersionId }, select: { listId: true } })
  const list = version ? await db.priceList.findUnique({ where: { id: version.listId }, select: { showDiscount: true } }) : null
  return list?.showDiscount ?? true
}

/** A version of a list the caller may see (else 404). */
export async function readVersionFor(caller: CommandCaller, listId: string, versionId: string): Promise<{ list: ListRow; version: ListVersionRow }> {
  const list = await readListFor(caller, listId)
  const version = isUuid(versionId) ? await caller.withClient((client) => client.priceListVersion.findUnique({ where: { id: versionId }, select: VERSION_COLUMNS })) : null
  if (!version || version.listId !== listId) throw new NotFoundError('Price list version not found.')
  return { list, version }
}

export const assertListActive = (list: Pick<ListRow, 'status' | 'code'>): void => {
  if (list.status === 'ARCHIVED') throw new InvalidStateError(`${list.code} is archived: reactivate it before changing it.`)
}

export const assertDraft = (version: Pick<ListVersionRow, 'status' | 'revision'>, what: string): void => {
  if (version.status !== 'DRAFT') throw new InvalidStateError(`Version ${version.revision} is active: its ${what} are fixed. Make the next version to change them.`)
}

// ---- the views ---------------------------------------------------------------------------------------------------------

type Label = { readonly code: string; readonly name: string }

async function labelsOf(db: Reader, styleIds: readonly string[], colourwayIds: readonly string[]) {
  const styles = new Map((styleIds.length === 0 ? [] : await db.style.findMany({ where: { id: { in: [...new Set(styleIds)] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  const colourways = new Map((colourwayIds.length === 0 ? [] : await db.colourway.findMany({ where: { id: { in: [...new Set(colourwayIds)] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, { code: row.code, name: row.name }]))
  return { style: (id: string | null): Label | null => (id === null ? null : (styles.get(id) ?? { code: '', name: '' })), colourway: (id: string | null): Label | null => (id === null ? null : (colourways.get(id) ?? { code: '', name: '' })) }
}

export const surchargeViewOf = (row: SurchargeRecord, style: Label | null) => ({
  id: row.id,
  styleId: row.styleId,
  style,
  size: row.size,
  amount: asMoney('price', text(row.surchargeAmount)),
  currency: row.currency,
  pct: asMoney('price', pct(row.surchargePct)),
  version: row.version,
})

/**
 * The record's Breaks & surcharges tab of one version: its quantity breaks (each with the price it lowers), its size
 * surcharges (every style, or one), and the own surcharges of the styles it prices (whatever list prices them: read
 * here, kept per style).
 */
export async function rulesViewOf(db: Reader, list: ListRow, version: ListVersionRow) {
  const breaks = await breaksOf(db, [version.id])
  const surcharges = await surchargesOf(db, [version.id], [])
  const entries = await db.priceListEntry.findMany({ where: { versionId: version.id }, select: { id: true, styleId: true, colourwayId: true, unitPrice: true, validFrom: true, validTo: true } })
  const styleIds = [...new Set(entries.map((entry) => entry.styleId))]
  const own = await surchargesOf(db, [], styleIds)
  const labels = await labelsOf(db, [...styleIds, ...surcharges.flatMap((row) => (row.styleId ? [row.styleId] : []))], entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))
  const entryOf = new Map(entries.map((entry) => [entry.id, entry]))
  return {
    list: { id: list.id, code: list.code, currency: list.currency, showDiscount: list.showDiscount },
    version: { id: version.id, revision: version.revision, status: version.status, version: version.version, updatedAt: toUtcIso(version.updatedAt) },
    breaks: breaks.map((row) => {
      const entry = row.entryId === null ? null : (entryOf.get(row.entryId) ?? null)
      return {
        id: row.id,
        entryId: row.entryId,
        entry: entry
          ? { id: entry.id, styleId: entry.styleId, style: labels.style(entry.styleId)!, colourwayId: entry.colourwayId, colourway: labels.colourway(entry.colourwayId), unitPrice: asMoney('price', text(entry.unitPrice)!), validFrom: dayText(entry.validFrom), validTo: dayText(entry.validTo) }
          : null,
        minQuantity: row.minQuantity,
        unitPrice: asMoney('price', text(row.unitPrice)),
        discountPct: asMoney('price', pct(row.discountPct)),
        version: row.version,
      }
    }),
    sizeSurcharges: surcharges.map((row) => surchargeViewOf(row, labels.style(row.styleId))),
    styleSurcharges: own.map((row) => surchargeViewOf(row, labels.style(row.styleId))),
  }
}

/** A minimum as the routes answer it (its subject and list named). */
export async function minimumViewsOf(db: Reader, rows: readonly MinimumRecord[]) {
  const styles = new Map((await db.style.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.styleId ? [row.styleId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const items = new Map((await db.item.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.itemId ? [row.itemId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  const lists = new Map((await db.priceList.findMany({ where: { id: { in: [...new Set(rows.flatMap((row) => (row.priceListId ? [row.priceListId] : [])))] } }, select: { id: true, code: true, name: true } })).map((row) => [row.id, row]))
  return rows.map((row) => ({
    id: row.id,
    companyId: row.companyId,
    priceListId: row.priceListId,
    priceList: row.priceListId ? (lists.get(row.priceListId) ?? { id: row.priceListId, code: '', name: '' }) : null,
    subject: row.styleId ? ('STYLE' as const) : row.productType ? ('PRODUCT_TYPE' as const) : ('MATERIAL' as const),
    styleId: row.styleId,
    style: row.styleId ? (styles.get(row.styleId) ?? { id: row.styleId, code: '', name: '' }) : null,
    productType: row.productType as ProductType | null,
    itemId: row.itemId,
    item: row.itemId ? (items.get(row.itemId) ?? { id: row.itemId, code: '', name: '' }) : null,
    minQuantity: row.minQuantity,
    per: row.per as MinimumPer,
    action: row.action as MinimumAction,
    surchargeAmount: asMoney('price', text(row.surchargeAmount)),
    currency: row.currency,
    surchargePct: asMoney('price', pct(row.surchargePct)),
    note: row.note,
    status: row.status as 'ACTIVE' | 'ARCHIVED',
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }))
}
