import type { Prisma } from '@nexus/factory-db'
import { defineContract } from '@nexus/factory-domain/core/contracts'
import { can, grantsFor, scopeWhere } from '@nexus/factory-domain/core/permissions'
import { PARTIES_VIEW } from '@nexus/factory-domain/parties/permissions'
import { inquiryCustomersQuery, inquiryCustomersView, type InquiryCustomersQuery } from '@nexus/factory-domain/sales/inquiries/contracts'
import { SALES_INQUIRIES_MANAGE } from '@nexus/factory-domain/sales/inquiries/permissions'
import type { CommandCaller } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { PARTY_SCOPE } from '../../parties/store'
import { officeOf } from './store'

/**
 * New request's customer picker (B-TH-221; threads plan O-SAL-INQ-LIST.band-F02, wall W23): GET /sales/inquiries/customers
 * lists the customers and brands a person may make a request for at one company — not archived, reached by the grants of their
 * sales.inquiries.manage that reach that company (every customer, or the customers a grant names: RoleAssignment.partyIds)
 * AND by their parties.view (the party list's own filter). A person limited to customer A never reads customer B's name or
 * code here, and the picker never offers a customer the create would refuse. `q` finds by code or name; `total` counts every
 * match beyond `limit`; `limited` says no grant reaches every customer ("your customers").
 */

export const inquiryCustomersContract = defineContract({ querystring: inquiryCustomersQuery, response: { 200: inquiryCustomersView } })

const COLUMNS = { id: true, code: true, legalName: true, tradeName: true } as const

export async function inquiryCustomers(caller: CommandCaller, query: InquiryCustomersQuery) {
  const context = officeOf(caller)
  const actor = actorOf(context)
  const { companyId } = query
  const grants = grantsFor(actor, SALES_INQUIRIES_MANAGE).filter((grant) => grant.companies === 'all' || grant.companies.includes(companyId))
  const every = grants.some((grant) => grant.parties === 'all')
  if (grants.length === 0) return { customers: [], total: 0, limited: true }
  const named = every ? null : [...new Set(grants.flatMap((grant) => (grant.parties === 'all' ? [] : grant.parties)))]
  const q = query.q?.trim()
  const where: Prisma.PartyWhereInput = {
    AND: [
      scopeWhere(actor, PARTIES_VIEW, PARTY_SCOPE) as Prisma.PartyWhereInput,
      named ? { id: { in: named } } : {},
      { roles: { hasSome: ['CUSTOMER', 'BRAND'] } },
      // Every customer the create takes: not archived (a customer still in PROSPECT status asks too).
      { status: { not: 'ARCHIVED' } },
      { OR: [{ companyId }, { companyId: null }] },
      q ? { OR: [{ code: { contains: q, mode: 'insensitive' } }, { legalName: { contains: q, mode: 'insensitive' } }, { tradeName: { contains: q, mode: 'insensitive' } }] } : {},
    ],
  }
  const [rows, total] = await caller.withClient((client) => Promise.all([client.party.findMany({ where, select: COLUMNS, orderBy: [{ code: 'asc' }, { id: 'asc' }], take: query.limit }), client.party.count({ where })]))
  // The create's own check, once more per row: what the picker offers is what the create takes.
  const customers = rows.filter((row) => can(actor, SALES_INQUIRIES_MANAGE, { companyId, partyId: row.id }))
  return { customers, total, limited: !every }
}
