import { describe, expect, it } from 'vitest'
import { REASON_COLOURS, REASON_CODE, REASON_ICONS } from '../../reasons/rules'
import { BASE_REASONS, standardReasonsOf } from '../../reasons/standard'
import {
  changedChecks,
  changedFields,
  DEFAULT_FLOOR_CHECKS,
  FIXED_FLOOR_RULES,
  floorChecksOf,
  floorChecksWords,
  floorRulesChangeProblems,
  floorRulesChangeWords,
  limitAt,
  limitSince,
  MAX_SCRAP_APPROVAL_LIMIT,
  scrapLimitWords,
  scrapNeedsApproval,
  type LimitChange,
} from './floor-rules'
import { FLOOR_REASON_LISTS, FULL_FLOOR_REASONS, fullReasonsOf, missingFullReasons } from './reason-lists'

/** Floor rules per site (B-W2b-53; MES-294, MES-128) and the floor's full reason lists (MES-293), pure. */

const at = (minute: number) => new Date(Date.UTC(2026, 9, 31, 8, minute))

describe('the checks of a site (MES-294)', () => {
  it('a site without floor rules runs on the schema defaults: quantity guard STRICT, sequence WARN, no scrap limit', () => {
    expect(floorChecksOf(null)).toEqual({ quantityGuard: 'STRICT', skippedOperationRule: 'WARN', scrapApprovalLimit: null, bundleCodeMode: 'ONE_CODE', stuckBundleHours: 4 })
    expect(floorChecksOf({ scrapApprovalLimit: 5, skippedOperationRule: 'FREE' })).toMatchObject({ scrapApprovalLimit: 5, skippedOperationRule: 'FREE', quantityGuard: 'STRICT' })
  })

  it('a change names at least one rule; modes are FREE, WARN or STRICT; the scrap limit a whole number of pieces up to a bundle, or none', () => {
    expect(floorRulesChangeProblems({})).toEqual([{ path: 'body', message: 'Name at least one rule to change.' }])
    expect(floorRulesChangeProblems({ quantityGuard: 'LOOSE' as never })).toEqual([{ path: 'body/quantityGuard', message: 'Expected FREE, WARN or STRICT.' }])
    for (const limit of [0, -1, 2.5, MAX_SCRAP_APPROVAL_LIMIT + 1]) expect(floorRulesChangeProblems({ scrapApprovalLimit: limit }).map((issue) => issue.path)).toEqual(['body/scrapApprovalLimit'])
    expect(floorRulesChangeProblems({ scrapApprovalLimit: null })).toEqual([])
    expect(floorRulesChangeProblems({ scrapApprovalLimit: 1, skippedOperationRule: 'STRICT' })).toEqual([])
  })

  it('only the named fields change; the words say what changes from now on, and that past scans keep theirs', () => {
    const after = changedChecks(DEFAULT_FLOOR_CHECKS, { skippedOperationRule: 'STRICT', scrapApprovalLimit: 3 })
    expect(after).toMatchObject({ quantityGuard: 'STRICT', skippedOperationRule: 'STRICT', scrapApprovalLimit: 3 })
    expect(changedFields(DEFAULT_FLOOR_CHECKS, after)).toEqual(['skippedOperationRule', 'scrapApprovalLimit'])
    expect(floorRulesChangeWords(DEFAULT_FLOOR_CHECKS, after)).toEqual([
      "From now on: Strict sequence: a scan that skips a required operation waits for a team leader's override with their PIN and a reason.",
      "From now on: Scrap above 3 pieces in one scan waits for the team leader's approval before it posts (the replacement, the scrap of stock and the cost wait for it).",
      'Scans already taken keep what they recorded.',
    ])
    expect(floorRulesChangeWords(after, after)).toEqual([])
    expect(floorChecksWords(DEFAULT_FLOOR_CHECKS)[2]).toBe('Scrap needs no approval, whatever the count.')
    expect(scrapLimitWords(1)).toContain('above 1 piece in one scan')
  })

  it('the rules not per site yet are the scans’ own constants: undo 120 s, clock off 5 min / flagged 24 h, no offline limit', () => {
    expect(FIXED_FLOOR_RULES).toMatchObject({ undoWindowSeconds: 120, clockOffSeconds: 300, clockFlagSeconds: 86_400, offlineMaxHours: null, offlineMaxActions: null })
    expect(FIXED_FLOOR_RULES.onlineOnly).toContain('quality.release')
  })
})

describe('scrap above the limit (MES-128)', () => {
  it('waits only above the limit; no limit, never', () => {
    expect(scrapNeedsApproval(5, 4)).toBe(true)
    expect(scrapNeedsApproval(4, 4)).toBe(false)
    expect(scrapNeedsApproval(400, null)).toBe(false)
  })

  it('the limit in force when the scan was taken: a change applies from its moment on, never to older scans', () => {
    const history: LimitChange[] = [
      { at: at(10), before: null, after: 5 },
      { at: at(30), before: 5, after: 2 },
      { at: at(50), before: 2, after: null },
    ]
    expect(limitAt(history, null, at(5))).toBeNull()
    expect(limitAt(history, null, at(10))).toBe(5)
    expect(limitAt(history, null, at(29))).toBe(5)
    expect(limitAt(history, null, at(40))).toBe(2)
    expect(limitAt(history, null, at(55))).toBeNull()
    // Out of order in the list: the same.
    expect(limitAt([...history].reverse(), null, at(40))).toBe(2)
    // No change recorded: the site's limit now (set before any change was recorded, a seed).
    expect(limitAt([], 3, at(1))).toBe(3)
    // Changes all later than the scan: the value before the first.
    expect(limitAt([{ at: at(20), before: 4, after: 6 }], 6, at(1))).toBe(4)
  })

  it('since when a scan may have waited: the first moment a limit was in force', () => {
    expect(limitSince([], null)).toBeNull()
    expect(limitSince([], 3)).toBe('ALWAYS')
    expect(limitSince([{ at: at(10), before: null, after: 5 }], 5)).toEqual(at(10))
    expect(limitSince([{ at: at(10), before: 7, after: 5 }], 5)).toBe('ALWAYS')
    expect(limitSince([{ at: at(10), before: null, after: null }], null)).toBeNull()
  })
})

describe('the floor’s full reason lists (MES-293)', () => {
  it('cover the eight lists of Floor rules & codes and keep every standard code with its words', () => {
    expect([...FLOOR_REASON_LISTS]).toEqual(['PAUSE', 'SCRAP', 'REWORK', 'DOWNTIME', 'HELP_CALL', 'ADJUSTMENT', 'HOLD', 'CANCEL'])
    for (const list of FLOOR_REASON_LISTS) {
      const full = FULL_FLOOR_REASONS[list]
      for (const standard of standardReasonsOf(list)) expect(full.find((reason) => reason.code === standard.code), `${list} ${standard.code}`).toEqual(standard)
      expect(full.length, list).toBeGreaterThan(standardReasonsOf(list).length)
    }
  })

  it('codes are unique and well formed, OTHER (asking for a detail) last, icons and colours of the design system', () => {
    for (const list of FLOOR_REASON_LISTS) {
      const codes = FULL_FLOOR_REASONS[list].map((reason) => reason.code)
      expect(new Set(codes).size, list).toBe(codes.length)
      for (const reason of FULL_FLOOR_REASONS[list]) {
        expect(reason.code).toMatch(REASON_CODE)
        expect(reason.labelIt.trim().length).toBeGreaterThan(1)
        expect(reason.labelEn.trim().length).toBeGreaterThan(1)
        if (reason.icon !== null) expect(REASON_ICONS as readonly string[]).toContain(reason.icon)
        if (reason.colour !== null) expect(REASON_COLOURS as readonly string[]).toContain(reason.colour)
      }
      const other = FULL_FLOOR_REASONS[list].findIndex((reason) => reason.code === 'OTHER')
      expect(other, list).toBe(codes.length - 1)
      expect(FULL_FLOOR_REASONS[list][other]!.needsDetail).toBe(true)
    }
  })

  it('the missing ones by code, active or not; another list keeps its standard reasons', () => {
    const missing = missingFullReasons('PAUSE', ['MATERIAL_WAIT', 'MACHINE', 'INSTRUCTIONS', 'BREAK', 'OTHER', 'MEETING'])
    expect(missing.map((reason) => reason.code)).toEqual(['QUALITY_CHECK', 'NEEDLE_THREAD', 'CLEANING', 'TRAINING', 'SAFETY'])
    expect(missingFullReasons('PAUSE', FULL_FLOOR_REASONS.PAUSE.map((reason) => reason.code))).toEqual([])
    expect(fullReasonsOf('RETURN')).toBe(BASE_REASONS.RETURN)
  })
})
