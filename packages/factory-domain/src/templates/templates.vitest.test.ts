import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { SYSTEM_ROLE_TEMPLATES } from '../auth/roles/templates'
import { composeDocument } from '../documents/compose'
import { attachLayoutTemplates, DOCUMENT_LAYOUTS, layoutFor, layoutTemplateOf, MANDATORY_COLUMNS, optionalColumnsOf, type LayoutTemplate } from '../documents/layouts'
import { DOCUMENT_TYPES, type CompanyLegal } from '../documents/model'
import { sampleDocument } from '../documents/sample'
import { EVENT_CATALOGUE } from '../events/catalogue'
import { statusMailOf, statusMailValuesOf } from '../sales/service/mail'
import { CASE_STATUSES, MOVE_TARGETS } from '../sales/service/rules'
import { trackingLinkMail, trackingLinkMailValues } from '../shipping/tracking-link/mail'
import { cleanDocumentWords, DOCUMENT_PLACEHOLDERS, DOCUMENT_TEMPLATE_KINDS, documentPlaceholderValues, documentTemplateProblems, mandatoryPartsOf } from './documents'
import { recipientLanguageOf } from './language'
import { companyValues, emailTemplateProblems, fillMail, MAIL_EVENT_DEFINITIONS, MAIL_EVENTS } from './mail'
import { TEMPLATES_ADDS, TEMPLATES_PERMISSIONS } from './permissions'
import { fillPlaceholders, missingValues, placeholderProblems, placeholdersIn, placeholderSyntaxOk } from './placeholders'
import { databaseTemplateRefusal } from './refusals'
import { replyPlaceholdersOf, replyProblems } from './replies'

/* Every company, person and number here is made up (the Partita IVA's office code 000 is no tax office's). */
const COMPANY: CompanyLegal = {
  legalName: 'Officina Esempio S.r.l.',
  tradeName: 'Esempio Moto',
  address: { line1: 'Via Esempio 1', postalCode: '50100', city: 'Firenze', province: 'FI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'FI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
  documentFooter: 'Footer of the company (made up)',
}

const template = (fields: Partial<LayoutTemplate> = {}): LayoutTemplate => ({
  type: 'QUOTE',
  language: 'it',
  revision: 3,
  header: 'Offerta {{quote.number}} per {{party.name}}, valida fino al {{quote.validUntil}}.',
  terms: 'Condizioni di vendita (inventate).\nSeconda riga.',
  footer: 'Grazie, {{company.name}}.',
  fieldsShown: ['discount'],
  ...fields,
})

describe('placeholders', () => {
  it('accepts {{name}} and {{record.name}} as the database does, and finds each name once in order', () => {
    expect(placeholderSyntaxOk('Gentile {{contact.name}}, ordine {{ order.number }}.')).toBe(true)
    expect(placeholderSyntaxOk('A broken {{ one')).toBe(false)
    expect(placeholderSyntaxOk('{{a.b.c.d.e.f}}')).toBe(false)
    expect(placeholdersIn('{{b}} {{a.x}} {{b}}')).toEqual(['b', 'a.x'])
  })

  it('refuses a broken placeholder and a name the registry does not offer', () => {
    expect(placeholderProblems('{{oops', 'body/body', ['a'])).toEqual([{ path: 'body/body', message: expect.stringContaining('{{name}}') }])
    expect(placeholderProblems('{{a}} {{b}}', 'body/body', ['a'])).toEqual([{ path: 'body/body', message: expect.stringContaining('{{b}}') }])
  })

  it('fills values, leaves no gap for an empty one and says which had none', () => {
    expect(fillPlaceholders('Hello {{name}},\n\n{{extra}}\n\nBye', { name: 'Ann' })).toBe('Hello Ann,\n\nBye')
    expect(missingValues('{{a}} {{b}}', { a: 'x', b: '  ' })).toEqual(['b'])
  })
})

describe("the partner contact's language (PLT-131)", () => {
  it("follows the contact's, else the party's, else the company's; English for a language documents are not written in", () => {
    expect(recipientLanguageOf({ contact: 'en', party: 'it', company: 'it' })).toEqual({ language: 'en', source: 'CONTACT', notOffered: null })
    expect(recipientLanguageOf({ contact: null, party: 'it', company: 'en' })).toEqual({ language: 'it', source: 'PARTY', notOffered: null })
    expect(recipientLanguageOf({ contact: 'de', party: 'it' })).toEqual({ language: 'en', source: 'CONTACT', notOffered: 'de' })
    expect(recipientLanguageOf({})).toEqual({ language: 'it', source: 'COMPANY', notOffered: null })
  })
})

describe('document templates (PLT-231)', () => {
  it('names the kinds of the code that take a template, and never lets a mandatory column be a choice', () => {
    // B-W2b-F60: every document the code prints, the proforma and the commercial invoice too, each once.
    expect(DOCUMENT_TEMPLATE_KINDS).toEqual(['QUOTE', 'ORDER_CONFIRMATION', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST', 'PROFORMA', 'COMMERCIAL_INVOICE'])
    expect([...DOCUMENT_TEMPLATE_KINDS].sort()).toEqual([...DOCUMENT_TYPES].sort())
    for (const kind of DOCUMENT_TEMPLATE_KINDS) {
      const keys = DOCUMENT_LAYOUTS[kind].columns.map((entry) => entry.key)
      for (const key of MANDATORY_COLUMNS[kind]) expect(keys, `${kind} ${key}`).toContain(key)
      expect(optionalColumnsOf(kind).some((key) => MANDATORY_COLUMNS[kind].includes(key))).toBe(false)
      expect(mandatoryPartsOf(kind)).toContain('COMPANY_LEGAL')
    }
    expect(mandatoryPartsOf('DDT')).toContain('SIGNATURES')
    expect(mandatoryPartsOf('DDT')).not.toContain('TOTALS')
    // B-W2b-F60: the kinds that always print fixed notices say so.
    expect(DOCUMENT_TEMPLATE_KINDS.filter((kind) => mandatoryPartsOf(kind).includes('NOTICES'))).toEqual(['PURCHASE_ORDER', 'INVOICE_COPY', 'PROFORMA', 'COMMERCIAL_INVOICE'])
    for (const kind of DOCUMENT_TEMPLATE_KINDS) {
      const plain = composeDocument(sampleDocument(kind, 'it', COMPANY, '2026-11-14'))
      expect(mandatoryPartsOf(kind).includes('NOTICES'), kind).toBe(plain.notices.length > 0)
    }
  })

  it('refuses a mandatory column, a column the layout lacks, an unknown placeholder, too long words and another language', () => {
    const problems = documentTemplateProblems('QUOTE', 'de', { header: '{{quote.number}} {{order.promiseDate}}', terms: 'x'.repeat(20001), footer: null, fieldsShown: ['amount', 'delivery', 'discount'] })
    expect(problems.map((problem) => problem.path)).toEqual(['body/language', 'body/header', 'body/terms', 'body/fieldsShown/0', 'body/fieldsShown/1'])
    expect(documentTemplateProblems('QUOTE', 'it', { header: '{{quote.number}}', terms: null, footer: null, fieldsShown: ['code', 'discount'] })).toEqual([])
  })

  it('cleans the words for storing: trimmed, empty is none, the columns in the layout order', () => {
    expect(cleanDocumentWords('QUOTE', { header: '  ', terms: ' Terms \r\n', footer: null, fieldsShown: ['discount', 'code'] })).toEqual({ header: null, terms: 'Terms', footer: null, fieldsShown: ['code', 'discount'] })
  })

  it('reads the template in use first: its columns (mandatory ones kept, widths still 1000), and names its version', () => {
    const layout = layoutFor('QUOTE', template())
    expect(layout.id).toBe('QUOTE/2+t3')
    expect(layout.columns.map((entry) => entry.key)).toEqual(['description', 'quantity', 'discount', 'amount'])
    expect(layout.columns.reduce((sum, entry) => sum + entry.width, 0)).toBe(1000)
    expect(layoutFor('QUOTE', null)).toBe(DOCUMENT_LAYOUTS.QUOTE)
    expect(layoutFor('DDT', template({ type: 'DDT', fieldsShown: [] })).columns.map((entry) => entry.key)).toEqual(['goods', 'quantity', 'uom'])
  })

  it('prints the header, terms and footer with their placeholders filled; without a template the document is as before', () => {
    const plain = composeDocument(sampleDocument('QUOTE', 'it', COMPANY, '2026-11-14'))
    expect(plain.layout).toBe('QUOTE/2')
    expect('intro' in plain).toBe(false)
    expect(plain.footer.text).toBe('Footer of the company (made up)')

    const company = attachLayoutTemplates({ ...COMPANY }, [template(), template({ language: 'en', header: 'English words' })])
    expect(layoutTemplateOf(company, 'QUOTE', 'en')?.header).toBe('English words')
    expect(JSON.stringify(company)).toBe(JSON.stringify(COMPANY))
    const composed = composeDocument(sampleDocument('QUOTE', 'it', company, '2026-11-14'))
    expect(composed.layout).toBe('QUOTE/2+t3')
    expect(composed.intro).toBe('Offerta SAMPLE per Example Customer S.r.l., valida fino al 14/11/2026.')
    expect(composed.terms).toBe('Condizioni di vendita (inventate).\nSeconda riga.')
    expect(composed.footer.text).toBe('Grazie, Esempio Moto.')
    expect(composed.footer.legal).toBe(plain.footer.legal)
    expect(composed.issuer.lines).toEqual(plain.issuer.lines)
    expect(composed.table.columns.map((entry) => entry.key)).toEqual(['description', 'quantity', 'discount', 'amount'])
    // Another type or language of the same company prints the code's layout.
    expect(composeDocument(sampleDocument('DDT', 'it', company, '2026-11-14')).layout).toBe('DDT/1')
  })

  it('prints the proforma and the commercial invoice with their words, and keeps every line of their own (B-W2b-F60)', () => {
    const words = (type: 'PROFORMA' | 'COMMERCIAL_INVOICE', language: 'it' | 'en', header: string) =>
      template({ type, language, revision: 1, header, terms: 'Made-up terms.', footer: null, fieldsShown: [] })
    const company = attachLayoutTemplates({ ...COMPANY }, [
      words('PROFORMA', 'it', 'Proforma {{proforma.number}} del {{proforma.date}} per {{party.name}}.'),
      words('COMMERCIAL_INVOICE', 'en', 'Invoice {{commercialInvoice.number}}, goods for {{commercialInvoice.destination}}.'),
    ])
    for (const [type, language, intro, columns] of [
      ['PROFORMA', 'it', 'Proforma SAMPLE del 14/11/2026 per Example Customer S.r.l..', ['description', 'quantity', 'unitPrice', 'vat', 'amount']],
      ['COMMERCIAL_INVOICE', 'en', 'Invoice SAMPLE, goods for Switzerland.', ['description', 'quantity', 'unitPrice', 'amount']],
    ] as const) {
      const plain = composeDocument(sampleDocument(type, language, COMPANY, '2026-11-14'))
      const printed = composeDocument(sampleDocument(type, language, company, '2026-11-14'))
      expect(printed.layout, type).toBe(`${plain.layout}+t1`)
      expect(printed.intro, type).toBe(intro)
      expect(printed.terms, type).toBe('Made-up terms.')
      // No footer of its own: the company's.
      expect(printed.footer, type).toEqual(plain.footer)
      expect(printed.table.columns.map((entry) => entry.key), type).toEqual(columns)
      // What the law or customs needs stays: the legal lines, the facts (a commercial invoice's EORI, reason and destination),
      // the notices (a proforma is no tax document; customs values and the non-taxable export), the totals.
      expect(printed.issuer, type).toEqual(plain.issuer)
      expect(printed.facts, type).toEqual(plain.facts)
      expect(printed.notices, type).toEqual(plain.notices)
      expect(printed.notices.length, type).toBe(2)
      expect(printed.totals, type).toEqual(plain.totals)
    }
    // Their other language prints the code's layout.
    expect(composeDocument(sampleDocument('PROFORMA', 'en', company, '2026-11-14')).layout).toBe('PROFORMA/1')
  })

  it("offers each kind's placeholders, and fills every one of them from a sample document", () => {
    for (const kind of DOCUMENT_TEMPLATE_KINDS) {
      const values = documentPlaceholderValues(sampleDocument(kind, 'en', COMPANY, '2026-11-14'))
      expect(Object.keys(values).sort(), kind).toEqual([...DOCUMENT_PLACEHOLDERS[kind]].sort())
    }
    // B-W2b-F60: a prepayment proforma's due day; the commercial invoice's destination in the document's language.
    const prepayment = { ...sampleDocument('PROFORMA', 'it', COMPANY, '2026-11-14'), proforma: { purpose: 'PREPAYMENT' as const, dueDate: '2026-11-30' } }
    expect(documentPlaceholderValues(prepayment)).toMatchObject({ 'proforma.number': 'SAMPLE', 'proforma.date': '14/11/2026', 'proforma.dueDate': '30/11/2026' })
    expect(documentPlaceholderValues(sampleDocument('COMMERCIAL_INVOICE', 'it', COMPANY, '2026-11-14'))['commercialInvoice.destination']).toBe('Svizzera')
  })
})

describe('e-mail templates (PLT-232) say what the code says', () => {
  it('every event offers its placeholders, and its code words use only them', () => {
    for (const event of MAIL_EVENTS) {
      for (const language of ['it', 'en'] as const) expect(emailTemplateProblems(event, language, MAIL_EVENT_DEFINITIONS[event].words[language]), `${event} ${language}`).toEqual([])
    }
    expect(emailTemplateProblems('quote.faxed', 'it', { subject: 'x', body: 'y' })).toEqual([{ path: 'body/event', message: expect.any(String) }])
    expect(emailTemplateProblems('service.status_changed', 'it', { subject: 'two\nlines', body: '{{case.number}} {{order.number}}' }).map((problem) => problem.path)).toEqual(['body/subject', 'body/body'])
  })

  it('service.status_changed (TM1:01): the code words filled give the status mail of every move, with and without a message', () => {
    for (const language of ['it', 'en'] as const) {
      for (const from of CASE_STATUSES) {
        for (const to of MOVE_TARGETS) {
          for (const message of [null, 'Le scriveremo domani.']) {
            const input = { language, number: 'SVC-0001', from, to, contactName: from === 'NEW' ? null : 'Anna Esempio', message, companyName: 'Esempio Moto' }
            expect(fillMail(MAIL_EVENT_DEFINITIONS['service.status_changed'].words[language], statusMailValuesOf(input)), `${language} ${from} → ${to}`).toEqual(statusMailOf(input))
          }
        }
      }
    }
  })

  it('shipping.tracking_link: the code words filled give the tracking mail, with or without carrier, delivery and link, renewed or not', () => {
    for (const locale of ['it', 'en'] as const) {
      for (const status of ['PACKED', 'SHIPPED', 'DELIVERED'] as const) {
        for (const extra of [{ carrierName: null, expectedDeliveryAt: null }, { carrierName: 'Corriere Esempio', expectedDeliveryAt: new Date('2026-11-20T10:00:00Z') }]) {
          for (const renewal of [false, true]) {
            for (const url of [null, 'https://example.com/l#token=abc']) {
              const input = { locale, companyName: 'Esempio Moto', shipmentNumber: 'SH-1', orderNumber: 'SO-1', customerRef: renewal ? 'REF-9' : null, status, renewal, ...extra }
              expect(fillMail(MAIL_EVENT_DEFINITIONS['shipping.tracking_link'].words[locale], trackingLinkMailValues(input, url))).toEqual(trackingLinkMail(input, url))
            }
          }
        }
      }
    }
  })

  it("gives the company's names: trade name first, the legal name, the trade name (or nothing)", () => {
    expect(companyValues({ legalName: 'Officina Esempio S.r.l.', tradeName: null })).toEqual({ 'company.name': 'Officina Esempio S.r.l.', 'company.legalName': 'Officina Esempio S.r.l.', 'company.tradeName': null })
  })
})

describe('saved replies (COL-016)', () => {
  it("fills the record's placeholders, any record's only the common ones", () => {
    expect(replyPlaceholdersOf('SalesOrder')).toContain('order.promiseDate')
    expect(replyPlaceholdersOf(null)).not.toContain('order.number')
    expect(replyProblems({ name: 'Delay notice', language: 'en', body: 'Dear {{contact.name}}, order {{order.number}}.', recordType: 'SalesOrder' })).toEqual([])
    expect(replyProblems({ name: 'x\ny', language: 'fr', body: '{{order.number}}', recordType: null }).map((problem) => problem.path)).toEqual(['body/name', 'body/language', 'body/body'])
    expect(replyProblems({ name: 'A', language: 'it', body: 'x', recordType: 'Lot' }).map((problem) => problem.path)).toEqual(['body/recordType'])
  })
})

describe('the catalogues', () => {
  it('declares the permissions and gives them to the templates named, and declares the events', () => {
    for (const name of TEMPLATES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
    for (const [key, permissions] of Object.entries(TEMPLATES_ADDS)) {
      const role = SYSTEM_ROLE_TEMPLATES.find((candidate) => candidate.key === key)
      expect(role, key).toBeDefined()
      for (const permission of permissions) expect(role!.permissions, `${key} ${permission}`).toContain(permission)
    }
    for (const type of ['document_template.changed', 'email_template.changed', 'saved_reply.changed']) expect(EVENT_CATALOGUE.find(type, 1), type).toBeDefined()
  })

  it("reads the database's template refusals", () => {
    expect(databaseTemplateRefusal('23505', 'duplicate key value violates unique constraint "DocumentTemplate_one_active"')).toBe('ANOTHER_IN_USE')
    expect(databaseTemplateRefusal('23514', 'templates: document template x was published: its words and fields never change (write a new version)')).toBe('NOT_A_DRAFT')
    expect(databaseTemplateRefusal('23514', 'fields: something else')).toBeNull()
  })
})
