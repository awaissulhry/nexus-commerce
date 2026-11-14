import { describe, expect, it } from 'vitest'
import { costWordsIn, firstItems, mentionedIn, MIS_SEND_LIMITS, nameWords, partiesNamedIn, recipientOf, type RecipientFacts } from './rules'

/** The mis-send guard's rules (B-W2b-397; COL-004). Made-up names only. */

const nobody: RecipientFacts = { parties: [], colleague: false, ourDomain: false, domainParty: null }

describe('cost words', () => {
  it('finds cost, margin, markup and the purchase price in Italian and English, as whole words, without case or accents', () => {
    expect(costWordsIn('Il nostro COSTO è basso, il margine resta.')).toEqual(['costo', 'margine'])
    expect(costWordsIn('Our cost price and margins; the mark-up stays.')).toEqual(['cost', 'margins', 'mark-up'])
    expect(costWordsIn('La marginalità e il prezzo d’acquisto')).toEqual(['marginalita', "prezzo d'acquisto"])
    expect(costWordsIn('Prezzo di acquisto e listino fornitore')).toEqual(['prezzo di acquisto', 'listino fornitore'])
  })

  it('leaves words that only look alike, and a price said to a customer', () => {
    expect(costWordsIn('Costumi in pelle, costante qualità; la giacca costa 480 euro. Costumes.')).toEqual([])
    expect(costWordsIn('')).toEqual([])
  })
})

describe('another customer named', () => {
  const parties = [
    { id: 'p1', legalName: 'Rider Club S.r.l.', tradeName: null },
    { id: 'p2', legalName: 'Moto Uno S.p.A.', tradeName: 'Motouno' },
    { id: 'p3', legalName: 'Ab', tradeName: null },
    { id: 'p4', legalName: 'Rossi & C. S.n.c.', tradeName: null },
  ]

  it('names a party by its legal name without the legal form, or by its trade name, as whole words', () => {
    expect(nameWords('Rider Club S.r.l.')).toEqual(['rider', 'club'])
    expect(nameWords('Moto Uno S.p.A.')).toEqual(['moto', 'uno'])
    expect(nameWords('Rossi & C. S.n.c.')).toEqual(['rossi'])
    expect(partiesNamedIn('Come per Rider Club, la consegna slitta.', parties).map((party) => party.id)).toEqual(['p1'])
    expect(partiesNamedIn('Lo stesso modello di MOTOUNO.', parties).map((party) => party.id)).toEqual(['p2'])
    expect(partiesNamedIn('Parlato con i Rossi ieri', parties).map((party) => party.id)).toEqual(['p4'])
  })

  it('never a part of a word nor a name too short to tell', () => {
    expect(partiesNamedIn('Riders clubbing; ab ovo; Motounox', parties)).toEqual([])
  })
})

describe('@mentions of colleagues', () => {
  const people = [
    { id: 'u1', displayName: 'Marco Bianchi' },
    { id: 'u2', displayName: 'Marco Verdi' },
    { id: 'u3', displayName: 'Giulia Neri' },
  ]

  it('finds a full name first, else everyone of the first name; never an address', () => {
    expect(mentionedIn('@Marco Verdi ci pensi tu?', people).map((person) => person.id)).toEqual(['u2'])
    expect(mentionedIn('Chiedo a @marco', people).map((person) => person.id)).toEqual(['u1', 'u2'])
    expect(mentionedIn('(@Giulia) e @nessuno', people).map((person) => person.id)).toEqual(['u3'])
    expect(mentionedIn('Scrivi a giulia@example.invalid o marco.verdi@example.invalid', people)).toEqual([])
  })
})

describe('whose a recipient is', () => {
  it('the record’s party wins, then another party, then ours, then a domain, else unknown', () => {
    expect(recipientOf({ ...nobody, parties: [{ partyId: 'other', source: 'CONTACT', name: 'A' }, { partyId: 'mine', source: 'CONTACT', name: 'B' }] }, 'mine')).toEqual({ kind: 'PARTY', source: 'CONTACT', partyId: 'mine', personName: 'B' })
    expect(recipientOf({ ...nobody, parties: [{ partyId: 'other', source: 'PORTAL_PERSON', name: 'A' }] }, 'mine')).toEqual({ kind: 'OTHER_PARTY', source: 'PORTAL_PERSON', partyId: 'other', personName: 'A' })
    expect(recipientOf({ ...nobody, colleague: true }, 'mine').kind).toBe('OURS')
    expect(recipientOf({ ...nobody, ourDomain: true }, 'mine')).toEqual({ kind: 'OURS', source: 'OUR_DOMAIN', partyId: null, personName: null })
    expect(recipientOf({ ...nobody, domainParty: 'mine' }, 'mine')).toEqual({ kind: 'PARTY', source: 'DOMAIN', partyId: 'mine', personName: null })
    expect(recipientOf({ ...nobody, domainParty: 'other' }, 'mine').kind).toBe('OTHER_PARTY')
    expect(recipientOf(nobody, 'mine')).toEqual({ kind: 'UNKNOWN', source: null, partyId: null, personName: null })
  })

  it('says each item once and at most ten', () => {
    expect(firstItems(['a', 'a', 'b'])).toEqual(['a', 'b'])
    expect(firstItems(Array.from({ length: 20 }, (_, index) => `x${index}`))).toHaveLength(MIS_SEND_LIMITS.items)
  })
})
