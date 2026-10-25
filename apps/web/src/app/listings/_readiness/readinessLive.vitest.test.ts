import { describe, expect, it } from 'vitest'
import { mayRefreshAgain, RETURN_DEDUPE_MS } from './readinessLive'

describe('coming back to the tab is one read (2026-10-25)', () => {
  it('focus and visibilitychange fire together: the second one waits', () => {
    expect(mayRefreshAgain(null, 1_000)).toBe(true)
    expect(mayRefreshAgain(1_000, 1_000)).toBe(false)
    expect(mayRefreshAgain(1_000, 1_000 + RETURN_DEDUPE_MS - 1)).toBe(false)
  })
  it('the 30-second re-read and a later return still read', () => {
    expect(mayRefreshAgain(1_000, 1_000 + RETURN_DEDUPE_MS)).toBe(true)
    expect(mayRefreshAgain(1_000, 31_000)).toBe(true)
  })
})
