import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * owb-of4 step 3 — People › People by customer: the reads and writes of owb-of2's Shape (FIXED), with the web's own zod (unknown keys
 * dropped). The owner and admin write it (the role-assignment right); anyone else reads it only (`may.write`).
 *
 *   GET  /people/by-customer                              the office people who may be given, the customers, who is given to whom,
 *                                                         each person's extra rights
 *   PUT  /people/by-customer/:partyId/:userId             { given } — one person for one customer (an end is `endedAt`, never a delete)
 *   POST /people/by-customer/every-customer               { userId, given } — Give to every customer / Take out for every customer…
 *   PUT  /people/by-customer/extra/:userId                { right, on } — assign / end the base's extra role template
 * Writes answer the changed rows: `{ given: […] }` or `{ person: { userId, extra: […] } }`.
 */

export const EXTRA_RIGHTS = ['ALLOW_PRODUCTION', 'PACK_AND_SEND', 'PRINT_AND_START'] as const
export type ExtraRight = (typeof EXTRA_RIGHTS)[number]

const given = z.object({ partyId: z.string(), userId: z.string(), since: z.string(), byName: z.string() })
export type Given = z.infer<typeof given>

export const byCustomerSchema = z.object({
  people: z.array(z.object({ userId: z.string(), name: z.string(), roleWords: z.string(), extra: z.array(z.enum(EXTRA_RIGHTS)) })),
  customers: z.array(z.object({ partyId: z.string(), code: z.string(), name: z.string() })),
  given: z.array(given),
  may: z.object({ write: z.boolean() }),
})
export type ByCustomer = z.infer<typeof byCustomerSchema>
export type PoolPerson = ByCustomer['people'][number]
export type PoolCustomer = ByCustomer['customers'][number]

const givenAnswer = z.object({ given: z.array(given) })
const personAnswer = z.object({ person: z.object({ userId: z.string(), extra: z.array(z.enum(EXTRA_RIGHTS)) }) })
export type GivenAnswer = z.infer<typeof givenAnswer>
export type PersonAnswer = z.infer<typeof personAnswer>

export const readByCustomer = (api: ApiClient, signal?: AbortSignal): Promise<ByCustomer> => api.get('/people/by-customer', { schema: byCustomerSchema, signal })

/** One tick: this person works for this customer (given true), or no longer (false). */
export const setGiven = (api: ApiClient, partyId: string, userId: string, isGiven: boolean, idempotencyKey: string = newIdempotencyKey()): Promise<GivenAnswer> =>
  api.request('PUT', `/people/by-customer/${encodeURIComponent(partyId)}/${encodeURIComponent(userId)}`, { body: { given: isGiven }, schema: givenAnswer, idempotencyKey })

/** Give to every customer (true) / Take out for every customer (false): one person, every customer. */
export const setEveryCustomer = (api: ApiClient, userId: string, isGiven: boolean, idempotencyKey: string = newIdempotencyKey()): Promise<GivenAnswer> =>
  api.post('/people/by-customer/every-customer', { body: { userId, given: isGiven }, schema: givenAnswer, idempotencyKey })

/** An extra right on or off for one person (today's role assignment of the base's extra template). */
export const setExtra = (api: ApiClient, userId: string, right: ExtraRight, on: boolean, idempotencyKey: string = newIdempotencyKey()): Promise<PersonAnswer> =>
  api.request('PUT', `/people/by-customer/extra/${encodeURIComponent(userId)}`, { body: { right, on }, schema: personAnswer, idempotencyKey })
