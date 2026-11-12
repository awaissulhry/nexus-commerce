import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { EMPTY_ITEM_PLANNING } from '@nexus/factory-domain/planning/settings/items'
import { PLANNING_STRATEGY_MANAGE } from '@nexus/factory-domain/planning/strategy/permissions'
import {
  effectiveStrategy,
  isStrategy,
  reasonProblem,
  STRATEGY_AUDIT_ACTION,
  STRATEGY_HINT,
  STRATEGY_ITEM_KINDS,
  STRATEGY_LIMITS,
  strategyItemProblem,
  type ProductionStrategy,
} from '@nexus/factory-domain/planning/strategy/rules'
import { command, StaleVersionError, type CommandCaller, type CommandTools } from '../../../core/command'
import { officeContextOf, siteFor } from '../access'
import { namesOf as userNamesOf } from '../milestones/store'
import { emitChange, lockKey } from '../settings/items'
import { siteViewOf } from '../settings/store'
import type { Reader, SiteRow } from '../store'
import type { BulkStrategyBody, SetStrategyBody, StrategyItemView, StrategyRowView } from './contract'

/**
 * The production strategy per item (B-W2b-319; PLN-061; design planning.mps sec:strategy "Item, strategy (inline Listbox,
 * autosave), reason, last changed" and "Bulk change with ReviewChangesModal"):
 *
 *   GET  /planning/strategy                  the site's finished garments and components (of its company or every company,
 *                                            ACTIVE), by code: each with its strategy (the every-colour ItemPlanning row's, else
 *                                            make to order), its rows, and the last change with its reason (planning.view)
 *   PUT  /planning/strategy/items/:itemId    one item (and colour): the cell's autosave, at the row's version (none: no row yet,
 *                                            one is made with the item's defaults); the same strategy again writes nothing
 *   POST /planning/strategy/bulk             up to 200 items in ONE command, all or nothing (every problem answered at once, 400
 *                                            `body/items/<i>/…`; a row changed since it was read: 409); the answer lists each
 *                                            item's from and to, so a review's Undo sends `from` back
 *
 * Writes: planning.strategy.manage over the site's company and the site. Under the item-planning lock of the site, item and colour
 * (settings/items.ts lockKey, so the item parameters' writes and these never cross); version compare-and-set on the row; one audit row
 * per row (action planning.setProductionStrategy, before and after, the reason) and planning.item_parameters_changed (CREATED |
 * EDITED), as the item parameters' writes emit. The database refuses a strategy on an item that is not FINISHED or COMPONENT
 * (B-W2b-286): it is refused here first, in words.
 */

const ITEM_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  colours: { where: { status: 'ACTIVE' }, select: { id: true, code: true, name: true }, orderBy: [{ code: 'asc' }, { id: 'asc' }] },
  variant: { select: { sku: true, size: true, styleId: true, colourway: { select: { id: true, code: true, name: true } } } },
} as const satisfies Prisma.ItemSelect
type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

const ROW_COLUMNS = { id: true, siteId: true, itemId: true, itemColourId: true, method: true, strategy: true, version: true, itemColour: { select: { id: true, code: true, name: true } } } as const satisfies Prisma.ItemPlanningSelect
type PlanningRow = Prisma.ItemPlanningGetPayload<{ select: typeof ROW_COLUMNS }>

type LastChange = StrategyRowView['lastChange']

/** The newest strategy change of each row (the audit trail), with who made it. */
async function lastChangesOf(db: Reader, siteId: string, rowIds: readonly string[]): Promise<Map<string, LastChange>> {
  const out = new Map<string, LastChange>()
  if (rowIds.length === 0) return out
  const audits = await db.auditLog.findMany({
    where: { action: STRATEGY_AUDIT_ACTION, recordType: 'ItemPlanning', recordId: { in: [...rowIds] }, siteId },
    select: { recordId: true, at: true, actorId: true, reason: true, before: true, after: true },
    orderBy: [{ at: 'desc' }, { id: 'desc' }],
  })
  const newest = audits.filter((row, index) => audits.findIndex((other) => other.recordId === row.recordId) === index)
  const names = await userNamesOf(db, newest.map((row) => row.actorId))
  const strategyIn = (value: Prisma.JsonValue | null): ProductionStrategy => effectiveStrategy(value && typeof value === 'object' && !Array.isArray(value) ? (value.strategy as string | null | undefined) : null)
  for (const row of newest) {
    out.set(row.recordId, { at: toUtcIso(row.at), by: names.has(row.actorId) ? { id: row.actorId, name: names.get(row.actorId)! } : null, from: strategyIn(row.before), to: strategyIn(row.after), reason: row.reason })
  }
  return out
}

const rowViewOf = (row: PlanningRow, last: ReadonlyMap<string, LastChange>): StrategyRowView => ({
  itemPlanningId: row.id,
  colour: row.itemColour,
  stored: isStrategy(row.strategy) ? row.strategy : null,
  strategy: effectiveStrategy(row.strategy),
  version: row.version,
  lastChange: last.get(row.id) ?? null,
})

async function styleRefsOf(db: Reader, items: readonly ItemRow[]): Promise<Map<string, { id: string; code: string; name: string }>> {
  const ids = [...new Set(items.flatMap((item) => (item.variant ? [item.variant.styleId] : [])))]
  return new Map((ids.length ? await db.style.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, name: true } }) : []).map((row) => [row.id, row]))
}

function itemViewOf(item: ItemRow, rows: readonly PlanningRow[], last: ReadonlyMap<string, LastChange>, styles: ReadonlyMap<string, { id: string; code: string; name: string }>): StrategyItemView {
  const colourCode = (row: PlanningRow) => (row.itemColour === null ? '' : `1${row.itemColour.code}`)
  const own = [...rows].sort((a, b) => (colourCode(a) < colourCode(b) ? -1 : colourCode(a) > colourCode(b) ? 1 : 0))
  const everyColour = own.find((row) => row.itemColourId === null) ?? null
  const style = item.variant ? styles.get(item.variant.styleId) : undefined
  return {
    item: { id: item.id, code: item.code, name: item.name, kind: item.kind as (typeof STRATEGY_ITEM_KINDS)[number] },
    sku: item.variant && style ? { sku: item.variant.sku, style, colourway: item.variant.colourway, size: item.variant.size } : null,
    strategy: effectiveStrategy(everyColour?.strategy),
    set: isStrategy(everyColour?.strategy),
    rows: own.map((row) => rowViewOf(row, last)),
    lastChange: everyColour ? (last.get(everyColour.id) ?? null) : null,
  }
}

export interface ListStrategyQuery {
  readonly siteId: string
  readonly q?: string | undefined
  readonly kind?: (typeof STRATEGY_ITEM_KINDS)[number] | undefined
  readonly strategy?: ProductionStrategy | undefined
  readonly styleId?: string | undefined
  readonly itemIds?: string | undefined
  readonly set?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit?: number | undefined
}

/** GET /planning/strategy. */
export async function listStrategy(caller: CommandCaller, query: ListStrategyQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  const itemIds = query.itemIds ? [...new Set(query.itemIds.split(',').map((value) => value.trim()).filter(Boolean))] : undefined
  if (itemIds && (itemIds.length > STRATEGY_LIMITS.bulk || itemIds.some((value) => !isUuid(value)))) {
    throw new ValidationError('Name at most 200 items by their ids.', [{ path: 'querystring/itemIds', message: `Comma-separated item ids, at most ${STRATEGY_LIMITS.bulk}.` }])
  }
  const limit = query.limit ?? STRATEGY_LIMITS.page.default
  return caller.withClient(async (db) => {
    const everyColourAt = (strategies: ProductionStrategy[]): Prisma.ItemWhereInput => ({ itemPlannings: { some: { siteId: site.id, itemColourId: null, strategy: { in: strategies } } } })
    const strategyWhere: Prisma.ItemWhereInput =
      query.strategy === undefined ? {} : query.strategy === 'MAKE_TO_ORDER' ? { NOT: everyColourAt(['MAKE_TO_STOCK', 'ASSEMBLE_TO_ORDER']) } : everyColourAt([query.strategy])
    const setWhere: Prisma.ItemWhereInput =
      query.set === undefined ? {} : query.set ? { itemPlannings: { some: { siteId: site.id, itemColourId: null, strategy: { not: null } } } } : { NOT: { itemPlannings: { some: { siteId: site.id, itemColourId: null, strategy: { not: null } } } } }
    const where: Prisma.ItemWhereInput = {
      AND: [
        { status: 'ACTIVE', kind: query.kind ? query.kind : { in: [...STRATEGY_ITEM_KINDS] }, OR: [{ companyId: null }, { companyId: site.companyId }] },
        itemIds ? { id: { in: itemIds } } : {},
        query.styleId ? { variant: { is: { styleId: query.styleId } } } : {},
        query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }, { variant: { is: { sku: { contains: query.q, mode: 'insensitive' } } } }] } : {},
        strategyWhere,
        setWhere,
      ],
    }
    const page = await db.item.findMany({ where, select: ITEM_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) })
    const shown = page.slice(0, limit)
    const rows = shown.length ? await db.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: shown.map((item) => item.id) } }, select: ROW_COLUMNS, orderBy: [{ itemId: 'asc' }, { id: 'asc' }] }) : []
    const last = await lastChangesOf(db, site.id, rows.map((row) => row.id))
    const styles = await styleRefsOf(db, shown)
    return {
      site: siteViewOf(site),
      items: shown.map((item) => itemViewOf(item, rows.filter((row) => row.itemId === item.id), last, styles)),
      nextCursor: page.length > limit ? shown[shown.length - 1]!.id : null,
      hint: STRATEGY_HINT,
    }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------------------

interface Asked {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly strategy: ProductionStrategy
  readonly version: number | undefined
}

interface Planned {
  readonly asked: Asked
  readonly item: ItemRow
  readonly row: PlanningRow | null
  readonly from: ProductionStrategy
}

/** What one item asks, checked inside the command (400 issues at `prefix`; a row changed or made since it was read: 409). */
async function planOne(tx: Reader, site: SiteRow, asked: Asked, prefix: string, problems: Issue[]): Promise<Planned | null> {
  const item = await tx.item.findUnique({ where: { id: asked.itemId }, select: ITEM_COLUMNS })
  if (!item || (item.companyId !== null && item.companyId !== site.companyId)) {
    problems.push({ path: `${prefix}itemId`, message: 'No such item for this site: choose an item of the site’s company.' })
    return null
  }
  const itemProblem = strategyItemProblem(item, `${prefix}itemId`)
  if (itemProblem) {
    problems.push(itemProblem)
    return null
  }
  if (asked.itemColourId !== null && !item.colours.some((colour) => colour.id === asked.itemColourId)) {
    problems.push({ path: `${prefix}itemColourId`, message: `No such colour of ${item.code}: choose one of its active colours, or none for every colour.` })
    return null
  }
  const row = await tx.itemPlanning.findFirst({ where: { siteId: site.id, itemId: item.id, itemColourId: asked.itemColourId }, select: ROW_COLUMNS })
  if (row && asked.version === undefined) throw new ConflictError(`${item.code} got its planning at this site since you looked (version ${row.version}): read it again.`)
  if (!row && asked.version !== undefined) throw new ConflictError(`The planning of ${item.code} at this site was removed since you looked: read it again.`)
  if (row && row.version !== asked.version) throw new StaleVersionError('ItemPlanning', row.id, row.version, asked.version!)
  return { asked, item, row, from: effectiveStrategy(row?.strategy) }
}

/** Writes one planned change (the caller holds the lock): the row made or changed at its version, its audit row and event. */
async function writeOne(tools: CommandTools, site: SiteRow, actorId: string, plan: Planned, reason: string | undefined): Promise<{ change: 'CREATED' | 'EDITED' | 'UNCHANGED'; row: PlanningRow }> {
  const { tx } = tools
  if (plan.from === plan.asked.strategy) return { change: 'UNCHANGED', row: plan.row! }
  if (plan.row) {
    const { count } = await tx.itemPlanning.updateMany({ where: { id: plan.row.id, version: plan.row.version }, data: { strategy: plan.asked.strategy, version: plan.row.version + 1 } })
    if (count !== 1) throw new StaleVersionError('ItemPlanning', plan.row.id, plan.row.version + 1, plan.row.version)
    const after = (await tx.itemPlanning.findUnique({ where: { id: plan.row.id }, select: ROW_COLUMNS }))!
    tools.audit({ action: STRATEGY_AUDIT_ACTION, recordType: 'ItemPlanning', recordId: after.id, companyId: site.companyId, siteId: site.id, before: { strategy: plan.row.strategy }, after: { strategy: after.strategy }, ...(reason ? { reason } : {}) })
    emitChange(tools, after, site, after.method, 'EDITED')
    return { change: 'EDITED', row: after }
  }
  const id = newId()
  await tx.itemPlanning.create({ data: { id, companyId: site.companyId, siteId: site.id, itemId: plan.item.id, itemColourId: plan.asked.itemColourId, ...EMPTY_ITEM_PLANNING, strategy: plan.asked.strategy, createdById: actorId }, select: { id: true } })
  const made = (await tx.itemPlanning.findUnique({ where: { id }, select: ROW_COLUMNS }))!
  tools.audit({ action: STRATEGY_AUDIT_ACTION, recordType: 'ItemPlanning', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: { itemId: plan.item.id, itemColourId: plan.asked.itemColourId, method: made.method, strategy: made.strategy }, ...(reason ? { reason } : {}) })
  emitChange(tools, made, site, made.method, 'CREATED')
  return { change: 'CREATED', row: made }
}

function refuseAll(problems: readonly Issue[], what: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : `${what}: ${problems.length} problems; nothing was saved.`, problems)
}

async function writableSite(caller: CommandCaller, siteId: string): Promise<SiteRow> {
  const site = await siteFor(caller, siteId, PLANNING_STRATEGY_MANAGE)
  if (site.status !== 'ACTIVE') throw new InvalidStateError('This site is archived: its planning cannot change.')
  return site
}

/** PUT /planning/strategy/items/:itemId. */
export async function setStrategy(caller: CommandCaller, itemId: string, body: SetStrategyBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await writableSite(caller, body.siteId)
  refuseAll([reasonProblem(body.reason)].filter((issue): issue is Issue => issue !== null), 'The strategy cannot be saved this way')
  const reason = body.reason?.trim()
  const asked: Asked = { itemId, itemColourId: body.itemColourId ?? null, strategy: body.strategy, version: body.version }
  // The same strategy again writes nothing (and needs no receipt): the cell's answer is the row as it is.
  const before = await caller.withClient(async (db) => {
    const item = await db.item.findUnique({ where: { id: itemId }, select: { id: true } })
    if (!item) throw new NotFoundError('Item not found.')
    return db.itemPlanning.findFirst({ where: { siteId: site.id, itemId, itemColourId: asked.itemColourId }, select: ROW_COLUMNS })
  })
  if (effectiveStrategy(before?.strategy) === asked.strategy && (before === null ? asked.version === undefined : before.version === asked.version)) {
    if (before === null) {
      // Nothing to make: an item without a row is already made to order. Its checks still answer in words.
      const problems: Issue[] = []
      await caller.withClient((db) => planOne(db, site, asked, 'body/', problems))
      refuseAll(problems, 'The strategy cannot be saved this way')
      return { row: null, change: 'UNCHANGED' as const, from: asked.strategy, replayed: false }
    }
    const last = await caller.withClient((db) => lastChangesOf(db, site.id, [before.id]))
    return { row: rowViewOf(before, last), change: 'UNCHANGED' as const, from: asked.strategy, replayed: false }
  }
  const { result, replayed } = await command(caller, { name: 'planning.setProductionStrategy', idempotencyKey, input: { itemId, ...body } }, async (tools) => {
    await lockKey(tools.tx, context.tenantId, site, itemId, asked.itemColourId)
    const problems: Issue[] = []
    const plan = await planOne(tools.tx, site, asked, 'body/', problems)
    refuseAll(problems, 'The strategy cannot be saved this way')
    const written = await writeOne(tools, site, context.actorId, plan!, reason)
    if (written.change === 'UNCHANGED') {
      // command() records at least one audit row: a change that found it so already says so, on the site (never read back as a
      // change of the row).
      tools.audit({ recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, before: null, after: { itemPlanningId: written.row.id, unchanged: written.row.strategy } })
    }
    return { rowId: written.row.id, change: written.change, from: plan!.from }
  })
  const view = await caller.withClient(async (db) => {
    const row = (await db.itemPlanning.findUnique({ where: { id: result.rowId }, select: ROW_COLUMNS }))!
    return rowViewOf(row, await lastChangesOf(db, site.id, [row.id]))
  })
  return { row: view, change: result.change, from: result.from, replayed }
}

/** POST /planning/strategy/bulk. */
export async function bulkStrategy(caller: CommandCaller, body: BulkStrategyBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await writableSite(caller, body.siteId)
  const shape: Issue[] = []
  const reasonIssue = reasonProblem(body.reason)
  if (reasonIssue) shape.push(reasonIssue)
  const keys = body.items.map((item) => `${item.itemId}|${item.itemColourId ?? '*'}`)
  if (new Set(keys).size !== keys.length) shape.push({ path: 'body/items', message: 'An item (and colour) is named twice: name each once.' })
  refuseAll(shape, 'The bulk change is not valid')
  const reason = body.reason?.trim()
  const { result, replayed } = await command(caller, { name: 'planning.bulkProductionStrategy', idempotencyKey, input: body }, async (tools) => {
    // Locks in one order (item, then colour), so two bulk changes never wait on each other in a circle.
    const order = body.items.map((item, index) => ({ item, index })).sort((a, b) => (keys[a.index]! < keys[b.index]! ? -1 : keys[a.index]! > keys[b.index]! ? 1 : 0))
    for (const { item } of order) await lockKey(tools.tx, context.tenantId, site, item.itemId, item.itemColourId ?? null)
    const problems: Issue[] = []
    const plans: { index: number; plan: Planned }[] = []
    for (const [index, item] of body.items.entries()) {
      const plan = await planOne(tools.tx, site, { itemId: item.itemId, itemColourId: item.itemColourId ?? null, strategy: item.strategy, version: item.version }, `body/items/${index}/`, problems)
      if (plan) plans.push({ index, plan })
    }
    refuseAll(problems, 'The strategies cannot be saved this way')
    const out: { index: number; itemId: string; itemColourId: string | null; change: 'CREATED' | 'EDITED' | 'UNCHANGED'; from: ProductionStrategy; to: ProductionStrategy; rowId: string | null }[] = []
    for (const { index, plan } of plans) {
      if (plan.from === plan.asked.strategy) {
        out.push({ index, itemId: plan.item.id, itemColourId: plan.asked.itemColourId, change: 'UNCHANGED', from: plan.from, to: plan.from, rowId: plan.row?.id ?? null })
        continue
      }
      const written = await writeOne(tools, site, context.actorId, plan, reason)
      out.push({ index, itemId: plan.item.id, itemColourId: plan.asked.itemColourId, change: written.change, from: plan.from, to: plan.asked.strategy, rowId: written.row.id })
    }
    if (out.every((entry) => entry.change === 'UNCHANGED')) {
      tools.audit({ action: 'planning.bulkProductionStrategy', recordType: 'Site', recordId: site.id, companyId: site.companyId, siteId: site.id, before: null, after: { unchanged: out.length } })
    }
    return { changes: out }
  })
  const rowIds = result.changes.flatMap((entry) => (entry.rowId ? [entry.rowId] : []))
  const views = await caller.withClient(async (db) => {
    const rows = rowIds.length ? await db.itemPlanning.findMany({ where: { id: { in: rowIds } }, select: ROW_COLUMNS }) : []
    const last = await lastChangesOf(db, site.id, rows.map((row) => row.id))
    return new Map(rows.map((row) => [row.id, rowViewOf(row, last)]))
  })
  const changes = result.changes.map((entry) => ({ index: entry.index, itemId: entry.itemId, itemColourId: entry.itemColourId, change: entry.change, from: entry.from, to: entry.to, row: entry.rowId ? (views.get(entry.rowId) ?? null) : null }))
  return { changes, changed: result.changes.filter((entry) => entry.change !== 'UNCHANGED').length, replayed }
}
