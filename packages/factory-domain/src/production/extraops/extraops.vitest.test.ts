import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS, FLOOR_SHARED_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { extraOperationProblem, extraReasonText } from './rules'

const facts = { workOrder: { number: 'WO-1', open: true }, operation: { code: 'OP-EXTRA', active: true }, planned: false, reasonCode: 'QUALITY_FIX', note: null } as const

describe('an unplanned operation (MES-086)', () => {
  it('goes on an open work order, from the library, off the routing, with a reason', () => {
    expect(extraOperationProblem(facts)).toBeNull()
    expect(extraOperationProblem({ ...facts, workOrder: { number: 'WO-1', open: false } })).toMatch(/not released or in progress/)
    expect(extraOperationProblem({ ...facts, operation: null })).toMatch(/not an active operation/)
    expect(extraOperationProblem({ ...facts, operation: { code: 'OP-EXTRA', active: false } })).toMatch(/not an active operation/)
    expect(extraOperationProblem({ ...facts, planned: true })).toBe("OP-EXTRA is on this work order's routing already.")
    expect(extraOperationProblem({ ...facts, reasonCode: 'OTHER' })).toMatch(/few words/)
    expect(extraOperationProblem({ ...facts, reasonCode: 'OTHER', note: 'Extra bar tack' })).toBeNull()
  })

  it('keeps the reason in words', () => {
    expect(extraReasonText('QUALITY_FIX', null)).toBe('To fix a defect')
    expect(extraReasonText('OTHER', 'Extra bar tack')).toBe('Other (say why): Extra bar tack')
  })

  it('the team leader on the tablet, the production office and the owner hold the right', () => {
    expect(FACTORY_PERMISSIONS.get('production.extraops.add')).toMatchObject({ area: 'production', risk: 'write' })
    expect(FLOOR_SHARED_PERMISSIONS).toContain('production.extraops.add')
    for (const key of ['team_leader', 'production_manager', 'floor_supervisor', 'owner']) expect(templateOf(key)?.permissions).toContain('production.extraops.add')
    expect(templateOf('operator')?.permissions).not.toContain('production.extraops.add')
  })
})
