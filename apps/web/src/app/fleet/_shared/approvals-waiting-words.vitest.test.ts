import { describe, expect, it } from 'vitest'
import {
  APPROVALS_HREF,
  COUNT_NOT_READ,
  NOTHING_NEEDS_YOU,
  OPEN_APPROVALS,
  approvalsWaitingLine,
  approvalsWaitingText,
  readWaitingCounts,
} from './approvals-waiting-words'

describe('ApprovalsWaiting — the one line other pages show about approvals', () => {
  it('says how many need you and how many failed, in plain words', () => {
    expect(approvalsWaitingText({ needsYou: 8, failed: 1 })).toBe('8 requests need you · 1 failed')
    expect(approvalsWaitingText({ needsYou: 1, failed: 0 })).toBe('1 request needs you')
    expect(approvalsWaitingText({ needsYou: 3, failed: 0 })).toBe('3 requests need you')
    expect(approvalsWaitingText({ needsYou: 0, failed: 1 })).toBe('1 request failed')
    expect(approvalsWaitingText({ needsYou: 0, failed: 2 })).toBe('2 requests failed')
  })

  it('says nothing needs you only when both counts are 0', () => {
    expect(approvalsWaitingText({ needsYou: 0, failed: 0 })).toBe(NOTHING_NEEDS_YOU)
    expect(NOTHING_NEEDS_YOU).toBe('Nothing needs you right now.')
    expect(approvalsWaitingLine({ counts: { needsYou: 0, failed: 0 }, failed: false })).toEqual({ kind: 'clear', text: NOTHING_NEEDS_YOU })
    expect(approvalsWaitingLine({ counts: { needsYou: 0, failed: 1 }, failed: false }).kind).toBe('attention')
    expect(approvalsWaitingLine({ counts: { needsYou: 2, failed: 0 }, failed: false })).toEqual({ kind: 'attention', text: '2 requests need you' })
  })

  it('is loading until the first read, and says so when a read failed, even after a good one', () => {
    expect(approvalsWaitingLine({ counts: null, failed: false })).toEqual({ kind: 'loading' })
    expect(approvalsWaitingLine({ counts: null, failed: true })).toEqual({ kind: 'error', text: COUNT_NOT_READ })
    expect(approvalsWaitingLine({ counts: { needsYou: 0, failed: 0 }, failed: true })).toEqual({ kind: 'error', text: COUNT_NOT_READ })
    expect(COUNT_NOT_READ).toBe('Nexus could not read the approvals count.')
  })

  it('reads only a real counts answer', () => {
    expect(readWaitingCounts({ needsYou: 8, failed: 1, waiting: 7, backToYou: 1 })).toEqual({ needsYou: 8, failed: 1 })
    expect(readWaitingCounts({ error: 'Forbidden' })).toBeNull()
    expect(readWaitingCounts({ needsYou: 3 })).toBeNull()
    expect(readWaitingCounts({ needsYou: '3', failed: 0 })).toBeNull()
    expect(readWaitingCounts(null)).toBeNull()
  })

  it('links to the Approvals page, the only place a request is decided', () => {
    expect(APPROVALS_HREF).toBe('/fleet/approvals')
    expect(OPEN_APPROVALS).toBe('Open Approvals')
  })
})
