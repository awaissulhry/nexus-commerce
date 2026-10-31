import { describe, expect, it } from 'vitest'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { at, DEVICES, NOW } from '../shared/fixtures'
import { batteryOf, BATTERY_LOW_PERCENT, inUseSinceOf, isOutdated, networkKey } from './model'
import { inUseSinceWords } from './view/columns'

/**
 * Admin › Devices, the W2a part (B-W2a-42; design admin.devices "App version (outdated marked)", "Battery"): what the
 * tablet last said of itself, never a guess.
 */

const tablet = DEVICES[0]!

describe('a tablet\'s own state', () => {
  it('marks the app version outdated only for an enrolled tablet, against a known server version', () => {
    expect(isOutdated({ ...tablet, appVersion: '1.3.2' }, '1.4.0')).toBe(true)
    expect(isOutdated({ ...tablet, appVersion: '1.4.0' }, '1.4.0')).toBe(false)
    expect(isOutdated({ ...tablet, appVersion: '1.3.2' }, null)).toBe(false)
    expect(isOutdated({ ...tablet, appVersion: null }, '1.4.0')).toBe(false)
    expect(isOutdated({ ...tablet, status: 'REVOKED', appVersion: '1.3.2' }, '1.4.0')).toBe(false)
    expect(isOutdated({ ...tablet, status: 'PENDING', appVersion: '1.3.2' }, '1.4.0')).toBe(false)
  })

  it('reads the battery as reported: low below 20% unless charging; nothing when never said', () => {
    expect(batteryOf({ ...tablet, batteryPercent: 64, batteryCharging: false })).toEqual({ percent: 64, charging: false, low: false })
    expect(batteryOf({ ...tablet, batteryPercent: BATTERY_LOW_PERCENT - 1, batteryCharging: false })).toMatchObject({ low: true })
    expect(batteryOf({ ...tablet, batteryPercent: 5, batteryCharging: true })).toMatchObject({ low: false, charging: true })
    expect(batteryOf({ ...tablet, batteryPercent: null })).toBeNull()
    expect(batteryOf(tablet)).toBeNull()
  })
})

describe('B-W2b-24: the network and since when it is in use (never who)', () => {
  const t = createTranslator('en', CATALOGUE.en.admin!)

  it('says the network only as the tablet reported it', () => {
    expect(networkKey({ network: 'WIFI' })).toBe('devices.network.WIFI')
    expect(networkKey({ network: null })).toBeNull()
    expect(networkKey({})).toBeNull()
  })

  it('says since when only for a device in use whose time is known; the time alone today, else the day too', () => {
    expect(inUseSinceOf({ inUse: false, inUseSince: at(29, 5, 12) })).toBeNull()
    expect(inUseSinceOf({ inUse: true, inUseSince: null })).toBeNull()
    expect(inUseSinceWords({ inUse: true, inUseSince: at(29, 5, 12) }, { t, locale: 'en', now: Date.parse(NOW) })).toBe('In use since 06:12')
    expect(inUseSinceWords({ inUse: true, inUseSince: at(28, 15, 40) }, { t, locale: 'en', now: Date.parse(NOW) })).toMatch(/^In use since 28\/10\/2026/)
    expect(inUseSinceWords({ inUse: false, inUseSince: null }, { t, locale: 'en', now: Date.parse(NOW) })).toBeNull()
  })
})
