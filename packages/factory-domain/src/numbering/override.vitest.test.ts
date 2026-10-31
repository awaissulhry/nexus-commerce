import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../auth/permissions/catalogue'
import { templateOf } from '../auth/roles/templates'
import { FISCAL_KINDS } from './kinds'
import { isOverridableKind, OVERRIDABLE_KINDS, OVERRIDE_REFUSALS, PREVIEW_PERMISSIONS, seriesWouldIssue, typedNumberProblems } from './override'
import { NUMBERING_OVERRIDE } from './permissions'

/** PLT-125: the number preview and the controlled override of a migrated document (B-W2b-24), pure. */
describe('the controlled override (PLT-125)', () => {
  it('never reaches a fiscal kind; the kinds a migrated document may keep its number for', () => {
    for (const kind of FISCAL_KINDS) expect(isOverridableKind(kind), kind).toBe(false)
    expect([...OVERRIDABLE_KINDS]).toEqual(['QUOTE', 'SALES_ORDER', 'PURCHASE_ORDER', 'WORK_ORDER', 'SUBCONTRACT', 'LOT'])
    expect(typedNumberProblems({ kind: 'INVOICE', number: 'FT-2019-0412', reason: 'carried over' }).map((p) => p.code)).toEqual(['kind'])
  })

  it('refuses a number that is not written as printed, and an override without its reason', () => {
    expect(typedNumberProblems({ kind: 'SALES_ORDER', number: 'ORD 2019 412', reason: 'Open order of the old system' }).map((p) => p.code)).toEqual(['shape'])
    expect(typedNumberProblems({ kind: 'SALES_ORDER', number: 'x'.repeat(41), reason: 'Open order of the old system' }).map((p) => p.code)).toEqual(['shape'])
    expect(typedNumberProblems({ kind: 'SALES_ORDER', number: '  ORD/2019/412  ', reason: ' ab ' }).map((p) => p.code)).toEqual(['reason'])
    expect(typedNumberProblems({ kind: 'PURCHASE_ORDER', number: 'OA-19-0412', reason: 'Open PO from the old system' })).toEqual([])
    // The check while typing asks no reason yet.
    expect(typedNumberProblems({ kind: 'LOT', number: 'L19-0412' })).toEqual([])
    expect(Object.keys(OVERRIDE_REFUSALS).sort()).toEqual(['future', 'kind', 'reason', 'shape', 'taken'])
  })

  it('knows when the series would give the typed number later (its pattern, its period, at or after its next number)', () => {
    const series = { pattern: 'PO-{YYYY}-{N:5}', scopeKey: '2026', nextValue: 18 }
    expect(seriesWouldIssue(series, 'PO-2026-00018')).toBe(true)
    expect(seriesWouldIssue(series, 'PO-2026-01000')).toBe(true)
    // Given already (a clash with the ledger, not the future), another year, another way of writing it, another text.
    expect(seriesWouldIssue(series, 'PO-2026-00017')).toBe(false)
    expect(seriesWouldIssue(series, 'PO-2019-00412')).toBe(false)
    expect(seriesWouldIssue(series, 'PO-2026-18')).toBe(false)
    expect(seriesWouldIssue(series, 'OA-19-0412')).toBe(false)
    expect(seriesWouldIssue({ pattern: 'LOT-{N:6}', scopeKey: 'ALL', nextValue: 1287 }, 'LOT-001300')).toBe(true)
  })

  it('is a declared permission the administrator holds; the preview names permissions that exist', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(NUMBERING_OVERRIDE)).toBe(true)
    expect(templateOf('admin')!.permissions).toContain(NUMBERING_OVERRIDE)
    expect(templateOf('read_only')!.permissions).not.toContain(NUMBERING_OVERRIDE)
    for (const names of Object.values(PREVIEW_PERMISSIONS)) for (const name of names ?? []) expect(FACTORY_PERMISSIONS.isDeclared(name), name).toBe(true)
  })
})
