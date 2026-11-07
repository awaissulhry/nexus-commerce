import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PARTNER_ROLE_TEMPLATES, ROLE_TEMPLATES } from '../../auth/roles/templates'
import { queryWords } from '../text'
import { GROUPS_OF_KIND, partnerSearchAnswer, partnerSearchQuery, PARTNER_SEARCH_GROUPS } from './contracts'
import { compareHits, partnerMatchOf, partnerTextOf, singleOf, trigramsOf, wordSimilarity } from './match'
import { PORTAL_SEARCH } from './permissions'

const order = { theirRef: 'PO-4471/B', ourRef: 'ORD-2026-00042', words: ['SH-2026-0007', '1Z999AA10123456784'] }

describe('portal search: how a partner query matches its record (B-W2b-168; SAL-084)', () => {
  it('finds their reference typed whole first, then our number', () => {
    expect(partnerMatchOf(queryWords('po-4471/b'), order)).toMatchObject({ match: 'theirs', rank: 0 })
    expect(partnerMatchOf(queryWords(' PO-4471/B '), order)).toMatchObject({ match: 'theirs' })
    expect(partnerMatchOf(queryWords('ORD-2026-00042'), order)).toMatchObject({ match: 'ours', rank: 1 })
  })

  it('finds every word inside the partner fields as typed, and a typo by a word alike', () => {
    expect(partnerMatchOf(queryWords('4471'), order)).toMatchObject({ match: 'words', rank: 2, score: 1 })
    expect(partnerMatchOf(queryWords('00042 sh-2026'), order)).toMatchObject({ match: 'words', score: 2 })
    // A tracking number they were given is theirs to type.
    expect(partnerMatchOf(queryWords('1Z999AA10123456784'), order)).toMatchObject({ match: 'words' })
    const pista = { theirRef: null, ourRef: 'Q-2026-0003', words: ['Pista Racing'] }
    const typo = partnerMatchOf(queryWords('pisra'), pista)
    expect(typo).toMatchObject({ match: 'similar', rank: 3 })
    expect(typo!.score).toBeGreaterThanOrEqual(0.45)
    // A number or a code matches only as typed: a mistyped number never finds another record.
    const shipment = { theirRef: 'SEED-PO-78', ourRef: 'SEED-SH-0001', words: ['SEEDTRACK0002'] }
    expect(partnerMatchOf(queryWords('SEED-SH-0002'), shipment)).toBeNull()
    expect(partnerMatchOf(queryWords('0002'), shipment)).toMatchObject({ match: 'words' })
  })

  it('refuses a record the query does not match on its partner fields', () => {
    // Every word must be found: one missing word is no match.
    expect(partnerMatchOf(queryWords('4471 zebra'), order)).toBeNull()
    // A short word is never matched by similarity.
    expect(partnerMatchOf(queryWords('zz'), order)).toBeNull()
    expect(partnerMatchOf(queryWords('x'), order)).toBeNull()
    // A word only the office sees is not among the partner fields: no match.
    expect(partnerMatchOf(queryWords('cutting'), { theirRef: null, ourRef: 'SC-2026-0001', words: [] })).toBeNull()
  })

  it('orders hits their reference first, then ours, words, words alike, then how alike', () => {
    const hits = [
      partnerMatchOf(queryWords('pisra'), { theirRef: null, ourRef: null, words: ['pista'] })!,
      partnerMatchOf(queryWords('ORD-2026-00042'), order)!,
      partnerMatchOf(queryWords('4471'), order)!,
      partnerMatchOf(queryWords('PO-4471/B'), order)!,
    ]
    expect([...hits].sort(compareHits).map((hit) => hit.match)).toEqual(['theirs', 'ours', 'words', 'similar'])
  })

  it('opens the single match directly: the only result, or the only reference typed whole', () => {
    expect(singleOf([{ match: 'words' as const, id: 'a' }])?.id).toBe('a')
    // A guess (a word alike) is never opened for the person.
    expect(singleOf([{ match: 'similar' as const, id: 'a' }])).toBeNull()
    expect(singleOf([{ match: 'words' as const, id: 'a' }, { match: 'theirs' as const, id: 'b' }])?.id).toBe('b')
    expect(singleOf([{ match: 'ours' as const, id: 'a' }, { match: 'theirs' as const, id: 'b' }])).toBeNull()
    expect(singleOf([])).toBeNull()
  })

  it('reads trigrams as pg_trgm does and folds the fields as the index does', () => {
    expect([...trigramsOf('ab')]).toEqual(['  a', ' ab', 'ab '])
    expect(wordSimilarity('pista', 'ord-1 pista racing')).toBe(1)
    expect(wordSimilarity('zzz', 'pista')).toBe(0)
    expect(partnerTextOf({ theirRef: 'Società Pista', ourRef: 'ORD-1', words: [null, '  '] })).toBe('ord-1 societa pista')
  })
})

describe('portal search: the contract, the groups and the permission', () => {
  it('groups by the partner kind’s portal', () => {
    expect(GROUPS_OF_KIND.CUSTOMER).toEqual(['orders', 'documents', 'returns'])
    expect(GROUPS_OF_KIND.SUPPLIER[0]).toBe('pos')
    expect(GROUPS_OF_KIND.SUBCONTRACTOR[0]).toBe('jobs')
    for (const groups of Object.values(GROUPS_OF_KIND)) for (const group of groups) expect(PARTNER_SEARCH_GROUPS).toContain(group)
  })

  it('reads a query and checks an answer', () => {
    expect(partnerSearchQuery.parse({ q: 'PO-4471' })).toEqual({ q: 'PO-4471', limit: 5 })
    expect(() => partnerSearchQuery.parse({ q: 'x', group: 'invoices' })).toThrow()
    const result = { recordType: 'SalesOrder', recordId: '0190f0e8-0000-7000-8000-000000000001', group: 'orders', theirRef: 'PO-4471', ourRef: 'ORD-1', subtitle: null, status: 'CONFIRMED', date: null, match: 'theirs' }
    expect(partnerSearchAnswer.parse({ query: 'po-4471', words: ['po-4471'], tooShort: false, groups: [{ group: 'orders', count: 1, results: [result] }], found: 1, single: result, capped: false }).single?.theirRef).toBe('PO-4471')
  })

  it('is a partner permission every main partner role holds, never an office or floor role', () => {
    expect(FACTORY_PERMISSIONS.get(PORTAL_SEARCH)?.partner).toBe(true)
    expect(FACTORY_PERMISSIONS.assignable.map((definition) => definition.name)).not.toContain(PORTAL_SEARCH)
    for (const template of ROLE_TEMPLATES) expect(template.permissions).not.toContain(PORTAL_SEARCH)
    const main = PARTNER_ROLE_TEMPLATES.filter((template) => !template.key.startsWith('partner-'))
    expect(main.length).toBeGreaterThan(0)
    for (const template of main) expect(template.permissions, template.key).toContain(PORTAL_SEARCH)
    for (const template of PARTNER_ROLE_TEMPLATES.filter((entry) => entry.key.startsWith('partner-'))) expect(template.permissions).not.toContain(PORTAL_SEARCH)
  })
})
