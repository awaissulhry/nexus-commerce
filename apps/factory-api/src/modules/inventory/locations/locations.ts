import type { Prisma } from '@nexus/factory-db'
import { ConflictError, InvalidStateError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { archiveProblems, locationProblems, locationTree, normalizeLocationCode, wouldCycle, type LocationKind } from '@nexus/factory-domain/inventory/locations/rules'
import { INVENTORY_LOCATIONS_MANAGE, INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { mayAt, officeContextOf, postedBy, siteFor, stockContextOf, type SiteRow } from '../ledger/access'
import type { LocationView, SiteLocations } from './contract'

/**
 * The locations of each site (SCM-176, SCM-177, SCM-178; A2 SCR-065): the tree per site (office: every site its grants
 * reach; a floor device: its own site), and, for the office, create, rename (and retype), move in the tree and archive
 * (only when it holds no stock and nothing active sits inside it). Each write is one command() with its audit row,
 * checked here first with the domain's rules (factory-domain inventory/locations), then by the …_supply_guards trigger.
 * Reads name their columns (a floor role reads only what it is granted).
 */

export const LOCATION_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  parentId: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  version: true,
  createdAt: true,
  updatedAt: true,
} as const satisfies Prisma.LocationSelect
export type LocationRow = Prisma.LocationGetPayload<{ select: typeof LOCATION_SELECT }>

const audited = (row: LocationRow) => ({ siteId: row.siteId, parentId: row.parentId, code: row.code, name: row.name, kind: row.kind, status: row.status })

function viewOf(row: LocationRow & { depth: number; path: readonly string[] }): LocationView {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    parentId: row.parentId,
    code: row.code,
    name: row.name,
    kind: row.kind,
    status: row.status,
    depth: row.depth,
    path: [...row.path],
    version: row.version,
    createdAt: toUtcIso(row.createdAt),
    updatedAt: toUtcIso(row.updatedAt),
  }
}

/** One location in its site's tree (its depth and path), as the answers show it. */
async function placed(client: Pick<CommandTx, 'location'>, row: LocationRow): Promise<LocationView> {
  const site = await client.location.findMany({ where: { siteId: row.siteId }, select: { id: true, parentId: true, code: true } })
  const found = locationTree(site).find((entry) => entry.id === row.id)
  return viewOf({ ...row, depth: found?.depth ?? 0, path: found?.path ?? [row.code] })
}

export interface ListQuery {
  readonly siteId?: string | undefined
  readonly includeArchived?: boolean | undefined
}

/** The location trees the caller may see: a floor device its own site's, the office every site its grants reach. */
export async function listLocations(caller: CommandCaller, query: ListQuery): Promise<{ sites: SiteLocations[] }> {
  const context = stockContextOf(caller)
  const where: Prisma.LocationWhereInput = {
    AND: [
      scopeWhere(actorOf(context), INVENTORY_LOCATIONS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LocationWhereInput,
      query.siteId ? { siteId: query.siteId } : {},
      query.includeArchived ? {} : { status: 'ACTIVE' },
    ],
  }
  const { rows, sites } = await caller.withClient(async (client) => {
    const rows = await client.location.findMany({ where, select: LOCATION_SELECT, orderBy: [{ siteId: 'asc' }, { code: 'asc' }], take: 10_000 })
    const sites = await client.site.findMany({ where: { id: { in: [...new Set(rows.map((row) => row.siteId))] } }, select: { id: true, companyId: true, code: true, name: true } })
    return { rows, sites }
  })
  return {
    sites: sites
      .sort((a, b) => (a.code < b.code ? -1 : 1))
      .map((site) => ({ ...site, locations: locationTree(rows.filter((row) => row.siteId === site.id)).map(viewOf) })),
  }
}

/** A location the caller may see (floor: of its own site), or not found. */
export async function readLocation(caller: CommandCaller, locationId: string): Promise<LocationRow> {
  const context = stockContextOf(caller)
  const row = isUuid(locationId) ? await caller.withClient((client) => client.location.findUnique({ where: { id: locationId }, select: LOCATION_SELECT })) : null
  if (!row || !mayAt(context, INVENTORY_LOCATIONS_VIEW, row)) throw new NotFoundError('Location not found.')
  return row
}

const atBody = (issues: readonly Issue[]): Issue[] => issues.map((issue) => ({ path: `body/${issue.path}`, message: issue.message }))
const isUniqueViolation = (error: unknown): boolean => (error as { code?: unknown } | null)?.code === 'P2002'
const taken = (site: SiteRow, code: string) => new ConflictError(`Site ${site.code} already has a location ${code}.`)

/** The parent a location goes inside: an active location of the same site, not itself or one of its own. */
async function checkParent(client: Pick<CommandTx, 'location'>, site: SiteRow, parentId: string | null, locationId: string | null): Promise<void> {
  if (parentId === null) return
  const siteLocations = await client.location.findMany({ where: { siteId: site.id }, select: { id: true, parentId: true, code: true, status: true } })
  const parent = siteLocations.find((location) => location.id === parentId)
  const problem = !parent
    ? 'Not a location of this site.'
    : parent.status !== 'ACTIVE'
      ? `Location ${parent.code} is archived; nothing goes inside it.`
      : locationId && wouldCycle(locationId, parentId, siteLocations)
        ? 'A location does not sit inside itself or one of its own.'
        : null
  if (problem) throw new ValidationError('The parent is not valid.', [{ path: 'body/parentId', message: problem }])
}

export interface CreateInput {
  readonly siteId: string
  readonly parentId?: string | null | undefined
  readonly code: string
  readonly name: string
  readonly kind: LocationKind
}

/** inventory.locations.create */
export async function createLocation(caller: CommandCaller, input: CreateInput, idempotencyKey?: string): Promise<LocationView> {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, input.siteId, INVENTORY_LOCATIONS_MANAGE, 'body/siteId')
  const code = normalizeLocationCode(input.code)
  const name = input.name.trim()
  const problems = locationProblems({ code, name })
  if (problems.length > 0) throw new ValidationError('The location is not valid.', atBody(problems))
  const parentId = input.parentId ?? null
  try {
    const { result } = await command(caller, { name: 'inventory.locations.create', idempotencyKey, input }, async ({ tx, audit, now }) => {
      await checkParent(tx, site, parentId, null)
      if (await tx.location.findFirst({ where: { siteId: site.id, code }, select: { id: true } })) throw taken(site, code)
      const id = newId()
      const row = await tx.location.create({
        data: { id, companyId: site.companyId, siteId: site.id, parentId, code, name, kind: input.kind, createdAt: now, updatedAt: now, createdById: postedBy(context).createdById },
        select: LOCATION_SELECT,
      })
      audit({ recordType: 'Location', recordId: id, companyId: site.companyId, siteId: site.id, after: audited(row) })
      return placed(tx, row)
    })
    return result
  } catch (error) {
    if (isUniqueViolation(error)) throw taken(site, code)
    throw error
  }
}

/** The location's site, checked for inventory.locations.manage. */
async function manageable(caller: CommandCaller, locationId: string): Promise<{ row: LocationRow; site: SiteRow }> {
  officeContextOf(caller)
  const row = await readLocation(caller, locationId)
  const site = await siteFor(caller, row.siteId, INVENTORY_LOCATIONS_MANAGE)
  return { row, site }
}

export interface UpdateInput {
  readonly version: number
  readonly name?: string | undefined
  readonly kind?: LocationKind | undefined
}

/** inventory.locations.update: a new name or kind (the code never changes: it is on the labels). */
export async function updateLocation(caller: CommandCaller, locationId: string, input: UpdateInput, idempotencyKey?: string): Promise<LocationView> {
  const { row: before, site } = await manageable(caller, locationId)
  const name = input.name?.trim() ?? before.name
  const problems = locationProblems({ name })
  if (problems.length > 0) throw new ValidationError('The location is not valid.', atBody(problems))
  const { result } = await command(
    caller,
    { name: 'inventory.locations.update', idempotencyKey, input: { locationId, ...input }, record: { type: 'Location', id: locationId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      const row = await tx.location.update({ where: { id: locationId }, data: { name, kind: input.kind ?? before.kind }, select: LOCATION_SELECT })
      audit({ recordType: 'Location', recordId: locationId, companyId: site.companyId, siteId: site.id, before: audited(before), after: audited(row) })
      return placed(tx, row)
    },
  )
  return result
}

/** inventory.locations.move: puts a location inside another of its site (or at the top). */
export async function moveLocation(caller: CommandCaller, locationId: string, input: { readonly version: number; readonly parentId: string | null }, idempotencyKey?: string): Promise<LocationView> {
  const { row: before, site } = await manageable(caller, locationId)
  if (before.status !== 'ACTIVE') throw new InvalidStateError(`Location ${before.code} is archived; it is not moved.`)
  const { result } = await command(
    caller,
    { name: 'inventory.locations.move', idempotencyKey, input: { locationId, ...input }, record: { type: 'Location', id: locationId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      await checkParent(tx, site, input.parentId, locationId)
      const row = await tx.location.update({ where: { id: locationId }, data: { parentId: input.parentId }, select: LOCATION_SELECT })
      audit({ recordType: 'Location', recordId: locationId, companyId: site.companyId, siteId: site.id, before: { parentId: before.parentId }, after: { parentId: row.parentId } })
      return placed(tx, row)
    },
  )
  return result
}

/** The location holds stock: any stock key whose balance there is not 0. */
async function holdsStock(tx: Pick<CommandTx, 'stockMove'>, locationId: string): Promise<boolean> {
  // One query after another: `tx` may be a transaction's client (one connection; no Promise.all on it, B-W2a-11).
  const into = await tx.stockMove.groupBy({ by: ['itemId', 'itemColourId', 'lotId', 'hideId'], where: { toLocationId: locationId }, _sum: { baseQuantity: true } })
  const outOf = await tx.stockMove.groupBy({ by: ['itemId', 'itemColourId', 'lotId', 'hideId'], where: { fromLocationId: locationId }, _sum: { baseQuantity: true } })
  const key = (row: { itemId: string; itemColourId: string | null; lotId: string | null; hideId: string | null }) => `${row.itemId}|${row.itemColourId}|${row.lotId}|${row.hideId}`
  const out = new Map(outOf.map((row) => [key(row), row._sum.baseQuantity?.toString() ?? '0']))
  return into.some((row) => !(row._sum.baseQuantity?.minus(out.get(key(row)) ?? '0').isZero() ?? true))
}

/** inventory.locations.archive: only an empty location with nothing active inside it; archived for good. */
export async function archiveLocation(caller: CommandCaller, locationId: string, input: { readonly version: number }, idempotencyKey?: string): Promise<LocationView> {
  const { row: before, site } = await manageable(caller, locationId)
  const { result } = await command(
    caller,
    { name: 'inventory.locations.archive', idempotencyKey, input: { locationId, ...input }, record: { type: 'Location', id: locationId, expectedVersion: input.version } },
    async ({ tx, audit }) => {
      // The row is locked now (command()'s version bump): its status as it is.
      const { status } = await tx.location.findUniqueOrThrow({ where: { id: locationId }, select: { status: true } })
      const problems = archiveProblems({
        status,
        holdsStock: await holdsStock(tx, locationId),
        activeChildren: await tx.location.count({ where: { parentId: locationId, status: 'ACTIVE' } }),
      })
      if (problems.length > 0) throw new InvalidStateError(problems.join(' '))
      const row = await tx.location.update({ where: { id: locationId }, data: { status: 'ARCHIVED' }, select: LOCATION_SELECT })
      audit({ recordType: 'Location', recordId: locationId, companyId: site.companyId, siteId: site.id, before: { status: before.status }, after: { status: row.status } })
      return placed(tx, row)
    },
  )
  return result
}
