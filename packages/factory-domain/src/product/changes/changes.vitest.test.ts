import { describe, expect, it } from 'vitest'
import { events } from '../../product-changes/events'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { PRODUCT_CHANGES_ADDS, PRODUCT_CHANGES_PERMISSIONS } from './permissions'
import {
  approvalCount,
  approvalOutcome,
  cancelRefusal,
  changeLineRefusal,
  decideRefusal,
  effectRefusal,
  floorRequestText,
  linkRefusal,
  orderEditRefusal,
  releaseRefusal,
  requestEditRefusal,
  requestMoveRefusal,
  submitRefusal,
  workInProgressRefusal,
} from './rules'

const order = { number: 'ECO-2026-0001', status: 'DRAFT' as const, authorId: 'author' }

describe('change requests (PRD-169, PRD-259, MES-006)', () => {
  it('triage moves: review, accept, reject with why; done only by the release', () => {
    const open = { number: 'CR-2026-0001', status: 'OPEN' as const }
    expect(requestMoveRefusal(open, 'IN_REVIEW', null)).toBeNull()
    expect(requestMoveRefusal(open, 'ACCEPTED', null)).toBeNull()
    expect(requestMoveRefusal(open, 'REJECTED', null)).toMatchObject({ code: 'REASON_NEEDED' })
    expect(requestMoveRefusal(open, 'REJECTED', 'Already in revision 3')).toBeNull()
    expect(requestMoveRefusal(open, 'DONE', null)).toMatchObject({ code: 'REQUEST_MOVE', message: expect.stringContaining('released') })
    expect(requestMoveRefusal({ number: null, status: 'REJECTED' }, 'ACCEPTED', null)).toMatchObject({ code: 'REQUEST_MOVE', message: expect.stringContaining('from the floor') })
  })

  it('what and why are fixed once accepted; only the priority still moves; nothing once done', () => {
    expect(requestEditRefusal({ number: 'CR-1', status: 'IN_REVIEW' }, ['title'])).toBeNull()
    expect(requestEditRefusal({ number: 'CR-1', status: 'ACCEPTED' }, ['priority'])).toBeNull()
    expect(requestEditRefusal({ number: 'CR-1', status: 'ACCEPTED' }, ['title'])).toMatchObject({ code: 'REQUEST_DECIDED' })
    expect(requestEditRefusal({ number: 'CR-1', status: 'DONE' }, ['priority'])).toMatchObject({ code: 'REQUEST_DECIDED' })
  })

  it('a change order carries requests of its style, not rejected, not in another live order', () => {
    expect(linkRefusal({ number: 'CR-1', status: 'OPEN', sameStyle: true, carriedBy: null }, 'ECO-1')).toBeNull()
    expect(linkRefusal({ number: 'CR-1', status: 'ACCEPTED', sameStyle: false, carriedBy: null }, 'ECO-1')).toMatchObject({ code: 'REQUEST_NOT_LINKABLE' })
    expect(linkRefusal({ number: 'CR-1', status: 'REJECTED', sameStyle: true, carriedBy: null }, 'ECO-1')).toMatchObject({ code: 'REQUEST_NOT_LINKABLE' })
    expect(linkRefusal({ number: 'CR-1', status: 'ACCEPTED', sameStyle: true, carriedBy: 'ECO-2' }, 'ECO-1')).toMatchObject({ message: expect.stringContaining('ECO-2') })
    expect(linkRefusal({ number: 'CR-1', status: 'ACCEPTED', sameStyle: true, carriedBy: 'ECO-1' }, 'ECO-1')).toBeNull()
  })

  it("the floor's report in words: the tile, where it was seen, the worker's words; never a person", () => {
    const text = floorRequestText({ problem: 'WRONG_MEASUREMENT', note: 'Sleeve 2 cm long', workOrder: 'WO-0001', operation: { seq: 30, name: 'Join sleeves' }, bundle: 'B-000042' })
    expect(text.title).toBe('Spec problem: wrong measurement')
    expect(text.reason).toBe('Wrong measurement, reported from the floor (operation 30 · Join sleeves, work order WO-0001, bundle B-000042). Sleeve 2 cm long')
    expect(floorRequestText({ problem: 'OTHER', note: null, workOrder: null, operation: null, bundle: null }).reason).toBe('Other spec problem, reported from the floor.')
  })
})

describe('change orders (PRD-170: one approval stage, four eyes)', () => {
  it('what it says changes only while DRAFT; the effect DATE needs its day', () => {
    expect(orderEditRefusal(order)).toBeNull()
    expect(orderEditRefusal({ ...order, status: 'SUBMITTED' })).toMatchObject({ code: 'ORDER_NOT_DRAFT', message: expect.stringContaining('Cancel it') })
    expect(effectRefusal('DATE', null)).toMatchObject({ code: 'EFFECT_DATE' })
    expect(effectRefusal('NEXT_ORDER', '2026-12-01')).toMatchObject({ code: 'EFFECT_DATE' })
    expect(effectRefusal('DATE', '2026-12-01')).toBeNull()
  })

  it('submitted with its draft revision and a required approver who is not the author', () => {
    const draft = { revision: 2, status: 'DRAFT' }
    expect(submitRefusal(order, null, [])).toMatchObject({ code: 'NO_DRAFT_REVISION' })
    expect(submitRefusal(order, { revision: 2, status: 'RELEASED' }, [])).toMatchObject({ code: 'REVISION_NOT_DRAFT' })
    expect(submitRefusal(order, draft, [{ approverId: 'q', required: false, decision: null }])).toMatchObject({ code: 'NO_APPROVER' })
    expect(submitRefusal(order, draft, [{ approverId: 'author', required: true, decision: null }])).toMatchObject({ code: 'OWN_APPROVAL' })
    expect(submitRefusal(order, draft, [{ approverId: 'q', required: true, decision: null }])).toBeNull()
  })

  it("the database's count: every required approval, none rejected; '2 of 3'", () => {
    const required = (decision: 'APPROVED' | 'REJECTED' | null) => ({ approverId: 'x', required: true, decision })
    expect(approvalOutcome([required('APPROVED'), required(null)])).toBe('WAITING')
    expect(approvalOutcome([required('APPROVED'), { approverId: 'y', required: false, decision: null }])).toBe('APPROVED')
    expect(approvalOutcome([required('APPROVED'), { approverId: 'y', required: false, decision: 'REJECTED' }])).toBe('REJECTED')
    expect(approvalOutcome([{ approverId: 'y', required: false, decision: 'APPROVED' }])).toBe('WAITING')
    expect(approvalCount([required('APPROVED'), required('APPROVED'), required(null)])).toEqual({ approved: 2, required: 3 })
  })

  it('a decision is the named approver’s, once, never the author’s, with why for a rejection', () => {
    const submitted = { ...order, status: 'SUBMITTED' as const }
    const mine = { approverId: 'q', required: true, decision: null }
    expect(decideRefusal(submitted, mine, 'author', 'APPROVED', null)).toMatchObject({ code: 'OWN_APPROVAL' })
    expect(decideRefusal(submitted, null, 'z', 'APPROVED', null)).toMatchObject({ code: 'NOT_APPROVER' })
    expect(decideRefusal(submitted, { ...mine, decision: 'APPROVED' }, 'q', 'APPROVED', null)).toMatchObject({ code: 'ALREADY_DECIDED' })
    expect(decideRefusal(submitted, mine, 'q', 'REJECTED', null)).toMatchObject({ code: 'REASON_NEEDED' })
    expect(decideRefusal(order, mine, 'q', 'APPROVED', null)).toMatchObject({ code: 'ORDER_MOVE' })
    expect(decideRefusal(submitted, mine, 'q', 'APPROVED', null)).toBeNull()
  })

  it('released once approved, not before its day; cancelled with why while still going', () => {
    const approved = { ...order, status: 'APPROVED' as const, effect: 'DATE' as const, effectiveDate: '2026-12-01' }
    expect(releaseRefusal({ ...approved, status: 'SUBMITTED' }, '2026-12-01')).toMatchObject({ code: 'NOT_APPROVED' })
    expect(releaseRefusal(approved, '2026-11-30')).toMatchObject({ code: 'NOT_YET_EFFECTIVE', message: expect.stringContaining('2026-12-01') })
    expect(releaseRefusal(approved, '2026-12-01')).toBeNull()
    expect(cancelRefusal(order, null)).toMatchObject({ code: 'CANCEL_REASON' })
    expect(cancelRefusal({ ...order, status: 'RELEASED' }, 'late')).toMatchObject({ code: 'ORDER_MOVE' })
    expect(cancelRefusal({ ...order, status: 'APPROVED' }, 'superseded')).toBeNull()
  })

  it("lines: a record by model name before → after; work in progress of an open work order of the style (MES-006)", () => {
    expect(changeLineRefusal({ recordType: 'BomLine', field: 'qty', before: '1.2', after: '1.4' })).toBeNull()
    expect(changeLineRefusal({ recordType: 'bomLine', field: null, before: 1, after: 2 })).toMatchObject({ code: 'LINE_INVALID' })
    expect(changeLineRefusal({ recordType: 'BomLine', field: '1qty', before: 1, after: 2 })).toMatchObject({ code: 'LINE_INVALID' })
    expect(changeLineRefusal({ recordType: 'BomLine', field: null, before: null, after: undefined })).toMatchObject({ code: 'LINE_INVALID' })
    expect(workInProgressRefusal({ number: 'WO-1', status: 'IN_PROGRESS', sameStyle: true })).toBeNull()
    expect(workInProgressRefusal({ number: 'WO-1', status: 'CLOSED', sameStyle: true })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
    expect(workInProgressRefusal({ number: 'WO-1', status: 'RELEASED', sameStyle: false })).toMatchObject({ code: 'WORK_ORDER_NOT_OPEN' })
  })
})

describe('declarations', () => {
  it('the permissions are declared and given to templates; the events name no person or money', () => {
    for (const name of PRODUCT_CHANGES_PERMISSIONS) expect(FACTORY_PERMISSIONS.isDeclared(name)).toBe(true)
    expect(PRODUCT_CHANGES_ADDS.production_manager).toContain('product.changes.approve')
    expect(PRODUCT_CHANGES_ADDS.sales).not.toContain('product.changes.manage')
    expect(events.map((event) => event.type)).toEqual(['change_request.raised', 'change_request.changed', 'change_order.changed'])
    for (const event of events) expect(Object.keys(event.payload.shape).join(' ')).not.toMatch(/worker|amount|price|cost/i)
  })
})
