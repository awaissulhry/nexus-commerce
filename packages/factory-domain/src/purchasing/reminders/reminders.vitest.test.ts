import { describe, expect, it } from 'vitest'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { effectiveSwitch, switchOf, switchWords } from './settings'

/**
 * The Owner's switch for automatic PO confirmation reminders (B-W2b-14; Z1:09): the company's row, else the tenant's,
 * else OFF; changing it is a step-up permission of the owner's.
 */

describe('the Owner switch for automatic PO confirmation reminders', () => {
  it('the company row wins, then the tenant row, else OFF by default', () => {
    expect(effectiveSwitch(null, null)).toEqual({ on: false, source: 'DEFAULT' })
    expect(effectiveSwitch(null, { companyId: null, confirmationRemindersEnabled: true })).toEqual({ on: true, source: 'TENANT' })
    expect(effectiveSwitch({ companyId: 'a', confirmationRemindersEnabled: false }, { companyId: null, confirmationRemindersEnabled: true })).toEqual({ on: false, source: 'COMPANY' })
    expect(effectiveSwitch({ companyId: 'a', confirmationRemindersEnabled: true }, null)).toEqual({ on: true, source: 'COMPANY' })
  })

  it('the daily run reads every row of the tenant once', () => {
    const on = switchOf([
      { companyId: null, confirmationRemindersEnabled: false },
      { companyId: 'a', confirmationRemindersEnabled: true },
    ])
    expect(on('a')).toBe(true)
    expect(on('b')).toBe(false)
    expect(switchOf([])('a')).toBe(false)
    expect(switchOf([{ companyId: null, confirmationRemindersEnabled: true }])('b')).toBe(true)
  })

  it('says where it stands', () => {
    expect(switchWords({ on: false, source: 'DEFAULT' })).toContain('never switched on')
    expect(switchWords({ on: true, source: 'TENANT' })).toContain('every company')
  })

  it('changing it is a step-up permission (no template lists it: the owner holds every office permission)', () => {
    expect(FACTORY_PERMISSIONS.get('purchasing.reminders.switch')?.risk).toBe('stepUp')
  })
})
