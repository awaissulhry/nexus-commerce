import { describe, expect, it } from 'vitest'
import { orderNotifications } from './notifications-order'

const at = (iso: string) => `2026-09-${iso}T10:00:00.000Z`
const row = (id: string, severity: string, read: boolean, day: string) =>
  ({ id, severity, readAt: read ? at(day) : null, createdAt: at(day) })

describe('orderNotifications', () => {
  it('🔴 the measured case — the one unread alarm comes first, not buried under read digests', () => {
    const rows = [
      row('digest-31', 'info', true, '10'),
      row('digest-24', 'info', true, '09'),
      row('budget-warn', 'warn', true, '08'),
      row('halt-alarm', 'danger', false, '01'), // oldest, but the only unread
    ]
    expect(orderNotifications(rows)[0].id).toBe('halt-alarm')
  })

  it('unread always precede read, whatever their severity or age', () => {
    const ids = orderNotifications([
      row('read-danger-new', 'danger', true, '15'),
      row('unread-info-old', 'info', false, '01'),
    ]).map(r => r.id)
    expect(ids).toEqual(['unread-info-old', 'read-danger-new'])
  })

  it('among unread, danger > warn > info/success, then newest', () => {
    const ids = orderNotifications([
      row('info-new', 'info', false, '15'),
      row('warn-old', 'warn', false, '02'),
      row('danger-old', 'danger', false, '01'),
      row('success-mid', 'success', false, '10'),
      row('warn-new', 'warn', false, '14'),
    ]).map(r => r.id)
    expect(ids).toEqual(['danger-old', 'warn-new', 'warn-old', 'info-new', 'success-mid'])
  })

  it('read rows stay newest-first and are NOT re-ranked by severity', () => {
    const ids = orderNotifications([
      row('danger-old', 'danger', true, '01'),
      row('info-new', 'info', true, '15'),
    ]).map(r => r.id)
    expect(ids).toEqual(['info-new', 'danger-old'])
  })

  it('an unknown severity ranks with info rather than jumping the queue', () => {
    const ids = orderNotifications([
      row('mystery', 'catastrophic-maybe', false, '15'),
      row('warn', 'warn', false, '01'),
    ]).map(r => r.id)
    expect(ids).toEqual(['warn', 'mystery'])
  })

  it('does not mutate what it was given', () => {
    const input = [row('a', 'info', true, '01'), row('b', 'danger', false, '02')]
    const snapshot = input.map(r => r.id)
    orderNotifications(input)
    expect(input.map(r => r.id)).toEqual(snapshot)
  })
})
