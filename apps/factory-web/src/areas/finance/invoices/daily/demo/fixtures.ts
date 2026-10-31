import type { Invoice, InvoiceLine, Queue } from '../../../_shared/api'
import { DDT, invoice, PARTIES, QUEUE, ROLES, TD01_ID, TD01_LINES, TODAY, type Role } from '../../../_demo/fixtures'
import type { Deferred, ReturnCredit } from '../api'

/**
 * Made-up data for B-W2a-80's design cases (the invoice screens every day): an invented customer invoiced once a month
 * ("Squadra Fittizia S.r.l.", two October DDTs → one deferred invoice by 15 November) and one per shipment ("Moto Demo
 * S.r.l.", DDT 144/2026 in its 12 days), freight decided on one shipment and not yet on another, a draft with freight and
 * packaging charge lines, a return "RMA-2026-0007" crediting 2 jackets of FT-2026-00031, and a FatturaPA file of the demo
 * company. Nothing here is a real company, person, invoice or number. Design-only: it exports no `designScreen`.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const MONTHLY = PARTIES[2]

/** The extra permissions B-W2a-80's screens read, by demo role (as the role templates give them). */
export const W2A_EXTRA: Record<Role, readonly string[]> = {
  owner: ['payments.refund', 'paymentterms.view', 'paymentterms.manage', 'costing.view', 'costing.method.manage'],
  finance: ['payments.refund', 'paymentterms.view', 'paymentterms.manage', 'costing.view', 'costing.method.manage'],
  sales: ['paymentterms.view', 'costing.view'],
}
export const permissionsOf = (role: Role): readonly string[] => [...ROLES[role], ...W2A_EXTRA[role]]

/** The queue with B-W2a-54's facts: the customer's preset, each DDT's deadline by it, the shipment's freight. */
export const QUEUE_W2A: Queue = {
  ...QUEUE,
  customers: QUEUE.customers.map((customer, index) =>
    index === 0
      ? { ...customer, invoiceTiming: 'PER_SHIPMENT' as const, preset: 'TD01' as const, ddts: customer.ddts.map((ddt) => ({ ...ddt, deadline: ddt.immediate, freight: { amount: 1200, currency: 'EUR', billed: false } })) }
      : {
          ...customer,
          invoiceTiming: 'MONTHLY' as const,
          preset: 'TD24' as const,
          ddts: customer.ddts.map((ddt, at) => ({ ...ddt, deadline: { docType: 'TD24' as const, dueBy: '2026-11-15', daysLeft: 17, state: 'OPEN' as const }, freight: { amount: at === 0 ? 1850 : null, currency: 'EUR', billed: false } })),
        },
  ),
}

const monthlyDdts = QUEUE.customers[1]!.ddts

export const DEFERRED: Deferred = {
  asOf: TODAY,
  counts: { groups: 1, open: 1, dueSoon: 0, late: 0 },
  groups: [
    {
      companyId: QUEUE.customers[1]!.companyId,
      partyId: MONTHLY.id,
      code: MONTHLY.code,
      legalName: MONTHLY.name,
      invoiceTiming: 'MONTHLY',
      month: '2026-10',
      ddts: monthlyDdts.map((ddt) => ({ ddtId: ddt.ddtId, number: ddt.number, date: ddt.date, shipmentNumber: ddt.shipmentNumber })),
      valueAmount: 810000,
      freightAmount: 1850,
      drafts: [],
      deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17, state: 'OPEN' },
    },
  ],
}

/** The same group two days before the 15th, and one late from September. */
export const DEFERRED_LATE: Deferred = {
  ...DEFERRED,
  counts: { groups: 2, open: 0, dueSoon: 1, late: 1 },
  groups: [
    { ...DEFERRED.groups[0]!, deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 2, state: 'DUE_SOON' } },
    { ...DEFERRED.groups[0]!, month: '2026-09', ddts: [{ ddtId: uid('7171', 120), number: '120/2026', date: '2026-09-22', shipmentNumber: 'SH-2026-0001' }], valueAmount: 225000, freightAmount: 0, deadline: { docType: 'TD24', dueBy: '2026-10-15', daysLeft: -14, state: 'LATE' } },
  ],
}

const charge = (n: number, kind: InvoiceLine['chargeKind'], description: string, unitPrice: string, netAmount: number): InvoiceLine => ({
  ...TD01_LINES[0]!,
  id: uid('8282', 40 + n),
  seq: 3 + n,
  kind: 'CHARGE',
  chargeKind: kind,
  description,
  itemCode: null,
  quantity: '1.0000',
  uom: null,
  unitPrice,
  netAmount,
  salesOrderLineId: null,
  size: null,
  ddtId: DDT.id,
})

/** A draft TD01 of DDT 144/2026 with its freight (12.00) and a packaging charge (8.00): 6,260.00 net before the deposit. */
export const DRAFT_WITH_CHARGES: Invoice = invoice('DRAFT', {
  lines: [...TD01_LINES.slice(0, 2), charge(1, 'FREIGHT', 'Spese di trasporto DDT n. 144/2026 del 27/10/2026', '12.000000', 1200), charge(2, 'PACKAGING', 'Spese di imballaggio', '8.000000', 800), TD01_LINES[2]!],
  netTotal: 438800,
  vatTotal: 96536,
  grossTotal: 535336,
  deadline: { docType: 'TD01', dueBy: '2026-11-08', daysLeft: 10, state: 'OPEN' },
  paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 535336, dueDate: '2026-11-30' }], source: { kind: 'TERMS', termsId: uid('6161', 1), code: 'BB30FM' } },
})

/** A draft TD24 whose deadline is two days away. */
export const DRAFT_DUE_SOON: Invoice = invoice('DRAFT', { docType: 'TD24', deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 2, state: 'DUE_SOON' } })

/** FT-2026-00031 paid in full, then credited 61.00: 61.00 to refund or carry. */
export const OVERPAID: Invoice = invoice('DELIVERED', { paidAmount: 532896, creditedAmount: 6100, openAmount: 0, refundDueAmount: 6100 })

/** The credit note of it, issued and delivered: refunded from Payments. */
export const TD04_ISSUED: Invoice = {
  ...invoice('DELIVERED'),
  id: uid('8181', 33),
  docType: 'TD04',
  number: 'FT-2026-00033',
  creditOfId: TD01_ID,
  netTotal: 5000,
  vatTotal: 1100,
  grossTotal: 6100,
  openAmount: 0,
  vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 5000, vat: 1100, rounding: 0 }],
  paymentTerms: null,
  lines: [{ ...TD01_LINES[0]!, id: uid('8282', 50), description: 'Abbuono su fattura FT-2026-00031', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '50.000000', netAmount: 5000, salesOrderLineId: null, size: null, ddtId: null }],
}

export const RETURN_ID = uid('9292', 7)

export const RETURN_CREDIT: ReturnCredit = {
  return: { id: RETURN_ID, number: 'RMA-2026-0007', status: 'DECIDED', companyId: QUEUE.customers[0]!.companyId, partyId: PARTIES[0].id },
  creditDecidedAmount: 90000,
  creditNotedAmount: 0,
  creditNotes: [],
  toCredit: [
    {
      creditOfId: TD01_ID,
      invoiceNumber: 'FT-2026-00031',
      currency: 'EUR',
      netTotal: 90000,
      lines: [
        { returnLineId: uid('9393', 1), seq: 1, pieces: 1, description: 'Reso RMA-2026-0007 riga 1: DEMO-JKT-01 Giacca Demo - Nero, taglia 50', netAmount: 45000 },
        { returnLineId: uid('9393', 2), seq: 2, pieces: 1, description: 'Reso RMA-2026-0007 riga 2: DEMO-JKT-01 Giacca Demo - Nero, taglia 52', netAmount: 45000 },
      ],
    },
  ],
  notCredited: [{ lineId: uid('9393', 3), seq: 3, code: 'NOT_RECEIVED' }],
}

/** The same return once its credit note was drafted: nothing left to credit. */
export const RETURN_CREDITED: ReturnCredit = {
  ...RETURN_CREDIT,
  creditNotedAmount: 90000,
  toCredit: [],
  creditNotes: [{ id: uid('8181', 35), number: null, status: 'DRAFT', issueDate: null, currency: 'EUR', netTotal: 90000, grossTotal: 109800, creditOfId: TD01_ID, creditOfNumber: 'FT-2026-00031', lines: [{ returnLineId: uid('9393', 1), seq: 1, quantity: '1', netAmount: 45000 }], refunds: [] }],
  notCredited: [
    { lineId: uid('9393', 1), seq: 1, code: 'ON_CREDIT_NOTE' },
    { lineId: uid('9393', 3), seq: 3, code: 'NOT_RECEIVED' },
  ],
}

/** A FatturaPA file of the demo company (made up; the shape SDI receives, shortened). */
export const SAMPLE_XML = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" versione="FPR12">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdTrasmittente>
      <ProgressivoInvio>00031</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>ABC1234</CodiceDestinatario>
    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>01234567890</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Officina Demo S.r.l.</Denominazione></Anagrafica>
        <RegimeFiscale>RF01</RegimeFiscale>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Esempio 1</Indirizzo><CAP>00100</CAP><Comune>Roma</Comune><Provincia>RM</Provincia><Nazione>IT</Nazione></Sede>
      <IscrizioneREA><Ufficio>RM</Ufficio><NumeroREA>000001</NumeroREA><StatoLiquidazione>LN</StatoLiquidazione></IscrizioneREA>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>09876543210</IdCodice></IdFiscaleIVA>
        <Anagrafica><Denominazione>Moto Demo S.r.l.</Denominazione></Anagrafica>
      </DatiAnagrafici>
      <Sede><Indirizzo>Via Prova 9</Indirizzo><CAP>20100</CAP><Comune>Milano</Comune><Provincia>MI</Provincia><Nazione>IT</Nazione></Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>2026-10-29</Data>
        <Numero>FT-2026-00031</Numero>
        <ImportoTotaleDocumento>5328.96</ImportoTotaleDocumento>
        <Causale>Fattura DDT n. 144/2026 del 27/10/2026 &amp; acconto dedotto</Causale>
      </DatiGeneraliDocumento>
      <DatiOrdineAcquisto><IdDocumento>SO-2026-0088</IdDocumento></DatiOrdineAcquisto>
      <DatiDDT><NumeroDDT>144/2026</NumeroDDT><DataDDT>2026-10-27</DataDDT><RiferimentoNumeroLinea>1</RiferimentoNumeroLinea><RiferimentoNumeroLinea>2</RiferimentoNumeroLinea></DatiDDT>
    </DatiGenerali>
    <DatiBeniServizi>
      <DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>DEMO-JKT-01 Giacca Demo - Nero, taglia 50</Descrizione><Quantita>8.00</Quantita><UnitaMisura>PZ</UnitaMisura><PrezzoUnitario>450.00</PrezzoUnitario><PrezzoTotale>3600.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DettaglioLinee><NumeroLinea>2</NumeroLinea><Descrizione>DEMO-JKT-01 Giacca Demo - Nero, taglia 52</Descrizione><Quantita>6.00</Quantita><UnitaMisura>PZ</UnitaMisura><PrezzoUnitario>440.00</PrezzoUnitario><PrezzoTotale>2640.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DettaglioLinee><NumeroLinea>3</NumeroLinea><Descrizione>Detrazione acconto fattura n. FT-2026-00028 del 15/10/2026</Descrizione><Quantita>1.00</Quantita><PrezzoUnitario>-1872.00</PrezzoUnitario><PrezzoTotale>-1872.00</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee>
      <DatiRiepilogo><AliquotaIVA>22.00</AliquotaIVA><ImponibileImporto>4368.00</ImponibileImporto><Imposta>960.96</Imposta><EsigibilitaIVA>I</EsigibilitaIVA></DatiRiepilogo>
    </DatiBeniServizi>
    <DatiPagamento>
      <CondizioniPagamento>TP02</CondizioniPagamento>
      <DettaglioPagamento><ModalitaPagamento>MP05</ModalitaPagamento><DataScadenzaPagamento>2026-11-30</DataScadenzaPagamento><ImportoPagamento>5328.96</ImportoPagamento><IBAN>IT60X0542811101000000123456</IBAN></DettaglioPagamento>
    </DatiPagamento>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`
