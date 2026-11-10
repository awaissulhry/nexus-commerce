import { describe, expect, it } from 'vitest'
import { CELL_STATES } from '@nexus/factory-domain/compliance/declarations/coverage'
import { SECTION_KEYS } from '@nexus/factory-domain/compliance/user-information/template'
import { PACK_STATES } from '@nexus/factory-domain/compliance/user-information/packs'
import { PROTECTOR_POCKETS } from '@nexus/factory-domain/product/protectors/rules'
import { ApiError } from '../../../lib/api/errors'
import en from '../../../../messages/en/compliance-declarations.json'
import it_ from '../../../../messages/it/compliance-declarations.json'
import { COVERAGE, DRAFT_DE, DRAFT_EN, DRAFT_IT, GLV, JKT, LUCA, MARTA, RECORD_DE, RECORD_DRAFT, RECORD_LEAFLET, RECORD_SIGNED, ROLES_DEMO, ROWS, SIGNED_IT, TIMELINE, docDetail } from './_demo/fixtures'
import {
  addressOf,
  addressText,
  BLOCKING,
  cellAction,
  checkHeld,
  countsOf,
  declarationsCan,
  draftOf,
  editHeld,
  editOf,
  EMPTY_ADDRESS,
  gapsOf,
  issueChecks,
  issueHeld,
  languageCheck,
  newDeclarationHref,
  originalOf,
  problemCodeKey,
  problemOf,
  recordAddressOf,
  recordAddressText,
  recordOfDeclaration,
  saveHeld,
  sourceKey,
  tileChange,
  tileOf,
  translateHeld,
  treeRows,
  typistsOf,
  withAddress,
  withdrawHeld,
  withdrawPhrase,
} from './model'

/**
 * B-W2b-268 — the pure rules of Declarations & instructions: the addresses, the tiles as saved filters, the grid's tree order,
 * the coverage's gaps and what a cell does, a DoC and a leaflet as one record, the Content draft and what it sends, the issue
 * review that never passes for a generated document (GATE-PPE-TEXTS, Owner 11-09 B), the holds of withdraw / translate / check,
 * and every code said in words in both languages.
 */

type Tree = { [key: string]: string | Tree }
const has = (tree: Tree, key: string): boolean => {
  const found = key.split('.').reduce<string | Tree | undefined>((node, part) => (node && typeof node === 'object' ? node[part] : undefined), tree)
  if (typeof found === 'string') return true
  return typeof key.split('.').reduce<string | Tree | undefined>((node, part, index, parts) => (node && typeof node === 'object' ? node[index === parts.length - 1 ? `${part}_other` : part] : undefined), tree) === 'string'
}
const QUALITY = declarationsCan(ROLES_DEMO.quality)
const READ_ONLY = declarationsCan(ROLES_DEMO.readOnly)

describe('who may do what (the role templates)', () => {
  it('the quality inspector makes and checks both kinds; read-only only reads; sales sees nothing', () => {
    expect(QUALITY).toMatchObject({ view: true, generate: true, check: true, uiGenerate: true, uiCheck: true })
    expect(READ_ONLY.view).toBe(true)
    expect(READ_ONLY.generate || READ_ONLY.uiGenerate).toBe(false)
    expect(declarationsCan(ROLES_DEMO.sales).view).toBe(false)
    expect(declarationsCan(ROLES_DEMO.warehouse).pack).toBe(true)
  })
})

describe('the page address', () => {
  it('reads the API filters and the dialogs, drops what is not one, and writes them back the same', () => {
    const params = new URLSearchParams('kind=USER_INFORMATION&status=DRAFT&origin=GENERATED&language=de&q=GIA&gaps=1&new=1&style=s1&newKind=USER_INFORMATION&lang=fr&check=1&unrecorded=1')
    const address = addressOf(params)
    expect(address).toEqual({ kind: 'USER_INFORMATION', status: 'DRAFT', origin: 'GENERATED', language: 'de', q: 'GIA', gaps: true, add: true, newStyle: 's1', newKind: 'USER_INFORMATION', newLanguage: 'fr', check: true, unrecorded: true })
    expect(addressOf(new URLSearchParams(addressText(address).slice(1)))).toEqual(address)
    expect(addressOf(new URLSearchParams('kind=OTHER&status=GONE&language=Deutsch'))).toEqual(EMPTY_ADDRESS)
  })
  it('closing New declaration forgets its prefill', () => {
    expect(withAddress({ ...EMPTY_ADDRESS, add: true, newStyle: 's1', newLanguage: 'de' }, { add: false })).toEqual(EMPTY_ADDRESS)
    expect(newDeclarationHref('/w/DEMO', { styleId: 's1', kind: 'USER_INFORMATION' })).toBe('/w/DEMO/compliance/declarations?new=1&style=s1&newKind=USER_INFORMATION')
  })
  it('the record address: the tab, the dialog, edit mode', () => {
    const address = recordAddressOf(new URLSearchParams('tab=batches&do=withdraw&edit=1'))
    expect(address).toEqual({ tab: 'batches', dialog: 'withdraw', edit: true })
    expect(recordAddressText({ tab: 'content', dialog: null, edit: false })).toBe('')
    expect(recordAddressOf(new URLSearchParams('tab=x&do=issue-now'))).toEqual({ tab: 'content', dialog: null, edit: false })
  })
})

describe('the tiles are saved filters', () => {
  it('a tile sets its filter, a second click clears it; the fifth opens the batches without a version', () => {
    expect(tileChange('issued', EMPTY_ADDRESS)).toEqual({ status: 'ISSUED' })
    expect(tileChange('issued', { ...EMPTY_ADDRESS, status: 'ISSUED' })).toEqual({ status: null })
    expect(tileChange('languagesMissing', EMPTY_ADDRESS)).toEqual({ gaps: true })
    expect(tileChange('batchesShippedWithoutVersion', EMPTY_ADDRESS)).toEqual({ unrecorded: true })
    expect(tileOf({ ...EMPTY_ADDRESS, status: 'SUPERSEDED' })).toBe('supersededIn30Days')
    expect(tileOf({ ...EMPTY_ADDRESS, gaps: true, status: 'DRAFT' })).toBe('languagesMissing')
  })
})

describe('the grid', () => {
  it('orders style › kind (DoC first) › revision (newest first) › the original before its translations', () => {
    const tree = treeRows([...ROWS].reverse())
    expect(tree.map((row) => row.number)).toEqual([
      `DoC-${JKT.code}-IT-r2`,
      `DoC-${JKT.code}-DE-r2`,
      `DoC-${JKT.code}-EN-r2`,
      `DoC-${JKT.code}-IT-r1`,
      `UI-${JKT.code}-IT-r2`,
      'DoC-PNT-DEMO-02-IT-r1',
      'DoC-PNT-DEMO-02-IT-r0',
    ])
    expect(tree.map((row) => [row.firstOfStyle, row.firstOfKind])).toEqual([
      [true, true],
      [false, false],
      [false, false],
      [false, false],
      [false, true],
      [true, true],
      [false, false],
    ])
  })
  it('finds the generated original of a revision (never a signed one, a translation or a withdrawn one)', () => {
    expect(originalOf(ROWS, JKT.id, 'DECLARATION_OF_CONFORMITY', 2)?.id).toBe(DRAFT_IT.id)
    expect(originalOf(ROWS, JKT.id, 'DECLARATION_OF_CONFORMITY', 1)).toBeNull()
    expect(originalOf(ROWS.map((row) => (row.id === DRAFT_IT.id ? { ...row, status: 'WITHDRAWN' as const } : row)), JKT.id, 'DECLARATION_OF_CONFORMITY', 2)).toBeNull()
  })
})

describe('the language coverage', () => {
  const jacketDoc = COVERAGE.rows[0]!
  it('a cell opens its document, a missing one is translated from the original, else New declaration', () => {
    expect(cellAction(jacketDoc, 'de', ROWS, QUALITY)).toEqual({ kind: 'open', documentId: DRAFT_DE.id })
    expect(cellAction(jacketDoc, 'fr', ROWS, QUALITY)).toEqual({ kind: 'translate', originalId: DRAFT_IT.id, language: 'fr' })
    expect(cellAction(COVERAGE.rows[4]!, 'en', ROWS, QUALITY)).toEqual({ kind: 'new', language: 'en' })
    expect(cellAction(jacketDoc, 'fr', ROWS, READ_ONLY)).toEqual({ kind: 'none' })
    expect(cellAction(COVERAGE.rows[2]!, 'de', ROWS, QUALITY)).toEqual({ kind: 'none' })
  })
  it('the language check: gaps first, each row with its original or why not', () => {
    const rows = languageCheck(COVERAGE, ROWS, QUALITY)
    expect(rows.map((row) => [row.row.style.code, row.row.kind, row.gaps.join(), row.held])).toEqual([
      [JKT.code, 'USER_INFORMATION', 'de,en,fr', null],
      [GLV.code, 'DECLARATION_OF_CONFORMITY', 'en,it', 'held.noOriginal'],
      [JKT.code, 'DECLARATION_OF_CONFORMITY', 'fr', null],
      ['PNT-DEMO-02', 'USER_INFORMATION', 'it', 'held.noOriginal'],
      ['PNT-DEMO-02', 'DECLARATION_OF_CONFORMITY', '', 'held.noGaps'],
    ])
    expect(gapsOf(COVERAGE.rows[2]!)).toEqual([])
    expect(languageCheck(COVERAGE, ROWS, READ_ONLY).filter((row) => row.held === null)).toEqual([])
  })
})

describe('one record', () => {
  it('a DoC: its points with the law each answers and what is still open, its counts from the timeline', () => {
    expect(RECORD_DRAFT.parts.map((part) => part.law)).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9'])
    expect(RECORD_DE.parts.filter((part) => part.open).map((part) => part.id)).toEqual(['3', '9'])
    expect(RECORD_SIGNED.row.batches).toBe(2)
    expect(RECORD_SIGNED.row.shipments).toBe(1)
    expect(countsOf('other', TIMELINE)).toEqual({ batches: 0, shipments: 0 })
  })
  it('a leaflet: its sections with their Annex II point, the protectors and the spares, stale lists', () => {
    expect(RECORD_LEAFLET.parts.map((part) => part.law)).toContain('1.4(l)')
    expect(RECORD_LEAFLET.positions).toHaveLength(2)
    expect(RECORD_LEAFLET.stale?.lists).toEqual({ positions: false, spares: true })
    expect(RECORD_LEAFLET.publicAddress).toBe('https://factory.example.com/doc/WVGDAEHC')
  })
})

describe('the Content draft', () => {
  it('sends only what changed, trimmed; the signatory only on the original DoC', () => {
    const draft = draftOf(RECORD_DRAFT)
    expect(editOf(RECORD_DRAFT, draft)).toBeNull()
    expect(saveHeld(RECORD_DRAFT, draft, false)).toBe('held.nothingChanged')
    const changed = { ...draft, parts: { ...draft.parts, '8': '  Non applicabile.  ' }, signedPlace: 'Esempiopoli' }
    expect(editOf(RECORD_DRAFT, changed)).toEqual({ parts: [{ id: '8', text: 'Non applicabile.' }], signedPlace: 'Esempiopoli' })
    expect(saveHeld(RECORD_DRAFT, changed, false)).toBeNull()
    expect(saveHeld(RECORD_DRAFT, { ...changed, parts: { ...changed.parts, '1': ' ' } }, false)).toBe('held.emptyPart')
    expect(editOf(RECORD_DE, { ...draftOf(RECORD_DE), signedPlace: 'X' })).toBeNull()
  })
  it('a signed file, a checked translation and a role without the right cannot be typed', () => {
    expect(editHeld(RECORD_DRAFT)).toBeNull()
    expect(editHeld(RECORD_SIGNED)).toBe('held.signedFile')
    expect(editHeld(recordOfDeclaration(docDetail(DRAFT_EN)))).toBe('held.checkedEdit')
    expect(editHeld({ ...RECORD_LEAFLET, may: { ...RECORD_LEAFLET.may, edit: false } })).toBe('held.uiGenerate')
  })
})

describe('Issue (GATE-PPE-TEXTS: a generated document is never issued here)', () => {
  it('the review lists what is ready, and the gate is always open', () => {
    const checks = issueChecks(RECORD_DRAFT)
    expect(checks.map((check) => [check.id, check.state])).toEqual([
      ['parts', 'OK'],
      ['signatory', 'OK'],
      ['records', 'OK'],
      ['gate', 'OPEN'],
    ])
    expect(issueChecks(RECORD_DE).find((check) => check.id === 'parts')).toMatchObject({ state: 'OPEN', key: 'issue.check.toType', params: { list: '3, 9' } })
    expect(issueChecks(RECORD_DE).find((check) => check.id === 'checked')?.state).toBe('OPEN')
    expect(issueHeld(RECORD_DRAFT)).toBe('held.gate')
    expect(issueHeld(RECORD_SIGNED)).toBe('held.issuedAlready')
  })
})

describe('withdraw, translate, check', () => {
  it('withdraw asks the reason and the number typed exactly', () => {
    const phrase = withdrawPhrase(RECORD_DRAFT, 'WITHDRAW')
    expect(phrase).toBe(DRAFT_IT.number)
    expect(withdrawHeld(RECORD_DRAFT, 'no', phrase, phrase, false)).toBe('held.reason')
    expect(withdrawHeld(RECORD_DRAFT, 'Replaced by revision 3', 'DoC', phrase, false)).toBe('held.phrase')
    expect(withdrawHeld(RECORD_DRAFT, 'Replaced by revision 3', phrase, phrase, false)).toBeNull()
    expect(withdrawHeld(RECORD_SIGNED, 'Replaced', phrase, phrase, false)).toBe('held.signedWithdraw')
  })
  it('translations are added to the original only, with a language chosen', () => {
    expect(translateHeld(RECORD_DRAFT, [], [], false)).toBe('held.chooseLanguage')
    expect(translateHeld(RECORD_DRAFT, ['fr'], [], false)).toBeNull()
    expect(translateHeld(RECORD_DE, ['fr'], [], false)).toBe('held.translateOriginal')
    expect(translateHeld(RECORD_SIGNED, ['fr'], [], false)).toBe('held.signedTranslate')
    expect(translateHeld(RECORD_LEAFLET, [], ['DE'], false)).toBeNull()
  })
  it('a check: never with words to type, never by someone who typed its words', () => {
    expect(checkHeld(RECORD_DRAFT, MARTA.id, [])).toBe('held.notTranslation')
    expect(checkHeld(RECORD_DE, MARTA.id, [])).toBe('refusal.WORDS_MISSING')
    const ready = { ...RECORD_DE, toType: [], parts: RECORD_DE.parts.map((part) => ({ ...part, open: false, source: part.id === '3' ? { kind: 'TYPED', recordType: 'User', recordId: LUCA.id } : part.source })), row: { ...RECORD_DE.row, translationStatus: 'DRAFT' as const } }
    expect(typistsOf(ready)).toEqual([LUCA.id])
    expect(checkHeld(ready, LUCA.id, typistsOf(ready))).toBe('refusal.OWN_WORDS')
    expect(checkHeld(ready, MARTA.id, typistsOf(ready))).toBeNull()
  })
})

describe('refusals and words', () => {
  const refusal = (code: string) => new ApiError('conflict', 409, 'conflict', 'English words', null, [{ path: `refusal/${code}`, message: 'English words' }])
  it('a refusal by its code, else by the kind of answer; the API English is never the key', () => {
    expect(problemOf(refusal('OWN_TRANSLATION')).key).toBe('refusal.OWN_TRANSLATION')
    expect(problemOf(refusal('SOMETHING_NEW')).key).toBe('refusal.OTHER')
    expect(problemOf(new ApiError('conflict', 409, 'conflict', 'x')).key).toBe('problem.conflict')
    expect(problemOf(new ApiError('invalid', 400, 'invalid', 'x', null, [{ path: 'body/companyId', message: 'x' }]))).toEqual({ key: 'problem.company', field: 'companyId' })
    expect(problemOf(new Error('x')).key).toBe('problem.unavailable')
  })
  it('every code, state and source has words in both catalogues', () => {
    const keys = [
      ...['NOT_PPE', 'NO_REVISION', 'NO_MAKER', 'NO_CERTIFICATE', 'PHRASE_MISSING', 'STANDARD_NOT_IN_FORCE', 'POINT8_TO_TYPE', 'NO_CLASS', 'PLACEMENT_SIZE_GAP', 'UNKNOWN'].map(problemCodeKey),
      ...[...BLOCKING, 'EXISTS', 'WITHDRAWN', 'TAKEN', 'OWN_WORDS', 'DATABASE', 'OTHER'].map((code) => `refusal.${code}`),
      ...CELL_STATES.map((state) => `cell.${state}`),
      ...PACK_STATES.map((state) => `pack.${state}`),
      ...SECTION_KEYS.map((key) => `section.${key}`),
      ...PROTECTOR_POCKETS.map((pocket) => `zone.${pocket}`),
      ...['STYLE', 'TYPED', 'UNTRANSLATED', 'TO_TYPE', 'PROTECTOR_PLACEMENT', 'SOMETHING'].map((kind) => sourceKey({ kind })),
    ]
    for (const key of keys) {
      expect(has(en as Tree, key), `en ${key}`).toBe(true)
      expect(has(it_ as Tree, key), `it ${key}`).toBe(true)
    }
  })
  it('the made-up rows hold no real business data (design-only fixtures)', () => {
    expect(SIGNED_IT.maker.name).toContain('Demo')
    expect(ROWS.every((row) => row.style.code.includes('DEMO'))).toBe(true)
  })
})
