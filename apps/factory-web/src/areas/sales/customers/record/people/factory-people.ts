'use client'

import { useEffect, useState } from 'react'
import { z } from 'zod'
import type { ApiClient } from '../../../../../lib/api/client'

/**
 * owb-of7 step 3 (design plan § 5f "People by customer", § 5i customer page) — the customer page's card "Factory people": the office
 * people given to THIS customer (owb-of2's `GET /people/by-customer`, Shape FIXED: people · customers · given · may.write), and a door
 * to People › People by customer for who may write it (owner / admin). A reader the read refuses (403) sees no card.
 */

const byCustomerSchema = z.object({
  people: z.array(z.object({ userId: z.string(), name: z.string(), roleWords: z.string(), extra: z.array(z.string()) })),
  customers: z.array(z.object({ partyId: z.string(), code: z.string(), name: z.string() })),
  given: z.array(z.object({ partyId: z.string(), userId: z.string(), since: z.string(), byName: z.string() })),
  may: z.object({ write: z.boolean() }),
})
export type ByCustomerRead = z.infer<typeof byCustomerSchema>

export const readByCustomer = (api: ApiClient, signal?: AbortSignal): Promise<ByCustomerRead> => api.get('/people/by-customer', { schema: byCustomerSchema, signal })

export interface FactoryPeopleCard {
  /** The people given to this customer, by name: their role in words and since when. */
  readonly people: readonly { readonly userId: string; readonly name: string; readonly roleWords: string; readonly since: string }[]
  /** The door to People › People by customer (owner / admin only). */
  readonly door: boolean
}

/** This customer's given people (one row per person; an unknown person left out), and whether the door is drawn. */
export function factoryPeopleOf(read: ByCustomerRead, partyId: string): FactoryPeopleCard {
  const byUser = new Map(read.people.map((person) => [person.userId, person]))
  const seen = new Set<string>()
  const people: FactoryPeopleCard['people'][number][] = []
  for (const row of read.given) {
    if (row.partyId !== partyId || seen.has(row.userId)) continue
    const person = byUser.get(row.userId)
    if (!person) continue
    seen.add(row.userId)
    people.push({ userId: row.userId, name: person.name, roleWords: person.roleWords, since: row.since })
  }
  return { people: people.sort((a, b) => a.name.localeCompare(b.name)), door: read.may.write }
}

/** The card's read, only while the People tab shows; null: not read, refused, or failed (no card). */
export function useFactoryPeople(api: ApiClient, partyId: string, enabled: boolean): FactoryPeopleCard | null {
  const [card, setCard] = useState<FactoryPeopleCard | null>(null)
  useEffect(() => {
    if (!enabled) return
    const abort = new AbortController()
    readByCustomer(api, abort.signal)
      .then((read) => setCard(factoryPeopleOf(read, partyId)))
      .catch(() => setCard(null))
    return () => abort.abort()
  }, [api, partyId, enabled])
  return card
}
