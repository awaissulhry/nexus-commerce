import { describe, expect, it } from 'vitest'
import { EVENT_CATALOGUE } from '../../events/catalogue'
import { carriedDeliveries, deliveryTermsProblems, incotermWords, planSchedule, remainderOf, reminderMail, scheduleFitProblem, validityOf, type ValidityFacts } from './rules'

describe('delivery terms (SAL-162)', () => {
  const terms = { incoterm: 'EXW', incotermPlace: 'Seedville', shipComplete: true, acceptanceMode: 'SIGN', depositPct: null } as const

  it('takes an Incoterms 2020 rule with its place, both or neither', () => {
    expect(deliveryTermsProblems(terms)).toEqual([])
    expect(deliveryTermsProblems({ ...terms, incoterm: null, incotermPlace: null })).toEqual([])
    expect(deliveryTermsProblems({ ...terms, incoterm: 'XYZ' })[0]).toMatchObject({ path: 'body/incoterm', message: expect.stringContaining('not an Incoterms 2020 rule') })
    expect(deliveryTermsProblems({ ...terms, incotermPlace: '  ' })[0]).toMatchObject({ path: 'body/incotermPlace', message: expect.stringContaining('names its place') })
    expect(deliveryTermsProblems({ ...terms, incoterm: null })[0]).toMatchObject({ path: 'body/incoterm', message: expect.stringContaining('A place without an Incoterm') })
    expect(deliveryTermsProblems({ ...terms, incotermPlace: 'a'.repeat(121) })[0]).toMatchObject({ path: 'body/incotermPlace' })
  })

  it('signs, or signs and pays a deposit the quote asks; paying alone is refused in words', () => {
    expect(deliveryTermsProblems({ ...terms, acceptanceMode: 'SIGN_AND_PAY', depositPct: '30' })).toEqual([])
    expect(deliveryTermsProblems({ ...terms, acceptanceMode: 'SIGN_AND_PAY' })[0]?.message).toContain('must ask a deposit')
    expect(deliveryTermsProblems({ ...terms, acceptanceMode: 'PAY', depositPct: '30' })[0]?.message).toContain('online payment')
  })

  it('says the rule in the document language', () => {
    expect(incotermWords('EXW', 'Seedville', 'en')).toBe('EXW Seedville (Ex Works)')
    expect(incotermWords('DAP', 'Milano', 'it')).toBe('DAP Milano (Reso al luogo di destinazione)')
    expect(incotermWords(null, null, 'it')).toBeNull()
  })
})

describe('a delivery schedule per line (SAL-151)', () => {
  const line = { seq: 10, kind: 'SIZE_GRID', sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 4 }] }

  it('plans dates from today, each once, in order, with pieces of the line\'s sizes', () => {
    const { deliveries, issues } = planSchedule(line, [{ deliveryDate: '2026-12-18', sizes: { '52': 2 } }, { deliveryDate: '2026-12-04', sizes: { '50': 1, '52': 1 }, note: ' first ' }], '2026-11-12')
    expect(issues).toEqual([])
    expect(deliveries).toEqual([
      { deliveryDate: '2026-12-04', sizeQuantities: { '50': 1, '52': 1 }, quantity: 2, note: 'first' },
      { deliveryDate: '2026-12-18', sizeQuantities: { '52': 2 }, quantity: 2, note: null },
    ])
    expect(remainderOf(line, deliveries)).toEqual({ '50': 1, '52': 1 })
  })

  it('refuses in words a past day, a day twice, a size the line lacks, more pieces than the line, an empty delivery', () => {
    const at = (input: Parameters<typeof planSchedule>[1]) => planSchedule(line, input, '2026-11-12').issues.map((issue) => issue.message)
    expect(at([{ deliveryDate: '2026-11-11', sizes: { '50': 1 } }])[0]).toContain('has passed')
    expect(at([{ deliveryDate: '2026-12-01', sizes: { '50': 1 } }, { deliveryDate: '2026-12-01', sizes: { '52': 1 } }])[0]).toContain('named twice')
    expect(at([{ deliveryDate: '2026-12-01', sizes: { '56': 1 } }])[0]).toContain('has no size 56')
    expect(at([{ deliveryDate: '2026-12-01', sizes: { '50': 2 } }, { deliveryDate: '2026-12-08', sizes: { '50': 1 } }])[0]).toBe('Size 50: the deliveries bring 3 pieces, the line has 2.')
    expect(at([{ deliveryDate: '2026-12-01', sizes: {} }])[0]).toContain('brings no pieces')
  })

  it('gives a made-to-measure unit one delivery without sizes, and a fee line none', () => {
    expect(planSchedule({ seq: 20, kind: 'MADE_TO_MEASURE', sizes: [] }, [{ deliveryDate: '2026-12-01' }], '2026-11-12')).toEqual({ deliveries: [{ deliveryDate: '2026-12-01', sizeQuantities: null, quantity: 1, note: null }], issues: [] })
    expect(planSchedule({ seq: 20, kind: 'MADE_TO_MEASURE', sizes: [] }, [{ deliveryDate: '2026-12-01' }, { deliveryDate: '2026-12-08' }], '2026-11-12').issues[0]?.message).toContain('one delivery')
    expect(planSchedule({ seq: 30, kind: 'FEE', sizes: [] }, [{ deliveryDate: '2026-12-01' }], '2026-11-12').issues[0]?.message).toContain('fee')
  })

  it('refuses a size change the schedule no longer fits, and carries only the days ahead', () => {
    const deliveries = [{ deliveryDate: '2026-12-04', sizeQuantities: { '52': 3 } }]
    expect(scheduleFitProblem({ seq: 10 }, [{ size: '52', quantity: 3 }], deliveries)).toBeNull()
    expect(scheduleFitProblem({ seq: 10 }, [{ size: '52', quantity: 2 }], deliveries)).toContain('brings 3 pieces of size 52, the line would have 2')
    expect(scheduleFitProblem({ seq: 10 }, [{ size: '50', quantity: 3 }], deliveries)).toContain('the line would have 0')
    expect(carriedDeliveries([{ deliveryDate: '2026-11-11' }, { deliveryDate: '2026-11-12' }], '2026-11-12')).toEqual({ kept: [{ deliveryDate: '2026-11-12' }], passed: [{ deliveryDate: '2026-11-11' }] })
  })
})

describe('validity: the reminder before the end, EXPIRED after (SAL-145)', () => {
  const sent: ValidityFacts = { status: 'SENT', validUntil: '2026-11-20', sentOn: '2026-11-01', reminderSentAt: null, current: true }

  it('reminds three days before the last day, once, and never a version being revised', () => {
    expect(validityOf(sent, '2026-11-12')).toMatchObject({ state: 'OPEN', daysLeft: 8, reminderOn: '2026-11-17', reminderDue: false, expiryDue: false })
    expect(validityOf(sent, '2026-11-17')).toMatchObject({ state: 'ENDS_SOON', daysLeft: 3, reminderDue: true })
    expect(validityOf(sent, '2026-11-20')).toMatchObject({ state: 'LAST_DAY', daysLeft: 0, reminderDue: true })
    expect(validityOf({ ...sent, reminderSentAt: new Date('2026-11-17T05:15:00Z') }, '2026-11-18')).toMatchObject({ reminderOn: null, reminderDue: false })
    expect(validityOf({ ...sent, current: false }, '2026-11-18')).toMatchObject({ reminderOn: null, reminderDue: false })
  })

  it('does not remind an offer just received: sent two days before at the least', () => {
    expect(validityOf({ ...sent, sentOn: '2026-11-18' }, '2026-11-18')).toMatchObject({ reminderOn: '2026-11-20', reminderDue: false })
    expect(validityOf({ ...sent, sentOn: '2026-11-19' }, '2026-11-19')).toMatchObject({ reminderOn: null })
  })

  it('is due to expire the day after its last day, and says where a closed version stands', () => {
    expect(validityOf(sent, '2026-11-21')).toMatchObject({ state: 'ENDED', daysLeft: -1, expiryDue: true, reminderDue: false })
    expect(validityOf({ ...sent, status: 'EXPIRED' }, '2026-11-25')).toMatchObject({ state: 'EXPIRED', expiryDue: false })
    expect(validityOf({ ...sent, status: 'DRAFT', sentOn: null }, '2026-11-12')).toMatchObject({ state: 'NOT_SENT', daysLeft: 8 })
    expect(validityOf({ ...sent, status: 'ACCEPTED' }, '2026-11-12')).toMatchObject({ state: 'CLOSED', daysLeft: null })
  })

  it('writes the reminder without an amount, in the document language; the thread keeps it without its link, the mail carries it (NT1:05)', () => {
    const en = reminderMail({ language: 'en', number: 'Q-0004', revision: 2, validUntil: '2026-11-20', sentOn: '2026-11-01', firmOffer: true, linkUntil: '2026-11-27' })
    expect(en.subject).toBe('Reminder: quote Q-0004 v2 ends soon')
    expect(en.stored).toContain('stands until 20 Nov 2026 included')
    expect(en.stored).toContain('firm offer')
    expect(en.stored).toContain('use the personal link in this e-mail (valid until 27 Nov 2026)')
    expect(en.stored).not.toMatch(/https?:/)
    const sent = en.withLink('https://factory.example.com/l#token=abc')
    expect(sent).toContain('open this personal link (valid until 27 Nov 2026)')
    expect(sent).toContain('https://factory.example.com/l#token=abc')
    expect(sent).toContain('firm offer')
    const it = reminderMail({ language: 'it', number: 'Q-0004', revision: 1, validUntil: '2026-11-20', sentOn: '2026-11-01', firmOffer: false, linkUntil: '2026-11-27' })
    expect(it.subject).toBe('Promemoria: il preventivo Q-0004 v1 scade presto')
    expect(it.stored).toContain('valido fino al 20/11/2026')
    expect(it.stored).not.toContain('irrevocabile')
    expect(it.withLink('https://x.example.com/l#token=t')).toContain('apra questo link personale (valido fino al 27/11/2026)')
  })

  it('declares its events for the quote screens', () => {
    for (const type of ['quote.expired', 'quote.reminder_sent', 'quote_template.changed']) expect(EVENT_CATALOGUE.get(type, 1)?.live?.permission, type).toBe('quotes.view')
  })
})
