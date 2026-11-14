import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { ROLES } from '../../shared/fixtures'
import type { RoleTemplate } from '../new-role/api'
import { copyName, createProblem, newRoleErrors, offeredTemplates, slugOf, templateHeld } from '../new-role/model'
import { bodyOf, draftDiff, draftOf, editHeld, grainToggled, refusalWords, reviewRows, saveProblem, toggled, type RoleReview } from './model'

/** B-W2b-413: New role and Change role, pure (PLT-031). */

const t = createTranslator('en', CATALOGUE.en['admin-security-depth'] ?? {})
const template = (key: string, over: Partial<RoleTemplate> = {}): RoleTemplate => ({ key, name: key, description: null, audience: 'office', requireMfa: false, permissions: [], grains: [], copyable: true, ...over })

describe('new role', () => {
  it('offers office templates, the copyable first; says why one is held', () => {
    const templates = [template('owner', { copyable: false }), template('planner'), template('operator', { audience: 'floor' }), template('finance', { copyable: false })]
    expect(offeredTemplates(templates).map((item) => item.key)).toEqual(['planner', 'owner', 'finance'])
    expect(templateHeld(templates[0]!)).toBe('newRole.held.owner')
    expect(templateHeld(templates[3]!)).toBe('newRole.held.beyond')
    expect(templateHeld(templates[1]!)).toBeNull()
    expect(newRoleErrors({ basedOn: 'owner', name: ' ' }, templates)).toEqual({ basedOn: 'newRole.error.basedOn', name: 'newRole.error.name' })
    expect(newRoleErrors({ basedOn: 'planner', name: 'Planner (copy)' }, templates)).toEqual({})
    expect(copyName('Planner', 'copy')).toBe('Planner (copy)')
  })

  it('a slug from the name, unique among the tenant’s keys', () => {
    expect(slugOf('Planner (copy)', [])).toBe('planner_copy')
    expect(slugOf('Planner (copy)', ['custom.planner_copy'])).toBe('planner_copy_2')
    expect(slugOf('Responsabilità qualità', [])).toBe('responsabilita_qualita')
    expect(slugOf('2nd shift', [])).toBe('role_2nd_shift')
    expect(slugOf('!!', [])).toBe('role')
    expect(createProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'body/permissions/invoices.issue/beyondYou' }]))).toBe('newRole.problem.beyond')
    expect(createProblem(new ApiError('conflict', 409, 'conflict', 'x'))).toBe('newRole.problem.taken')
  })
})

describe('change role', () => {
  const copy = ROLES[5]!
  it('the draft’s difference, and two-factor asked once it sees costs', () => {
    const draft = grainToggled(toggled(toggled(draftOf(copy), 'invoices.view', true), 'quotes.manage', false), 'cost', true)
    expect(draftDiff(copy, draft)).toMatchObject({ added: ['invoices.view'], removed: ['quotes.manage'], grainsAdded: ['cost'], count: 3 })
    expect(bodyOf({ requireMfa: false }, draft).requireMfa).toBe(true)
    expect(bodyOf({ requireMfa: true }, draft).requireMfa).toBeUndefined()
    expect(draft.grains).toEqual(['price', 'cost', 'margin'])
  })

  it('who may change it', () => {
    expect(editHeld({ system: true }, { manage: true, heldByMe: false })).toBe('saveRole.held.readyMade')
    expect(editHeld({ system: false, archivedAt: '2026-11-01T00:00:00.000Z' }, { manage: true, heldByMe: false })).toBe('saveRole.held.archived')
    expect(editHeld({ system: false }, { manage: false, heldByMe: false })).toBe('saveRole.held.right')
    expect(editHeld({ system: false }, { manage: true, heldByMe: true })).toBe('saveRole.held.mine')
    expect(editHeld({ system: false }, { manage: true, heldByMe: false })).toBeNull()
  })

  it('the review as rows (raises marked) and refusals in words', () => {
    const review: RoleReview = { version: 2, permissionsAdded: ['invoices.view'], permissionsRemoved: ['quotes.manage'], grainsAdded: ['cost'], grainsRemoved: [], requireMfa: { before: false, after: true }, raises: true, asksFreshCode: true, holders: 4, refusals: [] }
    const rows = reviewRows(review, { permission: (name) => name, risky: () => false, grain: (grain) => grain, t })
    expect(rows.map((row) => [row.id, row.raise])).toEqual([
      ['add:invoices.view', true],
      ['remove:quotes.manage', false],
      ['grain:cost', true],
      ['mfa', false],
    ])
    expect(refusalWords('body/permissions/invoices.view/beyondYou')).toEqual({ key: 'saveRole.refusal.beyondPermission', subject: { permission: 'invoices.view' } })
    expect(refusalWords('roles/ROLE_ARCHIVED').key).toBe('saveRole.refusal.archived')
    expect(refusalWords('body/requireMfa/lockOut').key).toBe('saveRole.refusal.mfaRule')
    expect(saveProblem(new ApiError('conflict', 409, 'conflict', 'x')).key).toBe('saveRole.problem.stale')
    expect(saveProblem(new ApiError('forbidden', 403, 'forbidden', 'x', null, [{ path: 'roles/held' }])).key).toBe('saveRole.problem.refused')
  })
})
