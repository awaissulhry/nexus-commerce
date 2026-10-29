import { describe, expect, it } from 'vitest'
import { canTransition } from '../../state/machine'
import { activationProblems, bodyMeasuresText, manufactureText, renderLabel, wrapText, type CellCertificate, type LabelTemplateFacts, type LabelValues } from './render'
import { contentProblems, defaultLabelCode, labelTemplateMachine, layoutOf, LABEL_CODE, printedFields, styleProblems, type LabelStyle } from './rules'
import { garmentLabelZpl } from './zpl'

/** Made-up data only: style, brand, certificate and notified body numbers are invented. */
const STYLE: LabelStyle = {
  id: '00000000-0000-7000-8000-000000000001',
  code: 'TEST-JKT-01',
  name: 'Test leather jacket',
  productType: 'JACKET',
  ppeCategory: 'CATEGORY_II',
  ppeStandard: 'EN 17092-3:2020',
  ppeClass: 'AA',
  brandPartyId: '00000000-0000-7000-8000-0000000000b1',
  companyId: null,
}

/** As the seed's label: { fields } only in the layout, care without texts. */
const TEMPLATE: LabelTemplateFacts = {
  id: '00000000-0000-7000-8000-0000000000a1',
  code: 'LBL-TEST-JKT-01',
  revision: 1,
  name: 'Test jacket label',
  status: 'DRAFT',
  styleId: STYLE.id,
  companyId: null,
  storedProblems: [],
  languages: ['it', 'en'],
  makerPartyId: STYLE.brandPartyId,
  makerName: 'Marchio Inventato S.r.l.',
  makerAddress: 'Via Esempio 10, 00000 Testville (MI), Italy',
  importerName: null,
  importerAddress: null,
  composition: [{ part: 'lining', fibres: [{ fibre: 'polyester', percent: '100' }] }],
  animalOriginPhrase: true,
  care: [{ symbol: 'wash-not' }, { symbol: 'bleach-not' }, { symbol: 'iron-not' }, { symbol: 'dryclean-professional' }],
  layout: layoutOf({ fields: ['ceMark', 'maker', 'model', 'batchOrSerial', 'size', 'bodyMeasures', 'pictogram', 'class', 'standard', 'composition', 'care'] }).layout,
  widthMm: '50.00',
  heightMm: '80.00',
}

const COVERED: CellCertificate = {
  outcome: 'covered',
  certificate: { id: '00000000-0000-7000-8000-0000000000c1', number: 'TEST-CERT-0001', standard: 'EN 17092-3:2020', ppeClass: 'AA', validTo: '2031-01-14' },
  reasons: [],
  date: '2026-10-29',
}

const VALUES: LabelValues = {
  style: STYLE,
  colourway: { id: '00000000-0000-7000-8000-0000000000d1', code: 'BLK', name: 'Black' },
  size: {
    code: '52',
    label: null,
    scaleId: '00000000-0000-7000-8000-0000000000e1',
    scaleCode: 'TEST-EU-JKT',
    bodyMeasures: { chest: { min: '100', max: '104', unit: 'cm' }, height: { min: '176', max: '182', unit: 'cm' } },
  },
  certificate: COVERED,
  identification: { kind: 'BATCH', value: null, recordType: null, recordId: null, reference: null },
  manufactured: null,
  date: '2026-10-29',
  sample: true,
  marketLanguages: [],
}

const paths = (issues: readonly { path: string }[]) => issues.map((issue) => issue.path)
const block = (label: ReturnType<typeof renderLabel>, field: string) => label.blocks.find((entry) => entry.field === field)

describe('the label template (PRD-331)', () => {
  it('reads the seed-shaped layout with its defaults and passes every rule', () => {
    expect(TEMPLATE.layout).toMatchObject({ preset: 'STANDARD', notifiedBodyNumber: null, manufactureDate: 'QUARTER', texts: { animalOrigin: {} } })
    expect(contentProblems(TEMPLATE)).toEqual([])
    expect(styleProblems(TEMPLATE, STYLE)).toEqual([])
    expect(activationProblems(TEMPLATE, STYLE, '2026-10-29')).toEqual([])
    expect(layoutOf({ fields: ['ceMark'], colour: 'red' }).problems).toEqual([{ path: 'layout', message: expect.stringContaining('colour') }])
  })

  it('codes: the default is LBL-<style>, capitals, at most 32 characters', () => {
    expect(defaultLabelCode('SEED-JKT-01')).toBe('LBL-SEED-JKT-01')
    expect(LABEL_CODE.test('LBL-JK100')).toBe(true)
    expect(LABEL_CODE.test('lbl-jk100')).toBe(false)
  })

  it('refuses each typed mistake with its own path and words', () => {
    const problems = contentProblems({
      ...TEMPLATE,
      name: ' ',
      languages: ['it', 'xx', 'it', 'nl'],
      makerAddress: 'Somewhere in Italy',
      importerName: 'Importer only',
      composition: [
        { part: 'shell', fibres: [{ fibre: 'polyamide', percent: '60' }, { fibre: 'polyester', percent: '30' }] },
        { part: 'lining', fibres: [{ fibre: 'polyester', percent: '50' }, { fibre: 'Polyester', percent: '50' }, { fibre: 'cotton', percent: '0' }] },
      ],
      care: [{ symbol: 'wash-30' }, { symbol: 'wash-not' }, { symbol: 'dance' }, { symbol: 'iron-110', text: { it: 'Stirare a 110 °C', de: 'Bügeln' } }],
      layout: { ...TEMPLATE.layout, fields: ['ceMark', 'ceMark'], notifiedBodyNumber: '12a', texts: { animalOrigin: { fr: 'Contient…' } } },
      widthMm: '10',
      heightMm: '80.123',
    })
    expect(paths(problems)).toEqual([
      'name',
      'languages/1',
      'languages/2',
      'makerAddress',
      'importerAddress',
      'composition/0/fibres',
      'composition/1/fibres/1/fibre',
      'composition/1/fibres/2/percent',
      'layout/texts/animalOrigin/nl',
      'layout/texts/animalOrigin/fr',
      'care/1/symbol',
      'care/2/symbol',
      'care/3/text/nl',
      'care/3/text/de',
      'layout/fields/1',
      'layout/notifiedBodyNumber',
      'widthMm',
      'heightMm',
    ])
    expect(problems.find((problem) => problem.path === 'composition/0/fibres')!.message).toBe('The fibres of shell add up to 90 %, not 100 % (Reg. (EU) 1007/2011 art. 9).')
    expect(problems.find((problem) => problem.path === 'layout/texts/animalOrigin/nl')!.message).toContain('Reg. (EU) 1007/2011 art. 12')
  })

  it('takes the animal-origin phrase from the regulation, or from the text typed for a language', () => {
    expect(contentProblems({ ...TEMPLATE, languages: ['it', 'en', 'de', 'fr', 'es'] })).toEqual([])
    const dutch = { ...TEMPLATE, languages: ['it', 'nl'], layout: { ...TEMPLATE.layout, texts: { animalOrigin: { nl: 'Bevat niet-textieldelen van dierlijke oorsprong' } } } }
    expect(contentProblems(dutch)).toEqual([])
    const label = renderLabel(dutch, VALUES)
    expect(block(label, 'animalOrigin')!.lines.map((line) => [line.language, line.text])).toEqual([
      ['it', 'Contiene parti non tessili di origine animale'],
      ['nl', 'Bevat niet-textieldelen van dierlijke'],
      ['nl', 'oorsprong'],
    ])
    expect(block(label, 'animalOrigin')!.source).toMatchObject({ kind: 'TEMPLATE', words: expect.stringContaining('typed in the label for nl') })
  })

  it('category III needs the notified body after CE; category II and not-PPE never carry one', () => {
    const catIII: LabelStyle = { ...STYLE, ppeCategory: 'CATEGORY_III', ppeStandard: 'EN 1621-4:2013', ppeClass: null }
    expect(styleProblems(TEMPLATE, catIII)).toEqual([{ path: 'layout/notifiedBodyNumber', message: expect.stringContaining('category III PPE: the CE marking is followed by the identification number') }])
    const withNb = { ...TEMPLATE, layout: { ...TEMPLATE.layout, notifiedBodyNumber: '9999' } }
    expect(styleProblems(withNb, catIII)).toEqual([])
    expect(styleProblems(withNb, STYLE)).toEqual([{ path: 'layout/notifiedBodyNumber', message: expect.stringContaining('No notified-body number after the CE mark') }])
    expect(styleProblems(withNb, { ...STYLE, ppeCategory: 'NOT_PPE', ppeStandard: null, ppeClass: null })[0]!.message).toContain('is not PPE')
    expect(block(renderLabel(withNb, { ...VALUES, style: catIII, certificate: null }), 'ceMark')).toMatchObject({ value: 'CE 9999', graphic: { kind: 'CE', notifiedBodyNumber: '9999' } })
  })

  it('a PPE style must name its standard, and EN 17092 / EN 13594 their class', () => {
    expect(paths(styleProblems(TEMPLATE, { ...STYLE, ppeStandard: null, ppeClass: null }))).toEqual(['style/ppeStandard'])
    const gloves: LabelStyle = { ...STYLE, productType: 'GLOVES', ppeStandard: 'EN 13594:2015', ppeClass: null }
    expect(styleProblems(TEMPLATE, gloves)).toEqual([{ path: 'style/ppeClass', message: 'Style TEST-JKT-01 is made to EN 13594:2015 but names no class: the pictogram prints the class (1, 2, 1KP, 2KP).' }])
    expect(styleProblems(TEMPLATE, { ...gloves, ppeClass: '1KP' })).toEqual([])
    // EN 17092 parts set their class.
    expect(styleProblems(TEMPLATE, { ...STYLE, ppeClass: null })).toEqual([])
  })

  it('the maker of a brand style is the brand', () => {
    expect(paths(styleProblems({ ...TEMPLATE, makerPartyId: '00000000-0000-7000-8000-0000000000b2' }, STYLE))).toEqual(['makerPartyId'])
    const ours = renderLabel({ ...TEMPLATE, makerPartyId: null }, VALUES)
    expect(ours.problems).toEqual([])
    expect(ours.warnings.map((warning) => warning.path)).toEqual(['makerPartyId', 'status'])
  })

  it('refuses text too long for the layout, and a label too narrow', () => {
    const small = { ...TEMPLATE, widthMm: '30', heightMm: '30' }
    const problems = activationProblems(small, STYLE, '2026-10-29')
    expect(problems).toEqual([{ path: 'heightMm', message: expect.stringMatching(/^The text is too long for the layout: the label needs \d+\.\d{2} mm of height and has 25\.00 mm inside its margins/) }])
    const compact = { ...TEMPLATE, heightMm: '62', layout: { ...TEMPLATE.layout, preset: 'COMPACT' as const } }
    expect(activationProblems(compact, STYLE, '2026-10-29')).toEqual([])
    expect(activationProblems({ ...compact, layout: { ...compact.layout, preset: 'STANDARD' } }, STYLE, '2026-10-29').map((problem) => problem.path)).toEqual(['heightMm'])
    expect(paths(activationProblems({ ...TEMPLATE, widthMm: '20', heightMm: '300' }, STYLE, '2026-10-29'))).toEqual(['widthMm'])
  })

  it('moves DRAFT → ACTIVE | RETIRED and ACTIVE → RETIRED only', () => {
    expect(canTransition(labelTemplateMachine, 'DRAFT', 'ACTIVE').ok).toBe(true)
    expect(canTransition(labelTemplateMachine, 'ACTIVE', 'RETIRED').ok).toBe(true)
    expect(canTransition(labelTemplateMachine, 'ACTIVE', 'DRAFT').ok).toBe(false)
    expect(canTransition(labelTemplateMachine, 'RETIRED', 'ACTIVE').ok).toBe(false)
  })
})

describe('the rendered label of a cell, with the source of each value', () => {
  it('a preview of the jacket: class AA from the certificate, the standard part, the size and a batch placeholder', () => {
    const label = renderLabel(TEMPLATE, VALUES)
    expect(label.problems).toEqual([])
    expect(label.printable).toBe(true)
    expect(label.banner).toEqual(['SAMPLE - NOT FOR GARMENTS', 'CAMPIONE - NON PER CAPI'])
    // The layout's order first, then what a PPE label prints anyway.
    expect(label.blocks.map((entry) => entry.field)).toEqual(['ceMark', 'maker', 'model', 'batchOrSerial', 'size', 'bodyMeasures', 'pictogram', 'class', 'standard', 'composition', 'care', 'manufactureDate', 'animalOrigin'])
    expect(block(label, 'pictogram')).toMatchObject({
      value: 'AA',
      graphic: { kind: 'PICTOGRAM', pictogram: 'MOTORCYCLIST', standardCode: 'EN 17092', ppeClass: 'AA' },
      source: { kind: 'CERTIFICATE', words: 'From certificate TEST-CERT-0001: class AA, valid until 2031-01-14.', recordType: 'Certificate', recordId: COVERED.certificate!.id },
    })
    expect(block(label, 'class')!.lines.map((line) => line.text)).toEqual(['Classe / Class AA'])
    expect(block(label, 'standard')).toMatchObject({ value: 'EN 17092-3:2020', source: { kind: 'STYLE', words: 'From style TEST-JKT-01: EN 17092 part 3, edition 2020.' } })
    expect(block(label, 'size')).toMatchObject({ value: '52', placeholder: false, source: { kind: 'SIZE_SCALE', words: 'From size scale TEST-EU-JKT: size 52.' } })
    expect(block(label, 'bodyMeasures')!.value).toBe('chest 100-104 cm, height 176-182 cm')
    expect(block(label, 'batchOrSerial')).toMatchObject({ value: null, placeholder: true, lines: [{ text: 'LOT ________', language: null }], source: { kind: 'SAMPLE' } })
    expect(block(label, 'manufactureDate')).toMatchObject({ value: '2026-Q4', placeholder: true })
    expect(block(label, 'ceMark')).toMatchObject({ value: 'CE', source: { kind: 'RULE', words: expect.stringContaining('no notified-body number') } })
    expect(block(label, 'composition')!.lines.map((line) => line.text)).toEqual(['lining: 100% polyester'])
    expect(block(label, 'care')!.graphic).toMatchObject({ kind: 'CARE', symbols: [{ code: 'wash-not' }, { code: 'bleach-not' }, { code: 'iron-not' }, { code: 'dryclean-professional' }] })
    expect(label.fit).toMatchObject({ widthMm: '50.00', heightMm: '80.00', availableMm: '75.00', charsPerLine: 45, fits: true })
  })

  it('a garment label: the batch from the work order, no banner, refused without a batch, a valid certificate or the active status', () => {
    const real: LabelValues = {
      ...VALUES,
      sample: false,
      identification: { kind: 'BATCH', value: 'BA-00012', recordType: 'WorkOrder', recordId: '00000000-0000-7000-8000-0000000000f1', reference: 'WO-00012' },
      manufactured: { date: '2026-11-03', recordType: 'WorkOrder', recordId: '00000000-0000-7000-8000-0000000000f1', reference: 'WO-00012' },
    }
    const active = { ...TEMPLATE, status: 'ACTIVE' as const }
    const label = renderLabel(active, real)
    expect(label).toMatchObject({ printable: true, banner: [], problems: [] })
    expect(block(label, 'batchOrSerial')).toMatchObject({ value: 'BA-00012', lines: [{ text: 'LOT BA-00012' }], source: { kind: 'WORK_ORDER', words: 'From work order WO-00012: batch BA-00012, given at its release.' } })
    expect(block(label, 'manufactureDate')).toMatchObject({ value: '2026-Q4', placeholder: false, source: { kind: 'WORK_ORDER' } })

    expect(paths(renderLabel(TEMPLATE, real).problems)).toEqual(['status'])
    expect(paths(renderLabel(active, { ...real, identification: { ...real.identification, value: null } }).problems)).toEqual(['batchOrSerial'])
    const refused = renderLabel(active, { ...real, certificate: { outcome: 'refused', certificate: null, reasons: ['Certificate TEST-CERT-0001 expired on 2026-10-28.'], date: '2026-10-29' } })
    expect(refused.problems).toEqual([
      { path: 'certificate', message: 'No valid certificate covers BLK 52 of style TEST-JKT-01 on 2026-10-29: its garment label is not printed (Reg. (EU) 2016/425 art. 17). Certificate TEST-CERT-0001 expired on 2026-10-28.' },
    ])
    expect(block(refused, 'pictogram')!.source).toMatchObject({ kind: 'STYLE', words: 'From style TEST-JKT-01: class AA; no valid certificate covers BLK 52 on 2026-10-29.' })
    const serial = renderLabel(active, { ...real, identification: { kind: 'SERIAL', value: 'SN-000123', recordType: 'GarmentSerial', recordId: null, reference: 'WO-00012' } })
    expect(block(serial, 'batchOrSerial')).toMatchObject({ lines: [{ text: 'SN SN-000123' }], source: { kind: 'SERIAL' } })
  })

  it("names a class the certificate does not grant, missing body measures and the buyer's missing language", () => {
    const label = renderLabel(TEMPLATE, {
      ...VALUES,
      certificate: { ...COVERED, certificate: { ...COVERED.certificate!, ppeClass: 'A' } },
      size: { ...VALUES.size!, bodyMeasures: null },
      marketLanguages: ['de', 'it'],
    })
    expect(paths(label.problems)).toEqual(['languages', 'pictogram', 'bodyMeasures'])
    expect(label.problems[0]!.message).toBe("The buyer's market needs de; the label prints it, en: add it (Reg. (EU) 1007/2011 art. 16(3); Reg. (EU) 2016/425 art. 8(7)).")
    expect(block(label, 'pictogram')!.value).toBe('A')
  })

  it('wraps, dates and measures as printed', () => {
    expect(wrapText('Contiene parti non tessili di origine animale', 20)).toEqual(['Contiene parti non', 'tessili di origine', 'animale'])
    expect(wrapText('ABCDEFGHIJKLMNOPQRSTUVWXYZ', 10)).toEqual(['ABCDEFGHIJ', 'KLMNOPQRST', 'UVWXYZ'])
    expect([manufactureText('2026-01-01', 'QUARTER'), manufactureText('2026-12-31', 'QUARTER'), manufactureText('2026-07-15', 'MONTH')]).toEqual(['2026-Q1', '2026-Q4', '2026-07'])
    expect(bodyMeasuresText({ chest: { min: '100', max: null, unit: 'cm' }, waist: { min: null, max: '90', unit: 'cm' } })).toBe('chest from 100 cm, waist up to 90 cm')
    expect(printedFields({ ...TEMPLATE, layout: { ...TEMPLATE.layout, fields: [] }, care: [], composition: [], animalOriginPhrase: false }, false)).toEqual(['model', 'size', 'batchOrSerial', 'manufactureDate', 'maker'])
  })
})

describe('the garment label in ZPL', () => {
  it('draws CE, the pictogram with the class, the lines and the SAMPLE band, with escaped text', () => {
    const zpl = garmentLabelZpl(renderLabel({ ...TEMPLATE, makerName: 'Marchio^Inventato' }, VALUES), 203, 2)
    expect(zpl.startsWith('^XA\n^CI28\n^PW400\n^LL639\n')).toBe(true)
    expect(zpl).toContain('^FDCE^FS')
    expect(zpl).toContain('^FDEN 17092^FS')
    expect(zpl).toContain('^FDAA^FS')
    expect(zpl).toContain('^FDLOT _5F_5F_5F_5F_5F_5F_5F_5F^FS')
    expect(zpl).toContain('^FDMarchio_5EInventato^FS')
    expect(zpl).toContain('^FR^A0N,14,14^FH^FDSAMPLE - NOT FOR GARMENTS^FS')
    expect(zpl.endsWith('^PQ2\n^XZ\n')).toBe(true)
    expect(() => garmentLabelZpl(renderLabel(TEMPLATE, VALUES), 150)).toThrow(RangeError)
  })
})
