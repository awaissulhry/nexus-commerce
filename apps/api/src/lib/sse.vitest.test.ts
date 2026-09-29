import { describe, expect, it } from 'vitest'
import { sseResponseHeaders } from './sse.js'

describe('event-stream headers', () => {
  it('forbid proxies to transform the stream — the web\'s next start would gzip it and hold every event back', () => {
    expect(sseResponseHeaders(undefined)['Cache-Control']).toBe('no-cache, no-transform')
    expect(sseResponseHeaders(undefined)['Content-Type']).toBe('text/event-stream')
  })
})
