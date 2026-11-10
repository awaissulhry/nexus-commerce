import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { renderLabel } from '@nexus/factory-domain/compliance/labels/render'
import type { DesignScreen } from '../../../../lib/design/design-screen'
import { CATALOGUE, messagesFor } from '../../../../lib/i18n/messages'
import { LOCALES } from '../../../../lib/i18n/locales'
import { I18nProvider } from '../../../../lib/i18n/provider'
import { designScreen as compositionScreen } from '../composition/fixtures'
import { CAN, GLOVES_R1, JACKET_R1, JACKET_R2, ROWS, SHARED_R1, TSHIRT_R1, valuesFor, VEST_R1 } from '../demo'
import { designScreen as listScreen } from '../fixtures'
import { draftOf, factsOf, sheetOf, tileCounts, valuesOf, viewRows } from '../model'
import { designScreen as recordScreen } from '../record/fixtures'
import { DEPTH_CAN, demoArtwork, demoChecks, demoPhrases, demoTextile, listDepth, MARKETS, ME, TEXTS } from './demo'
import {
  addProofHeld,
  approveHeld,
  approveTranslationHeld,
  compositionDraft,
  currentVersion,
  fillFromLibrary,
  gapsOf,
  kindOf,
  labelPhraseSpecs,
  languageColumns,
  listPhraseKeys,
  listWarningKeys,
  marketShown,
  markingDirty,
  markingPatch,
  markingProblem,
  marketsFor,
  NO_DEPTH,
  phraseRows,
  proofFileProblem,
  proposeHeld,
  removeHeld,
  retireHeld,
  rowsBlock,
  sameComposition,
  translationGaps,
  warningReasonOf,
} from './model'

const NS = 'compliance-labels-depth'

describe('the list: kinds, proofs waiting, markets a label cannot print for', () => {
  it('a row without a kind is W1’s PPE garment label', () => {
    expect(kindOf(JACKET_R1)).toBe('PPE_GARMENT')
    expect(kindOf(GLOVES_R1)).toBe('GLOVE_MARKING')
    expect(kindOf(TSHIRT_R1)).toBe('FIBRE_CARE')
  })
  it('asks the class B and C warnings of an EN 17092 PPE garment label only (protectors need the revision)', () => {
    const classC = { ...JACKET_R1, style: { ...JACKET_R1.style!, ppeStandard: 'EN 17092-6:2020', ppeClass: 'C' } }
    expect(listWarningKeys(classC)).toEqual(['warning.class-c'])
    expect(listWarningKeys({ ...classC, kind: 'FIBRE_CARE' })).toEqual([])
    expect(listWarningKeys(JACKET_R1)).toEqual([])
    expect(listWarningKeys(GLOVES_R1)).toEqual([])
    expect(listPhraseKeys([classC, { ...classC, id: 'x', status: 'RETIRED', style: { ...classC.style, ppeClass: 'B' } }])).toEqual(['warning.class-c'])
  })
  it('a switched-on market of the label’s company blocks it for a language it lacks or a warning without approved words', () => {
    expect(marketsFor(JACKET_R1, MARKETS).map((market) => market.code)).toEqual(['IT', 'DE', 'FR', 'CH'])
    const gaps = translationGaps(JACKET_R1, MARKETS, TEXTS)
    expect(gaps.map((gap) => [gap.market, gap.languages])).toEqual([
      ['DE', ['de']],
      ['FR', ['fr']],
      ['CH', ['de', 'fr']],
    ])
    const classC = { ...JACKET_R1, languages: ['it', 'de', 'fr'], style: { ...JACKET_R1.style!, ppeStandard: 'EN 17092-6:2020', ppeClass: 'C' } }
    const texts = [{ key: 'warning.class-c', language: 'it', text: 'Avvertenza C.', revision: 1 }, { key: 'warning.class-c', language: 'de', text: null, revision: 1 }]
    expect(translationGaps(classC, MARKETS, texts)).toEqual([
      { market: 'DE', marketName: 'Germania', languages: [], phrases: [{ key: 'warning.class-c', languages: ['de'] }] },
      { market: 'FR', marketName: 'Francia', languages: [], phrases: [{ key: 'warning.class-c', languages: ['fr'] }] },
      { market: 'CH', marketName: 'Svizzera', languages: [], phrases: [{ key: 'warning.class-c', languages: ['de', 'fr'] }] },
    ])
    // A retired label prints nothing; a market of another company is not the label's.
    expect(translationGaps({ ...JACKET_R1, status: 'RETIRED' }, MARKETS, TEXTS)).toEqual([])
    expect(marketsFor({ companyId: 'a' }, [{ ...MARKETS[1]!, companyId: 'b' }])).toEqual([])
  })
  it('the views and tiles count from their own reads; unknown is "—", being read is a skeleton', () => {
    const depth = listDepth()
    expect(viewRows(ROWS, 'artwork', '', depth).map((row) => row.id).sort()).toEqual([GLOVES_R1.id, JACKET_R2.id].sort())
    expect(viewRows(ROWS, 'translations', '', depth).length).toBe(gapsOf(ROWS, MARKETS, TEXTS).size)
    expect(viewRows(ROWS, 'artwork', '', NO_DEPTH)).toEqual([])
    const tiles = tileCounts(ROWS, false, depth)
    expect(tiles.artwork).toEqual({ count: 2, atLeast: false })
    expect(tileCounts(ROWS, false, NO_DEPTH).translations).toEqual({ count: undefined, atLeast: false })
    expect(tileCounts(ROWS, false, { ...NO_DEPTH, waitingFailed: true }).artwork).toEqual({ count: null, atLeast: false })
    expect(tileCounts(ROWS, false).active.count).toBe(2)
  })
})

describe('the record: marking, composition, rules', () => {
  it('Save sends only the marking that changed; an empty contact is none; a long one is held', () => {
    expect(markingPatch(TSHIRT_R1, null)).toEqual({})
    expect(markingPatch(TSHIRT_R1, { kind: 'FIBRE_CARE', qrTarget: 'NONE', gpsrContact: `  ${TSHIRT_R1.gpsrContact}  ` })).toEqual({})
    expect(markingPatch(TSHIRT_R1, { kind: 'PACKAGING', qrTarget: 'STYLE_DOC', gpsrContact: '' })).toEqual({ kind: 'PACKAGING', qrTarget: 'STYLE_DOC', gpsrContact: null })
    expect(markingDirty(JACKET_R1, { kind: 'PPE_GARMENT', qrTarget: 'BATCH_DOC', gpsrContact: '' })).toBe(false)
    expect(markingProblem({ kind: 'PPE_GARMENT', qrTarget: 'NONE', gpsrContact: 'x'.repeat(501) })).toBe('marking.problem.long')
  })
  it('the BOM’s parts become the builder’s in the label’s language, official names, parts without fibres left out', () => {
    const parts = demoTextile().composition[0]!.parts
    expect(compositionDraft(parts, 'it')).toEqual([
      { part: 'Tessuto esterno', fibres: [{ fibre: 'poliammide', percent: '80' }, { fibre: 'poliestere', percent: '20' }] },
      { part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] },
    ])
    expect(compositionDraft(parts, 'de')[0]!.fibres[0]!.fibre).toBe('polyamide')
    expect(sameComposition(compositionDraft(parts, 'it'), [{ part: 'tessuto esterno ', fibres: [{ fibre: 'Poliammide', percent: '80.0' }, { fibre: 'poliestere', percent: '20' }] }, { part: 'Fodera', fibres: [{ fibre: 'poliestere', percent: '100' }] }])).toBe(true)
  })
  it('shows the market asked, else the first that blocks', () => {
    const checks = demoChecks()
    // Every market blocks while the warning waits for the PPE consultant (IT) or lacks a language (DE, FR, CH).
    expect(marketShown(checks, null)).toBe('IT')
    expect(marketShown(checks, 'CH')).toBe('CH')
    expect(marketShown(checks, 'XX')).toBe('IT')
    expect(marketShown({ ...checks, markets: checks.markets.map((entry) => ({ ...entry, blocks: entry.market?.code === 'FR' })) }, null)).toBe('FR')
  })
  it('draws a QR from the block’s address and a box while the batch is not known (B-W2b-253: graphic null)', () => {
    const values = valuesOf(valuesFor('jacket'))
    const label = renderLabel({ ...factsOf(JACKET_R1, draftOf(JACKET_R1)), qrTarget: 'BATCH_DOC' }, { ...values, qr: { kind: 'BATCH', address: 'https://doc.example.com/doc/0F711ES7', printed: '0F71-1ES7', recordType: 'WorkOrder', recordId: 'x', reference: 'WO-1' } })
    const words = { name: 'L', ce: 'CE', pictogram: () => 'P', care: (text: string) => text, qr: 'QR at print' }
    const sheet = sheetOf(JSON.parse(JSON.stringify(label)), 50, 80, words)
    expect(JSON.stringify(sheet.layout.blocks)).toContain('"kind":"qr","value":"https://doc.example.com/doc/0F711ES7"')
    const box = sheetOf(JSON.parse(JSON.stringify(renderLabel({ ...factsOf(JACKET_R1, draftOf(JACKET_R1)), qrTarget: 'BATCH_DOC' }, { ...values, qr: { kind: 'BATCH', address: null, printed: null, recordType: null, recordId: null, reference: null } }))), 50, 80, words)
    expect(Object.values(box.marks).some((mark) => mark.kind === 'qr')).toBe(true)
  })
})

describe('the Languages tab', () => {
  const checks = demoChecks()
  const columns = languageColumns(JACKET_R2.languages, checks.markets.map((entry) => entry.market))
  const specs = labelPhraseSpecs(JACKET_R2, checks.marking.warnings)
  const rows = phraseRows(specs, demoPhrases(), columns, JACKET_R2)
  it('the label’s languages first, then those the switched-on markets need', () => {
    expect(columns.map((column) => [column.language, column.onLabel, column.markets])).toEqual([
      ['it', true, ['IT', 'CH']],
      ['en', true, []],
      ['nl', true, []],
      ['de', false, ['DE', 'CH']],
      ['fr', false, ['FR', 'CH']],
    ])
  })
  it('a warning without approved words blocks the markets needing the language; care words never claim to', () => {
    expect(specs.map((spec) => spec.key)).toEqual(['warning.protectors-removable', 'marking.animal-origin', 'care.wash-30-mild', 'care.bleach-not', 'care.tumble-not', 'care.iron-not', 'care.dryclean-not'])
    const warning = rows[0]!
    expect(warning.cells.map((cell) => [cell.language, cell.state])).toEqual([
      ['it', 'SOURCE'],
      ['en', 'APPROVED'],
      ['nl', 'MISSING'],
      ['de', 'MISSING'],
      ['fr', 'PROPOSED'],
    ])
    expect(warning.cells.find((cell) => cell.language === 'it')!.text).toContain('rimovibili')
    expect(warning.blocks).toEqual(['CH', 'DE', 'FR'])
    expect(rows.find((row) => row.spec.key === 'care.bleach-not')!.cells.every((cell) => cell.state === 'NOT_IN_LIBRARY')).toBe(true)
    expect(rows.find((row) => row.spec.key === 'care.wash-30-mild')!.cells.find((cell) => cell.language === 'it')!.blocks).toEqual([])
    expect(rowsBlock(rows, columns)).toEqual(['CH', 'DE', 'FR'])
    expect(warningReasonOf('warning.protectors-removable')).toBe('REMOVABLE_PROTECTORS')
    expect(warningReasonOf('care.wash-not')).toBeNull()
  })
  it('Fill from the library copies approved animal-origin and care words into the draft’s own languages', () => {
    const draft = draftOf(JACKET_R2)
    const filled = fillFromLibrary(draft, rows)
    // it (the source words) and en of each: nl has no approved words, so nothing is cleared there.
    expect(filled.filled).toBe(4)
    expect(filled.draft.animalOriginTexts.it).toBe('Contiene parti non tessili di origine animale')
    expect(filled.draft.animalOriginTexts.en).toBe('Contains non-textile parts of animal origin')
    expect(filled.draft.animalOriginTexts.nl).toBeUndefined()
    expect(filled.draft.care.find((entry) => entry.symbol === 'wash-30-mild')!.text.en).toBe('Wash at 30 °C, mild process')
    expect(fillFromLibrary(filled.draft, rows).filled).toBe(0)
  })
  it('proposing needs the library right; approving another person’s proposal, never one’s own', () => {
    const fr = rows[0]!.cells.find((cell) => cell.language === 'fr')!
    const nl = rows[1]!.cells.find((cell) => cell.language === 'nl')!
    expect(proposeHeld(DEPTH_CAN.owner, rows[0]!, fr, false)).toBeNull()
    // The production manager keeps phrases too (B-W2b-249's role templates); a person without the right does not.
    expect(proposeHeld(DEPTH_CAN.developer, rows[0]!, fr, false)).toBeNull()
    expect(proposeHeld({ phrasesManage: false }, rows[0]!, fr, false)).toBe('held.phrasesManage')
    expect(proposeHeld(DEPTH_CAN.owner, rows[0]!, rows[0]!.cells[0]!, false)).toBe('held.source')
    expect(proposeHeld(DEPTH_CAN.owner, rows[3]!, rows[3]!.cells[0]!, false)).toBe('held.notInLibrary')
    expect(approveTranslationHeld(DEPTH_CAN.owner, ME, fr, false)).toBeNull()
    expect(approveTranslationHeld(DEPTH_CAN.owner, ME, nl, false)).toBe('held.ownProposal')
    expect(approveTranslationHeld(DEPTH_CAN.developer, ME, fr, false)).toBe('held.phrasesApprove')
  })
})

describe('artwork', () => {
  const artwork = demoArtwork()
  it('opens on the approved proof; approving is a second person’s, on a draft of a label that is not retired', () => {
    expect(currentVersion(artwork)?.versionNo).toBe(2)
    const v3 = artwork.versions[0]!
    expect(approveHeld(v3, artwork, false)).toBeNull()
    expect(approveHeld({ ...v3, byYou: true }, artwork, false)).toBe('held.ownProof')
    expect(approveHeld(artwork.versions[1]!, artwork, false)).toBe('held.notDraft')
    expect(approveHeld(v3, { ...artwork, mayApprove: false }, false)).toBe('held.approveRight')
    expect(approveHeld(v3, { ...artwork, label: { ...artwork.label, status: 'RETIRED' } }, false)).toBe('held.labelRetired')
    expect(addProofHeld(artwork, { upload: false }, false)).toBe('held.upload')
    expect(retireHeld(artwork.versions[2]!, artwork, false)).toBe('held.retired')
    expect(removeHeld(artwork.versions[1]!, artwork, false)).toBe('held.kept')
  })
  it('a proof is a PDF or a picture of at most 25 MB', () => {
    expect(proofFileProblem(null)).toBe('held.pickFile')
    expect(proofFileProblem({ contentType: 'text/plain', size: 10 })).toBe('artwork.problem.type')
    expect(proofFileProblem({ contentType: 'application/pdf', size: 26 * 1024 * 1024 })).toBe('artwork.problem.size')
    expect(proofFileProblem({ contentType: 'image/png', size: 10 })).toBeNull()
  })
  it('the role templates: quality approves artwork and translations; the product developer reads', () => {
    expect(DEPTH_CAN.quality).toMatchObject({ approveArtwork: true, phrasesManage: true, phrasesApprove: true })
    expect(DEPTH_CAN.developer).toMatchObject({ approveArtwork: false, phrasesApprove: false })
    expect(CAN.developer.manage).toBe(false)
  })
})

describe('every W2b design case draws in both languages with no key of compliance-labels-depth left on screen', () => {
  const keys = new Set<string>()
  const walk = (node: unknown, path: string) => {
    if (typeof node === 'string') return keys.add(path.replace(/_(one|other)$/, ''))
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) walk(value, path ? `${path}.${key}` : key)
  }
  walk(CATALOGUE.en[NS] ?? {}, '')
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  const left = (html: string): string | null => {
    const text = html.replace(/<[^>]+>/g, ' ')
    for (const key of keys) {
      if (!key.includes('.')) continue
      const at = text.indexOf(key)
      if (at < 0) continue
      if (!/[\w.-]/.test(text[at - 1] ?? ' ') && !/[\w.]/.test(text[at + key.length] ?? ' ')) return key
    }
    return null
  }
  const w2b = (screen: DesignScreen<unknown>) => (screen.screen === 'SCR-331' ? screen.cases : screen.cases.filter((item) => item.id.startsWith('w2b-')))
  for (const screen of [listScreen, recordScreen, compositionScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${w2b(screen).length} W2b cases`, () => {
        for (const item of w2b(screen)) {
          const html = render(screen, item.model, locale)
          if (item.id !== 'no-permission') expect(html.length, item.id).toBeGreaterThan(150)
          expect(left(html), `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('the list shows the kinds and the W2b tiles; the record shows the rules with their laws and the waiting warning', () => {
    const list = render(listScreen as DesignScreen<unknown>, listScreen.cases.find((item) => item.id === 'w2b-kinds-tiles')!.model, 'en')
    // The grid's cells draw in the browser (AG Grid); the tiles draw on the server.
    expect(list).toContain('Artwork waiting approval')
    expect(list).toContain('Missing translations blocking a market')
    const record = render(recordScreen as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'w2b-builder')!.model, 'it')
    expect(record).toContain('Tipo e marcatura')
    expect(record).toContain('Reg. (EU) 2016/425 art. 17')
    expect(record).toContain('Composizione calcolata dalla distinta base')
    expect(record).toContain('Non ancora stampate: le avvertenze attendono il consulente DPI')
    const approve = render(recordScreen as DesignScreen<unknown>, recordScreen.cases.find((item) => item.id === 'w2b-approve')!.model, 'en')
    // The dialog draws in a portal (the browser); the tab's sign-off draws here.
    expect(approve).toContain('Approved by a second person')
    expect(approve).toContain('Send to the brand')
    for (const item of w2b(recordScreen as DesignScreen<unknown>)) expect(render(recordScreen as DesignScreen<unknown>, item.model, 'en'), item.id).not.toMatch(/€|EUR\b/)
  })

  it('design data stays made up: the demo labels are the W1 demo’s', () => {
    expect([SHARED_R1.code, VEST_R1.code].every((code) => code.startsWith('LBL-DEMO'))).toBe(true)
  })
})
