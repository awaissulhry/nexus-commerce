import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { partnerTemplateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { returnInstructions } from './label'
import { PORTAL_RETURNS_ADDS, PORTAL_RETURNS_PERMISSIONS } from './permissions'
import {
  cancelHeld,
  chipOf,
  complaintNextStep,
  complaintRequestProblems,
  disciplinesOf,
  inChip,
  publishHeld,
  returnMilestones,
  returnNextStep,
  returnRequestProblems,
  returnStateOf,
  sentWords,
  shareHeld,
  stageReachedWords,
} from './rules'

const facts = { goodsDueBy: null, answerBy: null, rejectReason: null, openTask: false, dispositions: [] } as const

describe('B-W2b-192 permissions and templates', () => {
  it('declares three partner permissions and gives them to the customer roles the design names', () => {
    for (const name of PORTAL_RETURNS_PERMISSIONS) expect(FACTORY_PERMISSIONS.get(name)?.partner).toBe(true)
    expect(Object.keys(PORTAL_RETURNS_ADDS).sort()).toEqual(['customer-buyer', 'customer-finance', 'customer-quality', 'customer-viewer'])
    expect(partnerTemplateOf('customer-quality')?.permissions).toEqual(expect.arrayContaining(['portal.returns.view', 'portal.returns.request', 'portal.complaints.view']))
    expect(partnerTemplateOf('customer-viewer')?.permissions).not.toContain('portal.returns.request')
    expect(partnerTemplateOf('customer-designer')?.permissions).not.toContain('portal.returns.view')
    expect(partnerTemplateOf('customer-buyer')?.permissions).not.toContain('portal.complaints.view')
    // The Admin follows its kind's roles by itself.
    expect(partnerTemplateOf('customer-admin')?.permissions).toEqual(expect.arrayContaining(['portal.returns.view', 'portal.returns.request', 'portal.complaints.view']))
  })

  it('declares its four events, without a price or a name in a payload', () => {
    for (const type of ['return_request.sent', 'claim_link.sent', 'complaint_answer.published', 'complaint_document.shared']) expect(EVENT_CATALOGUE.find(type, 1)?.context).toBe('portal-returns')
  })
})

describe('a return in customer words', () => {
  it('names each status and whose move it is', () => {
    expect(returnStateOf('AUTHORISED')).toBe('SEND_IT_BACK')
    expect(returnNextStep({ ...facts, status: 'REQUESTED', answerBy: '2026-11-10' })).toMatchObject({ forYou: false, code: 'WE_DECIDE', words: { en: 'We look at your request and answer by 2026-11-10.' } })
    expect(returnNextStep({ ...facts, status: 'AUTHORISED', goodsDueBy: '2026-11-30' })).toMatchObject({ forYou: true, code: 'SEND_IT_BACK', words: { it: 'Stampa le istruzioni di reso e rispediscilo entro il 30/11/2026.' } })
    expect(returnNextStep({ ...facts, status: 'INSPECTED', dispositions: ['CREDIT_ONLY', 'REPAIR'] }).words.en).toBe('Inspected: a credit note; we repair it and send it back.')
    expect(returnNextStep({ ...facts, status: 'REJECTED', rejectReason: 'Outside the return window.' }).words.en).toBe('Not accepted: Outside the return window.')
    // A question of ours comes first while the case is open.
    expect(returnNextStep({ ...facts, status: 'RECEIVED', openTask: true })).toMatchObject({ forYou: true, code: 'ANSWER_US' })
    expect(returnNextStep({ ...facts, status: 'CLOSED', openTask: true }).forYou).toBe(false)
  })

  it('draws where it is: done with its day, the current step, the rest to do; skipped after a rejection', () => {
    const base = { requestedAt: '2026-11-01T09:00:00.000Z', authorisedAt: null, receivedAt: null, inspectedAt: null, closedAt: null }
    expect(returnMilestones({ ...base, status: 'REQUESTED' }).map((step) => step.state)).toEqual(['DONE', 'CURRENT', 'TODO', 'TODO', 'TODO'])
    expect(returnMilestones({ ...base, status: 'RECEIVED', authorisedAt: '2026-11-02T09:00:00.000Z', receivedAt: '2026-11-05T09:00:00.000Z' }).map((step) => step.state)).toEqual(['DONE', 'DONE', 'DONE', 'CURRENT', 'TODO'])
    const rejected = returnMilestones({ ...base, status: 'REJECTED', closedAt: '2026-11-02T09:00:00.000Z' })
    expect(rejected.map((step) => [step.step, step.state])).toEqual([['ASKED', 'DONE'], ['DECIDED', 'DONE'], ['BACK_WITH_US', 'SKIPPED'], ['INSPECTED', 'SKIPPED'], ['OUTCOME', 'SKIPPED']])
  })

  it('lets the customer cancel only before the goods leave', () => {
    expect(cancelHeld('REQUESTED')).toBeNull()
    expect(cancelHeld('AUTHORISED')).toBeNull()
    expect(cancelHeld('RECEIVED')?.en).toMatch(/with us already/)
    expect(cancelHeld('CANCELLED')?.en).toMatch(/closed already/)
  })

  it('puts a case under its chips', () => {
    expect(chipOf({ open: true, forYou: true })).toEqual(['OPEN', 'WAITING'])
    expect(inChip('WAITING', { open: true, forYou: false })).toBe(false)
    expect(inChip('CLOSED', { open: false, forYou: true })).toBe(true)
    expect(inChip('ALL', { open: false, forYou: false })).toBe(true)
  })
})

describe('a complaint in customer words', () => {
  it('says when we answer, and asks to read the letter only of who may read it', () => {
    expect(complaintNextStep({ status: 'NEW', answerBy: '2026-11-11', openTask: false, readsAnswer: false }).words.en).toBe('We look into it and answer by 2026-11-11.')
    expect(complaintNextStep({ status: 'ANSWERED', answerBy: null, openTask: false, readsAnswer: true })).toMatchObject({ forYou: true, code: 'READ_ANSWER' })
    expect(complaintNextStep({ status: 'ANSWERED', answerBy: null, openTask: false, readsAnswer: false })).toMatchObject({ forYou: false, code: 'ANSWERED' })
  })

  it("draws the 8D's disciplines with the day each was left, and the step reached", () => {
    const reached = new Map([['D1', '2026-11-01'], ['D2', '2026-11-02'], ['D3', '2026-11-04']])
    const steps = disciplinesOf('EIGHT_D', 'D3', reached)!
    expect(steps.slice(0, 4).map((step) => [step.stage, step.state, step.on])).toEqual([['D1', 'DONE', '2026-11-02'], ['D2', 'DONE', '2026-11-04'], ['D3', 'CURRENT', '2026-11-04'], ['D4', 'TODO', null]])
    expect(steps).toHaveLength(8)
    expect(disciplinesOf('EIGHT_D', 'CANCELLED', reached)).toBeNull()
    expect(disciplinesOf('EIGHT_D', 'CLOSED', reached)!.every((step) => step.state === 'DONE')).toBe(true)
    expect(stageReachedWords('EIGHT_D', 'D4')?.en).toBe('D4 Root cause')
  })
})

describe('what the customer sends', () => {
  it('checks the shape of a return request and of a complaint', () => {
    expect(returnRequestProblems({ lines: [] }).map((problem) => problem.path)).toEqual(['body/lines'])
    expect(returnRequestProblems({ lines: [{ quantity: 0, reasonCode: '' }] }).map((problem) => problem.path)).toEqual(['body/lines/0/salesOrderLineId', 'body/lines/0/quantity', 'body/lines/0/reasonCode'])
    expect(returnRequestProblems({ lines: [{ salesOrderLineId: 'x', quantity: 1, reasonCode: 'WRONG_SIZE' }], note: 'n'.repeat(2001) }).map((problem) => problem.path)).toEqual(['body/note'])
    expect(complaintRequestProblems({ description: '  ' }).map((problem) => problem.path)).toEqual(['body/description'])
    expect(complaintRequestProblems({ description: 'The seam opened after two rides.' })).toEqual([])
  })

  it('says what was opened and when we answer', () => {
    expect(sentWords('RETURN', 'R-2026-0031', '2026-11-10')).toEqual({ en: 'Return request R-2026-0031 opened. We answer by 2026-11-10.', it: 'Richiesta di reso R-2026-0031 aperto. Rispondiamo entro il 10/11/2026.' })
    expect(sentWords('COMPLAINT', 'C-2026-0019', null).en).toBe('Complaint C-2026-0019 opened. We answer within 2 working days.')
  })
})

describe('the office: publish an answer, share an 8D', () => {
  it('publishes a written answer to a customer with a portal, or one that wrote by a claim link', () => {
    const written = { status: 'INVESTIGATING' as const, answerText: 'We repair it.', answerLanguage: 'en', portalOn: true, channel: 'EMAIL' }
    expect(publishHeld(written)).toBeNull()
    expect(publishHeld({ ...written, portalOn: false })?.code).toBe('NO_PORTAL')
    expect(publishHeld({ ...written, portalOn: false, channel: 'LINK' })).toBeNull()
    expect(publishHeld({ ...written, answerText: ' ' })?.code).toBe('NO_ANSWER')
    expect(publishHeld({ ...written, status: 'ANSWERED' })?.code).toBe('ANSWER_SENT')
    expect(publishHeld({ ...written, status: 'NEW' })?.code).toBe('NOT_TRIAGED')
  })

  it('shares an 8D only once a report is kept on a CAPA of the complaint', () => {
    expect(shareHeld({ capaType: null, reportFileId: null })?.code).toBe('NO_CAPA')
    expect(shareHeld({ capaType: 'EIGHT_D', reportFileId: null })?.code).toBe('NO_REPORT')
    expect(shareHeld({ capaType: 'EIGHT_D', reportFileId: 'f' })).toBeNull()
  })
})

describe('the return instructions', () => {
  it('lays out where it goes, by when, the number on the parcel and what goes in it, never a price', () => {
    const report = returnInstructions({
      language: 'en',
      date: '2026-11-07',
      company: { name: 'Example Leather Srl', lines: ['Via Example 1, 00100 Roma RM'], legal: 'VAT IT00000000000' },
      number: 'RMA-2026-0004',
      customer: { name: 'Example Racing Ltd', reference: 'CL-77' },
      sendTo: { name: 'Plant A', address: 'Via Test 2, 00100 Roma RM, IT' },
      goodsDueBy: '2026-11-22',
      freightPaidBy: 'BY_CAUSE',
      lines: [{ seq: 10, description: 'Jacket JKT-01 BLK', size: '50', quantity: 1, serial: 'SN-1' }],
      conditions: 'Goods unworn.\n\nTags on.',
    })
    expect(report.title).toBe('Return instructions')
    expect(report.facts).toContainEqual({ label: 'Send it by', value: '22 Nov 2026' })
    expect(report.sections[0]!.lines).toContain('Write RMA-2026-0004 clearly on the parcel and put a copy of this page inside.')
    expect(report.sections[1]!.table!.rows).toEqual([['10', 'Jacket JKT-01 BLK', '50', '1', 'SN-1']])
    expect(report.sections.map((section) => section.heading)).toEqual(['Label to put on the parcel', 'What goes in the parcel', 'Transport', 'Return conditions'])
    expect(JSON.stringify(report)).not.toMatch(/price|€/i)
  })
})
