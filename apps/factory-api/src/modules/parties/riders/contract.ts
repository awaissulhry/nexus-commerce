import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { PARTY_KINDS, PARTY_STATUSES } from '@nexus/factory-domain/parties/rules'

/** The riders' routes' contracts (B-W2b-290; SAL-021; modules/parties/riders). */

const ridersView = output({
  partyId: id(),
  code: z.string(),
  kind: z.enum(PARTY_KINDS),
  /** F-CA-fx4 (walk W-07): + the team's trade name — the office names a customer by its trade name, else its legal name. */
  team: output({ id: id(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable(), status: z.enum(PARTY_STATUSES) }).nullable(),
  riders: z.array(
    output({
      id: id(),
      code: z.string(),
      legalName: z.string(),
      tradeName: z.string().nullable(),
      status: z.enum(PARTY_STATUSES),
      country: z.string(),
      language: z.string(),
      /** F-CA-S4 (R-B10): null without the measurements right over the rider. */
      measurementProfiles: z.number().int().nullable(),
      version: z.number().int(),
      updatedAt: instant(),
    }),
  ),
  version: z.number().int(),
})
const answer = output({ riders: ridersView })

export const getRidersContract = defineContract({ params: input({ partyId: id() }), response: { 200: answer } })
export const setTeamContract = defineContract({ params: input({ partyId: id() }), body: input({ version: z.number().int().min(1), teamPartyId: id().nullable() }), response: { 200: answer } })
