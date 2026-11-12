import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { createInquiryBody, updateInquiryBody } from './contracts'
import { SALES_INQUIRIES_MANAGE, SALES_INQUIRIES_VIEW } from './permissions'
import {
  askInfoRefusal,
  assignRefusal,
  currentOf,
  declineRefusal,
  lineProblems,
  mailRefusal,
  overdue,
  prospectFromMail,
  prospectOf,
  prospectProblems,
  quantityOf,
  quotableLines,
  quoteRefusal,
  requestFromMail,
  resumeRefusal,
  sizesShort,
  statusAfterAssign,
  statusAfterResume,
  statusAfterUnassign,
  summaryOf,
  techPackProblems,
  unassignRefusal,
  waitingFor,
  WORKING_DAY_MINUTES,
  type InquiryFacts,
} from './rules'

/** B-W2b-295: the inquiries' pure rules (the database's …_sales_intake_w2b_guards say the same; these speak first, in words). */

const facts = (over: Partial<InquiryFacts> = {}): InquiryFacts => ({ number: 'INQ-2026-0001', status: 'NEW', assigneeId: null, partyId: null, ...over })
const A = '0190a0a0-0000-7000-8000-000000000001'
const B = '0190a0a0-0000-7000-8000-000000000002'

describe('the moves of an inquiry', () => {
  it('assigns NEW to ASSIGNED, keeps NEED_INFO waiting, takes the assignee off back to NEW, and resumes to whoever has it', () => {
    expect(statusAfterAssign('NEW')).toBe('ASSIGNED')
    expect(statusAfterAssign('ASSIGNED')).toBe('ASSIGNED')
    expect(statusAfterAssign('NEED_INFO')).toBe('NEED_INFO')
    expect(statusAfterUnassign('ASSIGNED')).toBe('NEW')
    expect(statusAfterUnassign('NEED_INFO')).toBe('NEED_INFO')
    expect(statusAfterResume(A)).toBe('ASSIGNED')
    expect(statusAfterResume(null)).toBe('NEW')
  })

  it('refuses in words: a closed inquiry, the same assignee, nobody to take off, waiting twice, resuming what does not wait', () => {
    for (const status of ['QUOTED', 'DECLINED', 'LOST'] as const) expect(assignRefusal(facts({ status }), A)?.code).toBe('CLOSED')
    expect(assignRefusal(facts({ status: 'ASSIGNED', assigneeId: A }), A)?.code).toBe('SAME_ASSIGNEE')
    expect(assignRefusal(facts({ status: 'ASSIGNED', assigneeId: A }), B)).toBeNull()
    expect(unassignRefusal(facts())?.code).toBe('NOT_ASSIGNED')
    expect(askInfoRefusal(facts({ status: 'NEED_INFO' }))?.code).toBe('ALREADY_WAITING')
    expect(resumeRefusal(facts({ status: 'ASSIGNED', assigneeId: A }))?.code).toBe('NOT_WAITING')
    expect(declineRefusal(facts(), 'OTHER', '  ')?.code).toBe('OTHER_NEEDS_WORDS')
    expect(declineRefusal(facts(), 'OTHER', 'Made-up: not our market.')).toBeNull()
    expect(declineRefusal(facts(), 'PRICE', null)).toBeNull()
    expect(quoteRefusal(facts())?.code).toBe('NEEDS_CUSTOMER')
    expect(quoteRefusal(facts({ partyId: A }))).toBeNull()
    expect(mailRefusal('REJECTED')?.code).toBe('MAIL_NOT_WAITING')
    expect(mailRefusal('TRIAGE')).toBeNull()
    expect(mailRefusal('HELD')).toBeNull()
  })
})

describe('what is asked', () => {
  it('needs a style or words, a colourway with its style, sizes in shape, and a quantity that is their sum', () => {
    expect(lineProblems({ description: 'Made-up: 40 leather jackets' }, 'body/lines/0')).toEqual([])
    expect(lineProblems({}, 'body/lines/0').map((issue) => issue.path)).toEqual(['body/lines/0/description'])
    expect(lineProblems({ description: 'x', colourwayId: A }, 'l').map((issue) => issue.path)).toEqual(['l/colourwayId'])
    expect(lineProblems({ styleId: A, sizes: { '50': 0 } }, 'l').map((issue) => issue.path)).toEqual(['l/sizes/50'])
    expect(lineProblems({ styleId: A, sizes: { '50': 5, '52': 10 }, quantity: 14 }, 'l').map((issue) => issue.path)).toEqual(['l/quantity'])
    expect(lineProblems({ styleId: A, sizes: { '50': 5, '52': 10 }, quantity: 15 }, 'l')).toEqual([])
    expect(quantityOf({ sizes: { '50': 5, '52': 10 } })).toBe(15)
    expect(quantityOf({ quantity: 40 })).toBe(40)
    expect(quantityOf({})).toBeNull()
    expect(sizesShort({ '46': 1, '48': 2, '50': 3, '52': 4, '54': 5, '56': 6, '58': 7 })).toBe('46:1 48:2 50:3 52:4 54:5 56:6 …')
  })

  it("keeps a prospect's e-mail in lower case, refuses a nameless or malformed prospect, and reads one from a mail", () => {
    const prospect = prospectOf({ name: ' Made-up Buyer ', email: ' Buyer@Example.COM ' })
    expect(prospect).toEqual({ name: 'Made-up Buyer', company: null, email: 'buyer@example.com', phone: null, lawfulBasis: 'CONTRACT' })
    expect(prospectProblems(prospect, 'body/prospect')).toEqual([])
    expect(prospectProblems(prospectOf({ phone: '+39 000 0000000' }), 'p').map((issue) => issue.path)).toEqual(['p'])
    expect(prospectProblems(prospectOf({ name: 'x', email: 'not-an-address', phone: 'abc' }), 'p').map((issue) => issue.path)).toEqual(['p/email', 'p/phone'])
    expect(prospectFromMail({ fromAddress: 'New.Buyer@example.net', fromName: 'Nuovo Cliente' })).toMatchObject({ name: 'Nuovo Cliente', email: 'new.buyer@example.net' })
    expect(requestFromMail({ subject: 'Giacche in pelle', bodyText: 'Buongiorno,\nun preventivo per 40 giacche.' })).toBe('Giacche in pelle\n\nBuongiorno,\nun preventivo per 40 giacche.')
    expect(requestFromMail({ subject: null, bodyText: null })).toBe('—')
    expect(summaryOf('\n  First line of the request  \nsecond')).toBe('First line of the request')
  })

  it('takes a tech pack of at most 50 files, each once, and finds the version in force of a series', () => {
    expect(techPackProblems([A, A], 'p')).toHaveLength(1)
    expect(techPackProblems([A, B], 'p')).toEqual([])
    const v1 = { id: A, seriesId: null, versionNo: 1, status: 'AVAILABLE', supersededAt: new Date() }
    const v2 = { id: B, seriesId: A, versionNo: 2, status: 'AVAILABLE', supersededAt: null }
    expect(currentOf([v1, v2])?.id).toBe(B)
    expect(currentOf([v1])).toBeNull()
  })

  it('says who it waits for and when it waits for us over one working day', () => {
    expect(waitingFor('NEW')).toBe('US')
    expect(waitingFor('NEED_INFO')).toBe('CUSTOMER')
    expect(waitingFor('QUOTED')).toBeNull()
    expect(overdue('ASSIGNED', WORKING_DAY_MINUTES + 1)).toBe(true)
    expect(overdue('ASSIGNED', WORKING_DAY_MINUTES)).toBe(false)
    expect(overdue('NEED_INFO', 10_000)).toBe(false)
  })

  it('makes a quote of the lines that name a style, a colourway and sizes, and says why the others are left out', () => {
    const line = (seq: number, over: object) => ({ seq, styleId: null, colourwayId: null, description: null, note: null, sizes: {}, ...over })
    const { copy, leftOut } = quotableLines([line(30, { styleId: A }), line(10, { styleId: A, colourwayId: B, sizes: { '50': 2 } }), line(20, { description: 'gloves' }), line(40, { styleId: A, colourwayId: B })])
    expect(copy.map((entry) => entry.seq)).toEqual([10])
    expect(leftOut.map((entry) => [entry.seq, entry.reason.split(':')[0]])).toEqual([
      [20, 'No style picked'],
      [30, 'No colourway picked'],
      [40, 'No pieces by size'],
    ])
  })
})

describe('the catalogues', () => {
  it('declares the permissions, gives them to sales, and declares the three events live for sales.inquiries.view', () => {
    expect(FACTORY_PERMISSIONS.get(SALES_INQUIRIES_VIEW)?.risk).toBe('read')
    expect(FACTORY_PERMISSIONS.get(SALES_INQUIRIES_MANAGE)?.risk).toBe('write')
    expect(templateOf('sales')!.permissions).toEqual(expect.arrayContaining([SALES_INQUIRIES_VIEW, SALES_INQUIRIES_MANAGE]))
    expect(templateOf('planner')!.permissions).not.toContain(SALES_INQUIRIES_VIEW)
    for (const type of ['inquiry.received', 'inquiry.changed', 'inquiry.closed']) expect(EVENT_CATALOGUE.get(type, 1)?.live?.permission, type).toBe(SALES_INQUIRIES_VIEW)
  })

  it('refuses a body that is not the contract: a mail source typed by hand, an unknown field, a size of no shape', () => {
    const company = A
    expect(createInquiryBody.safeParse({ companyId: company, source: 'PHONE', request: 'Made-up request', lines: [{ description: 'x', sizes: { '50': 2 } }] }).success).toBe(true)
    expect(createInquiryBody.safeParse({ companyId: company, source: 'MAIL', request: 'x' }).success).toBe(false)
    expect(createInquiryBody.safeParse({ companyId: company, source: 'PHONE', request: 'x', colour: 'red' }).success).toBe(false)
    expect(createInquiryBody.safeParse({ companyId: company, source: 'PHONE', request: 'x', lines: [{ description: 'x', sizes: { '': 2 } }] }).success).toBe(false)
    expect(updateInquiryBody.safeParse({ version: 1, prospect: null }).success).toBe(true)
  })
})
