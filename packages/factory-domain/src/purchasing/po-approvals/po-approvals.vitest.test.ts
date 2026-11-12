import { describe, expect, it } from 'vitest'
import { approvalFingerprint } from '../../approvals/rules'
import { askChanges, NO_SEND_OPTIONS, orderApprovalOf, sendOptionsOf, valueIncreaseOf, valueText, withdrawProblem } from './approvals'
import { copiedNeedDate, copiedRequestedDate, copyLinesOf, givenNeedDateProblem } from './duplicate'

// Hand-computed cases (B-W2b-305). Ids are made up.

describe('the change a purchase order request shows (SCM-078, SCM-080)', () => {
  it('a first revision: DRAFT → SENT only, with no send words', () => {
    expect(askChanges({ revision: 1, previous: null, value: '6000', options: NO_SEND_OPTIONS })).toEqual([{ field: 'status', from: 'DRAFT', to: 'SENT', grain: null }])
  })

  it('a later revision shows the revision and the value since the revision sent before (a cost), then the send words', () => {
    const changes = askChanges({
      revision: 2,
      previous: { revision: 1, value: '6000' },
      value: '6500',
      options: { confirmBy: '2026-11-20T10:00:00.000Z', subject: 'PO SEED rev 2', message: 'More leather.', cc: ['a@example.com'], changeNote: '50 ft² more' },
    })
    expect(changes).toEqual([
      { field: 'status', from: 'DRAFT', to: 'SENT', grain: null },
      { field: 'revision', from: 1, to: 2, grain: null },
      { field: 'orderValue', from: '6000', to: '6500', grain: 'cost' },
      { field: 'confirmBy', from: null, to: '2026-11-20T10:00:00.000Z', grain: null },
      { field: 'mailSubject', from: null, to: 'PO SEED rev 2', grain: null },
      { field: 'mailMessage', from: null, to: 'More leather.', grain: null },
      { field: 'mailCopies', from: null, to: ['a@example.com'], grain: null },
      { field: 'changeNote', from: null, to: '50 ft² more', grain: null },
    ])
    // The yes reads the same words back (what the order is sent with).
    expect(sendOptionsOf(changes)).toEqual({ confirmBy: '2026-11-20T10:00:00.000Z', subject: 'PO SEED rev 2', message: 'More leather.', cc: ['a@example.com'], changeNote: '50 ft² more' })
    expect(sendOptionsOf([{ field: 'status', from: 'DRAFT', to: 'SENT' }])).toEqual(NO_SEND_OPTIONS)
    // No copies said explicitly (an empty list) stays "none", not the default.
    expect(sendOptionsOf(askChanges({ revision: 1, previous: null, value: '1', options: { ...NO_SEND_OPTIONS, cc: [] } })).cc).toEqual([])
  })

  it('the send words are part of the fingerprint: another message is another request', () => {
    const base = { kind: 'PURCHASE_ORDER', recordType: 'PurchaseOrder', recordId: '0190a000-0000-7000-8000-000000000001', subject: { number: 'PO-1' } }
    const a = approvalFingerprint({ ...base, changes: askChanges({ revision: 1, previous: null, value: '10', options: { ...NO_SEND_OPTIONS, message: 'A' } }) })
    const b = approvalFingerprint({ ...base, changes: askChanges({ revision: 1, previous: null, value: '10', options: { ...NO_SEND_OPTIONS, message: 'B' } }) })
    expect(a).not.toBe(b)
  })

  it('values in major units; the value added since the revision before, null on a first revision', () => {
    expect(valueText(600000, 'EUR')).toBe('6000')
    expect(valueText(1250, 'EUR')).toBe('12.5')
    expect(valueIncreaseOf(650000, 600000, 'EUR')).toBe('500')
    expect(valueIncreaseOf(550000, 600000, 'EUR')).toBe('-500')
    expect(valueIncreaseOf(650000, null, 'EUR')).toBeNull()
    expect(valueText(5000, 'JPY')).toBe('5000')
  })
})

describe('the order’s approval in words', () => {
  const task = (status: string) => ({ id: 't1', status })
  it('none, waiting, approved (being sent / a draft approved as it is / sent), refused, taken back, changed', () => {
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: null }, null).state).toBe('NONE')
    expect(orderApprovalOf({ status: 'PENDING_APPROVAL', approvalTaskId: 't1' }, task('PENDING'))).toEqual({ state: 'WAITING', words: 'It waits for a yes before it is sent: nothing in it changes meanwhile.' })
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: null }, task('PENDING')).words).toBe('A yes was asked for it as it is now: Send sends it once it is given.')
    expect(orderApprovalOf({ status: 'PENDING_APPROVAL', approvalTaskId: 't1' }, task('APPROVED')).state).toBe('APPROVED')
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: null }, task('APPROVED')).words).toMatch(/^Approved as it is: Send sends it without asking again/)
    expect(orderApprovalOf({ status: 'SENT', approvalTaskId: 't1' }, task('APPROVED')).state).toBe('SENT_WITH_YES')
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: 't1' }, task('REJECTED')).state).toBe('REJECTED')
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: 't1' }, task('WITHDRAWN')).state).toBe('WITHDRAWN')
    expect(orderApprovalOf({ status: 'DRAFT', approvalTaskId: 't1' }, task('STALE')).state).toBe('STALE')
  })

  it('a request is taken back only while the order waits', () => {
    expect(withdrawProblem('PENDING_APPROVAL')).toBeNull()
    expect(withdrawProblem('DRAFT')).toBe('The order waits for no yes: it is a draft already.')
    expect(withdrawProblem('SENT')).toBe('The order is sent and waiting for the supplier: no request of it waits for a yes.')
  })
})

describe('duplicate or reorder (SCM-057)', () => {
  const lines = [
    { id: 'a', seq: 10, cancelled: false },
    { id: 'b', seq: 20, cancelled: true },
    { id: 'c', seq: 30, cancelled: false },
  ]
  it('copies every line not cancelled by default; named lines in the order’s own order', () => {
    expect(copyLinesOf(lines, null)).toEqual({ ids: ['a', 'c'], problems: [] })
    expect(copyLinesOf(lines, ['c', 'a'])).toEqual({ ids: ['a', 'c'], problems: [] })
  })
  it('refuses a cancelled line, a line of another order, a line twice, and nothing to copy', () => {
    expect(copyLinesOf(lines, ['b']).problems).toEqual([{ path: 'body/lineIds/0', message: 'Line 20 was cancelled: it is not copied.' }])
    expect(copyLinesOf(lines, ['a', 'x']).problems).toEqual([{ path: 'body/lineIds/1', message: 'Not a line of this order.' }])
    expect(copyLinesOf(lines, ['a', 'a']).problems[0]).toEqual({ path: 'body/lineIds', message: 'A line is named twice.' })
    expect(copyLinesOf([{ id: 'b', seq: 20, cancelled: true }], null).problems).toEqual([{ path: 'body/lineIds', message: 'Every line of this order was cancelled: there is nothing to copy.' }])
  })
  it('need dates: the one given; else the old day when still ahead of the earliest arrival; else that arrival', () => {
    expect(copiedNeedDate('2026-12-20', '2026-11-26', null)).toBe('2026-12-20')
    expect(copiedNeedDate('2026-10-01', '2026-11-26', null)).toBe('2026-11-26')
    expect(copiedNeedDate('2026-10-01', '2026-11-26', '2026-11-15')).toBe('2026-11-15')
    expect(copiedRequestedDate('2026-10-01', '2026-11-12')).toBeNull()
    expect(copiedRequestedDate('2026-11-12', '2026-11-12')).toBe('2026-11-12')
    expect(givenNeedDateProblem('2026-11-11', '2026-11-12')).toBe('The need date of a new order is today or later.')
    expect(givenNeedDateProblem(null, '2026-11-12')).toBeNull()
  })
})
