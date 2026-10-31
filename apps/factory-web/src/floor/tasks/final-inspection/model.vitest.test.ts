import { describe, expect, it } from 'vitest'
import { CHECKLIST_CODES, checklistProblems, planProblems } from '@nexus/factory-domain/quality/final/rules'
import { designScreen } from './fixtures'
import { CATALOGUE } from '../../../lib/i18n/messages'
import { assigneeKey, benchAssignee, checklistComplete, FAIL_REASONS, failItem, groupsDone, groupState, labelsToPrint, mainAction, nextGroup, noteOf, passGroup, passItem, reasonOfNote, releaseHeld, suggestedLot, suggestedPlan, withDefect, withoutDefect, withPlanValue, type Check, holdHeld, holdQuantity } from './model'

/** SCR-097's rules without a screen: the checklist taps, the suggested plan, the defect of a failed check, the release's holds. */

describe('the checklist in four groups (QHS-050)', () => {
  it('"Group passes" answers the rest of the group; a failed check stays failed', () => {
    const failed = failItem([], 'SIZE_LABEL', 'Wrong label (LABEL-WRONG)')
    const passed = passGroup(failed, 'LABELS')
    expect(passed.filter((answer) => answer.ok === true).map((answer) => answer.code)).toEqual(['EN17092_CLASS_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE'])
    expect(passed.find((answer) => answer.code === 'SIZE_LABEL')).toEqual({ code: 'SIZE_LABEL', ok: false, note: 'Wrong label (LABEL-WRONG)' })
    expect(groupState(passed, 'LABELS')).toBe('failed')
    expect(groupState(passed, 'GARMENT')).toBe('open')
    expect(groupState(passGroup(passed, 'GARMENT'), 'GARMENT')).toBe('passed')
    expect(groupState(passItem([], 'ZIPS'), 'GARMENT')).toBe('partly')
  })

  it('counts the groups done, finds the next one, and is complete only with every check answered', () => {
    let list = passGroup([], 'LABELS')
    expect(groupsDone(list)).toBe(1)
    expect(nextGroup(list)).toBe('GARMENT')
    for (const group of ['GARMENT', 'ARMOUR', 'PACKAGING'] as const) list = passGroup(list, group)
    expect(groupsDone(list)).toBe(4)
    expect(checklistComplete(list)).toBe(true)
    // The domain's own rule agrees: every check answered, a failed one with its note.
    expect(checklistProblems(list, { forDecision: true })).toEqual([])
    expect(checklistProblems(failItem(list, 'ZIPS', noteOf('Zip', 'ZIP-FAULT')), { forDecision: true })).toEqual([])
    expect(list.map((answer) => answer.code)).toEqual([...CHECKLIST_CODES])
  })

  it('passing a failed check again takes its defect back', () => {
    const reason = FAIL_REASONS.find((entry) => entry.code === 'ZIP-FAULT')!
    const lines = withDefect(withDefect([], reason, 13), reason, 13)
    expect(lines).toEqual([{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 2 }])
    expect(withDefect([{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 2 }], reason, 2)).toEqual([{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 2 }])
    expect(withoutDefect(lines, reason)).toEqual([{ defectClass: 'MAJOR', code: 'ZIP-FAULT', quantity: 1 }])
    expect(withoutDefect(withoutDefect(lines, reason), reason)).toEqual([])
    expect(reasonOfNote(noteOf('La cerniera non funziona', 'ZIP-FAULT'))).toBe(reason)
    expect(reasonOfNote('written in the office')).toBeNull()
  })
})

describe('the bench plan: every garment of the lot (the AQL sample is W2b)', () => {
  it('takes the finished garments not yet released as the lot, the whole lot when it is small', () => {
    expect(suggestedLot({ finished: 48, released: 6, pieces: 50 })).toBe(42)
    expect(suggestedLot({ finished: null, released: 0, pieces: 50 })).toBe(1)
    // No table is claimed in W1: the whole lot, no defect accepted, until the inspector states the customer's plan.
    expect(suggestedPlan(6)).toEqual({ lotSize: 6, sampleSize: 6, inspectionLevel: '100%', aqlMajor: '0', aqlMinor: '0', acceptMajor: 0, acceptMinor: 0 })
    expect(suggestedPlan(1000)).toMatchObject({ sampleSize: 1000, acceptMajor: 0, acceptMinor: 0 })
  })

  it('every plan passes the domain\'s plan rules; the sample follows the lot, the acceptance numbers stay within it', () => {
    for (const lot of [1, 2, 9, 30, 120, 600, 5000]) expect(planProblems(suggestedPlan(lot), { pieces: lot, finished: lot }), String(lot)).toEqual([])
    const plan = withPlanValue(withPlanValue(suggestedPlan(48), 'acceptMinor', 2), 'lotSize', 5)
    expect(plan).toMatchObject({ lotSize: 5, sampleSize: 5, acceptMinor: 2 })
    expect(withPlanValue(plan, 'acceptMajor', 9).acceptMajor).toBe(5)
    expect(withPlanValue(plan, 'lotSize', 1)).toMatchObject({ sampleSize: 1, acceptMinor: 1 })
  })
})

const check = (code: Check['code'], state: Check['state']): Check => ({ code, state, message: '', fix: null })

describe('what holds a release and what the bench does next (Q1 (a), QHS-051)', () => {
  it('holds Release for no right, a maker, an open check, nothing to release, then offline', () => {
    const green = [check('QUANTITY', 'OK'), check('LABELS', 'OK')]
    expect(releaseHeld({ online: true, mayRelease: false, made: false, checks: green, releasable: 4 })).toBe('noRight')
    expect(releaseHeld({ online: true, mayRelease: true, made: true, checks: green, releasable: 4 })).toBe('maker')
    expect(releaseHeld({ online: true, mayRelease: true, made: false, checks: [check('LABELS', 'OPEN')], releasable: 4 })).toBe('checks')
    expect(releaseHeld({ online: true, mayRelease: true, made: false, checks: [check('QUANTITY', 'OPEN')], releasable: 0 })).toBe('checks')
    expect(releaseHeld({ online: false, mayRelease: true, made: false, checks: green, releasable: 4 })).toBe('offline')
    expect(releaseHeld({ online: true, mayRelease: true, made: false, checks: green, releasable: 4 })).toBeNull()
  })

  it('offers the labels only to a person who may print them, when they hold the release', () => {
    expect(labelsToPrint([check('LABELS', 'OPEN')], true)).toBe(true)
    expect(labelsToPrint([check('LABELS', 'OPEN')], false)).toBe(false)
    expect(labelsToPrint([check('LABELS', 'OK')], true)).toBe(false)
  })

  it('continues my inspection, starts one, releases, and never lets a maker start or release', () => {
    const can = { record: true, release: true }
    expect(mainAction({ open: { yours: true }, passed: false, made: false }, can)).toBe('continue')
    expect(mainAction({ open: { yours: false }, passed: false, made: false }, can)).toBe('othersOpen')
    expect(mainAction({ open: null, passed: true, made: false }, can)).toBe('release')
    expect(mainAction({ open: null, passed: true, made: true }, can)).toBe('maker')
    expect(mainAction({ open: null, passed: false, made: false }, can)).toBe('start')
    expect(mainAction({ open: null, passed: false, made: false }, { record: false, release: false })).toBeNull()
  })
})

describe('the design cases', () => {
  it('has every state the step names', () => {
    const ids = designScreen.cases.map((item) => item.id)
    for (const id of ['pick', 'empty', 'gate-green', 'gate-red', 'checklist', 'failed-check', 'sign', 'pin-wrong', 'pin-locked', 'release', 'release-refused', 'maker', 'second-person', 'statement', 'labels', 'released', 'hold', 'offline', 'error', 'no-permission', 'view-only'])
      expect(ids).toContain(id)
  })
})

describe('Hold lot at the bench (B-W2a-75; design floor.final "Hold lot": a reason, and an NCR)', () => {
  it('is held for a role that does not record, a lot on hold already, then without the network', () => {
    expect(holdHeld({ online: true, mayRecord: true, holds: 0 })).toBeNull()
    expect(holdHeld({ online: true, mayRecord: false, holds: 0 })).toBe('noRight')
    expect(holdHeld({ online: false, mayRecord: true, holds: 1 })).toBe('already')
    expect(holdHeld({ online: false, mayRecord: true, holds: 0 })).toBe('offline')
  })

  it('holds the open inspection\'s lot, else the finished garments not yet released (at least one)', () => {
    expect(holdQuantity({ lotSize: 24 }, { finished: 48, released: 0, pieces: 48 })).toBe(24)
    expect(holdQuantity(null, { finished: 48, released: 12, pieces: 48 })).toBe(36)
    expect(holdQuantity(null, { finished: null, released: 0, pieces: 10 })).toBe(1)
  })
})

describe('B-W2b-17: the bench list says who the open inspection is assigned to', () => {
  it('mine, an office person by name, another bench inspector never named; none without an assignee', () => {
    expect(benchAssignee(null)).toBeNull()
    expect(benchAssignee(undefined)).toBeNull()
    expect(benchAssignee({ kind: 'WORKER', mine: true, name: null })).toEqual({ kind: 'MINE' })
    expect(benchAssignee({ kind: 'USER', mine: true, name: 'Bea Demo' })).toEqual({ kind: 'MINE' })
    expect(benchAssignee({ kind: 'USER', mine: false, name: 'Bea Demo' })).toEqual({ kind: 'OFFICE', name: 'Bea Demo' })
    // A worker's name never reaches a list, even if an answer carried one.
    expect(benchAssignee({ kind: 'WORKER', mine: false, name: 'Someone' })).toEqual({ kind: 'OTHER' })
    expect(assigneeKey({ kind: 'MINE' })).toEqual({ key: 'pick.assigned.mine' })
    expect(assigneeKey({ kind: 'OFFICE', name: 'Bea Demo' })).toEqual({ key: 'pick.assigned.office', params: { name: 'Bea Demo' } })
    expect(assigneeKey({ kind: 'OFFICE', name: null })).toEqual({ key: 'pick.assigned.officeUnnamed' })
    expect(assigneeKey({ kind: 'OTHER' })).toEqual({ key: 'pick.assigned.other' })
  })

  it('every assignee and due word is in both languages', () => {
    for (const locale of ['en', 'it'] as const) {
      const words = CATALOGUE[locale]['floor-final']!
      for (const key of ['pick.assigned.mine', 'pick.assigned.office', 'pick.assigned.officeUnnamed', 'pick.assigned.other', 'pick.overdue', 'pick.inspectionDue', 'pick.inspectionOverdue']) expect(words[key], `${locale} ${key}`).toBeTruthy()
    }
  })
})
