import { describe, expect, it } from 'vitest'
import { appointmentIcs, foldLine, icsText, icsTime } from './ics'
import {
  alterationWords,
  appointmentMail,
  appointmentProblems,
  bookedRefusal,
  closeRefusal,
  nextStepOf,
  overlaps,
  pointChangesOf,
  reminderDue,
  remakeOutcomeProblem,
  remakeProfileProblem,
  verdictProblems,
  whenWords,
} from './rules'

// Every time is fixed here (no test depends on today's date).
const NOW = new Date('2026-06-10T08:00:00.000Z')
const at = (hours: number) => new Date(NOW.getTime() + hours * 3_600_000)
const draft = { kind: 'FITTING' as const, startsAt: at(48), endsAt: at(49), place: 'Made-up showroom', riderName: null, withName: null, notes: null, hasProfile: true }
const paths = (issues: { path: string }[]) => issues.map((issue) => issue.path)

describe('appointments (SAL-054)', () => {
  it('is booked ahead, ends after it starts within 24 hours, where in one line, a fitting of a profile revision', () => {
    expect(appointmentProblems(draft, NOW)).toEqual([])
    expect(paths(appointmentProblems({ ...draft, startsAt: at(-1), endsAt: at(1) }, NOW))).toEqual(['body/startsAt'])
    // A move that keeps the times does not ask the start again.
    expect(appointmentProblems({ ...draft, startsAt: at(-1), endsAt: at(1) }, NOW, false)).toEqual([])
    expect(paths(appointmentProblems({ ...draft, endsAt: draft.startsAt }, NOW))).toEqual(['body/endsAt'])
    expect(paths(appointmentProblems({ ...draft, endsAt: at(48 + 25) }, NOW))).toEqual(['body/endsAt'])
    expect(paths(appointmentProblems({ ...draft, place: 'Show\nroom', withName: ' ', riderName: 'x'.repeat(201) }, NOW))).toEqual(['body/place', 'body/riderName', 'body/withName'])
    expect(paths(appointmentProblems({ ...draft, hasProfile: false }, NOW))).toEqual(['body/measurementProfileId'])
    expect(appointmentProblems({ ...draft, kind: 'MEASURING', hasProfile: false }, NOW)).toEqual([])
  })

  it('closes once: done or missed once started, done says who was there; booked actions only while booked', () => {
    const booked = { status: 'BOOKED' as const, kind: 'FITTING' as const, startsAt: at(-2) }
    const someone = { withUserId: null, withName: 'Made-up dealer fitter' }
    expect(closeRefusal(booked, 'DONE', NOW, NOW, someone)).toBeNull()
    expect(closeRefusal(booked, 'DONE', NOW, NOW, { withUserId: null, withName: null })).toContain('Say who was there')
    expect(closeRefusal(booked, 'MISSED', NOW, NOW, { withUserId: null, withName: null })).toBeNull()
    expect(closeRefusal({ ...booked, startsAt: at(2) }, 'MISSED', NOW, NOW, someone)).toContain('has not started yet')
    expect(closeRefusal(booked, 'DONE', at(1), NOW, someone)).toContain('not in the future')
    expect(closeRefusal({ ...booked, status: 'CANCELLED' }, 'DONE', NOW, NOW, someone)).toContain('closes once')
    expect(bookedRefusal('BOOKED', 'moved')).toBeNull()
    expect(bookedRefusal('DONE', 'moved')).toBe('This appointment is done: it is no longer moved (only its notes change; book a new one).')
  })

  it('reminds once, a day before, only when it was booked (or invited) earlier than that', () => {
    const row = { status: 'BOOKED' as const, startsAt: at(20), inviteSentAt: at(-72), reminderSentAt: null, createdAt: at(-72) }
    expect(reminderDue(row, NOW)).toBe(true)
    expect(reminderDue({ ...row, startsAt: at(30) }, NOW)).toBe(false)
    expect(reminderDue({ ...row, reminderSentAt: at(-1) }, NOW)).toBe(false)
    expect(reminderDue({ ...row, inviteSentAt: at(-2) }, NOW)).toBe(false)
    expect(reminderDue({ ...row, inviteSentAt: null, createdAt: at(-2) }, NOW)).toBe(false)
    expect(reminderDue({ ...row, startsAt: at(-1) }, NOW)).toBe(false)
    expect(reminderDue({ ...row, status: 'CANCELLED' }, NOW)).toBe(false)
    expect(overlaps({ startsAt: at(1), endsAt: at(2) }, { startsAt: at(1.5), endsAt: at(3) })).toBe(true)
    expect(overlaps({ startsAt: at(1), endsAt: at(2) }, { startsAt: at(2), endsAt: at(3) })).toBe(false)
  })

  it('writes the rider’s mails in the business time zone, never the reason of a cancellation', () => {
    const facts = { kind: 'FITTING' as const, riderName: 'Made-up rider', startsAt: new Date('2026-12-02T09:00:00.000Z'), endsAt: new Date('2026-12-02T10:00:00.000Z'), place: 'Made-up showroom', withWho: 'Made-up fitter', garment: 'Jacket' }
    expect(whenWords(facts.startsAt, facts.endsAt, 'en')).toBe('Wednesday 2 December 2026, 10:00–11:00')
    expect(whenWords(facts.startsAt, facts.endsAt, 'it')).toBe('mercoledì 2 dicembre 2026, 10:00–11:00')
    const invite = appointmentMail('INVITE', 'en', facts)
    expect(invite.subject).toBe('Appointment: fitting Wednesday 2 December 2026, 10:00–11:00')
    expect(invite.body).toContain('Where: Made-up showroom\nWith: Made-up fitter')
    expect(appointmentMail('REMINDER', 'it', facts).body).toContain('vi ricordiamo la prova (Jacket)')
    expect(appointmentMail('CANCEL', 'en', facts).body).toContain('is cancelled')
  })
})

describe('the calendar invite (.ics)', () => {
  it('is one VEVENT with the appointment’s UID and sequence, escaped, folded at 75 octets, CRLF', () => {
    const ics = appointmentIcs({
      method: 'REQUEST',
      appointmentId: '00000000-0000-4000-8000-000000000001',
      domain: 'example.test',
      sequence: 3,
      stamp: NOW,
      startsAt: new Date('2026-12-02T09:00:00.000Z'),
      endsAt: new Date('2026-12-02T10:00:00.000Z'),
      summary: 'Fitting, jacket; made-up',
      location: 'Made-up showroom',
      description: `Line one\nline two ${'è'.repeat(60)}`,
      organizer: { name: 'Made-up "fitter"', email: 'fitter@example.test' },
      attendee: { name: null, email: 'rider@example.test' },
    })
    expect(ics).toContain('UID:appointment-00000000-0000-4000-8000-000000000001@example.test\r\nSEQUENCE:3\r\n')
    expect(ics).toContain('DTSTART:20261202T090000Z\r\nDTEND:20261202T100000Z\r\n')
    expect(ics).toContain('SUMMARY:Fitting\\, jacket\\; made-up\r\n')
    expect(ics).toContain('ORGANIZER;CN="Made-up fitter":mailto:fitter@example.test')
    expect(ics).toContain('METHOD:REQUEST')
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true)
    for (const line of ics.split('\r\n')) expect(Buffer.byteLength(line, 'utf8')).toBeLessThanOrEqual(75)
    expect(appointmentIcs({ method: 'CANCEL', appointmentId: 'a', domain: 'd', sequence: 4, stamp: NOW, startsAt: NOW, endsAt: at(1), summary: 's', location: 'l', description: 'd', organizer: { name: null, email: 'o@example.test' }, attendee: { name: null, email: 'r@example.test' } })).toContain('STATUS:CANCELLED')
    expect(icsText('a\\b,c;d\ne')).toBe('a\\\\b\\,c\\;d\\ne')
    expect(icsTime(new Date('2026-01-05T07:08:09.000Z'))).toBe('20260105T070809Z')
    expect(foldLine('x'.repeat(80))).toBe(`${'x'.repeat(75)}\r\n ${'x'.repeat(5)}`)
  })
})

describe('a fitting’s result (SAL-297)', () => {
  const measured = { chest: { value: '100', unit: 'cm' }, sleeve: { value: '640', unit: 'mm' } }

  it('checks each point change against the revision’s measures and keeps it signed in the point’s unit', () => {
    const ok = pointChangesOf({ chest: { change: '2.0' }, sleeve: { change: '-10', unit: 'mm', note: 'Shorter' } }, measured)
    expect(ok.problems).toEqual([])
    expect(ok.changes).toEqual({ chest: { change: '+2.0', unit: 'cm' }, sleeve: { change: '-10', unit: 'mm', note: 'Shorter' } })
    const bad = pointChangesOf({ chest: { change: '0' }, sleeve: { change: '+1', unit: 'cm' }, waist: { change: '+1' }, 'bad code': { change: '+1' } }, measured)
    expect(paths(bad.problems)).toEqual(['body/pointChanges/chest/change', 'body/pointChanges/sleeve/unit', 'body/pointChanges/waist', 'body/pointChanges/bad code'])
    expect(paths(pointChangesOf({ chest: { change: '+12345' } }, measured).problems)).toEqual(['body/pointChanges/chest/change'])
    expect(paths(pointChangesOf({ chest: { change: '+1', note: 'two\nlines' } }, measured).problems)).toEqual(['body/pointChanges/chest/note'])
  })

  it('holds each verdict to its rules', () => {
    expect(verdictProblems({ verdict: 'OK', points: 0, notes: null, alterationDays: null })).toEqual([])
    expect(paths(verdictProblems({ verdict: 'OK', points: 1, notes: null, alterationDays: 3 }))).toEqual(['body/pointChanges', 'body/alterationDays'])
    expect(paths(verdictProblems({ verdict: 'ALTER', points: 0, notes: null, alterationDays: null }))).toEqual(['body/pointChanges'])
    expect(verdictProblems({ verdict: 'ALTER', points: 0, notes: 'Take in the waist.', alterationDays: 5 })).toEqual([])
    expect(paths(verdictProblems({ verdict: 'ALTER', points: 2, notes: null, alterationDays: 400 }))).toEqual(['body/alterationDays'])
    expect(paths(verdictProblems({ verdict: 'REMAKE', points: 0, notes: null, alterationDays: null }))).toEqual(['body/notes'])
  })

  it('says the alteration’s work in words and what comes next', () => {
    expect(alterationWords({ chest: { change: '+2.0', unit: 'cm' }, sleeve: { change: '-10', unit: 'mm', note: 'Shorter' } }, { chest: 'Chest' }, 'Check the collar.')).toBe('Chest +2.0 cm; sleeve -10 mm (Shorter). Check the collar.')
    expect(alterationWords({}, {}, null)).toBe('Alteration after the fitting.')
    expect(nextStepOf({ verdict: 'OK', alterationRepairId: null, newProfileId: null, salesOrderLineId: null })).toBeNull()
    expect(nextStepOf({ verdict: 'ALTER', alterationRepairId: null, newProfileId: null, salesOrderLineId: null })).toContain('Open the alteration')
    expect(nextStepOf({ verdict: 'REMAKE', alterationRepairId: null, newProfileId: null, salesOrderLineId: null })).toContain('Measure the rider again')
  })
})

describe('a remake (SAL-353)', () => {
  const madeTo = { id: 'r2', revision: 2, partyId: 'p', riderName: 'Made-up rider', garmentType: 'JACKET' }
  it('scraps or quarantines the goods; is made to the revision it was made to or the newest', () => {
    expect(remakeOutcomeProblem('SCRAP')).toBeNull()
    expect(remakeOutcomeProblem('QUARANTINE')).toBeNull()
    expect(remakeOutcomeProblem('RESTOCK')).toContain('never put back into stock')
    expect(remakeProfileProblem(madeTo, madeTo, 4)).toBeNull()
    expect(remakeProfileProblem(madeTo, { ...madeTo, id: 'r4', revision: 4 }, 4)).toBeNull()
    expect(remakeProfileProblem(madeTo, { ...madeTo, id: 'r3', revision: 3 }, 4)).toContain('is not the newest (revision 4 is)')
    expect(remakeProfileProblem(madeTo, { ...madeTo, id: 'x', revision: 5, riderName: 'Another' }, 5)).toContain("Made-up rider's JACKET measures")
  })
})
