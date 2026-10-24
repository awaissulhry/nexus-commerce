import { describe, expect, it } from 'vitest'
import { absoluteTime, relativeTime } from './relativeTime'

const NOW = Date.parse('2026-10-23T12:00:00Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const MIN = 60_000, HOUR = 60 * MIN, DAY = 24 * HOUR

describe('relativeTime — "checked 2 min ago"', () => {
  it('no check, or an unreadable one', () => {
    expect(relativeTime(null, NOW)).toBe('never')
    expect(relativeTime('yesterday-ish', NOW)).toBe('—')
  })
  it('seconds, and a clock a little ahead, are "just now"', () => {
    expect(relativeTime(ago(10_000), NOW)).toBe('just now')
    expect(relativeTime(ago(-5_000), NOW)).toBe('just now')
  })
  it('minutes', () => {
    expect(relativeTime(ago(60_000), NOW)).toBe('1 min ago')
    expect(relativeTime(ago(2 * MIN), NOW)).toBe('2 min ago')
    expect(relativeTime(ago(44 * MIN), NOW)).toBe('44 min ago')
  })
  it('hours, then yesterday, then days', () => {
    expect(relativeTime(ago(50 * MIN), NOW)).toBe('1 h ago')
    expect(relativeTime(ago(5 * HOUR), NOW)).toBe('5 h ago')
    expect(relativeTime(ago(30 * HOUR), NOW)).toBe('yesterday')
    expect(relativeTime(ago(3 * DAY), NOW)).toBe('3 days ago')
  })
  it('a month or more is a date', () => {
    expect(relativeTime('2026-08-01T09:00:00Z', NOW)).toBe('1 Aug 2026')
  })
})

describe('absoluteTime — the hover title', () => {
  it('a date and a time, or nothing', () => {
    expect(absoluteTime('2026-10-23T09:05:00Z')).toMatch(/23 Oct 2026/)
    expect(absoluteTime(null)).toBeUndefined()
    expect(absoluteTime('nope')).toBeUndefined()
  })
})
