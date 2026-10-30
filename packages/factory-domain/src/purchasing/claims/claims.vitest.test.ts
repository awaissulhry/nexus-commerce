import { describe, expect, it } from 'vitest'
import { claimMail } from './mail'
import {
  CLAIM_STATUSES,
  ageDays,
  canMove,
  claimActions,
  claimReasonText,
  closeProblems,
  cancelProblems,
  expectedCredit,
  foundAtFor,
  lineCredit,
  linesValue,
  nextSeq,
  readClaimReason,
  reasonProblems,
  returnProblems,
  sendProblems,
  type ClaimFacts,
} from './rules'

const facts = (overrides: Partial<ClaimFacts> = {}): ClaimFacts => ({
  number: 'CLM-2026-0001',
  kind: 'RETURN',
  status: 'DRAFT',
  remedy: 'CREDIT',
  lines: [
    { id: 'a', seq: 10, moved: false },
    { id: 'b', seq: 20, moved: false },
  ],
  ...overrides,
})

describe('the claim moves as the trigger does', () => {
  it('DRAFT → SENT | CANCELLED, SENT → ACCEPTED | REJECTED | CLOSED, ACCEPTED → CLOSED, REJECTED → SENT | CLOSED; the ended ones never move', () => {
    const allowed = CLAIM_STATUSES.flatMap((from) => CLAIM_STATUSES.filter((to) => canMove(from, to)).map((to) => `${from}→${to}`))
    expect(allowed).toEqual(['DRAFT→SENT', 'DRAFT→CANCELLED', 'SENT→ACCEPTED', 'SENT→REJECTED', 'SENT→CLOSED', 'ACCEPTED→CLOSED', 'REJECTED→SENT', 'REJECTED→CLOSED'])
  })
})

describe('the reason: a CLAIM code leads the text', () => {
  it('keeps the code and the words, and reads them back', () => {
    expect(claimReasonText('QUALITY', '  holes near the belly ')).toBe('QUALITY: holes near the belly')
    expect(claimReasonText('WRONG_ITEM', '')).toBe('WRONG_ITEM')
    expect(readClaimReason('QUALITY: holes: two of them')).toEqual({ code: 'QUALITY', note: 'holes: two of them' })
    expect(readClaimReason('WRONG_ITEM')).toEqual({ code: 'WRONG_ITEM', note: null })
    expect(readClaimReason('Hide SEED-HIDE-0002 has a hole')).toEqual({ code: null, note: 'Hide SEED-HIDE-0002 has a hole' })
  })

  it('refuses an unknown or retired code, and a code that needs words without them', () => {
    expect(reasonProblems(null, 'NOPE', null)).toEqual([{ path: 'body/reasonCode', message: 'NOPE is not a reason of the claim list.' }])
    expect(reasonProblems({ active: false, needsDetail: false }, 'OLD', null)[0]!.path).toBe('body/reasonCode')
    expect(reasonProblems({ active: true, needsDetail: true }, 'OTHER', '  ')).toEqual([{ path: 'body/reasonNote', message: 'This reason needs a few words: say what is wrong.' }])
    expect(reasonProblems({ active: true, needsDetail: true }, 'OTHER', 'stains')).toEqual([])
  })

  it('says where the problem was found from the lot: quarantine at receipt, rejected or blocked at inspection, else in stock', () => {
    expect([foundAtFor('QUARANTINE'), foundAtFor('REJECTED'), foundAtFor('BLOCKED'), foundAtFor('RELEASED'), foundAtFor(null)]).toEqual(['RECEIPT', 'INSPECTION', 'INSPECTION', 'STOCK', 'STOCK'])
  })
})

describe('what may be done now, in words', () => {
  it('sends a draft or a rejected claim with a line and a remedy', () => {
    expect(sendProblems(facts())).toEqual([])
    expect(sendProblems(facts({ status: 'REJECTED' }))).toEqual([])
    expect(sendProblems(facts({ lines: [], remedy: null }))).toEqual(['Claim CLM-2026-0001 has no line: say what it is about first.', 'Claim CLM-2026-0001 asks for nothing yet: choose a credit or a replacement.'])
    expect(sendProblems(facts({ status: 'ACCEPTED' }))[0]).toContain('only a draft, or a claim the supplier rejected, is sent')
  })

  it('closes a sent, accepted or rejected claim; cancels only a draft', () => {
    expect(closeProblems(facts({ status: 'SENT' }))).toEqual([])
    expect(closeProblems(facts())[0]).toContain('cancel a draft instead')
    expect(cancelProblems(facts())).toEqual([])
    expect(cancelProblems(facts({ status: 'SENT' }))[0]).toContain('close it instead')
    expect(cancelProblems(facts({ status: 'CLOSED' }))[0]).toBe('Claim CLM-2026-0001 is closed; only a draft is cancelled.')
  })

  it('sends goods back only on a return claim that was sent or accepted, each line once', () => {
    expect(returnProblems(facts())[0]).toContain('send it to the supplier first')
    expect(returnProblems(facts({ kind: 'CLAIM', status: 'SENT' }))[0]).toContain('only a return claim sends goods back')
    expect(returnProblems(facts({ status: 'SENT' }))).toEqual([])
    expect(returnProblems(facts({ status: 'ACCEPTED' }), ['b'])).toEqual([])
    const partly = facts({ status: 'SENT', lines: [{ id: 'a', seq: 10, moved: true }, { id: 'b', seq: 20, moved: false }] })
    expect(returnProblems(partly)).toEqual([])
    expect(returnProblems(partly, ['a'])).toEqual(['Line 10 went back already.'])
    expect(returnProblems(facts({ status: 'SENT', lines: [{ id: 'a', seq: 10, moved: true }] }))).toEqual(['Every line of claim CLM-2026-0001 went back already.'])
    expect(returnProblems(facts({ status: 'CLOSED' }))[0]).toContain('only while it is sent or accepted')
  })

  it('lists every action with why it is held', () => {
    const actions = claimActions(facts({ status: 'SENT' }))
    expect(actions).toMatchObject({ send: expect.stringContaining('only a draft'), answer: null, close: null, returnGoods: null, edit: expect.stringContaining('only while it is a draft') })
    expect(claimActions(facts()).cancel).toBeNull()
  })
})

describe('the credit: cost × base quantity, rounded once', () => {
  it("values a line, sums the lines, asks the sum for a credit and nothing for a replacement", () => {
    expect(lineCredit('4.200000', '4.5000', 'EUR')).toBe(1890)
    expect(lineCredit('5.123456', '51.8000', 'EUR')).toBe(26540)
    expect(lineCredit(null, '3', 'EUR')).toBeNull()
    const lines = [{ creditAmount: 1890 }, { creditAmount: null }, { creditAmount: 110 }]
    expect(linesValue(lines)).toBe(2000)
    expect(linesValue([{ creditAmount: null }])).toBeNull()
    expect(expectedCredit('CREDIT', lines)).toBe(2000)
    expect(expectedCredit(null, lines)).toBe(2000)
    expect(expectedCredit('REPLACEMENT', lines)).toBeNull()
  })

  it('counts days and places', () => {
    expect(ageDays(new Date('2026-11-01T10:00:00Z'), new Date('2026-11-04T09:00:00Z'))).toBe(2)
    expect(nextSeq([])).toBe(10)
    expect(nextSeq([10, 30, 20])).toBe(40)
  })
})

describe("the claim's mail: the goods, the reason, the remedy — never a price", () => {
  const base = {
    number: 'CLM-2026-0007',
    kind: 'RETURN' as const,
    remedy: 'CREDIT' as const,
    reason: { label: 'Difetto di qualità', note: 'fori sul fianco' },
    receiptNumber: 'GR-2026-0003',
    supplierDdtNumber: 'DDT-881',
    orderNumber: 'PO-2026-0012',
    lines: [{ seq: 10, code: 'LEA-BLK', name: 'Vacchetta nera', colour: 'Nero', lot: 'LOT-0042', hide: 'HD-0091', quantity: '51.8000', uom: 'FT2', reason: null }],
    recipientName: 'Anna Rossi',
    message: null,
  }

  it('speaks Italian to an Italian supplier', () => {
    const mail = claimMail({ ...base, language: 'it' })
    expect(mail.subject).toBe('Reso merce e reclamo CLM-2026-0007 (vs. DDT DDT-881)')
    expect(mail.body).toContain('Gentile Anna Rossi,')
    expect(mail.body).toContain('vi rendiamo la merce della consegna GR-2026-0003, ordine PO-2026-0012 (vs. DDT DDT-881)')
    expect(mail.body).toContain('10. LEA-BLK Vacchetta nera Nero (lotto LOT-0042, pelle HD-0091): 51.8 FT2')
    expect(mail.body).toContain('Motivo: Difetto di qualità: fori sul fianco.')
    expect(mail.body).toContain('nota di credito')
    expect(mail.body).not.toMatch(/€|EUR|\d+,\d{2}/)
  })

  it('speaks English otherwise, asks for a replacement, and takes the office’s own words instead of the standard text', () => {
    const mail = claimMail({ ...base, language: 'en', kind: 'CLAIM', remedy: 'REPLACEMENT', reason: { label: 'Quality defect', note: null }, recipientName: null })
    expect(mail.subject).toBe('Claim CLM-2026-0007 (your delivery note DDT-881)')
    expect(mail.body.startsWith('Hello,')).toBe(true)
    expect(mail.body).toContain('we report a problem with the goods of delivery GR-2026-0003, order PO-2026-0012')
    expect(mail.body).toContain('We ask you to replace the goods.')
    const own = claimMail({ ...base, language: 'en', message: '  Please call me.  ' })
    expect(own.body).toBe('Dear Anna Rossi,\n\nPlease call me.\n\nKind regards')
  })
})
