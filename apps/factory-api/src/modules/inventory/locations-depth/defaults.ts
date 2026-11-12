import type { Prisma } from '@nexus/factory-db'
import { ConflictError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { defaultProblems, resolveDefault, type DefaultPurpose, type DefaultRow } from '@nexus/factory-domain/inventory/locations-depth/defaults'
import type { HeldItemKind } from '@nexus/factory-domain/inventory/locations-depth/kinds'
import { INVENTORY_LOCATIONS_MANAGE, INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { command, type CommandCaller, type CommandTx } from '../../../core/command'
import { officeContextOf, siteFor } from '../ledger/access'
import type { DefaultView } from './contract'

/**
 * Default locations (B-W2b-289; SCM-179; design warehouse.settings › Default locations: material type × purpose →
 * location). Per site, per kind of material (null: the site's fallback) and purpose (RECEIVING, QUALITY, ISSUE, RETURN,
 * PUT_AWAY), one active row; a change keeps the earlier row inactive (history, "Changed by").
 *
 *   GET /inventory/locations/defaults?siteId=          the site's active defaults (inventory.locations.view; a floor device
 *                                                       its own site's: the put-away suggestion)
 *   PUT /inventory/locations/defaults                   {siteId, itemKind, purpose, locationId|null, version?}: set, change
 *                                                       or clear one (office, inventory.locations.manage; one command
 *                                                       inventory.locations.setDefault; event default_location_changed)
 *   GET /inventory/locations/defaults/resolve           the place a command takes for a purpose and an item (or a kind)
 *
 * `defaultPlaceFor(client, …)` is what the commands read when the person names no place (receipts, holds, customer
 * returns, issues, returns from a work order: their own files say where); the domain's resolveDefault decides.
 */

const DEFAULT_SELECT = {
  id: true,
  siteId: true,
  itemKind: true,
  purpose: true,
  locationId: true,
  active: true,
  version: true,
  updatedAt: true,
  updatedById: true,
  location: { select: { id: true, code: true, name: true, kind: true, status: true } },
} as const satisfies Prisma.DefaultLocationSelect
type DefaultDbRow = Prisma.DefaultLocationGetPayload<{ select: typeof DEFAULT_SELECT }>

const viewOf = (row: DefaultDbRow): DefaultView => ({
  id: row.id,
  itemKind: row.itemKind,
  purpose: row.purpose,
  location: row.location,
  version: row.version,
  updatedAt: toUtcIso(row.updatedAt),
  updatedById: row.updatedById,
})

const PURPOSE_ORDER = ['RECEIVING', 'QUALITY', 'ISSUE', 'RETURN', 'PUT_AWAY']

/** GET /inventory/locations/defaults. */
export async function listDefaults(caller: CommandCaller, query: { readonly siteId: string }): Promise<{ siteId: string; defaults: DefaultView[] }> {
  const site = await siteFor(caller, query.siteId, INVENTORY_LOCATIONS_VIEW, 'siteId')
  const rows = await caller.withClient((client) => client.defaultLocation.findMany({ where: { siteId: site.id, active: true }, select: DEFAULT_SELECT, orderBy: [{ purpose: 'asc' }, { id: 'asc' }] }))
  const sorted = [...rows].sort((a, b) => PURPOSE_ORDER.indexOf(a.purpose) - PURPOSE_ORDER.indexOf(b.purpose) || (a.itemKind ?? '').localeCompare(b.itemKind ?? ''))
  return { siteId: site.id, defaults: sorted.map(viewOf) }
}

export interface SetDefaultBody {
  readonly siteId: string
  readonly itemKind: HeldItemKind | null
  readonly purpose: DefaultPurpose
  readonly locationId: string | null
  readonly version?: number | undefined
}

/** PUT /inventory/locations/defaults: one command. */
export async function setDefault(caller: CommandCaller, body: SetDefaultBody, idempotencyKey?: string): Promise<{ default: DefaultView | null }> {
  const context = officeContextOf(caller)
  const site = await siteFor(caller, body.siteId, INVENTORY_LOCATIONS_MANAGE, 'body/siteId')
  const { result } = await command(caller, { name: 'inventory.locations.setDefault', idempotencyKey, input: body }, async ({ tx, audit, emit, now }) => {
    // The site's defaults of this purpose, locked (two people setting the same default: the second sees the first's).
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.default-location', ${context.tenantId}::uuid, ${site.id}::uuid, ${body.purpose}::text), 0))`
    const current = await tx.defaultLocation.findFirst({ where: { siteId: site.id, purpose: body.purpose, itemKind: body.itemKind, active: true }, select: DEFAULT_SELECT })
    if (current && body.version !== undefined && current.version !== body.version) {
      throw new ConflictError(`The default changed since you read it (version ${current.version}): read it again.`)
    }
    if (current && body.version === undefined) throw new ConflictError('This default is set already: send the version you read to change it.')
    if (!current && body.version !== undefined) throw new ConflictError('This default was cleared since you read it: read it again.')
    if (body.locationId === null) {
      if (!current) return { default: null }
      await tx.defaultLocation.update({ where: { id: current.id }, data: { active: false, updatedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
      audit({ recordType: 'DefaultLocation', recordId: current.id, companyId: site.companyId, siteId: site.id, before: { locationId: current.locationId, active: true }, after: { active: false } })
      emit({ type: 'inventory.default_location_changed', subject: current.id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, itemKind: body.itemKind, purpose: body.purpose, locationId: null, change: 'CLEARED' } })
      return { default: null }
    }
    const place = isUuid(body.locationId) ? await tx.location.findUnique({ where: { id: body.locationId }, select: { code: true, kind: true, status: true, siteId: true } }) : null
    const problems = defaultProblems(body.purpose, body.itemKind, place, site.id)
    if (problems.length > 0) throw new ValidationError(problems[0]!.message, problems.map((issue) => ({ path: `body/${issue.path}`, message: issue.message })))
    if (current?.locationId === body.locationId) return { default: viewOf(current) }
    // The earlier row stays, inactive; the new one is the active default.
    if (current) {
      await tx.defaultLocation.update({ where: { id: current.id }, data: { active: false, updatedById: context.actorId, version: { increment: 1 } }, select: { id: true } })
    }
    const id = newId()
    const row = await tx.defaultLocation.create({
      data: { id, companyId: site.companyId, siteId: site.id, itemKind: body.itemKind, purpose: body.purpose, locationId: body.locationId, createdAt: now, updatedAt: now, createdById: context.actorId, updatedById: context.actorId },
      select: DEFAULT_SELECT,
    })
    audit({ recordType: 'DefaultLocation', recordId: id, companyId: site.companyId, siteId: site.id, before: current ? { id: current.id, locationId: current.locationId } : null, after: { itemKind: body.itemKind, purpose: body.purpose, locationId: body.locationId } })
    emit({ type: 'inventory.default_location_changed', subject: id, companyId: site.companyId, siteId: site.id, payload: { siteId: site.id, itemKind: body.itemKind, purpose: body.purpose, locationId: body.locationId, change: 'SET' } })
    return { default: viewOf(row) }
  })
  return result
}

/** The active defaults of a site's purpose as the resolver reads them. */
async function defaultRows(client: Pick<CommandTx, 'defaultLocation'>, siteId: string, purpose: DefaultPurpose): Promise<(DefaultRow & { readonly name: string })[]> {
  const rows = await client.defaultLocation.findMany({
    where: { siteId, purpose, active: true },
    select: { itemKind: true, locationId: true, location: { select: { code: true, name: true, kind: true, status: true } } },
    orderBy: [{ id: 'asc' }],
  })
  return rows.map((row) => ({ itemKind: row.itemKind, locationId: row.locationId, location: row.location, name: row.location.name }))
}

/**
 * The default place of a site for a purpose and the kinds of material a command moves (factory-domain resolveDefault;
 * no kinds: the site's fallback only), or null: the command's own rule applies. Reads with the caller's client (a floor
 * device reads its own site's defaults).
 */
export async function defaultPlaceFor(client: Pick<CommandTx, 'defaultLocation'>, ask: { readonly siteId: string; readonly purpose: DefaultPurpose; readonly itemKinds?: readonly HeldItemKind[] }): Promise<{ id: string; code: string } | null> {
  const found = resolveDefault(await defaultRows(client, ask.siteId, ask.purpose), ask.itemKinds ?? [])
  return found ? { id: found.locationId, code: found.location.code } : null
}

/** GET /inventory/locations/defaults/resolve. */
export async function resolveDefaultPlace(caller: CommandCaller, query: { readonly siteId?: string | undefined; readonly purpose: DefaultPurpose; readonly itemId?: string | undefined; readonly itemKind?: HeldItemKind | undefined }) {
  const site = await siteFor(caller, query.siteId, INVENTORY_LOCATIONS_VIEW, 'siteId')
  return caller.withClient(async (client) => {
    let kind: HeldItemKind | null = query.itemKind ?? null
    if (query.itemId) {
      const item = await client.item.findUnique({ where: { id: query.itemId }, select: { kind: true } })
      if (!item) throw new NotFoundError('Item not found.')
      kind = item.kind
    }
    const rows = await defaultRows(client, site.id, query.purpose)
    const found = resolveDefault(rows, kind ? [kind] : [])
    if (!found) return { location: null, from: null }
    const row = rows.find((entry) => entry.locationId === found.locationId && entry.itemKind === found.itemKind)!
    return { location: { id: found.locationId, code: found.location.code, name: row.name, kind: found.location.kind }, from: found.itemKind === null ? ('FALLBACK' as const) : ('KIND' as const) }
  })
}
