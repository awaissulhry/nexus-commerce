import { buildFatturaPa } from '../build'
import { depositDeductionFrom } from '../deposit'
import type {
  FatturaPaDocument,
  FatturaPaInvoiceInput,
  FatturaPaSeller,
  ForeignBuyer,
  ItalianBusinessBuyer,
  ItalianConsumerBuyer,
} from '../types'
import { decideVatTreatment, taxable } from '../../../tax/vat-treatment'

/*
 * Sample invoices for the tests. EVERY company, person, tax number, SDI code, IBAN and address here is FAKE:
 * made up for these tests, syntactically valid so the checks pass. The Partita IVA numbers use office code 000,
 * which no tax office has; the codice fiscale uses place code Z999, which no place has; the IBAN uses bank 99999.
 * Do not reuse them outside tests.
 */

export const FAKE_SELLER: FatturaPaSeller = {
  vatNumber: '12345670009', // fake
  name: 'Pelletteria Fittizia S.r.l.',
  taxRegime: 'RF01',
  address: { street: 'Via dei Conciatori Finti', streetNumber: '1', postcode: '20121', city: 'Milano', province: 'MI', country: 'IT' },
  rea: { office: 'MI', number: '0000001', shareCapital: '10000.00', shareholders: 'SM', inLiquidation: false },
  contacts: { email: 'fatture@pelletteria-fittizia.example' },
}

export const FAKE_IT_BUSINESS: ItalianBusinessBuyer = {
  kind: 'IT_BUSINESS',
  vatNumber: '76543210009', // fake
  name: 'Motoabbigliamento Immaginario S.p.A.',
  address: { street: 'Viale delle Prove', streetNumber: '42', postcode: '40121', city: 'Bologna', province: 'BO', country: 'IT' },
  sdiCode: 'FAKE001', // fake
}

export const FAKE_IT_CONSUMER: ItalianConsumerBuyer = {
  kind: 'IT_CONSUMER',
  fiscalCode: 'TSTPRV80A41Z999I', // fake (place code Z999 does not exist)
  firstName: 'Viola',
  lastName: 'Provàti',
  address: { street: 'Via Esempio', streetNumber: '5', postcode: '00184', city: 'Roma', province: 'RM', country: 'IT' },
}

export const FAKE_EU_BUSINESS: ForeignBuyer = {
  kind: 'FOREIGN',
  country: 'DE',
  taxId: '999999999', // fake
  name: 'Beispiel Motorrad GmbH',
  address: { street: 'Musterstraße', streetNumber: '1', postcode: '10115', city: 'Berlin', country: 'DE' },
}

export const FAKE_EXTRA_EU_BUSINESS: ForeignBuyer = {
  kind: 'FOREIGN',
  country: 'CH',
  taxId: 'CHE-999.999.999', // fake
  name: 'Example Riders AG',
  address: { street: 'Beispielweg', streetNumber: '2', postcode: '8001', city: 'Zürich', country: 'CH' },
}

export const FAKE_IBAN = 'IT47X9999999999000000000001' // fake (bank code 99999)

const IT_GOODS = decideVatTreatment({ customer: { taxMode: 'IT_B2B' }, supply: 'GOODS', rate: 22 }).treatment
const IT_CONSUMER_GOODS = decideVatTreatment({ customer: { taxMode: 'IT_B2C' }, supply: 'GOODS', rate: 22 }).treatment
const EU_GOODS = decideVatTreatment({ customer: { taxMode: 'EU_B2B', viesValid: true }, supply: 'GOODS', rate: 22 }).treatment
const EU_SERVICES = decideVatTreatment({ customer: { taxMode: 'EU_B2B', viesValid: true }, supply: 'SERVICES', rate: 22 }).treatment
const EXPORT_GOODS = decideVatTreatment({
  customer: { taxMode: 'EXTRA_EU', extraEuBusiness: true },
  supply: 'GOODS',
  rate: 22,
  goodsLeaveEu: true,
}).treatment

/** TD01 to an Italian business: two rates, a discount, a purchase order, payment by bank transfer. */
export const TD01_IT_B2B: FatturaPaInvoiceInput = {
  documentType: 'TD01',
  number: '2026/0101',
  date: '2026-10-05',
  transmission: { progressive: '00101' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_BUSINESS,
  lines: [
    {
      description: 'Giacca moto in pelle bovina, nero, taglia 50',
      quantity: '3',
      unitOfMeasure: 'PZ',
      unitPrice: '389.90',
      discountPercent: '5',
      vat: IT_GOODS,
      itemCode: { type: 'SKU', value: 'JKT-001-BLK-50' },
    },
    { description: 'Pantalone moto in pelle, nero, taglia 48', quantity: '2', unitOfMeasure: 'PZ', unitPrice: '279.333', vat: IT_GOODS },
    { description: 'Catalogo stampato collezione 2027', quantity: '10', unitOfMeasure: 'PZ', unitPrice: '4.15', vat: taxable(4) },
  ],
  purchaseOrders: [{ number: 'PO-77/2026', date: '2026-09-15' }],
  payment: {
    condition: 'TP02',
    installments: [{ method: 'MP05', amount: '2080.43', dueDate: '2026-11-04', iban: FAKE_IBAN, bankName: 'Banca Fittizia' }],
  },
}

/** TD02: the deposit an Italian business paid on order ORD-0042 (gross, as transferred). Stage 06b-deposit. */
export const TD02_IT_B2B_DEPOSIT: FatturaPaInvoiceInput = {
  documentType: 'TD02',
  number: '2026/A007',
  date: '2026-09-20',
  transmission: { progressive: '00102' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_BUSINESS,
  priceBasis: 'GROSS',
  lines: [{ description: 'Acconto 30% su ordine n. ORD-0042 del 18/09/2026', quantity: '1', unitPrice: '1830.00', vat: IT_GOODS }],
  purchaseOrders: [{ number: 'PO-81/2026', date: '2026-09-18' }],
  payment: { condition: 'TP02', installments: [{ method: 'MP05', amount: '1830.00', iban: FAKE_IBAN }] },
}

export const TD02_IT_B2B_DEPOSIT_DOC: FatturaPaDocument = buildFatturaPa(TD02_IT_B2B_DEPOSIT)

/** TD24: the goods of ORD-0042 shipped on two DDTs in October, the deposit deducted. Stage 15-invoice. */
export const TD24_IT_B2B_WITH_DEPOSIT: FatturaPaInvoiceInput = {
  documentType: 'TD24',
  number: '2026/0131',
  date: '2026-10-31',
  transmission: { progressive: '00103' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_BUSINESS,
  lines: [
    { description: 'Giacca moto in pelle, rosso, taglia 52', quantity: '6', unitOfMeasure: 'PZ', unitPrice: '410.00', vat: IT_GOODS, ddtNumber: 'D-0107' },
    { description: 'Giacca moto in pelle, rosso, taglia 54', quantity: '4', unitOfMeasure: 'PZ', unitPrice: '410.00', vat: IT_GOODS, ddtNumber: 'D-0107' },
    { description: 'Guanti in pelle, nero, taglia L', quantity: '20', unitOfMeasure: 'PA', unitPrice: '45.00', vat: IT_GOODS, ddtNumber: 'D-0112' },
  ],
  ddts: [
    { number: 'D-0107', date: '2026-10-20' },
    { number: 'D-0112', date: '2026-10-27' },
  ],
  depositDeductions: [depositDeductionFrom(TD02_IT_B2B_DEPOSIT_DOC)],
  purchaseOrders: [{ number: 'PO-81/2026', date: '2026-09-18' }],
  payment: {
    condition: 'TP02',
    installments: [{ method: 'MP05', amount: '4270.00', dueDate: '2026-11-30', iban: FAKE_IBAN }],
  },
}

/** TD04: one jacket of TD01_IT_B2B returned. */
export const TD04_IT_B2B_CREDIT_NOTE: FatturaPaInvoiceInput = {
  documentType: 'TD04',
  number: 'NC-2026/0003',
  date: '2026-10-12',
  transmission: { progressive: '00104' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_BUSINESS,
  lines: [
    {
      description: 'Reso: giacca moto in pelle bovina, nero, taglia 50',
      quantity: '1',
      unitOfMeasure: 'PZ',
      unitPrice: '389.90',
      discountPercent: '5',
      vat: IT_GOODS,
    },
  ],
  relatedInvoices: [{ number: '2026/0101', date: '2026-10-05' }],
  causale: 'Nota di credito per reso merce (art. 26 DPR 633/1972)',
}

/** TD02 for an Italian consumer: a made-to-measure deposit, VAT-inclusive (Codice del Consumo art. 51). */
export const TD02_IT_CONSUMER_DEPOSIT: FatturaPaInvoiceInput = {
  documentType: 'TD02',
  number: '2026/A008',
  date: '2026-09-22',
  transmission: { progressive: '00105' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_CONSUMER,
  priceBasis: 'GROSS',
  lines: [{ description: 'Acconto su tuta moto su misura, ordine n. MTM-0009', quantity: '1', unitPrice: '500.00', vat: IT_CONSUMER_GOODS }],
  payment: { condition: 'TP02', installments: [{ method: 'MP08', amount: '500.00' }] },
}

export const TD02_IT_CONSUMER_DEPOSIT_DOC: FatturaPaDocument = buildFatturaPa(TD02_IT_CONSUMER_DEPOSIT)

/** TD01 for the same consumer at delivery: VAT-inclusive prices, the deposit deducted, the balance due. */
export const TD01_IT_CONSUMER_WITH_DEPOSIT: FatturaPaInvoiceInput = {
  documentType: 'TD01',
  number: '2026/0140',
  date: '2026-10-28',
  transmission: { progressive: '00106' },
  seller: FAKE_SELLER,
  buyer: FAKE_IT_CONSUMER,
  priceBasis: 'GROSS',
  lines: [
    { description: 'Tuta moto in pelle su misura, ordine n. MTM-0009', quantity: '1', unitOfMeasure: 'PZ', unitPrice: '1899.00', vat: IT_CONSUMER_GOODS },
    { description: 'Paraschiena livello 2', quantity: '1', unitOfMeasure: 'PZ', unitPrice: '119.99', vat: IT_CONSUMER_GOODS },
    { description: 'Spray protettivo per pelle', quantity: '3', unitOfMeasure: 'PZ', unitPrice: '12.90', vat: IT_CONSUMER_GOODS },
  ],
  depositDeductions: [depositDeductionFrom(TD02_IT_CONSUMER_DEPOSIT_DOC)],
  payment: { condition: 'TP02', installments: [{ method: 'MP08', amount: '1557.69' }] },
}

/** TD01 to an EU business with a valid VIES number: intra-EU supply, N3.2, CodiceDestinatario XXXXXXX. */
export const TD01_EU_B2B: FatturaPaInvoiceInput = {
  documentType: 'TD01',
  number: '2026/0150',
  date: '2026-10-14',
  transmission: { progressive: '00107' },
  seller: FAKE_SELLER,
  buyer: FAKE_EU_BUSINESS,
  lines: [{ description: 'Motorcycle leather jacket, black, size 52', quantity: '25', unitOfMeasure: 'PZ', unitPrice: '355.00', vat: EU_GOODS }],
  ddts: [{ number: 'D-0110', date: '2026-10-14' }],
  payment: { condition: 'TP02', installments: [{ method: 'MP05', amount: '8875.00', dueDate: '2026-11-13', iban: FAKE_IBAN }] },
}

/** TD01 to a business outside the EU: export, N3.1. */
export const TD01_EXTRA_EU_EXPORT: FatturaPaInvoiceInput = {
  documentType: 'TD01',
  number: '2026/0151',
  date: '2026-10-15',
  transmission: { progressive: '00108' },
  seller: FAKE_SELLER,
  buyer: FAKE_EXTRA_EU_BUSINESS,
  lines: [{ description: 'Leather riding gloves, brown, size M', quantity: '40', unitOfMeasure: 'PA', unitPrice: '38.50', vat: EXPORT_GOODS }],
}

/** TD01 for a sampling service to an EU business: N2.1 (art. 7-ter, reverse charge wording), stamp duty due. */
export const TD01_EU_B2B_SERVICES: FatturaPaInvoiceInput = {
  documentType: 'TD01',
  number: '2026/0152',
  date: '2026-10-16',
  transmission: { progressive: '00109' },
  seller: FAKE_SELLER,
  buyer: FAKE_EU_BUSINESS,
  lines: [{ description: 'Prototype development and sampling, style AW27-03', quantity: '1', unitPrice: '1200.00', vat: EU_SERVICES }],
}

/** Every sample, by name, for the XSD and arithmetic tests. */
export const SAMPLES: Readonly<Record<string, FatturaPaInvoiceInput>> = {
  TD01_IT_B2B,
  TD02_IT_B2B_DEPOSIT,
  TD24_IT_B2B_WITH_DEPOSIT,
  TD04_IT_B2B_CREDIT_NOTE,
  TD02_IT_CONSUMER_DEPOSIT,
  TD01_IT_CONSUMER_WITH_DEPOSIT,
  TD01_EU_B2B,
  TD01_EXTRA_EU_EXPORT,
  TD01_EU_B2B_SERVICES,
}
