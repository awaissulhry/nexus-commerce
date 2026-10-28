import { describe, expect, it } from 'vitest'
import { InvalidStateError } from '../core/errors'
import { assertTransition, canTransition, defineMachine, isState, MachineDefinitionError, nextStates, TransitionError } from './machine'

// A purchase order like A1 §2.5's, with the approval above a limit as a guard.
const order = defineMachine({
  name: 'purchase order',
  states: ['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'CANCELLED'],
  transitions: {
    DRAFT: ['PENDING_APPROVAL', 'SENT', 'CANCELLED'],
    PENDING_APPROVAL: ['APPROVED', 'CANCELLED'],
    APPROVED: ['SENT', 'CANCELLED'],
  },
  guards: {
    SENT: (facts: { totalMinor: number; limitMinor: number; approved: boolean }) =>
      facts.totalMinor > facts.limitMinor && !facts.approved ? ['an approval (the order is above the limit)'] : [],
  },
})

const simple = defineMachine({ name: 'site', states: ['ACTIVE', 'ARCHIVED'], transitions: { ACTIVE: ['ARCHIVED'], ARCHIVED: ['ACTIVE'] } })

describe('defineMachine', () => {
  it('keeps the states and moves, and finds the final states', () => {
    expect(order.states).toEqual(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT', 'CANCELLED'])
    expect(order.finals).toEqual(['SENT', 'CANCELLED'])
    expect(simple.finals).toEqual([])
    expect(Object.isFrozen(order)).toBe(true)
    expect(Object.isFrozen(order.transitions)).toBe(true)
  })

  it.each<[string, () => unknown, RegExp]>([
    ['no states', () => defineMachine({ name: 'x', states: [], transitions: {} }), /has no states/],
    ['no name', () => defineMachine({ name: ' ', states: ['A'], transitions: {} }), /needs a name/],
    ['a state twice', () => defineMachine({ name: 'x', states: ['A', 'A'], transitions: {} }), /state A is listed twice/],
    ['a move to an unknown state', () => defineMachine({ name: 'x', states: ['A'], transitions: { A: ['B' as 'A'] } }), /a move A → B, an unknown state/],
    ['a move from an unknown state', () => defineMachine({ name: 'x', states: ['A', 'B'], transitions: { C: ['A'] } as never }), /a move from unknown state C/],
    ['a move to itself', () => defineMachine({ name: 'x', states: ['A', 'B'], transitions: { A: ['A'] } }), /A → A changes nothing/],
    ['a move twice', () => defineMachine({ name: 'x', states: ['A', 'B'], transitions: { A: ['B', 'B'] } }), /A → B is listed twice/],
    ['a guard no move needs', () => defineMachine({ name: 'x', states: ['A', 'B'], transitions: { A: ['B'] }, guards: { A: () => [] } }), /guard for A, which no move enters/],
  ])('refuses a definition with %s', (_label, define, problem) => {
    expect(define).toThrow(MachineDefinitionError)
    expect(define).toThrow(problem)
  })
})

describe('canTransition', () => {
  const small = { totalMinor: 10_000, limitMinor: 50_000, approved: false }

  it('allows a listed move whose guard finds nothing missing', () => {
    expect(canTransition(order, 'DRAFT', 'SENT', small)).toEqual({ ok: true, from: 'DRAFT', to: 'SENT' })
    expect(canTransition(order, 'APPROVED', 'SENT', { ...small, totalMinor: 90_000, approved: true }).ok).toBe(true)
    expect(canTransition(simple, 'ARCHIVED', 'ACTIVE').ok).toBe(true)
  })

  it('refuses a move the machine does not list, and names where the state can go', () => {
    const check = canTransition(order, 'PENDING_APPROVAL', 'SENT', small)
    expect(check).toMatchObject({ ok: false, reason: 'not_allowed', from: 'PENDING_APPROVAL', to: 'SENT', missing: [] })
    expect(!check.ok && check.message).toBe('A purchase order in PENDING_APPROVAL cannot move to SENT (from PENDING_APPROVAL it can go to APPROVED, CANCELLED).')
    expect(canTransition(order, 'SENT', 'CANCELLED', small)).toMatchObject({ ok: false, reason: 'not_allowed', message: expect.stringContaining('SENT is final') })
  })

  it('refuses an unknown state on either side', () => {
    expect(canTransition(order, 'LOST', 'SENT', small)).toMatchObject({ ok: false, reason: 'unknown_state' })
    expect(canTransition(order, 'DRAFT', 'SHIPPED', small)).toMatchObject({ ok: false, reason: 'unknown_state' })
  })

  it('refuses when the guard finds something missing, and says exactly what (PLT-097)', () => {
    const check = canTransition(order, 'DRAFT', 'SENT', { ...small, totalMinor: 90_000 })
    expect(check).toMatchObject({ ok: false, reason: 'guard', missing: ['an approval (the order is above the limit)'] })
  })

  it('passes the move to the guard', () => {
    const seen: unknown[] = []
    const machine = defineMachine({
      name: 'x',
      states: ['A', 'B'],
      transitions: { A: ['B'] },
      guards: { B: (facts: number, move) => (seen.push([facts, move]), []) },
    })
    expect(canTransition(machine, 'A', 'B', 7).ok).toBe(true)
    expect(seen).toEqual([[7, { from: 'A', to: 'B' }]])
  })
})

describe('assertTransition', () => {
  it('passes an allowed move', () => {
    expect(() => assertTransition(simple, 'ACTIVE', 'ARCHIVED')).not.toThrow()
  })

  it('throws an InvalidStateError (409 invalid_state) with each missing condition as an issue', () => {
    let thrown: unknown
    try {
      assertTransition(order, 'DRAFT', 'SENT', { totalMinor: 90_000, limitMinor: 50_000, approved: false })
    } catch (error) {
      thrown = error
    }
    expect(thrown).toBeInstanceOf(TransitionError)
    expect(thrown).toBeInstanceOf(InvalidStateError)
    expect(thrown).toMatchObject({ code: 'invalid_state', issues: [{ path: 'state', message: 'an approval (the order is above the limit)' }] })
    expect(() => assertTransition(simple, 'ACTIVE', 'ACTIVE')).toThrow(/cannot move to ACTIVE/)
  })
})

describe('helpers', () => {
  it('tells states apart and lists the next ones', () => {
    expect(isState(order, 'DRAFT')).toBe(true)
    expect(isState(order, 'draft')).toBe(false)
    expect(isState(order, 3)).toBe(false)
    expect(nextStates(order, 'DRAFT')).toEqual(['PENDING_APPROVAL', 'SENT', 'CANCELLED'])
    expect(nextStates(order, 'CANCELLED')).toEqual([])
  })
})
