import { describe, expect, it } from 'vitest'
import { ValidationError } from '../core/errors'
import { composeDocument, documentProblems, pageLabel } from './compose'
import type { CompanyLegal, DocumentInput } from './model'

/*
 * Every company, person, tax number and address here is FAKE (as in the FatturaPA fixtures): the Partita IVA uses
 * office code 000, which no tax office has.
 */
const COMPANY: CompanyLegal = {
  legalName: 'Pelletteria Fittizia S.r.l.',
  tradeName: 'Fittizia',
  address: { line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  vatNumber: 'IT12345670009',
  fiscalCode: '12345670009',
  reaOffice: 'MI',
  reaNumber: '0000001',
  shareCapital: '10000.00',
  currency: 'EUR',
  soleShareholder: true,
  pec: 'amministrazione@pec.pelletteria-fittizia.example',
  documentFooter: 'Made up for tests',
}
const CUSTOMER = {
  name: 'Motoabbigliamento Immaginario S.p.A.',
  address: { line1: 'Viale delle Prove 42', postalCode: '40121', city: 'Bologna', province: 'BO', country: 'IT' },
  vatNumber: 'IT76543210009',
  sdiCode: 'FAKE001',
}

const ddt = (fields: Partial<DocumentInput> = {}): DocumentInput => ({
  type: 'DDT',
  language: 'it',
  number: '2026/000143',
  date: '2026-10-28',
  currency: 'EUR',
  company: COMPANY,
  party: CUSTOMER,
  references: [{ kind: 'CUSTOMER_ORDER', number: 'PO-7781', date: '2026-10-01' }],
  lines: [
    { code: 'JKT-01', description: 'Giacca in pelle bovina nera, taglia 50', quantity: '2', uom: 'PCS' },
    { code: 'GLV-02', description: 'Guanti in pelle, marrone, taglia L', quantity: '10', uom: 'PAIR' },
  ],
  transport: {
    reason: 'SALE',
    transportBy: 'CARRIER',
    carrier: { name: 'Trasporti Esempio S.r.l.', address: { line1: 'Via del Porto 3', postalCode: '40100', city: 'Bologna', country: 'IT' }, vatNumber: 'IT11111110009' },
    startAt: '2026-10-28T13:30:00Z',
    appearance: 'Scatole di cartone',
    packages: 3,
    grossWeightKg: '12.500',
    netWeightKg: '10.2',
    freight: 'FREE',
    destination: { name: 'Magazzino Est', line1: 'Via Esempio 9', postalCode: '40128', city: 'Bologna', province: 'BO', country: 'IT' },
  },
  ...fields,
})

const invoice = (fields: Partial<DocumentInput> = {}): DocumentInput => ({
  type: 'INVOICE_COPY',
  language: 'it',
  number: '2026/0101',
  date: '2026-10-05',
  currency: 'EUR',
  company: COMPANY,
  party: CUSTOMER,
  lines: [
    { code: 'JKT-01', description: 'Giacca in pelle', quantity: '2', uom: 'PCS', unitPrice: '250', amountMinor: 50000, vatRate: '22' },
    { description: 'Riparazione', quantity: '1', uom: 'PCS', unitPrice: '40.5', discountPercent: '10', amountMinor: 3645, vatRate: '22' },
  ],
  totals: { netMinor: 53645, vat: [{ rate: '22', taxableMinor: 53645, vatMinor: 11802 }], grossMinor: 65447 },
  invoice: { kind: 'TD01', sdiId: '9999999999', dueDate: '2026-11-04' },
  paymentTerms: 'Bonifico 30 gg',
  ...fields,
})

const factsOf = (document: ReturnType<typeof composeDocument>) => Object.fromEntries(document.facts.map((fact) => [fact.label, fact.value]))

describe('the company legal block (c.c. art. 2250)', () => {
  it('c.c. art. 2250: prints the registered office, register office and number, REA, paid-up capital and single shareholder under the name', () => {
    const document = composeDocument(ddt())
    expect(document.issuer).toEqual({
      heading: 'Mittente (cedente)',
      name: 'Pelletteria Fittizia S.r.l.',
      lines: [
        'Sede legale: Via dei Conciatori Finti 1, 20121 Milano (MI)',
        'P. IVA IT12345670009 · C.F. 12345670009',
        'Registro Imprese di MI n. 12345670009 · REA MI-0000001',
        'Capitale sociale versato € 10.000,00 · Società con socio unico',
        'PEC: amministrazione@pec.pelletteria-fittizia.example',
      ],
    })
  })

  it('c.c. art. 2250: repeats the legal line in every page footer, in English too', () => {
    expect(composeDocument(ddt()).footer).toEqual({
      legal:
        'Pelletteria Fittizia S.r.l. · Sede legale: Via dei Conciatori Finti 1, 20121 Milano (MI) · P. IVA IT12345670009 · REA MI-0000001 · ' +
        'Capitale sociale versato € 10.000,00 · Società con socio unico',
      text: 'Made up for tests',
      page: 'Pagina {page} di {pages}',
      continued: 'segue',
    })
    const english = composeDocument(ddt({ language: 'en' }))
    expect(english.footer.legal).toBe(
      'Pelletteria Fittizia S.r.l. · Registered office: Via dei Conciatori Finti 1, 20121 Milano (MI) · VAT no. IT12345670009 · REA MI-0000001 · ' +
        'Paid-up share capital €10,000.00 · Single-shareholder company',
    )
    expect(english.issuer.lines[2]).toBe('Companies Register of MI no. 12345670009 · REA MI-0000001')
    expect(pageLabel(english.footer.page, 2, 3)).toBe('Page 2 of 3')
  })

  it('c.c. art. 2250: says "in liquidazione" after the name, and prints no capital or single shareholder it does not know', () => {
    const company = { ...COMPANY, inLiquidation: true, shareCapital: null, soleShareholder: null }
    const document = composeDocument(ddt({ company }))
    expect(document.issuer.name).toBe('Pelletteria Fittizia S.r.l. in liquidazione')
    expect(document.issuer.lines.join('\n')).not.toMatch(/Capitale|socio unico/)
    expect(document.footer.legal).toMatch(/^Pelletteria Fittizia S\.r\.l\. in liquidazione · /)
  })

  it('c.c. art. 2250 c. 3 and c. 4: a company in liquidation with a single shareholder says both, in the header and every footer', () => {
    const company = { ...COMPANY, inLiquidation: true, soleShareholder: true }
    const italian = composeDocument(ddt({ company }))
    expect(italian.issuer.name).toBe('Pelletteria Fittizia S.r.l. in liquidazione')
    expect(italian.issuer.lines).toContain('Capitale sociale versato € 10.000,00 · Società con socio unico')
    expect(italian.footer.legal).toMatch(/^Pelletteria Fittizia S\.r\.l\. in liquidazione · .* · Società con socio unico$/)
    const english = composeDocument(ddt({ company, language: 'en' }))
    expect(english.issuer.name).toBe('Pelletteria Fittizia S.r.l. in liquidation')
    expect(english.footer.legal).toMatch(/ · Single-shareholder company$/)
    // A company that is neither says nothing about either.
    const plain = composeDocument(ddt({ company: { ...COMPANY, inLiquidation: false, soleShareholder: false } }))
    expect(JSON.stringify(plain)).not.toMatch(/liquidazione|socio unico/)
  })

  it('c.c. art. 2250: refuses a document while the company lacks its registered office, VAT number, codice fiscale or REA', () => {
    const company = { ...COMPANY, address: null, vatNumber: null, fiscalCode: '', reaOffice: 'MI', reaNumber: null }
    expect(documentProblems(ddt({ company })).map((problem) => problem.path)).toEqual(['company/address', 'company/vatNumber', 'company/fiscalCode', 'company/rea'])
    expect(() => composeDocument(ddt({ company }))).toThrow(ValidationError)
  })
})

describe('the DDT (DPR 472/1996)', () => {
  it('DPR 472/1996: prints the number, date, recipient, place of delivery, carrier and the goods with their quantities, and no prices', () => {
    const document = composeDocument(ddt())
    expect(document.title).toBe('Documento di trasporto (DDT)')
    expect(document.layout).toBe('DDT/1')
    expect(document.identity).toEqual([
      { label: 'Numero', value: '2026/000143' },
      { label: 'Data', value: '28/10/2026' },
    ])
    expect(document.blocks).toEqual([
      { heading: 'Destinatario (cessionario)', lines: ['Motoabbigliamento Immaginario S.p.A.', 'Viale delle Prove 42, 40121 Bologna (BO)', 'P. IVA IT76543210009'] },
      { heading: 'Luogo di destinazione', lines: ['Magazzino Est', 'Via Esempio 9, 40128 Bologna (BO)'] },
      { heading: 'Vettore', lines: ['Trasporti Esempio S.r.l.', 'Via del Porto 3, 40100 Bologna', 'P. IVA IT11111110009'] },
    ])
    expect(document.table.columns.map((column) => column.label)).toEqual(['Codice', 'Descrizione dei beni (natura e qualità)', 'Q.tà', 'U.M.'])
    expect(document.table.rows).toEqual([
      ['JKT-01', 'Giacca in pelle bovina nera, taglia 50', '2', 'PCS'],
      ['GLV-02', 'Guanti in pelle, marrone, taglia L', '10', 'PAIR'],
    ])
    expect(document.totals).toEqual([])
    expect(document.signatures).toEqual(['Firma del conducente', 'Firma del vettore', 'Firma del destinatario'])
  })

  it('DPR 472/1996: prints the reason, who carries the goods, the start date and time (Rome), the appearance, packages and weights', () => {
    expect(factsOf(composeDocument(ddt()))).toEqual({
      'Vs. ordine': 'PO-7781 del 01/10/2026',
      'Causale del trasporto': 'Vendita',
      'Trasporto a cura del': 'Vettore',
      'Inizio trasporto (data e ora)': '28/10/2026 14:30',
      'Aspetto esteriore dei beni': 'Scatole di cartone',
      'Numero colli': '3',
      'Peso lordo (kg)': '12,5',
      'Peso netto (kg)': '10,2',
      Porto: 'Franco',
    })
    expect(factsOf(composeDocument(ddt({ language: 'en' })))).toMatchObject({
      'Reason for transport': 'Sale',
      'Transport by': 'Carrier',
      'Start of transport (date and time)': '28 Oct 2026, 14:30',
      'External appearance of the goods': 'Scatole di cartone',
      'Number of packages': '3',
      'Gross weight (kg)': '12.5',
    })
    // Summer time: 2026-07-01 08:00 UTC is 10:00 in Rome.
    const summer = ddt({ transport: { ...ddt().transport!, startAt: '2026-07-01T08:00:00Z' } })
    expect(factsOf(composeDocument(summer))['Inizio trasporto (data e ora)']).toBe('01/07/2026 10:00')
    const other = ddt({ transport: { ...ddt().transport!, reason: 'OTHER', reasonText: 'Mostra campionario' } })
    expect(factsOf(composeDocument(other))['Causale del trasporto']).toBe('Mostra campionario')
    const work = ddt({ transport: { ...ddt().transport!, reason: 'WORK_ON_ACCOUNT', reasonText: 'cucitura' } })
    expect(factsOf(composeDocument(work))['Causale del trasporto']).toBe('Conto lavorazione - cucitura')
  })

  it('DPR 472/1996: refuses a DDT without its transport fields, a carrier\'s name, the recipient\'s address or the goods\' description', () => {
    const transport = { ...ddt().transport!, reason: 'OTHER' as const, reasonText: '', carrier: null, startAt: '2026-10-28 13:30', appearance: ' ', packages: 0, grossWeightKg: '0' }
    expect(documentProblems(ddt({ transport })).map((problem) => problem.path)).toEqual([
      'document/transport/reasonText',
      'document/transport/carrier',
      'document/transport/startAt',
      'document/transport/appearance',
      'document/transport/packages',
      'document/transport/grossWeightKg',
    ])
    expect(documentProblems(ddt({ transport: null })).map((problem) => problem.path)).toEqual(['document/transport'])
    expect(documentProblems(ddt({ party: { name: 'X', address: null } })).map((problem) => problem.path)).toEqual(['document/party/address'])
    expect(documentProblems(ddt({ lines: [{ description: '', quantity: '1.23456', uom: '' }] })).map((problem) => problem.path)).toEqual([
      'document/lines/0/description',
      'document/lines/0/quantity',
      'document/lines/0/uom',
    ])
  })
})

describe('the invoice copy', () => {
  it('says it is a courtesy copy and that the legal invoice is the electronic one sent through SdI, in Italian and English', () => {
    const italian = composeDocument(invoice())
    expect(italian.title).toBe('Fattura - copia di cortesia')
    expect(italian.notices).toEqual([
      "Copia di cortesia, priva di valore fiscale. L'originale è la fattura elettronica trasmessa tramite il Sistema di Interscambio (SdI), " +
        "consultabile nell'area riservata del sito dell'Agenzia delle Entrate.",
    ])
    const english = composeDocument(invoice({ language: 'en' }))
    expect(english.title).toBe('Invoice - courtesy copy')
    expect(english.notices[0]).toMatch(/^Courtesy copy with no fiscal value\. The original is the electronic invoice sent through the Italian exchange system \(SdI\)/)
  })

  it('prints prices, discounts, VAT per line, the totals, the SDI identity and the buyer\'s SDI code', () => {
    const document = composeDocument(invoice())
    expect(document.table.columns.map((column) => column.key)).toEqual(['code', 'description', 'quantity', 'uom', 'unitPrice', 'discount', 'vat', 'amount'])
    expect(document.table.rows).toEqual([
      ['JKT-01', 'Giacca in pelle', '2', 'PCS', '250,00', '', '22%', '€ 500,00'],
      ['', 'Riparazione', '1', 'PCS', '40,50', '10%', '22%', '€ 36,45'],
    ])
    expect(document.totals).toEqual([
      { label: 'Imponibile', value: '€ 536,45', strong: false },
      { label: 'IVA 22%', value: '€ 118,02', strong: false },
      { label: 'Totale documento', value: '€ 654,47', strong: true },
    ])
    expect(factsOf(document)).toEqual({ 'Tipo documento': 'TD01 Fattura', 'Identificativo SdI': '9999999999', Pagamento: 'Bonifico 30 gg', Scadenza: '04/11/2026' })
    expect(document.blocks[0]!.lines).toContain('Codice destinatario: FAKE001')
  })

  it('refuses totals that do not add up and a line without its VAT rate', () => {
    const totals = { netMinor: 53645, vat: [{ rate: '22', taxableMinor: 53645, vatMinor: 11802 }], grossMinor: 65448 }
    expect(documentProblems(invoice({ totals })).map((problem) => problem.path)).toEqual(['document/totals/grossMinor'])
    const lines = [{ description: 'Senza IVA', quantity: '1', uom: 'PCS', amountMinor: 100 }]
    expect(documentProblems(invoice({ lines, totals: { netMinor: 100, vat: [], grossMinor: 100 } })).map((problem) => problem.path)).toEqual(['document/lines/0/vatRate'])
  })

  it('prints a reverse-charge rate by its nature and a deducted deposit', () => {
    const document = composeDocument(
      invoice({
        language: 'en',
        lines: [{ description: 'Jackets', quantity: '2', uom: 'PCS', unitPrice: '250', amountMinor: 50000, vatRate: '0', vatNature: 'N3.2' }],
        totals: { netMinor: 50000, vat: [{ rate: '0', nature: 'N3.2', taxableMinor: 50000, vatMinor: 0 }], grossMinor: 50000, depositMinor: 15000, dueMinor: 35000 },
      }),
    )
    expect(document.table.rows[0]).toEqual(['', 'Jackets', '2', 'PCS', '250.00', '', 'N3.2', '€500.00'])
    expect(document.totals.map((row) => [row.label, row.value])).toEqual([
      ['Net amount', '€500.00'],
      ['No VAT (N3.2)', '€0.00'],
      ['Document total', '€500.00'],
      ['Deposit already invoiced', '-€150.00'],
      ['Amount due', '€350.00'],
    ])
  })
})

describe('quote and purchase order', () => {
  it('prints a quote with its validity and totals, and a PO with its supplier, delivery and the order-number notice', () => {
    const quote = composeDocument({ ...invoice(), type: 'QUOTE', number: 'Q-2026-0007', validUntil: '2026-11-30', invoice: null, references: [{ kind: 'CUSTOMER_ORDER', number: 'RFQ-1' }] })
    expect(quote.title).toBe('Offerta')
    expect(quote.layout).toBe('QUOTE/1')
    expect(quote.blocks[0]!.heading).toBe('Cliente')
    expect(factsOf(quote)).toEqual({ 'Vs. ordine': 'RFQ-1', 'Valida fino al': '30/11/2026', Pagamento: 'Bonifico 30 gg' })
    expect(quote.totals.at(-1)).toEqual({ label: 'Totale offerta', value: '€ 654,47', strong: true })
    expect(quote.notices).toEqual([])

    const order = composeDocument({
      ...invoice(),
      type: 'PURCHASE_ORDER',
      language: 'en',
      number: 'PO-2026-0031',
      invoice: null,
      party: { name: 'Conceria Esempio S.p.A.', address: { line1: 'Via Concia 2', postalCode: '56029', city: 'Santa Croce sull\'Arno', province: 'PI', country: 'IT' } },
      deliveryDate: '2026-11-15',
      deliverTo: { name: 'Plant 1', line1: 'Via dei Conciatori Finti 1', postalCode: '20121', city: 'Milano', country: 'IT' },
      lines: [{ code: 'VAC-14', description: 'Cowhide 1.4 mm', quantity: '120.5', uom: 'M2', unitPrice: '18.125', amountMinor: 218406, deliveryDate: '2026-11-15' }],
      totals: { netMinor: 218406, vat: [{ rate: '22', taxableMinor: 218406, vatMinor: 48049 }], grossMinor: 266455 },
    })
    expect(order.title).toBe('Purchase order')
    expect(order.blocks.map((block) => block.heading)).toEqual(['Supplier', 'Deliver to'])
    expect(order.table.rows[0]).toEqual(['VAC-14', 'Cowhide 1.4 mm', '120.5', 'M2', '18.125', '15 Nov 2026', '€2,184.06'])
    expect(order.notices).toEqual(['Please quote this order number on your delivery note and invoice.'])
  })
})

describe('the packing list (B-W1-46, LOG-039)', () => {
  const packingList = (fields: Partial<DocumentInput> = {}): DocumentInput => ({
    type: 'PACKING_LIST',
    language: 'it',
    number: 'SH-2026-00007',
    date: '2026-10-28',
    currency: 'EUR',
    company: COMPANY,
    party: CUSTOMER,
    references: [{ kind: 'SALES_ORDER', number: 'SO-2026-00003' }],
    lines: [
      { code: 'JKT-01', description: 'Giacca in pelle, nero, taglia 50', quantity: '2', uom: 'PCS', parcel: '1' },
      { code: 'JKT-01', description: 'Giacca in pelle, nero, taglia 52', quantity: '1', uom: 'PCS', parcel: '2' },
    ],
    packing: { packages: 2, grossWeightKg: '6.5', shipTo: { name: 'Magazzino Est', line1: 'Via Esempio 9', postalCode: '40128', city: 'Bologna', province: 'BO', country: 'IT' } },
    ...fields,
  })

  it('prints each line with its parcel, the number of parcels, the weight and the place of delivery, and no prices', () => {
    const composed = composeDocument(packingList())
    expect(composed.title).toBe('Distinta colli')
    expect(composed.layout).toBe('PACKING_LIST/1')
    expect(composed.table.columns.map((column) => column.key)).toEqual(['parcel', 'code', 'goods', 'quantity', 'uom'])
    expect(composed.table.rows[1]).toEqual(['2', 'JKT-01', 'Giacca in pelle, nero, taglia 52', '1', 'PCS'])
    expect(composed.facts).toEqual([
      { label: 'Ns. ordine', value: 'SO-2026-00003' },
      { label: 'Numero colli', value: '2' },
      { label: 'Peso lordo (kg)', value: '6,5' },
    ])
    expect(composed.blocks.map((block) => block.heading)).toEqual(['Destinatario', 'Luogo di destinazione'])
    expect(composed.totals).toEqual([])
    expect(composed.signatures).toEqual([])
    expect(composeDocument(packingList({ language: 'en' })).title).toBe('Packing list')
  })

  it('refuses a packing list without its parcels or a line without its parcel; the weight may wait', () => {
    expect(documentProblems(packingList({ packing: null }))).toEqual([{ path: 'document/packing', message: 'A packing list says how many parcels there are.' }])
    const lines = [{ code: 'JKT-01', description: 'Giacca', quantity: '1', uom: 'PCS' }]
    expect(documentProblems(packingList({ lines, packing: { packages: 0 } }))).toEqual([
      { path: 'document/packing/packages', message: 'Give the number of parcels (at least 1).' },
      { path: 'document/lines/0/parcel', message: 'Say which parcel the line is packed in.' },
    ])
    expect(composeDocument(packingList({ packing: { packages: 2, grossWeightKg: null } })).facts.map((fact) => fact.label)).toEqual(['Ns. ordine', 'Numero colli'])
  })
})

describe('composition', () => {
  it('is deterministic and plain JSON, with metadata fixed by the input', () => {
    const first = composeDocument(ddt())
    expect(composeDocument(ddt())).toEqual(first)
    expect(JSON.parse(JSON.stringify(first))).toEqual(first)
    expect(first.meta).toEqual({
      title: 'Documento di trasporto (DDT) 2026/000143',
      author: 'Pelletteria Fittizia S.r.l.',
      subject: 'DDT/1 it',
      createdAt: '2026-10-27T23:00:00.000Z',
      keywords: 'DDT 2026/000143 2026-10-28',
    })
  })

  it('marks a sample with its banner, and refuses an unknown type or language', () => {
    expect(composeDocument(ddt({ sample: true })).banner).toBe('ESEMPIO - documento non valido')
    expect(composeDocument(ddt({ language: 'en', sample: true })).banner).toBe('SAMPLE - not a valid document')
    expect(documentProblems({ ...ddt(), type: 'RECEIPT' as never })).toEqual([{ path: 'document/type', message: 'Unknown document type.' }])
    expect(documentProblems({ ...ddt(), language: 'de' as never })[0]?.path).toBe('document/language')
  })
})
