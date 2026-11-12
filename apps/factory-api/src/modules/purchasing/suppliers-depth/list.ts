import type { Prisma } from '@nexus/factory-db'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import type { PartyStatus } from '@nexus/factory-domain/parties/rules'
import { effectiveStatus, initialSupplierStatus, SUPPLIER_ROLES, SUPPLIER_STATUSES, type SupplierKind, type SupplierStatus } from '@nexus/factory-domain/purchasing/suppliers-depth/rules'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { PARTY_SCOPE } from '../../parties/store'
import { officeContextOf } from '../store'
import { nameOf, SUPPLIER_COLUMNS } from './store'

/**
 * The supplier list's W2b parts (B-W2b-311; design purchasing.suppliers › grid "roles, status", Rows ▾ Tanneries ·
 * Subcontractors, the tiles Active · Prospects · Blocked): parties.view, the parties the caller reaches (scopeWhere) that hold
 * a supplier, subcontractor or carrier role, by code, filtered by kind and by the status the list shows (W1's BLOCKED and
 * ARCHIVED over the supplier status; none set: W1's status read as one), with the counts per status for the tiles.
 */

export interface ListSuppliersQuery {
  readonly kind?: SupplierKind | undefined
  readonly status?: SupplierStatus | undefined
  readonly companyId?: string | undefined
  readonly q?: string | undefined
  readonly cursor?: string | undefined
  readonly limit: number
}

const OPEN: PartyStatus[] = ['PROSPECT', 'ACTIVE']

/** The parties the list shows with `status`, as a filter (see effectiveStatus). */
export function statusWhere(status: SupplierStatus): Prisma.PartyWhereInput {
  const or: Prisma.PartyWhereInput[] = [{ status: { in: OPEN }, supplierStatus: status }]
  for (const party of OPEN) if (initialSupplierStatus(party) === status) or.push({ status: party, supplierStatus: null })
  if (status === 'BLOCKED') or.push({ status: 'BLOCKED' })
  if (status === 'INACTIVE') or.push({ status: 'ARCHIVED' })
  return { OR: or }
}

function baseWhere(caller: CommandCaller, companyId: string | undefined): Prisma.PartyWhereInput[] {
  const context = officeContextOf(caller)
  return [
    scopeWhere(actorOf(context), PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput,
    { roles: { hasSome: [...SUPPLIER_ROLES] } },
    companyId ? { OR: [{ companyId }, { companyId: null }] } : {},
  ]
}

/** parties.view: one page of suppliers. */
export async function listSuppliers(caller: CommandCaller, query: ListSuppliersQuery) {
  const where: Prisma.PartyWhereInput = {
    AND: [
      ...baseWhere(caller, query.companyId),
      query.kind ? { supplierKinds: { has: query.kind } } : {},
      query.status ? statusWhere(query.status) : {},
      query.q ? { OR: [{ code: { contains: query.q, mode: 'insensitive' } }, { legalName: { contains: query.q, mode: 'insensitive' } }, { tradeName: { contains: query.q, mode: 'insensitive' } }] } : {},
    ],
  }
  return caller.withClient(async (client) => {
    const rows = await client.party.findMany({ where, select: SUPPLIER_COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit + 1, ...(query.cursor ? { cursor: { id: query.cursor }, skip: 1 } : {}) })
    const page = rows.slice(0, query.limit)
    return {
      suppliers: page.map((row) => {
        const effective = effectiveStatus(row.status as PartyStatus, row.supplierStatus as SupplierStatus | null)
        return {
          id: row.id,
          companyId: row.companyId,
          code: row.code,
          name: nameOf(row),
          roles: [...row.roles],
          kinds: [...row.supplierKinds] as SupplierKind[],
          status: effective.status,
          source: effective.source,
          since: effective.source === 'SUPPLIER' && row.supplierStatusChangedAt ? toUtcIso(row.supplierStatusChangedAt) : null,
          country: row.country,
          originCountry: row.originCountry,
          leadTimeDays: row.leadTimeDays,
          version: row.version,
        }
      }),
      nextCursor: rows.length > query.limit ? page[page.length - 1]!.id : null,
    }
  })
}

/** parties.view: how many suppliers the list shows in each status (the tiles; a zero is a zero). */
export async function supplierCounts(caller: CommandCaller, query: { readonly companyId?: string | undefined }) {
  return caller.withClient(async (client) => {
    const groups = await client.party.groupBy({ by: ['status', 'supplierStatus'], where: { AND: baseWhere(caller, query.companyId) }, _count: { _all: true } })
    const counts = Object.fromEntries(SUPPLIER_STATUSES.map((status) => [status, 0])) as Record<SupplierStatus, number>
    for (const group of groups) counts[effectiveStatus(group.status as PartyStatus, group.supplierStatus as SupplierStatus | null).status] += group._count._all
    return { counts, suppliers: Object.values(counts).reduce((sum, count) => sum + count, 0) }
  })
}
