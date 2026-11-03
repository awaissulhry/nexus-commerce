import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { CUT_OVERRIDE_REASON_CODES, CUT_WARNING_KINDS } from '@nexus/factory-domain/production/cutting/checks'
import { createScopedTranslator, messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { FLOOR_NAMESPACES } from '../routes'
import { hideAnswer, warningKindsOf } from './api'
import { designScreen } from './fixtures'
import { ANYWAY_REASONS, anywayHeld, anywayProblemOf, anywayReady, cardCheck, measureOf, remnantMinimum, remnantProblem, standingWarnings, waitingCuts, type CheckWarning, type HideChecks, type SizeState } from './model'
import { CUT_WORDS } from './view/CutView'
import { kindsWords, rangeWords, thicknessWords, warningWords } from './view/check-words'

/**
 * B-W2b-110: the hide check in depth on B-W2b-103's API — the card with the table measure counted in, why "Cut anyway"
 * waits, the signature's refusals, the warnings in the floor's words (never the API's English), the design cases.
 */

const CHECKS: HideChecks = {
  warnings: [],
  standing: [],
  passed: [],
  shade: { rule: 'ORDER', cutFrom: [{ lotCode: 'L-1', shadeLabel: '2' }], hide: { lotCode: 'L-1', shadeLabel: '2', outOfShade: false }, same: true },
  thickness: { verdict: 'OK', valueMm: '1.20', source: 'HIDE', minMm: '1.10', maxMm: '1.30' },
  grade: { hide: 'A', byText: false, pieces: [] },
  reserved: { forIt: false, hides: [], lots: [] },
  photo: { required: false },
}
const THIN: CheckWarning = { kind: 'THICKNESS', code: 'THIN', thickness: { valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' } }
const SHADE: CheckWarning = { kind: 'SHADE', code: 'SHADE_LOT', shade: { rule: 'ORDER', cutFrom: [{ lotCode: 'L-1', shadeLabel: '2' }], hide: { lotCode: 'L-9', shadeLabel: '3', outOfShade: false }, cell: null } }
const thin: HideChecks = { ...CHECKS, warnings: [THIN], standing: ['THICKNESS'], thickness: { verdict: 'THIN', valueMm: '0.95', source: 'HIDE', minMm: '1.10', maxMm: '1.30' } }
const SIZE = (allCut = false): SizeState => ({ id: 'c', label: '52', remaining: allCut ? 0 : 3, allCut })

describe('B-W2b-110 the card with the thickness measured at the table', () => {
  it('without a measure is the office\'s word, and a thickness off the record needs a measure before Cut anyway', () => {
    const card = cardCheck(thin, null)
    expect(card.standing).toEqual(['THICKNESS'])
    expect(card.needsMeasure).toBe(true)
    expect(cardCheck({ ...thin, standing: [], passed: ['THICKNESS'] }, null).needsMeasure).toBe(false)
  })

  it('a measure inside the range takes the warning away; outside it, the warning stands on the measure', () => {
    const inside = cardCheck(thin, '1.15')
    expect(inside.standing).toEqual([])
    expect(inside.warnings).toEqual([])
    expect(inside.thickness).toMatchObject({ verdict: 'OK', source: 'TABLE' })
    const outside = cardCheck(thin, '0.98')
    expect(outside.standing).toEqual(['THICKNESS'])
    expect(outside.needsMeasure).toBe(false)
    expect(outside.warnings[0]!.thickness).toMatchObject({ source: 'TABLE', minMm: '1.10' })
  })

  it('a measure outside the range adds a warning to a clean card, unless a lead passed the thickness already', () => {
    expect(cardCheck(CHECKS, '1.50').standing).toEqual(['THICKNESS'])
    expect(cardCheck({ ...CHECKS, passed: ['THICKNESS'] }, '1.50').standing).toEqual([])
  })

  it('keeps the other warnings and the database\'s kind order', () => {
    const both: HideChecks = { ...thin, warnings: [THIN, SHADE], standing: ['THICKNESS', 'SHADE'] }
    expect(cardCheck(both, null).standing).toEqual(['SHADE', 'THICKNESS'])
    const measured = cardCheck(both, '1.20')
    expect(measured.standing).toEqual(['SHADE'])
    expect(standingWarnings(measured).map((warning) => warning.kind)).toEqual(['SHADE'])
  })

  it('reads the thickness typed on the pad as the office takes it', () => {
    expect(measureOf(null)).toEqual({ text: null, problem: 'empty' })
    expect(measureOf(0.98)).toEqual({ text: '0.98', problem: null })
    expect(measureOf(1.2)).toEqual({ text: '1.20', problem: null })
    expect(measureOf(123)).toEqual({ text: null, problem: 'invalid' })
  })
})

describe('B-W2b-110 Cut anyway: when it waits, what the signature needs, its refusals', () => {
  it('waits for the network, then for the work order\'s saved cuts, the measure, a size, the photo — in that order', () => {
    const facts = { online: true, waiting: 0, needsMeasure: false, picked: SIZE(), photoMissing: false }
    expect(anywayHeld(facts)).toBeNull()
    expect(anywayHeld({ ...facts, online: false, waiting: 2 })).toBe('offline')
    expect(anywayHeld({ ...facts, waiting: 2, needsMeasure: true })).toBe('waiting')
    expect(anywayHeld({ ...facts, needsMeasure: true, picked: null })).toBe('measure')
    expect(anywayHeld({ ...facts, picked: null })).toBe('pickSize')
    expect(anywayHeld({ ...facts, picked: SIZE(true) })).toBe('allCut')
    expect(anywayHeld({ ...facts, photoMissing: true })).toBe('photo')
  })

  it('counts only this work order\'s cuts still waiting on the tablet', () => {
    const items = [
      { kind: 'production.cut.log', state: 'waiting', payload: { workOrderId: 'wo' } },
      { kind: 'production.cut.remnant', state: 'waiting', payload: { workOrderId: 'wo' } },
      { kind: 'production.cut.log', state: 'recorded', payload: { workOrderId: 'wo' } },
      { kind: 'production.cut.log', state: 'waiting', payload: { workOrderId: 'other' } },
      { kind: 'production.scan.report', state: 'waiting', payload: { workOrderId: 'wo' } },
    ]
    expect(waitingCuts(items, 'wo')).toBe(2)
  })

  it('takes a tile, and a few words with Other (the tiles are the office\'s own list)', () => {
    expect(ANYWAY_REASONS.map((reason) => reason.code)).toEqual([...CUT_OVERRIDE_REASON_CODES])
    expect(anywayReady(null, '')).toBe(false)
    expect(anywayReady('CHECKED_BY_EYE', '')).toBe(true)
    expect(anywayReady('OTHER', 'ab')).toBe(false)
    expect(anywayReady('OTHER', 'abc')).toBe(true)
  })

  it('keeps the lead\'s refusals in the pop-up; a new warning reads the card again; any other rule closes it', () => {
    expect(anywayProblemOf({ kind: 'refused', code: 'LEAD_PIN_WRONG' })).toBe('wrong')
    expect(anywayProblemOf({ kind: 'refused', code: 'LEAD_IS_CUTTER' })).toBe('self')
    expect(anywayProblemOf({ kind: 'refused', code: 'NOT_A_LEAD' })).toBe('notLead')
    expect(anywayProblemOf({ kind: 'refused', code: 'LEAD_NOTE_MISSING' })).toBe('note')
    expect(anywayProblemOf({ kind: 'refused', code: 'CUT_WARNING' })).toBe('changed')
    expect(anywayProblemOf({ kind: 'refused', code: 'NOTHING_LEFT' })).toBe('close')
    expect(anywayProblemOf({ kind: 'invalid', path: 'body/cut/measuredThicknessMm' })).toBe('measure')
    expect(anywayProblemOf({ kind: 'rateLimited' })).toBe('locked')
    expect(anywayProblemOf({ kind: 'offline' })).toBe('unavailable')
    expect(anywayProblemOf({ kind: 'unavailable' })).toBe('unavailable')
  })

  it('reads the warning kinds a CUT_WARNING refusal names, once each', () => {
    expect(warningKindsOf(['refusal/CUT_WARNING', 'warnings/SHADE/SHADE_LOT', 'warnings/GRADE/BELOW', 'warnings/GRADE/UNGRADED', 'warnings/NOPE/X'])).toEqual(['SHADE', 'GRADE'])
  })
})

describe('B-W2b-110 the API answer and a remnant under the minimum', () => {
  const hide = {
    hide: { id: 'h', code: 'HD-1', itemCode: 'L', itemName: 'Leather', colourCode: null, area: '10', areaUom: 'FT2', baseArea: '10', baseUom: 'FT2', grade: 'A', shade: null, thicknessMm: '1.2', defects: null, state: 'FULL', lot: { id: 'l', code: 'L-1', dyeBatch: null, shade: null, qualityStatus: 'RELEASED', crViStatus: 'PASS', usable: true, words: null } },
    onHand: [],
    lastCut: null,
    workOrders: [{ id: 'wo', number: 'WO-1', status: 'RELEASED', holdsHide: false, left: '10', cuttable: true, refusal: null, cells: [] }],
  }

  it('an older answer without checks still reads (null), and a W2b one carries them', () => {
    expect(hideAnswer.parse(hide).workOrders[0]!.checks).toBeNull()
    const parsed = hideAnswer.parse({ ...hide, workOrders: [{ ...hide.workOrders[0], checks: { ...CHECKS, warnings: [{ ...SHADE, message: 'English words' }], standing: ['SHADE'] } }] })
    expect(parsed.workOrders[0]!.checks?.standing).toEqual(['SHADE'])
  })

  it('refuses a remnant under the smallest kept (10 dm²) in the hide\'s unit, as the office does', () => {
    expect(remnantMinimum('FT2')).toBe('1.08')
    expect(remnantMinimum('DM2')).toBe('10.00')
    expect(remnantProblem('20', 1, false, 'FT2')).toBe('tooSmall')
    expect(remnantProblem('20', 1.1, false, 'FT2')).toBeNull()
    expect(remnantProblem('20', 1, false)).toBeNull()
  })
})

describe('B-W2b-110 the words: every warning said in the floor\'s language, both languages complete', () => {
  const t = { en: createScopedTranslator('en', messagesFor('en', ['floor-cutting']), 'floor-cutting'), it: createScopedTranslator('it', messagesFor('it', ['floor-cutting']), 'floor-cutting') }
  const WRONG: CheckWarning = { kind: 'WRONG_HIDE', code: 'NOT_RESERVED', wrongHide: { reservedHides: [{ code: 'HD-7', lotCode: 'L-1', grade: 'A' }], reservedLots: ['L-1'], differs: ['LOT', 'GRADE'], hide: { lotCode: 'L-9', grade: 'B' } } }
  const BELOW: CheckWarning = { kind: 'GRADE', code: 'BELOW', grade: { hideGrade: 'C', pieces: [{ name: 'Front', minGrade: 'B' }] } }

  it('says each warning from its facts', () => {
    const en = (warning: CheckWarning) => warningWords(t.en, warning, { number: 'WO-1', locale: 'en' })
    expect(en(SHADE)).toBe('Different shade lot: WO-1 is cut from lot L-1, shade 2; this hide is lot L-9, shade 3. One shade lot per order.')
    expect(en(WRONG)).toBe('Not the reserved hide: WO-1 has 1 hide reserved for it (HD-7). This hide: lot L-9, reserved L-1; grade B, reserved A.')
    expect(en(THIN)).toBe('Too thin: 0.95 mm as recorded on the hide; the leather asks 1.10–1.30 mm.')
    expect(en(BELOW)).toBe('Grade C is too low for some pieces: Front asks B or better.')
    expect(warningWords(t.it, SHADE, { number: 'WO-1', locale: 'it' })).toBe('Lotto di tonalità diverso: WO-1 è tagliato da lotto L-1, tonalità 2; questa pelle è lotto L-9, tonalità 3. Un lotto di tonalità per ordine.')
    expect(kindsWords(t.it, ['SHADE', 'THICKNESS'])).toBe('tonalità, spessore')
    expect(rangeWords(t.en, { minMm: '1.10', maxMm: null }, 'en')).toBe('at least 1.10 mm')
    expect(warningWords(t.it, THIN, { number: 'WO-1', locale: 'it' })).toBe('Troppo sottile: 0,95 mm come registrato sulla pelle; la pelle chiede 1,10–1,30 mm.')
    expect(thicknessWords(t.en, { verdict: 'OK', valueMm: '1.15', source: 'TABLE', minMm: '1.10', maxMm: '1.30' }, 'en')).toBe('1.15 mm measured here · the leather asks 1.10–1.30 mm')
  })

  it('has words in both languages for every warning code, kind, reason state and refusal it says', () => {
    for (const locale of ['en', 'it'] as const) {
      const file = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), `../../../../messages/${locale}/floor-cutting.json`), 'utf8')) as Record<string, any>
      for (const kind of CUT_WARNING_KINDS) expect(file.check.kind[kind], `${locale} kind ${kind}`).toBeTruthy()
      for (const code of ['SHADE_LOT', 'OUT_OF_SHADE', 'GARMENT_SHADE', 'RESERVED_LOT', 'THIN', 'THICK', 'BELOW', 'UNGRADED']) expect(file.check.warning[code], `${locale} ${code}`).toBeTruthy()
      for (const held of ['offline', 'measure', 'pickSize', 'allCut', 'photo', 'waiting_one', 'waiting_other']) expect(file.anyway.held[held], `${locale} held ${held}`).toBeTruthy()
      for (const problem of ['wrong', 'self', 'notLead', 'note', 'locked', 'unavailable', 'measure']) expect(file.anyway.problem[problem], `${locale} problem ${problem}`).toBeTruthy()
      for (const code of CUT_WORDS) expect(file.refusal[code]?.message, `${locale} refusal ${code}`).toBeTruthy()
    }
  })
})

describe('B-W2b-110 design cases', () => {
  const html = (id: string, locale: 'it' | 'en') => {
    const item = designScreen.cases.find((entry) => entry.id === id)
    if (!item) throw new Error(`no case ${id}`)
    const View = designScreen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, FLOOR_NAMESPACES) }, createElement(View, { model: item.model })))
  }

  it('a clean card goes straight to the size buttons and says each check in words', () => {
    const page = html('check-in-depth', 'en')
    expect(page).toContain('+ 1 set')
    expect(page).toContain('Same shade lot: WO-DEMO-0042 is cut from lot LOT-DEMO-0007, shade 2')
    expect(page).toContain('Reserved for WO-DEMO-0042.')
    expect(page).toContain('1.20 mm as recorded · the leather asks 1.10–1.30 mm')
    expect(page).toContain('Photo of the hide')
    expect(page).toContain('Measure here')
    expect(page).not.toContain('Cut anyway')
  })

  it('a warning stops on the card with Cut anyway instead of + 1 set, in both languages', () => {
    const en = html('stop-shade', 'en')
    expect(en).toContain('1 warning: this hide stops here.')
    expect(en).toContain('Different shade lot')
    expect(en).toContain('Cut anyway')
    expect(en).toContain('First set')
    expect(en).not.toContain('+ 1 set')
    const it = html('stop-shade', 'it')
    expect(it).toContain('Taglia comunque')
    expect(it).toContain('Lotto di tonalità diverso')
  })

  it('holds Cut anyway with its reason, offline and before a measure', () => {
    expect(html('stop-offline', 'en')).toContain('Cut anyway needs the network: the office checks the lead&#x27;s PIN.')
    expect(html('stop-thin-measure-first', 'en')).toContain('Measure the thickness at the table first (Measure here).')
    expect(html('stop-waiting', 'it')).toContain('2 tagli di questo ordine aspettano di essere inviati prima.')
  })

  it('a measure inside the range opens the sizes; the signed cut is on the strip, recorded', () => {
    const measured = html('measured-in-range', 'en')
    expect(measured).toContain('1.15 mm measured here')
    expect(measured).toContain('+ 1 set')
    const signed = html('anyway-signed', 'en')
    expect(signed).toContain('A lead let this hide be cut anyway for this work order: shade.')
    expect(signed).toContain('the first set is recorded')
    expect(signed).toContain('+ 1 set')
  })

  it('says a refused queued cut and a remnant under the minimum in the screen\'s words', () => {
    expect(html('refused-cut-warning', 'en')).toContain('This hide has warnings no lead signed for.')
    expect(html('remnant-too-small', 'en')).toContain('Smaller than the smallest remnant kept (1.08 ft²): it is waste.')
    expect(html('remnant-tag-scanned', 'it')).toContain('RM-5P-00003P-K')
  })
})
