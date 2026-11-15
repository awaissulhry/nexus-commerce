import { describe, expect, it } from 'vitest'
import { bulkRefusal, changesRecord, cleanLabel, cleanNote, databaseReminderRefusal, inView, noteProblems, stateOf, whenProblems } from './rules'
import { events } from './events'

const NOW = new Date('2026-11-13T08:30:00.000Z')

describe('reminders (B-W2b-388; COL-041)', () => {
  it('a reminder waits, comes back, is done', () => {
    expect(stateOf({ cameBackAt: null, doneAt: null })).toBe('WAITING')
    expect(stateOf({ cameBackAt: NOW, doneAt: null })).toBe('CAME_BACK')
    expect(stateOf({ cameBackAt: NOW, doneAt: NOW })).toBe('DONE')
    expect(stateOf({ cameBackAt: null, doneAt: NOW })).toBe('DONE')
    expect(inView({ cameBackAt: NOW, doneAt: null }, 'OPEN')).toBe(true)
    expect(inView({ cameBackAt: null, doneAt: null }, 'OPEN')).toBe(true)
    expect(inView({ cameBackAt: null, doneAt: NOW }, 'OPEN')).toBe(false)
    expect(inView({ cameBackAt: NOW, doneAt: null }, 'WAITING')).toBe(false)
  })

  it('comes back at a moment after now and within a year, or when the record changes (no moment)', () => {
    expect(whenProblems({ kind: 'AT_TIME', remindAt: '2026-11-13T15:00:00.000Z' }, NOW)).toEqual([])
    expect(whenProblems({ kind: 'AT_TIME', remindAt: '2026-11-13T08:00:00.000Z' }, NOW)).toEqual([{ path: 'body/remindAt', message: 'Choose a moment after now.' }])
    expect(whenProblems({ kind: 'AT_TIME', remindAt: '2027-12-01T08:00:00.000Z' }, NOW)[0]?.path).toBe('body/remindAt')
    expect(whenProblems({ kind: 'AT_TIME', remindAt: null }, NOW)).toEqual([{ path: 'body/remindAt', message: 'Choose when it comes back.' }])
    expect(whenProblems({ kind: 'AT_TIME', remindAt: 'tomorrow' }, NOW)).toEqual([{ path: 'body/remindAt', message: 'Not a moment.' }])
    expect(whenProblems({ kind: 'ON_CHANGE' }, NOW)).toEqual([])
    expect(whenProblems({ kind: 'ON_CHANGE', remindAt: '2026-11-14T08:00:00.000Z' }, NOW)[0]?.path).toBe('body/remindAt')
  })

  it('keeps the note and the label as the database holds them', () => {
    expect(cleanNote('  Supplier   promised\r\na date  ')).toBe('Supplier promised\na date')
    expect(cleanNote('   ')).toBeNull()
    expect(cleanNote(undefined)).toBeNull()
    expect(noteProblems('x'.repeat(501))).toEqual([{ path: 'body/note', message: 'At most 500 characters.' }])
    expect(noteProblems('x'.repeat(500))).toEqual([])
    expect(cleanLabel(' PO-2026-0031\n')).toBe('PO-2026-0031')
    expect(cleanLabel('y'.repeat(260))).toHaveLength(200)
  })

  it('a done reminder refuses Done N; Remove N takes it', () => {
    expect(bulkRefusal({ cameBackAt: null, doneAt: NOW }, 'DONE')).toBe('DONE')
    expect(bulkRefusal({ cameBackAt: null, doneAt: NOW }, 'REMOVE')).toBeNull()
    expect(bulkRefusal({ cameBackAt: NOW, doneAt: null }, 'DONE')).toBeNull()
  })

  it('a record changed for a reminder: someone else, and never a read', () => {
    const me = 'me'
    expect(changesRecord({ actorId: 'other', action: 'threads.post' }, me)).toBe(true)
    expect(changesRecord({ actorId: me, action: 'threads.post' }, me)).toBe(false)
    expect(changesRecord({ actorId: 'other', action: 'download' }, me)).toBe(false)
    expect(changesRecord({ actorId: 'other', action: 'mtm.worksheetOpened' }, me)).toBe(false)
    expect(changesRecord({ actorId: 'other', action: 'links.downloadFile' }, me)).toBe(false)
    expect(changesRecord({ actorId: 'other', action: 'orders.markReady' }, me)).toBe(true)
  })

  it('says the database refusals of a reminder in words, and leaves other refusals alone', () => {
    expect(databaseReminderRefusal('tasks: reminder 0190 is done; it changes no more (Undo clears done first)')).toEqual({ path: 'reminder/DONE', message: 'This reminder is done: undo it first.' })
    expect(databaseReminderRefusal('tasks: the message of reminder 0190 is of the thread of its record (PO-1), not of Quote')?.path).toBe('body/messageId')
    expect(databaseReminderRefusal('tasks: reminder 0190 reminds an office person')?.path).toBe('reminder/OFFICE_PERSON')
    expect(databaseReminderRefusal('tasks: reminder 0190 gets a new time or kind only when it is put off (its since moves on)')?.path).toBe('reminder/SHAPE')
    expect(databaseReminderRefusal('tasks: the moment reminder 0190 watches from never goes back')?.path).toBe('reminder/SHAPE')
    expect(databaseReminderRefusal('tasks: task 0190 is closed')).toBeNull()
    expect(databaseReminderRefusal('notifications: only e-mail has a daily digest')).toBeNull()
  })

  it('declares its three events, each live with the reminder and its record only (never the person)', () => {
    expect(events.map((event) => event.type)).toEqual(['reminder.set', 'reminder.came_back', 'reminder.changed'])
    for (const event of events) expect(event.live?.fields).toEqual(['reminderId', 'recordType', 'recordId'])
  })
})
