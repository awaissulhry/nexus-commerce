import type { FastifyRequest } from 'fastify'
import { grainPermission, isGrain } from '@nexus/factory-domain/auth/grains/grains'
import { OWNER_GIVEN_GRAIN } from '@nexus/factory-domain/auth/roles/roles'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { holds, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { actorOf, requireContext, type OfficeContext } from '../../../core/context'
import { liveAssignment } from '../../auth/roles/access'
import type { OfficeAuth } from '../../auth/sessions/office-auth'
import { PRICE_HOLDER_STATUSES, type PriceHoldersAnswer } from './contract'

/**
 * "Who sees prices" (customer page lane B-CP-013; the money wall, Owner O3: "only you and the people you name see our
 * prices"; design 11-money §4.4), GET /admin/security/price-holders:
 *
 *   people   every office person with a LIVE assignment of a role that holds the price grain (the Owner, Finance, a custom
 *            "Accountant (prices)" …), invited, active or suspended: per role its grains, whether it asks two-factor, its
 *            reach (all customers or how many, all companies or how many), since and until; the person's two-factor set up
 *            or not. An ended, expired or not-yet-started assignment is not listed; Sales (no grain since B-CP-011) never.
 *   guests   every outside accountant (a GUEST of an adviser firm) whose live portal role sees prices, with the firm and the
 *            end of access; a passed end is not listed. A customer's own people (its Buyer sees its own orders' prices) are
 *            not "our" price holders and are not listed.
 *
 * Read with users.view (the manifest) AND the price grain (here: the list is itself behind the money wall, 403 in words for
 * anyone else) over every customer (the tenant's people are every customer's, fix-pr-8: routes.ts). Never a price, never a
 * person's activity: names, states and dates only.
 */

const officeContextOf = (request: FastifyRequest): OfficeContext => requireContext(request) as OfficeContext

/** The words of the refusal (the web says `orders.json money.noPrice`). */
export const PRICE_HOLDERS_WORDS = Object.freeze({ notAPriceHolder: 'Shown to people who see prices.' })

const LIVE_STATUSES = [...PRICE_HOLDER_STATUSES]
type HolderStatus = (typeof PRICE_HOLDER_STATUSES)[number]

export async function priceHolders(auth: OfficeAuth, request: FastifyRequest): Promise<PriceHoldersAnswer> {
  const context = officeContextOf(request)
  if (!holds(actorOf(context), grainPermission(OWNER_GIVEN_GRAIN) as Permission)) throw new ForbiddenError(PRICE_HOLDERS_WORDS.notAPriceHolder)
  const now = auth.clock.now()
  return request.withClient(async (client) => {
    const rows = await client.roleAssignment.findMany({
      where: { ...liveAssignment(now), role: { grains: { has: OWNER_GIVEN_GRAIN } }, user: { status: { in: LIVE_STATUSES } } },
      orderBy: [{ validFrom: 'asc' }, { id: 'asc' }],
      take: 2000,
      select: {
        id: true,
        roleId: true,
        allCompanies: true,
        companyIds: true,
        partyIds: true,
        validFrom: true,
        validTo: true,
        role: { select: { key: true, name: true, system: true, audience: true, grains: true, requireMfa: true } },
        user: { select: { id: true, displayName: true, status: true, audience: true, partnerKind: true, partyId: true, accessUntil: true, totpConfirmedAt: true } },
      },
    })

    const people = new Map<string, PriceHoldersAnswer['people'][number]>()
    const guests = new Map<string, PriceHoldersAnswer['guests'][number]>()
    const firmIds = new Set<string>()
    for (const row of rows) {
      const status = row.user.status as HolderStatus
      if (row.role.audience === 'OFFICE' && row.user.audience !== 'PARTNER') {
        const person = people.get(row.user.id) ?? { userId: row.user.id, name: row.user.displayName, status, twoFactor: row.user.totpConfirmedAt !== null, roles: [] }
        person.roles.push({
          assignmentId: row.id,
          roleId: row.roleId,
          key: row.role.key,
          name: row.role.name,
          system: row.role.system,
          grains: row.role.grains.filter(isGrain),
          requireMfa: row.role.requireMfa,
          allCustomers: row.partyIds.length === 0,
          customers: row.partyIds.length,
          allCompanies: row.allCompanies,
          companies: row.allCompanies ? 0 : row.companyIds.length,
          since: toUtcIso(row.validFrom),
          until: row.validTo ? toUtcIso(row.validTo) : null,
        })
        people.set(row.user.id, person)
        continue
      }
      // An outside accountant: a guest whose access has not passed (the authenticator refuses it once it has).
      const ended = row.user.accessUntil !== null && row.user.accessUntil.getTime() <= now.getTime()
      if (row.role.audience !== 'PARTNER' || row.user.partnerKind !== 'GUEST' || ended || guests.has(row.user.id)) continue
      if (row.user.partyId) firmIds.add(row.user.partyId)
      guests.set(row.user.id, { userId: row.user.id, name: row.user.displayName, status, firm: row.user.partyId ? { id: row.user.partyId, name: '' } : null, roleKey: row.role.key, until: row.user.accessUntil ? toUtcIso(row.user.accessUntil) : null })
    }

    const firms = firmIds.size === 0 ? [] : await client.party.findMany({ where: { id: { in: [...firmIds] } }, select: { id: true, legalName: true, tradeName: true } })
    const firmName = new Map(firms.map((party) => [party.id, party.tradeName ?? party.legalName]))
    const byName = <T extends { readonly name: string; readonly userId: string }>(a: T, b: T) => a.name.localeCompare(b.name) || a.userId.localeCompare(b.userId)
    return {
      asOf: toUtcIso(now),
      people: [...people.values()].sort(byName),
      guests: [...guests.values()].map((guest) => (guest.firm ? { ...guest, firm: { id: guest.firm.id, name: firmName.get(guest.firm.id) ?? '' } } : guest)).sort(byName),
    }
  })
}
