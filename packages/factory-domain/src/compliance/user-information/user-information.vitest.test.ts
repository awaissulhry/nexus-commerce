import { describe, expect, it } from 'vitest'
import type { DeclarationFacts, LibraryWords, PhraseBook } from '../declarations/rules'
import { batchLeaflets, languagePacks, packLanguage, packTranslations, type PackDocument, type PackMarket } from './packs'
import {
  applyEdits,
  checkRefusal,
  composeUserInformation,
  differences,
  keepTyped,
  listsChanged,
  sectionEditProblems,
  sectionsJson,
  sectionsOf,
  sectionsToType,
  sourceWords,
  spareProtectors,
  standardCodeOf,
  startingState,
  translationRefusal,
  type LeafletFacts,
  type PlacementFact,
  type SpareCandidate,
} from './rules'
import { SECTION_KEYS, TEMPLATE, TEMPLATE_ID, missingPlaceholders } from './template'

/** Made-up facts only: SEED-like codes, example addresses. */
const STYLE = '00000000-0000-4000-8000-000000000001'
const REVISION = '00000000-0000-4000-8000-000000000002'
const CERT = '00000000-0000-4000-8000-000000000003'
const BODY = '00000000-0000-4000-8000-000000000004'
const P1 = '00000000-0000-4000-8000-000000000011'
const P2 = '00000000-0000-4000-8000-000000000012'
const P3 = '00000000-0000-4000-8000-000000000013'
const PL1 = '00000000-0000-4000-8000-000000000021'
const PL2 = '00000000-0000-4000-8000-000000000022'
const AUTHOR = '00000000-0000-4000-8000-000000000031'
const CHECKER = '00000000-0000-4000-8000-000000000032'

const declaration = (over: Partial<DeclarationFacts> = {}): DeclarationFacts => ({
  style: { id: STYLE, code: 'DEMO-JKT-01', name: 'Demo touring jacket', nameI18n: { it: 'Giacca touring demo' }, ppeCategory: 'CATEGORY_II', ppeStandard: 'EN 17092-3:2020', ppeClass: 'AA' },
  revision: { id: REVISION, revision: 2, sizes: ['48', '50', '52'] },
  colourways: [{ id: '00000000-0000-4000-8000-000000000041', code: 'BLK', name: 'Black' }],
  maker: { name: 'Demo Maker S.r.l.', address: 'Via Esempio 1, 00000 Demotown, IT', source: { kind: 'COMPANY', recordType: 'Company', recordId: '00000000-0000-4000-8000-000000000051' } },
  representative: null,
  certificate: { id: CERT, number: 'DEMO-CERT-1', bodyName: 'Demo Notified Body', bodyNumber: '0000', bodyId: BODY },
  certificateProblem: null,
  legislation: { id: '00000000-0000-4000-8000-000000000061', label: 'Regulation (EU) 2016/425', labels: { it: 'Regolamento (UE) 2016/425' } },
  standards: [{ typed: 'EN 17092-3:2020', entry: { id: '00000000-0000-4000-8000-000000000062', label: 'EN 17092-3:2020', ojReference: 'OJ L 1, 1.1.2021', status: 'IN_FORCE' }, source: { kind: 'STYLE', recordType: 'Style', recordId: STYLE } }],
  signatory: { name: null, function: null, place: null, on: null },
  ...over,
})

const placements: PlacementFact[] = [
  { id: PL1, seq: 1, pocket: 'SHOULDER', protector: { id: P1, code: 'DEMO-PROT-S2', name: 'Demo shoulder protector' }, standard: 'EN 1621-1:2012', level: '2', sizes: [], note: 'left and right, on the seam' },
  { id: PL2, seq: 2, pocket: 'ELBOW', protector: { id: P1, code: 'DEMO-PROT-S2', name: 'Demo shoulder protector' }, standard: 'EN 1621-1:2012', level: '2', sizes: ['50', '52'], note: null },
]

const cert = (id: string, number: string, level: string, valid = true) => ({ id, number, standard: 'EN 1621-1:2012', ppeClass: level, validTo: '2030-12-31', valid })
const candidates: SpareCandidate[] = [
  { itemId: P1, code: 'DEMO-PROT-S2', name: 'Demo shoulder protector', placed: true, replaces: [P1], certificates: [cert('00000000-0000-4000-8000-000000000071', 'DEMO-PCERT-1', '2')] },
  // An alternate certified at level 1 only: it does not serve a level 2 pocket.
  { itemId: P2, code: 'DEMO-PROT-L1', name: 'Demo protector L1', placed: false, replaces: [P1], certificates: [cert('00000000-0000-4000-8000-000000000072', 'DEMO-PCERT-2', '1')] },
  // An alternate at level 2 whose certificate expired.
  { itemId: P3, code: 'DEMO-PROT-X2', name: 'Demo protector X2', placed: false, replaces: [P1], certificates: [cert('00000000-0000-4000-8000-000000000073', 'DEMO-PCERT-3', '2', false)] },
]

const facts = (over: Partial<LeafletFacts> = {}): LeafletFacts => ({
  declaration: declaration(),
  importer: null,
  bodyAddress: 'Via Organismo 9, 00000 Demotown, IT',
  ppeClass: { value: 'AA', source: { kind: 'CERTIFICATE', recordType: 'Certificate', recordId: CERT } },
  placements,
  placementFindings: [],
  spareCandidates: candidates,
  markings: { values: ['CE'], source: { kind: 'MARKET', recordType: 'MarketProfile', recordId: '00000000-0000-4000-8000-000000000081' } },
  docAddress: { address: 'https://factory.example.org/doc/ABCD2345', source: { kind: 'PUBLIC_DOC', recordType: 'Style', recordId: STYLE } },
  ...over,
})

const emptyBook: PhraseBook = () => null
const bookOf = (entries: Record<string, LibraryWords>): PhraseBook => (key, language) => entries[`${key}|${language}`] ?? null

describe('the template', () => {
  it('has Italian and English words for every key, with every placeholder in both', () => {
    for (const entry of Object.values(TEMPLATE)) {
      expect(missingPlaceholders(entry.key, entry.it), `${entry.key} it`).toEqual([])
      expect(missingPlaceholders(entry.key, entry.en), `${entry.key} en`).toEqual([])
    }
  })
})

describe('composeUserInformation', () => {
  it('writes the Annex II 1.4 sections in order, each with its source, the protector positions and the spare protectors', () => {
    const result = composeUserInformation(facts(), 'en', emptyBook)
    expect(result.blocking).toEqual([])
    expect(result.content.template).toBe(TEMPLATE_ID)
    expect(result.content.sections.map((section) => section.key)).toEqual([...SECTION_KEYS])
    const by = (key: string) => result.content.sections.find((section) => section.key === key)!
    expect(by('product').text).toContain('Demo touring jacket, model DEMO-JKT-01 (revision 2), personal protective equipment of category II')
    expect(by('maker').text).toBe('Manufacturer: Demo Maker S.r.l., Via Esempio 1, 00000 Demotown, IT.')
    expect(by('maker').source.kind).toBe('COMPANY')
    expect(by('performance').text).toBe('Performance: tested to EN 17092-3:2020; class AA.')
    expect(by('protectors').text).toContain('shoulders (EN 1621-1:2012, level 2; every size) – left and right, on the seam; elbows (EN 1621-1:2012, level 2; sizes 50, 52)')
    expect(by('protectors').text).toContain('Fit: choose the size (48, 50, 52)')
    expect(by('spares').text).toBe('Spare protectors: replace a protector only with one of these, certified for the same zone and at least the same level: shoulders, elbows: Demo shoulder protector (EN 1621-1:2012, level 2, certificate DEMO-PCERT-1).')
    expect(by('notifiedBody').text).toBe('Notified body: Demo Notified Body, Via Organismo 9, 00000 Demotown, IT, number 0000; EU type-examination certificate DEMO-CERT-1.')
    expect(by('docAddress').text).toBe('EU declaration of conformity: available at https://factory.example.org/doc/ABCD2345.')
    expect(by('storage').source).toEqual({ kind: 'TEMPLATE' })
    expect(result.content.protectorPositions.map((entry) => [entry.zone, entry.level, entry.sizes])).toEqual([['shoulder', '2', []], ['elbow', '2', ['50', '52']]])
    expect(result.content.spareProtectors).toEqual([expect.objectContaining({ itemId: P1, zones: ['shoulder', 'elbow'], level: '2', placed: true, certificate: { id: '00000000-0000-4000-8000-000000000071', number: 'DEMO-PCERT-1', validTo: '2030-12-31' } })])
    const codes = result.warnings.map((warning) => warning.code)
    expect(codes.filter((code) => code === 'SPARE_NOT_CERTIFIED')).toHaveLength(2)
    // An AA garment with protectors in pockets asks the "protectors can be taken out" warning: the library lacks it.
    expect(codes).toContain('CLASS_WARNING_MISSING')
  })

  it('writes the Italian original from the built-in words; the library wins where it has the phrase', () => {
    const book = bookOf({ 'userinfo.storage|it': { text: 'Conservare in luogo asciutto.', phraseId: '00000000-0000-4000-8000-000000000091', revision: 3 }, 'warning.protectors-removable|it': { text: 'Le protezioni sono estraibili: la classe vale solo con le protezioni al loro posto.', phraseId: '00000000-0000-4000-8000-000000000092', revision: 1 } })
    const result = composeUserInformation(facts(), 'it', book)
    const storage = result.content.sections.find((section) => section.key === 'storage')!
    expect(storage).toMatchObject({ text: 'Conservare in luogo asciutto.', source: { kind: 'PHRASE', recordType: 'Phrase', recordId: '00000000-0000-4000-8000-000000000091' }, wording: { key: 'userinfo.storage', kind: 'PHRASE', revision: 3 } })
    expect(result.content.sections.find((section) => section.key === 'product')!.text).toContain('Giacca touring demo, modello DEMO-JKT-01')
    expect(result.content.sections.find((section) => section.key === 'protectors')!.text).toContain('spalle (EN 1621-1:2012, livello 2; tutte le taglie)')
    expect(result.content.sections.find((section) => section.key === 'limits')!.text).toContain('Le protezioni sono estraibili')
    expect(result.warnings.map((warning) => warning.code)).not.toContain('CLASS_WARNING_MISSING')
  })

  it('falls back to the built-in words when a library phrase lost a placeholder, and says so', () => {
    const book = bookOf({ 'userinfo.maker|en': { text: 'Made by {maker}.', phraseId: '00000000-0000-4000-8000-000000000093', revision: 1 } })
    const result = composeUserInformation(facts(), 'en', book)
    expect(result.content.sections.find((section) => section.key === 'maker')!.text).toBe('Manufacturer: Demo Maker S.r.l., Via Esempio 1, 00000 Demotown, IT.')
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'PHRASE_PLACEHOLDERS', point: 'maker' }))
  })

  it('refuses what cannot have user information: not PPE, no certificate for category II, no maker, an original in a language the library lacks', () => {
    expect(composeUserInformation(facts({ declaration: declaration({ style: { ...declaration().style, ppeCategory: 'NOT_PPE' } }) }), 'en', emptyBook).blocking.map((problem) => problem.code)).toContain('NOT_PPE')
    expect(composeUserInformation(facts({ declaration: declaration({ certificate: null }) }), 'en', emptyBook).blocking.map((problem) => problem.code)).toEqual(['NO_CERTIFICATE'])
    expect(composeUserInformation(facts({ declaration: declaration({ maker: null }) }), 'en', emptyBook).blocking.map((problem) => problem.code)).toEqual(['NO_MAKER'])
    const german = composeUserInformation(facts(), 'de', emptyBook)
    expect(german.blocking.every((problem) => problem.code === 'PHRASE_MISSING')).toBe(true)
    expect(german.blocking.length).toBeGreaterThan(10)
  })

  it('category I names no notified body; no placements: "no impact protectors", no spares section, and the class warning about it', () => {
    const result = composeUserInformation(facts({ declaration: declaration({ style: { ...declaration().style, ppeCategory: 'CATEGORY_I' }, certificate: null }), placements: [], spareCandidates: [] }), 'en', emptyBook)
    expect(result.blocking).toEqual([])
    expect(result.content.sections.find((section) => section.key === 'notifiedBody')!.text).toContain('none; category I PPE')
    expect(result.content.sections.find((section) => section.key === 'protectors')!.text).toContain('this garment holds no impact protectors')
    expect(result.content.sections.find((section) => section.key === 'spares')).toBeUndefined()
    expect(result.warnings.map((warning) => warning.code)).toContain('NO_PROTECTORS')
  })

  it('a translation keeps the original words where the library has none (UNTRANSLATED) and starts IN_TRANSLATION', () => {
    const original = composeUserInformation(facts(), 'it', emptyBook)
    const book = bookOf({ 'userinfo.storage|de': { text: 'Trocken lagern.', phraseId: '00000000-0000-4000-8000-000000000094', revision: 1 } })
    const german = composeUserInformation(facts(), 'de', book, original.content.sections)
    expect(german.blocking).toEqual([])
    expect(german.content.sections.find((section) => section.key === 'storage')!.text).toBe('Trocken lagern.')
    expect(german.content.sections.find((section) => section.key === 'maker')).toMatchObject({ text: original.content.sections.find((section) => section.key === 'maker')!.text, source: { kind: 'UNTRANSLATED' } })
    expect(startingState(german.content.sections)).toBe('IN_TRANSLATION')
    expect(sectionsToType(german.content.sections)).not.toContain('storage')
    expect(german.warnings.map((warning) => warning.code)).toContain('POSITION_NOTE_AS_TYPED')
    // English has the built-in words: nothing waits.
    const english = composeUserInformation(facts(), 'en', emptyBook, original.content.sections)
    expect(startingState(english.content.sections)).toBe('DRAFT')
  })

  it('a section a person typed in the original stays the original words in a translation', () => {
    const original = composeUserInformation(facts(), 'it', emptyBook)
    const typed = applyEdits(original.content.sections, [{ key: 'use', text: 'Uso: testo scritto a mano.' }], AUTHOR)
    const english = composeUserInformation(facts(), 'en', emptyBook, typed)
    expect(english.content.sections.find((section) => section.key === 'use')).toMatchObject({ text: 'Uso: testo scritto a mano.', source: { kind: 'UNTRANSLATED' } })
  })
})

describe('spare protectors (PRD-354)', () => {
  it('lists a protector only with a certificate valid today for the standard family at the level each zone asks', () => {
    const { spares, uncertified } = spareProtectors(placements, candidates)
    expect(spares.map((spare) => spare.itemId)).toEqual([P1])
    expect(uncertified.map((entry) => entry.code)).toEqual(['DEMO-PROT-L1', 'DEMO-PROT-X2'])
    // A level 1 pocket takes the level 1 alternate.
    const level1 = placements.map((placement) => ({ ...placement, level: '1' }))
    expect(spareProtectors(level1, candidates).spares.map((spare) => spare.code)).toEqual(['DEMO-PROT-S2', 'DEMO-PROT-L1'])
    // Another standard family never serves.
    const back = [{ ...placements[0]!, pocket: 'BACK', standard: 'EN 1621-2:2014' }]
    expect(spareProtectors(back, candidates).spares).toEqual([])
  })
})

describe('typed words, refresh and stale sections', () => {
  const composed = composeUserInformation(facts(), 'en', emptyBook).content

  it('checks the typed sections', () => {
    expect(sectionEditProblems([{ key: 'use', text: 'x' }])).toEqual([])
    expect(sectionEditProblems([{ key: 'nope', text: 'x' }, { key: 'use', text: ' ' }]).map((problem) => problem.path)).toEqual(['body/sections/0/key', 'body/sections/1/text'])
    expect(sectionEditProblems([{ key: 'use', text: 'a' }, { key: 'use', text: 'b' }]).map((problem) => problem.message)).toEqual(['Section use is given twice.'])
  })

  it('a typed section names its typist, survives a refresh and is never stale', () => {
    const typed = applyEdits(composed.sections, [{ key: 'cleaning', text: 'Cleaning: by hand only.' }], AUTHOR)
    expect(typed.find((section) => section.key === 'cleaning')!.source).toEqual({ kind: 'TYPED', recordType: 'User', recordId: AUTHOR })
    const fresh = composeUserInformation(facts({ bodyAddress: null }), 'en', emptyBook).content.sections
    const kept = keepTyped(fresh, typed)
    expect(kept.find((section) => section.key === 'cleaning')!.text).toBe('Cleaning: by hand only.')
    expect(kept.map((section) => section.key)).toEqual([...SECTION_KEYS])
    expect(differences(typed, fresh).map((difference) => difference.key)).toEqual(['notifiedBody'])
  })

  it('says when the protector positions or the spares changed against the records', () => {
    expect(listsChanged(composed, composed)).toEqual({ positions: false, spares: false })
    const expired = composeUserInformation(facts({ spareCandidates: candidates.map((candidate) => ({ ...candidate, certificates: candidate.certificates.map((entry) => ({ ...entry, valid: false })) })) }), 'en', emptyBook).content
    expect(listsChanged(composed, expired)).toEqual({ positions: false, spares: true })
  })

  it('reads back what it stores', () => {
    const stored = JSON.parse(JSON.stringify(sectionsJson(composed)))
    expect(sectionsOf(stored)).toEqual(composed)
    expect(sectionsOf(null)).toEqual({ template: TEMPLATE_ID, sections: [], protectorPositions: [], spareProtectors: [] })
  })

  it('names the sources in words', () => {
    expect(sourceWords({ kind: 'PROTECTOR_PLACEMENT', recordType: 'ProtectorPlacement', recordId: PL1 }, { [PL1]: '1 (shoulder)' })).toBe('from protector placement 1 (shoulder)')
    expect(sourceWords({ kind: 'PUBLIC_DOC' })).toBe("from the style's public DoC page")
    expect(sourceWords({ kind: 'CERTIFICATE', recordType: 'Certificate', recordId: CERT }, { [CERT]: 'DEMO-CERT-1' })).toBe('from certificate DEMO-CERT-1')
  })

  it('reads a standard code', () => {
    expect(standardCodeOf('EN 17092-3:2020')).toBe('EN 17092')
    expect(standardCodeOf('EN 13594:2015')).toBe('EN 13594')
  })
})

describe('translations', () => {
  const original = composeUserInformation(facts(), 'it', emptyBook).content.sections
  const german = composeUserInformation(facts(), 'de', emptyBook, original).content.sections

  it('a language once per revision, never the original', () => {
    expect(translationRefusal({ originalLanguage: 'it', language: 'de', taken: ['it', 'de'] })).toEqual({ code: 'TAKEN', message: 'This revision already has generated user information in de: open it.' })
    expect(translationRefusal({ originalLanguage: 'it', language: 'it', taken: [] })?.code).toBe('SOURCE_LANGUAGE')
    expect(translationRefusal({ originalLanguage: 'it', language: 'fr', taken: ['it'] })).toBeNull()
  })

  it('is checked by a second person once every section is typed, never by its author or a typist', () => {
    const base = { status: 'DRAFT', translationState: 'IN_TRANSLATION' as const, authorId: AUTHOR, checkerId: CHECKER }
    expect(checkRefusal({ ...base, sections: german })).toMatchObject({ code: 'WORDS_MISSING', message: expect.stringMatching(/^Sections .* still hold the original's words: type them first\.$/) })
    const typed = applyEdits(german, sectionsToType(german).map((key) => ({ key, text: `[de] ${key}` })), CHECKER)
    expect(checkRefusal({ ...base, sections: typed })?.code).toBe('OWN_WORDS')
    const byOther = applyEdits(german, sectionsToType(german).map((key) => ({ key, text: `[de] ${key}` })), '00000000-0000-4000-8000-000000000033')
    expect(checkRefusal({ ...base, sections: byOther })).toBeNull()
    expect(checkRefusal({ ...base, checkerId: AUTHOR, sections: byOther })?.code).toBe('OWN_TRANSLATION')
    expect(checkRefusal({ ...base, translationState: null, sections: original })?.code).toBe('NOT_A_TRANSLATION')
  })
})

describe('language packs per market (PRD-351) and the version per batch (PRD-352)', () => {
  const markets: PackMarket[] = [
    { code: 'IT', name: 'Italy', companyId: null, userInfoLanguages: ['it'], switchedOn: true },
    { code: 'DE', name: 'Germany', companyId: null, userInfoLanguages: ['de'], switchedOn: true },
    { code: 'CH', name: 'Switzerland', companyId: null, userInfoLanguages: ['de', 'fr', 'it'], switchedOn: false },
    { code: 'XX', name: 'Other company', companyId: '00000000-0000-4000-8000-0000000000aa', userInfoLanguages: ['es'], switchedOn: true },
  ]
  const doc = (id: string, language: string, over: Partial<PackDocument> = {}): PackDocument => ({ id, language, revision: 2, status: 'DRAFT', origin: 'GENERATED', translationOfId: null, translationStatus: null, marketCode: null, number: null, ...over })
  const documents: PackDocument[] = [
    doc('00000000-0000-4000-8000-0000000000b1', 'it', { origin: 'SIGNED', status: 'ISSUED', number: 'UI-1' }),
    doc('00000000-0000-4000-8000-0000000000b2', 'it'),
    doc('00000000-0000-4000-8000-0000000000b3', 'de', { translationOfId: '00000000-0000-4000-8000-0000000000b2', translationStatus: 'CHECKED' }),
  ]

  it('per market of the company: each language it asks, the signed leaflet first, else the generated draft', () => {
    const packs = languagePacks(markets, documents, '00000000-0000-4000-8000-0000000000bb')
    expect(packs.map((pack) => pack.market.code)).toEqual(['IT', 'DE', 'CH'])
    expect(packs[0]).toMatchObject({ live: true, missing: [], languages: [{ language: 'it', state: 'ISSUED' }] })
    expect(packs[1]).toMatchObject({ live: false, missing: [], languages: [{ language: 'de', state: 'CHECKED' }] })
    expect(packs[2]).toMatchObject({ live: false, missing: ['fr'] })
    expect(packLanguage('fr', [doc('00000000-0000-4000-8000-0000000000b4', 'fr', { status: 'WITHDRAWN' })]).state).toBe('WITHDRAWN')
  })

  it('the translations a pack still needs, with the market each is made for', () => {
    expect(packTranslations(markets, ['CH'], 'it', ['de'])).toEqual([{ language: 'fr', marketCode: 'CH' }])
    expect(packTranslations(markets, ['DE', 'CH'], 'it', [])).toEqual([{ language: 'de', marketCode: null }, { language: 'fr', marketCode: 'CH' }])
  })

  it('which leaflet goes with a batch: the recorded ones, else the signed leaflets of the revision the work order froze', () => {
    const workOrder = { id: '00000000-0000-4000-8000-0000000000c1', number: 'WO-1', batchNumber: 'BT-1', styleId: STYLE, revision: 2 }
    const none = batchLeaflets({ workOrder, batchNumber: 'BT-1', records: [], documents })
    expect(none.leaflets).toEqual([{ language: 'it', documentId: '00000000-0000-4000-8000-0000000000b1', number: 'UI-1', revision: 2, status: 'ISSUED', recorded: null }])
    expect(none.drafts.map((draft) => draft.language)).toEqual(['de', 'it'])
    const recorded = batchLeaflets({ workOrder, batchNumber: 'BT-1', records: [{ documentId: '00000000-0000-4000-8000-0000000000b1', batchNumber: 'BT-1', workOrderId: workOrder.id, shipmentId: '00000000-0000-4000-8000-0000000000d1' }], documents })
    expect(recorded.leaflets).toEqual([expect.objectContaining({ language: 'it', recorded: { shipmentIds: ['00000000-0000-4000-8000-0000000000d1'] } })])
  })
})
