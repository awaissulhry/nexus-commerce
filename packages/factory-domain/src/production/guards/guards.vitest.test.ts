import { describe, expect, it } from 'vitest'
import { FLOOR_SHARED_PERMISSIONS, FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { reportDecision, SCAN_REFUSALS, standingScans, type ReportFacts, type ScanFact, type ScanOperation } from '../scans/rules'
import {
  componentDecision,
  componentsAsked,
  DEFAULT_GUARD_SETTINGS,
  garmentsGoingOn,
  GUARD_REFUSALS,
  guardFindings,
  guardSettingsOf,
  heldBy,
  kindsOf,
  OVERRIDABLE_REFUSALS,
  overrideReasonText,
  overrideRefusal,
  passedTo,
  type ComponentMaterial,
  type GuardFacts,
} from './rules'

/**
 * B-W2b-46 — checks before a scan counts (MES-070, MES-097, MES-098, MES-114). Figures by hand: a routing of 10 cut, 20
 * sew, 30 final inspection, 40 pack (all scanned); a bundle of 10 garments. Every name and number is made up.
 */

const op = (seq: number, kind: ScanOperation['workCentreKind'], scanRequired = true): ScanOperation => ({ id: `op-${seq}`, seq, code: `OP-${seq}`, name: `Operation ${seq}`, scanRequired, workCentreKind: kind })
const OPS = [op(10, 'CUTTING'), op(20, 'SEWING'), op(30, 'INSPECTION'), op(40, 'PACKING')]
const BUNDLE = 'bundle-1'
let seq = 0
const scan = (operationId: string, good: number, scrap = 0, rework = 0): ScanFact => ({
  id: `scan-${++seq}`,
  kind: 'REPORT',
  bundleId: BUNDLE,
  workOrderOperationId: operationId,
  correctsId: null,
  goodQuantity: good,
  scrapQuantity: scrap,
  reworkQuantity: rework,
  workerId: 'w-1',
  stationId: 's-1',
  deviceId: 'd-1',
  clientScanId: `c-${seq}`,
  deviceTime: null,
  serverTime: new Date(`2026-11-02T08:${String(seq).padStart(2, '0')}:00Z`),
})
const standing = (...scans: ScanFact[]) => standingScans(scans)

const facts = (over: Partial<GuardFacts> = {}): GuardFacts => ({
  operations: OPS,
  operation: OPS[2]!,
  bundleId: BUNDLE,
  bundle: { code: 'BN-1', quantity: 10 },
  workOrder: { number: 'WO-1' },
  standing: standing(scan('op-10', 10), scan('op-20', 8, 2)),
  counts: { good: 8, scrap: 0, rework: 0 },
  settings: DEFAULT_GUARD_SETTINGS,
  lines: { station: null, workOrder: null, lineHasKind: false },
  ...over,
})

describe('what the earlier operations passed', () => {
  it('walks back to the last reported scanned operation and names the skipped ones in order', () => {
    expect(passedTo(OPS, OPS[3]!, 10, standing(scan('op-10', 9)), BUNDLE)).toMatchObject({ previous: { id: 'op-30' }, from: { id: 'op-10' }, passed: 9, skipped: [{ id: 'op-20' }, { id: 'op-30' }] })
    expect(passedTo(OPS, OPS[2]!, 10, standing(), BUNDLE)).toMatchObject({ from: null, passed: 10, skipped: [{ id: 'op-10' }, { id: 'op-20' }] })
    expect(passedTo(OPS, OPS[0]!, 10, standing(), BUNDLE)).toMatchObject({ previous: null, from: null, passed: 10, skipped: [] })
    // An operation that is not scanned is never skipped: nothing waits for it.
    const ops = [op(10, 'CUTTING'), op(15, 'FINISHING', false), op(20, 'SEWING')]
    expect(passedTo(ops, ops[2]!, 10, standing(scan('op-10', 10)), BUNDLE)).toMatchObject({ from: { id: 'op-10' }, passed: 10, skipped: [] })
  })
})

describe('MES-097 quantity guard and MES-098 skipped operations, by the site rule', () => {
  it('finds nothing when the bundle comes in order and within what was passed', () => {
    const result = guardFindings(facts())
    expect(result).toMatchObject({ cap: 8, findings: [] })
    expect(heldBy(result.findings)).toBeNull()
  })

  it('STRICT (the default) holds more than the operation before passed, in W1 words; WARN lets it count; FREE finds nothing', () => {
    const over = facts({ counts: { good: 9, scrap: 0, rework: 0 } })
    const strict = guardFindings(over)
    expect(strict.findings).toEqual([
      {
        kind: 'QUANTITY',
        mode: 'STRICT',
        refusal: { code: 'MORE_THAN_PASSED', message: 'Op 20 Operation 20 passed 8 garments of bundle BN-1; 9 reported here.', fix: 'Count again: at most 8, or ask a correction of Op 20 first. A team leader may override it with their PIN and a reason.', final: true },
        detail: { fromOperationId: 'op-20', passed: 8, reported: 9 },
      },
    ])
    expect(heldBy(strict.findings)).toMatchObject({ code: 'MORE_THAN_PASSED', final: true })
    const warn = guardFindings({ ...over, settings: { ...DEFAULT_GUARD_SETTINGS, quantityGuard: 'WARN' } })
    expect(warn.findings.map((finding) => [finding.kind, finding.mode])).toEqual([['QUANTITY', 'WARN']])
    expect(heldBy(warn.findings)).toBeNull()
    // Only a check that holds names the override in its fix.
    expect(warn.findings[0]!.refusal.fix).toBe('Count again: at most 8, or ask a correction of Op 20 first.')
    expect(guardFindings({ ...over, settings: { ...DEFAULT_GUARD_SETTINGS, quantityGuard: 'FREE' } }).findings).toEqual([])
  })

  it('WARN (the default) lets a skipped operation count with the last reported one as the cap; STRICT holds it, not final', () => {
    const skipped = facts({ operation: OPS[3]!, standing: standing(scan('op-10', 10), scan('op-20', 8, 2)), counts: { good: 8, scrap: 0, rework: 0 } })
    const warn = guardFindings(skipped)
    expect(warn.cap).toBe(8)
    expect(warn.findings).toEqual([
      {
        kind: 'SKIPPED_OPERATION',
        mode: 'WARN',
        refusal: { code: 'PREVIOUS_NOT_REPORTED', message: 'Op 30 Operation 30 has not passed bundle BN-1 yet.', fix: "Report it at Op 30 first; if it waits in another tablet's queue, this one is sent again by itself.", final: false },
        detail: { skippedOperationIds: ['op-30'], fromOperationId: 'op-20' },
      },
    ])
    expect(heldBy(warn.findings)).toBeNull()
    const strict = guardFindings({ ...skipped, settings: { ...DEFAULT_GUARD_SETTINGS, skippedOperationRule: 'STRICT' } })
    expect(heldBy(strict.findings)).toMatchObject({ code: 'PREVIOUS_NOT_REPORTED', final: false })
    expect(guardFindings({ ...skipped, settings: { quantityGuard: 'STRICT', skippedOperationRule: 'FREE' } }).findings).toEqual([])
  })

  it('names every skipped operation when there are several, and holds both checks at once with the override as the fix', () => {
    const result = guardFindings(facts({ operation: OPS[3]!, standing: standing(scan('op-10', 6, 4)), counts: { good: 7, scrap: 0, rework: 0 }, settings: { quantityGuard: 'STRICT', skippedOperationRule: 'STRICT' } }))
    expect(result.findings.map((finding) => finding.refusal.message)).toEqual(['Op 20 Operation 20, Op 30 Operation 30 have not passed bundle BN-1 yet.', 'Op 10 Operation 10 passed 6 garments of bundle BN-1; 7 reported here.'])
    const held = heldBy(result.findings)!
    expect(held).toMatchObject({ code: 'PREVIOUS_NOT_REPORTED', final: true })
    expect(held.message).toBe('Op 20 Operation 20, Op 30 Operation 30 have not passed bundle BN-1 yet. Op 10 Operation 10 passed 6 garments of bundle BN-1; 7 reported here.')
    expect(held.fix).toMatch(/^Ask your team leader to override them/)
    expect(kindsOf(result.findings)).toEqual(['QUANTITY', 'SKIPPED_OPERATION'])
  })

  it('a skipped operation reported late may not pass fewer good than the next one already took (STRICT holds, with the override)', () => {
    const late = facts({ operation: OPS[1]!, standing: standing(scan('op-10', 10), scan('op-30', 9)), counts: { good: 8, scrap: 2, rework: 0 } })
    const result = guardFindings(late)
    expect(result.findings).toEqual([
      {
        kind: 'QUANTITY',
        mode: 'STRICT',
        refusal: { code: 'LESS_THAN_TAKEN', message: 'Op 30 Operation 30 took 9 garments of bundle BN-1 already; 8 good here is fewer.', fix: 'Count again (at least 9 good), or ask your team leader to override it with their PIN and a reason.', final: true },
        detail: { nextOperationId: 'op-30', taken: 9, good: 8 },
      },
    ])
    expect(guardFindings({ ...late, counts: { good: 9, scrap: 1, rework: 0 } }).findings).toEqual([])
  })
})

describe('MES-070 wrong bundle: another line', () => {
  const lineA = { id: 'line-a', code: 'L1' }
  const lineB = { id: 'line-b', code: 'L2' }
  it('holds a bundle whose work order is allocated to another line that does this kind of work; always STRICT', () => {
    const result = guardFindings(facts({ lines: { station: { code: 'QC-02', line: lineB }, workOrder: lineA, lineHasKind: true }, settings: { quantityGuard: 'FREE', skippedOperationRule: 'FREE' } }))
    expect(result.findings).toEqual([
      {
        kind: 'WRONG_BUNDLE',
        mode: 'STRICT',
        refusal: { code: 'WRONG_BUNDLE', message: 'Bundle BN-1 is for line L1 (work order WO-1); QC-02 is on line L2.', fix: 'Take it to line L1, or ask your team leader to override it with their PIN and a reason.', final: true },
        detail: { bundleLineId: 'line-a', stationLineId: 'line-b' },
      },
    ])
  })
  it('lets it through on its own line, at a station on no line, for a work order on no line, or when its line has no station of this kind', () => {
    expect(guardFindings(facts({ lines: { station: { code: 'QC-01', line: lineA }, workOrder: lineA, lineHasKind: true } })).findings).toEqual([])
    expect(guardFindings(facts({ lines: { station: { code: 'QC-09', line: null }, workOrder: lineA, lineHasKind: true } })).findings).toEqual([])
    expect(guardFindings(facts({ lines: { station: { code: 'QC-02', line: lineB }, workOrder: null, lineHasKind: true } })).findings).toEqual([])
    expect(guardFindings(facts({ lines: { station: { code: 'QC-02', line: lineB }, workOrder: lineA, lineHasKind: false } })).findings).toEqual([])
  })
})

describe('the scans hook: W1 decides the operation, the guards the rest', () => {
  const report = (over: Partial<ReportFacts>): ReportFacts => ({
    workOrder: { number: 'WO-1', status: 'IN_PROGRESS' },
    bundleId: BUNDLE,
    bundle: { code: 'BN-1', quantity: 10, status: 'ACTIVE', replacedCodes: [] },
    scanned: 'BN-1',
    operations: OPS,
    operationId: 'op-30',
    station: null,
    kindReason: null,
    standing: standing(),
    counts: { good: 10, scrap: 0, rework: 0 },
    viewer: { scanSubject: 'WORKER', workerId: 'w-1', stationId: null },
    stationCodes: new Map(),
    timeZone: 'Europe/Rome',
    ...over,
  })
  it('W1 alone still refuses a skipped operation and more than passed; guarded, it decides only the operation and the bundle cap', () => {
    expect(reportDecision(report({}))).toMatchObject({ ok: false, refusal: { code: 'PREVIOUS_NOT_REPORTED' } })
    expect(reportDecision(report({ guarded: true }))).toMatchObject({ ok: true, operation: { id: 'op-30' }, cap: 10, previous: { id: 'op-20' } })
    expect(reportDecision(report({ guarded: true, counts: { good: 11, scrap: 0, rework: 0 } }))).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_BUNDLE' } })
    // Beyond the bundle after an operation that passed fewer: W1's words (never overridden).
    const passedEight = standing(scan('op-10', 10), scan('op-20', 8, 2))
    expect(reportDecision(report({ guarded: true, standing: passedEight, counts: { good: 11, scrap: 0, rework: 0 } }))).toMatchObject({ ok: false, refusal: { code: 'MORE_THAN_PASSED', message: 'Op 20 Operation 20 passed 8 garments of bundle BN-1; 11 reported here.', fix: 'Count again: at most 8, or ask a correction of Op 20 first.' } })
    expect(reportDecision(report({ guarded: true, standing: passedEight, counts: { good: 9, scrap: 0, rework: 0 } }))).toMatchObject({ ok: true, cap: 10 })
    // Already reported stays W1's, guarded or not.
    expect(reportDecision(report({ guarded: true, standing: standing(scan('op-30', 10)) }))).toMatchObject({ ok: false, refusal: { code: 'ALREADY_REPORTED' } })
  })
})

describe('the override: a team leader, never on their own scan, with a reason', () => {
  it('refuses the operator themself, a person without the right, and "Other" without words', () => {
    const base = { leadId: 'lead', operatorId: 'op', mayOverride: true, reasonCode: 'COUNTED_AGAIN' as const, note: null }
    expect(overrideRefusal(base)).toBeNull()
    expect(overrideRefusal({ ...base, leadId: 'op' })?.code).toBe('OVERRIDE_SELF')
    expect(overrideRefusal({ ...base, mayOverride: false })?.code).toBe('OVERRIDE_NOT_LEAD')
    expect(overrideRefusal({ ...base, reasonCode: 'OTHER' })?.code).toBe('OVERRIDE_NOTE_MISSING')
    expect(overrideRefusal({ ...base, reasonCode: 'OTHER', note: 'Bundle split by hand' })).toBeNull()
    expect(overrideReasonText('OTHER', 'Bundle split by hand')).toBe('Other (say why): Bundle split by hand')
    expect(overrideReasonText('EARLIER_LATE', null)).toBe('The earlier operation is recorded later')
  })
})

describe('MES-114 components and lots at the operation', () => {
  const protector: ComponentMaterial = { itemId: 'pro', code: 'PRO-300', name: 'Shoulder protector', tracking: 'LOT', ppe: true }
  const lining: ComponentMaterial = { itemId: 'lin', code: 'LIN-200', name: 'Mesh lining', tracking: 'LOT', ppe: false }
  const leather: ComponentMaterial = { itemId: 'lea', code: 'LEA-100', name: 'Cowhide', tracking: 'HIDE', ppe: false }
  const materials = [leather, lining, protector]
  const lot = (code: string, itemId: string, qualityStatus = 'RELEASED') => ({ id: `lot-${code}`, code, itemId, qualityStatus })
  const decide = (scanned: Parameters<typeof componentDecision>[0]['scanned'], garments = 10, asked = [protector]) => componentDecision({ asked, materials, scanned, garments, operation: { seq: 20, name: 'Sew' } })

  it('asks the PPE components traced by lot at the sewn operation of a style traced per garment, nowhere else', () => {
    expect(componentsAsked({ operations: OPS, operation: OPS[1]!, garmentTracking: 'SERIAL', materials }).map((material) => material.code)).toEqual(['PRO-300'])
    expect(componentsAsked({ operations: OPS, operation: OPS[2]!, garmentTracking: 'SERIAL', materials })).toEqual([])
    expect(componentsAsked({ operations: OPS, operation: OPS[1]!, garmentTracking: 'BATCH', materials })).toEqual([])
    expect(garmentsGoingOn({ good: 7, scrap: 2, rework: 1 })).toBe(8)
  })

  it('traces the garments per lot (a split over two lots), merges a lot scanned twice, sorts the lines', () => {
    expect(decide([{ code: 'l-b', garments: 4, lot: lot('L-B', 'pro') }, { code: 'L-A', garments: 3, lot: lot('L-A', 'pro') }, { code: 'L-A ', garments: 3, lot: lot('L-A', 'pro') }])).toEqual({
      ok: true,
      lines: [
        { itemId: 'pro', itemCode: 'PRO-300', lotId: 'lot-L-A', lotCode: 'L-A', garments: 6 },
        { itemId: 'pro', itemCode: 'PRO-300', lotId: 'lot-L-B', lotCode: 'L-B', garments: 4 },
      ],
    })
    // A lot of another lot-traced material of the garment may be recorded too, with its own garments.
    expect(decide([{ code: 'L-A', garments: 10, lot: lot('L-A', 'pro') }, { code: 'M-1', garments: 10, lot: lot('M-1', 'lin') }])).toMatchObject({ ok: true, lines: [{ itemCode: 'LIN-200' }, { itemCode: 'PRO-300' }] })
  })

  it('refuses a missing component, a wrong item, an unknown lot, a lot not released and a count that does not cover the garments', () => {
    expect(decide([])).toMatchObject({ ok: false, refusal: { code: 'COMPONENTS_MISSING', message: 'Op 20 Sew traces PRO-300 Shoulder protector per garment: no lot of it is scanned.', fix: 'Scan the lot of PRO-300 for the 10 garments.' } })
    expect(decide([{ code: 'X-1', garments: 10, lot: lot('X-1', 'other') }])).toMatchObject({ ok: false, refusal: { code: 'WRONG_COMPONENT' } })
    expect(decide([{ code: 'H-1', garments: 10, lot: lot('H-1', 'lea') }])).toMatchObject({ ok: false, refusal: { code: 'WRONG_COMPONENT' } })
    expect(decide([{ code: 'NOPE', garments: 10, lot: null }])).toMatchObject({ ok: false, refusal: { code: 'UNKNOWN_LOT', message: 'NOPE is not a lot of this site.' } })
    expect(decide([{ code: 'L-Q', garments: 10, lot: lot('L-Q', 'pro', 'QUARANTINE') }])).toMatchObject({ ok: false, refusal: { code: 'LOT_NOT_RELEASED', final: false, message: 'Lot L-Q is in quarantine: only a released lot goes into a garment.' } })
    expect(decide([{ code: 'L-B', garments: 10, lot: lot('L-B', 'pro', 'BLOCKED') }])).toMatchObject({ ok: false, refusal: { message: 'Lot L-B is blocked: only a released lot goes into a garment.' } })
    expect(decide([{ code: 'L-A', garments: 8, lot: lot('L-A', 'pro') }])).toMatchObject({ ok: false, refusal: { code: 'COMPONENT_COUNT', message: 'The lots of PRO-300 cover 8 garments; 10 garments go on from Op 20.' } })
    expect(decide([{ code: 'L-A', garments: 1, lot: lot('L-A', 'pro') }], 0)).toMatchObject({ ok: false, refusal: { code: 'COMPONENT_COUNT' } })
    // Nothing goes on (all scrapped): nothing is asked.
    expect(decide([], 0)).toEqual({ ok: true, lines: [] })
  })
})

describe('the catalogues', () => {
  it("adds its refusals to the scans' list, keeps W1's codes for the held checks, reads the site's rules", () => {
    for (const code of [...GUARD_REFUSALS, ...OVERRIDABLE_REFUSALS]) expect(SCAN_REFUSALS).toContain(code)
    expect(guardSettingsOf(null)).toEqual({ quantityGuard: 'STRICT', skippedOperationRule: 'WARN' })
    expect(guardSettingsOf({ quantityGuard: 'WARN', skippedOperationRule: 'STRICT' })).toEqual({ quantityGuard: 'WARN', skippedOperationRule: 'STRICT' })
  })
  it("gives the override to the team leader's floor role only (and the owner), as a right shared with the floor", () => {
    expect(FACTORY_PERMISSIONS.get('production.scan.override')).toMatchObject({ area: 'production', risk: 'write' })
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.scan.override')
    expect(templateOf('team_leader')?.permissions).toContain('production.scan.override')
    expect(templateOf('owner')?.permissions).toContain('production.scan.override')
    for (const key of ['operator', 'cutting_operator', 'floor_inspector', 'production_manager', 'floor_supervisor']) expect(templateOf(key)?.permissions).not.toContain('production.scan.override')
  })
  it('declares its two events without a person or words in them', () => {
    for (const type of ['production.scan_guard_flagged', 'production.scan_guard_overridden']) {
      const definition = EVENT_CATALOGUE.get(type, 1)
      expect(Object.keys((definition.payload as unknown as { shape: Record<string, unknown> }).shape).filter((key) => /worker|lead|name|note|reason$/i.test(key))).toEqual([])
    }
  })
})
