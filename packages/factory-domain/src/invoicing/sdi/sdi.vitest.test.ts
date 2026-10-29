import { describe, expect, it } from 'vitest'
import { messageKeyOf, sdiMessageSchema } from '../../ports/sdi'
import { progressiveOf } from '../document'
import { addWorkingDays, deadlineState, easterSunday, isItalianWorkingDay, italianHolidays, resendDeadline, workingDaysBetween } from './deadline'
import { rejectionGist, sdiErrorsOf } from './errors'
import { pollDue, POLL_STEP_MS } from './poll'
import { decidedOutcome, failureOf, failureReasonOf, invoicePath, invoiceStatusFromSends, maySend, outcomeOf, sendFileName, sendMoveFor, sendProgressive } from './states'
import { sdiStateWords } from './words'

describe('the SDI states (FIN-086): what notifications decide, in any order', () => {
  it('maps each notification to the outcome it says', () => {
    expect(['RC', 'NE', 'DT'].map((type) => outcomeOf(type as 'RC'))).toEqual(['DELIVERED', 'DELIVERED', 'DELIVERED'])
    expect(['MC', 'AT'].map((type) => outcomeOf(type as 'MC'))).toEqual(['NOT_DELIVERABLE', 'NOT_DELIVERABLE'])
    expect(outcomeOf('NS')).toBe('REJECTED')
  })

  it('the strongest notification decides, whatever the order: delivered > not deliverable > rejected', () => {
    expect(decidedOutcome([])).toBeNull()
    expect(decidedOutcome(['MC', 'RC'])).toBe('DELIVERED')
    expect(decidedOutcome(['RC', 'MC'])).toBe('DELIVERED')
    expect(decidedOutcome(['NS', 'MC'])).toBe('NOT_DELIVERABLE')
    expect(decidedOutcome(['DT'])).toBe('DELIVERED')
  })

  it('a send passes SENT on its way to an outcome; a recorded outcome is final (a different one is a conflict)', () => {
    expect(sendMoveFor('SENDING', 'DELIVERED')).toEqual({ steps: ['SENT', 'DELIVERED'], conflict: false })
    expect(sendMoveFor('SENT', 'REJECTED')).toEqual({ steps: ['REJECTED'], conflict: false })
    expect(sendMoveFor('FAILED', 'NOT_DELIVERABLE')).toEqual({ steps: ['NOT_DELIVERABLE'], conflict: false })
    expect(sendMoveFor('DELIVERED', 'DELIVERED')).toEqual({ steps: [], conflict: false })
    expect(sendMoveFor('REJECTED', 'DELIVERED')).toEqual({ steps: [], conflict: true })
    expect(sendMoveFor('SENT', null)).toEqual({ steps: [], conflict: false })
  })

  it('the invoice follows its latest send, unless a send reached the buyer’s side', () => {
    expect(invoiceStatusFromSends([], 'ISSUED')).toBe('ISSUED')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'SENDING' }], 'ISSUED')).toBe('ISSUED')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'SENT' }], 'ISSUED')).toBe('SENT')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'FAILED' }], 'SENT')).toBe('ERROR')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'REJECTED' }, { attempt: 2, status: 'SENDING' }], 'REJECTED')).toBe('REJECTED')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'REJECTED' }, { attempt: 2, status: 'SENT' }], 'REJECTED')).toBe('SENT')
    // A late delivery of an earlier file wins over a later duplicate rejection.
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'DELIVERED' }, { attempt: 2, status: 'REJECTED' }], 'REJECTED')).toBe('DELIVERED')
    expect(invoiceStatusFromSends([{ attempt: 1, status: 'REJECTED' }], 'DELIVERED')).toBe('DELIVERED')
  })

  it('finds the invoice’s path through the database’s moves', () => {
    expect(invoicePath('SENT', 'SENT')).toEqual([])
    expect(invoicePath('ISSUED', 'DELIVERED')).toEqual(['SENT', 'DELIVERED'])
    expect(invoicePath('REJECTED', 'DELIVERED')).toEqual(['SENT', 'DELIVERED'])
    expect(invoicePath('ERROR', 'REJECTED')).toEqual(['REJECTED'])
    expect(invoicePath('DELIVERED', 'SENT')).toBeNull()
  })

  it('sends only from ISSUED, REJECTED and ERROR', () => {
    expect(['DRAFT', 'ISSUED', 'SENT', 'DELIVERED', 'NOT_DELIVERABLE', 'REJECTED', 'ERROR'].filter((status) => maySend(status as 'DRAFT'))).toEqual(['ISSUED', 'REJECTED', 'ERROR'])
  })

  it('keeps why a send failed, and whether it may have reached SDI', () => {
    const reason = failureReasonOf('NO_ANSWER', 'sdi.send_invoice failed after 3 attempt(s): no answer within 200 ms')
    expect(reason.startsWith('NO_ANSWER: ')).toBe(true)
    expect(failureOf(reason)).toMatchObject({ code: 'NO_ANSWER', uncertain: true })
    expect(failureOf(failureReasonOf('REFUSED', 'HTTP 422'))).toMatchObject({ code: 'REFUSED', uncertain: false })
    expect(failureOf('something else')).toEqual({ code: 'UNKNOWN', uncertain: false, words: 'something else' })
    expect(failureReasonOf('NOT_SENT', 'x'.repeat(900)).length).toBe(500)
  })

  it('gives every send its own file name; the first keeps the one the issue built into the XML', () => {
    const id = '0193a1b2-0000-7000-8000-000000000001'
    expect(sendProgressive(id, 1)).toBe(progressiveOf(id))
    expect(sendProgressive(id, 2)).not.toBe(sendProgressive(id, 1))
    expect(sendProgressive(id, 2, 1)).not.toBe(sendProgressive(id, 2))
    expect(sendProgressive(id, 3)).toMatch(/^[0-9A-Z]{5}$/)
    expect(sendFileName('IT12345670009_ABCDE.xml', 'Z0Z0Z')).toBe('IT12345670009_Z0Z0Z.xml')
    expect(sendFileName('invoice.xml', 'Z0Z0Z')).toBeNull()
  })
})

describe('the resend deadline: five working days after the NS (Provv. AdE 89757/2018)', () => {
  it('knows Easter and the national holidays (4 October again from 2026, L. 151/2025)', () => {
    expect(easterSunday(2026)).toBe('2026-04-05')
    expect(easterSunday(2027)).toBe('2027-03-28')
    expect(italianHolidays(2026)).toContain('2026-04-06')
    expect(italianHolidays(2026)).toContain('2026-10-04')
    expect(italianHolidays(2025)).not.toContain('2025-10-04')
    expect(isItalianWorkingDay('2026-12-08')).toBe(false)
    expect(isItalianWorkingDay('2026-11-02')).toBe(true)
    expect(isItalianWorkingDay('2026-11-07')).toBe(false)
  })

  it('counts Monday to Friday without holidays, from the Rome day of the notification', () => {
    // Monday 2 Nov 2026 → Tue 3, Wed 4, Thu 5, Fri 6, Mon 9.
    expect(resendDeadline(new Date('2026-11-02T10:00:00Z'))).toBe('2026-11-09')
    // Friday 4 Dec 2026 → Mon 7, (Tue 8 Dec holiday), Wed 9, Thu 10, Fri 11, Mon 14.
    expect(resendDeadline(new Date('2026-12-04T10:00:00Z'))).toBe('2026-12-14')
    // 23:30 UTC on 1 Nov is already 2 Nov in Rome.
    expect(resendDeadline(new Date('2026-11-01T23:30:00Z'))).toBe('2026-11-09')
    // Christmas: Wed 23 Dec → Thu 24, (25, 26, weekend), Mon 28, Tue 29, Wed 30, Thu 31.
    expect(addWorkingDays('2026-12-23', 5)).toBe('2026-12-31')
  })

  it('says how many working days are left, and when it is overdue', () => {
    const rejected = new Date('2026-11-02T10:00:00Z')
    expect(deadlineState(rejected, '2026-11-02')).toEqual({ deadline: '2026-11-09', workingDaysLeft: 5, overdue: false })
    expect(deadlineState(rejected, '2026-11-09')).toEqual({ deadline: '2026-11-09', workingDaysLeft: 0, overdue: false })
    expect(deadlineState(rejected, '2026-11-11')).toMatchObject({ workingDaysLeft: -2, overdue: true })
    expect(workingDaysBetween('2026-11-06', '2026-11-09')).toBe(1)
  })
})

describe('the NS errors in plain words (FIN-087)', () => {
  it('parses our fields and SDI’s own, known codes in words with what to fix', () => {
    const errors = sdiErrorsOf({ errors: [{ code: '00305', description: '1.4.1.1.2 <IdCodice> non valido', hint: null }, { code: '09999', description: 'Altro', hint: 'Vedi' }] })
    expect(errors).toEqual([
      expect.objectContaining({ code: '00305', fix: 'party', known: true, words: expect.stringContaining("customer's VAT number") }),
      expect.objectContaining({ code: '09999', fix: 'lines', known: false, words: 'Altro', hint: 'Vedi' }),
    ])
    expect(sdiErrorsOf({ ListaErrori: { Errore: { Codice: '00423', Descrizione: 'PrezzoTotale non calcolato' } } })).toEqual([expect.objectContaining({ code: '00423', fix: 'lines' })])
    expect(sdiErrorsOf(null)).toEqual([])
    expect(rejectionGist(errors)).toBe("00305: The customer's VAT number is not valid at the tax agency. (+1 more)")
  })
})

describe('the words of each state, with the next step', () => {
  it('explains a rejection with its deadline, and a non-delivery with the copy', () => {
    const rejected = sdiStateWords({
      invoiceStatus: 'REJECTED',
      latest: { status: 'REJECTED', fileName: 'IT1_AAAAA.xml', failureReason: null, rejection: '00404: duplicate' },
      deadline: { deadline: '2026-11-09', workingDaysLeft: 3, overdue: false },
      copy: null,
    })
    expect(rejected).toMatchObject({ code: 'REJECTED', next: { action: 'FIX_AND_RESEND' } })
    expect(rejected.explanation).toContain('counts as never issued')
    expect(rejected.explanation).toContain('by 2026-11-09')
    const missing = sdiStateWords({ invoiceStatus: 'NOT_DELIVERABLE', latest: null, deadline: null, copy: 'MISSING' })
    expect(missing).toMatchObject({ code: 'NOT_DELIVERED', next: { action: 'CHECK_COPY' } })
    expect(sdiStateWords({ invoiceStatus: 'ERROR', latest: { status: 'FAILED', fileName: 'x', failureReason: failureReasonOf('NO_ANSWER', null), rejection: null }, deadline: null, copy: null }).title).toBe('No answer from the intermediary')
    expect(sdiStateWords({ invoiceStatus: 'ISSUED', latest: { status: 'SENDING', fileName: 'IT1_AAAAA.xml', failureReason: null, rejection: null }, deadline: null, copy: null }).code).toBe('SENDING')
  })
})

describe('the port', () => {
  it('records each message once: SDI’s MessageId, else a key derived from what identifies it', () => {
    expect(messageKeyOf({ type: 'RC', messageId: 'M1', sdiIdentifier: '1', issuedAt: '2026-11-02T10:00:00Z' })).toBe('M1')
    expect(messageKeyOf({ type: 'RC', messageId: null, sdiIdentifier: '77', issuedAt: '2026-11-02T10:00:00+00:00' })).toBe('derived:RC:77:2026-11-02T10:00:00.000Z')
    const parsed = sdiMessageSchema.safeParse({ type: 'NS', messageId: 'M', sdiIdentifier: null, providerRef: null, fileName: null, issuedAt: 'yesterday', errors: [], outcome: null, note: null })
    expect(parsed.success).toBe(false)
  })
})

describe('the status poll’s rule (a lost webhook is caught)', () => {
  const tick = new Date(Math.floor(Date.parse('2026-11-02T10:00:00Z') / POLL_STEP_MS) * POLL_STEP_MS)
  const ago = (minutes: number) => new Date(tick.getTime() - minutes * 60_000)

  it('asks about a send without an outcome once it waited 15 minutes, less often as it ages', () => {
    expect(pollDue({ status: 'SENT', failureReason: null, since: ago(10) }, tick)).toBe(false)
    expect(pollDue({ status: 'SENT', failureReason: null, since: ago(16) }, tick)).toBe(true)
    expect(pollDue({ status: 'SENDING', failureReason: null, since: ago(16) }, tick)).toBe(true)
    const offStep = new Date(tick.getTime() + POLL_STEP_MS)
    expect(pollDue({ status: 'SENT', failureReason: null, since: ago(3 * 60) }, offStep)).toBe(false)
    expect(pollDue({ status: 'SENT', failureReason: null, since: new Date(offStep.getTime() - 60 * 60_000) }, offStep)).toBe(true)
  })

  it('asks about a failed send only when it may have reached SDI, for seven days; never about an outcome', () => {
    expect(pollDue({ status: 'FAILED', failureReason: failureReasonOf('NO_ANSWER', null), since: ago(20) }, tick)).toBe(true)
    expect(pollDue({ status: 'FAILED', failureReason: failureReasonOf('REFUSED', 'HTTP 422'), since: ago(20) }, tick)).toBe(false)
    expect(pollDue({ status: 'FAILED', failureReason: failureReasonOf('NO_ANSWER', null), since: ago(8 * 24 * 60) }, tick)).toBe(false)
    expect(pollDue({ status: 'DELIVERED', failureReason: null, since: ago(20) }, tick)).toBe(false)
  })
})
