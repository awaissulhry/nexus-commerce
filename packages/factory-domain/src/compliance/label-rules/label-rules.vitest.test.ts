import { describe, expect, it } from 'vitest'
import { renderLabel, type LabelTemplateFacts, type LabelValues } from '../labels/render'
import { DEFAULT_LAYOUT, printedFields } from '../labels/rules'
import { garmentLabelZpl, qrMagnification, qrModules } from '../labels/zpl'
import { publicDocCodeOf } from '../public-doc/code'
import { gloveLevelOf, hasElectronicAddress, labelQrOf, localOrigin, namesSender, warningsAsked, type ExpectedSender } from './marking'
import { labelMarking, labelRuleChecks, type LabelRuleFacts, type RuleMarket, type RuleStyle, type RuleTemplate } from './rules'

// Every name, number, address and id here is made up.
const STYLE_ID = '01960000-0000-7000-8000-00000000a001'
const WO_ID = '01960000-0000-7000-8000-00000000b001'
const ORIGIN = 'https://factory.example.com'

const style = (extra: Partial<RuleStyle> = {}): RuleStyle => ({
  id: STYLE_ID,
  code: 'JKT-T1',
  name: 'Test jacket',
  productType: 'JACKET',
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'EN 17092-3:2020',
  ppeClass: 'AA',
  brandPartyId: null,
  soldUnderOurName: false,
  companyId: null,
  ...extra,
})

const template = (extra: Partial<RuleTemplate> = {}): RuleTemplate => ({
  id: '01960000-0000-7000-8000-00000000c001',
  code: 'LBL-JKT-T1',
  revision: 1,
  status: 'DRAFT',
  kind: 'PPE_GARMENT',
  languages: ['it', 'en'],
  makerPartyId: null,
  makerName: 'Fabbrica Esempio S.r.l.',
  makerAddress: 'Via Prova 1, 00000 Paese',
  gpsrContact: null,
  qrTarget: 'NONE',
  notifiedBodyNumber: null,
  ceHeight: 600,
  printed: ['ceMark', 'pictogram', 'standard', 'model', 'size', 'bodyMeasures', 'batchOrSerial', 'maker'],
  ...extra,
})

const market = (extra: Partial<RuleMarket> = {}): RuleMarket => ({ code: 'IT', name: 'Italy', switchedOn: true, labelLanguages: ['it'], markings: ['CE'], gpsrContactNeeded: false, ...extra })
const company: ExpectedSender = { who: 'COMPANY', name: 'Fabbrica Esempio S.r.l.', address: 'Via Prova 1, 00000 Paese', contact: 'info@example.com', operatorId: 'op-1' }

const facts = (extra: Partial<LabelRuleFacts> = {}): LabelRuleFacts => ({
  template: template(),
  style: style(),
  certificate: { id: 'cert-1', number: 'CERT-T1', standard: 'EN 17092-3:2020', ppeClass: 'AA', notifiedBodyNumber: '0000', levels: null },
  bodies: [],
  protectorPockets: [],
  phraseKeys: new Set(),
  texts: new Map(),
  qr: { qr: null, origin: ORIGIN, live: null },
  ppeTextsApproved: false,
  ...extra,
})

const byKey = (checks: ReturnType<typeof labelRuleChecks>) => Object.fromEntries(checks.map((check) => [check.key, check]))

describe('CE marking (PRD-333)', () => {
  it('passes a category II label with no number after the CE mark, and refuses one with a number', () => {
    const ok = byKey(labelRuleChecks(facts(), market(), company)).ceMarking!
    expect(ok.outcome).toBe('PASS')
    expect(ok.words).toContain('no notified-body number after it')
    expect(ok.gateKey).toBe('label.ceMarking')
    const wrong = byKey(labelRuleChecks(facts({ template: template({ notifiedBodyNumber: '0000' }) }), market(), company)).ceMarking!
    expect(wrong).toMatchObject({ outcome: 'FAIL', blocks: true })
    expect(wrong.findings[0]!.path).toBe('layout/notifiedBodyNumber')
  })

  it('asks a category III label for a number of the directory, and says an archived body', () => {
    const cat3 = style({ ppeCategory: 'CATEGORY_III' })
    expect(byKey(labelRuleChecks(facts({ style: cat3 }), null, company)).ceMarking!.outcome).toBe('FAIL')
    const known = facts({ style: cat3, template: template({ notifiedBodyNumber: '0000' }), bodies: [{ number: '0000', name: 'Organismo Esempio', status: 'ACTIVE' }] })
    expect(byKey(labelRuleChecks(known, null, company)).ceMarking!).toMatchObject({ outcome: 'PASS' })
    const unknown = facts({ style: cat3, template: template({ notifiedBodyNumber: '0001' }) })
    expect(byKey(labelRuleChecks(unknown, null, company)).ceMarking!).toMatchObject({ outcome: 'WARN', blocks: false })
    const archived = facts({ style: cat3, template: template({ notifiedBodyNumber: '0000' }), bodies: [{ number: '0000', name: 'Old', status: 'ARCHIVED' }] })
    expect(byKey(labelRuleChecks(archived, null, company)).ceMarking!.outcome).toBe('FAIL')
  })

  it("refuses a market's marking the label does not print, and leaves a fibre and care label out", () => {
    const uk = byKey(labelRuleChecks(facts(), market({ code: 'UK', markings: ['UKCA'] }), company)).ceMarking!
    expect(uk.outcome).toBe('FAIL')
    expect(uk.findings[0]!.path).toBe('markets/UK/markings/UKCA')
    expect(byKey(labelRuleChecks(facts({ template: template({ kind: 'FIBRE_CARE' }) }), market(), company)).ceMarking!.outcome).toBe('NOT_APPLICABLE')
  })
})

describe('class warnings (PRD-335)', () => {
  it('asks class B and C their warning, and a removable protector its own', () => {
    expect(warningsAsked({ standardCode: 'EN 17092', ppeClass: 'B', protectorPockets: ['ELBOW'] })).toEqual(['CLASS_B'])
    expect(warningsAsked({ standardCode: 'EN 17092', ppeClass: 'C', protectorPockets: ['BACK'] })).toEqual(['CLASS_C', 'REMOVABLE_PROTECTORS'])
    expect(warningsAsked({ standardCode: 'EN 17092', ppeClass: 'AA', protectorPockets: [] })).toEqual([])
    expect(warningsAsked({ standardCode: 'EN 13594', ppeClass: '2KP', protectorPockets: ['ELBOW'] })).toEqual([])
  })

  it('fails on a missing phrase or language, then waits for the PPE consultant (GATE-PPE-TEXTS)', () => {
    const classB = { style: style({ ppeStandard: 'EN 17092-5:2020', ppeClass: 'B' }), certificate: null }
    const missing = byKey(labelRuleChecks(facts(classB), market({ code: 'DE', labelLanguages: ['de'] }), company)).classWarnings!
    expect(missing.outcome).toBe('FAIL')
    expect(missing.findings[0]!.path).toBe('phrases/warning.class-b')
    const texts = new Map([['warning.class-b', new Map([['it', 'Avvertenza B (esempio)'], ['en', 'Warning B (example)'], ['de', null]])]])
    const noGerman = byKey(labelRuleChecks(facts({ ...classB, phraseKeys: new Set(['warning.class-b']), texts }), market({ code: 'DE', labelLanguages: ['de'] }), company)).classWarnings!
    expect(noGerman.findings.map((entry) => entry.path)).toEqual(['phrases/warning.class-b/de'])
    const ready = byKey(labelRuleChecks(facts({ ...classB, phraseKeys: new Set(['warning.class-b']), texts }), market(), company)).classWarnings!
    expect(ready).toMatchObject({ outcome: 'WAITING', blocks: true })
    expect(ready.words).toContain('GATE-PPE-TEXTS')
    expect(byKey(labelRuleChecks(facts({ ...classB, phraseKeys: new Set(['warning.class-b']), texts, ppeTextsApproved: true }), market(), company)).classWarnings!.outcome).toBe('PASS')
    const marking = labelMarking(facts({ ...classB, phraseKeys: new Set(['warning.class-b']), texts }), market(), company)
    expect(marking.warnings).toEqual([{ reason: 'CLASS_B', key: 'warning.class-b', texts: [{ language: 'it', text: 'Avvertenza B (esempio)' }, { language: 'en', text: 'Warning B (example)' }], draft: true }])
  })
})

describe('glove marking (PRD-336)', () => {
  const glove = style({ productType: 'GLOVES', ppeStandard: 'EN 13594:2015', ppeClass: '2KP' })
  const certificate = { id: 'cert-g', number: 'CERT-G1', standard: 'EN 13594:2015', ppeClass: '2KP', notifiedBodyNumber: '0000', levels: { level: '2', knuckle: 'KP' } }

  it('reads the levels and checks them against the certificate', () => {
    expect(gloveLevelOf('1KP')).toEqual({ level: '1', knuckle: true })
    expect(gloveLevelOf('AA')).toBeNull()
    const ok = byKey(labelRuleChecks(facts({ style: glove, certificate, template: template({ kind: 'GLOVE_MARKING' }) }), null, company)).gloveMarking!
    expect(ok).toMatchObject({ outcome: 'PASS', gateKey: 'label.gloveMarking' })
    expect(ok.words).toContain('2 KP')
    const other = byKey(labelRuleChecks(facts({ style: glove, certificate: { ...certificate, levels: { level: '1' } }, template: template({ kind: 'GLOVE_MARKING' }) }), null, company)).gloveMarking!
    expect(other.outcome).toBe('FAIL')
    expect(other.words).toContain('grants level 1')
  })

  it('warns a glove on a garment label and refuses a glove marking on a jacket', () => {
    expect(byKey(labelRuleChecks(facts({ style: glove, certificate }), null, company)).gloveMarking!.outcome).toBe('WARN')
    expect(byKey(labelRuleChecks(facts({ template: template({ kind: 'GLOVE_MARKING' }) }), null, company)).gloveMarking!.outcome).toBe('FAIL')
    expect(byKey(labelRuleChecks(facts(), null, company)).gloveMarking!.outcome).toBe('NOT_APPLICABLE')
  })
})

describe('GPSR identifier and contact (PRD-346)', () => {
  const consumer = style({ ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null })

  it('leaves PPE out (Owner Q37) unless the market asks, and asks a consumer line for its contact', () => {
    expect(byKey(labelRuleChecks(facts(), market(), company)).gpsr!.outcome).toBe('NOT_APPLICABLE')
    expect(byKey(labelRuleChecks(facts(), market({ gpsrContactNeeded: true }), company)).gpsr!.outcome).toBe('FAIL')
    const none = byKey(labelRuleChecks(facts({ style: consumer, certificate: null }), market(), company)).gpsr!
    expect(none).toMatchObject({ outcome: 'FAIL', gateKey: 'gpsr.contact' })
    const noMail = byKey(labelRuleChecks(facts({ style: consumer, certificate: null, template: template({ gpsrContact: 'Fabbrica Esempio S.r.l.\nVia Prova 1, 00000 Paese' }) }), market(), company)).gpsr!
    expect(noMail.findings.map((entry) => entry.message)).toEqual([expect.stringContaining('no electronic address')])
    const ok = byKey(labelRuleChecks(facts({ style: consumer, certificate: null, template: template({ gpsrContact: 'Fabbrica Esempio S.r.l.\nVia Prova 1, 00000 Paese\ninfo@example.com' }) }), market(), company)).gpsr!
    expect(ok.outcome).toBe('PASS')
  })

  it('names the brand for a private-label style sold under its own name (Owner 11-09)', () => {
    const brand: ExpectedSender = { who: 'BRAND', name: 'Marchio Esempio S.p.A.', address: 'Via Marca 2, 00000 Citta', contact: 'brand@example.com', operatorId: 'op-2' }
    const branded = style({ ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null, brandPartyId: 'party-brand' })
    const check = byKey(labelRuleChecks(facts({ style: branded, certificate: null, template: template({ gpsrContact: 'Fabbrica Esempio S.r.l.\nVia Prova 1, 00000 Paese\ninfo@example.com' }) }), market(), brand)).gpsr!
    expect(check.outcome).toBe('WARN')
    expect(check.words).toContain('Marchio Esempio S.p.A.')
    expect(namesSender('MARCHIO ESEMPIO SPA, Via Marca 2', 'Marchio Esempio S.p.A.')).toBe(true)
    expect(hasElectronicAddress('www.example.com')).toBe(true)
  })
})

describe('the QR to the public DoC (PRD-349)', () => {
  it('gives the batch address from the work order and the style address from the style', () => {
    const batch = labelQrOf('BATCH_DOC', { id: STYLE_ID, code: 'JKT-T1' }, { id: WO_ID, reference: 'WO-0001' }, ORIGIN)!
    expect(batch.address).toBe(`${ORIGIN}/doc/${publicDocCodeOf(WO_ID)}`)
    expect(batch.printed).toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/)
    expect(labelQrOf('BATCH_DOC', { id: STYLE_ID, code: 'JKT-T1' }, null, ORIGIN)).toMatchObject({ kind: 'BATCH', address: null })
    expect(labelQrOf('STYLE_DOC', { id: STYLE_ID, code: 'JKT-T1' }, null, ORIGIN)!.address).toBe(`${ORIGIN}/doc/${publicDocCodeOf(STYLE_ID)}`)
    expect(labelQrOf('NONE', { id: STYLE_ID, code: 'JKT-T1' }, null, ORIGIN)).toBeNull()
    expect(localOrigin('http://localhost:3200')).toBe(true)
    expect(localOrigin(ORIGIN)).toBe(false)
  })

  it('passes a batch QR, warns a style QR on a garment and a local origin, refuses a QR on a product that is not PPE', () => {
    const qr = labelQrOf('BATCH_DOC', { id: STYLE_ID, code: 'JKT-T1' }, { id: WO_ID, reference: 'WO-0001' }, ORIGIN)
    const printed = [...template().printed, 'qr' as const]
    expect(byKey(labelRuleChecks(facts({ template: template({ qrTarget: 'BATCH_DOC', printed }), qr: { qr, origin: ORIGIN, live: true } }), null, company)).qrCode!.outcome).toBe('PASS')
    const local = byKey(labelRuleChecks(facts({ template: template({ qrTarget: 'STYLE_DOC', printed }), qr: { qr, origin: 'http://localhost:3200', live: true } }), null, company)).qrCode!
    expect(local.findings.map((entry) => entry.path)).toEqual(['qrTarget', 'qr/origin'])
    const consumer = byKey(labelRuleChecks(facts({ style: style({ ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null }), template: template({ qrTarget: 'BATCH_DOC' }) }), null, company)).qrCode!
    expect(consumer.outcome).toBe('FAIL')
    expect(byKey(labelRuleChecks(facts(), null, company)).qrCode!.outcome).toBe('NOT_APPLICABLE')
  })

  it('prints the QR and the GPSR contact on the garment label, in the ZPL too', () => {
    const labelTemplate: LabelTemplateFacts = {
      id: 'tpl',
      code: 'LBL-JKT-T1',
      revision: 1,
      name: 'Test label',
      status: 'ACTIVE',
      styleId: STYLE_ID,
      companyId: null,
      storedProblems: [],
      languages: ['it', 'en'],
      makerPartyId: null,
      makerName: 'Fabbrica Esempio S.r.l.',
      makerAddress: 'Via Prova 1, 00000 Paese',
      importerName: null,
      importerAddress: null,
      composition: [],
      animalOriginPhrase: false,
      care: [],
      layout: DEFAULT_LAYOUT,
      widthMm: '50.00',
      heightMm: '150.00',
      kind: 'PPE_GARMENT',
      gpsrContact: 'Fabbrica Esempio S.r.l.\ninfo@example.com',
      qrTarget: 'BATCH_DOC',
    }
    expect(printedFields(labelTemplate, true)).toEqual(expect.arrayContaining(['qr', 'gpsrContact']))
    expect(printedFields({ ...labelTemplate, kind: 'FIBRE_CARE' }, true)).not.toContain('ceMark')
    const qr = labelQrOf('BATCH_DOC', { id: STYLE_ID, code: 'JKT-T1' }, { id: WO_ID, reference: 'WO-0001' }, ORIGIN)
    const values: LabelValues = {
      style: { ...style(), name: 'Test jacket' },
      colourway: { id: 'cw', code: 'BLK', name: 'Black' },
      size: { code: '52', label: '52', scaleId: 'sc', scaleCode: 'EU', bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' } } },
      certificate: null,
      identification: { kind: 'BATCH', value: 'BT-0001', recordType: 'WorkOrder', recordId: WO_ID, reference: 'WO-0001' },
      manufactured: { date: '2026-11-10', recordType: 'WorkOrder', recordId: WO_ID, reference: 'WO-0001' },
      date: '2026-11-10',
      sample: false,
      marketLanguages: [],
      qr,
    }
    const label = renderLabel(labelTemplate, values)
    const block = label.blocks.find((entry) => entry.field === 'qr')!
    expect(block).toMatchObject({ value: qr!.address, graphic: null, placeholder: false, lines: [{ text: qr!.printed, language: null }] })
    expect(label.blocks.find((entry) => entry.field === 'gpsrContact')!.lines.map((line) => line.text)).toEqual(['Fabbrica Esempio S.r.l.', 'info@example.com'])
    const zpl = garmentLabelZpl(label, 203)
    expect(zpl).toContain(`^BQN,2,${qrMagnification(qr!.address!, Math.round((1400 * 203) / 2540))}^FH^FDMA,${qr!.address}^FS`)
    expect(qrModules(qr!.address!)).toBe(29)
    // A garment label with a batch QR and no address is not printed.
    expect(renderLabel(labelTemplate, { ...values, qr: null }).problems.map((issue) => issue.path)).toContain('qr')
  })
})
