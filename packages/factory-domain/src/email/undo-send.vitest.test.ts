import { describe, expect, it } from 'vitest'
import { isDue, sendAfterOf, UNDO_REFUSALS, UNDO_SEND_CAP_MS, UNDO_SEND_MS, UNDO_WORDS, undoRefusal, undoUntilOf, waitMsOf } from './undo-send'

// B-TH-048 (threads plan TH-3, thread-G08, Owner decision 6): a thread mail waits 10 seconds and can be taken back meanwhile.
const queuedAt = new Date('2026-11-17T09:00:00.000Z')
const sendAfter = sendAfterOf(queuedAt)
const at = (ms: number) => new Date(queuedAt.getTime() + ms)
const SENDER = '0190a000-0000-7000-8000-0000000000a1'
const OTHER = '0190a000-0000-7000-8000-0000000000b2'
const waiting = { status: 'QUEUED' as const, attempts: 0, sendAfter, createdById: SENDER }

describe('undo send', () => {
  it('waits ten seconds from the queueing, within the database cap of a minute', () => {
    expect(UNDO_SEND_MS).toBe(10_000)
    expect(UNDO_SEND_MS).toBeLessThanOrEqual(UNDO_SEND_CAP_MS)
    expect(sendAfter.toISOString()).toBe('2026-11-17T09:00:10.000Z')
  })

  it('offers Undo until sendAfter, only while the mail is QUEUED and never claimed', () => {
    expect(undoUntilOf(waiting, at(0))).toEqual(sendAfter)
    expect(undoUntilOf(waiting, at(9_999))).toEqual(sendAfter)
    expect(undoUntilOf(waiting, at(10_000))).toBeNull()
    expect(undoUntilOf({ ...waiting, attempts: 1 }, at(1_000))).toBeNull()
    expect(undoUntilOf({ ...waiting, status: 'SENDING' }, at(1_000))).toBeNull()
    expect(undoUntilOf({ ...waiting, sendAfter: null }, at(0))).toBeNull()
  })

  it('is due at sendAfter (a mail without a window at once); the worker waits the rest, never more than the cap', () => {
    expect(isDue(waiting, at(9_999))).toBe(false)
    expect(isDue(waiting, at(10_000))).toBe(true)
    expect(isDue({ sendAfter: null }, at(0))).toBe(true)
    expect(waitMsOf(waiting, at(4_000))).toBe(6_000)
    expect(waitMsOf(waiting, at(12_000))).toBe(0)
    expect(waitMsOf({ sendAfter: null }, at(0))).toBe(0)
    expect(waitMsOf({ sendAfter: at(10 * 60_000) }, at(0))).toBe(UNDO_SEND_CAP_MS)
  })

  it('lets only the sender take it back, in its window; a mail taken back is taken back again without a change', () => {
    expect(undoRefusal(waiting, SENDER, at(3_000))).toBeNull()
    expect(undoRefusal(waiting, OTHER, at(3_000))).toBe('NOT_YOURS')
    expect(undoRefusal(waiting, SENDER, at(10_000))).toBe('LEFT')
    expect(undoRefusal({ ...waiting, attempts: 1 }, SENDER, at(3_000))).toBe('LEFT')
    expect(undoRefusal({ ...waiting, status: 'SENT', attempts: 1 }, SENDER, at(3_000))).toBe('LEFT')
    expect(undoRefusal({ ...waiting, status: 'FAILED' }, SENDER, at(3_000))).toBe('NOT_SENT')
    expect(undoRefusal({ ...waiting, sendAfter: null }, SENDER, at(0))).toBe('NO_WINDOW')
    expect(undoRefusal({ ...waiting, status: 'WITHDRAWN' }, SENDER, at(30_000))).toBeNull()
    expect(undoRefusal({ ...waiting, status: 'WITHDRAWN' }, OTHER, at(3_000))).toBe('NOT_YOURS')
  })

  it('says every refusal and both states in Italian and English', () => {
    for (const words of [...Object.values(UNDO_REFUSALS), ...Object.values(UNDO_WORDS)]) {
      expect(words.it.trim().length).toBeGreaterThan(3)
      expect(words.en.trim().length).toBeGreaterThan(3)
      expect(words.it).not.toBe(words.en)
    }
    expect(UNDO_WORDS.SENDING.en).toBe('Sending…')
    expect(UNDO_WORDS.WITHDRAWN.en).toBe('Taken back')
  })
})
