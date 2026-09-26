import { describe, expect, it } from 'vitest'
import { inboundActionNotice } from './inbound-action-notice'

describe('inbound action HTTP outcome contract', () => {
  it.each([200, 202])('does not present queued eBay replay as completed for HTTP %s', status => {
    expect(inboundActionNotice('replay', status, { success: true, queued: true })).toMatchObject({ tone: 'info', title: 'Queued' })
  })
  it('does not infer completed processing from HTTP202 without a queue flag', () => {
    expect(inboundActionNotice('replay', 202, { success: true })).toMatchObject({ tone: 'info', title: 'Queued' })
  })
  it.each([{ success: true }, { success: true, queued: false }])('retains confirmed synchronous legacy and eBay completion', body => {
    expect(inboundActionNotice('replay', 200, body)).toMatchObject({ tone: 'success', title: 'Completed' })
  })
  it('reports a retry as queued without promising completion within a minute', () => {
    const notice = inboundActionNotice('retry', 200, { success: true, queued: true })
    expect(notice).toMatchObject({ tone: 'info', title: 'Queued' })
    expect(notice.text).not.toMatch(/within a minute|succeeded|completed/i)
  })
  it.each([409, 503])('preserves an explicit failure even when HTTP%s says the receipt remains queued', status => {
    expect(inboundActionNotice('replay', status, { success: false, queued: true, error: 'Processing is held.' }))
      .toEqual({ tone: 'danger', title: 'Result not confirmed', text: 'Processing is held.' })
  })
  it.each([null, {}, [], { success: false }, { success: 'true' }, { success: true, queued: 'true' }])('does not invent success from an invalid response body: %j', body => {
    expect(inboundActionNotice('replay', 200, body)).toMatchObject({ tone: 'danger', title: 'Result not confirmed' })
  })
  it('requires a positive queue acknowledgement for retry', () => {
    expect(inboundActionNotice('retry', 200, { success: true, queued: false })).toMatchObject({ tone: 'danger' })
  })
})
