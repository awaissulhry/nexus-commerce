import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { SHARE_PERMISSIONS, SHARE_STATES } from '@nexus/factory-domain/shares/rules'
import { ApiError } from '../../lib/api/errors'
import { recordSharesSchema } from './api'
import { designScreen } from './fixtures'
import { dayOf, expiresAtOf, inviteDraftProblems, inviteHeld, inviteRefusal, invitedNotice, latestUntil, liveCount, newInviteDraft, permissionsOfDraft, shareActionHeld, shareActionRefusal, takesShares } from './model'

const NOW = new Date(2026, 10, 10, 9, 0, 0).getTime()
const DAY = 86_400_000
const catalogue = (locale: 'it' | 'en') => JSON.parse(readFileSync(new URL(`../../../messages/${locale}/record-shares.json`, import.meta.url), 'utf8')) as Record<string, unknown>
const flat = (tree: Record<string, unknown>, prefix = ''): Record<string, string> =>
  Object.fromEntries(Object.entries(tree).flatMap(([key, value]) => (typeof value === 'string' ? [[`${prefix}${key}`, value]] : Object.entries(flat(value as Record<string, unknown>, `${prefix}${key}.`)))))
const refused = (status: number, code: string, paths: string[] = []) => new ApiError(status === 404 ? 'not_found' : status === 403 ? 'forbidden' : status === 409 ? 'conflict' : 'invalid', status, code, 'x', 'r', paths.map((path) => ({ path, message: 'x' })))

describe('record panels › Partners (share with a partner)', () => {
  it('only a record a RECORD_INVITE link opens has the tab', () => {
    for (const type of ['Style', 'Quote', 'SalesOrder', 'PurchaseOrder', 'SubcontractOrder', 'Shipment', 'Complaint', 'ReturnAuthorisation', 'SupplierClaim']) expect(takesShares(type), type).toBe(true)
    expect(takesShares('WorkOrder')).toBe(false)
    expect(takesShares('PayrollExport')).toBe(false)
  })

  it('a fresh invitation takes the first contact, read and write, 30 days, by e-mail; it ends at 23:59 of its last day', () => {
    const draft = newInviteDraft({ contacts: [{ id: 'c1', name: 'Dana', email: 'dana@example.com', language: null }] }, NOW)
    expect(draft).toMatchObject({ to: 'contact', contactId: 'c1', comment: true, upload: false, send: true, until: dayOf(NOW + 30 * DAY) })
    expect(newInviteDraft({ contacts: [] }, NOW).to).toBe('email')
    expect(permissionsOfDraft({ comment: false, upload: true })).toEqual(['VIEW', 'UPLOAD'])
    const end = new Date(expiresAtOf('2026-11-30')!)
    expect([end.getFullYear(), end.getMonth(), end.getDate(), end.getHours(), end.getMinutes()]).toEqual([2026, 10, 30, 23, 59])
    expect(expiresAtOf('30/11/2026')).toBeNull()
    expect(Date.parse(expiresAtOf(latestUntil(NOW))!) - NOW).toBeLessThanOrEqual(180 * DAY)
  })

  it('the dialog checks its fields as the API does: whom, a last day within 180 days, the note', () => {
    const ok = { ...newInviteDraft({ contacts: [] }, NOW), email: 'aldo@agency.example' }
    expect(inviteDraftProblems(ok, NOW)).toEqual({})
    expect(inviteDraftProblems({ ...ok, email: 'aldo@' }, NOW)).toEqual({ email: 'invite.problem.email' })
    expect(inviteDraftProblems({ ...ok, to: 'contact', contactId: '' }, NOW)).toEqual({ to: 'invite.problem.contact' })
    expect(inviteDraftProblems({ ...ok, until: '' }, NOW).until).toBe('invite.problem.until')
    expect(inviteDraftProblems({ ...ok, until: dayOf(NOW + 200 * DAY) }, NOW).until).toBe('invite.problem.untilLate')
    expect(inviteDraftProblems({ ...ok, until: dayOf(NOW - DAY) }, NOW).until).toBe('invite.problem.untilSoon')
    expect(inviteDraftProblems({ ...ok, note: 'x'.repeat(1001) }, NOW).note).toBe('invite.problem.note')
  })

  it('holds each button with its reason, and says the API\'s refusals in words', () => {
    const data = { record: { type: 'SalesOrder', id: 'r', reference: 'SO-1' }, party: null, contacts: [], held: 'NO_PARTY' as const, may: { invite: false }, shares: [] }
    expect(inviteHeld({ can: { manage: false }, read: { status: 'loading' }, busy: false })).toBe('held.noRight')
    expect(inviteHeld({ can: { manage: true }, read: { status: 'ready', data }, busy: false })).toBe('held.NO_PARTY')
    expect(inviteHeld({ can: { manage: true }, read: { status: 'ready', data: { ...data, held: null } }, busy: false })).toBe('held.noRecordRight')
    expect(shareActionHeld({ state: 'REVOKED', may: { change: false, revoke: false } }, true, false)).toBe('held.revoked')
    expect(shareActionHeld({ state: 'LIVE', may: { change: true, revoke: true } }, true, false)).toBeNull()
    expect(inviteRefusal(refused(409, 'conflict', ['refusal/ALREADY_INVITED']))).toEqual({ problems: {}, problem: 'invite.problem.already', reload: true })
    expect(inviteRefusal(refused(409, 'conflict', ['refusal/SUPPRESSED'])).problems).toEqual({ email: 'invite.problem.suppressed' })
    expect(inviteRefusal(refused(400, 'validation_failed', ['body/expiresAt'])).problems).toEqual({ until: 'invite.problem.untilRefused' })
    expect(inviteRefusal(refused(409, 'invalid_state', ['held/NO_PARTY'])).problem).toBe('held.NO_PARTY')
    expect(shareActionRefusal(refused(409, 'conflict', ['refusal/STALE']))).toEqual({ key: 'action.problem.changed', reload: true })
    expect(shareActionRefusal(refused(409, 'invalid_state', ['held/REVOKED']))).toEqual({ key: 'action.problem.ended', reload: true })
    expect(invitedNotice({ share: { email: 'a@b.example' } as never, url: 'https://x/l#token=t', delivery: null })?.key).toBe('note.linkOnce')
  })

  it('counts the invitations that still live, and its cases are what the API could answer', () => {
    const list = designScreen.cases.find((item) => item.id === 'list')!.model.shares!
    expect(liveCount(list)).toBe(2)
    for (const item of designScreen.cases) {
      const read = item.model.shares!.read
      if (read.status === 'ready') expect(() => recordSharesSchema.parse(read.data), item.id).not.toThrow()
    }
  })

  it('has words in Italian and English for every state, right and held reason, and the same keys in both', () => {
    const it_ = flat(catalogue('it'))
    const en = flat(catalogue('en'))
    expect(Object.keys(it_).sort()).toEqual(Object.keys(en).sort())
    for (const key of [...SHARE_STATES.map((state) => `state.${state}`), ...SHARE_PERMISSIONS.map((permission) => `may.${permission}`), 'held.ALL_COMPANIES', 'held.NO_PARTY', 'tab']) {
      expect(it_[key], `it ${key}`).toBeTruthy()
      expect(en[key], `en ${key}`).toBeTruthy()
    }
  })
})
