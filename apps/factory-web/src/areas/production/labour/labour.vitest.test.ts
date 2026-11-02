import { createElement, type ReactNode } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { apiErrorFrom } from '../../../lib/api/errors'
import { createApiClient } from '../../../lib/api/client'
import { messagesFor } from '../../../lib/i18n/messages'
import { I18nProvider } from '../../../lib/i18n/provider'
import { correctionRequest, labourDispute, labourRecord, scansAround } from './api'
import { base, BLOCK_LONG, BLOCK_NORMAL, CORRECTION, DAY_READY, designScreen, DISPUTE_RECORD, ITEMS, keyOf, ready, type LabourCase } from './fixtures'
import { designScreen as offStandardScreen } from './offstandard/fixtures'
import {
  addressOf,
  blockDecision,
  decidesOneCorrection,
  addressText,
  agePhrase,
  approveHeld,
  blockCorrection,
  changeLines,
  chunks,
  closeDayHeld,
  dayOpenHeld,
  editReason,
  fieldKey,
  isLabourChange,
  LABOUR_NAMESPACES,
  labourCanOf,
  legalRowOf,
  lineDayOf,
  linesOffered,
  namesShown,
  nextAfter,
  normalHeld,
  normalTargets,
  openOf,
  reasonHeld,
  refusalCode,
  rejectHeld,
  reopenDayHeld,
  rowHeld,
  searchItems,
  sheetHeld,
  tileKind,
  valueText,
  writeProblem,
  type ItemRecord,
  type ValueWords,
} from './model'
import { ItemDetailBody } from './view/ItemDetail'
import { LabourView } from './view/LabourView'

const everything = labourCanOf(['production.labour.view', 'production.labour.close', 'production.labour.reopen', 'production.labour.answer', 'production.scan.correct', 'production.offstandard.view', 'production.offstandard.approve', 'workorders.view', 'production.settings.view', 'people.figures.view', 'people.view'])
const nothing = labourCanOf(['production.labour.view'])
const words: ValueWords = { instant: (iso) => `at ${iso}`, code: (id) => (id === 'c1' ? 'CLEANING' : null), word: (key) => key, clock: (kind) => `clock ${kind}` }

const refused = (path: string, status = 409) => apiErrorFrom(status, { error: { code: 'CONFLICT', message: 'no', requestId: 'r', issues: [{ path, message: 'no' }] } })

describe('Labour & corrections: the address', () => {
  const read = (text: string) => addressOf(new URLSearchParams(text))

  it('reads and writes the kind, the line, the item, the dates; a wrong word is no filter', () => {
    const address = read('kind=OFF_STANDARD&line=l1&q=wo&open=DISPUTE:d1&state=READY&from=2026-11-01&to=2026-11-07&editKind=CLOCK_EDIT&editFrom=2026-11-02&editTo=x')
    expect(address).toEqual({ kind: 'OFF_STANDARD', line: 'l1', q: 'wo', open: 'DISPUTE:d1', state: 'READY', from: '2026-11-01', to: '2026-11-07', editKind: 'CLOCK_EDIT', editFrom: '2026-11-02', editTo: null })
    expect(read('kind=NOPE&state=NOPE&editKind=NOPE').kind).toBeNull()
    expect(addressText({ ...read(''), kind: 'LINE_DAY', open: 'LINE_DAY:l1:2026-11-16' })).toBe('?kind=LINE_DAY&open=LINE_DAY%3Al1%3A2026-11-16')
    expect(addressText(read(''))).toBe('')
  })

  it('reads an item back from the address; anything else opens nothing', () => {
    expect(openOf('CORRECTION:r1')).toEqual({ kind: 'CORRECTION', id: 'r1' })
    expect(openOf('LINE_DAY:l1:2026-11-16')).toEqual({ kind: 'LINE_DAY', id: 'l1:2026-11-16' })
    expect(lineDayOf('l1:2026-11-16')).toEqual({ lineId: 'l1', workDate: '2026-11-16' })
    for (const wrong of [null, '', 'r1', 'NOPE:r1', 'LINE_DAY:l1', 'LINE_DAY:l1:not-a-day', 'CORRECTION:']) expect(openOf(wrong)).toBeNull()
  })

  it('a tile is the queue kind; pressed again, the whole queue', () => {
    expect(tileKind({ kind: null }, 'DISPUTE')).toBe('DISPUTE')
    expect(tileKind({ kind: 'DISPUTE' }, 'DISPUTE')).toBeNull()
    expect(tileKind({ kind: 'DISPUTE' }, 'LINE_DAY')).toBe('LINE_DAY')
  })
})

describe('the legal basis (Statuto dei Lavoratori art. 4; the gate is the API\'s reading, never this page\'s)', () => {
  const site = { id: 's1', name: 'Nord' }
  const basis = { kind: 'UNION_AGREEMENT', reference: 'RSU 12', recordedAt: '2026-03-03T09:00:00.000Z', recordedByName: 'A' }
  const on = { open: true, leadsSeeFigures: false }
  const off = { open: false, leadsSeeFigures: false }

  it('says the basis only with the gate in force, and the site names workers', () => {
    expect(legalRowOf(site, { scanSubject: 'WORKER', legalBasis: basis }, on).state).toBe('BASIS')
    expect(legalRowOf(site, { scanSubject: 'WORKER', legalBasis: basis }, off).state).toBe('GATE_OFF')
    expect(legalRowOf(site, null, on).state).toBe('ON')
  })

  it('a station site has no per-person sheets, whatever its gate says', () => {
    expect(legalRowOf(site, { scanSubject: 'STATION', legalBasis: basis }, on).state).toBe('STATION')
    expect(legalRowOf(site, { scanSubject: 'STATION', legalBasis: basis }, { open: true, leadsSeeFigures: true }).leads).toBe(false)
  })

  it('a read that failed is said as such, never as on or off', () => {
    expect(legalRowOf(site, { scanSubject: 'WORKER', legalBasis: basis }, null).state).toBe('UNKNOWN')
  })

  it('names only what the API served behind the gate', () => {
    expect(namesShown({ worker: { name: 'M' }, workerHidden: false })).toBe(true)
    expect(namesShown({ worker: null, workerHidden: true })).toBe(false)
    expect(namesShown({ worker: { name: 'M' }, workerHidden: true })).toBe(false)
  })

  it('holds "Open this person\'s day" while the gate hides the person, without an employee record, or without the right', () => {
    expect(dayOpenHeld({ workerHidden: true, employeeId: null, worker: null }, everything)).toBe('held.sheetsOff')
    expect(dayOpenHeld({ workerHidden: false, employeeId: null, worker: { name: 'M' } }, everything)).toBe('held.noEmployee')
    expect(dayOpenHeld({ workerHidden: false, employeeId: 'e1', worker: { name: 'M' } }, nothing)).toBe('held.noFigures')
    expect(dayOpenHeld({ workerHidden: false, employeeId: 'e1', worker: { name: 'M' } }, everything)).toBeNull()
  })

  it('the sheet takes a reason for someone else, and says why it cannot open', () => {
    expect(sheetHeld(null, '', false)).toBe('held.loading')
    expect(sheetHeld({ allowed: false, as: null, refusal: 'GATE_CLOSED', needsReason: false }, '', false)).toBe('held.sheetsOff')
    expect(sheetHeld({ allowed: false, as: null, refusal: 'NOT_ALLOWED', needsReason: false }, '', false)).toBe('held.noFigures')
    expect(sheetHeld({ allowed: true, as: 'FIGURE_ROLE', refusal: null, needsReason: true }, '', false)).toBe('held.sheetReason')
    expect(sheetHeld({ allowed: true, as: 'FIGURE_ROLE', refusal: null, needsReason: true }, 'PAY_QUERY', false)).toBeNull()
    expect(sheetHeld({ allowed: true, as: 'SELF', refusal: null, needsReason: false }, '', false)).toBeNull()
  })
})

describe('the queue', () => {
  it('only normal blocks and days join a bulk; unusual blocks and the rest say why', () => {
    expect(rowHeld(BLOCK_NORMAL, everything)).toBeNull()
    expect(rowHeld(DAY_READY, everything)).toBeNull()
    expect(rowHeld(BLOCK_LONG, everything)).toEqual({ key: 'select.unusual' })
    expect(rowHeld(CORRECTION, everything)).toEqual({ key: 'select.oneByOne' })
    expect(rowHeld(BLOCK_NORMAL, nothing)).toEqual({ key: 'held.noApprove' })
    expect(rowHeld(DAY_READY, nothing)).toEqual({ key: 'held.noClose' })
    expect(normalTargets(ITEMS).map((item) => item.id)).toEqual(ITEMS.filter((item) => item.kind === 'OFF_STANDARD' && item.unusual.length === 0).map((item) => item.id))
  })

  it('Approve normal blocks is held with why', () => {
    expect(normalHeld(3, nothing, false)).toBe('held.noApprove')
    expect(normalHeld(0, everything, false)).toBe('held.noNormal')
    expect(normalHeld(null, everything, false)).toBe('held.loading')
    expect(normalHeld(3, everything, true)).toBe('held.busy')
    expect(normalHeld(3, everything, false)).toBeNull()
  })

  it('splits a bulk at what one call takes', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(chunks([], 2)).toEqual([])
  })

  it('searches the line, the work order and the code words; never a person', () => {
    const found = (q: string) => searchItems(ITEMS, q, (kind) => kind, () => null).map((item) => item.kind)
    expect(found('wo-00042')).toEqual(['CORRECTION'])
    expect(found('training')).toEqual(['OFF_STANDARD'])
    expect(found('')).toHaveLength(ITEMS.length)
  })

  it('after a decision the next item opens: the same place, else the one before, else nothing', () => {
    expect(nextAfter(['a', 'b', 'c'], 'b')).toBe('c')
    expect(nextAfter(['a', 'b', 'c'], 'c')).toBe('b')
    expect(nextAfter(['a'], 'a')).toBeNull()
    expect(nextAfter(['a', 'b'], 'z')).toBe('a')
  })

  it('offers the lines read and any a row names, once', () => {
    const line = { id: 'l1', code: 'L1', name: 'Uno' }
    expect(linesOffered([line], [{ line }, { line: { id: 'l2', code: 'L10', name: 'Dieci' } }, { line: null }, { line: { id: 'l3', code: 'L2', name: 'Due' } }]).map((row) => row.code)).toEqual(['L1', 'L2', 'L10'])
  })

  it('an age in words', () => {
    expect(agePhrase(5)).toEqual({ key: 'age.min', params: { count: 5 } })
    expect(agePhrase(125)).toEqual({ key: 'age.h', params: { count: 2 } })
    expect(agePhrase(3000)).toEqual({ key: 'age.d', params: { count: 2 } })
  })

  it('the live messages that matter here (a hint: the page reads again)', () => {
    for (const type of ['labour_day.closed', 'labour_dispute.raised', 'production.scan_correction_requested', 'production.scan_correction_decided', 'production.off_standard_ended', 'production.off_standard_recorded', 'production.off_standard_decided']) expect(isLabourChange(type), type).toBe(true)
    for (const type of ['production.off_standard_code_changed', 'production.off_standard_started', 'production.scan_recorded', 'help_call.raised']) expect(isLabourChange(type), type).toBe(false)
  })
})

describe('held steps', () => {
  const state = { can: everything, busy: false }
  const read = { can: nothing, busy: false }
  const blockRecord = (over: object) => ({ kind: 'OFF_STANDARD', item: null, block: { status: 'PENDING', own: false, canDecide: true, ...over } }) as never

  it('holds each kind for its own permission', () => {
    expect(approveHeld(null, state)).toBe('held.loading')
    expect(approveHeld({ kind: 'CORRECTION', request: { status: 'PENDING' }, record: null, around: null } as never, read)).toBe('held.noCorrect')
    expect(approveHeld(DISPUTE_RECORD, read)).toBe('held.noAnswer')
    expect(approveHeld(blockRecord({}), read)).toBe('held.noApprove')
    expect(approveHeld({ kind: 'LINE_DAY', day: { state: 'READY' } } as never, read)).toBe('held.noClose')
  })

  it('never lets a person decide their own', () => {
    expect(approveHeld(blockRecord({ own: true, canDecide: false }), state)).toBe('held.ownBlock')
    expect(approveHeld({ kind: 'DISPUTE', dispute: { status: 'OPEN', own: true, canAnswer: false } } as never, state)).toBe('held.ownDispute')
  })

  it('says a decided item is decided, and that a line day has nothing to reject', () => {
    expect(approveHeld(blockRecord({ status: 'APPROVED', canDecide: false }), state)).toBe('held.decided')
    expect(approveHeld({ kind: 'CORRECTION', request: { status: 'REFUSED' }, record: null, around: null } as never, state)).toBe('held.decided')
    expect(rejectHeld({ kind: 'LINE_DAY', day: { state: 'READY' } } as never, state)).toBe('held.dayNoReject')
  })

  it('holds a day until anomalies are cleared, with the count', () => {
    const blockers = [{ kind: 'OFF_STANDARD_WAITING' as const, count: 2 }, { kind: 'DISPUTE_OPEN' as const, count: 1 }]
    expect(closeDayHeld({ state: 'OPEN', blockers }, everything, false)).toEqual({ key: 'held.dayHeldCount', params: { count: 3 } })
    expect(closeDayHeld({ state: 'READY', blockers: [] }, everything, false)).toBeNull()
    expect(closeDayHeld({ state: 'READY', blockers: [] }, nothing, false)).toEqual({ key: 'held.noClose' })
    expect(closeDayHeld({ state: 'CLOSED', blockers: [] }, everything, false)).toEqual({ key: 'held.closedAlready' })
    expect(reopenDayHeld({ state: 'CLOSED' }, nothing, false)).toEqual({ key: 'held.noReopen' })
    expect(reopenDayHeld({ state: 'OPEN' }, everything, false)).toEqual({ key: 'held.notClosed' })
  })

  it('wants a reason, at each kind\'s length', () => {
    expect(reasonHeld('OFF_STANDARD', '  ', false)).toBe('held.reason')
    expect(reasonHeld('CORRECTION', 'no', false)).toBe('held.reasonShort')
    expect(reasonHeld('OFF_STANDARD', 'no', false)).toBeNull()
    expect(reasonHeld('CORRECTION', 'x'.repeat(301), false)).toBe('held.reasonLong')
  })

  it('an upheld answer carries only what changes of a block; a rejection or a report none', () => {
    const dispute = { recordType: 'OffStandardEntry' as const, record: { version: 3, startedAt: '2026-11-17T08:00:00.000Z', endedAt: '2026-11-17T09:00:00.000Z' } } as never
    const draft = { outcome: 'UPHELD' as const, answer: 'ok', fix: { codeId: '', startedAt: '', endedAt: '2026-11-17T08:30:00.000Z' } }
    expect(blockCorrection(dispute, draft)).toEqual({ version: 3, endedAt: '2026-11-17T08:30:00.000Z' })
    expect(blockCorrection(dispute, { ...draft, fix: { codeId: '', startedAt: '2026-11-17T08:00:00.000Z', endedAt: '' } })).toBeNull()
    expect(blockCorrection(dispute, { ...draft, outcome: 'REJECTED' })).toBeNull()
    expect(blockCorrection({ recordType: 'OperationScan', record: { version: null } } as never, draft)).toBeNull()
  })
})

describe('words', () => {
  it('writes a change in the page\'s words, never the field\'s own name, and a value taken away in ours', () => {
    expect(fieldKey('good')).toBe('field.good')
    expect(fieldKey('overtime_dayMinutes')).toBe('field.minutes')
    expect(fieldKey('anythingElse')).toBe('field.other')
    expect(changeLines([{ field: 'good', from: 12, to: 10 }], words)).toEqual([{ label: 'field.good', from: '12', to: '10' }])
    expect(changeLines([{ field: 'clock', from: 'IN 2026-11-16T07:02:00.000Z', to: null }], words)).toEqual([{ label: 'field.clock', from: 'clock IN at 2026-11-16T07:02:00.000Z', to: 'change.none' }])
    expect(changeLines([{ field: 'codeId', from: 'c1', to: 'c2' }], words)).toEqual([{ label: 'field.codeId', from: 'CLEANING', to: '—' }])
    expect(changeLines([{ field: 'good', from: null, to: null }], words)).toEqual([])
    expect(valueText('status', 'PENDING', words)).toBe('blockStatus.PENDING')
    expect(valueText('startedAt', '2026-11-17T08:00:00.000Z', words)).toBe('at 2026-11-17T08:00:00.000Z')
  })

  it('shows the person\'s answer of a dispute\'s correction, not the API\'s stored prefix', () => {
    expect(editReason('Dispute upheld: Ho corretto', 'd1')).toBe('Ho corretto')
    expect(editReason('Dispute upheld: left as stored', null)).toBe('Dispute upheld: left as stored')
    expect(editReason(null, 'd1')).toBeNull()
  })

  it('says each refusal in the page\'s words', () => {
    expect(refusalCode(refused('refusal/HELD'))).toBe('HELD')
    expect(refusalCode(refused('gate/PERFORMANCE'))).toBe('GATE')
    expect(refusalCode(refused('figures/NOT_ALLOWED', 403))).toBe('FIGURES')
    expect(writeProblem(refused('refusal/HELD'))).toEqual({ key: 'refusal.HELD' })
    expect(writeProblem(refused('gate/PERFORMANCE'))).toEqual({ key: 'refusal.GATE' })
    expect(writeProblem(refused('refusal/PREVIOUS_NOT_REPORTED'))).toEqual({ key: 'refusal.PREVIOUS_NOT_REPORTED' })
    expect(writeProblem(refused('refusal/SOMETHING_NEW'))).toEqual({ key: 'problem.refused' })
    expect(writeProblem(refused('other'))).toEqual({ key: 'problem.changed' })
    expect(writeProblem(new Error('x'))).toEqual({ key: 'problem.write' })
  })
})

function render(node: ReactNode): string {
  return renderToStaticMarkup(createElement(I18nProvider, { locale: 'en', messages: messagesFor('en', [...LABOUR_NAMESPACES, 'shell']) }, node))
}

describe('the page, drawn', () => {
  it('B-W2b-73: production.scan.correct alone opens the one correction from Today: no queue, no "no access"', () => {
    const correctOnly = labourCanOf(['production.scan.correct'])
    expect(decidesOneCorrection(correctOnly, { kind: 'CORRECTION', id: 'k1' })).toBe(true)
    expect(decidesOneCorrection(correctOnly, { kind: 'DISPUTE', id: 'd1' })).toBe(false)
    expect(decidesOneCorrection(correctOnly, null)).toBe(false)
    expect(decidesOneCorrection(everything, { kind: 'CORRECTION', id: 'k1' })).toBe(false)
    expect(decidesOneCorrection(labourCanOf([]), { kind: 'CORRECTION', id: 'k1' })).toBe(false)
    const drawn = (id: string) => render(createElement(LabourView, { model: designScreen.cases.find((entry) => entry.id === id)!.model.model }))
    expect(drawn('correct-only')).toContain('You decide scan corrections from Today')
    expect(drawn('correct-only-closed')).toContain('Open Today')
    expect(drawn('no-permission')).toContain('cannot see Labour')
  })

  const NAME = 'Marta Esempio'

  it('puts the legal basis before anything else, and no name or key anywhere in the lists', () => {
    const html = render(createElement(LabourView, { model: base('production').model }))
    expect(html.indexOf('aria-label="Legal basis"')).toBeLessThan(html.indexOf('To decide, by kind'))
    expect(html).toContain('union agreement')
    expect(html).toContain('One person at a time; views are logged.')
    expect(html).not.toContain(NAME)
  })

  it('names the worker only inside the one record the API named them in', () => {
    const open = (key: LabourCase) => (key.model.detail?.loaded.status === 'ready' ? key.model.detail.loaded.value : null)
    const named = designScreen.cases.find((entry) => entry.id === 'correction')!.model
    const hidden = designScreen.cases.find((entry) => entry.id === 'correction-hidden')!.model
    expect(render(createElement(ItemDetailBody, { model: named.model, record: open(named)! }))).toContain(NAME)
    const html = render(createElement(ItemDetailBody, { model: hidden.model, record: open(hidden)! }))
    expect(html).not.toContain(NAME)
    expect(html).toContain('A person is on this record.')
  })

  it('B-W2b-73: a decider the gate keeps back says "a person", with no key and no name; a name the API served stays', () => {
    const body = (id: string) => {
      const entry = offStandardScreen.cases.find((item) => item.id === id)!.model
      return render(createElement(ItemDetailBody, { model: entry.model, record: (entry.model.detail!.loaded as { value: ItemRecord }).value }))
    }
    expect(body('decided-hidden')).toContain('Approved by')
    expect(body('decided-hidden')).toContain('A person')
    expect(body('decided-hidden')).not.toContain('detail.')
    expect(body('rejected-hidden')).toContain('Rejected by')
    expect(body('rejected-hidden')).toContain('A person')
    expect(body('decided-named')).toContain('Bea Esempio')
    expect(body('decided-named')).not.toContain('A person')
    expect(blockDecision({ approvedAt: null, approvedBy: null, approvedByHidden: false, rejectedAt: null, rejectedBy: null, rejectedByHidden: false })).toBeNull()
    const italian = offStandardScreen.cases.find((item) => item.id === 'decided-hidden')!.model
    const html = renderToStaticMarkup(createElement(I18nProvider, { locale: 'it', messages: messagesFor('it', [...LABOUR_NAMESPACES, 'shell']) }, createElement(ItemDetailBody, { model: italian.model, record: (italian.model.detail!.loaded as { value: ItemRecord }).value })))
    expect(html).toContain('Una persona')
    expect(html).toContain('Approvato da')
  })

  it('every design case has made-up data and draws without a raw key', () => {
    for (const screen of [designScreen, offStandardScreen]) {
      for (const entry of screen.cases) {
        const html = render(createElement(LabourView, { model: entry.model.model }))
        expect(html, `${screen.screen}/${entry.id}`).not.toMatch(/\b(held|legal|tile|queue|days|edits|detail|notice)\.[a-zA-Z]+\b/)
      }
    }
  })

  it('a row of the open item keeps its key', () => {
    expect(base('production', { detail: ready(CORRECTION, DISPUTE_RECORD) }).model.detail?.key).toBe(keyOf(CORRECTION))
  })
})

describe('the calls read a person only where the API serves one', () => {
  const answering = (body: unknown) => createApiClient({ baseUrl: '/api', fetch: (async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as typeof fetch })

  it('keeps worker and employee of one record, null while the gate is off', async () => {
    const record = { scanId: 's', state: 'STANDING', siteId: 's1', workDate: '2026-11-17', at: 'x', workOrder: { id: 'w', number: 'W' }, bundle: { id: 'b', code: 'B' }, operation: { id: 'o', seq: 1, code: 'O', name: 'N', standardMinutes: '1' }, line: null, station: null, reported: { good: 1, scrap: 0, rework: 0 }, counts: { good: 1, scrap: 0, rework: 0 }, earnedMinutes: '1.000', steps: [], worker: null, employeeId: null, workerHidden: true, enteredByLead: false, disputes: [], correctionsWaiting: 0 }
    expect(await labourRecord(answering({ record }), 's')).toMatchObject({ worker: null, employeeId: null, workerHidden: true })
    await expect(labourDispute(answering({ dispute: {} }), 'd')).rejects.toBeTruthy()
  })

  it('never reads the names the correction request and the scans list carry (W1: no legal gate on those reads)', async () => {
    const request = { id: 'r', status: 'PENDING', workOrderId: 'w', bundleId: 'b', scanId: 's', goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, reason: 'x', serverTime: 'x', decisionNote: null, bundleCode: 'B', operation: { id: 'o', seq: 1, code: 'O', name: 'N' }, workOrder: { id: 'w', number: 'W' }, recorded: null, askedAt: null, askedBy: { id: 'p', name: 'Someone' }, scan: { worker: { id: 'p', name: 'Someone' } } }
    expect(JSON.stringify(await correctionRequest(answering({ request }), 'r'))).not.toContain('Someone')
    const scan = { id: 's', kind: 'REPORT', operation: { id: 'o', seq: 1, code: 'O', name: 'N' }, goodQuantity: 1, scrapQuantity: 0, reworkQuantity: 0, serverTime: 'x', station: null, voidedById: null, worker: { id: 'p', name: 'Someone' } }
    expect(JSON.stringify(await scansAround(answering({ scans: [scan] }), 'w', 'b'))).not.toContain('Someone')
  })
})
