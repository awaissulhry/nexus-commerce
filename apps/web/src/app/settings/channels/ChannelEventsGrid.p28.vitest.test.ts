/**
 * P2.8 — an inbound event's status, as the Ingress tab reads it.
 *
 * Before P2.1 there were two facts on a row — `isProcessed` and an error string — and
 * the grid rendered three states from them. The lifecycle has four, and the pair the
 * boolean cannot separate is exactly the pair that matters: a DEAD LETTER, which has
 * run out of attempts and is waiting for a person, versus a failure that will be tried
 * again in four minutes.
 */
import { describe, it, expect } from 'vitest'
import { inboundStatusOf, type InboundRow } from './ChannelEventsGrid'

const row = (over: Partial<InboundRow>): InboundRow => ({
  id: 'e1', eventType: 'order/create', externalId: 'd-1',
  isProcessed: false, processedAt: null, error: null, createdAt: '2026-09-20T10:00:00Z',
  ...over,
})

describe('reading the status of a row', () => {
  it('prefers the lifecycle when the row carries one', () => {
    expect(inboundStatusOf(row({ status: 'dlq' }))).toBe('dlq')
    expect(inboundStatusOf(row({ status: 'failed' }))).toBe('failed')
    expect(inboundStatusOf(row({ status: 'pending' }))).toBe('pending')
    expect(inboundStatusOf(row({ status: 'done' }))).toBe('done')
  })

  it('tells a dead letter from a retry — which the old boolean could not', () => {
    // Both of these were "failed" before: same colour, same word, opposite meaning.
    const dead = row({ status: 'dlq', error: 'shopify said no', isProcessed: false })
    const willRetry = row({ status: 'failed', error: 'shopify said no', isProcessed: false })
    expect(inboundStatusOf(dead)).not.toBe(inboundStatusOf(willRetry))
  })

  it('does not contradict the lifecycle when the old boolean disagrees', () => {
    // `isProcessed` and `status` are written together, but a row that predates P2.1 or
    // a partial write could disagree. The lifecycle is the one the worker acts on, so
    // it is the one the screen shows.
    expect(inboundStatusOf(row({ status: 'dlq', isProcessed: true }))).toBe('dlq')
  })

  it('still reads a row from before the lifecycle existed', () => {
    // 5,158 rows predate CX.4a. They render rather than showing nothing.
    expect(inboundStatusOf(row({ isProcessed: true }))).toBe('done')
    expect(inboundStatusOf(row({ isProcessed: false }))).toBe('pending')
    expect(inboundStatusOf(row({ isProcessed: false, error: 'boom' }))).toBe('failed')
  })
})
