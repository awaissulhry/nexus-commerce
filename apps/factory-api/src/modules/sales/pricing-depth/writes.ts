import { ConflictError, ForbiddenError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { markMoney } from '@nexus/factory-domain/money/marked'
import { entryProblems, listPriceText, PRICE_LIST_LIMITS } from '@nexus/factory-domain/sales/pricelists/pricelists'
import { PRICE_LISTS_MANAGE, PRICE_LISTS_VIEW } from '@nexus/factory-domain/sales/pricelists/permissions'
import { breakKey, breakProblems, daysProblems, overlapProblems, sizeCodeOf, surchargeKey, surchargeProblems, type BreakInput, type DatedEntry, type SurchargeInput } from '@nexus/factory-domain/sales/pricing-depth/rules'
import { StaleVersionError, command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayWrite } from '../../product/materials/store'
import { assertMayChangeList, claimVersion, dayText, dayValue, ENTRY_COLUMNS, entriesViewOf, lockList, mayOnList, priceOf, readListFor, VERSION_COLUMNS, versionViewOf, type ListRow } from '../pricelists/store'
import { officeContextOf, type Reader } from '../quotes/store'
import { assertDraft, assertListActive, BREAK_COLUMNS, invalid, rulesViewOf, SURCHARGE_COLUMNS, surchargeViewOf } from './store'

/**
 * Price lists in depth (B-W2b-325), the writes. Each is ONE command that locks the list's row first, then compares and
 * sets the version's own `version` (sent by the caller), as every W2a price list write does, so a write to a list never
 * interleaves with another and two writers never deadlock; a style's own surcharges take the style's advisory lock.
 *
 *   breaks          a DRAFT version's quantity breaks (SAL-166), keyed by price (or every price) and quantity; neither a
 *                   price nor a discount removes one
 *   size surcharges a DRAFT version's (SAL-180), keyed by style (or every style) and size; neither removes one
 *   style surcharges a style's own, whatever list prices it, at any time
 *   dated prices    a DRAFT version's prices with their days (SAL-167), keyed by style, colourway and first day: a price
 *                   (and its last day) set, or removed (unitPrice null, with its breaks); the version's prices of one
 *                   style and colourway then never overlap
 *   discount shown  the list's choice for the customer's documents (SAL-170)
 */

const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

async function writableList(caller: CommandCaller, listId: string): Promise<ListRow> {
  const list = await readListFor(caller, listId)
  assertMayChangeList(officeContextOf(caller), PRICE_LISTS_MANAGE, list.companyId)
  return list
}

async function lockedDraft(tools: CommandTools, listId: string, versionId: string, expected: number, what: string) {
  const list = await lockList(tools.tx, listId)
  assertListActive(list)
  const version = await claimVersion(tools.tx, listId, versionId, expected, tools.now)
  assertDraft(version, what)
  return { list, version }
}

const rulesAnswer = async (tools: CommandTools, list: ListRow, versionId: string) => {
  const version = await tools.tx.priceListVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_COLUMNS })
  return rulesViewOf(tools.tx, list, version)
}

// ---- quantity breaks (SAL-166) -------------------------------------------------------------------------------------------

/** A row as the body sends it: the money fields are optional in the contract (the grain filter), so a row names both. */
type Sent<Row, Money extends keyof Row> = Omit<Row, Money> & { readonly [Field in Money]?: Row[Field] | undefined }

/** Every money field of every row sent (null for none): a row without them is refused, never read as a removal. */
function allSent<Row, Money extends keyof Row & string>(rows: readonly Sent<Row, Money>[], fields: readonly Money[], at: string): Row[] {
  const missing = rows.flatMap((row, index) => fields.filter((field) => (row as Record<string, unknown>)[field] === undefined).map((field) => ({ path: `${at}/${index}/${field}`, message: `Send ${field} (null for none).` })))
  if (missing.length > 0) throw invalid(missing, 'Some rows do not say their price.')
  return rows as unknown as Row[]
}

export interface BreaksBody {
  readonly version: number
  readonly breaks: readonly Sent<BreakInput, 'unitPrice' | 'discountPct'>[]
}

/** PUT /sales/price-lists/:listId/versions/:versionId/breaks: set or remove a draft's breaks. */
export async function setBreaks(caller: CommandCaller, listId: string, versionId: string, sent: BreaksBody, idempotencyKey?: string) {
  await writableList(caller, listId)
  const body = { version: sent.version, breaks: allSent(sent.breaks, ['unitPrice', 'discountPct'], 'breaks') }
  const { result } = await command(caller, { name: 'priceLists.setBreaks', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const { list, version } = await lockedDraft(tools, listId, versionId, body.version, 'quantity breaks')
    const entries = await tx.priceListEntry.findMany({ where: { versionId }, select: { id: true, unitPrice: true } })
    const prices = new Map(entries.map((entry) => [entry.id, priceOf(entry.unitPrice)]))
    const unknown = body.breaks.flatMap((row, index) => (row.entryId !== null && !prices.has(row.entryId) ? [{ path: `breaks/${index}/entryId`, message: 'Not a price of this version.' }] : []))
    const issues = [...unknown, ...breakProblems(body.breaks, prices)]
    if (issues.length > 0) throw invalid(issues, 'The quantity breaks are not valid.')
    const existing = await tx.priceBreak.findMany({ where: { versionId }, select: BREAK_COLUMNS })
    const byKey = new Map(existing.map((row) => [breakKey(row.entryId, row.minQuantity), row]))
    const before: unknown[] = []
    const after: unknown[] = []
    for (const row of body.breaks) {
      const current = byKey.get(breakKey(row.entryId, row.minQuantity))
      const unitPrice = row.unitPrice === null ? null : listPriceText(row.unitPrice)
      const discountPct = row.discountPct
      const was = current ? { unitPrice: current.unitPrice === null ? null : priceOf(current.unitPrice), discountPct: current.discountPct === null ? null : current.discountPct.toString() } : null
      const removing = unitPrice === null && discountPct === null
      if (removing && !current) continue
      if (current && !removing && was!.unitPrice === unitPrice && (was!.discountPct === null ? discountPct === null : discountPct !== null && current.discountPct!.equals(discountPct))) continue
      before.push({ entryId: row.entryId, minQuantity: row.minQuantity, ...(was ?? { unitPrice: null, discountPct: null }) })
      after.push({ entryId: row.entryId, minQuantity: row.minQuantity, unitPrice, discountPct })
      if (removing) await tx.priceBreak.delete({ where: { id: current!.id }, select: { id: true } })
      else if (current) await tx.priceBreak.update({ where: { id: current.id }, data: { unitPrice, discountPct, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else await tx.priceBreak.create({ data: { id: newId(), versionId, entryId: row.entryId, minQuantity: row.minQuantity, unitPrice, discountPct, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
    }
    if (after.length > 0) {
      tools.audit({ action: 'priceLists.setBreaks', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: version.revision, breaks: markMoney('price', before) }, after: { versionId, revision: version.revision, breaks: markMoney('price', after) } })
      tools.emit({ type: 'price_list.rules_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: version.revision, change: 'BREAKS', rows: after.length } })
    }
    return rulesAnswer(tools, list, versionId)
  })
  return result
}

// ---- size surcharges of a version (SAL-180) ------------------------------------------------------------------------------

export interface SurchargesBody {
  readonly version: number
  readonly surcharges: readonly Sent<SurchargeInput, 'amount' | 'pct'>[]
}

/** The styles a list's surcharges (or prices) may name: the list's company's or every company's, with their sizes. */
async function stylesFor(tx: CommandTx, list: Pick<ListRow, 'companyId'>, styleIds: readonly string[], at: (index: number) => string, ids: readonly (string | null)[]): Promise<{ issues: Issue[]; styles: Map<string, { id: string; code: string; companyId: string | null; status: string; sizes: string[] }> }> {
  const wanted = [...new Set(styleIds)].filter(isUuid)
  const styles = new Map((wanted.length === 0 ? [] : await tx.style.findMany({ where: { id: { in: wanted } }, select: { id: true, code: true, companyId: true, status: true, sizes: true } })).map((row) => [row.id, row]))
  const issues: Issue[] = []
  for (const [index, styleId] of ids.entries()) {
    if (styleId === null) continue
    const style = styles.get(styleId)
    if (!style || (list.companyId === null ? style.companyId !== null : style.companyId !== null && style.companyId !== list.companyId)) issues.push({ path: `${at(index)}/styleId`, message: list.companyId === null ? 'A list of every company prices styles of every company.' : "Not a style of the list's company." })
  }
  return { issues, styles }
}

/** PUT /sales/price-lists/:listId/versions/:versionId/size-surcharges: a draft's surcharges, every style or one. */
export async function setVersionSurcharges(caller: CommandCaller, listId: string, versionId: string, sent: SurchargesBody, idempotencyKey?: string) {
  await writableList(caller, listId)
  const body = { version: sent.version, surcharges: allSent(sent.surcharges, ['amount', 'pct'], 'surcharges') }
  const problems = surchargeProblems(body.surcharges, false)
  if (problems.length > 0) throw invalid(problems, 'The size surcharges are not valid.')
  const { result } = await command(caller, { name: 'priceLists.setSizeSurcharges', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx } = tools
    const { list, version } = await lockedDraft(tools, listId, versionId, body.version, 'size surcharges')
    const ids = body.surcharges.map((row) => row.styleId)
    const { issues, styles } = await stylesFor(tx, list, ids.flatMap((id) => (id ? [id] : [])), (index) => `surcharges/${index}`, ids)
    for (const [index, row] of body.surcharges.entries()) {
      const style = row.styleId ? styles.get(row.styleId) : undefined
      if (style && style.sizes.length > 0 && !style.sizes.includes(sizeCodeOf(row.size))) issues.push({ path: `surcharges/${index}/size`, message: `${sizeCodeOf(row.size)} is not a size of ${style.code} (${style.sizes.join(', ')}).` })
    }
    if (issues.length > 0) throw invalid(issues, 'Some size surcharges cannot be saved.')
    const changed = await writeSurcharges(tools, { versionId, currency: list.currency }, body.surcharges)
    if (changed.after.length > 0) {
      tools.audit({ action: 'priceLists.setSizeSurcharges', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: version.revision, surcharges: markMoney('price', changed.before) }, after: { versionId, revision: version.revision, surcharges: markMoney('price', changed.after) } })
      tools.emit({ type: 'price_list.rules_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: version.revision, change: 'SIZE_SURCHARGES', rows: changed.after.length } })
    }
    return rulesAnswer(tools, list, versionId)
  })
  return result
}

/** Writes surcharges of one scope (a version, or a style's own), keyed by style and size; answers what changed. */
async function writeSurcharges(tools: CommandTools, scope: { readonly versionId: string; readonly currency: string } | { readonly versionId: null; readonly styleId: string }, rows: readonly SurchargeInput[]) {
  const { tx, now } = tools
  const existing = await tx.sizeSurcharge.findMany({ where: scope.versionId !== null ? { versionId: scope.versionId } : { versionId: null, styleId: scope.styleId }, select: SURCHARGE_COLUMNS })
  const byKey = new Map(existing.map((row) => [surchargeKey(row.styleId, row.size), row]))
  const before: unknown[] = []
  const after: unknown[] = []
  for (const row of rows) {
    const styleId = scope.versionId === null ? scope.styleId : row.styleId
    const size = sizeCodeOf(row.size)
    const current = byKey.get(surchargeKey(styleId, size))
    const amount = row.amount === null ? null : listPriceText(row.amount)
    const currency = amount === null ? null : scope.versionId !== null ? scope.currency : (row.currency ?? null)
    const removing = amount === null && row.pct === null
    if (removing && !current) continue
    const was = current ? { amount: current.surchargeAmount === null ? null : priceOf(current.surchargeAmount), currency: current.currency, pct: current.surchargePct === null ? null : current.surchargePct.toString() } : null
    if (current && !removing && was!.amount === amount && was!.currency === currency && (was!.pct === null ? row.pct === null : row.pct !== null && current.surchargePct!.equals(row.pct))) continue
    before.push({ styleId, size, ...(was ?? { amount: null, currency: null, pct: null }) })
    after.push({ styleId, size, amount, currency, pct: row.pct })
    if (removing) await tx.sizeSurcharge.delete({ where: { id: current!.id }, select: { id: true } })
    else if (current) await tx.sizeSurcharge.update({ where: { id: current.id }, data: { surchargeAmount: amount, currency, surchargePct: row.pct, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
    else await tx.sizeSurcharge.create({ data: { id: newId(), versionId: scope.versionId, styleId, size, surchargeAmount: amount, currency, surchargePct: row.pct, createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
  }
  return { before, after }
}

// ---- a style's own size surcharges (SAL-180) -----------------------------------------------------------------------------

/** A style the caller may see with pricelists.view over its company (a style of every company: any such grant), else 404. */
async function styleFor(caller: CommandCaller, styleId: string) {
  const style = isUuid(styleId) ? await caller.withClient((client) => client.style.findUnique({ where: { id: styleId }, select: { id: true, code: true, name: true, companyId: true, status: true, sizes: true } })) : null
  if (!style || !mayOnList(officeContextOf(caller), PRICE_LISTS_VIEW, style.companyId)) throw new NotFoundError('Style not found.')
  return style
}

async function styleSurchargesView(db: Reader, style: { id: string; code: string; name: string }) {
  const rows = await db.sizeSurcharge.findMany({ where: { versionId: null, styleId: style.id }, select: SURCHARGE_COLUMNS, orderBy: [{ size: 'asc' }, { id: 'asc' }] })
  return { style: { id: style.id, code: style.code, name: style.name }, surcharges: rows.map((row) => surchargeViewOf(row, { code: style.code, name: style.name })) }
}

/** GET /sales/styles/:styleId/size-surcharges: a style's own surcharges. */
export async function getStyleSurcharges(caller: CommandCaller, styleId: string) {
  const style = await styleFor(caller, styleId)
  return caller.withClient((client) => styleSurchargesView(client, style))
}

/** PUT /sales/styles/:styleId/size-surcharges: a style's own surcharges set or removed (sizes of its range). */
export async function setStyleSurcharges(caller: CommandCaller, styleId: string, sent: { readonly surcharges: readonly Sent<Omit<SurchargeInput, 'styleId'>, 'amount' | 'pct'>[] }, idempotencyKey?: string) {
  const style = await styleFor(caller, styleId)
  const body = { surcharges: allSent(sent.surcharges, ['amount', 'pct'], 'surcharges') }
  if (!mayWrite(actorOf(officeContextOf(caller)), PRICE_LISTS_MANAGE, style.companyId)) throw new ForbiddenError(style.companyId === null ? "A style of every company's surcharges are changed only by a role over every company." : undefined)
  const rows = body.surcharges.map((row) => ({ ...row, styleId }))
  const problems = surchargeProblems(rows, true)
  for (const [index, row] of rows.entries()) {
    if (style.sizes.length > 0 && !style.sizes.includes(sizeCodeOf(row.size))) problems.push({ path: `surcharges/${index}/size`, message: `${sizeCodeOf(row.size)} is not a size of ${style.code} (${style.sizes.join(', ')}).` })
  }
  if (problems.length > 0) throw invalid(problems, 'The size surcharges are not valid.')
  const { result } = await command(caller, { name: 'styles.setSizeSurcharges', idempotencyKey, input: { styleId, ...body } }, async (tools) => {
    const { tx } = tools
    // One writer of a style's own surcharges at a time (the style row stays the product area's).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.style-surcharges', current_setting('factory.tenant_id', true), ${styleId}::text), 0))`
    const changed = await writeSurcharges(tools, { versionId: null, styleId }, rows)
    if (changed.after.length > 0) {
      tools.audit({ action: 'styles.setSizeSurcharges', recordType: 'Style', recordId: styleId, companyId: style.companyId, before: { surcharges: markMoney('price', changed.before) }, after: { surcharges: markMoney('price', changed.after) } })
      tools.emit({ type: 'style.size_surcharges_changed', subject: styleId, companyId: style.companyId, payload: { styleId, code: style.code, sizes: [...new Set(rows.map((row) => sizeCodeOf(row.size)))] } })
    }
    return styleSurchargesView(tx, style)
  })
  return result
}

// ---- dated prices (SAL-167) ----------------------------------------------------------------------------------------------

export interface DatedPriceInput {
  readonly styleId: string
  readonly colourwayId: string | null
  readonly validFrom: BusinessDate | null
  readonly validTo: BusinessDate | null
  /** null: the price (and its breaks) is removed. */
  readonly unitPrice: string | null
}

export const datedKey = (styleId: string, colourwayId: string | null, validFrom: BusinessDate | null): string => `${styleId}:${colourwayId ?? '*'}:${validFrom ?? '-'}`

/** The days of a draft's prices, checked against the version's other prices of the style (no overlap), in words. */
export async function overlapIssues(tx: CommandTx, versionId: string, at = 'prices'): Promise<Issue[]> {
  const entries = await tx.priceListEntry.findMany({ where: { versionId }, select: ENTRY_COLUMNS })
  const dated: DatedEntry[] = entries.map((entry) => ({ id: entry.id, styleId: entry.styleId, colourwayId: entry.colourwayId, validFrom: dayText(entry.validFrom), validTo: dayText(entry.validTo) }))
  const styles = new Map((await tx.style.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.styleId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const colourways = new Map((await tx.colourway.findMany({ where: { id: { in: [...new Set(entries.flatMap((entry) => (entry.colourwayId ? [entry.colourwayId] : [])))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  return overlapProblems(dated, (entry) => [styles.get(entry.styleId), entry.colourwayId ? colourways.get(entry.colourwayId) : null].filter(Boolean).join(' ')).map((issue) => ({ ...issue, path: at }))
}

/**
 * PUT /sales/price-lists/:listId/versions/:versionId/dated-prices: a draft's prices with their days, set or removed;
 * then no two prices of one style and colourway hold on the same day (else nothing is written).
 */
export async function setDatedPrices(caller: CommandCaller, listId: string, versionId: string, sent: { readonly version: number; readonly prices: readonly Sent<DatedPriceInput, 'unitPrice'>[] }, idempotencyKey?: string) {
  await writableList(caller, listId)
  const body = { version: sent.version, prices: allSent(sent.prices, ['unitPrice'], 'prices') }
  const issues: Issue[] = entryProblems(body.prices.map((row) => ({ styleId: `${row.styleId}:${row.validFrom ?? '-'}`, colourwayId: row.colourwayId, unitPrice: row.unitPrice }))).map((issue) => ({ path: issue.path.replace(/^entries/, 'prices'), message: issue.message.replace('The same style and colourway twice: one price each.', 'The same style, colourway and first day twice: one price each.') }))
  for (const [index, row] of body.prices.entries()) issues.push(...daysProblems(row.validFrom, row.validTo, `prices/${index}`))
  if (issues.length > 0) throw invalid(issues, 'The prices are not valid.')
  const { result } = await command(caller, { name: 'priceLists.setDatedPrices', idempotencyKey, input: { listId, versionId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const { list, version } = await lockedDraft(tools, listId, versionId, body.version, 'prices')
    await checkTargets(tx, list, body.prices)
    const existing = await tx.priceListEntry.findMany({ where: { versionId }, select: ENTRY_COLUMNS })
    const byKey = new Map(existing.map((entry) => [datedKey(entry.styleId, entry.colourwayId, dayText(entry.validFrom)), entry]))
    const before: unknown[] = []
    const after: unknown[] = []
    for (const row of body.prices) {
      const current = byKey.get(datedKey(row.styleId, row.colourwayId, row.validFrom))
      const price = row.unitPrice === null ? null : listPriceText(row.unitPrice)
      const was = current ? { unitPrice: priceOf(current.unitPrice), validTo: dayText(current.validTo) } : null
      if (price === null && !current) continue
      if (current && price !== null && was!.unitPrice === price && was!.validTo === row.validTo) continue
      const key = { styleId: row.styleId, colourwayId: row.colourwayId, validFrom: row.validFrom }
      before.push({ ...key, unitPrice: was?.unitPrice ?? null, validTo: was?.validTo ?? null })
      after.push({ ...key, unitPrice: price, validTo: price === null ? null : row.validTo })
      // A price removed takes its quantity breaks with it (PriceBreak's entry: ON DELETE CASCADE).
      if (price === null) await tx.priceListEntry.delete({ where: { id: current!.id }, select: { id: true } })
      else if (current) await tx.priceListEntry.update({ where: { id: current.id }, data: { unitPrice: price, validTo: row.validTo === null ? null : dayValue(row.validTo), version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      else await tx.priceListEntry.create({ data: { id: newId(), versionId, styleId: row.styleId, colourwayId: row.colourwayId, unitPrice: price, validFrom: row.validFrom === null ? null : dayValue(row.validFrom), validTo: row.validTo === null ? null : dayValue(row.validTo), createdAt: now, updatedAt: now, createdById: actorIdOf(tools) }, select: { id: true } })
    }
    const overlap = await overlapIssues(tx, versionId)
    if (overlap.length > 0) throw invalid(overlap, 'Some prices hold on the same days.')
    const count = await tx.priceListEntry.count({ where: { versionId } })
    if (count > PRICE_LIST_LIMITS.entries) throw new ConflictError(`A version holds at most ${PRICE_LIST_LIMITS.entries} prices.`)
    if (after.length > 0) {
      tools.audit({ action: 'priceLists.setDatedPrices', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { versionId, revision: version.revision, prices: markMoney('price', before) }, after: { versionId, revision: version.revision, prices: markMoney('price', after) } })
      tools.emit({ type: 'price_list.version_changed', subject: listId, companyId: list.companyId, payload: { listId, versionId, revision: version.revision, change: 'PRICES' } })
    }
    const row = await tx.priceListVersion.findUniqueOrThrow({ where: { id: versionId }, select: VERSION_COLUMNS })
    const entries = await entriesViewOf(tx, tools.context, list, versionId, now)
    return { version: versionViewOf(row, entries.length), entries }
  })
  return result
}

/** The styles and colourways a list's prices name: the list's company's (or every company's), not archived, active colourways. */
export async function checkTargets(tx: CommandTx, list: Pick<ListRow, 'companyId'>, rows: readonly { readonly styleId: string; readonly colourwayId: string | null; readonly unitPrice: string | null }[], at = (index: number) => `prices/${index}`): Promise<void> {
  const { issues, styles } = await stylesFor(tx, list, rows.map((row) => row.styleId), at, rows.map((row) => row.styleId))
  const colourwayIds = [...new Set(rows.flatMap((row) => (row.colourwayId ? [row.colourwayId] : [])))].filter(isUuid)
  const colourways = new Map((colourwayIds.length === 0 ? [] : await tx.colourway.findMany({ where: { id: { in: colourwayIds } }, select: { id: true, styleId: true, status: true } })).map((row) => [row.id, row]))
  for (const [index, row] of rows.entries()) {
    const style = styles.get(row.styleId)
    if (!style) continue
    if (row.unitPrice !== null && style.status === 'ARCHIVED') issues.push({ path: `${at(index)}/styleId`, message: `${style.code} is archived: it is not priced.` })
    if (row.colourwayId !== null) {
      const colourway = colourways.get(row.colourwayId)
      if (!colourway || colourway.styleId !== style.id) issues.push({ path: `${at(index)}/colourwayId`, message: `Not a colourway of ${style.code}.` })
      else if (row.unitPrice !== null && colourway.status !== 'ACTIVE') issues.push({ path: `${at(index)}/colourwayId`, message: `Not an active colourway of ${style.code}.` })
    }
  }
  if (issues.length > 0) throw invalid(issues, 'Some prices cannot be saved.')
}

// ---- the discount on the customer's documents (SAL-170) ------------------------------------------------------------------

/** PUT /sales/price-lists/:listId/discount-display: the list's documents show the list price and discount, or net only. */
export async function setDiscountDisplay(caller: CommandCaller, listId: string, body: { readonly version: number; readonly showDiscount: boolean }, idempotencyKey?: string) {
  await writableList(caller, listId)
  const { result } = await command(caller, { name: 'priceLists.discountDisplay', idempotencyKey, input: { listId, ...body } }, async (tools) => {
    const { tx, now } = tools
    const list = await lockList(tx, listId)
    assertListActive(list)
    if (list.version !== body.version) throw new StaleVersionError('PriceList', listId, list.version, body.version)
    if (list.showDiscount !== body.showDiscount) {
      await tx.priceList.update({ where: { id: listId }, data: { showDiscount: body.showDiscount, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
      tools.audit({ action: 'priceLists.discountDisplay', recordType: 'PriceList', recordId: listId, companyId: list.companyId, before: { showDiscount: list.showDiscount }, after: { showDiscount: body.showDiscount } })
      tools.emit({ type: 'price_list.changed', subject: listId, companyId: list.companyId, payload: { listId, code: list.code, change: 'UPDATED', fields: ['showDiscount'], partyIds: [] } })
    }
    const row = await tx.priceList.findUniqueOrThrow({ where: { id: listId }, select: { id: true, code: true, showDiscount: true, version: true } })
    return { list: row }
  })
  return result
}
