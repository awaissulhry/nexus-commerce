import { describe, expect, it } from 'vitest'
import { ApiError } from '../../../../lib/api/errors'
import { CATALOGUE, createTranslator } from '../../../../lib/i18n/messages'
import { ROLES } from '../../shared/fixtures'
import { scopeWords } from '../../shared/model' // B-TH-232
import { scanText } from '../../../../lib/testing/brand-scan' // B-TH-232
import { BRAND_ALPHA } from '../../../../lib/testing/two-brands' // B-TH-232
import { ALWAYS_RULES, holdersOf } from '../model' // B-TH-232
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

// ── B-TH-232 (threads plan decision 17, WALL-G11, W27: the office side of the wall in words) ──
describe('B-TH-232 the role screen says plainly what a customer limit covers', () => {
  const words = (locale: 'it' | 'en') => createTranslator(locale, CATALOGUE[locale].admin ?? {})
  // Agreement T4 with the production lane (B-PR-08a part 2, #1557: work orders and quality records follow the customer limit).
  it('every role’s Scope rules hold “A customer limit covers customer records and production”, with what it does not limit, in it and en', () => {
    expect(ALWAYS_RULES).toContain('customerLimit')
    expect(words('en')('role.rule.customerLimit.title')).toBe('A customer limit covers customer records and production')
    expect(words('it')('role.rule.customerLimit.title')).toBe('Un limite per clienti vale per i dati dei clienti e per la produzione')
    for (const locale of ['it', 'en'] as const) {
      const t = words(locale)
      for (const rule of ALWAYS_RULES) {
        expect(t(`role.rule.${rule}.title`), `${locale} ${rule}`).not.toMatch(/^role\.rule\./)
        expect(t(`role.rule.${rule}.why`), `${locale} ${rule}`).not.toMatch(/^role\.rule\./)
      }
    }
    // It says what production follows the limit, what needs every customer and what stays unlimited (decision 17: no full
    // office wall), never a customer's name; work orders are no longer called unlimited (#1557).
    const why = words('en')('role.rule.customerLimit.why')
    expect(why).toMatch(/in production only their work orders, cutting, scans, quality records and threads/)
    expect(why).toMatch(/need every customer/)
    expect(why).toMatch(/Styles and materials are not limited by customer/)
    expect(why).not.toMatch(/work orders and production boards are not limited/i)
    expect(words('it')('role.rule.customerLimit.why')).toMatch(/in produzione, solo i loro ordini di produzione/)
    for (const locale of ['it', 'en'] as const) expect(scanText(words(locale)('role.rule.customerLimit.why'), BRAND_ALPHA)).toEqual([])
  })

  it('a holder limited to some customers never reads as every company alone: “· 2 customers only”', () => {
    const t = words('en')
    const customers = (count: number) => t('scope.customers', { count })
    const companies = [{ id: 'c1', name: 'Made-up Factory', sites: [] }]
    expect(scopeWords({ allCompanies: true, companyIds: [], siteIds: [], partyIds: ['p1', 'p2'] }, companies, t('scope.all'), customers)).toBe(`${t('scope.all')} · 2 customers only`)
    expect(scopeWords({ allCompanies: false, companyIds: ['c1'], siteIds: [], partyIds: ['p1'] }, companies, t('scope.all'), customers)).toBe('Made-up Factory · 1 customer only')
    expect(scopeWords({ allCompanies: true, companyIds: [], siteIds: [], partyIds: [] }, companies, t('scope.all'), customers)).toBe(t('scope.all'))
    // Without the words (an older caller): as before.
    expect(scopeWords({ allCompanies: true, companyIds: [], siteIds: [], partyIds: ['p1'] }, companies, t('scope.all'))).toBe(t('scope.all'))
  })

  it('the Users tab reads each holder’s customers from the assignment', () => {
    const role = ROLES[0]!
    const user = { id: 'u1', email: 'made-up@example.com', displayName: 'Made-up person', locale: 'en', status: 'ACTIVE', roles: [{ assignmentId: 'a1', roleId: role.id, roleKey: role.key, roleName: role.name, allCompanies: true, companyIds: [], siteIds: [], partyIds: ['p1', 'p2'], validTo: null }], mfaEnabled: false, lastSignInAt: null } as unknown as Parameters<typeof holdersOf>[1][number]
    expect(holdersOf(role, [user])[0]!.scope.partyIds).toEqual(['p1', 'p2'])
  })
})
// ── end B-TH-232 ──
