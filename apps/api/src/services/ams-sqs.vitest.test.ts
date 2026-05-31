import { describe, it, expect } from 'vitest'
import { parseAmsBody, sqsUrlFromArn } from './ams-sqs.service.js'

describe('sqsUrlFromArn', () => {
  it('derives the HTTPS queue URL from an SQS ARN', () => {
    expect(sqsUrlFromArn('arn:aws:sqs:eu-west-1:123456789012:nexus-ams')).toBe('https://sqs.eu-west-1.amazonaws.com/123456789012/nexus-ams')
  })
  it('returns null for a non-SQS ARN (e.g. Firehose)', () => {
    expect(sqsUrlFromArn('arn:aws:firehose:eu-west-1:123456789012:deliverystream/nexus-ams')).toBeNull()
  })
  it('returns null for garbage', () => {
    expect(sqsUrlFromArn('not-an-arn')).toBeNull()
  })
})

describe('parseAmsBody', () => {
  it('parses a raw single AMS record', () => {
    const r = parseAmsBody(JSON.stringify({ dataset_id: 'sp-traffic', campaign_id: '123', impressions: 10, clicks: 2, cost: 1.5 }))
    expect(r).toHaveLength(1)
    expect(r[0].dataset_id).toBe('sp-traffic')
    expect(r[0].impressions).toBe(10)
  })

  it('unwraps an SNS envelope ({Message:"<json>"})', () => {
    const inner = JSON.stringify({ dataset_id: 'sp-conversion', campaign_id: '9', attributed_sales_1d: 42 })
    const r = parseAmsBody(JSON.stringify({ Type: 'Notification', Message: inner }))
    expect(r).toHaveLength(1)
    expect(r[0].dataset_id).toBe('sp-conversion')
    expect(r[0].attributed_sales_1d).toBe(42)
  })

  it('expands a Firehose-style {records:[...]} batch', () => {
    const r = parseAmsBody(JSON.stringify({ records: [{ dataset_id: 'sd-traffic' }, { dataset_id: 'sb-traffic' }] }))
    expect(r).toHaveLength(2)
    expect(r.map((x) => x.dataset_id)).toEqual(['sd-traffic', 'sb-traffic'])
  })

  it('passes through a bare array', () => {
    const r = parseAmsBody(JSON.stringify([{ dataset_id: 'sp-traffic' }, { dataset_id: 'sp-conversion' }]))
    expect(r).toHaveLength(2)
  })

  it('returns [] on non-JSON', () => {
    expect(parseAmsBody('not json at all')).toEqual([])
  })

  it('returns [] on a JSON primitive', () => {
    expect(parseAmsBody('42')).toEqual([])
    expect(parseAmsBody('"hello"')).toEqual([])
  })
})
