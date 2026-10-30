import { describe, expect, it } from 'vitest'
import {
  cancelProblems,
  cancelWarning,
  canMoveRepair,
  makeWorkOrderHeld,
  moveRefusal,
  noteNeeded,
  receiveHeld,
  REPAIR_MOVES,
  REPAIR_STAGES,
  repairActions,
  safeToShip,
  safetyChecklistProblems,
  safetyCheckHeld,
  safetyFailures,
  safetyRequiredFor,
  safetyResultOf,
  safetyStateOf,
  shipProblems,
  stageMoveProblems,
  statusWords,
  stepsOf,
  storedChecklist,
  unrepairedWarning,
  unsafeWords,
  type SafetyChecklist,
} from './rules'

const at = (iso: string) => new Date(iso)
const passed: SafetyChecklist = { seams: 'PASS', abrasionZones: 'PASS', closures: 'NOT_APPLICABLE', protectors: { result: 'PASS', replaced: false, lot: null, level: null }, certificateCovers: true, note: null }
const repairedAt = at('2026-12-02T10:00:00.000Z')
const after = at('2026-12-02T11:00:00.000Z')
const before = at('2026-12-02T09:00:00.000Z')

describe('the stages (SAL-390): the …_sales_w2a_guards moves, said in words', () => {
  it('moves as the database does; SHIPPED and CANCELLED never change', () => {
    expect(canMoveRepair('RECEIVED', 'IN_REPAIR')).toBe(true)
    expect(canMoveRepair('APPROVED', 'SHIPPED')).toBe(false)
    expect(canMoveRepair('REPAIRED', 'IN_REPAIR')).toBe(true)
    expect(canMoveRepair('REPAIRED', 'CANCELLED')).toBe(false)
    for (const stage of REPAIR_STAGES) for (const to of REPAIR_MOVES[stage]) expect(to).not.toBe(stage)
    expect(REPAIR_MOVES.SHIPPED).toEqual([])
    expect(moveRefusal('REP-1', 'APPROVED', 'SHIPPED')).toBe('Repair REP-1 is approved by the customer: it cannot be shipped back from there (it goes on to in repair or cancelled).')
    expect(moveRefusal('REP-1', 'SHIPPED', 'IN_REPAIR')).toBe('Repair REP-1 is shipped back: it changes no more.')
  })

  it('in repair needs its repair work order released; repaired needs it completed', () => {
    const facts = (stage: 'RECEIVED' | 'IN_REPAIR', status: string | null) => ({ number: 'REP-1', stage, workOrder: status ? { number: 'WO-00009', status } : null })
    expect(stageMoveProblems('IN_REPAIR', facts('RECEIVED', null))).toEqual(['Make the repair work order of REP-1 first and release it: the repair is done on it (Work › Make repair work order).'])
    expect(stageMoveProblems('IN_REPAIR', facts('RECEIVED', 'DRAFT'))).toEqual(['Release repair work order WO-00009 first: the floor works only on a released work order.'])
    expect(stageMoveProblems('IN_REPAIR', facts('RECEIVED', 'ON_HOLD'))).toEqual(['Repair work order WO-00009 is on hold: lift its hold first.'])
    expect(stageMoveProblems('IN_REPAIR', facts('RECEIVED', 'RELEASED'))).toEqual([])
    expect(stageMoveProblems('REPAIRED', facts('IN_REPAIR', 'IN_PROGRESS'))).toEqual(['Repair work order WO-00009 is in progress: complete it first (the repair is done when its work order is).'])
    expect(stageMoveProblems('REPAIRED', facts('IN_REPAIR', 'COMPLETED'))).toEqual([])
    expect(stageMoveProblems('REPAIRED', facts('RECEIVED', 'COMPLETED'))[0]).toContain('cannot be repaired from there')
  })

  it('asks a note where the move needs words', () => {
    expect(noteNeeded('RECEIVED', 'ESTIMATED')).toContain('what was estimated')
    expect(noteNeeded('ESTIMATED', 'APPROVED')).toContain('approved the work')
    expect(noteNeeded('REPAIRED', 'IN_REPAIR')).toContain('still needs doing')
    expect(noteNeeded('RECEIVED', 'SHIPPED')).toContain('unrepaired')
    expect(noteNeeded('REPAIRED', 'SHIPPED')).toBeNull()
    expect(noteNeeded('APPROVED', 'IN_REPAIR')).toBeNull()
  })

  it('one live repair work order per repair, before the repair is done', () => {
    expect(makeWorkOrderHeld('REP-1', 'RECEIVED', null)).toBeNull()
    expect(makeWorkOrderHeld('REP-1', 'RECEIVED', { number: 'WO-00009', status: 'IN_PROGRESS' })).toBe('Repair work order WO-00009 is in progress: one live work order per repair.')
    expect(makeWorkOrderHeld('REP-1', 'REPAIRED', null)).toContain('back into repair first')
  })
})

describe('the safety check of a protective garment (design repair.safety)', () => {
  it('passes when no point fails and the certificate still covers the garment', () => {
    expect(safetyResultOf(passed)).toBe('PASS')
    expect(safetyFailures({ ...passed, seams: 'FAIL', certificateCovers: false })).toEqual(['the seams', 'the certificate no longer covers the garment'])
    expect(safetyResultOf({ ...passed, protectors: { ...passed.protectors, result: 'FAIL' } })).toBe('FAIL')
  })

  it('a replaced protector names its lot and level (SAL-400); seams are always checked', () => {
    expect(safetyChecklistProblems(passed)).toEqual([])
    expect(safetyChecklistProblems({ ...passed, seams: 'NOT_APPLICABLE' })).toEqual([{ path: 'body/checklist/seams', message: 'Every garment has seams: PASS or FAIL.' }])
    expect(safetyChecklistProblems({ ...passed, protectors: { result: 'PASS', replaced: true, lot: null, level: '3' } }).map((issue) => issue.path)).toEqual(['body/checklist/protectors/lot', 'body/checklist/protectors/level'])
    expect(safetyChecklistProblems({ ...passed, protectors: { result: 'PASS', replaced: true, lot: 'LOT-7', level: '2' } })).toEqual([])
    expect(safetyChecklistProblems({ ...passed, protectors: { result: 'PASS', replaced: false, lot: 'LOT-7', level: null } }).map((issue) => issue.path)).toEqual(['body/checklist/protectors/replaced'])
    expect(storedChecklist({ ...passed, protectors: { result: 'PASS', replaced: true, lot: ' LOT-7 ', level: '2' }, note: '  ' })).toMatchObject({ protectors: { lot: 'LOT-7', level: '2' }, note: null })
  })

  it('counts only a check made at or after the last repair', () => {
    const facts = { required: true, result: 'PASS' as const, checkedAt: after, repairedAt }
    expect(safetyStateOf(facts)).toBe('PASSED')
    expect(safeToShip(facts)).toBe(true)
    expect(safetyStateOf({ ...facts, checkedAt: before })).toBe('OUTDATED')
    expect(safeToShip({ ...facts, checkedAt: before })).toBe(false)
    expect(safetyStateOf({ ...facts, result: 'FAIL' })).toBe('FAILED')
    expect(safetyStateOf({ required: true, result: null, checkedAt: null, repairedAt })).toBe('NOT_CHECKED')
    expect(safetyStateOf({ required: false, result: null, checkedAt: null, repairedAt })).toBe('NOT_REQUIRED')
    // Unrepaired (no repair made): nothing to check after.
    expect(safeToShip({ required: true, result: null, checkedAt: null, repairedAt: null })).toBe(true)
    expect(unsafeWords('REP-1', { ...facts, result: 'FAIL' })).toBe('Repair REP-1 is a protective garment: it goes back only after a passed safety check made after the repair (its last check failed: repair it again (back into repair), then check it again).')
  })

  it('is signed only for a repaired protective garment', () => {
    expect(safetyCheckHeld('REP-1', 'REPAIRED', true)).toBeNull()
    expect(safetyCheckHeld('REP-1', 'IN_REPAIR', true)).toBe('The safety check is made after the repair: repair REP-1 is in repair.')
    expect(safetyCheckHeld('REP-1', 'REPAIRED', false)).toBe('Repair REP-1 is not a protective garment: it needs no safety check.')
  })

  it('treats a garment of unknown style as protective', () => {
    expect(safetyRequiredFor(null)).toBe(true)
    expect(safetyRequiredFor({ ppeCategory: 'CATEGORY_II' })).toBe(true)
    expect(safetyRequiredFor({ ppeCategory: 'NOT_PPE' })).toBe(false)
  })
})

describe('the way back (LOG-116)', () => {
  const base = { number: 'REP-1', stage: 'REPAIRED' as const, workOrder: { number: 'WO-00009', status: 'COMPLETED' }, required: true, result: 'PASS' as const, checkedAt: after, repairedAt, liveDdt: null, ddtAsked: true }

  it('a passed PPE garment goes back with the DDT the step issues', () => {
    expect(shipProblems(base)).toEqual({ state: [], fields: [] })
    expect(shipProblems({ ...base, checkedAt: before }).state[0]).toContain('made before the last repair')
  })

  it('needs one live DDT: none asks for the transport, a second one is refused', () => {
    expect(shipProblems({ ...base, ddtAsked: false }).fields.map((issue) => issue.path)).toEqual(['body/ddt'])
    expect(shipProblems({ ...base, ddtAsked: false, liveDdt: { number: '146/2026' } })).toEqual({ state: [], fields: [] })
    expect(shipProblems({ ...base, liveDdt: { number: '146/2026' } }).state).toEqual(['DDT 146/2026 is live for this repair: send the garment back without a new DDT, or cancel that DDT first.'])
  })

  it('goes back unrepaired from received or estimated, once its work order is cancelled', () => {
    expect(shipProblems({ ...base, stage: 'RECEIVED', repairedAt: null, workOrder: { number: 'WO-00009', status: 'RELEASED' } }).state).toEqual(['Cancel repair work order WO-00009 first: the garment goes back unrepaired.'])
    expect(shipProblems({ ...base, stage: 'ESTIMATED', repairedAt: null, workOrder: null }).state).toEqual([])
    expect(shipProblems({ ...base, stage: 'IN_REPAIR' }).state).toEqual(['Repair REP-1 is in repair: finish the repair first (repaired), or cancel the repair.'])
    expect(unrepairedWarning({ stage: 'RECEIVED', required: true })).toContain('may no longer protect')
    expect(unrepairedWarning({ stage: 'REPAIRED', required: true })).toBeNull()
  })
})

describe('cancel and arrival', () => {
  it('cancels only what has no garment to send back, no live work order and no live DDT', () => {
    const facts = { number: 'REP-1', workOrder: null, liveDdt: null }
    expect(cancelProblems({ ...facts, stage: 'AWAITING_GOODS' })).toEqual([])
    expect(cancelProblems({ ...facts, stage: 'RECEIVED' })).toEqual(['The garment of repair REP-1 is here: send it back unrepaired instead of cancelling.'])
    expect(cancelProblems({ ...facts, stage: 'REPAIRED' })[0]).toContain('goes back to the customer')
    expect(cancelProblems({ ...facts, stage: 'IN_REPAIR', workOrder: { number: 'WO-00009', status: 'IN_PROGRESS' } })).toEqual(['Cancel repair work order WO-00009 first (Production › Work orders).'])
    expect(cancelProblems({ ...facts, stage: 'APPROVED', liveDdt: { number: '146/2026' } })).toEqual(['DDT 146/2026 is live for this repair: cancel it first.'])
    expect(cancelWarning(at('2026-12-01T08:15:00.000Z'), 'A1')).toBe('The garment arrived on 2026-12-01: it stays at A1 until the customer collects it (a cancelled repair takes no DDT).')
    expect(receiveHeld('REP-1', 'AWAITING_GOODS')).toBeNull()
    expect(receiveHeld('REP-1', 'RECEIVED')).toBe('The garment of repair REP-1 is here already (received).')
  })
})

describe('the record: stepper, actions, words', () => {
  it('marks the steps done, current, skipped or waiting', () => {
    const events = [
      { stage: 'RECEIVED' as const, at: at('2026-12-01T08:15:00.000Z') },
      { stage: 'IN_REPAIR' as const, at: at('2026-12-02T08:00:00.000Z') },
      { stage: 'REPAIRED' as const, at: repairedAt },
    ]
    expect(stepsOf('REPAIRED', events).map((step) => [step.stage, step.state])).toEqual([
      ['RECEIVED', 'DONE'],
      ['ESTIMATED', 'SKIPPED'],
      ['APPROVED', 'SKIPPED'],
      ['IN_REPAIR', 'DONE'],
      ['REPAIRED', 'CURRENT'],
      ['SHIPPED', 'WAITING'],
    ])
    expect(stepsOf('REPAIRED', events)[4]!.at).toBe('2026-12-02T10:00:00.000Z')
    expect(stepsOf('CANCELLED', events.slice(0, 2)).map((step) => step.state)).toEqual(['DONE', 'SKIPPED', 'SKIPPED', 'DONE', 'SKIPPED', 'SKIPPED'])
    expect(stepsOf('AWAITING_GOODS', []).every((step) => step.state === 'WAITING')).toBe(true)
  })

  it('offers each action or says why not', () => {
    const actions = repairActions({ number: 'REP-1', stage: 'REPAIRED', workOrder: { number: 'WO-00009', status: 'COMPLETED' }, liveDdt: null, required: true, result: null, checkedAt: null, repairedAt })
    const byName = Object.fromEntries(actions.map((entry) => [entry.action, entry.held]))
    expect(byName.safetyCheck).toBeNull()
    expect(byName.reopenRepair).toBeNull()
    expect(byName.ship).toContain('it is not checked yet')
    expect(byName.cancel).toContain('goes back to the customer')
    expect(byName.makeWorkOrder).toContain('one live work order per repair')
    expect(statusWords({ stage: 'REPAIRED', required: true, result: 'PASS', checkedAt: after, repairedAt })).toBe('Repaired: ready to go back')
    expect(statusWords({ stage: 'SHIPPED', required: false, result: null, checkedAt: null, repairedAt: null })).toBe('Shipped back unrepaired')
    expect(statusWords({ stage: 'AWAITING_GOODS', required: false, result: null, checkedAt: null, repairedAt: null })).toBe('Waiting for the garment')
  })
})
