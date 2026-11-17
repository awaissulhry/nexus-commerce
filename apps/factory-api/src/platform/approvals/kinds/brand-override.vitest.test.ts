import { describe, expect, it } from 'vitest'
import { APPROVAL_KIND_WORDS, FIELD_ID } from '@nexus/factory-domain/approvals/rules'
import { OVERRIDE_TASK_KIND } from '@nexus/factory-domain/production-brand/override'
import { kindOf, registeredKinds } from './index'

/**
 * B-PR-38 (review fixes R-06, R-36): the internal approvals engine knows BRAND_OVERRIDE — a decision for a customer, or its
 * undo, that a second person grants while the customer's switch is on. Only its module asks (B-PR-30a/b); its subject is the
 * customer's approval request; who sees it holds production.brand.override.
 */

describe('the BRAND_OVERRIDE kind (B-PR-38)', () => {
  it('is registered once, on the customer\'s approval request, asked only by its module, seen with production.brand.override', () => {
    const kind = kindOf(OVERRIDE_TASK_KIND)
    expect(kind).toMatchObject({ kind: 'BRAND_OVERRIDE', recordType: 'ApprovalRequest', ask: null, view: 'production.brand.override' })
    expect(kind?.label).toEqual(APPROVAL_KIND_WORDS.BRAND_OVERRIDE)
    expect(registeredKinds().filter((entry) => entry.kind === 'BRAND_OVERRIDE')).toHaveLength(1)
    expect(registeredKinds().filter((entry) => entry.recordType === 'ApprovalRequest')).toHaveLength(1)
  })

  it('its facts name no money and no person, and never offer a concession, a revised order, a signature or a proof', () => {
    const kind = kindOf(OVERRIDE_TASK_KIND)!
    expect(kind.fields.map((field) => field.id)).toEqual(['approvalKind', 'answered', 'recordType', 'customerCode'])
    for (const field of kind.fields) {
      expect(FIELD_ID.test(field.id), field.id).toBe(true)
      expect(field.grain ?? null, field.id).toBeNull()
    }
    const offered = kind.fields.find((field) => field.id === 'approvalKind')!.options!.map((option) => option.value)
    for (const own of ['CONCESSION', 'REVISED_ORDER', 'SIGNATURE', 'PROOF']) expect(offered).not.toContain(own)
    expect(offered).toEqual(expect.arrayContaining(['SAMPLE', 'COLOUR', 'LEATHER', 'FABRIC', 'TRIM', 'REPROMISE', 'COUNTER_OFFER']))
  })

  // B-PR-30a/30b: the yes carries out the act named on the preview; a no, a withdrawal or a stale request write nothing.
  it('carries out the act on the yes only (B-PR-30a/30b)', () => {
    const kind = kindOf(OVERRIDE_TASK_KIND)!
    expect(typeof kind.onApproved).toBe('function')
    expect(kind.onRejected).toBeUndefined()
    expect(kind.onWithdrawn).toBeUndefined()
    expect(kind.onStale).toBeUndefined()
  })
})
