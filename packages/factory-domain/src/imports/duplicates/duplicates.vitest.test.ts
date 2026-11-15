import { describe, expect, it } from 'vitest'
import { codeKey, emailDomain, nameKey, nameScore, searchWords, storedVatNumbers, taxKeys, websiteHost } from './match'
import {
  byLikelihood,
  coloursToMove,
  contactsToMove,
  likelihoodOf,
  materialKeys,
  materialReasons,
  mergeReasonProblem,
  mergeRefusals,
  partyKeys,
  partyReasons,
  useGroupOf,
  useGroups,
  type MergeFacts,
} from './rules'
import { IMPORTS_DUPLICATES_ADDS, IMPORTS_DUPLICATES_DEFINITIONS } from './permissions'

describe('names', () => {
  it('drops legal forms, small words, accents, punctuation and word order', () => {
    expect(nameKey('Pelletteria Rossi S.r.l.')).toBe('pelletteria rossi')
    expect(nameKey('ROSSI PELLETTERIA SRL')).toBe('pelletteria rossi')
    expect(nameKey('Conceria della Città S.p.A.')).toBe('citta conceria')
    expect(nameKey('Bianchi & Figli GmbH')).toBe('bianchi figli')
    expect(nameKey('S.r.l.')).toBe('')
    expect(nameKey(null)).toBe('')
  })

  it('scores equal keys 1, near ones high and other ones low; short keys only when equal', () => {
    expect(nameScore('pelletteria rossi', 'pelletteria rossi')).toBe(1)
    expect(nameScore('pelletterie rossi', 'pelletteria rossi')).toBeGreaterThanOrEqual(0.82)
    expect(nameScore('conceria rossi', 'conceria russo')).toBeLessThan(0.82)
    expect(nameScore('abc', 'abd')).toBe(0)
    expect(nameScore('', 'abc')).toBe(0)
  })

  it('searches by the longest words worth searching', () => {
    expect(searchWords('Pelletteria Rossi di Firenze S.r.l.')).toEqual(['pelletteria', 'firenze', 'rossi'])
    expect(searchWords('AB SRL')).toEqual([])
  })
})

describe('mail, website, codes and tax numbers', () => {
  it('keeps a company domain and drops public and certified-mail ones', () => {
    expect(emailDomain('Ordini@Rossi.Example')).toBe('rossi.example')
    expect(emailDomain('mario@libero.it')).toBeNull()
    expect(emailDomain('amministrazione@pec.it')).toBeNull()
    expect(emailDomain('not an address')).toBeNull()
  })

  it('reads a website as its host', () => {
    expect(websiteHost('https://www.rossi.example/chi-siamo')).toBe('rossi.example')
    expect(websiteHost('rossi.example')).toBe('rossi.example')
    expect(websiteHost('nope')).toBeNull()
  })

  it('compares codes without spaces and dashes', () => {
    expect(codeKey('pel-001 ')).toBe('PEL001')
    expect(codeKey('PEL 001')).toBe(codeKey('PEL001'))
  })

  it('compares VAT numbers without their prefix and reads a company codice fiscale as its VAT number', () => {
    expect(taxKeys(['IT 01234567890'], [])).toEqual({ vat: ['01234567890'], fiscal: ['01234567890'] })
    expect(taxKeys(['DE123456789'], [])).toEqual({ vat: ['123456789'], fiscal: [] })
    expect(taxKeys([], ['01234567890'])).toEqual({ vat: ['01234567890'], fiscal: ['01234567890'] })
    expect(taxKeys([], ['RSSMRA80A01H501U'])).toEqual({ vat: [], fiscal: ['RSSMRA80A01H501U'] })
    expect(storedVatNumbers(['01234567890'], 'IT')).toEqual(['01234567890', 'IT01234567890'])
    expect(storedVatNumbers(['123456789'], 'GR')).toEqual(['123456789', 'EL123456789', 'IT123456789'])
  })
})

describe('parties alike', () => {
  const rossi = partyKeys({ legalName: 'Pelletteria Rossi S.r.l.', vatNumbers: ['IT01234567890'], emails: ['ordini@rossi.example'], website: 'https://rossi.example' })

  it('says the same VAT number, the same name and the same domain (the website once, as the domain)', () => {
    const other = partyKeys({ legalName: 'PELLETTERIA ROSSI SRL', fiscalCodes: ['01234567890'], emails: ['info@rossi.example'], website: 'www.rossi.example' })
    expect(partyReasons(other, rossi).map((reason) => reason.code)).toEqual(['SAME_VAT_NUMBER', 'SAME_NAME', 'SAME_EMAIL_DOMAIN'])
    expect(partyReasons(other, rossi)[2]?.detail).toBe('rossi.example')
  })

  it('says a similar name with its score, and the website when no contact shares the domain', () => {
    const other = partyKeys({ tradeName: 'Pelletterie Rossi', website: 'rossi.example' })
    const reasons = partyReasons(other, partyKeys({ legalName: 'Pelletteria Rossi S.r.l.', website: 'https://rossi.example' }))
    expect(reasons.map((reason) => reason.code)).toEqual(['SIMILAR_NAME', 'SAME_WEBSITE'])
    expect(reasons[0]?.score).toBeGreaterThanOrEqual(82)
    expect(likelihoodOf(reasons)).toBe('MEDIUM')
  })

  it('finds nothing between different businesses, nor through a public mailbox', () => {
    expect(partyReasons(partyKeys({ legalName: 'Conceria Russo', emails: ['a@libero.it'] }), partyKeys({ legalName: 'Conceria Rossi', emails: ['b@libero.it'] }))).toEqual([])
  })

  it('orders HIGH first, then more reasons, then by code', () => {
    const list = [
      { code: 'B', reasons: [{ code: 'SIMILAR_NAME' as const, detail: null, score: 90 }] },
      { code: 'C', reasons: [{ code: 'SAME_VAT_NUMBER' as const, detail: null, score: null }] },
      { code: 'A', reasons: [{ code: 'SIMILAR_NAME' as const, detail: null, score: 85 }, { code: 'SAME_WEBSITE' as const, detail: 'x.example', score: null }] },
    ]
    expect([...list].sort(byLikelihood).map((item) => item.code)).toEqual(['C', 'A', 'B'])
  })
})

describe('materials alike', () => {
  it('says the same code, the same supplier code of the same supplier, and the name', () => {
    const a = materialKeys({ code: 'PEL-001', name: 'Vitello nappa nero', supplierId: 's1', supplierArticleCode: 'VN 100' })
    const b = materialKeys({ code: 'PEL001', name: 'Vitello Nappa Nero', supplierId: 's1', supplierArticleCode: 'vn-100' })
    expect(materialReasons(a, b).map((reason) => reason.code)).toEqual(['SAME_CODE', 'SAME_SUPPLIER_CODE', 'SAME_NAME'])
    expect(likelihoodOf(materialReasons(a, b))).toBe('HIGH')
  })

  it('never matches a supplier code of another supplier, nor a short one', () => {
    const a = materialKeys({ code: 'A1', supplierId: 's1', supplierArticleCode: 'VN100' })
    expect(materialReasons(a, materialKeys({ code: 'B1', supplierId: 's2', supplierArticleCode: 'VN100' }))).toEqual([])
    expect(materialReasons(materialKeys({ code: 'A1', supplierArticleCode: 'X1' }), materialKeys({ code: 'B1', supplierArticleCode: 'X1' }))).toEqual([])
  })
})

describe('the merge', () => {
  const side = (id: string, extra: Partial<MergeFacts['kept']> = {}) => ({ id, code: id.toUpperCase(), status: 'ACTIVE', companyId: null, ...extra })
  const facts = (extra: Partial<MergeFacts> = {}): MergeFacts => ({ recordType: 'PARTY', kept: side('a'), dropped: side('b'), uses: [], mayChangeBoth: true, ...extra })

  it('may go ahead for a free duplicate', () => {
    expect(mergeRefusals(facts())).toEqual([])
  })

  it('refuses itself, archived and blocked sides, other companies and a duplicate in use', () => {
    expect(mergeRefusals(facts({ dropped: side('a') }))).toEqual(['SAME_RECORD'])
    expect(mergeRefusals(facts({ kept: side('a', { status: 'ARCHIVED' }), dropped: side('b', { status: 'BLOCKED' }) }))).toEqual(['KEPT_ARCHIVED', 'DROPPED_BLOCKED'])
    expect(mergeRefusals(facts({ kept: side('a', { companyId: 'c1' }), dropped: side('b', { companyId: 'c2' }) }))).toEqual(['OTHER_COMPANY'])
    expect(mergeRefusals(facts({ kept: side('a', { companyId: 'c1' }) }))).toEqual(['EVERY_COMPANY'])
    expect(mergeRefusals(facts({ kept: side('a'), dropped: side('b', { companyId: 'c1' }) }))).toEqual([])
    expect(mergeRefusals(facts({ uses: [{ table: 'SalesOrder', count: 2 }], mayChangeBoth: false }))).toEqual(['IN_USE', 'NO_RIGHT'])
    expect(mergeRefusals(facts({ recordType: 'MATERIAL', kept: side('a', { kind: 'LEATHER' }), dropped: side('b', { kind: 'TRIM' }) }))).toEqual(['KIND_DIFFERS'])
  })

  it('names what uses a record by group', () => {
    expect(useGroupOf('SalesOrder')).toBe('SALES')
    expect(useGroupOf('Invoice')).toBe('MONEY')
    expect(useGroupOf('PurchaseOrderLine')).toBe('PURCHASING')
    expect(useGroupOf('Lot')).toBe('STOCK')
    expect(useGroupOf('Something')).toBe('OTHER')
    expect(useGroups([{ table: 'Quote', count: 1 }, { table: 'SalesOrder', count: 2 }, { table: 'Invoice', count: 1 }, { table: 'Zed', count: 0 }])).toEqual([
      { group: 'SALES', count: 3, tables: ['Quote', 'SalesOrder'] },
      { group: 'MONEY', count: 1, tables: ['Invoice'] },
    ])
  })

  it('moves the contacts whose e-mail the record that stays lacks, and the colours whose code it lacks', () => {
    const contacts = [{ id: '1', email: 'Anna@rossi.example' }, { id: '2', email: null }, { id: '3', email: 'luca@rossi.example' }, { id: '4', email: 'luca@rossi.example' }]
    const result = contactsToMove(contacts, ['anna@rossi.example'])
    expect(result.move.map((contact) => contact.id)).toEqual(['2', '3'])
    expect(result.stay.map((contact) => contact.id)).toEqual(['1', '4'])
    const colours = coloursToMove([{ code: 'NER' }, { code: 'TAN' }, { code: 'ta-n' }], ['ner'])
    expect(colours.move.map((colour) => colour.code)).toEqual(['TAN'])
    expect(colours.stay.map((colour) => colour.code)).toEqual(['NER', 'ta-n'])
  })

  it('asks for a reason of 3 to 500 characters', () => {
    expect(mergeReasonProblem(' no')).not.toBeNull()
    expect(mergeReasonProblem('Same customer typed twice')).toBeNull()
    expect(mergeReasonProblem('x'.repeat(501))).not.toBeNull()
  })

  it('declares imports.duplicates.merge for the templates that keep parties or materials', () => {
    expect(IMPORTS_DUPLICATES_DEFINITIONS.map((definition) => [definition.name, definition.risk])).toEqual([['imports.duplicates.merge', 'write']])
    expect(Object.keys(IMPORTS_DUPLICATES_ADDS).sort()).toEqual(['buyer', 'finance', 'production_manager', 'sales'])
  })
})
