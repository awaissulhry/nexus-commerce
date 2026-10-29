import { describe, expect, it } from 'vitest'
import {
  chooseDocument,
  documentTitle,
  languageChain,
  languagesText,
  linkDocuments,
  linkRecipients,
  LINK_EXPIRY_DAYS,
  LINK_MAX_USES,
  renewalRefusal,
  retainedFiles,
  retainUntilFor,
  shipmentDocuments,
  toAttach,
  type DocOnFile,
  type RenewalFacts,
  type SharedFile,
  type ShipmentDocumentsFacts,
  type StyleOnShipment,
} from './documents'
import { documentsLinkMail } from './mail'

const sha = (seed: string) => seed.padEnd(64, '0')
const file = (seed: string) => ({ id: `0195f5d0-0000-7000-8000-${seed.padStart(12, '0')}`, originalName: `${seed}.pdf`, sha256: sha(seed), sizeBytes: 100 })
const shared = (seed: string, at = '2026-11-24T10:00:00.000Z'): SharedFile => ({ ...file(`c${seed}`), sha256: sha(seed), contentType: 'application/pdf', availableAt: at })
const doc = (language: string, seed: string, revision = 1): DocOnFile => ({ documentId: file(`d${seed}`).id, language, revision, number: `DOC-${seed}`, issuedAt: '2026-11-01T09:00:00.000Z', file: file(seed) })
const style = (code: string, onFile: Partial<StyleOnShipment['onFile']> = {}, extra: Partial<StyleOnShipment> = {}): StyleOnShipment => ({
  styleId: file(`s${code}`).id,
  code,
  name: `Jacket ${code}`,
  revision: 1,
  documentsRequired: true,
  garments: 2,
  onFile: { DECLARATION_OF_CONFORMITY: [], USER_INFORMATION: [], ...onFile },
  ...extra,
})
const facts = (extra: Partial<ShipmentDocumentsFacts> = {}): ShipmentDocumentsFacts => ({
  shipment: { number: 'SH-1', status: 'PACKED' },
  wantedLanguage: 'de',
  styles: [],
  ddt: { required: true, live: { id: file('ddt').id, number: '12/2026', documentDate: '2026-11-24', pdf: file('ddtpdf') } },
  packingList: null,
  shared: [],
  ...extra,
})
const byKey = (result: ReturnType<typeof shipmentDocuments>) => Object.fromEntries(result.documents.map((document) => [document.key.split(':')[0] + (document.style ? `:${document.style.code}` : ''), document]))

describe('the languages a DoC and a leaflet are looked for in', () => {
  it('asks the buyer\'s language first, then English, then Italian, each once', () => {
    expect(languageChain('de')).toEqual(['de', 'en', 'it'])
    expect(languageChain(' IT ')).toEqual(['it', 'en'])
    expect(languageChain('en')).toEqual(['en', 'it'])
    expect(languageChain('xx')).toEqual(['en', 'it'])
    expect(languageChain(null)).toEqual(['en', 'it'])
    expect(languagesText(['de', 'en', 'it'])).toBe('de, en or it')
    expect(languagesText(['it'])).toBe('it')
  })

  it('takes the first language of the chain that has one, whatever order they were found in', () => {
    expect(chooseDocument(['de', 'en', 'it'], [doc('it', 'a'), doc('en', 'b')])?.language).toBe('en')
    expect(chooseDocument(['de', 'en', 'it'], [doc('it', 'a'), doc('de', 'c')])?.language).toBe('de')
    expect(chooseDocument(['de', 'en', 'it'], [doc('fr', 'a')])).toBeNull()
  })
})

describe('the documents of a shipment', () => {
  it('chooses the DoC in the buyer\'s language, the leaflet in a fallback (said, not blocking), and attaches nothing yet', () => {
    const result = shipmentDocuments(facts({ styles: [style('JKT', { DECLARATION_OF_CONFORMITY: [doc('en', 'e'), doc('de', 'g')], USER_INFORMATION: [doc('it', 'l')] })] }))
    const documents = byKey(result)
    expect(result.languages).toEqual(['de', 'en', 'it'])
    expect(documents['DECLARATION_OF_CONFORMITY:JKT']).toMatchObject({ state: 'ON_FILE', language: 'de', fallback: false, byLink: true, number: 'DOC-g', source: { sha256: sha('g') }, copy: null })
    expect(documents['USER_INFORMATION:JKT']).toMatchObject({ state: 'ON_FILE', language: 'it', fallback: true, wantedLanguage: 'de' })
    expect(documents['USER_INFORMATION:JKT']!.message).toBe('The user information leaflet of JKT (revision 1) in it is on file: attaching copies it onto the shipment for the link. It is not on file in de: the one in it travels instead.')
    expect(result.warnings).toEqual([
      {
        path: 'documents/USER_INFORMATION/JKT',
        message: 'The user information leaflet of JKT is not on file in de: the one in it travels. Upload the signed one in de when the country the goods are sold in asks for it (Reg. (EU) 2016/425 art. 8(7), Annex II 1.4).',
      },
    ])
    expect(result.checks.map((check) => [check.code, check.state, check.blocks])).toEqual([
      ['DECLARATION_OF_CONFORMITY', 'OK', ['SHIPPING']],
      ['USER_INFORMATION', 'OK', ['SHIPPING']],
    ])
    expect(result.blockers).toEqual([])
    expect(result.counts).toEqual({ attached: 0, toAttach: 3, missing: 1 })
    expect(documents.PACKING_LIST).toMatchObject({ state: 'MISSING', byLink: false })
  })

  it('blocks shipping, in the compliance step\'s shape and words, when a PPE style has no DoC in any language of the chain', () => {
    const result = shipmentDocuments(facts({ wantedLanguage: 'it', styles: [style('JKT', { USER_INFORMATION: [doc('it', 'l')] }), style('VEST', {}, { documentsRequired: false })] }))
    expect(result.blockers).toEqual([
      {
        code: 'DECLARATION_OF_CONFORMITY',
        state: 'BLOCKED',
        blocks: ['SHIPPING'],
        message: 'The EU Declaration of Conformity is not on file for JKT revision 1 (Reg. (EU) 2016/425 art. 8(8), art. 15): PPE is shipped only with it.',
        problems: [
          {
            path: 'documents/DECLARATION_OF_CONFORMITY/JKT',
            message: 'No signed EU Declaration of Conformity of JKT for revision 1 is on file in it or en: PPE is shipped only with it (Reg. (EU) 2016/425 art. 8(8), art. 15).',
          },
        ],
      },
    ])
    const documents = byKey(result)
    expect(documents['DECLARATION_OF_CONFORMITY:VEST']).toMatchObject({ state: 'NOT_REQUIRED', message: 'VEST is not PPE: no EU Declaration of Conformity travels with it.' })
  })

  it('says a style with no frozen revision is missing its documents, and that a shipment of no PPE needs none', () => {
    const missing = shipmentDocuments(facts({ styles: [style('JKT', {}, { revision: null })] }))
    expect(missing.blockers.map((check) => check.code)).toEqual(['DECLARATION_OF_CONFORMITY', 'USER_INFORMATION'])
    expect(byKey(missing)['DECLARATION_OF_CONFORMITY:JKT']!.message).toBe(
      'The garments of JKT come from a work order with no frozen style revision, so no EU Declaration of Conformity can be chosen for them.',
    )
    const none = shipmentDocuments(facts({ styles: [style('VEST', {}, { documentsRequired: false })] }))
    expect(none.checks.map((check) => check.state)).toEqual(['NOT_REQUIRED', 'NOT_REQUIRED'])
  })

  it('counts a copy as attached only when it holds exactly the same bytes (SHA-256) and is shared with the party', () => {
    const styles = [style('JKT', { DECLARATION_OF_CONFORMITY: [doc('it', 'g')], USER_INFORMATION: [doc('it', 'l')] })]
    const result = shipmentDocuments(facts({ wantedLanguage: 'it', styles, shared: [shared('g'), shared('ddtpdf'), shared('old')] }))
    const documents = byKey(result)
    expect(documents['DECLARATION_OF_CONFORMITY:JKT']).toMatchObject({ state: 'ATTACHED', copy: { sha256: sha('g') } })
    expect(documents.DDT).toMatchObject({ state: 'ATTACHED', number: '12/2026', message: 'DDT 12/2026 is attached: it travels by the link.' })
    expect(documents['USER_INFORMATION:JKT']).toMatchObject({ state: 'ON_FILE', copy: null })
    expect(toAttach(result.documents).map((document) => document.kind)).toEqual(['USER_INFORMATION'])
    expect(result.counts).toEqual({ attached: 2, toAttach: 1, missing: 1 })
    // Kept ten years: every travelling source and its copy.
    expect(retainedFiles(result.documents)).toEqual([file('ddtpdf').id, file('g').id, file('l').id, shared('g').id, shared('ddtpdf').id].sort())
  })

  it('copies one file once when two documents share it, and never the packing list', () => {
    const same = doc('it', 'same')
    const result = shipmentDocuments(facts({ wantedLanguage: 'it', styles: [style('A', { DECLARATION_OF_CONFORMITY: [same] }), style('B', { DECLARATION_OF_CONFORMITY: [same] })], packingList: file('pl') }))
    expect(toAttach(result.documents).map((document) => document.key.split(':')[0])).toEqual(['DDT', 'DECLARATION_OF_CONFORMITY'])
    expect(byKey(result).PACKING_LIST).toMatchObject({ state: 'ON_FILE', byLink: false })
  })

  it('names the DDT\'s state: none, issued without its PDF, stored, not needed', () => {
    expect(byKey(shipmentDocuments(facts({ ddt: { required: true, live: null } }))).DDT).toMatchObject({ state: 'MISSING', message: 'The shipment has no live DDT: issue it first.' })
    expect(byKey(shipmentDocuments(facts({ ddt: { required: true, live: { id: file('d').id, number: '7/2026', documentDate: '2026-11-24', pdf: null } } }))).DDT).toMatchObject({
      state: 'MISSING',
      message: 'DDT 7/2026 is issued, but its PDF is not stored yet: print it again, then attach the documents.',
    })
    expect(byKey(shipmentDocuments(facts())).DDT).toMatchObject({ state: 'ON_FILE' })
    expect(byKey(shipmentDocuments(facts({ ddt: { required: false, live: null } }))).DDT).toMatchObject({ state: 'NOT_REQUIRED' })
  })
})

describe('what a link lists', () => {
  it('lists exactly the shared files, each named after the document it copies, others by their name', () => {
    const styles = [style('JKT', { DECLARATION_OF_CONFORMITY: [doc('it', 'g')], USER_INFORMATION: [doc('it', 'l')] })]
    const files = [shared('zzz-other'), shared('l'), shared('g'), shared('ddtpdf')]
    const result = shipmentDocuments(facts({ wantedLanguage: 'it', styles, shared: files }))
    const listed = linkDocuments(files, result.documents)
    expect(listed.map((entry) => [entry.kind, entry.title])).toEqual([
      ['DDT', 'DDT 12/2026'],
      ['DECLARATION_OF_CONFORMITY', 'EU Declaration of Conformity, JKT revision 1 (it)'],
      ['USER_INFORMATION', 'User information, JKT revision 1 (it)'],
      ['OTHER', 'czzz-other.pdf'],
    ])
    expect(new Set(listed.map((entry) => entry.fileId))).toEqual(new Set(files.map((entry) => entry.id)))
    expect(linkDocuments([], result.documents)).toEqual([])
    expect(documentTitle({ kind: 'DECLARATION_OF_CONFORMITY', number: null, style: { id: file('s').id, code: 'JKT', name: 'J', revision: 2 }, language: 'it' }, 'it')).toBe('Dichiarazione UE di conformità, JKT rev. 2 (it)')
  })
})

describe('who gets the link, and a new one', () => {
  const contact = (id: string, name: string, email: string | null, roles: string[], status = 'ACTIVE') => ({ id, name, email, roles, status })

  it('sends to the party\'s ACTIVE orders and quality contacts with an address, once per address', () => {
    const recipients = linkRecipients([
      contact('1', 'Buyer', 'buyer@example.com', ['ORDERS']),
      contact('2', 'Accounts', 'accounts@example.com', ['INVOICES']),
      contact('3', 'Quality', 'quality@example.com', ['QUALITY', 'DESIGN']),
      contact('4', 'Again', 'Buyer@Example.com', ['QUALITY']),
      contact('5', 'Gone', 'gone@example.com', ['ORDERS'], 'ARCHIVED'),
      contact('6', 'Rider', null, ['ORDERS']),
    ])
    expect(recipients.map((entry) => entry.id)).toEqual(['4', '3'])
  })

  it('makes a new link only for an expired or used-up shipment link, to an address still on file, not twice in ten minutes', () => {
    const base: RenewalFacts = {
      purpose: 'DOCUMENT_VIEW',
      recordType: 'Shipment',
      revoked: false,
      email: 'buyer@example.com',
      state: 'EXPIRED',
      shipmentStatus: 'SHIPPED',
      contacts: [contact('1', 'Buyer', 'buyer@example.com', ['ORDERS'])],
      askedRecently: false,
    }
    expect(renewalRefusal(base)).toBeNull()
    expect(renewalRefusal({ ...base, state: 'USED_UP' })).toBeNull()
    expect(renewalRefusal({ ...base, purpose: 'QUOTE_ACCEPT' })).toBe('NOT_A_SHIPMENT_LINK')
    expect(renewalRefusal({ ...base, recordType: 'StoredFile' })).toBe('NOT_A_SHIPMENT_LINK')
    expect(renewalRefusal({ ...base, revoked: true })).toBe('WITHDRAWN')
    expect(renewalRefusal({ ...base, email: null })).toBe('NO_ADDRESS')
    expect(renewalRefusal({ ...base, state: 'LIVE' })).toBe('STILL_LIVE')
    expect(renewalRefusal({ ...base, shipmentStatus: 'CANCELLED' })).toBe('SHIPMENT_CANCELLED')
    expect(renewalRefusal({ ...base, contacts: [contact('1', 'Buyer', 'buyer@example.com', ['ORDERS'], 'ARCHIVED')] })).toBe('ADDRESS_NOT_ON_FILE')
    expect(renewalRefusal({ ...base, askedRecently: true })).toBe('ASKED_RECENTLY')
  })

  it('gives the shipment\'s link the purpose\'s longest life, and keeps the files ten years after the goods left', () => {
    expect([LINK_EXPIRY_DAYS, LINK_MAX_USES]).toEqual([365, 100])
    expect(retainUntilFor(new Date('2026-11-24T08:00:00.000Z'), new Date('2027-01-01T00:00:00.000Z')).toISOString()).toBe('2036-11-24T08:00:00.000Z')
    expect(retainUntilFor(null, new Date('2026-11-20T08:00:00.000Z')).toISOString()).toBe('2036-11-20T08:00:00.000Z')
  })
})

describe('the link mail', () => {
  const input = { locale: 'en' as const, shipmentNumber: 'SH-1', orderNumber: 'SO-9', customerRef: 'PO-77', titles: ['DDT 12/2026', 'EU Declaration of Conformity, JKT revision 1 (it)'], expiresAt: new Date('2027-11-24T09:00:00.000Z'), renewal: false }

  it('carries the link in the mail, never in the text the thread keeps', () => {
    const url = 'http://localhost:3200/l#token=t.p.l.secret'
    const sent = documentsLinkMail(input, url)
    expect(sent.subject).toBe('Shipment SH-1: documents and declaration of conformity')
    expect(sent.body).toContain(`on this page:\n${url}`)
    expect(sent.body).toContain('(your order PO-77)')
    expect(sent.body).toContain('- EU Declaration of Conformity, JKT revision 1 (it)')
    expect(sent.body).toContain('The link works until 24/11/2027, 10:00 (Europe/Rome).')
    const kept = documentsLinkMail(input, null)
    expect(kept.body).not.toContain('token')
    expect(kept.body).toContain('[A personal link, sent by e-mail only: it is not kept here.]')
    expect(kept.body.replace('[A personal link, sent by e-mail only: it is not kept here.]', url)).toBe(sent.body)
  })

  it('writes Italian, and says a renewal is one', () => {
    const sent = documentsLinkMail({ ...input, locale: 'it', customerRef: null, renewal: true }, 'http://localhost:3200/l#token=x')
    expect(sent.subject).toBe('Spedizione SH-1: documenti e dichiarazione di conformità')
    expect(sent.body).toContain('come richiesto, ecco un nuovo link ai documenti della spedizione SH-1 (ordine SO-9):')
  })
})
