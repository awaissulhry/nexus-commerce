import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { ASK_REFUSALS, askProblems, cancelProblem, QUEUE_STATUS_OF, quantityOf, readShortage, rejectProblem, requestStatusesOf, shortageSeen, wordsOf } from './ask-to-buy'
import { ASK_TO_BUY_ADDS, PURCHASING_REQUESTS_ASK } from './permissions'

const TODAY = '2026-11-12'

describe('ask to buy (B-W2b-332; SCM-035, SCM-037)', () => {
  it('reads a quantity above 0 with at most four decimals and fourteen whole digits', () => {
    expect(quantityOf('12')).toBe('12.0000')
    expect(quantityOf(' 2.5 ')).toBe('2.5000')
    expect(quantityOf('0.0001')).toBe('0.0001')
    expect(quantityOf('0')).toBeNull()
    expect(quantityOf('-1')).toBeNull()
    expect(quantityOf('1.23456')).toBeNull()
    expect(quantityOf('1e3')).toBeNull()
    expect(quantityOf('99999999999999')).toBe('99999999999999.0000')
    expect(quantityOf('999999999999999')).toBeNull()
  })

  it('checks what is asked: quantity, a need date from today to two years ahead, a reason, words of one’s own', () => {
    expect(askProblems({ quantity: '4', needDate: TODAY, reason: 'Per la linea 2' }, TODAY)).toEqual([])
    const paths = askProblems({ quantity: '0', needDate: '2026-11-11', reason: '  ', description: 'x'.repeat(2001) }, TODAY).map((problem) => problem.path)
    expect(paths).toEqual(['body/quantity', 'body/needDate', 'body/reason', 'body/description'])
    expect(askProblems({ quantity: '1', needDate: '2028-11-12', reason: 'x' }, TODAY)[0]?.message).toBe('At most two years ahead.')
    expect(askProblems({ quantity: '1', needDate: '12/11/2026', reason: 'x' }, TODAY)[0]?.path).toBe('body/needDate')
    expect(askProblems({ quantity: '1', needDate: TODAY, reason: 'x'.repeat(2001) }, TODAY)[0]?.path).toBe('body/reason')
  })

  it('says a request in the queue’s statuses; a cancelled one leaves the queue', () => {
    expect(QUEUE_STATUS_OF.PENDING_APPROVAL).toBe('WAITING_APPROVAL')
    expect(QUEUE_STATUS_OF.REJECTED).toBe('SET_ASIDE')
    expect(QUEUE_STATUS_OF.CANCELLED).toBeNull()
    expect(requestStatusesOf('OPEN')).toEqual(['OPEN'])
    expect(requestStatusesOf('WAITING_APPROVAL')).toEqual(['PENDING_APPROVAL'])
    expect(requestStatusesOf('SET_ASIDE')).toEqual(['REJECTED'])
    expect(requestStatusesOf('ALL')).toEqual(['OPEN', 'PENDING_APPROVAL', 'CONVERTED', 'REJECTED'])
  })

  it('lets the person who asked (or a buyer) take back what is still to decide; only the buyer refuses an open one', () => {
    const own = { status: 'OPEN' as const, requestedById: 'me' }
    expect(cancelProblem(own, 'me', false)).toBeNull()
    expect(cancelProblem({ ...own, status: 'PENDING_APPROVAL' }, 'me', false)).toBeNull()
    expect(cancelProblem(own, 'someone else', false)).toBe(ASK_REFUSALS.NOT_YOURS)
    expect(cancelProblem(own, 'someone else', true)).toBeNull()
    expect(cancelProblem({ ...own, status: 'CONVERTED' }, 'me', true)).toBe(ASK_REFUSALS.NOT_LIVE)
    expect(rejectProblem('OPEN')).toBeNull()
    expect(rejectProblem('PENDING_APPROVAL')).toBe(ASK_REFUSALS.NOT_OPEN)
    expect(wordsOf('  ')).toBeNull()
    expect(wordsOf(' Non serve più ')).toBe('Non serve più')
  })

  it('keeps the shortage as it was seen, and reads it back', () => {
    const seen = shortageSeen({ word: 'NOT_ENOUGH', short: '12.0000', uom: 'SQFT', needDate: TODAY, runId: null, workOrderNumber: 'WO-0001' })
    expect(readShortage(seen)).toEqual({ word: 'NOT_ENOUGH', short: '12.0000', uom: 'SQFT', needDate: TODAY, runId: null, workOrderNumber: 'WO-0001' })
    expect(readShortage({ word: 'LATE' })).toBeNull()
    expect(readShortage(null)).toBeNull()
  })

  it('declares purchasing.requests.ask and gives it to every office template that works in the office', () => {
    expect(FACTORY_PERMISSIONS.isDeclared(PURCHASING_REQUESTS_ASK)).toBe(true)
    for (const key of Object.keys(ASK_TO_BUY_ADDS)) expect(templateOf(key)?.permissions).toContain(PURCHASING_REQUESTS_ASK)
    expect(templateOf('owner')?.permissions).toContain(PURCHASING_REQUESTS_ASK)
    expect(templateOf('read_only')?.permissions).not.toContain(PURCHASING_REQUESTS_ASK)
    expect(templateOf('company_doctor')?.permissions).not.toContain(PURCHASING_REQUESTS_ASK)
  })

  it('declares its two events', () => {
    const types: string[] = EVENT_DEFINITIONS.map((entry) => entry.type)
    expect(types).toContain('purchase_requests.asked')
    expect(types).toContain('purchase_requests.status_changed')
  })
})
