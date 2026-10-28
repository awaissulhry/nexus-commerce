import { Decimal } from 'decimal.js'
import { describe, expect, it } from 'vitest'
import { buildFatturaPa } from './build'
import { depositDeductionFrom } from './deposit'
import {
  FAKE_EU_BUSINESS,
  FAKE_IT_BUSINESS,
  SAMPLES,
  TD01_EU_B2B,
  TD01_EU_B2B_SERVICES,
  TD01_EXTRA_EU_EXPORT,
  TD01_IT_B2B,
  TD01_IT_CONSUMER_WITH_DEPOSIT,
  TD02_IT_B2B_DEPOSIT,
  TD02_IT_B2B_DEPOSIT_DOC,
  TD02_IT_CONSUMER_DEPOSIT,
  TD04_IT_B2B_CREDIT_NOTE,
  TD24_IT_B2B_WITH_DEPOSIT,
} from './__fixtures__/samples'
import type { FatturaPaInvoiceInput } from './types'

// ── An independent reader of the XML: the SDI content checks, recomputed from what the file says ─────────────────
// It shares no code with the builder: it reads the elements back and applies the rules of Allegato A (v1.9).

const blocks = (xml: string, tag: string): string[] =>
  [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((match) => match[1]!)
const field = (block: string, tag: string): string | null => new RegExp(`<${tag}>([^<]*)</${tag}>`).exec(block)?.[1] ?? null
const fields = (block: string, tag: string): string[] =>
  [...block.matchAll(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'g'))].map((match) => match[1]!)
const num = (value: string | null): Decimal => new Decimal(value ?? 'NaN')
const half = (value: Decimal) => value.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
const cent = new Decimal('0.01')

/** Returns the SDI error codes the document would get, with a note each. Empty when it passes. */
function sdiContentErrors(xml: string): string[] {
  const errors: string[] = []
  const header = blocks(xml, 'FatturaElettronicaHeader')[0]!
  const general = blocks(xml, 'DatiGeneraliDocumento')[0]!
  const lines = blocks(xml, 'DettaglioLinee')
  const summaries = blocks(xml, 'DatiRiepilogo')
  const buyer = blocks(header, 'CessionarioCommittente')[0]!
  const buyerId = blocks(buyer, 'IdFiscaleIVA')[0] ?? null
  const destination = field(header, 'CodiceDestinatario')!

  if (destination.length !== 7) errors.push('00427 CodiceDestinatario must have 7 characters in FPR12')
  if (destination === 'XXXXXXX' && (buyerId === null || field(buyerId, 'IdPaese') === 'IT')) errors.push('00313')
  if (buyerId === null && field(buyer, 'CodiceFiscale') === null) errors.push('00417')
  if (!/\d/.test(field(general, 'Numero')!)) errors.push('00425')

  const summaryKey = (rate: string, natura: string | null) => `${num(rate).toFixed(2)}|${natura ?? ''}`
  const lineTotals = new Map<string, Decimal>()
  for (const line of lines) {
    const rate = num(field(line, 'AliquotaIVA'))
    const natura = field(line, 'Natura')
    if (rate.isZero() && natura === null) errors.push('00400')
    if (!rate.isZero() && natura !== null) errors.push('00401')
    if (natura !== null && ['N2', 'N3', 'N6'].includes(natura)) errors.push('00445')
    if (!rate.isZero() && rate.lt(1)) errors.push('00424')
    const percent = field(line, 'Percentuale')
    const factor = percent === null ? new Decimal(1) : new Decimal(1).minus(num(percent).dividedBy(100))
    const expected = num(field(line, 'PrezzoUnitario')).times(factor).times(num(field(line, 'Quantita') ?? '1'))
    if (expected.minus(num(field(line, 'PrezzoTotale'))).abs().gt(cent)) errors.push(`00423 line ${field(line, 'NumeroLinea')}`)
    const key = summaryKey(field(line, 'AliquotaIVA')!, natura)
    lineTotals.set(key, (lineTotals.get(key) ?? new Decimal(0)).plus(num(field(line, 'PrezzoTotale'))))
  }

  const summaryKeys = new Set<string>()
  let documentTotal = new Decimal(0)
  for (const summary of summaries) {
    const rate = num(field(summary, 'AliquotaIVA'))
    const natura = field(summary, 'Natura')
    const key = summaryKey(field(summary, 'AliquotaIVA')!, natura)
    summaryKeys.add(key)
    if (rate.isZero() && natura === null) errors.push('00429')
    if (!rate.isZero() && natura !== null) errors.push('00430')
    if (natura !== null && field(summary, 'RiferimentoNormativo') === null) errors.push('art. 21 c.6: wording missing')
    const base = num(field(summary, 'ImponibileImporto'))
    const vat = num(field(summary, 'Imposta'))
    const rounding = num(field(summary, 'Arrotondamento') ?? '0')
    // 00422 allows one euro; the builder is exact, so the test is too.
    if (!base.equals((lineTotals.get(key) ?? new Decimal(0)).plus(rounding))) errors.push(`00422 ${key}`)
    if (vat.minus(half(rate.times(base).dividedBy(100))).abs().gt(cent)) errors.push(`00421 ${key}`)
    documentTotal = documentTotal.plus(base).plus(vat)
  }
  for (const key of lineTotals.keys()) if (!summaryKeys.has(key)) errors.push(`00443/00444 ${key}`)

  if (!documentTotal.equals(num(field(general, 'ImportoTotaleDocumento')))) errors.push('total: summaries do not add up to ImportoTotaleDocumento')
  const payments = blocks(xml, 'DettaglioPagamento')
  if (payments.length > 0) {
    const paid = payments.reduce((total, block) => total.plus(num(field(block, 'ImportoPagamento'))), new Decimal(0))
    if (!paid.equals(num(field(general, 'ImportoTotaleDocumento')))) errors.push('payments do not add up to the total')
  }
  return errors
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────────────────────────────

describe('totals reconcile on every sample (SDI content checks, Allegato A)', () => {
  for (const [name, input] of Object.entries(SAMPLES)) {
    it(`${name}: lines, VAT summary, total and payments agree`, () => {
      const doc = buildFatturaPa(input)
      expect(sdiContentErrors(doc.xml)).toEqual([])
      // The returned numbers are the ones in the file.
      const general = blocks(doc.xml, 'DatiGeneraliDocumento')[0]!
      expect(field(general, 'ImportoTotaleDocumento')).toBe(doc.totals.total.toFixed(2))
      expect(doc.totals.taxable.plus(doc.totals.vat).equals(doc.totals.total)).toBe(true)
    })
  }

  it('the checker is not vacuous: a wrong Imposta and a wrong total are caught', () => {
    const xml = buildFatturaPa(TD01_IT_B2B).xml
    expect(sdiContentErrors(xml.replace('<Imposta>367.38</Imposta>', '<Imposta>367.40</Imposta>'))).toContain('00421 22.00|')
    expect(sdiContentErrors(xml.replace('<ImportoTotaleDocumento>2080.43<', '<ImportoTotaleDocumento>2080.44<')).length).toBeGreaterThan(0)
  })
})

describe('document content', () => {
  it('DPR 633/1972 art. 21 — every invoice carries number, date, both parties, the goods, the taxable amount, rate and VAT', () => {
    for (const input of Object.values(SAMPLES)) {
      const { xml } = buildFatturaPa(input)
      const seller = blocks(xml, 'CedentePrestatore')[0]!
      const buyer = blocks(xml, 'CessionarioCommittente')[0]!
      expect(field(xml, 'Numero')).toBe(input.number)
      expect(field(xml, 'Data')).toBe(input.date)
      expect(field(blocks(seller, 'IdFiscaleIVA')[0]!, 'IdCodice')).toBe('12345670009')
      expect(field(seller, 'Denominazione')).toBeTruthy()
      expect(blocks(seller, 'Sede')).toHaveLength(1)
      expect(field(buyer, 'IdCodice') ?? field(buyer, 'CodiceFiscale')).toBeTruthy()
      expect(field(buyer, 'Denominazione') ?? field(buyer, 'Cognome')).toBeTruthy()
      expect(blocks(buyer, 'Sede')).toHaveLength(1)
      for (const line of blocks(xml, 'DettaglioLinee')) {
        expect(field(line, 'Descrizione')).toBeTruthy()
        expect(field(line, 'Quantita')).toBeTruthy()
        expect(field(line, 'AliquotaIVA')).toBeTruthy()
      }
      for (const summary of blocks(xml, 'DatiRiepilogo')) {
        expect(field(summary, 'ImponibileImporto')).toBeTruthy()
        expect(field(summary, 'Imposta')).toBeTruthy()
      }
    }
  })

  it('DPR 633/1972 art. 21 c.6 — a zero-VAT line carries its Natura code and its summary the law that justifies it', () => {
    for (const input of [TD01_EU_B2B, TD01_EXTRA_EU_EXPORT, TD01_EU_B2B_SERVICES]) {
      const { xml } = buildFatturaPa(input)
      for (const line of blocks(xml, 'DettaglioLinee')) {
        expect(field(line, 'AliquotaIVA')).toBe('0.00')
        expect(field(line, 'Natura')).toMatch(/^N\d(\.\d)?$/)
      }
      const [summary] = blocks(xml, 'DatiRiepilogo')
      expect(field(summary!, 'RiferimentoNormativo')).toMatch(/art\./)
      expect(field(summary!, 'EsigibilitaIVA')).toBeNull()
    }
    expect(field(buildFatturaPa(TD01_EU_B2B).xml, 'RiferimentoNormativo')).toContain('art. 41')
    expect(field(buildFatturaPa(TD01_EXTRA_EU_EXPORT).xml, 'RiferimentoNormativo')).toContain('art. 8')
  })

  it('DPR 633/1972 art. 6 c.4 — the TD02 is the deposit paid, split into taxable and VAT, linked to the order', () => {
    const doc = buildFatturaPa(TD02_IT_B2B_DEPOSIT)
    expect(doc.documentType).toBe('TD02')
    expect(field(doc.xml, 'TipoDocumento')).toBe('TD02')
    expect(doc.totals.total.toFixed(2)).toBe('1830.00')
    expect([doc.totals.taxable.toFixed(2), doc.totals.vat.toFixed(2)]).toEqual(['1500.00', '330.00'])
    expect(field(blocks(doc.xml, 'DatiOrdineAcquisto')[0]!, 'IdDocumento')).toBe('PO-81/2026')
  })

  it('stage 15-invoice — the TD24 from the DDTs deducts the deposit; TD02 + TD24 are the whole order to the cent', () => {
    const doc = buildFatturaPa(TD24_IT_B2B_WITH_DEPOSIT)
    const deduction = doc.lines.find((line) => line.kind === 'DEPOSIT_DEDUCTION')!
    expect(deduction.total.toFixed(2)).toBe('-1500.00')
    expect(deduction.description).toBe('Storno acconto fattura n. 2026/A007 del 20/09/2026')
    const linked = blocks(doc.xml, 'DatiFattureCollegate').map((block) => [field(block, 'IdDocumento'), field(block, 'Data')])
    expect(linked).toEqual([['2026/A007', '2026-09-20']])
    expect(doc.totals.total.toFixed(2)).toBe('4270.00')
    // The order: 5000.00 + 22% = 6100.00, paid as 1830.00 (TD02) + 4270.00 (TD24).
    expect(TD02_IT_B2B_DEPOSIT_DOC.totals.total.plus(doc.totals.total).toFixed(2)).toBe('6100.00')
    expect(TD02_IT_B2B_DEPOSIT_DOC.totals.vat.plus(doc.totals.vat).toFixed(2)).toBe('1100.00')
  })

  it('DPR 633/1972 art. 21 c.4 — the TD24 names each DDT by number and date and the lines it shipped', () => {
    const { xml } = buildFatturaPa(TD24_IT_B2B_WITH_DEPOSIT)
    const ddts = blocks(xml, 'DatiDDT').map((block) => ({
      number: field(block, 'NumeroDDT'),
      date: field(block, 'DataDDT'),
      lines: fields(block, 'RiferimentoNumeroLinea'),
    }))
    expect(ddts).toEqual([
      { number: 'D-0107', date: '2026-10-20', lines: ['1', '2'] },
      { number: 'D-0112', date: '2026-10-27', lines: ['3'] },
    ])
  })

  it('a single DDT that covers the whole invoice carries no line references', () => {
    const { xml } = buildFatturaPa(TD01_EU_B2B)
    const [ddt] = blocks(xml, 'DatiDDT')
    expect(field(ddt!, 'NumeroDDT')).toBe('D-0110')
    expect(fields(ddt!, 'RiferimentoNumeroLinea')).toEqual([])
  })

  it('DPR 633/1972 art. 26 — a credit note (TD04) names the invoice it corrects, with positive amounts', () => {
    const doc = buildFatturaPa(TD04_IT_B2B_CREDIT_NOTE)
    expect(field(doc.xml, 'TipoDocumento')).toBe('TD04')
    const [linked] = blocks(doc.xml, 'DatiFattureCollegate')
    expect([field(linked!, 'IdDocumento'), field(linked!, 'Data')]).toEqual(['2026/0101', '2026-10-05'])
    expect(doc.totals.total.gt(0)).toBe(true)
    expect(doc.totals.total.toFixed(2)).toBe('451.90') // 370.41 + 81.49
  })

  it('D.Lgs. 127/2015 art. 1 c.3-bis — a foreign buyer goes through SDI with XXXXXXX and its own tax id', () => {
    for (const input of [TD01_EU_B2B, TD01_EXTRA_EU_EXPORT]) {
      const { xml } = buildFatturaPa(input)
      expect(field(xml, 'CodiceDestinatario')).toBe('XXXXXXX')
      expect(field(xml, 'PECDestinatario')).toBeNull()
      const buyer = blocks(xml, 'CessionarioCommittente')[0]!
      const id = blocks(buyer, 'IdFiscaleIVA')[0]!
      expect(field(id, 'IdPaese')).not.toBe('IT')
      expect(field(buyer, 'CodiceFiscale')).toBeNull()
      expect(field(buyer, 'CAP')).toBe('00000')
      expect(field(buyer, 'Provincia')).toBeNull()
    }
    const de = blocks(buildFatturaPa(TD01_EU_B2B).xml, 'CessionarioCommittente')[0]!
    expect([field(de, 'IdPaese'), field(de, 'IdCodice'), field(de, 'Comune')]).toEqual(['DE', '999999999', '10115 Berlin'])
    const ch = blocks(buildFatturaPa(TD01_EXTRA_EU_EXPORT).xml, 'CessionarioCommittente')[0]!
    expect(field(ch, 'IdCodice')).toBe('CHE999999999')
  })

  it('an Italian consumer: codice fiscale only, Nome and Cognome, 0000000', () => {
    const { xml } = buildFatturaPa(TD02_IT_CONSUMER_DEPOSIT)
    const buyer = blocks(xml, 'CessionarioCommittente')[0]!
    expect(blocks(buyer, 'IdFiscaleIVA')).toEqual([])
    expect(field(buyer, 'CodiceFiscale')).toBe('TSTPRV80A41Z999I')
    expect([field(buyer, 'Nome'), field(buyer, 'Cognome')]).toEqual(['Viola', 'Provàti'])
    expect(field(xml, 'CodiceDestinatario')).toBe('0000000')
  })

  it('Codice del Consumo artt. 49, 51 — the consumer invoice total is the VAT-inclusive price, the deposit deducted', () => {
    const deposit = buildFatturaPa(TD02_IT_CONSUMER_DEPOSIT)
    expect(deposit.totals.total.toFixed(2)).toBe('500.00')
    const final = buildFatturaPa(TD01_IT_CONSUMER_WITH_DEPOSIT)
    // 1899.00 + 119.99 + 3 x 12.90 = 2057.69 VAT included, less the 500.00 paid.
    expect(final.totals.total.toFixed(2)).toBe('1557.69')
    expect(deposit.totals.total.plus(final.totals.total).toFixed(2)).toBe('2057.69')
    expect(final.priceBasis).toBe('GROSS')
  })

  it('the stamp duty flag: 2.00 virtual on the N2.1 service invoice, none on exports and intra-EU supplies', () => {
    const service = buildFatturaPa(TD01_EU_B2B_SERVICES)
    const [stamp] = blocks(service.xml, 'DatiBollo')
    expect([field(stamp!, 'BolloVirtuale'), field(stamp!, 'ImportoBollo')]).toEqual(['SI', '2.00'])
    expect(service.totals.total.toFixed(2)).toBe('1200.00') // stamp duty is not added to the total
    expect(blocks(buildFatturaPa(TD01_EU_B2B).xml, 'DatiBollo')).toEqual([])
    expect(blocks(buildFatturaPa(TD01_EXTRA_EU_EXPORT).xml, 'DatiBollo')).toEqual([])
    expect(blocks(buildFatturaPa({ ...TD01_EU_B2B_SERVICES, stampDuty: 'NONE' }).xml, 'DatiBollo')).toEqual([])
  })

  it('SDI delivery: by SDI code, else by PEC, else 0000000', () => {
    const withCode = buildFatturaPa(TD01_IT_B2B).xml
    expect([field(withCode, 'CodiceDestinatario'), field(withCode, 'PECDestinatario')]).toEqual(['FAKE001', null])
    const pecOnly: FatturaPaInvoiceInput = {
      ...TD01_IT_B2B,
      buyer: { ...FAKE_IT_BUSINESS, sdiCode: undefined, pec: 'fatture@pec.immaginario.example' },
    }
    const byPec = buildFatturaPa(pecOnly).xml
    expect([field(byPec, 'CodiceDestinatario'), field(byPec, 'PECDestinatario')]).toEqual([
      '0000000',
      'fatture@pec.immaginario.example',
    ])
    const neither = buildFatturaPa({ ...TD01_IT_B2B, buyer: { ...FAKE_IT_BUSINESS, sdiCode: undefined } }).xml
    expect([field(neither, 'CodiceDestinatario'), field(neither, 'PECDestinatario')]).toEqual(['0000000', null])
  })

  it('the file name is IT + the transmitter id + the progressive (SDI naming rule)', () => {
    expect(buildFatturaPa(TD01_IT_B2B).fileName).toBe('IT12345670009_00101.xml')
    const viaProvider = buildFatturaPa({
      ...TD01_IT_B2B,
      transmission: { progressive: 'A1', transmitter: { country: 'IT', code: '76543210009' } },
    })
    expect(viaProvider.fileName).toBe('IT76543210009_A1.xml')
    expect(field(blocks(viaProvider.xml, 'IdTrasmittente')[0]!, 'IdCodice')).toBe('76543210009')
  })
})

describe('deterministic output', () => {
  it('the same input gives the same bytes, whatever the key order of the input objects', () => {
    const reversed = (value: unknown): unknown => {
      if (Array.isArray(value)) return value.map(reversed)
      if (value && typeof value === 'object' && !Decimal.isDecimal(value)) {
        return Object.fromEntries(Object.entries(value).reverse().map(([key, inner]) => [key, reversed(inner)]))
      }
      return value
    }
    for (const input of Object.values(SAMPLES)) {
      const first = buildFatturaPa(input).xml
      expect(buildFatturaPa(input).xml).toBe(first)
      expect(buildFatturaPa(reversed(input) as FatturaPaInvoiceInput).xml).toBe(first)
    }
  })

  it('accepts Decimal instances and decimal strings alike', () => {
    const asDecimals: FatturaPaInvoiceInput = {
      ...TD01_IT_B2B,
      lines: TD01_IT_B2B.lines.map((line) => ({
        ...line,
        quantity: new Decimal(line.quantity),
        unitPrice: new Decimal(line.unitPrice),
        ...(line.discountPercent === undefined ? {} : { discountPercent: new Decimal(line.discountPercent) }),
      })),
    }
    expect(buildFatturaPa(asDecimals).xml).toBe(buildFatturaPa(TD01_IT_B2B).xml)
  })

  it('depositDeductionFrom takes every treatment of a TD02 and refuses other documents', () => {
    const deduction = depositDeductionFrom(TD02_IT_B2B_DEPOSIT_DOC)
    expect([deduction.invoiceNumber, deduction.invoiceDate]).toEqual(['2026/A007', '2026-09-20'])
    expect(
      deduction.amounts.map((amount) => [amount.vat, String(amount.taxable), String(amount.vatAmount)]),
    ).toEqual([[{ kind: 'TAXABLE', rate: 22 }, '1500', '330']])
    expect(() => depositDeductionFrom(buildFatturaPa(TD01_IT_B2B))).toThrow(/TD02/)
  })

  it('escapes XML special characters in text', () => {
    const doc = buildFatturaPa({
      ...TD01_EU_B2B,
      buyer: { ...FAKE_EU_BUSINESS, name: 'Smith & Sons <Riders> GmbH' },
    })
    expect(doc.xml).toContain('<Denominazione>Smith &amp; Sons &lt;Riders&gt; GmbH</Denominazione>')
  })
})
