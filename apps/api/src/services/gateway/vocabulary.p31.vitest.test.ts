/**
 * P3.1 — the error vocabulary, one mapping table per connector.
 *
 * There was no test for this file at all. Two suites referenced
 * `classifyChannelAnswer` in passing; nothing asserted what any channel's error body
 * becomes.
 *
 * **Every fixture marked REAL below is a body taken verbatim from
 * `OutboundApiCallLog`** — this installation's own 469,455 stored calls. That matters
 * here more than usual, because three of the four defects this package fixed were
 * invisible to a hand-written fixture:
 *
 *   - **161 of the 201** stored failed bodies are DOUBLE-ENCODED (81 of 81 Amazon,
 *     80 of 120 eBay). One `JSON.parse` yields a string, every field read off it is
 *     `undefined`, and the error code was lost on every one.
 *   - eBay's OAuth endpoints answer `{error, error_description}` with no `errors[]`.
 *   - Amazon Ads sends `detail` and `details`; only the plural was read, and the
 *     singular is the commoner one.
 *
 * Fixtures marked SHAPE are from the vendor's documented envelope, because this
 * installation has never recorded a failure for that channel — Shopify, Etsy and
 * Amazon Ads have zero stored failed bodies. Said plainly rather than presented as
 * observed.
 */
import { describe, it, expect } from 'vitest'
import { classifyChannelAnswer, GATEWAY_ERROR_CLASSES, isRetryableClass } from './vocabulary.js'

/** A body encoded the way the channel really sent it: JSON inside a JSON string. */
const doubled = (json: string) => JSON.stringify(json)

describe('eBay', () => {
  it('REAL, double-encoded: keeps the error id and the sentence', () => {
    const body = doubled('{"errors":[{"errorId":62005,"domain":"API_TAXONOMY","category":"REQUEST","message":"The specified category ID does not belong to specified category tree.","parameters":[{"name":"category_id","value":"177104"},{"name":"queryParam","value":"category_id"}]}]}')
    const v = classifyChannelAnswer('EBAY', 400, body)
    expect(v.errorClass).toBe('validation')
    expect(v.channelCode).toBe('62005')
    expect(v.channelMessage).toContain('does not belong to specified category tree')
    // The FIRST parameter is the seller's field. The second is `queryParam`, which is
    // eBay describing its own envelope.
    expect(v.attribute).toBe('category_id')
    expect(v.retryable).toBe(false)
  })

  it('REAL: a plain errors[] on 401', () => {
    const v = classifyChannelAnswer('EBAY', 401, '{"errors": [{"errorId": 1001, "message": "Invalid access token"}]}')
    expect(v.errorClass).toBe('auth_expired')
    expect(v.channelCode).toBe('1001')
    expect(v.channelMessage).toBe('Invalid access token')
  })

  it('REAL: the OAuth shape, which has no errors[] at all', () => {
    const v = classifyChannelAnswer('EBAY', 400, doubled('{"error":"invalid_grant","error_description":"the provided authorization grant code is invalid or was issued to another client"}'))
    expect(v.errorClass).toBe('auth_revoked')
    expect(v.channelCode).toBe('invalid_grant')
    // The operator sees eBay's sentence, not an escaped JSON blob.
    expect(v.channelMessage).toContain('authorization grant code is invalid')
    expect(v.channelMessage).not.toContain('\\"')
  })

  it('REAL: a 500 is transient and retryable; a 400 is not', () => {
    const boom = classifyChannelAnswer('EBAY', 500, doubled('{"errors":[{"errorId":30500,"domain":"API_FULFILLMENT","category":"APPLICATION","message":"System error."}]}'))
    expect(boom.errorClass).toBe('transient')
    expect(boom.retryable).toBe(true)
    expect(boom.channelCode).toBe('30500')
  })

  it('SHAPE: Trading answers in XML inside an HTTP 200', () => {
    const xml = '<Errors><ErrorCode>931</ErrorCode><LongMessage>Auth token is invalid.</LongMessage></Errors><Ack>Failure</Ack>'
    const v = classifyChannelAnswer('EBAY', 200, xml)
    expect(v.errorClass).toBe('auth_revoked')
    expect(v.channelCode).toBe('931')
    expect(v.channelMessage).toBe('Auth token is invalid.')
  })
})

describe('Amazon SP-API', () => {
  it('REAL, double-encoded: a throttle with no errors[] envelope', () => {
    const v = classifyChannelAnswer('AMAZON_SP', 429, '"{\\n  \\"message\\": \\"Too Many Requests\\"\\n}\\n"')
    expect(v.errorClass).toBe('rate_limited')
    expect(v.retryable).toBe(true)
    // Three words, not an escaped blob.
    expect(v.channelMessage).toBe('Too Many Requests')
  })

  it('SHAPE: an errors[] entry naming the attribute it rejected', () => {
    const body = '{"errors":[{"code":"InvalidInput","message":"The value is not valid.","details":"bullet_point","attributeNames":["bullet_point"]}]}'
    const v = classifyChannelAnswer('AMAZON_SP', 400, body)
    expect(v.errorClass).toBe('validation')
    expect(v.channelCode).toBe('InvalidInput')
    // P3.2 cannot put an error on the right field without this.
    expect(v.attribute).toBe('bullet_point')
  })
})

describe('Amazon Ads', () => {
  it('REAL: `detail`, the singular Amazon mostly sends', () => {
    const v = classifyChannelAnswer('AMAZON_ADS', 400, '{"code":"400","detail":"configuration reportTypeId is unknown or invalid"}')
    expect(v.channelMessage).toBe('configuration reportTypeId is unknown or invalid')
  })

  it('REAL: `details`, the plural that already worked', () => {
    const v = classifyChannelAnswer('AMAZON_ADS', 400, '{"code":"400","details":"entityId provided is null"}')
    expect(v.channelMessage).toBe('entityId provided is null')
  })
})

describe('Shopify', () => {
  it('SHAPE: GraphQL errors arrive on an HTTP 200', () => {
    const body = '{"errors":[{"message":"Throttled","extensions":{"code":"THROTTLED"}}]}'
    const v = classifyChannelAnswer('SHOPIFY', 200, body)
    expect(v.errorClass).toBe('rate_limited')
    expect(v.channelCode).toBe('THROTTLED')
    expect(v.retryable).toBe(true)
  })

  it('SHAPE: a userError field path names the field, not the envelope', () => {
    const body = '{"errors":[{"message":"Title cannot be blank.","field":["input","title"]}]}'
    const v = classifyChannelAnswer('SHOPIFY', 200, body)
    // The LAST segment. `input` is Shopify's mutation wrapper, not the seller's field.
    expect(v.attribute).toBe('title')
  })
})

describe('Etsy', () => {
  it('SHAPE: a refused grant', () => {
    const v = classifyChannelAnswer('ETSY', 400, '{"error":"invalid_grant","error_description":"Refresh token is expired"}')
    expect(v.errorClass).toBe('auth_revoked')
    expect(v.channelMessage).toBe('Refresh token is expired')
  })
})

describe('the vocabulary itself', () => {
  it('gives every answer a severity, defaulting to error', () => {
    // A channel that accepts a change while complaining is not a failure, and reading
    // one as such sends an operator after a listing that published perfectly well.
    expect(classifyChannelAnswer('EBAY', 400, '{}').severity).toBe('error')
  })

  it('never reports a class outside the vocabulary', () => {
    const answers = [
      classifyChannelAnswer('EBAY', 418, 'teapot'),
      classifyChannelAnswer('SHOPIFY', 0, ''),
      classifyChannelAnswer('ETSY', 503, 'nope'),
      classifyChannelAnswer('AMAZON_SP', 200, 'not json at all'),
    ]
    for (const a of answers) expect(GATEWAY_ERROR_CLASSES).toContain(a.errorClass)
  })

  it('agrees with itself about what is retryable', () => {
    // `retryable` is derived, and a verdict whose flag disagreed with its own class
    // would send a permanent failure round the retry loop for ever.
    for (const answer of [
      classifyChannelAnswer('EBAY', 500, '{}'),
      classifyChannelAnswer('EBAY', 400, '{}'),
      classifyChannelAnswer('AMAZON_SP', 429, '{}'),
    ]) {
      expect(answer.retryable).toBe(isRetryableClass(answer.errorClass))
    }
  })

  it('does not invent an attribute when the channel named none', () => {
    expect(classifyChannelAnswer('EBAY', 401, '{"errors":[{"errorId":1001,"message":"Invalid access token"}]}').attribute).toBeNull()
    expect(classifyChannelAnswer('AMAZON_ADS', 400, '{"code":"400","detail":"nope"}').attribute).toBeNull()
  })
})
