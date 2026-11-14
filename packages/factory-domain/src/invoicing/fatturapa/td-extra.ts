import { isEuMemberState } from '../../tax/eu'
import type { FatturaPaInvoiceInput } from './types'
import type { NormalizedAddress, NormalizedInvoice, NormalizedParty } from './validate'
import { el, optional, type XmlElement } from './xml'

/**
 * The FatturaPA of the document types B-W2b-401 adds to the builder (FIN-071, FIN-095; Agenzia delle Entrate, "Guida alla
 * compilazione delle fatture elettroniche e dell'esterometro"): the debit note TD05 and the self-invoices TD17, TD18, TD19.
 * The builder (build.ts, validate.ts) asks this file for their own checks and for a self-invoice's header; everything else
 * (lines, VAT summary, totals, payment) is the builder's as for any invoice.
 *
 *   TD05  a debit note (art. 26 c.1 DPR 633/1972): names the invoice it adds to (DatiFattureCollegate); deducts no deposit
 *   TD17  integration / self-invoice for services bought abroad (art. 17 c.2)
 *   TD18  integration for goods bought from another EU state (art. 46 DL 331/1993)
 *   TD19  integration / self-invoice for goods already in Italy bought from a non-resident (art. 17 c.2)
 *
 * A self-invoice is issued by the company about a purchase: the input keeps the company as `seller` (it transmits the file and
 * its series numbers it) and the foreign supplier as `buyer` (the Invoice's buyer party), and the header swaps them as the
 * guide asks: CedentePrestatore is the supplier, CessionarioCommittente the company. UNVERIFIED (GATE-ACCOUNTANT): the
 * supplier's RegimeFiscale RF18 ("other"), CodiceDestinatario 0000000 (the file reaches the company's own tax drawer), the
 * supplier's invoice in DatiFattureCollegate.
 */

export const EXTRA_DOCUMENT_TYPES = ['TD05', 'TD17', 'TD18', 'TD19'] as const
export type ExtraDocumentType = (typeof EXTRA_DOCUMENT_TYPES)[number]

const SELF_INVOICE_TYPES: readonly string[] = ['TD17', 'TD18', 'TD19']

/** A self-invoice type: its header names the supplier as cedente and the company as cessionario. */
export const isSelfInvoiceDocument = (documentType: string): boolean => SELF_INVOICE_TYPES.includes(documentType)

/** The supplier's RegimeFiscale on a self-invoice (UNVERIFIED: RF18, "other", for a supplier abroad). */
export const SELF_INVOICE_SUPPLIER_REGIME = 'RF18'
/** CodiceDestinatario of a self-invoice (UNVERIFIED: the company's own tax drawer). */
export const SELF_INVOICE_DESTINATION = '0000000'

/** The extra types' own checks (each problem through `add`, as the builder's). */
export function extraTypeIssues(input: FatturaPaInvoiceInput, add: (path: string, code: string, message: string) => void): void {
  const type = input.documentType
  if (type !== 'TD05' && !isSelfInvoiceDocument(type)) return
  const related = input.relatedInvoices ?? []
  if ((input.depositDeductions ?? []).length > 0) add('depositDeductions', 'DEPOSIT_DEDUCTION_NOT_ALLOWED', `a ${type} cannot deduct a deposit; only TD01 and TD24 do`)
  if (type === 'TD05') {
    if (related.length === 0) add('relatedInvoices', 'TD05_NEEDS_INVOICE', 'a debit note names the invoice it adds to (DPR 633/1972 art. 26 c.1)')
    return
  }
  if (related.length === 0) add('relatedInvoices', 'SELF_INVOICE_NEEDS_INVOICE', "a self-invoice names the supplier's invoice it integrates")
  if ((input.ddts ?? []).length > 0) add('ddts', 'DDT_NOT_ALLOWED', `a ${type} does not invoice DDTs`)
  if (input.buyer?.kind !== 'FOREIGN') add('buyer.kind', 'SELF_INVOICE_SUPPLIER', `a ${type} integrates the invoice of a supplier without an Italian VAT number (FOREIGN)`)
  else if (type === 'TD18' && !isEuMemberState(String(input.buyer.country ?? '').trim().toUpperCase())) {
    add('buyer.country', 'TD18_NOT_EU', 'a TD18 integrates goods bought from another EU state')
  }
}

function idFiscale(id: NormalizedParty['idFiscaleIva']): XmlElement | null {
  return id === null ? null : el('IdFiscaleIVA', [el('IdPaese', id.country), el('IdCodice', id.code)])
}

function anagrafica(party: NormalizedParty): XmlElement {
  const names = party.anagrafica
  return el('Anagrafica', 'name' in names ? [el('Denominazione', names.name)] : [el('Nome', names.firstName), el('Cognome', names.lastName)])
}

function sede(address: NormalizedAddress): XmlElement {
  return el('Sede', [el('Indirizzo', address.street), optional('NumeroCivico', address.streetNumber), el('CAP', address.cap), el('Comune', address.city), optional('Provincia', address.province), el('Nazione', address.country)])
}

/** The header of a self-invoice: the supplier (the input's buyer) as CedentePrestatore, the company (the seller) as CessionarioCommittente. */
export function selfInvoiceHeader(invoice: NormalizedInvoice): XmlElement {
  const { seller, buyer } = invoice
  return el('FatturaElettronicaHeader', [
    el('DatiTrasmissione', [
      el('IdTrasmittente', [el('IdPaese', invoice.transmitter.country), el('IdCodice', invoice.transmitter.code)]),
      el('ProgressivoInvio', invoice.progressive),
      el('FormatoTrasmissione', 'FPR12'),
      el('CodiceDestinatario', SELF_INVOICE_DESTINATION),
    ]),
    el('CedentePrestatore', [el('DatiAnagrafici', [idFiscale(buyer.idFiscaleIva), anagrafica(buyer), el('RegimeFiscale', SELF_INVOICE_SUPPLIER_REGIME)]), sede(buyer.address)]),
    el('CessionarioCommittente', [el('DatiAnagrafici', [idFiscale(seller.idFiscaleIva), optional('CodiceFiscale', seller.fiscalCode), anagrafica(seller)]), sede(seller.address)]),
  ])
}
