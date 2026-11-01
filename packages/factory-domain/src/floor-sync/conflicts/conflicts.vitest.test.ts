import { describe, expect, it } from 'vitest'
import { choiceProblems } from '../../auth/floor/literacy'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { DISCARD_REASON_MAX, DISCARD_REASON_MIN } from '../rules'
import {
  CONFLICT_DECISIONS,
  CONFLICT_KINDS,
  CONFLICT_LOOK,
  CONFLICT_REASONS,
  conflictKindOf,
  conflictReasonProblem,
  DECISION_LOOK,
  isCrossTablet,
  keepRecordedWords,
  reasonOf,
  sendToOfficeWords,
} from './rules'

const TABLET = '019a0000-0000-7000-8000-0000000d0001'
const OTHER_TABLET = '019a0000-0000-7000-8000-0000000d0002'

describe('offline conflicts go to the lead (MES-196)', () => {
  it('a report refused because a bundle-operation is reported already may be a conflict; other refusals are not', () => {
    expect(conflictKindOf({ kind: 'production.scan.report', code: 'ALREADY_REPORTED' })).toBe('DOUBLE_REPORT')
    expect(conflictKindOf({ kind: 'production.scan.report', code: 'UNKNOWN_BUNDLE' })).toBeNull()
    expect(conflictKindOf({ kind: 'production.scan.undo', code: 'ALREADY_REPORTED' })).toBeNull()
    expect(conflictKindOf({ kind: 'production.cut.log', code: 'HIDE_USED_UP' })).toBeNull()
  })

  it('only when another tablet (or the office) recorded the standing report: a tablet\'s own double scan stays the operator\'s', () => {
    expect(isCrossTablet(TABLET, { deviceId: OTHER_TABLET })).toBe(true)
    expect(isCrossTablet(TABLET, { deviceId: null })).toBe(true)
    expect(isCrossTablet(TABLET, { deviceId: TABLET })).toBe(false)
  })

  it('a decision takes one of its own reason tiles, never typed words', () => {
    expect(CONFLICT_DECISIONS).toEqual(['KEEP_RECORDED', 'SEND_TO_OFFICE'])
    expect(conflictReasonProblem('KEEP_RECORDED', 'SAME_WORK')).toBeNull()
    expect(conflictReasonProblem('KEEP_RECORDED', 'COUNTS_WRONG')?.path).toBe('reason')
    expect(conflictReasonProblem('SEND_TO_OFFICE', 'COUNTS_WRONG')).toBeNull()
    expect(conflictReasonProblem('SEND_TO_OFFICE', 'anything')?.path).toBe('reason')
  })

  it('keeps words a discard and the history can hold, in English', () => {
    for (const reason of CONFLICT_REASONS.KEEP_RECORDED) {
      const words = keepRecordedWords(reason)
      expect(words.length).toBeGreaterThanOrEqual(DISCARD_REASON_MIN)
      expect(words.length).toBeLessThanOrEqual(DISCARD_REASON_MAX)
      expect(words).toMatch(/^The team leader kept the report recorded first: /)
    }
    expect(sendToOfficeWords(reasonOf('SEND_TO_OFFICE', 'COUNTS_WRONG')!)).toBe('The team leader asks the office to let this report stand: the counts recorded first are wrong.')
  })

  it('every tile is an icon and a tone first (MES-188)', () => {
    for (const decision of CONFLICT_DECISIONS) expect(choiceProblems(CONFLICT_REASONS[decision].map((reason) => ({ code: reason.code, look: reason.look })))).toEqual([])
    expect(choiceProblems(CONFLICT_DECISIONS.map((decision) => ({ code: decision, look: DECISION_LOOK[decision] })))).toEqual([])
    expect(choiceProblems(CONFLICT_KINDS.map((kind) => ({ code: kind, look: CONFLICT_LOOK[kind] })))).toEqual([])
  })

  it('declares the event of a conflict sent to the office, with no person in it, live for the lead', () => {
    const definition = EVENT_CATALOGUE.get('floor.conflict_sent_to_office', 1)
    expect(definition.live).toMatchObject({ permission: 'floorsync.view', floor: 'floor.lead' })
    expect(Object.keys((definition.payload as unknown as { shape: Record<string, unknown> }).shape).sort()).toEqual(['deviceId', 'kind', 'reason', 'refusedId'])
  })
})
