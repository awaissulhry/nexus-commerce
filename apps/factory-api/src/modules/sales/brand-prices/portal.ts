import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { Prisma } from '@nexus/factory-db'
import { ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoneyKeys } from '@nexus/factory-domain/money/marked' // B-CP-019
import { PORTAL_SALES_ORDERS_ASK } from '@nexus/factory-domain/sales/change-requests/permissions'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { parseDecimal } from '@nexus/factory-domain/tax/decimal'
import type { CommandTools } from '../../../core/command'
import { commandOn } from '../../../platform/portal/tasks/clock'
import type { Reader } from '../orders/store'
import { partnerOrder, portalReader, type PortalReader } from '../portal-orders/access'
import { namesOf, readOrder, type PortalOrderRow } from '../portal-orders/store'
import { decimal } from '../quotes/store'
import { BRAND_PRICE_WORDS, StaleBrandPricesError } from './prices'
import { announceBrandPrices, auditBrandPrice, brandPriceAuditView, checkOfOrder, type BrandPriceFacts, type BrandPriceSource, type PricedOrder } from './store'

/**
 * B-CP-019 (customer page plan C3, D2, D3; Owner O4; design customer-page 11 §1.2, §3.4; review B2, C3): the customer's own price
 * check in its portal — the same check the office reads (factory-domain priceCheckOf through ./store checkOfOrder), for the
 * customer's own order only:
 *
 *   GET /portal/sales-orders/:orderId/price-check    portal.salesOrders.view (the manifest, the party's scope) AND the price grain
 *                                                    of the person's role (customer Buyer, Finance, Admin; else 403 "Prices are not
 *                                                    part of your access."): each line — our unit price and line net beside the
 *                                                    customer's (its row), the check, the difference; the order's total the same
 *                                                    way; whether this person may give its price now (in words when not)
 *   PUT /portal/sales-orders/:orderId/brand-prices   portal.salesOrders.ask (the customer Buyer; the Admin follows: Finance and the
 *                                                    other roles read only — the priced counter-offer's rule, B-PR-26: an order's
 *                                                    priced act is the Buyer's or the Admin's) AND the price grain (the grain filter
 *                                                    refuses every key of the body to anyone else): ONE command in the partner
 *                                                    scope that gives, changes and takes away the customer's LINE prices at the
 *                                                    versions read (409 with every row as it is now), refused by place (400)
 *
 * The rows the portal writes are the customer's own: source PORTAL, no office person (the partner role holds no grant on
 * enteredById: factory-db ownership sales-brand-prices.json; the portal person is in the audit). A row the factory typed (its PO,
 * or typed by us) is REPLACED by delete + insert, never changed in place and never only taken away (the database's guard:
 * …_customer_page_guards factory_order_brand_price_guard); the order's total row stays the factory's. Nothing is written while the
 * order is CLOSED or CANCELLED.
 *
 * The brand wall: the order is read in the partner scope (row-level security by party), so another customer's order is as
 * unknown as a wrong id ("Order not found.", partnerOrder). Review C3: a row the factory typed says where it came from in words
 * only — never the office note, never who typed it, never the PO file's name. B-CP-021: a change here tells the order's maker and
 * the Owner once, each only while they see prices over the order (./notices.ts).
 */

/** The words of the portal's price check, as the customer reads them (Italian: "voi"). */
export const PORTAL_PRICE_WORDS = Object.freeze({
  /** portal-orders.json prices.none, word for word. */
  none: { it: 'I prezzi non fanno parte del vostro accesso.', en: 'Prices are not part of your access.' },
  closed: { it: 'Un ordine chiuso o annullato non cambia più i prezzi.', en: 'A closed or cancelled order keeps its prices.' },
  readsOnly: { it: 'Il vostro prezzo lo indica un collega che ordina per voi (un Buyer o il vostro Admin).', en: 'Your price is given by a colleague who orders for you (a Buyer or your Admin).' },
  factoryRow: { it: 'Questo prezzo lo ha inserito la fabbrica: indicate il vostro al suo posto.', en: 'The factory typed this price: give your own for the line instead.' },
})

/** Where a customer's price came from, in the customer's words (never who in the office typed it). */
export const PORTAL_SOURCE_WORDS: Readonly<Record<BrandPriceSource, { readonly it: string; readonly en: string }>> = Object.freeze({
  PORTAL: { it: 'Inserito da voi', en: 'Typed by you' },
  CUSTOMER_PO: { it: "Dal vostro ordine d'acquisto", en: 'From your PO' },
  OFFICE: { it: 'Inserito dalla fabbrica', en: 'Typed by the factory' },
})

const CLOSED: ReadonlySet<string> = new Set(['CLOSED', 'CANCELLED'])

/** The columns the partner reads (never enteredById: the partner role holds no grant on it). */
const PORTAL_COLUMNS = {
  id: true,
  salesOrderId: true,
  salesOrderLineId: true,
  unitPrice: true,
  netAmount: true,
  currency: true,
  source: true,
  sourceFileId: true,
  note: true,
  enteredAt: true,
  version: true,
} as const satisfies Prisma.OrderBrandPriceSelect
type PortalRow = Prisma.OrderBrandPriceGetPayload<{ select: typeof PORTAL_COLUMNS }>

const LINE_COLUMNS = { id: true, seq: true, styleId: true, colourwayId: true, description: true, quantity: true, unitPrice: true, netAmount: true } as const satisfies Prisma.SalesOrderLineSelect

const rowsOf = (db: Reader, orderId: string): Promise<PortalRow[]> => db.orderBrandPrice.findMany({ where: { salesOrderId: orderId }, select: PORTAL_COLUMNS, orderBy: { id: 'asc' } })
const scopeOf = (order: Pick<PortalOrderRow, 'companyId' | 'partyId'>) => ({ companyId: order.companyId, partyId: order.partyId })
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'

/** A row in the audit as the partner can read it (who typed a row of the factory stays in that row's own audit). */
const auditView = (row: Omit<BrandPriceFacts, 'enteredById'>) => brandPriceAuditView({ ...row, enteredById: null })

/** The person's order (else 404) and the price grain of their role (else 403 in words). */
async function pricedPortalOrder(request: FastifyRequest, reader: PortalReader, orderId: string): Promise<PortalOrderRow> {
  const order = await partnerOrder(request, reader, orderId)
  if (!reader.seesPrices) throw new ForbiddenError(PORTAL_PRICE_WORDS.none.en)
  return order
}

/** The customer's price check of one order (every key money-marked in ./contract portalPriceCheckView). */
async function portalCheckView(request: FastifyRequest, reader: PortalReader, order: PortalOrderRow) {
  const { lines, rows } = await request.withClient(async (client) => ({
    lines: await client.salesOrderLine.findMany({ where: { orderId: order.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } }),
    rows: await rowsOf(client, order.id),
  }))
  const names = await reader.inTenant((client) => namesOf(client, [...new Set(lines.map((line) => line.styleId))], [...new Set(lines.map((line) => line.colourwayId))]))
  const check = checkOfOrder(order, lines, rows)
  const resultOf = new Map(check.lines.map((line) => [line.lineId, line]))
  const byLine = new Map(rows.flatMap((row) => (row.salesOrderLineId ? [[row.salesOrderLineId, row] as const] : [])))
  const rowView = (row: PortalRow | undefined) =>
    row
      ? {
          id: row.id,
          unitPrice: decimal(row.unitPrice),
          netAmount: row.netAmount,
          currency: row.currency,
          source: row.source,
          sourceWords: { ...PORTAL_SOURCE_WORDS[row.source] },
          // Review C3: only the customer's own note; the office's never.
          note: row.source === 'PORTAL' ? row.note : null,
          enteredAt: toUtcIso(row.enteredAt),
          version: row.version,
        }
      : null
  const why = CLOSED.has(order.status) ? PORTAL_PRICE_WORDS.closed : !can(reader.actor, PORTAL_SALES_ORDERS_ASK, scopeOf(order)) ? PORTAL_PRICE_WORDS.readsOnly : null
  // B-CP-019: every key of the customer's price check is the price grain (its contract).
  return asMoneyKeys('price', {
    orderId: order.id,
    currency: order.currency,
    lines: lines.map((line) => {
      const result = resultOf.get(line.id)!
      const label = line.description?.trim() || [names.styles.get(line.styleId)?.code, names.colourways.get(line.colourwayId)?.code].filter(Boolean).join(' ')
      return {
        lineId: line.id,
        seq: line.seq,
        label,
        pieces: line.quantity,
        ourUnitPrice: decimal(line.unitPrice)!,
        ourAmount: line.netAmount,
        brandAmount: result.brandAmount,
        priceMatch: result.priceMatch,
        priceDiff: result.priceDiff,
        row: rowView(byLine.get(line.id)),
      }
    }),
    total: { ...check.total, row: rowView(rows.find((row) => row.salesOrderLineId === null)) },
    mayWrite: { allowed: why === null, why: why ? { ...why } : null },
  })
}

/** GET /portal/sales-orders/:orderId/price-check (see the module's head). */
export async function readPortalPriceCheck(app: FastifyInstance, request: FastifyRequest, orderId: string) {
  const reader = portalReader(app, request)
  const order = await pricedPortalOrder(request, reader, orderId)
  return portalCheckView(request, reader, order)
}

// ---- PUT: the customer gives, changes and takes away its line prices -----------------------------------------------------

export interface PortalBrandPricesBody {
  readonly currency?: string | undefined
  readonly rows?: readonly { readonly lineId?: string | undefined; readonly unitPrice?: string | null | undefined; readonly netAmount?: number | null | undefined; readonly note?: string | null | undefined; readonly version?: number | undefined }[] | undefined
  readonly remove?: readonly { readonly id?: string | undefined; readonly version?: number | undefined }[] | undefined
}

/** Nothing to write (every row sent is as stored): no command, the check as it is. */
class NothingToSave extends Error {}

/** The body's own problems by place (before the command). */
function bodyProblems(order: PortalOrderRow, body: PortalBrandPricesBody): Issue[] {
  const issues: Issue[] = []
  if (CLOSED.has(order.status)) issues.push({ path: 'body', message: PORTAL_PRICE_WORDS.closed.en })
  if (body.currency !== undefined && body.currency !== order.currency) issues.push({ path: 'body/currency', message: BRAND_PRICE_WORDS.currency(order.currency) })
  const seen = new Set<string>()
  for (const [index, row] of (body.rows ?? []).entries()) {
    const at = `body/rows/${index}`
    if (row.lineId === undefined) {
      issues.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.notALine })
      continue
    }
    const unit = row.unitPrice !== undefined && row.unitPrice !== null
    const total = row.netAmount !== undefined && row.netAmount !== null
    if (unit === total) issues.push({ path: `${at}/unitPrice`, message: BRAND_PRICE_WORDS.lineOneOf })
    if (unit && (parseDecimal(row.unitPrice)?.isNegative() ?? true)) issues.push({ path: `${at}/unitPrice`, message: BRAND_PRICE_WORDS.notNegative })
    if (total && row.netAmount! < 0) issues.push({ path: `${at}/netAmount`, message: BRAND_PRICE_WORDS.notNegative })
    if (seen.has(row.lineId)) issues.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.twice })
    seen.add(row.lineId)
  }
  for (const [index, entry] of (body.remove ?? []).entries()) {
    if (entry.id === undefined) issues.push({ path: `body/remove/${index}/id`, message: BRAND_PRICE_WORDS.removedMeanwhile })
    if (entry.version === undefined) issues.push({ path: `body/remove/${index}/version`, message: BRAND_PRICE_WORDS.removedMeanwhile })
  }
  return issues
}

/** The writes of one PUT inside its partner-scope command (every check by place and by version first, then the writes). */
async function saveInPortal(tools: CommandTools, order: PortalOrderRow, body: PortalBrandPricesBody): Promise<void> {
  const { tx, now } = tools
  // The partner holds no UPDATE grant on the order (FOR SHARE needs one): read plainly; the database's guard has the last word.
  const current = await tx.salesOrder.findUnique({ where: { id: order.id }, select: { companyId: true, status: true } })
  if (!current || current.companyId !== order.companyId || CLOSED.has(current.status)) throw new ValidationError(PORTAL_PRICE_WORDS.closed.en, [{ path: 'body', message: PORTAL_PRICE_WORDS.closed.en }])
  const lineIds = new Set((await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id))
  const stored = await rowsOf(tx, order.id)
  const byLine = new Map(stored.flatMap((row) => (row.salesOrderLineId ? [[row.salesOrderLineId, row] as const] : [])))
  const byId = new Map(stored.map((row) => [row.id, row]))
  const rows = body.rows ?? []
  const remove = body.remove ?? []
  const removing = new Set(remove.map((entry) => entry.id!))

  const place: Issue[] = []
  const stale: Issue[] = []
  for (const [index, row] of rows.entries()) {
    const at = `body/rows/${index}`
    if (!lineIds.has(row.lineId!)) {
      place.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.notALine })
      continue
    }
    const existing = byLine.get(row.lineId!)
    if (existing && removing.has(existing.id)) place.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.removedAndTyped })
    else if (existing && row.version !== existing.version) stale.push({ path: `${at}/version`, message: row.version === undefined ? BRAND_PRICE_WORDS.typedMeanwhile(existing.version) : BRAND_PRICE_WORDS.atVersion(existing.version) })
    else if (!existing && row.version !== undefined) stale.push({ path: `${at}/version`, message: BRAND_PRICE_WORDS.removedMeanwhile })
  }
  for (const [index, entry] of remove.entries()) {
    const existing = byId.get(entry.id!)
    if (!existing) stale.push({ path: `body/remove/${index}/id`, message: BRAND_PRICE_WORDS.removedMeanwhile })
    else if (existing.source !== 'PORTAL') place.push({ path: `body/remove/${index}/id`, message: PORTAL_PRICE_WORDS.factoryRow.en })
    else if (existing.version !== entry.version) stale.push({ path: `body/remove/${index}/version`, message: BRAND_PRICE_WORDS.atVersion(existing.version) })
  }
  if (place.length > 0) throw new ValidationError(place.length === 1 ? place[0]!.message : 'Your prices cannot be saved like this.', place)
  if (stale.length > 0) throw new StaleBrandPricesError(stale)

  const priced: PricedOrder = { id: order.id, companyId: order.companyId, partyId: order.partyId }
  let changed = 0
  for (const entry of remove) {
    const existing = byId.get(entry.id!)!
    const { count } = await tx.orderBrandPrice.deleteMany({ where: { id: existing.id, version: existing.version, source: 'PORTAL' } })
    if (count !== 1) throw new StaleBrandPricesError([{ path: 'body/remove', message: BRAND_PRICE_WORDS.removedMeanwhile }])
    auditBrandPrice(tools, priced, { action: 'brandPrices.portalRemove', before: auditView(existing), after: null })
    changed++
  }
  for (const [index, row] of rows.entries()) {
    const data = {
      unitPrice: row.unitPrice === undefined || row.unitPrice === null ? null : priceText(row.unitPrice),
      netAmount: row.netAmount ?? null,
      note: blankToNull(row.note),
    }
    const existing = byLine.get(row.lineId!)
    if (existing && existing.source === 'PORTAL' && decimal(existing.unitPrice) === data.unitPrice && existing.netAmount === data.netAmount && existing.note === data.note) continue
    const at = `body/rows/${index}/version`
    if (existing && existing.source === 'PORTAL') {
      // The customer's own row, changed in place at the version read.
      const { count } = await tx.orderBrandPrice.updateMany({ where: { id: existing.id, version: existing.version, source: 'PORTAL' }, data: { ...data, enteredAt: now, updatedAt: now, version: { increment: 1 } } })
      if (count !== 1) throw new StaleBrandPricesError([{ path: at, message: BRAND_PRICE_WORDS.stale }])
      auditBrandPrice(tools, priced, { action: 'brandPrices.portalChange', before: auditView(existing), after: auditView({ ...existing, ...data, enteredAt: now, version: existing.version + 1 }) })
    } else {
      // A row the factory typed is replaced (delete + insert: the partner never changes it in place), or the line's first price.
      if (existing) {
        const { count } = await tx.orderBrandPrice.deleteMany({ where: { id: existing.id, version: existing.version } })
        if (count !== 1) throw new StaleBrandPricesError([{ path: at, message: BRAND_PRICE_WORDS.stale }])
      }
      const id = newId()
      const fresh = { id, salesOrderId: order.id, salesOrderLineId: row.lineId!, ...data, currency: order.currency, source: 'PORTAL' as const, sourceFileId: null, enteredAt: now, version: 1 }
      try {
        await tx.orderBrandPrice.create({ data: { id, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, salesOrderLineId: row.lineId!, ...data, currency: order.currency, source: 'PORTAL', enteredAt: now, createdAt: now, updatedAt: now }, select: { id: true } })
      } catch (error) {
        if (isUniqueViolation(error)) throw new StaleBrandPricesError([{ path: at, message: BRAND_PRICE_WORDS.stale }])
        throw error
      }
      auditBrandPrice(tools, priced, existing ? { action: 'brandPrices.portalReplace', before: auditView(existing), after: auditView(fresh) } : { action: 'brandPrices.portalSet', after: auditView(fresh) })
    }
    changed++
  }
  if (changed === 0) throw new NothingToSave()
  announceBrandPrices(tools, priced)
  // B-CP-021: the customer changed its own price — one alert to the price holders who keep the order (./notices.ts); ids only.
  tools.emit({ type: 'sales_order.brand_price_changed_by_customer', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, partyId: order.partyId } })
}

/** PUT /portal/sales-orders/:orderId/brand-prices (see the module's head). */
export async function savePortalBrandPrices(app: FastifyInstance, request: FastifyRequest, orderId: string, body: PortalBrandPricesBody, idempotencyKey?: string) {
  const reader = portalReader(app, request)
  const order = await pricedPortalOrder(request, reader, orderId)
  // The manifest asked portal.salesOrders.ask over the party; asked again over this order (its company and customer).
  if (!can(reader.actor, PORTAL_SALES_ORDERS_ASK, scopeOf(order))) throw new ForbiddenError(PORTAL_PRICE_WORDS.readsOnly.en)
  const problems = bodyProblems(order, body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'Your prices cannot be saved like this.', problems)
  try {
    await commandOn(app, request, { name: 'portalBrandPrices.save', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      await saveInPortal(tools, order, body)
      return null
    })
  } catch (error) {
    if (!(error instanceof NothingToSave)) throw error
  }
  const fresh = (await request.withClient((client) => readOrder(client, reader.session.company.id, order.id))) ?? order
  return portalCheckView(request, reader, fresh)
}
