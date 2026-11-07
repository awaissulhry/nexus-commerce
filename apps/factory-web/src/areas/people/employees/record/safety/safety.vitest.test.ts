import { describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { currentJudgement, missingKit, nextVisit, outcomeKey, ppeRowsOf, receiptTone, safetyCan } from './model'

const perms = (key: string) => templateOf(key)?.permissions ?? []

describe('Employee › Safety: who reads which section', () => {
  it('gives the fitness outcome to HR and the occupational doctor only, incidents to the safety officer and HR', () => {
    expect(safetyCan(perms('hr'))).toEqual({ roleSheet: true, ppe: true, health: true, incidents: true })
    expect(safetyCan(perms('production_manager'))).toEqual({ roleSheet: true, ppe: true, health: false, incidents: false })
    expect(safetyCan(perms('read_only')).health).toBe(false)
    expect(safetyCan(perms('safety_officer')).health).toBe(false)
  })
})

describe('PPE issued', () => {
  const line = (id: string, at: string, voided = false) => ({ id, issuedAt: at, item: { id: 'i', code: 'G', name: 'Guanti', nameI18n: null }, size: null, quantity: 1, voided: voided ? { at } : null })
  it('lists the lines received newest first, voided lines left out, with their receipt', () => {
    const rows = ppeRowsOf({
      receipts: [
        { id: 'r1', issuedAt: '2026-01-01T08:00:00Z', method: 'PAPER', state: 'NOT_SIGNED', scan: null, document: null, lines: [line('a', '2026-01-01T08:00:00Z'), line('b', '2026-01-01T08:00:00Z', true)] },
        { id: 'r2', issuedAt: '2026-05-01T08:00:00Z', method: 'FLOOR_PIN', state: 'SIGNED_PIN', scan: null, document: null, lines: [line('c', '2026-05-01T08:00:00Z')] },
      ],
    })
    expect(rows.map((row) => [row.id, row.receipt])).toEqual([['c', 'SIGNED_PIN'], ['a', 'NOT_SIGNED']])
    expect(receiptTone('SIGNED_PAPER').tone).toBe('success')
    expect(receiptTone('NOT_SIGNED').key).toBe('ppe.receipt.NOT_SIGNED')
  })

  it('names the kit items the person misses', () => {
    const kit = [{ ppeItemId: 'x', item: { code: 'C', name: 'Cuffie', nameI18n: null, category: 'CATEGORY_III' }, quantity: 1, held: 0, missing: 1, replace: 0, whenToWear: '' }, { ppeItemId: 'y', item: { code: 'G', name: 'Guanti', nameI18n: null, category: 'CATEGORY_II' }, quantity: 2, held: 2, missing: 0, replace: 0, whenToWear: '' }]
    expect(missingKit({ kit }).map((entry) => entry.ppeItemId)).toEqual(['x'])
  })
})

describe('fitness: the outcome only, the next visit by its day', () => {
  it('takes the newest current judgement and the soonest open visit', () => {
    const row = (id: string, judgedOn: string) => ({ id, judgedOn, expiresOn: null, state: 'IN_FORCE' as const, fromVisit: true, hasCopy: false, version: 1 })
    expect(currentJudgement([row('a', '2025-01-01'), row('b', '2026-04-10')])?.id).toBe('b')
    expect(currentJudgement([])).toBeNull()
    const visit = (id: string, dueOn: string, status: 'DUE' | 'BOOKED' | 'DONE', bookedOn: string | null = null) => ({ id, type: 'PERIODIC' as const, dueOn, status, state: 'PLANNED' as const, booked: bookedOn ? { on: bookedOn, place: null } : null })
    expect(nextVisit([visit('a', '2027-03-01', 'DUE'), visit('b', '2027-05-01', 'BOOKED', '2026-12-01'), visit('c', '2026-01-01', 'DONE')])?.id).toBe('b')
  })

  it('says a temporary unfitness with its end, never anything clinical', () => {
    expect(outcomeKey({ outcome: 'TEMPORARILY_UNFIT', unfitUntil: '2026-12-15' })).toEqual({ key: 'fitness.outcome.TEMPORARILY_UNFIT', until: '2026-12-15' })
    expect(outcomeKey({ outcome: 'FIT', unfitUntil: null })).toEqual({ key: 'fitness.outcome.FIT', until: null })
  })
})
