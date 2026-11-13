import { describe, expect, it } from 'vitest'
import { reminderOn, REMINDERS_OFF, remindersInForce, type ReminderSwitchRow } from './rules'

const tenant = (quote: boolean, fitting: boolean): ReminderSwitchRow => ({ id: 't', companyId: null, quoteRemindersEnabled: quote, fittingRemindersEnabled: fitting })
const company = (id: string, quote: boolean, fitting: boolean): ReminderSwitchRow => ({ id, companyId: id, quoteRemindersEnabled: quote, fittingRemindersEnabled: fitting })

describe('B-W2b-F38: the reminder switches in force (company row, else tenant row, else off)', () => {
  it('no row: both off (the Owner\'s default)', () => {
    expect(remindersInForce([], 'a')).toEqual(REMINDERS_OFF)
    expect(remindersInForce([], null)).toEqual({ quoteRemindersEnabled: false, fittingRemindersEnabled: false, source: 'DEFAULT' })
    expect(reminderOn([], 'a', 'QUOTE')).toBe(false)
    expect(reminderOn([], 'a', 'FITTING')).toBe(false)
  })

  it('a company without its own row follows the tenant-wide row', () => {
    expect(remindersInForce([tenant(true, false)], 'a')).toEqual({ quoteRemindersEnabled: true, fittingRemindersEnabled: false, source: 'TENANT' })
    expect(reminderOn([tenant(true, false)], 'a', 'QUOTE')).toBe(true)
    expect(reminderOn([tenant(true, false)], 'a', 'FITTING')).toBe(false)
  })

  it('a company\'s own row wins, both ways, and never leaks to another company', () => {
    const rows = [tenant(true, true), company('a', false, false), company('b', false, true)]
    expect(remindersInForce(rows, 'a')).toEqual({ quoteRemindersEnabled: false, fittingRemindersEnabled: false, source: 'COMPANY' })
    expect(reminderOn(rows, 'b', 'FITTING')).toBe(true)
    expect(reminderOn(rows, 'b', 'QUOTE')).toBe(false)
    expect(remindersInForce(rows, 'c').source).toBe('TENANT')
    expect(remindersInForce([company('a', true, true)], 'c')).toEqual(REMINDERS_OFF)
  })

  it('the tenant-wide reading (companyId null) is the tenant row only', () => {
    expect(remindersInForce([company('a', true, true)], null)).toEqual(REMINDERS_OFF)
    expect(remindersInForce([company('a', true, true), tenant(false, true)], null).source).toBe('TENANT')
  })
})
