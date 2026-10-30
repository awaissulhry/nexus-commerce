import { describe, expect, it } from 'vitest'
import { orderStatusAfter } from '../../inventory/receipts/rules'
import { cancelLinesProblems, cancelOrderProblem, closeShortProblems, lineEndMail, mailsSupplier, outstandingBase, receivedInFull, supplierHolds, type EndLineFacts } from './changes'
import { confirmationReminderMail, confirmByProblem, daysLate, defaultConfirmBy, deliveryStateOf, expectedDateOf, moveConfirmByProblem, reminderState, remindProblem, weekEndOf } from './delivery'

/** Made-up lines (base quantities hand-checked). */
const line = (over: Partial<EndLineFacts> = {}): EndLineFacts => ({ id: 'a', seq: 10, label: 'Line 10 (ART-1 Seed cowhide)', cancelled: false, closedShort: false, expectedBase: '100.0000', receivedBase: '0.0000', tolerancePct: null, atDock: false, sentBefore: true, ...over })
const HOUR = 3_600_000

describe('cancel the order (W2a)', () => {
  it('a draft, a sent, declined or confirmed order; not with changes waiting, never after goods', () => {
    expect(['DRAFT', 'SENT', 'DECLINED', 'CONFIRMED'].map((status) => cancelOrderProblem(status as 'SENT'))).toEqual([null, null, null, null])
    expect(cancelOrderProblem('CHANGES_PROPOSED')).toMatch(/accept or refuse the supplier's changes first/)
    expect(cancelOrderProblem('PARTLY_RECEIVED')).toMatch(/Close the rest short instead/)
    expect(cancelOrderProblem('CLOSED')).toBe('The order is closed already.')
  })

  it('who holds the order: it was sent, or a draft of revision 2 replaces one the supplier holds', () => {
    expect([supplierHolds('DRAFT', 1), supplierHolds('DRAFT', 2), supplierHolds('SENT', 1), supplierHolds('CONFIRMED', 3), supplierHolds('CANCELLED', 2)]).toEqual([false, true, true, true, false])
    expect(['DRAFT', 'SENT', 'CONFIRMED', 'DECLINED', 'PARTLY_RECEIVED', 'RECEIVED'].map((status) => mailsSupplier(status as 'SENT'))).toEqual([false, true, true, true, true, false])
  })
})

describe('cancel lines', () => {
  it('a sent order’s open line with nothing received', () => {
    expect(cancelLinesProblems({ status: 'SENT', revision: 1 }, [line()], [line({ id: 'b', seq: 20 })])).toEqual([])
    expect(cancelLinesProblems({ status: 'CONFIRMED', revision: 1 }, [line()], [line({ id: 'b', seq: 20 })])).toEqual([])
  })

  it('refuses, each in words: goods came, goods at the dock, ended already, a draft’s new line, the last open line, a proposal waiting', () => {
    expect(cancelLinesProblems({ status: 'PARTLY_RECEIVED', revision: 1 }, [line({ receivedBase: '40.0000' })], [line({ id: 'b' })])).toEqual(['Line 10 (ART-1 Seed cowhide): goods came for it: close it short instead.'])
    expect(cancelLinesProblems({ status: 'SENT', revision: 1 }, [line({ atDock: true })], [line({ id: 'b' })])[0]).toMatch(/at the dock/)
    expect(cancelLinesProblems({ status: 'SENT', revision: 1 }, [line({ cancelled: true })], [line({ id: 'b' })])).toEqual(['Line 10 (ART-1 Seed cowhide): it is cancelled already.'])
    expect(cancelLinesProblems({ status: 'DRAFT', revision: 1 }, [line()], [])).toEqual(['The order was never sent: remove the line instead.'])
    expect(cancelLinesProblems({ status: 'DRAFT', revision: 2 }, [line({ sentBefore: false })], [line({ id: 'b' })])).toEqual(['Line 10 (ART-1 Seed cowhide): it is new in this draft: remove it instead.'])
    expect(cancelLinesProblems({ status: 'DRAFT', revision: 2 }, [line()], [line({ id: 'b' })])).toEqual([])
    expect(cancelLinesProblems({ status: 'SENT', revision: 1 }, [line()], [line({ id: 'b', cancelled: true })])).toEqual(['These are the last open lines of the order: cancel the order instead.'])
    expect(cancelLinesProblems({ status: 'CHANGES_PROPOSED', revision: 1 }, [line()], [])[0]).toMatch(/accept or refuse/)
    expect(cancelLinesProblems({ status: 'RECEIVED', revision: 1 }, [line()], [])[0]).toMatch(/nothing is left to cancel/)
  })

  it('the last unreceived line of a partly received order may go: what came on the others stays', () => {
    expect(cancelLinesProblems({ status: 'PARTLY_RECEIVED', revision: 1 }, [line()], [line({ id: 'b', receivedBase: '100.0000' })])).toEqual([])
  })
})

describe('close short', () => {
  it('a line that came in part, on a partly received order', () => {
    expect(closeShortProblems({ status: 'PARTLY_RECEIVED' }, [line({ receivedBase: '60.0000' })])).toEqual([])
  })

  it('refuses: nothing came (cancel it), received in full (within its tolerance), ended, the order not partly received', () => {
    expect(closeShortProblems({ status: 'PARTLY_RECEIVED' }, [line()])).toEqual(['Line 10 (ART-1 Seed cowhide): nothing came for it yet: cancel it instead.'])
    expect(closeShortProblems({ status: 'PARTLY_RECEIVED' }, [line({ receivedBase: '99.0000', tolerancePct: '2' })])).toEqual(['Line 10 (ART-1 Seed cowhide): it was received in full: nothing is left to close.'])
    expect(closeShortProblems({ status: 'PARTLY_RECEIVED' }, [line({ receivedBase: '10.0000', closedShort: true })])).toEqual(['Line 10 (ART-1 Seed cowhide): it is closed short already.'])
    expect(closeShortProblems({ status: 'SENT' }, [line()])[0]).toMatch(/^Nothing was received against this order yet/)
    expect(closeShortProblems({ status: 'RECEIVED' }, [line()])[0]).toMatch(/nothing is left to close short/)
  })

  it('the rest still expected, and in full within the tolerance (the receipts’ own rule)', () => {
    expect(outstandingBase(line({ receivedBase: '60.0000' }))).toBe('40.0000')
    expect(outstandingBase(line({ receivedBase: '120.0000' }))).toBe('0.0000')
    expect(outstandingBase(line({ receivedBase: '60.0000', closedShort: true }))).toBe('0.0000')
    expect([receivedInFull(line({ receivedBase: '97.9000', tolerancePct: '2' })), receivedInFull(line({ receivedBase: '98.0000', tolerancePct: '2' }))]).toEqual([false, true])
  })

  it('an ended line counts as complete for the order (inventory/receipts orderStatusAfter)', () => {
    const lines = [
      { expected: '100', received: '100' },
      { expected: '50', received: '20' },
    ]
    expect(orderStatusAfter({ status: 'PARTLY_RECEIVED', confirmed: true }, lines)).toBe('PARTLY_RECEIVED')
    expect(orderStatusAfter({ status: 'PARTLY_RECEIVED', confirmed: true }, [lines[0]!, { ...lines[1]!, ended: true }])).toBe('RECEIVED')
    expect(orderStatusAfter({ status: 'CONFIRMED', confirmed: true }, [{ expected: '100', received: '0', ended: true }, { expected: '50', received: '0' }])).toBe('CONFIRMED')
  })

  it('the supplier’s mail lists the lines', () => {
    expect(lineEndMail({ kind: 'CLOSED_SHORT', language: 'en', number: 'PO-7 rev. 2', recipientName: null, lines: ['Line 10 (ART-1 Seed cowhide)'], message: 'Thank you.' })).toEqual({
      subject: 'Purchase order PO-7 rev. 2: lines closed',
      body: 'Hello,\n\nthese lines of our purchase order PO-7 rev. 2 are closed with what we received already: please do not send the rest.\n- Line 10 (ART-1 Seed cowhide)\n\nThe rest of the order does not change.\n\nThank you.',
    })
    expect(lineEndMail({ kind: 'CANCELLED', language: 'it', number: 'PO-7', recipientName: 'Mario', lines: ['Riga 20'], message: null }).subject).toBe('Ordine di acquisto PO-7: righe annullate')
  })
})

describe('confirm by', () => {
  const sentAt = new Date('2026-11-06T09:30:00.000Z') // a Friday

  it('48 hours by default; longer by the supplier’s closed days between', () => {
    expect(defaultConfirmBy(sentAt, '2026-11-06', null).toISOString()).toBe('2026-11-08T09:30:00.000Z')
    // Two open days of a supplier closed at the weekend: Monday and Tuesday → Tuesday at the same time.
    expect(defaultConfirmBy(sentAt, '2026-11-06', '2026-11-10').toISOString()).toBe('2026-11-10T09:30:00.000Z')
    expect(defaultConfirmBy(sentAt, '2026-11-06', '2026-11-07').toISOString()).toBe('2026-11-08T09:30:00.000Z')
  })

  it('a deadline the office gives: to come, after the send, within 60 days and the link’s life', () => {
    const now = new Date('2026-11-06T10:00:00.000Z')
    expect(confirmByProblem(new Date(now.getTime() + 24 * HOUR), { now, sentAt, linkExpiresAt: new Date(now.getTime() + 14 * 24 * HOUR) })).toBeNull()
    expect(confirmByProblem(new Date(now.getTime() - HOUR), { now, sentAt: null, linkExpiresAt: null })).toMatch(/still to come/)
    expect(confirmByProblem(new Date(now.getTime() + 61 * 24 * HOUR), { now, sentAt: null, linkExpiresAt: null })).toMatch(/within 60 days/)
    expect(confirmByProblem(new Date(now.getTime() + 20 * 24 * HOUR), { now, sentAt: null, linkExpiresAt: new Date(now.getTime() + 14 * 24 * HOUR) })).toMatch(/confirm link stops working/)
    expect([moveConfirmByProblem('SENT'), moveConfirmByProblem('DRAFT'), moveConfirmByProblem('CONFIRMED')]).toEqual([null, 'The order is not sent yet: its confirm-by time is set when you send it.', 'The order waits for no answer: it has no confirm-by time to move.'])
  })
})

describe('reminders', () => {
  const confirmBy = new Date('2026-11-08T09:30:00.000Z')

  it('the first after the deadline, then one a day, at most three per revision; only while the order waits', () => {
    const facts = (reminders: Date[], status = 'SENT') => ({ status, revision: 2, confirmBy, reminders: reminders.map((sentAt) => ({ sentAt })) })
    expect(reminderState(facts([]), new Date(confirmBy.getTime() - HOUR))).toMatchObject({ overdue: false, due: false, sent: 0, nextAt: confirmBy })
    expect(reminderState(facts([]), new Date(confirmBy.getTime() + HOUR))).toMatchObject({ overdue: true, due: true, sent: 0 })
    const first = new Date(confirmBy.getTime() + HOUR)
    expect(reminderState(facts([first]), new Date(first.getTime() + 23 * HOUR))).toMatchObject({ due: false, sent: 1, nextAt: new Date(first.getTime() + 24 * HOUR) })
    expect(reminderState(facts([first]), new Date(first.getTime() + 24 * HOUR))).toMatchObject({ due: true, sent: 1 })
    expect(reminderState(facts([first, first, first]), new Date(first.getTime() + 72 * HOUR))).toMatchObject({ due: false, sent: 3, nextAt: null })
    expect(reminderState(facts([], 'CONFIRMED'), new Date(confirmBy.getTime() + HOUR))).toMatchObject({ overdue: false, due: false, nextAt: null })
    // A reminder by hand before the deadline counts: the daily run waits a day after it.
    const early = new Date(confirmBy.getTime() - 2 * HOUR)
    expect(reminderState(facts([early]), new Date(confirmBy.getTime() + HOUR))).toMatchObject({ due: false, nextAt: new Date(early.getTime() + 24 * HOUR) })
  })

  it('only a waiting order is reminded; the mail has no link', () => {
    expect([remindProblem('SENT'), remindProblem('DRAFT'), remindProblem('CHANGES_PROPOSED'), remindProblem('CONFIRMED')]).toEqual([
      null,
      'The order is not sent yet: send it.',
      "The supplier answered with changes: accept or refuse them; a reminder is for an order still waiting.",
      'The supplier answered this order already: it waits for no confirmation.',
    ])
    const mail = confirmationReminderMail({ language: 'en', number: 'PO-7 rev. 2', recipientName: 'Mario Rossi', sentOn: '2026-11-06', confirmBy, timeZone: 'Europe/Rome', message: null })
    expect(mail.subject).toBe('Reminder: please confirm purchase order PO-7 rev. 2')
    expect(mail.body).toMatch(/^Dear Mario Rossi,\n\na reminder of our purchase order PO-7 rev. 2, sent on 6 Nov 2026: we asked you to confirm it by 8 Nov 2026, 10:30\. The document is attached again\./)
    expect(mail.body).not.toMatch(/https?:|#token=/)
    expect(confirmationReminderMail({ language: 'it', number: 'PO-7', recipientName: null, sentOn: '2026-11-06', confirmBy, timeZone: 'Europe/Rome', message: 'Grazie.' }).body).toMatch(/^Buongiorno,\n\nle ricordiamo il nostro ordine di acquisto PO-7, inviato il 06\/11\/2026/)
  })
})

describe('expected deliveries', () => {
  it('the confirmed date, else the need date; late before today, this week to Sunday, later after', () => {
    expect(expectedDateOf({ confirmedDate: '2026-11-12', needDate: '2026-11-10' })).toBe('2026-11-12')
    expect(expectedDateOf({ confirmedDate: null, needDate: '2026-11-10' })).toBe('2026-11-10')
    expect([weekEndOf('2026-11-02'), weekEndOf('2026-11-07'), weekEndOf('2026-11-08')]).toEqual(['2026-11-08', '2026-11-08', '2026-11-08'])
    expect(['2026-11-03', '2026-11-04', '2026-11-08', '2026-11-09'].map((day) => deliveryStateOf(day, '2026-11-04'))).toEqual(['LATE', 'THIS_WEEK', 'THIS_WEEK', 'LATER'])
    expect([daysLate('2026-11-01', '2026-11-04'), daysLate('2026-11-05', '2026-11-04')]).toEqual([3, 0])
  })
})
