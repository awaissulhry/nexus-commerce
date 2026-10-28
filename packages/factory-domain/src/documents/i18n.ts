import type { DdtFreight, DdtReason, DdtTransportBy, DocumentLanguage, DocumentType, InvoiceKind, ReferenceKind } from './model'

/**
 * The words of the fixed layouts, in Italian and English (GAP-008). One table per language with the same keys, so a
 * missing translation is a type error, not a blank on paper. The legal wording (the courtesy copy, the art. 2250
 * labels, the DDT's fields) is fixed here and never comes from a request.
 */

export interface DocumentWords {
  readonly title: Readonly<Record<DocumentType, string>>
  readonly number: string
  readonly date: string
  /** The page label, with `{page}` and `{pages}`. */
  readonly page: string
  readonly continued: string
  readonly headings: {
    readonly issuer: Readonly<Record<DocumentType, string>>
    readonly party: Readonly<Record<DocumentType, string>>
    readonly destination: string
    readonly deliverTo: string
    readonly carrier: string
  }
  readonly legal: {
    readonly registeredOffice: string
    readonly vat: string
    readonly fiscalCode: string
    readonly register: (office: string, number: string) => string
    readonly rea: (office: string, number: string) => string
    readonly shareCapital: string
    readonly soleShareholder: string
    readonly inLiquidation: string
    readonly pec: string
  }
  readonly party: { readonly vat: string; readonly fiscalCode: string; readonly sdiCode: string; readonly pec: string }
  readonly columns: {
    readonly code: string
    readonly description: string
    readonly goods: string
    readonly quantity: string
    readonly uom: string
    readonly unitPrice: string
    readonly discount: string
    readonly vat: string
    readonly amount: string
    readonly delivery: string
  }
  readonly facts: {
    readonly validUntil: string
    readonly paymentTerms: string
    readonly deliveryTerms: string
    readonly deliveryDate: string
    readonly reference: Readonly<Record<ReferenceKind, string>>
    readonly referenceDated: (number: string, date: string) => string
    readonly reason: string
    readonly transportBy: string
    readonly startAt: string
    readonly appearance: string
    readonly packages: string
    readonly grossWeight: string
    readonly netWeight: string
    readonly freight: string
    readonly invoiceKind: string
    readonly sdiId: string
    readonly dueDate: string
  }
  readonly reasons: Readonly<Record<DdtReason, string>>
  readonly transportBy: Readonly<Record<DdtTransportBy, string>>
  readonly freight: Readonly<Record<DdtFreight, string>>
  readonly invoiceKinds: Readonly<Record<InvoiceKind, string>>
  readonly totals: {
    readonly net: string
    readonly vat: (rate: string) => string
    readonly vatExempt: (nature: string) => string
    readonly gross: Readonly<Record<DocumentType, string>>
    readonly deposit: string
    readonly due: string
  }
  readonly notes: string
  readonly notices: {
    readonly courtesyCopy: string
    readonly purchaseOrder: string
    readonly sample: string
  }
  readonly signatures: { readonly driver: string; readonly carrier: string; readonly recipient: string }
}

const IT: DocumentWords = {
  title: { QUOTE: 'Offerta', PURCHASE_ORDER: 'Ordine di acquisto', DDT: 'Documento di trasporto (DDT)', INVOICE_COPY: 'Fattura - copia di cortesia' },
  number: 'Numero',
  date: 'Data',
  page: 'Pagina {page} di {pages}',
  continued: 'segue',
  headings: {
    issuer: { QUOTE: 'Emittente', PURCHASE_ORDER: 'Committente', DDT: 'Mittente (cedente)', INVOICE_COPY: 'Cedente / prestatore' },
    party: { QUOTE: 'Cliente', PURCHASE_ORDER: 'Fornitore', DDT: 'Destinatario (cessionario)', INVOICE_COPY: 'Cessionario / committente' },
    destination: 'Luogo di destinazione',
    deliverTo: 'Consegnare a',
    carrier: 'Vettore',
  },
  legal: {
    registeredOffice: 'Sede legale',
    vat: 'P. IVA',
    fiscalCode: 'C.F.',
    register: (office, number) => `Registro Imprese di ${office} n. ${number}`,
    rea: (office, number) => `REA ${office}-${number}`,
    shareCapital: 'Capitale sociale versato',
    soleShareholder: 'Società con socio unico',
    inLiquidation: 'in liquidazione',
    pec: 'PEC',
  },
  party: { vat: 'P. IVA', fiscalCode: 'C.F.', sdiCode: 'Codice destinatario', pec: 'PEC' },
  columns: {
    code: 'Codice',
    description: 'Descrizione',
    goods: 'Descrizione dei beni (natura e qualità)',
    quantity: 'Q.tà',
    uom: 'U.M.',
    unitPrice: 'Prezzo unit.',
    discount: 'Sconto',
    vat: 'IVA',
    amount: 'Importo',
    delivery: 'Consegna',
  },
  facts: {
    validUntil: 'Valida fino al',
    paymentTerms: 'Pagamento',
    deliveryTerms: 'Resa',
    deliveryDate: 'Data di consegna richiesta',
    reference: {
      CUSTOMER_ORDER: 'Vs. ordine',
      QUOTE: 'Ns. offerta',
      SALES_ORDER: 'Ns. ordine',
      PURCHASE_ORDER: 'Ordine di acquisto',
      SUPPLIER_QUOTE: 'Vs. offerta',
      DDT: 'DDT',
      INVOICE: 'Fattura',
    },
    referenceDated: (number, date) => `${number} del ${date}`,
    reason: 'Causale del trasporto',
    transportBy: 'Trasporto a cura del',
    startAt: 'Inizio trasporto (data e ora)',
    appearance: 'Aspetto esteriore dei beni',
    packages: 'Numero colli',
    grossWeight: 'Peso lordo (kg)',
    netWeight: 'Peso netto (kg)',
    freight: 'Porto',
    invoiceKind: 'Tipo documento',
    sdiId: 'Identificativo SdI',
    dueDate: 'Scadenza',
  },
  reasons: {
    SALE: 'Vendita',
    WORK_ON_ACCOUNT: 'Conto lavorazione',
    RETURN_FROM_WORK: 'Reso da lavorazione',
    RETURN: 'Reso',
    ON_APPROVAL: 'Conto visione',
    REPAIR: 'Riparazione',
    SAMPLE: 'Campionatura',
    TRANSFER: 'Trasferimento tra sedi',
    OTHER: 'Altro',
  },
  transportBy: { SENDER: 'Mittente', RECIPIENT: 'Destinatario', CARRIER: 'Vettore' },
  freight: { FREE: 'Franco', FORWARD: 'Assegnato' },
  invoiceKinds: {
    TD01: 'TD01 Fattura',
    TD02: 'TD02 Acconto / anticipo su fattura',
    TD04: 'TD04 Nota di credito',
    TD05: 'TD05 Nota di debito',
    TD24: 'TD24 Fattura differita',
  },
  totals: {
    net: 'Imponibile',
    vat: (rate) => `IVA ${rate}`,
    vatExempt: (nature) => `Senza IVA (${nature})`,
    gross: { QUOTE: 'Totale offerta', PURCHASE_ORDER: 'Totale ordine', DDT: 'Totale', INVOICE_COPY: 'Totale documento' },
    deposit: 'Acconto già fatturato',
    due: 'Netto a pagare',
  },
  notes: 'Note',
  notices: {
    courtesyCopy:
      "Copia di cortesia, priva di valore fiscale. L'originale è la fattura elettronica trasmessa tramite il Sistema di " +
      "Interscambio (SdI), consultabile nell'area riservata del sito dell'Agenzia delle Entrate.",
    purchaseOrder: "Indicare il numero di questo ordine sul documento di trasporto e sulla fattura.",
    sample: 'ESEMPIO - documento non valido',
  },
  signatures: { driver: 'Firma del conducente', carrier: 'Firma del vettore', recipient: 'Firma del destinatario' },
}

const EN: DocumentWords = {
  title: { QUOTE: 'Quotation', PURCHASE_ORDER: 'Purchase order', DDT: 'Transport document (DDT)', INVOICE_COPY: 'Invoice - courtesy copy' },
  number: 'Number',
  date: 'Date',
  page: 'Page {page} of {pages}',
  continued: 'continued',
  headings: {
    issuer: { QUOTE: 'Issued by', PURCHASE_ORDER: 'Buyer', DDT: 'Sender (consignor)', INVOICE_COPY: 'Seller' },
    party: { QUOTE: 'Customer', PURCHASE_ORDER: 'Supplier', DDT: 'Recipient (consignee)', INVOICE_COPY: 'Buyer' },
    destination: 'Place of delivery',
    deliverTo: 'Deliver to',
    carrier: 'Carrier',
  },
  legal: {
    registeredOffice: 'Registered office',
    vat: 'VAT no.',
    fiscalCode: 'Tax code',
    register: (office, number) => `Companies Register of ${office} no. ${number}`,
    rea: (office, number) => `REA ${office}-${number}`,
    shareCapital: 'Paid-up share capital',
    soleShareholder: 'Single-shareholder company',
    inLiquidation: 'in liquidation',
    pec: 'Certified email (PEC)',
  },
  party: { vat: 'VAT no.', fiscalCode: 'Tax code', sdiCode: 'SDI recipient code', pec: 'PEC' },
  columns: {
    code: 'Code',
    description: 'Description',
    goods: 'Description of the goods (nature and quality)',
    quantity: 'Qty',
    uom: 'Unit',
    unitPrice: 'Unit price',
    discount: 'Disc.',
    vat: 'VAT',
    amount: 'Amount',
    delivery: 'Delivery',
  },
  facts: {
    validUntil: 'Valid until',
    paymentTerms: 'Payment',
    deliveryTerms: 'Delivery terms',
    deliveryDate: 'Requested delivery date',
    reference: {
      CUSTOMER_ORDER: 'Your order',
      QUOTE: 'Our quotation',
      SALES_ORDER: 'Our order',
      PURCHASE_ORDER: 'Purchase order',
      SUPPLIER_QUOTE: 'Your quotation',
      DDT: 'DDT',
      INVOICE: 'Invoice',
    },
    referenceDated: (number, date) => `${number} of ${date}`,
    reason: 'Reason for transport',
    transportBy: 'Transport by',
    startAt: 'Start of transport (date and time)',
    appearance: 'External appearance of the goods',
    packages: 'Number of packages',
    grossWeight: 'Gross weight (kg)',
    netWeight: 'Net weight (kg)',
    freight: 'Freight',
    invoiceKind: 'Document type',
    sdiId: 'SdI file id',
    dueDate: 'Due date',
  },
  reasons: {
    SALE: 'Sale',
    WORK_ON_ACCOUNT: 'Goods sent for processing',
    RETURN_FROM_WORK: 'Return from processing',
    RETURN: 'Return',
    ON_APPROVAL: 'On approval',
    REPAIR: 'Repair',
    SAMPLE: 'Samples',
    TRANSFER: 'Transfer between sites',
    OTHER: 'Other',
  },
  transportBy: { SENDER: 'Sender', RECIPIENT: 'Recipient', CARRIER: 'Carrier' },
  freight: { FREE: 'Free (prepaid)', FORWARD: 'Carriage forward' },
  invoiceKinds: {
    TD01: 'TD01 Invoice',
    TD02: 'TD02 Advance or deposit invoice',
    TD04: 'TD04 Credit note',
    TD05: 'TD05 Debit note',
    TD24: 'TD24 Deferred invoice',
  },
  totals: {
    net: 'Net amount',
    vat: (rate) => `VAT ${rate}`,
    vatExempt: (nature) => `No VAT (${nature})`,
    gross: { QUOTE: 'Quotation total', PURCHASE_ORDER: 'Order total', DDT: 'Total', INVOICE_COPY: 'Document total' },
    deposit: 'Deposit already invoiced',
    due: 'Amount due',
  },
  notes: 'Notes',
  notices: {
    courtesyCopy:
      'Courtesy copy with no fiscal value. The original is the electronic invoice sent through the Italian exchange ' +
      'system (SdI), available in your reserved area of the Agenzia delle Entrate website.',
    purchaseOrder: 'Please quote this order number on your delivery note and invoice.',
    sample: 'SAMPLE - not a valid document',
  },
  signatures: { driver: "Driver's signature", carrier: "Carrier's signature", recipient: "Recipient's signature" },
}

export const DOCUMENT_WORDS: Readonly<Record<DocumentLanguage, DocumentWords>> = Object.freeze({ it: IT, en: EN })

/** The country names printed in addresses abroad; Italian addresses print no country. */
const COUNTRIES: Readonly<Record<string, Readonly<Record<DocumentLanguage, string>>>> = {
  IT: { it: 'Italia', en: 'Italy' },
  DE: { it: 'Germania', en: 'Germany' },
  FR: { it: 'Francia', en: 'France' },
  ES: { it: 'Spagna', en: 'Spain' },
  AT: { it: 'Austria', en: 'Austria' },
  CH: { it: 'Svizzera', en: 'Switzerland' },
  GB: { it: 'Regno Unito', en: 'United Kingdom' },
  US: { it: 'Stati Uniti', en: 'United States' },
  NL: { it: 'Paesi Bassi', en: 'Netherlands' },
  BE: { it: 'Belgio', en: 'Belgium' },
  PT: { it: 'Portogallo', en: 'Portugal' },
  PL: { it: 'Polonia', en: 'Poland' },
  RO: { it: 'Romania', en: 'Romania' },
}

/** A country's name in the language; the ISO code when the table has none. */
export function countryName(code: string, language: DocumentLanguage): string {
  return COUNTRIES[code.toUpperCase()]?.[language] ?? code.toUpperCase()
}
