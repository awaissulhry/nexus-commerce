import { createElement, type ComponentType } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { DesignScreen } from '../../lib/design/design-screen'
import { CATALOGUE, createScopedTranslator, messagesFor } from '../../lib/i18n/messages'
import { LOCALES } from '../../lib/i18n/locales'
import { I18nProvider } from '../../lib/i18n/provider'
import { RECORD_PAGES, LIST_PAGES, recordAddress, listAddress } from '../../lib/records/record-links'
import { OFFICE_PAGES } from '../../shell/nav/office-nav'
import { runWithStepUp, StepUpCancelled, stepUpProblem } from './_shared/hooks'
import { evidenceAddress, newNcrAddress, problemKey, qualityCan, refusalLines } from './_shared/model'
import { ApiError } from '../../lib/api/errors'
import { chainOf, scansByOperation, verdictOf } from './evidence/model'
import { designScreen as evidenceScreen } from './evidence/fixtures'
import { designScreen as listScreen } from './inspections/fixtures'
import { designScreen as recordScreen } from './inspections/record/fixtures'
import { ANSWERED, EVIDENCE, EVIDENCE_GAPS, FAILING_BY_COUNTS, FAILING_HARD, FINAL, FINAL_SECOND, INSPECTION, PASSED, readOf, RELEASE_DETAIL, ROWS, RULE, SERIAL_DETAIL, SHIPPED_DETAIL, WO_CELLS } from './inspections/demo/fixtures'
import {
  answer,
  checklistBody,
  checklistCounts,
  checklistRows,
  finishedOf,
  holdOf,
  impactLines,
  NEW_DRAFT,
  newProblems,
  nextLimit,
  recordAbilities,
  releaseHeld,
  releaseProblems,
  REVERSE_DRAFT,
  reverseHeld,
  reverseProblems,
  ruleDraftOf,
  ruleLoosens,
  ruleProblems,
  signDraftOf,
  signProblems,
  statusOf,
  viewFromAddress,
  viewKind,
  whoKey,
  assignedWords,
  assignHeld,
  assigneeBody,
  assigneeValue,
  defectLineProblems,
  holdsAddressFor,
  kindHeld,
  returnBody,
  returnProblems,
  withPicked,
  changedLine,
  withoutLine,
} from './inspections/model'
import { INSPECTORS, LIBRARY, RETURN_RECORD } from './inspections/demo/fixtures'

const params = (query: string) => new URLSearchParams(query)
const OWNER = qualityCan(['quality.inspections.view', 'quality.inspections.record', 'quality.garments.release', 'quality.garments.reverse', 'quality.settings.manage'])
const VIEWER = qualityCan(['quality.inspections.view'])

describe('Inspections: views, tiles and what a row says', () => {
  it("reads ?view= first, then the API's own filters a link carries (Today, LIST_PAGES), else every inspection", () => {
    expect(viewFromAddress(params('view=reversed'))).toBe('reversed')
    expect(viewFromAddress(params('failedUndecided=true'))).toBe('failed')
    expect(viewFromAddress(params('assigned=me'))).toBe('mine')
    expect(viewFromAddress(params('waitingRelease=true'))).toBe('waiting')
    expect(viewFromAddress(params('status=OPEN'))).toBe('open')
    expect(viewFromAddress(params('reversed=true'))).toBe('reversed')
    expect(viewFromAddress(params('view=nonsense'))).toBe('all')
    expect(viewFromAddress(null)).toBe('all')
    expect([viewKind('reversed'), viewKind('lots'), viewKind('failed')]).toEqual(['releases', 'lots', 'inspections'])
  })

  it('W2a (Owner answer Q3): W1\'s "On hold" address now opens Quality › Holds', () => {
    expect(holdsAddressFor(params('view=onHold'))).toBe('/quality/holds?subjectType=WorkOrder')
    expect(holdsAddressFor(params('onHold=true'))).toBe('/quality/holds?subjectType=WorkOrder')
    expect(holdsAddressFor(params('view=open'))).toBeNull()
  })

  it('Show more reads a larger page up to 200 (the lists have no cursor)', () => {
    expect([nextLimit(50), nextLimit(150), nextLimit(200)]).toEqual([100, 200, 200])
  })

  it('a status says the override and the hold; the hold says why in our words', () => {
    expect(statusOf(ROWS[0]!)).toEqual({ key: 'status.OPEN', tone: 'info' })
    expect(statusOf(ROWS.find((row) => row.overridden)!).key).toBe('status.PASSED_OVERRIDE')
    expect(statusOf(ROWS.find((row) => row.reversed > 0)!).key).toBe('status.REVERSED')
    expect(holdOf(ROWS.find((row) => row.status === 'FAILED')!)).toEqual({ key: 'hold.failed' })
    expect(holdOf(ROWS.find((row) => row.reversed > 0)!)).toEqual({ key: 'hold.reversed', params: { count: 4 } })
    expect(holdOf(ROWS[2]!)).toBeNull()
  })

  it('names no person in a list: you, at the bench, in the office', () => {
    expect(whoKey({ kind: 'FLOOR', workerId: 'w', userId: null }, 'me').key).toBe('who.bench')
    expect(whoKey({ kind: 'OFFICE', workerId: null, userId: 'me' }, 'me')).toEqual({ key: 'who.you', you: true })
    expect(whoKey({ kind: 'OFFICE', workerId: null, userId: 'other' }, 'me').key).toBe('who.office')
  })
})

describe('the record: held reasons before the click, the sign and release drafts', () => {
  it('only the inspector who opened it records; a maker never signs; every check answered first', () => {
    expect(recordAbilities(readOf(INSPECTION), OWNER)).toEqual({ recordHeld: null, signHeld: 'held.unanswered', cancelHeld: null })
    expect(recordAbilities(readOf(ANSWERED), OWNER).signHeld).toBeNull()
    expect(recordAbilities(readOf(ANSWERED, { yours: false }), OWNER).signHeld).toBe('held.notYours')
    expect(recordAbilities(readOf(ANSWERED, { maker: { made: true, words: '' } }), OWNER).signHeld).toBe('held.maker')
    expect(recordAbilities(readOf(ANSWERED), VIEWER).recordHeld).toBe('held.noRecord')
    expect(recordAbilities(readOf(PASSED), OWNER).recordHeld).toBe('held.decided')
  })

  it('a checklist answer saves the whole answered set; a failed check needs its note', () => {
    const rows = answer(checklistRows(INSPECTION), 'HANGTAGS', { ok: false })
    expect(checklistCounts(rows)).toEqual({ answered: 8, total: 12, failed: 1 })
    expect(checklistBody(rows).find((row) => row.code === 'HANGTAGS')).toEqual({ code: 'HANGTAGS', ok: false, note: null })
    expect(answer(rows, 'HANGTAGS', { note: 'Missing' }).find((row) => row.code === 'HANGTAGS')?.note).toBe('Missing')
  })

  it('sign: as computed needs nothing; an override needs a reason; never a pass over a hard fail; the statement when asked', () => {
    expect(signProblems(signDraftOf(ANSWERED), ANSWERED, false)).toEqual([])
    expect(signProblems({ ...signDraftOf(FAILING_BY_COUNTS), result: 'PASS' }, FAILING_BY_COUNTS, false)).toEqual(['sign.problem.reason'])
    expect(signProblems({ ...signDraftOf(FAILING_BY_COUNTS), result: 'PASS', overrideReason: 'Counted twice' }, FAILING_BY_COUNTS, false)).toEqual([])
    expect(signProblems({ ...signDraftOf(FAILING_HARD), result: 'PASS', overrideReason: 'Fine' }, FAILING_HARD, false)).toEqual(['sign.problem.passOverHard'])
    expect(signProblems(signDraftOf(ANSWERED), ANSWERED, true)).toEqual(['sign.problem.statement'])
  })

  it('release per cell: held with the first open check (the gate in words), nothing left, or no right', () => {
    expect(releaseHeld(FINAL.cells[1]!, OWNER)).toBeNull()
    expect(releaseHeld(FINAL.cells[0]!, OWNER)).toEqual({ key: 'held.nothingToRelease' })
    expect(releaseHeld(FINAL.cells[2]!, OWNER)).toEqual({ key: 'held.gateOpen', params: { count: 2, check: 'LABELS' } })
    expect(releaseHeld(FINAL_SECOND.cells[1]!, OWNER)).toEqual({ key: 'held.gateOpen', params: { count: 1, check: 'SECOND_PERSON' } })
    expect(releaseHeld(FINAL.cells[1]!, VIEWER)).toEqual({ key: 'held.noRelease' })
    expect(releaseProblems({ quantity: '9', serialIds: [], note: '' }, FINAL.cells[1]!)).toEqual(['release.problem.tooMany'])
    expect(releaseProblems({ quantity: '0', serialIds: [], note: '' }, FINAL.cells[1]!)).toEqual(['release.problem.quantity'])
  })

  it('reversal: the impact in our words, held when nothing can be taken back, every problem at once', () => {
    expect(impactLines(RELEASE_DETAIL.reverseImpact)).toEqual([
      { key: 'reverse.impact.house', params: { count: 6 } },
      { key: 'reverse.impact.onShipment', params: { count: 2 } },
    ])
    expect(reverseHeld(SHIPPED_DETAIL, OWNER)).toBe('held.nothingToReverse')
    expect(reverseHeld(RELEASE_DETAIL, VIEWER)).toBe('held.noReverse')
    expect(reverseProblems(REVERSE_DRAFT, RELEASE_DETAIL)).toEqual(['reverse.problem.quantity', 'reverse.problem.reasonCode', 'reverse.problem.reason'])
    expect(reverseProblems({ ...REVERSE_DRAFT, quantity: '7', reasonCode: 'RECALL', reason: 'Recall' }, RELEASE_DETAIL)).toEqual(['reverse.problem.tooMany'])
    expect(reverseProblems({ ...REVERSE_DRAFT, serialIds: [SERIAL_DETAIL.release.serials[0]!.id], reasonCode: 'RECALL', reason: 'Recall' }, SERIAL_DETAIL)).toEqual(['reverse.problem.serialsTo'])
  })
})

describe('the release rule (Owner answer Q1): loosening asks a reason, then a code', () => {
  it('taking a listed customer off or giving up "always" loosens; adding or "always" tightens', () => {
    const draft = ruleDraftOf(RULE)
    expect(ruleProblems(RULE, draft)).toEqual(['rules.problem.nothing'])
    const off = { ...draft, customers: draft.customers.filter((customer) => customer.listedOn === 'TENANT') }
    expect(ruleLoosens(RULE, off)).toBe(true)
    expect(ruleProblems(RULE, off)).toEqual(['rules.problem.reason'])
    expect(ruleProblems(RULE, { ...off, reason: 'By contract' })).toEqual([])
    expect(ruleLoosens(RULE, { ...draft, rule: 'ALWAYS' })).toBe(false)
    expect(ruleLoosens({ ...RULE, own: { ...RULE.own!, releaseFourEyes: 'ALWAYS' } }, { ...draft, rule: 'WHEN_REQUIRED' })).toBe(true)
  })

  it('a step-up refusal asks for the code and runs the action once more; a closed dialog does nothing', async () => {
    let calls = 0
    const work = async () => {
      calls += 1
      if (calls === 1) throw new ApiError('step_up', 403, 'forbidden', 'x')
      return 'done'
    }
    await expect(runWithStepUp(work, async () => undefined)).resolves.toBe('done')
    expect(calls).toBe(2)
    await expect(runWithStepUp(async () => Promise.reject(new ApiError('step_up', 403, 'forbidden', 'x')), async () => Promise.reject(new StepUpCancelled()))).rejects.toBeInstanceOf(StepUpCancelled)
    expect(stepUpProblem(new ApiError('rate_limited', 429, 'rate_limited', 'x'))).toBe('stepUp.problem.locked')
  })
})

describe('New inspection', () => {
  it('the lot fits the finished garments; the sample fits the lot; acceptance numbers whole', () => {
    expect(finishedOf(WO_CELLS)).toBe(24)
    expect(newProblems(NEW_DRAFT, null)).toEqual(['new.problem.workOrder'])
    const draft = { ...NEW_DRAFT, workOrderId: 'x', lotSize: '30', sampleSize: '40', acceptMajor: '0', acceptMinor: '' }
    expect(newProblems(draft, 24)).toEqual(['new.problem.lotOverFinished', 'new.problem.sampleOverLot', 'new.problem.accept'])
    expect(newProblems({ ...draft, lotSize: '24', sampleSize: '5', acceptMinor: '1' }, 24)).toEqual([])
    expect(newProblems({ ...draft, lotSize: '5', sampleSize: '6', acceptMinor: '1' }, 24)).toEqual(['new.problem.sampleOverLot'])
  })
})

describe('the evidence trail: the chain in order, the verdict, no person, no money', () => {
  it('everything present on a full batch; the gaps named on a batch with a failed lot and no leaflet', () => {
    expect(verdictOf(chainOf(EVIDENCE))).toEqual({ present: 10, required: 10, gaps: 0, unknown: 0 })
    const gaps = chainOf(EVIDENCE_GAPS)
    expect(gaps.filter((link) => link.state === 'OPEN').map((link) => link.id)).toEqual(['documents', 'materials', 'register'])
    expect(gaps.find((link) => link.id === 'shipment')?.state).toBe('NOT_NEEDED')
  })

  it('production is counted per operation, never per person', () => {
    expect(scansByOperation(EVIDENCE).map((row) => [row.code, row.good])).toEqual([
      ['SEW-BODY', 48],
      ['FIT-ARMOUR', 47],
      ['FINAL', 47],
    ])
  })

  it('opens at a batch or a serial address', () => {
    expect(evidenceAddress('/w/DEMO', { batch: 'DEMO-BT-0142' })).toBe('/w/DEMO/compliance/evidence/batch/DEMO-BT-0142')
    expect(evidenceAddress('/w/DEMO', { serial: 'SN 1', batch: 'B' })).toBe('/w/DEMO/compliance/evidence/serial/SN%201')
    expect(evidenceAddress('/w/DEMO', {})).toBeNull()
  })
})

describe('W2a (B-W2a-67): assigning an inspector, defects from the library, New inspection kinds, Create NCR', () => {
  it('says who an inspection is assigned to — a worker never by name in a list — and picks by value', () => {
    expect(assignedWords(null, 'me')).toEqual({ key: 'assign.nobody' })
    expect(assignedWords({ kind: 'USER', userId: 'me', workerId: null, name: 'X' }, 'me')).toEqual({ key: 'assign.you' })
    expect(assignedWords({ kind: 'USER', userId: 'u', workerId: null, name: 'Demo Two' }, 'me')).toEqual({ key: 'assign.named', params: { name: 'Demo Two' } })
    expect(assignedWords({ kind: 'WORKER', userId: null, workerId: 'w', name: 'Demo Bench' }, 'me')).toEqual({ key: 'assign.bench' })
    expect(assignedWords({ kind: 'WORKER', userId: null, workerId: 'w', name: 'Demo Bench' }, 'me', true)).toEqual({ key: 'assign.benchNamed', params: { name: 'Demo Bench' } })
    expect(assigneeValue({ kind: 'WORKER', userId: null, workerId: 'w' })).toBe('WORKER:w')
    expect(assigneeBody('USER:u')).toEqual({ assigneeId: 'u', assigneeWorkerId: null })
    expect(assigneeBody('')).toEqual({ assigneeId: null, assigneeWorkerId: null })
  })

  it('"Assign N inspections" is held before the click: no right, a signed one, two sites', () => {
    const open = ROWS.filter((row) => row.status === 'OPEN')
    expect(assignHeld(open.slice(0, 2), OWNER)).toBeNull()
    expect(assignHeld(open, VIEWER)).toBe('assign.held.noRight')
    expect(assignHeld([open[0]!, ROWS.find((row) => row.status === 'PASSED')!], OWNER)).toBe('assign.held.notOpen')
    expect(assignHeld([open[0]!, { ...open[1]!, siteId: 'other' }], OWNER)).toBe('assign.held.sites')
    expect(INSPECTORS.inspectors.find((person) => person.made.length > 0)?.made).toEqual(['DEMO-WO-0151'])
  })

  it('a defect from the library adds a line with its class and zone, or one more garment; the list is checked before it is sent', () => {
    const one = withPicked([], LIBRARY[1]!)
    expect(one).toEqual([{ defectClass: 'MAJOR', code: 'STITCH-SKIP', quantity: 1, workOrderSizeId: null, note: null, defectCodeId: LIBRARY[1]!.id, zone: 'SLEEVE_L' }])
    expect(withPicked(one, LIBRARY[1]!)[0]!.quantity).toBe(2)
    expect(changedLine(one, 0, { zone: 'CUFF' })[0]!.zone).toBe('CUFF')
    expect(withoutLine(one, 0)).toEqual([])
    expect(defectLineProblems([{ ...one[0]!, quantity: 9 }], 5)).toEqual(['defects.problem.overSample', 'defects.problem.classOverSample'])
    expect(defectLineProblems([...one, ...one], 5)).toEqual(['defects.problem.twice'])
  })

  it('New inspection: in-line comes with W2b; a return needs the right to inspect returns, and every received line its grade', () => {
    expect(kindHeld('INLINE', OWNER)).toBe('new.kind.held.inline')
    expect(kindHeld('RETURN', OWNER)).toBe('new.kind.held.return')
    expect(kindHeld('RETURN', qualityCan(['sales.returns.view', 'sales.returns.inspect']))).toBeNull()
    expect(kindHeld('FINAL', qualityCan(['quality.inspections.record', 'workorders.view']))).toBeNull()
    expect(returnProblems({ returnId: null, lines: {} }, null)).toEqual(['new.return.problem.pick'])
    const lineA = RETURN_RECORD.lines[0]!.id
    const lineB = RETURN_RECORD.lines[1]!.id
    expect(returnProblems({ returnId: RETURN_RECORD.id, lines: { [lineA]: { grade: 'GOOD', cause: '', note: '' } } }, RETURN_RECORD)).toEqual(['new.return.problem.grade'])
    const draft = { returnId: RETURN_RECORD.id, lines: { [lineA]: { grade: 'DAMAGED', cause: 'OUR_DEFECT', note: ' Seam open ' }, [lineB]: { grade: 'GOOD', cause: '', note: '' } } }
    expect(returnProblems(draft, RETURN_RECORD)).toEqual([])
    expect(returnBody(draft, RETURN_RECORD)).toEqual({
      version: 4,
      lines: [
        { lineId: lineA, grade: 'DAMAGED', cause: 'OUR_DEFECT', conditionNote: 'Seam open' },
        { lineId: lineB, grade: 'GOOD', cause: null, conditionNote: null },
      ],
    })
  })

  it('every Create NCR / Decide in NCR opens the one New NCR (B-W2a-68), prefilled from its record', () => {
    expect(newNcrAddress('/w/SCA', 'Inspection', 'a b')).toBe('/w/SCA/quality/ncr?new=1&from=Inspection&id=a%20b')
    expect(newNcrAddress('/w/SCA', 'QualityHold', 'h1')).toBe('/w/SCA/quality/ncr?new=1&from=QualityHold&id=h1')
  })

  it('an assigned inspection is recorded only by its assignee (held with the reason)', () => {
    const assigned = readOf({ ...ANSWERED, assigned: { kind: 'USER', userId: 'other', workerId: null, name: 'Demo Two' } }, { yours: false })
    expect(recordAbilities(assigned, OWNER).recordHeld).toBe('held.assignedOther')
    expect(recordAbilities(readOf(ANSWERED, { yours: false }), OWNER).recordHeld).toBe('held.notYours')
  })
})

describe('errors in our words; the API’s refusal lines kept as data', () => {
  it('maps the kinds and reads the gate refusal (`checks/<CODE>` then its fix)', () => {
    expect(problemKey(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('problem.conflict')
    expect(problemKey(new Error('x'))).toBe('problem.unavailable')
    const refusal = new ApiError('conflict', 409, 'conflict', 'x', null, [
      { path: 'checks/LABELS', message: 'BLK 54 has 6 labels.' },
      { path: 'checks/LABELS/fix', message: 'Print the labels.' },
      { path: 'other', message: 'no' },
    ])
    expect(refusalLines(refusal, 'checks')).toEqual([{ code: 'LABELS', message: 'BLK 54 has 6 labels.', fix: 'Print the labels.' }])
  })
})

describe('record links: the quality records open their own pages', () => {
  it('inspection, release (DetailModal), lot and register entry; the lists of Today land on the built pages', () => {
    expect(recordAddress({ type: 'Inspection', id: 'i1' }, OFFICE_PAGES)).toBe('/quality/inspections/i1')
    expect(recordAddress({ type: 'QualityRelease', id: 'r1' }, OFFICE_PAGES)).toBe('/quality/inspections?open=r1')
    expect(recordAddress({ type: 'Lot', id: 'l1' }, OFFICE_PAGES)).toBe('/warehouse/lots/l1')
    expect(recordAddress({ type: 'PpeRegisterEntry', id: 'e1' }, OFFICE_PAGES)).toBe('/compliance/register/e1')
    expect(recordAddress({ type: 'QualityHold', id: 'h1' }, OFFICE_PAGES)).toBe('/quality/holds?open=h1')
    expect(recordAddress({ type: 'DefectCode', id: 'd1' }, OFFICE_PAGES)).toBe('/quality/defects?open=d1')
    expect(listAddress('/compliance/register', { status: 'OPEN' }, OFFICE_PAGES)).toBe('/compliance/register?status=OPEN')
    expect(listAddress('/quality/lots', { onHold: 'true' }, OFFICE_PAGES)).toBe('/compliance/tests?onHold=true')
    expect(Object.keys(RECORD_PAGES)).toEqual(expect.arrayContaining(['Inspection', 'QualityRelease', 'Lot', 'PpeRegisterEntry']))
    expect(Object.keys(LIST_PAGES)).toEqual(expect.arrayContaining(['/quality/inspections', '/quality/lots', '/compliance/register']))
  })
})

// ---- every design case, both languages, no key on screen -------------------------------------------------------------------

const QUALITY_KEYS = Object.keys(CATALOGUE.en.quality ?? {})
const PREFIXES = [...new Set(QUALITY_KEYS.map((key) => key.split('.')[0]!))].filter((prefix) => prefix.length > 2)
const LEFT_KEY = new RegExp(`\\b(?:${PREFIXES.join('|')})\\.[a-zA-Z][a-zA-Z0-9_]*(?:\\.[a-zA-Z0-9_]+)*`)

describe('every design case draws in both languages with no key left on screen', () => {
  const render = (screen: DesignScreen<unknown>, model: unknown, locale: (typeof LOCALES)[number]) => {
    const View = screen.view as ComponentType<{ model: unknown }>
    return renderToString(createElement(I18nProvider, { locale, messages: messagesFor(locale, ['shell']) }, createElement(View, { model })))
  }
  for (const screen of [listScreen, recordScreen, evidenceScreen] as DesignScreen<unknown>[]) {
    for (const locale of LOCALES) {
      it(`${screen.screen} in ${locale}: ${screen.cases.length} cases`, () => {
        for (const item of screen.cases) {
          const html = render(screen, item.model, locale).replace(/(?:href|src|id|class|aria-[a-z]+|data-[a-z-]+|name|for)="[^"]*"/g, '')
          expect(html.length, item.id).toBeGreaterThan(300)
          expect(html.match(LEFT_KEY)?.[0] ?? null, `${screen.screen}/${item.id} (${locale})`).toBeNull()
        }
      })
    }
  }

  it('Italian words where English would be (a sample)', () => {
    const it = createScopedTranslator('it', messagesFor('it', ['quality']), 'quality')
    expect(it('list.new')).toBe('Nuova ispezione')
    expect(it('release.confirm', { count: 3 })).toBe('Rilascia 3 capi')
  })

  it('no money on any of these screens (the evidence trail never shows a cost)', () => {
    for (const screen of [listScreen, recordScreen, evidenceScreen] as DesignScreen<unknown>[]) {
      for (const item of screen.cases) expect(render(screen, item.model, 'en'), `${screen.screen}/${item.id}`).not.toMatch(/€|EUR\b/)
    }
  })
})
