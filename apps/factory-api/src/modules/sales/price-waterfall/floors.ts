import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney, markMoney } from '@nexus/factory-domain/money/marked'
import { floorFor, floorsOf, floorsProblems, floorText, lowersAFloor, type FloorInForce } from '@nexus/factory-domain/sales/price-waterfall/rules'
import { QUOTES_VIEW, SALES_SETTINGS_MANAGE } from '@nexus/factory-domain/sales/quotes/permissions'
import type { QuoteRules } from '@nexus/factory-domain/sales/quotes/rules'
import { command, type CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { heldRoles } from '../../../platform/auth/roles/access'
import { mayWrite } from '../../product/materials/store'
import { rulesInForce, settingsRowsFor } from '../quotes/rules'
import { officeContextOf, type Reader } from '../quotes/store'

/**
 * The margin floor by role (B-W2b-330; SAL-189; design ssettings.approval "Margin floor % per role"): a quote version is
 * held to the floor of the person who made it (QuoteVersion.createdById, else the quote's maker) — the lowest floor of
 * their live office roles over the quote's company and customer that the sales settings list (SalesSettings
 * .marginFloorByRole: the company's own row's, else the tenant-wide row's), else the company's floor (W1's rules). The
 * same for every reader and at every write, so the record, the approval and the send agree; a version under it asks a yes
 * as W1 does (QuoteApproval MARGIN_FLOOR, its details naming the role). No floor by role is set by default: then every
 * quote keeps W1's floor.
 */

export interface PlaceOfQuote {
  readonly companyId: string
  readonly partyId: string
}

/** The floors by role in force for a company: its own row's (when it lists any), else the tenant-wide row's. */
export async function floorsInForce(db: Reader, companyId: string | null): Promise<{ readonly floors: Record<string, string> | null; readonly from: 'COMPANY' | 'TENANT' | null }> {
  const rows = await db.salesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] }, select: { companyId: true, marginFloorByRole: true } })
  const own = companyId === null ? null : floorsOf(rows.find((row) => row.companyId === companyId)?.marginFloorByRole)
  if (own) return { floors: own, from: 'COMPANY' }
  const tenant = floorsOf(rows.find((row) => row.companyId === null)?.marginFloorByRole)
  return tenant ? { floors: tenant, from: 'TENANT' } : { floors: null, from: null }
}

/** The keys of the roles a person holds now over a company and customer (an assignment limited elsewhere does not count). */
export async function roleKeysOver(db: Reader, personId: string, place: PlaceOfQuote, now: Date): Promise<string[]> {
  const held = await heldRoles(db, personId, now)
  return [
    ...new Set(
      held
        .filter((row) => (row.scope.allCompanies || row.scope.companyIds.includes(place.companyId)) && (row.scope.partyIds.length === 0 || row.scope.partyIds.includes(place.partyId)))
        .map((row) => row.roleKey),
    ),
  ].sort()
}

export interface PersonFloor extends FloorInForce {
  /** The person whose roles were read (the version's maker); null: nobody known (the company's floor). */
  readonly personId: string | null
}

/** The floor a person is held to on a quote of this company and customer (see the module comment). */
export async function personFloor(db: Reader, place: PlaceOfQuote, personId: string | null, companyFloorPct: string, now: Date): Promise<PersonFloor> {
  const { floors } = await floorsInForce(db, place.companyId)
  if (floors === null || personId === null) return { ...floorFor(null, [], companyFloorPct), personId }
  return { ...floorFor(floors, await roleKeysOver(db, personId, place, now), companyFloorPct), personId }
}

/** The person a quote version is held to: who made the version, else who made the quote. */
export const versionPersonOf = (quote: { readonly createdById: string | null }, version: { readonly createdById: string | null }): string | null => version.createdById ?? quote.createdById

/**
 * W1's quote rules with the floor of the version's maker (the one seam W1's pricing and reads call: quotes/pricing.ts
 * refreshVersion, quotes/views.ts readFacts). Without floors by role the rules come back as they are.
 */
export async function withPersonFloor<Rules extends Pick<QuoteRules, 'marginFloorPct'>>(
  db: Reader,
  quote: PlaceOfQuote & { readonly createdById: string | null },
  version: { readonly createdById: string | null },
  rules: Rules,
  now: Date,
): Promise<Rules & { readonly marginFloorRole: string | null }> {
  const floor = await personFloor(db, quote, versionPersonOf(quote, version), rules.marginFloorPct, now)
  return { ...rules, marginFloorPct: floor.marginFloorPct, marginFloorRole: floor.roleKey }
}

// ---- the settings: GET / PUT /sales/settings/margin-floors -------------------------------------------------------------

const ROW_SELECT = { id: true, companyId: true, marginFloorPct: true, marginFloorByRole: true, version: true, updatedAt: true } as const

const floorsView = (floors: Record<string, string> | null) => asMoney('margin', floors === null ? null : Object.fromEntries(Object.entries(floors).sort(([a], [b]) => (a < b ? -1 : 1)).map(([key, value]) => [key, floorText(value)])))

async function assertCompany(caller: CommandCaller, companyId: string): Promise<void> {
  const context = officeContextOf(caller)
  const row = isUuid(companyId) ? await caller.withClient((client) => client.company.findUnique({ where: { id: companyId }, select: { id: true } })) : null
  if (!row || !can(actorOf(context), QUOTES_VIEW, { companyId })) throw new NotFoundError('Company not found.')
}

/** The office roles of the tenant a floor may name (their keys and names). */
const officeRoles = (db: Reader) => db.role.findMany({ where: { audience: 'OFFICE' }, select: { key: true, name: true }, orderBy: [{ key: 'asc' }] })

/** GET /sales/settings/margin-floors: the floors by role of the tenant and of a company, the ones in force, the roles. */
export async function getMarginFloors(caller: CommandCaller, query: { companyId?: string | undefined }) {
  const context = officeContextOf(caller)
  if (query.companyId !== undefined) await assertCompany(caller, query.companyId)
  const companyId = query.companyId ?? null
  return caller.withClient(async (client) => {
    const rows = await client.salesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId === null ? [] : [{ companyId }])] }, select: ROW_SELECT })
    const view = (row: (typeof rows)[number] | undefined) => (row ? { id: row.id, companyId: row.companyId, floors: floorsView(floorsOf(row.marginFloorByRole)), version: row.version, updatedAt: toUtcIso(row.updatedAt) } : null)
    const inForce = await floorsInForce(client, companyId)
    const rules = rulesInForce(await settingsRowsFor(client, companyId), companyId)
    return {
      tenant: view(rows.find((row) => row.companyId === null && row.id === context.tenantId)),
      company: companyId === null ? null : view(rows.find((row) => row.companyId === companyId)),
      inForce: { floors: floorsView(inForce.floors), from: inForce.from, companyFloorPct: asMoney('margin', rules.marginFloorPct) },
      roles: await officeRoles(client),
    }
  })
}

export interface SaveFloorsInput {
  readonly companyId?: string | undefined
  readonly version: number
  /** Required (optional in the contract's type: the grain filter may drop it); null or {}: none. */
  readonly floors?: Readonly<Record<string, string>> | null | undefined
}

/**
 * PUT /sales/settings/margin-floors (sales.settings.manage; a tenant-wide row only by a grant over every company; the
 * floors are the margin grain): the floors by role of a company's (or the tenant's) sales settings, which must exist
 * (W1's PUT /sales/settings makes them). Every key an office role of the tenant (400 in words). A change that lets more
 * quotes through without a yes (a lower floor, a new one under the company's) asks for a fresh step-up first.
 */
export async function saveMarginFloors(caller: CommandCaller, body: SaveFloorsInput, idempotencyKey?: string, stepUp: () => void | Promise<void> = () => undefined) {
  const context = officeContextOf(caller)
  const companyId = body.companyId ?? null
  if (!mayWrite(actorOf(context), SALES_SETTINGS_MANAGE, companyId)) throw new ForbiddenError(companyId === null ? 'The tenant-wide sales settings are changed only by a role over every company.' : undefined)
  if (companyId !== null) await assertCompany(caller, companyId)
  if (body.floors === undefined) throw new ValidationError('Send the floors by role (null for none).', [{ path: 'body/floors', message: 'Send the floors.' }])
  const problems = floorsProblems(body.floors)
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : 'The margin floors are not valid.', problems)
  const wanted = body.floors === null || Object.keys(body.floors).length === 0 ? null : Object.fromEntries(Object.entries(body.floors).map(([key, value]) => [key, floorText(value)]))
  const id = companyId ?? context.tenantId
  const { existing, roles } = await caller.withClient(async (client) => ({
    existing: await client.salesSettings.findUnique({ where: { id }, select: ROW_SELECT }),
    roles: new Set((await officeRoles(client)).map((role) => role.key)),
  }))
  if (!existing) throw new ConflictError('Save these sales settings first (the margin floor, the discount limit): the floors by role go with them.')
  const unknown = Object.keys(wanted ?? {}).filter((key) => !roles.has(key))
  if (unknown.length > 0) throw new ValidationError(`Not an office role of this business: ${unknown.join(', ')}.`, unknown.map((key) => ({ path: `body/floors/${key}`, message: 'Not an office role.' })))
  // Against the row's own floor: a role without a floor of its own is held to it.
  if (lowersAFloor(floorsOf(existing.marginFloorByRole), wanted, existing.marginFloorPct.toString())) await stepUp()

  const { result } = await command(caller, { name: 'sales.saveMarginFloors', idempotencyKey, input: body, record: { type: 'SalesSettings', id, expectedVersion: body.version } }, async (tools) => {
    const { tx, now } = tools
    const row = await tx.salesSettings.findUniqueOrThrow({ where: { id }, select: ROW_SELECT })
    const current = floorsOf(row.marginFloorByRole)
    const same = JSON.stringify(floorsView(current)) === JSON.stringify(floorsView(wanted))
    if (!same) {
      if (wanted === null) await tx.$executeRaw`UPDATE "SalesSettings" SET "marginFloorByRole" = NULL, "updatedAt" = ${now} WHERE "id" = ${id}::uuid`
      else await tx.salesSettings.update({ where: { id }, data: { marginFloorByRole: wanted, updatedAt: now }, select: { id: true } })
    }
    tools.audit({ recordType: 'SalesSettings', recordId: id, companyId, before: { marginFloorByRole: markMoney('margin', current) }, after: { marginFloorByRole: markMoney('margin', wanted) } })
    if (!same) tools.emit({ type: 'sales_settings.changed', subject: id, companyId, payload: { settingsId: id, fields: ['marginFloorByRole'] } })
    const after = await tx.salesSettings.findUniqueOrThrow({ where: { id }, select: ROW_SELECT })
    return { settings: { id: after.id, companyId: after.companyId, floors: floorsView(floorsOf(after.marginFloorByRole)), version: after.version, updatedAt: toUtcIso(after.updatedAt) } }
  })
  return result
}
