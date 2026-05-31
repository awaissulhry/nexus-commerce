import { describe, it, expect } from 'vitest'
import { parseAmsBody } from './ams-sqs.service.js'

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
