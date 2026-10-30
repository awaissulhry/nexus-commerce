import { describe, expect, it } from 'vitest'
import { DEVICES } from '../shared/fixtures'
import { batteryOf, BATTERY_LOW_PERCENT, isOutdated } from './model'

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
