import { minorPlaces, toMinorUnits } from '../core/money'
import { Dec, parseDecimal, type Decimal } from '../tax/decimal'
import { child, children, parseXml, textAt, XmlReadError, type XmlNode } from './xml'

/**
 * Reading a passive FatturaPA (B-W2a-62; FIN-136): the XML a supplier or subcontractor sent the company through SDI,
 * delivered by the company's SDI intermediary (FAKE until Owner question Q21). Formats FPR12 (between private parties) and
 * FPA12; schema VFPR12 v1.2.x. What it says becomes the SupplierInvoice and its lines AS RECEIVED: the number, the dates,
 * the sums, the VAT summary, the payment terms and each line's figures never change afterwards (the …_money_w2a_guards
 * hold that); only how the lines are mapped to orders does. Pure: no I/O.
 *
 * Read per FatturaElettronicaBody (a file may hold a batch, a "lotto", of several invoices of one supplier):
 *   the supplier  CedentePrestatore: IdFiscaleIVA (IdPaese + IdCodice), CodiceFiscale, the name
 *   the buyer     CessionarioCommittente: IdFiscaleIVA, CodiceFiscale (the company it is addressed to)
 *   the document  TipoDocumento, Divisa, Data, Numero, DatiRitenuta, DatiBollo, ImportoTotaleDocumento, Causale
 *   references    DatiOrdineAcquisto (our order: IdDocumento, NumItem, the lines it covers), DatiDDT (the delivery notes:
 *                 NumeroDDT, DataDDT, the lines), DatiFattureCollegate (the invoice a credit note credits)
 *   lines         DettaglioLinee: NumeroLinea, TipoCessionePrestazione, CodiceArticolo, Descrizione, Quantita, UnitaMisura,
 *                 PrezzoUnitario, ScontoMaggiorazione, PrezzoTotale, AliquotaIVA, Natura
 *   summary       DatiRiepilogo: AliquotaIVA, Natura, ImponibileImporto, Imposta
 *   payment       DatiPagamento: CondizioniPagamento, DettaglioPagamento (ModalitaPagamento, DataScadenzaPagamento,
 *                 ImportoPagamento, IBAN)
 *   attachments   Allegati: the supplier's own PDF of the invoice, when it attached one
 * Amounts become minor units of the invoice's currency; unit prices six places and quantities four (the columns'
 * scales, rounded half up: FatturaPA allows eight). A signed file (.p7m, CAdES) is opened by the intermediary: the port
 * hands the XML.
 */

export class FatturaPaReadError extends Error {
  override name = 'FatturaPaReadError'
}

export interface ReceivedParty {
  /** IdFiscaleIVA: IdPaese and IdCodice, and the two joined (IT01234567890). */
  readonly country: string | null
  readonly vatCode: string | null
  readonly vatNumber: string | null
  readonly fiscalCode: string | null
  readonly name: string | null
}

export interface ReceivedLine {
  readonly seq: number
  /** TipoCessionePrestazione: SC sconto, PR premio, AB abbuono, AC spesa accessoria; null for an ordinary line. */
  readonly lineType: 'SC' | 'PR' | 'AB' | 'AC' | null
  readonly description: string
  /** The first CodiceArticolo's value (CodiceValore), and every code with its type. */
  readonly itemCode: string | null
  readonly codes: readonly { readonly type: string | null; readonly value: string }[]
  /** Four places, above 0; null when not given (or not above 0: the XML keeps it). */
  readonly quantity: string | null
  readonly uom: string | null
  /** Six places, as printed (may be negative on a discount line). */
  readonly unitPrice: string | null
  /** One percentage discount (SC) above 0 and below 100; null for none, several, a surcharge or an amount. */
  readonly discountPct: string | null
  /** PrezzoTotale in minor units (negative on a discount line). */
  readonly netAmount: number
  readonly vatRatePct: string
  readonly vatNature: string | null
}

export interface ReceivedReference {
  /** The lines (NumeroLinea) it covers; empty: the whole document. */
  readonly lines: readonly number[]
  readonly document: string | null
  readonly date: string | null
  /** NumItem: the referenced document's line. */
  readonly item: string | null
}

export interface ReceivedDdt {
  readonly number: string
  readonly date: string | null
  readonly lines: readonly number[]
}

export interface ReceivedVatRow {
  readonly rate: string | null
  readonly nature: string | null
  readonly taxable: number
  readonly vat: number
}

export interface ReceivedInstallment {
  readonly method: string | null
  readonly amount: number | null
  readonly dueDate: string | null
  readonly iban: string | null
}

export interface ReceivedAttachment {
  readonly name: string
  readonly format: string | null
  readonly description: string | null
  /** The bytes, base64 as in the XML (whitespace removed). */
  readonly base64: string
}

export interface ReceivedDocument {
  readonly docType: string
  readonly kind: 'INVOICE' | 'CREDIT_NOTE'
  readonly currency: string
  readonly issueDate: string
  readonly number: string
  readonly causale: readonly string[]
  readonly netTotal: number
  readonly vatTotal: number
  readonly grossTotal: number
  readonly withholdingAmount: number | null
  readonly stampDutyAmount: number | null
  readonly vatSummary: readonly ReceivedVatRow[]
  readonly paymentTerms: { readonly condition: string | null; readonly installments: readonly ReceivedInstallment[] } | null
  /** The earliest due date of the payment. */
  readonly dueDate: string | null
  readonly orders: readonly ReceivedReference[]
  readonly contracts: readonly ReceivedReference[]
  readonly ddts: readonly ReceivedDdt[]
  /** DatiFattureCollegate: the invoice(s) a credit note refers to. */
  readonly related: readonly ReceivedReference[]
  readonly lines: readonly ReceivedLine[]
  readonly attachments: readonly ReceivedAttachment[]
}

export interface ReceivedFatturaPa {
  readonly format: string | null
  readonly supplier: ReceivedParty
  readonly buyer: ReceivedParty
  readonly documents: readonly ReceivedDocument[]
}

/** The credit notes among the TipoDocumento codes a supplier sends (nota di credito, and the simplified one). */
export const CREDIT_NOTE_TYPES: readonly string[] = Object.freeze(['TD04', 'TD08'])
const DOC_TYPE = /^TD\d{2}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/
const NATURE = /^N[1-7](\.[0-9])?$/

function decimalOf(value: string | null, path: string): Decimal | null {
  if (value === null) return null
  const parsed = parseDecimal(value.trim())
  if (parsed === null) throw new FatturaPaReadError(`${path} is not a decimal (${value.slice(0, 40)}).`)
  return parsed
}

function required(node: XmlNode | null, path: string, ...at: string[]): string {
  const value = textAt(node, ...at)
  if (value === null) throw new FatturaPaReadError(`${path} is missing.`)
  return value
}

function dateOf(value: string | null, path: string): string | null {
  if (value === null) return null
  const day = value.slice(0, 10)
  if (!DATE.test(day)) throw new FatturaPaReadError(`${path} is not a date (${value.slice(0, 40)}).`)
  return day
}

function amount(value: Decimal, currency: string): number {
  return toMinorUnits(value.toDecimalPlaces(minorPlaces(currency), Dec.ROUND_HALF_UP), currency)
}

function partyOf(node: XmlNode | null): ReceivedParty {
  const data = child(node, 'DatiAnagrafici')
  const country = textAt(data, 'IdFiscaleIVA', 'IdPaese')?.toUpperCase() ?? null
  const vatCode = textAt(data, 'IdFiscaleIVA', 'IdCodice')?.toUpperCase() ?? null
  const denominazione = textAt(data, 'Anagrafica', 'Denominazione')
  const person = [textAt(data, 'Anagrafica', 'Nome'), textAt(data, 'Anagrafica', 'Cognome')].filter((part) => part !== null).join(' ')
  return {
    country,
    vatCode,
    vatNumber: country && vatCode ? `${country}${vatCode}` : null,
    fiscalCode: textAt(data, 'CodiceFiscale')?.toUpperCase() ?? null,
    name: denominazione ?? (person === '' ? null : person),
  }
}

const lineNumbers = (node: XmlNode): number[] =>
  children(node, 'RiferimentoNumeroLinea')
    .map((entry) => Number.parseInt(entry.text.trim(), 10))
    .filter((value) => Number.isInteger(value) && value > 0)

function referencesOf(node: XmlNode | null, name: string): ReceivedReference[] {
  return children(node, name).map((entry) => ({
    lines: lineNumbers(entry),
    document: textAt(entry, 'IdDocumento'),
    date: dateOf(textAt(entry, 'Data'), `${name}/Data`),
    item: textAt(entry, 'NumItem'),
  }))
}

function lineOf(node: XmlNode, currency: string, index: number): ReceivedLine {
  const at = `DettaglioLinee[${index + 1}]`
  const seq = Number.parseInt(required(node, `${at}/NumeroLinea`, 'NumeroLinea'), 10)
  if (!Number.isInteger(seq) || seq < 1) throw new FatturaPaReadError(`${at}/NumeroLinea is not a line number.`)
  const type = textAt(node, 'TipoCessionePrestazione')
  const codes = children(node, 'CodiceArticolo')
    .map((code) => ({ type: textAt(code, 'CodiceTipo'), value: textAt(code, 'CodiceValore') }))
    .filter((code): code is { type: string | null; value: string } => code.value !== null)
  const quantity = decimalOf(textAt(node, 'Quantita'), `${at}/Quantita`)
  const unitPrice = decimalOf(textAt(node, 'PrezzoUnitario'), `${at}/PrezzoUnitario`)
  const total = decimalOf(required(node, `${at}/PrezzoTotale`, 'PrezzoTotale'), `${at}/PrezzoTotale`)!
  const rate = decimalOf(required(node, `${at}/AliquotaIVA`, 'AliquotaIVA'), `${at}/AliquotaIVA`)!
  const discounts = children(node, 'ScontoMaggiorazione')
  let discountPct: string | null = null
  if (discounts.length === 1 && textAt(discounts[0], 'Tipo') === 'SC') {
    const pct = decimalOf(textAt(discounts[0], 'Percentuale'), `${at}/ScontoMaggiorazione/Percentuale`)
    if (pct && pct.greaterThan(0) && pct.lessThan(100)) discountPct = pct.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
  }
  const nature = textAt(node, 'Natura')
  return {
    seq,
    lineType: type === 'SC' || type === 'PR' || type === 'AB' || type === 'AC' ? type : null,
    description: (textAt(node, 'Descrizione') ?? `Line ${seq}`).replace(/\s+/g, ' ').slice(0, 1000),
    itemCode: codes[0]?.value ?? null,
    codes,
    quantity: quantity && quantity.greaterThan(0) ? quantity.toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4) : null,
    uom: textAt(node, 'UnitaMisura'),
    unitPrice: unitPrice ? unitPrice.toDecimalPlaces(6, Dec.ROUND_HALF_UP).toFixed(6) : null,
    discountPct,
    netAmount: amount(total, currency),
    vatRatePct: rate.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2),
    vatNature: nature && NATURE.test(nature) ? nature : null,
  }
}

function documentOf(body: XmlNode, index: number): ReceivedDocument {
  const at = `FatturaElettronicaBody[${index + 1}]`
  const general = child(body, 'DatiGenerali', 'DatiGeneraliDocumento')
  if (!general) throw new FatturaPaReadError(`${at}/DatiGenerali/DatiGeneraliDocumento is missing.`)
  const docType = required(general, `${at} TipoDocumento`, 'TipoDocumento')
  if (!DOC_TYPE.test(docType)) throw new FatturaPaReadError(`${at} TipoDocumento ${docType} is not a TDnn code.`)
  const currency = required(general, `${at} Divisa`, 'Divisa').toUpperCase()
  try {
    minorPlaces(currency)
  } catch {
    throw new FatturaPaReadError(`${at} Divisa ${currency} is not a currency code.`)
  }
  const issueDate = dateOf(required(general, `${at} Data`, 'Data'), `${at} Data`)!
  const number = required(general, `${at} Numero`, 'Numero').slice(0, 20)
  const withholdings = children(general, 'DatiRitenuta')
    .map((entry) => decimalOf(textAt(entry, 'ImportoRitenuta'), `${at} ImportoRitenuta`))
    .filter((value): value is Decimal => value !== null)
  const stamp = decimalOf(textAt(general, 'DatiBollo', 'ImportoBollo'), `${at} ImportoBollo`)
  const stated = decimalOf(textAt(general, 'ImportoTotaleDocumento'), `${at} ImportoTotaleDocumento`)
  const goods = child(body, 'DatiBeniServizi')
  const lines = children(goods, 'DettaglioLinee').map((line, position) => lineOf(line, currency, position))
  if (lines.length === 0) throw new FatturaPaReadError(`${at} has no DettaglioLinee.`)
  if (new Set(lines.map((line) => line.seq)).size !== lines.length) throw new FatturaPaReadError(`${at} repeats a NumeroLinea.`)
  const vatSummary = children(goods, 'DatiRiepilogo').map((row) => {
    const rate = decimalOf(textAt(row, 'AliquotaIVA'), `${at} DatiRiepilogo/AliquotaIVA`)
    const nature = textAt(row, 'Natura')
    return {
      rate: rate ? rate.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2) : null,
      nature: nature && NATURE.test(nature) ? nature : null,
      taxable: amount(decimalOf(required(row, `${at} ImponibileImporto`, 'ImponibileImporto'), `${at} ImponibileImporto`)!, currency),
      vat: amount(decimalOf(required(row, `${at} Imposta`, 'Imposta'), `${at} Imposta`)!, currency),
    }
  })
  const netTotal = vatSummary.reduce((total, row) => total + row.taxable, 0)
  const vatTotal = vatSummary.reduce((total, row) => total + row.vat, 0)
  const payments = children(body, 'DatiPagamento')
  const installments = payments.flatMap((payment) =>
    children(payment, 'DettaglioPagamento').map((detail) => {
      const paid = decimalOf(textAt(detail, 'ImportoPagamento'), `${at} ImportoPagamento`)
      return {
        method: textAt(detail, 'ModalitaPagamento'),
        amount: paid === null ? null : amount(paid, currency),
        dueDate: dateOf(textAt(detail, 'DataScadenzaPagamento'), `${at} DataScadenzaPagamento`),
        iban: textAt(detail, 'IBAN')?.replace(/\s+/g, '').toUpperCase() ?? null,
      }
    }),
  )
  const dueDates = installments.map((entry) => entry.dueDate).filter((value): value is string => value !== null).sort()
  const generalData = child(body, 'DatiGenerali')
  return {
    docType,
    kind: CREDIT_NOTE_TYPES.includes(docType) ? 'CREDIT_NOTE' : 'INVOICE',
    currency,
    issueDate,
    number,
    causale: children(general, 'Causale').map((entry) => entry.text.trim()).filter((value) => value !== ''),
    netTotal,
    vatTotal,
    grossTotal: stated ? amount(stated, currency) : netTotal + vatTotal,
    withholdingAmount: withholdings.length > 0 ? withholdings.reduce((total, value) => total + amount(value, currency), 0) : null,
    stampDutyAmount: stamp ? amount(stamp, currency) : null,
    vatSummary,
    paymentTerms: payments.length > 0 ? { condition: textAt(payments[0], 'CondizioniPagamento'), installments } : null,
    dueDate: dueDates[0] ?? null,
    orders: referencesOf(generalData, 'DatiOrdineAcquisto'),
    contracts: referencesOf(generalData, 'DatiContratto'),
    ddts: children(generalData, 'DatiDDT')
      .map((entry) => ({ number: textAt(entry, 'NumeroDDT') ?? '', date: dateOf(textAt(entry, 'DataDDT'), `${at} DataDDT`), lines: lineNumbers(entry) }))
      .filter((entry) => entry.number !== ''),
    related: referencesOf(generalData, 'DatiFattureCollegate'),
    lines,
    attachments: children(body, 'Allegati')
      .map((entry) => ({
        name: textAt(entry, 'NomeAttachment') ?? 'attachment',
        format: textAt(entry, 'FormatoAttachment')?.toUpperCase() ?? null,
        description: textAt(entry, 'DescrizioneAttachment'),
        base64: (child(entry, 'Attachment')?.text ?? '').replace(/\s+/g, ''),
      }))
      .filter((entry) => entry.base64 !== ''),
  }
}

/** Reads a supplier's FatturaPA. Throws FatturaPaReadError (in words, naming the element) when it cannot. */
export function readFatturaPa(xml: string): ReceivedFatturaPa {
  let root: XmlNode
  try {
    root = parseXml(xml)
  } catch (error) {
    if (error instanceof XmlReadError) throw new FatturaPaReadError(`The file is not readable XML: ${error.message}`)
    throw error
  }
  if (root.name !== 'FatturaElettronica') throw new FatturaPaReadError(`The file is not a FatturaPA (its root is <${root.name}>).`)
  const header = child(root, 'FatturaElettronicaHeader')
  if (!header) throw new FatturaPaReadError('FatturaElettronicaHeader is missing.')
  const bodies = children(root, 'FatturaElettronicaBody')
  if (bodies.length === 0) throw new FatturaPaReadError('FatturaElettronicaBody is missing.')
  return {
    format: root.attributes.versione ?? textAt(header, 'DatiTrasmissione', 'FormatoTrasmissione'),
    supplier: partyOf(child(header, 'CedentePrestatore')),
    buyer: partyOf(child(header, 'CessionarioCommittente')),
    documents: bodies.map((body, index) => documentOf(body, index)),
  }
}

/** Two tax ids are the same company's: VAT numbers with or without the country, or a fiscal code. */
export function sameTaxId(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false
  const clean = (value: string) => value.replace(/\s+/g, '').toUpperCase()
  const strip = (value: string) => clean(value).replace(/^[A-Z]{2}(?=[0-9A-Z]{6,})/, '')
  return clean(a) === clean(b) || strip(a) === strip(b)
}
