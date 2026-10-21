/**
 * Meta step 33 — one Conversions API request and what its answer means for the sales it carried: all received =
 * confirmed; fewer, a refusal of its content, no answer or Meta's own failure = maybe (Meta keeps the valid events that
 * carry an event_id); a throttle, a lost token, no permission or an unknown pixel = none; a gateway refusal = not sent.
 * The gateway is a stand-in. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('../../gateway/meta.js', () => ({ metaWriteCall: h.call }))

import { GatewayRefusal } from '../../gateway/gateway.js'
import { metaSendEvents } from './events-client.js'

const TARGET = { connectionId: 'm-1', adAccountId: '1234567890' }
const PIXEL = '120000000000050'
const answer = (status: number, body: unknown, verdict: Record<string, unknown> | null = null) => ({
  outcome: 'sent', ok: status >= 200 && status < 300, status, text: JSON.stringify(body), verdict, json: () => body,
})
const send = () => metaSendEvents(TARGET, PIXEL, { data: '[]', partner_agent: 'nexus' }, 3)

beforeEach(() => { h.call.mockReset() })

describe('metaSendEvents', () => {
  it('sends once to the pixel\'s events edge, named a pixel, never a check', async () => {
    h.call.mockResolvedValueOnce(answer(200, { events_received: 3, messages: [], fbtrace_id: 'AbC' }))
    expect(await send()).toEqual({ outcome: 'done', received: 3, sentence: 'Meta received all 3 events.' })
    expect(h.call).toHaveBeenCalledWith(expect.objectContaining({ connectionId: 'm-1', operation: 'events.send', objectId: PIXEL, objectKind: 'pixel', edge: 'events', check: false }))
  })
  it('fewer received than sent, or no count: maybe', async () => {
    h.call.mockResolvedValueOnce(answer(200, { events_received: 2, messages: ['one event was invalid'] }))
    expect(await send()).toMatchObject({ outcome: 'maybe', received: 2, sentence: expect.stringMatching(/2 of 3 events received.*one event was invalid.*never later/s) })
    h.call.mockResolvedValueOnce(answer(200, {}))
    expect(await send()).toMatchObject({ outcome: 'maybe', received: null })
  })
  it('a refusal of the content, no answer or Meta\'s own failure: maybe (valid events with an event_id are kept)', async () => {
    h.call.mockResolvedValueOnce(answer(400, {}, { errorClass: 'invalid', channelCode: '100/2804050', channelMessage: 'Invalid parameter' }))
    expect(await send()).toMatchObject({ outcome: 'maybe', sentence: expect.stringMatching(/Meta refused the request \(100\/2804050\): Invalid parameter\. Meta keeps the valid events/) })
    h.call.mockResolvedValueOnce(answer(0, {}, { errorClass: 'network' }))
    expect(await send()).toMatchObject({ outcome: 'maybe', sentence: expect.stringMatching(/did not answer/) })
    h.call.mockResolvedValueOnce(answer(503, {}, { errorClass: 'transient' }))
    expect(await send()).toMatchObject({ outcome: 'maybe' })
  })
  it('a throttle, a lost token, no permission or an unknown pixel: Meta took none', async () => {
    h.call.mockResolvedValueOnce(answer(400, {}, { errorClass: 'rate_limited', channelCode: '4' }))
    expect(await send()).toMatchObject({ outcome: 'none', sentence: expect.stringMatching(/slow down \(4\).*took none/) })
    h.call.mockResolvedValueOnce(answer(400, {}, { errorClass: 'auth_expired', channelCode: '190' }))
    expect(await send()).toMatchObject({ outcome: 'none' })
    h.call.mockResolvedValueOnce(answer(403, {}, { errorClass: 'forbidden', channelCode: '200' }))
    expect(await send()).toMatchObject({ outcome: 'none', sentence: expect.stringMatching(/does not let this system user send events/) })
    h.call.mockResolvedValueOnce(answer(400, {}, { errorClass: 'not_found', channelCode: '100/33' }))
    expect(await send()).toMatchObject({ outcome: 'none', sentence: expect.stringMatching(/does not exist/) })
  })
  it('the gateway refused it: not sent; any other error of Nexus\'s own may have come after the send: maybe (review F1)', async () => {
    h.call.mockRejectedValueOnce(new GatewayRefusal('refused', 'META_ACCOUNT_NOT_CHOSEN', 'Nothing was sent to Meta: the switch is off.', 403))
    expect(await send()).toEqual({ outcome: 'not_sent', received: null, sentence: 'Not sent: Nothing was sent to Meta: the switch is off.' })
    h.call.mockRejectedValueOnce(new Error('connection to the database lost'))
    expect(await send()).toMatchObject({ outcome: 'maybe', sentence: expect.stringMatching(/problem of its own during the request \(connection to the database lost\).*records them as not confirmed/) })
  })
})
