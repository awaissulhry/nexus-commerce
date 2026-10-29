import { describe, expect, it } from 'vitest'
import { depositLinkMail } from './deposit-link'
import { bankReferenceProblem, normaliseBankReference, openOnDeposit, openOnInvoice, planAllocations, voidProblems } from './payments'

describe('a payment received (FIN-121, FIN-122)', () => {
  it('the bank reference is kept in one form, so the same transfer typed twice is found', () => {
    expect(normaliseBankReference(' cro 0012 3456 ')).toBe('CRO00123456')
    expect(normaliseBankReference('   ')).toBeNull()
    expect(bankReferenceProblem('')).toContain('required')
    expect(bankReferenceProblem('TRN#1')).toContain('letters, digits')
    expect(bankReferenceProblem('TRN-2026/0001')).toBeNull()
  })

  it('without an amount an allocation takes what fits: the target\'s open amount, the payment\'s rest; the rest stays unallocated', () => {
    const plan = planAllocations(250000, [{ target: 'DEPOSIT_REQUEST', targetId: 'r1', open: openOnDeposit(183000, 0), path: 'body/allocations/0', label: 'deposit request' }], 'EUR')
    expect(plan).toEqual({ allocations: [{ target: 'DEPOSIT_REQUEST', targetId: 'r1', amount: 183000 }], left: 67000, issues: [] })
  })

  it('an amount above what is open or left is refused, in words', () => {
    const plan = planAllocations(10000, [
      { target: 'INVOICE', targetId: 'i1', open: openOnInvoice(61000, 0, 60000), amount: 2000, path: 'body/allocations/0', label: 'invoice FT-1' },
      { target: 'INVOICE', targetId: 'i2', open: 50000, amount: 20000, path: 'body/allocations/1', label: 'invoice FT-2' },
    ], 'EUR')
    expect(plan.allocations).toEqual([])
    expect(plan.issues.map((issue) => issue.message)).toEqual(['The invoice FT-1 is open for 10.00 EUR only; allocate at most that.', 'The payment has 100.00 EUR left to allocate; allocate at most that.'])
  })

  it('a payment is voided only once its allocations add up to 0', () => {
    expect(voidProblems({ status: 'RECEIVED', allocated: 0 })).toEqual([])
    expect(voidProblems({ status: 'RECEIVED', allocated: 100 })).toHaveLength(1)
    expect(voidProblems({ status: 'VOIDED', allocated: 0 })).toHaveLength(1)
  })
})

describe('the deposit page mail (DEPOSIT_INFO link)', () => {
  const input = { locale: 'it' as const, quoteDocument: 'QT-2026-00001 v1', orderNumber: 'SO-2026-0001', expiresAt: new Date('2026-11-28T09:00:00.000Z'), message: null }

  it('says what the page holds; the text the thread keeps never holds the link', () => {
    const kept = depositLinkMail(input, null)
    expect(kept.subject).toBe("Acconto per l'offerta QT-2026-00001 v1: importo e coordinate per il bonifico")
    expect(kept.body).toContain("l'offerta QT-2026-00001 v1 (ordine SO-2026-0001)")
    expect(kept.body).toContain('[Link personale inviato solo per e-mail: non è conservato qui.]')
    expect(kept.body).not.toContain('#token=')
    const sent = depositLinkMail({ ...input, locale: 'en', orderNumber: null, message: 'Thank you for your order.' }, 'https://factory.example.com/l#token=abc')
    expect(sent.subject).toBe('Deposit for quote QT-2026-00001 v1: amount and bank details')
    expect(sent.body).toContain('https://factory.example.com/l#token=abc')
    expect(sent.body.endsWith('Thank you for your order.')).toBe(true)
  })
})
