import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { ConflictError, ForbiddenError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { priceText } from '@nexus/factory-domain/sales/quotes/quotes'
import { parseDecimal } from '@nexus/factory-domain/tax/decimal'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { mayOn, officeContextOf } from '../orders/access'
import { officeOrder } from '../orders/moves'
import { lockOrder, readOrder, type OrderRow, type Reader } from '../orders/store'
import { decimal } from '../quotes/store'
import { announceBrandPrices, auditBrandPrice, brandPriceAuditView, brandPriceRowsOf, checkOfOrder, markSourceFilesPriced, type BrandPriceRecord, type PricedOrder } from './store'

/**
 * The customer's price of an order and the price check (customer page plan C2d, C3, B-CP-017; design customer-page 11 §1.2, §2;
 * Owner picks O1-O4, D5; review B2, B3, B4, C2, F4). The office's three commands and one read of ONE order:
 *
 *   GET  /sales/orders/:orderId/price-check           orders.view over the order (else not found, the brand wall) AND the price
 *                                                     grain over it (else 403 "Shown to people who see prices"): each line —
 *                                                     ours (unit price, line net) beside the customer's (its row: unit price or
 *                                                     line total, where from, the PO file, the note, who typed it), the check
 *                                                     (factory-domain priceCheckOf: EQUAL / NOT_EQUAL / NO_BRAND_PRICE, the
 *                                                     difference = ours − the customer's) — the order's total the same way, the
 *                                                     customer's own request whose prices can be taken over, and whether the
 *                                                     reader may write (in words when not)
 *   PUT  /sales/orders/:orderId/brand-prices          orders.manage AND the price grain (the grain filter already refuses every
 *                                                     key of the body to anyone else: each is money-marked): ONE command that
 *                                                     sets, changes and removes rows at the versions read (409 with every row as
 *                                                     it is now, in the issues), refused by place (400: the currency, a closed
 *                                                     or cancelled order, not a line of this order, both or none of unit price
 *                                                     and line total, a source file that is not this order's); the PO file named
 *                                                     is marked priced (StoredFile.priced, audited: the priced-file lock)
 *   POST /sales/orders/:orderId/brand-prices/from-request   the same rights: the customer's own prices of its portal request
 *                                                     (accepted as a QUOTE whose order came later, or an order the accept did not
 *                                                     carry them to) copied to the lines without a row, by the line's place
 *                                                     (seq), source PORTAL (the customer's own: no one in the office typed it)
 *
 * Computed on every read, never stored (D5): nothing closes a NOT_EQUAL but a change of one of the two prices. "No customer price
 * yet" is never EQUAL. Without VAT, in the order's currency, exact to the cent. The history is the audit under OrderBrandPrice (./store).
 */

/** The price grain as the permission can() reads (money.price). */
export const PRICE_PERMISSION = grainPermission('price') as Permission

/** The words of the refusals (the web says `orders.json money.noPrice` and its own catalogue words). */
export const BRAND_PRICE_WORDS = Object.freeze({
  notAPriceHolder: 'Shown to people who see prices.',
  closedOrder: 'A closed or cancelled order keeps its prices.',
  notAManager: 'The customer\'s price is set by people who manage orders.',
  stale: 'Someone changed these prices meanwhile. Here they are now: read them again.',
  notALine: 'Not a line of this order.',
  lineNamed: 'Name the line, or null for the customer\'s total of the whole order.',
  lineOneOf: 'A line takes the customer\'s unit price or its line total: one of the two.',
  totalAmount: 'The customer\'s total of the whole order is an amount (minor units).',
  notNegative: 'At least 0.',
  twice: 'This line is named twice: send it once.',
  removedAndTyped: 'This customer\'s price is removed and typed in the same request: send one.',
  source: 'Where it came from: the customer\'s PO, or typed by us.',
  notAFile: 'Not a file of this order.',
  removedMeanwhile: 'This customer\'s price was removed meanwhile.',
  typedMeanwhile: (version: number) => `The customer's price of this line was typed meanwhile (version ${version}): read it again.`,
  atVersion: (version: number) => `This customer's price is at version ${version} now.`,
  currency: (currency: string) => `The order is in ${currency}: the customer's price is typed in the order's currency.`,
  nothingToTake: 'Nothing to take over: the customer\'s request names no price for a line that has none yet.',
  notTheRequest: 'Not the customer\'s request of this order.',
})

const CLOSED = ['CLOSED', 'CANCELLED'] as const
const isClosed = (status: string): boolean => (CLOSED as readonly string[]).includes(status)
const blankToNull = (value: string | null | undefined): string | null => (value === undefined || value === null || value.trim() === '' ? null : value.trim())

/** A 409 of the price rows: each row as it is now, by place (the web reads the check again). */
export class StaleBrandPricesError extends ConflictError {
  override name = 'StaleBrandPricesError'
  override readonly issues: readonly Issue[]
  constructor(issues: readonly Issue[]) {
    super(BRAND_PRICE_WORDS.stale)
    this.issues = issues
  }
}

/** Nothing to write (every row sent is as stored): no command, the check as it is. */
class NothingToSave extends Error {}

/** The order the caller reaches (orders.view, else not found; `permission` over it, else forbidden) and holds the price grain over. */
async function pricedOrder(caller: CommandCaller, orderId: string, permission: Permission = ORDERS_VIEW): Promise<{ context: OfficeContext; order: OrderRow }> {
  const context = officeContextOf(caller)
  const order = await officeOrder(caller, orderId, permission)
  if (!mayOn(context, PRICE_PERMISSION, order)) throw new ForbiddenError(BRAND_PRICE_WORDS.notAPriceHolder)
  return { context, order }
}

// ---- the read -----------------------------------------------------------------------------------------------------------------

const LINE_COLUMNS = { id: true, seq: true, styleId: true, colourwayId: true, description: true, quantity: true, unitPrice: true, netAmount: true } as const

/** The customer's own portal request of this order whose prices may be taken over (lines without a row yet), or null. */
async function takeOverOf(db: Reader, order: OrderRow, lines: readonly { readonly id: string; readonly seq: number }[], rows: readonly BrandPriceRecord[]) {
  const quoteId = order.quoteVersionId ? ((await db.quoteVersion.findUnique({ where: { id: order.quoteVersionId }, select: { quoteId: true } }))?.quoteId ?? null) : null
  const request = await db.portalOrderRequest.findFirst({
    where: { partyId: order.partyId, status: 'ACCEPTED', OR: [{ salesOrderId: order.id }, ...(quoteId ? [{ quoteId }] : [])] },
    orderBy: [{ decidedAt: 'desc' }, { id: 'desc' }],
    select: { id: true, number: true, currency: true },
  })
  // Its prices are in its own currency: one in another currency is never taken over (no exchange rate, ever).
  if (!request || request.currency !== order.currency) return null
  const priced = await db.portalOrderRequestLine.findMany({ where: { requestId: request.id, brandUnitPrice: { not: null } }, select: { seq: true, brandUnitPrice: true } })
  const bySeq = new Map(priced.map((line) => [line.seq, line.brandUnitPrice!]))
  const typed = new Set(rows.flatMap((row) => (row.salesOrderLineId ? [row.salesOrderLineId] : [])))
  const takes = lines.filter((line) => !typed.has(line.id) && bySeq.has(line.seq)).map((line) => ({ lineId: line.id, unitPrice: bySeq.get(line.seq)! }))
  return takes.length === 0 ? null : { requestId: request.id, number: request.number, takes }
}

/** The price check of one order as the answer carries it (every key money-marked in ./contract). */
async function priceCheckView(db: Reader, context: OfficeContext, order: OrderRow) {
  const lines = await db.salesOrderLine.findMany({ where: { orderId: order.id }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
  const rows = await brandPriceRowsOf(db, [order.id])
  const styleIds = [...new Set(lines.map((line) => line.styleId))]
  const colourwayIds = [...new Set(lines.map((line) => line.colourwayId))]
  const styles = new Map(styleIds.length > 0 ? (await db.style.findMany({ where: { id: { in: styleIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]) : [])
  const colourways = new Map(colourwayIds.length > 0 ? (await db.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]) : [])
  const peopleIds = [...new Set(rows.flatMap((row) => (row.enteredById ? [row.enteredById] : [])))]
  const people = new Map(peopleIds.length > 0 ? (await db.user.findMany({ where: { id: { in: peopleIds } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]) : [])
  const fileIds = [...new Set(rows.flatMap((row) => (row.sourceFileId ? [row.sourceFileId] : [])))]
  const files = new Map(fileIds.length > 0 ? (await db.storedFile.findMany({ where: { id: { in: fileIds }, status: { not: 'DELETED' } }, select: { id: true, originalName: true } })).map((row) => [row.id, row.originalName]) : [])
  const check = checkOfOrder(order, lines, rows)
  const take = await takeOverOf(db, order, lines, rows)
  const rowView = (row: BrandPriceRecord | undefined) =>
    row
      ? {
          id: row.id,
          unitPrice: decimal(row.unitPrice),
          netAmount: row.netAmount,
          currency: row.currency,
          source: row.source,
          sourceFile: row.sourceFileId && files.has(row.sourceFileId) ? { id: row.sourceFileId, name: files.get(row.sourceFileId)! } : null,
          note: row.note,
          enteredBy: row.enteredById ? { name: people.get(row.enteredById) ?? '' } : null,
          enteredAt: toUtcIso(row.enteredAt),
          version: row.version,
        }
      : null
  const byLine = new Map(rows.flatMap((row) => (row.salesOrderLineId ? [[row.salesOrderLineId, row] as const] : [])))
  const totalRow = rows.find((row) => row.salesOrderLineId === null)
  const resultOf = new Map(check.lines.map((line) => [line.lineId, line]))
  const manages = mayOn(context, ORDERS_MANAGE, order)
  const why = isClosed(order.status) ? BRAND_PRICE_WORDS.closedOrder : !manages ? BRAND_PRICE_WORDS.notAManager : null
  return {
    orderId: order.id,
    number: order.number,
    currency: order.currency,
    status: order.status,
    lines: lines.map((line) => {
      const result = resultOf.get(line.id)!
      const label = line.description?.trim() || [styles.get(line.styleId), colourways.get(line.colourwayId)].filter(Boolean).join(' ')
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
    total: { ...check.total, row: rowView(totalRow) },
    fromRequest: take ? { requestId: take.requestId, number: take.number, lines: take.takes.length } : null,
    mayWrite: { allowed: why === null, why },
  }
}

/** GET /sales/orders/:orderId/price-check (see the module's head). */
export async function readPriceCheck(caller: CommandCaller, orderId: string) {
  const { context, order } = await pricedOrder(caller, orderId)
  return caller.withClient((client) => priceCheckView(client, context, order))
}

// ---- PUT: set, change and remove ----------------------------------------------------------------------------------------------

export interface BrandPriceRowBody {
  /** The order line; null: the customer's total of the whole order. */
  readonly lineId?: string | null | undefined
  readonly unitPrice?: string | null | undefined
  readonly netAmount?: number | null | undefined
  readonly source?: 'CUSTOMER_PO' | 'OFFICE' | undefined
  readonly sourceFileId?: string | null | undefined
  readonly note?: string | null | undefined
  /** The row's version as read; none: a new row (the line has none yet). */
  readonly version?: number | undefined
}

export interface SaveBrandPricesBody {
  /** The order's currency as the person read it (a check: the price is typed in the order's currency). */
  readonly currency?: string | undefined
  readonly rows?: readonly BrandPriceRowBody[] | undefined
  readonly remove?: readonly { readonly id?: string | undefined; readonly version?: number | undefined }[] | undefined
}

const keyOf = (lineId: string | null | undefined): string => lineId ?? 'total'

/** The body's own problems by place (before the command). */
function bodyProblems(order: OrderRow, body: SaveBrandPricesBody): Issue[] {
  const issues: Issue[] = []
  if (isClosed(order.status)) issues.push({ path: 'body', message: BRAND_PRICE_WORDS.closedOrder })
  if (body.currency !== undefined && body.currency !== order.currency) issues.push({ path: 'body/currency', message: BRAND_PRICE_WORDS.currency(order.currency) })
  const seen = new Set<string>()
  for (const [index, row] of (body.rows ?? []).entries()) {
    const at = `body/rows/${index}`
    if (row.lineId === undefined) issues.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.lineNamed })
    if (row.source === undefined) issues.push({ path: `${at}/source`, message: BRAND_PRICE_WORDS.source })
    const unit = row.unitPrice !== undefined && row.unitPrice !== null
    const total = row.netAmount !== undefined && row.netAmount !== null
    if (row.lineId === null) {
      if (unit || !total) issues.push({ path: `${at}/netAmount`, message: BRAND_PRICE_WORDS.totalAmount })
    } else if (unit === total) {
      issues.push({ path: `${at}/unitPrice`, message: BRAND_PRICE_WORDS.lineOneOf })
    }
    if (unit && (parseDecimal(row.unitPrice)?.isNegative() ?? true)) issues.push({ path: `${at}/unitPrice`, message: BRAND_PRICE_WORDS.notNegative })
    if (total && row.netAmount! < 0) issues.push({ path: `${at}/netAmount`, message: BRAND_PRICE_WORDS.notNegative })
    if (row.lineId !== undefined) {
      if (seen.has(keyOf(row.lineId))) issues.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.twice })
      seen.add(keyOf(row.lineId))
    }
  }
  for (const [index, entry] of (body.remove ?? []).entries()) {
    if (entry.id === undefined) issues.push({ path: `body/remove/${index}/id`, message: BRAND_PRICE_WORDS.removedMeanwhile })
    if (entry.version === undefined) issues.push({ path: `body/remove/${index}/version`, message: BRAND_PRICE_WORDS.removedMeanwhile })
  }
  return issues
}

const sameRow = (row: BrandPriceRecord, data: { unitPrice: string | null; netAmount: number | null; source: string; sourceFileId: string | null; note: string | null }): boolean =>
  decimal(row.unitPrice) === data.unitPrice && row.netAmount === data.netAmount && row.source === data.source && row.sourceFileId === data.sourceFileId && row.note === data.note

/** The writes of one PUT inside its command (the order locked; every check by place and by version first, then the writes). */
async function saveInCommand(tools: CommandTools, context: OfficeContext, order: OrderRow, body: SaveBrandPricesBody): Promise<void> {
  const { tx, now } = tools
  const locked = await lockOrder(tx, order.id)
  if (isClosed(locked.status)) throw new ValidationError(BRAND_PRICE_WORDS.closedOrder, [{ path: 'body', message: BRAND_PRICE_WORDS.closedOrder }])
  const lineIds = new Set((await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true } })).map((line) => line.id))
  const current = await brandPriceRowsOf(tx, [order.id])
  const byKey = new Map(current.map((row) => [keyOf(row.salesOrderLineId), row]))
  const byId = new Map(current.map((row) => [row.id, row]))
  const rows = body.rows ?? []
  const remove = body.remove ?? []
  const removing = new Set(remove.map((entry) => entry.id!))

  const place: Issue[] = []
  const stale: Issue[] = []
  for (const [index, row] of rows.entries()) {
    const at = `body/rows/${index}`
    if (row.lineId !== null && !lineIds.has(row.lineId!)) place.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.notALine })
    const existing = byKey.get(keyOf(row.lineId))
    if (existing && removing.has(existing.id)) place.push({ path: `${at}/lineId`, message: BRAND_PRICE_WORDS.removedAndTyped })
    else if (existing && row.version !== existing.version) stale.push({ path: `${at}/version`, message: row.version === undefined ? BRAND_PRICE_WORDS.typedMeanwhile(existing.version) : BRAND_PRICE_WORDS.atVersion(existing.version) })
    else if (!existing && row.version !== undefined) stale.push({ path: `${at}/version`, message: BRAND_PRICE_WORDS.removedMeanwhile })
  }
  for (const [index, entry] of remove.entries()) {
    const existing = byId.get(entry.id!)
    if (!existing) stale.push({ path: `body/remove/${index}/id`, message: BRAND_PRICE_WORDS.removedMeanwhile })
    else if (existing.version !== entry.version) stale.push({ path: `body/remove/${index}/version`, message: BRAND_PRICE_WORDS.atVersion(existing.version) })
  }
  // The customer's PO named: a file of this order, not deleted, of no other customer (the guard's rule, in words first).
  const fileIds = [...new Set(rows.flatMap((row) => (row.sourceFileId ? [row.sourceFileId] : [])))]
  const files = new Map(fileIds.length > 0 ? (await tx.storedFile.findMany({ where: { id: { in: fileIds } }, select: { id: true, recordType: true, recordId: true, status: true, partyId: true } })).map((file) => [file.id, file]) : [])
  for (const [index, row] of rows.entries()) {
    if (!row.sourceFileId) continue
    const file = files.get(row.sourceFileId)
    if (!file || file.recordType !== 'SalesOrder' || file.recordId !== order.id || file.status === 'DELETED' || (file.partyId !== null && file.partyId !== order.partyId)) place.push({ path: `body/rows/${index}/sourceFileId`, message: BRAND_PRICE_WORDS.notAFile })
  }
  if (place.length > 0) throw new ValidationError(place.length === 1 ? place[0]!.message : 'The customer\'s prices cannot be saved like this.', place)
  if (stale.length > 0) throw new StaleBrandPricesError(stale)

  const priced: PricedOrder = { id: order.id, companyId: order.companyId, partyId: order.partyId }
  let changed = 0
  for (const entry of remove) {
    const existing = byId.get(entry.id!)!
    const { count } = await tx.orderBrandPrice.deleteMany({ where: { id: existing.id, version: existing.version } })
    if (count !== 1) throw new StaleBrandPricesError([{ path: 'body/remove', message: BRAND_PRICE_WORDS.removedMeanwhile }])
    auditBrandPrice(tools, priced, { action: 'brandPrices.remove', before: brandPriceAuditView(existing), after: null })
    changed++
  }
  for (const [index, row] of rows.entries()) {
    const data = {
      unitPrice: row.unitPrice === undefined || row.unitPrice === null ? null : priceText(row.unitPrice),
      netAmount: row.netAmount ?? null,
      source: row.source!,
      sourceFileId: row.sourceFileId ?? null,
      note: blankToNull(row.note),
    }
    const existing = byKey.get(keyOf(row.lineId))
    if (existing && sameRow(existing, data)) continue
    // Typed by this person now: a change of a PORTAL row makes it the factory's (the source sent, who typed it).
    const typed = { ...data, enteredById: context.actorId, enteredAt: now, updatedAt: now }
    if (existing) {
      const { count } = await tx.orderBrandPrice.updateMany({ where: { id: existing.id, version: existing.version }, data: { ...typed, version: { increment: 1 } } })
      if (count !== 1) throw new StaleBrandPricesError([{ path: `body/rows/${index}/version`, message: BRAND_PRICE_WORDS.stale }])
      auditBrandPrice(tools, priced, { action: 'brandPrices.change', before: brandPriceAuditView(existing), after: brandPriceAuditView({ ...existing, ...typed, version: existing.version + 1 }) })
    } else {
      const id = newId()
      await tx.orderBrandPrice.create({ data: { id, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, salesOrderLineId: row.lineId ?? null, currency: order.currency, ...typed, createdAt: now }, select: { id: true } })
      auditBrandPrice(tools, priced, { action: 'brandPrices.set', after: brandPriceAuditView({ id, salesOrderLineId: row.lineId ?? null, currency: order.currency, ...typed, version: 1 }) })
    }
    changed++
  }
  if (changed === 0) throw new NothingToSave()
  // B-CP-017 (lead addition 1): the customer's PO a price was typed from is a priced file (the priced-file lock, cp-1b's).
  await markSourceFilesPriced(tools, priced, fileIds)
  announceBrandPrices(tools, priced)
}

/** PUT /sales/orders/:orderId/brand-prices (see the module's head). */
export async function saveBrandPrices(caller: CommandCaller, orderId: string, body: SaveBrandPricesBody, idempotencyKey?: string) {
  const { context, order } = await pricedOrder(caller, orderId, ORDERS_MANAGE)
  const problems = bodyProblems(order, body)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The customer\'s prices cannot be saved like this.', problems)
  try {
    await command(caller, { name: 'brandPrices.save', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      await saveInCommand(tools, context, order, body)
      return null
    })
  } catch (error) {
    if (!(error instanceof NothingToSave)) throw error
  }
  return caller.withClient(async (client) => priceCheckView(client, context, (await readOrder(client, order.id)) ?? order))
}

// ---- POST from-request: the customer's own prices of its request ------------------------------------------------------------

/** POST /sales/orders/:orderId/brand-prices/from-request (see the module's head). */
export async function takeOverBrandPrices(caller: CommandCaller, orderId: string, body: { readonly requestId?: string | undefined }, idempotencyKey?: string) {
  const { context, order } = await pricedOrder(caller, orderId, ORDERS_MANAGE)
  if (isClosed(order.status)) throw new ValidationError(BRAND_PRICE_WORDS.closedOrder, [{ path: 'body', message: BRAND_PRICE_WORDS.closedOrder }])
  try {
    await command(caller, { name: 'brandPrices.takeOver', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
      const { tx, now } = tools
      const locked = await lockOrder(tx, order.id)
      if (isClosed(locked.status)) throw new ValidationError(BRAND_PRICE_WORDS.closedOrder, [{ path: 'body', message: BRAND_PRICE_WORDS.closedOrder }])
      const lines = await tx.salesOrderLine.findMany({ where: { orderId: order.id }, select: { id: true, seq: true } })
      const take = await takeOverOf(tx, order, lines, await brandPriceRowsOf(tx, [order.id]))
      if (take && body.requestId !== undefined && take.requestId !== body.requestId) throw new ValidationError(BRAND_PRICE_WORDS.notTheRequest, [{ path: 'body/requestId', message: BRAND_PRICE_WORDS.notTheRequest }])
      if (!take) throw new NothingToSave()
      const priced: PricedOrder = { id: order.id, companyId: order.companyId, partyId: order.partyId }
      for (const entry of take.takes) {
        const id = newId()
        // The customer's own price, carried from its request: PORTAL, no one in the office typed it (the guard's carry).
        const row = { id, companyId: order.companyId, partyId: order.partyId, salesOrderId: order.id, salesOrderLineId: entry.lineId, unitPrice: entry.unitPrice, netAmount: null, currency: order.currency, source: 'PORTAL' as const, sourceFileId: null, note: null, enteredById: null, enteredAt: now }
        await tx.orderBrandPrice.create({ data: { ...row, createdAt: now, updatedAt: now }, select: { id: true } })
        auditBrandPrice(tools, priced, { action: 'brandPrices.takeOver', after: { ...brandPriceAuditView({ ...row, version: 1 }), requestId: take.requestId } })
      }
      announceBrandPrices(tools, priced)
      return null
    })
  } catch (error) {
    if (!(error instanceof NothingToSave)) throw error
    throw new ConflictError(BRAND_PRICE_WORDS.nothingToTake)
  }
  return caller.withClient(async (client) => priceCheckView(client, context, (await readOrder(client, order.id)) ?? order))
}
