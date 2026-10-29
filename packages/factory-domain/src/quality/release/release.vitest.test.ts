import { describe, expect, it } from 'vitest'
import {
  fourEyesInForce,
  inspectionHold,
  isFourEyesLoosening,
  lotHolds,
  openChecks,
  releasable,
  releaseChecks,
  releaseRefusalIssues,
  releaseSummary,
  reversalHolds,
  reversalImpact,
  reversalProblems,
  secondPersonReasons,
  type ReleaseFacts,
} from './rules'

/** The release gate, four eyes as a setting, the reversal and goods on hold (B-W1-45; Q1 (a), Q3 (a)), figures by hand. */

const facts = (over: Partial<ReleaseFacts> = {}): ReleaseFacts => ({
  workOrder: { number: 'WO-0007', status: 'IN_PROGRESS' },
  inspection: { label: 'WO-0007 · inspection 1', status: 'PASSED', lotSize: 6, releasedFrom: 2 },
  cell: { label: 'BLK 52', pieces: 8, netReleased: 2 },
  quantity: 3,
  tracking: 'BATCH',
  serials: { named: 0, problems: [], available: 0 },
  labels: { printed: 6 },
  certificate: { allowed: true, words: 'Covered: CERT-01 (EN 17092-3, AA) covers BLK 52 today.' },
  documents: [],
  lotsOnHold: [],
  maker: { made: false, words: 'You made none of these garments.' },
  secondPerson: { reasons: [], releaserIsInspector: true },
  ...over,
})
const open = (input: ReleaseFacts) => openChecks(releaseChecks(input)).map((check) => check.code)

describe('the release gate', () => {
  it('passes when every check holds: the inspector who made none of the garments releases alone', () => {
    const checks = releaseChecks(facts())
    expect(open(facts())).toEqual([])
    expect(releaseSummary(checks)).toBe('Ready to release')
    expect(checks.find((check) => check.code === 'SECOND_PERSON')!.state).toBe('NOT_NEEDED')
    // 8 pieces, 2 released: 6 left in the cell; the lot of 6 released 2: 4 left.
    expect(releasable(facts())).toBe(4)
  })

  it('names every open check at once, with its fix (PLT-097)', () => {
    const refused = facts({
      workOrder: { number: 'WO-0007', status: 'DRAFT' },
      quantity: 5,
      labels: { printed: 3 },
      certificate: { allowed: false, words: 'Size 58 is not covered: certificate CERT-01 covers 46-56.' },
      documents: [{ code: 'DECLARATION_OF_CONFORMITY', message: 'No signed Declaration of Conformity is on file for revision 2.' }],
      lotsOnHold: [{ code: 'L-0231', qualityStatus: 'BLOCKED', crViStatus: 'FAIL' }],
      maker: { made: true, words: 'You made 4 of these garments (scans of the work order).' },
    })
    expect(open(refused)).toEqual(['WORK_ORDER', 'QUANTITY', 'LABELS', 'CERTIFICATE', 'DOCUMENTS', 'LOTS', 'MAKER'])
    const byCode = new Map(releaseChecks(refused).map((check) => [check.code, check]))
    expect(byCode.get('QUANTITY')!.message).toBe('The inspection judged a lot of 6; 4 garment(s) of it are left to release (a reversed garment is released again only from a new inspection). 5 asked.')
    // 3 printed, 2 released, 5 asked: 7 needed, 4 more labels.
    expect(byCode.get('LABELS')!.message).toBe('BLK 52 has 3 garment label(s) printed and 2 garment(s) released: 5 can be released until 4 more label(s) are printed (QHS-051: labels before packing).')
    expect(byCode.get('LOTS')!.message).toBe('Material lot(s) on hold: L-0231 failed chromium VI. Garments made from them are not released.')
    expect(releaseSummary(releaseChecks(refused))).toBe('Release · 7 checks open')
    expect(releaseRefusalIssues(releaseChecks(refused)).slice(0, 2)).toEqual([
      { path: 'checks/WORK_ORDER', message: 'Work order WO-0007 is draft: its garments are released while it is released, in progress or completed.' },
      { path: 'checks/WORK_ORDER/fix', message: 'Release the work order first, or reopen the work.' },
    ])
  })

  it('caps by the cell and by the lot; only a PASSED inspection releases', () => {
    // The cell: 8 pieces, 7 released → 1 left.
    expect(releasable(facts({ cell: { label: 'BLK 52', pieces: 8, netReleased: 7 } }))).toBe(1)
    expect(releaseChecks(facts({ cell: { label: 'BLK 52', pieces: 8, netReleased: 7 }, labels: { printed: 9 } })).find((check) => check.code === 'QUANTITY')!.message).toBe(
      'BLK 52 has 1 garment(s) left to release (its pieces less what is released, less reversals). 3 asked.',
    )
    expect(open(facts({ inspection: { label: 'WO-0007 · inspection 1', status: 'FAILED', lotSize: 6, releasedFrom: 0 } }))).toEqual(['INSPECTION', 'QUANTITY'])
    expect(releasable(facts({ inspection: null }))).toBe(0)
  })

  it('a serial-tracked cell names exactly its serials, each with its label', () => {
    const serial = facts({ tracking: 'SERIAL', quantity: 2, serials: { named: 1, problems: [], available: 3 }, labels: { printed: 1 } })
    expect(releaseChecks(serial).find((check) => check.code === 'SERIALS')!.message).toBe('Name exactly 2 serial(s) of BLK 52: 1 named.')
    expect(open(facts({ tracking: 'SERIAL', quantity: 2, serials: { named: 2, problems: [], available: 3 }, labels: { printed: 2 } }))).toEqual([])
    expect(open(facts({ tracking: 'SERIAL', quantity: 2, serials: { named: 2, problems: ['SN-X is VOID.'], available: 3 }, labels: { printed: 2 } }))).toEqual(['SERIALS'])
    expect(open(facts({ tracking: 'SERIAL', quantity: 2, serials: { named: 2, problems: [], available: 3 }, labels: { printed: 1 } }))).toEqual(['LABELS'])
  })
})

describe('four eyes as a setting (Owner answer Q1 (a))', () => {
  it('needs a second person for an override, a listed customer or the ALWAYS rule; the inspector then does not release alone', () => {
    expect(secondPersonReasons({ overridden: false, rule: 'WHEN_REQUIRED', customerListed: false })).toEqual([])
    expect(secondPersonReasons({ overridden: true, rule: 'ALWAYS', customerListed: true })).toEqual(['OVERRIDE', 'CUSTOMER', 'ALWAYS'])
    const needs = facts({ secondPerson: { reasons: ['CUSTOMER'], releaserIsInspector: true } })
    expect(open(needs)).toEqual(['SECOND_PERSON'])
    expect(releaseChecks(needs).find((check) => check.code === 'SECOND_PERSON')!.message).toBe("You signed the result; a second person must release it: the customer's garments always need a second person.")
    expect(open(facts({ secondPerson: { reasons: ['OVERRIDE'], releaserIsInspector: false } }))).toEqual([])
  })

  it('the company rule wins, the lists of both apply; loosening is ALWAYS → WHEN_REQUIRED or a customer taken off', () => {
    expect(fourEyesInForce(null, null)).toEqual({ rule: 'WHEN_REQUIRED', source: 'DEFAULT', partyIds: [] })
    expect(fourEyesInForce({ releaseFourEyes: null, secondPersonPartyIds: ['p2'] }, { releaseFourEyes: 'ALWAYS', secondPersonPartyIds: ['p1', 'p2'] })).toEqual({ rule: 'ALWAYS', source: 'TENANT', partyIds: ['p1', 'p2'] })
    expect(fourEyesInForce({ releaseFourEyes: 'WHEN_REQUIRED', secondPersonPartyIds: [] }, { releaseFourEyes: 'ALWAYS', secondPersonPartyIds: [] }).source).toBe('COMPANY')
    expect(isFourEyesLoosening({ releaseFourEyes: 'ALWAYS', secondPersonPartyIds: [] }, { releaseFourEyes: null, secondPersonPartyIds: [] })).toBe(true)
    expect(isFourEyesLoosening({ releaseFourEyes: null, secondPersonPartyIds: ['p1'] }, { releaseFourEyes: 'ALWAYS', secondPersonPartyIds: [] })).toBe(true)
    expect(isFourEyesLoosening({ releaseFourEyes: null, secondPersonPartyIds: ['p1'] }, { releaseFourEyes: 'WHEN_REQUIRED', secondPersonPartyIds: ['p1', 'p2'] })).toBe(false)
  })
})

describe('the reversal', () => {
  it('takes back only what no shipment holds; serials go to rework or scrap', () => {
    // The release of 4 (1 reversed already); the cell has 5 released net, 1 packed on a DRAFT, 2 shipped.
    const impact = reversalImpact({ released: 4, reversed: 1, cell: { netReleased: 5, onDraft: 1, packed: 0, shipped: 2 } })
    expect(impact).toEqual({
      reversible: 2,
      onDraft: 1,
      packed: 0,
      shipped: 2,
      words: '2 in the house → put on hold · 1 on a shipment not yet gone → remove the line (or cancel the shipment) first · 2 shipped → cannot be pulled back here: the PPE register entry follows them.',
    })
    expect(reversalProblems({ quantity: 2, impact, tracking: 'BATCH', serialIds: [], serialsTo: null })).toEqual([])
    expect(reversalProblems({ quantity: 3, impact, tracking: 'BATCH', serialIds: ['s1'], serialsTo: 'MADE' }).map((entry) => entry.path)).toEqual(['quantity', 'serialIds', 'serialsTo'])
    expect(reversalProblems({ quantity: 2, impact, tracking: 'SERIAL', serialIds: ['s1', 's1'], serialsTo: undefined }).map((entry) => entry.path)).toEqual(['serialIds', 'serialsTo'])
    expect(reversalProblems({ quantity: 2, impact, tracking: 'SERIAL', serialIds: ['s1', 's2'], serialsTo: 'VOID' })).toEqual([])
  })
})

describe('goods on hold (Owner answer Q3 (a))', () => {
  it('the newest decided inspection FAILED, or its released garments were taken back; a lot not released holds its garments', () => {
    expect(inspectionHold({ status: 'FAILED', reversed: 0, newestDecided: true }).onHold).toBe(true)
    expect(inspectionHold({ status: 'FAILED', reversed: 0, newestDecided: false }).onHold).toBe(false)
    expect(inspectionHold({ status: 'PASSED', reversed: 2, newestDecided: true })).toEqual({ onHold: true, words: '2 released garment(s) were taken back: on hold until a new inspection passes.' })
    expect(inspectionHold({ status: 'PASSED', reversed: 0, newestDecided: true }).onHold).toBe(false)
    const reversedAt = new Date('2026-11-02T10:00:00Z')
    expect(reversalHolds(reversedAt, [new Date('2026-11-01T10:00:00Z')])).toBe(true)
    expect(reversalHolds(reversedAt, [new Date('2026-11-03T10:00:00Z')])).toBe(false)
    expect(lotHolds({ qualityStatus: 'RELEASED', crViStatus: 'PASS' })).toBe(false)
    expect(lotHolds({ qualityStatus: 'QUARANTINE', crViStatus: 'PENDING' })).toBe(true)
    expect(lotHolds({ qualityStatus: 'RELEASED', crViStatus: 'FAIL' })).toBe(true)
  })
})
