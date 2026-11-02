import { describe, expect, it } from 'vitest'
import { addLot, componentLines, componentMissing, componentRows, dropLot, garmentsOn, heldFindings, isOverridable, lineOf, overridable, quantityRule, stepLot, tickStep, toldFindings, workHold, type CheckFinding, type LotLine, type OperationCheck, type OperationSteps } from './checks'
import { startedBlock, tileReason, type OffStandardTile } from './indirect'
import { finishHeld, goodOf, NO_COUNTS, reportPayload, setGood, undoOpen, type BundleCard, type CardOperation, type Counts, type LastAction } from './model'
import { moreFiles, NEW_NOTE, noteHeld, notePayload } from './notes'
import { addToStack, afterFinish, ALL_SIZES, joinedBundles, MAX_STACK, rowsOfSize, sizesOf, stackItems, stackTotals, stepRow, takeOffStack, type StackRow } from './stack'
import { afterPause, afterResume, afterStart, barOf, clockOf, NOT_STARTED, piecesLeft, resumeRows, skewOf, type OpenItem, type Timing } from './timing'
import { clipTypeOf } from './view/ClipCapture'

/** B-W2b-69: the rules of the operation screen every shift, figures by hand. */

const T0 = new Date('2026-10-29T08:00:00.000Z')
const later = (seconds: number) => new Date(T0.getTime() + seconds * 1000)

describe('timing: the bundle\'s own clock', () => {
  it('Finish is never in the timing: each state asks its own bar, and nothing at all is needed to report (F3)', () => {
    expect(barOf(null)).toBe('start')
    expect(barOf(NOT_STARTED)).toBe('start')
    const running = afterStart(NOT_STARTED, T0)
    expect(barOf(running)).toBe('running')
    expect(barOf(afterPause(running, 'BREAK', later(60)))).toBe('paused')
    expect(barOf({ ...running, mine: false, actions: [] })).toBe('other')
    expect(barOf({ ...NOT_STARTED, state: 'REPORTED', actions: [] })).toBe('other')
    expect(running.actions).toEqual(['PAUSE', 'PARTIAL', 'HAND_BACK'])
  })

  it('a pause carries the minutes that ran; the clock stands still; resume goes on from there', () => {
    const running = afterStart(NOT_STARTED, T0)
    const paused = afterPause(running, 'MATERIAL_WAIT', later(754))
    expect(paused).toMatchObject({ state: 'PAUSED', secondsBefore: 754, runningSince: null, pauseReasonCode: 'MATERIAL_WAIT', actions: ['RESUME', 'PARTIAL', 'HAND_BACK'] })
    expect(clockOf(paused, 0)).toEqual({ since: null, carriedMs: 754_000, paused: true })
    const resumed = afterResume(paused, later(1000))
    expect(resumed).toMatchObject({ state: 'RUNNING', secondsBefore: 754, pauseReasonCode: null, pausedAt: null })
    expect(clockOf(resumed, 0)).toEqual({ since: later(1000).getTime(), carriedMs: 754_000, paused: false })
    // A second pause adds the second stretch, the pause between left out.
    expect(afterPause(resumed, 'BREAK', later(1100)).secondsBefore).toBe(854)
  })

  it('the clock starts on the tablet\'s own time: the skew moves it, never the figure', () => {
    const running: Timing = { ...afterStart(NOT_STARTED, T0), secondsBefore: 30 }
    const tabletAhead = skewOf(T0.toISOString(), later(5))
    expect(tabletAhead).toBe(5000)
    expect(clockOf(running, tabletAhead)).toEqual({ since: T0.getTime() + 5000, carriedMs: 30_000, paused: false })
  })

  it('pieces so far stop before the last piece: that one is the report', () => {
    expect(piecesLeft(20, null)).toBe(19)
    expect(piecesLeft(20, { ...NOT_STARTED, piecesSoFar: 8 })).toBe(11)
    expect(piecesLeft(1, null)).toBe(0)
    expect(piecesLeft(20, { ...NOT_STARTED, piecesSoFar: 25 })).toBe(0)
  })

  it('open work: paused and running come back, nothing else', () => {
    const item = (state: OpenItem['state']): OpenItem => ({ bundleId: state, bundleCode: 'B', operation: { id: 'o', seq: 30, code: 'X', name: 'X' }, state, pausedAt: null, runningSince: null, pausedAtClockOut: false })
    expect(resumeRows([item('RUNNING'), item('PAUSED'), item('REPORTED'), item('NOT_STARTED')]).map((row) => row.state)).toEqual(['RUNNING', 'PAUSED'])
  })
})

const finding = (kind: CheckFinding['kind'], mode: CheckFinding['mode'], code: string, overridableToo = true): CheckFinding => ({ kind, mode, code, message: code, fix: 'fix', overridable: overridableToo })
const CHECK: OperationCheck = { modes: { quantityGuard: 'STRICT', skippedOperationRule: 'WARN' }, expected: 20, beyondBundle: false, findings: [], components: { asked: [], traceable: [] }, overrideReasons: [] }

describe('checks before it counts', () => {
  it('STRICT holds, WARN tells, no check holds nothing', () => {
    const check = { ...CHECK, findings: [finding('SKIPPED_OPERATION', 'WARN', 'PREVIOUS_NOT_REPORTED'), finding('WRONG_BUNDLE', 'STRICT', 'WRONG_BUNDLE')] }
    expect(heldFindings(check).map((row) => row.code)).toEqual(['WRONG_BUNDLE'])
    expect(toldFindings(check).map((row) => row.code)).toEqual(['PREVIOUS_NOT_REPORTED'])
    expect(heldFindings(null)).toEqual([])
    expect(toldFindings(null)).toEqual([])
  })

  it('one line no override lifts stops the override for all', () => {
    const lifted = lineOf(finding('WRONG_BUNDLE', 'STRICT', 'WRONG_BUNDLE'))
    expect(overridable([lifted])).toBe(true)
    expect(overridable([lifted, { ...lifted, code: 'X', overridable: false }])).toBe(false)
    expect(overridable([])).toBe(false)
    expect(isOverridable('MORE_THAN_PASSED')).toBe(true)
    expect(isOverridable('MORE_THAN_BUNDLE')).toBe(false)
    expect(isOverridable('CHECKLIST_OPEN')).toBe(false)
  })

  it('MES-097: more than passed follows the site\'s rule; up to what passed nothing is said', () => {
    expect(quantityRule(CHECK, 20)).toBeNull()
    expect(quantityRule(CHECK, 21)).toBe('held')
    expect(quantityRule({ ...CHECK, modes: { ...CHECK.modes, quantityGuard: 'WARN' } }, 21)).toBe('told')
    expect(quantityRule({ ...CHECK, modes: { ...CHECK.modes, quantityGuard: 'FREE' } }, 21)).toBeNull()
    expect(quantityRule({ ...CHECK, expected: null }, 21)).toBeNull()
    expect(quantityRule(null, 21)).toBeNull()
  })

  it('Finish opens between what passed and the bundle (the rule decides there), never past the bundle', () => {
    const typed = (typedGood: number): Counts => ({ ...NO_COUNTS, typedGood })
    expect(finishHeld(typed(22), 20, 24)).toBeNull()
    expect(finishHeld(typed(25), 20, 24)).toBe('atMost')
    // W1's call without a ceiling keeps W1's rule.
    expect(finishHeld(typed(21), 20)).toBe('atMost')
    expect(setGood(NO_COUNTS, 22, 24)).toMatchObject({ ok: true })
    expect(setGood(NO_COUNTS, 25, 24)).toMatchObject({ ok: false })
  })
})

describe('steps in the operation', () => {
  const STEPS: OperationSteps = { open: 2, steps: [{ code: 'A', words: 'A', required: true, tick: null }, { code: 'B', words: 'B', required: true, tick: null }, { code: 'C', words: 'C', required: false, tick: null }] }

  it('a tick says who and when; a not-applicable one satisfies a required step; an optional one never holds', () => {
    const one = tickStep(STEPS, 'A', 'DONE', T0, 'Ada Demo')
    expect(one.open).toBe(1)
    expect(one.steps[0]!.tick).toEqual({ outcome: 'DONE', at: T0.toISOString(), mine: true, by: 'Ada Demo' })
    expect(tickStep(one, 'B', 'NOT_APPLICABLE', T0, null).open).toBe(0)
  })

  it('Finish waits for the required steps, and for nothing at all on an operation without them (F3)', () => {
    expect(workHold({ steps: STEPS, asked: [], lots: [], counts: NO_COUNTS, expected: 20 })).toEqual({ key: 'steps', count: 2 })
    expect(workHold({ steps: { open: 0, steps: [] }, asked: [], lots: [], counts: NO_COUNTS, expected: 20 })).toBeNull()
    expect(workHold({ steps: null, asked: [], lots: [], counts: NO_COUNTS, expected: 20 })).toBeNull()
  })
})

describe('the lots scanned', () => {
  const PRO = { itemId: 'pro', code: 'PRO-300', name: 'Protector' }
  const LIN = { itemId: 'lin', code: 'FOD-110', name: 'Lining' }
  const lot = (code: string, itemId: string | null = 'pro', garments: number | null = null): LotLine => ({ code, itemId, garments })

  it('the garments that go on carry a lot: good and rework, never scrap', () => {
    expect(garmentsOn({ scrap: { STAIN: 2 }, rework: { RESTITCH: 1 }, typedGood: null }, 20)).toBe(18)
  })

  it('one lot takes all the garments by itself, and follows the counts', () => {
    const lots = [lot('A')]
    expect(componentLines([PRO], lots, 20)).toEqual([{ code: 'A', garments: 20 }])
    expect(componentLines([PRO], lots, 19)).toEqual([{ code: 'A', garments: 19 }])
  })

  it('a second lot asks how many the first covers: Finish waits, a guess would be a wrong trace', () => {
    const two = addLot([PRO], [lot('A')], lot('B'), 20)
    expect(two).toEqual([lot('A', 'pro', 0), lot('B')])
    expect(workHold({ steps: null, asked: [PRO], lots: two, counts: NO_COUNTS, expected: 20 })).toEqual({ key: 'lotCount', code: 'A' })
    const said = stepLot(two, 'A', 1, 19)
    expect(said[0]!.garments).toBe(1)
    const twelve: readonly LotLine[] = [lot('A', 'pro', 12), lot('B')]
    expect(componentLines([PRO], twelve, 20)).toEqual([{ code: 'A', garments: 12 }, { code: 'B', garments: 8 }])
    expect(workHold({ steps: null, asked: [PRO], lots: twelve, counts: NO_COUNTS, expected: 20 })).toBeNull()
    expect(stepLot(twelve, 'A', 1, 12)[0]!.garments).toBe(12)
    expect(stepLot([lot('A', 'pro', 1)], 'A', -1, 12)[0]!.garments).toBe(1)
  })

  it('taking a lot off leaves one that takes all again; the same lot twice is one', () => {
    expect(dropLot([lot('A', 'pro', 12), lot('B')], 'B')).toEqual([lot('A')])
    expect(addLot([PRO], [lot('A')], lot('a'), 20)).toEqual([lot('A')])
  })

  it('each asked component is a row; the first it misses holds Finish in its own words', () => {
    expect(componentRows([PRO, LIN], [lot('A')], 20).map((row) => row.covered)).toEqual([20, 0])
    expect(componentMissing([PRO, LIN], [lot('A')], 20)?.component.code).toBe('FOD-110')
    expect(workHold({ steps: null, asked: [PRO, LIN], lots: [lot('A')], counts: NO_COUNTS, expected: 20 })).toEqual({ key: 'component', code: 'FOD-110', covered: 0, garments: 20 })
    // Nothing goes on (all scrapped): nothing to trace.
    expect(componentMissing([PRO], [], 0)).toBeNull()
  })

  it('a lot read offline fills the first open row: the office checks it when the report arrives', () => {
    const rows = componentRows([PRO, LIN], [lot('X', null), lot('Y', null)], 20)
    expect(rows.map((row) => row.lots.map((line) => line.code))).toEqual([['X'], ['Y']])
  })

  it('a lot of a material nobody asked for still goes with the report, covering all the garments', () => {
    expect(componentLines([], [lot('L', 'lin')], 5)).toEqual([{ code: 'L', garments: 5 }])
    expect(reportPayload({ bundle: { code: 'B-1' } as BundleCard['bundle'] }, 'op', NO_COUNTS, 5, [{ code: 'L', garments: 5 }])).toEqual({ code: 'B-1', workOrderOperationId: 'op', good: 5, components: [{ code: 'L', garments: 5 }] })
    expect(reportPayload({ bundle: { code: 'B-1' } as BundleCard['bundle'] }, 'op', NO_COUNTS, 5)).toEqual({ code: 'B-1', workOrderOperationId: 'op', good: 5 })
  })
})

describe('several bundles at once', () => {
  const OP: CardOperation = { id: 'op-20', seq: 20, code: 'SEW', name: 'Sew', scanRequired: true, workCentreKind: 'SEWING', final: false, sewn: false, state: 'OPEN', expected: 20, report: null }
  const row = (id: string, size: string, part: string | null = null, order = 'wo-1'): StackRow => ({
    clientScanId: `client-${id}`,
    card: { bundle: { id, code: `B-${id}`, size, part, quantity: 20 }, workOrder: { id: order } } as unknown as BundleCard,
    operation: OP,
    counts: NO_COUNTS,
    refusal: null,
  })

  it('Finish 3 bundles · 60 good; each bundle stays its own report under its own id', () => {
    const rows = [row('1', '52'), row('2', '52'), row('3', '54')]
    expect(stackTotals(rows)).toEqual({ bundles: 3, good: 60, scrap: 0, rework: 0 })
    expect(stackItems(rows).map((item) => item.clientScanId)).toEqual(['client-1', 'client-2', 'client-3'])
    expect(stackItems(rows)[0]).toEqual({ clientScanId: 'client-1', code: 'B-1', workOrderOperationId: 'op-20', good: 20 })
  })

  it('a bundle joins once; the stack ends at what one Finish takes', () => {
    const one = addToStack([], row('1', '52'))
    expect(one.ok).toBe(true)
    expect(addToStack([row('1', '52')], row('1', '52'))).toEqual({ ok: false, why: 'twice' })
    const full = Array.from({ length: MAX_STACK }, (_, index) => row(String(index), '52'))
    expect(addToStack(full, row('x', '52'))).toEqual({ ok: false, why: 'full' })
  })

  it('MES-107: the size buttons count pieces per size, in the order scanned; a size shows its bundles', () => {
    const rows = stepRow([row('1', '54'), row('2', '52'), row('3', '54')], 'client-3', -1)
    expect(sizesOf(rows)).toEqual([{ id: '54', label: '54', pieces: 39, bundles: 2 }, { id: '52', label: '52', pieces: 20, bundles: 1 }])
    expect(rowsOfSize(rows, '52').map((entry) => entry.card.bundle.id)).toEqual(['2'])
    expect(rowsOfSize(rows, ALL_SIZES)).toHaveLength(3)
    expect(rowsOfSize(rows, null)).toHaveLength(3)
  })

  it('MES-106: a row steps without typing, never below none, never above the bundle', () => {
    expect(goodOf(stepRow([row('1', '52')], 'client-1', -1)[0]!.counts, 20)).toBe(19)
    const up = Array.from({ length: 3 }).reduce<readonly StackRow[]>((rows) => stepRow(rows, 'client-1', 1), [row('1', '52')])
    expect(goodOf(up[0]!.counts, 20)).toBe(20)
    const zero: StackRow = { ...row('1', '52'), counts: { ...NO_COUNTS, typedGood: 0 } }
    expect(goodOf(stepRow([zero], 'client-1', -1)[0]!.counts, 20)).toBe(0)
  })

  it('after Finish only the refused bundles stay, each with its words', () => {
    const rows = [row('1', '52'), row('2', '52'), row('3', '52')]
    const kept = afterFinish(rows, [
      { clientScanId: 'client-1', status: 'accepted', refusal: null },
      { clientScanId: 'client-2', status: 'refused', refusal: { code: 'CHECKLIST_OPEN', message: 'Steps.', fix: 'Tick.' } },
      { clientScanId: 'client-3', status: 'duplicate', refusal: null },
    ])
    expect(kept.map((entry) => entry.clientScanId)).toEqual(['client-2'])
    expect(kept[0]!.refusal).toEqual({ code: 'CHECKLIST_OPEN', message: 'Steps.', fix: 'Tick.' })
    expect(takeOffStack(rows, 'client-2').map((entry) => entry.clientScanId)).toEqual(['client-1', 'client-3'])
  })

  it('MES-078: different parts of one work order are joined here; the same part is not', () => {
    expect(joinedBundles([row('1', '52', 'SLEEVE'), row('2', '52', 'BODY')])).toEqual(['1', '2'])
    expect(joinedBundles([row('1', '52', 'SLEEVE'), row('2', '52', 'SLEEVE')])).toEqual([])
    expect(joinedBundles([row('1', '52', 'SLEEVE', 'wo-1'), row('2', '52', 'BODY', 'wo-2')])).toEqual([])
    expect(joinedBundles([row('1', '52'), row('2', '52')])).toEqual([])
  })

  it('a stack has no single Undo: each bundle is its own report', () => {
    const last = { at: T0.toISOString(), scannedAfter: false, undoEventId: null, bundles: 3 } as unknown as LastAction
    expect(undoOpen(last, later(10))).toBe(false)
    expect(undoOpen({ ...last, bundles: undefined }, later(10))).toBe(true)
  })
})

describe('no bundle', () => {
  const TILE: OffStandardTile = { id: 't', code: 'CLEANING', kind: 'OFF_STANDARD', labelIt: 'Pulizia', labelEn: 'Cleaning', labelI18n: {}, icon: null, colour: null }
  it('a code is a tile of the one picker, in the office\'s order; a tile queued offline starts on the tablet\'s clock', () => {
    expect(tileReason(TILE, 2)).toMatchObject({ id: 't', list: 'OFF_STANDARD', code: 'CLEANING', sortOrder: 2, needsDetail: false })
    expect(startedBlock(TILE, T0)).toEqual({ id: 'local:t', code: TILE, startedAt: T0.toISOString() })
  })
})

describe('photo or comment', () => {
  const target = { workOrderId: 'wo', bundleId: 'b', workOrderOperationId: 'op' }
  it('a tile is the one thing it asks; Other asks words or a picture', () => {
    expect(noteHeld(NEW_NOTE)).toBe('tile')
    expect(noteHeld({ ...NEW_NOTE, tile: 'DAMAGED' })).toBeNull()
    expect(noteHeld({ ...NEW_NOTE, tile: 'OTHER' })).toBe('detail')
    expect(noteHeld({ ...NEW_NOTE, tile: 'OTHER', words: '  ' })).toBe('detail')
    expect(noteHeld({ ...NEW_NOTE, tile: 'OTHER', words: 'filo' })).toBeNull()
    expect(noteHeld({ ...NEW_NOTE, tile: 'OTHER', files: [{ id: 'f', kind: 'photo', name: 'p' }] })).toBeNull()
    expect(noteHeld({ ...NEW_NOTE, tile: 'DAMAGED', busy: true })).toBe('busy')
  })

  it('the queued note names the work order, the bundle, the operation and its files', () => {
    expect(notePayload({ ...NEW_NOTE, tile: 'DAMAGED' }, target)).toEqual({ ...target, tileCode: 'DAMAGED' })
    expect(notePayload({ ...NEW_NOTE, tile: 'DAMAGED', words: ' filo ', files: [{ id: 'f', kind: 'clip', name: 'c' }] }, target)).toEqual({ ...target, tileCode: 'DAMAGED', note: 'filo', fileIds: ['f'] })
  })

  it('four files on a note at most; the clip takes the first type this tablet records', () => {
    expect(moreFiles({ files: Array.from({ length: 3 }, (_, index) => ({ id: String(index), kind: 'photo' as const, name: 'p' })) })).toBe(true)
    expect(moreFiles({ files: Array.from({ length: 4 }, (_, index) => ({ id: String(index), kind: 'photo' as const, name: 'p' })) })).toBe(false)
    expect(clipTypeOf((type) => type === 'video/webm')).toBe('video/webm')
    expect(clipTypeOf((type) => type.startsWith('video/mp4'))).toBe('video/mp4')
    expect(clipTypeOf(() => false)).toBeNull()
  })
})
