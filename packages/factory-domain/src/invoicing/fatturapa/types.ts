import type { Decimal, DecimalInput } from '../../tax/decimal'
import type { TaxRulesConfig } from '../../tax/rules'
import type { PriceBasis, VatSummaryRow } from '../../tax/vat-summary'
import type { VatTreatment } from '../../tax/vat-treatment'

/**
 * Input of the FatturaPA builder (format FPR12, schema VFPR12 v1.2.3: invoices between private parties, B2B and B2C).
 * Amounts are decimals or plain decimal strings, never numbers. Dates are calendar dates, "YYYY-MM-DD".
 * Text must be Latin-1 (the schema allows nothing else); the builder refuses other characters rather than change them.
 */

/** The document types the factory issues. */
export type FatturaPaDocumentType =
  /** Invoice (immediate, or a sale without a DDT). */
  | 'TD01'
  /** Deposit / advance invoice (acconto/anticipo su fattura), DPR 633/1972 art. 6 c.4. */
  | 'TD02'
  /** Credit note, DPR 633/1972 art. 26. */
  | 'TD04'
  /** Deferred invoice from DDTs, DPR 633/1972 art. 21 c.4 terzo periodo lett. a). */
  | 'TD24'

/** A calendar date, "YYYY-MM-DD". */
export type LocalDate = string

/** RegimeFiscale of the seller. RF01 is the ordinary regime. */
export type RegimeFiscale =
  | 'RF01' | 'RF02' | 'RF04' | 'RF05' | 'RF06' | 'RF07' | 'RF08' | 'RF09' | 'RF10' | 'RF11'
  | 'RF12' | 'RF13' | 'RF14' | 'RF15' | 'RF16' | 'RF17' | 'RF18' | 'RF19' | 'RF20'

/**
 * ModalitaPagamento. Common ones: MP01 cash, MP05 bank transfer (bonifico), MP08 payment card, MP12 Ri.Ba.,
 * MP19 SEPA direct debit, MP23 PagoPA.
 */
export type ModalitaPagamento =
  | 'MP01' | 'MP02' | 'MP03' | 'MP04' | 'MP05' | 'MP06' | 'MP07' | 'MP08' | 'MP09' | 'MP10' | 'MP11' | 'MP12'
  | 'MP13' | 'MP14' | 'MP15' | 'MP16' | 'MP17' | 'MP18' | 'MP19' | 'MP20' | 'MP21' | 'MP22' | 'MP23'

export interface Address {
  /** Street (Indirizzo), at most 60 characters. */
  readonly street: string
  /** House number (NumeroCivico), at most 8 characters. */
  readonly streetNumber?: string
  /** Postcode. Italy: 5 digits, required. Abroad: optional; FatturaPA carries the generic 00000 (see build). */
  readonly postcode?: string
  /** City (Comune), at most 60 characters. */
  readonly city: string
  /** Italian province, 2 letters (MI, RM…). Required in Italy, not allowed abroad. */
  readonly province?: string
  /** ISO 3166-1 alpha-2. */
  readonly country: string
}

export interface FatturaPaSeller {
  /** Italian Partita IVA, 11 digits, without the IT prefix. The seller is always Italian. */
  readonly vatNumber: string
  /** Codice fiscale, when it differs from the Partita IVA or must be shown. */
  readonly fiscalCode?: string
  /** Company name (Denominazione), at most 80 characters. */
  readonly name: string
  readonly taxRegime: RegimeFiscale
  /** Registered office (Sede), in Italy. */
  readonly address: Address
  /** Company register entry (IscrizioneREA). */
  readonly rea?: {
    /** Province of the register office, 2 letters. */
    readonly office: string
    readonly number: string
    readonly shareCapital?: DecimalInput
    /** SU: one shareholder; SM: several. */
    readonly shareholders?: 'SU' | 'SM'
    readonly inLiquidation: boolean
  }
  readonly contacts?: { readonly phone?: string; readonly email?: string }
}

/**
 * The buyer (CessionarioCommittente). How it is identified decides the delivery channel:
 *   IT_BUSINESS — Partita IVA; delivered by its SDI code, else by PEC, else to its tax-portal area (0000000)
 *   IT_CONSUMER — codice fiscale only (a consumer, or a body without a Partita IVA); 0000000 unless it has a code
 *   FOREIGN     — foreign tax id; always CodiceDestinatario XXXXXXX (data sent to SDI under D.Lgs. 127/2015
 *                 art. 1 c.3-bis; the customer gets a courtesy copy)
 */
export type FatturaPaBuyer = ItalianBusinessBuyer | ItalianConsumerBuyer | ForeignBuyer

export interface ItalianBusinessBuyer {
  readonly kind: 'IT_BUSINESS'
  readonly vatNumber: string
  readonly fiscalCode?: string
  readonly name: string
  readonly address: Address
  /** 7-character SDI code (codice destinatario). When present it is used and pec is not written. */
  readonly sdiCode?: string
  readonly pec?: string
}

export interface ItalianConsumerBuyer {
  readonly kind: 'IT_CONSUMER'
  readonly fiscalCode: string
  /** A person: firstName and lastName. A body without Partita IVA: name. */
  readonly firstName?: string
  readonly lastName?: string
  readonly name?: string
  readonly address: Address
  readonly sdiCode?: string
  readonly pec?: string
}

export interface ForeignBuyer {
  readonly kind: 'FOREIGN'
  /** Country that issued the tax id (IdPaese), not Italy. */
  readonly country: string
  /** Tax id without the country prefix (IdCodice): the VAT number for an EU business. */
  readonly taxId: string
  readonly firstName?: string
  readonly lastName?: string
  readonly name?: string
  readonly address: Address
}

export interface FatturaPaLineInput {
  /** Descrizione, at most 1000 characters. */
  readonly description: string
  /** More than zero, at most 8 decimals. */
  readonly quantity: DecimalInput
  /** UnitaMisura, at most 10 characters (PZ, PA for pairs, MQ…). */
  readonly unitOfMeasure?: string
  /** Unit price on the invoice's price basis (without VAT for NET, with VAT for GROSS); zero or more, 8 decimals. */
  readonly unitPrice: DecimalInput
  /** Percentage discount on the unit price, more than 0 and less than 100. */
  readonly discountPercent?: DecimalInput
  readonly vat: VatTreatment
  /** CodiceArticolo, for instance { type: 'SKU', value: 'JKT-001-BLK-50' }. */
  readonly itemCode?: { readonly type: string; readonly value: string }
  /** TD24 with several DDTs: the number of the DDT this line shipped on. */
  readonly ddtNumber?: string
}

/** A DDT (documento di trasporto) the invoice covers. */
export interface DdtReference {
  readonly number: string
  readonly date: LocalDate
}

/** Another document the invoice refers to: the customer's purchase order, or the invoice a credit note corrects. */
export interface RelatedDocument {
  readonly number: string
  readonly date?: LocalDate
}

/**
 * A deposit invoice (TD02) deducted from this invoice. One amount per VAT treatment: the taxable amount and the VAT
 * the TD02 charged (all of it, or the part this invoice uses). depositDeductionFrom() makes it from a built TD02.
 */
export interface DepositDeduction {
  readonly invoiceNumber: string
  readonly invoiceDate: LocalDate
  readonly amounts: readonly {
    readonly vat: VatTreatment
    readonly taxable: DecimalInput
    readonly vatAmount: DecimalInput
  }[]
  /** Line text; default "Storno acconto fattura n. <number> del <dd/mm/yyyy>". */
  readonly description?: string
}

export interface PaymentInstallment {
  readonly method: ModalitaPagamento
  readonly amount: DecimalInput
  readonly dueDate?: LocalDate
  readonly iban?: string
  readonly bic?: string
  /** IstitutoFinanziario, at most 80 characters. */
  readonly bankName?: string
  /** Beneficiario, at most 200 characters. */
  readonly beneficiary?: string
}

export interface PaymentTerms {
  /** TP01 in instalments (2 or more), TP02 in full (1), TP03 advance (1). */
  readonly condition: 'TP01' | 'TP02' | 'TP03'
  /** The instalments add up to the amount due (ImportoTotaleDocumento). */
  readonly installments: readonly PaymentInstallment[]
}

export interface FatturaPaInvoiceInput {
  readonly documentType: FatturaPaDocumentType
  /** Invoice number (Numero): at most 20 ASCII characters with at least one digit (SDI 00425). */
  readonly number: string
  readonly date: LocalDate
  /** Only EUR is built. */
  readonly currency?: 'EUR'
  readonly transmission: {
    /**
     * ProgressivoInvio, also used in the file name: 1 to 5 letters or digits, unique per transmitter. The SDI
     * provider may replace it with its own.
     */
    readonly progressive: string
    /** IdTrasmittente; default: IT and the seller's codice fiscale (or Partita IVA). */
    readonly transmitter?: { readonly country: string; readonly code: string }
  }
  readonly seller: FatturaPaSeller
  readonly buyer: FatturaPaBuyer
  /** Default NET. GROSS for prices that include VAT (consumers, deposits paid). */
  readonly priceBasis?: PriceBasis
  readonly lines: readonly FatturaPaLineInput[]
  /** TD01 and TD24: deposit invoices deducted (a negative line per VAT treatment, and a link to each TD02). */
  readonly depositDeductions?: readonly DepositDeduction[]
  /** TD24: at least one; TD01: optional; TD02 and TD04: none. */
  readonly ddts?: readonly DdtReference[]
  /** DatiOrdineAcquisto: the customer's purchase order(s). */
  readonly purchaseOrders?: readonly RelatedDocument[]
  /** DatiFattureCollegate. TD04: the invoice(s) corrected, at least one. */
  readonly relatedInvoices?: readonly RelatedDocument[]
  readonly payment?: PaymentTerms
  /** Causale: free text, split into 200-character pieces. */
  readonly causale?: string
  /** AUTO (default): stamp duty when the stamp-duty rule says so. NONE: never. */
  readonly stampDuty?: 'AUTO' | 'NONE'
  /** Settings for the UNVERIFIED tax rules; default DEFAULT_TAX_RULES_CONFIG. */
  readonly taxRules?: TaxRulesConfig
}

export interface FatturaPaLine {
  readonly lineNumber: number
  readonly kind: 'GOODS' | 'DEPOSIT_DEDUCTION'
  readonly description: string
  readonly quantity: Decimal
  /** PrezzoUnitario, without VAT. */
  readonly unitPrice: Decimal
  /** PrezzoTotale, without VAT. */
  readonly total: Decimal
  readonly vat: VatTreatment
}

/** The built document: the XML and the numbers in it, for the invoice record and its PDF copy. */
export interface FatturaPaDocument {
  readonly xml: string
  /** SDI file name: <country><transmitter id>_<progressive>.xml. */
  readonly fileName: string
  readonly documentType: FatturaPaDocumentType
  readonly number: string
  readonly date: LocalDate
  readonly priceBasis: PriceBasis
  readonly lines: readonly FatturaPaLine[]
  readonly summary: readonly VatSummaryRow[]
  readonly totals: {
    readonly taxable: Decimal
    readonly vat: Decimal
    /** ImportoTotaleDocumento: taxable + VAT, after any deposit deducted. The amount due. */
    readonly total: Decimal
    /** ImportoBollo when stamp duty applies (not added to the total). */
    readonly stampDuty: Decimal | null
  }
}

export interface FatturaPaIssue {
  /** Where, as a path into the input: "buyer.vatNumber", "lines[2].quantity". */
  readonly path: string
  readonly code: string
  readonly message: string
}

/** The input cannot make a valid FatturaPA; issues lists every problem found, not only the first. */
export class FatturaPaInputError extends Error {
  readonly issues: readonly FatturaPaIssue[]

  constructor(issues: readonly FatturaPaIssue[]) {
    super(
      `FatturaPA input is not valid (${issues.length} issue${issues.length === 1 ? '' : 's'}):\n` +
        issues.map((issue) => `  ${issue.path}: ${issue.message} [${issue.code}]`).join('\n'),
    )
    this.name = 'FatturaPaInputError'
    this.issues = issues
  }
}
