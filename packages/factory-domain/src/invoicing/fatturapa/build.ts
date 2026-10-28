import { Dec, ONE_CENT, sum, ZERO } from '../../tax/decimal'
import { stampDutyFor, type StampDutyDecision } from '../../tax/stamp-duty'
import { computeVat, type VatComputation, type VatSummaryRow } from '../../tax/vat-summary'
import { formatAmount, formatPrice, formatRate, chunkText } from './format'
import {
  FatturaPaInputError,
  type FatturaPaDocument,
  type FatturaPaInvoiceInput,
  type FatturaPaIssue,
  type FatturaPaLine,
} from './types'
import { validateFatturaPaInput, type NormalizedAddress, type NormalizedInvoice, type NormalizedLine, type NormalizedParty } from './validate'
import { el, optional, serializeXml, type XmlElement } from './xml'

/**
 * Builds the FatturaPA XML (FPR12, schema VFPR12 v1.2.3) of one document from a typed, decimal-based input.
 * Pure and deterministic: the same input gives the same bytes. It only builds and checks; the SDI provider adapter
 * (A1 §4, SdiPort) sends it.
 *
 * Legal frame: DPR 633/1972 art. 21 (contents of an invoice; c.4 deferred invoices; c.6 and c.6-bis wording for
 * zero-VAT lines), art. 6 c.4 (deposit invoices), art. 26 (credit notes); D.Lgs. 127/2015 (invoices through SDI,
 * including foreign customers' data, art. 1 c.3-bis).
 */
export const FATTURAPA_NAMESPACE = 'http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2'
export const FATTURAPA_SCHEMA_VERSION = '1.2.3'

interface Prepared {
  readonly invoice: NormalizedInvoice
  readonly vat: VatComputation
  readonly stampDuty: StampDutyDecision
}

function prepare(input: FatturaPaInvoiceInput): { issues: readonly FatturaPaIssue[]; prepared: Prepared | null } {
  const { issues, normalized } = validateFatturaPaInput(input)
  if (normalized === null) return { issues, prepared: null }

  const vat = computeVat(
    normalized.lines.map((line) => ({
      treatment: line.vat,
      quantity: line.quantity,
      unitPrice: line.unitPrice,
      ...(line.discountPercent === null ? {} : { discountPercent: line.discountPercent }),
      ...(line.fixed === null ? {} : { fixed: line.fixed }),
    })),
    normalized.priceBasis,
  )

  const late: FatturaPaIssue[] = []
  // SDI 00423: PrezzoUnitario x (1 - discount) x Quantita must give PrezzoTotale within a cent. On the GROSS basis
  // the unit price is derived (8 decimals), which a very large quantity could push past the cent.
  normalized.lines.forEach((line, index) => {
    const computed = vat.lines[index]!
    const discount = line.discountPercent === null ? ZERO : line.discountPercent
    const factor = new Dec(100).minus(discount).dividedBy(100).times(line.quantity)
    if (computed.unitNetPrice.times(factor).minus(computed.net).abs().gt(ONE_CENT)) {
      late.push({
        path: `lines[${index}]`,
        code: 'LINE_UNIT_PRICE_ROUNDING',
        message: 'the unit price without VAT cannot be written exactly enough for this quantity; split the line or use the NET basis',
      })
    }
  })
  for (const row of vat.summary) {
    if (row.taxable.lt(ZERO) || row.gross.lt(ZERO)) {
      late.push({
        path: 'depositDeductions',
        code: 'DEPOSIT_EXCEEDS_LINES',
        message: 'the deposit deducted is more than the lines it is deducted from; deduct less, or issue a credit note',
      })
      break
    }
  }
  if (normalized.payment !== null) {
    const paid = sum(normalized.payment.installments.map((item) => item.amount))
    if (!paid.equals(vat.total)) {
      late.push({
        path: 'payment.installments',
        code: 'PAYMENT_SUM_MISMATCH',
        message: `the payments add up to ${formatAmount(paid)}, the amount due is ${formatAmount(vat.total)}`,
      })
    }
  }
  if (late.length > 0) return { issues: late, prepared: null }

  const stampDuty: StampDutyDecision =
    normalized.stampDuty === 'AUTO'
      ? stampDutyFor(vat.summary, normalized.taxRules)
      : { due: false, amount: null, base: ZERO }
  return { issues: [], prepared: { invoice: normalized, vat, stampDuty } }
}

/** Every problem that stops the input from becoming a valid FatturaPA (FIN-085 pre-check). Empty when it is fine. */
export function checkFatturaPaInput(input: FatturaPaInvoiceInput): readonly FatturaPaIssue[] {
  return prepare(input).issues
}

/** Builds the document; throws FatturaPaInputError with every issue when the input is not valid. */
export function buildFatturaPa(input: FatturaPaInvoiceInput): FatturaPaDocument {
  const { issues, prepared } = prepare(input)
  if (prepared === null) throw new FatturaPaInputError(issues)
  const { invoice, vat, stampDuty } = prepared

  const lines: FatturaPaLine[] = invoice.lines.map((line, index) => {
    const computed = vat.lines[index]!
    return {
      lineNumber: index + 1,
      kind: line.kind,
      description: line.description,
      quantity: line.quantity,
      unitPrice: computed.unitNetPrice,
      total: computed.net,
      vat: line.vat,
    }
  })

  const root = el(
    'p:FatturaElettronica',
    [header(invoice), body(invoice, lines, vat, stampDuty)],
    [
      ['versione', 'FPR12'],
      ['xmlns:ds', 'http://www.w3.org/2000/09/xmldsig#'],
      ['xmlns:p', FATTURAPA_NAMESPACE],
      ['xmlns:xsi', 'http://www.w3.org/2001/XMLSchema-instance'],
    ],
  )

  return {
    xml: serializeXml(root),
    fileName: `${invoice.transmitter.country}${invoice.transmitter.code}_${invoice.progressive}.xml`,
    documentType: invoice.documentType,
    number: invoice.number,
    date: invoice.date,
    priceBasis: invoice.priceBasis,
    lines,
    summary: vat.summary,
    totals: { taxable: vat.taxable, vat: vat.vat, total: vat.total, stampDuty: stampDuty.amount },
  }
}

// ── Header ─────────────────────────────────────────────────────────────────────────────────────────────────────────

function idFiscale(id: NormalizedParty['idFiscaleIva']): XmlElement | null {
  return id === null ? null : el('IdFiscaleIVA', [el('IdPaese', id.country), el('IdCodice', id.code)])
}

function anagraficaXml(party: NormalizedParty): XmlElement {
  const names = party.anagrafica
  return el(
    'Anagrafica',
    'name' in names ? [el('Denominazione', names.name)] : [el('Nome', names.firstName), el('Cognome', names.lastName)],
  )
}

function sede(name: string, address: NormalizedAddress): XmlElement {
  return el(name, [
    el('Indirizzo', address.street),
    optional('NumeroCivico', address.streetNumber),
    el('CAP', address.cap),
    el('Comune', address.city),
    optional('Provincia', address.province),
    el('Nazione', address.country),
  ])
}

function header(invoice: NormalizedInvoice): XmlElement {
  const { seller, buyer } = invoice
  const rea = seller.rea
  const contacts = seller.contacts
  return el('FatturaElettronicaHeader', [
    el('DatiTrasmissione', [
      el('IdTrasmittente', [el('IdPaese', invoice.transmitter.country), el('IdCodice', invoice.transmitter.code)]),
      el('ProgressivoInvio', invoice.progressive),
      el('FormatoTrasmissione', 'FPR12'),
      el('CodiceDestinatario', invoice.codiceDestinatario),
      optional('PECDestinatario', invoice.pecDestinatario),
    ]),
    el('CedentePrestatore', [
      el('DatiAnagrafici', [
        idFiscale(seller.idFiscaleIva),
        optional('CodiceFiscale', seller.fiscalCode),
        anagraficaXml(seller),
        el('RegimeFiscale', seller.taxRegime),
      ]),
      sede('Sede', seller.address),
      rea !== null &&
        el('IscrizioneREA', [
          el('Ufficio', rea.office),
          el('NumeroREA', rea.number),
          rea.shareCapital !== null && el('CapitaleSociale', formatAmount(rea.shareCapital)),
          optional('SocioUnico', rea.shareholders),
          el('StatoLiquidazione', rea.inLiquidation ? 'LS' : 'LN'),
        ]),
      contacts !== null &&
        (contacts.phone !== null || contacts.email !== null) &&
        el('Contatti', [optional('Telefono', contacts.phone), optional('Email', contacts.email)]),
    ]),
    el('CessionarioCommittente', [
      el('DatiAnagrafici', [idFiscale(buyer.idFiscaleIva), optional('CodiceFiscale', buyer.fiscalCode), anagraficaXml(buyer)]),
      sede('Sede', buyer.address),
    ]),
  ])
}

// ── Body ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The line numbers each DDT covers; empty when the only DDT covers every goods line (the whole invoice). */
function ddtLineNumbers(invoice: NormalizedInvoice, lines: readonly FatturaPaLine[]): Map<string, number[]> {
  const result = new Map<string, number[]>()
  const goods = invoice.lines
    .map((line, index) => ({ line, lineNumber: lines[index]!.lineNumber }))
    .filter(({ line }) => line.kind === 'GOODS')
  for (const ddt of invoice.ddts) {
    const covered = goods
      .filter(({ line }) => line.ddtNumber === ddt.number || (line.ddtNumber === null && invoice.ddts.length === 1))
      .map(({ lineNumber }) => lineNumber)
    result.set(ddt.number, invoice.ddts.length === 1 && covered.length === goods.length ? [] : covered)
  }
  return result
}

function rateText(line: Pick<NormalizedLine, 'vat'>): string {
  return line.vat.kind === 'TAXABLE' ? formatRate(new Dec(line.vat.rate)) : '0.00'
}

function dettaglioLinee(line: NormalizedLine, computed: FatturaPaLine): XmlElement {
  return el('DettaglioLinee', [
    el('NumeroLinea', String(computed.lineNumber)),
    line.itemCode !== null &&
      el('CodiceArticolo', [el('CodiceTipo', line.itemCode.type), el('CodiceValore', line.itemCode.value)]),
    el('Descrizione', line.description),
    el('Quantita', formatPrice(line.quantity)),
    optional('UnitaMisura', line.unitOfMeasure),
    el('PrezzoUnitario', formatPrice(computed.unitPrice)),
    line.discountPercent !== null &&
      el('ScontoMaggiorazione', [el('Tipo', 'SC'), el('Percentuale', formatRate(line.discountPercent))]),
    el('PrezzoTotale', formatAmount(computed.total)),
    el('AliquotaIVA', rateText(line)),
    line.vat.kind === 'NON_TAXABLE' && el('Natura', line.vat.natura),
  ])
}

function datiRiepilogo(row: VatSummaryRow): XmlElement {
  const t = row.treatment
  return el('DatiRiepilogo', [
    el('AliquotaIVA', t.kind === 'TAXABLE' ? formatRate(new Dec(t.rate)) : '0.00'),
    t.kind === 'NON_TAXABLE' && el('Natura', t.natura),
    !row.rounding.isZero() && el('Arrotondamento', formatAmount(row.rounding)),
    el('ImponibileImporto', formatAmount(row.taxable)),
    el('Imposta', formatAmount(row.vat)),
    t.kind === 'TAXABLE' && el('EsigibilitaIVA', t.exigibility ?? 'I'),
    t.kind === 'NON_TAXABLE' && el('RiferimentoNormativo', t.legalReference),
  ])
}

function body(
  invoice: NormalizedInvoice,
  lines: readonly FatturaPaLine[],
  vat: VatComputation,
  stampDuty: StampDutyDecision,
): XmlElement {
  const ddtLines = ddtLineNumbers(invoice, lines)
  const payment = invoice.payment
  return el('FatturaElettronicaBody', [
    el('DatiGenerali', [
      el('DatiGeneraliDocumento', [
        el('TipoDocumento', invoice.documentType),
        el('Divisa', 'EUR'),
        el('Data', invoice.date),
        el('Numero', invoice.number),
        stampDuty.amount !== null &&
          el('DatiBollo', [el('BolloVirtuale', 'SI'), el('ImportoBollo', formatAmount(stampDuty.amount))]),
        el('ImportoTotaleDocumento', formatAmount(vat.total)),
        ...(invoice.causale === null ? [] : chunkText(invoice.causale, 200).map((piece) => el('Causale', piece))),
      ]),
      ...invoice.purchaseOrders.map((doc) =>
        el('DatiOrdineAcquisto', [el('IdDocumento', doc.number), optional('Data', doc.date)]),
      ),
      ...invoice.relatedInvoices.map((doc) =>
        el('DatiFattureCollegate', [el('IdDocumento', doc.number), optional('Data', doc.date)]),
      ),
      ...invoice.ddts.map((ddt) =>
        el('DatiDDT', [
          el('NumeroDDT', ddt.number),
          el('DataDDT', ddt.date),
          ...(ddtLines.get(ddt.number) ?? []).map((lineNumber) => el('RiferimentoNumeroLinea', String(lineNumber))),
        ]),
      ),
    ]),
    el('DatiBeniServizi', [
      ...invoice.lines.map((line, index) => dettaglioLinee(line, lines[index]!)),
      ...vat.summary.map(datiRiepilogo),
    ]),
    payment !== null &&
      el('DatiPagamento', [
        el('CondizioniPagamento', payment.condition),
        ...payment.installments.map((item) =>
          el('DettaglioPagamento', [
            optional('Beneficiario', item.beneficiary),
            el('ModalitaPagamento', item.method),
            optional('DataScadenzaPagamento', item.dueDate),
            el('ImportoPagamento', formatAmount(item.amount)),
            optional('IstitutoFinanziario', item.bankName),
            optional('IBAN', item.iban),
            optional('BIC', item.bic),
          ]),
        ),
      ]),
  ])
}
