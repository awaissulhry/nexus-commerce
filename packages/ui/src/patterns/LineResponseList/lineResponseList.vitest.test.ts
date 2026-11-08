import { createElement as h } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineAnswerForm, LineResponseList, lineProblemWords } from './LineResponseList'
import { LINE_RESPONSE_LIST_LABELS as EN } from './LineResponseListLabels'
import {
  firstLineProblem,
  lineAnswerChanges,
  lineDraftFor,
  lineDraftProblems,
  lineDraftSaved,
  lineResponseChanged,
  lineResponseOutcome,
  lineResponseSummary,
  lineResponseSummaryParts,
  plainQuantityDefault,
  quantityUnits,
  type LineDraft,
  type LineRequest,
} from './lineResponseListModel'

/** B-W2b-155 — LineResponseList. Made-up lines of a made-up order. */
const TODAY = '2026-11-07'
const LEATHER: LineRequest = {
  id: 'l1',
  seq: 10,
  title: 'NAP-12 · Nappa 1.2 mm',
  details: ['Colour 001 · Black', 'one dye batch'],
  asked: { quantity: '120', unit: 'm²', date: '2026-12-03', dateText: '3 Dec 2026' },
  tags: [{ label: 'Cr VI report', tone: 'info' }],
  substitutes: [{ id: 's1', label: 'NAP-14 · Nappa 1.4 mm' }],
}
const LINING: LineRequest = { id: 'l2', seq: 20, title: 'LIN-3 · Lining', asked: { quantity: '1.200,5', plain: '1200.5', unit: 'm', date: '2026-12-10', dateText: '10 Dec 2026' } }
const THREAD: LineRequest = { id: 'l3', title: 'THR-9 · Thread', asked: { quantity: '40', unit: 'pieces', date: '2026-12-01', dateText: '1 Dec 2026' }, locked: true }
const LINES = [LEATHER, LINING, THREAD]
const rules = { today: TODAY }
const other = (patch: Partial<LineDraft>): LineDraft => ({ kind: 'OTHER', quantity: '', date: '', reason: 'Tannery late', ...patch })

describe('lineResponseList rules', () => {
  it('parses a plain quantity by default and counts it exactly at four places', () => {
    expect(plainQuantityDefault('1200,50')).toBe('1200.5')
    expect(plainQuantityDefault(' 007 ')).toBe('7')
    expect(plainQuantityDefault('1.200,5')).toBeNull()
    expect(quantityUnits('1200.5')).toBe(12005000n)
    expect(quantityUnits('1.23456')).toBeNull()
  })

  it('checks each kind as the PO rules do', () => {
    expect(lineDraftProblems(LEATHER, { kind: 'AS_ASKED', reason: '' }, rules)).toEqual({})
    expect(lineDraftProblems(LEATHER, { kind: 'CANNOT', reason: ' ' }, rules)).toEqual({ reason: 'missing' })
    expect(lineDraftProblems(LEATHER, other({}), rules).whole).toBe('nothing')
    expect(lineDraftProblems(LEATHER, other({ quantity: '120', date: '2026-12-03' }), rules)).toEqual({ whole: 'same' })
    expect(lineDraftProblems(LEATHER, other({ quantity: 'abc', date: '2026-11-01' }), rules)).toEqual({ quantity: 'number', date: 'past' })
    expect(lineDraftProblems(LEATHER, other({ quantity: '0' }), rules)).toEqual({ quantity: 'positive' })
    expect(lineDraftProblems(LEATHER, other({ date: '2029-01-01' }), rules)).toEqual({ date: 'far' })
    expect(lineDraftProblems(LEATHER, other({ quantity: '100', reason: '' }), rules)).toEqual({ reason: 'missing' })
    expect(lineDraftProblems(LEATHER, other({ quantity: '100', reason: 'x'.repeat(501) }), rules)).toEqual({ reason: 'long' })
    // The host's parse decides what "same" means for a grouped quantity.
    expect(lineDraftProblems(LINING, other({ quantity: '1200,5' }), rules)).toEqual({ whole: 'same' })
  })

  it('a split is two deliveries on two days; a substitute names an article; a change gives its words', () => {
    const split = (a: string, b: string): LineDraft => ({ kind: 'SPLIT', deliveries: [{ quantity: '60', date: a }, { quantity: '60', date: b }], reason: 'Two lots' })
    expect(lineDraftProblems(LEATHER, split('2026-12-03', '2026-12-03'), rules)).toEqual({ whole: 'sameDay' })
    expect(lineDraftProblems(LEATHER, split('2026-12-03', ''), rules)).toEqual({ deliveries: [{}, { date: 'missing' }] })
    expect(lineDraftProblems(LEATHER, split('2026-12-03', '2026-12-17'), rules)).toEqual({})
    expect(lineDraftProblems(LEATHER, { kind: 'SUBSTITUTE', reason: '' }, rules)).toEqual({ substitute: 'missing' })
    expect(lineDraftProblems(LEATHER, { kind: 'SUBSTITUTE', substituteId: 's1', reason: '' }, rules)).toEqual({})
    expect(lineDraftProblems(LEATHER, { kind: 'SUBSTITUTE', substitute: 'Our NP-1', quantity: '-1', reason: '' }, rules)).toEqual({ quantity: 'number' })
    expect(lineDraftProblems(LEATHER, { kind: 'CHANGE', reason: '' }, rules)).toEqual({ reason: 'missing' })
  })

  it('names the first problem, in the order the editor reads it', () => {
    expect(firstLineProblem({ reason: 'missing', quantity: 'number' })).toBe('quantity.number')
    expect(firstLineProblem({ deliveries: [{}, { date: 'past' }], reason: 'missing' })).toBe('date.past')
    expect(firstLineProblem({})).toBeNull()
    expect(lineProblemWords('reason.missing', EN, {}, 'CHANGE')).toBe('Say what you would change, in a few words.')
    expect(lineProblemWords('reason.long', EN)).toBe('At most 500 characters.')
  })

  it('says what an answer changes', () => {
    expect(lineAnswerChanges(LEATHER, undefined)).toEqual([])
    expect(lineAnswerChanges(LEATHER, other({ quantity: '100', date: '2026-12-20' }))).toEqual(['LATER', 'LESS'])
    expect(lineAnswerChanges(LEATHER, { kind: 'SPLIT', deliveries: [{ quantity: '60', date: '2026-12-01' }, { quantity: '70', date: '2026-12-17' }], reason: 'x' })).toEqual(['SPLIT', 'LATER', 'MORE'])
    expect(lineAnswerChanges(LEATHER, { kind: 'SUBSTITUTE', substituteId: 's1', reason: '' })).toEqual(['SUBSTITUTE'])
    expect(lineAnswerChanges(LEATHER, { kind: 'CANNOT', reason: 'x' })).toEqual(['CANNOT'])
    expect(lineAnswerChanges(LINING, other({ quantity: '1300' }))).toEqual(['MORE'])
  })

  it('counts the whole answer (locked lines left out) and says what it comes to', () => {
    expect(lineResponseSummaryParts(lineResponseSummary(LINES, {}))).toEqual([{ key: 'allAsAsked', count: 2 }])
    expect(lineResponseOutcome(LINES, {})).toBe('CONFIRMED')
    expect(lineResponseChanged(LINES, {})).toBe(false)
    const answers = { l1: other({ date: '2026-12-20' }), l2: { kind: 'CANNOT', reason: 'x' } as LineDraft }
    expect(lineResponseSummaryParts(lineResponseSummary(LINES, answers))).toEqual([{ key: 'later', count: 1 }, { key: 'cannot', count: 1 }])
    expect(lineResponseOutcome(LINES, answers)).toBe('PROPOSED')
    expect(lineResponseOutcome(LINES, { l1: { kind: 'CANNOT', reason: 'x' }, l2: { kind: 'CANNOT', reason: 'y' } })).toBe('DECLINED')
    expect(lineResponseChanged(LINES, answers)).toBe(true)
  })

  it('starts a draft from what was asked and keeps what was typed across kinds; saving drops unused fields', () => {
    const start = lineDraftFor(LEATHER, 'OTHER')
    expect(start).toMatchObject({ kind: 'OTHER', quantity: '120', date: '2026-12-03' })
    const typed = { ...start, reason: 'Late hides' }
    expect(lineDraftFor(LEATHER, 'SPLIT', typed)).toMatchObject({ kind: 'SPLIT', reason: 'Late hides', deliveries: [{ quantity: '', date: '2026-12-03' }, { quantity: '', date: '' }] })
    expect(lineDraftSaved({ ...typed, quantity: ' 100 ' })).toEqual({ kind: 'OTHER', quantity: '100', date: '2026-12-03', reason: 'Late hides' })
    expect(lineDraftSaved({ kind: 'AS_ASKED', reason: '' })).toBeNull()
    expect(lineDraftSaved({ kind: 'CANNOT', quantity: '3', reason: ' no ' })).toEqual({ kind: 'CANNOT', reason: 'no' })
  })
})

describe('LineResponseList', () => {
  const answers = { l1: other({ quantity: '100', date: '2026-12-20' }) }
  const html = render(h(LineResponseList, { lines: LINES, answers, today: TODAY, onAnswer: () => {}, onAllAsAsked: () => {}, formatDate: (iso: string) => `day ${iso}` }))

  it('draws each line: what, the asked value beside the answer with its tags and reason, and named buttons', () => {
    for (const word of ['Line 10', 'NAP-12 · Nappa 1.2 mm', 'Colour 001 · Black', 'Cr VI report', '120 m² by 3 Dec 2026', '100 m² by day 2026-12-20', 'Later date', 'Less', 'Your reason: Tannery late', 'As asked']) {
      expect(html).toContain(word)
    }
    expect(html).toContain('aria-label="Change your answer to line 10"')
    expect(html).toContain('aria-label="Line 10 as asked again"')
    expect(html).not.toContain('aria-label="Line 20 as asked again"')
    // The third line has no seq: its place in the list; it is locked, so it takes no answer.
    expect(html).toContain('Line 3')
    expect(html).toContain('Confirmed before: this line takes no new answer')
    expect(html).not.toContain('aria-label="Change your answer to line 3"')
  })

  it('says the review line as a polite status, and "All as asked" acts', () => {
    expect(html).toContain('role="status">Your answer: 1 line as asked · 1 later date · 1 other quantity.</p>')
    expect(html).toMatch(/<button type="button" class="nds-btn sm">.*All as asked<\/button>/)
  })

  it('holds "All as asked" with its words when every line already is', () => {
    const fresh = render(h(LineResponseList, { lines: LINES, answers: {}, today: TODAY, onAllAsAsked: () => {} }))
    expect(fresh).toContain('aria-description="Every line is as asked already"')
    expect(fresh).toContain('Your answer: all 2 lines as asked.')
    expect(fresh).not.toMatch(/\sdisabled[\s=>]/)
  })

  it('read-only: the answers, no buttons', () => {
    const ro = render(h(LineResponseList, { lines: LINES, answers, today: TODAY, editable: false, onAllAsAsked: () => {} }))
    expect(ro).toContain('Later date')
    expect(ro).not.toContain('<button')
  })

  it('speaks the host’s words only', () => {
    const it = render(
      h(LineResponseList, {
        lines: [LEATHER],
        answers: { l1: { kind: 'CANNOT', reason: 'Niente pelli' } },
        today: TODAY,
        onAllAsAsked: () => {},
        labels: {
          line: (seq: string) => `Riga ${seq}`,
          asked: 'Richiesto',
          yourAnswer: 'La tua risposta',
          askedValue: (q: string, u: string, d: string) => `${q} ${u} entro il ${d}`,
          answerCannot: 'Non puoi consegnarla',
          reason: (r: string) => `Il tuo motivo: ${r}`,
          changes: { ...EN.changes, CANNOT: 'Non consegnabile' },
          change: 'Modifica',
          changeAria: (s: string) => `Modifica la risposta alla riga ${s}`,
          asAskedAgain: 'Come richiesto',
          asAskedAgainAria: (s: string) => `Riga ${s} di nuovo come richiesto`,
          allAsAsked: 'Tutte come richiesto',
          review: (s: string) => `La tua risposta: ${s}.`,
          summary: { ...EN.summary, cannot: (n: number) => `${n} riga che non puoi consegnare` },
          list: 'Righe',
        },
      }),
    )
    for (const word of ['Riga 10', 'Richiesto', 'Non puoi consegnarla', 'Non consegnabile', 'Il tuo motivo: Niente pelli', 'Tutte come richiesto', 'La tua risposta: 1 riga che non puoi consegnare.']) expect(it).toContain(word)
    expect(it).not.toMatch(/Your answer|Asked<|Change<|All as asked|Your reason/)
  })
})

describe('the line editor’s form', () => {
  const form = (draft: LineDraft, tried = false, kinds = ['AS_ASKED', 'OTHER', 'SPLIT', 'CANNOT', 'SUBSTITUTE', 'CHANGE'] as const) =>
    render(
      h(LineAnswerForm, {
        formId: 'f',
        line: LEATHER,
        draft,
        problems: tried ? lineDraftProblems(LEATHER, draft, rules) : {},
        kinds,
        rules,
        lw: EN,
        onDraft: () => {},
        onSave: () => {},
      }),
    )

  it('shows the asked value and every allowed kind as a radio card, the chosen one checked', () => {
    const html = form(lineDraftFor(LEATHER, 'OTHER'))
    expect(html).toContain('role="radiogroup" aria-label="What can you do?"')
    for (const word of ['As asked', 'Another date or quantity', 'In two deliveries', 'I cannot deliver this line', 'Another article instead', 'Another change']) expect(html).toContain(word)
    expect((html.match(/type="radio"/g) ?? []).length).toBe(6)
    expect(html).toMatch(/checked="" value="OTHER"/)
    expect(html).toContain('Quantity (m²)')
  })

  it('after a try, each problem is under its field', () => {
    const html = form(other({ quantity: 'x', reason: '' }), true)
    expect(html).toContain('Give the quantity as a number, with at most four decimals.')
    expect(html).toContain('Say why, in a few words.')
  })

  it('a split draws two deliveries; a substitute its choice and words; a change its words', () => {
    expect((form(lineDraftFor(LEATHER, 'SPLIT')).match(/<fieldset/g) ?? []).length).toBe(2)
    const sub = form(lineDraftFor(LEATHER, 'SUBSTITUTE'), true)
    expect(sub).toContain('NAP-14 · Nappa 1.4 mm')
    expect(sub).toContain('None of these: I describe my own')
    expect(sub).toContain('Choose the article you offer instead, or describe your own.')
    expect(sub).toContain('Why (optional)')
    expect(form({ kind: 'CHANGE', reason: '' }, true)).toContain('What would you change?')
  })
})
