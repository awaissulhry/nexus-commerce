import { describe, expect, it } from 'vitest'
import { keptUntil, recordRefusal, recordsToMake, versionsByBatch } from './batches'
import { coverageCounts, coverageMatrix } from './coverage'
import { packContents, packFingerprintText, packLocaleOf, packPaper, packRefusals, packWarnings, safeName, sumsText, type PackFacts } from './pack'
import {
  applyEdits,
  checkRefusal,
  composeDeclaration,
  contentJson,
  contentOf,
  dayWords,
  declarationNumber,
  differences,
  keepTyped,
  pointEditProblems,
  startingState,
  translationRefusal,
  withdrawRefusal,
  type DeclarationFacts,
  type PhraseBook,
} from './rules'
import { fillWords, missingPlaceholders, TEMPLATE_ID } from './template'

/** B-W2b-257: the DoC generator's pure rules. Every name, number and address is made up. */

const STYLE = '00000000-0000-7000-8000-000000000001'
const REVISION = '00000000-0000-7000-8000-000000000002'
const CERTIFICATE = '00000000-0000-7000-8000-000000000003'
const BODY = '00000000-0000-7000-8000-000000000004'
const OPERATOR = '00000000-0000-7000-8000-000000000005'
const REGULATION = '00000000-0000-7000-8000-000000000006'
const STANDARD = '00000000-0000-7000-8000-000000000007'
const PHRASE = '00000000-0000-7000-8000-000000000008'
const USER_A = '00000000-0000-7000-8000-00000000000a'
const USER_B = '00000000-0000-7000-8000-00000000000b'

const facts = (over: Partial<DeclarationFacts> = {}): DeclarationFacts => ({
  style: { id: STYLE, code: 'DEMO-JKT-1', name: 'Demo touring jacket', nameI18n: { de: 'Demo Tourenjacke' }, ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' },
  revision: { id: REVISION, revision: 2, sizes: ['48', '50', '52'] },
  colourways: [{ id: 'c1', code: 'BLK', name: 'Black' }],
  maker: { name: 'Demo Factory S.r.l.', address: 'Via Demo 1, 00000 Demotown, IT', source: { kind: 'OPERATOR', recordType: 'EconomicOperatorRole', recordId: OPERATOR } },
  representative: null,
  certificate: { id: CERTIFICATE, number: 'DEMO-CERT-1', bodyName: 'Demo Notified Body', bodyNumber: '0000', bodyId: BODY },
  certificateProblem: null,
  legislation: { id: REGULATION, label: 'Regulation (EU) 2016/425', labels: { it: 'Regolamento (UE) 2016/425', en: 'Regulation (EU) 2016/425' } },
  standards: [{ typed: 'EN 17092-3:2020', entry: { id: STANDARD, label: 'EN 17092-3:2020', ojReference: 'OJ L 77, 5.3.2021', status: 'IN_FORCE' }, source: { kind: 'STYLE', recordType: 'Style', recordId: STYLE } }],
  signatory: { name: null, function: null, place: null, on: null },
  ...over,
})
const noLibrary: PhraseBook = () => null

describe('composing the Annex IX points (PRD-292)', () => {
  it('fills the nine points in Italian from the records, each with its source and values', () => {
    const { content, blocking, warnings, missingPhrases } = composeDeclaration(facts(), 'it', noLibrary)
    expect(blocking).toEqual([])
    expect(missingPhrases).toEqual([])
    expect(content.template).toBe(TEMPLATE_ID)
    expect(content.points.map((point) => point.point)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    const byPoint = Object.fromEntries(content.points.map((point) => [point.point, point]))
    expect(byPoint['1']!.text).toBe('DPI: Demo touring jacket, modello DEMO-JKT-1; lotto o numero di serie: come riportato sull’etichetta di ogni capo.')
    expect(byPoint['2']).toMatchObject({ text: 'Fabbricante: Demo Factory S.r.l., Via Demo 1, 00000 Demotown, IT.', source: { kind: 'OPERATOR', recordId: OPERATOR } })
    expect(byPoint['3']!.source.kind).toBe('TEMPLATE')
    expect(byPoint['4']!.text).toContain('revisione 2; colori: BLK Black; taglie: 48, 50, 52.')
    expect(byPoint['5']).toMatchObject({ source: { kind: 'REGISTER', recordId: REGULATION } })
    expect(byPoint['5']!.text).toContain('Regolamento (UE) 2016/425')
    expect(byPoint['6']!.text).toContain('EN 17092-3:2020 (OJ L 77, 5.3.2021)')
    expect(byPoint['7']).toMatchObject({ source: { kind: 'CERTIFICATE', recordId: CERTIFICATE } })
    expect(byPoint['7']!.text).toContain('Demo Notified Body, numero 0000')
    expect(byPoint['7']!.values?.find((value) => value.field === 'body')?.source).toEqual({ kind: 'NOTIFIED_BODY', recordType: 'NotifiedBody', recordId: BODY })
    expect(byPoint['8']!.text).toBe('Non applicabile: il DPI non è di categoria III.')
    expect(byPoint['9']!.text).toContain('Firmato a nome e per conto di: Demo Factory S.r.l.')
    expect(warnings.map((warning) => warning.code)).toEqual(['SIGNATORY_TO_TYPE'])
    // The stored JSON keeps what the database's shape wants (point, words, source).
    expect(contentOf(contentJson(content)).points).toEqual(content.points)
  })

  it('takes the phrase library before the built-in words, and the signatory typed in the fields', () => {
    const book: PhraseBook = (key, language) => (key === 'doc.sole-responsibility' && language === 'en' ? { text: 'Issued under the sole responsibility of the manufacturer (library).', phraseId: PHRASE, revision: 3 } : null)
    const signed = facts({ signatory: { name: 'Demo Person', function: 'Director', place: 'Demotown', on: '2026-11-10' } })
    const { content, warnings } = composeDeclaration(signed, 'en', book)
    const three = content.points.find((point) => point.point === '3')!
    expect(three).toMatchObject({ text: 'Issued under the sole responsibility of the manufacturer (library).', source: { kind: 'PHRASE', recordType: 'Phrase', recordId: PHRASE }, wording: { key: 'doc.sole-responsibility', kind: 'PHRASE', phraseId: PHRASE, revision: 3 } })
    expect(content.points.find((point) => point.point === '9')!.text).toBe('Additional information. Signed for and on behalf of: Demo Factory S.r.l.\nDemotown, 2026-11-10. Demo Person, Director.')
    expect(warnings.map((warning) => warning.code)).not.toContain('SIGNATORY_TO_TYPE')
  })

  it('refuses what cannot be declared: not PPE, no maker, no valid certificate, a language without the template', () => {
    expect(composeDeclaration(facts({ style: { ...facts().style, ppeCategory: 'NOT_PPE' } }), 'it', noLibrary).blocking.map((problem) => problem.code)).toContain('NOT_PPE')
    expect(composeDeclaration(facts({ maker: null }), 'it', noLibrary).blocking.map((problem) => problem.code)).toEqual(['NO_MAKER'])
    const lapsed = composeDeclaration(facts({ certificate: null, certificateProblem: 'DEMO-CERT-1 expired.' }), 'it', noLibrary)
    expect(lapsed.blocking).toEqual([{ code: 'NO_CERTIFICATE', point: '7', message: 'DEMO-CERT-1 expired.' }])
    const german = composeDeclaration(facts(), 'de', noLibrary)
    expect(german.blocking.every((problem) => problem.code === 'PHRASE_MISSING')).toBe(true)
    expect(german.missingPhrases).toContain('doc.point1')
  })

  it('writes category I and III points as the law has them', () => {
    const one = composeDeclaration(facts({ style: { ...facts().style, ppeCategory: 'CATEGORY_I' }, certificate: null }), 'en', noLibrary)
    expect(one.blocking).toEqual([])
    expect(one.content.points.find((point) => point.point === '7')!.text).toContain('Module A')
    const three = composeDeclaration(facts({ style: { ...facts().style, ppeCategory: 'CATEGORY_III' } }), 'en', noLibrary)
    expect(three.content.points.find((point) => point.point === '8')).toMatchObject({ source: { kind: 'TO_TYPE' } })
    expect(three.warnings.map((warning) => warning.code)).toContain('POINT8_TO_TYPE')
  })

  it('warns about a standard the register lacks or no longer holds in force', () => {
    const typedOnly = composeDeclaration(facts({ standards: [{ typed: 'EN 9999:2001', entry: null, source: { kind: 'CERTIFICATE', recordType: 'Certificate', recordId: CERTIFICATE } }] }), 'en', noLibrary)
    expect(typedOnly.warnings.map((warning) => warning.code)).toContain('STANDARD_NOT_IN_REGISTER')
    expect(typedOnly.content.points.find((point) => point.point === '6')!.source).toEqual({ kind: 'CERTIFICATE', recordType: 'Certificate', recordId: CERTIFICATE })
  })
})

describe('translations (PRD-293)', () => {
  const original = composeDeclaration(facts(), 'it', noLibrary).content.points

  it('composes the language from the library; what it lacks keeps the original words, IN_TRANSLATION', () => {
    const book: PhraseBook = (key, language) => (language === 'de' && key === 'doc.sole-responsibility' ? { text: 'Die alleinige Verantwortung trägt der Hersteller.', phraseId: PHRASE, revision: 1 } : null)
    const german = composeDeclaration(facts(), 'de', book, original)
    expect(german.blocking).toEqual([])
    expect(german.content.points.find((point) => point.point === '3')!.text).toBe('Die alleinige Verantwortung trägt der Hersteller.')
    const one = german.content.points.find((point) => point.point === '1')!
    expect(one.source.kind).toBe('UNTRANSLATED')
    expect(one.text).toBe(original.find((point) => point.point === '1')!.text)
    expect(startingState(german.content.points)).toBe('IN_TRANSLATION')
    expect(startingState(composeDeclaration(facts(), 'en', noLibrary, original).content.points)).toBe('DRAFT')
  })

  it('never translates a point a person typed in the original', () => {
    const typed = applyEdits(original, [{ point: '4', text: 'Oggetto scritto a mano.' }], USER_A)
    const english = composeDeclaration(facts(), 'en', noLibrary, typed)
    expect(english.content.points.find((point) => point.point === '4')).toMatchObject({ text: 'Oggetto scritto a mano.', source: { kind: 'UNTRANSLATED' } })
  })

  it('refuses a language twice, the original language, or not a code', () => {
    expect(translationRefusal({ originalLanguage: 'it', language: 'it', taken: [] })?.code).toBe('SOURCE_LANGUAGE')
    expect(translationRefusal({ originalLanguage: 'it', language: 'de', taken: ['de'] })?.code).toBe('TAKEN')
    expect(translationRefusal({ originalLanguage: 'it', language: 'DE', taken: [] })?.code).toBe('LANGUAGE')
    expect(translationRefusal({ originalLanguage: 'it', language: 'de', taken: ['it'] })).toBeNull()
  })

  it('is checked by a second person only: not its author, not a typist, never with words to type', () => {
    const typed = applyEdits(composeDeclaration(facts(), 'en', noLibrary, original).content.points, [{ point: '1', text: 'PPE: typed.' }], USER_B)
    const base = { status: 'DRAFT', translationState: 'DRAFT' as const, authorId: USER_A, points: typed }
    expect(checkRefusal({ ...base, checkerId: USER_A })?.code).toBe('OWN_TRANSLATION')
    expect(checkRefusal({ ...base, checkerId: USER_B })?.code).toBe('OWN_WORDS')
    expect(checkRefusal({ ...base, checkerId: '00000000-0000-7000-8000-0000000000cc' })).toBeNull()
    const open = composeDeclaration(facts(), 'de', noLibrary, original).content.points
    expect(checkRefusal({ ...base, points: open, checkerId: USER_B })?.code).toBe('WORDS_MISSING')
    expect(checkRefusal({ ...base, translationState: null, checkerId: USER_B })?.code).toBe('NOT_A_TRANSLATION')
    expect(checkRefusal({ ...base, translationState: 'CHECKED', checkerId: USER_B })?.code).toBe('CHECKED')
  })
})

describe('typed words, refresh and staleness', () => {
  const points = composeDeclaration(facts(), 'en', noLibrary).content.points

  it('types a point (TYPED by the person) and refuses bad edits', () => {
    const edited = applyEdits(points, [{ point: '8', text: '  Typed point eight.  ' }], USER_A)
    expect(edited.find((point) => point.point === '8')).toMatchObject({ text: 'Typed point eight.', source: { kind: 'TYPED', recordType: 'User', recordId: USER_A } })
    expect(pointEditProblems([{ point: '10', text: 'x' }, { point: '1', text: ' ' }]).map((problem) => problem.path)).toEqual(['body/points/0/point', 'body/points/1/text'])
    expect(pointEditProblems([{ point: '1', text: 'a' }, { point: '1', text: 'b' }])[0]!.message).toBe('Point 1 is given twice.')
  })

  it('keeps typed points on a refresh and names what the records changed', () => {
    const edited = applyEdits(points, [{ point: '8', text: 'Typed.' }], USER_A)
    const fresh = composeDeclaration(facts({ certificate: { ...facts().certificate!, number: 'DEMO-CERT-2' } }), 'en', noLibrary).content.points
    expect(keepTyped(fresh, edited).find((point) => point.point === '8')!.text).toBe('Typed.')
    expect(differences(edited, fresh).map((difference) => difference.point)).toEqual(['7'])
  })

  it('numbers, dates and withdrawal words', () => {
    expect(declarationNumber('DEMO-JKT-1', 'de', 3)).toBe('DoC-DEMO-JKT-1-DE-r3')
    expect(dayWords('2026-11-10', 'it')).toBe('10/11/2026')
    expect(dayWords('2026-11-10', 'de')).toBe('10.11.2026')
    expect(withdrawRefusal({ status: 'DRAFT', reason: 'no' })?.code).toBe('REASON')
    expect(withdrawRefusal({ status: 'ISSUED', reason: 'A good reason' })?.code).toBe('NOT_DRAFT')
    expect(withdrawRefusal({ status: 'DRAFT', reason: 'A good reason' })).toBeNull()
  })

  it('fills placeholders and finds a translation that lost one', () => {
    expect(fillWords('Model {code}, {missing}', { code: 'X' })).toBe('Model X, {missing}')
    expect(fillWords('By {maker}. Then…', { maker: 'Demo S.r.l.' })).toBe('By Demo S.r.l. Then…')
    expect(fillWords('Wait...', {})).toBe('Wait...')
    expect(missingPlaceholders('doc.point7', 'Die Stelle {body} hat geprüft.')).toEqual(['bodyNumber', 'certificate'])
  })
})

describe('versions by batch (PRD-295)', () => {
  const document = { styleId: STYLE, kind: 'DECLARATION_OF_CONFORMITY', revision: 2, status: 'ISSUED', language: 'it' }
  const order = { styleId: STYLE, batchNumber: 'DEMO-BT-1', frozenRevision: 2, number: 'DEMO-WO-1' }

  it('records a work order batch only with its own revision, issued', () => {
    expect(recordRefusal({ document, workOrder: order, batchNumber: null, shipment: null })).toBeNull()
    // B-W2b-288 (FU2:04): a superseded document keeps a batch made while it was in force (its work order froze its revision).
    expect(recordRefusal({ document: { ...document, status: 'SUPERSEDED' }, workOrder: order, batchNumber: null, shipment: null })).toBeNull()
    expect(recordRefusal({ document: { ...document, status: 'DRAFT' }, workOrder: order, batchNumber: null, shipment: null })?.code).toBe('NOT_ISSUED')
    expect(recordRefusal({ document, workOrder: { ...order, frozenRevision: 1 }, batchNumber: null, shipment: null })?.message).toBe(
      "Work order DEMO-WO-1 made revision 1; this document is of revision 2: record the batch with its own revision's document.",
    )
    expect(recordRefusal({ document, workOrder: { ...order, batchNumber: null }, batchNumber: null, shipment: null })?.code).toBe('NOT_RELEASED')
    expect(recordRefusal({ document, workOrder: order, batchNumber: 'X', shipment: null })?.code).toBe('BOTH')
    expect(recordRefusal({ document, workOrder: null, batchNumber: null, shipment: null })?.code).toBe('NO_BATCH')
    expect(recordRefusal({ document, workOrder: null, batchNumber: 'LEGACY-1', shipment: null })).toBeNull()
    expect(recordRefusal({ document, workOrder: order, batchNumber: null, shipment: { number: 'SH-1', status: 'SHIPPED', carriesWorkOrder: false } })?.code).toBe('NOT_ON_SHIPMENT')
  })

  it('keeps a record ten years, never a day less', () => {
    expect(keptUntil('2026-11-10')).toBe('2036-11-10')
    expect(keptUntil('2028-02-29')).toBe('2038-03-01')
  })

  it('records what travelled once, and draws the timeline newest revision first', () => {
    const make = recordsToMake({
      shipmentId: 's',
      batches: [
        { workOrderId: 'w1', batchNumber: 'B1', styleId: STYLE, frozenRevision: 2 },
        { workOrderId: 'w2', batchNumber: null, styleId: STYLE, frozenRevision: 2 },
        { workOrderId: 'w3', batchNumber: 'B3', styleId: STYLE, frozenRevision: 1 },
      ],
      documents: [
        { documentId: 'd-it', styleId: STYLE, revision: 2 },
        { documentId: 'd-leaflet', styleId: STYLE, revision: 2 },
      ],
      recorded: new Set(['d-leaflet|B1']),
    })
    expect(make).toEqual([{ documentId: 'd-it', workOrderId: 'w1', batchNumber: 'B1' }])
    const timeline = versionsByBatch(
      [
        { id: 'r1', documentId: 'd1', batchNumber: 'B0', workOrderId: null, shipmentId: null, createdAt: '2026-01-01T00:00:00.000Z' },
        { id: 'r2', documentId: 'd2', batchNumber: 'B1', workOrderId: 'w1', shipmentId: 's1', createdAt: '2026-02-01T00:00:00.000Z' },
        { id: 'r3', documentId: 'd2', batchNumber: 'B1', workOrderId: 'w1', shipmentId: null, createdAt: '2026-01-15T00:00:00.000Z' },
      ],
      [
        { id: 'd1', kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 1, number: 'N1', status: 'SUPERSEDED' },
        { id: 'd2', kind: 'DECLARATION_OF_CONFORMITY', language: 'it', revision: 2, number: 'N2', status: 'ISSUED' },
      ],
    )
    expect(timeline.map((group) => group.revision)).toEqual([2, 1])
    expect(timeline[0]!.batches).toEqual([{ batchNumber: 'B1', workOrderId: 'w1', shipmentIds: ['s1'], documentIds: ['d2'], firstRecordedAt: '2026-01-15T00:00:00.000Z' }])
  })
})

describe('the shipment compliance pack (PRD-300)', () => {
  const pack = (over: Partial<PackFacts> = {}): PackFacts => ({
    shipment: { id: 's', number: 'DEMO-SH-1', status: 'PACKED', shippedOn: null },
    customer: { name: 'Demo Customer' },
    order: { number: 'DEMO-SO-1', customerRef: 'PO 7' },
    wantedLanguage: 'de',
    day: '2026-11-10',
    sender: 'Demo Factory S.r.l.',
    styles: [
      {
        styleId: STYLE,
        code: 'DEMO-JKT-1',
        name: 'Demo touring jacket',
        revision: 2,
        category: 'CATEGORY_II',
        garments: 12,
        documents: [
          { documentId: 'd1', kind: 'DECLARATION_OF_CONFORMITY', language: 'en', revision: 2, number: 'DOC-1', issuedAt: null, fallback: true, file: { id: 'f1', originalName: 'doc.pdf', sha256: 'a'.repeat(64), sizeBytes: 10 } },
          { documentId: 'd2', kind: 'USER_INFORMATION', language: 'de', revision: 2, number: null, issuedAt: null, fallback: false, file: { id: 'f2', originalName: 'ui.pdf', sha256: 'b'.repeat(64), sizeBytes: 10 } },
        ],
        certificate: { id: CERTIFICATE, number: 'DEMO-CERT-1', standard: 'EN 17092-3:2020', ppeClass: 'AA', bodyName: 'Demo Notified Body', bodyNumber: '0000', validFrom: '2026-01-01', validTo: '2030-12-31', validOnDay: true },
        batches: [{ workOrderId: 'w1', batchNumber: 'DEMO-BT-1', garments: 12, publicDocAddress: 'https://factory.example/doc/7K3QM2XA', publicDocCode: '7K3Q-M2XA' }],
      },
    ],
    ...over,
  })

  it('lists each document with its path and fingerprint, warns of a fallback language', () => {
    const contents = packContents(pack(), 'en')
    expect(contents.map((entry) => entry.path)).toEqual(['documents/DEMO-JKT-1-r2-DoC-en.pdf', 'documents/DEMO-JKT-1-r2-user-information-de.pdf'])
    expect(packWarnings(pack()).map((warning) => warning.code)).toEqual(['FALLBACK_LANGUAGE'])
    expect(packRefusals(pack(), [])).toEqual([])
    expect(packRefusals(pack({ styles: [] }), ['DoC missing']).map((problem) => problem.code)).toEqual(['NO_PPE', 'DOCUMENT_MISSING'])
    expect(packFingerprintText(pack(), 'en')).toBe(packFingerprintText(pack(), 'en'))
    expect(packFingerprintText(pack(), 'en')).not.toBe(packFingerprintText(pack({ customer: { name: 'Other' } }), 'en'))
    expect(sumsText([{ sha256: 'c'.repeat(64), path: 'pack.pdf' }])).toBe(`${'c'.repeat(64)}  pack.pdf\n`)
    expect(safeName('DEMO SH/1 è')).toBe('DEMO-SH-1-e')
  })

  it('prints the summary in the buyer’s locale: Italian for Italian, English otherwise; never a price', () => {
    expect(packLocaleOf('it')).toBe('it')
    expect(packLocaleOf('de')).toBe('en')
    const paper = packPaper(pack(), 'it', packContents(pack(), 'it'), 'f'.repeat(64), 3)
    expect(paper.title).toBe('Pacchetto di conformità della spedizione')
    expect(paper.facts[0]).toEqual({ label: 'Spedizione', value: 'DEMO-SH-1 · v3' })
    expect(paper.styles[0]!.certificate[1]).toContain('valido il 10/11/2026')
    expect(paper.styles[0]!.batches[0]).toEqual({ line: 'Lotto DEMO-BT-1 · 12 capi', address: 'https://factory.example/doc/7K3QM2XA', code: '7K3Q-M2XA' })
    expect(JSON.stringify({ facts: paper.facts, contents: paper.contents, styles: paper.styles })).not.toMatch(/price|prezz|cost|€/i)
  })
})

describe('language coverage (PRD-293)', () => {
  it('says per style, kind and language what the current revision has', () => {
    const styles = [{ id: STYLE, code: 'DEMO-JKT-1', name: 'Demo', companyId: null, revision: 2 }]
    const documents = [
      { id: 'd1', styleId: STYLE, kind: 'DECLARATION_OF_CONFORMITY' as const, language: 'it', revision: 2, status: 'ISSUED', origin: 'SIGNED' as const, translationStatus: null, hasFile: true },
      { id: 'd2', styleId: STYLE, kind: 'DECLARATION_OF_CONFORMITY' as const, language: 'de', revision: 2, status: 'DRAFT', origin: 'GENERATED' as const, translationStatus: 'IN_TRANSLATION', hasFile: false },
      { id: 'd3', styleId: STYLE, kind: 'DECLARATION_OF_CONFORMITY' as const, language: 'fr', revision: 1, status: 'ISSUED', origin: 'SIGNED' as const, translationStatus: null, hasFile: true },
    ]
    const markets = [
      { code: 'IT', companyId: null, docLanguages: ['it'], userInfoLanguages: ['it'] },
      { code: 'DE', companyId: null, docLanguages: ['de'], userInfoLanguages: ['de'] },
      { code: 'FR', companyId: null, docLanguages: ['fr'], userInfoLanguages: [] },
    ]
    const { languages, rows } = coverageMatrix(styles, documents, markets)
    expect(languages).toEqual(['it', 'de', 'fr'])
    const doc = rows.find((row) => row.kind === 'DECLARATION_OF_CONFORMITY')!
    expect(doc.cells.map((cell) => [cell.language, cell.state])).toEqual([
      ['it', 'ISSUED'],
      ['de', 'IN_TRANSLATION'],
      ['fr', 'MISSING'],
    ])
    const leaflet = rows.find((row) => row.kind === 'USER_INFORMATION')!
    expect(leaflet.cells.map((cell) => cell.state)).toEqual(['MISSING', 'MISSING', 'NOT_NEEDED'])
    expect(coverageCounts(rows, documents)).toEqual({ issued: 2, drafts: 1, languagesMissing: 3 })
  })
})
