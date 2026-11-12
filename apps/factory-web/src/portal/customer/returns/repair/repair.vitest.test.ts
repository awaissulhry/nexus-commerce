import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { returnableRead } from '../design-data'
import { designScreen as listScreen } from '../fixtures'
import { EMPTY_START, startDirty, startProblems } from '../model'
import { repairSchema, repairsSchema } from './api'
import { repairsRead } from './cases'
import { designScreen } from './fixtures'
import { answerHeldKey, declineProblem, EMPTY_REPAIR_DRAFT, moneyText, OTHER_GARMENT, photosHeldKey, repairBodyOf, repairHref, repairItems, repairRefusalKey, repairStartProblems, repairTabOf } from './model'

/**
 * The customer's repairs in the portal (B-W2b-342; SCR-358 and SCR-187's repair cases): the start's repair part, the record's
 * address and tabs, the held actions by code, the money only when the API sent it, the refusals in our words, the design
 * cases as the API would answer them.
 */

const read = returnableRead()

describe('a repair request in "Start a return or claim" (RR1:02)', () => {
  it('checks the garment, a repair’s words, an alteration’s work and another garment’s serial', () => {
    expect(repairStartProblems(EMPTY_REPAIR_DRAFT, read)).toEqual({ repairItem: 'returns-repair:check.item', problem: 'returns-repair:check.problem' })
    expect(repairStartProblems({ ...EMPTY_REPAIR_DRAFT, repairKind: 'ALTERATION', repairItem: OTHER_GARMENT }, read)).toEqual({ repairSerial: 'returns-repair:check.serial', workWanted: 'returns-repair:check.workWanted' })
    expect(repairStartProblems({ ...EMPTY_REPAIR_DRAFT, repairItem: 'line-1|52', problem: 'Torn seam' }, read)).toEqual({})
    // The start's own checks take the repair's (a return's and a complaint's do not).
    expect(startProblems({ ...EMPTY_START, type: 'REPAIR' }, read)).toEqual({ repairItem: 'returns-repair:check.item', problem: 'returns-repair:check.problem' })
    expect(startProblems({ ...EMPTY_START, type: 'COMPLAINT', description: 'x' }, read)).toEqual({})
    expect(startDirty({ ...EMPTY_START, type: 'REPAIR', workWanted: 'Add 2 cm' })).toBe(true)
    expect(startDirty({ ...EMPTY_START, type: 'REPAIR' })).toBe(false)
  })

  it('sends the API’s body: one garment of an order line (each once), or another by its serial', () => {
    expect(repairItems(read).map((item) => item.key)).toEqual(['line-1|52', 'line-1|54', 'line-2|50'])
    expect(repairBodyOf({ repairKind: 'REPAIR', repairItem: 'line-1|52', repairSerial: ' SN-1 ', problem: ' Torn ', workWanted: '' }, read)).toEqual({ kind: 'REPAIR', salesOrderLineId: read.items[0]!.salesOrderLineId, size: '52', serial: 'SN-1', problem: 'Torn', workWanted: null })
    expect(repairBodyOf({ repairKind: 'ALTERATION', repairItem: OTHER_GARMENT, repairSerial: 'SN-2', problem: '', workWanted: 'Add 2 cm' }, read)).toEqual({ kind: 'ALTERATION', salesOrderLineId: null, size: null, serial: 'SN-2', problem: null, workWanted: 'Add 2 cm' })
  })
})

describe('the repair’s page (SCR-358)', () => {
  it('opens on Status, says why an act waits by code, and shows money only when the API sent it', () => {
    expect(repairTabOf(null)).toBe('status')
    expect(repairTabOf('request')).toBe('request')
    expect(repairTabOf('messages')).toBe('status')
    expect(repairHref('/p/X', 'r 1', 'request')).toBe('/p/X/returns/repairs/r%201?tab=request')
    expect(photosHeldKey('STAGE', false)).toBe('portal.held.photos.STAGE')
    expect(photosHeldKey(null, true)).toBe('portal.held.offline')
    expect(answerHeldKey(null, false, true)).toBe('portal.held.busy')
    expect(answerHeldKey('NO_PRICES', false, false)).toBe('portal.held.answer.NO_PRICES')
    expect(answerHeldKey(null, false, false)).toBeNull()
    expect(moneyText(undefined, 'EUR', 'it')).toBeNull()
    expect(moneyText(5350, 'EUR', 'en')).toBe('€53.50')
    expect(declineProblem('  ')).toBe('portal.decline.needed')
    expect(declineProblem('Too expensive')).toBeNull()
  })

  it('says a refusal in our words', () => {
    expect(repairRefusalKey(new ApiError('conflict', 409, 'conflict', 'x', null, [{ path: 'body/serial', message: 'x' }]))).toBe('refusal.open')
    expect(repairRefusalKey(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('portal.problem.changed')
    expect(repairRefusalKey(new ApiError('forbidden', 403, 'forbidden', 'x'))).toBe('portal.problem.forbidden')
    expect(repairRefusalKey(new Error('x'))).toBe('portal.problem.internal')
  })

  it('every made-up repair parses as the API answers it, and the design cases cover the states', () => {
    for (const entry of designScreen.cases) {
      const built = entry.model('en')
      if (built.body.kind === 'record' && built.body.model.repair) expect(() => repairSchema.parse(built.body.kind === 'record' ? built.body.model.repair : null), entry.id).not.toThrow()
    }
    expect(() => repairsSchema.parse(repairsRead())).not.toThrow()
    const ids = designScreen.cases.map((entry) => entry.id)
    for (const state of ['waiting', 'estimate', 'estimate-no-prices', 'accept', 'decline', 'accepted', 'declined', 'request', 'photos', 'preview', 'offline', 'loading', 'error', 'missing', 'no-access']) expect(ids).toContain(state)
    const listIds = listScreen.cases.map((entry) => entry.id)
    for (const state of ['w2b-342-repairs', 'w2b-342-repairs-failed', 'w2b-342-start-type', 'w2b-342-start-repair', 'w2b-342-start-review', 'w2b-342-start-sent']) expect(listIds).toContain(state)
  })
})
