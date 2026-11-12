import { describe, expect, it } from 'vitest'
import { teamProblem, type RiderFacts } from './riders'

/** Riders under a team or dealer (B-W2b-290; SAL-021): a person under an organisation that buys from us. */

const TEAM: RiderFacts = { id: 't', code: 'TEAM', kind: 'ORGANISATION', roles: ['CUSTOMER'], status: 'ACTIVE', companyId: null }
const RIDER: RiderFacts = { id: 'r', code: 'RIDER', kind: 'PERSON', roles: ['CUSTOMER'], status: 'ACTIVE', companyId: null }

describe('riders under a team', () => {
  it('puts a person customer under an organisation customer', () => {
    expect(teamProblem(RIDER, TEAM)).toBeNull()
    expect(teamProblem({ ...RIDER, companyId: 'a' }, { ...TEAM, companyId: 'a' })).toBeNull()
    expect(teamProblem({ ...RIDER, companyId: 'a' }, TEAM)).toBeNull()
  })

  it('refuses in words what the database refuses', () => {
    expect(teamProblem(RIDER, RIDER)).toBe('RIDER cannot ride for itself.')
    expect(teamProblem({ ...RIDER, kind: 'ORGANISATION' }, TEAM)).toContain('only a person rides for a team')
    expect(teamProblem(RIDER, { ...TEAM, kind: 'PERSON' })).toContain('a rider rides for a team or dealer')
    expect(teamProblem(RIDER, { ...TEAM, roles: ['SUPPLIER'] })).toContain('is not a customer or a brand')
    expect(teamProblem(RIDER, { ...TEAM, status: 'ARCHIVED' })).toContain('archived')
    expect(teamProblem(RIDER, { ...TEAM, companyId: 'a' })).toContain('of its own company')
    expect(teamProblem({ ...RIDER, roles: ['SUPPLIER'] }, TEAM)).toContain('give the rider the customer role first')
  })
})
