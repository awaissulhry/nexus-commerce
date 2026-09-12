/**
 * PES.5 — classifying why a sync row failed.
 *
 * The bug this prevents: 368 rows refused because publishing is switched OFF sit
 * in `dead` beside genuine marketplace rejections. They demand opposite
 * responses from an operator, and `errorCode` cannot tell them apart — 2,490
 * failed rows share `MAX_RETRIES_EXCEEDED`.
 *
 * Every message below is a REAL one from the production queue, quoted, not
 * invented — a classifier tested against messages I wrote myself would only
 * prove my regexes match my own examples.
 */
import { describe, it, expect } from 'vitest'
import { deriveFailureReason } from './sync-failure-reason.js'

const reasonOf = (msg: string | null, code: string | null = 'MAX_RETRIES_EXCEEDED') =>
  deriveFailureReason(code, msg).reason

describe('gated — a flag deliberately off is not a failure', () => {
  it('classifies the real Amazon message (356 rows)', () => {
    expect(reasonOf('NEXUS_ENABLE_AMAZON_PUBLISH=false — set true to enable Amazon outbound sync.')).toBe('gated')
  })
  it('classifies the real eBay message (12 rows)', () => {
    expect(reasonOf('NEXUS_ENABLE_EBAY_PUBLISH=false — set true to enable eBay outbound sync.')).toBe('gated')
  })
  it('is NOT actionable — there is nothing for an operator to fix', () => {
    expect(deriveFailureReason(null, 'NEXUS_ENABLE_AMAZON_PUBLISH=false').actionable).toBe(false)
  })
})

describe('throttled — deferred by us, retries itself', () => {
  it('circuit breaker', () => {
    // Note this message contains "publish" and a number; it must NOT be read as
    // gated or as a marketplace rejection.
    expect(reasonOf('eBay publish circuit open after 3 consecutive failures. Retry in 593s.')).toBe('throttled')
  })
  it('debounce', () => {
    expect(reasonOf('debounced: last revise 10s ago (< 15s min interval)')).toBe('throttled')
  })
})

describe('rejected — the marketplace refused it', () => {
  it('an eBay validation failure with an HTTP code', () => {
    expect(reasonOf('bulk_update_price_quantity 400: {"responses":[{"statusCode":400,"sku":"AIR-MESH-')).toBe('rejected')
  })
  it('a non-English marketplace message (an ended listing)', () => {
    // Italian. A classifier that only matched English would call this unknown.
    expect(reasonOf('eBay ReviseInventoryStatus Failure: Non puoi modificare un\'inserzione scaduta "2')).toBe('rejected')
  })
  it('is the one reason that IS actionable', () => {
    expect(deriveFailureReason(null, 'validation failed').actionable).toBe(true)
  })
})

describe('internal — we abandoned it', () => {
  it('a stale in-progress intent', () => {
    expect(reasonOf('ads-drain: crashed mid-dispatch and the intent is now stale — not re-applied')).toBe('internal')
  })
})

describe('the two cases found by classifying the whole table', () => {
  it('OUR OWN safety refusal is internal, not a marketplace rejection', () => {
    // 5 real rows. The marketplace was never asked — reporting these as
    // "rejected" sends an operator to Seller Central to investigate nothing.
    // The message contains "200", so the HTTP-code rule would claim it if the
    // internal rule did not run first.
    const msg = 'inventory_item GET 200 — refusing content PUT built from an empty read (would wipe the listing)'
    expect(reasonOf(msg)).toBe('internal')
    expect(deriveFailureReason(null, msg).actionable).toBe(false)
  })

  it('a channel refusal with no HTTP code and no English is still rejected', () => {
    // 1 real row, Italian: "SKU does not exist in the listing". It was landing
    // in `unknown` purely for lacking a 3-digit code and an English keyword.
    expect(reasonOf("eBay ReviseInventoryStatus Failure: SKU non esiste nell'inserzione Non-ManageB")).toBe('rejected')
  })
})

describe('unknown never masquerades as something else', () => {
  it('an unrecognised message is unknown, not rejected', () => {
    // Defaulting to `rejected` would invent a marketplace refusal that may
    // never have happened.
    expect(reasonOf('something nobody has seen before')).toBe('unknown')
  })
  it('no message at all is unknown', () => {
    expect(reasonOf(null)).toBe('unknown')
    expect(deriveFailureReason(null, null).summary).toMatch(/no recorded reason/)
  })
})

describe('a DEAD row cannot retry, whatever the cause', () => {
  // The bug this pins, found by PES.3 consuming the classifier: ALL 399
  // throttled rows are isDead=true, 3/3 retries, nextRetryAt=null. Grading them
  // "it will retry without you" told an operator that 399 writes which never
  // reached the channel were fine — the exact failure class this classifier
  // exists to remove, one level down.
  const DEBOUNCE = 'debounced: last revise 10s ago (< 15s min interval)'

  it('throttled + STILL RUNNABLE needs nobody', () => {
    const d = deriveFailureReason(null, DEBOUNCE, { isDead: false })
    expect(d.actionable).toBe(false)
    expect(d.willRetry).toBe(true)
  })

  it('throttled + DEAD is actionable — the write never landed', () => {
    const d = deriveFailureReason('MAX_RETRIES_EXCEEDED', DEBOUNCE, { isDead: true })
    expect(d.reason).toBe('throttled')
    expect(d.actionable).toBe(true)
    expect(d.willRetry).toBe(false)
    expect(d.summary).toMatch(/never reached the channel/)
  })

  it('internal + DEAD is actionable too', () => {
    const d = deriveFailureReason(null, 'crashed mid-dispatch and the intent is now stale', { isDead: true })
    expect(d.actionable).toBe(true)
    expect(d.willRetry).toBe(false)
  })

  it('gated + DEAD stays NOT actionable — nothing is broken', () => {
    // But it must say the row will not resend itself when the flag is turned
    // back on, which is the difference between "paused" and "lost".
    const d = deriveFailureReason(null, 'NEXUS_ENABLE_AMAZON_PUBLISH=false', { isDead: true })
    expect(d.actionable).toBe(false)
    expect(d.willRetry).toBe(false)
    expect(d.summary).toMatch(/will not resend/)
  })

  it('rejected is actionable either way — the channel already refused it', () => {
    for (const isDead of [true, false]) {
      expect(deriveFailureReason(null, 'bulk_update 400: rejected', { isDead }).actionable).toBe(true)
    }
  })

  it('omitting the option keeps the old, retry-optimistic reading', () => {
    // Callers that do not know deadness must not silently get the dead verdict.
    expect(deriveFailureReason(null, DEBOUNCE).actionable).toBe(false)
    expect(deriveFailureReason(null, DEBOUNCE).willRetry).toBe(true)
  })
})

describe('errorCode does not drive the answer', () => {
  it('the same code yields different reasons — which is the whole point', () => {
    const code = 'MAX_RETRIES_EXCEEDED'
    expect(reasonOf('NEXUS_ENABLE_AMAZON_PUBLISH=false', code)).toBe('gated')
    expect(reasonOf('bulk_update 400: rejected', code)).toBe('rejected')
  })
  it('a null code changes nothing', () => {
    expect(reasonOf('NEXUS_ENABLE_AMAZON_PUBLISH=false', null)).toBe('gated')
  })
})
