import type { Prisma } from '@nexus/factory-db'
import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can } from '@nexus/factory-domain/core/permissions'
import { businessDate, toUtcIso } from '@nexus/factory-domain/core/time'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { PartyStatus } from '@nexus/factory-domain/parties/rules'
import type { Tannage } from '@nexus/factory-domain/product/materials/rules'
import { effectiveStatus, hasSupplierRole, newOrderProblem, type Standing, type SupplierKind, type SupplierProfile, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, type Reader } from '../store'

/**
 * Suppliers in depth (B-W2b-311): the Party columns a supplier's depth reads (B-W2b-287's), who may see a supplier, its
 * profile and standing as the domain reads them (factory-domain purchasing/suppliers-depth/rules), and the one check a new
 * purchase order asks (`assertNoNewOrder`, called by modules/purchasing orders.ts assertBuyable).
 */

export const SUPPLIER_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  legalName: true,
  tradeName: true,
  roles: true,
  status: true,
  country: true,
  currency: true,
  leadTimeDays: true,
  supplierKinds: true,
  supplierStatus: true,
  supplierStatusReason: true,
  supplierStatusChangedAt: true,
  supplierStatusChangedById: true,
  originCountry: true,
  originRegion: true,
  originNote: true,
  hideOriginCountries: true,
  tannages: true,
  version: true,
  updatedAt: true,
} as const satisfies Prisma.PartySelect
export type SupplierRow = Prisma.PartyGetPayload<{ select: typeof SUPPLIER_COLUMNS }>

export const CONTACT_COLUMNS = { id: true, partyId: true, name: true, email: true, phone: true, roles: true, receives: true, language: true, status: true, version: true } as const satisfies Prisma.PartyContactSelect
export type ContactRow = Prisma.PartyContactGetPayload<{ select: typeof CONTACT_COLUMNS }>

export const nameOf = (row: Pick<SupplierRow, 'legalName' | 'tradeName'>): string => row.tradeName ?? row.legalName

export function profileOf(row: SupplierRow): SupplierProfile {
  return {
    kinds: [...row.supplierKinds] as SupplierKind[],
    leadTimeDays: row.leadTimeDays,
    originCountry: row.originCountry,
    originRegion: row.originRegion,
    originNote: row.originNote,
    hideOriginCountries: [...row.hideOriginCountries],
    tannages: [...row.tannages] as Tannage[],
  }
}

/** Where the supplier stands, as the domain's words read it. */
export function standingOf(row: Pick<SupplierRow, 'legalName' | 'status'> & { readonly tradeName?: string | null } & Partial<Pick<SupplierRow, 'supplierStatus' | 'supplierStatusReason' | 'supplierStatusChangedAt'>>): Standing {
  return {
    name: row.tradeName ?? row.legalName,
    partyStatus: row.status as PartyStatus,
    supplierStatus: (row.supplierStatus ?? null) as SupplierStatus | null,
    reason: row.supplierStatusReason ?? null,
    since: row.supplierStatusChangedAt ? businessDate(row.supplierStatusChangedAt) : null,
  }
}

export const readSupplierRow = (db: Reader, partyId: string): Promise<SupplierRow | null> =>
  isUuid(partyId) ? db.party.findUnique({ where: { id: partyId }, select: SUPPLIER_COLUMNS }) : Promise.resolve(null)

/** The supplier as the caller may see it (parties.view over its company and itself), else 404; a party with no supplier role is none. */
export async function readSupplier(caller: CommandCaller, partyId: string): Promise<SupplierRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readSupplierRow(client, partyId))
  if (!row || !can(actorOf(context), PARTIES_VIEW, { companyId: row.companyId, partyId: row.id })) throw new NotFoundError('Supplier not found.')
  if (!hasSupplierRole(row.roles)) throw new NotFoundError('Supplier not found: the party has no supplier, subcontractor or carrier role.')
  return row
}

/** The status a list shows, with where it came from (W1's party status when no supplier status is set or W1 blocked it). */
export function statusView(row: SupplierRow, names: ReadonlyMap<string, string>) {
  const effective = effectiveStatus(row.status as PartyStatus, row.supplierStatus as SupplierStatus | null)
  return {
    status: effective.status,
    source: effective.source,
    supplierStatus: row.supplierStatus as SupplierStatus | null,
    reason: row.supplierStatusReason,
    changedAt: row.supplierStatusChangedAt ? toUtcIso(row.supplierStatusChangedAt) : null,
    changedBy: row.supplierStatusChangedById ? (names.get(row.supplierStatusChangedById) ?? null) : null,
  }
}

/** The display names of the office people named by these rows (read in the office scope). */
export async function peopleNames(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((id): id is string => id !== null))]
  if (wanted.length === 0) return new Map()
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })).map((row) => [row.id, row.displayName]))
}

/**
 * SCM-008: no new purchase order goes to a supplier ON_HOLD, BLOCKED or INACTIVE (its supplier status; W1's BLOCKED and
 * ARCHIVED are the caller's own rule), a 409 in words naming the status, since when and why.
 */
export function assertNoNewOrder(party: Parameters<typeof standingOf>[0], path = 'body/partyId'): void {
  const problem = newOrderProblem(standingOf(party))
  if (problem) throw new DomainError('conflict', problem, [{ path, message: `The supplier is ${(party.supplierStatus ?? '').toLowerCase().replace('_', ' ')}.` }])
}
