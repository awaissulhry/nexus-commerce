import { describe, expect, it } from 'vitest'
import { grainPermission } from '../auth/grains/grains'
import type { Actor, Grant, Permission } from '../core/permissions'
import { mayOpenPriced, PRICED_LOCK, PRICED_REFUSALS, PRICED_WORDS, pricedDocumentHeld, pricedFileProblem, pricedUnmarkHeld, seesPrices } from './priced'

/** B-CP-014: the priced-file lock's rule (the money wall, design 11 D6). Every id is made up. */

const TENANT = '00000000-0000-4000-8000-0000000000a1'
const PARTY = '00000000-0000-4000-8000-0000000000b1'
const SITE = '00000000-0000-4000-8000-0000000000c1'
const grant = (permissions: readonly string[]): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all' })
const PRICE = grainPermission('price')
const actor = (audience: Actor['audience'], permissions: readonly string[]): Actor => ({
  audience,
  tenantId: TENANT,
  ...(audience === 'floor' ? { siteId: SITE } : {}),
  ...(audience === 'partner' || audience === 'link' ? { partyId: PARTY } : {}),
  grants: [grant(permissions)],
})

describe('who sees prices (the price grain, capped by the audience)', () => {
  it('the office with the price grain; the office without it never', () => {
    expect(seesPrices(actor('office', ['files.read', PRICE]))).toBe(true)
    expect(seesPrices(actor('office', ['files.read', 'orders.view']))).toBe(false)
    expect(seesPrices(actor('office', ['files.read', grainPermission('cost'), grainPermission('margin')]))).toBe(false)
  })

  it('a portal or link session through its own capped grain; the floor never, whatever its grants say; the system always', () => {
    expect(seesPrices(actor('partner', ['files.read', PRICE]))).toBe(true)
    expect(seesPrices(actor('partner', ['files.read']))).toBe(false)
    expect(seesPrices(actor('link', ['links.open', PRICE]))).toBe(true)
    expect(seesPrices(actor('link', ['links.open']))).toBe(false)
    expect(seesPrices(actor('floor', ['floor.work', PRICE]))).toBe(false)
    expect(seesPrices({ audience: 'system', tenantId: TENANT, grants: [] })).toBe(true)
    expect(seesPrices(null)).toBe(false)
  })
})

describe('the lock', () => {
  it('a priced file opens only for someone who sees prices; a file without prices for everyone (as the pack’s mayHave)', () => {
    expect(mayOpenPriced({ priced: true }, true)).toBe(true)
    expect(mayOpenPriced({ priced: true }, false)).toBe(false)
    expect(mayOpenPriced({ priced: false }, false)).toBe(true)
    expect(mayOpenPriced({}, false)).toBe(true)
    expect(mayOpenPriced({ priced: null }, false)).toBe(true)
    expect(PRICED_LOCK).toBe('PRICED')
  })

  it('a priced file is never shared with a floor, in words; a file without prices may be', () => {
    expect(pricedFileProblem({ priced: true, visibility: ['OFFICE', 'FLOOR'] })).toBe(PRICED_WORDS.floor.en)
    expect(pricedFileProblem({ priced: true, visibility: ['OFFICE', 'PARTNER'] })).toBeNull()
    expect(pricedFileProblem({ priced: false, visibility: ['OFFICE', 'FLOOR'] })).toBeNull()
  })
})

describe('the words (it + en), never an amount', () => {
  it('every word has both languages and names no figure', () => {
    for (const [key, words] of Object.entries(PRICED_WORDS)) {
      expect(words.it, key).not.toBe('')
      expect(words.en, key).not.toBe('')
      expect(`${words.it} ${words.en}`, key).not.toMatch(/\d|€|EUR/)
    }
    // The web's held words of the mailing (orders.json pricedPdf.held, F-CP-146) are the model.
    expect(PRICED_WORDS.send).toEqual({ it: 'Mostra dei prezzi: lo invia chi vede i prezzi.', en: 'It shows prices: it is sent by someone who sees prices.' })
    expect(PRICED_WORDS.locked.en).toBe('Priced document — you cannot open it')
  })

  it('making, mailing or opening a priced document is held with a 403 in words; so is taking the mark off', () => {
    for (const what of ['make', 'send', 'open'] as const) {
      const held = pricedDocumentHeld(what)
      expect(held.code).toBe('forbidden')
      expect(held.message).toBe(PRICED_WORDS[what].en)
      expect(held.issues).toEqual([{ path: `refusal/${PRICED_REFUSALS.HELD}`, message: PRICED_WORDS[what].en }])
    }
    expect(pricedUnmarkHeld()).toMatchObject({ code: 'forbidden', message: PRICED_WORDS.unmark.en, issues: [{ path: 'refusal/PRICED_UNMARK', message: PRICED_WORDS.unmark.en }] })
  })
})
