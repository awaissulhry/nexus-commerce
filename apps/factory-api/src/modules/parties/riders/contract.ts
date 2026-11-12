import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PARTY_KINDS, PARTY_STATUSES } from '@nexus/factory-domain/parties/rules'

/** The riders' routes' contracts (B-W2b-290; SAL-021; modules/parties/riders). */

const ridersView = output({
  partyId: id(),
  code: z.string(),
  kind: z.enum(PARTY_KINDS),
  team: output({ id: id(), code: z.string(), legalName: z.string(), status: z.enum(PARTY_STATUSES) }).nullable(),
  riders: z.array(
    output({
      id: id(),
      code: z.string(),
      legalName: z.string(),
      tradeName: z.string().nullable(),
      status: z.enum(PARTY_STATUSES),
      country: z.string(),
      language: z.string(),
      measurementProfiles: z.number().int(),
      version: z.number().int(),
      updatedAt: instant(),
    }),
  ),
  version: z.number().int(),
})
const answer = output({ riders: ridersView })

export const getRidersContract = defineContract({ params: input({ partyId: id() }), response: { 200: answer } })
export const setTeamContract = defineContract({ params: input({ partyId: id() }), body: input({ version: z.number().int().min(1), teamPartyId: id().nullable() }), response: { 200: answer } })
