import { describe, expect, it } from 'vitest'
import { addDays, daysUntil, expiryDateProblem, expiryStateOf, reminderWindowOf } from '../expiry/rules'
import { markedNameOf, markupProblems, markupTargetOf } from '../markup/rules'
import { blockedSentence, problemsOf, requirementSentence, requirementStates, ruleDraftProblems, rulesThatApply, sameRuleKey, type RequiredRule } from './rules'

const TODAY = '2026-11-07'
const rule = (over: Partial<RequiredRule> = {}): RequiredRule => ({ id: 'r1', recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK', active: true, ...over })
const file = (over: Partial<{ id: string; category: string | null; status: string; supersededAt: string | null; expiresOn: string | null }> = {}) => ({ id: 'f1', category: 'SUPPLIER_CERTIFICATE', status: 'AVAILABLE', supersededAt: null, expiresOn: null, ...over })

describe('required documents (COL-048)', () => {
  it('a rule names a known record type, one of its statuses, a document, a party role and a level', () => {
    expect(ruleDraftProblems({ recordType: 'PurchaseOrder', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'CONFIRMED', partyRole: 'SUPPLIER', level: 'BLOCK' })).toEqual([])
    expect(ruleDraftProblems({ recordType: 'Invoice', category: 'SUPPLIER_CERTIFICATE', beforeStatus: 'ISSUED', partyRole: null, level: 'WARN' }).map((issue) => issue.path)).toEqual(['body/recordType'])
    expect(ruleDraftProblems({ recordType: 'PurchaseOrder', category: 'OTHER', beforeStatus: 'POSTED', partyRole: 'ROBOT', level: 'STOP' }).map((issue) => issue.path)).toEqual(['body/beforeStatus', 'body/category', 'body/partyRole', 'body/level'])
  })

  it('applies the active rules of the status moved to, for every record or the party role the record has', () => {
    const rules = [rule(), rule({ id: 'r2', partyRole: null, category: 'DECLARATION', level: 'WARN' }), rule({ id: 'r3', partyRole: 'CUSTOMER' }), rule({ id: 'r4', active: false }), rule({ id: 'r5', beforeStatus: 'SENT' })]
    expect(rulesThatApply(rules, 'PurchaseOrder', 'CONFIRMED', ['SUPPLIER']).map((r) => r.id)).toEqual(['r1', 'r2'])
    expect(rulesThatApply(rules, 'PurchaseOrder', 'CONFIRMED', []).map((r) => r.id)).toEqual(['r2'])
    expect(sameRuleKey(rule(), rule({ id: 'x', level: 'WARN' }))).toBe(true)
    expect(sameRuleKey(rule(), rule({ partyRole: null }))).toBe(false)
  })

  it('a current version valid today meets it; superseded, held, other kinds and expired ones do not', () => {
    const rules = [rule()]
    expect(requirementStates(rules, [file()], TODAY)[0]).toMatchObject({ reason: 'MET', fileId: 'f1' })
    expect(requirementStates(rules, [file({ supersededAt: '2026-10-01T00:00:00Z' })], TODAY)[0]?.reason).toBe('MISSING')
    expect(requirementStates(rules, [file({ status: 'QUARANTINED' })], TODAY)[0]?.reason).toBe('MISSING')
    expect(requirementStates(rules, [file({ category: 'TEST_REPORT' })], TODAY)[0]?.reason).toBe('MISSING')
    expect(requirementStates(rules, [file({ expiresOn: '2026-11-06' })], TODAY)[0]).toMatchObject({ reason: 'EXPIRED', fileId: 'f1', expiresOn: '2026-11-06' })
    // The last valid day is the date itself; the longest valid one is named.
    expect(requirementStates(rules, [file({ expiresOn: TODAY })], TODAY)[0]?.reason).toBe('MET')
    expect(requirementStates(rules, [file({ id: 'a', expiresOn: '2027-01-01' }), file({ id: 'b', expiresOn: '2028-01-01' }), file({ id: 'c', expiresOn: '2026-01-01' })], TODAY)[0]?.fileId).toBe('b')
  })

  it('splits what is missing into blocks and warnings, said in words', () => {
    const states = requirementStates([rule(), rule({ id: 'r2', category: 'DECLARATION', level: 'WARN', partyRole: null })], [file({ expiresOn: '2026-10-28' })], TODAY)
    const { blocks, warnings } = problemsOf(states)
    expect(blocks.map((s) => s.ruleId)).toEqual(['r1'])
    expect(warnings.map((s) => s.ruleId)).toEqual(['r2'])
    expect(requirementSentence(blocks[0]!)).toBe('A supplier certificate is needed before Confirmed: the one on file expired on 2026-10-28.')
    expect(requirementSentence(warnings[0]!)).toBe('A declaration is needed before Confirmed: none is on file.')
    expect(blockedSentence(blocks)).toMatch(/^This purchase order cannot move to Confirmed yet\. A supplier certificate/)
  })
})

describe('document expiry (COL-049)', () => {
  it('counts days and says the state', () => {
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01')
    expect(daysUntil('2026-12-07', TODAY)).toBe(30)
    expect(expiryStateOf(null, TODAY)).toBe('NONE')
    expect(expiryStateOf('2026-12-08', TODAY)).toBe('VALID')
    expect(expiryStateOf('2026-12-07', TODAY)).toBe('EXPIRING')
    expect(expiryStateOf(TODAY, TODAY)).toBe('EXPIRING')
    expect(expiryStateOf('2026-11-06', TODAY)).toBe('EXPIRED')
  })

  it('reminds 30 days before, then 7 days before, once each', () => {
    const at = (day: string) => new Date(`${day}T08:00:00Z`)
    expect(reminderWindowOf({ expiresOn: '2026-12-08', remindedAt: null }, TODAY)).toBeNull()
    expect(reminderWindowOf({ expiresOn: '2026-12-07', remindedAt: null }, TODAY)).toBe(30)
    expect(reminderWindowOf({ expiresOn: '2026-12-07', remindedAt: at(TODAY) }, TODAY)).toBeNull()
    expect(reminderWindowOf({ expiresOn: '2026-11-14', remindedAt: at('2026-10-20') }, TODAY)).toBe(7)
    expect(reminderWindowOf({ expiresOn: '2026-11-14', remindedAt: at(TODAY) }, TODAY)).toBeNull()
    // Added five days before: the 7-day reminder only; nothing after the date.
    expect(reminderWindowOf({ expiresOn: '2026-11-12', remindedAt: null }, TODAY)).toBe(7)
    expect(reminderWindowOf({ expiresOn: '2026-11-06', remindedAt: null }, TODAY)).toBeNull()
  })

  it('a typed date is a real date, not too far away; a past one is kept', () => {
    expect(expiryDateProblem('2026-02-30', TODAY)).toMatch(/not a date/)
    expect(expiryDateProblem('1999-12-31', TODAY)).toMatch(/past/)
    expect(expiryDateProblem('2050-01-01', TODAY)).toMatch(/20 years/)
    expect(expiryDateProblem('2025-01-01', TODAY)).toBeNull()
  })
})

describe('markup (COL-055)', () => {
  const arrow = { kind: 'arrow', from: { x: 0.1, y: 0.2 }, to: { x: 0.5, y: 0.5 } }
  it('a picture becomes a new version, a PDF page an overlay', () => {
    expect(markupTargetOf('image/jpeg')).toBe('picture')
    expect(markupTargetOf('application/pdf')).toBe('pdf')
    expect(markupTargetOf('text/csv')).toBeNull()
    expect(markupProblems({ target: 'picture', page: null, shapes: [arrow], note: ' ', resultType: 'image/jpeg' })).toEqual([])
    expect(markupProblems({ target: 'pdf', page: 2, shapes: [arrow, { kind: 'circle', center: { x: 0.5, y: 0.5 }, radius: 0.1 }], note: 'Stitch line', resultType: null })).toEqual([])
  })

  it('refuses what cannot be drawn back', () => {
    const paths = (draft: Parameters<typeof markupProblems>[0]) => markupProblems(draft).map((issue) => issue.path)
    expect(paths({ target: null, page: null, shapes: [], note: null, resultType: null })).toEqual(['params/fileId', 'body/shapes'])
    expect(paths({ target: 'pdf', page: null, shapes: [arrow], note: null, resultType: 'image/png' })).toEqual(['body/page', 'body/result'])
    expect(paths({ target: 'picture', page: 1, shapes: [{ ...arrow, colour: 'red' }], note: 'x'.repeat(2001), resultType: 'image/gif' })).toEqual(['body/shapes/0', 'body/note', 'body/page', 'body/result/contentType'])
    expect(paths({ target: 'picture', page: null, shapes: [{ kind: 'circle', center: { x: 2, y: 0 }, radius: 0.1 }], note: null, resultType: null })).toEqual(['body/shapes/0', 'body/result'])
  })

  it('names the marked picture after the original', () => {
    expect(markedNameOf('front.webp', 'image/jpeg')).toBe('front (marked).jpg')
    expect(markedNameOf('front (marked).jpg', 'image/png')).toBe('front (marked).png')
  })
})
