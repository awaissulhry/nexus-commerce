import { describe, expect, it } from 'vitest'
import { abilitiesOf, RECORD_TABS, tabOf } from '../../_shared/model'
import { canOf, OPEN_ROWS, wipOf, workOrder } from '../../_shared/fixtures'
import { minutesOf, overCells, priorityBad, refusedWords, releaseHeld, RELEASE_BULK_LIMIT, splitAskHeld, splitAskOf, splitHeld, splitProblem, TRAVELLER_BULK_LIMIT, travellerIdsOf, travellersHeld, travellersHref } from './model'

const manager = canOf('manager')
const sales = canOf('sales')

describe('Release N', () => {
  const draft = OPEN_ROWS.find((row) => row.status === 'DRAFT')!
  const started = OPEN_ROWS.find((row) => row.status === 'IN_PROGRESS')!

  it('needs the right, then a selection with a draft in it', () => {
    expect(releaseHeld([draft], manager)).toBeNull()
    expect(releaseHeld([draft, started], manager)).toBeNull()
    expect(releaseHeld([draft], sales)).toEqual({ key: 'held.noRelease' })
    expect(releaseHeld([], manager)?.key).toBe('production-every-shift:release.pickFirst')
    expect(releaseHeld([started], manager)?.key).toBe('production-every-shift:release.noDraft')
  })

  it('is held over the API\'s limit', () => {
    expect(releaseHeld(Array.from({ length: RELEASE_BULK_LIMIT + 1 }, () => draft), manager)).toEqual({ key: 'production-every-shift:release.tooMany', params: { max: RELEASE_BULK_LIMIT } })
  })

  it('a held row says the checks that hold it, else its state, else why it was refused', () => {
    expect(refusedWords({ code: 'held', field: 'status', status: 'DRAFT', reasons: ['DEPOSIT', 'MATERIAL'] })).toEqual({ checks: ['DEPOSIT', 'MATERIAL'], key: 'release.heldBy' })
    expect(refusedWords({ code: 'held', status: 'CANCELLED' })).toEqual({ checks: [], key: 'release.heldState' })
    expect(refusedWords({ code: 'stale' })).toEqual({ checks: [], key: 'release.refusal.stale' })
  })
})

describe('the travellers', () => {
  it('one has its own address, several go in one PDF', () => {
    expect(travellersHref('/w/A', ['a'])).toBe('/w/A/production/work-orders/a/traveller')
    expect(travellersHref('/w/A', ['a', 'b'])).toBe('/w/A/production/work-orders/travellers?ids=a,b')
  })

  it('is held with nothing to print, and over the API\'s limit', () => {
    expect(travellersHeld(['a'])).toBeNull()
    expect(travellersHeld([])?.key).toBe('production-every-shift:travellers.none')
    expect(travellersHeld(Array.from({ length: TRAVELLER_BULK_LIMIT + 1 }, (_, n) => String(n)))?.params).toEqual({ max: TRAVELLER_BULK_LIMIT })
  })

  it('reads each id once, in the order asked', () => {
    expect(travellerIdsOf(' b, a ,b,,')).toEqual(['b', 'a'])
    expect(travellerIdsOf(null)).toEqual([])
    expect(travellerIdsOf(Array.from({ length: 60 }, (_, n) => `id${n}`).join(','))).toHaveLength(TRAVELLER_BULK_LIMIT)
  })
})

describe('split', () => {
  const wo = workOrder('DRAFT')
  const [first, second] = wo.cells
  const draft = { moves: { [first!.id]: 1 }, dueDate: '', priority: '0', rush: false, note: '' }
  const preview = { refusal: null, problems: [], numberPreview: null, parent: null, child: null }

  it('only a draft of a size grid, by who may', () => {
    expect(splitHeld(wo, manager)).toBeNull()
    expect(splitHeld(wo, sales)).toEqual({ key: 'held.noManage' })
    expect(splitHeld(workOrder('IN_PROGRESS'), manager)?.key).toBe('production-every-shift:split.heldFrozen')
    expect(splitHeld({ ...wo, kind: 'REPAIR' }, manager)?.key).toBe('production-every-shift:split.heldKind')
    expect(splitHeld({ ...wo, kind: 'MADE_TO_MEASURE' }, manager)?.key).toBe('production-every-shift:split.heldKind')
  })

  it('asks the cells that move, in the work order\'s order', () => {
    expect(splitAskOf(wo.cells, { [second!.id]: 2, [first!.id]: 1 })).toEqual([{ cellId: first!.id, quantity: 1 }, { cellId: second!.id, quantity: 2 }])
    expect(splitAskOf(wo.cells, { [first!.id]: 0 })).toEqual([])
    expect(overCells(wo.cells, { [first!.id]: first!.quantity + 1 })).toEqual([first!.id])
  })

  it('says why Split waits: pieces move, some stay, the priority reads, the API agrees', () => {
    expect(splitAskHeld(wo, draft, preview, false)).toBeNull()
    expect(splitAskHeld(wo, { ...draft, moves: {} }, preview, false)?.key).toBe('production-every-shift:split.heldNothing')
    expect(splitAskHeld(wo, { ...draft, moves: { [first!.id]: first!.quantity + 1 } }, preview, false)?.key).toBe('production-every-shift:split.heldOver')
    expect(splitAskHeld(wo, { ...draft, moves: Object.fromEntries(wo.cells.map((cell) => [cell.id, cell.quantity])) }, preview, false)?.key).toBe('production-every-shift:split.heldAll')
    expect(splitAskHeld(wo, { ...draft, priority: 'x' }, preview, false)?.key).toBe('overview.priorityBad')
    expect(splitAskHeld(wo, draft, null, false)?.key).toBe('held.checking')
    expect(splitAskHeld(wo, draft, preview, true)?.key).toBe('held.busy')
    expect(splitAskHeld(wo, draft, { ...preview, refusal: 'no' }, false)?.key).toBe('production-every-shift:split.heldApi')
    expect(splitAskHeld(wo, draft, { ...preview, problems: [{ path: 'body/cells', message: 'no' }] }, false)?.key).toBe('production-every-shift:split.heldApi')
  })

  it('a priority is a whole number in its limits', () => {
    expect(priorityBad('0')).toBe(false)
    expect(priorityBad('1001')).toBe(true)
    expect(priorityBad('1.5')).toBe(true)
    expect(priorityBad(' ')).toBe(true)
  })

  it('an unknown failure is said in the page\'s words', () => {
    expect(splitProblem(new Error('x')).key).toBe('production-every-shift:split.failed')
  })
})

describe('minutes', () => {
  const wo = workOrder('IN_PROGRESS')
  const wip = wipOf()

  it('planned is standard × pieces, earned is standard × good, per operation', () => {
    const minutes = minutesOf(wo, wip)
    expect(minutes.rows).toHaveLength(wo.spec.operations.length)
    for (const row of minutes.rows) {
      const operation = wo.spec.operations.find((entry) => entry.seq === row.seq)!
      const standard = Number(operation.standardMinutes)
      expect(row.planned).toBeCloseTo(standard * wo.pieces, 1)
      if (operation.scanRequired) expect(row.earned).toBeCloseTo(standard * (wip.operations.find((entry) => entry.seq === row.seq)?.good ?? 0), 1)
      else expect(row.earned).toBeNull()
    }
  })

  it('totals add the operations; an operation nothing reports earns nothing and says so', () => {
    const unscanned = { ...wo, spec: { ...wo.spec, operations: wo.spec.operations.map((operation, index) => (index === 0 ? { ...operation, scanRequired: false } : operation)) } }
    const minutes = minutesOf(unscanned, wip)
    expect(minutes.unscanned).toBe(unscanned.spec.operations.filter((operation) => !operation.scanRequired).length)
    expect(minutes.rows[0]!.earned).toBeNull()
    expect(minutes.earned).toBeCloseTo(minutes.rows.reduce((sum, row) => sum + (row.earned ?? 0), 0), 1)
  })

  it('before the release nothing is earned', () => {
    expect(minutesOf(workOrder('DRAFT'), null).earned).toBe(0)
  })

  it('has no field about a person or money', () => {
    expect(JSON.stringify(minutesOf(wo, wip))).not.toMatch(/worker|employee|cost|price/i)
  })
})

describe('the record', () => {
  it('has a Documents tab between Labour & cost and Activity', () => {
    expect(RECORD_TABS.slice(-3)).toEqual(['labour', 'documents', 'activity'])
    expect(tabOf('documents')).toBe('documents')
  })

  it('a bundle\'s full page needs production.bundles.view', () => {
    expect(abilitiesOf(['production.bundles.view']).bundlesView).toBe(true)
    expect(abilitiesOf(['production.bundles']).bundlesView).toBe(false)
  })
})
