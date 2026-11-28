import type { FactoryClient, Prisma } from '@nexus/factory-db'
import type { GateCover, PpeCategory, SizeGateRequest } from '@nexus/factory-domain/compliance/cert-gate/gate'
import { can, holds, NO_ROWS, scopeWhere, type Actor } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { costingCurrency } from '@nexus/factory-domain/costing/inputs'
import { COSTING_VIEW } from '@nexus/factory-domain/costing/permissions'
import { exactCell, prepareSheet, shownCost } from '@nexus/factory-domain/costing/sheet'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { checkedCells, coverageCell, coverageCounts, type CoverageCell } from '@nexus/factory-domain/product/compliance/rules'
import { STYLE_COMPLIANCE_VIEW } from '@nexus/factory-domain/product/compliance/permissions'
import type { MarginSource, RowCost, RowCoverage, StyleFamily, StyleRow } from '@nexus/factory-domain/product/styles/contracts'
// owb-pd1 1.2: the agreed prices and their margin (the price lists' own rules: in force on a day, the price's text, the margin).
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { listPriceText, marginPctOf } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { Dec, type Decimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTx } from '../../../core/command'
import { actorOf, type RequestContext } from '../../../core/context'
import { serverClock } from '../../../core/time'
import { dayOf } from '../../compliance/certificates/certificates'
import { loadCostFacts, type CostingCompany } from '../../costing/store'
import { REVISION_COLUMNS as COST_REVISION_COLUMNS, type RevisionRow } from '../bom/store'
import { todayOf } from '../compliance/read'
import { styleBrandWhere, type StyleRowData } from './store'
import { OPEN_ORDER, orderReach } from './order-reach' // owb-pd1 1.2: the open orders the person may see
// B-W2b-236: the list's thumbnail is the main picture.
import { mainPictureThumbnails } from '../images/main-picture'

/**
 * What a style list row shows beside the style (B-W2b-25; design products.styles `styles.grid` columns Thumbnail,
 * Certificate coverage, Cost per garment, and the phone card "thumbnail, coverage mark, cost"; the B-W2a-37 gap): read
 * for one page of rows, each part only for a caller who may see it over the style's company.
 *
 *   thumbnail  the style's main picture (B-W2b-236: the gallery's one main picture; none without it), with files.read
 *              over the file's company.
 *   coverage   the certificate coverage as the style's Compliance tab counts it (factory-domain product/compliance
 *              `coverageCell`, `checkedCells`, `coverageCounts`: the same gate on the same rows, today in Europe/Rome),
 *              with compliance.certificates.view. B-W2b-283 (FU1:02): with each certificate's base (B-W2b-255), as the
 *              real gates ask it: a brand certificate whose base does not hold covers nothing here either.
 *   cost       what one garment costs on the cost sheet (modules/costing `loadCostFacts`, factory-domain costing/sheet):
 *              the RELEASED revision, else the newest DRAFT (an estimate); the base size, else the range's first; the
 *              lowest and highest of the active colourways whose garment has every input. Only with costing.view AND the
 *              cost grain (the grain filter drops the field for everyone else; it is not even computed for them). A
 *              tenant-wide style is costed for the list's company filter, else for none (the default currency), as the
 *              cost sheet does without a company.
 *
 * Reads only, with the request's client: one query per kind for the page (coverage, pictures), and the cost sheet's
 * reads per costed row.
 *
 * owb-pd1 1.2 (S4 settles 1 and 11; design § 5q list columns "type + family", "orders", "agreed price", "margin"):
 *   typeName     the style's product type profile's name (S4 settle 1: product types are data); null: none.
 *   family       OUR_RANGE (no customer) or FOR_CUSTOMER (`brandPartyId`).
 *   openOrders   the open orders with the style the person reads (./order-reach: orders.view, or orders.view.own and on them);
 *                0 without either right.
 *   agreedRange  the lowest and highest price of the style on the CUSTOMER price lists in force today (ACTIVE list, ACTIVE version
 *                and entry in force on the Europe/Rome day; EUR lists only; the lists pricelists.view reaches), and how many;
 *                marked price (the grain filter drops it), null: none.
 *   marginPct    the margin of the LOWEST agreed price (a share of the price, factory-domain pricelists marginPctOf) on the kept
 *   marginFrom   standard cost: the dearest FROZEN StandardCost in force today of the style's finished items (one per SKU) for
 *                the style's company (KEPT); none kept: the median of the same figure over the other products of its kind — its
 *                type profile, else its product type — that the person may see by brand (KIND, the design's "rough standard of
 *                its kind"). Marked margin (the grain filter drops both, as the price lists' margin); computed only for a caller
 *                with the margin grain, null without costing.view over the style's company, an agreed price or a cost.
 */

type Reader = FactoryClient | CommandTx

export interface RowExtras {
  readonly thumbnail: StyleRow['thumbnail']
  readonly coverage: RowCoverage | null
  readonly cost: StyleRow['cost']
  // owb-pd1 1.2
  readonly typeName: string | null
  readonly family: StyleFamily
  readonly openOrders: number
  readonly agreedRange: StyleRow['agreedRange']
  readonly marginPct: StyleRow['marginPct']
  readonly marginFrom: StyleRow['marginFrom']
}

const NONE = { thumbnail: null, coverage: null, cost: asMoney('cost', null) } as const

// ---- thumbnails ---------------------------------------------------------------------------------------------------------

async function thumbnails(client: Reader, actor: Actor, styleIds: readonly string[]): Promise<Map<string, NonNullable<StyleRow['thumbnail']>>> {
  // B-W2b-236 (SY3:02): the style's main picture, not its oldest image file (modules/product/images/main-picture.ts).
  return mainPictureThumbnails(client, actor, styleIds)
}

// ---- certificate coverage -----------------------------------------------------------------------------------------------

/** The counts of a style's checked cells (the Compliance tab's legend), and the sizes with a gap. */
export function coverageOf(style: { readonly ppeCategory: string; readonly sizes: readonly string[] }, cells: readonly CoverageCell[]): RowCoverage {
  const checked = checkedCells(cells)
  const counts = coverageCounts(checked.map((cell) => ({ ...cell, offered: true })))
  const notCovered = checked.filter((cell) => cell.status === 'NOT_COVERED' || cell.status === 'EXPIRED' || cell.status === 'SUSPENDED')
  const gapSizes = new Set(notCovered.map((cell) => cell.size))
  const required = style.ppeCategory !== 'NOT_PPE'
  return {
    state: !required ? 'NOT_REQUIRED' : checked.length === 0 ? 'NO_CELLS' : notCovered.length === 0 ? 'ALL_COVERED' : 'GAPS',
    cells: checked.length,
    covered: counts.covered,
    notCovered: notCovered.length,
    expiringSoon: counts.expiringSoon,
    sizesNotCovered: style.sizes.filter((size) => gapSizes.has(size)),
  }
}

async function coverages(client: Reader, rows: readonly StyleRowData[], date: BusinessDate): Promise<Map<string, RowCoverage>> {
  const out = new Map<string, RowCoverage>()
  if (rows.length === 0) return out
  const ids = rows.map((row) => row.id)
  // One query per kind for the page, one after another (a transaction runs one query at a time).
  const colourways = await client.colourway.findMany({ where: { styleId: { in: ids } }, select: { id: true, styleId: true, code: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const variants = await client.variant.findMany({ where: { styleId: { in: ids }, status: 'ACTIVE' }, select: { styleId: true, colourwayId: true, size: true } })
  const covers = await client.certificateCoverage.findMany({
    where: { styleId: { in: ids }, status: 'ACTIVE' },
    select: {
      id: true,
      styleId: true,
      colourwayIds: true,
      sizes: true,
      allowsMadeToMeasure: true,
      certificate: {
        select: {
          id: true,
          number: true,
          standard: true,
          ppeClass: true,
          notifiedBodyName: true,
          notifiedBodyNumber: true,
          validFrom: true,
          validTo: true,
          status: true,
          // B-W2b-283 (FU1:02): an own-brand certificate covers only while its base (the factory's certificate) holds, as the gates ask.
          baseCertificate: { select: { number: true, status: true, validFrom: true, validTo: true } },
        },
      },
    },
    orderBy: { id: 'asc' },
  })
  const offered = new Set(variants.map((variant) => `${variant.colourwayId}|${variant.size}`))
  for (const row of rows) {
    const styleCovers: GateCover[] = covers
      .filter((cover) => cover.styleId === row.id)
      .map((cover) => ({
        coverageId: cover.id,
        colourwayIds: cover.colourwayIds,
        sizes: cover.sizes,
        allowsMadeToMeasure: cover.allowsMadeToMeasure,
        certificate: (({ baseCertificate, ...certificate }) => ({
          ...certificate,
          validFrom: dayOf(certificate.validFrom),
          validTo: dayOf(certificate.validTo),
          // B-W2b-283 (FU1:02): the base as modules/compliance/certificates/gate.ts `gateRequestFor` passes it.
          base: baseCertificate ? { number: baseCertificate.number, status: baseCertificate.status, validFrom: dayOf(baseCertificate.validFrom), validTo: dayOf(baseCertificate.validTo) } : null,
        }))(cover.certificate),
      }))
    const own = colourways.filter((colourway) => colourway.styleId === row.id)
    const base = (colourwayId: string, size: string): SizeGateRequest => ({
      style: { id: row.id, code: row.code, ppeCategory: row.ppeCategory as PpeCategory, sizes: row.sizes, mtmAllowed: row.mtmAllowed },
      colourwayId,
      size,
      date,
      covers: styleCovers,
    })
    // Rows = every colourway (archived ones too, as the Compliance tab), columns = the range.
    const cells = own.flatMap((colourway) =>
      row.sizes.map((size) => coverageCell(base(colourway.id, size), { colourwayId: colourway.id, colourwayCode: colourway.code, size, offered: offered.has(`${colourway.id}|${size}`) })),
    )
    out.set(row.id, coverageOf(row, cells))
  }
  return out
}

// ---- cost per garment ---------------------------------------------------------------------------------------------------

async function companiesOf(client: Reader, ids: readonly string[]): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map()
  const rows = await client.company.findMany({ where: { id: { in: [...ids] } }, select: { id: true, currency: true } })
  return new Map(rows.map((row) => [row.id, row.currency]))
}

async function costOf(client: Reader, row: StyleRowData, revision: RevisionRow, company: CostingCompany, now: Date): Promise<RowCost | null> {
  const size = row.baseSize ?? row.sizes[0]
  if (size === undefined) return null
  const { facts, colourways } = await loadCostFacts(client, { id: row.id, code: row.code, name: row.name, companyId: row.companyId, status: row.status, sizes: row.sizes, baseSize: row.baseSize }, revision, company, now)
  if (colourways.length === 0) return null
  const sheet = prepareSheet(facts)
  const cells = colourways.map((colourway) => exactCell(sheet, colourway.id, size))
  const known = cells.filter((cell) => cell.missing.length === 0).map((cell) => cell.knownTotal)
  const sorted = [...known].sort((a, b) => a.comparedTo(b))
  return {
    revision: revision.revision,
    estimate: revision.status !== 'RELEASED',
    size,
    currency: company.currency,
    lowest: sorted.length > 0 ? shownCost(sorted[0]!) : null,
    highest: sorted.length > 0 ? shownCost(sorted.at(-1)!) : null,
    complete: known.length === cells.length,
  }
}

async function costs(client: Reader, actor: Actor, rows: readonly StyleRowData[], listCompanyId: string | null): Promise<Map<string, RowCost | null>> {
  const out = new Map<string, RowCost | null>()
  if (!holds(actor, 'money.cost')) return out
  const costed = rows.filter((row) => can(actor, COSTING_VIEW, { companyId: row.companyId }))
  if (costed.length === 0) return out
  const revisions = await client.styleRevision.findMany({ where: { styleId: { in: costed.map((row) => row.id) }, status: { in: ['RELEASED', 'DRAFT'] } }, select: COST_REVISION_COLUMNS, orderBy: { revision: 'desc' } })
  const currencies = await companiesOf(client, [...new Set(costed.map((row) => row.companyId ?? listCompanyId).filter((id): id is string => id !== null))])
  const now = serverClock.now()
  for (const row of costed) {
    const own = revisions.filter((revision) => revision.styleId === row.id)
    const revision = own.find((entry) => entry.status === 'RELEASED') ?? own[0]
    if (!revision) {
      out.set(row.id, null)
      continue
    }
    const companyId = row.companyId ?? listCompanyId
    const company: CostingCompany = { id: companyId, currency: costingCurrency(companyId === null ? null : (currencies.get(companyId) ?? null)) }
    out.set(row.id, await costOf(client, row, revision, company, now))
  }
  return out
}

// ---- owb-pd1 1.2: type, open orders, agreed prices, margin ---------------------------------------------------------------

/** The price list kinds whose prices are "agreed" with a customer (design § 5q "Agreed price"). */
export const AGREED_LIST_KINDS = ['CUSTOMER'] as const
/** EUR only (R58 a): a list in another currency is left out, never converted. */
const AGREED_CURRENCY = 'EUR'
const LIST_SCOPE = { company: { field: 'companyId', nullable: true } } as const

const dayValue = (day: BusinessDate): Date => new Date(`${day}T00:00:00.000Z`)
/** In force on a day: from a day (or open) to a day (or open). */
const inForceOn = (day: Date) => ({ AND: [{ OR: [{ validFrom: null }, { validFrom: { lte: day } }] }, { OR: [{ validTo: null }, { validTo: { gte: day } }] }] })
const decimalOf = (value: { toString(): string }): Decimal => new Dec(value.toString())
const dearest = (values: readonly Decimal[]): Decimal | null => values.reduce<Decimal | null>((top, value) => (top === null || value.gt(top) ? value : top), null)
function median(values: readonly Decimal[]): Decimal | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a.comparedTo(b))
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle]! : sorted[middle - 1]!.plus(sorted[middle]!).dividedBy(2)
}

/** Each style's type profile (S4 settle 1) and its kind's key (the profile, else the product type), by style id. */
async function kindsOf(client: Reader, rows: readonly StyleRowData[]): Promise<Map<string, { readonly typeName: string | null; readonly kind: string }>> {
  const out = new Map<string, { typeName: string | null; kind: string }>()
  if (rows.length === 0) return out
  const typed = await client.style.findMany({ where: { id: { in: rows.map((row) => row.id) } }, select: { id: true, productType: true, productTypeProfileId: true } })
  const profileIds = [...new Set(typed.flatMap((row) => (row.productTypeProfileId ? [row.productTypeProfileId] : [])))]
  const profiles = profileIds.length === 0 ? [] : await client.productTypeProfile.findMany({ where: { id: { in: profileIds } }, select: { id: true, name: true } })
  const nameOf = new Map(profiles.map((profile) => [profile.id, profile.name]))
  for (const row of typed) out.set(row.id, { typeName: row.productTypeProfileId ? (nameOf.get(row.productTypeProfileId) ?? null) : null, kind: kindKey(row) })
  return out
}
const kindKey = (row: { readonly productType: string; readonly productTypeProfileId: string | null }): string => (row.productTypeProfileId ? `profile:${row.productTypeProfileId}` : `type:${row.productType}`)

/** The open orders with each style that the person reads (none without orders.view or orders.view.own). */
async function openOrderCounts(client: Reader, context: RequestContext, rows: readonly StyleRowData[]): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (rows.length === 0) return out
  const reach = await orderReach(client, context)
  if (!reach) return out
  const pairs = await client.salesOrderLine.groupBy({ by: ['styleId', 'orderId'], where: { styleId: { in: rows.map((row) => row.id) }, kind: { not: 'FEE' }, order: { is: { AND: [reach, OPEN_ORDER] } } } })
  for (const pair of pairs) out.set(pair.styleId, (out.get(pair.styleId) ?? 0) + 1)
  return out
}

/** Each style's agreed prices in force today (the CUSTOMER lists the person may see, EUR only). */
async function agreedPrices(client: Reader, actor: Actor, rows: readonly StyleRowData[], day: Date): Promise<Map<string, Decimal[]>> {
  const out = new Map<string, Decimal[]>()
  if (rows.length === 0) return out
  const lists = scopeWhere(actor, PRICE_LISTS_VIEW, LIST_SCOPE)
  if (lists === NO_ROWS) return out
  const entries = await client.priceListEntry.findMany({
    where: {
      styleId: { in: rows.map((row) => row.id) },
      ...inForceOn(day),
      listVersion: {
        is: {
          status: 'ACTIVE',
          validFrom: { lte: day },
          OR: [{ validTo: null }, { validTo: { gte: day } }],
          list: { is: { AND: [lists as Prisma.PriceListWhereInput, { kind: { in: [...AGREED_LIST_KINDS] }, status: 'ACTIVE', currency: AGREED_CURRENCY }] } },
        },
      },
    },
    select: { styleId: true, unitPrice: true },
  })
  for (const entry of entries) out.set(entry.styleId, [...(out.get(entry.styleId) ?? []), decimalOf(entry.unitPrice)])
  return out
}

/** The FROZEN standard costs in force on a day, in EUR, of these companies' finished items (`where` names the items), per item. */
async function frozenUnitCosts(client: Reader, companyIds: readonly string[], items: Prisma.ItemWhereInput, day: Date) {
  if (companyIds.length === 0) return []
  return client.standardCost.findMany({
    where: { companyId: { in: [...companyIds] }, status: 'FROZEN', currency: AGREED_CURRENCY, validFrom: { lte: day }, OR: [{ validTo: null }, { validTo: { gte: day } }], item: { is: { AND: [items, { kind: 'FINISHED' }] } } },
    select: { companyId: true, itemId: true, unitCost: true },
  })
}

/** Each style's kept standard cost: the dearest frozen standard in force of its finished items, for its company. */
async function keptCosts(client: Reader, rows: readonly (StyleRowData & { readonly costCompanyId: string })[], day: Date): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>()
  if (rows.length === 0) return out
  const variants = await client.variant.findMany({ where: { styleId: { in: rows.map((row) => row.id) } }, select: { id: true, styleId: true } })
  if (variants.length === 0) return out
  const items = await client.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } })
  const styleOfVariant = new Map(variants.map((variant) => [variant.id, variant.styleId]))
  const styleOfItem = new Map(items.map((item) => [item.id, item.variantId ? styleOfVariant.get(item.variantId) : undefined]))
  const companyOf = new Map(rows.map((row) => [row.id, row.costCompanyId]))
  const standards = await frozenUnitCosts(client, [...new Set(rows.map((row) => row.costCompanyId))], { id: { in: items.map((item) => item.id) } }, day)
  for (const standard of standards) {
    const styleId = styleOfItem.get(standard.itemId)
    if (!styleId || companyOf.get(styleId) !== standard.companyId) continue
    const top = dearest([...(out.has(styleId) ? [out.get(styleId)!] : []), decimalOf(standard.unitCost)])
    if (top) out.set(styleId, top)
  }
  return out
}

/**
 * The rough standard of each kind (the design's STD_COST by kind), per company and kind: the median, over the OTHER products of
 * the kind that the person may see by brand, of each one's kept standard cost (its dearest frozen standard in force).
 */
async function kindCosts(client: Reader, actor: Actor, wanted: readonly { readonly costCompanyId: string; readonly productType: string; readonly profileId: string | null }[], day: Date): Promise<Map<string, Decimal>> {
  const out = new Map<string, Decimal>()
  if (wanted.length === 0) return out
  const profileIds = [...new Set(wanted.flatMap((entry) => (entry.profileId ? [entry.profileId] : [])))]
  const types = [...new Set(wanted.filter((entry) => entry.profileId === null).map((entry) => entry.productType))]
  const ofKind: Prisma.StyleWhereInput[] = [
    ...(profileIds.length > 0 ? [{ productTypeProfileId: { in: profileIds } }] : []),
    ...(types.length > 0 ? [{ productTypeProfileId: null, productType: { in: types as StyleRowData['productType'][] } }] : []),
  ]
  const brand = styleBrandWhere(actor, PRODUCT_STYLES_VIEW)
  const styles = await client.style.findMany({ where: { AND: [brand, { OR: ofKind }] }, select: { id: true, productType: true, productTypeProfileId: true } })
  if (styles.length === 0) return out
  const kindOfStyle = new Map(styles.map((style) => [style.id, kindKey(style)]))
  const variants = await client.variant.findMany({ where: { styleId: { in: styles.map((style) => style.id) } }, select: { id: true, styleId: true } })
  const styleOfVariant = new Map(variants.map((variant) => [variant.id, variant.styleId]))
  const items = variants.length === 0 ? [] : await client.item.findMany({ where: { variantId: { in: variants.map((variant) => variant.id) }, kind: 'FINISHED' }, select: { id: true, variantId: true } })
  const styleOfItem = new Map(items.map((item) => [item.id, item.variantId ? styleOfVariant.get(item.variantId) : undefined]))
  const standards = items.length === 0 ? [] : await frozenUnitCosts(client, [...new Set(wanted.map((entry) => entry.costCompanyId))], { id: { in: items.map((item) => item.id) } }, day)
  // Each product's kept figure (its dearest item), per company, then the median per company and kind.
  const perStyle = new Map<string, Decimal>()
  for (const standard of standards) {
    const styleId = styleOfItem.get(standard.itemId)
    if (!styleId) continue
    const key = `${standard.companyId}|${styleId}`
    const top = dearest([...(perStyle.has(key) ? [perStyle.get(key)!] : []), decimalOf(standard.unitCost)])
    if (top) perStyle.set(key, top)
  }
  const perKind = new Map<string, Decimal[]>()
  for (const [key, value] of perStyle) {
    const [companyId, styleId] = key.split('|') as [string, string]
    const kind = `${companyId}|${kindOfStyle.get(styleId)}`
    perKind.set(kind, [...(perKind.get(kind) ?? []), value])
  }
  for (const [kind, values] of perKind) {
    const middle = median(values)
    if (middle) out.set(kind, middle)
  }
  return out
}

interface Margin {
  readonly pct: string | null
  readonly from: MarginSource | null
}

/** The margin of each style's lowest agreed price, for a caller with the margin grain (see the header). */
async function margins(client: Reader, actor: Actor, rows: readonly StyleRowData[], prices: ReadonlyMap<string, readonly Decimal[]>, kinds: ReadonlyMap<string, { readonly kind: string }>, listCompanyId: string | null, day: Date): Promise<Map<string, Margin>> {
  const out = new Map<string, Margin>()
  if (!holds(actor, 'money.margin')) return out
  const priced = rows
    .filter((row) => can(actor, COSTING_VIEW, { companyId: row.companyId }) && (prices.get(row.id)?.length ?? 0) > 0)
    .flatMap((row) => {
      const costCompanyId = row.companyId ?? listCompanyId
      return costCompanyId === null ? [] : [{ ...row, costCompanyId }]
    })
  if (priced.length === 0) return out
  const kept = await keptCosts(client, priced, day)
  const unkept = priced.filter((row) => !kept.has(row.id))
  const kindRows = unkept.map((row) => {
    const kind = kinds.get(row.id)?.kind ?? `type:${row.productType}`
    return { row, costCompanyId: row.costCompanyId, productType: row.productType, profileId: kind.startsWith('profile:') ? kind.slice('profile:'.length) : null, kind }
  })
  const rough = await kindCosts(client, actor, kindRows, day)
  for (const row of priced) {
    const lowest = [...prices.get(row.id)!].sort((a, b) => a.comparedTo(b))[0]!
    const own = kept.get(row.id)
    const kind = kindRows.find((entry) => entry.row.id === row.id)
    const cost = own ?? (kind ? rough.get(`${row.costCompanyId}|${kind.kind}`) : undefined)
    if (!cost) continue
    out.set(row.id, { pct: marginPctOf(lowest.toString(), cost.toString()), from: own ? 'KEPT' : 'KIND' })
  }
  return out
}
// ---- end owb-pd1 1.2

// ---- the page -----------------------------------------------------------------------------------------------------------

/** The extras of one page of rows, by style id (a row the caller may see none of gets nulls). */
export async function rowExtras(client: Reader, context: RequestContext, rows: readonly StyleRowData[], listCompanyId: string | null): Promise<Map<string, RowExtras>> {
  const actor = actorOf(context)
  const pictures = await thumbnails(client, actor, rows.map((row) => row.id))
  const certified = await coverages(
    client,
    rows.filter((row) => can(actor, STYLE_COMPLIANCE_VIEW, { companyId: row.companyId })),
    todayOf(),
  )
  const costed = await costs(client, actor, rows, listCompanyId)
  // owb-pd1 1.2 — one query per kind for the page; the prices only for a caller who sees prices or margins.
  const day = dayValue(todayOf())
  const kinds = await kindsOf(client, rows)
  const orders = await openOrderCounts(client, context, rows)
  const prices = holds(actor, 'money.price') || holds(actor, 'money.margin') ? await agreedPrices(client, actor, rows, day) : new Map<string, Decimal[]>()
  const marginOf = await margins(client, actor, rows, prices, kinds, listCompanyId, day)
  return new Map(
    rows.map((row): [string, RowExtras] => {
      const agreed = prices.get(row.id) ?? []
      const sorted = [...agreed].sort((a, b) => a.comparedTo(b))
      const margin = marginOf.get(row.id)
      return [
        row.id,
        {
          thumbnail: pictures.get(row.id) ?? NONE.thumbnail,
          coverage: certified.get(row.id) ?? NONE.coverage,
          cost: asMoney('cost', costed.get(row.id) ?? null),
          typeName: kinds.get(row.id)?.typeName ?? null,
          family: row.brandPartyId === null ? 'OUR_RANGE' : 'FOR_CUSTOMER',
          openOrders: orders.get(row.id) ?? 0,
          agreedRange: asMoney('price', sorted.length === 0 ? null : { low: listPriceText(sorted[0]!.toString()), high: listPriceText(sorted.at(-1)!.toString()), count: sorted.length, currency: AGREED_CURRENCY }),
          marginPct: asMoney('margin', margin?.pct ?? null),
          marginFrom: asMoney('margin', margin?.from ?? null),
        },
      ]
    }),
  )
}
