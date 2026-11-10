import { describe, expect, it } from 'vitest'
import { draftDistributorMessage, draftNotice, draftPublicNotice, type DraftFacts } from './drafts'
import { noticePaper } from './paper'
import { noticesForPage, type PublishedRecall } from './public-notice'
import {
  defaultDecision,
  distributorDraftProblems,
  noticeOnlyGrows,
  noticeSendProblems,
  progressProblems,
  progressSummary,
  publicNoticeProblems,
  requestDue,
  requestProblems,
  scopeProblems,
  scopeWidensOnly,
  startingProgress,
  stillOutOf,
  toldCount,
  widenScope,
  wordsProblems,
} from './rules'

/** Recall, withdrawal and authority (B-W2b-260): the pure rules. Every name and number is made up. */

const FACTS: DraftFacts = {
  companyName: 'Officina Demo',
  entryReference: 'REG-2026-0007',
  reportedOn: '2026-11-02',
  styleCode: 'DEMO-JKT-01',
  styleName: 'Giacca Demo',
  wholeStyle: false,
  batchNumbers: ['BA-26-0001'],
  serialCount: 0,
  description: 'The elbow protector pocket seam opened in a test.',
  investigation: null,
  risk: 'YES',
  actionTaken: null,
}

const scope = (over: Partial<{ wholeStyle: boolean; batchNumbers: string[]; serials: string[]; workOrderIds: string[]; shipmentIds: string[] }> = {}) => ({ wholeStyle: false, batchNumbers: [], serials: [], workOrderIds: [], shipmentIds: [], ...over })

describe('the scope of a recall', () => {
  it('names the whole style or something it calls back, each code one line', () => {
    expect(scopeProblems(scope()).map((issue) => issue.path)).toEqual(['body/batchNumbers'])
    expect(scopeProblems(scope({ wholeStyle: true }))).toEqual([])
    expect(scopeProblems(scope({ batchNumbers: ['x'.repeat(101)] })).map((issue) => issue.path)).toEqual(['body/batchNumbers/0'])
  })

  it('only widens once started', () => {
    const before = scope({ batchNumbers: ['A'], workOrderIds: ['w1'] })
    expect(scopeWidensOnly(before, widenScope(before, { batchNumbers: ['B'] }))).toBe(true)
    expect(scopeWidensOnly(before, scope({ batchNumbers: ['B'], workOrderIds: ['w1'] }))).toBe(false)
    expect(scopeWidensOnly(scope({ wholeStyle: true }), scope({ batchNumbers: ['A'] }))).toBe(false)
    expect(widenScope(before, { batchNumbers: [' A ', 'C'], wholeStyle: true })).toMatchObject({ wholeStyle: true, batchNumbers: ['A', 'C'] })
  })
})

describe('progress per customer', () => {
  it('keeps sent = returned + repaired + destroyed + still out', () => {
    expect(stillOutOf({ unitsSent: 5, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 1 })).toBe(1)
    expect(stillOutOf({ unitsSent: 2, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 0 })).toBeNull()
    expect(progressProblems({ unitsSent: 2, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 0 }).map((issue) => issue.path)).toEqual(['body/unitsReturned'])
    expect(progressProblems({ unitsSent: -1, unitsReturned: 0, unitsRepaired: 0, unitsDestroyed: 0 }).map((issue) => issue.path)).toEqual(['body/unitsSent'])
  })

  it('sums the rows for the progress bar', () => {
    const rows = [
      { partyId: 'p1', unitsSent: 4, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 0, unitsStillOut: 1 },
      { partyId: 'p1', unitsSent: 2, unitsReturned: 0, unitsRepaired: 0, unitsDestroyed: 0, unitsStillOut: 2 },
      { partyId: 'p2', unitsSent: 0, unitsReturned: 0, unitsRepaired: 0, unitsDestroyed: 0, unitsStillOut: 0 },
    ]
    expect(progressSummary(rows)).toEqual({ customers: 2, unitsSent: 6, unitsReturned: 2, unitsRepaired: 1, unitsDestroyed: 0, unitsStillOut: 3, percentDone: 50 })
    expect(progressSummary([]).percentDone).toBe(0)
  })

  it('starts one row per shipment that left with garments, never twice nor beside a whole-customer row', () => {
    const shipments = [
      { shipmentId: 's1', partyId: 'p1', garments: 3, left: true },
      { shipmentId: 's2', partyId: 'p1', garments: 2, left: false },
      { shipmentId: 's3', partyId: 'p2', garments: 4, left: true },
      { shipmentId: 's4', partyId: 'p3', garments: 1, left: true },
    ]
    expect(startingProgress(shipments, [{ partyId: 'p2', shipmentId: 's3' }, { partyId: 'p3', shipmentId: null }])).toEqual([{ partyId: 'p1', shipmentId: 's1', unitsSent: 3 }])
  })
})

describe('distributors', () => {
  it('counts a recipient told once a notice to them left', () => {
    expect(toldCount(['p1', 'p2', 'p3'], [{ partyId: 'p1', status: 'ANSWERED' }, { partyId: 'p2', status: 'FAILED' }, { partyId: 'p2', status: 'DRAFT' }, { partyId: 'p9', status: 'SENT' }])).toEqual({ told: 1, of: 3, allTold: false })
    expect(toldCount(['p1'], [{ partyId: 'p1', status: 'SENT' }])).toEqual({ told: 1, of: 1, allTold: true })
    expect(toldCount([], []).allTold).toBe(false)
  })

  it('asks an address for an e-mail and a number for a call', () => {
    const draft = { channel: 'EMAIL' as const, contact: 'buyer@example.com', contactName: 'Made-up Buyer', language: 'it', subject: 'Richiamo', message: 'Testo' }
    expect(distributorDraftProblems(draft)).toEqual([])
    expect(distributorDraftProblems({ ...draft, contact: 'not an address' }).map((issue) => issue.path)).toEqual(['body/contact'])
    expect(distributorDraftProblems({ ...draft, channel: 'PHONE', contact: '+39 02 0000000', subject: null })).toEqual([])
    expect(distributorDraftProblems({ ...draft, subject: null }).map((issue) => issue.path)).toEqual(['body/subject'])
    expect(distributorDraftProblems({ ...draft, language: 'ITA-x' }).map((issue) => issue.path)).toEqual(['body/language'])
  })

  it('drafts the message in the recipient language (English for any other)', () => {
    expect(draftDistributorMessage(FACTS, 'RECALL', 'it').subject).toBe('Richiamo del prodotto DEMO-JKT-01')
    expect(draftDistributorMessage(FACTS, null, 'de').subject).toBe('Safety information about product DEMO-JKT-01')
    expect(draftDistributorMessage(FACTS, 'WITHDRAWAL', 'en').message).toContain('REG-2026-0007')
  })
})

describe('the authority notice', () => {
  it('is drafted from the entry per language with the law', () => {
    const words = draftNotice(FACTS, 'RISK', ['it', 'de'])
    expect(Object.keys(words)).toEqual(['it', 'de'])
    expect(words.it).toContain('DPI che presenta un rischio')
    expect(words.de).toContain('Reg. (EU) 2016/425 art. 8(8)')
    expect(words.de).toContain('The elbow protector pocket seam opened in a test.')
    expect(Object.keys(draftNotice(FACTS, 'NOT_CONFORMING', []))).toEqual(['en'])
    expect(wordsProblems(words, 20000, 'body/words')).toEqual([])
    expect(wordsProblems({ IT: 'x' }, 20000, 'body/words').map((issue) => issue.path)).toEqual(['body/words/IT'])
    expect(wordsProblems({}, 20000, 'body/words').map((issue) => issue.path)).toEqual(['body/words'])
  })

  it('reports a risk only when the entry decided YES, and is sent once while the entry is open', () => {
    expect(defaultDecision('YES')).toBe('RISK')
    expect(defaultDecision('ASSESSING')).toBe('NOT_CONFORMING')
    expect(noticeSendProblems({ status: 'DRAFT', decision: 'RISK' }, { status: 'OPEN', risk: 'ASSESSING' }).map((issue) => issue.path)).toEqual(['problem/RISK_NOT_DECIDED'])
    expect(noticeSendProblems({ status: 'DRAFT', decision: 'NOT_CONFORMING' }, { status: 'OPEN', risk: 'NO' })).toEqual([])
    expect(noticeSendProblems({ status: 'SENT', decision: 'RISK' }, { status: 'OPEN', risk: 'YES' }).map((issue) => issue.path)).toEqual(['problem/NOT_DRAFT'])
    expect(noticeSendProblems({ status: 'DRAFT', decision: 'RISK' }, { status: 'CLOSED', risk: 'YES' }).map((issue) => issue.path)).toEqual(['problem/ENTRY_CLOSED'])
  })

  it('prints as A4 paper in Italian or English, a draft said as such', () => {
    const paper = noticePaper({
      language: 'de',
      company: { name: 'Officina Demo', lines: [], legal: '' },
      authorityName: 'Made-up Market Surveillance Office',
      market: 'Germany (DE)',
      channel: 'SAFETY_BUSINESS_GATEWAY',
      decision: 'RISK',
      status: 'DRAFT',
      entryReference: 'REG-2026-0007',
      styleCode: 'DEMO-JKT-01',
      sentOn: null,
      reference: null,
      words: 'Line one\nLine two',
      madeAt: '2026-11-10T09:00:00.000Z',
    })
    expect(paper.language).toBe('en')
    expect(paper.facts[0]).toEqual({ label: '', value: 'DRAFT — to be sent by a person' })
    expect(paper.sections[0]!.lines).toEqual(['Line one', 'Line two'])
    expect(paper.fileName).toBe('authority-notice-REG-2026-0007-Germany-DE-de.pdf')
  })
})

describe('the public notice', () => {
  const notice = { it: { title: 'Richiamo', problem: 'Cucitura', action: 'Restituire', contact: 'Modulo' } }

  it('says per language what is wrong, what to do and whom to contact', () => {
    expect(publicNoticeProblems(notice, 'body/publicNotice')).toEqual([])
    expect(publicNoticeProblems({ it: { ...notice.it, title: 'a\nb' } }, 'body/publicNotice').map((issue) => issue.path)).toEqual(['body/publicNotice/it/title'])
    expect(publicNoticeProblems(null, 'body/publicNotice').map((issue) => issue.path)).toEqual(['body/publicNotice'])
    expect(Object.keys(draftPublicNotice(FACTS, 'RECALL', []))).toEqual(['it', 'en'])
  })

  it('once published only gains languages', () => {
    expect(noticeOnlyGrows(notice, { ...notice, en: { title: 'Recall', problem: 'Seam', action: 'Return', contact: 'Form' } })).toBe(true)
    expect(noticeOnlyGrows(notice, { it: { ...notice.it, action: 'Altro' } })).toBe(false)
  })

  const recall = (over: Partial<PublishedRecall>): PublishedRecall => ({
    kind: 'RECALL',
    number: 'RCL-2026-0001',
    publishedAt: new Date('2026-11-06T08:00:00.000Z'),
    wholeStyle: false,
    wholeBatches: [],
    wholeWorkOrderIds: [],
    partWorkOrderIds: [],
    bySerial: false,
    words: notice,
    ...over,
  })

  it('shows on a batch page the notices that reach the batch, newest first', () => {
    const recalls = [
      recall({ number: 'RCL-1', wholeBatches: ['BA-1'], wholeWorkOrderIds: ['wo1'] }),
      recall({ number: 'RCL-2', wholeStyle: true, publishedAt: new Date('2026-11-07T08:00:00.000Z') }),
      recall({ number: 'RCL-3', partWorkOrderIds: ['wo1'], bySerial: true }),
      recall({ number: 'RCL-4', wholeBatches: ['BA-9'], wholeWorkOrderIds: ['wo9'] }),
    ]
    const shown = noticesForPage(recalls, { kind: 'BATCH', workOrderId: 'wo1', batchNumber: 'BA-1' })
    expect(shown.map((entry) => [entry.number, entry.reach, entry.batches])).toEqual([
      ['RCL-2', 'STYLE', []],
      ['RCL-1', 'BATCH', ['BA-1']],
      ['RCL-3', 'PART', []],
    ])
    expect(shown[0]!.publishedOn).toBe('2026-11-07')
  })

  it('shows on a style page every notice of the style, with the batches it calls back', () => {
    const shown = noticesForPage([recall({ wholeBatches: ['BA-1', 'BA-2'] }), recall({ number: 'RCL-5', partWorkOrderIds: ['wo3'], bySerial: true })], { kind: 'STYLE', workOrderId: null, batchNumber: null })
    expect(shown.map((entry) => [entry.reach, entry.batches, entry.bySerial])).toEqual([
      ['BATCH', ['BA-1', 'BA-2'], false],
      ['PART', [], true],
    ])
  })
})

describe('authority requests', () => {
  it('counts down to the due day', () => {
    expect(requestDue({ status: 'OPEN', dueOn: '2026-11-18' }, '2026-11-10')).toEqual({ state: 'OPEN', daysLeft: 8 })
    expect(requestDue({ status: 'OPEN', dueOn: '2026-11-13' }, '2026-11-10')).toEqual({ state: 'DUE_SOON', daysLeft: 3 })
    expect(requestDue({ status: 'OPEN', dueOn: '2026-11-10' }, '2026-11-10')).toEqual({ state: 'DUE_TODAY', daysLeft: 0 })
    expect(requestDue({ status: 'OPEN', dueOn: '2026-11-08' }, '2026-11-10')).toEqual({ state: 'OVERDUE', daysLeft: -2 })
    expect(requestDue({ status: 'ANSWERED', dueOn: '2026-11-08' }, '2026-11-10')).toEqual({ state: 'ANSWERED', daysLeft: null })
  })

  it('is due on or after the day it came, and names batches only with their style', () => {
    const now = new Date('2026-11-10T12:00:00.000Z')
    expect(requestProblems({ receivedAt: new Date('2026-11-04T08:00:00.000Z'), dueOn: '2026-11-18', batchNumbers: [], styleId: null }, now)).toEqual([])
    expect(requestProblems({ receivedAt: new Date('2026-11-04T08:00:00.000Z'), dueOn: '2026-11-03', batchNumbers: ['BA-1'], styleId: null }, now).map((issue) => issue.path)).toEqual(['body/dueOn', 'body/batchNumbers'])
    expect(requestProblems({ receivedAt: new Date('2026-11-11T08:00:00.000Z'), dueOn: '2026-11-18', batchNumbers: [], styleId: null }, now).map((issue) => issue.path)).toEqual(['body/receivedAt'])
  })
})
