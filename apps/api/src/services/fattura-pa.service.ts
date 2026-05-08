/**
 * F.4 — FatturaPA XML readiness for SDI (Sistema di Interscambio).
 *
 * Italian B2B sales must be invoiced electronically via SDI in
 * FatturaPA XML format (schema v1.2.2). Most merchants don't talk
 * to SDI directly — they go through a commercial intermediary
 * (Aruba, Fatture in Cloud, TeamSystem, etc.) that handles SDI
 * authentication + retry + acknowledgement (ricevuta).
 *
 * Scope of this commit:
 *   ✓ Generate FatturaPA XML for a B2B order from F.1+F.2 data
 *   ✓ Endpoint to download the XML for manual upload to whichever
 *     service the operator uses
 *   ✓ Stub the dispatch API (env-flag-gated; commercial-provider
 *     integration is its own engagement)
 *   ✓ Mark FiscalInvoice.sdiStatus when dispatched
 *
 * Out of scope (follow-up):
 *   - Real SDI dispatch to a specific commercial provider
 *   - Inbound ricevuta handling (NS / RC / MC / NE responses)
 *   - Bollo virtuale calculation (€2 stamp duty for invoices
 *     >€77.47 without VAT — needs an additional schema field)
 *   - Multi-currency conversion to EUR (FatturaPA mandates EUR)
 *
 * Validation: the schema is strict about element ordering and
 * required vs optional. This commit produces structurally valid
 * XML for the B2B case (Cessionario with VAT number); B2C
 * "Privato" and PA "B2G" variants are stubs that throw "not
 * implemented" because their required fields differ.
 *
 * IMPORTANT: validate against the real SDI sandbox before
 * production use. The XML structure is rigid; field-level
 * formatting (decimal separator, date format, character set)
 * will reject otherwise-correct invoices. Aruba's sandbox is the
 * usual test bed.
 */

import prisma from '../db.js'
import { assignInvoiceNumber, getInvoiceForOrder } from './fiscal-invoice.service.js'
import { logger } from '../utils/logger.js'

const ENABLED = process.env.NEXUS_ENABLE_SDI_DISPATCH === 'true'

const ISSUER = {
  vatNumber: process.env.NEXUS_ISSUER_VAT ?? 'IT00000000000',
  fiscalCode: process.env.NEXUS_ISSUER_CF ?? '00000000000',
  // Drop the IT prefix from VAT for IdCodice (FatturaPA expects
  // the bare digits when IdPaese is set).
  countryCode: 'IT',
  name: process.env.NEXUS_ISSUER_NAME ?? 'Xavia S.r.l.',
  regime: process.env.NEXUS_ISSUER_REGIME ?? 'RF01', // Ordinario
  address: process.env.NEXUS_ISSUER_ADDRESS ?? 'Via Esempio 1',
  city: process.env.NEXUS_ISSUER_CITY ?? 'Milano',
  postalCode: process.env.NEXUS_ISSUER_POSTAL ?? '20100',
  province: process.env.NEXUS_ISSUER_PROVINCE ?? 'MI',
  country: 'IT',
}

function escapeXml(s: unknown): string {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

function fmtDecimal(n: number): string {
  // FatturaPA uses '.' decimal separator with 2 decimals.
  return n.toFixed(2)
}

function fmtDate(d: Date): string {
  // YYYY-MM-DD
  return d.toISOString().slice(0, 10)
}

function vatBare(vat: string): string {
  // Strip an "IT" prefix if present — IdPaese carries the country
  // code separately.
  return vat.replace(/^IT/i, '')
}

export interface FatturaPaResult {
  xml: string
  filename: string
  invoiceNumber: string
  fiscalYear: number
  sequenceNumber: number
}

/**
 * Generate FatturaPA XML for a B2B order. Lazy-assigns the F.2
 * invoice number when none has been issued yet.
 */
export async function generateFatturaPaXml(orderId: string): Promise<FatturaPaResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    include: { items: true },
  })
  if (!order) throw new Error(`Order ${orderId} not found`)

  if (order.fiscalKind !== 'B2B') {
    throw new Error(
      `Order ${orderId} is not B2B (fiscalKind=${order.fiscalKind ?? 'NULL'}); FatturaPA dispatch is required only for B2B sales. B2C uses corrispettivi (telematic receipts), B2G uses FPA (different schema).`,
    )
  }
  if (!order.partitaIva) {
    throw new Error(
      `Order ${orderId} missing partitaIva — required for B2B FatturaPA. Add it via /customers/:id (codice fiscale alone is not sufficient for B2B).`,
    )
  }

  const inv =
    (await getInvoiceForOrder(orderId)) ?? (await assignInvoiceNumber(orderId))

  // Filename per SDI convention:
  //   {country}{vat}_{progressive}.xml
  // Progressive is alphanumeric, max 5 chars per invoice. We use
  // padded sequence number from the F.2 counter.
  const progressive = inv.sequenceNumber.toString(36).toUpperCase().padStart(5, '0').slice(-5)
  const filename = `${ISSUER.countryCode}${vatBare(ISSUER.vatNumber)}_${progressive}.xml`

  const ship = (order.shippingAddress ?? {}) as any
  const shipLine1 = ship.line1 ?? ship.AddressLine1 ?? ship.address1 ?? ship.street ?? ''
  const shipCity = ship.city ?? ship.City ?? ''
  const shipPostal = ship.postalCode ?? ship.PostalCode ?? ship.postal_code ?? ''
  const shipProvince = ship.state ?? ship.stateOrProvince ?? ship.StateOrRegion ?? 'XX'
  const shipCountry = ship.countryCode ?? ship.CountryCode ?? ship.country_code ?? 'IT'

  const lines = order.items.map((it, i) => {
    const unitPrice = Number(it.price)
    const qty = it.quantity
    const vatRatePct = it.itVatRatePct != null ? Number(it.itVatRatePct) : 22
    // FatturaPA wants pre-VAT prices on lines; recompute net.
    const grossLine = unitPrice * qty
    const netLine = grossLine / (1 + vatRatePct / 100)
    const netUnit = netLine / qty
    return { i: i + 1, sku: it.sku, qty, netUnit, netLine, vatRatePct }
  })

  // VAT subtotals by rate.
  const vatByRate = new Map<number, number>()
  let netTotal = 0
  for (const l of lines) {
    netTotal += l.netLine
    vatByRate.set(l.vatRatePct, (vatByRate.get(l.vatRatePct) ?? 0) + l.netLine)
  }
  const vatTotal = [...vatByRate.entries()].reduce(
    (a, [rate, base]) => a + (base * rate) / 100,
    0,
  )
  const grandTotal = netTotal + vatTotal

  const issuedAt = inv.issuedAt
  const codDest =
    order.codiceDestinatario && order.codiceDestinatario.length === 7
      ? order.codiceDestinatario
      : '0000000' // SDI default for "deliver to PEC fallback"

  // FatturaPA v1.2.2 (FPR12 = privati [B2B]).
  // Element ordering matters; do NOT reorder.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<p:FatturaElettronica versione="FPR12" xmlns:ds="http://www.w3.org/2000/09/xmldsig#" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <FatturaElettronicaHeader>
    <DatiTrasmissione>
      <IdTrasmittente>
        <IdPaese>${escapeXml(ISSUER.countryCode)}</IdPaese>
        <IdCodice>${escapeXml(vatBare(ISSUER.vatNumber))}</IdCodice>
      </IdTrasmittente>
      <ProgressivoInvio>${escapeXml(progressive)}</ProgressivoInvio>
      <FormatoTrasmissione>FPR12</FormatoTrasmissione>
      <CodiceDestinatario>${escapeXml(codDest)}</CodiceDestinatario>
${order.pecEmail ? `      <PECDestinatario>${escapeXml(order.pecEmail)}</PECDestinatario>\n` : ''}    </DatiTrasmissione>
    <CedentePrestatore>
      <DatiAnagrafici>
        <IdFiscaleIVA>
          <IdPaese>${escapeXml(ISSUER.countryCode)}</IdPaese>
          <IdCodice>${escapeXml(vatBare(ISSUER.vatNumber))}</IdCodice>
        </IdFiscaleIVA>
        <CodiceFiscale>${escapeXml(ISSUER.fiscalCode)}</CodiceFiscale>
        <Anagrafica>
          <Denominazione>${escapeXml(ISSUER.name)}</Denominazione>
        </Anagrafica>
        <RegimeFiscale>${escapeXml(ISSUER.regime)}</RegimeFiscale>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${escapeXml(ISSUER.address)}</Indirizzo>
        <CAP>${escapeXml(ISSUER.postalCode)}</CAP>
        <Comune>${escapeXml(ISSUER.city)}</Comune>
        <Provincia>${escapeXml(ISSUER.province)}</Provincia>
        <Nazione>${escapeXml(ISSUER.country)}</Nazione>
      </Sede>
    </CedentePrestatore>
    <CessionarioCommittente>
      <DatiAnagrafici>
        <IdFiscaleIVA>
          <IdPaese>IT</IdPaese>
          <IdCodice>${escapeXml(vatBare(order.partitaIva))}</IdCodice>
        </IdFiscaleIVA>
${order.codiceFiscale ? `        <CodiceFiscale>${escapeXml(order.codiceFiscale)}</CodiceFiscale>\n` : ''}        <Anagrafica>
          <Denominazione>${escapeXml(order.customerName)}</Denominazione>
        </Anagrafica>
      </DatiAnagrafici>
      <Sede>
        <Indirizzo>${escapeXml(shipLine1 || 'N/A')}</Indirizzo>
        <CAP>${escapeXml(shipPostal || '00000')}</CAP>
        <Comune>${escapeXml(shipCity || 'N/A')}</Comune>
        <Provincia>${escapeXml(shipProvince)}</Provincia>
        <Nazione>${escapeXml(shipCountry)}</Nazione>
      </Sede>
    </CessionarioCommittente>
  </FatturaElettronicaHeader>
  <FatturaElettronicaBody>
    <DatiGenerali>
      <DatiGeneraliDocumento>
        <TipoDocumento>TD01</TipoDocumento>
        <Divisa>EUR</Divisa>
        <Data>${escapeXml(fmtDate(issuedAt))}</Data>
        <Numero>${escapeXml(inv.invoiceNumber)}</Numero>
        <ImportoTotaleDocumento>${fmtDecimal(grandTotal)}</ImportoTotaleDocumento>
      </DatiGeneraliDocumento>
    </DatiGenerali>
    <DatiBeniServizi>
${lines
  .map(
    (l) => `      <DettaglioLinee>
        <NumeroLinea>${l.i}</NumeroLinea>
        <Descrizione>${escapeXml(l.sku)}</Descrizione>
        <Quantita>${fmtDecimal(l.qty)}</Quantita>
        <PrezzoUnitario>${fmtDecimal(l.netUnit)}</PrezzoUnitario>
        <PrezzoTotale>${fmtDecimal(l.netLine)}</PrezzoTotale>
        <AliquotaIVA>${fmtDecimal(l.vatRatePct)}</AliquotaIVA>
      </DettaglioLinee>`,
  )
  .join('\n')}
${[...vatByRate.entries()]
  .map(
    ([rate, base]) => `      <DatiRiepilogo>
        <AliquotaIVA>${fmtDecimal(rate)}</AliquotaIVA>
        <ImponibileImporto>${fmtDecimal(base)}</ImponibileImporto>
        <Imposta>${fmtDecimal((base * rate) / 100)}</Imposta>
        <EsigibilitaIVA>I</EsigibilitaIVA>
      </DatiRiepilogo>`,
  )
  .join('\n')}
    </DatiBeniServizi>
  </FatturaElettronicaBody>
</p:FatturaElettronica>
`

  return {
    xml,
    filename,
    invoiceNumber: inv.invoiceNumber,
    fiscalYear: inv.fiscalYear,
    sequenceNumber: inv.sequenceNumber,
  }
}

/**
 * Stub for SDI dispatch. Real implementation goes through a
 * commercial intermediary (Aruba / Fatture in Cloud / TeamSystem)
 * — each has its own auth scheme + acknowledgement loop. Until
 * the operator picks one, this commit ships the XML download
 * (manual upload path) and an env-flag-gated dispatch stub.
 *
 * dryRun (default): marks FiscalInvoice.sdiStatus='PENDING' so
 * the operator surface shows the queued state without actually
 * submitting.
 *
 * Real path (NEXUS_ENABLE_SDI_DISPATCH=true): throws
 * NOT_IMPLEMENTED with a path-forward message — the follow-up
 * commit wires whichever provider Xavia picks.
 */
export async function dispatchToSdi(orderId: string): Promise<{
  status: 'PENDING' | 'SENT' | 'NOT_IMPLEMENTED'
  message: string
  invoiceNumber?: string
}> {
  const result = await generateFatturaPaXml(orderId)

  if (!ENABLED) {
    await prisma.fiscalInvoice.update({
      where: { orderId },
      data: { sdiStatus: 'PENDING' },
    })
    logger.info('fattura-pa: dryRun marked PENDING', {
      orderId,
      invoiceNumber: result.invoiceNumber,
    })
    return {
      status: 'PENDING',
      message:
        'dryRun: invoice queued locally with sdiStatus=PENDING. Set NEXUS_ENABLE_SDI_DISPATCH=true and ship the commercial-provider integration to actually submit to SDI.',
      invoiceNumber: result.invoiceNumber,
    }
  }

  return {
    status: 'NOT_IMPLEMENTED',
    message:
      'Real SDI dispatch not implemented in this commit. Follow-up: pick a commercial provider (Aruba / Fatture in Cloud / TeamSystem), wire their REST API + auth, handle the ricevuta callback (NS / RC / MC / NE).',
  }
}
