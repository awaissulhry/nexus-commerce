import { describe, expect, it } from 'vitest'
import { APPROVAL_KINDS } from '../approvals-out/kinds'
import { partnerTemplateOf } from '../auth/roles/templates'
import { SAMPLE_KINDS } from '../sales/samples/rules'
import { APPROVER_KINDS, APPROVER_ROUND_KINDS, approverHeldWords, approverRuleOf, CUSTOMER_QUALITY_ROLE, mayAnswerAsApprover } from './approver'

/**
 * B-PR-29 (production plan §3, §C S-LIM-approver; review fix R-25): the customer's named approver covers its production
 * approvals only — PP, size set, top of production, fabric, trims; Designers keep artwork and design kinds; Quality keeps
 * concessions (top of production: the approver or Quality). Pure.
 */

describe('the named approver (B-PR-29, R-25)', () => {
  it('covers PP, size set and top-of-production rounds (asked as a SAMPLE) and fabric and trims, nothing else', () => {
    expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind: 'PRE_PRODUCTION' })).toBe('APPROVER')
    expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind: 'SIZE_SET' })).toBe('APPROVER')
    expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind: 'TOP_OF_PRODUCTION' })).toBe('APPROVER_OR_QUALITY')
    expect(approverRuleOf({ kind: 'FABRIC', recordType: 'SampleSwatch' })).toBe('APPROVER')
    expect(approverRuleOf({ kind: 'TRIM', recordType: 'SalesOrder' })).toBe('APPROVER')
    // Designers keep the development samples, artwork and design proofs; colours and leathers stay anyone's with the right.
    for (const sampleKind of ['PROTO', 'FIT', 'SALESMAN', 'CERTIFICATION', 'BRAND']) expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind }), sampleKind).toBeNull()
    expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'Style' })).toBeNull()
    expect(approverRuleOf({ kind: 'SAMPLE', recordType: 'SampleRound', sampleKind: null })).toBeNull()
    for (const kind of ['ARTWORK', 'PROOF', 'COLOUR', 'LEATHER', 'CONCESSION', 'REVISED_ORDER', 'SIGNATURE', 'REPROMISE', 'COUNTER_OFFER'] as const) {
      expect(approverRuleOf({ kind, recordType: 'SampleSwatch' }), kind).toBeNull()
    }
    // Every kind it names is one of the engine's and the samples' own.
    for (const kind of APPROVER_KINDS) expect(APPROVAL_KINDS as readonly string[]).toContain(kind)
    for (const kind of APPROVER_ROUND_KINDS) expect(SAMPLE_KINDS as readonly string[]).toContain(kind)
  })

  it('only the named person answers; the top of production also Quality; a link never', () => {
    const portal = (userId: string, quality = false) => ({ via: 'PORTAL' as const, userId, quality })
    expect(mayAnswerAsApprover('APPROVER', 'anna', portal('anna'))).toBe(true)
    expect(mayAnswerAsApprover('APPROVER', 'anna', portal('bruno'))).toBe(false)
    expect(mayAnswerAsApprover('APPROVER', 'anna', portal('quinta', true))).toBe(false)
    expect(mayAnswerAsApprover('APPROVER_OR_QUALITY', 'anna', portal('quinta', true))).toBe(true)
    expect(mayAnswerAsApprover('APPROVER_OR_QUALITY', 'anna', portal('bruno'))).toBe(false)
    expect(mayAnswerAsApprover('APPROVER_OR_QUALITY', 'anna', { via: 'LINK', userId: null, quality: false })).toBe(false)
    expect(CUSTOMER_QUALITY_ROLE).toBe('customer-quality')
    expect(partnerTemplateOf(CUSTOMER_QUALITY_ROLE)?.kind).toBe('CUSTOMER')
  })

  it('says who it waits for, in both languages, naming only the customer\'s own colleague', () => {
    expect(approverHeldWords('APPROVER', 'Anna', 'PORTAL', 'en')).toBe('Waiting for Anna: Anna answers your production approvals.')
    expect(approverHeldWords('APPROVER', 'Anna', 'PORTAL', 'it')).toBe('In attesa di Anna: è Anna a rispondere alle vostre approvazioni di produzione.')
    expect(approverHeldWords('APPROVER_OR_QUALITY', 'Anna', 'PORTAL', 'en')).toBe('Waiting for Anna: Anna or your quality team answers this top-of-production sample.')
    expect(approverHeldWords('APPROVER_OR_QUALITY', 'Anna', 'PORTAL', 'it')).toMatch(/^In attesa di Anna: /)
    expect(approverHeldWords('APPROVER', 'Anna', 'LINK', 'en')).toBe('Waiting for Anna: Anna answers it in your portal.')
    expect(approverHeldWords('APPROVER', 'Anna', 'LINK', 'it')).toBe('In attesa di Anna: Anna risponde dal vostro portale.')
  })
})
