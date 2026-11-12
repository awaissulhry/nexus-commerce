import { describe, expect, it } from 'vitest'
import { appliesTo, normaliseRequirement, RECORD_STAGES, requirementProblems, shownOn } from './requirements'

/** A customer's requirements (B-W2b-290; SAL-014): the rules in words and where each one is shown. */

const STYLE_A = '0190d3a1-0000-7000-8000-00000000000a'
const STYLE_B = '0190d3a1-0000-7000-8000-00000000000b'
const COMPANY = '0190d3a1-0000-7000-8000-0000000000c1'
const OTHER = '0190d3a1-0000-7000-8000-0000000000c2'

describe('customer requirements', () => {
  it('needs words, a place to be shown and each style once', () => {
    expect(requirementProblems({ kind: 'PACKING', words: '  ', appliesAt: [] }).map((issue) => issue.path)).toEqual(['words', 'appliesAt'])
    expect(requirementProblems({ kind: 'LABEL', words: 'x'.repeat(2001), appliesAt: ['ORDER', 'ORDER'], styleIds: [STYLE_A, STYLE_A] }).map((issue) => issue.path)).toEqual(['words', 'appliesAt', 'styleIds'])
    expect(requirementProblems({ kind: 'DOCUMENT', words: 'A packing list with every DDT.', appliesAt: ['SHIPMENT'] })).toEqual([])
  })

  it('stores the stages in their order and the words trimmed', () => {
    expect(normaliseRequirement({ kind: 'PACKING', words: ' Fold in tissue. ', appliesAt: ['PACKING', 'ORDER'] })).toEqual({ kind: 'PACKING', words: 'Fold in tissue.', appliesAt: ['ORDER', 'PACKING'], styleIds: [] })
    expect(shownOn(['SHIPMENT', 'ORDER', 'PACKING'], 'en')).toBe('the order · the pick & pack screen · the shipping checklist')
  })

  it('applies on a record of its company (or every company), at its stage, for one of its styles', () => {
    const rule = { active: true, companyId: COMPANY, appliesAt: ['ORDER', 'PACKING'] as const, styleIds: [STYLE_A] }
    const order = { companyId: COMPANY, stages: RECORD_STAGES.SalesOrder, styleIds: [STYLE_B, STYLE_A] }
    expect(appliesTo({ ...rule, appliesAt: [...rule.appliesAt] }, order)).toBe(true)
    expect(appliesTo({ ...rule, appliesAt: [...rule.appliesAt] }, { ...order, styleIds: [STYLE_B] })).toBe(false)
    expect(appliesTo({ ...rule, appliesAt: [...rule.appliesAt] }, { ...order, companyId: OTHER })).toBe(false)
    expect(appliesTo({ ...rule, appliesAt: [...rule.appliesAt], active: false }, order)).toBe(false)
    expect(appliesTo({ ...rule, appliesAt: [...rule.appliesAt] }, { companyId: COMPANY, stages: RECORD_STAGES.Invoice, styleIds: [STYLE_A] })).toBe(false)
    expect(appliesTo({ active: true, companyId: null, appliesAt: ['SHIPMENT'], styleIds: [] }, { companyId: OTHER, stages: RECORD_STAGES.Shipment, styleIds: [] })).toBe(true)
  })
})
