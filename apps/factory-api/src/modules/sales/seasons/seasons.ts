import { DomainError, ForbiddenError, InvalidStateError, ValidationError } from '@nexus/factory-domain/core/errors'
import { newId } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { PRODUCT_STYLES_VIEW } from '@nexus/factory-domain/product/styles/permissions'
import { ORDERS_MANAGE, ORDERS_VIEW } from '@nexus/factory-domain/sales/orders/permissions'
import { QUOTES_MANAGE, QUOTES_VIEW, SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import { SEASON_LIMITS, SEASON_STATE_WORDS, seasonNotice, seasonProblems, seasonState, type SeasonFacts, type SeasonStatus } from '@nexus/factory-domain/sales/seasons/rules'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { officeContextOf } from '../orders/access'
import { serverClock } from '../../../core/time'
import { lockOrder, readOrder } from '../orders/store'
import { officeOrder } from '../orders/moves'
import { assertDraft } from '../quotes/quotes'
import { officeQuote, readCurrentVersion, readQuote } from '../quotes/store'
import { assertOpenSeason, SEASON_COLUMNS, seasonOr404, type Reader } from './store'
import { freezeSeasonSheets } from '../../costing/sheet-versions/approval'

/**
 * Seasons per company (B-W2b-303; SAL-277 "season on every order"; follow-up SO1:01 "Set season on a style picks from the
 * seasons list"). Office only.
 *
 *   GET  /sales/seasons                  the seasons of the companies the reader works in (orders.view, quotes.view,
 *                                        product.styles.view or sales.settings.manage over the company): code, name,
 *                                        dates, the order-book close, state in words, how many styles carry its code (W1's
 *                                        text: Set season on a style picks from this list), quotes and orders that name it
 *   GET  /sales/seasons/:seasonId        one season
 *   POST /sales/seasons                  sales.settings.manage over the company: a new season (code unique per company)
 *   PATCH /sales/seasons/:seasonId       {version, name?, startsOn?, endsOn?, orderBookClosesOn?, note?}: the code never changes
 *   POST …/close, …/reopen               {version}: CLOSED (no new quote or order names it) or OPEN again; never deleted
 *   PUT  /sales/quotes/:quoteId/season   quotes.manage: the quote's DRAFT version names an open season (or none)
 *   PUT  /sales/orders/:orderId/season   orders.manage: the order names an open season (or none) while it is open
 */

const READERS: readonly Permission[] = [ORDERS_VIEW, QUOTES_VIEW, PRODUCT_STYLES_VIEW, SALES_SETTINGS_MANAGE]

const officeOf = (caller: CommandCaller): OfficeContext => officeContextOf(caller)

const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
const mayRead = (context: OfficeContext, companyId: string): boolean => READERS.some((permission) => can(actorOf(context), permission, { companyId }))
const assertManage = (context: OfficeContext, companyId: string): void => {
  if (!can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })) throw new ForbiddenError()
}

type SeasonRow = Awaited<ReturnType<typeof seasonOr404>>

async function viewsOf(db: Reader, rows: readonly SeasonRow[], today: BusinessDate) {
  if (rows.length === 0) return []
  const ids = rows.map((row) => row.id)
  const quotes = await db.quoteVersion.groupBy({ by: ['seasonId'], where: { seasonId: { in: ids } }, _count: { _all: true } })
  const orders = await db.salesOrder.groupBy({ by: ['seasonId'], where: { seasonId: { in: ids } }, _count: { _all: true } })
  const companies = new Map((await db.company.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.companyId))] } }, select: { id: true, code: true } })).map((row) => [row.id, row.code]))
  const styles = await db.style.findMany({ where: { season: { in: rows.map((row) => row.code), mode: 'insensitive' } }, select: { season: true, companyId: true } })
  const names = new Map((await db.user.findMany({ where: { id: { in: rows.flatMap((row) => (row.closedById ? [row.closedById] : [])) } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
  return rows.map((row) => {
    const facts = { status: row.status as SeasonStatus, endsOn: dayOf(row.endsOn), orderBookClosesOn: row.orderBookClosesOn ? dayOf(row.orderBookClosesOn) : null }
    const state = seasonState(facts, today)
    return {
      id: row.id,
      companyId: row.companyId,
      company: { id: row.companyId, code: companies.get(row.companyId) ?? '' },
      code: row.code,
      name: row.name,
      startsOn: dayOf(row.startsOn),
      endsOn: facts.endsOn,
      orderBookClosesOn: facts.orderBookClosesOn,
      status: row.status as SeasonStatus,
      state,
      stateWords: SEASON_STATE_WORDS[state],
      notice: seasonNotice({ code: row.code, ...facts }, today),
      closedAt: row.closedAt ? toUtcIso(row.closedAt) : null,
      closedBy: row.closedById ? (names.get(row.closedById) ?? null) : null,
      note: row.note,
      styles: styles.filter((style) => style.season?.toLowerCase() === row.code.toLowerCase() && (style.companyId === null || style.companyId === row.companyId)).length,
      quoteVersions: quotes.find((entry) => entry.seasonId === row.id)?._count._all ?? 0,
      orders: orders.find((entry) => entry.seasonId === row.id)?._count._all ?? 0,
      version: row.version,
    }
  })
}

/** GET /sales/seasons */
export async function listSeasons(caller: CommandCaller, query: { readonly companyId?: string | undefined; readonly status?: SeasonStatus | 'ALL' | undefined; readonly q?: string | undefined }) {
  const context = officeOf(caller)
  const today = businessDate(serverClock.now())
  return caller.withClient(async (db) => {
    const status = query.status ?? 'ALL'
    const rows = await db.season.findMany({
      where: { ...(query.companyId ? { companyId: query.companyId } : {}), ...(status === 'ALL' ? {} : { status }), ...(query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {}) },
      orderBy: [{ startsOn: 'desc' }, { code: 'asc' }, { id: 'asc' }],
      take: SEASON_LIMITS.list,
      select: SEASON_COLUMNS,
    })
    const visible = rows.filter((row) => mayRead(context, row.companyId))
    return { seasons: await viewsOf(db, visible, today), mayManage: (query.companyId ? [query.companyId] : [...new Set(visible.map((row) => row.companyId))]).some((companyId) => can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId })) }
  })
}

async function readable(caller: CommandCaller, context: OfficeContext, seasonId: string) {
  const row = await caller.withClient((db) => seasonOr404(db, seasonId))
  if (!mayRead(context, row.companyId)) throw new DomainError('not_found', 'Season not found.')
  return row
}

/** GET /sales/seasons/:seasonId */
export async function getSeason(caller: CommandCaller, seasonId: string) {
  const context = officeOf(caller)
  const row = await readable(caller, context, seasonId)
  const [season] = await caller.withClient((db) => viewsOf(db, [row], businessDate(serverClock.now())))
  return { season: { ...season!, mayManage: can(actorOf(context), SALES_SETTINGS_MANAGE, { companyId: row.companyId }) } }
}

export interface SeasonBody {
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly startsOn: BusinessDate
  readonly endsOn: BusinessDate
  readonly orderBookClosesOn?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

const blank = (value: string | null | undefined): string | null => (value === null || value === undefined || value.trim() === '' ? null : value.trim())
const asDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)
const isUnique = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002' || (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode === '23505'
const sameCode = (code: string) => new DomainError('conflict', `The company has a season ${code} already: codes are unique per company.`, [{ path: 'body/code', message: 'One season per code and company.' }])
const invalid = (issues: { path: string; message: string }[]) => new ValidationError(issues.length === 1 ? issues[0]!.message : 'The season cannot be saved like this.', issues)

/** POST /sales/seasons */
export async function createSeason(caller: CommandCaller, body: SeasonBody, idempotencyKey?: string) {
  const context = officeOf(caller)
  assertManage(context, body.companyId)
  const facts: SeasonFacts = { code: body.code.trim(), name: body.name.trim(), startsOn: body.startsOn, endsOn: body.endsOn, orderBookClosesOn: body.orderBookClosesOn ?? null, note: blank(body.note) }
  const issues = seasonProblems({ ...facts, name: body.name })
  if (issues.length > 0) throw invalid(issues)
  let id: string
  try {
    const { result } = await command(caller, { name: 'seasons.create', idempotencyKey, input: body }, async (tools) => {
      const twin = await tools.tx.season.findFirst({ where: { companyId: body.companyId, code: { equals: facts.code, mode: 'insensitive' } }, select: { id: true } })
      if (twin) throw sameCode(facts.code)
      const seasonId = newId()
      await tools.tx.season.create({ data: { id: seasonId, companyId: body.companyId, code: facts.code, name: facts.name, startsOn: asDay(facts.startsOn), endsOn: asDay(facts.endsOn), orderBookClosesOn: facts.orderBookClosesOn ? asDay(facts.orderBookClosesOn) : null, note: facts.note, createdAt: tools.now, updatedAt: tools.now, createdById: context.actorId }, select: { id: true } })
      tools.audit({ action: 'seasons.create', recordType: 'Season', recordId: seasonId, companyId: body.companyId, after: { ...facts } })
      tools.emit({ type: 'season.changed', subject: seasonId, companyId: body.companyId, payload: { seasonId, companyId: body.companyId, code: facts.code, change: 'MADE' } })
      return { id: seasonId }
    })
    id = result.id
  } catch (error) {
    if (isUnique(error)) throw sameCode(facts.code)
    throw error
  }
  return getSeason(caller, id)
}

export interface SeasonPatch {
  readonly version: number
  readonly name?: string | undefined
  readonly startsOn?: BusinessDate | undefined
  readonly endsOn?: BusinessDate | undefined
  readonly orderBookClosesOn?: BusinessDate | null | undefined
  readonly note?: string | null | undefined
}

async function onSeason(caller: CommandCaller, seasonId: string, version: number, name: `seasons.${string}`, input: unknown, idempotencyKey: string | undefined, work: (tools: CommandTools, row: SeasonRow) => Promise<void>) {
  const context = officeOf(caller)
  const row = await readable(caller, context, seasonId)
  assertManage(context, row.companyId)
  await command(caller, { name, idempotencyKey, input, record: { type: 'Season', id: seasonId, expectedVersion: version } }, async (tools) => {
    const fresh = await seasonOr404(tools.tx, seasonId)
    await work(tools, fresh)
    return { seasonId }
  })
  return getSeason(caller, seasonId)
}

/** PATCH /sales/seasons/:seasonId */
export async function updateSeason(caller: CommandCaller, seasonId: string, body: SeasonPatch, idempotencyKey?: string) {
  const fields = (['name', 'startsOn', 'endsOn', 'orderBookClosesOn', 'note'] as const).filter((field) => body[field] !== undefined)
  if (fields.length === 0) throw new ValidationError('Nothing to change.', [{ path: 'body', message: 'Send at least one of name, startsOn, endsOn, orderBookClosesOn, note.' }])
  return onSeason(caller, seasonId, body.version, 'seasons.update', { seasonId, ...body }, idempotencyKey, async (tools, row) => {
    const before: SeasonFacts = { code: row.code, name: row.name, startsOn: dayOf(row.startsOn), endsOn: dayOf(row.endsOn), orderBookClosesOn: row.orderBookClosesOn ? dayOf(row.orderBookClosesOn) : null, note: row.note }
    const after: SeasonFacts = {
      code: row.code,
      name: body.name === undefined ? before.name : body.name.trim(),
      startsOn: body.startsOn ?? before.startsOn,
      endsOn: body.endsOn ?? before.endsOn,
      orderBookClosesOn: body.orderBookClosesOn === undefined ? before.orderBookClosesOn : body.orderBookClosesOn,
      note: body.note === undefined ? before.note : blank(body.note),
    }
    const issues = seasonProblems({ ...after, name: body.name ?? before.name })
    if (issues.length > 0) throw invalid(issues)
    await tools.tx.season.update({ where: { id: row.id }, data: { name: after.name, startsOn: asDay(after.startsOn), endsOn: asDay(after.endsOn), orderBookClosesOn: after.orderBookClosesOn ? asDay(after.orderBookClosesOn) : null, note: after.note, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: 'seasons.update', recordType: 'Season', recordId: row.id, companyId: row.companyId, before: { ...before }, after: { ...after } })
    tools.emit({ type: 'season.changed', subject: row.id, companyId: row.companyId, payload: { seasonId: row.id, companyId: row.companyId, code: row.code, change: 'CHANGED' } })
  })
}

/** POST /sales/seasons/:seasonId/close and …/reopen */
export async function moveSeason(caller: CommandCaller, seasonId: string, to: SeasonStatus, body: { readonly version: number }, idempotencyKey?: string) {
  return onSeason(caller, seasonId, body.version, to === 'CLOSED' ? 'seasons.close' : 'seasons.reopen', { seasonId, to, ...body }, idempotencyKey, async (tools, row) => {
    if (row.status === to) throw new InvalidStateError(to === 'CLOSED' ? `Season ${row.code} is closed already.` : `Season ${row.code} is open already.`)
    const actor = tools.context.audience === 'office' ? tools.context.actorId : null
    // B-W2b-420: the season's approved cost sheet versions frozen (SEASON_CLOSED), its drafts' requests for a yes sent back.
    if (to === 'CLOSED') await freezeSeasonSheets(tools, row.id)
    await tools.tx.season.update({ where: { id: row.id }, data: to === 'CLOSED' ? { status: 'CLOSED', closedAt: tools.now, closedById: actor, updatedAt: tools.now } : { status: 'OPEN', closedAt: null, closedById: null, updatedAt: tools.now }, select: { id: true } })
    tools.audit({ action: to === 'CLOSED' ? 'seasons.close' : 'seasons.reopen', recordType: 'Season', recordId: row.id, companyId: row.companyId, before: { status: row.status }, after: { status: to } })
    tools.emit({ type: 'season.changed', subject: row.id, companyId: row.companyId, payload: { seasonId: row.id, companyId: row.companyId, code: row.code, change: to === 'CLOSED' ? 'CLOSED' : 'REOPENED' } })
  })
}

// ---- the season of a quote and of an order --------------------------------------------------------------------------------

/** PUT /sales/quotes/:quoteId/season: the quote's DRAFT version names an open season of its company (null: none). */
export async function setQuoteSeason(caller: CommandCaller, quoteId: string, body: { readonly version: number; readonly seasonId: string | null }, idempotencyKey?: string) {
  const quote = await officeQuote(caller, quoteId, QUOTES_MANAGE)
  const { result } = await command(caller, { name: 'quotes.season', idempotencyKey, input: { quoteId, ...body }, record: { type: 'Quote', id: quote.id, expectedVersion: body.version } }, async (tools) => {
    const current = (await readQuote(tools.tx, quote.id))!
    const version = await readCurrentVersion(tools.tx, current)
    assertDraft(version)
    const season = await assertOpenSeason(tools.tx, body.seasonId, current.companyId)
    const before = (await tools.tx.quoteVersion.findUniqueOrThrow({ where: { id: version.id }, select: { seasonId: true } })).seasonId
    if (before !== (season?.id ?? null)) await tools.tx.quoteVersion.update({ where: { id: version.id }, data: { seasonId: season?.id ?? null }, select: { id: true } })
    tools.audit({ action: 'quotes.season', recordType: 'Quote', recordId: current.id, companyId: current.companyId, before: { versionId: version.id, seasonId: before }, after: { versionId: version.id, seasonId: season?.id ?? null } })
    tools.emit({ type: 'quote.season_changed', subject: current.id, companyId: current.companyId, payload: { quoteId: current.id, versionId: version.id, number: current.number, seasonId: season?.id ?? null, code: season?.code ?? null } })
    return { quoteId: current.id, versionId: version.id, seasonId: season?.id ?? null, code: season?.code ?? null }
  })
  return { season: result }
}

/** PUT /sales/orders/:orderId/season: the order names an open season of its company (null: none) while it is open. */
export async function setOrderSeason(caller: CommandCaller, orderId: string, body: { readonly version: number; readonly seasonId: string | null }, idempotencyKey?: string) {
  const order = await officeOrder(caller, orderId, ORDERS_MANAGE)
  const { result } = await command(caller, { name: 'orders.season', idempotencyKey, input: { orderId, ...body } }, async (tools) => {
    const locked = await lockOrder(tools.tx, order.id, body.version)
    if (locked.status === 'CLOSED' || locked.status === 'CANCELLED') throw new InvalidStateError(`${order.number} is ${locked.status}: its season stays as it was.`)
    const season = await assertOpenSeason(tools.tx, body.seasonId, order.companyId)
    const before = (await tools.tx.salesOrder.findUniqueOrThrow({ where: { id: order.id }, select: { seasonId: true } })).seasonId
    if (before !== (season?.id ?? null)) await tools.tx.salesOrder.update({ where: { id: order.id }, data: { seasonId: season?.id ?? null, updatedAt: tools.now, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ action: 'orders.season', recordType: 'SalesOrder', recordId: order.id, companyId: order.companyId, before: { seasonId: before }, after: { seasonId: season?.id ?? null } })
    tools.emit({ type: 'sales_order.season_changed', subject: order.id, companyId: order.companyId, payload: { orderId: order.id, number: order.number, seasonId: season?.id ?? null, code: season?.code ?? null } })
    return { orderId: order.id, seasonId: season?.id ?? null, code: season?.code ?? null }
  })
  const fresh = await caller.withClient((db) => readOrder(db, order.id))
  return { season: { ...result, version: fresh?.version ?? order.version } }
}
