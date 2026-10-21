/**
 * Meta step 33 — the pixel rule the tool and the gateway both ask: the business's switch on, the connection the one the
 * business chose its ad account through, the pixel one of that account's own that no other business in Nexus uses — and
 * any lookup that fails refuses. Also the switch itself: off by default, a person's name and time when on, recorded in
 * the settings history only when it moves. Stand-ins for Meta's reads and the database. Made-up ids.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  row: null as null | { metaConversionsApiOnAt: Date | null; metaConversionsApiOnBy: string | null },
  upsert: vi.fn(),
  audit: vi.fn(),
  chosen: vi.fn(),
  pixel: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: { accountSettings: { findFirst: vi.fn(async () => h.row), upsert: h.upsert } } }))
vi.mock('../../../utils/settings-audit.js', () => ({ writeSettingsAudit: h.audit }))
vi.mock('./live.js', async (importActual) => ({ ...(await importActual<typeof import('./live.js')>()), metaChosenAccount: h.chosen }))
vi.mock('./live-audiences.js', async (importActual) => ({ ...(await importActual<typeof import('./live-audiences.js')>()), ownPixelState: h.pixel }))

import { MetaLiveRefusal } from './live.js'
import { TAKEN_PIXEL } from './live-audiences.js'
import { metaEventsPixelProblem } from './events-rule.js'
import { META_EVENTS_OFF, metaEventsSwitch, setMetaEventsSwitch } from './events-switch.js'

const PIXEL = '120000000000050'

beforeEach(() => {
  h.row = { metaConversionsApiOnAt: new Date('2026-10-21T08:00:00Z'), metaConversionsApiOnBy: 'Owner' }
  h.upsert.mockReset().mockImplementation(async ({ update }: { update: typeof h.row }) => { h.row = update })
  h.audit.mockReset()
  h.chosen.mockReset().mockResolvedValue({ connectionId: 'm-1', adAccountId: '1234567890' })
  h.pixel.mockReset().mockResolvedValue({ pixelId: PIXEL, takenByAnotherBusiness: false })
})

describe('the switch', () => {
  it('is off without a settings row or a time; on names who and when', async () => {
    h.row = null
    expect(await metaEventsSwitch()).toEqual({ on: false, since: null, by: null })
    h.row = { metaConversionsApiOnAt: null, metaConversionsApiOnBy: 'Someone' }
    expect(await metaEventsSwitch()).toEqual({ on: false, since: null, by: null })
    h.row = { metaConversionsApiOnAt: new Date('2026-10-21T08:00:00Z'), metaConversionsApiOnBy: 'Owner' }
    expect(await metaEventsSwitch()).toEqual({ on: true, since: '2026-10-21T08:00:00.000Z', by: 'Owner' })
  })
  it('a person turns it on or off; the same value again changes and records nothing', async () => {
    expect(await setMetaEventsSwitch(true, { label: 'Owner' })).toMatchObject({ changed: false, switch: { on: true } })
    expect(h.upsert).not.toHaveBeenCalled()
    const off = await setMetaEventsSwitch(false, { label: 'Owner' })
    expect(off).toEqual({ changed: true, switch: { on: false, since: null, by: null } })
    expect(h.upsert.mock.calls[0][0].update).toEqual({ metaConversionsApiOnAt: null, metaConversionsApiOnBy: null })
    // Review F7 — its own history key, which Settings › History never reverts.
    expect(h.audit).toHaveBeenCalledWith({ key: 'meta-conversions-api', action: 'update', before: { metaConversionsApi: true }, after: { metaConversionsApi: false } })
    const on = await setMetaEventsSwitch(true, { label: 'Owner' })
    expect(on.switch).toMatchObject({ on: true, by: 'Owner' })
  })
})

describe('metaEventsPixelProblem', () => {
  it('lets through only the chosen account\'s own pixel of a business that switched sending on', async () => {
    expect(await metaEventsPixelProblem('m-1', PIXEL)).toBeNull()
    expect(h.pixel).toHaveBeenCalledWith({ connectionId: 'm-1', adAccountId: '1234567890' }, PIXEL, false)
  })
  it('refuses when the switch is off, another connection, a taken or unchecked pixel, or any lookup failing', async () => {
    h.row = null
    expect(await metaEventsPixelProblem('m-1', PIXEL)).toBe(META_EVENTS_OFF)
    h.row = { metaConversionsApiOnAt: new Date(), metaConversionsApiOnBy: 'Owner' }
    expect(await metaEventsPixelProblem('m-2', PIXEL)).toMatch(/not the one through which/)
    h.pixel.mockResolvedValueOnce({ pixelId: PIXEL, takenByAnotherBusiness: true })
    expect(await metaEventsPixelProblem('m-1', PIXEL)).toBe(TAKEN_PIXEL)
    h.pixel.mockRejectedValueOnce(new MetaLiveRefusal('That pixel is not on the ad account this business chose, so it is not read.'))
    expect(await metaEventsPixelProblem('m-1', PIXEL)).toMatch(/not on the ad account this business chose/)
    h.pixel.mockRejectedValueOnce(new Error('connection to the database lost'))
    expect(await metaEventsPixelProblem('m-1', PIXEL)).toMatch(/could not confirm the pixel \(connection to the database lost\)/)
  })
})
