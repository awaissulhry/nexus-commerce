import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { PLANNING_VIEW } from '@nexus/factory-domain/planning/permissions'
import { PLANNING_ITEMS_MANAGE } from '@nexus/factory-domain/planning/settings/permissions'
import { itemPlanningProblems, mergeItemPlanning, REORDER_METHODS, type ItemPlanningPatch, type ItemPlanningValues } from '@nexus/factory-domain/planning/settings/items'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { assertMayAt, officeContextOf, siteFor } from '../access'
import { SITE_COLUMNS, type Reader, type SiteRow } from '../store'
import type { CreateItemParametersBody, EditItemParametersBody } from './contract'
import { auditValuesOf, ITEM_PLANNING_SELECT, ITEM_SELECT, itemDefaultsOf, itemParametersViewOf, itemPlanningValuesOf, readItemPlanning, siteViewOf, storedAnswer, type ItemPlanningRow, type ItemRow } from './store'

/**
 * Item planning parameters (B-W2a-16; PLN-005) and reorder rules (PLN-099; design planning.settings "Item parameters",
 * "Reorder rules"): how a site plans each item and colour. Read with planning.view, kept with planning.items.manage over
 * the site's company and the site. One row per site, item and colour (null: every colour) is this module's rule: the
 * create takes an advisory lock on the key, then looks. Every write is ONE command (a create, or the row's version bump
 * for a change or a removal): audited before and after, and planning.item_parameters_changed. The values follow
 * factory-domain planning/settings/items (method exactness, ranges, BASE unit), and the facts are checked here, in the
 * command: an ACTIVE item of the site's company (or of every company) and one of its colours; a preferred supplier that
 * is an active supplier and an approved source of the item (its default supplier, or an ACTIVE supplier item for the
 * colour or every colour, of the site's company or every company); a make site that is an ACTIVE plant of the company.
 */

const ITEM_FIELDS = Object.keys({
  method: 0,
  source: 0,
  supplierId: 0,
  makeSiteId: 0,
  buyLeadTimeDays: 0,
  makeLeadTimeDays: 0,
  safetyLeadTimeDays: 0,
  safetyStock: 0,
  reorderPoint: 0,
  lotSize: 0,
  minStock: 0,
  maxStock: 0,
  minOrderQty: 0,
  orderMultiple: 0,
  maxOrderQty: 0,
  note: 0,
} satisfies Record<keyof ItemPlanningValues, 0>) as (keyof ItemPlanningValues)[]

const patchOf = (body: Partial<Record<keyof ItemPlanningValues, unknown>>): ItemPlanningPatch => {
  const patch: Record<string, unknown> = {}
  for (const key of ITEM_FIELDS) if (body[key] !== undefined) patch[key] = key === 'note' && body[key] === '' ? null : body[key]
  return patch as ItemPlanningPatch
}

function refuse(problems: readonly Issue[], message: string): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : message, problems)
}

const readItem = (db: Reader, itemId: string): Promise<ItemRow | null> => db.item.findUnique({ where: { id: itemId }, select: ITEM_SELECT })

/** An ACTIVE item the site may plan: of its company, or of every company. */
function assertItemAt(item: ItemRow | null, site: SiteRow, path = 'body/itemId'): asserts item is ItemRow {
  if (!item || (item.companyId !== null && item.companyId !== site.companyId)) throw new ValidationError('No such item for this site.', [{ path, message: 'Choose an item of the site’s company.' }])
  if (item.status !== 'ACTIVE') throw new ValidationError('This item is archived: archived items are not planned.', [{ path, message: 'The item is archived.' }])
}

/** The facts a row's values name: the supplier and make site, checked in words (400) inside the command. */
async function factProblems(tx: Reader, site: SiteRow, item: ItemRow, itemColourId: string | null, values: ItemPlanningValues, before: ItemPlanningValues | null): Promise<Issue[]> {
  const problems: Issue[] = []
  if (values.supplierId !== null && values.supplierId !== before?.supplierId) {
    const party = await tx.party.findUnique({ where: { id: values.supplierId }, select: { id: true, roles: true, status: true } })
    if (!party || !party.roles.includes('SUPPLIER')) problems.push({ path: 'body/supplierId', message: 'The preferred supplier is a party with the supplier role.' })
    else if (party.status !== 'ACTIVE') problems.push({ path: 'body/supplierId', message: `This supplier is ${party.status.toLowerCase()}: choose an active one.` })
    else if (item.defaultSupplierId !== party.id) {
      const source = await tx.supplierItem.findFirst({
        where: {
          partyId: party.id,
          itemId: item.id,
          status: 'ACTIVE',
          AND: [{ OR: [{ companyId: null }, { companyId: site.companyId }] }, itemColourId === null ? {} : { OR: [{ itemColourId: null }, { itemColourId }] }],
        },
        select: { id: true },
      })
      if (!source) problems.push({ path: 'body/supplierId', message: 'This supplier is not an approved source of the item: add it to the item’s suppliers first, or choose the item’s default supplier.' })
    }
  }
  if (values.makeSiteId !== null && values.makeSiteId !== before?.makeSiteId) {
    const plant = await tx.site.findUnique({ where: { id: values.makeSiteId }, select: { companyId: true, kind: true, status: true } })
    if (!plant || plant.companyId !== site.companyId) problems.push({ path: 'body/makeSiteId', message: 'The make site is a plant of the same company.' })
    else if (plant.kind !== 'PLANT') problems.push({ path: 'body/makeSiteId', message: `The make site is a plant, not a ${plant.kind.toLowerCase()}.` })
    else if (plant.status !== 'ACTIVE') problems.push({ path: 'body/makeSiteId', message: 'The make site is archived.' })
  }
  return problems
}

/** The row, when the caller sees its site (else 404) and holds `permission` there (else 403). */
async function rowFor(caller: CommandCaller, itemPlanningId: string, permission: typeof PLANNING_VIEW | typeof PLANNING_ITEMS_MANAGE): Promise<{ row: ItemPlanningRow; site: SiteRow }> {
  const context = officeContextOf(caller)
  const found = isUuid(itemPlanningId)
    ? await caller.withClient(async (client) => {
        const row = await readItemPlanning(client, itemPlanningId)
        const site = row ? await client.site.findUnique({ where: { id: row.siteId }, select: SITE_COLUMNS }) : null
        return row && site ? { row, site } : null
      })
    : null
  assertMayAt(context, permission, found ? { companyId: found.site.companyId, siteId: found.site.id } : null, 'Item parameters')
  return found!
}

const lockKey = (tx: CommandTx, tenantId: string, site: SiteRow, itemId: string, itemColourId: string | null) =>
  tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.item-planning', ${tenantId}::uuid, ${site.id}::uuid, ${itemId}::uuid, ${itemColourId ?? '*'}::text), 0))`

function emitChange(tools: { emit: (event: { type: string; subject: string; companyId: string; siteId: string; payload: unknown }) => void }, row: { id: string; siteId: string; itemId: string; itemColourId: string | null }, site: SiteRow, method: string, change: 'CREATED' | 'EDITED' | 'DELETED'): void {
  tools.emit({ type: 'planning.item_parameters_changed', subject: row.id, companyId: site.companyId, siteId: site.id, payload: { itemPlanningId: row.id, siteId: site.id, itemId: row.itemId, itemColourId: row.itemColourId, method, change } })
}

// ---- reads ----------------------------------------------------------------------------------------------------------------

export interface ListItemParametersQuery {
  readonly siteId: string
  readonly q?: string | undefined
  readonly kind?: Prisma.ItemWhereInput['kind'] & string | undefined
  readonly method?: ItemPlanningValues['method'] | undefined
  readonly configured?: boolean | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

/**
 * planning.view: the "Item parameters" grid of a site: every ACTIVE item it may plan (its company's and every
 * company's), by code, each with its own terms (the defaults) and the site's rows (every colour first, then per colour).
 */
export async function listItemParameters(caller: CommandCaller, query: ListItemParametersQuery) {
  const site = await siteFor(caller, query.siteId, PLANNING_VIEW)
  return caller.withClient(async (client) => {
    const atSite: Prisma.ItemPlanningWhereInput = { siteId: site.id, ...(query.method ? { method: query.method } : {}) }
    const where: Prisma.ItemWhereInput = {
      AND: [
        { status: 'ACTIVE', OR: [{ companyId: null }, { companyId: site.companyId }] },
        query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { name: { contains: query.q, mode: 'insensitive' } }] } : {},
        query.kind ? { kind: query.kind } : {},
        query.method || query.configured === true ? { itemPlannings: { some: atSite } } : query.configured === false ? { itemPlannings: { none: { siteId: site.id } } } : {},
      ],
    }
    const page = await client.item.findMany({
      where,
      select: ITEM_SELECT,
      orderBy: [{ code: 'asc' }, { id: 'asc' }],
      take: query.limit + 1,
      ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}),
    })
    const shown = page.slice(0, query.limit)
    const rows = shown.length
      ? await client.itemPlanning.findMany({ where: { siteId: site.id, itemId: { in: shown.map((item) => item.id) } }, select: ITEM_PLANNING_SELECT, orderBy: [{ itemId: 'asc' }, { id: 'asc' }] })
      : []
    const colourOrder = (row: ItemPlanningRow) => (row.itemColour === null ? '' : `1${row.itemColour.code}`)
    return {
      site: siteViewOf(site),
      items: shown.map((item) => ({
        item: { id: item.id, code: item.code, name: item.name, kind: item.kind, tracking: item.tracking, baseUom: item.baseUom, colours: item.colours },
        defaults: itemDefaultsOf(item),
        parameters: rows
          .filter((row) => row.itemId === item.id)
          .sort((a, b) => (colourOrder(a) < colourOrder(b) ? -1 : colourOrder(a) > colourOrder(b) ? 1 : 0))
          .map(itemParametersViewOf),
      })),
      nextCursor: page.length > query.limit ? shown[shown.length - 1]!.id : null,
    }
  })
}

/** planning.view: one row, with the item's own terms. */
export async function getItemParameters(caller: CommandCaller, itemPlanningId: string) {
  const { row } = await rowFor(caller, itemPlanningId, PLANNING_VIEW)
  const item = await caller.withClient((client) => readItem(client, row.itemId))
  return { parameters: itemParametersViewOf(row), defaults: itemDefaultsOf(item!) }
}

/** planning.view: the "Reorder rules" grid: the site's rows planned by a reorder point or min/max, by item code. */
export async function reorderRules(caller: CommandCaller, siteId: string) {
  const site = await siteFor(caller, siteId, PLANNING_VIEW)
  return caller.withClient(async (client) => {
    const rows = await client.itemPlanning.findMany({
      where: { siteId: site.id, method: { in: [...REORDER_METHODS] } },
      select: ITEM_PLANNING_SELECT,
      orderBy: [{ item: { code: 'asc' } }, { id: 'asc' }],
      take: 2000,
    })
    return { site: siteViewOf(site), rules: rows.map(itemParametersViewOf) }
  })
}

// ---- writes ---------------------------------------------------------------------------------------------------------------

/**
 * planning.items.manage: how the site plans an item (and colour) from now on. 409 when the site already has a row for
 * the item and colour (change that one); 400 in words for a rule the values or their facts break.
 */
export async function createItemParameters(caller: CommandCaller, body: CreateItemParametersBody, idempotencyKey?: string) {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, PLANNING_ITEMS_MANAGE)
  if (site.status !== 'ACTIVE') throw new InvalidStateError('This site is archived: its planning cannot change.')
  const itemColourId = body.itemColourId ?? null
  const { values, cleared } = mergeItemPlanning(null, patchOf(body))
  refuse(itemPlanningProblems(values), 'The item parameters cannot be saved this way.')
  const { result } = await command(caller, { name: 'planning.createItemParameters', idempotencyKey, input: body }, async (tools) => {
    const item = await readItem(tools.tx, body.itemId)
    assertItemAt(item, site)
    if (itemColourId !== null && !item.colours.some((colour) => colour.id === itemColourId)) {
      throw new ValidationError('No such colour of this item.', [{ path: 'body/itemColourId', message: 'Choose one of the item’s active colours, or none for every colour.' }])
    }
    await lockKey(tools.tx, context.tenantId, site, item.id, itemColourId)
    const taken = await tools.tx.itemPlanning.findFirst({ where: { siteId: site.id, itemId: item.id, itemColourId }, select: { id: true } })
    if (taken) throw new ConflictError(`This site already plans ${item.code}${itemColourId ? ' in this colour' : ' (every colour)'} with item parameters ${taken.id}; change those instead.`)
    refuse(await factProblems(tools.tx, site, item, itemColourId, values, null), 'The item parameters name what cannot be used.')
    const id = newId()
    await tools.tx.itemPlanning.create({ data: { id, companyId: site.companyId, siteId: site.id, itemId: item.id, itemColourId, ...values, createdById: context.actorId }, select: { id: true } })
    const row = (await readItemPlanning(tools.tx, id))!
    tools.audit({ recordType: 'ItemPlanning', recordId: id, companyId: site.companyId, siteId: site.id, before: null, after: { itemId: item.id, itemColourId, ...auditValuesOf(itemPlanningValuesOf(row)) } })
    emitChange(tools, row, site, row.method, 'CREATED')
    return { parameters: itemParametersViewOf(row), cleared: cleared as string[] }
  })
  return result
}

/**
 * planning.items.manage: changes the fields sent at the version read. A change of method clears the old method's own
 * fields it does not name (and a change of source the supplier or make site): `cleared` says which. The same values
 * again change nothing.
 */
export async function editItemParameters(caller: CommandCaller, itemPlanningId: string, body: EditItemParametersBody, idempotencyKey?: string) {
  const { row, site } = await rowFor(caller, itemPlanningId, PLANNING_ITEMS_MANAGE)
  const current = itemPlanningValuesOf(row)
  const { values } = mergeItemPlanning(current, patchOf(body))
  refuse(itemPlanningProblems(values), 'The item parameters cannot be saved this way.')
  const changed = ITEM_FIELDS.filter((key) => values[key] !== current[key])
  if (changed.length === 0 && body.version === row.version) {
    const replay = await storedAnswer<{ parameters: ReturnType<typeof itemParametersViewOf>; cleared: string[] }>(caller, { name: 'planning.editItemParameters', idempotencyKey, input: { itemPlanningId, ...body } }, [{ type: 'ItemPlanning', id: row.id, expectedVersion: body.version }])
    return replay ?? { parameters: itemParametersViewOf(row), cleared: [] as string[] }
  }
  const { result } = await command(
    caller,
    { name: 'planning.editItemParameters', idempotencyKey, input: { itemPlanningId, ...body }, record: { type: 'ItemPlanning', id: row.id, expectedVersion: body.version } },
    async (tools) => {
      const before = (await readItemPlanning(tools.tx, row.id))!
      const from = itemPlanningValuesOf(before)
      const next = mergeItemPlanning(from, patchOf(body))
      refuse(itemPlanningProblems(next.values), 'The item parameters cannot be saved this way.')
      const item = await readItem(tools.tx, before.itemId)
      refuse(await factProblems(tools.tx, site, item!, before.itemColourId, next.values, from), 'The item parameters name what cannot be used.')
      await tools.tx.itemPlanning.update({ where: { id: row.id }, data: next.values, select: { id: true } })
      const after = (await readItemPlanning(tools.tx, row.id))!
      tools.audit({ recordType: 'ItemPlanning', recordId: row.id, companyId: site.companyId, siteId: site.id, before: auditValuesOf(from), after: auditValuesOf(itemPlanningValuesOf(after)) })
      emitChange(tools, after, site, after.method, 'EDITED')
      return { parameters: itemParametersViewOf(after), cleared: next.cleared as string[] }
    },
  )
  return result
}

/** planning.items.manage: removes the row at the version read; the item is planned by its defaults (or its other row) again. */
export async function deleteItemParameters(caller: CommandCaller, itemPlanningId: string, body: { version: number }, idempotencyKey?: string) {
  const { row, site } = await rowFor(caller, itemPlanningId, PLANNING_ITEMS_MANAGE)
  const { result } = await command(
    caller,
    { name: 'planning.deleteItemParameters', idempotencyKey, input: { itemPlanningId, ...body }, record: { type: 'ItemPlanning', id: row.id, expectedVersion: body.version } },
    async (tools) => {
      const before = (await readItemPlanning(tools.tx, row.id))!
      await tools.tx.itemPlanning.delete({ where: { id: row.id }, select: { id: true } })
      tools.audit({ recordType: 'ItemPlanning', recordId: row.id, companyId: site.companyId, siteId: site.id, before: { itemId: before.itemId, itemColourId: before.itemColourId, ...auditValuesOf(itemPlanningValuesOf(before)) }, after: null })
      emitChange(tools, before, site, before.method, 'DELETED')
      return { deleted: row.id, siteId: site.id, itemId: before.itemId }
    },
  )
  return result
}
