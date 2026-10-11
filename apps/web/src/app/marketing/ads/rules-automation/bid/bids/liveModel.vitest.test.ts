import { describe, expect, it } from 'vitest'
import { BACKOFF_AFTER_MS, BACKOFF_MS, cursorMoved, cursorOf, deliveryChip, FAST_MS, inFlight, inFlightSince, pollDelay, SLOW_MS } from './liveModel'

describe('how often the view asks whether anything moved', () => {
  it('every 5 s while a change is on its way, every 60 s otherwise, never in a hidden tab', () => {
    expect(pollDelay({ hidden: false, inFlight: true })).toBe(FAST_MS)
    expect(pollDelay({ hidden: false, inFlight: false })).toBe(SLOW_MS)
    expect(pollDelay({ hidden: true, inFlight: true })).toBeNull()
    expect([FAST_MS, SLOW_MS]).toEqual([5_000, 60_000])
  })

  it('a change on its way for more than 5 minutes: every 30 s instead of every 5 s (still never in a hidden tab)', () => {
    expect([BACKOFF_MS, BACKOFF_AFTER_MS]).toEqual([30_000, 300_000])
    expect(pollDelay({ hidden: false, inFlight: true, inFlightMs: 60_000 })).toBe(FAST_MS)
    expect(pollDelay({ hidden: false, inFlight: true, inFlightMs: BACKOFF_AFTER_MS })).toBe(FAST_MS)
    expect(pollDelay({ hidden: false, inFlight: true, inFlightMs: BACKOFF_AFTER_MS + 1 })).toBe(BACKOFF_MS)
    expect(pollDelay({ hidden: false, inFlight: false, inFlightMs: BACKOFF_AFTER_MS + 1 })).toBe(SLOW_MS)
    expect(pollDelay({ hidden: true, inFlight: true, inFlightMs: BACKOFF_AFTER_MS + 1 })).toBeNull()
  })

  it('since when a change is on its way: the oldest Queued / Sent row, or when the view first saw one', () => {
    const at = (iso: string) => Date.parse(iso)
    const rows = [
      { delivery: 'sent' as const, lastChange: { at: '2026-10-10T10:05:00Z' } },
      { delivery: 'waiting' as const, lastChange: { at: '2026-10-10T10:02:00Z' } },
      { delivery: 'live' as const, lastChange: { at: '2026-10-10T09:00:00Z' } },
    ]
    expect(inFlightSince(rows, null)).toBe(at('2026-10-10T10:02:00Z'))
    expect(inFlightSince(rows, at('2026-10-10T10:00:00Z'))).toBe(at('2026-10-10T10:00:00Z'))
    expect(inFlightSince([{ delivery: 'waiting' as const, lastChange: null }], null)).toBeNull()
    expect(inFlightSince([], at('2026-10-10T10:00:00Z'))).toBe(at('2026-10-10T10:00:00Z'))
  })

  it('a change is on its way: a row Queued or Sent, or the cursor\'s own counts', () => {
    expect(inFlight([{ delivery: 'live' }, { delivery: 'sent' }], null)).toBe(true)
    expect(inFlight([{ delivery: 'waiting' }], null)).toBe(true)
    expect(inFlight([{ delivery: 'live' }, { delivery: null }, {}], null)).toBe(false)
    expect(inFlight([], { latestChangeAt: null, waiting: 1, sent: 0 })).toBe(true)
  })

  it('reads the rows again only when the cursor moved; the first answer is the baseline', () => {
    const a = { latestChangeAt: '2026-10-10T10:00:00Z', waiting: 0, sent: 0 }
    expect(cursorMoved(null, a)).toBe(false)
    expect(cursorMoved(a, { ...a })).toBe(false)
    expect(cursorMoved(a, { ...a, latestChangeAt: '2026-10-10T10:01:00Z' })).toBe(true)
    expect(cursorMoved(a, { ...a, sent: 1 })).toBe(true)
  })

  it('reads the cursor, and knows an answer that is not one', () => {
    expect(cursorOf({ latestChangeAt: '2026-10-10T10:00:00Z', waiting: 2, sent: 1 })).toEqual({ latestChangeAt: '2026-10-10T10:00:00Z', waiting: 2, sent: 1 })
    expect(cursorOf({ latestChangeAt: null })).toEqual({ latestChangeAt: null, waiting: 0, sent: 0 })
    expect(cursorOf({ error: 'x' })).toBeNull()
    expect(cursorOf(null)).toBeNull()
  })
})

describe('the row\'s delivery chip', () => {
  const now = Date.parse('2026-10-10T12:00:00Z')
  it('shows Queued, Sent and Failed always; Live only just after it landed; nothing without a record', () => {
    expect(deliveryChip({ delivery: 'waiting' }, now)).toBe('waiting')
    expect(deliveryChip({ delivery: 'sent' }, now)).toBe('sent')
    expect(deliveryChip({ delivery: 'failed' }, now)).toBe('failed')
    expect(deliveryChip({ delivery: 'live', lastChange: { at: '2026-10-10T11:55:00Z' } }, now)).toBe('live')
    expect(deliveryChip({ delivery: 'live', lastChange: { at: '2026-10-09T11:55:00Z' } }, now)).toBeNull()
    expect(deliveryChip({ delivery: 'undone' }, now)).toBeNull()
    expect(deliveryChip({}, now)).toBeNull()
  })
})
