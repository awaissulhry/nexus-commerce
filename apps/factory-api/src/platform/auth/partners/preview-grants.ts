import type { FactoryClient } from '@nexus/factory-db'
import { partnerKindsOf } from '@nexus/factory-domain/auth/partners/kinds'
import { previewPermissions } from '@nexus/factory-domain/auth/partners/rules'
import { grantOf } from '@nexus/factory-domain/auth/roles/roles'
import type { Grant } from '@nexus/factory-domain/core/permissions'

/**
 * What an office preview of a party's portal may read (B-W2b-162; design portal.frame notices "previewing this portal as …
 * read-only"): the portal authenticator (auth/portal/authenticator.ts) asks here on every request of a preview session.
 * The read permissions of every main role of the party's kinds as its roles are NOW, over the session's company and the
 * party; never a write (the authenticator refuses a preview's unsafe requests) and never money (no grain).
 */
export async function previewGrants(client: FactoryClient, place: { readonly companyId: string; readonly partyId: string }): Promise<Grant[]> {
  const party = await client.party.findUnique({ where: { id: place.partyId }, select: { roles: true } })
  const permissions = previewPermissions(partnerKindsOf(party?.roles ?? []))
  if (permissions.length === 0) return []
  return [grantOf({ permissions, grains: [] }, { allCompanies: false, companyIds: [place.companyId], siteIds: [], partyIds: [place.partyId] })]
}
